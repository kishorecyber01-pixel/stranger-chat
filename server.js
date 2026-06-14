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
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Serve captcha gate for first-time visitors
app.get('/', (req, res) => {
  if (req.session.verified) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'captcha.html'));
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── TURNSTILE VERIFY ROUTE ──
app.post('/verify-turnstile', async (req, res) => {
  try {
    const token = req.body.token;
    const response = await axios.post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET,
        response: token
      })
    );
    if (response.data.success) {
      req.session.verified = true;
    }
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ── STATE ──
const waitingQueues = {};
const pairs = new Map();
const userInfo = new Map();
const reports = new Map();

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

function tryMatch(interests) {
  const keys = interests.length > 0
    ? [...interests.map(i => i.toLowerCase()), 'any']
    : ['any'];

  for (const key of keys) {
    if (!waitingQueues[key]) waitingQueues[key] = [];
    const queue = waitingQueues[key];
    if (queue.length >= 2) {
      const a = queue.shift();
      const b = queue.shift();
      if (!io.sockets.sockets.get(a) || !io.sockets.sockets.get(b)) {
        if (io.sockets.sockets.get(a)) queue.unshift(a);
        if (io.sockets.sockets.get(b)) queue.unshift(b);
        continue;
      }
      pairs.set(a, b);
      pairs.set(b, a);
      const infoA = userInfo.get(a) || {};
      const infoB = userInfo.get(b) || {};
      io.to(a).emit('matched', { partner: { username: infoB.username || 'Stranger', flag: infoB.flag || '🌍', country: infoB.country || 'Unknown' } });
      io.to(b).emit('matched', { partner: { username: infoA.username || 'Stranger', flag: infoA.flag || '🌍', country: infoA.country || 'Unknown' } });
      broadcastStats();
      return;
    }
  }
}

// ── SOCKET EVENTS ──
io.on('connection', (socket) => {
  broadcastStats();

  socket.on('setInfo', (info) => {
    userInfo.set(socket.id, info);
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
    if (partnerId) io.to(partnerId).emit('message', { text: data.text });
  });

  socket.on('typing', (isTyping) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('typing', isTyping);
  });

  socket.on('report', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      const count = (reports.get(partnerId) || 0) + 1;
      reports.set(partnerId, count);
      socket.emit('reported');
      if (count >= 3) {
        io.to(partnerId).emit('banned');
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

  socket.on('disconnect', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      pairs.delete(partnerId);
      pairs.delete(socket.id);
      io.to(partnerId).emit('strangerLeft');
    }
    removeFromQueues(socket.id);
    userInfo.delete(socket.id);
    broadcastStats();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 StrangerChat running on port ${PORT}`);
});