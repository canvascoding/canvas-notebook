"""Explicit, byte-counted Faster-Whisper model download into persistent DATA."""
import fcntl
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path
from dictation_progress import ModelProgress

MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3']
FILES = {'config.json', 'model.bin', 'tokenizer.json', 'vocabulary.json', 'vocabulary.txt'}


def read_json(file):
    try:
        value = json.loads(file.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def fingerprint(file):
    stat = file.stat()
    return [stat.st_size, stat.st_mtime_ns, stat.st_ino]


def installed_models(directory):
    result = []
    for name in MODELS:
        target = directory / name
        receipt = read_json(target / 'receipt.json')
        files = receipt.get('files', {})
        try:
            if (not target.is_symlink() and {'config.json', 'model.bin', 'tokenizer.json'}.issubset(files)
                    and all(file in FILES and not (target / file).is_symlink()
                            and fingerprint(target / file) == stamp for file, stamp in files.items())):
                result.append(name)
        except OSError:
            pass
    return result


def read_status(directory):
    state = read_json(directory / 'installation.json')
    if state.get('state') == 'installing':
        with (directory / 'installation.lock').open('a+') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                state.update(state='failed', phase='failed', message='Model installation was interrupted. Try again.')
            except BlockingIOError:
                pass
    return {**state, 'installedModels': installed_models(directory)}


def install(directory, name):
    if name not in MODELS:
        raise ValueError('Choose a supported local model.')
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / 'installation.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # join the single shared download, then reuse its result
        if name in installed_models(directory):
            return directory / name
        state = directory / 'installation.json'
        progress = ModelProgress(state, name, 0)
        stage = None
        try:
            repo = 'Systran/faster-whisper-' + name
            with urllib.request.urlopen('https://huggingface.co/api/models/' + repo + '/revision/main?blobs=true', timeout=60) as response:
                metadata = json.loads(response.read(1024 * 1024))
            revision = metadata['sha']
            if not re.fullmatch('[a-f0-9]{40}', revision):
                raise RuntimeError('Invalid model revision.')
            files = [file for file in metadata['siblings'] if file['rfilename'] in FILES]
            if not {'config.json', 'model.bin', 'tokenizer.json'}.issubset({file['rfilename'] for file in files}):
                raise RuntimeError('Required model files are missing.')
            sizes = [file['size'] for file in files]
            if not all(isinstance(size, int) and 0 < size < 8 * 1024**3 for size in sizes):
                raise RuntimeError('Invalid model download size.')
            progress.total = sum(sizes)
            if shutil.disk_usage(directory).free < progress.total + 64 * 1024**2:
                raise RuntimeError('Insufficient free disk space for the selected model.')
            progress.publish('downloading', force=True)
            for stale in directory.glob('.model-download-*'):
                if stale.is_dir() and not stale.is_symlink():
                    shutil.rmtree(stale)
            stage = Path(tempfile.mkdtemp(prefix='.model-download-', dir=directory))
            for file in files:
                size = file['size']
                lfs = file.get('lfs')
                expected = lfs['sha256'] if lfs else file['blobId']
                digest = hashlib.sha256() if lfs else hashlib.sha1(b'blob ' + str(size).encode() + b'\0')
                if not re.fullmatch('[a-f0-9]{64}' if lfs else '[a-f0-9]{40}', expected):
                    raise RuntimeError('Invalid model integrity metadata.')
                received = 0
                url = 'https://huggingface.co/' + repo + '/resolve/' + revision + '/' + file['rfilename']
                with urllib.request.urlopen(url, timeout=60) as response, (stage / file['rfilename']).open('wb') as output:
                    for chunk in iter(lambda: response.read(1024 * 1024), b''):
                        received += len(chunk)
                        if received > size:
                            raise RuntimeError('Model download exceeds its declared size.')
                        output.write(chunk)
                        digest.update(chunk)
                        progress.downloaded += len(chunk)
                        progress.publish('downloading')
                if received != size or digest.hexdigest() != expected:
                    raise RuntimeError('Model download failed integrity verification.')
            progress.publish('verifying', force=True)
            receipt = {'revision': revision, 'files': {file['rfilename']: fingerprint(stage / file['rfilename']) for file in files}}
            (stage / 'receipt.json').write_text(json.dumps(receipt))
            target = directory / name
            if target.is_symlink():
                raise RuntimeError('The model directory must not be a symbolic link.')
            if target.exists():
                shutil.rmtree(target)
            os.replace(stage, target)
            progress.publish('ready', force=True)
            return target
        except Exception:
            progress.publish('failed', force=True, message='The selected model could not be downloaded or verified. Check network access and free disk space, then retry.')
            raise
        finally:
            if stage and stage.exists():
                shutil.rmtree(stage)


if __name__ == '__main__':
    directory = Path(sys.argv[2]) / 'dictation/models'
    if sys.argv[1] == 'status':
        print(json.dumps(read_status(directory)))
    elif sys.argv[1] == 'install':
        install(directory, sys.argv[3])
    else:
        raise ValueError('Unknown model operation.')
