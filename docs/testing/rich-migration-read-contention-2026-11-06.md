# Begrenzte Wiederaufnahme der Migrationsbeobachtung

Der vollständige lokale Browserlauf vom 06.11.2026 zeigt beim Öffnen eines
zweiten Editors eine HTTP-500-Antwort mit PostgreSQL-Code `55P03`. Der Trace
enthält den ursprünglichen Migrationsauftrag; ein späterer Sitzungsaufbau gelingt.

Eine eigene PostgreSQL-18-Reproduktion hält die tatsächliche Dokumentzeile mit
`FOR UPDATE`. Das abschließende `domain.read()` scheitert vor der Korrektur mit
demselben SQL-Code. Die Erstbeobachtung liefert dagegen bereits den typisierten
`PRINCIPAL_BUSY`-Fehler und behält ihre bestehende Ablehnung.

Die Korrektur betrifft nur die feste aktuelle Beobachtung des Migrationsdomains.
Nach bestätigtem Rollback und geschlossener Verbindung sind höchstens zwei weitere
Leseversuche mit je 25 ms Pause erlaubt. Jeder Versuch öffnet eine neue Transaktion,
prüft aktuelle Schreibrechte und muss weiterhin zur ursprünglichen nativen
Identität, Workspace-Wurzel und Datenbank-Realität passen. Anhaltende bestätigte
Lesekonkurrenz endet mit 503. Migration, Projektion und Schreibtransaktionen werden
dabei nicht erneut ausgeführt.

Acht echte PostgreSQL-/Autorisierungsgruppen bestehen: anfängliche Ablehnung,
erfolgreiches aktuelles Lesen nach Sperrfreigabe, dauerhaft gehaltene Sperre,
widerrufene Sitzung, geänderte Workspace-Wurzel sowie verlorene COMMIT-, Rollback-
und Verbindungsfreigabe-Antworten. Native Zeilen einschließlich `xmin`, Yjs-Bytes,
Sicherungs- und Zulassungsstände bleiben erhalten. Die drei unbestätigten
Transaktionsausgänge starten keinen weiteren SQL-Aufruf. Eigene Schemas, Pool,
Clients und Dateien werden danach nachweislich entfernt.

Die vorhandene Migrationssuite besteht zusätzlich 61 tatsächliche Familien für
native Änderungen, aktuelle Autorisierung, Abbruch, Endzustände und COMMIT-Recovery.
Der neue portable Prüfer läuft über
`npm run test:collaboration:migration-read-contention:postgres` in der bestehenden
Native-API-/SDK-CI; sein Log bleibt als Artefakt erhalten.

Diese Quellabnahmen ersetzen noch keine kompilierte Browserabnahme. Der vorherige
Gesamtlauf bleibt mit 334 regulären Erfolgen, einem regulären Fehler, 102 bedingten
Auslassungen sowie 44 erfolgreichen und zwei fehlgeschlagenen verpflichtenden
Kollaborationsfällen erhalten. Die veraltete Unsupported-Meldung im isolierten
Browsertest ist inzwischen korrigiert und zusammen mit der echten Room-Active-
Meldung gezielt geprüft. Die kompilierte Wiederholung und endgültige Gesamtabnahme
bleiben offen. Review Center und Dateioperationen-Undo bleiben aus.

## Explizite Fortsetzung des ursprünglichen mobilen Vorgangs

Der mobile Fehler ist eine bereits vorgesehene Zulassungsablehnung:
`503/COLLABORATION_BUSY` verlangt denselben Request. Der vorhandene echte
PostgreSQL-Prüfer bestätigt unter kontrollierter Lesersperre, dass eine neue
Mutation weder vorbereitet noch angewandt wird. Nach Freigabe erzeugt dieselbe
Operations-ID genau einen Vorgang; eine weitere Wiederholung liefert denselben
Beleg ohne Änderung nativer Bytes oder Historie. Spätere Peer-Änderungen bleiben
auch beim Abruf eines älteren Belegs erhalten. Der ursprüngliche konkrete
Sperrhalter des Browserlaufs wird damit nicht nachträglich identifiziert.

Der Browseraufbau verwendet dafür nun einen eingefrorenen Request mit derselben
Version, demselben Inhalt und expliziter Idempotenz-ID. Nur der genaue benannte
503-Busy-Fall darf höchstens zweimal nach je 250 ms fortgesetzt werden. Andere
HTTP-Fehler und unklare Transportausgänge werden nicht wiederholt. Ein erfolgreicher
Aufbau erfordert einen dauerhaften angewandten Beleg; die bestehenden Dokument-
und Deep-Link-Identitätsprüfungen bleiben erhalten. Die mobile Produkt-Schreiblogik
wurde dafür nicht geändert. Der erweiterte PostgreSQL-Prüfer ist in der CI verdrahtet.
