# Native Dateiaktionsbelege: unbekannte Versionen abweisen

Stand: 15. Oktober 2026, Ausgangsbasis `de6c155567`. Dies schließt einen konkreten Formatfehler vor dem weiterhin offenen Dateiaktions-Koordinatoranschluss.

Die beiden Reader in [native-file-operation-handoff.ts](../app/lib/markdown/native-file-operation-handoff.ts) decodierten JSON als `NativeFileOperationReceipt`, ohne dessen Version zu prüfen. Auch der [Deferred-Endstatevalidator](../app/lib/db/native-file-operation-handoff-migration.ts) prüfte weder Receipt- noch Bundleversion. Gültige Prüfsummen und ein vollständiger Receiptset-Beleg bestätigen Inhaltsbindung, aber keine unterstützte Formatversion.

Beide Reader verwenden jetzt denselben privaten Decoder für ein JSON-Objekt mit eigenem numerischem `version:1`. Unbekannte Version oder ungültiges JSON führen zu `NATIVE_FILE_RECEIPT_UNCONFIRMED`. Der SQLvalidator verlangt vor der weiteren Interpretation numerische Version 1 bei Receipt und Bundle; andernfalls SQLSTATE `23514`. Bestehende unveränderliche Zeilen werden nicht umgeschrieben. Die normale Bundleaufnahme prüfte die Version bereits und bleibt erhalten.

Die unabhängig ergänzte [PG18-Gegenprobe](../scripts/native-file-operation-handoff-postgres-test.ts) verändert bei einem ausdrücklich gebundenen eigenen Test-INSERT ausschließlich die Version und deren tatsächlichen Digest. Ursprüngliche Admission-, Claim-, Quiescence-, Outcome- und Triggermechanik bleiben aktiv. Die 19 Formatfälle bestehen aus:

- Numerischem v1 sowie fehlender, textueller `"1"`, zukünftiger `2` und `null`-Version, jeweils beim Applied-Reader, beim Committed-Reader und an der Deferred-SQL-COMMIT-Barriere.
- Vier ungültigen Bundleversionen an der tatsächlichen Capture-/Stage-Eingangsprüfung, jeweils ohne gespeicherten Intent.

Die Applied-Readerfälle laufen unter echter SAME-Connection-Mutationsautorität und rollen zurück. Die Committed-Readerfälle prüfen innerhalb der tatsächlichen Admissiontransaktion nach deren `status=committed`/Outcome, aber vor SQL-COMMIT, und führen anschließend ausdrücklich ROLLBACK aus. Sie beweisen Formatprüfung, keine COMMIT-Dauerhaftigkeit. Die getrennten SQLfälle verlangen einen tatsächlichen COMMIT-Versuch: v1 dauerhaft vorhanden, ungültige Version mit echtem `23514` abgewiesen und ohne Receipt beziehungsweise Pfadänderung. Eine beliebige Setupausnahme zählt nicht als erfolgreiche Verweigerung.

Identische finale Testbytes, SHA-256 `3789b5c3a239b1bc1c96b373a4d049b668ce8f3b9fc4a7fb8cc74018ca9f94fa`: vor der Korrektur tatsächlich Exit 1, genau zwölf ungültige Receiptfälle fehlgeschlagen, sieben Kontrollen bestanden; danach tatsächlich Exit 0, 19 von 19 bestanden. Die bisherigen Handoff-Fälle einschließlich kombiniertem Link-/Pfadupdate, nicht exportierbarem Rich-Dokument, Rollback und verlorener COMMIT-Antwort bleiben ebenfalls bestanden. Die vorhandenen vollständigen Nebenwirkungs- und Restore-PG18-Matrizen bestehen auf den geänderten Receiptreader-/DDL-Bytes.

| Produktquelle | Vorher SHA-256 | Nachher SHA-256 |
| --- | --- | --- |
| Native Handoff | `698f7750184349f69ce7620c1f92134dadbcd01e77761eb729f01de1a1dfa0c5` | `202a01fd89b44626617db99358209945be8abef7bc8623d083fc053909368e4a` |
| Handoff-DDL | `c3b92e5f685b190d8de13aa0f2c75884a682bb58c19d1b578979b54e896c025d` | `a4f25d8a179614d80f9c563955d1aa63209fd58c3e4a609a9b47665e225e33a0` |

Der zusätzliche globale Starttest deckte einen unabhängigen [Schemafehler der Main-Agent-Migration](./postgres-main-agent-schema-isolation-evidence.md) auf. Er wurde gegen den unveränderten QA-Stand bestätigt und separat korrigiert. Danach bestehen sowohl der vollständige echte PG18-Start als auch der vollständige PGlite-Start einschließlich wiederholter Migrationen. Die privaten Testschemas/Verbindungen werden durch die ursprünglichen Fixtures abgeschlossen; die PG18-Startfixture bestätigt die tatsächliche Entfernung ihres eigenen Schemas.

Reproduzierbare Handoff-Prüfung benötigt die vorhandene private lokale PG18-Konfiguration:

```sh
CANVAS_NATIVE_FILE_HANDOFF_TEST_ENV_FILE=/absolute/private/notebook-host-dev.env \
  CANVAS_MCP_DIRECT_ENABLED=false BETTER_AUTH_BASE_URL=https://canvas.test \
  npm run test:files:native-handoff:postgres
```

GitNexus meldet für die beiden Reader LOW, einen beziehungsweise zwei direkte Aufrufer und keine erfassten Prozesse; die Konstante der DDL hat im Graph keine Aufrufer, ihr tatsächlicher globaler Startanschluss wurde zusätzlich im Quellcode geprüft. Der unabhängige Quellenreview findet keine konkreten P1/P2 am Produktdiff oder den neuen Gegenproben.

Vollständiges TypeScript ohne inkrementellen Cache mit 8 GiB und fokussiertes ESLint bestehen auf dem kombinierten finalen Quellenstand einschließlich der separaten Schema-Korrektur, jeweils mit tatsächlichem Exit 0. Beide neuen Gegenprobendateien behalten zwischen RED, GREEN und diesem Abschluss ihre gebundenen Hashes.

Diese Korrektur installiert weder einen nativen Dateiaktions-Domainadapter noch einen neuen öffentlichen Receiptvertrag. Der aktuelle normale Move/Delete-Eingang läuft über den direkten Batchpfad; Copy verliert im alten Vorschau-/Stagingvertrag noch native Belege und benötigt Clone-Link-Rebinding. Versioniertes Staging, physisches Publikations-/Recoveryjournal, kooperative normale Metadata-/Guest-/Public-/Lock-Writer, Undo und betroffene öffentliche Consumer bleiben vor der integrierten Aktivierung erforderlich. Der bestehende Browserpass auf Root `a1fc2a0b8` / QA `16e2a920d` enthält diese spätere Korrektur nicht. `executionReady:false` und das allgemeine deaktivierte Sessiongate bleiben erhalten.
