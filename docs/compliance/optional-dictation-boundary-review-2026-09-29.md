# Optional dictation distribution boundary: Docker exclusion

Date: 2026-09-29. The first image pair below came from Notebook `c2f4e1ef8`
before the installer exclusion. It established that the base image already
omitted the 13 optional Wheels, but left a callable installer in Docker.

| Platform | Local image ID | Debian | Python (pip) | Global npm | Inventory SHA-256 |
| --- | --- | ---: | ---: | ---: | --- |
| linux/amd64 | `sha256:ae43f4d0296280fbd7888527e51aa2cff4a2547cfbde4c89720111caaf15945c` | 513 | 48 (45) | 153 | `a5556aa9c15cb82167e3eff0c595605fd53cc64ad1d5a31955879952f0a8f5ca` |
| linux/arm64 | `sha256:64059ed8f4725fec148fbc6f95bfa54c0a0874536c900614cd1b1dc202de44fc` | 509 | 48 (45) | 153 | `1e6a685c0c640722811d63ea860372367d30878a48ef5739fbe34ecda8e5eb65` |

Both images passed `runtime-component-inventory-test.mjs`; their extracted
inventories and Sharp linkage passed `runtime-multiarch-compliance-test.mjs`.
The runtime test verified that all 13 optional dictation Python packages are
absent from both images and that the 45 pip packages exactly match
`requirements/runtime-python.txt`. The extracted notices, component manifest,
optional dictation lock and libvips source archive are byte-identical between
architectures and match the source files. The libvips source archive SHA-256 is
`3c41e1d5458081bfa4a5bc54e116c46259c75c6760a18027764555632b9dda3e`.
Both inventories record Dockerfile SHA-256
`3eee114cd0f76ca648ff60d1a5ded5fcea8e5c15345c716f9afa5642e624d0e9`
and base Python lock SHA-256
`7ed0b21c265f46a3dd468bbed4c91bacbd9fd3f73b917cf4aeb03adfda875c5b`.
`npm run test:dictation-runtime` passed its three focused cases.

The opt-in installer and lock text remain shipped with the application. An
instance admin can still request installation of the pinned Wheels from PyPI
into persistent DATA. The prior [58-package candidate audit](dictation-python-dependency-intake-2026-09-28.md)
identified unresolved PyAV/FFmpeg x264/x265 license-mode and CTranslate2 native
payload evidence. Those findings no longer describe binaries in the base
image, but remain relevant when the optional installer runs. The local image
comparison does not settle distribution or downstream installation obligations.

The original `npm run test:licenses:release` failed on
`docker-runtime:optional-dictation-boundary@2026-09-28`. The Docker candidate
was then changed to remove both Python scripts from the final image, report
local installation as disabled, reject local settings and installation
requests server-side, and retain OpenAI/Groq cloud dictation. The optional
Wheels are not approved for redistribution or future Docker installation.

| Platform | Remediated local image ID | Debian | Python (pip) | Global npm | Inventory SHA-256 |
| --- | --- | ---: | ---: | ---: | --- |
| linux/amd64 | `sha256:28fb079fac38a7594a15ffc204b801f43c850807905c445ff1b6a984c4cff138` | 513 | 48 (45) | 153 | `9c82d5776ddc1492ce1e995cbeeddcbf7fd7e71a58f03cb4af163639b1f574cf` |
| linux/arm64 | `sha256:8b12e37c8b8a107215af0e53459998b5a187abd010ad95180813d14dcdac30e1` | 509 | 48 (45) | 153 | `aec18491310cfa71c03b0c4bf733ce74d484e8b3bee1d71402c8e789cf77753b` |

Both remediated images passed their runtime inventory and Sharp-linkage checks,
then `runtime-multiarch-compliance-test.mjs`. Each final image was inspected
with a one-off container: `/app/scripts/dictation-runtime.py` and
`/app/scripts/dictation-worker.py` are absent, while `CANVAS_RUNTIME_ENV=docker`
is set. All 13 optional Python distributions remain absent. The embedded
notices, component manifest, optional-lock text and libvips source archive
match across architectures; notices, manifest and lock also match the source.
Both inventories bind Dockerfile SHA-256
`04e7716e22e1457e73d42b0cb55e6c423eca69b02ae9758b897ecac8ed77430e`.
The Docker boundary test, TypeScript, focused ESLint, host production build,
Python installer tests, `npm run test:licenses` and
`npm run test:licenses:release` pass with zero release blockers.
The broader `npm run verify:release` advanced through lockfile, license,
PostgreSQL SQL-compatibility, lint and production build, then failed in the
separate Yjs ESM/CJS collaboration-module assertion on local Node 26.7.0.
This image review does not claim that broader release verification passed.

This closes the Docker distribution review by excluding the unresolved
optional installer from that artifact. It does not clear the historical
PyAV/FFmpeg or CTranslate2 findings for a later source/host installation or
for any future Docker image that re-enables local dictation. A tagged
release-workflow run and registry publication were not performed here.
