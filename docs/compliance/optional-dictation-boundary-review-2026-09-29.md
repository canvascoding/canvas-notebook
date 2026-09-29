# Optional dictation distribution boundary: local image audit

Date: 2026-09-29. Source: Notebook `c2f4e1ef8` with a clean worktree.
This is technical evidence for the current base-image candidate, not a
commercial-release approval.

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

`npm run test:licenses:release` therefore still fails on
`docker-runtime:optional-dictation-boundary@2026-09-28`. To close the review,
the release owner must decide whether to ship the optional installer with a
documented disposition of its native dependency findings, or disable that
installer for the commercial release while preserving cloud dictation. A
new source change or release candidate needs its own image evidence.
