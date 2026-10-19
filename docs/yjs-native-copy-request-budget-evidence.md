# Native Copy: vollständiges kanonisches Requestbudget vor Vorbereitung

Stand: 19. Oktober 2026. Dieser Schritt schließt das zusätzliche Größenproblem vor dem öffentlichen MCP-Copy-Anschluss. Er registriert noch kein öffentliches Tool und aktiviert den normalen nativen Editor-/Dateiaktionspfad nicht.

## Tatsächlicher Vertrag und gemeinsamer Einbaupunkt

Der neue reine `assertNativeCopyRequestBudget` prüft den vollständigen neuen ursprünglichen Copy-Request einschließlich echter Origin und endgültiger Planselektionen auf höchstens 65.536 UTF-8-Bytes. Origin enthält auch die beiden tatsächlichen Workspacekontexte. Die Reihenfolge der Objektschlüssel verändert den JSON-Bytebedarf nicht. Ein erster JSON-Bytecheck verhindert, dass ASCIIübergröße bereits als allgemeiner Zeichenlimitfehler des unveränderten Journalserializers entweicht; anschließend werden tatsächliche kanonische Serialisierung und Bytebedarf ebenfalls geprüft. Andere Serializerfehler werden nicht pauschal zu Größenfehlern umgedeutet.

`observe` ruft den Guard genau einmal nach der endgültigen Managed-Planbildung und echter Kollisionsauflösung auf. Die beiden direkten Aufrufer Preview und `createStage` verwenden damit dieselbe Voraussetzung vor Assetlesen, physischer Copyvorbereitung und Stageveröffentlichung. Die separate `NativeCopyRequestTooLargeError` liefert `NATIVE_COPY_REQUEST_TOO_LARGE`/413; der breit verwendete Owner-Hubfehler und allgemeine Journalserializer bleiben unverändert.

Dies ist die zusätzliche kanonische Grenze, keine Behauptung, dass ein begrenzter MCP-Wirekörper dieselbe Größe wie das spätere Original hat. Ein Originalstage, dessen Auftrag bereits besteht, durchläuft weiterhin die ursprünglichen History-/Recoveryprüfungen. Der neue Guard wird diesem historischen Auftrag nicht nachträglich als neue Zulassungsentscheidung aufgesetzt.

## Tatsächliche Prüfungen

Alle vier Originalfolgen liefen seriell gegen den vorhandenen PostgreSQL-18-Stack und endeten mit Exit 0 ohne Signal. Der Runner selbst endete ebenfalls mit Exit 0.

| Folge | Ergebnis |
| --- | --- |
| `workspace-operation-native-copy-request-budget-test` | 3/3, Originalexit 0 |
| `workspace-operation-native-copy-request-budget-postgres-test` | 4/4, Originalexit 0 |
| `direct-mcp-native-copy-owner-postgres-test` | 9/9, Originalexit 0 |
| `workspace-operation-native-copy-owner-postgres-test` | 26/26, Originalexit 0 |

Damit bestehen **42 tatsächliche Prüfgruppen**, einschließlich sieben neuer Budgetfamilien. Die reinen drei Familien verwenden historische V1-/V2-Herkunftsdaten, den echten Helper und den tatsächlichen kanonischen Serializer: genau 65.536 Bytes werden akzeptiert, 65.537 abgelehnt; Unicode und JSON-Escaping zählen einschließlich vollständiger Origin. Die ASCIIprobe zeigt zusätzlich den gezielten 413-Vertrag vor dem bisherigen allgemeinen Zeichenlimitfehler. Diese reinen Datenfixtures sind kein Autoritätsnachweis.

Die vier neuen PG-/FD-Familien verwenden die echte bestehende Web-/MetadataOwner-Fixture, einen nativen Upload und 39 opake Quelldateien. Genau 65.536 Bytes sind durch echte Owner-Vorschau bestätigt; eine 40-Dateien-Veröffentlichung am Maximalbudget wird nicht behauptet. 65.537 Bytes werden sowohl bei Preview als auch frischer Execute vor Stage, Domänen-DML und physischer Vorbereitung abgewiesen. Tatsächliche Kollisionsauflösung addiert vier ASCIIbytes: 65.532 vor Auflösung/65.536 danach bleiben zulässig, 65.533/65.537 werden früh abgewiesen. Eine separate kleine tatsächliche Kopie verliert die Bestätigung erst nach ausgeführtem, unabhängig sichtbarem B1-COMMIT und wird über den festen Recover mit denselben ursprünglichen Clone-IDs, Receipts und Requestbytes abgeschlossen.

Bei Ablehnung bleiben sämtliche ausgewählten Domänenzeilen samt `xmin`, Workspace-/Assetbytes und Dateisystemidentitäten sowie Stage-Namen unverändert. Die Fixture initialisiert vor der Baseline transparent das vorhandene Stageverzeichnis. Legitime Lockmetadaten außerhalb der Workspaces werden nicht als vollständig unverändert ausgegeben. Tatsächliche Autorität, SQL-Ergebnisse, Planner und Publisher werden nicht ersetzt.

Gezieltes TypeScript einschließlich beider neuer Testdateien und Scoped-Lint bestehen mit Exit 0; `type-final.log` und `lint-final.log` sind leer. Unabhängige Quellenreviews des Helpers/Einbaupunkts und beider Tests fanden keinen konkreten Blocker. Die bestehende MCP9- und Owner26-Folge sind zusätzlich tatsächlich erneut ausgeführt, ältere größere Abnahmen werden nicht als wiederholt ausgegeben.

## Quellen und unabhängiger Abschluss

Private Originale, Berichte, Logs, Runner und eingefrorene Quellen liegen unter `/private/tmp/canvas-mcp-copy-request-budget-mfi1sqxn/`. Ausgangsstände: Root `8878293156a5306ba9a93a54dfb9bace90723393`, QA `c8cd1feb5aa03186a24d3ea4ce42c976f4e1803c`. Die fünf Code-/Testquellen wurden in Root und QA bytegleich integriert und während der gesamten tatsächlichen Folge unverändert gehalten.

| Geänderte Quelle | SHA-256 |
| --- | --- |
| `app/lib/files/workspace-operation-native-copy-owner.ts` | `6b42c30c83864642c942da30e2d88194abe39d1d92807cb95f5baf5442abc982` |
| `app/lib/files/workspace-operation-native-copy-request-budget.ts` | `ad4cae2e8568405e9a8a7dc01b6b1b45143cae07edfd18f662a6a6e45a531d3f` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `83ff21a8cb4439833a4a3891d7989fd606ddd39f66995150b9736b4cf46a9d9d` |
| `scripts/workspace-operation-native-copy-request-budget-test.ts` | `51ad68f5681361d30485562153659d153526e81d2dcc2fbab0c53c434742d201` |
| `scripts/workspace-operation-native-copy-request-budget-postgres-test.ts` | `5b0ef63f786a78bb80df77fea98537f9c5d3e00a7678766baf8ad41e078191e9` |

| Originallog | Ende (UTC) | SHA-256 |
| --- | --- | --- |
| `workspace-operation-native-copy-request-budget-test.log` | `2026-10-19T03:54:39.878Z` | `b66ee28cce0f5665dc00d0434920e98247780e0c9c0f695f70150783c39e698e` |
| `workspace-operation-native-copy-request-budget-postgres-test.log` | `2026-10-19T03:55:08.298Z` | `e656e080ea876a754547e97228c5bb74304f0d1c2e6ec2c2880f33e912e394e1` |
| `direct-mcp-native-copy-owner-postgres-test.log` | `2026-10-19T03:57:01.823Z` | `d6a85b602a4bd16c96508debfdaf4638715594c13eadc748c3cdd66446d57419` |
| `workspace-operation-native-copy-owner-postgres-test.log` | `2026-10-19T04:07:31.825Z` | `a7af979e7f33c42a1e5051d74d52f8effeeb04ad5d2f68b20ba9370e748cf29b` |

Die frische begrenzte RR-/READ-ONLY-Abschlussprüfung am `2026-10-19T04:08:42.659Z` endet mit Exit 0. Alle vier Originalberichte und Quell-/Loghashes sind bestätigt; vor und nach den Tests gibt es null passende eigene Schemas/Backends. 3 geloggte eigene DATA-Verzeichnisse und 7 bekannte Runner-/Fixture-PIDs sind abwesend. Die Prüfverbindung hat keine zugewiesene XID und wird geschlossen. Vier verwaltete Dienste behalten dieselben IDs und gesunden Zustand, drei Health-URLs antworten HTTP 200. `resources-after.json` hat SHA-256 `bd44ec5d4b418f0607df6a98e0da95a2e9711b354ee41bc8dc7597241c57e40b`. Dies ist eine Abschlussbeobachtung, keine Vollhistorie unbeobachteter Prozesse. Kein Container wurde gebaut oder verändert.

Der bestehende dreiteilige Root-/QA-Unterschied und der eingefrorene Hauptplansuffix bleiben unverändert. Der zusätzliche frische Main-Abruf hat Notebook-main `1506927038b80036749266a56fb769dcb6e6d18c` gefunden; dieser Stand war während dieser Abnahme noch nicht integriert. Die 25 neuen Main-Dateien betreffen Chat-Erweiterungen/Composio und überschneiden die fünf hier geänderten Quellen nicht. Marketplace-main bleibt `54ce6573502f67f4cb6227871000aa315ab87dbe`. Der Main-Anschluss erfolgt getrennt nach diesem abgeschlossenen Schritt; dadurch werden diese Originaltests nicht rückwirkend einem neuen Quellenstand zugeschrieben.

## Offener Anschluss

Der öffentliche Copy-Wirevertrag muss `NATIVE_COPY_REQUEST_TOO_LARGE` fest auf `COPY_TOO_LARGE`/413 abbilden. Gemeinsamer MCP-Dienst, Toolregistry, reiner öffentlicher Status/ausdrücklicher Recover, Settings und SDK-Methoden bleiben bis zu ihrer tatsächlichen Integration und Abnahme offen. Die vorbereiteten privaten Wire-/Dienst-/Unitkandidaten sind keine verfügbaren öffentlichen Funktionen.

Dateiaktions-Undo, Review Center und allgemeine Aktivierung bleiben aus. Dieser Schritt ist kein neuer Produktionsbuild, HTTP-/OAuthbrowser-, SDK- oder Gesamt-E2E-Nachweis. Vollständiger Plan, finale gemeinsame Abnahme und gesonderte Veröffentlichung bleiben offen.
