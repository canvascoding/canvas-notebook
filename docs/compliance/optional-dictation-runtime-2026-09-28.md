# Optional local dictation runtime

**Superseded Docker path:** The
[2026-10-04 source/notice review](container-local-dictation-review-2026-10-04.md)
adds a source-built whisper.cpp runtime with model installation in Settings.
The Python wheels discussed below remain excluded from Docker. The installer
below is retained only for source/host setups.

The standard Docker image installs only the 45 packages in
`requirements/runtime-python.txt`. The 13 Faster-Whisper additions are pinned
and SHA-256 locked in `requirements/dictation-python.txt`, which is shipped as
text but never passed to pip during the image build. The commercial Docker
image removes the local installer and worker scripts and rejects local
dictation selection and installation server-side. Cloud transcription is
unaffected. The optional installer remains available only in source/host
setups outside this Docker release.

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

In source/host setups, the admin settings page shows installation progress
and failure, and the ordinary chat UI shows the microphone only after
activation. The selected Whisper model is still downloaded on first
transcription. Before install, the admin page links to FFmpeg's license
information and notes the PyAV wheel's GPL codec payload. In Docker, the
local option is disabled and the admin sees an explanation instead.

This changes which binaries Canvas distributes in the base image. It does
not establish that every downstream deployment or install workflow has
fulfilled its own license obligations. The [wheel and old-image audit](dictation-python-dependency-intake-2026-09-28.md)
remains relevant to the optional wheels. The final amd64/arm64 images,
runtime installer exclusion, notices and release-gate result are documented
in the [boundary review](optional-dictation-boundary-review-2026-09-29.md).
The former 13 `docker-python:*` blockers no longer describe the base image.
Enabling or distributing the optional wheels later requires a separate review.
