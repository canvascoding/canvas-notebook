# Matplotlib Python runtime intake

Date: 2026-10-14

The agent's standard Python runtime now pins Matplotlib alongside the existing
document and data-processing packages. `Dockerfile` already installs this lock
with `--require-hashes`; no additional runtime installation step is needed.
All 45 existing package versions and hashes remain unchanged. The base lock
now contains 51 packages, and both compliance count assertions reflect that set.

## Added distributions

| Package | Version | Selected Linux wheel hashes | Packaged license evidence |
| --- | --- | ---: | --- |
| [matplotlib](https://pypi.org/project/matplotlib/3.11.2/) | 3.11.2 | 2 | Matplotlib license agreement in `.dist-info/LICENSE` |
| [contourpy](https://pypi.org/project/contourpy/1.3.3/) | 1.3.3 | 2 | BSD-3-Clause in `.dist-info/LICENSE` |
| [cycler](https://pypi.org/project/cycler/0.12.1/) | 0.12.1 | 1 | BSD-style license in `.dist-info/LICENSE` |
| [fonttools](https://pypi.org/project/fonttools/4.66.1/) | 4.66.1 | 2 | MIT plus external font notices in `.dist-info/licenses/` |
| [kiwisolver](https://pypi.org/project/kiwisolver/1.5.1/) | 1.5.1 | 2 | Modified BSD license in `.dist-info/licenses/LICENSE` |
| [pyparsing](https://pypi.org/project/pyparsing/3.3.3/) | 3.3.3 | 1 | MIT in `.dist-info/licenses/LICENSE` |

NumPy, Pillow, packaging, python-dateutil and six already satisfy Matplotlib's
remaining dependencies. The existing runtime inventory collector retains
distribution metadata and packaged license-file hashes automatically. This
intake does not replace the historical image approvals with a new image approval.

## Validation

- Resolved and downloaded the complete lock with pip's `--require-hashes` and
  `--only-binary=:all:` for CPython 3.11 on Linux amd64 and arm64. Both succeeded.
- Both platforms resolve the same 51 distribution names and versions. The six
  added distributions contribute ten distinct wheel hashes across the platforms.
- `npm run test:licenses` and `npm run test:licenses:python-inventory` passed.
- A separate temporary macOS Python 3.14 virtual environment uses the same
  Matplotlib dependency versions; its headless Agg PNG/SVG/PDF smoke check passed.
  This is local rendering evidence, separate from Linux image acceptance.

Lock SHA-256:
`e75cbc5214228b7db746810d19f93bcedbd2c8cf972a4fd0d8a05efcc252471d`.

No container was built or deployed for this change. Fresh runtime inventories,
native dependency/license evidence and the multi-architecture release gate
remain part of the next authorized image build. Matplotlib becomes available
in deployed agent environments after that updated image is built and rolled out.
