# Nativer Einzel-Delete mit eingehenden Linkänderungen

Stand: 16. Oktober 2026. Diese Etappe erweitert den bestehenden nativen Original-Delete um eingehende Unlinks in anderen nativen Quelldokumenten. Acht erfolgreiche PG18-Familien belegen den internen Claim-/Owner-Ablauf; sie sind noch keine Abnahme der regulären UI-, API-, MCP- oder Agent-Dateiaktionen. Maßgeblich sind die unten referenzierten eingefrorenen Produktquellen, nicht allein der vorausgehende Commit `d2cc98fb0`.

## Enger Ausführungsvertrag

- Ein echter ursprünglicher Direct-/Apply-Claim bindet Plan, Actor, Anfragehash und vollständigen Workspace-Scope. Der V2-Plan enthält genau einen Delete und die aus dem vollständigen nativen Quellbestand ermittelten eingehenden Unlinks. Ziele und Quellen werden anhand ihrer ursprünglichen nativen Identitäten und Zustandsbelege gebunden.
- [Vorbereitung und Originalintent](../app/lib/files/workspace-operation-original-delete.ts) speichern die tatsächlich vorbereiteten nativen Änderungen vor der physischen Phase unveränderlich. Dabei werden die Größen des Intents und der vorgesehenen Completion geprüft. Die Änderung schreibt Yjs-Zustände; sie editiert keine Markdown-Projektion als Dokumentautorität.
- Dieselbe tatsächliche Owner-Verbindung B hält die aktuellen Rechte-, Claim-, Schema-, Admission-, Raum- und Pfadfences. B2 verbindet die Quellen-CAS samt Linkreceipts mit ursprünglicher nativer Archivierung, bestehendem Public-Nebeneffekt, Trash und Completion in einer Transaktion. Ein vor COMMIT zurückgegebener DAL-Beleg bestätigt noch keinen dauerhaften Abschluss.
- Die Completion enthält die tatsächlichen Linkreceipts einschließlich Quellenbindung, Vorher-/Nachherzustand, Containmentsnapshot und Inversrezepten. Fortschritt und Ergebnis zählen einen Delete plus ein Link-Schritt je geänderter Quelldatei. `updatedLinks` stammt aus deren geprüften Receipt-Rezepten; V1-`previewContents` oder `linkEdits` werden dafür nicht erfunden.

## Zwei feste interne Owner-Methoden

Die gewöhnliche beschränkte SQL-Fassade bleibt unverändert. Die [Ownerhülle](../app/lib/files/workspace-operation-job-lifecycle-owner.ts) ergänzt ausschließlich zwei feste Operationen auf ihrem privaten B:

1. `readOriginalNativeDeleteSources()` nimmt keine Parameter an. Sie liest ausschließlich den aktuell autorisierten Workspace des echten Claims über den bestehenden Quellcollector. Sie gibt weder eine Verbindung noch eine neue Mutationsberechtigung zurück.
2. `applyOriginalNativeDeleteLinks(expectedIntentDigest)` akzeptiert weder SQL noch vorbereitete Bytes oder einen Callback. Sie liest den tatsächlichen eigenen, qualifizierten Intent anhand der ursprünglichen Batch-ID, prüft Digest, Actor-/Scopebindung und Mitgliedschaft der Quellen und Rezepte im echten Claimplan. Der bestehende Borrowed-DAL führt die gespeicherten Änderungen aus. Aktuelle Authority wird vor jeder Quelle, auch beim Receipt-Retry, und unmittelbar vor jedem CAS geprüft.

Beide Operationen laufen im bestehenden getrackten Dispatch mit Owner-, Principal-, Storage- und Fenceprüfung vor und nach dem Aufruf. Pending-Drain, Poisoning, begrenzte Phasen sowie COMMIT-/Rollback-/Disposalbehandlung bleiben erhalten. Raw-B und frei wählbare Ausführungscallbacks werden nicht herausgegeben.

## Tatsächlicher lokaler Erfolgsnachweis

Die echte Fixture [workspace-operation-native-delete-links-postgres-test.ts](../scripts/workspace-operation-native-delete-links-postgres-test.ts) besteht in v6 in vier getrennten Gruppen mit jeweils tatsächlichem Exit 0 und **2/2 Familien, insgesamt 8/8**. Personal verwendet echte Cookie-, Team echte Bearer-Anmeldung. Workspaceanlage samt zentraler Startdokumentinitialisierung, Originalimport, tatsächliche aktuelle Rechte, Storeclaim und Ownerausführung werden verwendet; der allgemeine Worker wird in dieser Fixture nicht ausgeführt.

Die beiden Erfolgsfamilien prüfen je drei eingehende Quellen: `plain_text`, `tiptap_xml` und `tiptap_blocks`. Deren Ziellinks verschwinden aus dem tatsächlich persistierten nativen Inventar; die Links zum unabhängigen anderen Ziel bleiben erhalten. Geprüft werden die tatsächlichen SQL-Linkreceipts, Sequenz-/Vector-/Snapshotbelege, ursprüngliche Zielarchivierung, gemeinsames Trash/Completion und die vollständigen Storezähler. Das unveränderte unabhängige Zieldokument wird gesondert verglichen. Der erfolgreiche Fall enthält zudem einen nativen Zielpfad mit ausschließlich virtuellen, physisch fehlenden Elternverzeichnissen.

Die drei Fehlergruppen verwenden jeweils eine echte `plain_text`-Quelle in beiden Workspacetypen:

| Gruppe | Tatsächlich geprüfter Verlauf |
| --- | --- |
| `--drift` | Quellenänderung nach Originalintent wird abgewiesen; keine Link-/Archive-/Trashcompletion. Fremde Änderung und ursprünglicher Intent bleiben erhalten. |
| `--rollback` | Tatsächlicher Fehler nach Linkreceipt-Anlage rollt B2 zurück; frische Jobübernahme verwendet dieselben vorbereiteten Intentbytes und schließt erfolgreich ab. |
| `--ack` | Tatsächlich ausgeführter B2-COMMIT mit verlorenem ACK führt zu unbestätigtem Ausgang und Discard. Frische Jobübernahme bestätigt denselben Completionbeleg; ein späterer tatsächlicher Peeredit bleibt unverändert erhalten. |

| Finale B2-Phase | Dauer | Weitergereichte SQL-Abfragen |
| --- | ---: | ---: |
| Personal | 2.902 ms | 2.401 |
| Team | 3.115 ms | 2.484 |

Originalprotokolle liegen unter `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-native-delete-links-pg-q_gqfjp2/`. Die 13 tatsächlich getesteten, zwischen den vier Gruppen unveränderten Produktdateien sind in `product-source-pins-v6.json` festgehalten. Alle vier Protokolle bestätigen entfernte eigene Schema-/DATA-Fixtures, null eigene offene Clients/Checkouts und den Completionmarker erst nach Bereinigung. Diese Dokumentation enthält keine Zugangsdaten oder rohen Dokumentzustände.

| Protokoll | SHA-256 |
| --- | --- |
| `success-v6.log` | `6d497b7b5e8d18c51b1953168bcec906e6c77717ae127121d85316cf2516658b` |
| `drift-v6.log` | `05054153debc17f72aec47fa4f74af5507128428ae2363963a74e3bf4ecf2f1f` |
| `rollback-v6.log` | `d94a0ebbeaf230d77955b8ae3cdbc55180caffb2d8124c33d77d36d72a6f28e0` |
| `ack-v6.log` | `221bb3c7683d8d41dd11f58d19dd072e6b5b4db62ef846f2ba047c5b6414bb27` |

## Vorheriger Performancefehler und begrenzte Korrektur

Der allein ausgeführte v4-Lauf scheiterte tatsächlich: B2 benötigte 5.007 ms bei 4.247 Abfragen und endete mit SQLSTATE `25P04` samt Rollbackfehler. Die gewöhnliche Fassade führte um jede einzelne DAL-Abfrage erneut vollständige Prüfungen aus; zusätzliche Authority-Aufrufe multiplizierten sie weiter. Die beiden festen Owner-Operationen bündeln ausschließlich bekannte interne Arbeit. Die ursprüngliche **5-Sekunden-Grenze wurde nicht erhöht**, kein Storagegate entfernt und keine gewöhnliche Fassade freigeschaltet. v4 bleibt ein fehlgeschlagener historischer Lauf; v6 belegt die zwei oben genannten Erfolge auf den neuen eingefrorenen Quellen.

## Noch offene Abnahme

Die unveränderte ursprüngliche 20er Delete-Regression gegen die v6-Produktquellen besteht mit tatsächlichem Exit 0 und vollständiger eigener Bereinigung (`original-delete-v6.log`, SHA-256 `e97158ae715639e6f5d29dfbe3ee7993485b6afd1f6ea38c1d377ac17787e0b1`). Die cachefreie vollständige Typprüfung und Scoped ESLint für alle 21 betroffenen TypeScript-Dateien bestehen. Die gezielten Planer-, Storage-, Effekt- und Executorfolgen bestehen mit 28/142/12/10 Prüfungen. Der frische Originalproduktionsbuild besteht auf Root `14a122938d3817f3572780c2a47ca91c226b7266` / QA `f8d8ab58303e9c75c5f4dbb128de26134fa9a184`. Die folgende Browserabnahme ist fehlgeschlagen und unten gesondert beschrieben. Frühere Browsererfolge werden dafür nicht umgedeutet.

Move/Copy, mehrere Delete-Ziele sowie ein allgemeiner Fallback auf gewöhnliche physische Markdown-Quellen sind hier nicht abgenommen. Die vollständige Datei-/Linkanforderung bleibt im [zentralen Plan](./central-notebook-file-api-import-plan.md) offen. **Dateiaktions-Undo bleibt für alle Dateitypen ausgeschaltet**; gespeicherte Inversrezepte aktivieren weder Undo noch Restore. Review Center bleibt ausgeschaltet. Diese Etappe behauptet keine Veröffentlichung oder Produktionsabnahme.

## Tatsächlicher Build und anschließender Browserfehler

Der Originalbuild endet tatsächlich mit Exit 0. Source-Fingerprint `d68ea54f3130e7951ce3b55173e627b49c7bad1f93846ad3d40d369a53a632d9`, Build-Fingerprint `132bcbfed384c799313277bcc144f33b8632751116abacb6b4244595f6744095`, Proof-SHA256 `55c822087d9aefd668a1f8d6fceab3da4910dcd55b101d016d31e4d844a5e4c1`. Unabhängige Prüfungen nach Build und Runtime verwenden den unveränderten Originalguard sowie separate Fingerprints und bestätigen alle 24 Commitdateien, die ursprünglichen Helfer/Adapter/Specs, beide neuen engen Adapter und die drei bekannten Root-/QA-Abweichungen. Die separate Source-Lesung der Integrationsprüfung lief bereits parallel zum Build; sie wird nicht als sicher vor Buildbeginn ausgewiesen.

| Ausgewählte Browserfolge | Tatsächliches Ergebnis |
| --- | --- |
| Datei-Undo ausgeschaltet, Desktop/Mobile | 2/2 bestanden, Markdown und TXT tatsächlich gelöscht und alte Restore-/Undozugänge abgewiesen |
| Neue sofort editierbare Starterdokumente, Desktop/Mobile | 2/2 bestanden |
| Editorfokus/Breite/Tabelle | 0/1; abschließender API-Delete im `finally` überschreitet das unveränderte 15-Sekunden-Requestlimit |
| Neuer nativer Delete mit eingehenden Links | Nicht gestartet; kein Report vorhanden |

Gesamt: fünf gestartete Fälle, vier bestanden, einer fehlgeschlagen, keine als Test-Timeout gezählten Fälle, Skips oder Unterbrechungen. Der Browserfehler ist keine vollständige Browser- oder native Linkabnahme. Die Undo-Familie selbst besteht.

Die fehlgeschlagene eigene Fixture `canvas-yjs-authority-PTHBRx` bleibt mit unveränderten Originalreceipts und privaten Daten für die Diagnose erhalten. Parentlog-SHA256 `75fb4e097deb153c4236ea575ffe0cf53896900edc632459b942b03d02db8c4a`, unabhängiger Postruntime-Audit `e35fc166f4b9b764f515883f5c0153894802398037272009a5e38e13b3ff7a6b`. Das Originalreceipt ist `preserved`, `passed:false`, `uncertain:true`; Datenbanken und DATA sind noch nicht entfernt.

Frische rein lesende Prüfungen bestätigen die tatsächliche Datenbankidentität und deren Besitzmarker: Der Focus-Delete hat einen committed Originalintent, keine Linkrezepte und keine SQL-Completion/Trashreceipt. Die physische Quelldatei liegt bereits im zugehörigen Papierkorb, während das native Ziel aktiv bleibt; der Batch meldet nach 17.121 ms `needs_recovery/BATCH_EXECUTION_FAILED`. Im selben Zeitfenster enthält das PostgreSQL-Protokoll einen `transaction_timeout` um 16:23:43.469 UTC; der Batchabschluss folgt 157 ms später. Die genaue Zuordnung dieser Datenbankverbindung zu einer Ownerphase und die Abgrenzung zum anschließenden Supervisor-Shutdown sind noch nicht gesichert. Der oberste Fehlermapper bewahrt verschachtelte SQL-/Aggregate-Codes nicht. Eine engere Diagnose ist erforderlich; weder das 5-Sekunden-Produktlimit noch Tests oder Originalhelfer wurden gelockert.
