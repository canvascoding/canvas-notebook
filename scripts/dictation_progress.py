"""Small persistent progress contract shared by both local model installers."""
import json
import os
import tempfile
import time


def write_progress(file, value):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode='w', dir=file.parent, prefix='.progress-', delete=False) as output:
        json.dump({**value, 'updatedAt': int(time.time() * 1000)}, output)
        output.flush()
        os.fsync(output.fileno())
        temporary = output.name
    os.replace(temporary, file)


class ModelProgress:
    def __init__(self, file, model, total):
        self.file, self.model, self.total = file, model, total
        self.downloaded, self.last = 0, 0
        self.publish('downloading', force=True)

    def publish(self, phase, force=False, message=None):
        now = time.monotonic()
        if force or now - self.last >= 0.25:
            self.last = now
            write_progress(self.file, {'state': 'failed' if phase == 'failed' else 'installed' if phase == 'ready' else 'installing',
                                      'phase': phase, 'model': self.model,
                                      'downloadedBytes': self.downloaded, 'totalBytes': self.total,
                                      **({'message': message} if message else {})})
