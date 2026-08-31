# Bradley Character Theme Variants

Status: bestanden

Geprüft: 2026-08-31

Todo: BRADLEY-012

## Verbindliche Entscheidung

Light und Dark Mode verwenden dieselbe transparente, kanonische Bradley-Datei:

`references/character/bradley-character-master.png`

Die Theme-Variante entsteht durch die jeweilige Canvas-Oberfläche und nicht
durch eine neu gezeichnete oder farblich abweichende Figur. So bleiben
Silhouette, Stofftextur, Augen, Falten und Markenfarbe in beiden Themes
identisch. Diese Ein-Asset-Strategie verhindert sichtbare Identitätsdrifts und
reduziert spätere Pflege- und Cache-Risiken.

Zwei generative Light-Mode-Versuche wurden bei der Prüfung verworfen: Einer
veränderte Größe, Augen und Falten; der andere renderte ein Schachbrett als
Hintergrund und veränderte ebenfalls die Form. Keiner dieser Entwürfe wurde ins
Repository übernommen.

## Reale Canvas-Oberflächen

Die Werte stammen aus `app/globals.css`. Die Hex-Werte sind für die
reproduzierbaren PNG-Prüfansichten aus den dort verbindlichen OKLCH-Tokens nach
sRGB umgerechnet.

| Theme | Oberfläche | Verbindlicher Token | sRGB-Prüfwert |
| --- | --- | --- | --- |
| Light | Background | `oklch(0.98 0.006 247)` | `#F5F9FC` |
| Light | Card | `oklch(1 0.004 247)` | `#FDFFFF` |
| Light | Muted | `oklch(0.955 0.01 247)` | `#EBF1F7` |
| Dark | Background | `oklch(0.15 0.012 247)` | `#070C10` |
| Dark | Card | `oklch(0.19 0.014 247)` | `#0F141A` |
| Dark | Muted | `oklch(0.24 0.014 247)` | `#1A2026` |

## Abnahmeansichten

- [Light-Mode-Prüfansicht](./previews/character/bradley-character-light-mode-preview.png)
- [Dark-Mode-Prüfansicht](./previews/character/bradley-character-dark-mode-preview.png)

Beide Dateien sind 1536 × 768 Pixel große, nicht transparente QA-Artefakte.
Sie zeigen den unveränderten Master jeweils auf Background, Card und Muted. Sie
dürfen nicht anstelle des transparenten Masters in der Produktoberfläche
verwendet werden.

## Kontrastbewertung

Die Figur wurde vollständig und in Kantenansicht auf allen sechs Flächen
geprüft. Silhouette, beide Augen, die rechte Falte, die innere Faltentrennung und
das untere V bleiben in Light und Dark visuell unterscheidbar. Weiße Halos oder
neue Hintergrundartefakte sind nicht sichtbar.

Die mittlere Farbe der deckenden Character-Pixel liegt bei ungefähr
`rgb(61 151 238)`. Ihr rechnerischer Kontrast reicht von 2,69:1 auf der hellen
Muted-Fläche bis 6,42:1 auf dem dunklen Background. Dieser 3D-Character ist ein
dekoratives oder unterstützendes Markenmotiv und darf weder der einzige
Statusindikator noch die einzige Beschriftung eines Bedienelements sein. Für
funktionale Avatar- und Statusflächen gelten stattdessen die separaten
Glyph-Anforderungen aus BRADLEY-013, BRADLEY-014 und BRADLEY-041.

## Integrationsvertrag

- Light und Dark referenzieren denselben transparenten Master ohne CSS-Filter.
- Keine themenabhängige Farbverschiebung, Kontur oder Glow anwenden.
- Den Character nur mit sachlichem Text oder einer zugänglichen Beschriftung
  verwenden, wenn er eine inhaltliche Rolle besitzt.
- Bei rein dekorativem Einsatz leeren Alt-Text verwenden.
- Die beiden Preview-PNGs sind ausschließlich Abnahmenachweise.
- Ändern sich die Theme-Tokens oder der Master, müssen beide Prüfansichten und
  die Sichtprüfung neu erstellt werden.

Damit erfüllt die Ein-Asset-Variante das Abnahmekriterium von BRADLEY-012, ohne
die kanonische Bradley-Form zwischen Light und Dark Mode zu verändern.
