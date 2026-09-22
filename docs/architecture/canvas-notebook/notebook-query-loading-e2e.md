# Notebook-Ladeabläufe: Browserabnahme

Stand: 2026-09-22. Browserprüfung ausdrücklich freigegeben.
Ziel: aktueller Worktree auf `http://localhost:3000`, verwaltete lokale
PostgreSQL-Datenbank; keine Container-Builds und kein Remote-Notebook.

## Prüfinventar

| Ablauf / sichtbare Zusage | Funktionsprüfung | Visuelle Prüfung / Evidenz |
| --- | --- | --- |
| Login und Startseite | Bootstrap-Login über UI; Startseite lädt | Desktop-Startansicht |
| Bestehender Chat | Direkter Einstieg, Bootstrap vor Verlauf; History nicht Voraussetzung | Erstlade-Skeleton und geladene Nachrichten |
| Neuer Chat / Startseiten-Prompt | Keine Session vor Senden; genau eine Erstellung und Versand | Composer, Senden, bestätigte Nachricht |
| Hintergrundabgleich | Verzögerter Read darf vorhandene Nachrichten nicht entfernen | Verlauf bleibt sichtbar |
| Schneller Chatwechsel | Verspätete Antwort von A verändert B nicht | Richtiger Titel und Verlauf |
| Dokumente | Öffnen unabhängig von Chat/History, Editor und Baum nutzbar | Lade-Skeleton, fertiger Editor |
| Reviews | Öffnen, Vergleich, Übernahme/Versionskontrolle | Lesbarer Vergleich und Aktionszustand |
| Kleine Ansicht | Notebook und Composer auf mobilem Viewport erreichbar | Screenshot und Bounds-Prüfung |

Explorative Fälle: langsamer Bootstrap mit anschließendem Chatwechsel;
Hintergrundfehler beziehungsweise wiederholtes Öffnen. Kontrollierte
HTTP-/WebSocket-Fixtures werden in den Ergebnissen von echten Backend-Aufrufen
getrennt ausgewiesen.

## Ergebnisse

Der interaktive Durchlauf mit echtem Login und echtem Ollama-Runtime-Zugang
hat einen Startseiten-Prompt genau einmal erstellt und gesendet: ein
`POST /api/sessions`, ein WebSocket-`send_message`, sichtbare Antwort `OK`.
Die gespeicherte Prompt-Übergabe war danach entfernt. „Neuer Chat“ hat vor dem
Senden keine weitere Session erstellt.

Beim direkten Chat-Einstieg starteten Runtime-Auflösung und gezielter Bootstrap
parallel. Vor der Anzeige war keine Sessionliste nötig; die erste Seite kam
aus dem Bootstrap, ohne zusätzliche initiale Nachrichtenabfrage. Der sichtbare
Dateibaum lud unabhängig davon. Beim warmen Wiederöffnen blieb der Verlauf
während einer zurückgehaltenen HTTP-Antwort sichtbar; derselbe Nachrichten-
DOM-Knoten war nach dem Abgleich weiterhin verbunden.

Mobile Prüfung bei 390 × 844: Dokumentbreite 390 px, Composer und Senden-
Schaltfläche innerhalb des Viewports. Screenshots von Startseite, Skeleton,
warmem Abgleich und mobiler Ansicht liegen unter
`test-results/notebook-query-e2e/` (lokale, nicht versionierte Artefakte).

### Gefundene Probleme

- **Startseiten-Sortierung:** Drizzle entfernte in einer rohen korrelierten
  Unterabfrage die äußere Tabellenqualifizierung. Der projizierte Aktivitätswert
  wurde dadurch `0`; die nachgelagerte Sortierung konnte einen neuen Chat aus
  den ersten zehn Treffern verdrängen. Auf korrekt korrelierte QueryBuilder-
  Unterabfragen für PI und Legacy umgestellt. PGlite prüft zwölf Chats,
  Top-10-Sortierung, separate Aktivitätswerte und gemischte Legacy-Ergebnisse.
  GitNexus: geringe Reichweite, ein direkter Caller, keine erkannten Prozesse.
- **Lokales Dependency-Setup:** Der vorhandene `yjs+13.6.31.patch` war in
  `node_modules` nicht angewendet. Das führte beim Dokumentöffnen zu
  `Unexpected content type` durch unterschiedliche ESM/CJS-Konstruktoren.
  Vorhandenes `npm run postinstall` ausgeführt; keine Collaboration-Codeänderung.
  `test:collaboration:production-modules` anschließend erfolgreich.
- **Dokument-Kaltstart:** Zwischen Tab-Hydration und asynchroner Dateiöffnung
  blieb die Standardansicht kurzzeitig auf Chat. Dadurch mountete der später
  unsichtbare Chat bereits seine Queries. Die Shell übernimmt die aufgelöste
  Dokumentansicht jetzt synchron mit der Hydration, auch beim Workspacewechsel.
  Der neue Browserfall war vor der Korrektur rot (unerwartet gemounteter
  Chat-Composer). Ein zusätzlicher Effekt-/Reducer-Test prüft explizite und
  wiederhergestellte Dokumente sowie weiterhin sichtbare angedockte Chats.
  GitNexus: geringe Reichweite, ein direkter Caller, keine erkannten Prozesse.

Bestehende Review-Testhelfer wurden an den absichtlich weiterhin sichtbaren,
aber gesperrten Übernehmen-Button neben „Erneut prüfen“ angepasst. Vor dem
Klick wird ausdrücklich der aktivierte Zustand verlangt. Verschwindet der
Refresh-Button während des Klickversuchs, akzeptiert der Helper das nur, wenn
„Übernehmen“ inzwischen tatsächlich aktiviert wurde. Damit prüft er auch den
erfolgreich abgeschlossenen Hintergrundabgleich, statt auf einen verschwundenen
Button zu warten. Screenshots warten auf das Ende von Öffnungsanimationen.

## Automatisierte Browserfälle

| Suite | Ergebnis | Abdeckung |
| --- | --- | --- |
| `notebook-query-loading.spec.ts` | 4 bestanden | Dokument ohne Chat-Abfragen; Bootstrap ohne History-Abhängigkeit; warmer Verlauf und späte Antwort nach Chatwechsel; Bootstrap-Retry |
| `home-agent-loading.spec.ts` | 2 bestanden | Gültiger und veralteter gespeicherter Workspace vor Agent-Abfragen |
| `home-loading.spec.ts` | 6 bestanden | 0/1/5 Dateien bei 390 und 1440 px; Skeletons und stabile Kartengeometrie |
| `editor-agent-review-lifecycle.spec.ts` | 4 bestanden | Verschobenes Ziel; verlorene Antwort; selektiver Revert; gelöschtes Ziel |
| `file-version-center-global.spec.ts` | 2 bestanden | Persönlicher/Team-Workspace und Dokument-Einstiege; mobile Geometrie |

Die Home-Skeleton-Suite wurde nach Anmeldefehlern bei dicht aufeinanderfolgenden
Logins mit elf Sekunden Abstand zwischen den einzelnen Fällen wiederholt;
alle sechs Fälle bestanden. Authentifizierung und Schutzmechanismen wurden
nicht abgeschaltet. Die neuen Query-Tests verwenden den vorhandenen gemeinsamen
Login-Helper. Initiale Dev-/Setup-Fehler und der vor der Korrektur rote
Dokumenttest zählen ausdrücklich nicht als erfolgreiche Abnahme.

Finaler Produktionsbuild, TypeScript, gezieltes ESLint, die zusätzlichen
PGlite-/Effekt-Regressionen und `test:collaboration:production-modules` sind
erfolgreich. Die Chat-Race-Tests nutzen echte Authentifizierung und Session-
Erstellung, verzögern beziehungsweise ersetzen aber gezielt Nachrichtenantworten.
Der interaktive Startseiten-Prompt oben wurde dagegen vollständig mit dem
echten Backend und Runtime-Versand geprüft.

**Abnahme: 18 unterschiedliche gezielte Playwright-Fälle erfolgreich.** Nach
dem letzten Testhelfer-Fix wurden dessen zwei betroffene Review-Fälle erneut
ausgeführt (beide erfolgreich); die übrigen vier Review-Fälle bestanden im
vorherigen finalen Produktionsdurchlauf. Das ist keine Ausführung der gesamten
repositoryweiten E2E-Suite.

Visuelle Evidenz wurde getrennt geprüft: Notebook/Desktop, Chat bei 390 px,
Review bei 1600/760/390 px einschließlich dunkler mobiler Ansicht. Finale
Query-Screenshots: `test-results/notebook-query-final/`; Review-Screenshots:
`test-results/notebook-review-final/`. Eigene Live-Chat-Session und Testdateien
wurden über die APIs entfernt; auch nach abgebrochenen Tests verbliebene eigene
Fixtures wurden gezielt bereinigt.
