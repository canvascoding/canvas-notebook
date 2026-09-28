#!/usr/bin/env python3
"""Install the opt-in dictation wheels outside the distributed image."""

import fcntl
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def runtime_paths(data_root: Path, requirements: Path):
    digest = hashlib.sha256(requirements.read_bytes()).hexdigest()
    key = f"{sys.platform}-{platform.machine().lower()}-py{sys.version_info.major}{sys.version_info.minor}-{digest[:20]}"
    directory = data_root / "dictation" / "python"
    return directory, directory / key, directory / f"{key}.json", directory / f"{key}.lock", digest


def locked_packages(requirements: Path):
    return {
        re.sub(r"[-_.]+", "-", match.group(1).lower()): match.group(2)
        for match in re.finditer(r"^([a-z0-9._-]+)==([^\s\\]+)", requirements.read_text(), re.MULTILINE | re.IGNORECASE)
    }


def installed_packages(target: Path):
    found = {}
    for distribution in importlib.metadata.distributions(path=[str(target)]):
        name = distribution.metadata.get("Name")
        if name:
            found[re.sub(r"[-_.]+", "-", name.lower())] = distribution.version
    return found


def ready(target: Path, digest: str, packages: dict[str, str]) -> bool:
    try:
        if target.is_symlink() or not target.is_dir() or (target / ".canvas-dictation-ready").read_text() != digest:
            return False
        installed = installed_packages(target)
        return all(installed.get(name) == version for name, version in packages.items())
    except (OSError, UnicodeError):
        return False


def write_state(state_path: Path, state: str, message: str | None = None):
    payload = {"state": state}
    if message:
        payload["message"] = message[:500]
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=state_path.parent,
                                     prefix=".dictation-state-", delete=False) as output:
        json.dump(payload, output)
        output.flush()
        os.fsync(output.fileno())
        temporary = Path(output.name)
    os.replace(temporary, state_path)


def read_status(directory: Path, target: Path, state_path: Path, lock_path: Path,
                digest: str, packages: dict[str, str]):
    if ready(target, digest, packages):
        return {"state": "installed", "path": str(target)}
    try:
        state = json.loads(state_path.read_text())
    except (OSError, ValueError):
        return {"state": "missing"}
    if not isinstance(state, dict):
        return {"state": "failed", "message": "Installation status is invalid. Try again."}
    if state.get("state") == "installing":
        with lock_path.open("a+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {"state": "installing"}
        return {"state": "failed", "message": "Installation was interrupted. Try again."}
    if state.get("state") == "failed":
        return {"state": "failed", "message": str(state.get("message") or "Installation failed.")[:500]}
    return {"state": "missing"}


def install(directory: Path, target: Path, state_path: Path, lock_path: Path,
            digest: str, requirements: Path, packages: dict[str, str]):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if ready(target, digest, packages):
            write_state(state_path, "installed")
            return
        write_state(state_path, "installing")
        stage_prefix = f".dictation-install-{target.name}-"
        for stale in directory.glob(f"{stage_prefix}*"):
            if stale.is_dir() and not stale.is_symlink():
                shutil.rmtree(stale)
        stage = Path(tempfile.mkdtemp(prefix=stage_prefix, dir=directory))
        try:
            command = [
                sys.executable, "-m", "pip", "--isolated", "install",
                "--disable-pip-version-check", "--no-cache-dir", "--no-deps",
                "--only-binary=:all:", "--require-hashes",
                "--index-url", "https://pypi.org/simple",
                "--target", str(stage), "-r", str(requirements),
            ]
            subprocess.run(command, check=True, capture_output=True, text=True, timeout=900)
            installed = installed_packages(stage)
            if any(installed.get(name) != version for name, version in packages.items()):
                raise RuntimeError("Installed wheels do not match the optional lock.")
            environment = {**os.environ, "PYTHONPATH": str(stage), "PYTHONNOUSERSITE": "1"}
            subprocess.run(
                [sys.executable, "-c", "import av, ctranslate2, faster_whisper, tokenizers, huggingface_hub, httpx"],
                check=True, capture_output=True, text=True, timeout=60, env=environment,
            )
            (stage / ".canvas-dictation-ready").write_text(digest)
            if target.exists():
                shutil.rmtree(target)
            os.replace(stage, target)
            write_state(state_path, "installed")
        except (OSError, RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            detail = (error.stderr or "").strip() if isinstance(error, subprocess.CalledProcessError) else ""
            message = f"Installation failed: {detail[-350:]}" if detail else f"Installation failed: {error.__class__.__name__}."
            write_state(state_path, "failed", message)
        finally:
            if stage.exists():
                shutil.rmtree(stage)


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in {"status", "install"}:
        raise SystemExit("usage: dictation-runtime.py <status|install> <data-root> <requirements>")
    action, data_root, requirements = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    directory, target, state_path, lock_path, digest = runtime_paths(data_root, requirements)
    packages = locked_packages(requirements)
    if not packages:
        raise SystemExit("The optional dictation lock contains no packages.")
    if action == "status":
        if not directory.exists():
            print(json.dumps({"state": "missing"}))
        else:
            print(json.dumps(read_status(directory, target, state_path, lock_path, digest, packages)))
    else:
        install(directory, target, state_path, lock_path, digest, requirements, packages)


if __name__ == "__main__":
    main()
