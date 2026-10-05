#!/usr/bin/env python3
"""Exercise worker protocols without downloading or loading speech models."""

import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))


def load_worker(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkerProtocolTest(unittest.TestCase):
    def test_faster_whisper_receives_prompt_and_auto_language(self):
        calls = []

        class Model:
            def __init__(self, *_args, **_kwargs):
                pass

            def transcribe(self, audio, **options):
                calls.append((audio, options))
                return iter([types.SimpleNamespace(text=' Canvas ')]), None

        faster = types.SimpleNamespace(WhisperModel=Model)
        with patch.dict(sys.modules, {'faster_whisper': faster}):
            worker = load_worker('dictation-worker')
        output = io.StringIO()
        request = {'id': 1, 'model': 'base', 'path': '/recording.wav', 'language': 'auto',
                   'prompt': 'Canvas, Weiß, --language de'}
        with patch.object(sys, 'stdin', io.StringIO(json.dumps(request) + '\n')), \
                patch.object(sys, 'stdout', output):
            worker.main()
        self.assertEqual(calls[0][1]['initial_prompt'], request['prompt'])
        self.assertIsNone(calls[0][1]['language'])
        self.assertEqual(json.loads(output.getvalue().splitlines()[1]), {'id': 1, 'text': 'Canvas'})

    def cpp_request(self, request, duration=1, modified_model=False, timeout_stage=None):
        worker = load_worker('dictation-cpp-worker')
        output = io.StringIO()
        commands = []
        with tempfile.TemporaryDirectory(prefix='canvas-cpp-protocol-test-') as temporary:
            directory = Path(temporary)
            model_bytes = b'reviewed test model'
            digest = hashlib.sha256(model_bytes).hexdigest()
            policy = {'models': {'base': {'sha256': digest, 'size': len(model_bytes)}}}
            model = directory / (digest + '.bin')
            model.write_bytes(b'modified model' if modified_model else model_bytes)

            def run(command, timeout):
                commands.append((command, timeout))
                stage = 'ffmpeg' if command[0] == 'ffmpeg' else 'whisper'
                if stage == timeout_stage:
                    raise worker.subprocess.TimeoutExpired(command, timeout)
                if command[0] == 'ffmpeg':
                    with wave.open(command[-1], 'wb') as audio:
                        audio.setnchannels(1)
                        audio.setsampwidth(2)
                        audio.setframerate(16000)
                        audio.writeframes(b'\x00\x00' * (duration * 16000))
                else:
                    Path(command[command.index('-of') + 1] + '.txt').write_text(' Canvas ')

            with patch.object(worker, 'configuration', return_value=(policy, directory)), \
                    patch.object(worker, 'installed_models', return_value=['base']), \
                    patch.object(worker.signal, 'signal'), \
                    patch.object(worker, 'run', side_effect=run), \
                    patch.dict(worker.os.environ, {'CANVAS_DICTATION_RUNTIME': str(directory)}), \
                    patch.object(sys, 'stdin', io.StringIO(json.dumps(request) + '\n')), \
                    patch.object(sys, 'stdout', output):
                worker.main()
        return commands, json.loads(output.getvalue().splitlines()[1])

    def test_cpp_prompt_is_one_cli_argument_and_conversion_remains_local(self):
        prompt = 'Canvas, Weiß, --language de'
        commands, response = self.cpp_request({'id': 2, 'model': 'base', 'path': '/recording.wav',
                                              'language': 'de', 'prompt': prompt})
        self.assertEqual(response, {'id': 2, 'text': 'Canvas'})
        ffmpeg, cli = [command for command, _timeout in commands]
        self.assertEqual(ffmpeg[ffmpeg.index('-protocol_whitelist') + 1], 'file,pipe')
        self.assertEqual(cli[cli.index('--prompt') + 1], prompt)
        self.assertEqual(cli.count('--prompt'), 1)
        self.assertEqual(cli[cli.index('-l') + 1], 'de')
        self.assertEqual([timeout for _command, timeout in commands], [30, 150])

    def test_cpp_duration_limit_prevents_transcription(self):
        commands, response = self.cpp_request({'id': 3, 'model': 'base', 'path': '/recording.wav'}, duration=601)
        self.assertEqual(len(commands), 1)
        self.assertIn('ten-minute', response['error'])

    def test_cpp_model_integrity_prevents_audio_processing(self):
        commands, response = self.cpp_request({'id': 4, 'model': 'base', 'path': '/recording.wav'}, modified_model=True)
        self.assertEqual(commands, [])
        self.assertIn('integrity verification', response['error'])

    def test_cpp_invalid_language_prevents_audio_processing(self):
        commands, response = self.cpp_request({'id': 5, 'model': 'base', 'path': '/recording.wav',
                                              'language': 'de --prompt other'})
        self.assertEqual(commands, [])
        self.assertIn('Invalid dictation language', response['error'])

    def test_cpp_subprocess_deadlines_have_explicit_timeout_code(self):
        for stage, expected_commands in [('ffmpeg', 1), ('whisper', 2)]:
            with self.subTest(stage=stage):
                commands, response = self.cpp_request(
                    {'id': 6, 'model': 'base', 'path': '/recording.wav'}, timeout_stage=stage)
                self.assertEqual(len(commands), expected_commands)
                self.assertEqual(response['id'], 6)
                self.assertEqual(response['code'], 'TRANSCRIPTION_TIMEOUT')
                self.assertTrue(response['error'])


if __name__ == '__main__':
    unittest.main()
