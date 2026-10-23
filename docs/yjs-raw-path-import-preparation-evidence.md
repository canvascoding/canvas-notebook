# Frische Markdown-Dateiaktionen: Importpflicht und native Neuplanung

Stand: 19. Oktober 2026. Ausgangscommits Root `1dc957ed182ce74a02d7b394ddb98c4d87a3b7ce` / QA `80dcbdd97a4674e0c0538a4c8edeec174cb19123`. Dieser Schnitt sperrt einen neu belegten Legacy-Löschfallback und prüft expliziten Originalimport mit anschließender vollständig frischer nativer Planung. **M1 und der MVP bleiben offen.**

## Verhalten

Bei aktiviertem Dokumentkern darf eine neue Web-/MCP-Dateiaktion ausgewähltes rohes Markdown nicht als ausführbaren V1-Plan übernehmen. Der tatsächliche gemeinsame Request-Eingang prüft deshalb den vollständig gebauten V1-Plan auf betroffene Markdown-Dateien einschließlich Nachfahren und Overwrite-Löschzielen. Ein Ordnername mit `.md` genügt nicht. Die Prüfung gilt ausschließlich für neue tatsächliche Default-Planungen bei aktiver Integration. Bekannte gespeicherte Aufträge werden vorher gefunden; der gemeinsame Batchbuilder und historische V1-Executor-Rebuilds sind unverändert. Root bleibt nicht aktiviert.

Der interne Fehler `NATIVE_SOURCE_IMPORT_REQUIRED` wird auf dem öffentlichen MCP-Wire exakt als bestehender Konflikt `PATH_NATIVE_REQUIRED` / 409 ausgegeben. Unbekannte Suffixe oder freie Fehlermeldungen erhalten diese Zuordnung nicht. Aktuelle Rechte, Authentifizierungs-Challenges, historische Belege und Ausgabegrenzen bleiben erhalten.

## Tatsächliche Gegenprobe

Die erste echte PG18-Diagnose auf unverändertem Produktcode belegt: Raw-Delete mit einem nativen eingehenden Link erzeugte einen bereiten V1-Plan. Drei andere Raw-/Incoming-Fälle waren bereits gesperrt. Die zweite echte RED-Folge importiert anschließend zwei Originale und bestätigt vier bereite native Pläne; sie scheitert ausdrücklich nur an der noch fehlenden anfänglichen Löschsperre.

Nach dem Produktfix besteht `workspace-operation-raw-path-import-preparation-postgres-test.ts`: vier gesperrte anfängliche Planungen, zwei tatsächliche explizite Originalimporte mit aktuellen Ownerrechten, unveränderten Originalbytes und Dateiversionen sowie echten neuen Registry-/Lineage-/Yjs-Fakten; anschließend dieselben vier vollständig neuen nativen Move-/Delete-Pläne. Die Probe kontrolliert die konkreten nativen Rewrite- und Unlink-Intents samt echten Dokument-/Linkreferenzen. Jede der acht Planungen hat sechs unabhängige NoWrite-Prüfungen: vorheriger Snapshot, keine tatsächliche DML/DDL/Notify, nachheriger Snapshot, unveränderte Tabellen/OIDs, Domainzeilen einschließlich `xmin` und vollständiger DATA-Baum einschließlich FD-Identitäten und Hashes. Alle 48 bestehen. Fixtureanlage und die zwei tatsächlichen Imports liegen außerhalb dieser Fenster.

`path-preparation-green2`: Typen, Lint und tatsächliche Vorbereitungsprobe bestehen. Alle zehn MCP-Vertragsgruppen bestehen ebenfalls, aber die veraltete Schlusszählung erwartet noch neun und macht diesen Gesamtlauf rot. Ausschließlich diese Zählung wird auf zehn berichtigt. `path-preparation-final` bestätigt danach Typen, Lint, alle zehn MCP-Vertragsgruppen, den bestehenden direkten Service und den bisherigen Batchplanner. Die Quellen bleiben jeweils unverändert.

Die bestehende echte öffentliche MCP-/PG18-/FD-Deletefolge erreicht nach dem Guard zunächst die falsche alte Servicecode-Erwartung für Raw-Delete. Diese eine Erwartung wird auf den neuen tatsächlichen internen Importpflichtcode geändert; der öffentliche 409-Vertrag ist separat geprüft. `path-preparation-native-owner-green` besteht danach vollständig: Typen, Lint und acht tatsächliche Gruppen einschließlich FD-Trash, zentralem Unlink, unverändertem Raw-Bestand, aktuellen Rechten, stale Evidence, verlorenem COMMIT-Acknowledgement und erneuerter Sitzung. Keine produktive Autorität oder Assertion wird umgangen.

Die unabhängigen Ressourcenabschlüsse bestätigen entfernte eigene Schema-Namen/OIDs, geschlossene eigene Sessions/Clients, entfernten DATA-Baum, beendete Originalprozesse und dieselben vier gesunden verwalteten Dienste. Es wurde kein Container gebaut oder neu gestartet.

## Zusätzliche rote Bestandsprüfungen

Der unveränderte `workspace-operation-batch-executor-test.ts` endet mit Exit 1: Er verlangt `BATCH_UNDO_NEW_BACKLINK`, erhält aber den ausdrücklich gewünschten `FILE_OPERATION_UNDO_DISABLED`. Der unveränderte `workspace-file-undo-disabled-test.ts` besteht acht Sperrfamilien, scheitert danach im modellierten Apply-Workerfall an `executions === 1` mit tatsächlichem Wert 0. Diese beiden Gesamtsuiten sind **nicht bestanden** und werden nicht als grüne Regressionen ausgegeben. Ihre Testauswahl/-erwartungen und die zweite genaue Ursache bleiben vor gemeinsamer Abschlussfreigabe zu klären; die eigentliche Datei-Undo-Funktion bleibt aus.

## Grenzen und nächster Anschluss

Diese Folge ist expliziter Import plus neue Planung, kein UI-/MCP-Importworkflow und keine automatische Import-/Linkzuordnung innerhalb einer Dateiaktion. Sie führt die vier neuen Pläne nicht aus. READ-only-Raw-Copy benötigt weiterhin den tatsächlichen Zielimport und die gebundene Zuordnung physischer zu nativen Links. Der ursprüngliche Produktionsfall mit vorhandenem Blocks-Inhalt, leerer Projektion und scheiterndem strengem Export benötigt weiterhin eine erhaltene kombinierte echte Aktionsgegenprobe; einfache exportierbare Seedtexte ersetzen sie nicht. Interne Agenten-Neuanlage, verpflichtende Linux-/CI-Schreibschutzabnahme, bewusste Produktionsaktivierung und gemeinsame frische Build-/UI-/API-/MCP-/PR-Abnahme bleiben offen. Review Center bleibt außerhalb des Auftrags.

## Quellen und Originale

Private erhaltene Originale: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-raw-rebinding-169h8pfj`. `slice-acceptance.json` bindet die folgenden Quellen und ursprünglichen positiven wie negativen Terminal-/Ressourcenbelege. Der Index ist veraltet: GitNexus meldet für die neue Testfunktion UNKNOWN; reine Nulltreffer sind keine Sicherheitsfreigabe. Unabhängige Quellenreviews fanden im engen Guard und Vorbereitungsnachweis keine konkreten P1/P2-Befunde.

| Produkt-/Testquelle | SHA-256 |
| --- | --- |
| `app/lib/files/workspace-path-operation-service.ts` | `a02d19ab9c4fe2a9898e04f5fd32a16d7742ce5275c789d3840b253adaa1daef` |
| `app/lib/mcp/server/workspace-path-tool-contract.ts` | `7f3719076349b5c65ccb3c6c01178a7f81ded38cd46df8d3efd23d698bb0f2e8` |
| `scripts/mcp-server-workspace-path-contract-test.ts` | `c295e7b4517eb11c8639bd36493072bb2e1ae4ce047d5fcc07b1012c7a544edf` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `c5c21d8ab4a489a9736fd7bd1d21b8a3d6075d8910ebe48f6fa640e239d4fa8b` |
| `scripts/workspace-operation-raw-path-import-preparation-postgres-test.ts` | `7e0fe399df14657cd93d1b51fe257d08e6d6a1a20fc47d563c207d074297fae0` |
| `scripts/workspace-operation-mixed-delete-postgres-test.ts` | `56452703e6707b1a008e6c770ef3d441ebd0d999da711788c2617fc2bd34900b` |

`slice-acceptance.json` SHA-256: `279599f37b42b8b9e800aa6d87f49a927c8986154e7e3e58bb014f3951711118`.
