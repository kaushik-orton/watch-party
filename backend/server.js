const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Port configuration
const PORT = process.env.PORT || 5000;

// Track active rooms and users
// rooms: { [roomId]: { [socketId]: { username, isHost, socketId } } }
const rooms = {};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // 1. Join Room
  socket.on('join-room', ({ roomId, username }) => {
    socket.join(roomId);
    
    if (!rooms[roomId]) {
      rooms[roomId] = {};
    }

    // First user to join becomes host
    const isHost = Object.keys(rooms[roomId]).length === 0;

    rooms[roomId][socket.id] = {
      socketId: socket.id,
      username: username || `Guest-${socket.id.slice(0, 4)}`,
      isHost
    };

    console.log(`User ${username} (${socket.id}) joined room: ${roomId} as ${isHost ? 'Host' : 'Guest'}`);

    // Send the current list of users to the joined user
    socket.emit('room-users', {
      users: Object.values(rooms[roomId]),
      userId: socket.id
    });

    // Notify others in the room
    socket.to(roomId).emit('user-joined', rooms[roomId][socket.id]);
  });

  // 2. WebRTC Signaling: Offer, Answer, Ice Candidate
  // Forward signaling data to a specific peer
  socket.on('webrtc-signal', ({ targetId, signalData }) => {
    io.to(targetId).emit('webrtc-signal', {
      senderId: socket.id,
      signalData
    });
  });

  // 3. Playback Synchronization Actions (play, pause, seek, speed)
  socket.on('playback-sync', ({ roomId, action, time, speed }) => {
    console.log(`Sync action [${action}] in room [${roomId}] to time [${time}] from socket [${socket.id}]`);
    // Broadcast to everyone else in the room
    socket.to(roomId).emit('playback-sync', {
      senderId: socket.id,
      action,
      time,
      speed
    });
  });

  // 4. Room Control (e.g. host changed, or sync request)
  socket.on('request-sync', ({ roomId }) => {
    // A guest requests the current playback state from the host
    const host = Object.values(rooms[roomId] || {}).find(u => u.isHost);
    if (host) {
      io.to(host.socketId).emit('request-current-state', { requesterId: socket.id });
    }
  });

  socket.on('send-current-state', ({ targetId, time, playing, speed, videoUrl }) => {
    // Host sends the current state back to the requester
    io.to(targetId).emit('current-state', { time, playing, speed, videoUrl });
  });

  // 5. Chat Messages
  socket.on('chat-message', ({ roomId, text }) => {
    const user = rooms[roomId]?.[socket.id];
    if (user) {
      const message = {
        id: Math.random().toString(36).substring(2, 9),
        sender: user.username,
        senderId: socket.id,
        text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      io.to(roomId).emit('chat-message', message);
    }
  });

  // 6. Reactions
  socket.on('send-reaction', ({ roomId, reaction }) => {
    const user = rooms[roomId]?.[socket.id];
    if (user) {
      io.to(roomId).emit('reaction', {
        senderId: socket.id,
        username: user.username,
        reaction
      });
    }
  });

  // 7. Disconnect / Leave
  socket.on('disconnecting', () => {
    // Find rooms the socket was in
    for (const roomId of socket.rooms) {
      if (rooms[roomId] && rooms[roomId][socket.id]) {
        const leftUser = rooms[roomId][socket.id];
        delete rooms[roomId][socket.id];

        console.log(`User ${leftUser.username} left room: ${roomId}`);

        // Notify others
        socket.to(roomId).emit('user-left', { socketId: socket.id });

        // If the host left and there are still users, assign a new host
        const remainingUsers = Object.values(rooms[roomId]);
        if (leftUser.isHost && remainingUsers.length > 0) {
          const newHost = remainingUsers[0];
          newHost.isHost = true;
          io.to(roomId).emit('host-changed', { newHostId: newHost.socketId });
          console.log(`New host assigned in room ${roomId}: ${newHost.username}`);
        }

        // Clean up empty room
        if (remainingUsers.length === 0) {
          delete rooms[roomId];
          console.log(`Room ${roomId} is now empty and has been removed.`);
        }
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

app.get('/', (req, res) => {
  res.send('Watch Party Signaling Server is running.');
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
