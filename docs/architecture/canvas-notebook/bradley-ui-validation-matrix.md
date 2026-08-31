# Bradley UI- und End-to-End-Prüfung

Stand: 31. August 2026

Status: fertig

Zugehöriges Todo: `BRADLEY-044`

## Ziel und Abgrenzung

Diese Prüfung validiert den begrenzten Bradley-UI-Piloten aus `BRADLEY-040` bis
`BRADLEY-043`. Sie prüft die sichtbare Hauptagent-Identität, die Abgrenzung zu
Spezialagenten, den Starter-Zustand und den Arbeitszustand. Interne Runtime-IDs,
Sessions, Automationen und Speicherpfade werden weiterhin als `canvas-agent`
geführt und sind durch die bestehende Stabilitätsregression abgesichert.

Die automatisierte Vorprüfung und die visuelle End-to-End-Abnahme mit
Playwright sind abgeschlossen.

## Automatisierte Vorprüfungen

Der Befehl `npm run test:agent:bradley-ui-preflight` bündelt folgende Gates:

| Gate | Erwartung | Status |
| --- | --- | --- |
| DE-/EN-Texte | Bradley-Starter und Antwortvorbereitung sind in beiden Sprachen vorhanden. | bestanden |
| Hauptagent-Identität | `canvas-agent` wird sichtbar als Bradley dargestellt. | bestanden |
| Spezialagenten | Eigene Namen und Icons bleiben erhalten. | bestanden |
| Glyph | Skalierbares `64 × 64`-SVG, dekorative und benannte Nutzung sind semantisch korrekt. | bestanden |
| Reduced Motion | Bradley-Animation wird über `prefers-reduced-motion` vollständig deaktiviert. | bestanden |
| Arbeitszustand | Animation erscheint nur bei bestätigter Antwortvorbereitung; Tool-, Abbruch- und Inhaltszustände bleiben statisch. | bestanden |
| Starter-Zustand | Bradley erscheint nur im leeren normalen Hauptagent-Chat, nicht bei Spezialagenten oder im Studio. | bestanden |
| Starter-Asset | PNG ist `2048 × 2048`, besitzt Alpha sowie transparente und deckende Pixel. | bestanden |
| Screenreader-Basis | Live-Status ist `role="status"` mit `aria-live="polite"`; dekorative Grafik bleibt verborgen. | bestanden |
| Runtime-Stabilität | IDs, Sessions, Automationen, APIs und Speicherpfade bleiben unverändert. | bestanden |

Ausgeführt am 31. August 2026: Die gesamte Vorprüfung war erfolgreich. Der
Produktions-Build kompiliert, wird aber in der nachgelagerten TypeScript-Prüfung
durch den bereits vorhandenen, nicht zu Bradley gehörenden Fehler in
`app/apps/email/components/EmailAttachmentPanel.tsx:243` blockiert
(`file.path` ist möglicherweise `undefined`).

## Browser-Testmatrix

Für jede Zeile werden Selector, Empty State und Antwortvorbereitung gemeinsam
geprüft. Die Prüfung umfasst außerdem Tastaturfokus, lesbare Beschriftungen,
keine Überlagerungen sowie die klare visuelle Trennung zu einem Spezialagenten.

| Szenario | Viewport | Farbschema | Bewegung | Erwartung | Ergebnis |
| --- | --- | --- | --- | --- | --- |
| Desktop Light | `1440 × 900` | Light | normal | Bradley ist scharf, Starter bleibt zentriert, Arbeitsanimation startet und endet korrekt. | [bestanden](./bradley-044-evidence/desktop-light.png) |
| Desktop Dark | `1440 × 900` | Dark | normal | Glyph, Figur, Text und Status bleiben kontrastreich und klar erkennbar. | [bestanden](./bradley-044-evidence/desktop-dark.png) |
| Mobile Light | `390 × 844` | Light | normal | Keine Überläufe; Selector, Starter und Eingabe verdrängen einander nicht. | [bestanden](./bradley-044-evidence/mobile-light.png) |
| Mobile Dark | `390 × 844` | Dark | normal | Mobile Darstellung bleibt klar, scharf und vollständig bedienbar. | [bestanden](./bradley-044-evidence/mobile-dark.png) |
| Desktop Reduced Motion | `1440 × 900` | Light | reduziert | Bradley bleibt statisch; Status und Text vermitteln den Zustand vollständig. | [bestanden](./bradley-044-evidence/desktop-light-reduced-motion.png) |
| Mobile Reduced Motion | `390 × 844` | Dark | reduziert | Keine Bradley-Bewegung; Layout und Status bleiben unverändert nutzbar. | [bestanden](./bradley-044-evidence/mobile-dark-reduced-motion.png) |

## Prüfschritte pro Szenario

1. Normalen Hauptagent-Chat öffnen und im Selector den Namen Bradley sowie die
   Bradley-Glyph bestätigen.
2. Leeren Chat prüfen: Figur, Eyebrow und Starter-Frage sind sichtbar, Eingabe
   und vorhandene Aktionen bleiben frei.
3. Spezialagenten auswählen: eigener Name und eigenes Icon erscheinen; Bradley-
   Figur und Bradley-Glyph werden nicht fälschlich übernommen.
4. Zu Bradley zurückkehren und eine Antwort starten: animierte Glyph und
   lokalisierter Live-Status erscheinen erst nach bestätigtem Antwortstart.
5. Sobald sichtbarer Inhalt erscheint, muss die Vorbereitungsschleife enden.
6. Tool- und Abbruchzustand prüfen: keine irreführende Bradley-Schleife;
   Statusfarbe und Text entsprechen dem Zustand.
7. Selector vollständig per Tastatur bedienen und sichtbaren Fokus prüfen.
8. Bei Reduced Motion bestätigen, dass die SVG-Animation tatsächlich stillsteht.

## Funktionale Ergebnisse

- Desktop und Mobile hatten weder horizontalen noch vertikalen Seiten-Overflow.
  Selector, Starter, Status und Eingabe lagen vollständig innerhalb des
  jeweiligen Viewports.
- Der Hauptagent zeigte Name, Bradley-Glyph und Bradley-Starter. Beim Wechsel zum
  Email-Agenten blieben dessen Name und `24 × 24`-Spezialagent-Icon erhalten;
  der Bradley-Starter war nicht vorhanden.
- Beim echten Antwortlauf erschien nach bestätigtem Streamstart
  „Bradley is preparing the response…“. Die Animation nutzte
  `bradley-working-hover` und verschwand beim ersten sichtbaren Antwortinhalt.
- Mit `prefers-reduced-motion: reduce` erschien derselbe Status mit
  `animation-name: none` und `transform: none`; nach der Antwort stand der Status
  wieder auf „Ready“.
- Der Live-Status blieb in allen Zuständen `role="status"` mit
  `aria-live="polite"`.
- Der Agent-Selector ließ sich per Enter öffnen, per Tab innerhalb des Dialogs
  bedienen und per Escape schließen; der Fokus kehrte zum Selector zurück.
- Ein sehr früher Stop deckte zunächst einen kurzen Übergang zurück in die
  Bradley-Vorbereitung auf. Der Abbruch setzt nun sofort den optimistischen
  Zustand „Stopping“ und schützt ihn vor verspäteten Streaming-Events. Der
  erneute Lauf wechselte direkt von „Stopping“ zu „Ready“, ohne Bradley-Schleife.
- Der finale Lauf meldete keine Browserfehler. Drei vorhandene Warnungen stammen
  ausschließlich vom lokal nicht erreichbaren Managed-License-Control-Plane und
  betreffen die Bradley-UI nicht.

## Abschluss

Alle sechs Matrixszenarien, die Spezialagent-Abgrenzung, der echte Antwortstart,
Reduced Motion, Frühabbruch und Tastaturbedienung sind bestanden. Die finalen
Screenshots liegen unter `bradley-044-evidence/`. Damit ist `BRADLEY-044` fertig;
`BRADLEY-045` darf als nächstes beginnen.
