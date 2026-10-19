# Gewöhnliche Projektion respektiert dauerhafte Dateiaktionsreservationen

Stand: 19. Oktober 2026. Grundlage ist Root `bd76d7b438a476e288cc735907105815ee152e23`. Der zusätzliche Fence schließt eine Voraussetzung für den laufenden Live-Editor-Anschluss; der vollständige Move-/Delete-Anschluss und die neue Browserabnahme sind weiterhin offen.

## Verhalten

Der gewöhnliche Projektionsguard prüft jetzt die tatsächliche Admission für die feste Workspace-/Pfad-/Dokumentidentität. Die Prüfung läuft unter dem bereits gehaltenen Kernel- und echten gemeinsamen PostgreSQL-Sessionlock vor dem Veröffentlichungscallback sowie bei jeder bestehenden Wiederprüfung. Diese bestehende Lebensdauer umfasst physische Datei, Checkpoint, Registry-Version und Abschluss der Projektionsreceipt.

Eine aktive dauerhafte Reservation bleibt damit auch nach dem kurzen P0-COMMIT wirksam, bevor ein B1-Move-/Delete-Intent existiert. Nur der echte `CollaborationAdmissionError` mit genau `ADMISSION_CONFLICT` wird zum bestehenden retryfähigen `CollaborationFileOperationProjectionPendingError`. Unbekannte SQL-Fehler, ähnlich benannte Objekte und andere Admissionfehler bleiben erhalten. Die vorhandenen Scopeprädikate lassen unbeteiligte Dokumente und bloße Pfadpräfixe weiterhin zu.

Es gibt keinen eigenen Reservationsbypass. Die bisherige Prüfung alter Intents, I04-Erstprojektion, Checkpoint-DAL und Materializer bleiben unverändert. Die neue Prüfung gewährt weder Claim noch Mutation oder aktuelle Rechte.

## Tatsächliche Prüfung

Private Originale: `/private/tmp/canvas-native-path-admission-8gusy9ys/`.

- Mit ausschließlich den neuen Testquellen und unverändertem Produktguard endet der reine 16er-Lauf tatsächlich mit Exit 1 bei 8/16. Die neuen Reservierungs-/Fehlerprüfungen weisen die fehlende Produktprüfung nach. Die SQL-/Kernelmechanik dieser Harness ist ausdrücklich gemockt.
- Der echte PG18-RED-Lauf besteht zunächst die unreservierte Shared-Lock-/Projektionskontrolle und scheitert dann genau am fehlenden Callbackverbot bei dauerhafter Reservation ohne B1-Intents. Er endet mit ursprünglichem Exit 1; Fixture und Bundleverzeichnis sind zuvor bestätigt bereinigt. Dieses Ergebnis bleibt fehlgeschlagen erhalten.
- Mit dem eingefrorenen Produktpatch bestehen alle 16 reinen Fälle und sechs tatsächliche PG18-Familien mit Exit 0. Der echte Lauf verwendet authentifizierte native Uploads, ursprünglichen Guard und Materializer, echte Reservation, Cancel, Quiescence und einen echten No-write-Abort mit dauerhaft gelesenem Outcome. Er prüft unveränderte Domainzeilen einschließlich `xmin` und beide Workspace-Dateibäume bei abgelehnter Projektion, exakten beziehungsweise Subtree-Scope, Freigabe und erneute echte Projektion.
- Das PG-GREEN endet nach 26,831 Sekunden. Gezieltes TypeScript endet mit Exit 0 nach 18,065 Sekunden und ESLint ohne Warnungen mit Exit 0 nach 1,939 Sekunden. `projection-green-v1-terminal.json` bestätigt unveränderte Eingabequellen.
- Wegen des gemeinsamen Projektionspfads laufen zusätzlich die unveränderten tatsächlichen Native-Edit-Owner-/Requestfälle mit 10/10 sowie registrierter MCP-/PI-Editanschluss mit 8/8 durch. Beide ursprünglichen Exits sind 0 nach 48,934 beziehungsweise 16,809 Sekunden; eigene Server, Sockets, Backends und Fixture-Ressourcen sind bestätigt geschlossen. Dies ist kein neuer OAuth-Issuance- oder Browsernachweis.
- Ein unabhängiger read-only Postcheck bestätigt für RED, GREEN und den zusätzlichen Edit-Owner die Abwesenheit der jeweils ursprünglich gemeldeten Schemas nach Namen/OID, Backend-Sessions, DATA-Verzeichnisse und OS-Prozesse bei nicht zugewiesener XID. Originalreport: `projection-resource-postcheck-v2.json`. Ein unabhängiger rein lesender Review bestätigt Scope, Lockreihenfolge, tatsächliche Abort-/Cancelorakel und erhaltene I04-Grenzen.

GitNexus meldet für den bestehenden Guard CRITICAL mit einem direkten Aufrufer, 22 betroffenen Symbolen und drei Prozessen einschließlich MCP-Edit, Recovery und Checkpoint-POST. Warnung, Prüfung des bestehenden Aufrufers und Impacts gingen dem Patch voraus. Die reine Harness ersetzt keinen PG-Nachweis; die neue tatsächliche PG-Folge ersetzt keine vollständige Dateiaktion bei aktivem Room.

## Offen

Der feste Claim-/P0-/Drainanschluss muss noch verbunden werden. Move/Delete brauchen anschließend alle erneut gehaltenen Ownerfences, den atomaren Domain-/Admissionabschluss, echten Abort und Terminalinvalidierung offener Editoren. Der letzte vollständige Browserstand bleibt 8/9; ein frischer Build und unveränderter Fall 9 folgen nach diesen Anschlüssen. Allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben aus.
