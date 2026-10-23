# Native Session: kontrollierte HTTP-/Socket-Sperrgegenprobe

Status: **Acht Source-/PG-/Netzwerkfamilien abgeschlossen; konkreter Produktfehler eingegrenzt, Korrektur und neue Browserabnahme offen.** Test-only Autorcommit `fe14f22395f3410d64b6c8dde6f54e596a18050a` basiert auf `7beb6a43b`; alle Produktmodule und drei bestehenden Native-Session-/Peer-/HTTP-Tests sind bytegleich zur Basis.

[authenticated-native-peer-busy-postgres-test](../scripts/authenticated-native-peer-busy-postgres-test.ts) startet echte exportierte Web-Session-Handler und den tatsächlichen Collaborationserver mit PG18, echten Authsessions und einem eigenen UUID-Schema/DATA/Loopback-Port. Observer pausieren ursprüngliche SQL-Promises nach echter Factorymint, rufen die originalen Funktionen auf und ändern keine SQL-Ergebnisse. Die Hocuspocus-Hooks und Transportphasen werden beobachtet; die Produktsource wird für diesen Sourcecounter direkt transpiliert. Dies ist ein instrumentierter Source-/Netzwerkbeleg, kein Compiled-Host- oder Browserbeleg. Der native Testschalter gilt ausschließlich in der isolierten Testfixture.

Die Gegenprobe hält echte Organization-Zeilen- bzw. Tabellensperren. Ein zusätzlicher eigener SQL-Waiter weist `pg_blocking_pids`, Lock-Wait und tatsächlichen Holder nach; nur dieser eigene Waiter wird beendet. Jeder behauptete Busy-B hat tatsächliches SQL `55P03`, `ROLLBACK` und bestätigten Close. Die acht abgeschlossenen Familien zeigen:

| Fall | Tatsächliches Ergebnis |
| --- | --- |
| Unbestrittener Einstieg | Originaler HTTP 200, eingehendes Authenticated/read-write und Durability-Snapshot. |
| HTTP: Row vs. Table | Row: native B scheitert mit `55P03`, frische Requestfactory schreibt anschließend die gehaltene Orgzeile und erhält `57014`; Originalroute liefert `403/PRINCIPAL_ACCESS_DENIED`. Table: drei native Busy-Bs liefern `409/PRINCIPAL_BUSY`. Nach Holderrelease gelingt HTTP wieder. |
| Capture unter Row-Lock | Vorher HTTP 200; Capture-B wird zurückgerollt/geschlossen, eingehendes `AuthPermissionDenied/permission-denied`. Nach Holderrelease gelingt ein frischer Handshake. |
| Join unter Table-Lock | Capture wurde committed/geschlossen; Join-B wird zurückgerollt/geschlossen und der erfasste Transport tatsächlich disposed. Eingehendes AuthDenied; frischer Handshake nach Freigabe gelingt. |
| Tatsächlicher Sessionwiderruf | Dasselbe AuthDenied-Wireformat, aber keine native Capture-/Join-B-Phase startet. |
| Connected unter Table-Lock | Drei frische erfolglose private Busy-Bs; Socket schließt mit 1013. |
| Message unter Row-Lock | Holder wird erst nach tatsächlichem B-Close freigegeben. Derselbe eingehende Frame erhält nach frischer Prüfung Sync 0/1, ohne AccessRevoked oder native Mutation. |
| Message unter Table-Lock | Drei frische erfolglose private Busy-Bs; Socket schließt mit 1013. |

Damit ist vorübergehendes Capture-/Join-Busy im aktuellen Auth-Wireformat nicht von dauerhaftem Widerruf unterscheidbar. Die bestehende Connected-/Message-Behandlung arbeitet dagegen in diesen Gegenfällen wie vorgesehen. Der HTTP-Row-Befund weist zusätzlich eine tatsächliche Factory-/Bootstrap-Schreibgrenze nach. Er beweist weder den ursprünglichen V22-Lockhalter noch einen einheitlichen Grund aller V22-Browserfehler.

Der Autor bestätigt acht Familien, Exit 0, frisches vollständiges TypeScript mit 8 GiB/`--incremental false`, scoped ESLint, forceIndex und staged detect. Nach dem Lauf wurde nur eine Typannotation des privaten Observercallbacks korrigiert; deren transpiliertes Runtime-JS bleibt bytegleich. Root bestätigt finale Sourcebytes `5360a0e4d72ebd08f0b151df52ae04fa8e953ffad77796c659e4f9a68046ee26` und berechnet den identischen Runtime-JS-Hash `66fbcc3cc7218f815a6e8665fc8b857b0adce2bcac0eb17ef38692fb47789d5a` unabhängig. Root liest die tatsächlichen Ergebnis-/Closurebelege und prüft die übernommenen Sourcebytes; dies wird nicht als zusätzlicher Root-Matrixlauf bezeichnet.

Eigene Runtimeclosure: Server beendet, keine verbleibenden Sockets, Port ohne Listener, Prozess/Gruppe abwesend, UUID-Schema und DATA entfernt, alle neunzehn beobachteten eigenen B-/Holder-/Waiter-Backends abwesend. Root bestätigt Schemaentfernung und null beobachtete PG-Backends unabhängig sowie den abwesenden Prozess/Listener.

Nächste getrennte Schritte: echte Resolver-500 im nativen Principal als unbestätigte Autorisierung behandeln, statt 403 zu behaupten; anschließend Capture-/Join-Busy nur nach belegtem B-Abschluss/Dispose begrenzt neu prüfen und als temporären Wirezustand an den bestehenden Reconnectpfad geben. Echter Widerruf, unklarer COMMIT und Closefehler dürfen keinen Retry erhalten. Der weitreichende allgemeine Workspace-/Bootstrapresolver bleibt für diesen ersten Fix unverändert. Danach folgen frischer integrierter Build und die ursprüngliche Browsermatrix.
