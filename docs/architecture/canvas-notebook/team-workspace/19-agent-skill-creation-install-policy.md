# Agent Skill Creation and Install Policy

Stand: 2026-07-08

## Zweck

Dieses Dokument konkretisiert, wie Nutzer und Agenten eigene Canvas Skills erstellen, bearbeiten oder aus dem Chat-Workspace installieren duerfen, ohne die generische Agent-Dateisandbox fuer `/data/users/{userId}/skills` zu oeffnen. Es konkretisiert ausserdem den Zielpfad fuer zentral von Admins bereitgestellte Organization Skills.

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

Bestehende Skills werden ebenfalls nicht direkt im Runtime-Verzeichnis editiert. Sie werden ueber einen Paket-Update-Flow geaendert: aktuelles Paket inspizieren, Version und Checksum pinnen, Aenderung validieren, Diff anzeigen, Paketversion aktualisieren, Registry atomar aktualisieren.

Ein Canvas Skill ist dabei immer ein Paketordner. `SKILL.md` ist nur der verpflichtende Einstiegspunkt. Zum Paket gehoeren auch `agents/canvas.yaml`, `scripts/`, `references/`, `assets/`, Beispiele, Testdaten und optional ausfuehrbare Code-Dateien. Create-, Edit-, Fork- und Publish-Flows muessen deshalb den kompletten Ordnerinhalt als Einheit behandeln.

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

## Existing Skill Editing

Bearbeiten ist nach Skill-Klasse unterschiedlich:

| Skill-Klasse | Bearbeitung |
|---|---|
| Core/System | nicht editierbar; Nutzer koennen einen neuen Personal oder Organization Skill mit anderem Namen erstellen |
| Personal Local | direkt editierbar ueber validierten Update-Flow mit erwarteter Version und Checksum |
| Organization Shared | nicht in-place editierbar; Admin veroeffentlicht eine neue Version und aktualisiert die Policy |
| Marketplace Standalone | standardmaessig read-only; Anpassung erzeugt Personal Fork oder explizites Detach vom Marketplace-Updatepfad |
| Plugin-managed | nicht einzeln editierbar; Plugin aktualisieren oder Skill als Personal/Organization Fork kopieren |

Grundregeln:

- Der primaere Edit-Flow arbeitet mit einem vollstaendigen Skill-Paketordner oder Archiv, nicht nur mit `SKILL.md`.
- Jeder Edit startet mit `inspect_canvas_skill`, damit Agent und UI die aktuelle Checksum, Quelle, Editierbarkeit und aktive Version kennen.
- Fuer groessere Aenderungen wird das komplette Skill-Paket in einen Workspace-Draft ausgecheckt, dort mit normalen Workspace-Dateitools bearbeitet und danach als Ganzes wieder importiert.
- Jeder schreibende Edit braucht `expectedVersion` und `expectedChecksum`.
- Das Zielpaket muss eine neue oder explizit bestaetigte Paketversion enthalten.
- Der Server validiert immer das komplette Ergebnis, nicht nur den Patch.
- Organization Updates erzeugen eine neue Version, statt die vorhandene Version in-place zu veraendern.
- Registry und `skills.json` werden atomar aktualisiert.
- Der Tool-Output zeigt einen Diff der geaenderten Textdateien und eine Zusammenfassung von hinzugefuegten, entfernten oder geaenderten Assets, Referenzen und Scripts.
- Wenn der Skill gerade im laufenden Agent-Turn verwendet wurde, gilt die Aenderung erst fuer den naechsten Prompt-Aufbau.
- Rollback ist kein V1-Produktfeature. Die Version und Checksum schuetzen gegen Vermischung und verlorene Updates; alte Versionen werden nur fuer Organization Skills explizit als versionierte Pakete behalten.

Code- und Script-Dateien:

- Skill-Pakete duerfen Code-Dateien enthalten, z. B. `.js`, `.ts`, `.py`, `.sh` oder Hilfsdaten.
- Der Import oder Update-Flow fuehrt diese Dateien niemals aus.
- Zur Laufzeit duerfen Scripts nur ueber vorhandene erlaubte Agent-Tools, deren Sandbox und deren Env-/Secret-Regeln ausgefuehrt werden.
- Datei-Modi muessen sicher normalisiert werden. Ausfuehrbare Bits koennen fuer normale Dateien erhalten oder gezielt gesetzt werden; SUID/SGID, Devices, FIFOs, Hardlinks und unsichere Symlinks sind abzulehnen.
- Symlinks werden fuer V1 entweder abgelehnt oder beim Import sicher dereferenziert, solange das Ziel innerhalb des Pakets liegt. Kein Paket darf ueber Links aus seinem Skill-Root ausbrechen.
- `.env`, OAuth-Tokens, private Keys und andere Secret-Dateien duerfen nicht automatisch in Skills kopiert werden.

## Version Number Policy

V1 nutzt eine einfache Paketversionsnummer statt einer komplexen Rollback- oder History-Funktion.

Kanonische Quellen:

```yaml
# agents/canvas.yaml
skill:
  version: "1.2.0"
interface:
  display_name: "Example Skill"
```

Rueckwaertskompatibel bleibt auch die bestehende Frontmatter-Quelle:

```yaml
---
name: example-skill
description: "Example"
metadata:
  version: "1.2.0"
---
```

Regeln:

- Neue und bearbeitete Skills muessen eine Version tragen.
- Wenn `SKILL.md` und `agents/canvas.yaml` beide eine Version enthalten, muessen sie identisch sein.
- Die Registry speichert die aufgeloeste Version zusammen mit der Paket-Checksum.
- Personal Skill Updates muessen `expectedVersion` und `expectedChecksum` pruefen.
- Organization Skill Updates erzeugen einen neuen versionierten Paketordner.
- Eine Update-Operation darf nicht mehrere Skill-Namen oder mehrere Versionen in einem Paket vermischen.

Empfohlener Agent-Ablauf fuer Personal Skills:

1. `inspect_canvas_skill({ name })` aufrufen.
2. Wenn `editable` false ist, Fork-Option erklaeren.
3. `create_canvas_skill_draft` mit `sourceSkillName` ausfuehren.
4. Den kompletten Draft-Ordner im Workspace bearbeiten.
5. `update_canvas_skill_from_workspace` mit `expectedVersion` und `expectedChecksum` ausfuehren.
6. Ergebnis mit neuer Version, neuer Checksum, geloeschtem Draft-Pfad und Nutzungszeitpunkt melden.

Empfohlener Admin-Ablauf fuer Organization Skills:

1. `inspect_canvas_skill({ name, scope: "organization" })` aufrufen.
2. Aenderung als neue Version vorbereiten.
3. `publish_canvas_skill_to_organization` mit `expectedVersion` und `expectedChecksum` ausfuehren.
4. Policy auf `optional`, `default-enabled` oder `required` setzen.
5. Nutzer-Forks unveraendert lassen und Konflikte sichtbar machen.

## Tool Surface V1

### `inspect_canvas_skill`

Liest Skill-Metadaten und optional bearbeitbare Textdateien.

Parameter:

```ts
{
  name: string;
  scope?: "personal" | "organization";
  includeContent?: boolean; // default false
}
```

Regeln:

- gibt `sourceType`, `scope`, `editable`, `editableReason`, `checksum`, `version`, `enabled`, `pathSummary` und `interface` zurueck,
- liefert Version, Checksum und Paketstruktur; Dateien werden ueber `create_canvas_skill_draft` als Workspace-Draft bearbeitet,
- Core- und Plugin-managed Skills duerfen inspiziert, aber nicht als editierbar gemeldet werden,
- Organization Skills duerfen normale Nutzer nur lesen, wenn die Policy sie fuer ihre Rolle freigibt.

### `create_canvas_skill_draft`

Erzeugt einen temporaeren Skill-Draft im aktuellen Chat-Workspace. Fuer neue Skills wird ein minimales Paket mit `SKILL.md` und `agents/canvas.yaml` angelegt. Fuer bestehende Personal Skills wird der komplette Skill-Ordner als bearbeitbarer Draft kopiert.

Parameter:

```ts
{
  skillName: string;
  description?: string;     // new-skill draft
  version?: string;         // new-skill draft, default 1.0.0
  sourceSkillName?: string; // edit/fork draft
  draftId?: string;
  overwrite?: boolean;
}
```

Regeln:

- kopiert den kompletten Paketordner inklusive `SKILL.md`, `agents/`, `scripts/`, `references/`, `assets/` und Beispieldateien,
- schreibt nur in den aktuellen Chat-Workspace,
- gibt bei Edit-Drafts `expectedVersion` und `expectedChecksum` aus,
- Core- und Plugin-managed Skills werden nicht direkt kopiert; dafuer bleibt ein separater Fork-Flow noetig,
- kopiert keine bekannten Secret-Dateien in den Draft,
- gibt den Workspace-Pfad zurueck, damit Agent oder UI normale File-Tools fuer beliebige Paketdateien nutzen koennen.

### Draft Storage und Cleanup

Aktueller technischer Stand:

- Generische Agent-Dateitools duerfen mit aktivem `AgentExecutionContext` nur in den aktuellen Chat-Workspace schreiben.
- `/data/temp/skills` wird beim Containerstart angelegt, ist aber fuer generische Agent-Dateitools nicht als Schreibroot freigegeben.
- Ein Temp-Verzeichnis ausserhalb des Workspace kann deshalb nur durch dedizierte serverseitige Skill-Tools beschrieben werden, nicht durch `write`, `edit_file`, `copy_path`, `bash` oder Shell-Redirects.

V1-Entscheidung:

- Skill-Drafts werden unter einem versteckten Workspace-Pfad wie `.canvas-skill-drafts/{draftId}/` angelegt.
- Der Pfad wird im Tool-Output klar als temporaer markiert.
- `install_canvas_skill_from_workspace` und `update_canvas_skill_from_workspace` bekommen `cleanupDraft?: boolean` mit Default `true`.
- Nach erfolgreichem Install/Update loescht das Tool den Draft-Ordner aus dem Workspace.
- Bei einem Fehler bleibt der Draft erhalten, damit der Agent oder Nutzer ihn korrigieren kann.
- `discard_canvas_skill_draft` loescht abgebrochene Drafts explizit.

V2-Option:

- Dedizierte Skill-Draft-Tools koennen spaeter `/data/temp/skills/{userId}/{sessionId}/{draftId}` nutzen.
- Diese Tools muessen eigene Read/Write/Delete-Operationen fuer Draft-Dateien anbieten, weil generische File-Tools dort weiter keinen Zugriff bekommen sollen.
- Auch serverseitige Temp-Drafts muessen TTL-Cleanup und explizites Discard bekommen.

Die separate Dry-run-Validierung und direkte Text-Erstellung sind in Personal V1 keine eigenen Tools. V1 validiert innerhalb von `install_canvas_skill_from_workspace` und `update_canvas_skill_from_workspace`; neue Skills werden zuerst als Draft mit `create_canvas_skill_draft` erzeugt und danach installiert.

### `install_canvas_skill_from_workspace`

Installation eines im Workspace gestagten vollstaendigen Skill-Pakets.

Parameter:

```ts
{
  draftPath: string;  // workspace-relative folder containing one skill package
  enable?: boolean;   // default true
  cleanupDraft?: boolean; // default true for .canvas-skill-drafts paths
}
```

Regeln:

- der Tool-Call darf nur aus dem aktuellen Workspace lesen,
- Folder-Quellen werden mit denselben Ignorierregeln behandelt wie Uploads (`.git`, `node_modules`, `.DS_Store`),
- der gesamte Paketordner wird kopiert, inklusive Scripts, Referenzen, Assets und Beispiele,
- das Paket muss eine Version ueber `agents/canvas.yaml` `skill.version` oder kompatibel ueber `SKILL.md` `metadata.version` deklarieren,
- das Tool darf keine vorhandenen Skills ersetzen,
- bei `cleanupDraft !== false` und einer Quelle unter `.canvas-skill-drafts/` wird der Draft nach erfolgreicher Installation geloescht.

### `update_canvas_skill_from_workspace`

Aktualisiert einen bestehenden Personal Local Skill aus einem vollstaendigen Workspace-Paket.

Parameter:

```ts
{
  skillName: string;
  expectedVersion: string;
  expectedChecksum: string;
  draftPath: string;  // workspace-relative folder containing one skill package
  enable?: boolean;
  cleanupDraft?: boolean; // default true
}
```

Regeln:

- Quelle muss im aktuellen Chat-Workspace liegen,
- das Paket darf nur genau einen Skill enthalten,
- der gesamte Zielordner ersetzt nach erfolgreicher Validierung atomar das bisherige Skill-Paket,
- `expectedVersion` und `expectedChecksum` muessen aus `inspect_canvas_skill` stammen,
- Asset-, Script-, Reference- und Beispiel-Aenderungen werden als Zusammenfassung ausgegeben,
- bei `cleanupDraft !== false` wird der Workspace-Draft nach erfolgreichem Update geloescht.

### `discard_canvas_skill_draft`

Loescht einen temporaeren Skill-Draft aus dem Chat-Workspace.

Parameter:

```ts
{
  draftPath: string;
}
```

Regeln:

- `path` muss unter `.canvas-skill-drafts/` im aktuellen Workspace liegen,
- geloescht wird nur der Draft-Ordner, nie der installierte Skill,
- geeignet fuer abgebrochene Skill-Erstellungen oder -Bearbeitungen.

### Future: `fork_canvas_skill`

Erzeugt eine bearbeitbare Kopie eines nicht editierbaren Skills.

Parameter:

```ts
{
  sourceName: string;
  targetName: string;
  targetScope?: "personal" | "organization";
}
```

Regeln:

- `targetScope: "personal"` ist fuer normale Nutzer mit `canCreatePersonalSkills` erlaubt,
- `targetScope: "organization"` ist nur fuer Admin/Skill-Manager erlaubt,
- Forks muessen einen eindeutigen Namen bekommen und duerfen Core-Namen nicht verwenden,
- Forks kopieren den kompletten Paketordner, nicht nur `SKILL.md`,
- Registry-Record speichert `forkedFrom` mit Quelle, Version und Checksum.

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
  expectedVersion?: string;
  expectedChecksum?: string;
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

Nicht editierbare Skills werden nicht "entsperrt". Sie werden per Fork oder, bei Organization Skills, per neuer Version angepasst.

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
- Updates muessen mit erwarteter Checksum/Version gegen verlorene Updates geschuetzt sein.
- Ein fehlgeschlagenes Update darf die bestehende aktive Skill-Version nicht veraendern.
- Der gesamte Skill-Ordner ist die atomare Einheit fuer Version, Checksum und Update.

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
2. Mit `create_canvas_skill_draft` einen temporaeren Draft unter `.canvas-skill-drafts/` erzeugen.
3. Bei Bedarf den kompletten Paketordner mit normalen Workspace-Dateitools bearbeiten.
4. Bei explizitem Nutzerauftrag `install_canvas_skill_from_workspace` ausfuehren.
5. Ergebnis im Chat melden: Skill-Name, Status, Aktivierung, naechster Nutzungszeitpunkt.

Der Agent muss nicht und darf nicht versuchen, `/data/users/.../skills` direkt zu beschreiben.

## Implementierungsplan

### 1. Service-Schicht

Neue Datei:

- `app/lib/skills/agent-skill-workspace.ts`

Aufgaben:

- Workspace-Pfade ueber `AgentExecutionContext.workspaceRoot` aufloesen.
- Workspace-Quellen auf den aktiven Chat-Workspace begrenzen.
- Folder-Quellen rekursiv sammeln, mit Dateianzahl-/Bytes-Limits.
- Folder-Quellen in `SkillPackageImportSource` normalisieren.
- komplette Paketordner inklusive Scripts, Assets, References, Beispielen und Dateimodus-Metadaten sicher importieren.
- Paketversion aus `agents/canvas.yaml` oder kompatibel aus `SKILL.md` pruefen.
- Install-Funktionen als schmale Adapter um `importSkillPackage()` implementieren.

Die bestehende `skill-package-import.ts` bleibt die Quelle fuer Install-Regeln.

### 2. Runtime-Tools

`app/lib/pi/tool-registry.ts` erweitert `createUserScopedTools()` um:

- `inspect_canvas_skill`
- `create_canvas_skill_draft`
- `install_canvas_skill_from_workspace`
- `update_canvas_skill_from_workspace`
- `discard_canvas_skill_draft`

Tool-Gruppe:

- neue Gruppe `Skills` fuer Metadaten und Settings-Anzeige.

Default:

- Tools sollten standardmaessig verfuegbar sein, weil Core Skills wie `skill-creator` sie brauchen.
- Die eigentliche Installation bleibt trotzdem serverseitig permission-gated.

### 3. Audit

Erfolg und Fehler werden als eigene Audit-Events erfasst:

- `eventType: "agent"`
- `entityType: "skill"`
- `action: "skill.inspect" | "skill.create_draft" | "skill.install_from_workspace" | "skill.update_from_workspace" | "skill.discard_draft"`
- `entityId: skillName`
- Metadaten: `sourceKind`, `sourcePath`, `enabled`, `previousVersion`, `version`, `previousChecksum`, `checksum`, `draftPath`, `draftCleaned`, `workspaceId`, `sessionId`, `agentId`.

Nicht auditieren:

- komplette `SKILL.md`-Inhalte,
- grosse Dateien,
- Secret-Werte,
- raw Upload-Inhalte.

### 4. UX und Fehlermeldungen

Tool-Fehler muessen handlungsleitend sein:

- fehlende Permission: auf Settings/Permissions bzw. Plugin-/Skill-Freigabe verweisen,
- invalides Frontmatter oder fehlende Version: konkrete Validierungsfehler zurueckgeben,
- Skill existiert bereits: auf `inspect_canvas_skill` plus `create_canvas_skill_draft`/`update_canvas_skill_from_workspace` verweisen,
- Core-Skill-Name: klar sagen, dass Built-in/Core Skills nicht ersetzt werden koennen,
- nicht editierbare Quelle: Fork- oder Admin-Update-Flow als spaeteren Ausbau anbieten,
- Checksum-Konflikt: erneutes Inspect verlangen und kein Update schreiben,
- Workspace-Pfad ausserhalb Scope: klar sagen, dass nur Chat-Workspace-Quellen installierbar sind.

## Tests

Pflichttests fuer die Umsetzung:

- `create_canvas_skill_draft` erzeugt neuen Draft mit `SKILL.md` und `agents/canvas.yaml`.
- `install_canvas_skill_from_workspace` installiert Folder-Paket mit `agents/canvas.yaml` und Assets.
- `install_canvas_skill_from_workspace` installiert komplette Paketordner mit `scripts/`, `references/`, `assets/` und Beispieldateien.
- Registry-Record und `settings/skills.json` werden geschrieben.
- Skill ist nach erneutem Laden ueber `loadSkillsFromDisk(..., { userId })` sichtbar und enabled.
- `inspect_canvas_skill` meldet Quelle, Editierbarkeit und Checksum korrekt.
- `create_canvas_skill_draft` kopiert einen kompletten Skill inklusive Scripts, References und Assets in einen Workspace-Draft.
- `update_canvas_skill_from_workspace` kann Scripts, References, Assets und Beispiele hinzufuegen, aendern und entfernen.
- `update_canvas_skill_from_workspace` lehnt stale `expectedChecksum` ohne Aenderung ab.
- `update_canvas_skill_from_workspace` lehnt stale `expectedVersion` ohne Aenderung ab.
- `update_canvas_skill_from_workspace` lehnt Core-, Plugin-managed- und Marketplace-Skills mit Fork-Hinweis ab.
- der Import fuehrt enthaltene Scripts nicht aus.
- unsichere Symlinks und bekannte Secret-Dateien im Paket werden abgelehnt.
- erfolgreiche Install-/Update-Tools loeschen Workspace-Drafts standardmaessig.
- fehlgeschlagene Install-/Update-Tools lassen Workspace-Drafts zur Korrektur bestehen.
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
- bestehende Personal Skills ueber einen Version-/Checksum-Flow bearbeitet werden koennen,
- der komplette Skill-Ordner inklusive Scripts, Assets, References und Beispielen erstellt, geforkt und aktualisiert werden kann,
- temporaere Skill-Drafts nach erfolgreichem Install/Update aus dem Workspace entfernt werden,
- die generischen File-Tools weiterhin keine `/data/users/.../skills`-Writes erlauben,
- Core- und Plugin-Skill-Schutz unveraendert greifen,
- der Agent im Chat korrekt erklaert, dass der Skill ab dem naechsten Prompt-Aufbau nutzbar ist.
