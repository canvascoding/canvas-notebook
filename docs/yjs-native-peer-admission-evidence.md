# Nativer Verbindungsaufbau: begrenztes Warten ohne Verlust lokaler Änderungen

Stand: 14. Oktober 2026. Autorencommit `42b73ca523863dc4f5d8acba2260c01618a7d5e6`, zwölf Source-/Testdateien; Sourceanschluss auf Rootbasis `4c9734dbd53e31cc6ae61eabeca1e677e20e4f13`; Produktschalter weiterhin `false`.

Der erste echte Principal-Schemalock kann vor erfolgreichem Transport-Capture mit `PRINCIPAL_BUSY` scheitern. Ein neuer Versuch braucht dabei dieselbe ursprüngliche Anmeldung und Scopebindung. Eine erschöpfte Verbindung darf einen lokalen Editorentwurf weder als Rechteentzug behandeln noch über einen bereits geplanten Provider-Reconnect unbegrenzt neue Versuche starten.

## Umsetzung

- Der genuine Principal kann seine historischen primitiven Identitätsfelder vor dem ersten Schemalock synchron an den privaten Besitzer melden. Dazu gehören Workspace-/Root-/Datenbank-/Suchpfadbindung und `impersonatedBy`. Das ist keine Autorisierung; die bestehenden gesperrten aktuellen und finalen Prüfungen bleiben erhalten. Bekannt ungültige Anmeldung wird bereits vor einer möglichen Busy-Einstufung abgewiesen.
- Der gemeinsame native Runtimebesitzer bleibt im selben unveränderlichen Prozessslot und verwendet Version 2. Private Ursprungs- und Transportrecords bleiben im ersten Besitzer. Mobile übernimmt nach echtem HTTP-Capture genau dessen historische Bindung; Existing-, ReadJoin-, Diagnose- und Owned-Phasen vergleichen sie weiter. Sie setzen keine neue Historie.
- Der Socketaufbau hat höchstens drei Capture/Join-Iterationen mit 25 ms Abstand. Nur echte private Principal-/Reader-Contention vor Consumerbeginn darf nach bestätigtem ROLLBACK und Close einen neuen Versuch auslösen. COMMIT-Ungewissheit, fehlgeschlagener Cleanup, Scope-/Authwechsel und spätere Consumerfehler bleiben endgültige Fehler. Das bereits bestehende HTTP-Lesebudget ist separat.
- Ein Mobile-Ticket wird einmal konsumiert. Sein HTTP-Capture zählt als Capture der ersten Socketiteration. Erfolgreiches Join wird erst nach tatsächlichem COMMIT und Close an den Peer weitergegeben. Abbruch und fehlgeschlagene Adoption geben den jeweils eigenen Transport frei.
- Nur der exakte AuthDenied-Grund `NATIVE_PEER_ADMISSION_BUSY` pausiert den Webclient als offline und erhält Y.Doc, Draft, Undo, Sessionrechte und Authscope. Token-/Checkpoint- und bereits geplante Socket-Retries erzeugen in dieser geöffneten Providerlebenszeit keinen neuen Ursprung. Unbekannte Ablehnung und tatsächlicher Rechteentzug bleiben gesperrt.

Der Produktdiff betrifft sieben bestehende Dateien und einen neuen Admissionhelper; drei neue Testdateien und die genaue Anpassung der alten Brokerfixture ergänzen die Prüfungen. Lifecycle-Transaktionskern, native Peerpolicy, bestehender HTTP-Service, Owner-/Persistenz-/Checkpointmodule, Produktschalter und Abhängigkeiten bleiben vollständig bytegleich.

## Unabhängige Rootprüfung

Root übernimmt zwölf exakt übereinstimmende Autoren-Dateien und prüft im eigenen Worktree:

| Prüfung | Tatsächliches Ergebnis |
| --- | --- |
| Zwei echte Source-Modulreihenfolgen mit PostgreSQL 18/Auth | 15 Familien je Reihenfolge, Exit 0 |
| Prelock-Ban/Impersonation, unveränderte Impersonation und Wechsel zwischen Versuchen | 10 Fälle über beide Reihenfolgen, Exit 0; keine native DML |
| Geänderte Impersonation nach echtem Mobile-HTTP-Capture | Je Existing, gesunder/quarantinierter ReadJoin, Diagnose und Owned in beiden Reihenfolgen vor Consumer abgewiesen, Exit 0 |
| Echter Source-Custom-Server mit Raw-WebSocket | 8 Familien, Exit 0: Web/Mobile transient/dauerhaft Busy, COMMIT-Ungewissheit, poisoned/in-flight Adoption und Abbruch vor Peerpublikation |
| Webclient mit echtem Reducer, Y.Doc, Hook und installierter Provider-Frame-/Closemechanik | 6 Busy- und 3 unbekannte AuthDenied-Fälle; Draft/Scope erhalten, verspätete Token/Checkpoint/Timer gestoppt; regulärer Nicht-Busy-Connect erhalten, Exit 0 |
| Cachefreies vollständiges TypeScript | Exit 0 mit 12 GiB Heap |
| ESLint für zwölf Source-/Testdateien | Exit 0 |
| Bisherige gemeinsame Brokerregression | 36 echte PG/Auth/Source-POST-Familien plus fünf inkompatible Slots, Exit 0 |

Die erste unverändert übernommene Brokerfixture scheiterte im eigenen Rootlauf an ihrer exakten Fehlercode-Erwartung: Ein absichtlich geänderter B-Suchpfad wird nun schon vom genuinen Prelock-Principal mit `PRINCIPAL_SCOPE_CHANGED` abgewiesen. Der Test erwartete die spätere `NATIVE_TRANSPORT_SCOPE_CHANGED`-Ablehnung. Ausschließlich die Realm-Erwartung wird präzisiert; Native- und Rootfälle sowie alle 36 Familien und fünf inkompatiblen Slots bleiben erhalten. Kein Produktfehlercode wird normalisiert und keine Assertion entfernt. Der anschließende vollständige Rootlauf besteht 18 Familien je Modulreihenfolge und alle fünf Slots, Exit 0; SHA-256 des originalen finalen Logs `9cbb802fb7577c067d99851e8b9904a40670b9048f33448dc687f4e2ac889921`.

Private originale Rootlogs liegen unter `canvas-peer-root-integration-9bx78zzq`. Relevante SHA-256: PG `059c2e3279ea966d3929fcdeae150b5983dda2d1c0c4cd08d60d4e74693af051`, Auth `b38ca6d24a187de404e182cc3dd6cca7c4ff79b2c4e1ad83221a5781cc1004d3`, Transport `7fb803e1552d25f1df99c6db55616d8eff156579a5eac9887c6f5b1fa5b2f0f3`, RawWS `e5c52341a13d20f5755021b5dcdc6ccff69f4780cd9cda29e9100b97171fc744`, Client `8ceae32d1a35a78ff5d8b1d8e57bca4debd798a2eb8140a16b3e85930d3c2f2a`. Root bestätigt außerhalb des RawWS-Testprozesses die Abwesenheit von dessen PID, DATA, UUID-Schema und zugehörigen SQL-Sessions. Andere PG-Matrizen schließen ihre eigenen Clients/Pools und entfernen ihre exakten Schemas mit Namespaceprüfung im ausgeführten finally; ihre bestätigten Prozessabschlüsse sind Exit 0.

GitNexus vor Übernahme: HIGH für Transport-Dispose (10 direkte/21 erreichbare Symbole über Collaboration, Mobile und Server), Clienterzeugung, Locationadoption und Reducer (12 direkte/36 erreichbare Symbole, MarkdownEditor-Prozesse). Warnung wurde vor Integration berichtet; niedrigere und mittlere Principal-/Reader-/Server-Glues separat geprüft. Die korrekte benannte Rootindex-Auswahl ist maßgeblich; Pfadabfragen mit unvollständiger Reichweite dienen nicht als Nullbeleg. Der frische Root-Forceindex bestätigt den vollständigen Staging-Scope: 15 Dateien einschließlich drei Dokumentationen, 226 Symbole, null indexierte Prozesse, grob LOW. Das nimmt die zuvor geprüften HIGH-Reichweiten nicht zurück. Der gesamte Branchvergleich gegen `main` umfasst 414 Dateien, 4.268 Symbole und 40 betroffene Prozesse, CRITICAL; die Warnung wurde vor dem Abschluss berichtet.

## Noch offene gemeinsame Abnahme

Dies ist Source-/PostgreSQL-/Raw-WebSocket- und gezielte Clientprüfung. Ein frischer kompilierter Appbuild, tatsächliche Mobile-HTTP→Ticket-only-WebSocket-Synchronisation samt Replay-/Ownerfreigabe sowie die neue vollständige Browserabnahme fehlen noch. Die native Mobile-Editorvorlage besitzt einen eigenen AuthDenied-/Reconnectadapter und übernimmt den Webclientfix nicht automatisch; dessen enger Anschluss und Geräteabnahme bleiben ein eigener Folgeschritt. I-04-Erstveröffentlichung, neue Create-/Import-Routen, allgemeine Dateiaktionsaktivierung und ursprüngliche Codecdiagnose werden durch diesen Commit nicht abgeschlossen. Erhaltene V20/V21/V22- und private Mobile-Fixtures bleiben unverändert.
