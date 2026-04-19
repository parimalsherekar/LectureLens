"""
diagnose_cuda.py
Run this ONCE from inside your venv to get the full picture:
  python diagnose_cuda.py

Paste the output here and we will tell you exactly what to install / change.
"""
import sys, os, subprocess, shutil

SEP = "-" * 60

print(SEP)
print("PYTHON")
print(f"  executable : {sys.executable}")
print(f"  version    : {sys.version}")

# ── GPU via nvidia-smi ──────────────────────────────────────────────────────
print(SEP)
print("GPU (nvidia-smi)")
smi = shutil.which("nvidia-smi")
if smi:
    r = subprocess.run([smi, "--query-gpu=name,driver_version,memory.total",
                        "--format=csv,noheader"], capture_output=True, text=True)
    if r.returncode == 0:
        for line in r.stdout.strip().splitlines():
            print(f"  {line}")
    else:
        print(f"  nvidia-smi found but failed: {r.stderr.strip()}")
else:
    print("  nvidia-smi NOT found — NVIDIA driver may not be installed")

# ── CUDA Toolkit on disk ─────────────────────────────────────────────────────
print(SEP)
print("CUDA TOOLKIT (on disk)")
cuda_base = r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"
if os.path.exists(cuda_base):
    versions = sorted([d for d in os.listdir(cuda_base) if d.startswith("v")], reverse=True)
    for ver in versions:
        ver_path = os.path.join(cuda_base, ver)
        cublas = os.path.join(ver_path, "bin", "cublas64_12.dll")
        cublas11 = os.path.join(ver_path, "bin", "cublas64_11.dll")
        print(f"  {ver_path}")
        print(f"    cublas64_12.dll : {'FOUND' if os.path.exists(cublas) else 'MISSING'}")
        print(f"    cublas64_11.dll : {'FOUND' if os.path.exists(cublas11) else 'MISSING'}")
else:
    print(f"  NOT FOUND at {cuda_base}")
    print("  (CUDA Toolkit is not installed, or installed to a non-standard path)")

# ── CUDA_PATH env var ────────────────────────────────────────────────────────
print(SEP)
print("CUDA_PATH env var")
cuda_path = os.environ.get("CUDA_PATH", "")
print(f"  CUDA_PATH = '{cuda_path}'")
if cuda_path:
    cublas = os.path.join(cuda_path, "bin", "cublas64_12.dll")
    print(f"  cublas64_12.dll there? {'YES' if os.path.exists(cublas) else 'NO'}")

# ── pip packages ─────────────────────────────────────────────────────────────
print(SEP)
print("RELEVANT PIP PACKAGES")
r = subprocess.run([sys.executable, "-m", "pip", "list"], capture_output=True, text=True)
keywords = ["faster-whisper", "ctranslate2", "torch", "nvidia", "cuda", "cudnn", "cublas"]
for line in r.stdout.splitlines():
    low = line.lower()
    if any(k in low for k in keywords):
        print(f"  {line}")

# ── ctranslate2 device probe ─────────────────────────────────────────────────
print(SEP)
print("CTRANSLATE2 DEVICE PROBE")
try:
    import ctranslate2
    print(f"  ctranslate2 version : {ctranslate2.__version__}")
    print(f"  cuda available      : {ctranslate2.get_cuda_device_count() > 0}")
    count = ctranslate2.get_cuda_device_count()
    print(f"  cuda device count   : {count}")
    if count > 0:
        print(f"  compute capability  : {ctranslate2.get_cuda_device_count()}")
except ImportError:
    print("  ctranslate2 not installed")
except Exception as e:
    print(f"  ctranslate2 import error: {e}")

# ── torch cuda probe (if torch is installed) ─────────────────────────────────
print(SEP)
print("TORCH CUDA PROBE (if installed)")
try:
    import torch
    print(f"  torch version    : {torch.__version__}")
    print(f"  cuda available   : {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"  cuda version     : {torch.version.cuda}")
        print(f"  device name      : {torch.cuda.get_device_name(0)}")
except ImportError:
    print("  torch not installed (that is fine)")
except Exception as e:
    print(f"  torch error: {e}")

# ── .env contents ────────────────────────────────────────────────────────────
print(SEP)
print(".env FILE (if present in current directory)")
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.rstrip()
            if line and not line.startswith("#"):
                print(f"  {line}")
else:
    print("  no .env found in script directory")

print(SEP)
print("DONE — paste all output above when asking for help")
print(SEP)