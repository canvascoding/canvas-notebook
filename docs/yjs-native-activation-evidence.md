# Dokumentkern: Aktivierung im PR-Code

Stand: 20. Oktober 2026. **M2 ist auf Quellenebene geschlossen:** interne zentrale PI-Neuanlage und tatsächlicher Linux-Schreibschutz sind belegt; der noch fehlende echte PostgreSQL-18-Upgradefall besteht. Danach wurde der einzige zentrale Integrationsschalter im Root von `false` auf `true` gesetzt. Root und der bereits aktive QA-Checkout haben jetzt identische Produktquellen. Dies ist keine Auslieferung: frischer aktivierter Build, gemeinsame End-to-End-Abnahme, zwei alte rote Regressionen und PR-/CI-/Reviewfreigabe bleiben verbindliches M3-Gate vor Main.

## Prüfung vor dem Schalterwechsel

GitNexus bewertet `authenticatedNativeTextSessionEnabled` als CRITICAL: 19 direkte Aufrufer, fünf erfasste Prozesse und neun Module. Die Reichweite wurde vor der Änderung gemeldet. Zwei getrennte Quellprüfungen behandeln Schema/Bestandsdaten beziehungsweise Writer/Session/Ticket/Room. Ein zusätzlicher fehlender Produktanschluss wurde dabei nicht gefunden.

Der tatsächliche globale Dispatcher führt die neuen Schema- und Lifecycle-Migrationen aus; der Containerstart wartet darauf und bricht bei Fehlern ab. Der finale PI-Zwölferlauf hatte diesen unveränderten Dispatcher bereits auf einem eigenen echten PG18-Schema durchlaufen. Der Produktionsbootstrap übergibt einen tatsächlichen Room-Owner samt Drain. Sitzung und Ticket sind an tatsächliche Nutzer-/Sitzungs-/Dokument-/Generationfakten gebunden; der Socket prüft erneut aktuelle Rechte vor Apply und der Store verlangt den tatsächlichen Ownerfence. Diese Quellprüfung ersetzt keine frische kompilierte End-to-End-Prüfung.

[PI-Create-Originale](./yjs-pi-markdown-create-evidence.md) und [Linux-CI-Originale](./yjs-linux-agent-sandbox-evidence.md) bleiben getrennt gebunden. Der tatsächliche Linuxlauf 39351304661 besteht auf Produktstand `2f3804e6c98c2250cef6e611f3cbd48d82d549aa`; der anschließende Dokumentationsstand `6ff0d528ec9b6d56f218a816fc1a8d615147059b` verändert keine Produktquellen. Frühere Browser9-/LiveOwner16-Abnahmen behalten ihre historischen Quellen; sie werden nicht auf diesen Gesamtstand umgebunden.

## Tatsächlicher PG18-Upgradefall

Die enge Testergänzung erweitert ausschließlich `scripts/native-file-operation-storage-migration-postgres-test.ts`. Alle ursprünglichen Zeilen, die drei ursprünglichen globalen Startup-Proben, Metadata-/Restore-Assertions sowie Identitäts- und Cleanupregeln bleiben bytegleich erhalten. Der neue Block läuft danach auf genau demselben eigenen PG18-Client/Schema und dem unveränderten globalen Dispatcher.

Drei tatsächliche Yjs-Dokumente werden mit den vorhandenen Plain-/Rich-Factories als `plain_text`, `tiptap_xml` und `tiptap_blocks` erzeugt. Ihre Binaries, State-Vektoren, vollständigen Zustands- und Lineagezeilen sowie Registryzeilen werden vor dem Fehler gehalten. Wie im vorhandenen PGlite-Altfall wird ausschließlich die Lifecycle-Spalte entfernt; diese kleinere SQL-Alt-Schema-Grenze wird nicht als vollständige Produktionsdatenkopie ausgegeben.

Nach dem tatsächlichen Upgrade gelten bestehende Zustände als `initialized`; alle ursprünglichen Binaries/Vektoren und vollständigen Identitätsfakten bleiben unverändert. Ein alter Eintrag ohne Zustand wird `legacy_unknown`. Der tatsächliche Katalog klassifiziert ihn unter einer echten READ-ONLY-Transaktion als `missing-state`; der vorhandene deny-only Schreibguard wirft exakt `COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED` mit HTTP 409, passender Autorität und Pfad. Die verwendete Scopebeschreibung erteilt keine Actor- oder Dateischreibfähigkeit. Es gibt keinen Rawfallback und keinen Review-Center-Anschluss. Ein danach neu angelegter Eintrag erhält `never_initialized`; ein weiterer vollständiger Startup bewahrt die gesamten Zeilen und Zustände erneut.

Die Probe ist ein Bestands-/Migrations- und Verweigerungsnachweis. Sie behauptet weder eine gemeinsame atomare XID über den mehrteiligen Startup noch einen neuen Session-/Autorisierungsabschluss oder ein geprüftes Produktionsinventar.

**Tatsächliche Ergebnisse:** TypeScript Exit 0 nach 19,522 Sekunden; Scoped-ESLint Exit 0 nach 1,712 Sekunden; vollständiger PG18-Test Exit 0 nach 26,151 Sekunden, jeweils Signal null. Die originale Restore-/FK-/Trigger-/Immutability-/deferred-COMMIT-Matrix besteht weiterhin. Der vollständige Quellcensus bleibt während dieses Laufs unverändert; Root-Aktivierung ist zu diesem Lauf noch `false`, nur die isolierte Testumgebung verwendet das bekannte Native-Opt-in. Der tatsächliche Quellenwechsel folgt erst danach.

Unabhängig geprüft: eigenes Schema samt OID und Relationen entfernt, beide eigenen PG-Backends geschlossen, ursprünglicher Nodeprozess beendet, Prüfsitzung read-only ohne XID, dieselben vier verwalteten Dienste gesund. Der Test benötigt keine neue lokale Laufzeit oder Testcontainer.

## Quellenwechsel und Grenzen

Der Root-Schalter wechselt von SHA-256 `cabf3a871e4e5b25831ef61f24828bccf3f292e3686817280b333056cd56801b` auf `c59fe563329e34a4c3a2c3d963af1b04e401cd305abf2e05d2faee4dee12bc12`. Das ist exakt die bereits vorher aktivierte QA-Datei; geändert wird ausschließlich `const enabled = true`. Die Produktion erhält keinen Test-ENV-Bypass oder neuen Konfigurationsschalter. Dateiaktions-Undo und Review Center bleiben aus.

| Quelle | SHA-256 |
| --- | --- |
| `app/lib/collaboration/native-text-session-activation.ts` | `c59fe563329e34a4c3a2c3d963af1b04e401cd305abf2e05d2faee4dee12bc12` |
| `scripts/native-file-operation-storage-migration-postgres-test.ts` | `06c7400afa741680dccb8591b0fe4ebf682bf72893b6a4c798aed2e0c3420dbc` |
| `app/lib/db/postgres.ts` | `14b0f31ff416ac586f6bec50812118fe8e2e736708975210df33505c96e165f9` |
| `server.js` | `5b853dd253f37fe8a9cd9100199468403efc9684be475a6a227f60fc0cb6db76` |
| `server/collaboration-server.ts` | `2dcbf0fa2efe8818da81872444e1d8646c7967c0a2ff335b5d34fd7ee1c93831` |

Private Originale: `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m2-activation-upgrade-gxs7y7l1`.

| Original | SHA-256 |
| --- | --- |
| `upgrade-final/terminal.json` | `737f1899681dce073b17f1c87a13713e40c216b70f9388e92e3a798ce96c18cc` |
| `upgrade-final/source-start.json` | `4791a13f70db7e76fbce516b9bac5ce080418d881bc8b2768e53e8dd43da7f3c` |
| `upgrade-final/upgrade-postgres.log` | `1c0cc83e1f6e6e70f2b50bf24ed8901bb700f7ce5d0d6a48120165ebf8c10481` |
| `independent-upgrade-closure.json` | `1af6dd2810bb7035cff50e2f315b6a77b8a96d67bd9d6b392ab03b2bab85158a` |
| `source-activation.json` | `6e71801a9855d9f65c24d88255e348b78e703953a83938ba5a297fcca5020aec` |

Die vorher gesondert geschützte Aktivierungsdifferenz zwischen Root und QA ist mit diesem bewusst geprüften Schritt geschlossen. Die zwei historischen geschützten Dokumente bleiben unverändert; Konsolidierungs-Historie und die übrigen Roadmap-Pakete werden nicht umgeschrieben.

Beim späteren Rollout müssen alte Server-/Writerinstanzen und deren Räume beendet beziehungsweise sauber gedraint sein, bevor neue native Owner übernehmen. Eine parallele gemischte Schreibgeneration wird nicht freigegeben. Es wurde hier kein Produktionsserver geändert oder neu gestartet. Die tatsächliche ausgelieferte Version und der Produktionskernel sind nach dem gesonderten Rollout zu prüfen.

Nächster einziger Umsetzungsschritt ist M3: den jetzt aktivierten Gesamtstand frisch bauen und gemeinsam im Browser sowie über API/MCP/Create/Edit/Copy/Move/Delete samt Links abnehmen; die zwei erhaltenen roten Legacy-Regressionsfälle klären, alle aktuellen CI-/Reviewbefunde bearbeiten und erst dann Main freigeben. [Aktueller MVP-Plan](./yjs-document-authority-mvp-launch-plan.md), [Draft-PR #176](https://github.com/canvascoding/canvas-notebook/pull/176).
