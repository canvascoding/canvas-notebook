# Neustartabnahme: PostgreSQL-Flags im Testreader

Stand: 2026-10-14. V15 prüft exakt `3857ce3d6b1a13a118dc5bfd74ead1126d324f8b`. Der native Absatz-Locator besteht im echten Browser; die vollständige Neustartabnahme bleibt offen.

## Tatsächlicher Lauf und Fehlergrenze

Der erste unveränderte Produktionsbuild mit allen drei Prebuild-Schritten und tatsächlicher CLI-Versionseinfügung besteht. Root bestätigt den echten Deep-Buildproof, vollständigen privaten Loghash, echte Buildumgebung und alle 37 bekannten Build-PIDs samt Observer sowie drei leere Gruppen. Sourcefingerprint `d8ba357afbf155fa31b8ce86d1ff48d46b1728755910824d66bbad537d3daad0`, Buildfingerprint `f8a83a3e3e0b28557972284770c1cb9487a32687929d74626f76b104fc070e56`.

Vier Suites und Helper entsprechen exakt dem eingefrorenen Commit. Fokus/Links, Runner und QA-Konfiguration bleiben bytegleich zur früheren Basis. Create/Restart enthalten nur die zuvor bestätigten Import-, Helper- und Locatoränderungen; sämtliche ursprünglichen Case-/Geschäftsprüfungen, Seeds und Zeitlimits bleiben erhalten. Keine Behauptung einer Gleichheit aller vier vollständigen Dateien zur früheren Basis.

Ergebnis: **zehn tatsächlich gestartet, acht bestanden, zwei fehlgeschlagen**. Create/Paste/Import sechs bestanden, Fokus/Breite einer, vollständige Link-/Fragmentnavigation einer. Keine Skips, Testtimeouts, Abbrüche oder Wiederholungen.

Beide Restartfälle bestehen jetzt nativen Absatznachweis, echten Klick, Peer-Tastatureingabe, sichtbare Owneränderung und native JSON-Konvergenz. Der erste Durability-Poll in [editor-yjs-owned-restart.spec.ts](../tests/editor-yjs-owned-restart.spec.ts), Zeile 88, scheitert an `Owned storage-evidence child failed; exit verified.`. Hostneustart, frischer Browserprozess und Persistenz nach Neustart werden nicht erreicht: `restartCount=0`.

Der Fehler belegt einen bestätigten fehlgeschlagenen Childexit. Die [Childhilfe](../tests/helpers/owned-native-command.ts) verwirft stderr; der [Storage-Reader](../scripts/owned-yjs-authority-storage-read.ts) vereinheitlicht Fehler zusätzlich im Catch. Ursprüngliche Child-Ursache und erfolgreicher Durchlauf seines vorgeschalteten Live-Guards sind dadurch nicht nachträglich belegt.

## Separat nachgewiesener Adapterfehler

Root liest nach Runtimeende ausschließlich die beiden tatsächlichen erhaltenen Restartzeilen aus der eigenen, erneut über OID/Owner/Marker geprüften PG18-Datenbank. Beide aktiv: `tiptap_blocks`, Schema 1, Generation 1, Sequenz 2, positive Persistenzzeit, Binary 1.292 Bytes und StateVector 19 Bytes. Dies allein beweist noch keinen vollständigen Inhalt oder Neustart.

Der direkte PostgreSQL-Client liefert `degraded`, `has_bom` und `projection_error_permanent` jeweils als BIGINT-String `0`. Der aktuelle Adapter macht durch `Boolean(row.degraded)` daraus `true`. Ohne Projektionsfehlercode folgt über [assertNativeState](../app/lib/collaboration/document-snapshot.ts) und das [Quarantäneprädikat](../app/lib/collaboration/failure.ts) ein Reject vor Yjs-Dekodierung. Root bestätigt diesen Gegenbeweis an beiden echten Zeilen mit dem tatsächlichen Prädikat; strikt als Null gelesene Flags erzeugen diese falsche Quarantäne nicht. BOM und Permanentflag haben denselben Boolean-Mappingfehler.

Die Anwendung installiert ihren INT8-Parser beim Erzeugen ihres eigenen PostgreSQL-Pools. Der Testreader nutzt zuerst einen direkten `pg.Client`; der Snapshotimport erfolgt erst nach dem Mapping. Parserzustand des Playwright-Workers wird nicht an den Childprozess vererbt. Dieser separat bewiesene Defekt bleibt vom generischen historischen Childexit unterschieden.

## Korrekturvertrag und offene Abnahme

Die enge Korrektur betrifft den Testadapter. SQL-Flags werden strikt als `0` oder `1` ausgewertet; wahre Quarantäne und BOM bleiben erhalten, ungültige Flags werden nicht als harmlos interpretiert. Fehlender/veralteter Fehlercode darf ein tatsächliches Permanentflag nicht unsichtbar machen. Produkt-Persistenz, Snapshotvertrag, Live-Guard, DB-/Root-/Receiptidentität, Schema-/Binary-/Vectorprüfung, Browserassertions und stderr-/Exitbegrenzung bleiben wirksam.

Der [reine testinterne Rowadapter](../scripts/lib/owned-yjs-authority-storage-row.ts) ist integriert. Root bestätigt vor Änderung den präzisen Impact: LOW, ein direkter Aufrufer, keine indexierten Prozesse oder Module. Alle drei integrierten Sourcebytes entsprechen exakt dem geprüften Agentcommit. Der ursprüngliche Reader bleibt nach Rückersetzung genau des Adapterimports und Aufrufs bytegleich; Live-Guard, Child-/Exit-/stderr-Hilfe, Restart-Suite, Runner und QA-Konfiguration bleiben vollständig bytegleich.

Root bestätigt zehn echte isolierte [PostgreSQL-/Native-Snapshot-Testgruppen](../scripts/owned-yjs-authority-storage-postgres-test.ts), Full TypeScript mit 8 GiB und scoped ESLint. Die Matrix reproduziert alte falsche Quarantäne auf echten BIGINT-Zeilen und bestätigt vollständige Binary-/JSON-/Proofgleichheit, Plain/XML/Blocks und leere Zustände, Native-only-Tabellenbreiten ohne Markdown-Export, BOM/CRLF, echte Quarantäne, zulässigen Persistence-Retry, fehlerhafte Flags, versteckte/stale Permanentflags sowie Identitäts-/Schema-/Vector-/Trailing-Byte-Rejects. Eigenes UUID-Schema, Clients und DATA werden geschlossen/entfernt; Env und Fetch restauriert. Unabhängige Source-Review hat keinen materiellen Befund. Der Agent bestätigt zusätzlich die neun unveränderten Native-Snapshotfälle und die vorhandenen QA-Guardtests. Die erste neue Agent-PG-Fixture scheitert an ihrer eigenen Search-Path-Literalform; nach genauer Korrektur bestehen alle Gruppen. Root besteht die integrierte Matrix im ersten eigenen Lauf.

Die vollständige Browser-/Neustartabnahme der Korrektur bleibt erforderlich; kein historischer Child-Guardstatus und keine Dateioperations-, Session- oder Produktionsaktivierung werden daraus abgeleitet.

## Erhaltene Belege und Closure

Root bestätigt nach Laufende erneut den tatsächlichen unveränderten Deep-Buildproof. Frische unabhängige Closure: sieben bekannte Runtime-PIDs und sieben Gruppen beendet, passiver Observer beendet, Port 65179 frei, Lock entfernt, Root-/DATA-Identität erhalten. Beide exakten eigenen PG18-Datenbank-OIDs mit Owner/Marker bestätigt, null Sessions. Keine Wiederholung oder fremde Dienst-/Containeränderung. Der passive Observer erfasst alle vier Browser-CLI-PIDs; Root beobachtet direkt nur den Restart-CLI.

Private Traces: graceful 14.028.060 Bytes, SHA256 `96c78b92865a7d6ca479c463f1fc0c095ac57874f1f6b4d667be333e8948b796`; crash 14.528.001 Bytes, SHA256 `3b9e6e5ab99181cf691be866545ec255ef13817d9e975602b8ce4797fb0faa36`. Offlinebericht 9.947 Bytes, SHA256 `5a303b4ab959feba8f367af26a7ca801ce58dfbc590d2b4fb01f9adb2d13e38e`. Dateien 0600 unter eigenen 0700-Verzeichnissen; keine Rawframes, Header, Credentials, Dokumentidentitäten, Inhalte oder Markerpayloads in öffentlichen Nachweisen.
