# User-Scoped Secrets, Runtime, MCP, Skills und Mail

Stand: 2026-06-17

## Zweck

Dieses Dokument konkretisiert die Credential- und Runtime-Isolation fuer Team-Instanzen. Es ergaenzt die Aufgaben `5`, `16`, `17`, `18`, `19`, `21`, `22`, `27`, `28`, `29`, `31`, `33` und `36` im Aufgabenindex.

Kernregel: Alles, was im Auftrag eines Users ausgefuehrt wird, muss den effektiven `userId`, `organizationId`, `workspaceId`, `sessionId` und optional `agentId` kennen, bevor Secrets, MCP-Server, Skills, Plugins, Mailboxen oder Agent-Runtime-Einstellungen aufgeloest werden. Agent-Tools nutzen dafuer den `AgentExecutionContext` aus `10-agent-tool-execution-policy.md`.

Fresh-Install- und Update-Migrationsablaeufe fuer bestehende globale Env-/MCP-/Skill-/Plugin- und Runtime-Dateien sind in `09-initial-setup-and-update-migration.md` beschrieben. Dieses Dokument definiert den Ziel-Scope; `09` definiert die Migrationsreihenfolge und Review-Zustaende.

## Aktueller Befund

Bereits gute Ausgangslage:

- E-Mail-Accounts, Drafts und lokale OAuth-Flows sind user-scoped.
- E-Mail-Secrets liegen bereits unter einem Pfad mit `userId` und `accountId`.
- SMTP- und Local-Mail-Services laden Accounts ueber `userId` und `accountId`.
- Legacy-E-Mail-Migration wird nur fuer sichere Single-User-Faelle automatisch versucht.

Noch zu schaerfende globale Stellen:

- Integrations- und Agent-ENV liegen aktuell global unter `data/secrets/Canvas-Integrations.env` und `data/secrets/Canvas-Agents.env`.
- MCP-Konfiguration liegt global in `data/settings/mcp.json`.
- MCP-Manager-Verbindungen sind nicht nach `userId` isoliert.
- Skills und Plugins liegen global unter `data/skills` und `data/plugins`.
- Agent-Runtime-Konfiguration und Agent-Dateien liegen global unter `data/settings`, `data/canvas-agent` und `data/agents`.
- Settings-Storage ist generisch und muss pro Setting einem Scope zugeordnet werden.

Diese globalen Stellen duerfen in Team-Instanzen nicht unveraendert als gemeinsame Wahrheit genutzt werden.

## Ziel-Layout unter `/data`

Workspace-Dateien bleiben im Layout aus `07-filesystem-migration-and-write-policy.md`. User-nahe Runtime-, Tool- und Credential-Daten bekommen eigene Roots:

```txt
/data/
  users/
    {userId}/
      settings/
      secrets/
      agents/
      skills/
      plugins/
      mcp/
      mail/
  organizations/
    {organizationId}/
      settings/
      secrets/
      agent-templates/
      skill-templates/
      plugin-templates/
      mcp-templates/
      policies/
  system/
    settings/
    secrets/
    managed/
```

Regeln:

- Pfadsegmente verwenden technische IDs, niemals E-Mail-Adressen, Namen oder Slugs.
- User-Secrets duerfen nicht in Organization-Verzeichnisse verschoben werden.
- Organization-Secrets sind explizit geteilte Ressourcen und niemals automatische Kopien aus User-Secrets.
- System-/Managed-Secrets sind nur fuer Infrastruktur, Lizenz, Provisioning und verwaltete Provider gedacht.
- Migration-Exports muessen Scope-Metadaten speichern und Secrets standardmaessig nur redacted oder als Reconnect-Manifest enthalten.
- Lokale Full Backups fuer Disaster Recovery koennen Secret-/OAuth-State enthalten; in V1 werden lokale Backup-Artefakte nicht automatisch verschluesselt und muessen deshalb Admin-Warnung, restriktive Dateirechte und Audit bekommen.

## Secret Scopes

Es gibt genau drei Secret-Klassen:

| Scope | Beispiel | Sichtbarkeit | Verwendung |
|---|---|---|---|
| `user` | persoenlicher OpenAI-Key, Gmail OAuth, SMTP Passwort, User-MCP Token | nur der User; Admins sehen hoechstens Metadaten | Agenten, Mail, MCP und Plugins im Auftrag dieses Users |
| `organization` | geteilte Team-Integration, Team-Mailbox, Organization-MCP Token | Admins verwalten, berechtigte User nutzen indirekt | explizit geteilte Team-Ressourcen |
| `system/managed` | Control-Plane Instance Token, Managed Provider Proxy | nur System/Admin-Flow, nicht normale User-UI | Provisioning, Lizenz, Monitoring, verwaltete Abrechnung |

Ein Secret Resolver muss immer mit einem serverseitig aufgeloesten Context aufgerufen werden:

```ts
type SecretResolutionContext = {
  userId: string;
  organizationId: string;
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
  purpose: "agent-tool" | "email" | "mcp" | "plugin" | "automation" | "admin";
  requestedSecretRef: string;
};
```

Invarianten:

- Der Client darf niemals rohe Secret-Pfade oder Scope-Roots bestimmen.
- Tool-Calls erhalten nur die konkret erlaubten, kurzlebig aufgeloesten Env-Werte.
- `process.env` darf fuer Agent-/Tool-Ausfuehrungen nur ueber eine explizite Allowlist genutzt werden.
- `NEXT_PUBLIC_*` darf keine Secrets enthalten.
- Geteilte Agenten, Skills und Plugins kopieren keine privaten Secret-Werte.
- Audit speichert Secret-Refs, Scope, Tool, Status und Hash/Metadata, aber nie Secret-Werte.

## Resolver-Reihenfolge

Fuer Agenten, Automations, MCP und Plugins gilt:

1. Server loest den Actor Context aus Session, Gateway oder Automation-Run auf.
2. Server prueft User-, Workspace- und Organization-Permission.
3. Server laedt User-spezifische Tool-/Runtime-Konfiguration.
4. Server wendet Workspace- und Organization-Policies an.
5. Server laedt nur die freigegebenen User- oder Organization-Secrets.
6. Server injiziert System-/Managed-Secrets nur fuer explizit erlaubte Infrastrukturzwecke.

Nicht erlaubt:

- Eine Team-Session darf nicht automatisch private User-Secrets anderer User erhalten.
- Eine Personal-Session darf nicht automatisch Organization-Secrets erhalten.
- Eine Organization-Integration darf nicht als Fallback fuer fehlende User-Credentials genutzt werden, ausser die Integration ist ausdruecklich als Organization-Ressource freigegeben.
- Ein Agent darf bei einem blockierten Secret keinen globalen Fallback verwenden.

## E-Mail und Mailboxen

V1-Regel:

- Jeder User verbindet eigene E-Mail-Konten.
- Senden, Empfangen, Drafts, Reply-Watcher und Mail-Tools laufen immer fuer `userId`.
- Ein `accountId` aus einem anderen User-Scope muss serverseitig wie nicht vorhanden behandelt werden.
- E-Mail-Attachments duerfen nur aus erlaubten Workspace-Reads kommen.
- Agent-Mail-Tools muessen den Actor Context und den verwendeten `emailAccountId` auditieren.

Team-Mailboxen sind spaetere Organization-Ressourcen:

- Sie brauchen eigene `organizationEmailAccount`-Metadaten.
- Nutzung erfordert Rollen- oder explizite Permission.
- Der konkrete sendende User bleibt im Audit sichtbar.
- Team-Mailbox-Secrets liegen im Organization-Secret-Scope, nicht in einem User-Scope.
- Team-Mailboxen duerfen keine private User-Mailbox ersetzen oder als Fallback verwendet werden.

Managed/Gateway-Mail:

- Externe Gateway-Aufrufe muessen vor Mail-Zugriff auf einen internen `userId` gemappt werden.
- Der Gateway darf keine Mailbox ohne User-Mapping oder Organization-Mailbox-Permission verwenden.
- E-Mail-Adressen sind keine Identitaetsquelle fuer Dateisystempfade oder Scope-Entscheidungen.

## MCP

MCP-Server sind in Team-Instanzen user-scoped.

Zielmodell:

- User-MCP-Konfig: `/data/users/{userId}/mcp/config.json`.
- User-MCP-Secrets: `/data/users/{userId}/secrets/mcp/...`.
- Organization-MCP-Templates: `/data/organizations/{organizationId}/mcp-templates/...`.
- System-MCP nur fuer verwaltete Admin-/Infrastruktur-Tools.

Manager-Invarianten:

- Connection Keys enthalten mindestens `organizationId`, `userId`, `serverName` und `configHash`.
- Logs, Caches, OAuth Tokens und Transport-State werden pro User getrennt.
- `envPassthrough` darf nur aus dem aufgeloesten User-/Organization-Secret-Scope stammen.
- Organization-Templates koennen Server vorschlagen oder erlauben, erzeugen aber keine globale aktive User-Verbindung.

## Skills und Plugins

Aktive Skills und Plugins gehoeren standardmaessig dem User.

Zielmodell:

- Installierte User-Skills: `/data/users/{userId}/skills/`.
- Installierte User-Plugins: `/data/users/{userId}/plugins/`.
- User-Konfiguration: `/data/users/{userId}/settings/skills.json` und `plugins.json`.
- Organization-Templates: `/data/organizations/{organizationId}/skill-templates/` und `plugin-templates/`.
- Policies: Allowlist, Blocklist, Version Pins und Sharing-Rechte unter `/data/organizations/{organizationId}/policies/`.

Invarianten:

- Ein User kann nur den eigenen aktiven Tool-Stack ausfuehren.
- Organization-Templates werden kopiert oder aktiviert, aber nicht als global mutable Installation genutzt.
- Plugin-/Skill-Aenderungen sind auditpflichtig, weil sie Agent-Verhalten veraendern.
- Ein geteilter Skill darf keine privaten Credential-Dateien, MCP Tokens oder Mailbox-Konfigurationen mitbringen.
- Admins koennen Freigabe und Blockierung verwalten, aber normale User-Secrets bleiben redacted.

## Agent Runtime und Agent-Definitionen

Agenten brauchen getrennte fachliche und technische Scopes.

Zielmodell:

- User-Agenten: `/data/users/{userId}/agents/{agentId}/`.
- Organization-Agent-Templates: `/data/organizations/{organizationId}/agent-templates/{templateId}/`.
- System-Agent-Defaults: `/data/system/settings/agent-runtime-defaults.json`.

Der Runtime Resolver muss mindestens diese Parameter erhalten:

```ts
type AgentRuntimeResolutionContext = {
  organizationId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  agentId: string;
};
```

Invarianten:

- Neue Sessions speichern `workspaceId`, `agentId`, `userId`, Runtime-Config-Revision und Tool-Stack-Revision.
- Workspace-Wechsel im Chat startet eine neue Session, statt eine laufende Session umzudeuten.
- Geteilte Agent-Templates uebernehmen keine privaten User-Secrets.
- Tool-Ausfuehrungen nutzen die Runtime- und Secret-Aufloesung des ausloesenden Users.
- Runtime-Artefakte duerfen fremde Personal Workspaces nicht lesen oder schreiben.

## Settings UI

Die Settings-Oberflaeche muss Scope sichtbar machen:

- `Meine Integrationen`: User-Secrets, User-MCP, User-Mailboxen, User-Plugins und User-Skills.
- `Organization Integrationen`: nur fuer Admins oder berechtigte Rollen; geteilte Organization-Secrets, Templates und Policies.
- `System/Managed`: nur Admin-/Managed-Kontext; keine normale User-Self-Service-Flaeche.

UI-Regeln:

- Secrets werden nie im Klartext zurueckgegeben.
- Admins sehen bei fremden User-Secrets nur Status, Provider, Owner und letzte Nutzung, nicht den Wert.
- Reconnect-/Rotate-Flows ersetzen Secret-Werte, statt sie zu exportieren.
- Export-UI fuer normale User umfasst nur eigene Personal-Daten und eigene User-Konfiguration, nicht Organization- oder System-Secrets.

## Migration

Bestehende globale Dateien werden nicht automatisch allen Usern zugeschrieben.

Empfohlene Migration:

1. Bestehende globale Mail-Accounts nur in sicheren Single-User-Faellen zu diesem User migrieren.
2. `Canvas-Integrations.env` in ein Admin-Review ueberfuehren: pro Key entscheiden `user`, `organization`, `system/managed` oder `discard`.
3. `Canvas-Agents.env` analog reviewen.
4. Globale MCP-Konfig als Organization-Template importieren, nicht als aktive User-Konfig.
5. Globale Skills/Plugins als Organization-Templates oder Admin-seedbare Defaults importieren.
6. Globale Agenten als Owner-User-Agenten oder Organization-Templates klassifizieren.
7. Alte globale Pfade read-only halten, bis Import/Review abgeschlossen ist.

## Edge Cases

- Offboarding: User-Secrets und OAuth Tokens revoken; User-MCP deaktivieren; User-Automations pausieren, transferieren oder loeschen; Audit-Metadaten behalten. Details stehen in `16-offboarding-and-recovery-policy.md`.
- User-E-Mail-Aenderung: Dateipfade bleiben stabil, weil sie technische `userId` verwenden.
- Secret-Rotation waehrend Agent-Run: bestehende Tool-Calls laufen nicht mit neuem Secret weiter; neue Tool-Calls muessen neu resolven und bei Revocation failen.
- Doppelte MCP-/Plugin-Namen: erlaubt, solange sie in getrennten User-Scopes liegen.
- Organization-Secret geloescht: abhaengige Automations/Agents werden disabled oder verlangen Reconnect, kein User-Secret-Fallback.
- Import in neue Organization: Secrets bleiben redacted; User und Admins muessen Reconnect bestaetigen.
- Backup/Restore: Restore stellt Secret-Metadaten und Full-Backup-State nur innerhalb desselben Scope-Kontexts wieder her oder erzwingt Reconnect. Bei lokal unverschluesselten V1-Backups muss der Admin-Kontext explizit warnen.

## Tests

Pflichttests fuer die Umsetzung:

- User A kann User-B-Secret nicht lesen, aufloesen oder als Tool-Env erhalten.
- User A kann User-B-E-Mail-Account nicht senden, lesen oder als Draft-Ziel verwenden.
- Team-Mailbox ohne Permission wird fuer Senden und Empfangen blockiert.
- MCP-Verbindungen mit gleichem Servernamen bleiben zwischen Usern getrennt.
- Plugin-/Skill-Konfiguration eines Users beeinflusst andere User nicht.
- Geteiltes Agent-Template enthaelt keine privaten Secret-Refs des Erstellers.
- Organization-Secret wird nur bei erlaubtem Organization-Scope injiziert.
- Offboarding revokt User-OAuth und deaktiviert User-MCP/Automations; archivierte Personal Workspaces sind nur ueber Recovery-Flow mit Audit erreichbar.
- Export eines normalen Users enthaelt keine Organization- oder System-Secrets.
- Audit Events speichern Secret-Refs und Tool-Metadaten, aber keine Secret-Werte.
