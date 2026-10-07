#!/usr/bin/env python3
"""Persistent CPU speech-to-text worker for the instance-wide dictation service.

The process keeps one faster-whisper model warm across requests. Each input and
output is one JSON line; audio stays in a temporary file owned by the Node side.
"""

import json
import os
import sys
from pathlib import Path

from faster_whisper import WhisperModel


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    model = None
    model_name = None
    model_stamp = None
    emit({"type": "ready"})
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            requested_model = request["model"]
            root = os.environ.get('CANVAS_DICTATION_MODEL_ROOT')
            source = str(Path(root) / requested_model) if root else requested_model
            stat = (Path(source) / 'model.bin').stat() if root else None
            stamp = (stat.st_size, stat.st_mtime_ns, stat.st_ino) if stat else None
            if model is None or requested_model != model_name or stamp != model_stamp:
                # A CPU/int8 baseline works on servers without CUDA drivers.
                model = WhisperModel(source, device="cpu", compute_type="int8", cpu_threads=4, num_workers=1,
                                     **({'local_files_only': True} if root else {}))
                model_name = requested_model
                model_stamp = stamp
            language = request.get("language")
            segments, _ = model.transcribe(
                request["path"],
                language=None if language == "auto" else language,
                initial_prompt=request.get("prompt") or None,
                beam_size=5,
                condition_on_previous_text=False,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
            )
            # faster-whisper decodes lazily; exhaust the generator inside the guard.
            text = " ".join(segment.text.strip() for segment in segments).strip()
            emit({"id": request["id"], "text": text})
        except Exception as error:
            emit({"id": request.get("id") if isinstance(request, dict) else None,
                  "error": str(error)[:400]})


if __name__ == "__main__":
    main()
