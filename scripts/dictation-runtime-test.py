#!/usr/bin/env python3
"""Exercise the optional installer without downloading Python wheels."""

import fcntl
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("dictation-runtime.py")
spec = importlib.util.spec_from_file_location("dictation_runtime", SCRIPT)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class DictationRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.requirements = self.root / "optional.txt"
        self.requirements.write_text("example==1.0 \\\n    --hash=sha256:" + "a" * 64 + "\n")
        self.directory, self.target, self.state, self.lock, self.digest = runtime.runtime_paths(
            self.root, self.requirements
        )
        self.packages = runtime.locked_packages(self.requirements)

    def status(self):
        return runtime.read_status(
            self.directory, self.target, self.state, self.lock, self.digest, self.packages
        )

    def test_atomic_install_and_lock_version(self):
        self.assertEqual(self.status(), {"state": "missing"})
        commands = []
        stale = self.directory / f".dictation-install-{self.target.name}-interrupted"
        stale.mkdir(parents=True)
        (stale / "partial-wheel").write_text("incomplete")

        def run(command, **_kwargs):
            commands.append(command)
            if "--target" in command:
                stage = Path(command[command.index("--target") + 1])
                metadata = stage / "example-1.0.dist-info"
                metadata.mkdir()
                (metadata / "METADATA").write_text("Metadata-Version: 2.1\nName: example\nVersion: 1.0\n")
            return subprocess.CompletedProcess(command, 0)

        with mock.patch.object(runtime.subprocess, "run", side_effect=run):
            runtime.install(self.directory, self.target, self.state, self.lock,
                            self.digest, self.requirements, self.packages)

        self.assertEqual(self.status(), {"state": "installed", "path": str(self.target)})
        self.assertFalse(stale.exists())
        self.assertIn("--require-hashes", commands[0])
        self.assertIn("--only-binary=:all:", commands[0])
        self.assertIn("--no-deps", commands[0])
        self.assertEqual(len(commands), 2)
        self.assertFalse(any(path.name.startswith(".dictation-install-") for path in self.directory.iterdir()))
        (self.target / "example-1.0.dist-info" / "METADATA").unlink()
        self.assertNotEqual(self.status()["state"], "installed")

    def test_active_lock_and_interrupted_install(self):
        self.directory.mkdir(parents=True)
        runtime.write_state(self.state, "installing")
        with self.lock.open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.status(), {"state": "installing"})
        self.assertEqual(self.status()["state"], "failed")

    def test_failed_install_does_not_activate_partial_wheels(self):
        def fail(command, **_kwargs):
            raise subprocess.CalledProcessError(1, command, stderr="No matching binary wheel")

        with mock.patch.object(runtime.subprocess, "run", side_effect=fail):
            runtime.install(self.directory, self.target, self.state, self.lock,
                            self.digest, self.requirements, self.packages)

        self.assertEqual(self.status()["state"], "failed")
        self.assertIn("No matching binary wheel", json.loads(self.state.read_text())["message"])
        self.assertFalse(self.target.exists())
        self.assertFalse(any(path.name.startswith(".dictation-install-") for path in self.directory.iterdir()))


if __name__ == "__main__":
    unittest.main()
