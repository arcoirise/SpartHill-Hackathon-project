"""Keep the public Next.js server and loopback-only FastAPI server together."""
import os
import signal
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
processes = []
stopping = False


def stop(signum=None, frame=None):
    global stopping
    stopping = True
    for process in processes:
        if process.poll() is None:
            process.terminate()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    processes.append(subprocess.Popen([
        "/opt/venv/bin/python", "-m", "uvicorn", "app.main:app",
        "--host", "127.0.0.1", "--port", "8001", "--no-access-log",
    ], cwd=ROOT / "backend"))
    processes.append(subprocess.Popen([
        "node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0",
        "--port", os.environ.get("PORT", "10000"),
    ], cwd=ROOT / "frontend"))
    while not stopping and all(p.poll() is None for p in processes):
        time.sleep(0.5)
finally:
    stop()
    for process in processes:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
