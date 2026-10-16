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

Die unveränderte ursprüngliche 20er Delete-Regression gegen die v6-Produktquellen besteht mit tatsächlichem Exit 0 und vollständiger eigener Bereinigung (`original-delete-v6.log`, SHA-256 `e97158ae715639e6f5d29dfbe3ee7993485b6afd1f6ea38c1d377ac17787e0b1`). Die cachefreie vollständige Typprüfung und Scoped ESLint für alle 21 betroffenen TypeScript-Dateien bestehen. Die gezielten Planer-, Storage-, Effekt- und Executorfolgen bestehen mit 28/142/12/10 Prüfungen. Frischer Produktionsbuild und Browserabnahme dieses neuen eingehenden Linkanschlusses stehen noch aus. Frühere Browsererfolge werden dafür nicht umgedeutet.

Move/Copy, mehrere Delete-Ziele sowie ein allgemeiner Fallback auf gewöhnliche physische Markdown-Quellen sind hier nicht abgenommen. Die vollständige Datei-/Linkanforderung bleibt im [zentralen Plan](./central-notebook-file-api-import-plan.md) offen. **Dateiaktions-Undo bleibt für alle Dateitypen ausgeschaltet**; gespeicherte Inversrezepte aktivieren weder Undo noch Restore. Review Center bleibt ausgeschaltet. Diese Etappe behauptet keine Veröffentlichung oder Produktionsabnahme.
