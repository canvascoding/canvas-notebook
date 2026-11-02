"""Real filesystem journal guarantees; no SDK, credentials, DB or app server."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("compiled_operations_probe",
    Path(__file__).parent / "helpers" / "python_sdk_compiled_operations_probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class RequestJournalTests(unittest.TestCase):
    def test_atomic_private_unicode_record_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            file = root / "requests.json"
            file.write_text("[]\n")
            file.chmod(0o600)
            records = [{"kind": "move", "path": "source-ü😀.md"}]
            probe.write_request_journal(file, records)
            self.assertEqual(json.loads(file.read_text()), records)
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(file.stat().st_uid, os.getuid())
            self.assertEqual(list(root.iterdir()), [file])

    def test_failed_replacement_preserves_prior_requests_and_removes_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            file = root / "requests.json"
            original = '[{"operationId":"previously-confirmed"}]\n'
            file.write_text(original)
            file.chmod(0o600)
            with patch.object(probe.os, "replace", side_effect=OSError("Declared publication interruption")):
                with self.assertRaises(OSError):
                    probe.write_request_journal(file, [{"operationId": "next-not-sent"}])
            self.assertEqual(file.read_text(), original)
            self.assertEqual(list(root.iterdir()), [file])


if __name__ == "__main__":
    unittest.main()
