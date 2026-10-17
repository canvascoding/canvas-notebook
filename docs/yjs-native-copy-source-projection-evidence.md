# Native Copy: Sourceprojektion verändert die Previewsemantik

Stand 17. Oktober 2026. Die getrennte PostgreSQL-18-Gegenprobe ist vollständig beendet und bleibt **fehlgeschlagen**: Zwei Kontrollen bestehen, das Apply mit dem ursprünglichen Previewplan scheitert nach einer reinen Sourceprojektion. Dieser Produktfehler ist noch nicht behoben. Der inzwischen bestandene [Pending-Copy-Projektionsschutz](yjs-native-copy-pending-projector-evidence.md) betrifft einen anderen Konflikt.

## Tatsächliche Quellen und Kontrollen

Root `d8484987ba0d0301bebef498b6ed23b08f4bddcc`, QA `f223d98cae1f5827e63ca374fa490e377746e0e9`, Control Plane `27c8ce37da082244f006ca376068cde6b98845d5`. Der Lauf verwendet unmittelbar die Root-Produktquellen. QA und Control Plane wurden dabei nicht gestartet oder geändert. Die Versiegelung bindet 6890 Repository-/explizite Native-Artefaktdateien einschließlich 22 direkter Draftabhängigkeiten; `node_modules` ist nicht einzeln gehasht.

Unveränderte private Testquelle: `/private/tmp/cn-source-projector-plan-draft-8uwf5as7/source-projector-copy-plan-draft.ts`, SHA256 `369438e29f609eb8a3e2c634d49e54b700e01e425d2668bf64f871c5af3d0f01`. Root-Session 62577 endet mit tatsächlichem Runner-Exit 1. Drei getrennte Kindprozesse mit jeweils eigener unveränderter Metadatenfixture laufen seriell, ohne Timeout oder Signale; kein Modus bleibt ungestartet.

| Modus | Tatsächliche Beobachtung | Exit |
| --- | --- | --- |
| `no-projector-original-plan` | Ohne Zwischenprojektion bleiben beide Pläne und Belege gleich. Das ursprüngliche Apply endet `complete`/`published`. | 0 |
| `projector-fresh-plan` | Projektor bestätigt die neue Sourceprojektion. Mit dem anschließend neu aufgenommenen Kontrollplan gelingt Copy. | 0 |
| `projector-original-plan` | Derselbe Projektionswechsel; Apply mit dem ursprünglichen Plan wirft `NativeCopyOwnerError` / `NATIVE_COPY_PLAN_CHANGED`, bevor ein Ziel-, Ledger- oder Journal-Birth entsteht. | 1 |

Der frische Plan ist ausschließlich eine positive Kontrolle. Er ist kein vorgeschlagener automatischer Repreview-/Retry-Workaround.

## Kausale Grenze und tatsächlich veränderte Daten

Die Fixture legt die Source über den echten nativen Upload-/Projektionspfad an. Danach prüft sie einen tatsächlichen Owner-WRITE-Request, die native Identität und den beobachteten Room-Owner-Epoch 0. Sie verändert den echten Yjs-Frontmatterzustand und persistiert ihn über `persistCollaborationYDoc`; es gibt keine SQL-Umschreibung nativer Bytes. Anschließend sind eine neue native Sequenz und ein neuer Proof dauerhaft gespeichert, während die physische Datei noch exakt die ursprünglichen Uploadbytes enthält und die Projektion tatsächlich aussteht. Das ist ein echter Autorisierungscheck plus Persistenzkernel, kein vollständiger WebSocket-/Editortransportnachweis.

Preview A wird erst danach aufgenommen. Der Sourceprojektor läuft nach vollständig beendeter Persistenz und zurückgekehrtem Preview-Owner. Preview B sowie das jeweils ausgewählte echte Apply laufen vor den Sollassertions; alle Resultate, Fehler und Vorher-/Nachhersnapshots werden zuvor gespeichert. Unbeteiligte Source-/Zieldokumente und persönliche/gemeinsame Annotationen bleiben geprüft unverändert.

In beiden Projektionsmodi gilt zwischen Preview A und B:

- Yjs-Binärzustand, StateVector, Dokumentsequenz, `persistedAt`, Identität und nativer Zustandsproof bleiben exakt gleich.
- Physische Sourceprojektion und Projektionsreceipt/-metadaten ändern sich; der Projektor liefert tatsächlich einen bestätigten Checkpoint, der Pendingzustand endet.
- Die Source-Registry ändert `state_version` von 0 auf 1 sowie `snapshot_revision_id`, `updated_at` und `xmin`.
- Plan-ID, Compilerplanbeleg, finaler Graphbeleg, semantischer Quellenbeleg und roher Quellenbeleg ändern sich. Semantischer und roher Zielbeleg bleiben gleich.

Damit ist der Fehler umfassender als eine rohe Inode-/mtime-Kopplung: Auch abgeleitete Registrymetadaten fließen in die derzeitige Plan-/Compiler-/Currentsemantik ein. Im roten Fall speichert die Probe den tatsächlichen Applyfehler; `afterApply.target.registry`, `afterApply.target.states`, `afterApply.ledger`, `afterApply.header` und `afterApply.steps` enthalten anschließend jeweils null Zeilen. Die Schrittzeilen gehören zum Journal; ein Feld `target.steps` existiert im Originalbericht nicht. Die ursprüngliche Planung wird nicht still ersetzt.

## Belege und separater Ressourcenabschluss

Privates Laufverzeichnis `/private/tmp/cn-source-projector-plan-repeat-aqhzuheg/`:

- `ready.json`: SHA256 `c51c98747ddc0b8f4d156d8cdd74d54456be99937a7672ac66f122f8a0b0c20c`.
- `results.json`: SHA256 `f222dd15742f91a50fd7c114bda444a26cc6a0d015f7233da53791aa555a2b1c`.
- `independent-closure.json`: SHA256 `5743b0e3011ced16137bb0cffc7db40afad020a7b6c04873e8ebb60fae0cac1c`; Root-Session 94707, tatsächlicher Exit 0. Die frische unabhängige Prüfung ist strikt lesend, mit Readonly-/Repeatable-Read- und null-XID-Beleg. Exakte eigene Schema-/OID-, Backend-, Prozess-/Gruppen-, Fixture- und Lockbindungen sind geschlossen; alle Quellenpins bleiben gleich.
- `outer-scratch-closure.json`: SHA256 `64d34ee62fc905327aed4912511a5fc1a8f3fd364da33d28f9dac319d22f871e`, separater Abschluss mit Exit 0. Nur eigene gebundene Scratchverzeichnisse wurden entfernt; 36 geschützte Originaleinträge und die roten Ergebnisse bleiben unverändert.

Vier verwaltete Dienste bleiben identisch und gesund, drei Healthaufrufe liefern HTTP 200. Prozessbeobachtungen behaupten keine vollständige Erfassung sämtlicher kurzlebiger Startprozesse. Die erfolgreiche Ressourcenprüfung macht den fachlich roten Lauf nicht grün.

## Gemeinsamer nächster Produktschnitt

Copy bindet die vollständigen Evidence- und Compilerdaten in `computeWorkspaceOperationNativeCopyPlanId`; sein frisches Apply vergleicht diese Plan-ID. Move/Rename bindet dieselbe Quellenfamilie in den V3-Plan und vergleicht bei neuen direkten Aufträgen ebenfalls den ursprünglichen öffentlichen Previewplan. Native Delete hat keinen identischen HTTP-Previewvergleich, prüft aber denselben semantischen Quellenbeleg und zusätzlich die Registryversion im ursprünglichen Native-Target. Das ist eine quellenbelegte gemeinsame Kopplung; die tatsächliche PG-Reproduktion hier betrifft ausschließlich Copy.

Als Nächstes ist die gemeinsame Semantik abgeleiteter Metadaten und öffentlicher Preview-Anwendbarkeit zu korrigieren, einschließlich ihrer Copy-/Move-/Rename-/Delete-Current-Konsumenten. Historische private Pläne und Originalbelege müssen erhalten und weiterhin streng validierbar bleiben. `catalogueProof` darf nicht pauschal entfallen; native Identität, echte Inhaltsänderung, Lineage, vollständiger Namespace, Links, Assets und aktuelle Autorität bleiben bindend. Weder automatischer Retry noch Repreview ersetzt diesen Produktschnitt.

Der konkrete mobile Browser-409 aus `lasSNn` ist damit nicht kausal erklärt: Dort fehlt ein Sourceproof-/FD-Snapshot zwischen Preview und Apply. Der isolierte Desktop-`ECONNRESET` bleibt ebenfalls ungeklärt. Die vollständige neue Zehn-Fälle-UI-Abnahme, API/MCP/PI/Mobile-Gesamtanschlüsse, SDK/Standard-Skill, progressive Suche und die übrigen Planaufgaben bleiben offen. Kein neuer Build-/UI-Pass, keine allgemeine Aktivierung oder Produktionsauslieferung. Dateiaktions-Undo und Review Center bleiben ausgeschaltet.
