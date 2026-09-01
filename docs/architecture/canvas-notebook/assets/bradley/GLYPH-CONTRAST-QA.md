# Bradley Glyph Monochrome and High-Contrast QA

Status: bestanden

Geprüft: 2026-08-31

Todo: BRADLEY-014

## Freigegebene Varianten

| Datei | Farbe | Verbindlicher Einsatz |
| --- | --- | --- |
| `glyphs/static/bradley-glyph-monochrome.svg` | `#172033` | statische Einfarbendarstellung auf hellen Flächen |
| `glyphs/static/bradley-glyph-monochrome-inverse.svg` | `#FFFFFF` | statische Einfarbendarstellung auf dunklen Flächen |
| `glyphs/static/bradley-glyph-high-contrast.svg` | `currentColor` | Inline-SVG für vererbte System- oder Forced-Colors-Farbe |

Alle drei Dateien verwenden dieselben drei Silhouettenpfade und dieselbe Maske
für zwei transparente Augenaussparungen. Es gibt keine Rastertextur,
Farbverläufe, Filter, externen Referenzen oder eingebetteten Fonts.

## Technische Prüfung

- alle Dateien mit `xmllint --noout` als valides XML geprüft;
- bei 16, 20, 24, 32 und 40 Pixeln mit Sharp 0.35.3 gerastert;
- Alpha-Kanal aller drei Varianten in jeder Zielgröße miteinander verglichen;
- Alpha-Geometrie ist in allen fünf Größen identisch;
- keine Variante wird am 64-×-64-Viewport abgeschnitten.

## Kontrastprüfung

| Variante | Vordergrund | Prüffläche | Kontrast |
| --- | --- | --- | ---: |
| Monochrome | `#172033` | Light Background `#F5F9FC` | 15,37:1 |
| Monochrome inverse | `#FFFFFF` | Dark Background `#070C10` | 19,64:1 |
| High Contrast, Simulation | `#FFFF00` | `#000000` | 19,56:1 |

Die Kontrastwerte wurden nach der WCAG-Relativluminanzformel aus den
sRGB-Prüffarben berechnet. Sie liegen deutlich oberhalb der für wesentliche
nicht-textliche UI-Grafiken relevanten 3:1-Schwelle.

## Visuelle Erkennbarkeit ohne Farbe und Textur

In allen Varianten bleiben folgende Merkmale erhalten:

- schräge Oberkante und asymmetrische Außenkontur;
- rechte Ausbuchtung der angehobenen Falte;
- unteres V mit zwei getrennten Standflächen;
- genau zwei voneinander getrennte Augenaussparungen.

Die inneren Faltfarben des primären Glyphs entfallen in der Einfarbenfassung
absichtlich. Die Wiedererkennbarkeit entsteht hier aus Kontur, V, rechter Falte
und Augen und bleibt deshalb auch in Druck, Masken und Forced Colors erhalten.

## Integrationsregeln

- `bradley-glyph-monochrome.svg` nur auf ausreichend hellen Flächen verwenden.
- `bradley-glyph-monochrome-inverse.svg` nur auf ausreichend dunklen Flächen
  verwenden.
- `bradley-glyph-high-contrast.svg` als Inline-SVG einbinden, wenn die Farbe vom
  Element oder Betriebssystem geerbt werden soll.
- Die `currentColor`-Variante nicht als `<img>` verwenden, wenn eine vom
  Elternelement geerbte Farbe erwartet wird; externe SVG-Dokumente erben diese
  Farbe nicht zuverlässig.
- Augenaussparungen zeigen immer die jeweilige Hintergrundfarbe. Daher keine
  unruhigen Bildhintergründe direkt hinter dem Glyph verwenden.
- Bedeutungstragende Einsätze behalten einen zugänglichen Namen; Farbe oder
  Bradley allein dürfen keinen Zustand exklusiv codieren.

Damit erfüllen die drei Dateien das Abnahmekriterium von BRADLEY-014: Bradley
bleibt ohne Farbe und Textur unterscheidbar und kann auf hellen, dunklen sowie
systemgesteuerten High-Contrast-Flächen eingesetzt werden.
