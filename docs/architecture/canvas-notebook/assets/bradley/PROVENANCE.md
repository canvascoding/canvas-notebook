# Bradley Asset Provenance and Project Usage Record

Status: approved for Canvas Notebook product development and derived Bradley assets

Recorded: 2026-08-31

Todo: BRADLEY-010

## Source of record

The canonical raster source of record is:

`references/character/bradley-character-master.png`

It is a 2048 × 2048 RGBA PNG with a transparent background. The repository
copy is byte-identical to the user-provided source file imported from:

`/Users/frankalexanderweber/Desktop/mosa-explorations/mo transparent.png`

The historical source name is retained only in this provenance record. It is
not a current character or product name.

An earlier conversation referenced a JPEG named
`studio-gen-minimalist-mascot-character-mosa-for-a-0-2026-08-21T09-21-15-963Z-adbdc0c2.jpg`.
That file is not locally available and is not required to reproduce the
versioned asset pack because the transparent PNG above is the approved
high-resolution master.

## Product-owner attestation and authorization

The Product Owner stated in the project conversation that the displayed
character image had already been created by them and then explicitly directed
that the relevant generated images could be copied, used to derive SVG assets,
and used to create a mascot animation. This record preserves that authorization
for the Canvas Notebook project.

Approved project use:

- versioning the selected raster references in this repository;
- using the character as the visual reference for Bradley;
- deriving static, monochrome and animated SVG assets;
- prototyping and implementing Canvas Notebook UI, onboarding and status
  surfaces;
- preparing Canvas Notebook documentation and brand previews.

This is a project authorization and provenance record, not a legal opinion.
The original generator receipt, prompt transcript and provider terms were not
available for archival. Before standalone merchandising, asset resale, a
separate Bradley product line or a large international paid campaign, the
commercial-use basis should be reviewed together with the then-current
generator terms and trademark strategy.

## Imported files

All raster files were imported on 2026-08-31 without recompression or content
editing. The SHA-256 values prove the current repository files are identical to
the inspected local sources.

| Historical source file | Versioned repository file | Format | SHA-256 |
| --- | --- | --- | --- |
| `mo transparent.png` | `references/character/bradley-character-master.png` | 2048 × 2048 RGBA PNG | `eb0d618a440ae142f4da41942222879e77f545c4517d06d4a032201133c6701c` |
| `mo Silhouettentest.png` | `references/character/bradley-character-silhouette.png` | 2048 × 2048 indexed PNG | `0bd0f9572f24d96b9c03f3f7c7ad647780ff724e8f8da2bbc1095e7bf3fa4b54` |
| `mo-welcome-scene.png` | `references/scenes/bradley-welcome-scene.png` | 1536 × 1024 RGB PNG | `7ff378b908df3bee3cae26f98e1affb086f64c7de8fdcb7ff4af01afbad8bfd3` |
| `mo-thinking-transparent.png` | `references/explorations/bradley-thinking-exploration.png` | 1024 × 1024 RGBA PNG | `3aed68a2ab9a2e35d58a2d311edf05d9c488e495274319868f0305b85950c6f1` |
| `mo-done-transparent.png` | `references/explorations/bradley-done-exploration.png` | 1024 × 1024 RGBA PNG | `5b0008c8e81e6c4112022784512570503f892af0873e218b54297e258d927a63` |

The machine-readable checksum list is stored in
[`checksums.sha256`](./checksums.sha256).

## Authority and limitations

The character master defines Bradley's canonical silhouette, fold layout,
raised right fold, lower V and two eye points. The scene and pose explorations
are supporting references and do not override the master form.

The vector assets are intentional interpretations rather than byte-derived
traces. Their shape must be reviewed against the character master. Naming
changes from the historical source files to Bradley do not imply that the
underlying pixels were regenerated.

## Verification

From `docs/architecture/canvas-notebook/assets/bradley/` run:

```sh
shasum -a 256 -c checksums.sha256
```

BRADLEY-010 is complete when the files above remain present, the checksum
verification succeeds and this provenance record remains linked from the asset
README and main branding plan.
