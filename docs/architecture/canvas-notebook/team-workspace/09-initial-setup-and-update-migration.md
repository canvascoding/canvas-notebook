# Initial Setup, Onboarding und Update-Migration

Stand: 2026-06-17

## Zweck

Dieses Dokument konkretisiert den ersten Start einer neuen Canvas Notebook Instanz und die Migration bestehender Instanzen beim Update auf Team-/Workspace-faehige Versionen. Es ergaenzt die Aufgaben `4`, `10`, `11`, `12`, `13`, `16`, `17`, `18`, `19`, `22`, `27`, `28`, `31` und `36` im Aufgabenindex.

Kernregel: Fresh Install und Update-Migration muessen denselben Zielzustand erzeugen. Es darf keine zweite Alt-Logik geben, in der der erste Admin, globale Env-Dateien, globale Skills/Plugins oder `data/workspace` dauerhaft anders behandelt werden.

Die Database-Provider-Entscheidung ist in `17-database-provider-postgres-rag-collaboration-policy.md` verbindlich: SQLite bleibt fuer Community/Single-User; Team-/Advanced-/RAG-Installationen muessen Postgres mit pgvector verwenden.

## Aktueller Befund

Heute gibt es zwei Setup-Pfade:

- `/setup` erstellt den ersten Better-Auth-User mit `user.role = "admin"`.
- `scripts/bootstrap-admin.js` synchronisiert oder erstellt einen Admin aus `BOOTSTRAP_ADMIN_EMAIL` und `BOOTSTRAP_ADMIN_PASSWORD`.

Heute gibt es ausserdem Runtime-Bootstrap:

- `scripts/bootstrap-agent-runtime.ts` migriert alte Dateien aus `/home/node/canvas-agent` und `/data/canvas-agent`.
- Agent-Dateien werden nach `/data/agents/canvas-agent` kopiert.
- Settings wie `pi-runtime-config.json`, `mcp.json`, `mcp-cache.json`, `auth.json` werden nach `/data/settings` kopiert.
- `Canvas-Integrations.env` und `Canvas-Agents.env` werden unter `/data/secrets` angelegt oder aus Legacy-Pfaden kopiert.
- Seed-Skills und Seed-Plugins werden global nach `/data/skills` und `/data/plugins` materialisiert.

Diese Pfade sind fuer Single-User-Instanzen brauchbar, aber fuer Team-Instanzen nicht ausreichend, weil sie keinen `organizationId`, `userId` oder `workspaceId` tragen.

## Zielzustand nach Fresh Install

Nach dem ersten erfolgreichen Setup muss die Instanz sofort im neuen Scope-Modell liegen.

Pflichtobjekte:

- genau eine lokale Canvas Organization,
- genau ein erster User,
- dieser User ist globale Recovery-/Instance-Admin-Rolle,
- dieser User ist Organization Owner,
- Owner-Permission-Row mit allen Owner-Rechten,
- Personal Workspace fuer den Owner,
- Team Workspace, wenn Deployment Mode und Lizenz Team erlauben,
- User-scoped Runtime-/Secret-/Tool-Verzeichnisse fuer den Owner,
- Organization-scoped Template-/Policy-Verzeichnisse,
- System-/Managed-Verzeichnisse.
- erlaubter Database Provider fuer den Deployment Mode.

Empfohlene physische Mindeststruktur:

```txt
/data/
  workspaces/
    personal/{ownerUserId}/files/
    team/{organizationId}/files/
  users/{ownerUserId}/
    settings/
    secrets/
    agents/
    skills/
    plugins/
    mcp/
    mail/
  organizations/{organizationId}/
    settings/
    secrets/
    policies/
    agent-templates/
    skill-templates/
    plugin-templates/
    mcp-templates/
  system/
    settings/
    secrets/
    managed/
```

Der Team Workspace wird nur angelegt, wenn Team-Features in Lizenz/Deployment Mode aktiv sind. In Community/Single-User wird eine lokale Organization trotzdem angelegt, aber Team-Features bleiben gesperrt und nur der Personal Workspace ist produktiv sichtbar.

Team-Features duerfen nur angelegt und aktiviert werden, wenn der Provider-Gate bestanden ist:

- Community/Single-User: `CANVAS_DATABASE_PROVIDER=sqlite` ist erlaubt.
- Managed Single: SQLite ist erlaubt, solange Team Knowledge, Team Workspace, produktives RAG und Collaboration gesperrt bleiben.
- Managed Team/Enterprise Team: `CANVAS_DATABASE_PROVIDER=postgres` ist Pflicht.
- Wenn ein Teamplan mit SQLite startet, bleibt die App im Setup-/Health-Blocker und fordert Postgres-Provisioning oder Migration.

## First-Run Ablauf

Empfohlener Ablauf fuer `/setup` und `bootstrap-admin`:

1. DB-Migrationen laufen.
2. Database Provider, Deployment Mode und `organizationId` werden aufgeloest.
3. Provider-Gate prueft, ob SQLite fuer den Deployment Mode erlaubt ist oder Postgres/pgvector erforderlich ist.
4. Setup prueft, ob bereits ein Auth-User existiert.
5. Wenn kein User existiert, wird der erste User erstellt.
6. In derselben Transaktion oder einem wiederaufnehmbaren Bootstrap-Job werden Organization, Owner Membership, Permissions und Workspace-Metadaten erstellt.
7. Scoped Verzeichnisse werden angelegt.
8. Seed-Agent-Dateien, BOOTSTRAP.md, Default-Skills und Default-Plugins werden in den Owner-User-Scope oder Organization-Template-Scope geschrieben, nicht in globale aktive Runtime-Pfade.
9. Aktiver Default Workspace des Owners wird auf den Personal Workspace gesetzt.
10. Onboarding startet im Owner-Personal-Workspace.
11. Onboarding schreibt User-/Agent-Profil in den Owner-User-Agent-Scope.

Invarianten:

- Kein UI-Schritt darf Team- oder Runtime-Features zeigen, bevor Organization, Owner und Personal Workspace existieren.
- Kein Team-/RAG-UI-Schritt darf sichtbar aktiv werden, bevor der Database Provider zum Deployment Mode passt.
- `/setup` und `bootstrap-admin` muessen denselben Servicepfad nutzen oder denselben Zielzustand garantieren.
- Wenn der Bootstrap nach User-Erstellung, aber vor Workspace-Erstellung abstuerzt, muss der naechste Start die fehlenden Objekte idempotent nachziehen.
- `BOOTSTRAP_ADMIN_EMAIL` und `BOOTSTRAP_ADMIN_PASSWORD` bleiben Bootstrap-Secrets und werden nicht in User-/Organization-Secret-Stores geschrieben.
- Der erste Admin wird nicht ueber E-Mail-Adresse im Dateisystem referenziert, sondern nur ueber `ownerUserId`.

## Organization-ID Aufloesung

Fresh Install:

1. Managed/Team: `organizationId` aus Lizenzclaim oder `CANVAS_ORGANIZATION_ID`.
2. Community/Development: lokal generierte stabile ID.
3. Persistierte DB-ID wird danach lokale Wahrheit.

Update:

1. Wenn bereits eine persistierte Canvas Organization existiert, muss sie mit Env/Lizenz abgeglichen werden.
2. Wenn keine existiert, wird sie gemaess Migration erzeugt.
3. Ein Konflikt zwischen persistierter Organization-ID und Managed Claim ist ein Start-/Health-Problem und darf nicht still repariert werden.

## Database Provider Aufloesung

Fresh Install:

1. Canvas Notebook CLI oder Control Plane Provisioning setzt `CANVAS_DATABASE_PROVIDER`.
2. Wenn der Installer Team/Advanced/RAG auswaehlt, wird Postgres erzwungen.
3. Bei Postgres muss `DATABASE_URL` gesetzt sein und der Healthcheck muss die Verbindung sowie pgvector pruefen.
4. Bei SQLite nutzt die App weiterhin `/data/sqlite.db`.

Update:

1. Bestehende Instanzen ohne Provider-Angabe werden als `sqlite` interpretiert.
2. Wenn eine bestehende Instanz auf Team/Advanced/RAG wechseln soll, muss zuerst der SQLite-zu-Postgres-Migrationsflow laufen.
3. Team-Lizenz plus SQLite ohne laufenden Migrationsflow ist ein blockierender Health-/Setup-Fehler.
4. Provider-Wechsel wird im Migration-State protokolliert und ist nicht nur eine Env-Aenderung.

## Update-Migration bestehender Instanzen

Bestehende Instanzen muessen beim Update versioniert und idempotent migriert werden.

Empfohlenes Migrationsformat:

```txt
/data/settings/team-workspace-migration.json
```

Beispiel:

```json
{
  "version": 1,
  "startedAt": "2026-06-17T00:00:00.000Z",
  "completedAt": null,
  "sourceLayout": "legacy-global",
  "targetLayout": "team-workspace-v1",
  "ownerUserId": "user_...",
  "organizationId": "org_...",
  "steps": {
    "organization": "completed",
    "personalWorkspace": "completed",
    "teamWorkspace": "completed",
    "legacyWorkspace": "completed",
    "runtimeFiles": "needs-review",
    "envFiles": "needs-review",
    "skillsPlugins": "needs-review"
  }
}
```

Alternativ oder zusaetzlich kann eine DB-Tabelle `data_migrations` verwendet werden. Wichtig ist nicht der Speicherort, sondern dass die Migration wiederaufnehmbar, auditierbar und eindeutig versioniert ist.

## Owner-Aufloesung bei Update

Die Migration braucht einen Owner.

Sichere Reihenfolge:

1. Wenn genau ein Auth-User existiert, wird dieser Owner.
2. Wenn `BOOTSTRAP_ADMIN_EMAIL` gesetzt ist und exakt einen bestehenden User matcht, wird dieser Owner.
3. Wenn genau ein aktiver `user.role = "admin"` existiert, wird dieser Owner.
4. Wenn mehrere Kandidaten existieren, stoppt die Team-Migration und verlangt Admin-Review.

Nicht erlaubt:

- zufaellig ersten User als Owner waehlen, wenn mehrere Kandidaten existieren,
- fremde User automatisch als Team-Member freischalten,
- alte private Daten automatisch in den Team Workspace verschieben.

## Legacy Workspace Migration

Bestehendes `data/workspace` wird nie automatisch Team Workspace.

Default-Migration:

1. Personal Workspace fuer den Owner anlegen.
2. Team Workspace initial leer anlegen, wenn Team-Features aktiv sind.
3. `data/workspace` als Owner-Legacy-Workspace importieren oder mappen.
4. Empfohlener Zielpfad: `/data/workspaces/personal/{ownerUserId}/files/legacy-workspace/`.
5. Team-Freigabe alter Daten erfolgt spaeter explizit ueber Copy/Move/Publish-Flow.

Fuer sehr grosse Workspaces darf ein DB-Mapping temporaer auf den alten physischen Root zeigen. Auch dann gilt: Der Root gehoert fachlich zum Owner-Personal-Workspace und nicht zum Team Workspace.

## Legacy Runtime- und Dateiformate

Bestehende globale Dateien werden in folgende Zielklassen migriert:

| Legacy-Datei/-Pfad | Aktuelles Format | Ziel bei sicherem Single-User | Ziel bei Team-/Mehruser-Migration |
|---|---|---|---|
| `/data/workspace` | Dateiordner | Owner Personal Workspace, optional `legacy-workspace/` | Owner Personal Workspace, Team bleibt leer |
| `/data/canvas-agent/*.md` | Markdown | Owner User-Agent-Scope | Owner User-Agent-Scope oder Review |
| `/data/agents/canvas-agent/*.md` | Markdown | Owner User-Agent-Scope | Owner User-Agent-Scope oder Organization Template nach Review |
| `/data/settings/pi-runtime-config.json` | JSON | Owner User Settings plus System Defaults | Review: Owner User Settings, Org Defaults oder System Defaults |
| `/data/settings/mcp.json` | JSON | Owner User MCP Config | Organization Template, nicht aktive User-Konfig |
| `/data/settings/mcp-cache.json` | JSON Cache | verwerfen oder Owner User Cache | verwerfen; kein Team-Import |
| `/data/settings/mcp-oauth/` | Token/State | Owner User MCP Secrets/State | Review/Reconnect; nicht automatisch teamweit |
| `/data/settings/email-oauth/` | OAuth State | Owner User Mail State | nur Owner, wenn eindeutig; sonst Reconnect |
| `/data/secrets/Canvas-Integrations.env` | dotenv | Owner User Secrets oder Review | Admin-Review pro Key: user/org/system/discard |
| `/data/secrets/Canvas-Agents.env` | dotenv | Owner User Secrets oder System Defaults nach Review | Admin-Review pro Key: user/org/system/discard |
| `/data/skills` | Registry/Files | Owner User Skills und optional Org Templates | Org Templates; User-Aktivierung separat |
| `/data/plugins` | Registry/Files | Owner User Plugins und optional Org Templates | Org Templates; User-Aktivierung separat |

Formatregeln:

- JSON-Dateien bekommen bei Migration eine neue `version` oder werden in ein neues Wrapper-Format ueberfuehrt.
- Importierte Dateien speichern `legacySourcePath`, `migratedAt`, `migratedBy` und Ziel-Scope.
- Dotenv-Dateien werden nicht blind in einen aktiven Team-Scope geladen.
- Secrets werden nur als Secret-Refs und Metadaten migriert, wenn der Ziel-Scope nicht eindeutig ist.
- Token-/OAuth-State wird bei Unsicherheit nicht kopiert, sondern per Reconnect neu aufgebaut.

## Onboarding nach Migration

Onboarding ist userbezogen.

Fresh Install:

- Onboarding des ersten Users laeuft im Owner-Personal-Workspace.
- `BOOTSTRAP.md` ist nur fuer den Owner-User-Agent-Scope sichtbar.
- Abschluss schreibt `USER.md`/`SOUL.md` oder Nachfolgeformate in den Owner-User-Agent-Scope und markiert nur diesen Onboarding-Flow als abgeschlossen.

Bestehende Instanz:

- Wenn Onboarding bereits abgeschlossen war, wird es nicht erneut erzwungen.
- Bestehende globale Onboarding-Artefakte werden dem Owner-User-Scope zugeordnet.
- Neue User bekommen eigene User-Onboarding-Hints und eigene Integrations-/Mailbox-/Tool-Setups.
- Organization-Onboarding fuer Admins kann separat anzeigen, welche Legacy-Env-, MCP-, Skill-/Plugin- und Runtime-Items noch Review brauchen.

## Blocking Conditions

Die Migration muss stoppen oder Team-Features gesperrt halten, wenn:

- kein Owner eindeutig bestimmbar ist,
- persistierte Organization-ID und Managed Claim kollidieren,
- `data/workspace` nicht sicher einem Owner zugeordnet werden kann,
- globale Env-Dateien Secrets enthalten, die keinem Scope zugeordnet wurden,
- MCP-OAuth-State nicht eindeutig einem User zugeordnet werden kann,
- DB-Migration teilweise fehlgeschlagen ist,
- Team-/Advanced-/RAG-Deployment mit SQLite statt Postgres startet,
- Postgres erreichbar ist, aber pgvector oder Schema-Version fehlt,
- scoped Root-Verzeichnisse nicht mit sicheren Permissions angelegt werden koennen.

In diesen Faellen bleibt die App im Legacy-/Maintenance-Modus oder zeigt Admin-Review an. Es darf keinen stillen Fallback auf globale Team-Runtime geben.

## Tests

Pflichttests:

- Fresh `/setup` erstellt User, Organization, Owner Membership, Permissions, Personal Workspace und scoped User-Verzeichnisse.
- `bootstrap-admin` erzeugt denselben Zielzustand wie `/setup`.
- Bootstrap ist idempotent, wenn User existiert, aber Organization oder Workspace noch fehlen.
- Community Fresh Install erstellt lokale Organization, aber keine sichtbaren Team-Features.
- Community/Single-User Fresh Install darf mit SQLite starten.
- Managed-Team Fresh Install mit SQLite blockiert vor Team-Feature-Aktivierung.
- Managed-Team Fresh Install mit Postgres prueft `DATABASE_URL`, Schema-Version und pgvector-Status.
- Managed-Team Fresh Install verlangt stabile `organizationId`.
- Single-User-Update migriert `data/workspace` in den Owner-Personal-Workspace, nicht in den Team Workspace.
- Multi-User-Update mit mehreren Owner-Kandidaten stoppt mit Admin-Review.
- Globale `.env`-Dateien werden nicht automatisch als Organization-Secrets aktiviert.
- Globale `mcp.json` wird als Template/Review importiert, nicht als aktive User-Konfig fuer alle.
- Seed-Skills/Plugins werden in User- oder Organization-Template-Scope geschrieben, nicht global aktiv fuer alle.
- Migration kann nach Abbruch erneut laufen, ohne doppelte Workspaces oder doppelte Owner Memberships zu erzeugen.
- Update ohne Provider-Angabe wird als SQLite erkannt.
- SQLite-zu-Postgres-Migration laeuft nur im Maintenance Mode und protokolliert Provider-Wechsel.
