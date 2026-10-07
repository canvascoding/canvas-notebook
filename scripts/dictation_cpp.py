#!/usr/bin/env python3
"""Admin-only model installation for the source-built container Whisper runtime."""

import fcntl
import hashlib
import json
import os
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path
from dictation_progress import ModelProgress


def sha256(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(file):
    try:
        value = json.loads(file.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def write_json(file, value):
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps(value) + '\n')
    os.replace(temporary, file)


def configuration(policy_path):
    policy = read_json(policy_path)
    native = policy_path.parents[2] / 'native/dictation'
    evidence = read_json(native / 'runtime.json')
    if (evidence.get('schemaVersion') != 1 or evidence.get('engine') != 'whisper-cpp'
            or evidence.get('version') != policy.get('version')
            or evidence.get('policySha256') != sha256(policy_path)
            or evidence.get('sourceSha256') != policy.get('sourceSha256')
            or evidence.get('buildOptions') != policy.get('buildOptions')):
        raise RuntimeError('The reviewed local dictation runtime is missing from this image.')
    for name in ['whisper-cli', 'LICENSE.txt', 'MODEL-LICENSE.txt']:
        file = native / name
        if file.is_symlink() or sha256(file) != evidence.get('files', {}).get(name):
            raise RuntimeError('Local dictation runtime verification failed.')
    if (evidence['files']['LICENSE.txt'] != policy['noticeSha256']
            or evidence['files']['MODEL-LICENSE.txt'] != policy['modelNoticeSha256']):
        raise RuntimeError('Local dictation license notices do not match the reviewed policy.')
    if not os.access(native / 'whisper-cli', os.X_OK):
        raise RuntimeError('The local dictation executable is not available.')
    return policy, native


def model_path(directory, model):
    return directory / (model['sha256'] + '.bin')


def fingerprint(file):
    stat = file.stat()
    return {'size': stat.st_size, 'mtime': stat.st_mtime_ns, 'inode': stat.st_ino}


def installed_models(directory, policy):
    result = []
    for name, model in policy['models'].items():
        file = model_path(directory, model)
        receipt = read_json(file.with_suffix('.json'))
        try:
            if (not file.is_symlink() and receipt.get('sha256') == model['sha256']
                    and receipt.get('fingerprint') == fingerprint(file)
                    and file.stat().st_size == model['size']):
                result.append(name)
        except OSError:
            pass
    return result


def read_status(directory, policy):
    models = installed_models(directory, policy)
    state = read_json(directory / 'installation.json')
    result = {'engine': 'whisper-cpp', 'installedModels': models,
              'state': 'installed' if models else 'missing',
              'modelSizes': {name: model['size'] for name, model in policy['models'].items()}}
    result.update({key: state[key] for key in ['model', 'phase', 'downloadedBytes', 'totalBytes', 'updatedAt'] if key in state})
    if models:
        result['path'] = str(directory)
    if state.get('state') == 'installing':
        with (directory / 'installation.lock').open('a+') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result.update(state='failed', message='Model installation was interrupted. Try again.')
            except BlockingIOError:
                result['state'] = 'installing'
    elif state.get('state') == 'failed':
        result.update(state='failed', message=state.get('message', 'Model installation failed.'))
    return result


def install(directory, policy, native, name):
    if name not in policy['models']:
        raise ValueError('Choose a supported local dictation model.')
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / 'installation.lock').open('a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state = directory / 'installation.json'
        if name in installed_models(directory, policy):
            write_json(state, {'state': 'installed'})
            return
        write_json(state, {'state': 'installing', 'model': name})
        temporary = None
        progress = ModelProgress(state, name, policy['models'][name]['size'])
        try:
            model = policy['models'][name]
            if shutil.disk_usage(directory).free < model['size'] + 64 * 1024 * 1024:
                raise RuntimeError('Insufficient free disk space for the selected model.')
            for stale in directory.glob('.model-download-*'):
                stale.unlink()
            digest = hashlib.sha256()
            downloaded = 0
            with tempfile.NamedTemporaryFile(prefix='.model-download-', dir=directory, delete=False) as output:
                temporary = Path(output.name)
                with urllib.request.urlopen(model['url'], timeout=60) as response:
                    for chunk in iter(lambda: response.read(1024 * 1024), b''):
                        downloaded += len(chunk)
                        if downloaded > model['size']:
                            raise RuntimeError('The model download exceeds its reviewed size.')
                        digest.update(chunk)
                        output.write(chunk)
                        progress.downloaded = downloaded
                        progress.publish('downloading')
                output.flush()
                os.fsync(output.fileno())
            progress.publish('verifying', force=True)
            if downloaded != model['size'] or digest.hexdigest() != model['sha256']:
                raise RuntimeError('The downloaded model does not match its reviewed SHA-256.')
            shutil.copy2(native / 'MODEL-LICENSE.txt', directory / 'MODEL-LICENSE.txt')
            target = model_path(directory, model)
            os.replace(temporary, target)
            write_json(target.with_suffix('.json'), {'sha256': model['sha256'], 'fingerprint': fingerprint(target)})
            progress.publish('ready', force=True)
        except (OSError, ValueError, RuntimeError) as error:
            progress.publish('failed', force=True, message=str(error)[:300])
        finally:
            if temporary and temporary.exists():
                temporary.unlink()


def main():
    action, data_root, policy_path = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    policy, native = configuration(policy_path)
    directory = data_root / 'dictation/whisper-cpp'
    if action == 'status':
        print(json.dumps(read_status(directory, policy)))
    elif action == 'install':
        install(directory, policy, native, sys.argv[4])
    else:
        raise ValueError('Unknown dictation operation.')


if __name__ == '__main__':
    main()
