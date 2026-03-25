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
skill transcribe <audio-file>
```

Example:
```bash
skill transcribe /data/workspace/recordings/meeting.mp3
skill transcribe /data/workspace/voice-note.m4a
```

## Supported Formats

- m4a, mp3, wav, ogg, flac, webm
- Max file size: 25MB

## Output

Returns plain text transcription with punctuation and proper capitalization to stdout.

## Requirements

- `GROQ_API_KEY` must be set in Canvas Notebook under Settings → Integrations
- Get a free API key at https://console.groq.com/
