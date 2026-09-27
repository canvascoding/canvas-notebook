# Dauerhaft belegte Raumfreigabe

Stand: 27. September 2026. Aufbauend auf `78b02a5a7`.
Teilbaustein von FVRC-1008, **keine Live-Handoff- oder Produktionsfreigabe**.

## Geschlossene Lücke

Ein freier Advisory-Lock oder ein gelöschtes Owner-Token beweist bisher nicht,
dass der letzte Live-Stand gespeichert wurde. Die neue optionale Freigabe
bindet einen unveränderlich kopierten Snapshot an einen dauerhaften Beleg:

- Zustand und Owner werden unter der bestehenden Zustandszeilensperre geprüft.
- Persistierte Yjs-Bytes müssen den Live-Snapshot kausal enthalten, einschließlich
  Delete-Sets. Ein gleicher State Vector allein genügt nicht. Beide gespeicherten
  Vektoren werden anhand der tatsächlichen Bytes kontrolliert.
- Der Beleg bindet Dokument, Workspace, Organisation, Pfad, Repräsentation,
  Lifecycle, Schema, Owner-Epoche/-Token/-Backend, Sequenz und getrennte Hashes
  der Live- und Persistenzbytes. Inhalt oder Zugangsdaten werden nicht geloggt.
- Beleg und exaktes Token-Clear committen in derselben SQL-Transaktion. Erst
  anschließend wird der Advisory-Lock freigegeben. Normales/abgebrochenes
  Legacy-Release ohne Snapshot erstellt ausdrücklich keinen solchen Beleg.
- Bei Fehlern einschließlich ungewissem COMMIT oder Unlock wartet die neue
  Freigabe auf das Ende der dedizierten Verbindung. Keine normale Pool-Rückgabe
  und kein Wiederholen des Schreibauftrags.
- Read-only-Recovery nimmt auf einer frischen Verbindung denselben Advisory-Lock
  vor der Zeilensperre. Sie verlangt den exakten Beleg, denselben Zustand und
  einen freigegebenen Owner. Eine neue Epoche, Scope-Drift, fehlender Beleg oder
  konkurrierender Claim bleiben gesperrt. Diese Prüfung erlaubt keinen späteren
  Lifecycle-Write ohne erneut gehaltene Sperren.

Die additive Migration verwendet zwei einzelne SQL-Aufrufe. Ein erster breiter
Lauf deckte auf, dass die vorher zusammengefassten Anweisungen am vorbereiteten
PGlite-Query scheiterten. Die Korrektur liegt im regulären Migrationspfad, nicht
in abgeschwächten Test-Assertions; echte PostgreSQL-Migrationen laufen zweimal.

## Verifikation

- Sechs Unit-Prüfgruppen: reine Löschung, nicht gespeicherte Löschung bei gleichem
  Vector, falsche Vektoren, genaue Belegprüfung, Lock-Reihenfolge, Scope-/Epoch-
  Wechsel und Connection-Cleanup. Bestandteil von `test:collaboration:room-owner`.
- Sechs echte PG18-Prüfgruppen mit getrennten Verbindungen: persistierter
  kausaler Oberstand, Legacy-Release ohne Beleg, ungespeicherte Änderungen,
  verlorene erfolgreiche Commit-Antwort, neuer Owner und abgelehnter COMMIT.
- Der Lost-Ack-Test blockiert `client.end()` gezielt: Release darf vorher nicht
  abschließen; Recovery startet unmittelbar danach ohne zusätzliches `close()`.
- Eigenes UUID-Schema mit ausschließlich schema-lokalem Suchpfad, danach entfernt.
  Kein Reset bestehender App-Daten. Bestehende PG-Owner-Suite ebenfalls grün.
- Vollständige Lifecycle-, Projection- und Operationssuites grün. Operations
  verwendet eine frisch migrierte UUID-Datenbank und echte Markdown-Codecs;
  diese Testdatenbank wurde anschließend entfernt.
- Vollständiges TypeScript, fokussiertes ESLint, Diff-Check und Produktionsbuild
  mit 353 Seiten grün. Bekannte Tracing-Warnungen bleiben unverändert.

Logs: `/tmp/fvrc1008-room-release-` mit `lifecycle-final.log`, `projection.log`,
`operations.log`, `owner-pg-final.log`, `postgres-idempotent-migrations.log`,
`types-verified.log`, `lint-verified.log`, `build-verified.log`, `stack.log`.
Der erste Build erfasste zwei inzwischen behobene Typfehler im parallel neu
entstandenen Unit-Test; der abschließende Build ist erfolgreich.

### Browserregression und Scopeprüfung

Am frisch gestarteten Host-Dev **127.0.0.1:3000** bestanden die gewöhnlichen
B/C-Reviews seriell mit einem Worker: Personal **23,4 s**, Team **15,4 s**.
C wird angenommen; B bleibt offen mit konkreter Konfliktdiagnose, ohne
Timeline-Fehler, ohne Null-Diff und ohne zweite Inhaltsrevision. Beide Screenshots
wurden angesehen. Berichte: `/tmp/fvrc1008-room-release-personal-report/index.html`
und `/tmp/fvrc1008-room-release-team-report/index.html`.
Diese Browsertests prüfen den unverändert ungefencten Default, nicht den noch
nicht integrierten Release-/Live-Handoff-Pfad.

Der lesende Bestandscheck findet null aktivierte Owner-Epochen, null verbliebene
Owner-/Release-Testschemas und null isolierte Editor-Testdatenbanken. Vier
verwaltete Container bleiben gesund; 3100 verwendet weiterhin das ältere Image.

GitNexus wurde explizit auf den absoluten Worktree-Pfad gerichtet: Der geteilte
Repositoryname ist für mehrere Checkouts mehrdeutig. Staged-Scan: zehn Dateien,
sieben bereits indexierte Symbole, keine indexierten Prozessketten, LOW.
Die neuen Symbole sind darin noch nicht vollständig erfasst und wurden zusätzlich
manuell geprüft. Der zentrale Migrations-Einstieg hat separat CRITICAL-Risiko
(42 direkte Aufrufer); seine Änderung ist auf den zusätzlichen Einzelaufruf
beschränkt. Gesamtbranch gegen `main`: 258 Dateien und 30 Prozessketten,
CRITICAL — ausdrücklich keine Gesamtfreigabe.

## Noch offen

Das Runtime-Release nutzt den neuen Snapshot-Pfad noch nicht. Er benötigt zuerst
einen expliziten terminalen Drain unter derselben Raummutierungssperre wie
Client-/Direct-Writes. Normales `beforeUnloadDocument` ist abbrechbar und darf
nicht vorschnell die Zuständigkeit aufgeben. Ein neuer Peer muss die Freigabe
entweder zuverlässig verhindern oder bis zum bestätigten Handoff warten.

Während finalem Store und History-Capture darf kein äußerer Workspace-Lock
gehalten werden, auf den dieser Store selbst wartet. Lifecycle-Reservation,
prozessübergreifende Benachrichtigung, Advisory-Guard durch die Lifecycle-
Transaktion, atomarer Kandidatencommit vor Veröffentlichung, Crash-/Reconnect-
Recovery, vollständige PG-/MR-Abnahme und P12 bleiben offen. Eine spätere
gemeinsame Lock-/Fence-Hilfsdatei soll den derzeit nicht initialisierungswirksamen
Runtime-Importzyklus zwischen Owner und Release vor breiter Integration lösen.

Der reguläre Bootstrap bleibt ohne aktivierte Ownership. Kein Container wurde
gebaut, ersetzt oder neu gestartet. Kein Push und keine Produktionsaktivierung.
