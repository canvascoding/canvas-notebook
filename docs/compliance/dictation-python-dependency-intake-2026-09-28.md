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

## Technical wheel review, 2026-09-28

The 13 additions were downloaded as CPython 3.11 wheels for both Linux target
architectures (`manylinux_2_28`/`manylinux2014`, amd64 and arm64). Every selected
wheel's SHA-256 matches a hash in `requirements/runtime-python.txt`. The normal
`npm run test:licenses` check passes with 1967 components and 13 release blockers;
`npm run test:licenses:release` fails on those blockers as intended. This is a
wheel-content review, not a review of either final Docker image.

Nine distributions have no native `.so` payload in their wheels: anyio,
faster-whisper, filelock, fsspec, h11, httpcore, httpx, huggingface-hub, and
tqdm. All nine include a license file. `tqdm` declares `MPL-2.0 AND MIT`; its
wheel's `LICENCE` contains the MIT text and an MPL-2.0 Exhibit A reference,
but not the complete MPL-2.0 text. It therefore still needs the MPL text,
file-level obligations, and notices checked for the actual distribution.

The four native-wheel findings are:

| Distribution | amd64 wheel SHA-256 | arm64 wheel SHA-256 | Finding |
| --- | --- | --- | --- |
| `av 18.1.0` | `8a032e8d8ebc73dec079364b9b4a6837638a2d106e8472314e685ffbf163e700` | `6fc837cc51adf80331ac850779cd53b5d4c4460bebe9057a02a921c6736f19d` | PyAV's BSD text is present, but the wheels also contain 32/31 `av.libs` shared libraries. `libavcodec` has ELF `NEEDED` entries for bundled `libx264` and `libx265` on both architectures. The wheel does not contain corresponding FFmpeg/codec license texts or source-offer evidence. |
| `ctranslate2 4.8.2` | `a24e0a95151b970941867fec94c983df978630f1996242a587c072d455607d28` | `3823c9883c2c410a76b2f19feda9da628a3c112cedfd912db815e0055c8235e2` | The MIT declaration is present in metadata, but neither wheel contains a license file. Both bundle `libctranslate2` and `libgomp`; their exact notice/source obligations still need review. |
| `hf-xet 1.6.0` | `d62671bb130879cef0ee4c9ebe47a14af6c66ec53e6d84dc15936e5ffdfac82f` | `0e6e21fa3cdfcdcd76748564bf593870a5e013f47d97cf10aed63aa222cff5b7` | Apache-2.0 text is present. The Rust/Python native extension still needs a version-specific review of bundled third-party code and notices. |
| `tokenizers 0.23.2` | `41c2f84d172449b4dadb9cdc508e3e364076613c35b16e76ecfe47a60d1e3305` | `a37039b5dfc4af84eb3ef0a92f4307e28936c8f9adccba2629d36f652e9bf7a2` | Both wheels contain a native extension but no license file or license expression. The exact PyPI source distribution (`sha256:7f0f085686b9de0d0079e6f874ae053600db64c5d13049e0bbc0119926d25aac`) does include an Apache-2.0 `tokenizers/LICENSE`; wheel notices and native transitive code remain to be accounted for. |

The `av` finding is the material release concern. [FFmpeg's license
documentation](https://ffmpeg.org/doxygen/trunk/md_LICENSE.html) identifies
`libx264` and `libx265` as GPL libraries and says that combining them with
FFmpeg requires GPL treatment. The exact wheels' ELF dependencies establish
that these libraries are linked into the bundled FFmpeg payload; PyAV's
BSD-3-Clause metadata alone does not cover it. The effect on the Canvas
distribution and any corresponding-source obligations require a responsible
legal/owner decision. Rebuilding PyAV against a reviewed FFmpeg configuration
or using a different decoder is a potential remediation, but neither has been
implemented or verified here.

Do not remove the 13 policy blockers or extend the earlier release approval on
the basis of this review. Before release, resolve the PyAV/FFmpeg codec payload,
complete the remaining native and notice/source checks, and record a new
version-specific approval. The final-image inspection is recorded below.

## Final-image inspection, 2026-09-28

After a successful host `npm run build`, separate local Docker builds completed
for `linux/amd64` and `linux/arm64`. Their local image IDs are
`sha256:5bf925f0ebbbc33e16568bfa83aa716f5690a593d84727f5f3af005724c73f3d`
and `sha256:ab712dde5e98c7c9b1860c709c62d1e3f5e82709c8af931286f8d2d7a0cad55b`,
respectively. Each build passed `runtime-component-inventory-test.mjs` and
`sharp-runtime-linkage-test.mjs`. The extracted final inventories and Sharp
linkage results passed `runtime-multiarch-compliance-test.mjs`: 513/509 Debian
packages, 61 Python distributions (58 pip), and 153 global npm packages per
architecture. Both images contain the same Dockerfile, distribution-policy,
and Python-lock hashes in their inventory evidence.

The final images reproduce the wheel finding. The amd64/arm64 images contain
32/31 files under `av.libs`; their `libavcodec` ELF dependency lists include
the bundled `libx264` and `libx265` on both architectures. PyAV's installed
metadata says `BSD-3-Clause` and supplies its own license text, but does not
provide the FFmpeg/codec license texts or source-offer evidence for those
libraries. The four extracted codec-library files are byte-identical to those
in the corresponding pinned wheels. The images also contain `ctranslate2`
with an MIT declaration but no packaged license file, `tokenizers` with an
Apache Software License classifier but no packaged license file, and `tqdm`
with an `MPL-2.0 AND MIT` declaration and the partial wheel notice described
above. This is technical
inventory evidence, not an approval of the combined distribution.

The runtime collector now excludes compiled `.pyc`/`.pyo` files under
`.dist-info/licenses` and records license classifiers. This prevents PyAV's
compiled `AUTHORS.py` from becoming a false license-file hash and preserves
the sole packaged license declaration for `tokenizers` in both inventories.
The inventory test accepts that declaration as evidence of metadata presence;
it does not treat it as a release decision.

Hermes Agent is not a license precedent for this image. Its transcription
tool [installs the `stt-whisper` dependency on demand](https://github.com/NousResearch/hermes-agent/blob/614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0/tools/transcription_local.py),
and its [project configuration](https://github.com/NousResearch/hermes-agent/blob/main/pyproject.toml)
describes voice dependencies as lazy-installed. Whether that project satisfies
its own redistribution obligations cannot be inferred from its use of
`faster-whisper`. Canvas instead includes the PyAV wheel in both distributed
container images, so this image's obligations need their own review.

The normal `npm run test:licenses` check still passes and reports 1967
components with 13 release blockers. `npm run test:licenses:release` still
fails on those blockers as intended. No blocker or prior approval was changed.
