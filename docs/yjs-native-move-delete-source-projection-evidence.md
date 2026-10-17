# Move/Delete: ursprüngliches Preview nach reiner Quellenprojektion

Stand: 17. Oktober 2026. Die beiden tatsächlichen Gegenproben bestätigen denselben Fehler bei Move und Delete: Ein Checkpoint eines **nicht ausgewählten nativen Dokuments mit eingehendem Link** verändert nur abgeleitete Projektions-/Registrydaten. Trotzdem kann der vorher erstellte ursprüngliche Plan anschließend nicht angewendet werden. Je Operation bestehen beide Kontrollen mit Exit 0; der unveränderte Originalplanfall endet tatsächlich mit **Exit 1 und `NATIVE_SOURCE_EVIDENCE_CHANGED`**. Die unabhängigen Ressourcenprüfungen bestehen und ändern diese roten Produktergebnisse nicht.

Die neue gemeinsame Move/Delete-V2-Implementierung wird zum Zeitpunkt dieser Dokumentation im Root-Worktree bearbeitet. Diese Originale belegen ihren Fehler vor der Änderung; sie sind **kein V2-Runtime-Erfolgsnachweis**. Die bereits lokal bestandene [Copy10-Abnahme](./yjs-native-copy-browser-pass-evidence.md) bleibt davon getrennt und unverändert gültig für ihre dort bezeichnete Matrix.

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

## Noch erforderliche V2-Abnahme

Dieser Bericht schließt ausschließlich die rote Gegenprobe und ihren Ressourcenabschluss ab. Der gemeinsame Produktschnitt muss weiterhin vollständig nachweisen:

1. Das ursprüngliche Preview A lässt sich nach einer reinen Quellenprojektion mit demselben semantischen Auftrag anwenden. Ein automatisch ersetztes Preview B erfüllt diese Anforderung nicht.
2. Der neue klar versionierte Plan-/Originalarm verwendet echte vollständige SourceEvidence-V2-/Current-Witnesses. Aktuelle Registry-CAS und echte FD-/Inode-/Hash-/Parent-/Vacancy-Belege bleiben exakt gebunden. Legacy-Pläne, gespeicherte Jobs und historische Rawhash-Verträge werden nicht umgedeutet.
3. Der Verlauf **nach B1**, einschließlich tatsächlich bestätigtem B1-COMMIT mit verlorener Bestätigung und frischer Wiederaufnahme, wird geprüft. Eine nur vor B1 tolerante Lösung reicht nicht. Entweder ist der vollständige Projector-Ausschluss über Prozesse und sämtliche Veröffentlichungswege nachgewiesen, oder ein versionierter Original-/Projektionsleaf-Vertrag muss die semantisch gültige Fortsetzung ermöglichen. Unbelegtes striktes Artefaktblocking gilt nicht als fertige Lösung.
4. Unterbrechung nach physischer Phase, B2-Rollback, verlorene Completion-Bestätigung, historische Wiederaufnahme und spätere D2/S2 bleiben sicher. Die Wiederaufnahme übernimmt keinen aktuellen Pfad als neues Original und erzeugt keine neuen vorbereiteten CRDT-Identitäten.
5. Finale Prüfung bindet den vollständigen tatsächlichen nativen Zustand einschließlich Binär-/Vektorhash, Sequenz, Persistenzzeit, Linkreceipts, unmutierter Nachbardokumente und vollständigem Finalgraphen – auch bei Delete ohne eingehende Linkänderungen. Ein inhaltsfreier Yjs-Snapshot aus Vector/DeleteSet ersetzt keinen Fullbinary-Beleg.
6. Negative Gegenproben für echte Inhalts-/Identitäts-/Scope-/Rechte-/Asset-/Namespaceänderungen und die ursprünglichen Legacy-Regressionen bleiben streng. Bestehende Intent-/Completionbudgets werden nicht still erhöht; ein sauberer Vorab-Abbruch über dem Budget ersetzt kein noch offenes Lastgate. Keine Assertion, Zeitgrenze oder ursprüngliche Erfolgserwartung wird abgeschwächt.

Erst frische tatsächliche PG-/Transport-/UI-Nachweise auf den dann gebundenen Produktquellen können diesen Anschluss abnehmen. Dateiaktions-Undo, Review Center und allgemeines Aktivierungsgate bleiben ausgeschaltet. Diese Dokumentation behauptet weder einen neuen Build noch einen V2-Runtimepass, Produktionsänderungen oder eine Veröffentlichung.
