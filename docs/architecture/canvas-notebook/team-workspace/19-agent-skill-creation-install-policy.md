# Agent Skill Creation and Install Policy

Stand: 2026-07-08

## Zweck

Dieses Dokument konkretisiert, wie Nutzer und Agenten eigene Canvas Skills erstellen oder aus dem Chat-Workspace installieren duerfen, ohne die generische Agent-Dateisandbox fuer `/data/users/{userId}/skills` zu oeffnen. Es konkretisiert ausserdem den Zielpfad fuer zentral von Admins bereitgestellte Organization Skills.

Es ergaenzt `08-user-scoped-secrets-runtime.md` und `10-agent-tool-execution-policy.md`.

## Ausgangsfall

Ein Agent sollte aus hochgeladenen Inhalten einen neuen Skill wie `reel-skript-writer` erstellen. Dabei traten mehrere erwartbare Blockaden auf:

- `ls` und direkte Reads auf `/data/users/.../skills/...` wurden ausserhalb des Chat-Workspace blockiert.
- direkte Writes nach `/data/users/.../skills/reel-skript-writer/SKILL.md` wurden blockiert.
- `bash mkdir`, Shell-Redirects und andere direkte Shell-Mutationen wurden blockiert.
- als Fallback entstanden Dateien nur im Chat-Workspace, nicht im echten Runtime-Skill-Verzeichnis.
- der lokale Skill-Registry-Eintrag unter `registry.json` fehlte.

Die Blockaden sind grundsaetzlich richtig. Die Luecke ist nicht fehlender Dateisystemzugriff, sondern ein fehlendes dediziertes Agent-Tool fuer validierte Skill-Installation.

## Bestehende Bausteine

Die Codebasis hat bereits die zentrale Import-Pipeline:

- `app/lib/skills/skill-package-import.ts`
  - importiert Text, ZIP/Archive und Folder-Payloads,
  - validiert genau eine `SKILL.md`,
  - prueft YAML-Frontmatter,
  - schuetzt Core-Skill-Namen,
  - schuetzt gegen Plugin-Skill-Konflikte,
  - schreibt den lokalen Skill-Registry-Record,
  - aktiviert den Skill in `settings/skills.json`.
- `app/api/skills/upload/route.ts`
  - nutzt dieselbe Pipeline fuer UI-Uploads,
  - prueft `canSharePluginsAndSkills`.
- `app/lib/pi/agent-file-operations.ts`
  - begrenzt generische Datei-Mutationen bewusst auf den Session-Workspace.
- `app/lib/pi/tool-registry.ts`
  - ist der richtige Ort fuer ein user-scoped Agent-Tool, das in den `AgentExecutionContext` eingewickelt wird.
- `app/lib/skills/core-skills.ts` und `app/lib/skills/core-skill-loader.ts`
  - definieren Core Skills, die immer verfuegbar sind und nicht installiert, geloescht oder ueberschrieben werden duerfen.

Die neue Funktion soll diese Bausteine verwenden, nicht duplizieren.

## Grundentscheidung

Agenten bekommen keinen freien Schreibzugriff auf `/data/users/{userId}/skills`.

Stattdessen gibt es einen validierenden Skill-Install-Pfad:

1. Der Agent entwirft oder sammelt Skill-Dateien im normalen Chat-Workspace.
2. Ein dediziertes Agent-Tool liest diesen Workspace-Entwurf oder nimmt `SKILL.md` direkt als Text entgegen.
3. Der Server validiert Paket, User, Permission, Skill-Namen und Konflikte.
4. Der Server installiert ueber `importSkillPackage()` in den User-Scope.
5. Der Server schreibt Registry, aktiviert den Skill und auditiert die Aktion.

Damit bleibt die allgemeine Workspace-Sandbox streng, waehrend Skill-Erstellung als Produktfunktion moeglich wird.

## Skill Scopes

Canvas unterscheidet vier Skill-Klassen:

| Klasse | Besitzer | Speicherort | Editierbar durch Nutzer | Zweck |
|---|---|---|---|---|
| Core/System | App-Image | App-Bundle | nein | immer verfuegbare Basisfunktionen wie `create-plugin`, `skill-creator`, `find-skills` |
| Personal Local | einzelner User | `/data/users/{userId}/skills/` | ja, bei Permission | eigene wiederverwendbare Workflows |
| Organization Shared | Organization/Admin | `/data/organizations/{organizationId}/skill-templates/` oder spaeter `/skills/` | nur Admin/Skill-Manager | zentral gepflegte Skills fuer mehrere Nutzer |
| Marketplace | Registry-Publisher | remote Registry, lokal installiert | nicht direkt | kuratierte, versionierte Pakete |

Wichtig: Ein "VM-weiter" Skill ist in Team- und Managed-Instanzen fachlich ein Organization Skill. Der alte globale Pfad `/data/skills` bleibt nur fuer Legacy-, Seed- und Single-User-Fallbacks relevant und darf nicht als neuer Shared-Mutable-Scope fuer Teams ausgebaut werden.

## Personal Skill Creation

Nutzer sollen eigene Skills erstellen koennen, ohne einen Admin bitten zu muessen, sofern die Organization-Policy das erlaubt.

Ziel-Permissions:

- `canCreatePersonalSkills`: eigene lokale Skills erstellen, bearbeiten, deaktivieren und loeschen.
- `canPublishOrganizationSkills`: Skills als Organization Shared Skill bereitstellen oder aktualisieren.
- `canManageSkillPolicies`: Skills verpflichtend machen, blockieren, Default-Aktivierung setzen oder Marketplace-Quellen verwalten.

Aktueller Kompatibilitaetspfad:

- Solange diese feineren Rechte noch nicht im Schema existieren, mappt die Implementierung auf `canSharePluginsAndSkills`.
- Owner/Admin bekommen diese Rechte standardmaessig.
- Members koennen spaeter gezielt `canCreatePersonalSkills` bekommen, ohne Organization-Skills publizieren zu duerfen.

Persoenliche Skills bleiben im User-Scope. Andere Nutzer sehen sie nicht und koennen sie nicht ausfuehren, solange sie nicht als Organization Skill veroeffentlicht oder in ein Plugin/Marketplace-Paket ueberfuehrt werden.

## Organization Shared Skills

Ein Admin soll einen zentralen Skill fuer die Organization bereitstellen koennen, damit mehrere Nutzer denselben gepflegten Workflow verwenden.

Zielmodell:

```txt
/data/organizations/{organizationId}/skill-templates/{skillName}/{version}/
  SKILL.md
  agents/canvas.yaml
  assets/
/data/organizations/{organizationId}/settings/skill-policies.json
```

Policy-Felder pro Organization Skill:

```ts
{
  name: string;
  version: string;
  source: "admin-upload" | "marketplace" | "promoted-user-skill";
  availability: "optional" | "default-enabled" | "required" | "blocked";
  allowedRoles?: Array<"owner" | "admin" | "member" | "external">;
  checksum: string;
}
```

Regeln:

- Admins und explizite Skill-Manager koennen Organization Skills erstellen, aktualisieren, deaktivieren und entfernen.
- Normale Nutzer koennen Organization Skills nutzen, aber nicht direkt veraendern.
- Optionale Organization Skills duerfen Nutzer aktivieren oder deaktivieren.
- `default-enabled` aktiviert den Skill fuer Nutzer standardmaessig, erlaubt aber persoenliches Deaktivieren.
- `required` macht den Skill fuer passende Rollen immer verfuegbar und nicht deaktivierbar.
- Ein Nutzer kann einen Organization Skill als persoenliche Kopie forken, wenn Anpassungen noetig sind. Diese Kopie bekommt einen neuen Namen oder eine eindeutige personal Fork-ID.
- Updates laufen versioniert und auditierbar. Laufende Agent-Turns behalten die alte Tool-Stack-Revision; neue Turns sehen die neue Version.

Namenskonflikte:

- Core-Skill-Namen sind gesperrt.
- Ein Organization Skill darf keinen aktiven Skill-Namen still ueberschatten.
- Wenn ein User bereits einen Personal Skill mit demselben Namen hat, zeigt die UI einen Konflikt und bietet Rename/Fork/Disable an. Es gibt keine stille Praezedenzregel.
- Plugin-managed Skills duerfen nicht durch Organization Skills ersetzt werden, solange das Plugin aktiv ist.

Secrets:

- Organization Skills enthalten keine Secret-Werte.
- Skills duerfen benoetigte Secret-Refs oder Env-Namen dokumentieren.
- Zur Laufzeit werden Secrets weiterhin ueber User-/Organization-Secret-Resolver und Tool-Permissions aufgeloest.

Runtime-Aufloesung:

1. Core Skills laden und immer aktiv halten.
2. Organization Skill Policies fuer den User und seine Rolle laden.
3. Personal Skills des Users laden.
4. Marketplace-/Plugin-Skills des Users laden.
5. Konflikte blockieren oder in der UI sichtbar machen, statt still zu ueberschreiben.

Diese Reihenfolge ist eine Policy-Reihenfolge, keine Erlaubnis zum Ueberschreiben. Ein Name darf am Ende nur einmal im aktiven Skill-Set vorkommen.

## Tool Surface V1

### `validate_canvas_skill_package`

Dry-run ohne persistente Aenderung.

Parameter:

```ts
{
  path?: string;       // workspace-relative folder, SKILL.md, .zip or .skill
  skillMd?: string;    // raw SKILL.md content
}
```

Regeln:

- genau eine Quelle ist erforderlich,
- `path` muss im aktuellen `AgentExecutionContext.workspaceRoot` liegen,
- die Validierung nutzt dieselben Limits und Frontmatter-Regeln wie `importSkillPackage`,
- Ergebnis enthaelt `skillName`, `validation`, `sourceKind`, `detectedFiles`, aber keinen Registry-Write.

### `create_canvas_skill`

Direkte Erstellung aus generiertem `SKILL.md`-Text.

Parameter:

```ts
{
  skillMd: string;
  canvasInterfaceYaml?: string;
  enable?: boolean; // default true
}
```

Regeln:

- fuer Faelle, in denen ein Agent aus Upload-/Chat-Inhalt sofort eine saubere `SKILL.md` erzeugt,
- optionales `agents/canvas.yaml` wird als zweite Datei in die Folder-Quelle aufgenommen,
- intern wird daraus eine `SkillPackageImportSource` mit `kind: "folder"` oder `kind: "text"`,
- `sourcePath` im Registry-Record soll `agent-generated:SKILL.md` oder `agent-generated:<skillName>` sein.

### `install_canvas_skill_from_workspace`

Installation eines im Workspace gestagten Skill-Pakets.

Parameter:

```ts
{
  path: string;       // workspace-relative folder, SKILL.md, .zip or .skill
  enable?: boolean;   // default true
}
```

Regeln:

- der Tool-Call darf nur aus dem aktuellen Workspace lesen,
- Folder-Quellen werden mit denselben Ignorierregeln behandelt wie Uploads (`.git`, `node_modules`, `.DS_Store`),
- ZIP-Quellen laufen ueber denselben Archive-Importer,
- Registry `sourcePath` soll `agent-workspace:<relativePath>` enthalten,
- das Tool darf keine vorhandenen Skills ersetzen.

### `publish_canvas_skill_to_organization` (V2)

Admin-Flow fuer zentral geteilte Skills.

Parameter:

```ts
{
  path?: string;
  skillMd?: string;
  canvasInterfaceYaml?: string;
  availability?: "optional" | "default-enabled" | "required";
  allowedRoles?: string[];
}
```

Regeln:

- erfordert `canPublishOrganizationSkills` oder bis zur Permission-Aufteilung `canSharePluginsAndSkills` plus Admin/Owner-Rolle,
- installiert in den Organization-Scope, nicht in den User-Scope,
- schreibt Organization Skill Policy und Audit,
- ersetzt nur eine vorhandene Organization-Skill-Version, wenn Checksum/Version/Expected-Revision passt,
- veraendert keine bestehenden Personal Forks.

## Nicht in V1

Nicht in diesen ersten Schritt gehoeren:

- generischer Write-/Copy-/Move-Zugriff auf `/data/users/{userId}/skills`,
- direkte Bearbeitung von `registry.json`,
- automatisches Publizieren in `canvas-notebook-plugin-marketplace`,
- stilles Ersetzen existierender Standalone- oder Plugin-Skills,
- Installation in Organization-/System-Scope im Personal-V1-Tool,
- sofortige Prompt-Erweiterung im bereits laufenden Modell-Call.

Bestehende Skills zu aktualisieren ist ein separater V2-Flow. Er braucht mindestens erwarteten Checksum-Vergleich, Backup, Diff, explizite Bestaetigung und Audit.

## Permission und Scope

Jeder installierende Personal-Tool-Call muss:

- `userId` aus `AgentExecutionContext` oder dem user-scoped Tool-Build verwenden,
- `assertUserOrganizationPermission(userId, "canSharePluginsAndSkills")` ausfuehren,
- `scope: { userId }` an die Skill-Pipeline uebergeben,
- `updatedBy` mit User-ID oder E-Mail fuellen, wenn verfuegbar,
- bei fehlender Permission einen klaren Fehler liefern.

Workspace-Write-Rechte (`canWrite`) sind nicht ausreichend und nicht zwingend erforderlich. Skill-Installation veraendert den User-Toolstack und wird deshalb ueber Skill-Permissions gesteuert. In V1 ist das `canSharePluginsAndSkills`; Ziel ist die feinere Trennung zwischen persoenlicher Skill-Erstellung und Organization-Publishing.

## Sicherheitsregeln

Der neue Pfad darf diese Invarianten nicht aufweichen:

- Core Skills duerfen nicht installiert, geloescht, deaktiviert oder durch lokale Skills ueberschattet werden.
- Plugin-managed Skills duerfen nicht durch Agent-Install ersetzt werden.
- Ein Paket darf nur genau eine `SKILL.md` enthalten.
- Pfade in Archiven oder Folder-Uploads duerfen keine Traversal-Segmente enthalten.
- Paketgroesse, Dateianzahl und extrahierte Gesamtgroesse folgen den bestehenden Import-Limits.
- Secret-Dateien, OAuth-Tokens, `.env`-Dateien und MCP-Konfigurationen duerfen nicht automatisch in Skills kopiert werden.
- Tool-Ausgaben duerfen Skill-Inhalt zusammenfassen, aber keine fremden Secrets oder komplette grosse Payloads auditieren.

## Registry und Runtime-Verhalten

Installierte Agent-Skills bleiben lokale User-Skills:

```txt
/data/users/{userId}/skills/{skillName}/
  SKILL.md
  agents/canvas.yaml
  ...
/data/users/{userId}/skills/registry.json
/data/users/{userId}/settings/skills.json
```

Registry-Regeln:

- `sourceType` bleibt `local`.
- `sourcePath` zeigt die Agent-Quelle (`agent-generated:*` oder `agent-workspace:*`).
- `checksum`, `installDir`, `skillPath` und `interface` werden wie bei UI-Uploads gesetzt.
- der Skill wird standardmaessig aktiviert.

Prompt-/Runtime-Regel:

- Der neue Skill ist fuer neue Agent-Turns verfuegbar, sobald die Skill-Liste neu geladen wird.
- Der laufende LLM-Call kennt den frisch installierten Skill nicht automatisch in seinem bisherigen Prompt.
- Tool-Output muss deshalb explizit melden: "Installiert und aktiviert; nutzbar ab dem naechsten Agent-Run bzw. nach neuem Prompt-Aufbau."

## Ablauf fuer den Ausgangsfall

Zielablauf fuer einen Agenten, der aus Upload-Inhalt einen Skill erstellt:

1. Upload oder Chat-Inhalt mit normalen Read-/Attachment-Funktionen auswerten.
2. `SKILL.md` und optional `agents/canvas.yaml` im Arbeitsspeicher erzeugen oder im Workspace als Entwurf speichern.
3. `validate_canvas_skill_package` ausfuehren.
4. Bei validem Ergebnis und explizitem Nutzerauftrag `create_canvas_skill` oder `install_canvas_skill_from_workspace` ausfuehren.
5. Ergebnis im Chat melden: Skill-Name, Status, Aktivierung, naechster Nutzungszeitpunkt.

Der Agent muss nicht und darf nicht versuchen, `/data/users/.../skills` direkt zu beschreiben.

## Implementierungsplan

### 1. Service-Schicht

Neue Datei:

- `app/lib/skills/agent-skill-installer.ts`

Aufgaben:

- Workspace-Pfade ueber `resolveAgentPath()` und `AgentExecutionContext.workspaceRoot` aufloesen.
- Read-Only-Pfadpruefung fuer Workspace-Quellen anwenden.
- Folder-Quellen rekursiv sammeln, mit Dateianzahl-/Bytes-Limits.
- `SKILL.md`-, Folder- und Archive-Quellen in `SkillPackageImportSource` normalisieren.
- Dry-run-Validierung bereitstellen, ohne Registry/Settings zu schreiben.
- Install-Funktionen als schmale Adapter um `importSkillPackage()` implementieren.

Die bestehende `skill-package-import.ts` bleibt die Quelle fuer Install-Regeln. Falls Dry-run noch interne Funktionen braucht, sollten kleine gemeinsame Validatoren aus `skill-package-import.ts` exportiert werden, statt eine zweite Validierung zu bauen.

### 2. Runtime-Tools

`app/lib/pi/tool-registry.ts` erweitert `createUserScopedTools()` um:

- `validate_canvas_skill_package`
- `create_canvas_skill`
- `install_canvas_skill_from_workspace`

Tool-Gruppe:

- neue Gruppe `Skills` fuer Metadaten und Settings-Anzeige.

Default:

- Tools sollten standardmaessig verfuegbar sein, weil Core Skills wie `skill-creator` sie brauchen.
- Die eigentliche Installation bleibt trotzdem serverseitig permission-gated.

### 3. Audit

Erfolg und Fehler werden als eigene Audit-Events erfasst:

- `eventType: "agent"`
- `entityType: "skill"`
- `action: "agent_skill.validate" | "agent_skill.install"`
- `entityId: skillName`
- Metadaten: `sourceKind`, `sourcePath`, `enabled`, `checksum`, `workspaceId`, `sessionId`, `agentId`.

Nicht auditieren:

- komplette `SKILL.md`-Inhalte,
- grosse Dateien,
- Secret-Werte,
- raw Upload-Inhalte.

### 4. UX und Fehlermeldungen

Tool-Fehler muessen handlungsleitend sein:

- fehlende Permission: auf Settings/Permissions bzw. Plugin-/Skill-Freigabe verweisen,
- invalides Frontmatter: konkrete Validierungsfehler zurueckgeben,
- Skill existiert bereits: auf Skill-Editor oder spaeteren Update-Flow verweisen,
- Core-Skill-Name: klar sagen, dass Built-in/Core Skills nicht ersetzt werden koennen,
- Workspace-Pfad ausserhalb Scope: klar sagen, dass nur Chat-Workspace-Quellen installierbar sind.

## Tests

Pflichttests fuer die Umsetzung:

- `create_canvas_skill` installiert aus `SKILL.md`-Text unter `/data/users/{userId}/skills/{name}`.
- `install_canvas_skill_from_workspace` installiert Folder-Paket mit `agents/canvas.yaml` und Assets.
- Registry-Record und `settings/skills.json` werden geschrieben.
- Skill ist nach erneutem Laden ueber `loadSkillsFromDisk(..., { userId })` sichtbar und enabled.
- Core-Skill-Namen werden abgelehnt.
- bestehender Standalone-Skill wird nicht ueberschrieben.
- Plugin-managed Skill wird nicht ueberschrieben.
- Workspace-Pfad ausserhalb `workspaceRoot` wird abgelehnt.
- Archive mit mehreren `SKILL.md` werden abgelehnt.
- User ohne `canSharePluginsAndSkills` bekommt einen Permission-Fehler.
- Tool-Metadaten zeigen die Skills-Gruppe und die Install-Tools.

Geeignete Testdateien:

- `scripts/agent-skill-installer-test.ts`
- Erweiterung von `scripts/skill-package-import-test.ts` fuer exportierte Dry-run-Validatoren.
- Erweiterung von `scripts/pi-tool-registry-test.ts` fuer Tool-Registrierung und blockierte Pfade.

Verifikation:

- `npm run test:skills:core`
- `npm run test:skills:store`
- `npm run test:pi:tools`
- neuer `agent-skill-installer-test`
- `npm run lint`
- `npm run build`

UI-/E2E-Pruefung ist nur noetig, wenn zusaetzliche sichtbare Settings- oder Chat-UI geaendert wird. Bei reiner Tool-/Service-Implementierung reichen Service- und Tool-Registry-Tests.

## Beziehung zum Marketplace

Agent-erstellte Skills werden nicht automatisch Marketplace-Pakete.

- Marketplace-Quellen bleiben kuratierte, versionierte Registries.
- Lokale Agent-Skills sind `sourceType: "local"`.
- Eine spaetere Publish-Funktion muss einen getrennten Review-/Packaging-Flow fuer `canvas-notebook-plugin-marketplace` verwenden.
- Der lokale Install-Flow darf keine Remote-Registry-Dateien schreiben.

## Akzeptanzkriterien

Der Ausgangsfall gilt als geloest, wenn ein Agent aus Chat-/Upload-Inhalt einen neuen Skill erzeugen kann und danach:

- der Skill im User-Skill-Verzeichnis liegt,
- die lokale Skill-Registry einen korrekten Eintrag hat,
- der Skill aktiviert ist,
- die generischen File-Tools weiterhin keine `/data/users/.../skills`-Writes erlauben,
- Core- und Plugin-Skill-Schutz unveraendert greifen,
- der Agent im Chat korrekt erklaert, dass der Skill ab dem naechsten Prompt-Aufbau nutzbar ist.
