---
name: transcribe
description: Speech-to-text transcription using Groq Whisper API. Supports m4a, mp3, wav, ogg, flac, webm. Requires GROQ_API_KEY in Canvas Integrations settings.
---

# Transcribe

Speech-to-text using Groq Whisper API. Fast and accurate transcription, no local model required.

## When to Use

- Transcribing audio or voice recordings
- Converting meetings, interviews, or voice notes to text
- Any task that requires turning speech into written text

## Usage

```bash
transcribe <audio-file>
```

Example:
```bash
transcribe /data/workspace/recordings/meeting.mp3
transcribe /data/workspace/voice-note.m4a
```

## Supported Formats

- m4a, mp3, wav, ogg, flac, webm
- Max file size: 25MB

## Output

Returns plain text transcription with punctuation and proper capitalization to stdout.

## Requirements

- `GROQ_API_KEY` must be set in Canvas Notebook under Settings → Integrations
- Canvas stores that key centrally in `/data/secrets/Canvas-Integrations.env`
- New skills that need secrets must also use `/data/secrets/Canvas-Integrations.env`
- Get a free API key at https://console.groq.com/
