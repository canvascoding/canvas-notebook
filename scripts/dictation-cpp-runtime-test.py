#!/usr/bin/env python3
"""Check model integrity, activation, interrupted downloads and installation locks."""

import fcntl
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


spec = importlib.util.spec_from_file_location('dictation_cpp', Path(__file__).with_name('dictation_cpp.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class ModelInstallTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.directory = root / 'models'
        self.native = root / 'native'
        self.native.mkdir()
        (self.native / 'MODEL-LICENSE.txt').write_text('model terms')
        self.payload = b'known model content'
        self.model = {'sha256': hashlib.sha256(self.payload).hexdigest(), 'size': len(self.payload),
                      'url': 'https://example.invalid/pinned-model'}
        self.policy = {'models': {'tiny': self.model}}

    def install(self, payload):
        with mock.patch.object(runtime.urllib.request, 'urlopen', return_value=io.BytesIO(payload)):
            runtime.install(self.directory, self.policy, self.native, 'tiny')

    def test_verified_download_activates_and_preserves_license(self):
        self.assertEqual(runtime.read_status(self.directory, self.policy)['state'], 'missing')
        self.install(self.payload)
        self.assertEqual(runtime.read_status(self.directory, self.policy)['installedModels'], ['tiny'])
        self.assertEqual((self.directory / 'MODEL-LICENSE.txt').read_text(), 'model terms')
        with mock.patch.object(runtime.urllib.request, 'urlopen', side_effect=AssertionError('must reuse model')):
            runtime.install(self.directory, self.policy, self.native, 'tiny')
        self.assertFalse(list(self.directory.glob('.model-download-*')))

    def test_hash_mismatch_never_activates_model(self):
        self.install(b'x' * len(self.payload))
        status = runtime.read_status(self.directory, self.policy)
        self.assertEqual(status['state'], 'failed')
        self.assertEqual(status['installedModels'], [])
        self.assertIn('SHA-256', status['message'])
        self.assertFalse(runtime.model_path(self.directory, self.model).exists())
        self.assertFalse(list(self.directory.glob('.model-download-*')))

    def test_truncated_and_oversized_downloads_are_rejected(self):
        for payload in [self.payload[:-1], self.payload + b'excess']:
            self.install(payload)
            self.assertEqual(runtime.read_status(self.directory, self.policy)['installedModels'], [])

    def test_modified_or_symlinked_model_is_unavailable(self):
        self.install(self.payload)
        target = runtime.model_path(self.directory, self.model)
        target.write_bytes(b'modified')
        self.assertEqual(runtime.installed_models(self.directory, self.policy), [])
        target.unlink()
        substitute = self.native / 'substitute'
        substitute.write_bytes(self.payload)
        target.symlink_to(substitute)
        self.assertEqual(runtime.installed_models(self.directory, self.policy), [])

    def test_lock_prevents_parallel_install_and_detects_interruption(self):
        self.directory.mkdir()
        runtime.write_json(self.directory / 'installation.json', {'state': 'installing'})
        with (self.directory / 'installation.lock').open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(runtime.read_status(self.directory, self.policy)['state'], 'installing')
            with mock.patch.object(runtime.urllib.request, 'urlopen', side_effect=AssertionError('parallel download')):
                runtime.install(self.directory, self.policy, self.native, 'tiny')
        self.assertEqual(runtime.read_status(self.directory, self.policy)['state'], 'failed')

    def test_unknown_model_and_insufficient_storage_are_rejected(self):
        with self.assertRaises(ValueError):
            runtime.install(self.directory, self.policy, self.native, '../../model')
        with mock.patch.object(runtime.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 1})()):
            runtime.install(self.directory, self.policy, self.native, 'tiny')
        self.assertEqual(runtime.read_status(self.directory, self.policy)['installedModels'], [])


if __name__ == '__main__':
    unittest.main()
