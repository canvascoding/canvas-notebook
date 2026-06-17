# Canvas Notebook Team Workspace Inventory

Stand: 2026-06-17

## Zweck

Dieses Dokument schliesst Umsetzungsschritt 1 aus dem Team-Workspace-Plan ab: bestehende Canvas Notebook Datei- und Workspace-Zugriffe inventarisieren. Es beschreibt den Ist-Zustand im Notebook-Repository und markiert die Stellen, die vor einer Team-Workspace-Umsetzung entkoppelt werden muessen.

## Kurzfazit

Canvas Notebook ist bereits in vielen fachlichen Bereichen user-aware, aber noch nicht workspace- oder organization-aware. Der sichtbare Arbeitsbereich ist an mehreren Stellen hart als ein globaler Ordner `data/workspace` beziehungsweise `/data/workspace` modelliert. Die File-API ist weitgehend ueber `app/lib/filesystem/workspace-files.ts` zentralisiert und damit ein guter Einstiegspunkt fuer eine Workspace-Service-Schicht. Agent-Dateioperationen, System-Prompts, Migration/Export, QMD/Search und Public Links muessen separat migriert werden, weil sie eigene Pfadannahmen oder persistierte `workspacePath`-Referenzen nutzen.

## Zentrale globale Workspace-Annahmen

- `app/lib/filesystem/workspace-files.ts` setzt den Workspace Root fest auf `path.join(getDataDir(), 'workspace')` und validiert alle normalen Dateioperationen gegen diesen einen Root (`getWorkspaceBaseDir`, `validatePath`, `resolveExistingWorkspacePath`, `writeFile`, `deleteFile`).
- `app/lib/utils/workspace-manager.ts` gibt ebenfalls immer `data/workspace` zurueck. `getWorkspacePath(_sessionId?)` ignoriert die `sessionId` explizit.
- `app/lib/pi/agent-file-operations.ts` hat eine eigene Root-Funktion: `getAgentWorkspaceRoot()` zeigt auf `data/workspace`. Relative Agent-Pfade werden dorthin aufgeloest, absolute Pfade bleiben erlaubt und werden nur gegen geschuetzte Bereiche wie `secrets`, `proc` und Snapshot-Cache geprueft.
- `app/lib/agents/base-system-prompt.ts` weist Agenten an, finale Dateien unter `/data/workspace` zu schreiben und relative Pfade gegen `/data/workspace` aufzuloesen.
- `app/lib/qmd/status.ts` nutzt `/data/workspace` als Default-Collection fuer Workspace-Text.
- `scripts/docker-entrypoint.sh` legt `/data/workspace` an und konfiguriert QMD mit diesem Pfad.

Konsequenz: Der erste technische Schnitt muss eine Workspace-Context-Aufloesung sein, die einen aktiven Workspace in einen Root-Pfad uebersetzt und danach dieselben Path-Security-Regeln erzwingt wie heute.

## File-API und UI

Die File-API ist gut als erste Migrationsflaeche geeignet:

- `app/api/files/create/route.ts`, `read/route.ts`, `write/route.ts`, `delete/route.ts`, `copy/route.ts`, `rename/route.ts`, `download/route.ts`, `preview/route.ts`, `tree/route.ts`, `exists/route.ts` und Upload-/Export-Routen greifen ueber Funktionen aus `workspace-files.ts` oder `validatePath()` auf Dateien zu.
- Der aktuelle API-Vertrag kennt nur `path`, `sources`, `destDir` usw. Es gibt keinen `workspaceId`, `workspaceType` oder aktiven Workspace im Request.
- Public-Share-Annotationen werden in File-Listen ueber `workspacePath` angebunden.
- Die UI-Komponenten unter `app/components/file-browser/` und Stores wie `app/store/file-store.ts` arbeiten mit workspace-relativen Pfaden ohne Workspace-Identitaet.

Risiko bei Team-Migration: Wenn nur die physische Ordnerstruktur geaendert wird, bleiben UI und API mehrdeutig. Ein Pfad wie `docs/brief.md` muss immer zusammen mit `workspaceId` oder einem serverseitig aufgeloesten aktiven Workspace interpretiert werden.

## Persistenz und Scopes

Bestehende user-aware Tabellen:

- Better Auth Tabellen `user`, `session`, `account`.
- E-Mail: `email_accounts`, `email_drafts` und Reply-Watcher/Event-Tabellen haben `userId`.
- Chat/Agent: `ai_sessions`, `pi_sessions`, `pi_usage_events`, `session_channel_links`, `channel_active_sessions` haben `userId`; `pi_sessions` hat zusaetzlich `agentId`, aber kein `workspaceId`.
- Todos: `todo_items`, `todo_categories`, `todo_file_links` sind user-scoped.
- Studio: Produkte, Personas, Styles, Generations und Bulk Jobs sind user-scoped.
- Channels: Telegram/Web-Channel-Bindings sind user-scoped.

Noch fehlende Team-Scope-Grundlagen:

- Keine `organizations`- oder `workspaces`-Tabellen.
- Keine `workspaceId`-Spalten an `pi_sessions`, `automation_jobs`, `automation_runs`, `public_file_shares`, `todo_file_links`, Studio-Tabellen oder Migration-Manifesten.
- `agents` sind global eindeutig ueber `agentId`, nicht user- oder organization-scoped.
- Rollen basieren aktuell auf Better Auth `user.role`; `isAdminUser()` prueft `role === 'admin'` oder Bootstrap-Admin-E-Mail. `owner`, `member`, `external` und per-user Team-Permissions fehlen.

## Agent-Dateioperationen

Agent-Dateioperationen sind der kritischste Bereich fuer Teamfaehigkeit:

- Pfadaufloesung: relative Pfade gehen nach `data/workspace`; absolute Pfade bleiben moeglich.
- Schutzmodell: `assertAgentPathAllowed()` blockiert bekannte Schutzbereiche, erzwingt aber keinen aktiven Workspace Root.
- Nebenwirkungen: Agent-Dateioperationen synchronisieren Public Shares nach Writes, Moves und Deletes.
- Audit: Snapshot-Metadaten enthalten Pfad, Operation und Hashes, aber keinen `organizationId`, `workspaceId`, `userId` oder `sessionId` als harte Audit-Relation.

V1-Anforderung: Agent-Tools muessen einen `WorkspaceContext` bekommen und alle relativen wie absoluten Workspace-Dateipfade gegen den aktiven Workspace Root normalisieren. Absolute `/data/workspace`-Pfade sollten in Team-Instanzen nur noch als Legacy-Alias fuer den aktiven Workspace erlaubt sein, nicht als globale Wahrheit.

## Public Links

`public_file_shares` speichert:

- `workspacePath`
- `createdByUserId`
- `createdByAgentId`
- `sourceSessionId`
- Status, Token, Security Mode, Ablauf und Zugriffsdaten

Es fehlen:

- `workspaceId`
- `organizationId`
- Revision/File-Version
- Access Policy fuer personal/team/project

Die Public-Link-Services in `app/lib/public-sharing/` normalisieren aktuell absolute `/data/workspace`-Pfade auf workspace-relative Pfade und loesen Dateien ueber den globalen Workspace auf. Fuer Team-Workspaces muss jeder Link eindeutig an einen Workspace gebunden werden, sonst kann derselbe relative Pfad in mehreren Workspaces kollidieren.

## Automations

`automation_jobs` enthaelt bereits:

- `createdByUserId`
- `agentId`
- Delivery-/Channel-Informationen
- `workspaceContextPathsJson`
- `targetOutputPath`

Es fehlen:

- `workspaceId`
- `workspaceType`
- `organizationId`
- Owner-/Organization-Scope fuer Team-Automations
- explizite Permission-Pruefung fuer Team-Workspace-Ausfuehrungen

Der Runner erstellt Zielordner ueber `createDirectory()` aus `workspace-files.ts`, also immer im globalen Workspace. Automations sollten erst auf Team-Scope migriert werden, wenn der Workspace-Service serverseitig existiert.

## Migration, Export und Backup

`app/lib/migration/component-paths.ts` exportiert Komponenten aus festen Data-Roots:

- `data/workspace`
- `data/studio/assets`
- `data/studio/outputs`
- `data/user-uploads`
- `data/agents`
- `data/settings`
- `data/canvas-agent`
- `data/skills`
- optional `data/secrets`

Der Export ist fuer Single-Instance-Migrationen sinnvoll, aber noch nicht organization-granular. Fuer Team-Instanzen muessen Export-Manifeste `organizationId`, `workspaceId`, User-Mapping und Secret-Redaction/Reconnect-Verhalten enthalten.

V1-Regel: Ein normaler User darf nur den eigenen Personal Workspace exportieren. Team-Workspace- und Organization-Exporte sind admin- oder permission-gated.

## Studio und generierte Assets

Studio-Tabellen sind user-scoped, aber nicht organization-scoped. Das passt fuer Community/Single-User, kollidiert aber mit dem Zielbild "Organization-geteilte Bibliotheken":

- Produkte, Personas und Styles haben `userId`.
- Generations und Bulk Jobs haben `userId`.
- Output-Dateipfade zeigen auf Studio-Data-Pfade, nicht auf Workspaces.

V1 sollte nicht blind alle Studio-Daten teamweit sichtbar machen. Erst braucht es Organization-Scope und eine Policy, ob eigene oder alle Assets sichtbar sind.

Der aktuelle Save-to-Workspace-Flow schreibt noch in den globalen Workspace. Fuer Team-Instanzen muss der Dialog einen Ziel-Workspace abfragen und die API `targetWorkspaceId` plus `targetPath` validieren. Speichern in den Team Workspace ist nur mit Team-Write-Permission erlaubt.

## Skills, Plugins, Agents und Runtime Config

- Skills liegen unter `data/skills`.
- Plugins liegen unter `data/plugins`.
- Agent-Dateien und Runtime-Konfiguration liegen unter `data/agents`, `data/settings` und `data/canvas-agent`.
- `agents` in der DB sind global; relevante Skills/Connections sind JSON-Felder an der Agent-Definition.
- `resolveAgentRuntimeConfig()` wird derzeit mit `agentId` aufgerufen, nicht mit User/Workspace/Organization.

V1-Teamlogik braucht einen klaren Split:

- Organization Defaults und Policies.
- User Tool-Stack und User Runtime Preferences.
- Workspace Policy.
- Session-Auswahl als finaler Override.

## Bereiche mit guter Ausgangslage

- Auth nutzt Better Auth und hat bereits Admin-Plugin sowie deaktiviertes Self-Signup.
- E-Mail-Konten und Drafts sind bereits user-scoped.
- Chat-/PI-Sessions sind user-scoped und agent-aware.
- Usage Events speichern `userId`.
- Channel Bindings sind user-scoped.
- File-API laeuft ueber wenige zentrale Helper, sodass ein Workspace-Service ohne kompletten API-Neubau eingefuehrt werden kann.

## Empfohlene naechste technische Schritte

1. Scope-Klassifizierung der bestehenden Funktionen abschliessen und als eigene Matrix dokumentieren.
2. Datenmodell fuer `organizations`, `workspaces`, Rollen und per-user Team-Permissions entwerfen.
3. `WorkspaceContext` definieren: `organizationId`, `workspaceId`, `type`, `ownerUserId`, `rootPath`, `userId`, `permissions`.
4. `workspace-files.ts` so vorbereiten, dass bestehende Funktionen einen optionalen Workspace-Kontext akzeptieren, waehrend Community/Legacy weiter auf `data/workspace` faellt.
5. API-Vertrag fuer File-Routen erweitern: aktiver Workspace serverseitig aus Session/Preference oder explizitem `workspaceId` aufloesen.
6. Globalen Workspace UI State planen: Startseite, Chat Header und File Browser duerfen denselben aktiven Workspace setzen.
7. Agent-Session-Regel festlegen: Workspace-Wechsel im Chat startet eine neue Session; bestehende Sessions behalten ihren gespeicherten `workspaceId`.
8. Agent-Dateioperationen auf denselben Workspace Resolver umstellen.
9. Studio Save-to-Workspace auf Ziel-Workspace-Auswahl und Workspace Resolver umstellen.
10. Erst danach UI-Switcher fuer Personal/Team Workspace bauen, damit die UI nicht vor der serverseitigen Isolation existiert.

## Offene technische Fragen fuer V1

- Soll `data/workspace` physisch in den Owner-Personal-Workspace kopiert werden oder zunaechst als read-only Legacy-Root fuer den Owner gemappt bleiben?
- Wird `CANVAS_ORGANIZATION_ID` als Env gebootstrappt und in der DB persistiert, oder nur aus dem License Cert gelesen?
- Soll `workspaceId` schon in V1 an Public Links, Todos, Automations, PI Sessions und Studio Generations migriert werden, oder gibt es eine Kompatibilitaetsschicht?
- Werden Agent-absolute Pfade in Team-Instanzen komplett verboten oder nur fuer bekannte Runtime-Pfade erlaubt?
- Welche Better-Auth-Rollenstruktur soll fuer `owner`, `admin`, `member`, `external` konkret verwendet werden?
