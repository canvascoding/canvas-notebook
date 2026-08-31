# Bradley Motion Specification

Status: freigegeben für den UI-Pilot

Geprüft: 2026-08-31

Todo: BRADLEY-016

## Geltungsbereich

Motion dient ausschließlich dazu, einen realen aktiven Arbeitszustand sichtbar
zu machen. Die einzige derzeit freigegebene bewegte Datei ist:

`glyphs/animated/bradley-generating.svg`

Idle, Warten und Abschluss bleiben statisch. Animation darf weder Persönlichkeit
simulieren noch fehlende Statusinformation ersetzen.

## Bewegungsparameter

| Ebene | Dauer | Easing | Bereich | Wiederholung |
| --- | ---: | --- | --- | --- |
| Gesamter Character | 2,4 s | `cubic-bezier(.4, 0, .2, 1)` | y 0 bis −1,15 SVG-Einheiten; Skalierung 1 bis 1,008 | solange aktiv |
| Rechte Falte | 2,4 s | `cubic-bezier(.4, 0, .2, 1)` | Rotation 0 bis −2,4°; y 0 bis −0,35 | solange aktiv |
| Faltflächen-Scan | 2,4 s | `ease-in-out` | Deckkraft 0 bis 0,22; Delays 0 / 0,28 / 0,56 s | solange aktiv |
| Aktivitätsbalken | 1,2 s | `ease-in-out` | Deckkraft 0,4 bis 1; Delays 0 / 0,16 / 0,32 s | solange aktiv |

Augen, Badge-Fläche und Körperpfade werden nicht verformt. Es gibt keine
Mund-, Blick-, Blinzel- oder Gestenanimation.

## Zustandssemantik

### Start

Die Animation startet erst, wenn Bradley tatsächlich eine Antwort vorbereitet,
eine Dateioperation ausführt oder ein Tool aktiv ist. Reines Hover, Fokus,
Seitenaufruf, Idle oder Queue-Warten starten keine Bewegung.

### Fortsetzung

Die Schleife läuft nur, solange der aktive Arbeitszustand wahr ist. Pro sichtbarer
Produktoberfläche darf höchstens ein Bradley-Arbeitsglyph gleichzeitig
animieren. Aus dem Viewport entfernte oder verdeckte Instanzen sollen pausiert
oder nicht gemountet werden.

### Stop

Beim Wechsel zu Warten, Abschluss, Fehler oder Idle wird der Arbeitsglyph
ersetzt und nicht bis zum Zyklusende weitergeführt. Statuswechsel werden nicht
künstlich verzögert, nur um eine Animation abzuschließen.

## Reduced Motion

Das SVG enthält eine eigene
`@media (prefers-reduced-motion: reduce)`-Regel. Sie setzt:

- Character-Schweben auf `none`;
- Faltrotation und Translation auf `none`;
- Faltflächen-Scan auf Deckkraft 0;
- Balkenwechsel auf `none`;
- alle drei Aktivitätsbalken statisch auf Deckkraft 1.

Damit bleibt der Zustand als Arbeits-Badge sichtbar, ohne Bewegung zu benötigen.
Die Anwendung darf diese Regel nicht durch globale Animationsklassen
überschreiben.

## Performancevertrag

- Animiert werden ausschließlich `transform` und `opacity`.
- Keine Animation von `d`, `points`, Layoutgrößen, Farben, Blur oder Schatten.
- Keine SVG-Filter oder Rastersequenzen verwenden.
- Bewegte Gruppen besitzen gezielte `will-change`-Hinweise; nicht pauschal das
  gesamte Dokument markieren.
- Die Datei bleibt ohne Skript, externe Abhängigkeit und eingebetteten Font.
- Ein GIF ist für die Produktoberfläche nicht zulässig, weil Skalierung,
  Transparenz, Zustandssteuerung und Reduced Motion schlechter kontrollierbar
  wären.

## Einbettung und Steuerung

Für den UI-Pilot ist ein Inline-React-SVG beziehungsweise eine aus dieser Datei
abgeleitete Komponente bevorzugt. Dadurch kann die Anwendung Mounting,
zugänglichen Namen und den echten Runtime-Zustand gemeinsam steuern. Eine
Einbettung per `<img>` ist nur zulässig, wenn die Datei ausschließlich während
des aktiven Arbeitszustands gemountet wird.

Die App darf die Animation nicht als generischen Dauer-Avatar einsetzen. Die
Integration erfolgt erst in BRADLEY-042; die Browser- und Reduced-Motion-Prüfung
auf der echten Oberfläche folgt nach ausdrücklicher Freigabe in BRADLEY-044.

## Accessibility

- Der sichtbare Statustext benennt die echte Aktion, zum Beispiel „Bradley
  prüft die Dateien …“.
- Bewegung, Farbe und Badge sind nie die einzige Zustandsinformation.
- Wiederholungszyklen erzeugen keine wiederholten Live-Region-Ansagen.
- Wenn das SVG neben einem bereits benannten Status rein dekorativ ist, wird es
  durch die einbettende Komponente mit `aria-hidden="true"` verborgen.
- Wenn es selbst bedeutungstragend ist, bleiben `title` und `desc` erhalten und
  werden durch den konkreten Statuskontext ergänzt.

## Technische Abnahme

Die SVG-Datei wurde als valides XML geprüft und bei 16, 20, 24, 32 und 40
Pixeln mit Alpha-Kanal gerastert. Der Quelltext verwendet für Animationen nur
`transform` und `opacity`, enthält keine Filter und besitzt einen expliziten
Reduced-Motion-Block. Der statische Reduced-Motion-Zustand ist im
[Bradley Small-State System](./STATE-SYSTEM.md) abgenommen.

Damit sind Dauer, Easing, Bedeutung, Performance und bewegungsarme Alternative
vollständig dokumentiert und das Abnahmekriterium von BRADLEY-016 erfüllt.
