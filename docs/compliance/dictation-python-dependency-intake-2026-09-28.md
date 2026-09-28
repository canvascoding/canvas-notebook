# Dictation Python dependency intake (approval pending)

Commit `bae04f940` added 13 pinned Python packages for local dictation to
`requirements/runtime-python.txt`. The Docker lock now contains 58 packages,
while the static compliance test still expected the 45-package set from the
earlier review. The test update checks the new packages by name and version as
well as the total count and the presence of wheel hashes. It does **not** approve
their licenses or a new Docker-image composition. The policy records each
addition as a pending distribution review: normal application builds can
proceed, while `npm run test:licenses:release` blocks commercial release.

The declarations below come from the PyPI pages for the exact pinned versions.
They are intake evidence, not verification of the license files or bundled
native libraries in the wheels delivered by the final Linux images.

| Package | Version | PyPI license declaration |
| --- | --- | --- |
| [anyio](https://pypi.org/project/anyio/4.15.1/) | 4.15.1 | MIT |
| [av](https://pypi.org/project/av/18.1.0/) | 18.1.0 | BSD-3-Clause |
| [ctranslate2](https://pypi.org/project/ctranslate2/4.8.2/) | 4.8.2 | MIT |
| [faster-whisper](https://pypi.org/project/faster-whisper/1.2.1/) | 1.2.1 | MIT |
| [filelock](https://pypi.org/project/filelock/4.0.5/) | 4.0.5 | MIT |
| [fsspec](https://pypi.org/project/fsspec/2026.9.0/) | 2026.9.0 | BSD-3-Clause |
| [h11](https://pypi.org/project/h11/0.16.0/) | 0.16.0 | MIT |
| [hf-xet](https://pypi.org/project/hf-xet/1.6.0/) | 1.6.0 | Apache-2.0 |
| [httpcore](https://pypi.org/project/httpcore/1.0.9/) | 1.0.9 | BSD-3-Clause |
| [httpx](https://pypi.org/project/httpx/0.28.1/) | 0.28.1 | BSD-3-Clause |
| [huggingface-hub](https://pypi.org/project/huggingface-hub/1.33.0/) | 1.33.0 | Apache-2.0 |
| [tokenizers](https://pypi.org/project/tokenizers/0.23.2/) | 0.23.2 | Apache Software License classifier; no license expression in PyPI metadata |
| [tqdm](https://pypi.org/project/tqdm/4.70.1/) | 4.70.1 | MPL-2.0 AND MIT |

Before commercial distribution, the responsible reviewer still needs to inspect
the exact wheels and their license/notice files on both Docker target platforms.
In particular, inspect the native payloads and dependencies of PyAV,
CTranslate2, hf-xet, and tokenizers, and determine the obligations for tqdm's
declared license combination. Then update the Docker runtime review and
version-specific review decisions, run the final image compliance gates, and
record the responsible release decision. The existing `releaseApproval` entry
documents the prior inventory; this intake does not extend that approval.
