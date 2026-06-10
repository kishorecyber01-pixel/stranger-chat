const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const geoip = require('geoip-lite');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── State ────────────────────────────────────────────────────────────────────
const waitingQueue = [];   // [{ id, interests, country }]
const pairs        = new Map();  // socketId -> partnerId
const userMeta     = new Map();  // socketId -> { interests, country, ip }

// ─── Ban/Report system (in-memory) ───────────────────────────────────────────
const reportCounts = new Map();  // ip -> number of reports
const bannedIPs    = new Set();  // IPs permanently banned
const REPORT_THRESHOLD = 3;      // bans after this many reports

function getIP(socket) {
  return (
    socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() ||
    socket.handshake.address
  );
}

function isBanned(ip) {
  return bannedIPs.has(ip);
}

function recordReport(ip) {
  const count = (reportCounts.get(ip) || 0) + 1;
  reportCounts.set(ip, count);
  if (count >= REPORT_THRESHOLD) {
    bannedIPs.add(ip);
    return true; // newly banned
  }
  return false;
}

// ─── Geo ──────────────────────────────────────────────────────────────────────
function getCountry(ip) {
  // geoip-lite doesn't resolve loopback/private — treat as unknown
  if (!ip || ip === '127.0.0.1' || ip.startsWith('::') || ip.startsWith('192.168') || ip.startsWith('10.')) {
    return null;
  }
  const geo = geoip.lookup(ip);
  return geo ? geo.country : null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getTotalUsers() {
  return io.sockets.sockets.size;
}

function broadcastStats() {
  io.emit('stats', { online: getTotalUsers(), waiting: waitingQueue.length });
}

function interestScore(interestsA, interestsB) {
  if (!interestsA?.length || !interestsB?.length) return 0;
  const setB = new Set(interestsB.map(t => t.toLowerCase()));
  return interestsA.filter(t => setB.has(t.toLowerCase())).length;
}

/**
 * Find the best match for a given socket in the waiting queue.
 * Priority:
 *   1. Same country + shared interests (highest score wins)
 *   2. Same country, no shared interests
 *   3. Any user with shared interests
 *   4. First user in queue (fallback)
 * Returns the index in waitingQueue, or -1 if queue is empty.
 */
function findBestMatch(meta) {
  if (waitingQueue.length === 0) return -1;

  let bestIdx   = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < waitingQueue.length; i++) {
    const candidate  = waitingQueue[i];
    const candMeta   = userMeta.get(candidate.id);
    if (!candMeta) continue;

    const sameCountry  = meta.country && candMeta.country && meta.country === candMeta.country;
    const shared       = interestScore(meta.interests, candMeta.interests);

    // Score: same-country bonus (100) + shared interests
    const score = (sameCountry ? 100 : 0) + shared;

    if (score > bestScore) {
      bestScore = score;
      bestIdx   = i;
    }
  }

  // Always accept any match (fallback to best available)
  return bestIdx;
}

function tryMatch(socketId) {
  const meta = userMeta.get(socketId);
  if (!meta) return;

  const idx = findBestMatch(meta);
  if (idx === -1) return;

  // Remove the chosen candidate from the queue
  const [candidate] = waitingQueue.splice(idx, 1);

  // Remove the requesting user from the queue too
  const myIdx = waitingQueue.findIndex(e => e.id === socketId);
  if (myIdx !== -1) waitingQueue.splice(myIdx, 1);

  const a = socketId;
  const b = candidate.id;

  if (!io.sockets.sockets.get(a) || !io.sockets.sockets.get(b)) {
    // Re-queue whoever is still alive
    if (io.sockets.sockets.get(a)) waitingQueue.push({ id: a, ...meta });
    if (io.sockets.sockets.get(b)) waitingQueue.push(candidate);
    return;
  }

  pairs.set(a, b);
  pairs.set(b, a);

  const sharedInterests = meta.interests?.filter(t =>
    (userMeta.get(b)?.interests || []).map(x => x.toLowerCase()).includes(t.toLowerCase())
  ) || [];

  io.to(a).emit('matched', {
    message: "You're now chatting with a stranger. Say hi!",
    sharedInterests
  });
  io.to(b).emit('matched', {
    message: "You're now chatting with a stranger. Say hi!",
    sharedInterests
  });

  broadcastStats();
}

// ─── Socket logic ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const ip = getIP(socket);

  // Reject banned IPs immediately
  if (isBanned(ip)) {
    socket.emit('banned', { message: 'You have been banned for violating community guidelines.' });
    socket.disconnect(true);
    return;
  }

  console.log(`[+] Connected: ${socket.id} | IP: ${ip} | Total: ${getTotalUsers()}`);

  const country = getCountry(ip);
  userMeta.set(socket.id, { interests: [], country, ip });

  broadcastStats();

  // User wants to find a stranger
  socket.on('findStranger', ({ interests = [] } = {}) => {
    // Update interests
    const meta = userMeta.get(socket.id) || {};
    meta.interests = Array.isArray(interests)
      ? interests.slice(0, 10).map(t => String(t).trim()).filter(Boolean)
      : [];
    userMeta.set(socket.id, meta);

    // Clean up any existing pair
    const existingPartner = pairs.get(socket.id);
    if (existingPartner) {
      pairs.delete(existingPartner);
      pairs.delete(socket.id);
      io.to(existingPartner).emit('strangerLeft');
    }

    // Remove from queue if already there
    const qi = waitingQueue.findIndex(e => e.id === socket.id);
    if (qi !== -1) waitingQueue.splice(qi, 1);

    // Add to queue
    waitingQueue.push({ id: socket.id, interests: meta.interests, country: meta.country });
    socket.emit('waiting');
    broadcastStats();

    // Try to match this user
    tryMatch(socket.id);
  });

  // User sends a message
  socket.on('message', (data) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('message', { text: data.text, from: 'stranger' });
    }
  });

  // Typing indicator
  socket.on('typing', (isTyping) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('typing', isTyping);
    }
  });

  // Report a stranger
  socket.on('report', () => {
    const partnerId = pairs.get(socket.id);
    if (!partnerId) return;

    const partnerMeta = userMeta.get(partnerId);
    if (!partnerMeta) return;

    const wasBanned = recordReport(partnerMeta.ip);
    socket.emit('reportAck', { message: 'Report submitted. Thank you.' });

    if (wasBanned) {
      // Kick the banned socket
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('banned', { message: 'You have been banned for violating community guidelines.' });
        partnerSocket.disconnect(true);
      }
    }

    // Disconnect reporter from this partner and send them back to queue
    pairs.delete(partnerId);
    pairs.delete(socket.id);
    socket.emit('strangerLeft');
  });

  // User clicks Next / Stop
  socket.on('disconnect_chat', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      pairs.delete(partnerId);
      pairs.delete(socket.id);
      io.to(partnerId).emit('strangerLeft');
    }
    const qi = waitingQueue.findIndex(e => e.id === socket.id);
    if (qi !== -1) waitingQueue.splice(qi, 1);
    socket.emit('idle');
    broadcastStats();
  });

  // Socket disconnects entirely
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      pairs.delete(partnerId);
      pairs.delete(socket.id);
      io.to(partnerId).emit('strangerLeft');
    }
    const qi = waitingQueue.findIndex(e => e.id === socket.id);
    if (qi !== -1) waitingQueue.splice(qi, 1);
    userMeta.delete(socket.id);
    broadcastStats();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 StrangerChat running on http://localhost:${PORT}`);
});
