# Memory-Reviewer im Administrator-Onboarding

Stand: 2026-09-02

Status: geplant

## Zielentscheidung

Jede neue Production-Installation verwendet ausschliesslich PostgreSQL. Das
Administrator-Onboarding muss zusaetzlich zum normalen App-Standardmodell ein
Provider-/Modell-Paar fuer den isolierten `memory-manager` festlegen und
verifizieren. Erst danach darf das Instanz-Onboarding abgeschlossen werden.

Die Auswahl ist eine organisationsweite Runtime-Konfiguration. Sie wird einmal
durch einen Owner oder Administrator gesetzt und gilt fuer die Memory-Jobs aller
berechtigten User der Organisation. Persoenliche Memories, Sessions, Queue-Jobs
und sensible Einstellungen bleiben weiterhin strikt userbezogen.

Der App-Default darf im Onboarding als Vorauswahl fuer den Memory-Reviewer
angeboten werden. Die Memory-Runtime bleibt dennoch eine eigene Auswahl, damit
spaeter ein guenstigeres oder kleineres Modell verwendet werden kann. Es gibt
keinen stillen Rueckfall auf das aktive Chatmodell.

## PostgreSQL-Migrationsfluss

In diesem Kontext sind zwei verschiedene Vorgänge zu unterscheiden.

### 1. Schema-Migration bei einem reinen PostgreSQL-Setup

Der normale Production-Start laeuft so:

```text
PostgreSQL bereitstellen bzw. externe Verbindung pruefen
  -> CANVAS_DATABASE_PROVIDER=postgres und DATABASE_URL setzen
  -> Startup-Migrationsrunner starten
  -> PostgreSQL-Pool oeffnen
  -> idempotente PostgreSQL-DDL anwenden
  -> Pool schliessen
  -> Notebook-Server starten
```

`runStartupDatabaseMigrations()` verzweigt vor dem Oeffnen einer Datenbank nach
dem konfigurierten Provider. Im PostgreSQL-Zweig wird direkt
`runPostgresMigrations()` ausgefuehrt. Der SQLite-Bootstrap, `better-sqlite3`
und `sqlite.db` gehoeren nicht zu diesem Pfad und duerfen bei einem frischen
Production-Setup weder benoetigt noch erzeugt werden.

Die Schema-Migration ist wiederholbar. `CREATE TABLE IF NOT EXISTS`, additive
Spalten-/Indexmigrationen und idempotente Backfills bringen eine leere oder
aeltere PostgreSQL-Datenbank auf den vom aktuellen Release erwarteten Stand.
Schlaegt dieser Schritt fehl, startet die Anwendung nicht gegen ein
unvollstaendiges Schema.

### 2. PostgreSQL-only Production-Artefakt

Der aktuelle Runtime-Zweig benoetigt bei aktiviertem PostgreSQL keine
SQLite-Datenbank. Das heutige Standard-Image liefert fuer Legacy-, Export- und
Migrationspfade jedoch weiterhin das native Modul `better-sqlite3` und das
`sqlite3`-CLI mit. Fuer ein strikt PostgreSQL-only Production-Artefakt muss auch
diese Packaging-Abhaengigkeit entfernt werden:

- Der Provider-Dispatcher darf im PostgreSQL-Prozess keine SQLite-Module auf
  Top-Level importieren.
- Das normale Production-Dependency-Set und das Runner-Image enthalten weder
  `better-sqlite3` noch das Betriebssystempaket `sqlite3`.
- SQLite-spezifische Bootstrap-, Export-, Restore- und Cutover-Logik wird in
  ein separates Legacy-Migrationsartefakt beziehungsweise einen expliziten
  Migration-CLI-Pfad verschoben.
- Tests und lokale Entwicklung duerfen SQLite weiter als Testadapter verwenden;
  diese Abhaengigkeit gelangt nicht in das Production-Runner-Image.
- Der gemeinsame Schema- und Servicevertrag bleibt providerneutral. Eine
  importierte Drizzle-Schema-Beschreibung allein darf nicht zum Laden einer
  nativen SQLite-Engine fuehren.

Damit bleiben bestehende Installationen migrierbar, waehrend eine neue
Production-Installation technisch und nicht nur logisch PostgreSQL-only ist.

### 3. Einmaliger SQLite-Bestandsimport

`database migrate-sqlite-to-postgres` ist ausschliesslich ein
Kompatibilitaetswerkzeug fuer bestehende Installationen mit Daten in SQLite. Es
bereitet PostgreSQL vor, kopiert die vorhandenen Datensaetze, prueft Anzahl und
stabile IDs und fuehrt danach den Cutover aus.

Dieser Befehl ist kein Bestandteil einer Neuinstallation und darf im reinen
PostgreSQL-Setup nie vorausgesetzt oder automatisch aufgerufen werden.

## Festgestellte Luecke

Der aktuelle Instanz-Setup prueft nur das App-Standardmodell. Die vorhandene
Memory-Konfiguration speichert `provider_installation_id` und `model_id`
dagegen pro User in `memory_user_settings`.

Dadurch kann das Onboarding erfolgreich abgeschlossen sein, obwohl der
Memory-Worker kein Modell besitzt. Ein Job wird dann dauerhaft und korrekt in
`awaiting_model_configuration` mit `model_not_configured` geparkt. Das direkte
`memory`-Tool kann trotzdem Eintraege speichern, weil es keine Modellinferenz
braucht; die automatische Auswertung nach zehn User-Turns oder nach dem
Idle-Flush findet jedoch nicht statt.

## Zielarchitektur

### Organisationsweite Runtime-Konfiguration

Eine neue Tabelle `memory_review_runtime_settings` speichert mindestens:

```text
organization_id                 primary key
provider_installation_id
model_id
verified_catalog_revision
verified_at
configured_by_user_id
created_at
updated_at
```

Regeln:

- Es werden nur Referenzen auf die zentrale Provider-Installation und den
  Runtime-Modellkatalog gespeichert, niemals API-Keys oder Provider-Secrets.
- Provider muss aktiviert und `ready` sein; das Modell muss im aktuellen
  Katalog vorhanden und aktiviert sein.
- Verifikation gilt fuer die konkrete Kombination aus Provider-Installation,
  Modell und Katalogrevision. Eine Aenderung invalidiert die bisherige
  Verifikation.
- Nur Owner und Organisationsadministratoren duerfen die Auswahl aendern.
- Der reservierte `memory-manager` bleibt ein nicht interaktiver
  `system-worker` ohne Tools und ohne Chat-Oberflaeche.

`memory_user_settings` bleibt fuer persoenliche Entscheidungen erhalten:

```text
automatic_memory_enabled
memory_prompt_max_tokens
sensitive_memory_enabled
```

Die bisherigen userbezogenen Provider-/Modellspalten werden im ersten Schritt
nicht destruktiv entfernt. Nach dem Cutover liest die Runtime sie nicht mehr
als primaere Auswahl. So bleiben Rollback und Bestandsmigration moeglich.

### Stabile Queue-Zuordnung

Neue `memory_review_jobs` erhalten die `organization_id` des gespeicherten
Execution Contexts. Damit haengt ein bereits erzeugter Job nicht von einem
spaeteren Workspace- oder Organisationswechsel des Users ab.

Beim Claim eines Jobs wird die aktuelle, verifizierte
Organisationskonfiguration aufgeloest:

```text
kein Runtime-Setting
  -> awaiting_model_configuration / model_not_configured

Provider oder Modell nicht mehr ready
  -> awaiting_model_configuration / provider_or_model_unavailable

gueltige verifizierte Auswahl
  -> queued/running mit exakt diesem Provider und Modell
```

Die tatsaechlich verwendete Auswahl wird wie bisher in Usage- und Auditdaten
festgehalten. Eine erfolgreiche Neukonfiguration setzt alle passenden
`awaiting_model_configuration`-Jobs der Organisation atomar wieder auf
`scheduled` und weckt den Worker.

## Administrator-Onboarding

Nach der Einrichtung des App-Standardproviders erhaelt der Instanz-Wizard
einen verpflichtenden Schritt „Memory-Reviewer einrichten“:

1. Der Wizard laedt ausschliesslich aktivierte, bereite Provider-Installationen
   und deren freigegebene Modelle.
2. Das App-Standardmodell ist vorausgewaehlt, kann aber bewusst geaendert
   werden.
3. Der Administrator speichert Provider und Modell.
4. Der Server prueft Berechtigung, Organisationszuordnung, Katalogrevision und
   Modellstatus und fuehrt einen kleinen Probeaufruf mit genau diesem Modell
   aus.
5. Nur eine erfolgreiche Probe speichert `verified_at` und die verifizierte
   Katalogrevision.
6. `/api/onboarding/complete` prueft sowohl den verifizierten App-Default als
   auch die verifizierte Memory-Runtime. Fehlt eine der beiden Konfigurationen,
   bleibt das Onboarding offen.
7. Die Abschlussansicht zeigt beide Runtime-Auswahlen getrennt an.

Speichern, Verifikation, Audit und Queue-Reaktivierung muessen serverseitig
idempotent sein. Ein Reload des Wizards darf weder doppelte Settings noch
doppelte Jobs erzeugen.

## Bestehende Installationen

Ein Update darf bereits laufende Instanzen nicht erneut in das gesamte
Erst-Onboarding zwingen.

- Existiert genau eine gueltige, konsistente bisherige Memory-Modellwahl bei
  einem Owner/Admin, darf eine additive Migration diese Auswahl als
  Organisationsdefault uebernehmen und als noch zu verifizieren markieren.
- Bei keiner oder mehreren widerspruechlichen Auswahlen bleibt die
  Organisationsruntime unkonfiguriert. Jobs bleiben sicher geparkt.
- Owner/Admin sehen in Settings und auf der Agent-Karte eine erforderliche
  Aktion mit Deep-Link zur Memory-Runtime-Konfiguration.
- Erst eine aktuelle serverseitige Verifikation aktiviert die automatische
  Queue wieder. Der direkte Memory-Write-Pfad bleibt davon unabhaengig.

## Umsetzungsplan

Die Arbeit erfolgt in dieser Reihenfolge. Jede Phase wird abgeschlossen,
getestet und separat committed, bevor die naechste beginnt.

1. **Vertrag und Datenbankschema**
   - Organisationsweite Runtime-Tabelle und `organization_id` an Review-Jobs
     additiv in die gemeinsame Schema-/Migrationsebene aufnehmen.
   - PostgreSQL-Migration und SQLite-Bestandskompatibilitaet getrennt testen.
   - Bestehende userbezogene Provider-/Modellfelder noch nicht loeschen.

2. **PostgreSQL-only Runtime-Artefakt**
   - SQLite-Adapter aus den PostgreSQL-Startup-Imports und dem normalen
     Production-Dependency-Set herausloesen.
   - `better-sqlite3` und das `sqlite3`-OS-Paket aus dem Standard-Runner
     entfernen.
   - Einen separaten, expliziten Legacy-Migrationspfad fuer bestehende
     SQLite-Installationen erhalten.

3. **Runtime-Aufloesung und Queue-Zustaende**
   - Einen zentralen Resolver fuer die effektive Memory-Runtime bauen.
   - Scheduling, Claim, Worker, Reconfigure und Statusabfragen auf den
     Organisationsdefault umstellen.
   - Parken und Reaktivieren aller betroffenen Jobs transaktional und
     idempotent machen.

4. **Admin-API und Verifikation**
   - Admin-only Read/Update/Verify-Endpunkte fuer die Memory-Runtime schaffen.
   - Den bestehenden Providerkatalog und den gemeinsamen
     Provider-Verifikationsservice wiederverwenden und um eine explizite
     Modellauswahl erweitern.
   - Audit-Events fuer Auswahl, Probe, Fehler und Reaktivierung schreiben.

5. **Onboarding-Gate und UI**
   - Verpflichtenden Memory-Reviewer-Schritt in den Instanz-Wizard integrieren.
   - Abschlussroute und Review-Checkliste um die Memory-Verifikation ergaenzen.
   - Settings-Karte auf organisationsweite Admin-Konfiguration und fuer normale
     User auf einen lesbaren „durch Administrator verwaltet“-Status umstellen.

6. **Bestandsmigration und Rollout**
   - Eindeutige Altwahl kontrolliert uebernehmen, Konflikte sichtbar lassen.
   - Bestehende wartende Jobs nach Verifikation reaktivieren.
   - Produktdokumentation, Health-/Diagnoseausgabe und Upgrade-Hinweise
     aktualisieren.

7. **Abnahme**
   - Relevante Unit-, Service-, API-, Queue- und PostgreSQL-Integrationstests
     ausfuehren.
   - `npm run build` muss erfolgreich sein.
   - Die visuelle Onboarding- und Settings-Pruefung erfolgt gemaess
     Repository-Regel erst nach expliziter Freigabe mit Playwright oder Chrome.

## Verbindliche Tests

- Eine leere PostgreSQL-Datenbank erhaelt alle Memory-Tabellen und Settings,
  ohne dass eine SQLite-Datei existiert oder erzeugt wird.
- Das Production-Runner-Image enthaelt weder `better-sqlite3`, ein natives
  SQLite-Addon noch das `sqlite3`-CLI.
- Ein reines PostgreSQL-Production-Setup startet nach idempotenter
  Schema-Migration erfolgreich neu.
- Das Instanz-Onboarding kann ohne verifizierten Memory-Provider und ohne
  verifiziertes Memory-Modell nicht abgeschlossen werden.
- Ein deaktivierter, geloeschter oder nicht bereiter Provider beziehungsweise
  ein deaktiviertes Modell wird fail-closed abgelehnt.
- Jobs vor der Konfiguration werden geparkt und nach erfolgreicher
  Admin-Konfiguration genau einmal reaktiviert.
- Mehrere User verwenden dieselbe organisationsweite Runtime-Auswahl, waehrend
  Memories, Prompt-Budgets, Sensitivitaet und Queue-Nutzdaten isoliert bleiben.
- Ein laufender Job speichert die tatsaechlich verwendete Provider-/Modellwahl
  in Audit und Usage.
- Der SQLite-Bestandsimport bleibt separat, idempotent und kopiert die neuen
  Settings und Job-Organisationszuordnungen korrekt.
- Das direkte Onboarding- und Chat-`memory`-Tool funktioniert auch bei einer
  temporaer nicht verfuegbaren Review-Runtime weiter.

## Akzeptanzkriterien

- Frische Production-Installationen besitzen keinen SQLite-Laufzeitpfad und
  keine `sqlite.db`; ihr Standard-Runner enthaelt auch keine SQLite-Engine.
- PostgreSQL-Schemamigrationen laufen vor dem Serverstart und brechen bei
  Fehlern den Start ab.
- Das erste Administrator-Onboarding endet nur mit einem funktionierenden,
  explizit verifizierten Memory-Reviewer-Modell.
- Kein normaler User muss Provider oder Modell fuer automatische Memories
  selbst konfigurieren.
- Queue-Arbeit startet nach dem Onboarding ohne weiteren Settings-Schritt.
- Provider-Ausfaelle sind sichtbar, sicher geparkt und nach Re-Konfiguration
  wiederaufnehmbar.
- Der isolierte Reviewer erhaelt weiterhin keine Tools, keine Secrets und
  keinen direkten Datenbank-Schreibzugriff ausserhalb des validierenden
  Memory-Service.
