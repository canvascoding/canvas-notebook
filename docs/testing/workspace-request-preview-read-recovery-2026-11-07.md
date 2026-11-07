# Begrenzte Wiederaufnahme der Web-Pfadvorschau

Der kompilierte Rename-Fall aus der Gesamtabnahme erhält nach einer stabilen
Vorschau `409/PATH_IMPORT_PREVIEW_BUSY` im Apply. Eine echte PostgreSQL-Probe
reproduziert den kurzfristigen Konflikt an `canvas_organization_settings`.
Der alte Leser bricht ab, obwohl die Sperre nach seinem Rollback bereits frei
ist. Ein vergifteter Principal darf dafür nicht erneut verwendet werden.

`readRequestWorkspacePathImportPreparationPlan` besitzt ausschließlich die feste
lesende Vorschaufrage. Rename und einzelne Delete-Vorgänge verwenden ihn an der
bisherigen Lesestelle, nachdem vorhandene Operationshistorie geprüft wurde.
Importvorbereitung, bestehende Batches und tatsächlicher Apply bleiben außerhalb
seiner Wiederaufnahmeschleife. Es gibt keinen frei übergebenen Callback.

Nur die private Herkunft eines tatsächlichen Principal-/Advisory-Busy nach
bestätigtem Rollback und Verbindungsabschluss erlaubt eine weitere Beobachtung.
Vorher muss auch die gesamte fehlgeschlagene Principal-Factory abgewickelt sein.
Jeder Versuch authentifiziert die unverändert kopierten Originalheader frisch;
höchstens drei Versuche mit 25 ms Abstand sind möglich. Der ausgeschöpfte Leser
behält den bisherigen typisierten HTTP-409-Vertrag. Alle anderen Fehler bleiben
terminal. Ein Code-String allein ist kein Wiederaufnahmebeleg.

Benutzer, Session, Impersonation und vollständiger Workspace-Stamm müssen mit dem
gestarteten Dateivorgang übereinstimmen. Diese erwarteten historischen Daten
begrenzen nur das Ergebnis und verleihen keine Berechtigung. Aktuelle Rechte,
native Quellen, vollständige doppelte Quellbeobachtung und Datenbank-/Schema-Realm
werden weiterhin durch die echten Services geprüft. Ein neuer Stamm vor der
ersten Beobachtung oder zwischen Versuchen bleibt `PREVIEW_STALE`.

## Tatsächliche Abnahme

- 13 echte PostgreSQL-/Auth-Gruppen: kurzzeitige Zeilen- und Advisory-Sperre,
  dauerhafte Konkurrenz, Session-Widerruf, Stammwechsel zwischen Versuchen,
  verlorene ROLLBACK-/Close-/COMMIT-Antwort, nachträgliche Änderung der Aufruferdaten
  sowie falscher erwarteter Benutzer/Session/Impersonation und vorheriger Stammwechsel.
- Frische Factory-Anzahl und Abschlussreihenfolge werden an den tatsächlichen
  SQL-Aufrufen und Pool-Freigaben beobachtet. Nach unbestätigtem Abschluss folgt
  keine weitere SQL-Abfrage. Originaldateien, geschützte native Zeilen samt
  `xmin`, Batch- und Vorbereitungszähler bleiben unverändert.
- Neun bestehende Web-Handler-/Worker-Gruppen bestehen. Die beiden ersten echten
  Rename-/Delete-Applies halten zusätzlich die tatsächliche Vorschau-Zeilensperre
  bis zu genau einem Rollback. Anschließend wird derselbe Originalvorgang einmal
  vorbereitet und ausgeführt; ursprüngliche Preview-/Operations-ID, importierte
  Identitäten, Backlinks, FD-Trash und aktuelle Rechte bleiben geprüft.
- Die bisherigen Busy-Client-, Transaktionsabschluss- und echten PostgreSQL-
  Regressionen bestehen ebenfalls. Eigene Schemas, Pools, Clients und Daten sind
  entfernt bzw. geschlossen. Beide neuen nativen Prüfungen sind in CI registriert.

Die Handlerabnahme verwendet tatsächliche Request-/Response-Funktionen und den
echten PostgreSQL-/FD-Worker, keinen TCP-/Browserersatznachweis. Neuer Build,
kompilierte Browserabnahme, Gesamtsuite und Remote-CI dieses Standes stehen aus.
Review Center und Datei-Undo werden nicht erweitert.
