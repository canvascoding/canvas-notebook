# Container-local dictation: source and notice review

This review implements the owner's 2026-10-04 request to make local model
installation available in Settings. It does not approve the historical PyAV,
CTranslate2, hf-xet or tokenizers wheels. Those 13 Python additions, their
installer and Faster-Whisper worker remain excluded from Docker.

## Reviewed replacement

Docker uses the unmodified whisper.cpp **v1.9.4** source, commit
`927cfce34f31707e17f2bff35c349632fb9e2c3a`. Its exact source archive SHA-256 is
`57e280cee375ab02425b806ad5146b99f6eb9357e3c2b31357c8a6af2e2e44ae`.
[The pinned policy](dictation-cpp-policy.json) records the download URL,
build options, notice hashes, and all five model hashes and sizes.

The CPU runtime and embedded ggml code use MIT terms. The compiled CLI also
contains miniaudio (MIT-0 alternative selected), stb_vorbis (MIT alternative
selected), nlohmann/json and its included MIT contributions, and CPU operation
contributions by Jeffrey Quesnelle and Bowen Peng. The combined notice retains
the relevant copyright statements and complete license terms. The unmodified
source archive retains original file-level notices as well.

The build disables FFmpeg library linking, networking/libcurl, GPU backends,
BLAS, OpenMP, KleidiAI and llamafile. It statically links only the reviewed
whisper/ggml source into the CLI. Host-specific tuning and x86 AVX/AVX2,
SSE4.2, BMI2, FMA and F16C requirements are disabled for VM compatibility;
this conservative CPU build trades x86 throughput for a common baseline.
It uses
system C/C++ runtime libraries supplied
by the already inventoried Debian image. No MKL, wheel-bundled libgomp,
x264/x265, CUDA or PyAV payload is added. Audio conversion invokes the existing
Debian FFmpeg executable as a separate process; its existing Debian notices
and source-package obligations remain part of the container inventory. This
change does not alter the license of that separate executable.

`build-dictation-cpp.py` verifies the source archive before extraction, builds
only `whisper-cli`, retains the source archive and both notices, and records
binary/notice hashes plus the reviewed build options in `runtime.json`.
Every final image build runs `capture-dictation-cpp-evidence.py`. It verifies
those hashes, checks the source archive, executes CLI help, and rejects ELF
linkage outside system libc/libm/libstdc++/libgcc/loader libraries. The runtime
inventory and multi-architecture release gate require that evidence on both
amd64 and arm64. CI exports the actual executable, source, notices and evidence
into the native-compliance release asset. A missing or modified runtime is
unavailable to the application.

## Model downloads and user flow

The converted OpenAI Whisper models are downloaded from
[the MIT-declared ggerganov model repository](https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/README.md),
fixed to revision `5359861c739e955e79d9a303bcbc70fb988958b1`. The pinned policy
binds `tiny`, `base`, `small`, `medium` and `large-v3` to their SHA-256 values
and exact byte sizes. The original
[OpenAI Whisper v20250625 MIT notice](https://github.com/openai/whisper/blob/v20250625/LICENSE)
is retained in the image and copied alongside installed weights. The base
image contains no model weights and no personal credentials are required.

An instance admin selects a local model in Settings and requests installation.
The server validates the model name and streams the immutable download into
a temporary file under persistent DATA. It checks disk space, byte size and
SHA-256 before atomic activation. A lock prevents concurrent installers;
failure or interruption leaves an unavailable model retryable. Settings polls
progress and lists the selected model as installed only when its activation
receipt and file metadata are valid. Other already installed models remain
available while another model downloads or fails. Non-admin users cannot
install models through the API.

The microphone becomes available only for the saved, installed model. The
worker never downloads weights or executes an installer. It verifies model
contents on first use (and again after file metadata changes), accepts only
the named models/languages, converts local recordings to mono 16-kHz PCM, and
runs CPU transcription with bounded processing times. Recordings exceeding
ten minutes are rejected instead of silently truncated. FFmpeg input protocols
are restricted to local files and pipes. Parent termination also terminates
the native child. WebM, Ogg, M4A, MP3 and WAV retain their public API contract.

Source/host installations continue to use the separate Faster-Whisper path;
the historical wheel review remains applicable to that path and is not
cleared by this review.

## Validation and limits

The source-built macOS arm64 CLI was inspected: it links only system
`libSystem` and `libc++`, and no GPU, BLAS or FFmpeg library. A real `tiny`
model download passed its pinned SHA-256/size check, and a JFK sample recording
was correctly transcribed through the new worker. Installer regressions cover
hash mismatch, truncation, oversized downloads, modified/symlinked files,
concurrent installation, interrupted installation, invalid model names and
insufficient storage. The TypeScript boundary regression covers a missing or
modified runtime, local settings selection, model-specific readiness and
idempotent installation.

Real worker transcriptions passed for WebM, Ogg, M4A, MP3 and WAV. The
production `npm run build`, TypeScript check, focused ESLint, installer tests,
Docker-boundary tests and strict `test:licenses:release` gate passed on the
host. These checks do not build a Linux container or validate the Settings UI
in a browser.

This is a technical source, notice and distribution-boundary review. The
reviewed permissive components are included in the normal license inventory;
the existing release approval and strict component gates are retained. Final
Linux image IDs, amd64/arm64 runtime evidence, browser acceptance and deployment
must be recorded after their actual execution; a host test does not establish
them.
