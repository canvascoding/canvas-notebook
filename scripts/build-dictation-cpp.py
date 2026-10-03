#!/usr/bin/env python3
"""Build the reviewed CPU-only CLI; never fetch or build on a customer's server."""

import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path


def sha256(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def build(output, cmake):
    root = Path(__file__).resolve().parent.parent
    policy_path = root / 'docs/compliance/dictation-cpp-policy.json'
    policy = json.loads(policy_path.read_text())
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'whisper.cpp-source.tar.gz'
    if not archive.exists():
        urllib.request.urlretrieve(policy['sourceUrl'], archive)
    if sha256(archive) != policy['sourceSha256']:
        raise RuntimeError('Whisper source archive does not match the reviewed SHA-256.')
    with tempfile.TemporaryDirectory(prefix='canvas-whisper-build-') as temporary:
        with tarfile.open(archive) as source:
            # Debian bookworm's Python 3.11 may predate extraction filters.
            # This reviewed archive contains only files/directories; reject
            # links and escaped paths before extracting on either version.
            destination = Path(temporary).resolve()
            for member in source.getmembers():
                if (not (member.isfile() or member.isdir())
                        or not (destination / member.name).resolve().is_relative_to(destination)):
                    raise RuntimeError('Unexpected entry in the reviewed Whisper source archive.')
            source.extractall(temporary)
        source_root = Path(temporary) / ('whisper.cpp-' + policy['version'])
        build_root = Path(temporary) / 'build'
        subprocess.run([cmake, '-S', str(source_root), '-B', str(build_root),
                        '-DCMAKE_BUILD_TYPE=Release',
                        *['-D' + option for option in policy['buildOptions']]], check=True)
        subprocess.run([cmake, '--build', str(build_root), '--target', 'whisper-cli', '-j', '4'], check=True)
        shutil.copy2(build_root / 'bin/whisper-cli', output / 'whisper-cli')
    for key, name in [('notice', 'LICENSE.txt'), ('modelNotice', 'MODEL-LICENSE.txt')]:
        file = root / policy[key + 'Path']
        if sha256(file) != policy[key + 'Sha256']:
            raise RuntimeError('Whisper notice differs from the reviewed terms.')
        shutil.copy2(file, output / name)
    evidence = {'schemaVersion': 1, 'engine': policy['engine'], 'version': policy['version'],
                'policySha256': sha256(policy_path), 'sourceSha256': sha256(archive),
                'buildOptions': policy['buildOptions'],
                'files': {name: sha256(output / name) for name in
                          ['whisper-cli', 'LICENSE.txt', 'MODEL-LICENSE.txt']}}
    (output / 'runtime.json').write_text(json.dumps(evidence, indent=2) + '\n')


if __name__ == '__main__':
    build(Path(sys.argv[1]).resolve(), sys.argv[2] if len(sys.argv) > 2 else 'cmake')
