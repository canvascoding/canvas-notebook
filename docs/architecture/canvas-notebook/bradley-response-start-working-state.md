# Bradley-Arbeitszustand beim Antwortstart

Status: implementiert und validiert  
Stand: 31. August 2026  
Umsetzung: BRADLEY-042

## Ergebnis

Nachdem die Runtime einen Bradley-Lauf bestätigt hat und bevor der erste
sichtbare Antwortinhalt eintrifft, zeigt der Chat-Status den animierten
Bradley-Arbeitsglyph und die Copy „Bradley bereitet die Antwort vor …“ / „Bradley
is preparing the response…“.

Die Animation startet nicht während des rein optimistischen UI-Zustands. Sie
stoppt ohne Abschlusschoreografie, sobald Antworttext oder ein Anhang sichtbar
wird, ein Toollauf beginnt, ein Abbruch verarbeitet wird oder die Runtime idle
wird.

## Zustandsvertrag

| Zustand | Darstellung |
| --- | --- |
| optimistischer Sendestart | statischer Bradley-Glyph, normaler Arbeitsstatus |
| bestätigtes Streaming ohne Ausgabe | 2,4-Sekunden-Arbeitsbewegung plus drei Aktivitätsbalken |
| erster sichtbarer Antwortinhalt | statischer Bradley-Glyph; der Textstream zeigt Fortschritt |
| Toollauf | statischer Bradley-Glyph; Toolstatus bleibt die primäre Aktivität |
| Abbruch | neutrales rotes Statuszeichen, keine Bradley-Bewegung |
| Spezialagent | vorhandenes neutrales Statuszeichen, kein Bradley-Glyph |
| Idle | reine Textanzeige „Bereit“ / “Ready”, keine Bewegung |

## Motion und Barrierefreiheit

- Es werden nur `transform` und `opacity` animiert.
- Körper, erhobene Faltfläche und Aktivitätsbalken teilen einen ruhigen
  2,4-Sekunden-Zyklus.
- Die Augen bleiben statisch; es gibt kein Blinzeln oder Blickverhalten.
- `prefers-reduced-motion: reduce` deaktiviert alle Bewegungen und zeigt die
  drei Balken statisch.
- Der SVG-Glyph ist dekorativ. Der sichtbare Status liegt in einer einzigen
  höflichen `role="status"`-/`aria-live="polite"`-Region.
- Spezialagenten, Toolläufe und Abbruchzustände erhalten keine Bradley-
  Körperschleife.

## Regressionstest

```bash
npm run test:agent:bradley-working-state
```

Der Test prüft bestätigten gegen optimistischen Start, den Stopp bei erster
Ausgabe, Tool-/Abbruch-/Idle-Übergänge, die Bradley- und Spezialagenten-Trennung,
Statussemantik und die Reduced-Motion-Regel.

Die visuelle Laufzeitprüfung erfolgt gebündelt in BRADLEY-044 nach ausdrücklicher
Browserfreigabe.
