# Mo Glyph

This directory contains the first flat SVG interpretation of the existing Mo
character reference. It is a reviewable design draft, not yet the final
production avatar.

## Files

- `mo-glyph.svg`: full-color master on a transparent canvas;
- `mo-glyph-monochrome.svg`: single-color version using `currentColor` when
  embedded inline;
- `mo-glyph-preview.svg`: review sheet with size, theme and monochrome checks.

## Design contract

- 64 × 64 coordinate system with no fixed output dimensions;
- character silhouette, two eyes, raised right fold and lower V remain visible;
- no raster texture, filters, drop shadows or embedded fonts in the production
  assets;
- eye size is optically enlarged for 16–20 px rendering;
- colors are deliberately flat so the glyph remains crisp in the application.

## Draft palette

| Role | Hex |
| --- | --- |
| Main canvas | `#2F8CFF` |
| Light fold | `#63B1FF` |
| Raised fold | `#4DA3FF` |
| Deep fold | `#1469D3` |
| Face | `#172033` |

## Review still required

- compare silhouette and proportions against the transparent character master;
- confirm recognizability and eye clarity at 16, 20, 24, 32 and 40 px;
- review on actual Canvas Notebook light, dark and high-contrast surfaces;
- decide whether the smallest 16–20 px optical size needs one fewer internal
  fold plane;
- approve the shape before integrating it into application code.
