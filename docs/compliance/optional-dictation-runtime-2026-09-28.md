# Optional local dictation runtime

The standard Docker image installs only the 45 packages in
`requirements/runtime-python.txt`. The 13 Faster-Whisper additions are pinned
and SHA-256 locked in `requirements/dictation-python.txt`, which is shipped as
text but never passed to pip during the image build. Local dictation stays
unavailable until an instance admin explicitly selects **Install local
transcription** in Dictation settings. Cloud transcription is unaffected.

The installation helper uses Python's `flock` to serialize simultaneous
requests, downloads binary wheels directly from PyPI with `--require-hashes`
and `--no-deps`, and stages them in the persistent `/data/dictation/python`
directory. It verifies the installed distribution names and versions and
imports the native modules before atomically activating the directory. A
failed or interrupted install leaves dictation unavailable and can be
retried. The target path includes the operating system, architecture, Python
minor version, and lock hash, so upgrades and shared macOS/Linux test data
cannot reuse incompatible wheels. No runtime process writes to the system
Python installation or to the immutable application directory.

The admin settings page shows installation progress and failure, and the
ordinary chat UI shows the microphone only after activation. The selected
Whisper model is still downloaded on first transcription. Before install,
the admin page links to FFmpeg's license information and notes the PyAV
wheel's GPL codec payload.

This changes which binaries Canvas distributes in the base image. It does
not establish that every downstream deployment or install workflow has
fulfilled its own license obligations. The [wheel and old-image audit](dictation-python-dependency-intake-2026-09-28.md)
remains relevant to the optional wheels. The new final amd64/arm64 images,
runtime installer boundary, notices, and release decision require a fresh
owner review. The release gate retains one blocker for that review; the
former 13 `docker-python:*` blockers no longer describe the base image.
