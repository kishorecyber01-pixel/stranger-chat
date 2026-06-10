const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));

// State
const waitingQueue = []; // sockets waiting for a partner
const pairs = new Map();  // socketId -> partnerId

function getTotalUsers() {
  return io.sockets.sockets.size;
}

function broadcastStats() {
  io.emit('stats', { online: getTotalUsers(), waiting: waitingQueue.length });
}

function tryMatch() {
  while (waitingQueue.length >= 2) {
    const a = waitingQueue.shift();
    const b = waitingQueue.shift();

    // Make sure both are still connected
    if (!io.sockets.sockets.get(a) || !io.sockets.sockets.get(b)) {
      // Re-queue the one that's still alive
      if (io.sockets.sockets.get(a)) waitingQueue.unshift(a);
      if (io.sockets.sockets.get(b)) waitingQueue.unshift(b);
      continue;
    }

    pairs.set(a, b);
    pairs.set(b, a);

    io.to(a).emit('matched', { message: "You're now chatting with a stranger. Say hi!" });
    io.to(b).emit('matched', { message: "You're now chatting with a stranger. Say hi!" });
    broadcastStats();
  }
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id} | Total: ${getTotalUsers()}`);
  broadcastStats();

  // User wants to find a stranger
  socket.on('findStranger', () => {
    // Clean up any existing pair
    const existingPartner = pairs.get(socket.id);
    if (existingPartner) {
      pairs.delete(existingPartner);
      pairs.delete(socket.id);
      io.to(existingPartner).emit('strangerLeft');
    }

    // Remove from queue if already there
    const qi = waitingQueue.indexOf(socket.id);
    if (qi !== -1) waitingQueue.splice(qi, 1);

    // Add to queue
    waitingQueue.push(socket.id);
    socket.emit('waiting');
    broadcastStats();
    tryMatch();
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

  // User clicks Next / Stop
  socket.on('disconnect_chat', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      pairs.delete(partnerId);
      pairs.delete(socket.id);
      io.to(partnerId).emit('strangerLeft');
    }
    const qi = waitingQueue.indexOf(socket.id);
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
    const qi = waitingQueue.indexOf(socket.id);
    if (qi !== -1) waitingQueue.splice(qi, 1);
    broadcastStats();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 StrangerChat running on http://localhost:${PORT}`);
});