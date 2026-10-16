# Workspace-Startdokument zentral initialisieren

Stand: 16. Oktober 2026. Produktanschluss lokal implementiert; frischer Build und Browserabnahme stehen für diesen Code noch aus. Der vorausgehende echte Delete-Fehler bleibt im [ursprünglichen Befund](./yjs-workspace-starter-birth-evidence.md) erhalten. Die allgemeine native Aktivierung bleibt aus.

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

## Noch ausstehende Abnahme

Die neue Spec `tests/workspace-starter-initialization.spec.ts` prüft Desktop und Mobile Web über den wirklichen Workspace-Switcher/Erstellungsdialog: genau eine Anlage, unmittelbar bestätigtes Startdokument, unveränderte Attempt-/Dokumentidentität bei GET/POST/GET, echte Auswahl des neuen Workspace und Öffnen des direkt editierbaren Welcome-Dokuments. Sie ist bislang nur lintgeprüft.

Danach ist derselbe unveränderte native Delete-/Undo-Browserfall erneut auszuführen, gefolgt von der ursprünglichen physischen Datei-/Linkregression. Zwölf ursprüngliche QA-/Build-/Roomhelper und fünf bestehende Raumadapter sind im Root und bisherigen QA unverändert. SDK/Standard-Skill, PDF, volle native Linkmutationen und Move/Copy sowie die gesamte abschließende E2E-Abnahme bleiben offen. Das experimentelle Review Center bleibt ausgeschaltet und außerhalb des Auftrags.
