# Gastzugang: atomarer Codeverbrauch und Sitzungsanlage

Stand: 15. Oktober 2026. Enger Vorabschluss innerhalb der noch offenen Guest-Writerfamilie. Das globale native Lifecycle-Gate bleibt ausgeschaltet. Vollständiger Guest-Admission-Fence, aktuelle Inviterrechte auf derselben Verbindung und dauerhaft gebundene Dokumentgeneration sind weiterhin offen.

## Fehler und Änderung

`createFileGuestService.verify` verbrauchte den bestätigten E-Mail-Code, löschte alte Sitzungen und legte die neue Sitzung mit getrennten globalen Drizzlewrites an. Ein tatsächlicher SQLfehler beim INSERT ließ einen verbrauchten Code ohne neue Sitzung zurück.

Der reguläre Service verwendet jetzt `redeemFileGuestCode`: eine kurze RC/RW-Transaktion auf einer tatsächlichen `openDb`-Connection. Nach den bestehenden Entitlement-/Inviter-/Dokumentprüfungen sperrt sie die Einladung mit `FOR UPDATE` und vergleicht Workspace, Pfad, Dokument, Ersteller und die zuvor gelesene Policyrevision. Bei Abweichung bleibt der Code unberührt; der Service meldet 409. Die Uhr wird erst nach einem möglichen Rowlock-Warten gelesen. Ablauf bleibt 401 für den Code beziehungsweise 410 für die Einladung.

Versuchszähler, Codeverbrauch, Cleanup alter Sitzungen und neue Sitzung gehören zu derselben Transaktion. Ein falscher Code liefert innerhalb der Transaktion ein Ablehnungsergebnis; der bestehende 401 wird erst nach bestätigtem COMMIT ausgegeben. So bleibt die Grenze von fünf Versuchen erhalten. Scheitert dagegen die Sitzungsanlage, werden auch Verbrauch, Versuch und Cleanup zurückgerollt.

Die vorhandene `executeLifecycleTransaction`-Mechanik besitzt COMMIT und einmaligen Connectionabschluss. Verlorener COMMIT-ACK, fehlgeschlagener Discard und Fehler nach bestätigtem COMMIT liefern `FILE_GUEST_REDEMPTION_COMMIT_UNCONFIRMED` mit 503. Der echte Actionrouter setzt dann keinen Cookie. Kein automatischer zweiter Versuch, keine Erfolgsbehauptung aus ähnlichen gespeicherten Zeilen und keine Token-/SQLdetails im öffentlichen Fehler.

## Tatsächliche PostgreSQL-Gegenproben

Neue Fixture: `scripts/file-guest-redemption-postgres-test.ts`. Sie prüft die private Zielkonfiguration, PostgreSQL 18 und eine eigene zufällige Schema-/DATA-Bindung. Sie führt die unveränderten originalen Migrationen und den echten Runtimepool aus. Native Yjs-/Namespace-/Einladungszeilen sind eigene Testdaten. Nur Entitlement-Prüfung und Mailzustellung verwenden die bestehenden Service-Testdependencies; der Fall behauptet keine echte SMTPzustellung oder neue Autorisierung. Der normale Gastservice, Challenge, Verify und Actionrouter werden tatsächlich ausgeführt. SQL und Ergebnisse werden nicht umgeschrieben.

Der ursprüngliche Service, SHA-256 `8f3b8a37188c376a294b7a8cce60835a0b12b7928ddfb0bd05c2b1e5ebf4f5f5`, scheitert im echten RED-Lauf 97463, Exit 1, am erwarteten Codeverbrauch nach einem realen INSERT-CHECKfehler SQLSTATE 23514 mit exakt gebundener Testconstraint. Davor besteht der echte Erfolgsfall. Die damalige Achtfamilien-Fixture hat SHA-256 `17bd9f6926e7230404f2de7ac968924b2d5c43c901c1ea875287696d05b48fed`. Ein früherer Syntaxfehler der Testfixture lief noch vor PG und zählt ausdrücklich nicht als Produkt-RED.

Nach dem Anschluss bestehen zunächst acht Familien, tatsächlicher Exit 0, Session 45346. Drei zusätzliche Gegenfälle erweitern anschließend dieselbe vorhandene Matrix: echte OTP-/Einladungsabläufe während eines nachgewiesenen Rowlock-Wartens und verlorener COMMIT-ACK eines tatsächlich gespeicherten Fehlversuchszählers. Der finale Lauf 9754 endet mit Exit 0 und elf tatsächlichen Familien:

- Tatsächliche Challenge, native Vorbereitung und genau eine tokengebundene Sitzung.
- Reale INSERT-Constraint verletzt: Code, Versuchszähler und Sessioncleanup bleiben zurückgerollt; derselbe Code funktioniert danach.
- Fünf falsche Versuche bleiben bestätigt und können nicht durch Rollback umgangen werden.
- Zwei verschiedene echte BEGIN-Backends: genau ein erfolgreicher Verbraucher und eine Sitzung.
- Tatsächlicher Policywechsel nach Lieferung eines alten Einladungsergebnisses: 409, kein Verbrauch und keine Sitzung.
- Je ein tatsächlicher Code-/Einladungsablauf während `pg_blocking_pids` den eigenen Rowlock-Blocker nachweist; reale Deadline wird bei gehaltener Sperre überschritten, danach 401/410 ohne Cookie oder Mutation.
- Tatsächlich gespeicherter falscher Versuch mit verlorenem COMMIT-ACK: benannter 503, Zähler eins, kein Verbrauch, kein INSERT und kein Retry.
- Drei erfolgreiche echte COMMITs mit verlorenem ACK, Fehler beim tatsächlichen Discard oder Fehler nach normaler tatsächlicher Freigabe: benannter 503 ohne Cookie, je ein Verbrauch/INSERT/COMMIT/Release und kein Rollback/Retry. Backendabwesenheit wird nur für tatsächliche Discards behauptet.

Quellen des Elf-Familien-Laufs: Redemption `d90aab697a3b8cf0b8d8cacd09da4bc61f1efcd3315fddf7c7250afda7191286`, Service `ac479a5721ce055fc6c02be42c8178395c913ef2c6a65cc0f335fcc7098c5476`, HTTPmapper `2734d5e43f7caebe391aae86efa14a0d91a6214a737a50f7183fad68b0cdf754`, PGfixture `d659313c8a331b90cc58873d168c9b832f434ebedfb56652fe6978c2216f3921`.

## Weitere Prüfung und offene Grenzen

Der bestehende `npm run test:file-guests` endet zwar mit Exit 0, bestätigt aber nur die ersten beiden Skripte durch deren Abschlussausgabe. Beim dritten Access-Test ignoriert der alte Promise-only-`Pool.connect`-Stub den inzwischen tatsächlichen callbackbasierten Checkout. Die unerfüllte Promise erlaubt Prozessende ohne den Erfolgsmarker oder `finally` des Access-Tests. Deshalb wird dieser Lauf nicht als bestandene vollständige Access-/WebSocket-Kompatibilitätsprüfung gewertet. Die neue echte PGfixture ersetzt keinen Poolcheckout.

Vollständiges cachefreies TypeScript besteht mit tatsächlichem Exit 0, Session 68445. Scoped-Lint aller drei Produktmodule und der Browser-Spec besteht, Session 32514; die finale PGfixture besteht separat, Session 80805. Frischer Produktionsbuild und echter Guest-Browserfall folgen vor der lokalen Integrationsabnahme. Der vorhandene Browserfall wurde um falschen Code ohne Cookie und anschließende erfolgreiche Verifikation ergänzt; vor der Dateiarbeit wird das experimentelle Review Center ausdrücklich ausgeschaltet. UI-, Inviter-ACL-, Lifecycle-/Generation-, Shared-Fence-, Dateilink-, SDK-/Skill- und Produktionsabnahme bleiben getrennte Nachweise.
