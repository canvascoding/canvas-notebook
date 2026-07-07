# Workspace-Verwaltung Plan

Datum: 2026-07-08 (v5, Project-Rollout ergänzt)

## Aktueller Stand

Diese Version dokumentiert den Stand des Review-/Feature-Branches nach der Branch-Bereinigung und den weiter abgearbeiteten Workspace-TODOs:

- `dcb9f9ea` — `Allow organization chat workspace type`
- `69240f33` — `Add organization workspace defaults`
- `519b604b` — `Add workspace management UI`
- `b19d8b80` — `Add workspace member management`
- `fa680832` — `Add project workspace member management`
- `4de187bb` — `Add workspace type changes`

Die Änderungen wurden aus `origin/main` herausgenommen und liegen auf dem Review-/Feature-Branch `codex/workspace-management`. `origin/main` enthält dafür den Revert-Commit `c181835e` (`Remove workspace management changes from main`), damit Greptile später einen echten PR-Diff prüfen kann.

### Bereits umgesetzt

- `organization` als eigener Workspace-Typ ist eingeführt.
- Default-Workspaces werden mit `is_default` markiert; bestehende Default-`team`-Workspaces werden zu `organization` migriert.
- `canvas_workspace_members` existiert für eingeschränkte Team-Workspaces.
- Personal- und Organisations-Default-Workspaces werden beim Bootstrap/Ensure-Prozess erzeugt.
- Organisations-Workspace ist für aktive interne Org-Mitglieder lesbar; Team-Workspaces verwenden explizite Member-Rechte.
- Standard-Workspaces und Organisations-Workspaces können serverseitig nicht gelöscht werden.
- Workspace-Delete ist Soft-Delete (`status='disabled'`) und blockt bei aktiven Automations.
- Weitere Personal-, Team- und Project-Workspaces können per `POST /api/workspaces` erstellt werden; Project bleibt hinter `CANVAS_PROJECT_FEATURES_ENABLED`.
- `GET`/`POST /api/customers` und `GET`/`POST /api/projects` sind hinter demselben Feature-Gate vorhanden.
- Project-Workspace-Erstellung validiert aktives Project, verhindert doppelte Workspaces pro Project und legt den Ersteller als Project-Admin an.
- Workspace-Management-Card im Settings-Tab `workspace` ist vorhanden.
- `CreateWorkspaceDialog` ist vorhanden und zeigt Project-Option + Project-Dropdown nur bei aktivem Project-Feature.
- Workspace-Switcher hat Plus-Button/Deeplink zu den Workspace-Settings.
- Default-Badge, Organization-Label/Icon und Store/API-Serialisierung für `isDefault` sind vorhanden.
- Team-Member-Management ist implementiert: `GET`/`POST /api/workspaces/[id]/members`, `DELETE /api/workspaces/[id]/members/[userId]`, `WorkspaceMembersDialog`, Candidates, Upsert, Remove und letzter-Manager-Schutz.
- Project-Member-Management ist in denselben Member-Endpunkten implementiert und nutzt `canvas_project_members` mit demselben letzten-Manager-Schutz.
- Workspace-Typ-Wechsel ist in Service und API umgesetzt (`PATCH /api/workspaces/[id]`) inklusive Root-Move/Rollback und Rechte-Migration zwischen Personal, Team und Project. Die UI aktiviert Personal/Team und Project hinter Feature-Gate.
- Granulare User-Permissions sind im User-Management umgesetzt: `GET`/`PATCH /api/admin/organization/users/[userId]/permissions`, `PATCH /api/admin/organization/users/[userId]/role`, `UserPermissionsDialog` und serverseitige Mutation-Guards.
- Die Rolle `external` ist vorbereitet und per `CANVAS_EXTERNAL_USERS_ENABLED` feature-gated; externe Nutzer bekommen serverseitig keine Org-Permissions.
- SQLite- und Postgres-Runtime wurden für die umgesetzten Workspace-Funktionen erweitert.
- Relevante i18n-Keys in `messages/de.json` und `messages/en.json` wurden ergänzt.

### Verifiziert

- `npm run lint` bestanden.
- `npm run build` bestanden.
- `npm run test:workspace:model` bestanden.
- `npx tsx --conditions react-server scripts/project-customer-model-test.ts` bestanden.
- `npx tsx --conditions react-server scripts/organization-permission-guards-test.ts` bestanden.
- `npm run test:workspace:switcher-ui` bestanden.
- `npm run test:workspace:foundation` bestanden.

Bekannter Prüfstatus: Ein echter Browser-UI-Smoke gegen `localhost:3000` war nicht verwertbar, weil der bereits laufende Server HTTP 500 für `/api/health` und `/en/login` geliefert hat. Zusätzlich war der Browser-Plugin-Pipe-Bridge-Zugriff nicht verfügbar; Playwright über lokales Chrome konnte den Serverfehler nur bestätigen.

### Noch offen

- External-User-Produktverhalten außerhalb der Permission-Rolle finalisieren.
- Offboarding-Erweiterung für mehrere Personal-Workspaces und Team-Workspace-Manager-Preflight.
- Restliche Edge-Cases aus Strang H zentralisieren, testen und mit stabilen Error-Codes verdrahten.
- API-/UI-Tests für den Project-Rollout und die noch offenen Offboarding-Flows ergänzen.
- Reale UI-/E2E-Prüfung wiederholen, sobald `localhost:3000` gesund läuft.

### Klärungsbedarf

- Delegationsregel für granulare Permissions ist für V1 entschieden: Nur Owner/Admins dürfen mutieren; Admins dürfen keine Permission vergeben, die sie selbst nicht besitzen; Owner dürfen alle Permissions setzen.
- External-User-Zugriff: Rolle und Org-Permission-Block sind feature-gated umgesetzt, aber erlaubte produktweite UI-Aktionen und Workspace-Zugriff sind noch nicht final definiert.
- Typ-Wechsel in `organization`: Der Plan beschreibt ihn technisch als machbar, die UI schließt `organization` für manuelle Erstellung aus. Es braucht eine klare Produktentscheidung, ob nicht-default Workspaces überhaupt zu `organization` gewechselt werden dürfen.

## Ursprüngliche Ausgangslage

Vor Start der v4-Umsetzung verwaltete die Canvas Notebook App drei Workspace-Typen (`app/lib/workspaces/types.ts:3`):

- `personal` — genau ein persönlicher Workspace pro User
- `team` — genau ein Team-Workspace pro Organisation
- `project` — Projekt-Workspace (Service + Schema vorhanden, keine API/UI)

Die damalige Logik erzwang "eins pro Scope" über `ensureDefaultWorkspaceRecords` (`app/lib/workspaces/service.ts:230-267`) mit fest codierten Namen (`"Personal Workspace"`, `"Team Workspace"`). Es gab keine API zum Erstellen, Löschen oder Umbenennen von Workspaces (`GET /api/workspaces` war read-only). Der `WorkspaceSwitcher` zeigte nur eine Liste zum Wechseln, ohne Plus-Button. Die Project-Logik in `app/lib/projects/service.ts` war fertig im Service-Layer, aber nicht in API oder UI ausgerollt.

**Permission-Backend vorhanden, UI fehlte:** Die Tabelle `organization_user_permissions` (`migrate.ts:278-305`) mit 11 granularen Rechten existierte bereits. `app/lib/organization/permissions.ts` implementierte `requireOrganizationPermission()` und wird von 30+ API-Routen genutzt. Neu ist die User-Management-UI samt Permission-/Role-APIs.

**Better Auth Organization Plugin nicht aktiviert:** `app/lib/auth.ts:39-43` nutzt nur `admin()`, `bearer()`, `nextCookies()`. Das `04-auth-roles-model.md` plant das Plugin, aber die Entscheidung in v3 ist: **nicht wechseln** (siehe Entscheidung 7).

## Zielbild

- **Vier Workspace-Typen:** `personal`, `organization`, `team`, `project` (neu: `organization` als Default-Org-Workspace für alle Mitglieder; `team` als Unter-Workspace mit eingeschränktem Zugriff).
- Mindestens ein Personal-Workspace pro User und mindestens ein Organisations-Workspace pro Organisation werden erzwingt und als **Standard** markiert.
- Standard-Workspaces dürfen **nicht gelöscht** werden.
- Umbenennen von Workspaces ist **nicht** möglich (bleibt so).
- Nutzer können **weitere** Workspaces vom Typ `personal`, `team` oder `project` anlegen.
- Der `WorkspaceSwitcher` erhält ein **Plus-Button** analog `ChatAgentSelector.tsx` mit Deeplink zu den Workspace-Einstellungen.
- Die Workspace-Verwaltung (Anlegen, Löschen, Zugriff) findet im bestehenden Settings-Tab `workspace` statt — kein neuer Tab.
- Organisations-, Team- und Projekt-Workspaces unterstützen **Mehrbenutzer-Zugriff** (Member-Verwaltung). Personal-Workspaces sind immer Einzelperson.
- Der Workspace-Typ kann nachträglich geändert werden (mit Pfad- und Rechte-Migration).
- **Granulare Permissions** pro User werden im User-Management-Tab editierbar (neue API + UI).
- **Drei Rollen:** `admin`, `member`, `external`. Admins haben Vollzugriff, Members können eingeschränkte Permissions erhalten, Externals werden gesondert behandelt (vorbereitet, nicht final programmiert).
- Permission-Verwaltung findet an **zwei Orten** statt: im User-Management-Tab (pro User, Vollbild-Dialog) und im Workspace-Tab (pro Workspace, Member-Dialog).
- Vollständige Multi-Language-Unterstützung (de/en) via `messages/de.json` und `messages/en.json`.
- Project-Rollout wird im Backend vorbereitet, aber noch nicht für Produktions-Use finalisiert.

## Architekturprinzipien

- **Service-Layer** (`app/lib/workspaces/`, `app/lib/projects/`, `app/lib/organization/`) bleibt die Single Source of Truth.
- **API-Routen** unter `app/api/workspaces/`, `app/api/admin/organization/users/` wrapen die Service-Funktionen mit Auth, License-Check und Validierung.
- **UI** (Switcher, Settings-Panels, Dialoge) bleibt zustandslos gegenüber dem Server — Stores hydratisieren via API und sind die Client-Source-of-Truth.
- **Standard-Markierung** (`is_default`) ist ein Datenbank-Constraint, keine reine UI-Logik.
- **Löschschutz** für Standard-Workspaces wird bereits im Service-Layer erzwungen, nicht erst im UI.
- **Typ-Wechsel** ist eine transaktionale Operation (Pfad-Migration + Rechte-Migration), in eigenem Service gekapselt.
- **Multi-Language:** alle neuen UI-Strings in `messages/de.json` und `messages/en.json`, keine hardcoded UI-Texte.
- **Better Auth Organization Plugin wird nicht aktiviert** — die Canvas-eigene `organization_user_permissions`-Tabelle bleibt die Wahrheit für granulare Permissions. Begründung: Single-Org-Instanz, 11 granulare Felder lassen sich pro-User sauberer pflegen als über Rollen-Statements, 30+ bestehende Guards bleiben unverändert.
- **Edge-Case-Prüfungen** (letzter Admin, letzter Owner, Selbst-Schutz, Bootstrap-Admin) werden serverseitig in den Service-Transaktionen erzwungen, nicht nur im UI.

## Nicht-Ziele

- Umbenennen von Workspaces ermöglichen (bleibt deaktiviert).
- Wechsel auf Better Auth Organization Plugin (bleibt bei Canvas-eigener Permission-Tabelle).
- Eigenständige Project-Verwaltung in der UI (Project-Customer-Rollout kommt später).
- Productions-finaler Project-Workspace-Use — Backend darf vorbereitet werden, UI bleibt hinter Feature-Gate.
- Productions-finaler External-User-Use — Rollen-Modell wird vorbereitet, aber `external` noch nicht voll funktional in der UI.
- Container-Build, ausser er wird explizit angefordert.
- Push, ausser User fordert es explizit oder ein PR wird erstellt/aktualisiert.
- Neue Settings-Route — alles passiert in bestehenden Tabs (`workspace`, `user-management`).

## Arbeitsregeln

- Pro abgeschlossener To-do-Einheit sauber committen.
- Nicht mit dem nächsten To-do weitermachen, wenn das aktuelle nicht verifiziert ist.
- Vor jedem grösseren Schritt `git status --short` prüfen.
- `npm run build` laufen lassen, bevor irgendein Container gebaut würde.
- Dev-Server ausschliesslich auf `localhost:3000` (Port 3001 ist reserviert).
- Keinen neuen Dev-Server starten, wenn auf Port 3000 bereits einer läuft.
- UI- und End-to-End-Prüfungen mit Playwright/Chrome DevTools nur, wenn der User es explizit sagt oder fragt.
- Test-Container bei neuem Testlauf immer mit aktuellem Stand neu laden (recreate/rebuild), nie alte Container weiterverwenden.
- Keine parallelen Test-Container.

---

## Workspace-Typ-Modell (neu in v3)

| Typ | Scope | Zugriff | Default? | Mehrere pro Scope? |
|---|---|---|---|---|
| `personal` | User | Nur Owner | Ja (einer pro User) | Ja (weitere nicht-Default) |
| `organization` | Organisation | Alle aktiven Org-Mitglieder | Ja (einer pro Org) | Nein (genau einer) |
| `team` | Organisation (Unter-Workspace) | Nur explizite Members (`canvas_workspace_members`) | Nein | Ja |
| `project` | Project | Nur `canvas_project_members` | Nein | Ja (eins pro Project) |

**Unterscheidung `organization` vs `team`:**
- `organization`-Workspace = freigegeben für alle aktiven Mitglieder der Organisation (via Org-Membership, keine Workspace-Member-Tabelle nötig). Entspricht dem bisherigen `team`-Workspace.
- `team`-Workspace = Unter-Workspace innerhalb der Organisation mit explizitem Member-Zugriff via neuer Tabelle `canvas_workspace_members`. Nicht alle Org-Mitglieder haben automatisch Zugriff.
- `project`-Workspace = wie bisher, via `canvas_project_members`.

**Migration des bestehenden `team`-Typs:** Der aktuelle `team`-Workspace wird zum `organization`-Workspace (Default, alle Mitglieder haben Zugriff). Neue `team`-Workspaces bekommen eingeschränkten Zugriff.

---

## Strang A — Standard-Workspace erzwingen + schützen

**Status:** umgesetzt. Schema, Migration, `organization`-Typ, Default-Markierung, Löschschutz, Soft-Delete und aktive-Automations-Blocker sind vorhanden. Project-spezifische Default-/Member-Fälle bleiben Teil von Strang F.

### A1. Schema-Erweiterung

**Datei:** `app/lib/db/migrate.ts` (neue Migrationsspalte + neuer Typ + neue Member-Tabelle)

`canvas_workspaces` um Spalte `is_default INTEGER NOT NULL DEFAULT 0` ergänzen. Die Spalte markiert den Standard-Workspace je Typ+Scope.

Partial-Unique-Index pro Scope, damit es genau einen Default gibt:
- Personal: `UNIQUE(type, owner_user_id, is_default) WHERE type='personal' AND is_default=1`
- Organization: `UNIQUE(type, organization_id, is_default) WHERE type='organization' AND is_default=1`
- Project: `UNIQUE(type, project_id, is_default) WHERE type='project' AND is_default=1`

**Typ-Erweiterung:** `WorkspaceType` um `organization` ergänzen (`app/lib/workspaces/types.ts:3`):
```ts
export type WorkspaceType = 'personal' | 'organization' | 'team' | 'project';
```

**Migration bestehender `team`-Workspaces zu `organization`:** Einmaliges `UPDATE canvas_workspaces SET type='organization' WHERE type='team' AND is_default=1`.

**Neue Tabelle `canvas_workspace_members`** für `team`-Workspaces (nicht für `organization` oder `project`):
```sql
CREATE TABLE IF NOT EXISTS canvas_workspace_members (
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  can_read INTEGER NOT NULL DEFAULT 1,
  can_write INTEGER NOT NULL DEFAULT 0,
  can_manage INTEGER NOT NULL DEFAULT 0,
  invited_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id),
  FOREIGN KEY (invited_by_user_id) REFERENCES user(id) ON DELETE SET NULL
);
```

SQLite- und Postgres-kompatibel.

### A2. Service-Layer

**Datei:** `app/lib/workspaces/service.ts`

- `WorkspaceRecord`-Interface um `isDefault: boolean` ergänzen (Zeile 12-24).
- `rowToWorkspaceRecord` mappt `is_default`-Spalte (Zeile 71-85).
- `normalizeWorkspaceType` (Zeile 61-64) um `organization` ergänzen.
- `ensureDefaultWorkspaceRecords` (Zeile 230-267) setzt `is_default = 1` beim Anlegen des Personal- und Organisations-Workspaces (bisher `team` → wird `organization`).
- Beim Anlegen weiterer Workspaces via `insertWorkspace` (Zeile 164-203): `is_default = 0`.
- Neue Funktion `canDeleteWorkspace(record: WorkspaceRecord): boolean`:
  - `record.isDefault === true` → `false` (Standard-Workspaces nicht löschbar)
  - `record.type === 'organization'` → `false` (Org-Workspace nie löschbar, auch nicht-Default)
  - `record.type === 'personal'` → nur Owner darf löschen (`record.ownerUserId === actor.userId`)
  - `record.type === 'team'` → nur Workspace-Manager oder `owner`/`admin`
  - `record.type === 'project'` → nur `owner`/`admin` oder `canManage`
- Neue Funktion `deleteWorkspaceRecord(sqlite, workspaceId, actor)`:
  - Prüft `canDeleteWorkspace` + `permissions.canManageWorkspace`
  - Wenn `is_default === 1` → wirft Error mit Code `WORKSPACE_IS_DEFAULT`
  - Wenn `type === 'organization'` → wirft Error mit Code `WORKSPACE_ORGANIZATION_NOT_DELETABLE`
  - Preflight: prüft auf aktive Automations im Workspace → wirft `WORKSPACE_HAS_AUTOMATIONS` (siehe Strang H, Edge-Case 9)
  - Sonst Soft-Delete via `status = 'disabled'` (kompatibel mit Offboarding `organization/offboarding.ts:188,747` und `recovery_locked`)
  - Löscht keine Dateien physisch (Soft-Delete)
- `workspaceContextFromRecord` (Zeile 373-420) erweitert `WorkspaceContext` um `isDefault`.
- `types.ts:24-38` (`WorkspaceContext`) um `isDefault: boolean` ergänzen.
- `personalWorkspaceRootRelativePath`, `teamWorkspaceRootRelativePath` (Zeile 87-97) um `organizationWorkspaceRootRelativePath(organizationId)` ergänzen: `workspaces/organization/<orgId>/files`.
- `canReadWorkspace` (Zeile 355-371) um `organization`-Typ ergänzen: alle aktiven Org-Mitglieder (status='active', role!='external').
- `resolveWorkspacePermissions` in `permissions.ts` um `organization`-Typ ergänzen: analog `team`, aber alle internen Rollen haben Read, Admin/Owner haben Write.

### A3. API — DELETE

**Datei:** `app/api/workspaces/[id]/route.ts` (neu)

- `DELETE /api/workspaces/[id]`
  - Auth via `auth.api.getSession` + `resolveWorkspaceActor`
  - Lädt Workspace via `resolveWorkspaceContextById` (`service.ts:468-481`)
  - Prüft `permissions.canManageWorkspace`
  - Wenn `isDefault === true` → `409` mit `{ error, code: 'WORKSPACE_IS_DEFAULT' }`
  - Wenn `type === 'organization'` → `409` mit `{ error, code: 'WORKSPACE_ORGANIZATION_NOT_DELETABLE' }`
  - Wenn aktive Automations → `409` mit `{ error, code: 'WORKSPACE_HAS_AUTOMATIONS' }`
  - Sonst `deleteWorkspaceRecord` aufrufen
  - Response: `{ success: true }` oder Fehler-Payload

Kein `PATCH`/`PUT` für Name-Updates — Umbenennen bleibt deaktiviert.

### A4. Switcher-Markierung

**Datei:** `app/components/workspaces/WorkspaceSwitcher.tsx`, `app/lib/workspaces/client-types.ts`, `app/api/workspaces/route.ts`

- `ClientWorkspaceType` um `organization` ergänzen (`client-types.ts:1`).
- `ClientWorkspaceSummary` (`client-types.ts:14-24`) um `isDefault?: boolean` ergänzen.
- `serializeWorkspace` in `app/api/workspaces/route.ts:22-34` um `isDefault: workspace.isDefault` ergänzen.
- `normalizeWorkspace` in `app/store/workspace-store.ts:97-127` mappt `isDefault` + `organization`-Typ.
- `isWorkspaceType` (workspace-store.ts:93-95) um `organization` ergänzen.
- In `WorkspaceSwitcher.tsx`:
  - Badge "Standard" (kleiner Badge mit Star-Icon) neben Default-Workspaces
  - Lock-Icon + Tooltip "Standard-Workspaces können nicht gelöscht werden" bei Default-Workspaces
  - Lock-Icon + Tooltip "Organisations-Workspace kann nicht gelöscht werden" bei `organization`-Typ
  - Reihenfolge: Default-Workspaces zuerst (Sortierung anpassen in `listWorkspaceContextsForUser`, `service.ts:434`)
- `workspace-utils.tsx` um Icon/Label für `organization` ergänzen.

**i18n-Keys** (neu in `messages/de.json` und `messages/en.json` unter `workspaces`):
- `workspaces.badge.default` — "Standard" / "Default"
- `workspaces.badge.cannotDelete` — "Standard-Workspaces können nicht gelöscht werden" / "Default workspaces cannot be deleted"
- `workspaces.badge.organizationNotDeletable` — "Organisations-Workspace kann nicht gelöscht werden" / "Organization workspace cannot be deleted"
- `workspaces.types.organization` — "Organisation" / "Organization"

---

## Strang B — Plus-Button im Workspace-Switcher

**Status:** umgesetzt. Plus-Button, Deeplink in die Workspace-Settings und Auto-Open des Create-Dialogs sind vorhanden.

Vorbild: `app/components/canvas-agent-chat/ChatAgentSelector.tsx:75-87` — Header im Popover mit Liste und Plus-Button rechts, Plus-Button linkt zu `/settings?tab=...&createAgent=1`.

### B1. Switcher erweitern

**Datei:** `app/components/workspaces/WorkspaceSwitcher.tsx`

In jedem Variant (`default`, `compact`, `chat-compact`, `toolbar`, `mobile-sheet`) im Dropdown/Popover/Sheet einen Header einfügen:

- Header-Reihe: Label "Workspaces" (i18n `workspaces.label`) + Plus-Button rechts.
- Plus-Button: `<Link href="/settings?tab=workspace&workspaceManagement=1" />` mit `title`/`aria-label` aus i18n `workspaces.create`.
- Button-Stil exakt wie `ChatAgentSelector.tsx:79-86`: `inline-flex h-7 w-7`, `border border-border bg-background`, `rounded-md`, `Plus`-Icon `h-4 w-4`, `hover:bg-accent`.
- Bei `mobile-sheet`-Variant: Plus-Button in den Sheet-Header legen (analog vorhandenem Pattern im Sheet).
- Plus-Button nur sichtbar für Nutzer mit `canManageWorkspace` oder Admin-Rolle — sonst ausblenden.

**i18n-Keys** (neu):
- `workspaces.create` — "Workspace erstellen" / "Create workspace"
- `workspaces.manage` — "Workspaces verwalten" / "Manage workspaces"

### B2. Deeplink-Target

**Datei:** `app/components/settings/IntegrationsSettingsClient.tsx` (Zeile 2247-2250)

- `?tab=workspace` wird bereits gelesen (Zeile 2250 `effectiveTab`).
- Ergänze Query-Param `workspaceManagement=1`:
  - Wird an `WorkspaceSettingsPanel` durchgereicht (neue Prop `workspaceManagementOpen?: boolean`)
  - Öffnet automatisch den neuen Management-Card (Strang C1) und scrollt/fokussiert ihn
  - Optional Auto-Open des Create-Dialogs, falls zusätzlich `createWorkspace=1` gesetzt

**i18n-Keys** (neu in `settings.workspacePanel.management`):
- Siehe Strang C.

---

## Strang C — Workspace-Management im Settings → Workspace-Tab

**Status:** umgesetzt für Personal-, Team- und Project-Workspaces. Management-Card, Create-Dialog, `POST /api/workspaces` und `DELETE /api/workspaces/[id]` sind vorhanden. `organization` bleibt nicht manuell anlegbar; `project` ist hinter Feature-Gate aktivierbar.

### C1. Management-Card im WorkspaceSettingsPanel

**Datei:** `app/components/settings/WorkspaceSettingsPanel.tsx`

Neuer Abschnitt **"Workspaces verwalten"** (Card), eingefügt vor der Migration-Card (nach Zeile 528, vor Zeile 613):

- Liste alle Workspaces des Nutzers (Personal + Organization + Team + Project) aus `useWorkspaceStore`.
- Pro Zeile:
  - Name (aus `displayName`)
  - Typ-Badge (Personal/Organization/Team/Project) via `renderWorkspaceIcon`/`getWorkspaceKindLabel`
  - **"Standard"-Badge** (wenn `isDefault`) — Badge mit Star-Icon
  - Zugriff-Badge (Read/Write/Manage) — analog `getAccessLabel` im Switcher
  - Löschen-Button (Mülleimer-Icon):
    - **disabled + Tooltip** bei `isDefault` — "Standard-Workspaces können nicht gelöscht werden"
    - **disabled + Tooltip** bei `type === 'organization'` — "Organisations-Workspace kann nicht gelöscht werden"
    - Bei nicht-Default + nicht-Organization: Bestätigungsdialog (`AlertDialog`) → `DELETE /api/workspaces/[id]`
  - "Zugriff verwalten"-Button (nur bei `team`/`project` und `canManageWorkspace`) → öffnet Detail-Dialog (Strang D)
  - "Typ ändern"-Button (nur für `owner`/`admin`, nicht bei Default/Organization) → öffnet Typ-Wechsel-Dialog (Strang E)
- **"Neuen Workspace anlegen"-Button** oben im Card-Header → öffnet `CreateWorkspaceDialog`.
- Kein Rename-Feld (bewusst weglassen).
- Nach Aktionen: `useWorkspaceStore.refreshWorkspaces()` aufrufen.
- Personal-Workspaces für jeden User sichtbar; Organization/Team/Project für Admins.

### C2. Create-Dialog

**Datei:** `app/components/settings/CreateWorkspaceDialog.tsx` (neu)

- Trigger: Button im `WorkspaceSettingsPanel` ("Neuen Workspace anlegen") und ggf. Plus-Button (via Deeplink Auto-Open).
- Felder:
  - **Name** (Pflicht, 1–80 Zeichen, Input)
  - **Typ** (Select, abhängig von Rolle + Team-Features):
    - `personal` — jeder User, nur für sich selbst
    - `team` — nur `owner`/`admin`, erfordert `teamFeaturesEnabled` (Unter-Workspace mit Member-Zugriff)
    - `project` — nur `owner`/`admin`, erfordert vorhandenes Project → Project-Dropdown hinter Feature-Gate
    - `organization` — **nicht wählbar** (wird automatisch beim Bootstrap angelegt, genau einer pro Org)
  - Bei `team`/`project`: Hinweis "Zugriff nach der Erstellung verwalten" (keine Member-Auswahl im Create-Dialog, siehe Strang D).
  - Bei `personal`: Hinweis "Personal-Workspaces sind nur für dich zugänglich."
- Validierung:
  - Name Pflicht, nicht leer
  - Typ-basierte Berechtigungsprüfung client-side (vorab), final server-side in API
- Submit → `POST /api/workspaces` → bei Erfolg `useWorkspaceStore.refreshWorkspaces()` + Dialog schliessen.
- Fehler-Handling: Fehlermeldung im Dialog anzeigen (i18n `settings.workspacePanel.management.errors.*`).

**i18n-Keys** (neu in `settings.workspacePanel.management`):
- `title` — "Workspaces verwalten" / "Manage workspaces"
- `description` — "Workspaces anlegen, löschen und Zugriff verwalten." / "Create, delete, and manage access to workspaces."
- `createWorkspace` — "Neuen Workspace anlegen" / "Create new workspace"
- `fields.name` — "Name" / "Name"
- `fields.type` — "Typ" / "Type"
- `hints.teamProjectAccess` — "Zugriff kann nach der Erstellung verwaltet werden." / "Access can be managed after creation."
- `hints.personalOnly` — "Personal-Workspaces sind nur für dich zugänglich." / "Personal workspaces are only accessible to you."
- `errors.createFailed` — "Workspace konnte nicht erstellt werden" / "Failed to create workspace"
- `errors.deleteFailed` — "Workspace konnte nicht gelöscht werden" / "Failed to delete workspace"
- `errors.isDefault` — "Standard-Workspaces können nicht gelöscht werden" / "Default workspaces cannot be deleted"
- `errors.organizationNotDeletable` — "Organisations-Workspace kann nicht gelöscht werden" / "Organization workspace cannot be deleted"
- `errors.hasAutomations` — "Workspace hat aktive Automations und kann nicht gelöscht werden" / "Workspace has active automations and cannot be deleted"
- `confirmDelete` — "Workspace wirklich löschen? Inhalte werden deaktiviert (Soft-Delete)." / "Really delete workspace? Contents will be disabled (soft-delete)."
- `access.manage` — "Zugriff verwalten" / "Manage access"
- `access.read` — "Lesen" / "Read"
- `access.write` — "Schreiben" / "Write"
- `access.manage` — "Verwalten" / "Manage"
- `typeChange` — "Typ ändern" / "Change type"

### C3. API — POST

**Datei:** `app/api/workspaces/route.ts` (POST ergänzen)

- `POST /api/workspaces`
  - Auth + `resolveWorkspaceActor` + Team-License-Check (`requireTeamRuntimeLicense`) wie GET.
  - Body: `{ name: string, type: 'personal' | 'team' | 'project', projectId?: string }`
  - `type === 'organization'` → `403` (nur via Bootstrap anlegbar, genau einer pro Org)
  - Berechtigungsprüfung:
    - `personal`: jeder User, `ownerUserId = actor.userId`
    - `team`: nur `owner`/`admin` + `teamFeaturesEnabled`
    - `project`: nur `owner`/`admin`, erfordert `projectId` und aktives Project hinter Feature-Gate
  - Validierung:
    - Name: Pflicht, 1–80 Zeichen, kein Pfad-Traversal (`../`, absoluter Pfad, Null-Bytes)
    - Typ-basierte Felder: `personal` → `ownerUserId` aus Session; `team` → `organizationId` aus Bootstrap; `project` → `projectId` Pflicht
  - Root-Pfad pro Typ unique für Mehrfach-Workspaces:
    - Personal: `workspaces/personal/<userId>/<slug>/files` (Slug aus Name via `normalizeSlug`)
    - Team: `workspaces/team/<orgId>/<slug>/files`
    - Project: bleibt `workspaces/project/<projectId>/files` (eins pro Project)
  - Service: `insertWorkspace` (`service.ts:164-203`) wiederverwenden, `is_default = 0`.
  - Response: `{ success: true, workspace: serializeWorkspace(...) }` oder Fehler-Payload.

---

## Strang D — Zugriff-Verwaltung (Members) für Team/Project

**Status:** umgesetzt. Team- und Project-Member-Verwaltung sind für SQLite und Postgres umgesetzt. Project-Members nutzen `canvas_project_members`; Team-Members nutzen `canvas_workspace_members`.

### D1. Konzept

- **Personal:** nur Owner → kein Member-Management, kein Zugriff-UI.
- **Organization:** alle aktiven Org-Mitglieder haben automatisch Zugriff (via Org-Membership). Keine Workspace-Member-Tabelle. Zugriff-Verwaltung = Org-Permission-Verwaltung (Strang G).
- **Team:** Mitglieder via `canvas_workspace_members` (neue Tabelle, Strang A1) mit `can_read`/`can_write`/`can_manage` + Rolle. Nicht alle Org-Mitglieder haben automatisch Zugriff.
- **Project:** Projekt-Mitglieder via `canvas_project_members` (`projects/service.ts:320-375`) mit `can_read`/`can_write`/`can_manage` + Rolle.

Member-Verwaltung erfolgt **nach der Erstellung** im Detail-Dialog (nicht im Create-Dialog), da sauberer und vermeidet, unvollständige Member-States bei fehlgeschlagener Erstellung zu hinterlassen.

### D2. Service-Erweiterung

**Datei:** `app/lib/workspaces/service.ts` (neue Funktionen)

- `upsertTeamWorkspaceMember(sqlite, { organizationId, workspaceId, userId, role, canRead, canWrite, canManage, invitedByUserId })`:
  - Schreibt in `canvas_workspace_members` (Upsert via `ON CONFLICT(workspace_id, user_id)`).
  - Nur aufrufbar für Workspace-Manager oder `owner`/`admin`.
- `listTeamWorkspaceMembers(sqlite, workspaceId)`:
  - Lädt Members aus `canvas_workspace_members` + join mit `user` für Name/Email.
- `removeTeamWorkspaceMember(sqlite, workspaceId, userId)`:
  - DELETE aus `canvas_workspace_members`.
  - Preflight: wenn User einziger Manager (`can_manage=1`) → Block mit `WORKSPACE_LAST_MANAGER` (siehe Strang H, Edge-Case 15).

**Für Project** bereits vorhanden:
- `upsertCanvasProjectMember` (`projects/service.ts:320-375`)
- `getCanvasProjectMember` (`projects/service.ts:377-390`)
- Liste: neue Funktion `listCanvasProjectMembers(sqlite, projectId)` ergänzen.

### D3. API

**Datei:** `app/api/workspaces/[id]/members/route.ts` (neu)

- `GET /api/workspaces/[id]/members`:
  - Auth + `resolveWorkspaceContextById`
  - Prüft `permissions.canManageWorkspace`
  - Bei `personal` → `403` mit `{ error, code: 'WORKSPACE_PERSONAL_NO_MEMBERS' }`
  - Bei `organization` → `403` mit `{ error, code: 'WORKSPACE_ORGANIZATION_MANAGED_VIA_ORG' }` (Hinweis: Zugriff über User-Management-Tab)
  - Bei `team` → `listTeamWorkspaceMembers`
  - Bei `project` → `listCanvasProjectMembers`
  - Response: `{ success: true, members: [...] }`

- `POST /api/workspaces/[id]/members`:
  - Body: `{ userId, role?, canRead?, canWrite?, canManage? }`
  - Auth + `canManageWorkspace`
  - Bei `personal` → `403` (wie oben)
  - Bei `organization` → `403` (wie oben)
  - Bei `team` → `upsertTeamWorkspaceMember`
  - Bei `project` → `upsertCanvasProjectMember`
  - Response: `{ success: true, member: [...] }`

**Datei:** `app/api/workspaces/[id]/members/[userId]/route.ts` (neu)

- `DELETE /api/workspaces/[id]/members/[userId]`:
  - Entfernt Member-Zugriff (bei `team`: `removeTeamWorkspaceMember`; bei `project`: DELETE aus `canvas_project_members`).
  - Bei `personal`/`organization` → `403`.
  - Preflight: letzter Manager-Check (Strang H, Edge-Case 15).

### D4. UI — Member-Verwaltung im Detail-Dialog (Workspace-Tab)

**Datei:** `app/components/settings/WorkspaceMembersDialog.tsx` (neu)

- Trigger: "Zugriff verwalten"-Button in der Workspace-Zeile im `WorkspaceSettingsPanel` (nur bei `team`/`project`).
- Lädt Members via `GET /api/workspaces/[id]/members`.
- Liste der Members mit:
  - Name/Email (aus `authClient.listUsers` oder Member-Liste)
  - Rolle/Rechte (Read/Write/Manage) als Switches (analog `UserManagementPanel.tsx`-Pattern)
  - Entfernen-Button pro Member
- "Member hinzufügen"-Bereich:
  - User-Auswahl (Dropdown/Search aus Org-Usern)
  - Rechte-Vorauswahl (Default: Read)
  - Submit → `POST /api/workspaces/[id]/members`
- Nach Aktionen: Liste neu laden.
- Kein Member-UI im `CreateWorkspaceDialog` (nur Hinweis "Zugriff nach Erstellung verwalten").
- Bei `organization`-Workspace: Hinweis "Zugriff wird über den User-Management-Tab verwaltet" + Link zu `/settings?tab=user-management`.

**i18n-Keys** (neu in `settings.workspacePanel.management.members`):
- `title` — "Zugriff verwalten: {name}" / "Manage access: {name}"
- `addMember` — "Member hinzufügen" / "Add member"
- `selectUser` — "Nutzer auswählen" / "Select user"
- `removeMember` — "Member entfernen" / "Remove member"
- `noMembers` — "Keine Member vorhanden" / "No members"
- `personalNoMembers` — "Personal-Workspaces haben keine Member." / "Personal workspaces have no members."
- `organizationManagedViaOrg` — "Organisations-Workspaces werden über den User-Management-Tab verwaltet." / "Organization workspaces are managed via the User Management tab."
- `roles.member` — "Member" / "Member"
- `roles.admin` — "Admin" / "Admin"
- `roles.external` — "Extern" / "External"
- `errors.lastManager` — "Der letzte Manager kann nicht entfernt werden. Bitte erst einen neuen Manager zuweisen." / "The last manager cannot be removed. Please assign a new manager first."

---

## Strang E — Workspace-Typ ändern

**Status:** umgesetzt für die Zieltypen `personal`, `team` und `project`. `changeWorkspaceType`, `changePostgresWorkspaceTypeForActor`, `PATCH /api/workspaces/[id]` und `WorkspaceTypeChangeDialog` sind vorhanden; `organization` bleibt gesperrt. Die UI aktiviert `project` nur hinter Feature-Gate und mit verfügbarem Project.

### E1. Konzept

Der Workspace-Typ kann nachträglich geändert werden. Hauptkomplikation: der Root-Pfad (`root_relative_path`) ist im Record gespeichert, und abgeleitete Tabellen (`file_revisions`, `workspace_trash_entries`, `knowledge_sources`, `automations`, `todo_items` — alle haben `workspace_id`) referenzieren die Workspace-ID. Bei Typ-Wechsel müssen Dateien physisch verschoben und Rechte migriert werden.

| Wechsel | Machbar | Komplikationen |
|---|---|---|
| personal → organization | Ja | Pfad ändert, Dateien migrieren, alle Org-Mitglieder bekommen Zugriff, `is_default`-Logik (Standard-Personal bleibt) |
| personal → team | Ja | Pfad ändert, Dateien migrieren, Owner wird Manager, `is_default`-Logik |
| personal → project | Ja | Pfad ändert, Project muss existieren, Member setzen, `ownerUserId` → null |
| organization → team | Ja | Pfad ändert, alle Org-Mitglieder verlieren Auto-Zugriff, müssen explizit als Member angelegt werden |
| organization → personal | Ja, kritisch | Pfad ändert, alle Members verlieren Zugriff, nur ein User behält, `ownerUserId` setzen |
| team → organization | Ja | Pfad ändert, `canvas_workspace_members` → alle aktiven Org-Mitglieder bekommen Auto-Zugriff (Member-Tabelle wird geleert) |
| team → personal | Ja, kritisch | Pfad ändert, Members verlieren Zugriff, nur ein User behält |
| team → project | Ja | Pfad ändert, `projectId` setzen, `canvas_workspace_members` → `canvas_project_members` migrieren |
| project → personal | Ja | Pfad ändert, `projectId` → null, `ownerUserId` setzen, Project-Member → Owner |
| project → team | Ja | Pfad ändert, `projectId` → null, `canvas_project_members` → `canvas_workspace_members` migrieren |
| project → organization | Ja | Pfad ändert, `canvas_project_members` → alle aktiven Org-Mitglieder (Member-Tabelle geleert) |

**Einschränkungen:**
- `organization`-Default-Workspace kann nicht Typ-geändert werden (bleibt Organization).
- Personal-Default-Workspace kann nicht Typ-geändert werden (bleibt Personal).

### E2. Service-Funktion

**Datei:** `app/lib/workspaces/service.ts` (neue Funktion)

`changeWorkspaceType(sqlite, params: { workspaceId, newType, newProjectId?, actor })`:
- Lädt Workspace-Record, prüft `canManageWorkspace` + `owner`/`admin`.
- Wenn `record.isDefault && (record.type === 'personal' || record.type === 'organization')` → wirft `WORKSPACE_DEFAULT_TYPE_LOCKED`.
- Validiert neue Rechte (`team` erfordert `teamFeaturesEnabled`; `project` erfordert `projectId`).
- Transaktion + File-Lock:
  1. Neuen Root-Pfad berechnen (`workspaces/<newType>/<scope>/<slug>/files`).
  2. Dateien physisch verschieben (`fs.rename`/`fs.cp` mit Rollback-Pfad).
  3. `root_relative_path` im Record updaten.
  4. `type` updaten; `project_id`/`owner_user_id` anpassen.
  5. Rechte migrieren:
     - → organization: alle aktiven Org-Mitglieder bekommen Auto-Zugriff; `canvas_workspace_members`/`canvas_project_members` für diesen Workspace löschen.
     - → team: Owner wird Manager (`can_manage=1` in `canvas_workspace_members`); andere Members nach Rechte-Migration.
     - → project: `canvas_workspace_members`/`organization_user_permissions` → `canvas_project_members`.
     - → personal: alle Members entfernen, `ownerUserId = actor.userId`.
  6. `is_default`-Logik: wenn alter Workspace Standard war und neuer Typ bereits einen Standard hat → neuer wird nicht-Standard; sonst wird neuer Standard.
  7. Abgeleitete Tabellen (`file_revisions`, `workspace_trash_entries`, etc.) referenzieren `workspace_id`, das bleibt gleich — keine Migration nötig, nur `workspace_type`-Spalten updaten, falls vorhanden.
- Rollback bei Fehler: Dateien zurückverschieben, DB-Transaktion zurückrollen.

### E3. API

**Datei:** `app/api/workspaces/[id]/route.ts` (PATCH ergänzen)

- `PATCH /api/workspaces/[id]` (einziger PATCH-Endpoint, **kein** Name-Update):
  - Body: `{ type: 'personal' | 'organization' | 'team' | 'project', projectId? }`
  - Auth + `canManageWorkspace` + `owner`/`admin`
  - Ruft `changeWorkspaceType` auf
  - Response: `{ success: true, workspace: serializeWorkspace(...) }` oder Fehler-Payload (z.B. `WORKSPACE_TYPE_CHANGE_FAILED`, `WORKSPACE_DEFAULT_TYPE_LOCKED`)

### E4. UI

**Datei:** `app/components/settings/WorkspaceTypeChangeDialog.tsx` (neu)

- Trigger: "Typ ändern"-Aktion in der Workspace-Zeile im `WorkspaceSettingsPanel` (nur für `owner`/`admin`, nicht bei Default/Organization).
- Dialog mit:
  - Aktuellem Typ anzeigen
  - Typ-Select (alle Typen ausser `organization` für nicht-Bootstrap, abhängig von Rolle + Team-Features)
  - Bei `project`: Project-Dropdown
  - Warnhinweis: "Wechsel migriert Dateien und Rechte. Vorgang kann nicht unterbrochen werden." (i18n)
  - Bestätigung mit Typ-Name-Eingabe ("tippe 'WECHSELN' ein") für kritische Wechsel (→ personal, organization → team/personal)
- Submit → `PATCH /api/workspaces/[id]` → `useWorkspaceStore.refreshWorkspaces()`.

**i18n-Keys** (neu in `settings.workspacePanel.management.typeChange`):
- `title` — "Workspace-Typ ändern" / "Change workspace type"
- `currentType` — "Aktueller Typ" / "Current type"
- `newType` — "Neuer Typ" / "New type"
- `warning` — "Der Wechsel migriert Dateien und Rechte. Der Vorgang kann nicht unterbrochen werden." / "Changing the type migrates files and permissions. The process cannot be interrupted."
- `confirmCritical` — "Bestätige mit WECHSELN" / "Confirm with CHANGE"
- `success` — "Typ erfolgreich geändert" / "Type changed successfully"
- `failed` — "Typ-Wechsel fehlgeschlagen" / "Type change failed"
- `defaultLocked` — "Standard-Workspaces können nicht Typ-geändert werden" / "Default workspaces cannot change type"

---

## Strang F — Project-Rollout (Feature-Gate)

**Status:** umgesetzt hinter `CANVAS_PROJECT_FEATURES_ENABLED`. Project-/Customer-APIs, Feature-Gate-Verdrahtung, Project-Dropdowns in Workspace-Erstellung und Typ-Wechsel, Project-Workspace-Erstellung und Project-Member-Management sind vorhanden. Eine eigenständige Project-Verwaltung in der UI bleibt bewusst Nicht-Ziel.

### F1. Backend vorbereiten

Die Service-Funktionen in `app/lib/projects/service.ts` sind bereits vorhanden:
- `createCanvasCustomer` (Zeile 201-241)
- `createCanvasProject` (Zeile 257-304)
- `upsertCanvasProjectMember` (Zeile 320-375)
- `ensureCanvasProjectWorkspace` (Zeile 392-407)

### F2. API (hinter Feature-Gate)

**Datei:** `app/api/projects/route.ts` (neu, hinter Feature-Gate)
- `GET /api/projects` — list Projects (nur für `owner`/`admin`)
- `POST /api/projects` — create via `createCanvasProject`

**Datei:** `app/api/customers/route.ts` (neu, hinter Feature-Gate)
- `GET /api/customers` — list Customers
- `POST /api/customers` — create via `createCanvasCustomer`

Feature-Gate: env `CANVAS_PROJECT_FEATURES_ENABLED`; solange inaktiv, return `404`.

### F3. UI (Workspace-integriert)

- Im `CreateWorkspaceDialog`: Typ `project` nur auswählbar, wenn Project-Feature aktiv (sonst ausgeblendet oder disabled mit Hinweis "Projekt-Workspaces kommen später").
- Keine eigene Project-Verwaltung in der UI in diesem Strang.
- Project-Dropdown im Create-Dialog und Typ-Wechsel-Dialog lädt `/api/projects` und zeigt nur Projects ohne Workspace bzw. beim Typ-Wechsel das aktuell zugeordnete Project.

**i18n-Keys** (neu):
- `settings.workspacePanel.management.projectFeatureNotEnabled` — "Projekt-Workspaces sind noch nicht verfügbar." / "Project workspaces are not yet available."

---

## Strang G — Granulare Permissions im User-Management-Tab (neu in v3)

**Status:** umgesetzt. Die vorhandene `organization_user_permissions`-Tabelle und Guards werden genutzt; User-Permissions-API, Rollen-PATCH-API, `UserPermissionsDialog`, Feature-Gate für `external` und zentrale Mutation-Guards sind vorhanden.

### G1. Konzept

Die Tabelle `organization_user_permissions` (`migrate.ts:278-305`) mit 11 granularen Rechten existiert, wird von 30+ API-Routen via `requireOrganizationPermission` genutzt und ist jetzt im User-Management sichtbar und änderbar.

**Drei Rollen** (vereinfacht vom `04-auth-roles-model.md`):
- `admin` — Vollzugriff auf alle Permissions (Owner ist Admin mit `role='owner'` als Spezialfall, der nicht herabgestuft werden kann).
- `member` — Normaler Nutzer, kann eingeschränkte Permissions erhalten.
- `external` — Externer Nutzer, stark eingeschränkt (vorbereitet, nicht final programmiert — siehe Strang F-Logik: hinter Feature-Gate).

**Permission-Änderung ohne Rollen-Wechsel:** Permissions können unabhängig von der Rolle geändert werden. Ein `member` kann `canWriteTeamWorkspace=1` bekommen, ohne `admin` zu werden.

**Delegation:** Nur Owner/Admins können Permissions vergeben. Admins können nur Permissions vergeben, die sie selbst besitzen; Owner können alle Permissions setzen. Members können keine Permissions mutieren.

### G2. Service-Erweiterung

**Datei:** `app/lib/organization/permissions.ts`

- `getOrganizationUserPermissionDetails(targetUserId, actorUserId?)`:
  - Lädt den User-Permission-Snapshot mit Name/E-Mail und legt fehlende Permission-Zeilen mit Rollen-Defaults an.
- `updateOrganizationPermissions({ targetUserId, permissions, actorUserId })`:
  - Aktualisiert die 11 granularen Felder für einen User.
  - Prüft Edge-Cases: Owner-Schutz, Bootstrap-Admin, archivierte User, External-ohne-Permissions und Delegation.
- `updateOrganizationRole({ targetUserId, role, actorUserId, externalUsersEnabled })`:
  - Ändert die Rolle (`admin`/`member`/`external`).
  - Prüft Edge-Cases: letzter Owner, letzter Admin, Selbst-Schutz, Bootstrap-Admin und External-Feature-Gate.
  - Synchronisiert `user.role` in Better-Auth-Tabelle (für Instanz-Admin-Plugin-Kompatibilität).

### G3. API

**Datei:** `app/api/admin/organization/users/[userId]/permissions/route.ts` (neu)

- `GET /api/admin/organization/users/[userId]/permissions`:
  - Auth + eigener Snapshot immer erlaubt; fremde Snapshots nur für `owner`/`admin`.
  - Response: `{ success: true, user, externalUsersEnabled }`.

- `PATCH /api/admin/organization/users/[userId]/permissions`:
  - Body: `{ canWriteTeamWorkspace?, canCreatePublicLinks?, canCreateTeamAutomations?, canSharePluginsAndSkills?, canExport?, canDeleteTeamFiles?, canDeleteStudioAssets?, canManageBackups?, canMigrateDatabase?, canEnableKnowledge?, canRecoverWorkspaces? }` (alle optional, nur angegebene werden aktualisiert).
  - Auth + `owner`/`admin`.
  - Prüft Edge-Cases (Strang H).
  - Response: `{ success: true, user }` oder Fehler-Payload.

**Datei:** `app/api/admin/organization/users/[userId]/role/route.ts` (neu)

- `PATCH /api/admin/organization/users/[userId]/role`:
  - Body: `{ role: 'admin' | 'member' | 'external' }`.
  - Auth + `owner`/`admin`.
  - Prüft Edge-Cases (Strang H): letzter Owner/Admin, Selbst-Schutz.
  - Synchronisiert `user.role` in Better-Auth.
  - Response: `{ success: true, user, externalUsersEnabled }` oder Fehler-Payload.

### G4. UI — User-Management-Tab mit Permission-Dialog

**Datei:** `app/components/settings/UserManagementPanel.tsx` (erweitern)

- Pro User-Zeile: Button **Rechte** öffnet **Vollbild-Dialog** (`UserPermissionsDialog.tsx`).
- Dialog-Inhalt:
  - User-Info (Name, Email, Rolle, Status, erstellt am)
  - **Rollen-Select** (`admin`/`member`/`external`) — nur für `owner`/`admin` editierbar; `external` hinter Feature-Gate (sonst disabled mit Hinweis).
  - **Granulare Permissions** als Switches (11 Felder):
    - `canWriteTeamWorkspace` — "Team-/Org-Workspace schreiben"
    - `canCreatePublicLinks` — "Public Links erstellen"
    - `canCreateTeamAutomations` — "Team-Automationen erstellen"
    - `canSharePluginsAndSkills` — "Plugins/Skills freigeben"
    - `canExport` — "Exporte ausführen"
    - `canDeleteTeamFiles` — "Team-Dateien löschen"
    - `canDeleteStudioAssets` — "Studio-Assets löschen"
    - `canManageBackups` — "Backups verwalten"
    - `canMigrateDatabase` — "Datenbank-Migration"
    - `canEnableKnowledge` — "Knowledge aktivieren"
    - `canRecoverWorkspaces` — "Recovery-Flow"
  - Speichern-Button → `PATCH /api/admin/organization/users/[userId]/permissions` + ggf. `/role`.
  - Edge-Case-Feedback: Fehler vom Server werden im Dialog angezeigt (z.B. "Letzter Admin kann nicht herabgestuft werden").
- Nach Speichern: User-Liste neu laden.

**Datei:** `app/components/settings/UserPermissionsDialog.tsx` (neu)

- Vollbild-Dialog (Dialog mit `max-w-4xl`, scrollsbar).
- Gruppierte Permissions:
  - **Workspace** — `canWriteTeamWorkspace`, `canDeleteTeamFiles`, `canCreatePublicLinks`
  - **Automations** — `canCreateTeamAutomations`
  - **Plugins/Skills** — `canSharePluginsAndSkills`
  - **Studio** — `canDeleteStudioAssets`
  - **Admin** — `canExport`, `canManageBackups`, `canMigrateDatabase`, `canEnableKnowledge`, `canRecoverWorkspaces`
- Pro Gruppe: Überschrift + Switches mit i18n-Labels.
- Read-only-Modus für non-Admins (nur Anzeige der eigenen Permissions).
- Bei `external`-Rolle: alle Permissions ausgegraut mit Hinweis "Externe Nutzer haben eingeschränkten Zugriff."

**i18n-Keys** (neu in `settings.userManagement.permissions`):
- `title` — "Berechtigungen: {name}" / "Permissions: {name}"
- `role` — "Rolle" / "Role"
- `roles.admin` — "Administrator" / "Administrator"
- `roles.member` — "Mitglied" / "Member"
- `roles.external` — "Extern" / "External"
- `roles.externalDisabled` — "Externe Nutzer sind noch nicht verfügbar." / "External users are not yet available."
- `groups.workspace` — "Workspace" / "Workspace"
- `groups.automations` — "Automationen" / "Automations"
- `groups.plugins` — "Plugins & Skills" / "Plugins & Skills"
- `groups.studio` — "Studio" / "Studio"
- `groups.admin` — "Administration" / "Administration"
- `permissions.canWriteTeamWorkspace` — "Team-/Org-Workspace schreiben" / "Write team/org workspace"
- `permissions.canCreatePublicLinks` — "Public Links erstellen" / "Create public links"
- `permissions.canCreateTeamAutomations` — "Team-Automationen erstellen" / "Create team automations"
- `permissions.canSharePluginsAndSkills` — "Plugins/Skills freigeben" / "Share plugins/skills"
- `permissions.canExport` — "Exporte ausführen" / "Run exports"
- `permissions.canDeleteTeamFiles` — "Team-Dateien löschen" / "Delete team files"
- `permissions.canDeleteStudioAssets` — "Studio-Assets löschen" / "Delete studio assets"
- `permissions.canManageBackups` — "Backups verwalten" / "Manage backups"
- `permissions.canMigrateDatabase` — "Datenbank-Migration" / "Database migration"
- `permissions.canEnableKnowledge` — "Knowledge aktivieren" / "Enable knowledge"
- `permissions.canRecoverWorkspaces` — "Recovery-Flow" / "Recovery flow"
- `errors.lastAdmin` — "Der letzte admin-fähige User kann nicht herabgestuft werden." / "The last admin-capable user cannot be downgraded."
- `errors.lastOwner` — "Der Owner kann nicht herabgestuft oder entfernt werden." / "The owner cannot be downgraded or removed."
- `errors.selfDowngrade` — "Du kannst dich nicht selbst herabstufen." / "You cannot downgrade yourself."
- `errors.selfOffboard` — "Du kannst dich nicht selbst offboarden." / "You cannot offboard yourself."
- `errors.archivedUser` — "Archivierte User können nicht geändert werden." / "Archived users cannot be modified."
- `errors.bootstrapAdmin` — "Der Bootstrap-Admin kann nicht deaktiviert werden." / "The bootstrap admin cannot be disabled."
- `save` — "Speichern" / "Save"
- `saved` — "Berechtigungen gespeichert" / "Permissions saved"

---

## Strang H — Edge-Cases & Invarianten (neu in v3)

**Status:** teilweise umgesetzt. Default-Delete, Organization-Delete, aktive Automations beim Delete, letzter Team-/Project-Workspace-Manager und zentrale Permission-/Role-Mutation-Guards sind serverseitig abgedeckt. Offboarding-Erweiterung, Session-Invalidation und Audit-Log-Zentralisierung sind noch offen.

### H1. Edge-Case-Liste

Alle Prüfungen erfolgen **serverseitig** in den Service-Transaktionen, nicht nur im UI. Das UI zeigt Fehlermeldungen aus den Error-Codes.

| # | Edge-Case | Prüfung | Error-Code |
|---|---|---|---|
| 1 | Letzter Admin-fähiger User | Herabstufung/Entfernung blocken, wenn kein anderer `owner`/`admin` aktiv | `LAST_ADMIN_USER` |
| 2 | Letzter Owner | Owner kann nicht herabgestuft/entfernt werden | `LAST_OWNER` |
| 3 | Selbst-Herabstufung | User kann sich nicht selbst von `admin` auf `member` herabstufen | `SELF_DOWNGRADE` |
| 4 | Selbst-Offboarding | User kann sich nicht selbst offboarden | `SELF_OFFBOARD` |
| 5 | Bootstrap-Admin | Bootstrap-Admin (`BOOTSTRAP_ADMIN_EMAIL`) kann nicht deaktiviert/herabgestuft werden | `BOOTSTRAP_ADMIN_LOCKED` |
| 6 | Archivierte User | Permission-Änderung an archivierten Usern blocken | `USER_ARCHIVED` |
| 7 | Letztes aktives Org-Mitglied | Entfernung blocken, wenn kein anderes aktives Mitglied existiert | `LAST_ORG_MEMBER` |
| 8 | Default-Workspace löschen | Blocken | `WORKSPACE_IS_DEFAULT` |
| 9 | Workspace mit aktiven Automations | Löschen blocken, Preflight zeigt betroffene Automations | `WORKSPACE_HAS_AUTOMATIONS` |
| 10 | Workspace mit aktiven Agent-Sessions | Warnung + Bestätigung im UI (kein Block, aber Hinweis) | — (UI-Warnung) |
| 11 | Permission-Vergabe ohne eigenes Recht | User kann nur Permissions vergeben, die er selbst hat (Delegation) | `PERMISSION_NOT_OWNED` |
| 12 | External-User mit Org-Permissions | External darf keine Org-Permissions erhalten | `EXTERNAL_NO_ORG_PERMISSIONS` |
| 13 | Owner-Transfer auf inaktiven User | Target-User muss aktiv sein | `OWNER_TARGET_INACTIVE` |
| 14 | Session-Cache-Invalidation | Nach Permission-Änderung müssen betroffene Sessions aktualisiert werden (5-Min-Cache in `auth.ts:46`) | — (Service invalidiert Cache) |
| 15 | Team-Workspace ohne Manager nach Entfernung | Wenn User einziger Manager (`can_manage=1`) → Block, Neuzuweisung nötig | `WORKSPACE_LAST_MANAGER` |
| 16 | Concurrent Edits an Permissions | Last-Write-Wins + Audit-Log (kein pessimistischer Lock) | — (Service) |
| 17 | Organisations-Workspace löschen/archivieren | Blocken (Org-Workspace ist nie löschbar) | `WORKSPACE_ORGANIZATION_NOT_DELETABLE` |
| 18 | User aus Organisations-Workspace entfernen | Blocken (Zugriff via Org-Membership, nicht Workspace-Membership) | `WORKSPACE_ORGANIZATION_MANAGED_VIA_ORG` |
| 19 | Default-Workspace Typ ändern | Blocken (Standard-Personal und Standard-Organization behalten Typ) | `WORKSPACE_DEFAULT_TYPE_LOCKED` |

### H2. Service-Implementierung

**Datei:** `app/lib/organization/permissions.ts`, `app/lib/organization/offboarding.ts`, `app/lib/workspaces/service.ts`

- Zentrale Funktion `assertPermissionMutationAllowed(sqlite, { organizationId, targetUserId, actorUserId, mutation })`:
  - Prüft Edge-Cases 1-7, 11-13.
  - Wirft strukturierte Errors mit `code`-Feld.
- Zentrale Funktion `assertWorkspaceDeletionAllowed(sqlite, { workspaceId, actor })`:
  - Prüft Edge-Cases 8, 9, 17.
- Zentrale Funktion `assertWorkspaceMemberRemovalAllowed(sqlite, { workspaceId, userId })`:
  - Prüft Edge-Case 15.
- Zentrale Funktion `assertWorkspaceTypeChangeAllowed(sqlite, { record })`:
  - Prüft Edge-Case 19.
- **Session-Cache-Invalidation** (Edge-Case 14): nach Permission-Änderung wird `auth.api.revokeSession` für betroffene Sessions aufgerufen ODER ein Cache-Invalidation-Event gesendet. Client muss `useWorkspaceStore.refreshWorkspaces()` aufrufen.
- **Audit-Log** (Edge-Case 16): jede Permission-Änderung wird in `audit_events` (`migrate.ts:613`) geloggt mit Actor, Target, geänderten Feldern, altem/nachem Wert.

### H3. Offboarding & Recovery (Antwort auf Frage 6)

**Verhalten beim Offboarding eines Users:**

| Objekt | Verhalten |
|---|---|
| Alle Personal-Workspaces | `recovery_locked` (bestehende Logik auf mehrere Personal-Workspaces erweitern) |
| Organisations-Workspace | Auto-Verlust via `organization_user_permissions.status='archived'` (bestehend) |
| Team-Workspaces (Mitglied) | Entfernung aus `canvas_workspace_members` |
| Team-Workspaces (einziger Manager) | **Preflight-Blocker**: Neuzuweisung an Org-Owner ODER Workspace archivieren |
| Project-Workspaces | Entfernung aus `canvas_project_members` |
| Automations | Pausieren, Verantwortlichen neu zuweisen (bestehend) |
| Public Links | Aktiv lassen, Creator-Badge "orphaned" |
| Aktive Sessions/Agent-Runs | Killen |

**Begründung:** Die Preflight-Logik für "letzter Admin" existiert schon (`UserManagementPanel.tsx` Offboarding-Preflight). Bei Team-Workspaces kommt der neue Fall "einziger Manager" dazu — analog. Wenn der User der einzige Manager eines Team-Workspaces ist, muss vor dem Offboarding entweder ein neuer Manager zugewiesen oder der Workspace archiviert werden. Sonst entsteht ein unzugänglicher Workspace.

**Datei:** `app/lib/organization/offboarding.ts` (erweitern)
- Preflight-Erweiterung: prüfe `canvas_workspace_members` auf `can_manage=1`-Einträge des Target-Users. Wenn einziger Manager eines Team-Workspaces → füge Preflight-Blocker hinzu.
- Apply-Erweiterung: entferne User aus allen `canvas_workspace_members`, setze alle Personal-Workspaces auf `recovery_locked`.

---

## Strang I — UI-Platzierung: zwei Orte für Permission-Verwaltung (Antwort auf Frage 7)

**Status:** umgesetzt. Workspace-zentrisches Team-/Project-Member-Management ist im Workspace-Tab vorhanden. User-zentrische globale Permission-Verwaltung ist im User-Management-Tab über `UserPermissionsDialog` vorhanden.

### I1. Konzept

Permission-Verwaltung findet an **zwei Orten** statt, mit klarer Trennung der Verantwortung:

| Ort | Fokus | Was wird verwaltet |
|---|---|---|
| **User-Management-Tab** (pro User, Vollbild-Dialog) | User-zentrisch | Alle Permissions eines Users, Rolle, Offboarding |
| **Workspace-Tab** (pro Workspace, Member-Dialog) | Workspace-zentrisch | Members eines Team-/Project-Workspaces, deren Rechte an diesem Workspace |

**Vermeidung von Doppel-Verwaltung:**
- User-Tab verwaltet **globale** Permissions (`organization_user_permissions`) und **Rolle**.
- Workspace-Tab verwaltet **workspace-spezifische** Members (`canvas_workspace_members`, `canvas_project_members`).
- Es gibt keine Überschneidung: `organization_user_permissions.canWriteTeamWorkspace` ist eine globale Aussage, `canvas_workspace_members.can_write` ist workspace-spezifisch.

**Quelle der Wahrheit:**
- Globale Permissions → User-Tab ist führend.
- Workspace-Members → Workspace-Tab ist führend.
- Eine Änderung im User-Tab (z.B. Rolle auf `admin`) gibt automatisch Zugriff auf den Organisations-Workspace, aber nicht automatisch auf Team-Workspaces (dafür muss man im Workspace-Tab Member werden).

### I2. User-Management-Tab — Vollbild-Dialog

Siehe Strang G4.

### I3. Workspace-Tab — Member-Dialog

Siehe Strang D4.

---

## Offene Entscheidungen (geklärt in v3)

1. **Mehrfach-Personal/Team-Workspaces:** Erlaubt. Schema lässt es zu (kein Unique auf `type+owner` ausser Default). UI muss beim Anlegen prüfen: existiert schon ein Default? Neuer Workspace wird nicht-Default.
2. **Löschen:** Soft-Delete via `status='disabled'` — kompatibel mit Offboarding & Recovery, keine physische Datei-Löschung.
3. **Typ-Wechsel:** Mit in den Plan aufgenommen (Strang E), inkl. Pfad- und Rechte-Migration, transaktional. Default-Workspaces können nicht Typ-geändert werden.
4. **Project-Rollout:** Hinter Feature-Gate umgesetzt; keine eigenständige Project-Verwaltung in der UI.
5. **Member-UI:** Nach Erstellung im Detail-Dialog (Strang D4), nicht im Create-Dialog.
6. **Multi-Language:** Alle neuen UI-Strings in `messages/de.json` und `messages/en.json`, keine hardcoded UI-Texte.
7. **Better Auth Organization Plugin:** **Nicht wechseln.** Canvas-eigene `organization_user_permissions`-Tabelle bleibt die Wahrheit. Begründung: Single-Org-Instanz, granulare Permissions pro-User sauberer, 30+ bestehende Guards unverändert, Plugin spart hauptsächlich Multi-Org-Features (unbenutzt).
8. **Workspace-Typen:** Vier Typen — `personal`, `organization` (neu, Default-Org-Workspace für alle Mitglieder), `team` (Unter-Workspace mit eingeschränktem Member-Zugriff via `canvas_workspace_members`), `project`. Bisheriger `team`-Typ wird zu `organization` migriert.
9. **Rollen:** Drei Rollen — `admin` (Vollzugriff), `member` (eingeschränkte Permissions möglich), `external` (vorbereitet, nicht final programmiert, hinter Feature-Gate analog Strang F).
10. **Permission-Änderung ohne Rollen-Wechsel:** Möglich. Permissions können unabhängig von der Rolle geändert werden (Strang G).
11. **Edge-Cases:** 19 Edge-Cases identifiziert (Strang H), alle serverseitig erzwungen.
12. **Offboarding & Recovery:** Verhalten für mehrere Personal-Workspaces, Team-Workspaces (einziger Manager = Preflight-Blocker), Project-Workspaces definiert (Strang H3).
13. **UI-Platzierung Permission-Verwaltung:** Zwei Orte — User-Management-Tab (pro User, Vollbild-Dialog, global) + Workspace-Tab (pro Workspace, Member-Dialog, workspace-spezifisch). Klare Trennung, keine Doppel-Verwaltung (Strang I).

---

## Aktuelle Rest-Reihenfolge

Die bereits erledigten Schritte A/B/C und Team-Member-Verwaltung aus D werden nicht erneut angefasst, ausser für Bugfixes aus Review oder Tests.

1. **Review-Branch herstellen** — erledigt: `origin/main` enthält den Revert `c181835e`; `codex/workspace-management` enthält die Workspace-Commits als Cherry-picks.
2. **D abschliessen: Project-Member-Verwaltung** — erledigt: Member-GET/POST/DELETE unterstützt Team- und Project-Workspaces.
3. **E umsetzen: Workspace-Typ-Wechsel** — erledigt für Personal/Team/Project; `organization` bleibt gesperrt.
4. **F umsetzen: Project-Rollout** — erledigt hinter Feature-Gate: Project-/Customer-APIs, Project-Dropdowns, Project-Workspace-Erstellung und Project-Member-Rechte.
5. **G umsetzen: Granulare User-Permissions** — erledigt: Permission-/Role-APIs, `UserPermissionsDialog`, Rolle `external` feature-gated.
6. **H abschliessen: Edge-Cases & Offboarding** — zentrale Permission-Mutation-Guards, Offboarding-Preflight für Team-Manager, mehrere Personal-Workspaces, Session-Invalidation und Audit-Log.
7. **I abschliessen: User-zentrische Permission-UI** — erledigt für User-Management und Workspace-Tab.
8. **Tests erweitern** — API-Tests für Project-Members, Typ-Wechsel, Offboarding-Preflight und restliche Edge-Case-Codes.
9. **UI/E2E-Smoke wiederholen** — erst wenn `localhost:3000` gesund ist; keine neuen Dev-Server auf anderen Ports.

Jeder Strang bleibt einzeln buildbar, testbar und separat commitbar. Vor jedem Container-Build `npm run build` laufen lassen.

---

## Betroffene Dateien (Übersicht)

### Neu / umgesetzt
- `app/api/workspaces/[id]/route.ts` — DELETE und PATCH für Typ-Wechsel umgesetzt
- `app/api/workspaces/[id]/members/route.ts` — GET + POST für Team- und Project-Members umgesetzt
- `app/api/workspaces/[id]/members/[userId]/route.ts` — DELETE für Team- und Project-Members umgesetzt
- `app/api/projects/route.ts` — Project-API (Feature-Gate)
- `app/api/customers/route.ts` — Customer-API (Feature-Gate)
- `app/api/admin/organization/users/[userId]/permissions/route.ts` — GET + PATCH Permissions
- `app/api/admin/organization/users/[userId]/role/route.ts` — PATCH Role
- `app/components/settings/CreateWorkspaceDialog.tsx` — umgesetzt
- `app/components/settings/WorkspaceMembersDialog.tsx` — Team- und Project-Member-Verwaltung umgesetzt
- `app/components/settings/WorkspaceTypeChangeDialog.tsx` — Typ-Wechsel-Dialog mit Project-Auswahl hinter Feature-Gate
- `app/components/settings/UserPermissionsDialog.tsx` — Permission-Verwaltung (User-Tab, Vollbild)

### Neu / noch offen
- keine neuen Dateien für Strang G offen

### Geändert
- `app/lib/db/migrate.ts` — `is_default`-Spalte, `organization`-Typ, `canvas_workspace_members`-Tabelle, Migration `team`→`organization`
- `app/lib/workspaces/types.ts` — `isDefault` in `WorkspaceContext`, `organization` in `WorkspaceType`
- `app/lib/workspaces/service.ts` — Default-Logik, `organization`-Logik, `canDeleteWorkspace`, `deleteWorkspaceRecord`, Team-/Project-Member-Funktionen, `changeWorkspaceType`, `organizationWorkspaceRootRelativePath`
- `app/lib/workspaces/permissions.ts` — `organization`-Typ in `resolveWorkspacePermissions`
- `app/lib/workspaces/client-types.ts` — `isDefault` in `ClientWorkspaceSummary`, `organization` in `ClientWorkspaceType`
- `app/lib/organization/permissions.ts` — `getOrganizationUserPermissionDetails`, `updateOrganizationPermissions`, `updateOrganizationRole`, Permission-Mutation-Guards
- `app/lib/organization/features.ts` — Feature-Gate für `external`-Rolle
- `app/lib/organization/offboarding.ts` — Preflight-Erweiterung (Team-Workspace-Manager), Apply-Erweiterung (canvas_workspace_members, mehrere Personal-Workspaces) offen
- `app/lib/projects/service.ts` — Project-/Customer-Listing ergänzt; Member-Verwaltung läuft im Workspace-Service über `canvas_project_members`
- `app/api/workspaces/route.ts` — POST ergänzen, `serializeWorkspace` um `isDefault`, `organization`-Typ
- `app/store/workspace-store.ts` — `normalizeWorkspace` um `isDefault` + `organization`
- `app/components/workspaces/WorkspaceSwitcher.tsx` — Plus-Button, Standard-Badge, Lock, organization-Typ
- `app/components/workspaces/workspace-utils.tsx` — Icon/Label für `organization`
- `app/components/settings/WorkspaceSettingsPanel.tsx` — Management-Card
- `app/components/settings/UserManagementPanel.tsx` — Rechte-Dialog angebunden; Rollenwechsel nutzt neue Rollen-API
- `app/components/settings/IntegrationsSettingsClient.tsx` — `workspaceManagement`-Query-Param
- `messages/de.json` — neue i18n-Keys
- `messages/en.json` — neue i18n-Keys

### Tests
- `scripts/workspace-model-service-test.ts` — erweitert für `is_default`, `organization`-Typ, Create/Delete, Team-/Project-Member-Funktionen und `changeWorkspaceType`
- `scripts/project-customer-model-test.ts` — Project-/Customer-Listing und Project-Workspace-Erstellung hinter Feature-Gate
- `scripts/organization-permission-guards-test.ts` — Guard- und Mutation-Tests für Permission-/Role-Service
- API-Routen-Tests für DELETE/POST/Members/Permissions/Role/PATCH offen
