# Native Copy: private Plan- und History-Grundlage

Stand: 16. Oktober 2026. Diese Etappe bereitet die Erweiterung des **vorhandenen Copy-Koordinators** vor. Sie führt keinen zweiten V4-Batchjob ein. Die neuen Plan-/History-Module sind noch nicht an öffentliche Producer oder Ausführung angeschlossen. Die allgemeine Aktivierung bleibt `false`; Datei-Undo und Review Center bleiben aus. Diese Datei belegt keine vollständige native Copy-Ausführung oder öffentliche Move-Abnahme.

## Implementierte Verträge

[workspace-operation-native-copy-plan.ts](../app/lib/files/workspace-operation-native-copy-plan.ts) enthält einen privaten JSON-Vertrag `version:1`, `kind:native-copy`, mit unverändertem `executionReady:false`. Er bindet ursprüngliche geordnete Auswahlen, vollständige Source-/Destination-Scopes und Evidence-Snapshots, den vorhandenen Copy-Pfadplan, Compiler-/Finalgraph-Proof und virtuelle `cloneRequirements`. Gleicher Workspace verlangt identische ursprüngliche Scope-/Evidence-Fakten; der bereits vorhandene Cross-Workspace-Vertrag verwendet unabhängige Zielzustände. Native-only-Dokumente, Assets sowie volle und leere Ordner bleiben unterscheidbar.

`createWorkspaceOperationNativeCopyPlan` verwendet vorhandene Source-Evidence, Pfadplaner, Mixed-Batch-Compiler und Bounds. `decodeWorkspaceOperationNativeCopyPlan` rekonstruiert alle aus den Inventaren ableitbaren Pfad-/Clone-/Linkbindungen. Inhalts-, Compiler- und Finalgraph-Hashes bleiben historische Daten, bis `assertWorkspaceOperationNativeCopyPlanCurrent` sie gegen frisch geprüfte, abgetrennte native Source- **und** Destination-Bytes reproduziert. Virtuelle Clonekeys sind keine dauerhaften Dokumentidentitäten oder ausführbaren Clone-Referenzen. JSON enthält keine Yjs-Binärzustände oder Legacy-Markdownfelder; aktuelle Actor-/ACL-/Claim-/Raum-/SQL-Autorität bleibt Aufgabe des späteren echten Koordinators.

[native-copy-historical-receipt.ts](../app/lib/collaboration/native-copy-historical-receipt.ts) ergänzt `readNativeCopyReceiptStorageIdentityOnConnection` und `readHistoricalNativeWorkspaceCopyReceiptOnConnection`. Der neue historische Leser verlangt eine vom Aufrufer gehaltene PostgreSQL-Transaktion `REPEATABLE READ READ ONLY`, pinnt Storage-/Schema-/Tabellen-/Triggeridentität sowie Backend-/Transaktionszeugen und prüft die ursprünglichen Actor-, Session-, Organisations-, Request- und Publikationsbindungen. Er liest ausschließlich veröffentlichte Originalreceipts; keine aktuellen Yjs-/Registry-Zeilen, Rowlocks, XID-Allokation, eigene Verbindung oder Transaktion. Fehlende Operation liefert `null`, unbestätigte Publikation einen Konflikt. Aktuelle Rechte und Ausführungszulassung werden dadurch nicht erteilt. Der bestehende Copy-Reader bleibt unverändert.

Die additive [Copy-Ledger-Migration](../app/lib/db/collaboration-native-copy-migration.ts) schützt den gesamten ursprünglichen Zeilenkörper gegen Update/Delete. Nur zulässige Fortschritte von `publication_status` bleiben möglich; veröffentlichte Receipts können nicht zurückgestuft werden. Die ursprüngliche Copy-/Restore-Publikation bleibt damit nutzbar. Der historische Leser begrenzt kompakte Receiptdaten auf 8 MiB und den tatsächlichen PostgreSQL-JSONB-Text auf 16 MiB; die SQL-Payloadabfrage wiederholt die Schranken vor der Übertragung.

## Tatsächlich vorliegende Prüfungen

| Prüfung | Belegter Stand |
| --- | --- |
| Neue [Copy-Plan-Folge](../scripts/workspace-operation-native-copy-plan-test.ts) | 27/27, keine Fehler/Skips; ursprünglicher eigener Lauf Session6758 und unabhängiger Root-Lauf Session46162 Exit 0. Nach reinem Test-Typfix nochmals Session68524 Exit 0, unverändert 27/27. |
| Scoped ESLint | Eigener Lauf Session76342 und Root Session79590 jeweils Exit 0; nach dem Test-Typfix Session51409 ebenfalls Exit 0. |
| Neue [History-PG18-Folge](../scripts/native-copy-historical-receipt-postgres-test.ts) | 18 Familien, tatsächlicher Child-Exit 0 im Runner6357. |
| Unveränderte [Original-Copy-PG-Folge](../scripts/collaboration-native-copy-postgres-test.ts) | Tatsächlicher Child-Exit 0 im selben seriellen Runner. |
| Unveränderte [Original-Backup-PG-Folge](../scripts/workspace-operation-native-backup-postgres-test.ts) | Tatsächlicher Child-Exit 0 im selben seriellen Runner. |
| Vollständige Typprüfung | Session91398 tatsächlich Exit 2: vier neue Test-Typfehler durch absichtliche Mutation produktiver `readonly`-Typen. Nach ausdrücklicher Typisierung dieser veränderlichen Testfixtures besteht der vollständige cachefreie Wiederholungslauf Session80174 mit tatsächlichem Exit 0; produktive Guards unverändert. |
| Gesamt-Runner / Ressourcenabschluss | Runner6357 endet trotz dreier erfolgreicher Childprozesse mit Exit 1 beim abschließenden Health-Fetch (`TypeError: fetch failed`). `results.json` wurde nicht geschrieben. Der getrennte unabhängige Postcheck endet mit Exit 0; der Originalrunner bleibt fehlgeschlagen. |

Die Copy-Plan-Folge verwendet echte lokale Yjs-Zustände für Plain/XML/Blocks, leere Sequenz-0-Dokumente, mehrere Roots, interne/unveränderte externe Ziele, Displayalias/Fragment, unveränderte Source-/Destination-Backlinks, Assets/Ordner/native-only sowie neu signierte Fälschungen, Scope-/Byteänderungen, Bounds und unveränderliche Erfassung. Deklarierte Registry-/FS-Beobachtungen erteilen keine Rechte. Plain-Inventare erfassen lokale Links; der externe Literaltext wird dort zusätzlich über den vollständigen erwarteten semantischen Compilerinhalt geprüft.

Die History-Folge enthält echte ursprüngliche Clone-/Publikationsläufe für Plain/XML/Blocks und Legacy-Block-ID-Wörterbücher. Spätere Text-/Pfad-/Archivzustände und D2/S2 werden anschließend **direkt als SQL-Fixture** hergestellt; sie sind keine Ausführung oder öffentliche Abnahme von Move/Delete. Die 106000 UUID-Mappings und 1001 Scopes sind ausdrücklich gespeicherte **Formatfixtures**, keine Behauptung eines solchen nativen Blockclones oder öffentlich ausführbaren Copy-Batches. Die Mappingfixture misst 8268862 kompakte Bytes gegenüber 8480895 tatsächlichen JSONB-Textbytes. Die ursprüngliche DDL erlaubt im isolierten Gegenbeispiel ein Update; die additive DDL verweigert es mit `55000`. Beide Gegenbeispieltransaktionen werden zurückgerollt.

Originale Runnerbelege liegen privat unter:

`/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-native-copy-foundation-nccoc5i8/`

Insbesondere bleiben die drei `*.ts.log`, `before.json` und der fehlgeschlagene Originalabschluss erhalten. Der anschließend unabhängige Nachcheck (`independent-audit-2fQQwG/postcheck.json`, SHA-256 `4f09c92b6d1633d4013181331744f07d61c46c9d733be7539ca37e2c7625b432`, tatsächlicher Exit 0) bestätigt alle sieben ursprünglichen Sourcepins, bytegleiche Originaldateien, vier unveränderte gesunde Managedcontainer und drei neue HTTP-200-Proben. Alle drei vollständigen generierten Testschemapräfixe sind in einer echten RO-RR-Abfrage leer; benannte Fixtureverbindungen fehlen ebenso wie unbenannte Adminverbindungen im gebundenen Runner-/Childzeitfenster. Der Checker ist geschlossen, seine XID blieb null. Die erste Liveabfrage war bereits leer: ursprüngliche konkrete Schema-UUIDs/OIDs wurden deshalb nicht nachträglich behauptet. Nur der eigene DATA-Ordner wurde nach Identitäts-/UID-/Symlinkprüfung inventarisiert und entfernt. Der separate Abschluss schreibt den fehlgeschlagenen Originalrunner nicht um; `results.json` bleibt abwesend. Der vollständige cachefreie TypeScript-Lauf auf dem korrigierten Teststand ist anschließend ebenfalls mit Exit 0 abgeschlossen (Session80174).

Die beiden eingefrorenen Copy-Plan-Dateien nach dem Test-Typfix und bestandener vollständiger Typprüfung:

| Datei | SHA-256 |
| --- | --- |
| Copy-Plan | `c2189624d132ad07f06290766fe41d35e0e1b7a69ffa0b7c14f0f63f7613d7ca` |
| Copy-Plan-Test | `76cfcb9ec553172674767bb5f155dd94850e9c82ec89866cbc03f21e4fca4f64` |

## Verbleibender Copy-Anschluss

Der vorhandene Copy-Koordinator muss den privaten Plan später an echte aktuelle Rechte, einen ursprünglichen dauerhaften Auftrag und die realen Source-/Destination-Fences binden. Frische Clone-Receipts/Inventare und Block-ID-Zuordnungen müssen Original-Linkrezepte über den vorhandenen Rebinding-Baustein auf tatsächliche neue Identitäten übertragen; danach ist der wirkliche Ergebnisgraph zu prüfen. Physische Veröffentlichung, Metadatenpolitik, Originalreceipt-Recovery und Retry bei späterem D2 müssen integriert geprüft werden. Diese Etappe aktiviert keine dieser offenen Ausführungsschritte und startet keinen Build, Browser oder Container. Haupt- und [Zentralplan](./central-notebook-file-api-import-plan.md) werden getrennt fortgeschrieben.
