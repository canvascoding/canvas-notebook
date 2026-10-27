# Principal: kurze Wartung innerhalb der bestehenden Sperrgrenze

Stand: 27.10.2026, Produktgrundlage `633b0cf7b`. Der
[Quell- und Laufnachweis](document-service-principal-maintenance-2026-10-27.json)
bindet die tatsächlichen Quellen und zwölf seriell ausgeführten PostgreSQL-Suiten.

## Reproduzierter Auslöser

Eine echte `ANALYZE`-Transaktion hält einen `ShareUpdateExclusiveLock` auf der
Benutzertabelle. Der bisherige Principal fordert seine unveränderte `SHARE`-
Tabellensperre mit `NOWAIT` an und meldet deshalb sofort `PRINCIPAL_BUSY`, obwohl
die Phase bereits `lock_timeout=50ms` gesetzt hat. Diese beiden Sperrmodi stehen
in Konflikt; die [PostgreSQL-Dokumentation](https://www.postgresql.org/docs/18/explicit-locking.html)
beschreibt auch, dass reguläres VACUUM denselben Wartungsmodus verwendet. Tatsächlich
nachgestellt wurde hier ANALYZE. Der frühere sporadische Member-Vorfall ist damit
nicht einem bestimmten damaligen Sperrhalter zugeordnet.

## Änderung und Grenzen

Ausschließlich das `NOWAIT` der gemeinsamen Foundation-Tabellensperre entfällt.
Die vollständige Principal-Datei entspricht ansonsten bytegenau der Grundlage,
abgesehen vom erklärenden Kommentar. Sperrmodus, Tabellenliste, Zeilensperren,
Fremdschlüssel-/Trigger-/Relationsprüfungen und sämtliche Berechtigungsentscheidungen
bleiben bestehen. Die Phasenfristen werden gesetzt, bevor einer der beiden privaten
Aufrufer diese Sperre ausführt.

Die bereits vorhandenen 50 ms erlauben einer kurzen Konkurrenz, regulär zu enden.
Längere Konkurrenz wird weiter als `PRINCIPAL_BUSY` abgewiesen und zurückgerollt.
Es gibt keine zusätzliche Wiederholung. `lock_timeout` gilt
[je Sperrversuch](https://www.postgresql.org/docs/18/runtime-config-client.html#GUC-LOCK-TIMEOUT),
nicht für die gesamte HTTP-Laufzeit; die fünfsekündige Transaktions-/Principal-Grenze
bleibt bestehen. Die beobachtete Zeit einschließlich Client-/Rollback-Verarbeitung
wird deshalb nicht als exakte serverseitige Wartezeit ausgegeben.

## Tatsächliche Prüfung

Jeweils kurze und gehaltene ANALYZE-Transaktionen auf Benutzer-, Seat-, Workspace-
und Organisationstabellen werden durch echte `pg_locks`-Beobachtung mit dem
konkreten Principal-Backend gekoppelt. Die kurze Transaktion wird erst nach
nachgewiesenem wartendem `ShareLock` beendet. Alle vier kurzen Fälle speichern
Titel, Favorit und Pin. Alle vier längeren Fälle werden abgewiesen und erhalten
sämtliche Metadatenzeilen einschließlich xmin. Autoritäts- und native Zeilen
bleiben dabei unverändert.

Zwei weitere Fälle ändern echte Autoritätsdaten: Eine Kontosperre und ein
deaktivierter Workspace werden während des kurzen Wartens bestätigt. Die frischen
Entscheidungen weisen sie anschließend mit `SEAT_ACCESS_INACTIVE` beziehungsweise
`PRINCIPAL_SCOPE_CHANGED` ab. Alle übrigen Autoritäts-/Native-Zeilen und sämtliche
Metadaten bleiben einschließlich xmin erhalten. Ein früher gelesener Kontext kann
den bestätigten Rechteentzug somit nicht übergehen.

Zusätzlich bestehen 66 Member-/Metadaten-, 49 Agenten-, 26 Original-Origin-,
30 Gast-, 30 Auftrags-, 60 Agenten-Scope-, zwölf MCP-, neun native Edit-Principal-,
zwölf native PI-Create- und zwei Speicheraktions-COMMIT-Recovery-Familien sowie
der registrierte Agentenvergleich. Die bekannten Actual-COMMIT-/Close-/
Prozessabbruch-/Original-Recovery- und Parallelitätsprüfungen bleiben aktiv.
Alle strengen temporären Testgraphen werden entfernt; die Fixture-Bereinigung besteht.
Release-TypeScript, Test-TypeScript (5099 Quellen, 30 Wurzeln, null Diagnosen),
ESLint und der vollständige mechanische Quellenvergleich sind erfolgreich.

Der vergleichbare Agent mit zehn normalen Upload-Quellen benötigt weiter
2829/2724/2724/198 SQL-Aufrufe und 80/46/46/7 Pool-Ausleihen für ersten Einstieg,
zwei warme Neuanlagen und ursprüngliche Wiederholung. Dieser Fix ändert die
Sperrbehandlung; er behauptet keinen gemessenen Abfrage- oder Latenzgewinn.

Der aktuelle große Vergleich, finale Build-/UI-/Gesamtsuite, weitere gemeinsame
Service-Mechanik, inkrementelle Linkpflege, Original-Reparatur, neue CI-Abnahme und
sämtliche Release-/Rollout-Gates bleiben offen. Review Center und Undo werden nicht
weiterentwickelt; Produktion und Release wurden hier nicht verändert.
