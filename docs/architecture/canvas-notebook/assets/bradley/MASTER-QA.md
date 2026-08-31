# Bradley Character Master QA

Status: bestanden

Geprüft: 2026-08-31

Todo: BRADLEY-011

## Geprüfte Datei

`references/character/bradley-character-master.png`

- SHA-256: `eb0d618a440ae142f4da41942222879e77f545c4517d06d4a032201133c6701c`
- Format: PNG mit RGBA-Kanälen
- Abmessungen: 2048 × 2048 Pixel
- sichtbare Motivgrenze bei Alpha größer 0: x 554–1576, y 448–1631
- sichtbare Motivgrenze bei Alpha mindestens 8: x 554–1576, y 448–1630

## Technische Alpha-Prüfung

Die Datei wurde mit Sharp 0.35.3 als unkomprimierte RGBA-Pixeldaten geprüft.

| Messwert | Ergebnis |
| --- | ---: |
| Vollständig transparente Pixel | 3.211.228 (76,5616 %) |
| Halbtransparente Pixel | 13.067 (0,3115 %) |
| Vollständig deckende Pixel | 970.009 (23,1268 %) |
| Nicht transparente Pixel am äußeren Bildrand | 0 |
| Weißnahe, halbtransparente Pixel | 951 |
| Weißnahe Pixel mit Alpha mindestens 128 | 0 |

Die 951 weißnahen Pixel verteilen sich ausschließlich auf schwach deckende
Antialiasing-Stufen: 708 Pixel bei Alpha 1–15, 215 bei Alpha 16–63 und 28 bei
Alpha 64–127. Es existiert kein weißnaher Kantenpixel mit mindestens 50 Prozent
Deckkraft. Damit liegt kein deckender weißer Freistellsaum vor.

RGB-Werte vollständig transparenter Pixel wurden nicht als sichtbarer Fehler
gewertet, weil sie bei Alpha 0 nicht gerendert werden. Entscheidend sind der
Alpha-Kanal und die kontrastive Kompositionsprüfung.

## Visuelle Kontrastprüfung

Der unveränderte Master wurde zur Sichtprüfung auf drei Hintergründe gesetzt:

- Dunkelblau `#111827`;
- Magenta `#7E22CE` als starker Gegenkontrast;
- dunkelgraues/hellgraues Schachbrett zur Transparenzkontrolle.

Zusätzlich wurden obere und untere Motivkante in dreifacher Pixelvergrößerung
auf Dunkelblau und Magenta geprüft. Es ist kein weißer Halo sichtbar. Die
dunkle, schmale Linie an der unteren Standkante gehört zur natürlichen
Kontaktverschattung des Renders und ist kein Freistellartefakt.

## Ergebnis

Der hochauflösende Character-Master erfüllt das Abnahmekriterium von
BRADLEY-011. Er besitzt einen transparenten Außenbereich, ausreichend Abstand
zum Bildrand und keine sichtbaren weißen Randartefakte. Eine Neuberechnung oder
destruktive Kantenkorrektur ist nicht erforderlich.

Bei jeder späteren Änderung der Masterdatei müssen SHA-256, Alpha-Messwerte und
die visuelle Prüfung auf mindestens einem dunklen und einem gesättigten
Gegenhintergrund erneut erstellt werden.
