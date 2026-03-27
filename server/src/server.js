const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { createWorker } = require('./mediasoupWorker');
const Room = require('./Room');

const PORT = process.env.PORT || 3001;

// ─── App setup ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// rooms: Map<roomId, Room>
const rooms = new Map();

// transcripts: Map<roomId, TranscriptRecord>
// TranscriptRecord = { roomId, meetingStart, meetingEnd, status, segments[], fullText }
const transcripts = new Map();

// ─── REST endpoints ──────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Get transcript for a room (available only after meeting ends)
app.get('/transcript/:roomId', (req, res) => {
  const record = transcripts.get(req.params.roomId);
  if (!record) return res.status(404).json({ error: 'Transcript not found' });
  if (record.status !== 'complete') {
    return res.status(403).json({ error: 'Transcript not yet available — meeting still in progress' });
  }
  res.json(record);
});

// ─── mediasoup init ──────────────────────────────────────────────────────────

async function bootstrap() {
  await createWorker();
  console.log('[Server] mediasoup worker ready');

  httpServer.listen(PORT, () => {
    console.log(`[Server] Listening on http://localhost:${PORT}`);
  });
}

// ─── Socket.IO signaling ─────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Track which room this socket is in (for cleanup on disconnect)
  let currentRoomId = null;

  // ── Create room (host only) ──────────────────────────────────────────────

  socket.on('createRoom', async (_data, callback) => {
    try {
      const roomId = uuidv4().slice(0, 8).toUpperCase(); // short code e.g. "A3F9B2C1"
      const room = await new Room(roomId).init();
      rooms.set(roomId, room);

      room.addPeer(socket.id, 'host');
      socket.join(roomId);
      currentRoomId = roomId;

      console.log(`[Room ${roomId}] Created by host ${socket.id}`);
      callback({ roomId, rtpCapabilities: room.rtpCapabilities });
    } catch (err) {
      console.error('[createRoom] Error:', err);
      callback({ error: err.message });
    }
  });

  // ── Join room (participant) ──────────────────────────────────────────────

  socket.on('joinRoom', async ({ roomId }, callback) => {
    try {
      const room = rooms.get(roomId);
      if (!room) return callback({ error: `Room ${roomId} not found` });

      room.addPeer(socket.id, 'participant');
      socket.join(roomId);
      currentRoomId = roomId;

      // Let existing peers know someone joined
      socket.to(roomId).emit('peerJoined', { peerId: socket.id });

      console.log(`[Room ${roomId}] Participant joined: ${socket.id}`);
      callback({ rtpCapabilities: room.rtpCapabilities });
    } catch (err) {
      console.error('[joinRoom] Error:', err);
      callback({ error: err.message });
    }
  });

  // ── Create WebRTC transport ──────────────────────────────────────────────

  socket.on('createTransport', async ({ direction }, callback) => {
    try {
      const room = rooms.get(currentRoomId);
      if (!room) return callback({ error: 'Room not found' });

      const transportParams = await room.createWebRtcTransport(socket.id);

      // Tag transport with direction so Room.consume() can find the recv one
      const peer = room.getPeer(socket.id);
      const transport = peer.transports.get(transportParams.id);
      transport.appData = { direction };

      callback({ transportParams });
    } catch (err) {
      console.error('[createTransport] Error:', err);
      callback({ error: err.message });
    }
  });

  // ── Connect transport (DTLS handshake) ──────────────────────────────────

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      const room = rooms.get(currentRoomId);
      if (!room) return callback({ error: 'Room not found' });

      await room.connectTransport(socket.id, transportId, dtlsParameters);
      callback({ connected: true });
    } catch (err) {
      console.error('[connectTransport] Error:', err);
      callback({ error: err.message });
    }
  });

  // ── Produce (host sends audio/video) ────────────────────────────────────

  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    try {
      const room = rooms.get(currentRoomId);
      if (!room) return callback({ error: 'Room not found' });

      const producerId = await room.produce(socket.id, transportId, kind, rtpParameters);

      // Notify all other peers in the room that a new producer is available
      socket.to(currentRoomId).emit('newProducer', {
        producerId,
        kind,
        peerId: socket.id,
      });

      callback({ producerId });
    } catch (err) {
      console.error('[produce] Error:', err);
      callback({ error: err.message });
    }
  });

  // ── Consume (participant receives media) ─────────────────────────────────

  socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
    try {
      const room = rooms.get(currentRoomId);
      if (!room) return callback({ error: 'Room not found' });

      const consumerParams = await room.consume(socket.id, producerId, rtpCapabilities);
      callback({ consumerParams });
    } catch (err) {
      console.error('[consume] Error:', err);
      callback({ error: err.message });
    }
  });

  // ── Resume consumer (client signals it's ready to receive) ──────────────

  socket.on('resumeConsumer', async ({ consumerId }, callback) => {
    try {
      const room = rooms.get(currentRoomId);
      if (!room) return callback({ error: 'Room not found' });

      const peer = room.getPeer(socket.id);
      const consumer = peer?.consumers.get(consumerId);
      if (!consumer) return callback({ error: 'Consumer not found' });

      await consumer.resume();
      callback({ resumed: true });
    } catch (err) {
      console.error('[resumeConsumer] Error:', err);
      callback({ error: err.message });
    }
  });

  // ── Get existing producers (when joining a room with active streams) ──────

  socket.on('getProducers', (_data, callback) => {
    try {
      const room = rooms.get(currentRoomId);
      if (!room) return callback({ error: 'Room not found' });

      const producers = room.getProducerList(socket.id);
      callback({ producers });
    } catch (err) {
      console.error('[getProducers] Error:', err);
      callback({ error: err.message });
    }
  });

  // ── Transcript: host starts recording ───────────────────────────────

  socket.on('startTranscription', ({ roomId }) => {
    if (transcripts.has(roomId)) return; // already started
    transcripts.set(roomId, {
      roomId,
      meetingStart: Date.now(),
      meetingEnd: null,
      status: 'live',
      segments: [],
      fullText: '',
    });
    console.log(`[Transcript ${roomId}] Started`);
  });

  // ── Transcript: host syncs text segments periodically ───────────────

  socket.on('syncTranscript', ({ roomId, segments, fullText }) => {
    const record = transcripts.get(roomId);
    if (!record || record.status === 'complete') return;
    record.segments = segments;
    record.fullText = fullText || '';
    console.log(`[Transcript ${roomId}] Synced — ${segments.length} segments`);
  });

  // ── Transcript: host ends the meeting, marks transcript complete ─────

  socket.on('endTranscription', ({ roomId }) => {
    const record = transcripts.get(roomId);
    if (!record) return;
    record.status = 'complete';
    record.meetingEnd = Date.now();
    console.log(`[Transcript ${roomId}] Complete — ${record.segments.length} segments`);
  });

  // ── Transcript: participant fetches post-meeting transcript ──────────

  socket.on('getTranscript', ({ roomId }, callback) => {
    const record = transcripts.get(roomId);
    if (!record) return callback({ error: 'Transcript not found' });
    if (record.status !== 'complete') {
      return callback({ error: 'Transcript not yet available — meeting still in progress' });
    }
    callback(record);
  });

  // ── Chat message ────────────────────────────────────────────────────

  socket.on('chatMessage', ({ message }, callback) => {
    try {
      const room = rooms.get(currentRoomId);
      if (!room) return callback?.({ error: 'Room not found' });

      socket.to(currentRoomId).emit('chatMessage', {
        peerId: socket.id,
        message,
        timestamp: Date.now(),
      });
      callback?.({ sent: true });
    } catch (err) {
      console.error('[chatMessage] Error:', err);
      callback?.({ error: err.message });
    }
  });

  // ── Disconnect / cleanup ─────────────────────────────────────────────────

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);

    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.removePeer(socket.id);
    socket.to(currentRoomId).emit('peerLeft', { peerId: socket.id });

    // Clean up empty rooms
    if (room.isEmpty()) {
      rooms.delete(currentRoomId);
      console.log(`[Room ${currentRoomId}] Deleted (empty)`);
    }
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

bootstrap().catch((err) => {
  console.error('[Server] Fatal error during bootstrap:', err);
  process.exit(1);
});
