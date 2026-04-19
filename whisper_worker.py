"""
whisper_worker.py — persistent mode

Loads the Whisper model ONCE at startup, then reads audio file paths from
stdin line-by-line and writes JSON segment arrays to stdout.

With 30-second audio chunks from the client, the model receives a solid
enough context window to produce accurate, well-punctuated transcriptions.
No chunking strategy changes are needed here — the server.js layer handles
slicing and we just process whatever file we're given.

Gracefully falls back to CPU if CUDA is requested but unavailable.

Environment variables (all optional, set in .env or shell):
  WHISPER_MODEL    — model size: tiny | base | small | medium | large-v2 (default: base)
  WHISPER_DEVICE   — cpu | cuda (default: cpu)
  WHISPER_COMPUTE  — int8 | float16 | float32 (default: int8)
  WHISPER_LANG     — ISO 639-1 language code, e.g. "en" | "" for auto-detect (default: en)
  WHISPER_BEAM     — beam search width; 1 = greedy / fastest (default: 1)
  PYTHON_BIN       — override the Python interpreter path (used by server.js)
"""

import sys
import os
import subprocess
import json
import shutil

MODEL_SIZE   = os.environ.get("WHISPER_MODEL",   "small")
DEVICE       = os.environ.get("WHISPER_DEVICE",  "cuda")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "float16")
LANGUAGE     = os.environ.get("WHISPER_LANG",    "en")
BEAM_SIZE    = int(os.environ.get("WHISPER_BEAM", "1"))

def log(msg):
    """Write a diagnostic message to stderr (visible in server.js console)."""
    print(f"[worker] {msg}", file=sys.stderr, flush=True)

# ── CUDA DLL setup on Windows ─────────────────────────────────────────────────
# Must run BEFORE any import of faster_whisper / ctranslate2.
# Two strategies used together for maximum reliability:
#   1. os.add_dll_directory  — registers search path for LoadLibrary
#   2. ctypes.CDLL            — force-loads the DLL by absolute path,
#      bypassing Windows search order entirely (most reliable on broken toolkits)
if sys.platform == 'win32' and DEVICE == 'cuda':
    import ctypes as _ctypes
    _dlls_loaded = []
    _dirs_added  = []

    def _reg_dir(d):
        if os.path.isdir(d):
            try: os.add_dll_directory(d); _dirs_added.append(d)
            except Exception: pass

    def _load_dll(p):
        if os.path.isfile(p):
            try: _ctypes.CDLL(p); _dlls_loaded.append(os.path.basename(p))
            except Exception as e:
                print('[worker] load-failed ' + p + ': ' + str(e), file=sys.stderr, flush=True)

    # Scan sys.path for pip-installed nvidia-* packages.
    # sys.path always has venv site-packages; getsitepackages() returns [] in
    # venvs on Python 3.13 Windows, so we never use it.
    _critical = ['cublas64_12.dll', 'cublasLt64_12.dll', 'cudnn_ops_infer64_8.dll', 'cudnn64_8.dll']
    for _sp in sys.path:
        _nr = os.path.join(_sp, 'nvidia')
        if os.path.isdir(_nr):
            for _pkg in os.listdir(_nr):
                for _sub in ['bin', 'lib']:
                    _bd = os.path.join(_nr, _pkg, _sub)
                    _reg_dir(_bd)
                    for _dll in _critical:
                        _load_dll(os.path.join(_bd, _dll))

    # Also try system CUDA toolkit (may be empty but harmless to add)
    _cb = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA'
    if os.path.exists(_cb):
        for _v in sorted(os.listdir(_cb), reverse=True):
            _reg_dir(os.path.join(_cb, _v, 'bin'))

    print('[worker] CUDA setup: ' + str(len(_dirs_added)) + ' dirs registered, ' + str(len(_dlls_loaded)) + ' DLLs loaded', file=sys.stderr, flush=True)
    if _dlls_loaded:
        print('[worker]   loaded: ' + ', '.join(_dlls_loaded), file=sys.stderr, flush=True)
    else:
        print('[worker] WARNING: no cublas DLLs found — CUDA inference will fail', file=sys.stderr, flush=True)

# ── ffmpeg ────────────────────────────────────────────────────────────────────
def find_ffmpeg():
    """Return the path to ffmpeg, searching well-known locations on Windows."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    candidates = [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        os.path.join(os.environ.get("USERPROFILE", ""), "ffmpeg", "bin", "ffmpeg.exe"),
        os.path.join(
            os.environ.get("LOCALAPPDATA", ""), "Programs", "ffmpeg", "bin", "ffmpeg.exe"
        ),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    raise RuntimeError("ffmpeg not found. Install with: winget install ffmpeg")

FFMPEG = find_ffmpeg()

def webm_to_wav(input_path: str) -> str:
    """
    Convert a WebM/Opus file to a 16 kHz mono WAV file that Whisper can read.

    Whisper (and faster-whisper) natively expects 16 kHz mono PCM — feeding it
    WebM/Opus directly causes it to rely on an internal decode step that can
    silently fail on some builds.  Pre-converting with ffmpeg is more reliable.

    The 30-second window means the WAV files are small (~960 KB) and the
    conversion is fast (< 0.1 s on a modern CPU).
    """
    wav_path = input_path.replace(".webm", ".wav")
    result = subprocess.run(
        [
            FFMPEG, "-y",
            "-i", input_path,
            "-ar", "16000",     # 16 kHz — Whisper's native sample rate
            "-ac", "1",         # mono
            "-sample_fmt", "s16",
            "-f", "wav",
            wav_path,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        lines = [l for l in result.stderr.strip().splitlines() if l.strip()]
        raise RuntimeError(f"ffmpeg failed: {lines[-1] if lines else 'unknown'}")
    return wav_path

def is_hallucination(text: str) -> bool:
    """
    Detect common Whisper hallucinations and filter them out before returning
    segments to the server.

    Whisper sometimes generates repetitive nonsense (e.g. "......", "www")
    especially on silent or very quiet audio.  These checks catch the most
    common patterns without being so aggressive that we drop real speech.
    """
    stripped = text.replace(" ", "").replace("\n", "")
    if not stripped or len(stripped) <= 2:
        return True
    # Repetitive single or double character (e.g. ".....", "abababab")
    if len(set(stripped)) <= 2:
        return True
    return False

def load_model(device: str, compute_type: str):
    """
    Load the WhisperModel.
    Falls back to CPU if CUDA is requested but fails at load time.
    Note: some CUDA DLL errors (e.g. cublas64_12.dll) only surface at
    inference time, not at load time — those are caught in transcribe_file().
    """
    from faster_whisper import WhisperModel
    try:
        log(f"trying device={device} compute={compute_type}")
        model = WhisperModel(MODEL_SIZE, device=device, compute_type=compute_type)
        log(f"model loaded on {device}")
        return model, device
    except Exception as e:
        if device == "cuda":
            log(f"CUDA load failed ({e}) — falling back to CPU")
            model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
            log("model loaded on cpu (fallback)")
            return model, "cpu"
        raise

def _run_transcription(model, wav_path: str) -> list[dict]:
    """Inner transcription call — separated so we can retry on a CPU model if CUDA fails."""
    lang = LANGUAGE if LANGUAGE else None
    segments_iter, info = model.transcribe(
        wav_path,
        beam_size=BEAM_SIZE,
        best_of=1,
        language=lang,
        vad_filter=True,
        vad_parameters={
            "min_silence_duration_ms": 300,
            "speech_pad_ms":           100,
            "threshold":               0.3,
        },
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
        suppress_tokens=[-1],
        condition_on_previous_text=False,
    )
    log(f"lang={info.language} ({info.language_probability:.0%})")
    result = []
    for seg in segments_iter:
        text = seg.text.strip()
        if is_hallucination(text):
            log(f"skip hallucination: {repr(text)}")
            continue
        if seg.no_speech_prob > 0.8:
            log(f"skip no-speech: {repr(text)}")
            continue
        result.append({"text": text, "start": round(seg.start, 2), "end": round(seg.end, 2)})
    log(f"segments found: {len(result)}")
    return result


# Module-level fallback CPU model — created lazily if CUDA fails at runtime.
_cpu_model_fallback = None

def transcribe_file(model, audio_path: str) -> list[dict]:
    """
    Transcribe a single audio file and return a list of segment dicts:
      [{ "text": str, "start": float, "end": float }, ...]

    Offsets are in seconds, relative to the start of the audio file.

    If the model was loaded on CUDA but a DLL error surfaces at inference time
    (e.g. cublas64_12.dll not found), we transparently fall back to a CPU model
    for this and all future calls.
    """
    global _cpu_model_fallback

    wav_path = webm_to_wav(audio_path)
    try:
        try:
            return _run_transcription(model, wav_path)
        except Exception as e:
            err_str = str(e)
            # Catch CUDA runtime errors that only surface during inference,
            # not at model load time (e.g. missing cublas64_12.dll, cuDNN errors)
            is_cuda_runtime_err = any(kw in err_str.lower() for kw in [
                "cublas", "cudnn", "cuda", "cublaslt", "library", "dll",
                "cannot be loaded", "not found", "ctypes",
            ])
            if not is_cuda_runtime_err:
                raise  # not a CUDA error — re-raise so the caller sees it

            log(f"CUDA runtime error during transcription: {e}")
            log("falling back to CPU for this and all future transcriptions")

            # Build the CPU fallback model once and reuse it
            if _cpu_model_fallback is None:
                from faster_whisper import WhisperModel
                log("loading CPU fallback model...")
                _cpu_model_fallback = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
                log("CPU fallback model ready")

            return _run_transcription(_cpu_model_fallback, wav_path)

    finally:
        try:
            os.unlink(wav_path)
        except Exception:
            pass

# ── main loop ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    log(
        f"loading model={MODEL_SIZE} device={DEVICE} compute={COMPUTE_TYPE} "
        f"lang={LANGUAGE or 'auto'} beam={BEAM_SIZE}"
    )

    model, active_device = load_model(DEVICE, COMPUTE_TYPE)

    log(f"ready (active_device={active_device})")
    # This exact string is watched by server.js to set whisperReady = true
    print("[worker] ready", file=sys.stderr, flush=True)

    # ── stdin loop ────────────────────────────────────────────────────────────
    # server.js writes one audio file path per line.
    # We write one JSON array per line back to stdout.
    # The protocol is strictly one-in / one-out so the pendingResolvers queue
    # in server.js stays in sync.
    for line in sys.stdin:
        audio_path = line.strip()
        if not audio_path:
            continue
        if not os.path.exists(audio_path):
            log(f"file not found: {audio_path}")
            print(json.dumps([]), flush=True)
            continue
        try:
            log(f"transcribing {os.path.basename(audio_path)}")
            segments = transcribe_file(model, audio_path)
            # Must be a single valid JSON line — server.js reads one line = one result
            print(json.dumps(segments), flush=True)
            log(f"done — {len(segments)} segments emitted")
        except Exception as e:
            log(f"error: {e}")
            print(json.dumps([]), flush=True)