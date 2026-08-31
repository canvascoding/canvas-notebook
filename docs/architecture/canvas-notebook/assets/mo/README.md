# Mo Asset-System

Dieser Ordner enthält die versionierten Referenzbilder, statischen Glyphs und
den ersten Bewegungsprototyp für Mo. Die Assets sind weiterhin Entwürfe und
noch nicht als produktive UI-Integration freigegeben.

## Ordnerstruktur

```text
mo/
├── glyphs/
│   ├── static/
│   │   ├── mo-glyph.svg
│   │   └── mo-glyph-monochrome.svg
│   └── animated/
│       └── mo-generating.svg
├── previews/
│   └── mo-glyph-preview.svg
└── references/
    ├── character/
    │   ├── mo-character-master.png
    │   └── mo-character-silhouette.png
    ├── scenes/
    │   └── mo-welcome-scene.png
    └── explorations/
        ├── mo-thinking-exploration.png
        └── mo-done-exploration.png
```

## Asset-Status

| Datei | Rolle | Status |
| --- | --- | --- |
| `references/character/mo-character-master.png` | kanonische 3D-Form | primäre Referenz |
| `references/character/mo-character-silhouette.png` | Prüfung der Außenkontur | Referenz |
| `glyphs/static/mo-glyph.svg` | flacher UI-Glyph | Entwurf v1 |
| `glyphs/static/mo-glyph-monochrome.svg` | einfarbiger UI-Glyph | Entwurf v1 |
| `glyphs/animated/mo-generating.svg` | aktiver Generierungszustand | Bewegungsprototyp |
| `references/scenes/mo-welcome-scene.png` | Onboarding/Empty State | starke Exploration |
| `references/explorations/mo-thinking-exploration.png` | Pose-Idee | nicht formverbindlich |
| `references/explorations/mo-done-exploration.png` | Pose-Idee | nicht formverbindlich |

Die früher erzeugten Glow-Glyph-PNGs und ältere Bilddubletten wurden bewusst
nicht übernommen. Sie weichen von der kanonischen Körperform ab oder enthalten
Effekte, die sich nicht für kleine UI-Zeichen eignen.

## Herkunft der Rasterreferenzen

Die Rasterdateien wurden am 31. August 2026 aus dem vom Nutzer bereitgestellten
Ordner `/Users/frankalexanderweber/Desktop/mosa-explorations` kopiert. Die
tatsächlichen Dateieigenschaften wurden beim Import geprüft:

| Ursprungsdatei | Ziel | Tatsächliches Format |
| --- | --- | --- |
| `mo transparent.png` | `references/character/mo-character-master.png` | 2048 × 2048, Alpha |
| `mo Silhouettentest.png` | `references/character/mo-character-silhouette.png` | 2048 × 2048, Alpha |
| `mo-welcome-scene.png` | `references/scenes/mo-welcome-scene.png` | 1536 × 1024, ohne Alpha |
| `mo-thinking-transparent.png` | `references/explorations/mo-thinking-exploration.png` | 1024 × 1024, Alpha |
| `mo-done-transparent.png` | `references/explorations/mo-done-exploration.png` | 1024 × 1024, Alpha |

Ein separater Erzeugungs- oder Nutzungsrechtsnachweis liegt noch nicht in der
Assetstruktur. Deshalb bleibt MO-010 bis zur Dokumentation dieses Nachweises
auf `in Arbeit`.

## Design contract

- 64 × 64 coordinate system with no fixed output dimensions;
- character silhouette, two eyes, raised right fold and lower V remain visible;
- no raster texture, filters, drop shadows or embedded fonts in the production
  assets;
- eye size is optically enlarged for 16–20 px rendering;
- colors are deliberately flat so the glyph remains crisp in the application.

## Generierungsanimation

Für die Produktoberfläche ist eine animierte SVG geeigneter als ein GIF:

- bleibt bei 16–64 px scharf;
- benötigt keine Rasterbildsequenz;
- besitzt einen transparenten Hintergrund;
- kann später im Inline-SVG durch die Anwendung gesteuert werden;
- respektiert `prefers-reduced-motion` direkt im Asset.

`mo-generating.svg` verwendet ausschließlich performante `transform`- und
`opacity`-Animationen. Mo hebt sich innerhalb von 2,4 Sekunden um ungefähr eine
SVG-Einheit, die rechte Falte bewegt sich minimal und drei vorhandene
Faltflächen werden nacheinander aufgehellt. Augen und Gesicht bleiben statisch,
damit die Bewegung als Arbeitszustand und nicht als menschliche Mimik gelesen
wird.

Bei Reduced Motion wird dieselbe Datei vollständig statisch dargestellt. Ein
GIF wäre nur sinnvoll, wenn die Animation außerhalb des Produkts in einem
Format geteilt werden muss, das SVG nicht unterstützt.

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
- test the animation in the actual Chat-Header and generation state;
- confirm that 2.4 seconds feels calm without appearing stalled;
- decide whether the production integration should use the SVG as an `<img>`
  or an inline React component that can explicitly start and stop the motion.
