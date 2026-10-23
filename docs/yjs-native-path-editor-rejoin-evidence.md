# Frisch autorisierter Editor-Rejoin nach Admission

Stand: 19. Oktober 2026. Grundlage ist Root `e0eb0311b6f30ff436dd35387dbbca078acaa1f3`. Dieser Schritt verbindet den bestehenden Client mit echten Location-Invalidierungen und frischer HTTP-Sessionprüfung. Der vollständige serverseitige Move-/Delete-Drain ist weiterhin offen; dies ist kein neuer Browser- oder Produktionsnachweis.

## Verhalten

Der installierte Hocuspocus-Provider bildet die Servernachricht `Collaboration document transition` auf einen Document-CLOSE mit Code 1000 ab. Der Client erkennt genau diesen Grund bei Code 1000 oder 1013 und pausiert die alte Verbindung. Ein allgemeiner Closecode allein löst diese Behandlung nicht aus.

Nach einer ID-geprüften Location-Abfrage darf auch ein unveränderter Incoming-Pfad einen parameterlosen Rejoin anfordern. Der feste Registryeintrag fordert eine neue HTTP-Session an und prüft private HTTP-Autorisierung, aktuelle Auth-Epoche, Benutzer, Dokumentname/-ID, Generation, Repräsentation, Schema, Ticketablauf und Berechtigung. Eine echte READ-Herabstufung bleibt wirksam. Erst danach werden alte Request-/Providercallbacks pensioniert und Busy freigegeben. Y.Doc, IndexedDB und lokale Änderungen bleiben erhalten; Persistenz wird erst wieder durch tatsächlichen Sync bestätigt.

Ein Versuch besitzt ein eigenes Abbruchsignal und eine feste 10-Sekunden-Frist. Ein Cancellation-Race beendet ihn auch bei einem Fetch, der Abbruch ignoriert. Deduplizierung gilt nur für denselben Pfad, Auth-Scope und Request-Scope. Ein neuer aktueller Pfadhinweis ersetzt den alten Versuch; alte Antworten und finally-Handler können den neuen nicht übernehmen oder löschen. Busy erzeugt keinen eigenen Polling-Timer. 401/403 erhalten den Entwurf und verweigern die Verbindung.

## Prüfung und erhaltene Vorläufe

Private Originale: `/private/tmp/canvas-native-path-admission-8gusy9ys/`. Die eingefrorenen v1-/v2-Kandidaten und zwei unabhängige Quellreviews bleiben getrennt von Roots tatsächlicher Ausführung.

- Mit ausschließlich den zwei neuen Regressionstestquellen und unverändertem Produktcode endet der echte RED-Lauf mit Exit 1 an der fehlenden Zustandsfreigabe.
- Der erste integrierte Clientlauf besteht die Native-Peer-Harness mit Exit 0. Auch die Location-Harness beendet tatsächlich mit Exit 0 nach 311,680 Sekunden. Die Diagnose am selben verifizierten Live-Prozess zeigt fünf reguläre QueryCache-GC-Timer von je 300.000 ms; es wurde kein Prozessabbruch als Erfolg gewertet.
- Der finale Stand beseitigt im Fixture-Teardown nach Unmount, Watcher-Disconnect und Gateauflösung dessen eigene QueryCaches. Produkt-Cachefristen und Assertions bleiben erhalten. Native-Peer- und Location-Harness enden erneut mit tatsächlichem Exit 0 nach 3,858 beziehungsweise 12,419 Sekunden.
- Die Harnesses prüfen echten installierten CLOSE-Empfang, Sticky-Busy, verspätete Callbackabwehr, Entwurfserhalt, Fresh-Session-Bindung, Rechteherabstufung/-entzug, abweichende Identitäten, abgelaufene Tickets, Authrotation, offene/retirierte Views, hängenden POST und konkurrierenden Pfadwechsel. Die Location-Harness prüft außerdem unveränderte Pfade sowie fehlende Busy-/Content-Pollschleifen.
- Gezieltes TypeScript endet mit Exit 0. Der erste ESLintlauf findet einen Render-Refwrite; das Ref-Update läuft im finalen Stand im vorgelagerten Effect. Erneutes gezieltes TypeScript und ESLint enden mit Exit 0. Ein abschließender unabhängiger Quellreview findet keine weiteren Probleme.
- Beide finalen Controller bestätigen unveränderte Eingabequellen während der Läufe. Originaler Location-Prozess, Controller und diagnostischer Inspector sind anschließend nachweislich abwesend. Die vier verwalteten Container behalten ihre ursprünglichen Identitäten und sind gesund.

Die vollständigen finalen Sourcepins stehen in `client-green-v3-terminal.json` und `client-checks-v2-terminal.json`. Diese React-/JSDOM-Harnesses verwenden deklarierte HTTP-/Providerfixtures; sie beweisen keine serverseitige aktuelle Berechtigung oder vollständige Appintegration. GitNexus meldet HIGH für die gemeinsamen Produktfunktionen, darunter 13 direkte Reducer-Aufrufer; die Warnung ging der Integration voraus.

## Weiterer Anschluss

Die neue unveränderliche Move-P0-Vorbereitung ist bislang nur ein privat geprüfter Kandidat. Ihr unabhängiger Review fand einen Null-Bundle-Bypass; die v2-Korrektur ruft den vorhandenen strikten Decoder auch für null auf. Sie wurde noch nicht integriert oder ausgeführt.

Nächste verbindliche Schritte bleiben die tatsächliche Claim-/Policygebundene P0-Reservation, Drain außerhalb aller gehaltenen Workspace-/Roomlocks, Wiedererwerb der Ownerfences und atomarer Domain-/Admissionabschluss auf derselben B2. Delete muss dabei Links, Archiv, Trash und Original-Completion umfassen. Auch ein abgebrochener Übergang ohne Dateistrukturänderung braucht einen echten Terminalhinweis für den Client. Anschließend sind die vorbereiteten echten Live-Room-PG-Fälle und der unveränderte Browserfall 9 mit geöffnetem Incoming-Editor auszuführen. Der vollständige SDK-Lifecycle über erneuertes OAuth und die übrigen Restblöcke bleiben offen.

Der bisherige Browserstand bleibt bei 8/9. Ursprünglicher Produktionsfehler, allgemeine Aktivierung und Gesamtabschluss sind nicht als behoben beziehungsweise erreicht belegt. Dateiaktions-Undo und Review Center bleiben aus.
