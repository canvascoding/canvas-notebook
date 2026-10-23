# Native Copy: bestätigte vorzeitige Projektion eines unvollständigen Clone

Stand 17. Oktober 2026. Der ursprüngliche serielle PostgreSQL-18-Lauf bleibt mit Exit 1 erhalten. Der nachfolgend dokumentierte Produktfix besteht inzwischen dieselbe unveränderte private Gegenprobe in allen drei Modi. Ein neuer Build- oder Browsernachweis liegt dafür nicht vor.

## Quellen und tatsächlicher Lauf

Root `6ef2c9342e5ec4dbbf97537afae2b630d86ef882`, QA `4bc3552f3a05effc4538cdbb8999dfa41d8975dc`, Control Plane `27c8ce37da082244f006ca376068cde6b98845d5`. Der Lauf importiert unmittelbar die Root-Produktquellen; QA und Control Plane werden dabei nicht gestartet oder geändert. Der Quellenabschluss umfasst 6888 Repository-/explizite Native-Artefaktdateien; installierte `node_modules` werden nicht einzeln gehasht. Die 18 direkten Testabhängigkeiten sind keine Behauptung einer vollständigen Aufrufgraphabdeckung.

Privater Test `/private/tmp/cn-pending-copy-projector-draft-yx2evk4f/pending-copy-projector-postgres-draft.ts`, SHA256 `3a670a5788161f0d89d85141679caede57b92fd9ded4867ec60956cc2d957a60`. Die unabhängige Quellenprüfung bestätigt echte COMMIT-Ausführung vor der simulierten verlorenen Bestätigung, keinen Projector innerhalb des Owner-/SQL-Hooks und tatsächliche Wiederaufnahme vor den Sollassertions. Es werden keine Yjs-/Journal-/Admissionzustände für das Ergebnis umgeschrieben.

Root-Session 54216 endet tatsächlich mit Exit 1, Zeitraum 07:07:21–07:08:52 UTC. Drei getrennte Kindprozesse mit jeweils eigener unveränderter Metadatenfixture laufen seriell. Keine Timeouts, Signale oder nicht gestarteten Fälle; die ursprünglichen Ergebnisse bleiben erhalten.

| Modus | Tatsächliches Ergebnis | Exit |
| --- | --- | --- |
| `published-control` | Vollständig veröffentlichte Kopie lässt sich regulär projizieren; native Daten und abgeschlossene Kopierbelege bleiben erhalten. | 0 |
| `pending-control` | Tatsächlicher B1-COMMIT mit verlorener Bestätigung; ohne Zwischenprojektion vervollständigt derselbe Owner die Kopie mit unveränderten Clone-IDs und gemeinsamem Titel. | 0 |
| `pending-projector` | Derselbe Pendingzustand; tatsächlicher Projektor legt die Zieldatei an. Die anschließende ursprüngliche Owner-Wiederaufnahme bleibt in `needs_recovery` mit `destination-occupied`. | 1 |

Im dritten Fall ist die Ziel-Markdowndatei vorher nicht vorhanden und anschließend vorhanden. Eine neue Projektionsreceipt wird angelegt; der Kopierbeleg bleibt `native_committed`. Yjs-Binärzustand, StateVector und Dokumentsequenz bleiben gleich. Der Projektor liefert einen bestätigten Checkpoint zurück. Beide tatsächlichen Resultate werden vor der scheiternden Schutzassertion gespeichert. Das ist ein bestätigter Konflikt zwischen Projektion und Kopierveröffentlichung, keine nachgewiesene Ursache des separaten mobilen `NATIVE_COPY_PLAN_CHANGED`.

## Belege und Abschluss

Privates Laufverzeichnis `/private/tmp/cn-pending-copy-projector-runner-7vapuren/`:

- `ready.json`: SHA256 `3fa08c8e07a0029ba345696d9d702ec737a16d49b69c74e942572f30f6a6279d`.
- `results.json`: SHA256 `5895e6bfa152960d1d647f8d21f9f7805a4f9df10a62c3eac20aef9bb73dfbeb`.
- `independent-closure.json`: SHA256 `1bd1e89484e0c675086664c8578af1bbbe4a92a69828ac5b3c83e6f4e3e8837d`; Root-Session 51482, Exit 0. Strikt lesende Nachprüfung: alle drei exakten Schemas/OIDs, beobachteten eigenen Backendidentitäten, Prozesse/Gruppen, Fixture-DATA und Runlock geschlossen; vier verwaltete Dienste unverändert gesund, drei Healthaufrufe HTTP 200. Die äußeren Scratchverzeichnisse werden dabei ausdrücklich nicht gelöscht.
- `outer-scratch-closure.json`: SHA256 `ed824c308e28e7af2d7c6d2d4fc787f984af89ce70426e34341155325a039d58`; separater Root-Abschluss mit Exit 0 entfernt anschließend ausschließlich die drei gebundenen eigenen Verzeichnisse `t`, `c`, `data`. Alle 44 geschützten Originaleinträge bleiben byte- und identitätsgleich. Keine Datenbanklöschung, Signale oder Änderung der roten Testergebnisse.

Geprüft wird der reale Materialisierungskern nach vollständiger Owner-Rückkehr mit aktiver dauerhafter Copy-Reservation. Schedulerintervall, WebSocket-/Chokidarereignisse und tatsächliche Browseranzeige werden damit nicht nachgewiesen. Der daraus abgeleitete enge Schutz ist im folgenden Abschnitt abgenommen; die ursprünglichen roten Ergebnisse oben werden dadurch nicht ersetzt. Dateiaktions-Undo und Review Center bleiben aus.

## Produktfix und tatsächliche Wiederholung

Fixstand: Root `d8484987ba0d0301bebef498b6ed23b08f4bddcc`, QA `f223d98cae1f5827e63ca374fa490e377746e0e9`, Control Plane unverändert `27c8ce37da082244f006ca376068cde6b98845d5`. Der zentrale Projektions-Identitätsguard verweigert unveröffentlichte `native_clone`-/`native_restore`-Receipts anhand der tatsächlichen Clone-ID. Veröffentlichte Kopien und `markdown_import` bleiben frei; eine allgemeine Admission-Sperre oder frei übergebene Ausnahme wurde nicht eingeführt. Der Hintergrundworker verschiebt diesen transienten Fall ohne Failure-Schreibzugriff; Web-, Mobile- und Guest-Checkpoint behandeln ihn vor der Fehlerpersistenz mit HTTP 409. Der vorhandene Receipt-Migrationspfad ergänzt einen kleinen Partialindex für unveröffentlichte Copy-/Restore-Belege.

Die private Golden-Quelle mit SHA256 `3a670a5788161f0d89d85141679caede57b92fd9ded4867ec60956cc2d957a60` bleibt unverändert. Der neue Root-Lauf unter `/private/tmp/cn-pending-copy-projector-repeat-g0qhl2kz/` endet mit tatsächlichem Runner- und allen drei Child-Exits 0, ohne Timeout oder Signale. `published-control`, `pending-control` und `pending-projector` bestehen jeweils. Die Versiegelung bindet 6890 Repository-/explizite Native-Artefaktdateien sowie die 18 direkten Testabhängigkeiten; installierte `node_modules` sind nicht einzeln gehasht.

Im Schutzfall liefert der echte Materialisierungskern `CollaborationCopyPublicationPendingError` mit `COLLABORATION_COPY_PUBLICATION_PENDING`, keinen bestätigten Checkpoint. Der vollständige Snapshot nach diesem Versuch ist exakt gleich dem vorherigen: Zieldatei absent→absent, native Bytes/Vector/Sequenz, Metadaten, Projektionsreceipts, Ledger, Journal und Admissionzeilen unverändert. Die bereits vor den Sollassertions ausgeführte ursprüngliche Owner-Recovery endet tatsächlich `complete`/`published`, mit gleichem unveränderlichem Receiptbody und denselben Clone-IDs, ursprünglichem gemeinsamem Titel und leeren persönlichen Zielzuständen. Header und Admissionen sind abgeschlossen. Der veröffentlichte Kontrollfall bestätigt weiterhin echte Materialisierung. Eine weitere Materialisierung desselben zuvor wiederaufgenommenen Clone wird nicht behauptet.

- `ready.json`: SHA256 `3952c3c3ac584e8a90f35a25b559d43a6de6589d8fcd3f4773bd1d38ea7d2e8a`.
- `results.json`: SHA256 `3b0fcc2d32d2277ef69485ea0fb1957c7f13675b26c5e58d1c6d18b719dfe2f7`.
- `independent-closure.json`: SHA256 `b4b30ec288eaf10a4a3a62a568c532551b72499c53c424b0f71cf3496e784ef2`, tatsächlicher Exit 0, strikt lesend. Exakte eigene Schema-/OID-, Backend-, Hostprozess-/Gruppen-, Fixture- und Lockbindungen sind geschlossen; vier verwaltete Dienste bleiben identisch gesund, drei Healthaufrufe HTTP 200.
- `outer-scratch-closure.json`: SHA256 `d8f68c9cdb7fc15a8ebcd9a9dd2e5d175c6b7866dce8fbd2f3497511a50a41a3`, separater Abschluss mit Exit 0. Nur eigene gebundene Scratchverzeichnisse wurden entfernt; 35 geschützte Originaleinträge bleiben unverändert.

Direkte Regressionen bestehen: Runtime 22/22, Web/Guest 46/46 und bestehende Mobile-Checkpoint-Route mit Exit 0. Der frühe vollständige TypeScript-Lauf 56078 endete wegen einer `never[]`-Inferenz im Test mit Exit 2; der korrigierte vollständige Lauf 38334 und Scoped-Lint 1444 endeten mit Exit 0. Nach einem Snapshotarray-Lesefix im Runtime-Harness bestätigte Lauf 64926 erneut 22/22. Der vollständige Typcheck lag vor der anschließenden rein mechanischen Root-Locator-Anpassung der permanenten Testdatei von `import.meta` auf `process.cwd()`; dafür wird kein weiterer vollständiger Typcheck behauptet. Der tatsächliche PG-Nachweis hier verwendet weiterhin die unveränderte private Golden-Quelle.

Damit ist der kontrollierte Pending-Copy-/Projektionskonflikt backendseitig geschlossen. Der [separat bestätigte Source-Projektions-/Previewfehler](yjs-native-copy-source-projection-evidence.md), der isolierte Browser-`ECONNRESET` und die vollständige Zehn-Fälle-UI-Abnahme bleiben offen. Kein Scheduler-/HTTP-/Browser-/Crash- oder Produktionsnachweis folgt allein aus diesem PG-Lauf; die direkte Fehlerbehandlung ist separat wie oben geprüft. Allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben aus.
