# FVRC-1007 – stabile Review-Einstiege und gruppierte Benachrichtigungen

Stand: 26. September 2026. Implementierung auf
`codex/review-conflict-resolution-20260925`, aufbauend auf FVRC-1006
(`1e6b297c62f4dfa668b2c166a791777dd4f9f538`). Dieses Dokument beschreibt
FVRC-1007, **keine Produktionsaktivierung und keinen Abschluss von FVRC-1008/P12**.

## Ergebnis

- Gespeicherte Chat-Widgets behalten ihre ursprüngliche Operation und
  Änderungsgruppe. Ein autorisierter Zusatz liefert aktuellen Lifecycle,
  Auswertung und höchstens 32 ausdrücklich wählbare direkte Nachfolger.
  Weitere Nachfolger werden kenntlich gemacht; es gibt keinen Sprung zum neuesten.
- Notifications gruppieren Voraussetzungen und Nachfahren sowie explizite
  Alternativen zu einer Aufgabe. Erledigte und durch geschlossene Voraussetzungen
  blockierte Zweige erzeugen keine neuen Annahmeaufforderungen. Legacy-Vorschläge
  bleiben kompatibel; Graph-Vorschläge erscheinen nicht zusätzlich als Legacy-Task.
- Ein Gruppenlink öffnet zuerst die Vorschlagsauswahl, ohne Schreibaktion.
  Editor und Dateimenü wählen bei mehreren Reviews ebenfalls nicht still den
  neuesten. Der Benutzer kann einen konkreten Vorschlag samt Voraussetzungen prüfen.
- Gelesen-/Ausblenden-Zustände beziehen sich auf die beobachtete Gruppenrevision.
  Home, Bell und Mobile reichen denselben Nachweis weiter. Automatisches Gelesen
  setzt eine frische autorisierte Timeline und passenden Graph-Kontext voraus;
  reine URL-Aufrufe, veraltete Antworten und Zugriffsverlust reichen nicht aus.
- Alte Links bleiben exakt. Geschlossene Einzelvorschläge zeigen ihren
  historischen Lifecycle, keine irreführende Dependency-Blockierung und keine
  Annahme-, Ablehnungs- oder Transformationsbuttons. Diagnose bleibt aufklappbar.
- Die Umsetzung nutzt den bestehenden Query-/Review-Service und dieselbe
  Autorisierung. Keine zweite Merge-Engine, keine neuen Dependencies und keine
  gelockerten Rate-Limits.

## Echte Browsernachweise

Getestet wurde **Port 3000 im angegebenen Implementierungs-Worktree**, mit dem
einzigen verwalteten Team-Seat-Stack und PostgreSQL auf 55433. Der vorhandene
Container auf 3100 ist nicht der Nachweis dieses Codes. Kein Container wurde
neu gebaut oder gestartet. Ein Browser-Worker, getrennte Läufe mit Abstand,
eigene UUID-Dokumente und eigene Test-Chats; Cleanup über die echten APIs.

Die Graph-Fixtures sind deterministische, lokale Testdaten. Der Chat-Test legt
seine Session über die echte authentifizierte API an und speichert anschließend
einen vertragskonformen Tool-Result-Fixture. Widget-Zugriff, aktuelle Projektion,
Review, Annahme und Reload laufen über die echte App. Dies ist **kein Nachweis
eines gewöhnlichen LLM-Tool-Laufs**; dessen Aktivierungstest gehört zu FVRC-1008.

| Fall | Geprüftes Ergebnis | Lokaler Report |
|---|---|---|
| Chat → ursprünglicher Vorschlag → expliziter B2-Nachfolger | Exakte IDs; A wird mit B2 enthalten; Bytes `A1\|B2`; Refresh/Reload zeigt Included; historischer Link bleibt readonly und ohne Block-Warnung | `/tmp/fvrc1007-widget-r7-report`, 18,8 s |
| Home und Bell → gruppierter Zweig | Genau ein Eintrag für A/B1/B2; drei explizite Optionen; kein Apply; aktuelle Revision im Gelesen-PATCH; Reload markiert nicht erneut gelesen | `/tmp/fvrc1007-notifications-r3-report`, 13,7 s |
| Mobile-Vertrag und 320-px-Ansicht | Default ohne Capability blendet Datei-Tasks aus; Opt-in enthält denselben Zweig; veralteter Gelesen-Nachweis 404, gültiger Nachweis akzeptiert; kein horizontaler Überlauf | gleicher Notification-Report |
| Editor-Agent-Button und Dateibaum-Menü | Keine automatische Auswahl bei mehreren Vorschlägen; explizites B1/B2 zeigt exakt dessen Diff/URL; null Apply-POSTs, unveränderte Bytes und Revisionenzahl | `/tmp/fvrc1007-editor-entry-r2-report`, 9,5 s |
| Ersetzter historischer B-Link | Nach Replace und Reload weiterhin ursprüngliche ID und Superseded; keine Mutation oder falsche Blockierung; erst separate Annahme des Nachfolgers ändert Inhalt/Revision | `/tmp/fvrc1007-replace-r1-report`, 19,6 s |
| Abgelehnter Zweig und alter Kind-Link | Parent und beide Kinder geschlossen, null Inhaltsrevisionen; alter Kind-Link nach Reload weiterhin exakt Rejected und ohne Schreibaktion/Block-Warnung | `/tmp/fvrc1007-reject-r1-report`, 8,9 s |
| Navigation bei ausstehender Antwort | Workspace-/Dateiwechsel übernimmt keine verspätete alte Review-Antwort | `/tmp/fvrc1007-navigation-r1-report`, 10,1 s |
| Rechteänderung | Schreibrechtsverlust sperrt Mutation; Leserechtsverlust entfernt geschützten Kontext | `/tmp/fvrc1007-permissions-r1-report`, 9,6 s |
| Parent-Annahme und Peer-Edit | Ausgewähltes Kind behält Fokus und Restdiff; parallele Bearbeitung sperrt alte Freigabe | `/tmp/fvrc1007-peer-sequence-r1-report`, 14,1 s |
| Responsive Review | Desktop, Tablet, Mobile, DE/EN, Light/Dark und Tastaturbedienung | `/tmp/fvrc1007-responsive-r1-report`, 9,9 s |
| Verlorene Apply-Antwort | Status-Recovery nach Schließen/Wiederöffnen ohne zweite Anwendung | `/tmp/fvrc1007-recovery-r1-report`, 8,0 s |
| Angenommener Parent mit offenen Kindern | Notification-ID und A-Anker bleiben stabil, Gruppenrevision ändert sich; A historisch und B1/B2 offen auswählbar; explizites B2 zeigt nur Restdiff, keine zusätzliche Revision | `/tmp/fvrc1007-closed-anchor-r2-report`, 9,1 s |

Die erfolgreichen Läufe prüfen auf unerwartete 500/429 an den Proposal-Endpunkten.
Der zusätzliche Notification-Client-Mitschnitt enthält keine ungefangenen
Browserfehler; zwei bereits vorhandene Meldungen über abgebrochene, überholte
Chat-History-Abfragen sind separat erfasst. Die Screenshots enthalten deshalb
teilweise den lokalen Next-Dev-Indikator, nicht einen Review-Fehler.

Visuell geprüft: [Widget-Nachfolgerauswahl](./chat-successor-choice.png),
[historisches Included](./historical-included-proposal.png),
[Zweigauswahl Desktop](./branch-overview-desktop.png) und
[Zweigauswahl 320 px](./branch-overview-mobile320.png) sowie
[angenommener Parent mit offenen Kindern](./applied-parent-open-children.png).

## Automatisierte Regression

- `test:proposal-graph:entrypoints` (`/tmp/fvrc1007-entrypoints-r4.log`): strikte Deep-Link-/Widget-Verträge,
  Operation-ID-Bindung, Graph-Revision-Wechsel, Scope/Rechte, Lifecycle-Anzeigen,
  32-Nachfolger-Grenze, Parser und UI-Aktionen; Notification-PGlite mit mehr als
  200 Knoten, unabhängigen Choice-Roots, blockierten/geschlossenen Vorfahren,
  Revisionen sowie Home/Bell/Mobile-Kompatibilität.
- Der Host-Komponententest kontrolliert frische Resolve- und Graph-Antworten:
  kein Vorab-Ack aus Cache, kein Ack nach Entzug/Workspace-Wechsel/Schließen,
  keine Autorität allein aus einer URL. Ein fehlgeschlagener Notification-PATCH
  erzeugt keinen Retry-Loop und keinen Apply; explizites Wiederöffnen lädt frisch
  und wiederholt nur die exakte Gelesen-Markierung.
- `test:proposal-graph:review-actions`, `orchestrator`, `review-summary` und
  `test:file-version-center:hardening` bestanden. Enthalten sind auch bestehende
  Legacy-Aktionen, Restore-/Rechteprüfungen, Recovery und Widget-Verträge.
- `test:tool-apps` bestand; nur das bestehende Widget wurde erweitert.
- `proposal-review-context-test.ts`: 8/8 grün, einschließlich angenommenem
  exaktem Parent-Anker mit beiden offenen Kindern und unverändertem Snapshot
  bei bloßer Auswahl (`/tmp/fvrc1007-closed-anchor-unit.log`).
- `npm run build` bestand erneut nach der historischen Statuskorrektur
  (`/tmp/fvrc1007-build-r2.log`). Danach bestanden `tsc --noEmit` und
  `test:collaboration:production-modules` (`/tmp/fvrc1007-production-modules-r2.log`).
  Der finale vollständige Lint-Lauf (`/tmp/fvrc1007-lint-r3.log`) hat null Fehler
  und sieben bestehende Warnungen außerhalb dieses Umfangs.
  Die danach ergänzten Testfälle bestanden ebenfalls Typecheck und gezielten Lint.

## Grenzen und nachfolgende Gates

- Die vollständige Operation-Pool-Suite ist **nicht vollständig grün**: Der
  Test `ten actual direct pure deletions keep pool capacity during grant and durable-receipt waits`
  schlägt auch unverändert auf dem Vorgänger-Commit
  fehl. Der neue Lifecycle-Listentest besteht. Der Baseline-Fehler muss in
  FVRC-1008 untersucht werden und wird hier nicht als bestanden umetikettiert.
  Erneuter Einzeltest: `/tmp/fvrc1007-pure-deletions-known-failure.log`
  (`durability === 'persisted_yjs'` nicht für alle Ergebnisse erfüllt);
  gezielter grüner Listing-Test: `/tmp/fvrc1007-operation-list-r1.log`.
  Nachtrag FVRC-1008: als unvollständiger Testaufbau identifiziert und mit
  unveränderter Erfolgsassertion plus negativem History-Capture-Test korrigiert;
  siehe [Härtungszwischenstand](../fvrc-1008/hardening-progress.md).
- Die komplette 46-Fälle-Matrix inklusive gewöhnlicher Agententools,
  Rollout-/Rollback-Ringe, zusätzliche große paginierte Einstiegskombinationen
  und Betriebsmetriken bleibt FVRC-1008. Der freie PR-artige Konflikteditor ist
  weiterhin P12. Native Screenreader- oder Produktionsprüfungen werden nicht behauptet.
- Frühere rote Browserläufe waren Test-Harness-Fehler (fehlende `changeGroup`
  im gespeicherten Tool-Ergebnis und falsche sichtbare Button-Namen). Ein dabei
  zeitüberschrittenes eigenes Test-Dokument samt Test-Chat wurde anhand seiner
  exakten ID und erwarteten Bytes über die App-API entfernt. Keine Nutzerdaten
  wurden dafür gelöscht. Die Sichtprüfung fand zusätzlich den echten
  historischen Statusfehler; dieser wurde vor dem abschließenden Chat-Lauf behoben.
  Der zusätzliche Closed-Parent-Browsertest hatte zunächst nur einen falschen
  erwarteten Button-Text; der korrigierte Wiederholungslauf bestand vollständig.
- Keine Datenmigration, kein Push, keine Produktionsfreischaltung. Fremde
  GitNexus-Zähleränderungen in `AGENTS.md`/`CLAUDE.md` bleiben außerhalb des Commits.

## Änderungsumfang

GitNexus wurde für den gestagten Umfang und zusätzlich gegen das lokale `main`
ausgeführt. Der fokussierte Umfang liegt bei niedrigem gemeldetem Risiko;
neue, noch nicht indexierte UI-Symbole wurden zusätzlich über Aufrufstellen und
Tests geprüft. Der Gesamtvergleich mit dem älteren lokalen `main` meldet hohes
Risiko und umfasst auch vorherige Commits außerhalb FVRC-1007. Diese Prüfung ist
keine Freigabe für Merge, Push oder Produktionsaktivierung.
