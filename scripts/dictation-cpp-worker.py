#!/usr/bin/env python3
"""JSON-lines speech worker. Models are installed by an admin, never here."""

import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

from dictation_cpp import configuration, installed_models, model_path, sha256


child = None


def terminate(_signal, _frame):
    if child is not None:
        child.kill()
    raise SystemExit(0)


def run(command, timeout):
    global child
    child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        _, stderr = child.communicate(timeout=timeout)
        if child.returncode:
            raise RuntimeError('Local audio processing failed: ' + stderr.decode(errors='replace')[-300:])
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate()
        child = None


def main():
    policy_path = Path(__file__).resolve().parent.parent / 'docs/compliance/dictation-cpp-policy.json'
    policy, native = configuration(policy_path)
    directory = Path(os.environ['CANVAS_DICTATION_RUNTIME'])
    verified = {}
    signal.signal(signal.SIGTERM, terminate)
    print(json.dumps({'type': 'ready'}), flush=True)
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            name = request['model']
            if name not in installed_models(directory, policy):
                raise RuntimeError('Install the selected model in Settings → Dictation first.')
            model = model_path(directory, policy['models'][name])
            stamp = (model.stat().st_mtime_ns, model.stat().st_size, model.stat().st_ino)
            if verified.get(name) != stamp:
                if sha256(model) != policy['models'][name]['sha256']:
                    raise RuntimeError('The installed dictation model failed integrity verification.')
                verified[name] = stamp
            language = request.get('language', 'auto')
            if language != 'auto' and not re.fullmatch('[a-z]{2}', language):
                raise ValueError('Invalid dictation language.')
            with tempfile.TemporaryDirectory(prefix='canvas-dictation-decoded-') as temporary:
                wav = str(Path(temporary) / 'audio.wav')
                output = str(Path(temporary) / 'transcript')
                run(['ffmpeg', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                     '-i', request['path'], '-vn', '-t', '601', '-ar', '16000', '-ac', '1',
                     '-c:a', 'pcm_s16le', wav], 30)
                with wave.open(wav) as audio:
                    if audio.getnframes() > 600 * audio.getframerate():
                        raise ValueError('Audio recording exceeds the ten-minute dictation limit.')
                run([str(native / 'whisper-cli'), '-m', str(model), '-f', wav,
                     '-l', language, '-t', '4', '-ng', '-nt', '-np', '-otxt', '-of', output], 150)
                text = Path(output + '.txt').read_text().strip()
            print(json.dumps({'id': request['id'], 'text': text}), flush=True)
        except Exception as error:
            print(json.dumps({'id': request.get('id') if isinstance(request, dict) else None,
                              'error': str(error)[:400]}), flush=True)


if __name__ == '__main__':
    main()
