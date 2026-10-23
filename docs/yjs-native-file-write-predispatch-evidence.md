# Native Dokumente vor Datei-Speicherdispatch schützen

Stand: 2026-10-14. Root übernimmt vier Dateien aus `061a5fc1d292eddc6c49ea0fb6292cae2e713a57` bytegleich. Dieses abgeschlossene Source-TODO gehört zum [Gesamtplan](./yjs-document-authority-consolidation-plan.md); es schließt noch nicht dessen allgemeinen Writer-/Publikationsvertrag.

Der [Datei-Speicherendpunkt](../app/api/files/write/route.ts) installiert eine private Prüfung im vorhandenen [Schreibservice](../app/lib/files/write-service.ts). Innerhalb des tatsächlich gehaltenen Workspace-Kernels und vor Suffix-/Office-/Revisionsdispatch liest [assertNoInitializedNativeFileWriteBeforeDispatch](../app/lib/files/native-file-write-authority.ts) den Dokumentkatalog unter einer eigenen kurzen Read-only-Transaktion und tatsächlicher gemeinsamer Admission-Sperre. Initialisierte oder fehlende native Autorität und native Nachfahren verhindern eine physische Gesamtersetzung, unabhängig von Dateiendung und vorhandenen Projektionsbytes. Katalogkonflikte erhalten eine begrenzte öffentliche Fehlermeldung ohne fremde native IDs.

Die Prüfung verweigert aktive Reservationen und fremde exklusive Sperren. Eine geformte öffentliche ALS-Lease kann lediglich eine Ablehnung auslösen, keinen positiven Skip oder Grant. Die SQL-Phase verwendet 5 Sekunden Statement- und 50 Millisekunden Locklimit. Bei verlorenem Read-COMMIT wird B verworfen; es gibt 503 und weder Replay noch Dateiweitergabe. Ein erlaubter pristine/physischer Befund ist nur das Ende dieser Ablehnungsprüfung, keine Dateisystem-Publikationsfähigkeit. Andere interne und Owned-Writer installieren diesen POST-spezifischen Hook nicht; deren eigene Verträge bleiben unverändert.

Root bestätigt unabhängig [22 echte PG18-/Auth-/Office-/FS-/Kernel-Familien](../scripts/native-file-write-predispatch-postgres-test.ts), vollständiges TypeScript mit 8 GiB und scoped ESLint für vier Dateien, jeweils Exit 0. Die exportierte POST-Funktion wird mit echten NextRequests direkt aufgerufen; kein Netzwerk-Next-Server, Browser oder neuer Testcontainer wird daraus behauptet. Eigene zufällige Schemas/DATA werden im Fixtureabschluss entfernt. Die ausgeführten Fälle umfassen:

- Zwölf initialisierte Plain-Seeds: `.md`, `.txt`, `.json`, `.docx` jeweils mit fehlender, leerer und veralteter Projektion; keine native, physische oder Revisionsänderung.
- Fehlender/verwaister Zustand und katalogisierte native Nachfahren ohne physischen Fallback.
- Tatsächliche pristine/physische DOCX-Erstellung und Speicherung mit Bytes, Lock, idempotentem Journal, Revisionskonflikt und unverändertem 422 für ungültiges DOCX.
- Normale `.log`-Datei und manuelle leere Markdown-Erstellung; Read-only-Nutzer und ungültiges Root-Dateiziel.
- Tatsächlich gehaltene gemeinsame SQL-Sperre und unabhängiger Python-Prozess als Kernel-Gegenprobe; fremde exklusive Sperre und echte Admission-Reservation.
- Öffentliche ALS-Form nur als Ablehnungsgrund, unveränderter interner Owned-DOCX-Aufruf sowie echte COMMIT-Antwortverluste mit Connection-Disposal und null Datei-Publikation.

Ein absichtlich im eigenen Fixture fehlendes Schemacolumn liefert den erwarteten internen PostgreSQL-Fehler und HTTP 500 ohne Fallback; dies wird nicht als freundlicher 409-Fall ausgegeben. Permanente Quarantäne und nicht exportierbares Rich sind keine separat ausgeführten Seeds dieser Matrix.

Root bestätigt zwölf ganze Kernmodule und die Körper von `writeWorkspaceFileContentUnlocked` sowie `assertNoInitializedNativeFileWrite` bytegleich zum Autorenparent `d9e67184`. Vor Integration meldet die exakte Einflussanalyse für den gemeinsamen Schreibservice CRITICAL, neun direkte/16 gesamte Aufrufer, sechs Module und zwei indexierte Prozessgruppen; die Nutzerwarnung erfolgt vor Änderung. Null indexierte POST-Aufrufer beweisen keine fehlenden dynamischen UI-/API-Verbraucher.

Offen bleiben die SQL→Dateisystem-Publikationslücke, aktuelle finale Autorität an dieser späteren Grenze, Create-/Upload-/Import- und Agent/MCP-Writer, globale kooperative Fences sowie Lifecycle/Batch/Trash/Undo. Deren Aktivierung benötigt eigene echte Konkurrenz-/Recovery- und anschließende gemeinsame Browserabnahme. Der neue POST-Schutz ersetzt diese Schritte nicht.
