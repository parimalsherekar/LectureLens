# LLM Transcription Server

Socket.IO server that receives WebM/Opus audio chunks from the SFU client,
transcribes them with **faster-whisper** (local), and streams `transcriptSegment`
events back in real time.

```
SFU client  ──audioChunk──►  Node.js server  ──spawn──►  Python whisper_worker
            ◄─transcriptSegment──             ◄─stdout──
```

---

## Requirements

| Tool | Version |
|------|---------|
| Node.js | ≥ 18 |
| Python | ≥ 3.9 |
| ffmpeg | any recent (needed by faster-whisper to decode WebM) |

Install ffmpeg:
```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt install ffmpeg

# Windows
winget install ffmpeg
```

---

## Setup

### 1. Install Node dependencies
```bash
npm install
```

### 2. Install Python dependencies
```bash
pip install -r requirements.txt
```
> The first run will download the Whisper model weights (~150 MB for `base`).
> They are cached in `~/.cache/huggingface/` and reused on subsequent starts.

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env — at minimum set CLIENT_ORIGIN to your SFU client URL
```

### 4. Start
```bash
npm start          # production
npm run dev        # auto-restart on file changes (Node 18+)
```

Health check:
```
GET http://localhost:4000/health
→ { "status": "ok", "sessions": 0 }
```

---

## Wiring into the SFU client

Follow the steps in the integration guide (`useTranscript.js`).
Set the LLM server host/port in **Step 3**:

```js
llmSocketRef.current = llmIo('http://localhost:4000');
```

---

## Tuning

### Speed vs accuracy

Edit `.env`:

| `WHISPER_MODEL` | RTF (CPU) | Notes |
|-----------------|-----------|-------|
| `tiny`          | ~0.1×     | Fast, noisier |
| `base`          | ~0.2×     | **Default** — good for meetings |
| `small`         | ~0.5×     | Noticeably better accuracy |
| `medium`        | ~1×       | Real-time on modern CPU |
| `large-v3`      | ~3×       | Needs GPU for real-time |

RTF < 1 means faster than real-time. Chunks are ~3 s, so `base` on CPU
finishes in ~0.6 s per chunk — well within the 3 s window.

### Force a language
In `whisper_worker.py`, change:
```python
language=None,   # auto-detect
```
to:
```python
language="en",   # always English — slightly faster
```

### GPU acceleration
```env
WHISPER_DEVICE=cuda
WHISPER_COMPUTE=float16
```
Requires: NVIDIA GPU + CUDA 11.x/12.x + `pip install faster-whisper[gpu]`

---

## File layout

```
llm-transcript-server/
├── server.js            # Node.js Socket.IO server
├── whisper_worker.py    # Python faster-whisper child process
├── package.json
├── requirements.txt
├── .env.example
├── .env                 # your local config (git-ignored)
└── tmp_audio/           # auto-created, holds in-flight .webm chunks
```

---

## Architecture notes

- Chunks arrive as **binary Socket.IO messages** (Buffer on the Node side).
- Each chunk is written to `tmp_audio/` as a `.webm` file, passed to
  `whisper_worker.py` as `argv[1]`, and deleted immediately after.
- The worker is **spawned fresh per chunk** — simple, no memory leaks.
  If you need higher throughput, replace this with a persistent Python process
  that reads chunk paths from stdin (keep-alive worker pattern).
- Chunks are processed **serially per session** (queue in `drainQueue`).
  Parallel processing across sessions is automatic since each session has its
  own queue.
