# Canvas Skills and Plugins Architecture

Stand: 2026-06-16

## Implementierter Stand

Die Canvas-Skill-Runtime und die lokale Canvas-Plugin-Runtime sind implementiert.

- Skills werden aus `/data/skills` und aktivierten Plugin-Paketen geladen.
- Plugins werden unter `/data/plugins/installed/<plugin-name>/<version>/` installiert.
- Die lokale Plugin-Registry liegt unter `/data/plugins/registry.json`.
- Plugin-Skills bleiben im Plugin-Paket und werden nicht nach `/data/skills` kopiert.
- Plugin-Skills erhalten ein `plugin`-Mapping im Skill-Modell, damit Runtime, UI und spaetere Chat-Referenzen den Ursprung kennen.
- Skill- und Plugin-Assets werden ueber authentifizierte Asset-Endpunkte ausgeliefert.
- Der Chat-Composer nutzt `/` als gemeinsamen Picker fuer Plugins und Skills. Aktive Plugins werden zuerst angezeigt, danach aktive Skills.
- Referenzierte Plugins werden im Composer und in der Chat-History mit Plugin-Icon oder Initialen-Fallback gerendert.
- Wenn ein Nutzer `/plugin-name` referenziert, erzeugt die Agent-Runtime fuer diesen Turn einen Canvas-Kontextblock mit Pluginbeschreibung, gebuendelten Skills und Connector-Hinweisen.
- MCP- und Composio-Angaben werden als Metadaten gespeichert, enthalten aber keine Secrets und werden noch nicht automatisch in Connector-Konfigurationen geschrieben.

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
  "connectors": {
    "mcpServers": "./.mcp.json",
    "composio": ["google-drive"]
  },
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

`registry.json` listet Name, Version, Beschreibung, Lizenz, Checksums, Download-Pfad, Kategorien und Icon-Metadaten. Canvas Notebook installiert lokale Plugin-Pakete nach:

```text
/data/plugins/installed/<plugin-name>/<version>/
/data/plugins/registry.json
```

Standalone Skills bleiben moeglich. Plugin-Skills bleiben intern ihrem Plugin zugeordnet, damit Updates, Entfernen und Lizenzinformationen konsistent sind.

## Lokale API

Die lokale Runtime stellt diese authentifizierten Endpunkte bereit:

- `GET /api/plugins` — installierte Plugins listen
- `GET /api/plugins/[name]` — Plugin-Details lesen
- `POST /api/plugins/validate` — lokales Plugin-Paket validieren (`sourcePath`)
- `POST /api/plugins/install` — lokales Plugin-Paket installieren (`sourcePath`, optional `enable`, `replace`)
- `POST /api/plugins/[name]/enable` — Plugin aktivieren
- `POST /api/plugins/[name]/disable` — Plugin deaktivieren
- `DELETE /api/plugins/[name]` — Plugin entfernen
- `GET /api/plugins/asset?plugin=<name>&path=<relative-image-path>` — Plugin-Bilder laden

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
4. Plugin-Manifest-Schema und Validator implementieren. ✅
5. Lokale Plugin-Registry unter `/data/plugins` einfuehren. ✅
6. Plugin-Installer fuer lokale Pakete bauen. ✅
7. Settings-UI um Plugin Store, Details, Installieren, Update und Entfernen erweitern.
8. `/`-Picker im Chat um Plugins priorisiert vor Skills erweitern. ✅
9. Plugin-Referenzen im Chat in zusaetzlichen Agent-Runtime-Kontext uebersetzen. ✅
10. Remote Registry/Public Store und Update-Pruefung bauen.
