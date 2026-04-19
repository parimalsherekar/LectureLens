import { createServer } from 'http';
import { Server } from 'socket.io';
import { spawn } from 'child_process';
import { writeFile, unlink, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── load .env ────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (existsSync(envPath)) {
  const envFile = await readFile(envPath, 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
  console.log('[config] loaded .env');
}

const PORT           = process.env.PORT          || 4000;
const ALLOWED_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:3000';
const AUDIO_TMP_DIR  = path.join(__dirname, 'tmp_audio');

// Number of parallel Whisper workers.
// One worker handles one chunk at a time (the model is not thread-safe).
// With 3 workers, chunks #1, #2, #3 all run simultaneously instead of queuing.
// Keep at 3 for a 4 GB GPU — each small-model instance uses ~500 MB VRAM.
const WORKER_POOL_SIZE = parseInt(process.env.WHISPER_WORKERS || '3', 10);

// ── auto-detect Python / venv ─────────────────────────────────────────────────
const IS_WINDOWS = process.platform === 'win32';

function findPythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  for (const name of ['venv', '.venv', 'env']) {
    const candidate = IS_WINDOWS
      ? path.join(__dirname, name, 'Scripts', 'python.exe')
      : path.join(__dirname, name, 'bin', 'python3');
    if (existsSync(candidate)) {
      console.log('[config] auto-detected venv: ' + candidate);
      return candidate;
    }
  }
  return IS_WINDOWS ? 'python' : 'python3';
}

const PYTHON_BIN = findPythonBin();
console.log('[config] platform    : ' + process.platform);
console.log('[config] python bin  : ' + PYTHON_BIN);
console.log('[config] worker pool : ' + WORKER_POOL_SIZE);

if (!existsSync(AUDIO_TMP_DIR)) {
  await mkdir(AUDIO_TMP_DIR, { recursive: true });
}

// ── WebM header extraction ────────────────────────────────────────────────────
//
// MediaRecorder only writes the WebM EBML header + Tracks into the FIRST blob.
// Every subsequent blob is a raw Cluster block — valid as a stream continuation
// but rejected by ffmpeg as a standalone file ("Invalid data found").
//
// We fix this by prepending the header bytes from chunk #0 to every later chunk.
//
// The header is found by locating the first Cluster EBML element (0x1F43B675).
// Everything before it is the reusable header.
//
// IMPORTANT: 0x1F43B675 can appear inside compressed audio data as a coincidence.
// We guard against false positives by requiring the header to be at least 100
// bytes — a real WebM header always contains EBML + Segment + SeekHead + Info +
// Tracks elements, which together are several hundred bytes minimum.
//
// ── WebM EBML element IDs ──────────────────────────────────────────────────
// 1A 45 DF A3  EBML
// 18 53 80 67  Segment
// 11 4D 9B 74  SeekHead   ← contains seek entries whose byte values can
//                            accidentally match the Cluster ID → false positives
// 15 49 A9 66  Info
// 16 54 AE 6B  Tracks     ← codec/sample-rate info; Cluster always comes after
// 1F 43 B6 75  Cluster    ← first actual audio data; this is our split point
//
// CORRECT STRATEGY:
//   1. Find the Tracks element (16 54 AE 6B). It always precedes the Cluster.
//   2. Search for Cluster (1F 43 B6 75) only in the bytes AFTER Tracks.
//   This eliminates false positives in SeekHead seek entries entirely.

function findTracksOffset(buf) {
  // Tracks EBML element ID: 16 54 AE 6B
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x16 && buf[i+1] === 0x54 && buf[i+2] === 0xAE && buf[i+3] === 0x6B) {
      return i;
    }
  }
  return -1;
}

function findClusterOffset(buf) {
  // First locate Tracks so we only search for Cluster after it.
  const tracksOffset = findTracksOffset(buf);
  const searchFrom = tracksOffset >= 0 ? tracksOffset : 100;

  // Cluster EBML element ID: 1F 43 B6 75
  for (let i = searchFrom; i <= buf.length - 4; i++) {
    if (buf[i] === 0x1F && buf[i+1] === 0x43 && buf[i+2] === 0xB6 && buf[i+3] === 0x75) {
      return i;
    }
  }
  return -1;
}

function extractWebmHeader(firstChunkBuf) {
  const tracksOffset = findTracksOffset(firstChunkBuf);
  const clusterOffset = findClusterOffset(firstChunkBuf);

  console.log('[webm] scan — Tracks at byte ' + tracksOffset + '  Cluster at byte ' + clusterOffset + '  chunk size: ' + (firstChunkBuf.length / 1024).toFixed(1) + ' KB');

  // Validate: cluster must come after tracks, and header must be a sensible size.
  // A real WebM header (EBML + Segment + SeekHead + Info + Tracks) is at least
  // 300 bytes. If we get less, something is wrong — fall back to full first chunk.
  if (clusterOffset < 300 || (tracksOffset >= 0 && clusterOffset < tracksOffset)) {
    console.log('[webm] header too small or invalid (' + clusterOffset + ' bytes) — using full first chunk as header');
    return firstChunkBuf;
  }

  const header = firstChunkBuf.slice(0, clusterOffset);
  console.log('[webm] header extracted: ' + (header.length / 1024).toFixed(2) + ' KB (Tracks at ' + tracksOffset + ', Cluster at ' + clusterOffset + ')');
  return header;
}

// ── Whisper worker pool ───────────────────────────────────────────────────────
//
// WHY A POOL?
// The Whisper model is not thread-safe and cannot process two files simultaneously
// in a single process. With a single worker, every chunk waits in a queue behind
// the previous one. If transcribing a 30s chunk takes 35s, the queue grows by 1
// every chunk and the system falls further and further behind.
//
// A pool of N workers processes N chunks in parallel. Each worker is an
// independent Python process with its own model instance loaded into GPU/CPU.
// Workers take jobs from a shared queue using a simple round-robin + idle-slot
// approach: when a job arrives, it's dispatched to the first idle worker.
//
// With WORKER_POOL_SIZE=3 and a GTX 1650 (4 GB):
//   - small model: ~500 MB VRAM per worker → 3 workers = 1.5 GB → fine
//   - If you see CUDA OOM errors, set WHISPER_WORKERS=2 in .env
//
class WhisperWorkerPool {
  constructor(size) {
    this.size = size;
    // Each worker: { proc, ready, busy, stderrBuf, rl }
    this.workers = [];
    // Queue of { filePath, resolve, reject } waiting for a free worker
    this.queue = [];
  }

  start() {
    for (let i = 0; i < this.size; i++) {
      this._spawnWorker(i);
    }
  }

  _spawnWorker(id) {
    console.log('[whisper-pool] spawning worker #' + id);
    const proc = spawn(PYTHON_BIN, [path.join(__dirname, 'whisper_worker.py')], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    const worker = { id, proc, ready: false, busy: false, stderrBuf: '' };
    this.workers[id] = worker;

    proc.stderr.on('data', (d) => {
      worker.stderrBuf += d.toString();
      const lines = worker.stderrBuf.split('\n');
      worker.stderrBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        console.log('[whisper-' + id + '] ' + line);
        if (line.includes('[worker] ready')) {
          worker.ready = true;
          console.log('[whisper-pool] worker #' + id + ' ready ✓');
          // If jobs were queued before this worker finished loading, dispatch now
          this._dispatch();
        }
      }
    });

    const rl = createInterface({ input: proc.stdout });
    worker.rl = rl;
    // Each worker carries exactly one pending resolver at a time (since busy=true
    // while it's processing). We store it on the worker object, not in a shared array.
    worker.pendingResolver = null;

    rl.on('line', (line) => {
      const resolver = worker.pendingResolver;
      worker.pendingResolver = null;
      worker.busy = false;
      if (!resolver) {
        console.warn('[whisper-' + id + '] unexpected stdout: ' + line.slice(0, 80));
        return;
      }
      try {
        resolver.resolve(JSON.parse(line));
      } catch (e) {
        resolver.reject(new Error('Bad whisper output: ' + line.slice(0, 80)));
      }
      // A worker just freed up — dispatch the next queued job immediately
      this._dispatch();
    });

    proc.on('close', (code) => {
      console.error('[whisper-pool] worker #' + id + ' exited (code ' + code + ') — restarting in 3s');
      worker.ready = false;
      worker.busy = false;
      if (worker.pendingResolver) {
        worker.pendingResolver.reject(new Error('Worker #' + id + ' died'));
        worker.pendingResolver = null;
      }
      setTimeout(() => this._spawnWorker(id), 3000);
    });

    proc.on('error', (err) => console.error('[whisper-pool] worker #' + id + ' spawn error: ' + err.message));
  }

  // Dispatch the next queued job to the first idle+ready worker
  _dispatch() {
    if (this.queue.length === 0) return;
    const worker = this.workers.find(w => w.ready && !w.busy);
    if (!worker) return;  // all workers busy — job stays in queue
    const { filePath, resolve, reject } = this.queue.shift();
    worker.busy = true;
    worker.pendingResolver = { resolve, reject };
    console.log('[whisper-pool] dispatching to worker #' + worker.id + '  queue remaining: ' + this.queue.length);
    worker.proc.stdin.write(filePath + '\n');
  }

  // Submit a file for transcription — returns a Promise
  transcribe(filePath) {
    return new Promise((resolve, reject) => {
      this.queue.push({ filePath, resolve, reject });
      console.log('[whisper-pool] job queued  total queue: ' + this.queue.length + '  idle workers: ' + this.workers.filter(w => w.ready && !w.busy).length);
      this._dispatch();
    });
  }

  get allReady() {
    return this.workers.length === this.size && this.workers.every(w => w.ready);
  }

  get anyReady() {
    return this.workers.some(w => w.ready);
  }

  get status() {
    return this.workers.map(w => (w.ready ? (w.busy ? 'busy' : 'idle') : 'loading')).join(', ');
  }
}

const pool = new WhisperWorkerPool(WORKER_POOL_SIZE);
pool.start();

// ── HTTP + Socket.IO ──────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:  'ok',
      workers: pool.status,
      queue:   pool.queue.length,
      sessions: sessions.size,
    }));
    return;
  }
  res.writeHead(404); res.end();
});

const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGIN, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 10 * 1024 * 1024,
});

const sessions = new Map();

// ── transcribeChunk ───────────────────────────────────────────────────────────
async function transcribeChunk(sessionId, chunkBuf, chunkIndex, startOffset) {
  console.log('[transcribeChunk] START #' + chunkIndex + '  session=' + sessionId + '  offset=' + startOffset + 's  pool=' + pool.status);

  const session = sessions.get(sessionId);
  if (!session) {
    console.error('[transcribeChunk] ABORT — session gone');
    return;
  }

  const getSocket = () => io.sockets.sockets.get(session.socketId);

  const emitResult = (payload) => {
    const s = getSocket();
    if (s?.connected) s.emit('transcriptSegment', payload);
    else io.emit('transcriptSegment', payload);
  };

  const filePath = path.join(AUDIO_TMP_DIR, sessionId + '_chunk' + chunkIndex + '.webm');

  try {
    await writeFile(filePath, chunkBuf);

    if (!pool.anyReady) {
      console.warn('[transcribeChunk] no workers ready yet — job will queue until a worker loads');
    }

    const t0 = Date.now();
    const rawSegments = await pool.transcribe(filePath);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('[transcribeChunk] #' + chunkIndex + ' done in ' + elapsed + 's — ' + (rawSegments?.length ?? 0) + ' segments');

    if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
      emitResult({ sessionId, text: '', startOffset, endOffset: startOffset, chunkIndex });
      return;
    }

    for (const seg of rawSegments) {
      if (!seg.text?.trim()) continue;
      const payload = {
        sessionId,
        text:        seg.text.trim(),
        startOffset: parseFloat((startOffset + seg.start).toFixed(2)),
        endOffset:   parseFloat((startOffset + seg.end).toFixed(2)),
        chunkIndex,
      };
      console.log('[transcribeChunk]   -> "' + payload.text.slice(0, 60) + '"');
      emitResult(payload);
    }

  } catch (err) {
    console.error('[transcribeChunk] ERROR #' + chunkIndex + ': ' + err.message);
    emitResult({ sessionId, text: '[transcription error]', startOffset, endOffset: startOffset, chunkIndex });

  } finally {
    unlink(filePath).catch(() => {});
  }
}

// ── Socket.IO handlers ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[socket] connected: ' + socket.id);

  socket.on('startSession', ({ sessionId }) => {
    if (!sessionId) return;
    sessions.set(sessionId, {
      socketId:   socket.id,
      chunks:     [],
      chunkMeta:  [],
      webmHeader: null,
      ended:      false,
    });
    console.log('[' + sessionId + '] session started');
  });

  socket.on('audioChunk', ({ sessionId, chunk, startOffset, chunkIndex }) => {
    console.log('\n[audioChunk] #' + chunkIndex + '  session=' + sessionId + '  offset=' + startOffset + 's');

    const session = sessions.get(sessionId);
    if (!session) {
      console.error('[audioChunk] DROPPED — no session "' + sessionId + '". Active: [' + [...sessions.keys()].join(', ') + ']');
      return;
    }
    if (session.ended) {
      console.warn('[audioChunk] DROPPED — session ended');
      return;
    }

    session.socketId = socket.id;
    const rawBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    // ── WebM header fix ─────────────────────────────────────────────────────
    let transcribeBuf;
    if (chunkIndex === 0) {
      session.webmHeader = extractWebmHeader(rawBuf);
      transcribeBuf = rawBuf;
      console.log('[audioChunk] header saved: ' + (session.webmHeader.length / 1024).toFixed(1) + ' KB');
    } else if (session.webmHeader) {
      transcribeBuf = Buffer.concat([session.webmHeader, rawBuf]);
      console.log('[audioChunk] header prepended: ' + (session.webmHeader.length / 1024).toFixed(1) + ' KB + ' + (rawBuf.length / 1024).toFixed(1) + ' KB = ' + (transcribeBuf.length / 1024).toFixed(1) + ' KB');
    } else {
      console.error('[audioChunk] SKIP chunk #' + chunkIndex + ' — no header (chunk #0 missing). Restart recording.');
      const s = io.sockets.sockets.get(session.socketId);
      const p = { sessionId, text: '', startOffset, endOffset: startOffset, chunkIndex };
      if (s?.connected) s.emit('transcriptSegment', p); else io.emit('transcriptSegment', p);
      return;
    }

    session.chunks.push(rawBuf);
    session.chunkMeta.push({ index: chunkIndex, startOffset });

    console.log('[audioChunk] raw: ' + (rawBuf.length / 1024).toFixed(1) + ' KB  pool: ' + pool.status);
    transcribeChunk(sessionId, transcribeBuf, chunkIndex, startOffset);
  });

  socket.on('endSession', ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.ended = true;
    sessions.delete(sessionId);
    console.log('[' + sessionId + '] session ended and cleaned up');
  });

  socket.on('disconnect', () => { console.log('[socket] disconnected: ' + socket.id); });
});

httpServer.listen(PORT, () => {
  console.log('\nLLM Transcription Server on port ' + PORT);
  console.log('  Health  : http://localhost:' + PORT + '/health');
  console.log('  CORS    : ' + ALLOWED_ORIGIN);
  console.log('  Workers : ' + WORKER_POOL_SIZE + ' (loading Whisper models...)\n');
});