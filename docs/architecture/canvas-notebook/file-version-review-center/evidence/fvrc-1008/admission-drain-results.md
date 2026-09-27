# DA-02: gebundener Owner-Drain und atomare Bestätigung

Stand: 27. September 2026, aufbauend auf `6bc4b613b`.
Teil des [Distributed-Admission-Plans](distributed-admission-plan.md).
Keine Aktivierung im Default-Server, keine Lifecycle-Mutationsberechtigung
und kein Abschluss von FVRC-1008 oder P12.

## Implementierung

`startDrain` bindet den dauerhaften Request an sein unveränderliches Target:
Dokumentidentität, Workspace/Organisation, Pfad, Repräsentation, Generation,
Schema sowie Owner-Epoch, Token und PostgreSQL-Backend-Inkarnation.
Request und Target wechseln unter Header-/Target-Zeilensperren gemeinsam in
`draining`. Ein wiederholter identischer Auftrag liefert dasselbe eingefrorene
Ticket und dieselbe deterministische Release-ID, ohne einen zweiten Auftrag.
Ein noch nicht gestarteter Cancel kann den Übergang nicht rückgängig machen.

Die Release-Transaktion sperrt Header → Target → Dokumentzustand. Sie prüft
den gesamten Ticket-Snapshot und den weiterhin gültigen Owner-Fence, belegt
die kausal vollständig gespeicherten Yjs-Bytes, löscht ausschließlich den
exakten Owner-Token und setzt das Target samt Receipt-Verweis auf `released`.
Alle Schritte werden gemeinsam committed. Der Fremdschlüssel hält den
referenzierten Receipt fest; ein Fehler bestätigt keinen Teil-Release.
Das Target bleibt aktiv und die Pfadreservation bleibt bestehen.

Bei verlorener Commit-Antwort wird zuerst die unsichere Verbindung beendet.
Danach werden Ticket, Target-Ack, Receipt und gespeicherter Snapshot gemeinsam
über eine neue Verbindung geprüft. Ein positives Target allein ersetzt nicht
den vollständigen Release-Nachweis. Fehlender Beleg bleibt ein Recoveryfall.

Die optionale Runtime pollt die dauerhaften Aufträge für ihre exakten lokalen
Owner-Inkarnationen. Ein Wake-Hinweis löst nur eine erneute Abfrage aus; er ist
selbst keine Autorisierung. Polls sind seriell, doppelte Tickets werden
zusammengefasst, Fehler werden beim nächsten Poll erneut geprüft. Ein Neustart
des Pollers löscht oder verändert keine Aufträge.

Vor lokalem Drain wird das Ticket nochmals dauerhaft geprüft. Derselbe Auftrag
verwendet denselben lokalen Drain-Handle; eine andere oder verspätete Inkarnation
darf keinen Ersatzraum schließen. Zugelassene Startup-/Direct-/Peer-/Reader-
Aktivitäten laufen vor dem finalen Store aus. Nach positivem Release bleibt
der alte Handle bis zum tatsächlichen lokalen Destroy erhalten, damit ein
fehlgeschlagener Unload ohne zweiten Store/Release abgeschlossen werden kann.

## Verifikation

- Sieben reine Ticket-Vertragstests: kanonische unveränderliche Identität,
  deterministische Release-ID, sämtliche Owner-/Scope-Abweichungen und
  Ablehnung von archivierten oder nicht besessenen Targets.
- Zehn echte PostgreSQL-Grenzen: atomarer Receipt/Token/Target-Abschluss,
  gebundene Retries, falsche Identität, Cancel nach Start, verlorene Start- und
  Release-COMMIT-Antwort, vollständiger Rollback bei injiziertem Ack-Fehler,
  Polling aus neuer Serviceinstanz, FK-gepinnter Receipt und zwei Targets mit
  gemischten Phasen. Revisionen 1 → 2 → 3 → 4 → 5 belegen getrennte Starts
  und Releases; ein idempotenter Retry erhöht die Revision nicht.
- Die bestehenden echten PostgreSQL-Suites für Owner, Release und DA-01
  bestehen unverändert. Jeder Lauf verwendet ein eigenes UUID-Schema und
  entfernt es nach Schließen seiner Verbindungen; keine App-Daten werden verändert.

- Runtime: 13 Szenarien; Poller: zwei Szenarien mit tatsächlichem Abschluss
  (referenzierter Test-Timeout verhindert einen scheinbar grünen vorzeitigen Exit).
- Tatsächlicher Hocuspocus-Serverpfad mit Testadaptern: Preflight-Fehler vor
  Quieszenz erfolgreich wiederholbar; positiver Release mit Unload-Fehler
  wiederaufnehmbar; späte/falsche Epoch und abgeschlossene doppelte Tickets
  berühren keinen Ersatzraum. Ein bloßer Target-Status `released` beendet keinen
  lokal unbewiesenen, quarantinierten Handle. Bestehende Startup-/Direct-/Peer-
  Store-/Unload-Grenzen bleiben grün.
- Komplette Lifecycle-Suite grün; abschließender Serverlauf zusätzlich nach den
  letzten Testergänzungen. TypeScript, fokussiertes ESLint und Produktionsbuild
  bestehen. Keine Container wurden gebaut oder neu gestartet.

Logs: `/tmp/fvrc1008-drain-postgres-final.log`,
`/tmp/fvrc1008-drain-owner-regression.log`,
`/tmp/fvrc1008-drain-release-regression.log`,
`/tmp/fvrc1008-drain-admission-regression.log`.
Weitere Logs: `/tmp/fvrc1008-drain-lifecycle.log`,
`/tmp/fvrc1008-drain-server-final.log`, `/tmp/fvrc1008-drain-types-final.log`,
`/tmp/fvrc1008-drain-lint-final.log`, `/tmp/fvrc1008-drain-build.log`.
Die PostgreSQL-Tests verwenden echte separate Backend-Verbindungen und Yjs-Bytes,
aber noch keine zwei App-/OS-Prozesse.

GitNexus vor dem Commit: 18 erwartete Dateien, 135 indexierte berührte Symbole,
0 zugeordnete Prozesse, automatisch LOW. Die symbolbezogenen Owner-Session-
und Runtime-Analysen waren MEDIUM (12 beziehungsweise 8 direkte Abhängigkeiten).
Der gesamte Branch gegen `main` bleibt CRITICAL mit 279 Dateien und 30 Prozessen;
kein Gesamtbranch- oder Merge-Gate ist damit erfüllt. Ein separater Read-only-
Peerreview fand keinen Blocker in Lockordnung, Bindung oder Commit-Recovery.

### Browser am aktuellen Host-Dev

Der Host-Dev wurde nach dem Build mit dem neuen Code neu gestartet, Port 3000,
PID 58161. Vor dem Browserlauf wurde HTTP-/DB-/Collaboration-Readiness positiv
geprüft. Team-B/C besteht in **23,6 s**: C wird angewendet, B bleibt als konkreter
Konflikt offen, ohne Timeline-Fehler; Screenshot visuell geprüft.
Report: `/tmp/fvrc1008-drain-team-conflict-report/index.html`.

Team „10 → 3 einzeln → 7 gemeinsam“ besteht ebenfalls, **57,1 s**. Exakter
Endtext, vier neue Inhaltsrevisionen, idempotente Wiederholungen und keine
offenen Reviews; Ergebnisscreenshot visuell geprüft. Report:
`/tmp/fvrc1008-drain-team-batch-report/index.html`. Beide Browserfälle seriell
mit einem Worker und mindestens 55 Sekunden Abstand nach bestätigtem Abschluss.
Personal-Browserfälle wurden in DA-01 separat geprüft, in diesem Schritt nicht
nochmals ausgeführt.

Lesender Check des App-Bestands nach beiden Browserfällen: **0 Owner-Epochen größer null, 0 Admission-
Requests, 0 verbliebene DA-01/DA-02-Testschemata**. Die Browserfälle laufen ohne
aktivierten Owner-/Admission-Adapter und prüfen die reguläre Review-Regression,
nicht einen bereits produktiv aktivierten verteilten Übergabepfad. Port 3100
enthält weiterhin das ältere Container-Image. Lizenz, Secrets und Dependencies
wurden nicht verändert.

## Aktivierungsgrenzen

Ein fehlgeschlagener Store mit anschließend unbewiesenem Release bleibt
quarantiniert. Sessionverlust ohne vollständigen Receipt-Nachweis ist kein
sicher wiederholbarer lokaler Fehler. Der Recoverypfad dafür gehört zu DA-03;
die erfolgreiche Wiederholung des lokalen Unloads ersetzt ihn nicht.

DA-03 behandelt außerdem normalen Unload vor einer Reservation, Vacancy und
Owner-Abstürze. DA-04 muss bei terminalem Request weiterhin den rein lokalen
Finish eines bereits positiv bewiesenen alten Releases ermöglichen, ohne einen
neuen Drain oder Schreibrechte zu erteilen. Sonst könnte ein verspäteter Unload
nach dem Coordinator-Commit aus dem Polling verschwinden.

DA-04 bis DA-06, sämtliche neuen Dokument-/Agentenzulassungen, Domain-Aufrufer,
Mixed-Version-Gate, Mehrprozess-Crashtests und atomarer Kandidatencommit vor
Live-Publish bleiben offen. Keine vorhandene Lifecycle-Schutzprüfung wird
gelockert. Der normale Server erhält weiterhin keinen Owner-/Admission-Adapter.
