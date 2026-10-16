# Nativer Einzel-Delete mit eingehenden Linkänderungen

Stand: 16. Oktober 2026. Diese Etappe erweitert den bestehenden nativen Original-Delete um eingehende Unlinks in anderen nativen Quelldokumenten. Acht erfolgreiche PG18-Familien belegen den internen Claim-/Owner-Ablauf. Der abschließende frische Build und die reguläre Desktop-/Mobile-Web-Browserfolge bestehen mit 7/7 Fällen einschließlich beider neuen Link-Delete-Fälle. MCP-/Agentadapter und breitere Dateioperationen sind damit noch nicht abgenommen. Maßgeblich sind die nachfolgend jeweils gebundenen Produktquellen und tatsächlichen Laufbelege.

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

## Begrenzter Diagnoseanschluss für den nächsten Folgelauf

Der Owner protokolliert bei einem tatsächlichen Phasenfehler vor Rollback und weiterer Fehlerverpackung jetzt die bereits gebundene Backend-PID, eine lokale Phasennummer, Beginn/Dauer, Anzahl tatsächlich weitergereichter B-Abfragen sowie feste Stage-/Relationslabels. Der Fehlercodebaum ist auf 16 Knoten und Tiefe vier beschränkt und liest ausschließlich eigene Datenfelder mit einer endlichen Codeliste; Rohmeldungen, SQL, Parameter, Dokumenttext, Pfade und Zugangsdaten werden nicht ausgegeben. Logging oder Serialisierung können den ursprünglichen Fehler nicht ersetzen. Öffentliche Fehlersemantik, Rückgaben, Transaktionen, Pending-Drain, Rechteprüfungen und Zeitgrenzen bleiben unverändert. Der Anschluss behebt den Delete-Fehler noch nicht.

Die tatsächliche ursprüngliche Owner-/Principalfolge besteht mit 30/30 Familien und vollständigem eigenen Ressourcenabschluss (`owned-job-principal-v2.log`, SHA256 `44bdf97c1bec8d0a70f6aae2c6c0482088e47b0b0b120e6ce387d622b649eefa`); die 12 Filter-/Neverthrow-Prüfungen bestehen ebenfalls (`pure-diagnostics-v2.log`, SHA256 `8c19e82e4ec0e1d9a826df5fae7bda008f0a3ffcb73990438987e9de18f7eccc`). Beide Protokolle liegen im privaten Verzeichnis `canvas-file-delete-phase-diagnostic-xmmun3ly`. Nach der PG-Folge wurde ausschließlich die Logausgabe auf vollständiges JSON umgestellt, damit tiefe Cause-Codes nicht durch Node-Inspect gekürzt werden. Cachefreie vollständige Typprüfung, Scoped ESLint und unabhängiger Quellreview bestehen.

Eine zuvor irrtümlich ausgewählte historische kombinierte Delete-/Undo-Scheduling-Folge endet wegen der ausdrücklich ausgeschalteten Undo-Funktion mit `FILE_OPERATION_UNDO_DISABLED`, ohne bestandene Familie. Sie bleibt unverändert und wird nicht durch Aktivieren von Undo oder veränderte Erwartungen passend gemacht. Dieses Ergebnis ist kein fehlgeschlagener Owner-Sicherheitsnachweis. Frischer Build und Browserdiagnose des neuen Anschlusses sind als nächster Schritt erforderlich.

## Zweiter tatsächlicher Browserlauf: Desktop-Link-Delete bestanden, mobiler Testweg offen

Der frische Originalbuild auf Root `d291e6c7e815bcf8bb65e08a47d32a3a547cb216` / QA `965751433fd3e25eaeaf57eee20adca31e3a9ef2` endet mit Exit 0. Source-Fingerprint `bc57ff500b361c0d79d5ef54fa17df8d256a6007907ba7aaa0483bc19342672c`, Build-Fingerprint `ad4e4e8fbba5ef87b6dcc53599e38919390d7a9454ad881b6c6193d02e26efc9`, Proof-SHA256 `a893c8848ab44eb8ae68ccfac1877581ff8c13588b338e76848baaa957915708`. Der unveränderte Supervisor beendet die tatsächliche Folge mit Exit 1: **sechs von sieben Fällen bestanden**, ein Fehler, keine Testtimeouts, Skips oder Unterbrechungen.

| Browserfamilie | Tatsächliches Ergebnis |
| --- | --- |
| Datei-Undo ausdrücklich aus, Desktop/Mobile | 2/2 bestanden |
| Sofort editierbare Starterdokumente, Desktop/Mobile | 2/2 bestanden |
| Editorfokus/Breite/Tabelle einschließlich abschließendem Delete | 1/1 bestanden |
| Neuer nativer Delete mit eingehenden Links, Desktop | 1/1 bestanden; echter Markdownimport, Raumfreigabe, UI-Delete, Linkreceipt, Erhalt unabhängiger Links und vollständiger nativer Richvergleich nach frischem Wiederöffnen |
| Derselbe neue Fall, Mobile Web | Vor Einfügen und Delete fehlgeschlagen: Desktop-Insert-Button bei 390 px absichtlich unsichtbar |

Die unabhängige Nachprüfung bestätigt unveränderte Originalhelfer, Adapter, drei bisherige Specs, die beiden neuen engen Adapter und den tatsächlichen Build. Originalreports und Recoverybelege der eigenen Fixture `canvas-yjs-authority-JnoNkm` bleiben unverändert (`preserved`, `passed:false`, `uncertain:true`). Parentlog-SHA256 `0076c43ebf6441196f0b8b272259cb15c305a27b2b6127bc2a9b6907e66615ab`, Postruntime-Audit `67e55e31649ff32743df64d902a63eee9f00098ddf4cc792411933ef455a65c1`. Dieser Lauf belegt weder einen mobilen Link-Delete noch eine vollständige Abnahme.

Der mobile Trace bestätigt erfolgreichen Editor-Readiness- und Leerinhaltcheck unmittelbar vor dem falschen Desktop-Klick. Die Spec wird ausschließlich an den bereits vorhandenen mobilen Markdown-Einfügetest angeglichen: Editor antippen, den Tastaturbereich durch 390×544 emulieren, den sichtbaren direkten Button antippen und danach 390×844 wiederherstellen. Produktcode, fachliche Assertions, Zeitgrenzen und Originalhelfer bleiben unverändert. Die Tastatur-/IME-Funktion eines echten Mobilgeräts wird damit nicht behauptet.

Der vorherige Focus-Delete-Timeout tritt diesmal nicht auf; im Hostprotokoll entsteht kein neuer Owner-Phasenfehler. Die zusätzliche Diagnose ist deshalb noch kein Beleg für die genaue ursprüngliche Ursache oder deren Behebung. Es wird keine vorsorgliche weitere Archiv-/Timeoutänderung vorgenommen.

Die eigene fehlgeschlagene Fixture `canvas-yjs-authority-JnoNkm` ist anschließend ebenfalls separat geschlossen (tatsächlicher Exit 0, Abschluss-SHA256 `61084ed9d40275e67045a711c9381aff15140dd1d89323d73dcbffe2113de18f`). Frische exakte Besitzprüfungen, null Sessions, geschlossene Prozesse/Gruppen/Ports und freier Runlock gehen der Entfernung ausschließlich eigener Datenbanken und DATA/tmp voraus. Kein FORCE und keine Veränderung der ursprünglichen fehlgeschlagenen Receipts; die drei verwalteten HTTP-Healthchecks bestätigen danach 200. Der korrigierte mobile Testweg ist zu diesem Zeitpunkt noch nicht erneut ausgeführt.

## Separater Ressourcenabschluss des ersten fehlgeschlagenen Laufs

Die oben historisch als aufbewahrt beschriebene Fixture `canvas-yjs-authority-PTHBRx` wurde inzwischen nach einer privaten, an ihre tatsächlichen Datenbankidentitäten gebundenen Read-only-Sicherung separat geschlossen. Snapshot-SHA256 `cbcfb8fe95bddbac95e3bc766a2ce9e106357be68bb55dec5d1ca34f9f21d23d`; Abschluss-SHA256 `1a1204c4cf5464fd3bcc72877d70728eb67e748d67af9cc987bd056c8ea32902`. Vor jedem DROP wurden exakter Datenbankname/OID, Owner, Besitzmarker und null Sessions frisch geprüft; kein FORCE und kein Beenden fremder Verbindungen. Eigene Prozesse/Gruppen, drei Ports und Runlock waren geschlossen; ausschließlich eigene DATA/tmp wurden entfernt. Originale fehlgeschlagene Receipts und Reports bleiben bytegleich. Die drei verwalteten HTTP-Healthchecks bestätigen danach weiterhin 200.


## Abschließender frischer lokaler Build und Browserpass

Der frische Originalproduktionsbuild auf Root `516f9245c66b70fc8252041ec18c20acd26fd1f6` / QA `5b0f23451998b1e2c83d9dd94308ca7243ed0f9e` endet mit tatsächlichem Exit 0. Der einzige neue ausführbare Unterschied zum vorherigen Lauf ist der mobile Bedienweg der neuen Spec; sämtliche Produktdateien, Originalhelfer, fünf bisherigen Adapter, drei bisherigen Specs und beide neuen engen Raumadapter bleiben bytegleich. Neue Spec-SHA256 `723da17f34bbb57fa53c64eacc2a5f2fbe712ca17c6888f00aab53be960d1c2a`. Die beiden Heads enthalten zusätzlich die dokumentierte Entfernung von Datei-Undo aus den Liefergates.

- Source-Fingerprint: `aaa3b1e23636155a8faac4eb3ff09b90aa3d46312693e140b043668beaa5522d`.
- Build-Fingerprint: `77078dfe4cf387e80ee6ba3e03844a31131fa3be23177c706df3e9d260e094fe`.
- Build-Proof-SHA256: `9180ac93690a420c182d5c9c6bbb9edc798fa0013eab2e033f6575d9c0a2a9c2`.
- Build-Parentlog: `f58a6f0583ab6f142cd38a399a8347a331664a2bbda106e1e7d227c0980d0bce`.
- Runtime-Parentlog: `4a77586f3346bcfa76762c6b7296120c592ccfbe932ab0fe2bd42f1517ec8e4a`.

Der unveränderte Originalsupervisor endet mit tatsächlichem Exit 0: vier Specs, **7/7 bestanden**, null Fehler, Skips, Testtimeouts und Unterbrechungen. Undo-Abschaltung und Starter bestehen jeweils 2/2, Editorfokus/Breite/Tabelle einschließlich abschließendem Delete 1/1, neuer nativer Link-Delete Desktop/Mobile 2/2. Beide neuen Fälle verwenden echte Zwischenablage/Markdown-Insertion, tatsächliche Raumfreigabe, den regulären UI-/API-/Worker-Delete und einen frischen Browserkontext. Das gelöschte Ziel ist per Read 404, der Linkreceipt meldet exakt eine Änderung, das andere Ziel bleibt unverändert. Der vollständige native ProseMirror-Baum entspricht dem ursprünglichen Baum abzüglich ausschließlich des Ziellinkmarks; Beschriftung, Fettdruck, Heading, Tabelle, übriger Link und Attribute bleiben erhalten. Die beiden tatsächlichen Screenshots wurden zusätzlich visuell geprüft. Mobile Tastaturgeometrie ist emuliert; kein nativer OS-/IME-Nachweis.

Unabhängiger tatsächlicher Postbuild-/Preruntime-Audit-SHA256 `1db9d2af76223f22862c66ed105273d7b841d9529ad0ba68437cb07cdeb3396b`, unabhängiger Postruntime-Audit `8bd6ea7a694db663b85f0a33af9c9904993fa4d5837a807d50c57c8ad80332c9`. Jeweils originaler Buildguard und separate Quell-/Build-Fingerprints; beide Reportsätze, Quellenpins, saubere Heads und die drei bekannten Root-/QA-Abweichungen sind bestätigt. Der Postruntime-Audit prüft zusätzlich den Originalreportguard auf allen vier wirklichen Reports. Die früheren fehlgeschlagenen Läufe bleiben unverändert RED.

Eigene Fixture `canvas-yjs-authority-g3vsmo`: Originalreceipt `cleaned`, `passed:true`, `uncertain:false`, alle vier Specs abgeschlossen, beide eigenen Datenbanken und DATA entfernt. Eine danach tatsächlich ausgeführte frische rein lesende Ressourcenprüfung endet mit Exit 0 (SHA256 `253d1e6fae2ea17547a92f9d2e746b2efb6606a3611de6b72e2901547a9a561e`): eigene PIDs/Gruppen und drei Ports fehlen, Runlock ist frei, beide exakten Datenbanknamen/OIDs und zugehörige Backends fehlen, eigene DATA/tmp fehlen und die Prüfverbindung ist geschlossen. Alle drei verwalteten Healthchecks liefern 200. Originalreceipts und Reports bleiben unverändert; die Prüfung führt keine Cleanupmutation aus.

Die cachefreie vollständige Typprüfung mit 8-GiB-Node-Heap und Scoped ESLint bestehen. Der erste zusätzliche Typprüfversuch mit dem Node-Standardheap brach mit Exit 134 wegen Speichermangel ab; die vollständige Wiederholung endete ohne Typfehler mit Exit 0. Es gab keine Lockerung fachlicher Assertions, Zeitgrenzen oder Produktguards.

Diese Abnahme schließt ausschließlich den beschriebenen lokalen Einzel-Delete-Anschluss. Move/Copy, mehrere Ziele, gemischte/noch nicht importierte Quellen, vollständige Syntax-/Offene-Raum-Matrix, MCP-/Agentadapter, SDK/Skill/Suche/PDF und Gesamtintegration bleiben gemäß zentralem Plan offen. Datei-Undo und Review Center bleiben aus. Der ältere Delete-Timeout ist in beiden Folgeläufen nicht aufgetreten; seine genaue ursprüngliche Ursache bleibt ungeklärt. Kein Produktionsrollout.
