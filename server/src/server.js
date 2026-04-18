require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');

const { createWorker }    = require('./mediasoupWorker');
const Room                = require('./Room');
const { connectDB }       = require('./db');
const { authMiddleware, verifySocketToken } = require('./middleware/authMiddleware');
const authRoutes          = require('./routes/auth');
const Meeting             = require('./models/Meeting');
const Transcript          = require('./models/Transcript');

const PORT = process.env.PORT || 3001;

// ─── App setup ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// rooms: Map<roomId, Room>  (in-memory mediasoup state, not persisted)
const rooms = new Map();

function formatTranscriptText(transcript) {
  const header = [
    `Room: ${transcript.roomId}`,
    transcript.meetingStart ? `Started: ${new Date(transcript.meetingStart).toISOString()}` : null,
    transcript.meetingEnd ? `Ended: ${new Date(transcript.meetingEnd).toISOString()}` : null,
    '',
  ].filter(line => line !== null);

  const body = transcript.fullText?.trim()
    || transcript.segments
      .filter(seg => seg?.text && seg.text !== '--- TRANSCRIPT COMPLETED ---')
      .map(seg => {
        const time = seg.startOffset == null ? '' : `[${formatOffset(seg.startOffset)}] `;
        return `${time}${seg.text}`;
      })
      .join('\n');

  return `${header.join('\n')}${body || 'No transcript text available.'}\n`;
}

function formatOffset(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function transcriptFileName(roomId) {
  return `transcript-${String(roomId).replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`;
}

// ─── REST endpoints ──────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/auth', authRoutes);

// Get all meetings the logged-in user participated in
app.get('/meetings', authMiddleware, async (req, res) => {
  try {
    const meetings = await Meeting.find({ participants: req.user.userId })
      .populate('hostId', 'name email')
      .sort({ createdAt: -1 });

    const roomIds = meetings.map(m => m._id);
    const transcripts = await Transcript.find(
      { roomId: { $in: roomIds } },
      'roomId status'
    );
    const transcriptMap = {};
    transcripts.forEach(t => { transcriptMap[t.roomId] = t.status; });

    const result = meetings.map(m => ({
      roomId:           m._id,
      host:             m.hostId,
      isHost:           m.hostId._id.toString() === req.user.userId,
      status:           m.status,
      createdAt:        m.createdAt,
      endedAt:          m.endedAt,
      transcriptStatus: transcriptMap[m._id] || null,
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get transcript — requires auth + must have been a participant
app.get('/transcript/:roomId', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user.userId;

    const meeting = await Meeting.findOne({ _id: roomId, participants: userId });
    if (!meeting) return res.status(403).json({ error: 'Access denied' });

    const transcript = await Transcript.findOne({ roomId });
    if (!transcript) return res.status(404).json({ error: 'Transcript not found' });
    if (transcript.status !== 'complete')
      return res.status(403).json({ error: 'Transcript not yet available — meeting still in progress' });

    res.json(transcript);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download transcript as a .txt file — requires auth + must have been a participant
app.get('/transcript/:roomId/download', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user.userId;

    const meeting = await Meeting.findOne({ _id: roomId, participants: userId });
    if (!meeting) return res.status(403).json({ error: 'Access denied' });

    const transcript = await Transcript.findOne({ roomId });
    if (!transcript) return res.status(404).json({ error: 'Transcript not found' });
    if (transcript.status !== 'complete')
      return res.status(403).json({ error: 'Transcript not yet available - meeting still in progress' });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${transcriptFileName(roomId)}"`);
    res.send(formatTranscriptText(transcript));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Socket.IO auth middleware ────────────────────────────────────────────────

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = verifySocketToken(token);
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

// ─── mediasoup init ──────────────────────────────────────────────────────────

async function bootstrap() {
  await connectDB();
  await createWorker();
  console.log('[Server] mediasoup worker ready');

  httpServer.listen(PORT, () => {
    console.log(`[Server] Listening on http://localhost:${PORT}`);
  });
}

// ─── Socket.IO signaling ─────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id} (user: ${socket.user.email})`);

  // Track which room this socket is in (for cleanup on disconnect)
  let currentRoomId = null;

  // ── Create room (host only) ──────────────────────────────────────────────

  socket.on('createRoom', async (_data, callback) => {
    try {
      const roomId = uuidv4().slice(0, 8).toUpperCase();
      const room = await new Room(roomId).init();
      rooms.set(roomId, room);

      room.addPeer(socket.id, 'host');
      socket.join(roomId);
      currentRoomId = roomId;

      // Persist room and record host as participant
      await Meeting.create({
        _id:          roomId,
        hostId:       socket.user.userId,
        participants: [socket.user.userId],
      });

      console.log(`[Room ${roomId}] Created by host ${socket.user.email}`);
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

      // Add participant to meeting (addToSet prevents duplicates on reconnect)
      await Meeting.findByIdAndUpdate(roomId, {
        $addToSet: { participants: socket.user.userId },
      });

      socket.to(roomId).emit('peerJoined', { peerId: socket.id });

      console.log(`[Room ${roomId}] Participant joined: ${socket.user.email}`);
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

  // ── Resume consumer ──────────────────────────────────────────────────────

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

  // ── Get existing producers ────────────────────────────────────────────────

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

  // ── Transcript: host starts recording ────────────────────────────────────

  socket.on('startTranscription', async ({ roomId }) => {
    try {
      const existing = await Transcript.findOne({ roomId });
      if (existing) return;

      await Transcript.create({
        roomId,
        meetingStart: Date.now(),
        status: 'live',
        segments: [],
        fullText: '',
      });
      console.log(`[Transcript ${roomId}] Started`);
    } catch (err) {
      console.error('[startTranscription] Error:', err);
    }
  });

  // ── Transcript: host syncs text segments periodically ────────────────────

  socket.on('syncTranscript', async ({ roomId, segments, fullText }) => {
    try {
      await Transcript.findOneAndUpdate(
        { roomId, status: 'live' },
        { segments, fullText: fullText || '' }
      );
      console.log(`[Transcript ${roomId}] Synced — ${segments.length} segments`);
    } catch (err) {
      console.error('[syncTranscript] Error:', err);
    }
  });

  // ── Transcript: host ends meeting, marks transcript complete ─────────────

  socket.on('endTranscription', async ({ roomId }) => {
    try {
      const transcript = await Transcript.findOne({ roomId });
      const completionSegment = {
        id:          (transcript?.segments?.length ?? 0) + 1,
        chunkIndex:  -1,
        text:        '--- TRANSCRIPT COMPLETED ---',
        startOffset: null,
        endOffset:   null,
        timestamp:   Date.now(),
        status:      'complete',
      };

      await Transcript.findOneAndUpdate(
        { roomId },
        {
          status:      'complete',
          meetingEnd:  Date.now(),
          fullText:    (transcript?.fullText ?? '') + '\n--- TRANSCRIPT COMPLETED ---',
          $push:       { segments: completionSegment },
        }
      );
      await Meeting.findByIdAndUpdate(roomId, { status: 'ended', endedAt: new Date() });
      console.log(`[Transcript ${roomId}] Complete`);
    } catch (err) {
      console.error('[endTranscription] Error:', err);
    }
  });

  // ── Transcript: fetch post-meeting transcript (auth + participant check) ──

  socket.on('getTranscript', async ({ roomId }, callback) => {
    try {
      const meeting = await Meeting.findOne({ _id: roomId, participants: socket.user.userId });
      if (!meeting) return callback({ error: 'Access denied' });

      const transcript = await Transcript.findOne({ roomId });
      if (!transcript) return callback({ error: 'Transcript not found' });
      if (transcript.status !== 'complete')
        return callback({ error: 'Transcript not yet available — meeting still in progress' });

      callback(transcript.toObject());
    } catch (err) {
      console.error('[getTranscript] Error:', err);
      callback({ error: err.message });
    }
  });

  // ── Chat message ─────────────────────────────────────────────────────────

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
