# DA-03, erster Baustein: belegtes normales Entladen

Stand: 27. September 2026, aufbauend auf `48851c08d`.
Teil des [Distributed-Admission-Plans](distributed-admission-plan.md).
DA-03 insgesamt bleibt in Arbeit; keine Runtime-Aktivierung, keine
Lifecycle-Mutationsberechtigung und kein Abschluss von FVRC-1008 oder P12.

## Umsetzung und Grenzen

Der optionale Owner-Server führt normales Entladen durch einen eigenen
Abschlusskoordinator. Der installierte Hocuspocus-`beforeUnloadDocument`-Hook
bleibt abbrechbar. Erst nach dessen erfolgreichem Ende werden exakte Rauminstanz,
Verbindungen und Ruhezustand nochmals synchron geprüft und neue Aktivitäten
gesperrt. Ein abgebrochener Vorlauf erzeugt weder Receipt noch Token-Clear.

Das ist ausdrücklich kein Warten auf alle Aktivitäten aus jedem Aufrufer:
Ein Direct-Disconnect läuft selbst innerhalb einer Aktivität und hält dabei
Room-/Workspace-Locks. Normaler Unload beginnt deshalb ausschließlich im
bereits ruhenden Raum. Bei noch laufender Aktivität kehrt er zurück; nach
Freigabe der letzten Aktivität wird ein späterer Versuch eingeplant. So muss
kein Aufrufer auf seine eigene Freigabe warten.

Nach Schließen der Zulassung laufen der echte Store-Hook und seine Nachfolger
unter Room-/Save-Lock. Die fehlerunterdrückende Hocuspocus-Store-Hülle zählt
nicht als Nachweis. Der finale Snapshot wird einmal gebunden und mit dem
vorhandenen vollständigen Release-Receipt belegt. Erst dessen positive
Bestätigung erlaubt das Entfernen und Zerstören genau dieser Rauminstanz.
Der bereits freigegebene DA-02-Ticketpfad erhält keinen zweiten normalen Drain.

Eine verlorene Release-Antwort schließt zuerst die gemeinsame Owner-Sitzung.
Schlägt danach nur der Belegabruf fehl, darf derselbe Handle diesen lesenden
Abruf wiederholen. Release-ID, vollständige Update-/Vector-Bytes und gegebenenfalls
Admission-Ticket bleiben unveränderlich. Weder Store noch Release-SQL werden
dabei erneut ausgeführt. Fehlender Beleg, geänderte Identität oder nicht
bestätigtes Schließen erlauben kein Destroy. Andere Räume der verlorenen
Sitzung bleiben gesperrt; dieser Schritt bietet keinen automatischen Session-Neustart.

Ein tatsächlicher Persistenzfehler schließt weiterhin die Owner-Runtime.
Das ist kein lokal wiederholbarer erfolgreicher Store. Wiederholbare lokale
Hook-/Abschlussfehler und unbewiesene Datenbankfehler werden getrennt geprüft.

Nach positivem Receipt ist die Zerstörung eine eigene unumkehrbare Grenze.
`Y.Doc.destroy()` setzt `isDestroyed` bereits vor den Listenern. Ein danach
werfender Listener darf den bereits zerstörten Raum deshalb nicht dauerhaft
als gesperrt zurücklassen. Normales Entladen beendet seinen exakten Handle;
der DA-02-Pfad räumt zusätzlich nur das identische, von ihm gestartete
Hocuspocus-Unload-Promise auf. Vor der Zerstörung bleibt ein Fehler blockierend;
ein möglicherweise neu eingetragener Ersatzraum wird niemals gelöscht.
Diagnosen enthalten nur Dokument-ID, feste Phase und Fehlercode, keinen Inhalt.

## Verifikation

- Activity-Gate: **9/9**, Owner-Runtime: **15 Szenarien**. Leerlaufprüfung,
  einmaliger Idle-Hinweis, geschlossene Zulassung, parallele identische Retries,
  veränderte ID/Bytes/Tickets, fehlgeschlagenes Sitzungsschließen und weiterhin
  gesperrte Geschwisterräume sind abgedeckt.
- Abschlusskoordinator: **7 Szenarien** mit referenziertem Timeout gegen einen
  scheinbar grünen vorzeitigen Testprozess-Exit. Abbrechbarer Vorlauf, laufender
  Direct-Auftrag, spät hinzukommende Verbindung, lokaler Store-Hook-Fehler,
  lesender Receipt-Retry, erneuter Destroy-Versuch und Ersatzraum-Isolation.
- Tatsächlicher Hocuspocus-Server mit Testadaptern: Direct-Disconnect ohne
  Selbstblockade, finale Store-/Receipt-/Destroy-Reihenfolge, gesperrter später
  Create, automatischer lokaler Hook-Retry und automatischer Beleg-Retry nach
  Sitzungsschließen ohne zweiten Store/Release. Ein echter Destroy-Listener-
  und nachgelagerter Hook-Fehler im normalen Pfad beendet die Sperre einmalig;
  eine neue Instanz kann claimen, ein alter Unload-Retry berührt sie nicht.
  Im DA-02-Pfad zusätzlich
  Vorlaufabbruch, nachgelagerter Hook-Fehler und echter werfender Y.Doc-Listener:
  exaktes Promise-Cleanup, neue Owner-Inkarnation und keine doppelte Wirkung.
- Neues echtes PostgreSQL-Schema: normaler Receipt ohne Admission-Ticket,
  neue Runtime übernimmt dieselben gespeicherten Bytes unter Epoch + 1;
  verlorene erfolgreiche COMMIT-Antwort mit vorübergehend gescheitertem
  Receipt-Read und erfolgreichem rein lesenden Retry; abgewiesener COMMIT
  bleibt ohne Receipt gesperrt. Veränderte ID/Bytes lösen keinen Recovery-Read
  aus. Der Persistenzschreiber im Harness ist ein expliziter gefenceter
  SQL-Testadapter, kein vollständiger HTTP-/App-Prozesspfad.
- Bestehende echte PostgreSQL-Suites für Owner, Release und die zehn DA-02-
  Grenzen bleiben grün. Alle Läufe nutzen eigene UUID-Schemata und entfernen
  ausschließlich diese nach Schließen ihrer Verbindungen.
- Komplette Lifecycle-Suite, TypeScript, fokussiertes ESLint und
  Produktionsbuild bestehen. Keine Container wurden gebaut oder neu gestartet.

Der Startup-Server-Test musste den neuen Koordinator tatsächlich laden und
für den nun erforderlichen finalen Store einen passenden Persistenzadapter
bereitstellen. Sein rein testseitiges Activity-Drain-Probe leitet den
zurückgestellten Idle-Hinweis nach Ende des Probes weiter; sonst unterdrückte
der Test selbst den Abschluss. Die bestehenden Startup-Assertions bleiben
unverändert. Die ersten roten Harness-/Typprüfungen wurden damit korrigiert;
der vollständige erfolgreiche Wiederholungslauf ist maßgeblich.

Logs: `/tmp/fvrc1008-idle-activity.log`, `/tmp/fvrc1008-idle-runtime.log`,
`/tmp/fvrc1008-idle-release-postgres-final.log`,
`/tmp/fvrc1008-idle-admission-regression.log`,
`/tmp/fvrc1008-idle-release-regression.log`,
`/tmp/fvrc1008-idle-owner-regression.log`,
`/tmp/fvrc1008-idle-lifecycle-r3.log`, `/tmp/fvrc1008-idle-types-r3.log`,
`/tmp/fvrc1008-idle-lint-r3.log`, `/tmp/fvrc1008-idle-build-r3.log`.
Der letzte reine Testzusatz wurde anschließend separat erneut geprüft:
`/tmp/fvrc1008-idle-server-final.log`, `/tmp/fvrc1008-idle-types-final.log`,
`/tmp/fvrc1008-idle-server-lint-final.log`. Der erfolgreiche Produktbuild
erzeugte 353 Seiten; danach wurde kein Produktcode mehr geändert.

### Browser am aktuellen Host-Dev

Host-Dev nach dem Build frisch gestartet auf **Port 3000**, PID **80691**.
HTTP-, Datenbank- und Collaboration-Readiness wurden vor dem Browserlauf
positiv geprüft. Team-B/C besteht in **23,2 s**: C wird angenommen, B bleibt
als konkreter Konflikt offen, ohne Timeline-Fehler. Screenshot visuell geprüft.
Report: `/tmp/fvrc1008-idle-team-conflict-report/index.html`.

Team „10 → 3 einzeln → 7 gemeinsam“ besteht in **54,8 s**: exakter Endtext,
vier neue Inhaltsrevisionen, idempotente Wiederholungen und keine offenen
Reviews; Screenshot visuell geprüft.
Report: `/tmp/fvrc1008-idle-team-batch-report/index.html`.
Die beiden Fälle liefen seriell mit einem Worker und mindestens 55 Sekunden
Abstand nach bestätigtem Abschluss. Personal wurde in diesem Schritt nicht
erneut im Browser geprüft; dessen frühere Nachweise bleiben separat.

Der reguläre Browser-Server nutzt weiterhin keinen Owner-/Admission-Adapter.
Die Browserfälle sind Review-Regressionen, nicht ein bereits aktivierter
verteilter Übergabepfad. Der Container auf **3100** bleibt das ältere Image.
Keine Lizenz, Secrets oder Dependencies wurden verändert.

Lesender Check danach: **0 Owner-Epochen größer null, 0 Admission-Requests,
0 verbliebene Idle-Release-Testschema-Namespaces** im App-Bestand.

GitNexus vor Commit: **15 erwartete Dateien, 145 indexierte berührte Symbole,
0 zugeordnete Prozesse**, automatisch LOW; die vorherige symbolbezogene
Runtime-Analyse war MEDIUM mit acht direkten Abhängigkeiten. Der Gesamtbranch
gegen `main` bleibt CRITICAL mit 283 Dateien und 30 Prozessen. Das ist keine
Mergefreigabe. Der separate Read-only-Peerreview hat zwei Abschlusslücken
aufgedeckt, die korrigiert und mit tatsächlichen Hocuspocus-Dokumenten geprüft
wurden; im abschließenden Gegencheck blieb kein Blocker für diesen Baustein.

## Noch offen innerhalb DA-03

- Ein eigener Vacant-Proof für nie beanspruchte Epoch-0-Räume unter gehaltenem
  Guard und exakter gesperrter Zustandszeile.
- Die Coordinator-Zuordnung eines bereits normal freigegebenen Receipts zu
  einem späteren oder konkurrierend gestarteten Admission-Request. Der normale
  Receipt allein setzt kein reserviertes Target auf abgeschlossen.
- Vollständiger Wiederanlauf nach Owner-Absturz ohne Receipt, aus einer neuen
  Service-/App-Instanz, einschließlich tatsächlicher anschließender Weiterarbeit.
- Wiederaufnahme unbewiesener gebundener DA-02-Tickets und spätes lokales Finish
  über den gesamten Coordinator-Lebenszyklus, ohne neue Schreibrechte zu erteilen.

DA-04 bis DA-06, sämtliche Domain-Einstiegspunkte, Mixed-Version-Gate und
Mehrprozess-Crashtests bleiben nachgelagerte Schritte. Der Default-Server
bekommt weiterhin keinen Owner-/Admission-Adapter; die bestehenden
Lifecycle-Schutzprüfungen werden nicht gelockert.
