# MCP Move/Delete: dauerhafte Ausführung und Status

Stand: 19. Oktober 2026. Der interne Anschluss ist lokal abgenommen auf Root `d7c63ab397dc848550384db8b6b69cf4efa3c054`. QA `1613ba7c01a24a8df28aedc1f5dcac9c325d4a71` belegt reine Quellparität. Ausgangspunkt war Root `0a6891373b0e5b371d324754923f25dd66617103`. Öffentliche MCP-Tools und SDK-Move/Delete sind damit noch nicht angeschlossen; die allgemeine Aktivierung bleibt aus.

## Umgesetzter Anschluss

- Eigene gespeicherte MCP-Originaldaten binden den vollständigen nativen Plan, Client, Benutzer, Tool und Workspace. Die ursprüngliche Session bleibt erhalten; erneuerte aktuelle Sessions liefern ausschließlich frisch geprüfte Autorität.
- Vier feste Store-Eintritte für neue und bestehende Move-/Delete-Aufträge prüfen echte MCP-Principals auf derselben SQL-Verbindung. Ein neuer Claim entsteht erst nach bestätigtem COMMIT und abgewartetem Close. Ein verlorenes COMMIT-ACK erzeugt keinen zurückgegebenen Claim.
- Bestehende Original-Move-/Delete-Owner und Executor erhalten den echten aktuellen MCP-Handle. Allgemeine Worker, lockere Heartbeat-/Finish-Eintritte und bisherige Web-Batch-Routen dürfen MCP-Aufträge nicht übernehmen.
- Status prüft aktuelle MCP-Rechte vor und nach einem tatsächlichen historischen RR/RO-Snapshot einschließlich abgewartetem COMMIT/Close. Ein gespeicherter `applied`-Header allein ist kein Abschlussnachweis; bestehende native Belege entscheiden.
- Die strenge Original-Delete-Speicherprüfung berücksichtigt nun exakt die beiden vorhandenen nativen Edit-Belegfelder und deren bekannten Migrationstrigger. Unbekannte Felder/Trigger bleiben abgewiesen.
- Vor jeder physischen MCP-Verschiebung erfolgt ein frischer bestehender Owner-Check. Ein Rechteentzug nach dessen COMMIT kann weiterhin einen bereits begonnenen Dateischritt betreffen; dessen sichere Behandlung bleibt Original-Recovery. Es wird keine atomare ACL-/Filesystem-Transaktion behauptet.

## Tatsächliche Validierung

Private Originalprotokolle und quellgebundene Reports: `/private/tmp/canvas-mcp-path-owner-fxzpy19r/`. Die elf abschließenden Programme liefen seriell und haben jeweils Originalexit 0 ohne Signal. Unterschiedliche Programme werden nicht zu einem gemeinsamen E2E-Ergebnis zusammengezählt.

- Reine Autorisierungs-/Planbindung: 8 Prüfgruppen, ursprünglicher Exit 0.
- Neuer echter MCP-/PG18-Ownerlauf: 11 Prüfgruppen, ursprünglicher Exit 0.
- Tatsächliche SQL-Claims: 34 Prüfgruppen, ursprünglicher Exit 0.
- Batch-Worker: bestehende mechanische PGlite-Prüfungen mit gewollter Undo-Sperre, Exit 0.
- Direct-Worker: tatsächlicher PG18-Lauf mit neun Apply-Scope- und neun Apply-Progress-Gegenfällen sowie 20 Abweisungen historischer Undo-Aufträge, Exit 0.
- Bestehender Original-Move-Owner: 13 Prüfgruppen, Exit 0.
- Bestehender tatsächlicher Move-B2-COMMIT-ACK-Verlust und Original-Recovery: eine Prüfgruppe, Exit 0.
- Bestehender Original-Delete-Lauf: 20 Prüfgruppen, Exit 0.
- Bestehender Owned-Job-Lauf: 30 echte PG18-Prüfgruppen, Exit 0.
- Native Delete-Links: zwei reguläre Erfolgsgruppen für Personal/Cookie und Team/Bearer, Exit 0; keine erneute vollständige Fehlermatrix.
- MCP-Move-/Delete-Principals: 12 aktuelle Autoritätsgruppen, Exit 0.
- Finales gezieltes TypeScript `type-v6.log` und Scoped-Lint `lint-v4.log`: jeweils Exit 0, leere Diagnoseprotokolle.

Die neue MCP-Folge prüft echte aktuelle Token-/Client-/Session-/Workspace-/Toolrechte und tatsächliche SQL-Verbindungen. Beide Aktionen pflegen eingehende Links. Move erhält Dokument-/Lineage-Identitäten und verlagert Metadaten und Benutzerzustand. Delete archiviert native Identität und Inhalt und erzeugt reguläre Trashbelege; Metadaten und Benutzerzustand werden entfernt und sind nicht als Annotationswerte in den Trashmetadaten erhalten. Gegenfälle prüfen Fremdclient/-benutzer/-workspace, Rechte- und Sessionentzug, erneuerte Session bei unveränderter Originalattribution, Status ohne DML mit unveränderten Zeilen/`xmin`/Dateien sowie tatsächlichen Rechteentzug nach dem historischen Status-COMMIT. Verspätete oder geschluckte Autoritätsprüfungen müssen die echte laufende Phase vergiften.

Zwei verlorene Bestätigungen sind tatsächlich geprüft: ein committed Ownerabschluss mit anschließendem ACK-Verlust sowie ein committed Store-Claim mit anschließendem ACK-Verlust. Ein unabhängiger Adminread sieht den gespeicherten Originalzustand. Es entsteht keine zweite Operation; ein kopierter gelesener Header kann keinen Claim erzeugen. Nach explizit angeordneter Leaseexpiry setzt der feste Original-Recover denselben Auftrag fort. Bestehende-only-Eintritte legen keinen neuen Auftrag an.

Die 24 endgültigen Code-/Testquellen sind in `tested-source-pins-v1.json` festgehalten und entsprechen beiden Commits. Besonders relevante Originalbelege:

| Report | Quell-SHA-256 | Original-Log-SHA-256 |
| --- | --- | --- |
| `direct-mcp-workspace-path-owner-postgres-test.json` | `1c045a5f3f3b7f57210aa012e983a052fb9e38e7c78bac8c24b6f6b4b94fbcdd` | `0b2948e34b3a94a27855ee0e4054937faff810295cd13b6566afeabaa046ddb3` |
| `workspace-operation-owned-job-principal-postgres-test.json` | `c522981daa6a56ae241e6b591338b2c8c6d6b4b8a53731fcb93d7722e7715a59` | `9fca3259a5c66ddd913eb5b5a06c420c1c0aedcaf0bccff979c0ef7e90c8a690` |
| `workspace-operation-batch-claim-test.json` | `e7b8cb416fb787feda56f52df43119e8965763465ffd727761d29dbf4a85f126` | `d26ec8f8de6b97ee8f47283a5a987807d7dc7f3e91e0c9da792b685592b5ffd4` |

## Fehlversuche und enge Korrekturen

Alle Originalversuche bleiben erhalten. `all-attempts-resource-closure.json` prüft 24 Report-/Logpaare einschließlich elf fehlgeschlagener Versuche; frühere Fehler werden durch den abschließenden Erfolg nicht rückwirkend umbenannt.

- Der erste echte MCP-Lauf zeigt die fehlenden bekannten Editfelder/-trigger in der strengen Speicherprüfung. Die Produktkorrektur ergänzt ausschließlich den vorhandenen Migrationsvertrag.
- Die nächste Folge zeigt einen bereits physisch verschobenen PDF-Pfad nach Rechteentzug zwischen Phasen. Der zusätzliche frische Owner-Check vor dem physischen Schritt verhindert diesen geprüften Fall; die oben beschriebene ACL-/Filesystem-Grenze bleibt bestehen.
- Engere Folgefehler betreffen die Testanordnung: abgelaufene alte Token wurden vor dem eigentlichen SQL-Gegenfall beziehungsweise nach Sessionerneuerung im Metadatenfixture verwendet. Die finale Folge verwendet echte erneuerte Sitzungen und erreicht unveränderte Autoritätserwartungen. Rechte werden nicht gemockt.
- Der Legacy-Planfixture lädt den tatsächlichen Planer innerhalb desselben kompilierten Modulgraphen und erst nach der Fixture-Environmentinitialisierung. Alte Worker-Undo-Erwartungen berücksichtigen jetzt die ausdrücklich geltende Abschaltung; historische Undojobs werden vor Ausführung abgewiesen.
- Im bestehenden Owned-Job-Test kann `client.release(error)` die asynchrone Beendigung des tatsächlichen PG-Backends anstoßen, bevor eine sofortige Inventarabfrage dessen Abwesenheit sieht. Der finale Test beobachtet den ursprünglichen PID samt Backendstart mit echten Adminreads begrenzt bis höchstens eine Sekunde. Die strikten 503-/Cause-/Lease-/Marker-Erwartungen bleiben erhalten; kein COMMIT-/Aktionsretry. Die Ursache jedes älteren Fehlversuchs ist dadurch nicht nachträglich bewiesen.

## Abschluss und Grenzen

Unabhängige Quellenreviews finden keinen konkreten Blocker innerhalb dieses internen Anschlusses. Der frische GitNexus-Index endet nach 118,6 Sekunden erfolgreich. Die Änderungsanalyse beider gestagter Codeänderungen umfasst 24 Dateien, 264 Symbole und 17 bekannte Abläufe, Risiko `critical` wegen gemeinsam genutzter Jobinfrastruktur. Claim-/Worker-/Move-/Delete-Regressionen sind deshalb ausdrücklich enthalten.

`resources-after-final.json` bestätigt die elf erfolgreichen Originalprogramme, keine passenden Testschema-/Backendreste, abwesende exakt protokollierte Fixturepfade und bekannte Prozesse sowie dieselben vier gesunden verwalteten Dienste und drei HTTP-Healthantworten mit 200. Die zusätzliche Gesamtprüfung über alle Versuche bestätigt 32 bekannte abwesende PIDs und 32 exakt protokollierte abwesende DATA-/Bundlepfade. Nicht protokollierte frühere Ressourcenhistorien werden daraus nicht abgeleitet.

`code-parity.json` bestätigt identische getestete 24 Quellen und ausschließlich die drei vorgesehenen Root-/QA-Unterschiede; deren binärer Diff behält SHA-256 `b3c69c58e362e44bd5945415de80ec45537f5b67c41949020f78107cfc6997d4`. Root bleibt am privaten nativen Sessiongate aus, QA an. Eingefrorene Planhistorien bleiben unverändert.

Öffentliche MCP-Move-/Delete-Tools einschließlich Dienst/Registry/Ansichten, SDK-Move/Delete und deren OAuth-/Browseranschluss bleiben der nächste Schritt. Rohes Markdown, PI-Neuanlage, kontrollierter Python-Runtimeadapter, PDF-Import, Sucherweiterung, Standard-Skill/Sandbox und gemeinsame Gesamtabnahme bleiben Teil des Gesamtplans. Das Bewegen vorhandener PDF-Bytes belegt keinen Parser-/Notebookimport. Der ursprüngliche Produktionsfall `PREVIEW_BLOCKED` ist nicht als behoben nachgewiesen. Dateiaktions-Undo und Review Center bleiben aus. Dieser Schritt enthält keinen neuen Next-Build, Browser-/Gesamt-E2E-Nachweis, Push, PR oder Produktionsrollout.
