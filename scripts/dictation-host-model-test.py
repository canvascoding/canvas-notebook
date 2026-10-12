"""Exercise byte progress, pinned revisions, hashes, cache reuse and failure cleanup."""
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import dictation_host_model as runtime


class HostModelTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'models'
        self.files = {'model.bin': b'known model content', 'config.json': b'{}', 'tokenizer.json': b'{}'}
        self.metadata = {'sha': 'a' * 40, 'siblings': [
            {'rfilename': name, 'size': len(data), 'blobId': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}
            for name, data in self.files.items()]}
        self.metadata['siblings'][0]['lfs'] = {'sha256': hashlib.sha256(self.files['model.bin']).hexdigest()}
        self.progress = []

    def open(self, url, **_kwargs):
        self.progress.append(runtime.read_json(self.directory / 'installation.json'))
        if '/api/models/' in url:
            return io.BytesIO(json.dumps(self.metadata).encode())
        self.assertIn('/resolve/' + 'a' * 40 + '/', url)
        return io.BytesIO(self.files[url.rsplit('/', 1)[-1]])

    def test_real_progress_hashes_and_reuse(self):
        with mock.patch.object(runtime.urllib.request, 'urlopen', side_effect=self.open):
            target = runtime.install(self.directory, 'tiny')
        status = runtime.read_status(self.directory)
        self.assertEqual(status['installedModels'], ['tiny'])
        self.assertEqual(status['downloadedBytes'], sum(map(len, self.files.values())))
        self.assertEqual(status['totalBytes'], status['downloadedBytes'])
        self.assertEqual(status['phase'], 'ready')
        self.assertTrue(any(state.get('phase') == 'downloading' for state in self.progress))
        with mock.patch.object(runtime.urllib.request, 'urlopen', side_effect=AssertionError('cache must be reused')):
            runtime.install(self.directory, 'tiny')
        (target / 'model.bin').write_bytes(b'modified')
        self.assertEqual(runtime.installed_models(self.directory), [])

    def test_failure_never_activates_partial_model(self):
        for payload in [b'wrong model content', b'short', b'excess' * 20]:
            self.files['model.bin'] = payload
            with mock.patch.object(runtime.urllib.request, 'urlopen', side_effect=self.open):
                with self.assertRaises(RuntimeError):
                    runtime.install(self.directory, 'tiny')
            self.assertEqual(runtime.read_status(self.directory)['installedModels'], [])
            self.assertEqual(runtime.read_status(self.directory)['phase'], 'failed')
            self.assertFalse(list(self.directory.glob('.model-download-*')))

    def test_invalid_names_and_disk_space(self):
        with self.assertRaises(ValueError):
            runtime.install(self.directory, '../../escape')
        with mock.patch.object(runtime.urllib.request, 'urlopen', side_effect=self.open), mock.patch.object(runtime.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 1})()):
            with self.assertRaises(RuntimeError):
                runtime.install(self.directory, 'tiny')


if __name__ == '__main__':
    unittest.main()
