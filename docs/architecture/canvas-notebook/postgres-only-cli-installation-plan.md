# PostgreSQL-only CLI Installation Plan

Stand: 2026-08-31

Status: PostgreSQL-Fresh-Install- und Lifecycle-Kernpfad implementiert;
vollstaendig SQLite-freies Production-Runner-Image noch geplant

Memory-Readiness: implementiert am 2026-09-02. Onboarding und regulaere
Memory-Persistenz verwenden bereits die provider-neutrale SQL-Abstraktion. Neue
Production-Installationen verwenden PostgreSQL als Default; Managed- und
External-Modus sind getrennt. Es gibt keine zu unterstuetzenden SQLite-only-
Bestandsinstallationen. Der SQLite-Cutover ist deshalb kein Produktpfad. Das
Standard-Runner-Image enthaelt derzeit noch `better-sqlite3` und das
`sqlite3`-CLI; beide werden ersatzlos aus dem Production-Artefakt entfernt.

## Ziel

Neue Canvas-Notebook-Installationen ueber die portable TypeScript-CLI verwenden ausschliesslich PostgreSQL. Die bisherige Auswahl zwischen SQLite und PostgreSQL entfaellt. PostgreSQL kann entweder als lokal von Canvas verwalteter Compose-Service oder als externe/gehostete Datenbank betrieben werden.

Updates werden ausschliesslich als PostgreSQL→PostgreSQL-Schemamigration
unterstuetzt. SQLite-Konfigurationen brechen in neuen Production-Versionen mit
einem klaren Fehler ab; es gibt weder automatische Datenuebernahme noch einen
SQLite-Fallback.

## Ist-Zustand und bekannte Luecke

- `DATABASE_URL` kann bereits sicher mit `config-set env.DATABASE_URL --stdin` gespeichert werden.
- Config- und Env-Dateien werden atomar und mit Dateimodus `0600` geschrieben; CLI-Ausgaben maskieren sensitive Werte.
- Managed- und External-Modus sind getrennt; nur `managed` aktiviert das lokale Compose-Profil und die Rollenpasswort-Reconciliation.
- Der External-Preflight prueft Verbindung, DDL-Rechte und pgvector ohne einen lokalen PostgreSQL-Container zu starten.
- Fresh Production Install und Runtime-Provider verwenden PostgreSQL als Default und verlangen eine gueltige `DATABASE_URL`.
- Der lokale PostgreSQL-Service verwendet `pgvector/pgvector:0.8.3-pg18` und aktiviert `vector` idempotent.
- Offene Luecke: Standard-Runner, Runtime-Imports und viele Tests enthalten weiterhin SQLite-Komponenten, obwohl der PostgreSQL-Pfad sie fachlich nicht benoetigt.

## Zielmodell

Die technische Datenbankauswahl und die Service-Verantwortung werden getrennt:

```env
CANVAS_DATABASE_PROVIDER=postgres
CANVAS_POSTGRES_MODE=managed|external
```

Regeln:

- `CANVAS_DATABASE_PROVIDER` ist fuer neue Installationen immer `postgres`.
- `managed` ist der Standard und startet den lokalen PostgreSQL-/pgvector-Compose-Service.
- `external` verwendet ausschliesslich die angegebene `DATABASE_URL` und startet, veraendert oder inspiziert keinen lokalen PostgreSQL-Container.
- Das Compose-Profil `postgres` richtet sich nach `CANVAS_POSTGRES_MODE=managed`, nicht allein nach dem Datenbankprovider.
- Lokale Rollenpasswort-Reconciliation ist ausschliesslich im Managed-Modus erlaubt.
- Ein externer Anbieter muss eine dedizierte Datenbank sowie die fuer Canvas-Migrationen erforderlichen Schema-/DDL-Rechte bereitstellen.

## CLI-Vertrag

### Interaktive Installation

`canvas-notebook install` fragt nicht mehr nach SQLite oder PostgreSQL, sondern nur nach dem PostgreSQL-Betriebsmodell:

1. Lokal verwaltetes PostgreSQL (Standard)
2. Externe oder gehostete PostgreSQL-Datenbank

Im externen Modus wird die Datenbank-URL verdeckt eingelesen. Der Wert darf weder ausgegeben noch in Logs geschrieben werden.

### Non-interaktive Installation

Managed:

```bash
canvas-notebook install \
  --postgres-mode managed \
  --non-interactive
```

Extern ueber stdin:

```bash
printf '%s' "$DATABASE_URL" | \
  canvas-notebook install \
    --postgres-mode external \
    --database-url-stdin \
    --pgvector auto \
    --non-interactive
```

Zusaetzlich wird `--database-url-file <path>` fuer Secret-Dateien unterstuetzt. Ein direktes `--database-url <url>` wird nicht angeboten, damit Zugangsdaten nicht in Prozesslisten oder Shell-History erscheinen.

Im Non-interactive-Modus fuehren fehlende Angaben zu einem deterministischen Fehler statt zu einem Prompt.

### Provider-Vertrag

- `install --database sqlite` wird bei Fresh Installs abgelehnt.
- `install --database postgres` kann fuer eine begrenzte Uebergangszeit als deprecated Alias fuer den Managed-Modus akzeptiert werden.
- Vorhandene SQLite-Konfigurationen werden als nicht unterstuetzt abgelehnt.
- `database migrate-sqlite-to-postgres` wird aus dem Production-CLI entfernt.
- Ein fehlender Production-Provider wird nur zusammen mit einer gueltigen
  `DATABASE_URL` als PostgreSQL normalisiert; andernfalls bricht der Start mit
  einer klaren Konfigurationsmeldung ab.

## Secret-Behandlung

- `DATABASE_URL` wird nur ueber verdeckte TTY-Eingabe, stdin oder eine Secret-Datei angenommen.
- Vor erfolgreichem Preflight liegt die URL nur in einer temporaeren Datei mit `0600` und wird anschliessend geloescht.
- Die dauerhafte Speicherung verwendet den vorhandenen atomaren, geschuetzten Config-/Env-Mechanismus.
- Status-, Diagnose- und JSON-Ausgaben enthalten nur `databaseUrlConfigured`, Secret-Fingerprint und nicht-sensitive Capability-Metadaten.
- Fehlertexte, Child-Process-Ausgaben und Control-Plane-Events muessen die URL und das Passwort redigieren.
- Im externen Modus werden URL-Credentials nicht zusaetzlich als lokales `CANVAS_POSTGRES_PASSWORD` dupliziert oder reconciliiert.

## Externer PostgreSQL-Preflight

Der Preflight wird aus demselben Container-/Netzwerkkontext ausgefuehrt, in dem Canvas Notebook spaeter laeuft. Eine erfolgreiche Verbindung vom Host allein reicht nicht aus.

Pruefungen vor der dauerhaften Installation:

1. URL-Syntax und Protokoll `postgres://` oder `postgresql://`.
2. Vorhandene Benutzer-, Passwort-, Host- und Datenbankbestandteile.
3. Erhalt von TLS- und `sslmode`-Parametern.
4. Begrenzter DNS-/TCP-/Login-Timeout.
5. `SELECT 1` und Ermittlung der Server-Version.
6. Pruefung einer festgelegten, durch Integrationstests abgesicherten PostgreSQL-Major-Version.
7. Schreib- und DDL-Test im effektiven Schema innerhalb einer zurueckgerollten Transaktion.
8. Erkennung, ob die Datenbank leer, bereits eine bekannte Canvas-Datenbank oder eine fremd belegte Datenbank ist.
9. pgvector-Verfuegbarkeit, Installationsstatus, Version und Installationsberechtigung.

Eine fremd belegte Datenbank wird ohne explizite Adoption-Freigabe abgelehnt. Preflight-Fehler werden strukturiert ausgegeben, zum Beispiel:

- `POSTGRES_URL_INVALID`
- `POSTGRES_CONNECTION_TIMEOUT`
- `POSTGRES_AUTH_FAILED`
- `POSTGRES_TLS_FAILED`
- `POSTGRES_VERSION_UNSUPPORTED`
- `POSTGRES_SCHEMA_NOT_WRITABLE`
- `POSTGRES_DATABASE_NOT_DEDICATED`
- `PGVECTOR_UNAVAILABLE`
- `PGVECTOR_CREATE_FORBIDDEN`

Nach dem Start folgt eine zweite Verifikation fuer angewandte Migrationen, Notebook-Health, Schema-Readiness und den tatsaechlichen pgvector-Status.

## pgvector-Verhalten

Vorhandene Runtime-Variablen bleiben autoritativ:

```env
CANVAS_POSTGRES_VECTOR_ENABLED=true|false
CANVAS_VECTOR_PROVIDER=pgvector|none
CANVAS_POSTGRES_VECTOR_VERSION=<erkannte Version oder leer>
```

`CANVAS_VECTOR_SEARCH_ENABLED` ist derzeit kein autoritativer Provider-Schalter und wird fuer diese Entscheidung nicht verwendet.

CLI-Modi:

- `--pgvector auto`: installierte Extension erkennen, bei vorhandener Berechtigung aktivieren und andernfalls Vector-Funktionen mit klarer Warnung deaktivieren.
- `--pgvector require`: Installation abbrechen, wenn pgvector nicht vollstaendig funktioniert.
- `--pgvector disable`: keine Aktivierung versuchen; Vector Provider auf `none` setzen.

Ergebnis bei fehlendem pgvector:

```env
CANVAS_POSTGRES_VECTOR_ENABLED=false
CANVAS_VECTOR_PROVIDER=none
CANVAS_POSTGRES_VECTOR_VERSION=
```

Bei erfolgreicher Pruefung:

```env
CANVAS_POSTGRES_VECTOR_ENABLED=true
CANVAS_VECTOR_PROVIDER=pgvector
CANVAS_POSTGRES_VECTOR_VERSION=<erkannte Version>
```

Team-/Vector-Search-Runtimes erzwingen effektiv `--pgvector require`. Reine PostgreSQL-Personal-Installationen duerfen mit `vectorProvider=none` laufen; Embeddings, Vector Search und davon abhaengige Funktionen bleiben dann durch die bestehenden Capability-Gates gesperrt.

## Lifecycle-Anpassungen

Die bisherige Funktion "PostgreSQL ist gewuenscht" wird in zwei Entscheidungen geteilt:

- PostgreSQL-Datenbank wird verwendet.
- Lokal verwalteter PostgreSQL-Service wird benoetigt.

Folgende Befehle muessen beide Modi korrekt behandeln:

- `install`
- `start`
- `restart`
- `update`
- `env --sync`
- `database status`
- neuer dynamischer Check `database validate`
- `backup create`

Managed-only:

- `database prepare-postgres`
- `database reconcile-postgres-auth`
- lokaler Container-/Volume-/Rollenpasswort-Lifecycle

External:

- kein lokaler PostgreSQL-Container,
- keine lokale Passwort-Reconciliation,
- Verbindung und Migrationen ueber `DATABASE_URL`,
- Backup ueber `pg_dump` gegen die externe Datenbank,
- Status ueber echte SQL-Probes statt Docker-Container-Status.

## Control-Plane- und Agent-Vertrag

Die Control Plane und der Canvas Agent muessen das Betriebsmodell explizit transportieren.

Managed VMs:

- setzen `CANVAS_POSTGRES_MODE=managed`,
- erzeugen lokale DB-Secrets,
- duerfen den PostgreSQL-Container vorbereiten und reconciliieren,
- verwenden weiterhin den typisierten CLI- und Agent-Lifecycle.

Externe Datenbanken:

- setzen `CANVAS_POSTGRES_MODE=external`,
- uebertragen `DATABASE_URL` nur ueber den vorhandenen Secret-Kanal,
- duerfen keinen lokalen PostgreSQL-Container vorbereiten oder inspizieren,
- beziehen Status, pgvector-Version und Readiness ueber `database validate --json` beziehungsweise Notebook-Health.

Die Agent-Logik fuer `notebookPostgresRuntimeDesired`, Config-Aenderungsanalyse, Migration, Backup und Status muss die neue Trennung nachvollziehen. Bestehende Secret-Fingerprint-, Redaction- und Operation-Lock-Garantien bleiben erhalten.

## Umsetzungsreihenfolge

### Phase 1: Konfigurationsvertrag

- `CANVAS_POSTGRES_MODE=managed|external` einfuehren.
- Defaults und fail-closed Provider-Validierung getrennt behandeln.
- Compose-Profil und Statusmodell auf den neuen Modus umstellen.
- Unit- und Paritaetstests zuerst abschliessen.

### Phase 2: Sichere Eingabe und Preflight

- interaktiven TTY-Flow implementieren,
- stdin-/Datei-Secret-Eingabe implementieren,
- containerbasierten externen SQL-/TLS-/Rechte-/pgvector-Preflight implementieren,
- strukturierte, redigierte Fehlercodes testen.

### Phase 3: PostgreSQL-only Fresh Install

- SQLite-Auswahl fuer neue Installationen entfernen,
- Managed- und External-Installationen atomar ausfuehren,
- fehlgeschlagene Preflights ohne dauerhafte Teilkonfiguration beenden,
- Post-Start-Migrationen und Health verifizieren.

### Phase 4: Lifecycle und Backups

- Start, Restart, Update und Env-Sync modusabhaengig machen,
- externe Backups ohne lokalen Prepare-Pfad absichern,
- SQLite-Migrations-, Restore- und Fallbackpfade aus Production entfernen.

### Phase 5: Control Plane und Agent

- Modus in Managed Env, Agent Config und Status aufnehmen,
- lokale Containerannahmen im External-Modus entfernen,
- typisierte Datenbankoperationen und Secret-Redaction erweitern,
- Control-Plane- und Agent-Vertragstests abschliessen.

### Phase 6: Plattform- und Release-Verifikation

- CLI-Unit-, Paritaets- und Secret-Safety-Suiten,
- Integration mit lokalem PostgreSQL/pgvector,
- External-Simulation mit separatem Netzwerkziel,
- negative Tests fuer Auth, Timeout, TLS, Rechte und pgvector,
- PostgreSQL-Update-, Backup-, Schema- und Rollback-Tests,
- native Linux-, macOS- und Windows-Smoke-Tests,
- `npm run lint`, relevante Test-Suiten und `npm run build`,
- Control-Plane-Agent-Tests und Release-Metadaten pruefen.

## Risikobewertung

Der Impact ist hoch. `CANVAS_DATABASE_PROVIDER` wird breit in Notebook, Installer, Tests, Migration, Backup, Lizenz-/Capability-Gates, Control Plane und Agent verwendet. Besonders risikoreich sind:

- unbeabsichtigter SQLite-Fallback bei fehlender PostgreSQL-Konfiguration,
- versehentliches Starten eines lokalen PostgreSQL-Containers trotz externer URL,
- Secret-Leaks ueber Argumente, Logs oder Fehlermeldungen,
- lokale Passwort-Reconciliation gegen den falschen Betriebsmodus,
- fehlerhafte Backup-Annahmen,
- pgvector als konfigurierte statt tatsaechlich verfuegbare Capability,
- Control-Plane-Status, der nur den lokalen Container statt die echte Datenbank misst.

Die Phasen werden deshalb einzeln abgeschlossen, getestet und committed. Mit der naechsten Phase wird erst begonnen, wenn die vorherige stabil ist.

## Akzeptanzkriterien

- Fresh Install bietet keine SQLite-Auswahl mehr.
- Managed PostgreSQL bleibt der einfache Standardpfad.
- Externe PostgreSQL-URLs funktionieren interaktiv und non-interaktiv ohne Secret-Leak.
- Eine Installation wird nur nach erfolgreicher Verbindung und Rechtepruefung fortgesetzt.
- pgvector-Status basiert auf einer echten Datenbankabfrage.
- Fehlendes optionales pgvector setzt die bestehenden Vector-Variablen konsistent auf deaktiviert.
- Team-/Vector-Runtime blockiert ohne pgvector fail-closed.
- External-Modus startet oder veraendert keinen lokalen PostgreSQL-Container.
- Start, Update, Backup und Status funktionieren in beiden PostgreSQL-Modi.
- Das Production-Runner-Image enthaelt weder `better-sqlite3`, ein natives
  SQLite-Addon noch das `sqlite3`-CLI.
- SQLite-Konfigurationen werden fail-closed abgelehnt; es gibt keinen
  Production-Cutover oder Fallback.
- Onboarding-Memories, Collections, Audit-Events, Review-Jobs und User-Settings
  bleiben bei PostgreSQL→PostgreSQL-Schemaupdates vollstaendig und
  nutzerisoliert erhalten.
- Control Plane und Agent behandeln Managed und External eindeutig und redigieren alle Secrets.
