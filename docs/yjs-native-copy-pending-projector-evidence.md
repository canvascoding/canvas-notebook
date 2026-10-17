# Native Copy: bestätigte vorzeitige Projektion eines unvollständigen Clone

Stand 17. Oktober 2026. Der echte serielle PostgreSQL-18-Lauf endet mit Exit 1: Zwei Kontrollen bestehen; der gewünschte Schutzfall scheitert. Es gibt noch keinen Produktfix und keinen neuen Browsernachweis.

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

Geprüft wird der reale Materialisierungskern nach vollständiger Owner-Rückkehr mit aktiver dauerhafter Copy-Reservation. Schedulerintervall, WebSocket-/Chokidarereignisse und tatsächliche Browseranzeige werden damit nicht nachgewiesen. Nächster Schritt ist ein enger Schutz ausschließlich für unveröffentlichte native Clone; veröffentlichte Kopien und notwendige Checkpoints bestehender Räume müssen weiter funktionieren. Die identische Gegenprobe muss anschließend bestehen. Dateiaktions-Undo und Review Center bleiben aus.
