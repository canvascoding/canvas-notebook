# Local transcription self-test

`dictation-self-test.wav` contains John F. Kennedy's 1961 inauguration excerpt,
a United States federal government speech in the public domain. Source audio:
https://github.com/openai/whisper/blob/main/tests/jfk.flac

Converted to mono 16 kHz PCM WAV with FFmpeg. Expected speech includes “fellow
Americans” and “country”. The self-test tolerates punctuation and case changes;
it checks meaningful recognized words, rather than requiring a byte-identical
transcript. This verifies execution, not general transcription accuracy.
