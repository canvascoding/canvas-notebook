# Native Autorität vor DOCX-Dispatch beim API-Read

Dieser fokussierte Anschluss basiert auf `5ec766573c1d6d50865d8b7db62b68c4f856e821`. Er verändert nur den Dispatch und die typisierte Catalogue-Konfliktantwort von `GET /api/files/read`; Office-Service, Provider-Strategien und UI bleiben unverändert.

## Vertrag

- Nur `.docx` nimmt außen den Workspace-Kernelmutex und danach den bestehenden nativen Shared-SQL-Read-Fence. Die native Antwort hat Vorrang vor dem Suffix.
- OfficeSnapshot läuft ausschließlich beim ausdrücklich `null` liefernden Reader: unregistriert oder nachgewiesen pristine. Dieser Fallback bleibt bis einschließlich Binärread, bestehender Journal-Recovery und passender Revision innerhalb desselben Shared-Fence. Der Office-Kernelmutex wird reentrant betreten.
- Native Missing-State, fremde Identität, Quarantäne, beschädigte Updates/Vektoren und verlustbehafteter Export werden niemals durch alte oder fehlende DOCX-Projektionen ersetzt. Die Route behandelt typisierte `WorkspaceDocumentCatalogueError` als 409. Beschädigte Binär-/Vektorbeweise behalten den bestehenden geschlossenen 500-Vertrag; sie sind keine reparierbare Quarantäne-Metadatenantwort.
- Native Bootstrap/Metadaten liefern die vorhandene native Identität und `contentUnavailable`, ohne Office-Base64, erfundene Revision oder Rekonstruktion aus Markdown. Bekannte native Zeiten bleiben Epoch-Sekunden.
- Echte unregistrierte/pristine Word-Dateien behalten den bisherigen Office-Vertrag: begrenzter tatsächlicher Binärread, Base64, exakter Hash und Revision, Workspace-/Viewer-/Lineagebindung, Kompatibilitätsprüfung, `meta=1` und Original-Autor/-Session bei Journal-Recovery. Ein nicht veröffentlichter Vorschlag ersetzt keine kanonischen Bytes. Der bestehende Read-Zugriff benötigt weiterhin `canRead`, nicht `canWrite`.

## Lokaler API-/PostgreSQL-Nachweis

Die [neue Route-Fixture](../scripts/native-docx-file-read-postgres-test.ts) führt den tatsächlichen transpilierten GET-Handler mit echten Yjs-Updates, DOCX-Paketen, Dateisystem, OfficeSnapshot, Office-Journal und isoliertem PostgreSQL 18 aus. Nur HTTP-Authentifizierung/Rate-Limit und die Auswahl der eigenen DB-Connectionfactory sind Adapter; ein Host oder Browser wird nicht gestartet. Alle Tabellen liegen in einem neu erzeugten, eigentumsgeprüften Schema mit privatem DATA-Root. Öffentliche Tabellen dienen ausschließlich als DDL-Vorlage. Checkouts werden geschlossen und das eigene Schema nach der Prüfung entfernt.

Die ausgeführte Matrix prüft:

1. Native `.docx` ohne Projektion und mit gültiger alter Office-Projektion; native Metadaten und Bootstrap. Kein Aufruf von OfficeSnapshot oder dem physischen Route-Read/Stats-Fallback, keine File-Revision.
2. Missing-State und fremde Organisation als Konflikt; korrupten Vektor als geschlossenen Fehler auch im Bootstrap; explizite Quarantäne mit verfügbarer Recovery-Metadatenantwort; Rich-Exportverlust mit 422 und weiterhin möglichem Metadata-Bootstrap. Keine Office-Ausweichroute.
3. Echte unregistrierte/pristine DOCX-Dateien, unveränderte Base64-/Hash-/Revisions-/Scope- und Kompatibilitätsfelder, Metadaten und Bootstrap bei `canWrite:false`.
4. Tatsächlich unterbrochene Office-Veröffentlichung: passende kanonische Bytes finalisieren den vorbereiteten Journal-Eintrag mit ursprünglichem Agent-/Sessionattribut. Ein anderer unveröffentlichter Vorschlag bleibt vorbereitet.
5. Ein anderer tatsächlicher Kernelhalter verzögert den Read vor dem SQL-Checkout; der Read hält während dieses Wartens keinen Shared-SQL-Fence.
6. Während des Office-Fallbacks kann der echte Initialisierungs-Admission-Lock bis zum bestehenden SQL-Locktimeout nicht erworben werden; der Move-Writer-Gate meldet Busy. Nach dem Read ist der Lifecycle-SQL-Gate wieder erwerbbar. Diese Prüfung verändert kein echtes Dokument durch Initialisierung oder Move und ersetzt keinen vollständigen Lifecycle-E2E.
7. Eine durch den tatsächlichen DA04-Service erzeugte native Reservierung lässt den gebundenen Read zu und blockiert neue Lifecycle-Veröffentlichung; der Read ruft kein OfficeSnapshot auf. Die Reservierung wird kontrolliert beendet.

Ausführungsbefehl, mit einer privaten verwalteten Env-Datei als explizitem Input:

```sh
CANVAS_NATIVE_READ_TEST_ENV_FILE=/absolute/private/managed.env npm run test:files:native-docx-read:postgres
```

Zusätzlich ausgeführt: `npm run test:collaboration:native-file-read` (fünf Helperfälle, zehn Routefälle und die eigenständige Read-only-Metadata-Matrix) sowie `scripts/office-document-commit-test.ts` mit echtem DOCX/FS und PGlite für exakte Commit-/Crash-/Journalverträge. Der bestehende PGlite-Office-Test meldet daneben nicht konfigurierte asynchrone Audit-/Public-Share-Worker; seine Kernassertions bestehen, diese Nebenwirkungen sind dadurch nicht abgenommen. TypeScript/ESLint und GitNexus-Precommitprüfung gehören zum Abschluss dieses Pakets.

## Offene Consumer- und Writer-Gates

- `FileEditor` wählt `.docx` weiterhin anhand des Suffixes als `DocxWorkspaceEditor`. Dessen Client erwartet Office-Base64 und eine konkrete Office-Revision. Dieser API-Nachweis ist **keine native-.docx-UI-Abnahme**.
- `buildPostgresState` findet die bestehende Yjs-Identität bereits unabhängig vom Suffix, berechnet aber `crdtCapable`/Lockstrategie weiterhin aus dem Suffix. `CurrentFile` enthält kein typisiertes `nativeSource` für eine identitätsbasierte Editor-Auswahl. Provider-, FileStore-/FileEditor- und DOCX-Client-Anschlüsse bleiben gesonderte Arbeit.
- OfficeSnapshot ist ein Read mit bestehender Journal-/Revisionsfinalisierung auf separaten Writer-Verbindungen. Die vollständigen Office-/Standalone-Nebenwirkungsfences und deren Reservierungsverträge bleiben offen. Die native Reservierungsprobe behauptet keinen abgesicherten Office-Recovery-Write unter einer fremden Office-Reservierung.
- Ein zukünftiger Office-Writer-Gate darf innerhalb dieses Shared-Fence nicht auf einer anderen SQL-Verbindung exklusiven Workspace-Admission-Lock anfordern. Der Connection-/Leasevertrag muss dann ausdrücklich angepasst werden; ein Shared→Exclusive-Upgrade oder ein ungeprüfter Probe-und-Später-Read sind keine sichere Anschlusslösung.
- V6 und sämtliche privaten Runtime-Belege bleiben unverändert. Dieses Paket beinhaltet weder Activityfix noch einen neuen Build-/Browserlauf. V7 benötigt erst den integrierten Root-Stand, einen echten frischen Build, unabhängig geprüften Seal und gesonderten START. Native Mobile, Produktionsrollout und native `.docx`-Editoroberflächen haben hier keinen neuen Nachweis.
