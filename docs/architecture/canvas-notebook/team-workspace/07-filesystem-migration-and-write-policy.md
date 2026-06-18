# Workspace Filesystem Migration und Write Policy

Stand: 2026-06-17

## Zweck

Dieses Dokument konkretisiert, wie Canvas Notebook von einem globalen `data/workspace` auf getrennte Personal- und Team-Workspaces migriert, wie Workspaces physisch unter `/data` abgelegt werden, welche Exportrechte gelten und wie Agent-/Tool-Schreibzugriffe programmatisch begrenzt werden.

Diese Entscheidung ergaenzt die Aufgaben `10`, `12`, `13`, `15`, `16`, `24`, `27`, `28`, `31`, `33` und `36` im Aufgabenindex.

Fresh-Install- und Update-Migrationsablaeufe werden in `09-initial-setup-and-update-migration.md` verbindlich konkretisiert. Dieses Dokument beschreibt die Zielpfade und Zugriffspolitik; `09` beschreibt, wann und wie sie angelegt oder aus Legacy-Daten befuellt werden.

## Physisches Layout unter `/data`

Die fachliche Wahrheit liegt in der Datenbank. Das Dateisystem ist nur die physische Ablage. Trotzdem braucht die Ablage eine stabile, backup- und debugfreundliche Struktur.

Empfohlenes V1-Layout:

```txt
/data/
  workspaces/
    personal/
      {userId}/
        files/
        trash/
        revisions/
    team/
      {organizationId}/
        files/
        trash/
        revisions/
    projects/
      {projectId}/
        files/
        trash/
        revisions/
  studio/
    assets/
    outputs/
    edits/
  user-uploads/
  backups/
  secrets/
  users/
  organizations/
  system/
```

Regeln:

- `userId`, `organizationId` und `projectId` sind technische IDs, keine E-Mail-Adressen oder Anzeigenamen.
- Workspace-Dateien liegen immer unter einem `files/` Root.
- User-nahe Runtime-, Secret-, MCP-, Skill- und Plugin-Daten liegen nicht unter `workspaces/`, sondern unter den scoped Roots aus `08-user-scoped-secrets-runtime.md`.
- Trash und Revisions liegen unter demselben Workspace-Scope, damit Restore und Export scope-sicher bleiben.
- `data/workspace` bleibt nur Legacy-Quelle oder Legacy-Alias, nicht die fachliche Wahrheit.
- Direkte Pfadannahmen wie `/data/workspace` muessen aus Agent-Prompts, Tool-Implementierungen, File-APIs und Studio-Copy-Flows entfernt werden.

## Datenmodell-Mapping

Jeder Workspace bekommt einen DB-Eintrag.

Pflichtfelder:

- `id`
- `organizationId`
- `type`: `personal` | `team` | `project`
- `ownerUserId`
- `rootRelativePath`
- `displayName`
- `status`: `active` | `archived` | `disabled`
- `createdAt`
- `updatedAt`

Invarianten:

- Ein Personal Workspace hat genau einen `ownerUserId`.
- Ein User darf nur den eigenen Personal Workspace lesen oder schreiben.
- Ein Team Workspace gehoert zur Organization und erfordert Team-Workspace-Permissions.
- Der Server loest Workspace Roots ausschliesslich ueber DB-Metadaten und einen Resolver auf.
- Client-Requests duerfen `workspaceId` uebergeben, aber niemals eigene absolute Roots.

## Migration aus `data/workspace`

Die bestehende Installation hat aktuell einen globalen Workspace. Bei Migration darf dieser nicht unbemerkt zum Team Workspace werden, weil dadurch private Daten teamweit sichtbar werden koennten.

Sicherer Default:

1. Personal Workspaces fuer alle bestehenden User anlegen.
2. Team Workspace fuer Team-/Managed-Lizenzen anlegen, initial leer.
3. Bestehendes `data/workspace` in einen Legacy Import fuer den Bootstrap-/Owner-User migrieren.
4. Der Owner/Admin kann anschliessend explizit Ordner oder Dateien in den Team Workspace kopieren oder verschieben.
5. `data/workspace` bleibt nach erfolgreicher Migration read-only Legacy-Alias oder wird archiviert.

Empfohlener Zielpfad fuer Legacy-Daten:

```txt
/data/workspaces/personal/{ownerUserId}/files/legacy-workspace/
```

Alternative fuer sehr grosse Installationen:

- `data/workspace` bleibt physisch liegen.
- Der Workspace-DB-Eintrag des Owner-Personal-Workspace zeigt zunaechst auf diesen Legacy-Root.
- Eine spaetere Maintenance-Migration verschiebt die Dateien in das neue Layout.

Diese Alternative ist nur zulaessig, wenn der Resolver trotzdem garantiert, dass `data/workspace` nicht als globaler Team-Root interpretiert wird.

Wenn der Owner bei einem Update nicht eindeutig bestimmbar ist, wird kein Workspace-Import gestartet. Die App bleibt in einem Admin-Review-/Maintenance-Zustand, bis ein Owner festgelegt wurde.

## Exportrechte

Export ist eine Berechtigungsfrage, nicht nur ein Download-Button.

Regeln:

- Jeder User darf den eigenen Personal Workspace exportieren.
- Ein User darf keinen fremden Personal Workspace exportieren.
- Team Workspace Export erfordert Organization-Admin oder explizite Export-Permission.
- Vollstaendiger Organization Export inklusive DB, Team Workspace, Team-Metadaten, Audit, Automations und Studio-Metadaten ist admin-only.
- Public Links werden in Migration Exports nicht aktiv exportiert; sie muessen im Zielsystem neu gesetzt werden.
- Full/Admin Export kann Personal Workspaces enthalten, muss aber explizit gewaehlt, gewarnt und auditiert werden.
- Secret-Exports bleiben redacted oder werden als Reconnect-Manifest exportiert.
- Settings-UI fuer normale User zeigt nur Personal-Workspace-Export und eigene Daten.
- Organization-/Team-Export darf nicht in derselben UI-Flaeche wie normaler User-Export erscheinen, sondern braucht Admin-/Security-Kontext.

## Agent Write Policy

Eine Agent-Session hat genau einen Schreib-Workspace.

Pflichtregel:

- Der `session.workspaceId` ist der einzige Workspace, in den Agent-Dateitools schreiben duerfen.

Wenn der Agent versucht, in einen anderen Workspace zu schreiben:

1. Der Tool-Call wird serverseitig abgelehnt.
2. Es wird kein Fallback-Pfad verwendet.
3. Es wird keine Datei teilweise geschrieben.
4. Die Runtime gibt dem Agenten eine klare Policy-Meldung zurueck.

Beispielmeldung:

```txt
Dieser Schreibzugriff wurde blockiert. Diese Session arbeitet im Workspace "{currentWorkspaceName}". Starte eine neue Session im Ziel-Workspace, um dort Dateien zu schreiben.
```

## Cross-Workspace Reads

Lesen und Schreiben werden getrennt behandelt.

V1-Regeln:

- Schreiben ist nur im Session-Workspace erlaubt.
- Lesen aus dem eigenen Personal Workspace ist erlaubt, wenn die Session dort arbeitet.
- Lesen aus dem Team Workspace ist erlaubt, wenn der User Team-Leserechte hat.
- Lesen aus dem Team Workspace waehrend einer Personal-Session ist fuer mehrere explizit referenzierte Dateien oder ausgewaehlte Ordner erlaubt.
- Lesen aus dem eigenen Personal Workspace waehrend einer Team-Session ist fuer mehrere explizit referenzierte Dateien oder ausgewaehlte Ordner erlaubt.
- Automatisches breites Indexing oder Durchsuchen eines anderen Workspace ist nicht erlaubt.
- Lesen oder Schreiben in fremden Personal Workspaces ist immer verboten.
- Shell-/Terminal-Tools duerfen keine Cross-Workspace-Reads ausfuehren.

Der Tool-Layer muss deshalb zwischen `readAllowedWorkspaceIds` und `writeWorkspaceId` unterscheiden.

## Agent File Resolver

Der Resolver muss fuer jeden Dateizugriff einen `WorkspaceFileAccessContext` erhalten.

Pflichtfelder:

- `organizationId`
- `userId`
- `sessionId`
- `agentId`
- `writeWorkspaceId`
- `readAllowedWorkspaceIds`
- `requestedWorkspaceId`
- `relativePath`
- `operation`: `read` | `write` | `delete` | `rename` | `copy` | `list`

Validierung:

- Absolute Pfade aus Agent-Tools werden nicht als Wahrheit akzeptiert.
- Absolute Legacy-Pfade duerfen nur in kompatiblen Migrationsfaellen auf einen bekannten Workspace gemappt werden.
- Nach `realpath` muss das Ziel weiterhin unter dem erlaubten Workspace Root liegen.
- Symlinks, `..`, hardlink-artige Umgehungen und Pfadnormalisierung muessen getestet werden.
- Bei `copy` muss Quelle und Ziel getrennt validiert werden.

## Studio Copy to Workspace

Studio-Outputs bleiben zunaechst im Studio Asset/Output Store. Eine Save-/Copy-Aktion erzeugt eine Datei im Ziel-Workspace.

UI-Anforderung:

- Save-to-Workspace Dialog fuer ein oder mehrere Outputs.
- Der Dialog ist in Team-Instanzen verpflichtend und fragt explizit ab, in welchen Workspace kopiert werden soll.
- Zielauswahl:
  - aktiver Workspace,
  - eigener Personal Workspace,
  - Team Workspace, wenn sichtbar und schreibbar.
- Team-Ziel ist deaktiviert, wenn Lizenz oder Permission fehlt.
- Bei Batch-Auswahl werden Zielordner, Namenskollisionen und gespeicherte Pfade transparent angezeigt.

API-Anforderung:

- Request enthaelt `outputIds`, `targetWorkspaceId`, `targetPath`.
- Server prueft, ob der User die Outputs lesen darf.
- Server prueft, ob der User in den Ziel-Workspace schreiben darf.
- Server schreibt ueber den Workspace Resolver, nicht ueber globale `writeFile(path, ...)`.
- Server speichert `sourceStudioOutputId`, `createdByUserId`, `copiedByUserId`, `workspaceId` und optional `sessionId`.

Nicht erlaubt:

- Save-to-Workspace ohne `targetWorkspaceId` in Team-Instanzen.
- Speichern in fremden Personal Workspace.
- Speichern in Team Workspace ohne `canWriteTeamWorkspace`.

## Umsetzungsgates

Vor produktivem Team Workspace muessen diese Gates erfuellt sein:

1. Workspace-Tabelle und Workspace Resolver existieren.
2. Physische Roots werden nur ueber Workspace-Metadaten aufgeloest.
3. `data/workspace` ist Legacy und wird nicht mehr als globaler Runtime-Root genutzt.
4. File-API nimmt `workspaceId` oder serverseitig aufgeloesten aktiven Workspace.
5. Agent-Sessions speichern `workspaceId`.
6. Agent-Tools trennen Read-Allowlist und Write-Workspace.
7. Studio Save-to-Workspace verlangt einen Ziel-Workspace.
8. Personal Workspace Export ist user-self-service; Team-/Organization-Export ist admin/permission-gated.
9. Secret-, MCP-, Skill-/Plugin- und Agent-Runtime-Pfade werden ueber User-/Organization-/System-Resolver aufgeloest, nicht ueber globale Settings-Dateien.

## Tests

Pflichttests:

- User A kann User-B-Personal-Workspace nicht lesen.
- User A kann User-B-Personal-Workspace nicht schreiben.
- Personal-Session kann nicht in Team Workspace schreiben.
- Team-Session kann nicht in Personal Workspace schreiben.
- Cross-Workspace Read ist nur fuer explizite, berechtigte Referenzen erlaubt.
- Agent-Tool blockiert absolute Pfade ausserhalb des Workspace Roots.
- Symlink-/`..`-Traversal wird blockiert.
- Studio Batch Save fragt Ziel-Workspace ab.
- Studio Save in Team Workspace ohne Permission wird blockiert.
- Normaler User sieht keinen Organization-Export.
- Admin/Export-Permission ist fuer Team-/Organization-Export erforderlich.
