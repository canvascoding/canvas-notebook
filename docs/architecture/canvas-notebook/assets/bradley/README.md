# Bradley Asset-System

Dieser Ordner enthält die versionierten Referenzbilder, statischen Glyphs und
den ersten Bewegungsprototyp für Bradley. Die Assets sind weiterhin Entwürfe und
noch nicht als produktive UI-Integration freigegeben.

## Ordnerstruktur

```text
bradley/
├── MASTER-QA.md
├── PROVENANCE.md
├── THEME-VARIANTS.md
├── checksums.sha256
├── glyphs/
│   ├── static/
│   │   ├── bradley-glyph.svg
│   │   └── bradley-glyph-monochrome.svg
│   └── animated/
│       └── bradley-generating.svg
├── previews/
│   ├── bradley-glyph-preview.svg
│   └── character/
│       ├── bradley-character-dark-mode-preview.png
│       └── bradley-character-light-mode-preview.png
└── references/
    ├── character/
    │   ├── bradley-character-master.png
    │   └── bradley-character-silhouette.png
    ├── scenes/
    │   └── bradley-welcome-scene.png
    └── explorations/
        ├── bradley-thinking-exploration.png
        └── bradley-done-exploration.png
```

## Asset-Status

| Datei | Rolle | Status |
| --- | --- | --- |
| `references/character/bradley-character-master.png` | kanonische 3D-Form | QA-freigegebene primäre Referenz |
| `references/character/bradley-character-silhouette.png` | Prüfung der Außenkontur | Referenz |
| `glyphs/static/bradley-glyph.svg` | flacher UI-Glyph | Entwurf v1 |
| `glyphs/static/bradley-glyph-monochrome.svg` | einfarbiger UI-Glyph | Entwurf v1 |
| `glyphs/animated/bradley-generating.svg` | aktiver Generierungszustand | Bewegungsprototyp |
| `previews/character/bradley-character-light-mode-preview.png` | Light-Mode-Flächenprüfung | QA-Nachweis |
| `previews/character/bradley-character-dark-mode-preview.png` | Dark-Mode-Flächenprüfung | QA-Nachweis |
| `references/scenes/bradley-welcome-scene.png` | Onboarding/Empty State | starke Exploration |
| `references/explorations/bradley-thinking-exploration.png` | Pose-Idee | nicht formverbindlich |
| `references/explorations/bradley-done-exploration.png` | Pose-Idee | nicht formverbindlich |

Die früher erzeugten Glow-Glyph-PNGs und ältere Bilddubletten wurden bewusst
nicht übernommen. Sie weichen von der kanonischen Körperform ab oder enthalten
Effekte, die sich nicht für kleine UI-Zeichen eignen.

## Herkunft der Rasterreferenzen

Die Rasterdateien wurden am 31. August 2026 aus dem vom Nutzer bereitgestellten
Ordner `/Users/frankalexanderweber/Desktop/mosa-explorations` kopiert. Die
tatsächlichen Dateieigenschaften wurden beim Import geprüft:

| Ursprungsdatei | Ziel | Tatsächliches Format |
| --- | --- | --- |
| `mo transparent.png` | `references/character/bradley-character-master.png` | 2048 × 2048, Alpha |
| `mo Silhouettentest.png` | `references/character/bradley-character-silhouette.png` | 2048 × 2048, Alpha |
| `mo-welcome-scene.png` | `references/scenes/bradley-welcome-scene.png` | 1536 × 1024, ohne Alpha |
| `mo-thinking-transparent.png` | `references/explorations/bradley-thinking-exploration.png` | 1024 × 1024, Alpha |
| `mo-done-transparent.png` | `references/explorations/bradley-done-exploration.png` | 1024 × 1024, Alpha |

Importkette, Product-Owner-Autorisierung, Nutzungsgrenzen und SHA-256-Nachweis
sind portabel in [PROVENANCE.md](./PROVENANCE.md) dokumentiert. Die Prüfsummen
liegen zusätzlich in [`checksums.sha256`](./checksums.sha256). Damit ist
BRADLEY-010 abgeschlossen; eine spätere juristische Prüfung für Merchandising,
Asset-Weiterverkauf oder einen eigenständigen internationalen Bradley-Auftritt
bleibt davon unberührt.

## Character-Master-QA

Auflösung, Alpha-Kanal, Motivabstand und die Kantenwirkung des transparenten
Masters sind in [MASTER-QA.md](./MASTER-QA.md) dokumentiert. Die technische und
visuelle Prüfung auf dunklem, gesättigtem und kariertem Gegenhintergrund ergab
keinen sichtbaren weißen Freistellsaum. Damit ist BRADLEY-011 abgeschlossen;
eine destruktive Kantenkorrektur war nicht erforderlich.

## Theme-Varianten

Light und Dark Mode verwenden bewusst denselben transparenten Character-Master
ohne Farbfilter oder neu generierte Form. Die beiden Theme-Profile, die
verbindlichen Canvas-Oberflächen und die visuellen Abnahmenachweise sind in
[THEME-VARIANTS.md](./THEME-VARIANTS.md) dokumentiert. Damit ist BRADLEY-012
abgeschlossen. Die PNGs unter `previews/character/` sind nur Prüfansichten und
keine Produktions-Assets.

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

`bradley-generating.svg` verwendet ausschließlich performante `transform`- und
`opacity`-Animationen. Bradley hebt sich innerhalb von 2,4 Sekunden um ungefähr eine
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
