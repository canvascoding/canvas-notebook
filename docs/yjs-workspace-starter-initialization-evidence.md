# Workspace-Startdokument zentral initialisieren

Stand: 16. Oktober 2026. Produktanschluss auf Root `1e12bba0361eb34aca5a5ee5e3d6ec2d78fe6fa6` / QA `01c1316a44bbf764c26492ba0140508e52509a7c` lokal implementiert; frischer Produktionsbuild besteht. Der unveränderte native Delete-/Undo-Browserfall erreicht jetzt zweimal einen bestätigten Delete, scheitert jedoch an zwei verschiedenen Wiederherstellungsgrenzen. Sein Originalreport meldet **0/2 bestanden**. Die zusätzliche Starter-UI-Spec startet danach nicht. Der vorausgehende 409-Delete-Fehler bleibt im [ursprünglichen Befund](./yjs-workspace-starter-birth-evidence.md) erhalten. Die allgemeine native Aktivierung bleibt aus.

## Verhalten und Grenzen

Bei aktivierter nativer Dokumentintegration speichert der wirkliche Workspace-INSERT einen unveränderlichen Starter-Intent in derselben SQL-Transaktion. Er enthält behaltene Operation-/Request-UUIDs, Erzeuger und Workspacekontext sowie die am tatsächlich gehaltenen Original-FD beobachtete Dateiversion, SHA256, Bytezahl und Created-/Existing-Disposition. Alle vorhandenen expliziten Workspacearten verwenden diesen gemeinsamen Erzeugungspfad. Der Default-Personal-Bootstrap erhält dadurch weder eine neue Startdatei noch eine künstliche HTTP-Sitzung. Bei ausgeschalteter Integration bleiben Legacy-Seed und Create-Response erhalten.

Nach erfolgreichem Workspace-COMMIT und Schließen seiner Verbindung verwenden Web und Mobile denselben Initialisierungsdienst mit der tatsächlichen Anfrage. Erst nach dessen eigener abgeschlossener Principal-/SQL-Inspektion läuft der vorhandene feste Original-Schreibimport mit seinen eigenen Lifecycle-, Owner-, Mutations- und Recoveryphasen. Der Seeder schreibt keine Registry, Lineage oder nativen Zustand direkt; weder Upload noch Manual-Empty werden für die nicht leere Vorlage vorgetäuscht.

Ein bestätigter Workspace bleibt bei unbestätigter oder blockierter Initialisierung im HTTP-201-Ergebnis erhalten. Der Erstellungsdialog hält diese Workspace-ID auch bei fehlgeschlagenem Aktualisieren der Liste fest. Sein Statusfeld bietet lesende Prüfung und Wiederaufnahme desselben gespeicherten Versuchs. Es wiederholt keinen Workspace-Create und sendet keine neuen Operation-IDs, Quellpfade oder Inhalte.

| Schnittstelle | Verhalten |
| --- | --- |
| `POST /api/workspaces` und `POST /api/mobile/v1/workspaces` | Enthalten bei aktiver Integration zusätzlich `starterDocumentInitialization`; `workspace` bestätigt die abgeschlossene Workspaceanlage. |
| `GET /api/workspaces/{id}/starter-document-initialization` | Prüft aktuelle Rechte und den gespeicherten Versuch; führt keinen Import aus. |
| `POST /api/workspaces/{id}/starter-document-initialization` | Setzt ausschließlich diesen Versuch fort; 200 bei bestätigt, 202 bei unbestätigt, 409 bei blockiert. |
| Mobile unter `/api/mobile/v1/workspaces/{workspaceId}/starter-document-initialization` | Dieselben GET-/POST-Regeln und derselbe Dienst. |

Das öffentliche Ergebnis enthält Version, Workspace-ID, Status und gegebenenfalls sichere Codes sowie die behaltenen beiden UUIDs. Dateisystempfade, Session-IDs, Originalhashes und native Zustände bleiben privat. Ein fehlender erwarteter Intent ist unbestätigt, kein nachträglich erfundener Erfolg.

Wiederaufnahme bestätigt entweder den tatsächlichen Originalimport-Return oder dessen eigene unveränderliche zentrale Receipt mit passenden ursprünglichen Quellfakten und aktuellem authentifiziertem Native-Reader an derselben Dokument-/Lineage-/Generationsbindung. Beliebige initialisierte Gewinner werden nicht übernommen. Spätere unabhängige Textänderungen dürfen den ursprünglichen Yjs-Snapshot enthalten; eine spätere Pfad-/Generationsänderung wird nicht als neue Importfreigabe verwendet. Ein unklarer Commit oder Ressourcenabschluss bleibt unbestätigt.

Dies ist die Admission eines tatsächlich erhaltenen Originals. Ein vollständiger First-Projection-Abschluss und eine neue native-first Template-Quelle sind dadurch nicht implementiert. Für alte Workspaces ohne Intent wird kein unbeobachtetes Startdokument automatisch adoptiert. Die Statusoberfläche sitzt zunächst im bestehenden Erstellungsdialog; die API kann denselben gespeicherten Versuch später wieder aufnehmen. Allgemeine HTTP-Idempotenz der Workspaceanlage bei verlorener Create-Antwort ist eine getrennte, noch offene Anforderung.

## Tatsächliche lokale Prüfung

- Neun echte Dateisystemfälle: vier Vorlagentypen, vorhandene Originalbytes einschließlich BOM/CRLF/Emoji/leer, Ersetzung, Symlink/Hardlink, Größen- und Descriptorgrenzen sowie gesammelte Closefehler.
- Sechs PGlite-Gruppen: echte DDL zweimal, gemeinsames Workspace-/Intent-Rollback, unveränderliche UPDATE-/DELETE-Grenzen, tatsächliches FK-Cascade und striktes Lesen. Dies ist kein Nachweis mehrerer PostgreSQL-Verbindungen.
- Zehn mechanische Koordinationsfälle mit ausdrücklich ersetzten Auth-/SQL-Grenzen und echtem FS/Yjs. Sie sind kein tatsächlicher Auth-/COMMIT-Beweis.
- Sieben UI-Wiederaufnahmeprüfungen: kein automatischer Import beim Anzeigen, GET/POST an derselben ID, fremde Antworten und Netzwerkfehler erhalten die Warnung, blockierter und bestätigter Status bleiben unterscheidbar.
- 29 unveränderte Original-Bootstrap-PG18-Familien bestehen mit dem ergänzten globalen Migrationsdispatcher.
- Elf neue tatsächliche PG18-Familien bestehen mit wirklicher Personal-/Team-Anlage, Cookie-/Bearer-Authentifizierung, aktuellem Principal, Originalimport und zentraler Receipt. Enthalten sind unveränderte Wiederaufnahme ohne weitere Workspaceanlage, Quelländerung, tatsächlich fremder Importgewinner, Read-only-Mitglied, abgelaufene Session und ein nach ausgeführtem Originalimport-COMMIT absichtlich verlorener ACK. Dessen genau eine Receipt-Insertion und genau ein verlorener ACK sind belegt; derselbe Versuch wird bestätigt. Eigenes Schema, Clients und DATA werden vollständig geschlossen/entfernt.

Die ersten beiden neuen PG-Läufe scheiterten nach dem Ablauf-Test: Better Auth hatte die abgelaufene Session tatsächlich gelöscht; ein UPDATE stellte sie nicht wieder her. Die isolierte Fixture prüft jetzt diese echte Löschung und stellt für die folgenden unabhängigen Fälle die vollständige eigene Sessionrow wieder her, einschließlich erneuter echter Auth-Prüfung. Keine Produktberechtigung oder Businessassertion wurde dafür gelockert. Der finale Lauf endet mit Exit 0.

Brand-Workflow und Mobile-Workspace-Regressionsprogramm bestehen. Der alte `workspace-switcher-ui-test.ts` scheitert an Zeile 298 sowohl im neuen Root als auch im unveränderten bisherigen QA-Stand mit `false !== true`; seine Ursache ist damit nicht behoben. Der neue Browserfall prüft die tatsächliche Workspace-Auswahl ausdrücklich. Ein erster TypeScript-Lauf erreicht den standardmäßigen 4-GiB-Heap; mit 8 GiB werden die tatsächlichen Anschluss-/Testtypfehler sichtbar und korrigiert. Der vollständige finale TypeScript-Lauf und Scoped ESLint bestehen mit tatsächlichem Exit 0. Es wurden keine TypeScript-Grenzen abgeschaltet.

## Frischer Produktionsbuild und tatsächlicher Browserfolgelauf

Der unveränderte Originalsupervisor baut den oben genannten QA-Commit mit tatsächlichem Exit 0. Sourcefingerprint `90af2f25d34821bad890e8deb73b6ba769076e374ef1101917daa3041ff360ac`, Buildfingerprint `542c7c62aac9901c03c776a5244d08d283f5f893111ab6c9dce6cc0682a6d0e5`. Das originale Buildproof trägt SHA256 `20101b12f8eb57c7bd5e8a2d949145e47228d0ebe40a8fa5cd8be308104cda0a`. Diese Belege gelten für genau den gebauten Commit, nicht für spätere Änderungen.

Unabhängige Vor-/Nachprüfungen bestätigen dasselbe originale Buildproof und getrennte Source-/Buildfingerprints. Die 27 Anschlussdateien entsprechen ihren Gitobjekten, zwölf ursprüngliche QA-/Build-/Roomhelper, fünf Raumadapter und 59 weitere historische Pins bleiben unverändert. Root und QA unterscheiden sich weiterhin nur im Aktivierungsgate und zwei historischen Dokumenttexten. Das QA-Gate ist aktiviert, die allgemeine Root-Aktivierung bleibt aus. Der unabhängige POST-RUNTIME-Beleg trägt SHA256 `5a66ef4c0922b2f3e303bb830c267bf7c4abae06158996c0d34c0555fe51b08a`.

Die tatsächliche Browserfolge wird im ursprünglichen Supervisor mit den Specs `workspace-operation-native-delete`, `workspace-starter-initialization` und `workspace-operation-automatic` ausgewählt. Nur die erste startet. Ihr Originalreport enthält zwei deklarierte Fälle, null bestandene und zwei Fehler; keine Skips, Testtimeouts oder Unterbrechungen. Report-SHA256: `c971cbe3a1193bccae39b513a046544f7c588416a1e0edc97e0c632b5b3b844f`.

| Fall | Tatsächlich beobachtet | Nicht bestätigt |
| --- | --- | --- |
| Desktop | Delete HTTP 200, Job `applied/complete`. Undo wird angenommen und endet in `needs_recovery/recovery`, `BATCH_EXECUTION_FAILED`, 0/1 Schritte. Der ursprüngliche Poll scheitert nach 90 Sekunden am falschen fachlichen Endstatus. | Kein ursprünglicher Restore-Abschlussbeleg; keine frische Wiederöffnung oder vollständige Identitäts-/Inhaltsabnahme. |
| Mobile Web | Delete HTTP 200, Job `applied/complete`. Undo endet in `undone/complete`, 1/1 Schritte. Die ursprüngliche Assertion findet anschließend die Dateizeile 30 Sekunden lang nicht. | Erfolgreicher Jobstatus allein belegt keine sichtbar zurückgekehrte Datei und keinen nachfolgenden Read. |

Ein separater tatsächlicher, an eigene Datenbankidentität und READ-ONLY/RR gebundener Read vor dem Ressourcenabschluss bestätigt zwei Restore-Intents, aber nur die mobile Restore-Receipt. Desktop besitzt den generischen Workerfehler; dessen verschachtelte Ursache ist bislang nicht nachgewiesen. Auch die mobile Ursache zwischen wiederhergestelltem Katalog, Dateilistenantwort und UI ist noch einzugrenzen. Weder Timeouts noch Originalassertions oder Guards werden zur Abnahme gelockert. Der Readbeleg trägt SHA256 `5960ab772f7d61dfe1cc53eeb5060266d701f88216ffdd7f5291707c861ac7a3`.

Die eigene fehlgeschlagene Fixture `canvas-yjs-authority-lUhQWE` ist anschließend vollständig geschlossen: eigene Prozesse/Gruppen und Ports fehlen, Runlock ist frei, beide eigenen Datenbanken sind nach frischer Namens-/OID-/Owner-/Marker- und Null-Sessions-Prüfung ohne FORCE entfernt; DATA/tmp sind entfernt. Der separate Abschlussbeleg `manual-cleanup.json` trägt SHA256 `6d5d4077ee48e5fd5e8511c6911af45329c924e3f2399a3f284094f8690b1832`. Originale Recoverybelege bleiben unverändert fehlgeschlagen/unsicher; private Traces und Runtimegeheimnisse werden nicht veröffentlicht. Die verwaltete gemeinsame Testumgebung und fremde Devprozesse werden nicht entfernt.

## Noch ausstehende Abnahme

Die neue Spec `tests/workspace-starter-initialization.spec.ts` prüft Desktop und Mobile Web über den wirklichen Workspace-Switcher/Erstellungsdialog: genau eine Anlage, unmittelbar bestätigtes Startdokument, unveränderte Attempt-/Dokumentidentität bei GET/POST/GET, echte Auswahl des neuen Workspace und Öffnen des direkt editierbaren Welcome-Dokuments. Sie ist lintgeprüft, wurde im ausgewählten Browserlauf wegen des vorherigen Fehlers aber **nicht gestartet**.

Zuerst sind die beiden tatsächlichen Undo-Fehler zu beheben und derselbe unveränderte native Delete-/Undo-Browserfall erneut auszuführen. Danach folgen Starter-UI und die ursprüngliche physische Datei-/Linkregression. Gemeinsamer MCP-/Agent-/SDK-Zugriff muss ausdrücklich Erstellen, Lesen und Bearbeiten sowie [Suche → stabile Treffer-ID → vollständigen Read](./workspace-document-api-mcp-search-plan.md) abdecken. SDK/Standard-Skill-Auslieferung, PDF, volle native Linkmutationen und Move/Copy sowie die gesamte abschließende E2E-Abnahme bleiben offen. Das experimentelle Review Center bleibt ausgeschaltet und außerhalb des Auftrags.
