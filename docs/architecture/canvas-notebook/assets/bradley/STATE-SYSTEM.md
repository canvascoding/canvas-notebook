# Bradley Small-State System

Status: bestanden

Geprüft: 2026-08-31

Todo: BRADLEY-015

## Verbindliche Zustände

| Zustand | Datei | Nicht-anatomisches Merkmal | Bewegung |
| --- | --- | --- | --- |
| Idle | `glyphs/static/bradley-glyph.svg` | kein Status-Badge | keine |
| Arbeit | `glyphs/animated/bradley-generating.svg` | drei ansteigende Aktivitätsbalken | ruhige Faltbewegung und Balkenwechsel |
| Warten | `glyphs/states/bradley-waiting.svg` | Pausezeichen | keine |
| Abschluss | `glyphs/states/bradley-done.svg` | Häkchen | keine |

Alle Varianten verwenden dieselbe 64-×-64-Körperform, dieselben Augenpositionen
und dieselben Faltflächen. Nur das 15-×-15-Status-Badge unten rechts unterscheidet
Arbeit, Warten und Abschluss. Idle bleibt bewusst frei von Badge und Bewegung.

## Bedeutungsregeln

### Idle

Idle bedeutet ausschließlich, dass Bradley bereit ist und keine sichtbare
Aktion ausführt. Der Zustand darf nicht dauerhaft animieren und keine
ungefragte Aufforderung darstellen.

### Arbeit

Arbeit wird verwendet, solange eine tatsächliche Antwortvorbereitung,
Dateioperation oder Tool-Ausführung aktiv ist. Drei Balken kommunizieren
Aktivität auch dann, wenn Animationen deaktiviert sind.

### Warten

Warten wird nur verwendet, wenn der nächste Schritt von einer Nutzerfreigabe,
Nutzereingabe oder klar benannten externen Voraussetzung abhängt. Das
Pausezeichen darf nicht für normale Queue- oder Rechenzeit eingesetzt werden.

### Abschluss

Abschluss signalisiert ein erfolgreich fertiggestelltes, konkret benanntes
Ergebnis. Das Häkchen ist ein sachliches UI-Zeichen und keine Geste oder Mimik.
Der Zustand ersetzt keine Ergebniszusammenfassung.

## Anti-Anthropomorphisierungsvertrag

- Körper, Augen und Falten werden zwischen Zuständen nicht verformt.
- Keine Mund-, Augenbrauen-, Hand-, Finger-, Fuß- oder Kopfbewegung ergänzen.
- Keine traurige, aufgeregte, fragende oder jubelnde Mimik verwenden.
- Warten ist ein Systemzustand und keine vermeintliche Unsicherheit Bradleys.
- Abschluss verwendet kein Konfetti und keine Siegerpose.
- Status-Badges bleiben sachlich und verwenden etablierte UI-Symbole.

## Reduced Motion und Semantik

Bei `prefers-reduced-motion: reduce` werden Schweben, Faltbewegung,
Flächen-Scan und Balkenwechsel im Arbeits-SVG deaktiviert. Die drei
Aktivitätsbalken bleiben statisch sichtbar. Dadurch unterscheidet sich Arbeit
weiterhin von Idle, ohne dass Bewegung erforderlich ist.

Jeder bedeutungstragende Einsatz muss zusätzlich einen sichtbaren Statustext
oder einen zugänglichen Namen besitzen. Die Icons dürfen weder Farbe noch
Bewegung als einzige Zustandsinformation verwenden. Das Badge selbst ist in
den SVGs mit `aria-hidden="true"` als Teil der Gesamtbeschreibung markiert.

## Abnahme

Alle vier Zustände wurden mit Sharp 0.35.3 bei 16, 20, 24, 32 und 40 Pixeln mit
Alpha-Kanal gerastert. Idle, Arbeit, Warten und Abschluss sind bei 16 und 40
Pixeln auf Canvas Light Background und Canvas Dark Background visuell
unterscheidbar. Die dauerhafte Review-Datei ist:

[`previews/bradley-state-preview.png`](./previews/bradley-state-preview.png)

Sie ist ein QA-Artefakt und kein Produktions-Asset. Damit erfüllt das System
das Abnahmekriterium von BRADLEY-015, ohne anatomische oder comicartige Mimik
einzuführen.
