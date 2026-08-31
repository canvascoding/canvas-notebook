# Bradley Glyph Small-Size QA

Status: bestanden

Geprüft: 2026-08-31

Todo: BRADLEY-013

## Geprüfte Datei

`glyphs/static/bradley-glyph.svg`

- Format: eigenständiges SVG
- Koordinatensystem: `viewBox="0 0 64 64"`
- feste Ausgabegröße: keine
- semantischer Name: `title` und `desc` vorhanden
- Produktionsabhängigkeiten: keine Rasterbilder, Fonts, Filter oder externen
  Referenzen

## Technische Prüfung

Die XML-Struktur wurde mit `xmllint --noout` validiert. Anschließend wurde
dasselbe SVG mit Sharp 0.35.3 exakt auf 16, 20, 24, 32 und 40 Pixel gerastert.
Alle Ausgaben besitzen die erwartete quadratische Größe und einen Alpha-Kanal.

| Zielgröße | sichtbare Pixelgrenze | Ergebnis |
| ---: | --- | --- |
| 16 px | x 1–14, y 1–14 | bestanden |
| 20 px | x 2–18, y 1–18 | bestanden |
| 24 px | x 2–22, y 1–22 | bestanden |
| 32 px | x 3–29, y 2–29 | bestanden |
| 40 px | x 4–37, y 2–37 | bestanden |

Damit besitzt der Glyph auch in der kleinsten Zielgröße einen transparenten
Sicherheitsrand und wird nicht am Viewport abgeschnitten.

## Visuelle Prüfung

Jede Zielgröße wurde auf den Canvas-Flächen Light Background `#F5F9FC` und
Dark Background `#070C10` bei nativer Pixelgröße sowie in ungeglätteter
Pixelvergrößerung geprüft.

Folgende Erkennungsmerkmale bleiben erhalten:

- asymmetrische, nach rechts ansteigende Oberkante;
- breite gefaltete Hauptfläche;
- abgesetzte linke Seitenfläche;
- angehobene rechte Falte;
- unteres V mit zwei getrennten Standflächen;
- genau zwei voneinander getrennte dunkle Augenpunkte.

Bei 16 px werden die Augen erwartungsgemäß stark antialiasiert, bleiben aber
als zwei getrennte dunkle Pixelgruppen auf der blauen Hauptfläche sichtbar. Ab
20 px sind beide Augen und die innere rechte Faltkante deutlich getrennt.

Die vorhandene Review-Datei
[`previews/bradley-glyph-preview.svg`](./previews/bradley-glyph-preview.svg)
zeigt alle Zielgrößen sowie Color-, Dark-Surface- und Monochrom-Kontexte.

## Verwerfungsprüfung

Minimal größere und auf das 16-Pixel-Raster verschobene Augen wurden vor einer
Änderung testweise gerendert. Sie verbesserten einzelne Subpixelwerte, wichen
bei 32–64 px aber unnötig von den freigegebenen Proportionen ab. Da die
unveränderte v1 alle Erkennungsmerkmale erfüllt, wurde keine optische
Sondergeometrie für nur eine Zielgröße eingeführt.

## Ergebnis und Nutzung

`bradley-glyph.svg` erfüllt das Abnahmekriterium von BRADLEY-013 bei 16, 20, 24,
32 und 40 Pixeln. Farb- und High-Contrast-Freigaben sind davon getrennt und
werden in BRADLEY-014 bewertet.

Bei bedeutungstragender Verwendung muss die Anwendung einen zugänglichen Namen
bereitstellen. Bei rein dekorativer Verwendung soll die einbettende Anwendung
das SVG mit `aria-hidden="true"` aus dem Accessibility Tree entfernen.
