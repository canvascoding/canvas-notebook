#!/usr/bin/env python3
"""Persistent CPU speech-to-text worker for the instance-wide dictation service.

The process keeps one faster-whisper model warm across requests. Each input and
output is one JSON line; audio stays in a temporary file owned by the Node side.
"""

import json
import sys

from faster_whisper import WhisperModel


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    model = None
    model_name = None
    emit({"type": "ready"})
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            requested_model = request["model"]
            if model is None or requested_model != model_name:
                # A CPU/int8 baseline works on servers without CUDA drivers.
                model = WhisperModel(requested_model, device="cpu", compute_type="int8", cpu_threads=4, num_workers=1)
                model_name = requested_model
            language = request.get("language")
            segments, _ = model.transcribe(
                request["path"],
                language=None if language == "auto" else language,
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
