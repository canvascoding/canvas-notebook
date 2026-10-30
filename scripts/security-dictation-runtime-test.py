#!/usr/bin/env python3
"""Opt-in Linux acceptance: real pinned installer, file locks and speech model."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys


def main():
    assert sys.platform == "linux" and sys.version_info[:2] == (3, 11)
    assert len(sys.argv) == 2, "Pass a dedicated security-* test DATA directory."
    data_root = Path(sys.argv[1]).resolve()
    assert data_root.name.startswith("security-"), "Never use the instance DATA root."
    data_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    app = Path(__file__).resolve().parent.parent
    installer = app / "scripts/dictation-runtime.py"
    requirements = app / "requirements/dictation-python.txt"
    command = [sys.executable, str(installer)]
    subprocess.run(command + ["install", str(data_root), str(requirements)], check=True, timeout=960)
    status = json.loads(subprocess.check_output(command + ["status", str(data_root), str(requirements)]))
    assert status["state"] == "installed", status
    target = status["path"]
    environment = {**os.environ, "PYTHONPATH": target, "PYTHONNOUSERSITE": "1",
                   "HF_HOME": str(data_root / "cache/huggingface"), "HF_HUB_DISABLE_TELEMETRY": "1"}
    checks = r'''
import importlib.metadata
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from filelock import FileLock, Timeout
from huggingface_hub import hf_hub_download

assert importlib.metadata.version("filelock") == "4.2.4"
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    # CVE-2026-112909: a planted regular file must not be truncated/chmodded.
    for operation in ("rename", "hardlink"):
        victim = root / (operation + ".victim")
        victim.write_bytes(b"Private fixture bytes must survive acquire")
        victim.chmod(0o600)
        lock_path = root / (operation + ".lock")
        if operation == "rename":
            victim.rename(lock_path)
            observed = lock_path
        else:
            os.link(victim, lock_path)
            observed = victim
        try:
            with FileLock(lock_path, mode=0o666, timeout=0.1):
                pass
        except (OSError, ValueError):
            pass  # Refusing the planted inode is also safe.
        assert observed.read_bytes() == b"Private fixture bytes must survive acquire"
        assert stat.S_IMODE(observed.stat().st_mode) == 0o600
    lock = root / "exclusive.lock"
    with FileLock(lock, timeout=1):
        code = "from filelock import FileLock,Timeout; import sys\ntry:\n with FileLock(sys.argv[1],timeout=0.1): sys.exit(2)\nexcept Timeout: pass"
        subprocess.run([sys.executable, "-c", code, str(lock)], check=True)
    with FileLock(lock, timeout=1):
        pass
# Real Hub cache download exercises its FileLock integration, not a mock.
download = hf_hub_download("Systran/faster-whisper-tiny", "config.json")
assert Path(download).is_file()
print("Patched FileLock: planted-file integrity, cross-process exclusion and real Hub cache passed")
'''
    subprocess.run([sys.executable, "-c", checks], check=True, timeout=180, env=environment)
    subprocess.run([sys.executable, str(app / "scripts/dictation_host_model.py"),
                    "install", str(data_root), "tiny"], check=True, timeout=1200, env=environment)
    environment["CANVAS_DICTATION_MODEL_ROOT"] = str(data_root / "dictation/models")
    child = subprocess.Popen([sys.executable, "-u", str(app / "scripts/dictation-worker.py")],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, env=environment)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)

    def receive(timeout):
        assert selector.select(timeout), "The real speech worker exceeded its deadline"
        line = child.stdout.readline()
        assert line, "The real speech worker stopped unexpectedly"
        return json.loads(line)

    try:
        assert receive(60) == {"type": "ready"}
        for request_id in (1, 2):
            child.stdin.write(json.dumps({"id": request_id, "model": "tiny", "language": "en",
                                          "path": str(app / "scripts/fixtures/dictation-self-test.wav")}) + "\n")
            child.stdin.flush()
            result = receive(180)
            assert result["id"] == request_id and "error" not in result, result
            assert "country" in result["text"].lower(), result
            assert "americans" in result["text"].lower(), result
        print("Real Faster-Whisper CPU/int8 transcription and warm-worker reuse passed")
    finally:
        selector.close()
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)


if __name__ == "__main__":
    main()
