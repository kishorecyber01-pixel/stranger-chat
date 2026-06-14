require('./db');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'strangerchat-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ── IP BAN LIST (persistent in memory, swap to DB/Redis for production) ──
const bannedIPs = new Set();

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress ||
    '0.0.0.0'
  );
}

// Middleware: block banned IPs from web requests
app.use((req, res, next) => {
  const ip = getClientIP(req);
  if (bannedIPs.has(ip)) {
    return res.status(403).sendFile(path.join(__dirname, 'public', 'banned.html'));
  }
  next();
});

// Serve captcha gate for first-time visitors
app.get('/', (req, res) => {
  if (req.session.verified) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'captcha.html'));
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── TURNSTILE VERIFY ──
app.post('/verify-turnstile', async (req, res) => {
  try {
    const ip = getClientIP(req);
    if (bannedIPs.has(ip)) return res.status(403).json({ success: false, error: 'banned' });

    const token = req.body.token;
    const response = await axios.post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET,
        response: token
      })
    );
    if (response.data.success) req.session.verified = true;
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ── PREMIUM CHECK ──
// In production replace with real payment/DB lookup
app.get('/api/premium-status', (req, res) => {
  const isPremium = req.session.premium === true;
  res.json({ premium: isPremium });
});

// ── FAKE PREMIUM UPGRADE (replace with Stripe etc.) ──
app.post('/api/upgrade', (req, res) => {
  // TODO: integrate real payment. For now just a stub.
  res.json({ success: false, message: 'Payment integration required' });
});

// ── AVATAR UPLOAD (base64 stored in session, max 200KB) ──
app.post('/api/avatar', (req, res) => {
  const { dataUrl } = req.body;
  if (!dataUrl || dataUrl.length > 300000) {
    return res.json({ success: false, error: 'Image too large (max ~200KB)' });
  }
  req.session.avatar = dataUrl;
  req.session.save();
  res.json({ success: true });
});

app.get('/api/avatar', (req, res) => {
  res.json({ avatar: req.session.avatar || null });
});

// ── TRANSLATION ROUTE ──
app.post('/translate', async (req, res) => {
  try {
    const { text, targetLang, sourceLang = 'en' } = req.body;
    if (!text || !targetLang) return res.json({ translatedText: text });
    if (sourceLang === targetLang) return res.json({ translatedText: text });
    const langpair = `${sourceLang}|${targetLang}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langpair}`;
    const response = await axios.get(url, { timeout: 6000 });
    const result = response.data?.responseData;
    const translated = result?.translatedText;
    const match = result?.match ?? 0;
    if (translated && match > 0 && translated.toLowerCase() !== text.toLowerCase()) {
      res.json({ translatedText: translated });
    } else {
      res.json({ translatedText: text });
    }
  } catch (err) {
    console.error('[TRANSLATE ERROR]', err.message);
    res.json({ translatedText: req.body.text });
  }
});

// ── SMART AI MODERATION ──
// Expanded keyword patterns + smart context checks
const BAD_PATTERNS = [
  /\b(nigger|nigga|faggot|retard|chink|spic|kike|cunt)\b/i,
  /\b(kill\s+your?self|kys|go\s+die|i\s+will\s+kill\s+you)\b/i,
  /\b(fuck\s+you|fuck\s+off|motherfucker|piece\s+of\s+shit)\b/i,
  /(rape|molest|pedophile|child\s+porn|\bcp\b\s*(link|video|pic))/i,
  /\b(sex|nude|naked|dick|cock|pussy|boobs|tits)\b.{0,20}\b(send|share|show|pic|photo|video)\b/i,
  /(\b\d{3}[-.]?\d{3}[-.]?\d{4}\b)/,
  /(https?:\/\/[^\s]+\.(onion))/i,
  /\b(whatsapp|snapchat|telegram|instagram|discord)\s*(is|id|number|@|:)?\s*[\w.@]+/i,
  /\b(asl|age sex location|how old are you).{0,10}(female|girl|boy|male|f\/|m\/)/i,
  /\b(wanna\s+fuck|let'?s\s+fuck|want\s+to\s+have\s+sex)\b/i,
];

// Contextual severity scoring — returns { blocked: bool, severity: 'low'|'high', reason: string }
function moderateMessage(text) {
  for (const pattern of BAD_PATTERNS) {
    if (pattern.test(text)) {
      // Hate speech or threats = high severity (instant ban)
      const highSeverity = [BAD_PATTERNS[0], BAD_PATTERNS[1]];
      const severity = highSeverity.includes(pattern) ? 'high' : 'low';
      return { blocked: true, severity, reason: 'policy_violation' };
    }
  }
  return { blocked: false };
}

// ── SPAM DETECTION ──
// Blocks if user sends same message 3+ times in a row or 5+ identical in a session
function createSpamTracker() {
  return {
    lastMessage: '',
    repeatCount: 0,
    sessionCounts: new Map(),
    check(text) {
      const normalized = text.trim().toLowerCase();
      // Repeated consecutive messages
      if (normalized === this.lastMessage) {
        this.repeatCount++;
      } else {
        this.lastMessage = normalized;
        this.repeatCount = 1;
      }
      // Session frequency
      const freq = (this.sessionCounts.get(normalized) || 0) + 1;
      this.sessionCounts.set(normalized, freq);
      if (this.repeatCount >= 3 || freq >= 5) {
        return { spam: true, reason: this.repeatCount >= 3 ? 'repeat' : 'flood' };
      }
      return { spam: false };
    }
  };
}

// ── STATE ──
const waitingQueues = {};
const pairs = new Map();
const userInfo = new Map();
const reports = new Map();   // socketId -> report count
const ipReports = new Map(); // ip -> report count (for IP banning)
const warnings = new Map();
const spamTrackers = new Map();
const socketIPs = new Map(); // socketId -> ip

function getTotalUsers() { return io.sockets.sockets.size; }
function getTotalWaiting() {
  return Object.values(waitingQueues).reduce((a, q) => a + q.length, 0);
}
function broadcastStats() {
  io.emit('stats', { online: getTotalUsers(), waiting: getTotalWaiting() });
}
function removeFromQueues(socketId) {
  for (const key of Object.keys(waitingQueues)) {
    const qi = waitingQueues[key].indexOf(socketId);
    if (qi !== -1) waitingQueues[key].splice(qi, 1);
  }
}

function genderMatch(infoA, infoB) {
  const aPrefOk = infoA.pref === 'any' || infoA.pref === infoB.gender || !infoB.gender;
  const bPrefOk = infoB.pref === 'any' || infoB.pref === infoA.gender || !infoA.gender;
  return aPrefOk && bPrefOk;
}

function tryMatch(interests) {
  const keys = interests.length > 0
    ? [...interests.map(i => i.toLowerCase()), 'any']
    : ['any'];

  for (const key of keys) {
    if (!waitingQueues[key]) waitingQueues[key] = [];
    const queue = waitingQueues[key];

    for (let i = 0; i < queue.length; i++) {
      for (let j = i + 1; j < queue.length; j++) {
        const a = queue[i];
        const b = queue[j];
        if (!io.sockets.sockets.get(a) || !io.sockets.sockets.get(b)) continue;
        const infoA = userInfo.get(a) || {};
        const infoB = userInfo.get(b) || {};
        if (genderMatch(infoA, infoB)) {
          queue.splice(j, 1);
          queue.splice(i, 1);
          pairs.set(a, b);
          pairs.set(b, a);
          io.to(a).emit('matched', { partner: { username: infoB.username || 'Stranger', flag: infoB.flag || '🌍', country: infoB.country || 'Unknown', socketId: b, avatar: infoB.avatar || null }, isInitiator: true });
          io.to(b).emit('matched', { partner: { username: infoA.username || 'Stranger', flag: infoA.flag || '🌍', country: infoA.country || 'Unknown', socketId: a, avatar: infoA.avatar || null }, isInitiator: false });
          broadcastStats();
          return;
        }
      }
    }
  }
}

// ── SOCKET EVENTS ──
io.on('connection', (socket) => {
  // Grab IP for this socket
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || socket.handshake.address
    || '0.0.0.0';
  socketIPs.set(socket.id, ip);

  // Block banned IPs at socket level
  if (bannedIPs.has(ip)) {
    socket.emit('ipBanned');
    socket.disconnect();
    return;
  }

  broadcastStats();
  warnings.set(socket.id, 0);
  spamTrackers.set(socket.id, createSpamTracker());

  socket.on('setInfo', (info) => {
    userInfo.set(socket.id, { ...info, ip });
  });

  socket.on('findStranger', ({ interests = [] } = {}) => {
    const existingPartner = pairs.get(socket.id);
    if (existingPartner) {
      pairs.delete(existingPartner);
      pairs.delete(socket.id);
      io.to(existingPartner).emit('strangerLeft');
    }
    removeFromQueues(socket.id);

    if (interests.length > 0) {
      for (const interest of interests) {
        const key = interest.toLowerCase();
        if (!waitingQueues[key]) waitingQueues[key] = [];
        waitingQueues[key].push(socket.id);
      }
    } else {
      if (!waitingQueues.any) waitingQueues.any = [];
      waitingQueues.any.push(socket.id);
    }

    socket.emit('waiting');
    broadcastStats();
    tryMatch(interests);
  });

  socket.on('message', (data) => {
    const partnerId = pairs.get(socket.id);
    if (!partnerId) return;

    const text = (data.text || '').substring(0, 2000); // cap length

    // ── SPAM CHECK ──
    const spamTracker = spamTrackers.get(socket.id);
    if (spamTracker) {
      const spam = spamTracker.check(text);
      if (spam.spam) {
        socket.emit('modWarning', {
          message: spam.reason === 'repeat'
            ? '⚠️ Please don\'t send the same message repeatedly.'
            : '⚠️ You\'re sending too fast — slow down!'
        });
        console.log(`[SPAM] ${socket.id}: ${spam.reason}`);
        return;
      }
    }

    // ── MODERATION CHECK ──
    const mod = moderateMessage(text);
    if (mod.blocked) {
      const warnCount = (warnings.get(socket.id) || 0) + 1;
      warnings.set(socket.id, warnCount);

      if (mod.severity === 'high' || warnCount >= 2) {
        // Instant or second-offence ban
        socket.emit('modBanned', {
          message: '🚫 You have been removed for violating community rules.'
        });
        console.log(`[MOD] Banned ${socket.id} — severity: ${mod.severity}, warnings: ${warnCount}`);
        pairs.delete(partnerId);
        pairs.delete(socket.id);
        io.to(partnerId).emit('strangerLeft');
        removeFromQueues(socket.id);
        setTimeout(() => socket.disconnect(), 500);
      } else {
        socket.emit('modWarning', {
          message: '⚠️ Your message was blocked. One more violation and you will be disconnected.'
        });
        console.log(`[MOD] Warning #${warnCount} to ${socket.id}: "${text.substring(0, 50)}"`);
      }
      return;
    }

    io.to(partnerId).emit('message', { text });
  });

  socket.on('typing', (isTyping) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('typing', isTyping);
  });

  socket.on('report', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      // Per-socket report count
      const socketCount = (reports.get(partnerId) || 0) + 1;
      reports.set(partnerId, socketCount);

      // Per-IP report count (for permanent banning)
      const partnerIP = socketIPs.get(partnerId) || '0.0.0.0';
      const ipCount = (ipReports.get(partnerIP) || 0) + 1;
      ipReports.set(partnerIP, ipCount);

      socket.emit('reported');
      console.log(`[REPORT] ${partnerId} (IP ${partnerIP}) has ${socketCount} socket reports, ${ipCount} IP reports`);

      if (socketCount >= 3) {
        io.to(partnerId).emit('banned');
        io.sockets.sockets.get(partnerId)?.disconnect();
      }

      // Permanently ban IP after 3+ cross-session IP reports
      if (ipCount >= 3) {
        bannedIPs.add(partnerIP);
        io.to(partnerId).emit('ipBanned');
        console.log(`[BAN] IP permanently banned: ${partnerIP}`);
        io.sockets.sockets.get(partnerId)?.disconnect();
      }
    }
  });

  socket.on('disconnect_chat', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      pairs.delete(partnerId);
      pairs.delete(socket.id);
      io.to(partnerId).emit('strangerLeft');
    }
    removeFromQueues(socket.id);
    socket.emit('idle');
    broadcastStats();
  });

  // ── WebRTC SIGNALING ──
  socket.on('webrtc-offer', ({ to, offer }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc-offer', { from: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ to, answer }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc-answer', { answer });
  });

  socket.on('webrtc-ice', ({ to, candidate }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc-ice', { candidate });
  });

  socket.on('disconnect', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      pairs.delete(partnerId);
      pairs.delete(socket.id);
      io.to(partnerId).emit('strangerLeft');
    }
    removeFromQueues(socket.id);
    userInfo.delete(socket.id);
    warnings.delete(socket.id);
    spamTrackers.delete(socket.id);
    socketIPs.delete(socket.id);
    broadcastStats();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 StrangerChat running on port ${PORT}`);
});
