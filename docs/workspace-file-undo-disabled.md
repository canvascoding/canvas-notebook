# Dateiaktions-Undo vorerst ausgeschaltet

Stand: 16. Oktober 2026. Der Nutzer hat die Reparatur von Dateiaktions-Undo zurückgestellt und stattdessen die ausdrückliche Abschaltung verlangt. Die verbleibende Datei-/Link-/Dokument-API-Arbeit wird dadurch nicht aufgeschoben. Der ursprüngliche Desktop-Restorefehler ist nicht behoben und wird nicht als abgeschlossen ausgewiesen. Review Center bleibt ausgeschaltet.

## Geltungsbereich

Dateiaktions-Undo war grundsätzlich dateitypunabhängig vorgesehen. Der bestehende Einzeloperationsdienst unterstützt Rename/Move; Batch V1 und der physische Papierkorb behandeln normale Dateien beziehungsweise Verzeichnisse. Bei Notebook-Markdown sind zusätzlich Yjs-Zustand, ursprüngliche Identität, Generation und Linkwirkungen zu erhalten. Der neuere native V2-Anschluss ist enger: ein einzelner nativer Delete ohne Linkänderungen anderer Quellen. Das ist keine vollständige Undo-Freigabe für alle Operationen und Dateitypen.

Die aktuelle feste Policy `WORKSPACE_FILE_UNDO_ENABLED = false` gilt für alle Deployments und Dateitypen. Es gibt keinen automatisch aktivierten QA- oder Produktionsschalter. Editor-Textgeschichte (Strg/Cmd+Z), eigenständige Dokumentversions-/Backupsicherung und `restore_file_snapshot` sind hiervon getrennt. Die Sperre repariert keine bereits teilweise ausgeführte Wiederherstellung und verwirft keine historischen Belege.

## Zentral geschlossene Zugänge

- Der gemeinsame Desktop-/Mobile-Web-/Bulkdelete-Toast zeigt weiter den erfolgreichen Delete, erzeugt aber keine Undo-Aktion.
- Direkte und historische Batch-Endpunkte verweigern neues Undo und Resume eines gespeicherten Undo-Jobs mit HTTP 409 und `FILE_OPERATION_UNDO_DISABLED`. Der Store wiederholt die Entscheidung an der tatsächlichen gesperrten Zeile; ein alter Serviceread kann kein Undo einreihen.
- Der Worker beendet historische queued/reclaimed Undo-Jobs nach echtem Claim vor Timer, Scope-/Dateiarbeit und Executor mit `needs_recovery/recovery` und dem ausdrücklichen Disabled-Code. Ein gegebenenfalls bereits begonnener Zustand bleibt unbestätigt; kein Restore wird erneut ausgeführt und kein `undone` erfunden.
- Executor-Undo und Undo-Availability sind vor dem Native-/Legacy-Dispatch gesperrt. Der alte Einzeloperationsdienst bietet keine Undo-Fähigkeit und mutiert nicht.
- Der physische Toast-Fallback `POST /api/files/trash/{entryId}/restore` ist ebenfalls gesperrt. Mobile exportiert denselben Handler. Ein alter Toast kann damit die Abschaltung nicht umgehen. Diese bewusste Grenze betrifft die Datei-Papierkorbwiederherstellung, nicht unabhängige Dokumentversions-/Backup-Restores.
- Öffentliche `undoAvailable`, `recovery.canUndo`, `undo.available` und Resume für Undo-Jobs bleiben false. Statusreads und gewöhnliches Apply-Resume bleiben erreichbar; Apply/Delete/Move/Copy erhalten keinen Undo-Guard.

## Prüfung und verbleibende Grenze

Der neue echte React-/Sonner-Hooktest prüft zehn Desktop-/Mobile-Fälle: Legacy- und Batch-Delete, partielle Fehler, keine Trash-Einträge und gewöhnlichen Fehler. Delete-Dispatch und Erfolgsmeldung bleiben erhalten, ein Undo-Button oder Restore-Netzwerkaufruf entsteht nicht.

Die neue Backend-Folge besteht mit 13/13 Prüfgruppen (tatsächlicher Exit 0) und prüft die echten Exportkörper mit ausdrücklich ersetzten Auth-/I/O-Grenzen sowie einen wirklichen eingebetteten PGlite-Store mit SQL-Claim und dauerhafter Workerentscheidung. Diese Prüfungen sind keine tatsächliche HTTP-/ACL-/Dateisystem- oder PostgreSQL-18-Abnahme. Der positive Apply-Dispatch ist nicht allein ein Beleg für echte Dateilöschung.

Die neue Browser-Spec `tests/workspace-file-undo-disabled.spec.ts` soll auf Desktop und Mobile Web wirkliche Markdown- und gewöhnliche Dateien löschen, den fehlenden Undo-Button prüfen und alte API-Aufrufe ausdrücklich ablehnen. Vollständiges cachefreies TypeScript, Scoped ESLint und die Diffprüfung bestehen. Frischer Produktionsbuild und tatsächlicher Browserabschluss sind zunächst ausstehend. Die frühere native Undo-Spec und positive Undo-Algorithmusfixtures bleiben als historische, bei deaktivierter Produktfunktion nicht erfüllbare Erwartungen erhalten; ihr ursprünglicher Report wird nicht umgedeutet.

Dies ist zunächst eine Änderung im Worktree. Ein tatsächlicher Produktionsrollout ist damit nicht durchgeführt. Eine spätere Undo-Freigabe verlangt die Reparatur und eigene integrierte Abnahme einschließlich Identität, Inhalt, Links und historischer Wiederaufnahme.
