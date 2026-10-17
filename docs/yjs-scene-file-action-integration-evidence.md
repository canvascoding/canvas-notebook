# Scene-Inventur und Verfügbarkeit während Dateiaktionen

Stand: 18. Oktober 2026. Geprüfter Teilanschluss; die vollständige Koordination gemischter Dateiaktionen bleibt offen. Die allgemeine native Aktivierung bleibt aus.

Notebook-main `67c509c08a204b7481fa063cf5de007de8538dd4` und Marketplace-main `54ce6573502f67f4cb6227871000aa315ab87dbe` wurden erneut gefetcht und sind unverändert. Der Notebook-Stand ist im Arbeitsbranch enthalten. Für den Documents-Skill gelten weiterhin die vorhandenen Core-/Package-/Runtime-Discovery-Verträge aus [§4.1 des Plans](./central-notebook-file-api-import-plan.md#41-standard-skill-und-kontext-erst-bei-bedarf); der Kandidat ist noch nicht ausgeliefert.

## Implementiert

Der neue [Scene-Katalog](../app/lib/collaboration/workspace-scene-catalogue.ts) liest Registry, Scene-Header und Lineage in einem begrenzten SELECT auf der vom Aufrufer gehaltenen Verbindung. Beide Registry-/Statepfade und Workspaces bestimmen den Prüfbereich; aktive verwaiste oder widersprüchliche Einträge werden nicht durch Inner Join, Suffixfilter oder fehlende Dateiprojektion ausgeblendet. Registry ohne Scene-State bleibt ausdrücklich `missing-state`, ohne stillen Bootstrap oder Dateifallback. `initialized` bezeichnet vorhandene Headerfakten, keine bereits validierten Scene-Inhalte oder Mutationsberechtigung.

Der Katalog prüft Scope, Lineage, sichere Ganzzahlen, Hashformat, Sequenzordnung und Ergebnisgrenzen. Er überträgt nur JSON-Bytegrößen und öffnet weder Datenbankverbindungen noch Transaktionen oder Dateien. Scene-/Assetinhalte werden hier nicht gelesen. Er ist noch nicht an den gemeinsamen Source-Collector und die Copy-/Move-/Delete-Stages angeschlossen.

Die [Availability-Prüfung](../app/lib/excalidraw-collaboration/lifecycle-availability.ts) verwendet die bestehende zentrale Lifecycle-/Reservationsprüfung innerhalb einer echten kurzen SQL-Transaktion. Öffentliche [Scene-Eingänge](../app/lib/excalidraw-collaboration/scene-service.ts) und [Portable-Import](../app/lib/excalidraw-collaboration/portable-import.ts) halten dabei bereits den Workspace-Kernellock:

- Get löst eine Dokument-ID zuerst auf ihren aktuellen Pfad auf und prüft dann vor Bootstrap und Checkpointinspektion.
- Create liest eine bestehende Receipt zuerst. Ein neuer Request prüft vor Preparing-Receipt und Dateiveröffentlichung; ein historischer Retry folgt seiner Dokument-ID, eine unterbrochene Erstellung ohne ID ihrem gespeicherten Pfad.
- Import prüft vor Registry-, Asset- und Dateiveröffentlichung.

Ein tatsächlicher Lifecycle-Busy-Fehler wird als `EXCALIDRAW_FILE_LIFECYCLE_BUSY` mit Status 409 an die vorhandenen Scene-Adapter übergeben. Andere Fehler werden nicht umgedeutet. Es gibt keinen öffentlichen Schalter zum Ignorieren einer Reservation.

## Tatsächliche Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| `npm run test:collaboration:scene-catalogue:postgres` | 8/8 echte PG18-Gruppen: Registry/State/Lineage, fehlende Projektion, fremde Suffixe, beide Scopeseiten, Cross-Workspace, int8-Protokoll, Header ohne JSON-Body und wiederholte Caller-RR-READ-ONLY-Reads ohne DB-/FS-Änderung. |
| `npm run test:excalidraw:lifecycle-availability:postgres` | 6/6 echte Servicegruppen: reservierte initialisierte/noch nicht initialisierte Scenes, Create/Import, terminale Freigabe, Unterbaumgrenzen und D1→Move→D2. Busy erhält relevante Zeilen samt xmin sowie Dateien/Inodes und Assets. |
| `npm run test:documents:read:tools` | Bestehende 15/15 registrierte MCP-/PI-Lesegruppen nach Erweiterung des festen ESM-Teststarters erneut bestanden. |
| Compiler/Lint | Produkt-Typecheck und Scoped-Lint bestanden. Vollständiger Typecheck mit 8 GiB endet weiterhin mit denselben 69 geerbten Testdiagnosen; der vollständige Diagnoseblock ist bytegleich zum vorherigen Main-Integrationsbeleg. |

Die neuen Servicefälle verwenden das bestehende isolierte PG18-/DATA-Fixture mit vollständigen Migrationen. Direkte SQL-Arrangements erzeugen ausdrücklich Testdaten und Reservationszustände; sie beweisen keinen vollständigen Copy-Handoff. Die Tests behaupten weder neue HTTP-/OAuth-Autorisierungsabnahme noch einen Browserlauf oder einen echten Live-Agententurn. Die spezielle Busy-Antwort ist als Domainfehler geprüft; ihre vollständige REST-/MCP-Transportabnahme steht aus.

Die drei neu erzeugten privaten Fixtures einschließlich des ersten fehlgeschlagenen Starts sind unabhängig auf entfernte Schemas, geschlossene Sessions und entfernte DATA-/Bundleverzeichnisse geprüft. Die vier bereits verwalteten Dienste wurden nicht neu gebaut oder ersetzt.

Originale unter `/private/tmp/canvas-scene-file-actions-7x8lcv2_/catalogue-admission/` halten Exits, Quellpins, Logchecksummen und Ressourcenprüfung. Der erste direkte tsx-Start scheiterte an `ERR_PACKAGE_PATH_NOT_EXPORTED`; der bestehende ESM-Starter führt die echten Quellen mit installierten Paketen aus. Der erste vollständige Typecheck wurde am Standardheap von 4 GiB mit SIGABRT beendet; der Gegenlauf verwendet dieselben 8 GiB wie der vorherige Vergleich. Beide roten Originale bleiben erhalten.

## Nächster Anschluss

Der gemeinsame Kernellock ist bei gemeinsamem DATA prozessübergreifend. Nach einem Prozessabbruch bleibt die dauerhafte Reservation entscheidend. Deshalb sieht die nächste Copy-Integration B1-Intents vor; neue aktive Scene-/Lineage-/Asset-Metadaten sollen erst in B2 gemeinsam mit ihren Receipts und dem Abschluss entstehen. Der feste Owner muss seine eigene originale Reservation auf seiner tatsächlichen Verbindung prüfen. Die öffentliche Availability-Prüfung ersetzt diesen privaten Phasenvertrag nicht.

Noch fehlen begrenzte Scene-Snapshots und schreibfreie Assetreads auf derselben Verbindung, versionierte Composite-Stages, Asset-/Inodebesitzbelege und deren Wiederaufnahme sowie Scene-Komponenten für Move/Delete einschließlich gemischter Ordner. Erst deren gemeinsame Pfad-, Inhalts- und Linknachweise erlauben den vollständigen Dateiaktionsabschluss. Danach bleiben die im Hauptplan ausgewiesenen Such-, SDK-/Skill-/PDF-Anschlüsse und die frische gemeinsame Build-/End-to-End-Abnahme erforderlich. Dateiaktions-Undo und Review Center bleiben ausgeschaltet.
