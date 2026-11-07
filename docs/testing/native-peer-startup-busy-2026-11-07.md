# Native Wiederverbindung während Raumfreigabe

Der reguläre kompilierte Gesamtlauf am Produktstand `1e7db7310` und Teststand
`756a3d952` endet mit 332 Erfolgen, drei Fehlern und 102 bestehenden bedingten
Auslassungen. Zwei Migrationsfeedback-Fälle zeigen nach der ausdrücklich
simulierten Antwort `blocked/runtime_unavailable` einen echten
`COLLABORATION_AUTHENTICATION_FAILED`-Zustand; die Serverlogs melden eine belegte
Raumressource. Der dritte Fehler ist ein Rename-Apply mit
`PATH_IMPORT_PREVIEW_BUSY` und bleibt separat offen.

Die drei unveränderten Fälle bestehen anschließend einzeln auf demselben Image
und behaltenen QA-Daten, ohne Retry oder Skip. Das ist ein Timinghinweis, keine
Behebung. Der Gesamtlauf wurde nach den drei Fehlern über seinen eigenen
Koordinator beendet; sein Kollaborationsprofil ist unvollständig. Beide Abläufe
stellen den gesunden Originalstack wieder her. Geschützte Zeilen einschließlich
`xmin`, Dateibytes, Speicheranker und andere Container bleiben erhalten.

## Kontrollierter Fehler und Korrektur

`test:collaboration:peer-startup-socket:postgres` hält den tatsächlichen
In-Process-Aktivitätszaun, den auch die normale Raumfreigabe verwendet. Ein echter
WebSocket mit echten Auth-Cookies erhält vor dem Fix die allgemeine
AuthDenied-Meldung „The document is owned by another collaboration room.“
Die Erwartung des benannten Busy-Vertrags schlägt kontrolliert fehl.

Der Server ordnet ausschließlich einen typisierten `ROOM_OWNER_BUSY` direkt aus
diesem synchronen Aktivitätseintritt dem vorhandenen
`NATIVE_PEER_ADMISSION_BUSY`-Vertrag zu. Weder SQL-Zulassung noch neuer
Eigentumsanspruch haben zu diesem Zeitpunkt begonnen. Der bestehende Client
behält seinen begrenzten Wiederverbindungsweg mit frischer Autorisierung und
gleicher Dokumentidentität. Andere Fehler, Eigentumsverlust und unbestätigte
Transaktionsantworten bleiben unverändert.

Neun tatsächliche Socket-/PostgreSQL-18-Gruppen bestehen: Aktivitätszaun,
kurzzeitige/anhaltende Web-/Mobile-Sperren, verlorene COMMIT-Antwort, vergiftete
bzw. gleichzeitig verwendete Mobile-Capability und Abbruch beim Besitztransfer.
Der Zaunfall erhält native Zeilen und `xmin`. Nach Freigabe bleibt ein tatsächlich
widerrufener Session-Token abgewiesen; wieder gültige Autorisierung erlaubt den
frischen Peer mit gleichem Inhalt. Eigene Schemas, Dateien, Clients und Pools
werden entfernt bzw. geschlossen.

Der bisher separate Test verwendet nun die gemeinsame verifizierte
lokale/CI-Datenbankauswahl; CI verbietet Fallfilter. Zwei alte Fixture-Annahmen
sind aktualisiert: die Main-Agent-Migration nutzt bereits `current_schema()`,
und echte Konkurrenz zur `SHARE`-Lesesperre benötigt `ROW EXCLUSIVE`, statt einer
zweiten kompatiblen `SHARE`-Sperre. Produktionsschutz bleibt unverändert.
Die CI bewahrt das Socket-Protokoll als eigenes Artefakt auf.

Gezieltes ESLint, YAML-/JSON-Parsing und Diff-Prüfung bestehen. Neue kompilierte
Browserabnahme, Gesamtsuite und aktuelle CI dieses Fixes stehen noch aus.
Dies ist kein Release- oder Produktionsnachweis. Review Center und Datei-Undo
bleiben außerhalb der Implementierung.
