# Öffentliche MCP-Tools für Move und Delete

Stand: 19. Oktober 2026. Code auf Root `5c7b20480bd1b1f3df2126d7b737dbe20c065953`, auf QA `bc15c35bab634d177a811e7f056648dd91c89e92`. Der öffentliche Anschluss ist lokal über die tatsächlichen Handler und PostgreSQL geprüft. Ein frischer kompilierter OAuth-/Browserlauf und SDK-Move/Delete stehen noch aus. Allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben aus.

## Umgesetzter Anschluss

- Die registrierten Werkzeuge `move_knowledge_source` und `delete_knowledge_source` bieten Preview, Apply, Status und ausdrückliches Recover. Sie sind in den Einstellungen verfügbar und bleiben standardmäßig ausgeschaltet; bestehende Konfigurationen werden nicht automatisch erweitert.
- Der gemeinsame Dateioperationsdienst verbindet echte aktuelle MCP-Principals, den bestehenden nativen Planer, dauerhafte Claims und die ursprünglichen Move-/Delete-Owner. Native Move-Selektionen und ein einzelnes natives Deleteziel sind unterstützt. Daraus folgt keine allgemeine Löschabnahme für physische Dateien, Ordner oder Scenes.
- Preview liest die Quellen ohne Migration oder Checkpoint. Apply prüft vorhandene Originalaufträge zuerst; bestätigte Wiederholungen planen nicht neu. Recover setzt ausschließlich einen bestehenden Originalauftrag fort. Unbestätigte Ergebnisse bleiben ausdrücklich unbestätigt.
- Eingehende Links, Metadaten und die regulären Datei-Events verwenden die bestehenden zentralen Dienste. Historische Wiederholungen senden keine erneuten Add-/Unlink-Events.
- Requestversion, erlaubte Felder, kanonische Pfade, Caller-Operations-ID, Planbindung und Größen sind begrenzt. Die öffentliche Antwort unterscheidet Caller-ID, tatsächliche Batch-ID, Journalzustand und durch Originalbelege bestätigten Abschluss. Ein noch offener Journalheader kann neben einem bereits belegten historischen Abschluss bestehen.
- Der bestehende Worker und der neue Dienst teilen denselben Mechanismus für Claimverlängerung. Vor Ownerphasen werden laufende Verlängerungen abgewartet und ein verlorener Claim abgewiesen. Ein lang dauernder realer Dateischritt wurde in dieser Folge nicht zusätzlich abgenommen.
- Copy verwendet unverändert dieselben öffentlichen Regeln; ausschließlich die identische begrenzte JSON-Erfassung ist in ein gemeinsames Modul verschoben.

## Tatsächliche Validierung

Private Originalreports und Protokolle: `/private/tmp/canvas-mcp-path-public-edn_vzwu/`. Sieben ausgewählte Programme liefen seriell und endeten jeweils mit Originalexit 0. Das ist kein gemeinsames Browser-E2E-Ergebnis.

| Programm | Tatsächliche Abdeckung |
| --- | --- |
| `mcp-server-workspace-path-contract-test` | Acht reine Vertragsfamilien, einschließlich strikter Requests, Antwortgrenzen und sicherer Fehlerprojektion. |
| `mcp-server-workspace-copy-contract-test` | Acht bestehende Copy-Vertragsfamilien nach der gemeinsamen JSON-Extraktion. |
| `direct-mcp-workspace-path-tool-postgres-test` | Elf echte Handler-/PG-Gruppen: Registry, schreibfreie Preview, native Move/Delete samt Links und Events, historische Wiederholung, falsche Bindungen, vier tatsächliche COMMIT-ACK-Verluste sowie aktuelle und entzogene Sitzungsrechte. |
| `direct-mcp-workspace-copy-tool-postgres-test` | Sechs bestehende tatsächliche Handler-/PG-/Dateisystemgruppen. |
| `workspace-operation-batch-worker-test` | Bestehende mechanische PGlite-Workerregressionen einschließlich Undo-Sperre. |
| `workspace-operation-direct-worker-test` | Bestehende echte PG-Workerregressionen einschließlich historischer Undo-Abweisung. |
| `direct-mcp-workspace-path-owner-postgres-test` | Elf bestehende tatsächliche MCP-/PG-Ownergruppen. |

Die vier neuen ACK-Verlustfälle betreffen jeweils Move und Delete nach tatsächlichem Claim-COMMIT beziehungsweise tatsächlichem Abschluss-COMMIT. Die unabhängige Adminverbindung sieht die committed Originalzeile, bevor die Rückmeldung absichtlich verloren geht. Status bleibt ein Read; Recover verwendet ausdrücklich dieselbe Operation. Ein echtes erneuertes Token behält die Originalattribution. Ein abgelaufenes Token erhält tatsächlich HTTP 401 mit Authentifizierungsanforderung vor dem Dispatcher.

Der Handlerlauf verwendet echte Web-Requests und Originalhandler im Prozess. Er belegt weder TCP-Transport noch OAuth-Ausstellung oder eine kompilierte Browseroberfläche. Die Datei-Events werden am tatsächlichen Dienst beobachtet; der rohe Dateiwatcher und sichtbare Browserzustände sind damit nicht erneut abgenommen.

Finales gezieltes TypeScript und Scoped-Lint enden jeweils mit Exit 0; die Diagnoseprotokolle sind leer. `npm run test:mcp:server-settings` besteht im abschließenden Lauf mit tatsächlich gespeichertem Childexit 0, einschließlich bestehender Bootstrapprüfung und der unveränderten Opt-in-Politik.

Die 17 getesteten Code-/Testquellen stehen in `tested-source-pins-v1.json`, SHA-256 `363f775ad7c62a627c7e24191a139897d93af7e4b6abc802ae49e8649391daf5`. Der neue tatsächliche Handlerlauf bindet Testquelle `f16e5b5c7077eafc1430744b97c2380bb34a7454c95857034a17c7ec178020e8` und Originalprotokoll `11dd8cf8d90654751d763cf42b77c833660cfed21f57a859eba0746ddc210423`.

## Erhaltene Fehlversuche und Grenzen

Der erste tatsächliche Handlerlauf endet mit Exit 1: Die Dateiinventur berücksichtigt zunächst auch die beabsichtigte erfolgreiche MCP-Nutzungshistorie unter dem exakten betrieblichen Unterbaum `users/member/mcp/server-usage`. Die korrigierte Inventur nimmt nur diesen Unterbaum aus; Workspace, Assets, Journale, Trash, Backups und sämtliche geprüften Domainzeilen samt `xmin` bleiben streng verglichen. Originalquelle, Report und Protokoll des Fehlversuchs bleiben separat erhalten. Dieser erste Lauf wird nicht rückwirkend als bestanden bezeichnet.

Die erste Settingshülle scheitert an eigenen Node-/tsx-Caches, nachdem beide Programme OK ausgeben; ihr tatsächlicher Childexit wurde nicht gespeichert und ist daraus nicht ableitbar. Die korrigierte Hülle speichert den Childexit vor der Ressourcenprüfung und entfernt ausschließlich ihre genau geprüften eigenen Cachepfade. Ursprünglicher Hüllenfehler und Protokoll bleiben erhalten. Zwei anfängliche reine Testtypfehler sind vor dem finalen Typecheck korrigiert.

Unabhängige Quellenreviews finden innerhalb dieses Anschlusses keinen konkreten Blocker. GitNexus wurde erfolgreich neu indiziert; die gestagten Codeprüfungen beider Worktrees erfassen 17 Dateien und 229 Symbole bei Risiko LOW. Keine abgebildeten Abläufe bedeutet hier keine vollständige dynamische Registry-Abdeckung. Gemeinsame Worker- und Copyregressionen sind deshalb ausdrücklich enthalten.

`resources-after.json` bestätigt alle sieben erfolgreichen Originalprogramme, keine passenden Testschema-/Backendreste, abwesende exakt protokollierte Fixturepfade und bekannte Prozesse sowie dieselben vier gesunden verwalteten Dienste und drei HTTP-Healthantworten mit 200. Der frühere fehlgeschlagene Lauf besitzt einen eigenen erfolgreichen Ressourcenabschluss. Es wurde kein Container gebaut oder neu gestartet.

SDK-Move/Delete und die zusätzliche Browserfolge liegen bislang nur als private unintegrierte Kandidaten vor. Rohes Markdown, weitere Datei-/Ordner-/Scene-Lifecyclefälle, interne native Agentenneuanlage, kontrollierter SDK-Runtimeadapter, PDF-Import, Sucherweiterung, Standard-Skill, übrige Sandboxwege und die gemeinsame Endabnahme bleiben offen. Der ursprüngliche Produktionsfehler `PREVIEW_BLOCKED` ist weiterhin nicht als behoben nachgewiesen. Kein neuer Next-Build, allgemeiner Aktivierungsnachweis, Push, PR oder Produktionsrollout gehört zu diesem Schritt.
