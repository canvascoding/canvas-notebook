# Hermes Compaction Parity Refresh

Stand: 2026-09-22

Referenz: `NousResearch/hermes-agent` Commit
`e2f8a0731bf26e95b31e35d73e71e183a1045b81` (MIT).

## Ziel

Canvas soll die aktuelle Hermes-Compaction-Semantik fuer variable
Modellfenster uebernehmen und die bisherige Canvas-Mischform aus
`legacy`-Tail und seriellen Lean-Digests abloesen. Produktionsziele sind:

- genau ein Summary-LLM-Aufruf pro Compaction-Versuch;
- explizit waehlbare Modi `legacy` und `lean`;
- ein schnelles, separates Compression-Modell mit sicherem Main-Model-Fallback;
- ein gemeinsamer Budget-Snapshot fuer Trigger, Candidate, UI und Logs;
- atomarer Commit ohne History-Verlust bei Timeout, Abbruch oder Konkurrenz;
- unveraenderte, durchsuchbare Rohhistorie als Recovery-Quelle;
- sofortiger Rueckfall auf `legacy` ohne Datenmigration.

## Upstream-Aenderung

Die bisherige Canvas-V2-Implementierung basiert auf Hermes
`f293e7206b4ddd66042329442c6afebc19a8808d`. Aktuelles Hermes erzeugt keine
separaten Chunk-Digests mehr. Sowohl `legacy` als auch `lean` verwenden einen
einzigen, bounded Summary-Aufruf. Lean ergaenzt dessen Eingabe und Ergebnis
deterministisch um Anchor-Index, reale Nutzernachrichten und Recovery-Hinweise
auf `session_search` und die erhaltene Session-Historie. Alte grosse
Tool-Ergebnisse im aktiven Tail werden zu kurzen Recovery-Stubs.

Die alte Canvas-Strategie mit mehreren seriellen Digest-Aufrufen ist damit
weder aktuelle Hermes-Paritaet noch fuer Produktionslatenz akzeptabel.

## Konfigurationsvertrag

Eine einzige validierte Policy wird fuer Live-Chat und Automationen aufgeloest.
Prioritaet:

1. Deployment-Override;
2. persistierte Admin-Einstellung;
3. getesteter Produktdefault.

Neue Deployment-Schalter:

- `CANVAS_PI_COMPACTION_TAIL_MODE=legacy|lean`
- `CANVAS_PI_COMPACTION_SUMMARY_MODEL=<providerInstallationId/modelId>`

Der Environment-Override ist ein Betriebs- und Rollbackmechanismus. Die
persistierte Einstellung wird organisationsbezogen und revisionsgesichert in
`ai_organization_compaction_settings` gepflegt; die globale
`pi-runtime-config.json` ist nur ein Legacy-/Bootstrap-Fallback fuer
Organisationen ohne eigene Einstellung. Secrets bleiben in der
Integrationsverwaltung und duerfen weder in dieser Einstellung noch in
Telemetrie gespeichert werden.

`summaryModel` ist immer die exakte Katalogreferenz
`providerInstallationId/modelId` (der Modellteil darf weitere `/` enthalten).
Beim Speichern wird sie gegen einen aktivierten, erfolgreichen Provider und
ein aktiviertes Modell aus dem aktuellen Katalog geprueft. Wird eine vorher
gueltige Referenz spaeter stale, deaktiviert oder nicht mehr aufloesbar, ist
dies kein Compaction-Fehler: der Lauf faellt sicher auf das gepinnte
Hauptmodell zurueck. Ein aktiver Environment-Override wird im Settings-Bereich
mit seiner Quelle angezeigt und sperrt nur das betreffende persistierte Feld.
Der echte Chat-Runtime-Status zeigt nur eine vom Runtime-Resolver bestaetigte
Identitaet; eine stale oder nicht verfuegbare rohe Referenz wird nie an Clients
serialisiert.

## Modussemantik

### Legacy

- geschuetzter Head wie bisher;
- verbatim Tail: `target_ratio * trigger`, standardmaessig 20 Prozent;
- alte Tool-Ergebnisse werden deterministisch und idempotent gekuerzt;
- Summary-Eingabe bleibt bounded und bewahrt Anfang sowie juengstes Ende;
- genau ein Summary-Aufruf;
- keine Chunk-Digest-Aufrufe.

### Lean

- Tail-Ziel: `max(10k, min(25k, 2.5% * context_window))`;
- zusaetzlicher harter Tail-Deckel von 20 Prozent des Kontextfensters;
- letzte echte User-Anfrage und kohaerente Tool-Gruppen bleiben erhalten;
- alte grosse Tool-Ergebnisse im Tail werden zu Recovery-Stubs;
- Anchor-Index, begrenzte wortgetreue User-Nachrichten und Recovery-Footer
  werden deterministisch erzeugt;
- Rohhistorie bleibt persistent und autorisiert durchsuchbar;
- genau ein Summary-Aufruf.

## Trigger und Budget

Canvas behaelt die Hermes-Regeln fuer variable Modellfenster:

- effektives Fenster: `context_window - output_reserve`;
- Standardratio 50 Prozent;
- bei Fenstern unter 512k raise-only Floor von 75 Prozent;
- Minimum 64k;
- 85-Prozent-Ausweichregel, wenn das Minimum den Trigger unerreichbar macht;
- laengster passender Modell-Override gewinnt;
- optionaler absoluter Token-Cap.

Ein unveraenderlicher Request-Budget-Snapshot ist die einzige Quelle fuer
Preflight-Entscheidung, Candidate-Komposition, Runtime-Status, UI und Logs.
System-/Developer-Prompt, Tool-Schemas, Medien, Provider-Overhead, Output- und
Safety-Reserve muessen darin einmalig und nachvollziehbar ausgewiesen werden.

## Summary-Modell und Fehlerpfad

- Das konfigurierte Compression-Modell wird bevorzugt.
- Es muss das bounded Summary-Prompt sicher aufnehmen koennen.
- Ein separates Summary-Modell erhaelt nach Fehler genau einen direkten
  Fallback-Versuch mit dem Hauptmodell.
- Leere, reine Refusal- oder laengenabgebrochene Antworten gelten als Fehler.
- Der Summary-Aufruf setzt keinen harten `max_tokens`-Wert, der Reasoning-Modelle
  vor dem sichtbaren Ergebnis abschneiden koennte.
- Idle-/No-progress- und Gesamtzeitlimits werden getrennt klassifiziert.
- Timeout-Cooldowns steigen persistiert an und verhindern Retry-Schleifen.
- Nach ausgeschoepften Modellpfaden darf nur ein explizit markierter,
  deterministischer Fallback verwendet werden; nie wird ein fehlgeschlagener
  LLM-Lauf als semantisch erfolgreiche Summary committed.

## Persistenz und Concurrency

- Compaction bleibt in-place: alte Zeilen werden nicht geloescht und bleiben
  als compacted History suchbar.
- Lease, Watermark und Commit-Fence schuetzen vor veralteten Workern.
- Vor dem Commit werden Schrumpfung, Sendbarkeit, User-Anker, Tool-Gruppen und
  Summary-Vertrag validiert.
- Bei Timeout, Abbruch, Session-Wechsel oder neuerem Context-Stand bleibt der
  aktive Verlauf unveraendert.

## Umsetzungspakete

### SC-P10: Referenz und Policy-Vertrag

- Hermes-Referenz und MIT-Inventar auf `e2f8a073...` aktualisieren.
- zentrale Settings-/Env-Aufloesung einfuehren;
- gemeinsamen Budget-Snapshot fuer alle Laufzeitpfade definieren;
- alte und neue Konfiguration regressionssicher validieren.

Gate: Live und Automationen erhalten bytegleich dieselbe effektive Policy;
Trigger, Status und Logs melden denselben Snapshot.

### SC-P11: Ein-Aufruf-Summary-Paritaet

- serielle Digest-Aufrufe entfernen;
- aktuelle Hermes-Sampling-/Bounding-Regeln portieren;
- leere, Refusal- und Length-Ergebnisse fail-closed behandeln;
- separates Summary-Modell samt genau einem Main-Model-Fallback anbinden.

Gate: Jeder normale Versuch hat genau einen erfolgreichen Summary-Aufruf; ein
Fallback-Versuch ist separat sichtbar und niemals doppelt committed.

### SC-P12: Vollstaendige Legacy-/Lean-Semantik

- Legacy-Tail und Lean-Tail exakt trennen;
- Lean Anchor, User-Verbatim, Tool-Stubs und Recovery-Footer portieren;
- Rohhistorie und autorisierte Suche nach mehreren Compaction-Zyklen pruefen;
- Tail-Hard-Cap und uebergrosse aktive Turns abdecken.

Gate: Legacy und Lean bestehen dieselben User-, Tool- und Recovery-Invarianten;
Lean erreicht das kleinere Ziel ohne Informationsverlust im persistenten
Verlauf.

### SC-P13: Runtime-Settings und Bedienung

- Admin-Setting fuer Modus und Summary-Modell;
- Environment-Override inklusive sichtbarer Herkunft;
- effektiven Modus, Modell, Trigger und Tail-Ziel im Runtime-Status anzeigen;
- laufende Sessions uebernehmen die neue Policy nur an sicheren
  Request-Grenzen.

Der Settings-Status zeigt effektiven Modus, Modellpfad und die jeweilige
Herkunft. Die Budget-Vorschau basiert auf dem App-Standardmodell; die
Kontextanzeige im Chat bleibt fuer jede Anfrage autoritativ, weil sie
Systemprompt, Tools, Medien und Outputreserve einbezieht.

Gate: Einstellung, Override, Neustart und Legacy-Rollback sind API-, Contract-
und nach Freigabe UI-getestet.

Status: abgeschlossen. Die organisationsbezogene, revisionsgesicherte
Einstellung übernimmt beim ersten Speichern sichere Legacy-Fallbackwerte,
bewahrt eine explizite Hauptmodell-Entscheidung und wird an der nächsten
inaktiven Request-Grenze neu gebunden. API-/Berechtigungs-/Konflikttests,
Live-Runtime-Integration und Browserprüfungen in Desktop-, kompakter Desktop-
und Mobile-Breite sind grün.

### SC-P14: Produktionshaertung und Rollout

- content-freie Stage-, Modell-, Token- und Laufzeittelemetrie;
- Fehlerklassifikation, Cooldown, Anti-Thrash und spaete Worker testen;
- Legacy und Lean mit toolreichen 256k-, kleinen und grossen Fenstern messen;
- `npm run build`, TypeScript, ESLint, gezielte Integrationstests und nach
  Freigabe Playwright abschliessen;
- Canary zuerst mit explizitem Legacy-Rollback, danach Lean aktivieren.

Gate: keine History-Verluste, keine Compaction-Schleifen, konsistente Anzeige
und eine materiell niedrigere p95-Latenz als der bisherige serielle
Digest-Pfad.

## Rollback

`CANVAS_PI_COMPACTION_TAIL_MODE=legacy` schaltet nur die Tail- und
Summary-Komposition um. Persistierte V2-/Lean-Summaries bleiben gueltige
Reference-Only-Handoffs; keine Datenbankmigration wird zurueckgerollt und keine
Rohhistorie geloescht. Der bestehende Summary-Rollout-Schalter bleibt ein
separater Notfallpfad.

## Definition of Done

Die Paritaetsrunde ist abgeschlossen, wenn:

1. aktuelle Hermes-Invarianten und bewusste Canvas-Abweichungen dokumentiert
   und MIT-konform inventarisiert sind;
2. Legacy und Lean explizit waehlbar sind;
3. ein normaler Compaction-Lauf genau einen Summary-LLM-Aufruf benoetigt;
4. das schnelle Summary-Modell sicher auf das Hauptmodell zurueckfallen kann;
5. alle Request-Pfade denselben Trigger-Snapshot verwenden;
6. letzte User-Intention, aktuelle Tool-Kette und Recovery erhalten bleiben;
7. Fehler, Timeout und Konkurrenz keine History oder Summary-Grenze
   veraendern;
8. der bisherige Drei-Minuten-Mehrfach-Digest-Pfad nicht mehr erreichbar ist;
9. Build und alle relevanten Compaction-, Runtime-, Automation-, Persistenz-
   und freigegebenen UI-Tests erfolgreich sind.
