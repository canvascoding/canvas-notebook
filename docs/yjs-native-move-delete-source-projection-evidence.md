# Move/Delete: ursprüngliches Preview nach reiner Quellenprojektion

Stand: 17. Oktober 2026. Die ursprünglichen Gegenproben unten bestätigen denselben Fehler bei Move und Delete: Ein Checkpoint eines **nicht ausgewählten nativen Dokuments mit eingehendem Link** verändert nur abgeleitete Projektions-/Registrydaten. Trotzdem kann der vorher erstellte ursprüngliche Plan anschließend nicht angewendet werden. Je Operation bestehen beide Kontrollen mit Exit 0; der unveränderte Originalplanfall endet tatsächlich mit **Exit 1 und `NATIVE_SOURCE_EVIDENCE_CHANGED`**. Die unabhängigen Ressourcenprüfungen bestehen und ändern diese roten Produktergebnisse nicht.

Die gemeinsame Move/Delete-V2-Implementierung ist auf Root `d8e3d5500583e5d99a454723a930bed0a6cc79b3` / QA `9d4327e72e788d267d34f14af1bdc09330606d2d` implementiert. Die frische Wiederholung besteht **jeweils 3/3** einschließlich des unveränderten ursprünglichen Plans; beide unabhängigen Ressourcenabschlüsse bestehen. Der neue Nachweis folgt unten. Die ursprünglichen roten Artefakte bleiben unverändert erhalten. Die bereits lokal bestandene [Copy10-Abnahme](./yjs-native-copy-browser-pass-evidence.md) bleibt davon getrennt und unverändert gültig für ihre dort bezeichnete Matrix.

## Gebundene Quellen und tatsächlicher Ausführungsumfang

| Repository | Vollständiger gebundener Commit |
| --- | --- |
| Notebook Root | `fa772311a1f8549b5a8a31d88f15729f9796be08` |
| Notebook QA | `87b2baa46492b3666525fa4440f17e9101624cda` |
| Control Plane | `27c8ce37da082244f006ca376068cde6b98845d5` |

Vorbereitung, Ausführung und unabhängiger Abschluss binden diese drei damals sauberen Checkouts. Pro Operation wurden 6.909 reguläre Repositorydateien, 76 explizite Produktpins und sechs native Pins erfasst; Quellen und private Probe blieben bis zum jeweiligen unabhängigen Abschluss unverändert. `node_modules` ist kein einzeln fingerprinteter Bestandteil dieses Nachweises. Die späteren Produktänderungen im nun bearbeiteten Root gehören nicht zu diesen Läufen.

Beide Proben laufen seriell auf der lokalen verwalteten PG18-Umgebung mit jeweils eigenen Schema-/DATA-Fixtures. Sie verwenden echte Dokumentanlage/Import, den tatsächlichen Editor-Persistenzkern, aktuelle Workspace-Rechte über den zentralen Request-Principal, Direct-Batch, Storeclaim und den regulären ursprünglichen Move- beziehungsweise Delete-Owner. Das verwendete wiederverwendbare Fixture erzeugt seinen authentifizierten `NextRequest` unter `/api/files/copy`; hier wird dessen zentraler Principal-Kern aufgerufen. Das ist **keine Prüfung der Move-/Delete-HTTP-Routen**. Vollständiger Editor-HTTP-/WebSocket-Transport, Browser, UI und Produktion wurden in diesen Proben nicht abgenommen.

Private Originale liegen unter:

```text
/private/tmp/cn-move-delete-source-projection-preparation-ledzcxlp/move/
/private/tmp/cn-move-delete-source-projection-preparation-ledzcxlp/delete/
```

Die Probenaufrufe haben keine Retries und ändern nach dem ersten Fehler weder den ursprünglichen Plan noch die Erfolgserwartung. Ein tatsächlicher Originalplanfehler wird mit seinen Beobachtungen gespeichert und erneut geworfen. Die Kontrollvariante mit frischem Plan ist ausdrücklich eine andere Variante.

## Drei tatsächliche Varianten je Operation

| Variante | Verwendeter Plan | Move | Delete |
| --- | --- | --- | --- |
| `no-projector-original-plan` | Preview A; kein zusätzlicher Projector zwischen Preview und Apply | Exit 0, Originaloperation abgeschlossen | Exit 0, Originaloperation abgeschlossen |
| `projector-fresh-plan` | Tatsächlicher Quellencheckpoint; anschließend neu erstelltes Preview B | Exit 0, Originaloperation abgeschlossen | Exit 0, Originaloperation abgeschlossen |
| `projector-original-plan` | Tatsächlicher Quellencheckpoint; **weiterhin unverändertes Preview A** | Exit 1, `NATIVE_SOURCE_EVIDENCE_CHANGED` | Exit 1, `NATIVE_SOURCE_EVIDENCE_CHANGED` |

Move lief vom 17. Oktober 2026, 11:39:05.051 bis 11:40:44.080 UTC; Delete anschließend von 11:41:17.767 bis 11:43:03.131 UTC. Alle sechs vorgesehenen Kindprozesse wurden tatsächlich gestartet. Keiner wurde durch Timeout oder Signal beendet. Beide äußeren Runner enden mit Exit 1, ohne zusätzliche Runner-/Auditfehler.

Vor Preview A wird der native Inhalt einer eingehenden Quelle tatsächlich persistiert. Die Quelle enthält einen Link auf das ausgewählte Ziel und einen unabhängigen weiteren Link. Ihre Markdownprojektion ist zunächst noch nicht auf dem aktuellen nativen Stand. Anschließend veröffentlicht der echte Projector ausschließlich die Quelle; das ausgewählte Ziel bleibt vollständig unverändert.

In beiden Originalplanfällen sind folgende Beobachtungen belegt:

| Beobachtung vor/nach Projector | Tatsächliches Ergebnis |
| --- | --- |
| Native Dokumentidentität, Generation, Repräsentation und Schema | unverändert |
| Vollständige Yjs-Bytes samt SHA, State Vector samt SHA und Snapshot-Proof | unverändert |
| Dokumentsequenz / Persistenzzeit / natives Linkinventar | Sequenz `1 → 1`; Persistenzzeit und Inventar unverändert |
| Registry-`state_version` | `0 → 1` |
| Checkpointsequenz / Pending | `0 → 1`; `true → false` |
| Physische Projektion und rohe Registry-/Checkpointdaten | verändert |
| Ausgewähltes Ziel, unabhängiges Ziel, Starter und Quellenannotation | unverändert |
| Preview A gegenüber neuem Preview B | Plan-ID, bisheriger semantischer Proof, rohe Evidenz und Compiler-/Finalgraph-Proofs unterscheiden sich |

Die tatsächliche Ausnahme entsteht in der bisherigen Source-Evidence-Current-Prüfung: Move über `assertWorkspaceOperationNativeMoveBatchPlanCurrent` und den Owner, Delete über `assertWorkspaceOperationNativeDeleteBatchPlanCurrent` und `prepareIntent`. Der erste Fehler ist keine fehlende Quelle, kein fremder Peeredit und kein verändertes ausgewähltes Ziel.

Nach dem fehlgeschlagenen Apply entspricht die eingehende Quelle exakt dem unmittelbar nach dem Projector erfassten Stand; das ausgewählte Ziel entspricht weiterhin seinem Vorherstand. Der tatsächliche Direct-Batch samt Claim existiert, aber es wurden **keine Originaloperationsintents oder Operationsreceipts** angelegt: bei Move null Move-/Pfad-/Eltern-/Completionbelege, bei Delete null Delete-/Trash-/Completionbelege. Es liegt damit keine Move-/Delete-Zustandsmutation durch den Owner vor. Die ausdrücklich ausgelöste Quellenprojektion selbst ist die kontrollierte Vorbedingung.

## Originalartefakte und unabhängig verifizierte Hashes

Die folgenden SHA-256-Werte wurden direkt aus den erhaltenen Originaldateien gelesen. Zusätzlich stimmen alle von den Runreceipts bezeichneten Beobachtungsdateien und Kindlogs mit ihren gespeicherten Hashes überein.

| Datei relativ zum jeweiligen privaten Operationsverzeichnis | Move SHA-256 | Delete SHA-256 |
| --- | --- | --- |
| `ready.json` | `6d292a12d0bfa73fb9fc9ec7213140edef5731684e67625d79ec2e2f26dee9ac` | `ffc76dd37ba3fe3ef9389327bbd711596f27a6aa6b8666fc0a83fa172ff4c527` |
| `manifest.json` | `3a8916b43d5dae33201f5e1c90835bc376bb01171d64e41953908ea20eeccf45` | `6ddba587b032389ba8be4ee5fc6e2e8c3f300b05a8f484e43c44fd329c3b77a4` |
| `source-projector-{operation}-plan-draft.ts` | `69d3d6b133c623100503d5342a822e70391d6982a030f4e02f0faf5cbe6a50cc` | `fb88fff555371d6c9fa08373912d096129af6497714004819e5392c175507719` |
| `results.json` | `d4813bd714c07e59dfcfa78fb05176702814b93653da991b7d8ba87e3fde4f6c` | `e7f6a9628bd7e2721568755024edf41958ba7df1cdd814320de814f4eef0e862` |
| `cases/projector-original-plan/projector-original-plan-observations.json` | `3fb3a0a9b428b61f8853dbc58510e9af053eebe26e82b122dcec28abbdc7b97c` | `f0c7c6ae4a6465e807e0e5bede15a74fe8cb4cdd5f0cdc6c89429b3532a501bd` |
| `projector-original-plan.log` | `2caf4744dab1584915bb4196a9902ad195c9b705bddf40b406de0fc7c68195e0` | `8f14e5511b333864a3a85fdf61dcdf031cbdc36d2b43047a1911f39988fd15d2` |
| `independent-closure.json` | `28a7041a6349ce9b154b27753b0e30225dfe9cde267721f8ae9bdc83c497e406` | `210201759b4b1523e53ec430b3adb3acf2c683530b5fbc5aae06f7800657244f` |

Die unabhängige Move-Prüfung endet um 11:40:53.191 UTC, die Delete-Prüfung um 11:43:30.254 UTC. Beide bestehen tatsächlich mit Exit 0. Sie lesen den Zustand, führen keine nachträgliche Reparatur durch und lassen den ursprünglichen Domain-Exit 1 unverändert.

Alle eigenen Launcher, Runner, Kindprozesse und Prozessgruppen sind geschlossen. Eigene PG-Schemas samt OIDs und beobachtete Sitzungen samt Backendidentitäten sind nicht mehr vorhanden; Clients, Fixture- und Auditpools sind geschlossen, der Runlock entfernt. Die drei Kind-Fixtures je Operation melden entfernte eigene Daten und `fetches: 0`. Vier vorhandene Container und vier vorhandene Listener bleiben unverändert; die drei bezeichneten HTTP-Gesundheitsprüfungen melden jeweils 200. Die äußeren privaten `t`-/`c`-/`data`-Verzeichnisse mit Caches und Diagnoseartefakten bleiben ausdrücklich erhalten. „Ressourcenabschluss“ bedeutet hier nicht, dass diese erhaltenen Originalbelege gelöscht wurden.

## Vollständige V2-Abnahmeanforderungen

Die historische rote Gegenprobe ist durch den nachfolgenden frischen 3/3-Nachweis ergänzt. Die vollständige Integration muss weiterhin alle folgenden Anforderungen erfüllen; insbesondere Post-B1-Recovery, ursprüngliche Regressionen und Transport/UI sind noch nicht vollständig abgenommen:

1. Das ursprüngliche Preview A lässt sich nach einer reinen Quellenprojektion mit demselben semantischen Auftrag anwenden. Ein automatisch ersetztes Preview B erfüllt diese Anforderung nicht.
2. Der neue klar versionierte Plan-/Originalarm verwendet echte vollständige SourceEvidence-V2-/Current-Witnesses. Aktuelle Registry-CAS und echte FD-/Inode-/Hash-/Parent-/Vacancy-Belege bleiben exakt gebunden. Legacy-Pläne, gespeicherte Jobs und historische Rawhash-Verträge werden nicht umgedeutet.
3. Der Verlauf **nach B1**, einschließlich tatsächlich bestätigtem B1-COMMIT mit verlorener Bestätigung und frischer Wiederaufnahme, wird geprüft. Eine nur vor B1 tolerante Lösung reicht nicht. Entweder ist der vollständige Projector-Ausschluss über Prozesse und sämtliche Veröffentlichungswege nachgewiesen, oder ein versionierter Original-/Projektionsleaf-Vertrag muss die semantisch gültige Fortsetzung ermöglichen. Unbelegtes striktes Artefaktblocking gilt nicht als fertige Lösung.
4. Unterbrechung nach physischer Phase, B2-Rollback, verlorene Completion-Bestätigung, historische Wiederaufnahme und spätere D2/S2 bleiben sicher. Die Wiederaufnahme übernimmt keinen aktuellen Pfad als neues Original und erzeugt keine neuen vorbereiteten CRDT-Identitäten.
5. Finale Prüfung bindet den vollständigen tatsächlichen nativen Zustand einschließlich Binär-/Vektorhash, Sequenz, Persistenzzeit, Linkreceipts, unmutierter Nachbardokumente und vollständigem Finalgraphen – auch bei Delete ohne eingehende Linkänderungen. Ein inhaltsfreier Yjs-Snapshot aus Vector/DeleteSet ersetzt keinen Fullbinary-Beleg.
6. Negative Gegenproben für echte Inhalts-/Identitäts-/Scope-/Rechte-/Asset-/Namespaceänderungen und die ursprünglichen Legacy-Regressionen bleiben streng. Bestehende Intent-/Completionbudgets werden nicht still erhöht; ein sauberer Vorab-Abbruch über dem Budget ersetzt kein noch offenes Lastgate. Keine Assertion, Zeitgrenze oder ursprüngliche Erfolgserwartung wird abgeschwächt.

Erst frische tatsächliche PG-/Transport-/UI-Nachweise auf den dann gebundenen Produktquellen können diesen Anschluss abnehmen. Dateiaktions-Undo, Review Center und allgemeines Aktivierungsgate bleiben ausgeschaltet. Der nachfolgende V2-Runtimepass belegt ausschließlich seine bezeichneten sechs Varianten; er ist kein neuer Build-, Browser-, Produktions- oder Veröffentlichungsnachweis.

## Frische V2-Wiederholung: Move 3/3 und Delete 3/3

Beide tatsächlichen seriellen Runner binden die oben genannten sauberen Root-/QA-Commits und Control Plane `27c8ce37da082244f006ca376068cde6b98845d5`. Je Operation sind 6.916 Repositoryquellen, 87 explizite Produktpins und sechs native Pins gebunden. Die originale 180-Sekunden-Grenze bleibt unverändert. Move verwendet exakt dieselbe private Probe wie im ursprünglichen RED; bei Delete wurde ausschließlich die explizite erwartete Completionversion von 2 auf 3 aktualisiert, entsprechend dem neuen Originalarm. Es gibt keine gelockerte Erfolgsassertion oder Ersatz des ursprünglichen Plans durch ein neues Preview.

| Tatsächliche Variante | Move | Delete |
| --- | --- | --- |
| Ohne zusätzliche Projektion, ursprünglicher Plan A | Exit 0 | Exit 0 |
| Quellenprojektion, frischer Kontrollplan B | Exit 0 | Exit 0 |
| Quellenprojektion, weiterhin ursprünglicher Plan A | Exit 0 | Exit 0 |

Im entscheidenden Originalplanfall bleiben native Bytes, Vector, Sequenz, Linkinventar und das ausgewählte Ziel unverändert. Die Quellenprojektion verändert physische Bytes, Registry und Checkpointbelege. Preview A und B behalten nun dieselbe semantische Plan-ID, während rohe Evidenz und Compiler-/Finalgraphbelege ihre tatsächlichen Unterschiede ausweisen. Der Owner übernimmt echte aktuelle B1-Witnesses, ohne das ursprüngliche Preview umzuschreiben. Im Journal stehen Move-Intentversion 2 beziehungsweise Delete-Intent-/Completionversion 3. Die Operation und ihre zentralen Linkänderungen schließen tatsächlich ab.

Die privaten Wiederholungen liegen unter `/private/tmp/cn-move-delete-source-projection-v2-repeat-draft-kirgezj7/{move,delete}`. Beide Originalrunner enden mit Exit 0, drei tatsächlichen Kindern und null Timeout/Signal. Die unabhängigen Abschlussprüfungen lesen unveränderte Quellen, geschlossene eigene Prozesse/Gruppen und nicht mehr vorhandene eigene Schema-OIDs/Backends; verwaltete Container, Listener und Gesundheitsprüfungen bleiben erhalten. Äußere Cache-/Belegverzeichnisse bleiben ausdrücklich bestehen.

| Artefakt relativ zum jeweiligen Operationsverzeichnis | Move SHA-256 | Delete SHA-256 |
| --- | --- | --- |
| `manifest.json` | `0ad2e7c920e0c43d788af6aff82677eb475d434f2f82dcbfee45a465b41a5b61` | `a7523e252daa756dcc5aa2819e6f3d5b626c0e689f37cb8d53a472d8a49c0da9` |
| `ready.json` | `37cdac0b88212069d6a240b2c948cc696cf53db396868a6748179c04ea73eec3` | `b80328c19bc63bac24f88206a3b6a073e1ab56a4b6ff36973fb7e6637a1dff21` |
| `results.json` | `7576d7df57d2255ad07bb33f7d9edf0a948c6d58f66f4a8a040188693d745ded` | `35a8b2c27a830eff4e7ef995001ff48ad9f314f7cdec43b1cd3d369d7aa77f76` |
| `cases/projector-original-plan/projector-original-plan-observations.json` | `176ace5e3e50c9f8b3c5fdd429308c1e7ed5a74f2d8a27aee5da00704b41688b` | `4aea462d1f86ef179061652e757ab66d7baeeea1c89e0065d3ab8dca890ae078` |
| `independent-closure.json` | `61d6a537dd3ead1ceee576e112f49638cc3877f92a9c4a075c86e1228e25d487` | `c7612cfce8280148ce2a2784cb89a982f3eb824e907cf4a8c2e341df6ba2ca56` |

Dieser Durchstich beweist die ursprüngliche Preview-Anwendbarkeit nach reiner Quellenprojektion. Post-B1-ACK-Verlust/Ownerverlust, historische Recovery, vollständige ursprüngliche Negativ-/Lastregressionen und frische gemeinsame Transport-/UI-Abnahme bleiben offen. Der zusätzlich reproduzierte ältere Asset-Delete-/Native-Backlink-Konflikt wird separat korrigiert; diese sechs nativen Ownerfälle beweisen dessen Abschluss nicht. Dateiaktions-Undo, Review Center und allgemeine Aktivierung bleiben aus.


## Original-Move: tatsächlicher Post-B1-ACK-Verlust und Projector-Deferral

Auf Root `ada376646345e5730d4667609c3bc3e1043a7189` / QA `c557c53c6ed3b61800428e7eae2e0aa45d32cd56` besteht das echte einzelne Szenario unter `/private/tmp/cn-move-b1-root-runner-pending-jfltu44o`. Ein tatsächlicher B1-COMMIT verliert seine Antwort; der echte Owner ist geschlossen. Der reguläre Projector erwirbt danach positiv seinen Shared-Lock, erkennt den dauerhaft offenen Move-Intent und bleibt sowohl vor als auch nach echter Claimfreigabe ohne SQL-/Dateiänderung zurückgestellt. Dieselbe Operation wird über den echten Store ohne Repreview fortgesetzt; ursprünglicher Intent und vorbereitete CRDT-Identitäten bleiben erhalten. Vollständige native Ergebnisbelege und unabhängig angewandtes vorbereitetes Delta stimmen überein. Nach Abschluss kann der authentifizierte Import D2 am alten Movepfad erzeugen; der alte Projector wird wegen geänderter Identität abgewiesen, der neue Zielpfad funktioniert und D2 bleibt unverändert.

Originalchild und Runner Exit 0, ein tatsächlich gestartetes Szenario, kein Timeout/Signal; unabhängiger Ressourcenabschluss Exit 0. Die Bindung umfasst 6.918 Rootquellen und die konkreten Root-/QA-/CP- und Native-Pins. Dies ist keine Move-B2-ACK-Verlust- oder historische Store-Recoveryprüfung bei schon vorhandenem D2 und kein UI-/HTTP-Nachweis.

| Move-Artefakt | SHA-256 |
| --- | --- |
| Unverändertes Kindskript | `e6fe8520882062409f86496464e49488af22e9b020f6a2e2d5829aecdcf6d274` |
| `ready.json` | `33c5eed454fe048711dd8309248f2442fca2c9958460737ee9273e66becb8dfd` |
| `results.json` | `16ddfa9ee33c6810afae9456feeb7103e89cd010f571205fa521622fdcc9f68e` |
| `independent-closure.json` | `3d3d251148cb1c7dd571a1f970111160280ff54e970de003fc80339e8b2fdb79` |

## Original-Delete: B1/B2 bestätigt, tatsächliche Neuanlage am gelöschten Pfad blockiert

Das separate echte Szenario `/private/tmp/cn-delete-b1-root-runner-pending-zmnty5xv` auf denselben Quellen endet tatsächlich mit **Exit 1**. Bis dahin bestehen tatsächlicher B1-COMMIT-ACK-Verlust/Ownerabschluss, dauerhafter Projector-Ausschluss vor/nach Claimfreigabe, echte Wiederaufnahme sowie der zweite tatsächliche B2-COMMIT-ACK-Verlust. Archivierung, zentraler nativer Link, Trash, immutable Completion sind auf dieselbe B2-Transaktion gebunden. Anschließende reale Quellenprojektion ist vollständig; ursprüngliche native Belege bleiben unverändert.

Der erste Fehler entsteht erst bei der echten authentifizierten D2-Erzeugung am zuvor gelöschten Pfad: `MARKDOWN_IMPORT_LIFECYCLE_REQUIRED` in `captureAuthenticatedUpload`. Der bisherige any-status-Registrycheck blockiert auch korrekt archiviertes D1. Die Datenbank erlaubt Wiederbelegung ausdrücklich durch aktive partielle Unique-Indizes. Auch manuelles Create nutzt denselben bisher blockierenden Erzeugungskern. Die spätere historische Wiederaufnahme mit D2 wurde deshalb nicht erreicht und ist nicht bestanden. Der unabhängige Abschluss besteht; alle eigenen Ressourcen sind geschlossen und bestehende Dienste unverändert.

| Delete-Artefakt des roten Originals | SHA-256 |
| --- | --- |
| Unverändertes Kindskript | `2427f9eeb3756fe0c528bf203a5fc320a99f77141bdd6eaa2263ea6826913834` |
| `ready.json` | `9bf6060334d56ee761fcb8095113770a52f0bc829dfbd4bee4d9e581363981c8` |
| `results.json` | `081f30f55a6a1da04e3dae511871a0569ca50fd36185ccc32aabe4faa47bded0` |
| `independent-closure.json` | `fda4256c85c5de94e8148f211e33c185585f44618a7e52cb0ae0d670a14c6b71` |

Die enge Korrektur betrifft ausschließlich authentifiziertes First-Birth-Create: physische Abwesenheit und echter privater Birthclaim bleiben zwingend; ausschließlich archivierte Historie und keine aktive Lineage sind erlaubt. Vor neuer Native-DML wird unter dem echten EXCLUSIVE Owner zusätzlich jeder dauerhaft offene Original-Move/Delete-Intent abgewiesen. Neue Dokument-ID und Lineage entstehen frisch; D1/Archivzustand/Receipts werden nicht geändert. Pristine-/Originaldatei-/Session-Bootstrap-Sperren bleiben erhalten. Unabhängiges Source-Review bestätigt die Auth-/Owner-/Realm-/Replaygrenzen. Der echte Folgelauf auf der Korrektur bleibt bis zu seinem tatsächlichen Ergebnis offen.

Die ursprüngliche strenge Probe liegt zusätzlich als Repositoryregression `scripts/workspace-operation-original-delete-recreate-postgres-test.ts` vor. Nur Import-/Reportpfade und Suitebezeichnung wurden tragbar gemacht; die Receipt-Typen sind konkret. B1/B2-Faults, sämtliche Domainassertions, Zeitgrenze und echter Ressourcenabschluss bleiben erhalten. npm-Einstieg: `test:files:original-delete-recreate:postgres`; benötigt den bestehenden verwalteten lokalen PG18-Stack. Keine neue Testumgebung oder Containeranlage.


### Frischer vollständiger Delete-B1/B2-/Recreate-Folgelauf bestanden

Root `953f54f0026aa96e5b9a5d6cdce3dff6e044480e` / QA `c703470c1d19ac6f310544bc48a4a621954a6449` enthalten die enge authentifizierte Create-Korrektur und die dauerhafte Repositoryregression. Vollständiges cachefreies TypeScript, Scoped-Lint und acht bestehende Markdownimport-Prüfungen bestehen. Der frisch ausschließlich lesend aktualisierte GitNexus-Index umfasst 84.601 Knoten/235.501 Kanten; die Änderungskontrolle meldet sechs erwartete Dateien/70 Symbole, Risiko LOW. Der Root-/QA-Unterschied bleibt exakt auf die drei vorher erlaubten Gate-/Dokumentdateien begrenzt.

Der echte Repositorytest läuft unter `/private/tmp/cn-delete-recreate-root-runner-pending-a3ambh_2` mit 6.919 gebundenen aktuellen Quellen. Alle ursprünglichen strengen Domainassertions schließen ab: echte B1- und B2-COMMIT-ACK-Verluste, jeweiliger tatsächlicher Ownerabschluss, Projector-Zurückstellung bei dauerhaftem offenen Intent vor/nach Claimverlust, ursprüngliche Recovery, exakt eine native Linkänderung und ein Trashpayload. Die bestätigte spätere D2-Anlage erhält eine andere Dokument-ID und Lineage. Die historische tatsächliche Store-Recovery mit D2 am alten Pfad endet erfolgreich und hat **null beobachtete Domain-DML**; vollständige D2-Fakten, archiviertes D1, ursprüngliche immutable Journale, Linkreceipt und Trash bleiben unverändert. Originalchild/Runner Exit 0, keine Signale/Timeouts, kein Skip und kein Repreview.

Der unabhängige Auditor endet mit Exit 0; eigene Prozesse/Gruppen, echte Schema-OIDs/Backendidentitäten/Advisorylocks und Fixture-DATA sind entfernt beziehungsweise geschlossen. Alle vier vorhandenen verwalteten Dienste und Listener/Gesundheitsprüfungen bleiben unverändert. Der tatsächliche vorige D2-Create-RED bleibt erhalten. Die Pure- und Runtimebelege sind getrennt; es wird keine neue Browser-/HTTP-/MCP-/SDK-/Produktionsabnahme behauptet. Das zusätzliche spätere Legacy-Receipt-Finalisierungsgate sowie weitere ursprüngliche Regressionen und gemeinsame neue UI-Abnahme bleiben offen.

| Artefakt des tatsächlichen erfolgreichen Repositorylaufs | SHA-256 |
| --- | --- |
| `scripts/workspace-operation-original-delete-recreate-postgres-test.ts` | `ed4e8793449f123e3dabc1d974ae8cfce95bd17b99476d34f9b81478dd51861b` |
| `ready.json` | `4e6b65183f3fcf7f6cd284ba0084032043eadbc7ab00f685bd324457bcb41f9f` |
| `results.json` | `81b8e21209b309bd712c3eefdb719f57f967bce75b19b8ae95ef8511c01a2d49` |
| `independent-closure.json` | `0502b4d634c008a5b8c4a98bb928f38cb844b00b512dfdf667ac640300f68bc5` |
