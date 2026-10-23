# Erste vollständige native Live-Ownerfolge

Stand: 19. Oktober 2026. V6 und die frische unprofilierte V7-Bestätigung bestehen lokal jeweils vollständig mit 16/16. Browser-, SDK- und Gesamtabschluss bleiben offen.

## Tatsächlicher Nachweis

`prepared-read-v6-terminal.json` enthält ursprüngliche Exits 0 für gezieltes TypeScript, ESLint und die vollständige Folge [direct-mcp-workspace-path-owner-postgres-test.ts](../scripts/direct-mcp-workspace-path-owner-postgres-test.ts). Der Ownerlauf dauert 361.980 ms. Das vollständige Originalprotokoll enthält exakt 16 bestandene Gruppen und den abschließenden Bericht `groups: 16`; es gibt keine Fallauswahl oder gelockerten Schutzprüfungen. Das bestehende Fünf-Sekunden-Limit bleibt erhalten.

Der Lauf verwendet tatsächliche fixturegebundene JWTs, aktuelle MCP-Principals, PostgreSQL 18, feste Store-/Move-/Delete-Owner, Dateideskriptoren, echte Raum-/WebSocket-Verbindungen und gespeicherte Admissiontickets. Alle vier zusätzlichen Live-Fälle bestehen:

- Offene Incoming-Räume werden vor Move und Delete mit ihren erhaltenen Tickets tatsächlich geleert; ausdrückliche SID-B-Recovery erhält das Original.
- Eine echte fremde Reservation kann weder übernommen noch durch den aktuellen MCP-Auftrag geleert werden.
- Nach dauerhaftem Room-Release entzogene Delete-Rechte verweigern die Auswirkungen; ausdrückliche Recovery erhält Original und Ticket.
- Eine nach dem gebundenen Plan akzeptierte echte Peeränderung erzeugt den genauen Plankonflikt; sie wird nicht als neue Preview oder fremde Bearbeitung übernommen.

Die bisherigen Fallkörper bleiben enthalten, darunter aktuelle Autorität und Sitzungsentzug, fehlende Projektion und PDF-Wurzeln, zentrale Incoming-Linkpflege, stabile Identität, Archive/Trash, verlorene echte COMMIT-ACKs und ausdrückliche Recovery. Die Status-/Wiederholungsprüfungen erhalten ihre vollständigen Domain-, `xmin`-, Dateisystem- und Benachrichtigungsverbote. Der Terminalhinweisfall bestätigt Veröffentlichung aus demselben tatsächlichen B2-COMMIT, Stille nach Rollback und genau eine Veröffentlichung bei verlorenem ACK. Dieser Suitepass umfasst damit auch die früher im Livepfad erreichte Nichtmutationsprüfung.

## Quellenbindung und Ressourcenabschluss

Die 47 Vorher-/Nachherquellenpins des Controllers sind gleich; `unchanged` und `profileUnchanged` sind wahr. Die tatsächliche Testsuite hat SHA-256 `8eaa692bb5d1c16bb8eec8b0792af7f5e884e2c79cf7cf3f154b22658b5d3bc6`. Änderungen während des Laufes oder eine abgeschwächte Deadline erklären den Pass nicht.

V6 ist ein profilierter Lauf. Sein privates Diagnoseprofil heißt `native-owner-profile-v7.cjs`, SHA-256 `740d657df659d8b1204d2d44e754bb1ee80e34282e7e6af17dbae60ca6c80c5f`; die Dateinummer ist kein Ergebnis der separat laufenden unprofilierten V7-Bestätigung. Der Profilbericht bindet die gleichen Quellen und den vollständigen Loghash. Er enthält 346 Phasen; die längste erfasste Phase endet mit COMMIT nach 4249 ms und 2237 Abfragen. Das ist ein lokaler Messwert, keine Laufzeitgarantie. Frische Prüfungen, Sperren und Autorität werden weiterhin bei jedem bestehenden Checkpoint gelesen; die vorbereiteten PostgreSQL-Pläne ersetzen keinen Fakt oder Rechtecheck.

Das Originalprotokoll bestätigt den Abschluss eines tatsächlichen Room-Backends und fünf Sockets sowie entfernte Domain-Fixture und Dispatch-Bundle-Ressourcen. Der gesonderte tatsächliche READ-ONLY-Nachcheck `owner-resource-postcheck-v8.json` bestätigt für genau 24 aus Originalprotokollen gebundene eigene Fixtures jeweils abwesendes Schema, eigene Backend-Sitzungen, DATA und Originalprozess; die Read-only-Transaktion hat keine zugewiesene XID. Das ist kein globaler Ressourcencheck fremder Umgebungen.

Private Originale liegen unter `/private/tmp/canvas-native-path-admission-8gusy9ys/`:

| Artefakt | SHA-256 |
| --- | --- |
| `prepared-read-v6-terminal.json` | `be05e5bf09120a698cad0fbb1fce0b4756fd5589cb69bfa4db0daf051f9ce176` |
| `owner-live16-pg-prepared-read-v6.log` | `cf91e6fd2ba5b297261e2378f2040bb6554f86227f770f7caa135259c19eb1ab` |
| `native-owner-profile-v6-report.json` | `d3e46f63cbebb23ff0105c96e681156717783ce783c2caab5c6fff66caa122a5` |
| `owner-resource-postcheck-v8.json` | `85a034889f548b7c0437348bfdf8489107a1758bae7a53d8c5d862bec7ad24a0` |

## Frische unprofilierte Bestätigung V7

`prepared-read-v7-terminal.json` bestätigt tatsächliche ursprüngliche Exits 0: TypeScript 19.556 ms, ESLint 3.534 ms und dieselbe vollständige Ownerfolge 348.361 ms mit 16/16. Es gibt keinen privaten Timing-Preload. Alle 47 Quellenpins bleiben während V7 unverändert. Gegenüber V6 sind alle 46 übrigen Quellen gleich; die Testdatei ergänzt ausschließlich zwei Zeilen zur sicheren Ausgabe eines tatsächlichen numerischen SQLSTATE im bestehenden Diagnosehelper und hat SHA-256 `57041958a8e1b71a8046200657d525aead59963dcf05122e400ce5792506549c`. Decoder, ursprüngliche Fehler, sämtliche Assertions und alle Fallkörper bleiben erhalten. Sämtliche Produktquellen sind zwischen V6 und V7 bytegleich.

Auch die beiden strikten Nichtmutationsprüfungen nach tatsächlichem Move und Delete bestehen erneut. Der gesonderte tatsächliche READ-ONLY-Nachcheck `owner-resource-postcheck-v9.json` erweitert den ursprünglichen Ressourcenabschluss auf 25 exakt protokollgebundene eigene Fixtures; Schema/OID, beide eigenen Application-Namen, DATA und ursprünglicher Prozess sind jeweils abwesend, die XID bleibt null.

| Neues Artefakt | SHA-256 |
| --- | --- |
| `prepared-read-v7-terminal.json` | `87f840f0a6957a77304307bfa0187da09489edb26747ac8d0578b6c0b6a7dcac` |
| `owner-live16-pg-prepared-read-v7.log` | `53b9bd2bbcfb4f12357be5a287840a18384d442157b12be7644b73888b745d27` |
| `owner-resource-postcheck-v9.json` | `20f0e907f19172a132966f7128e5abdbc57cd2807677a972f7e35cb743a418b5` |

## Offene Grenzen

V3 bleibt als fehlgeschlagener Originalablauf mit Nichtmutationsassertion nach elf bestandenen Gruppen erhalten; V5 bleibt mit Abbruch nach zehn Gruppen und einem maskierten ursprünglichen Fehler erhalten. Ihre jeweiligen Ursachen sind ungeklärt. Der vollständige V6-Pass erklärt diese früheren Fehler nicht rückwirkend. Die nachfolgend separat gebundene unprofilierte V7-Bestätigung besteht; sie erklärt die früheren Fehlversuche ebenfalls nicht rückwirkend.

Dieser Lauf enthält keine HTTP-/REST-/öffentliche MCP-Handlerfolge, keine tatsächliche OAuth-Ausstellung oder -Erneuerung, keinen installierten SDK-, Browser-, Next-Build- oder Produktionsnachweis. Der letzte kompilierte Browserlauf bleibt bei 8/9. Der unveränderte aktive Editorfall, sichtbarer Rejoin sowie Tree-/Suchaktualisierung und der vollständige installierte SDK-Lifecycle mit echter erneuerter OAuth-Sitzung müssen gemeinsam abgenommen werden. Der ursprüngliche Produktionsfehler ist damit nicht als behoben bewiesen.

Alle sieben Restblöcke des [Konsolidierungsplans](./yjs-document-authority-consolidation-plan.md#restarbeiten-bis-zum-vollständigen-ergebnis) bleiben erhalten. Legacy-Markdown, interne Agentenanlage/Runtime, zentraler PDF-Import, breitere Suche, Standard-Skill/Sandbox und tatsächliche öffentliche Dokumentationsauslieferung sind durch diese Ownerfolge nicht abgeschlossen. Die allgemeinen Aktivierungs- und bisherigen Abschaltgrenzen bleiben bestehen. [Vorherige Ownerbelege](./yjs-native-path-owner-integration-evidence.md) und [Prepared-Read-Belege](./yjs-prepared-storage-read-evidence.md) gelten weiterhin für ihre gebundenen Quellenstände.
