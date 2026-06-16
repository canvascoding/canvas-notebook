# Canvas Skills and Plugins Architecture

Stand: 2026-06-16

## Zielbild

Canvas Notebook nutzt eigene, produktneutrale Begriffe und Formate:

- **Canvas Skill:** Ein einzelner wiederverwendbarer Agent-Workflow mit `SKILL.md`, optionalen Ressourcen und UI-Metadaten.
- **Canvas Plugin:** Ein installierbares Bundle aus einem oder mehreren Canvas Skills plus optionalen Konnektoren, Store-Metadaten und Assets.
- **Canvas Skill Store:** Eine Registry, aus der Nutzer kuratierte Skills und Plugins installieren oder aktualisieren koennen.

Die Runtime darf intern keine Skill-Modellnamen verwenden, die auf einzelne Anbieter verweisen. Importer fuer fremde Formate koennen spaeter ergaenzt werden, normalisieren aber immer in das Canvas-Modell.

## Canvas Skill Format

Ein Skill bleibt ein Ordner. `SKILL.md` ist weiterhin die fachliche Quelle fuer Agent-Instruktionen.

```text
my-skill/
  SKILL.md
  agents/
    canvas.yaml
  scripts/
  references/
  assets/
```

`SKILL.md` enthaelt nur Trigger- und Arbeitsanweisungen:

```yaml
---
name: my-skill
description: "Use this skill when ..."
license: "MIT"
metadata:
  version: "1.0.0"
---
```

`agents/canvas.yaml` enthaelt UI- und Invocation-Metadaten:

```yaml
interface:
  display_name: "My Skill"
  short_description: "Do one focused job well"
  icon_small: "./assets/icon.png"
  icon_large: "./assets/logo.png"
  brand_color: "#2563EB"
  default_prompt: "Use $my-skill to ..."
```

Alle Felder ausser `display_name` sind optional. Wenn kein Icon existiert oder das Bild nicht geladen werden kann, rendert Canvas Initialen in einem runden Fallback-Icon. `brand_color` faerbt diesen Fallback.

## Canvas Plugin Format

Plugins werden als installierbare Versionen behandelt. Die Plugin-Version ist der primaere Update- und Sharing-Anker; enthaltene Skills erben diese Version, koennen aber optional eigene `metadata.version` tragen.

```text
plugin-name/
  .canvas-plugin/
    plugin.json
  skills/
    skill-a/
      SKILL.md
      agents/canvas.yaml
  .mcp.json
  .composio.json
  assets/
    icon.png
    logo.png
```

Vorgesehenes Manifest:

```json
{
  "name": "plugin-name",
  "version": "1.0.0",
  "description": "What this plugin enables.",
  "license": "MIT",
  "author": {
    "name": "Canvas Studios"
  },
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "composio": "./.composio.json",
  "interface": {
    "displayName": "Plugin Name",
    "shortDescription": "User-facing summary",
    "category": "Productivity",
    "brandColor": "#2563EB",
    "icon": "./assets/icon.png",
    "logo": "./assets/logo.png",
    "defaultPrompt": [
      "Use this plugin for ..."
    ]
  }
}
```

MCP- und Composio-Konfigurationen duerfen keine Secrets enthalten. Sie referenzieren Umgebungsvariablen, die zentral ueber `/data/secrets/Canvas-Integrations.env` verwaltet werden.

## Registry und Installation

Langfristig sollte es ein separates oeffentliches Repository geben, z. B. `canvas-skills`, das nur kuratierte Skill- und Plugin-Pakete enthaelt:

```text
canvas-skills/
  registry.json
  plugins/
    pdf/
      1.0.0/
    google-workspace/
      1.0.0/
  skills/
    standalone-skill/
      1.0.0/
```

`registry.json` listet Name, Version, Beschreibung, Lizenz, Checksums, Download-Pfad, Kategorien und Icon-Metadaten. Canvas Notebook installiert daraus nach:

```text
/data/plugins/installed/<plugin-name>/<version>/
/data/skills/<skill-name>/
```

Standalone Skills bleiben moeglich. Plugin-Skills sollten intern aber ihrem Plugin zugeordnet bleiben, damit Updates, Entfernen und Lizenzinformationen konsistent sind.

## Versionierung

Empfohlenes Modell:

- Plugin-Versionen sind immutable.
- Installierte Pakete bekommen einen Content-Hash ueber alle Dateien.
- Eine lokale Registry speichert `installedVersion`, `enabled`, `source`, `checksum`, `installedAt` und `updatedAt`.
- Updates installieren eine neue Version neben die alte und schalten danach atomar um.
- Nutzerkoepien oder lokale Edits markieren ein Paket als `modified`, damit Updates nicht still lokale Aenderungen ueberschreiben.

## Seed Collection

Canvas Notebook kann eine kleine Seed Collection direkt mitliefern. Beim ersten Start sollten Nutzer auswaehlen koennen, welche Skills oder Plugins installiert und aktiviert werden. Weitere Pakete kommen spaeter aus dem Remote Store.

Seed-Pakete muessen vor dem Veröffentlichen auditierbar sein:

- Lizenz klar und kompatibel
- Quelle/Provenance dokumentiert
- keine kopierten Anbieter-Skills ohne Nutzungsrecht
- keine Secrets oder Token
- Icons/Assets mit passender Lizenz

## Umsetzungsschritte

1. Canvas Skill Runtime auf `CanvasSkill` und `agents/canvas.yaml` normalisieren.
2. UI-Icon-Fallback fuer Skills einfuehren.
3. Seed-Skills mit Canvas-Metadaten ausstatten.
4. Plugin-Manifest-Schema und Validator implementieren.
5. Lokale Plugin-Registry unter `/data/plugins` einfuehren.
6. Plugin-Installer fuer lokale Pakete und Remote Registry bauen.
7. Settings-UI um Plugin Store, Details, Installieren, Update und Entfernen erweitern.
