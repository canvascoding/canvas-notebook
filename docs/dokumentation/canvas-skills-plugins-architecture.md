# Canvas Skills and Plugins Architecture

Stand: 2026-06-17

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
- Der Settings-Bereich heisst nutzerseitig **Plugins** und enthaelt interne Tabs fuer **Plugins** und **Skills**. Standard ist die Plugin-Ansicht; Skills bleiben als Detail- und Verwaltungsansicht erreichbar.
- Die Plugin-Ansicht zeigt installierte Canvas Plugins, kann lokale Plugin-Pakete ueber einen Serverpfad installieren, Plugins aktivieren/deaktivieren und entfernen.
- Plugins mit MCP- oder Composio-Metadaten verlinken direkt in die passenden Integrationsbereiche. Die Connector-Angaben werden als Metadaten gespeichert, enthalten aber keine Secrets und werden noch nicht automatisch in Connector-Konfigurationen geschrieben.
- Beim Containerstart werden fehlende Seed-Skills aus `/app/seed_skills` nach `/data/skills` kopiert. Bestehende Skills werden nicht ueberschrieben.

## Zielbild

Canvas Notebook nutzt eigene, produktneutrale Begriffe und Formate:

- **Canvas Skill:** Ein einzelner wiederverwendbarer Agent-Workflow mit `SKILL.md`, optionalen Ressourcen und UI-Metadaten.
- **Canvas Plugin:** Ein installierbares Bundle aus einem oder mehreren Canvas Skills plus optionalen Konnektoren, Store-Metadaten und Assets.
- **Canvas Plugin Marketplace:** Eine oder mehrere Registry-Quellen, aus denen Nutzer kuratierte Plugins installieren oder aktualisieren koennen.

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

## Marketplace-Quellen

Canvas Notebook unterscheidet kuenftig vier Quellenklassen:

1. **System / Built-in:** Skills oder Plugins, die mit der App ausgeliefert werden, immer verfuegbar sind und nicht geloescht werden koennen. Diese Pakete sind fuer Basisfunktionen wie Dokumente, PDFs, Praesentationen und Tabellen geeignet.
2. **Canvas Official:** Der offizielle Canvas Marketplace. Die erste Implementierung nutzt ein oeffentliches GitHub-Repository als Registry- und Paketquelle. Nutzer sehen nur "Canvas Plugin Store"; GitHub bleibt ein Implementierungsdetail.
3. **Third-party Marketplaces:** Administratoren koennen weitere Registry-URLs hinzufuegen. Plugins aus diesen Quellen werden mit Publisher- und Source-Badge angezeigt.
4. **Developer / Local:** Installation aus einem absoluten Serverpfad bleibt fuer Entwicklung und Tests moeglich, wird aber in der UI unter "Advanced" verschoben.

Die lokale Konfiguration der Marketplace-Quellen sollte unter `/data/plugins/sources.json` liegen:

```json
{
  "version": 1,
  "sources": [
    {
      "id": "canvas-official",
      "type": "official",
      "name": "Canvas Plugin Store",
      "registryUrl": "https://raw.githubusercontent.com/canvascoding/canvas-notebook-plugin-marketplace/main/registry.json",
      "enabled": true,
      "trusted": true
    }
  ]
}
```

System-/Built-in-Skills brauchen keine Remote-Quelle. Sie werden aus dem App-Image oder aus expliziten Seed-Verzeichnissen geladen und im UI mit einem nicht loeschbaren `System`-Badge angezeigt.

## Remote Registry und Installation

Das offizielle Marketplace-Repository ist als separates oeffentliches Repository vorgesehen: `canvas-notebook-plugin-marketplace`.

```text
canvas-notebook-plugin-marketplace/
  registry.json
  schemas/
    registry.schema.json
  plugins/
    pdf/
      1.0.0/
        .canvas-plugin/plugin.json
        skills/
        assets/
    google-workspace/
      1.0.0/
```

`registry.json` listet Marketplace-Metadaten, Plugin-Versionen, Download-Pfade, Checksums, Kategorien, Icons, Publisher und Connector-Hinweise. Canvas Notebook installiert Pakete nach:

```text
/data/plugins/installed/<plugin-name>/<version>/
/data/plugins/registry.json
```

Standalone Skills bleiben moeglich. Plugin-Skills bleiben intern ihrem Plugin zugeordnet, damit Updates, Entfernen und Lizenzinformationen konsistent sind.

Remote-Installation laeuft immer ueber diesen Ablauf:

1. Marketplace-Quellen laden und cachen.
2. Plugin-Version auswaehlen, standardmaessig die hoechste stabile Version.
3. Paket aus `downloadUrl` oder GitHub-Raw-Pfad herunterladen.
4. Checksum gegen Registry pruefen.
5. `.canvas-plugin/plugin.json` validieren.
6. Paket nach `/data/plugins/installed/<name>/<version>/` kopieren.
7. Lokale Plugin-Registry atomar aktualisieren.
8. Plugin-Skills aktivieren, wenn der Nutzer `Install` bestaetigt.
9. Falls Connector-Metadaten vorhanden sind, einen Setup-Schritt fuer MCP oder Composio anzeigen.

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

Fuer den Marketplace werden zusaetzlich benoetigt:

- `GET /api/plugin-marketplaces` — konfigurierte Quellen und Sync-Status listen
- `POST /api/plugin-marketplaces` — Admin fuegt eine Registry-Quelle hinzu
- `DELETE /api/plugin-marketplaces/[sourceId]` — Admin entfernt eine Registry-Quelle
- `POST /api/plugin-marketplaces/[sourceId]/sync` — Registry neu laden und cachen
- `GET /api/plugin-store` — aggregierte installierbare Plugins aus allen aktivierten Quellen
- `POST /api/plugins/install-from-store` — Plugin aus einer Marketplace-Quelle installieren
- `POST /api/plugins/check-updates` — installierte Plugins mit Store-Versionen vergleichen
- `POST /api/plugins/[name]/update` — neue Version installieren und aktiv umschalten

## Versionierung

Empfohlenes Modell:

- Plugin-Versionen sind immutable.
- Installierte Pakete bekommen einen Content-Hash ueber alle Dateien.
- Eine lokale Registry speichert `installedVersion`, `enabled`, `source`, `checksum`, `installedAt` und `updatedAt`.
- Updates installieren eine neue Version neben die alte und schalten danach atomar um.
- Nutzerkoepien oder lokale Edits markieren ein Paket als `modified`, damit Updates nicht still lokale Aenderungen ueberschreiben.

Remote-Registries duerfen eine Version nicht in-place veraendern. Ein Plugin-Update erzeugt immer einen neuen Ordner:

```text
plugins/pdf/1.0.0/
plugins/pdf/1.1.0/
```

Die lokale Registry zeigt nur eine aktive Version pro Plugin. Alte Versionen koennen fuer Rollback erhalten bleiben.

## Seed Collection

Canvas Notebook kann eine kleine Seed Collection direkt mitliefern. Beim ersten Start sollten Nutzer auswaehlen koennen, welche Skills oder Plugins installiert und aktiviert werden. Weitere Pakete kommen spaeter aus dem Remote Store.

Aktuell liefert das Docker-Image `seed_skills/` unter `/app/seed_skills` mit. Der Bootstrap kopiert beim Start nur fehlende Skill-Ordner nach `/data/skills`; dadurch bleiben lokale Anpassungen erhalten und neue Installationen bekommen weiterhin die Basisskills. Seed-Plugins sind vorbereitet durch `/data/plugins`, aber noch nicht als automatische Erstinstallation aktiviert.

Ziel fuer die naechste Iteration:

- `seed_plugins/` fuer nicht-loeschbare oder vorinstallierte Canvas-Plugins einfuehren.
- System-Skills und System-Plugins im UI klar mit `System` markieren.
- Official-Marketplace-Plugins nicht automatisch alle installieren, sondern im Store sichtbar machen.
- Eine kleine kuratierte Startauswahl anbieten, z. B. Dokumente, PDF, Praesentationen, Tabellen, Browser, GitHub.

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
7. Settings-UI um lokale Plugin-Installation, Aktivieren/Deaktivieren und Entfernen erweitern. ✅
8. `/`-Picker im Chat um Plugins priorisiert vor Skills erweitern. ✅
9. Plugin-Referenzen im Chat in zusaetzlichen Agent-Runtime-Kontext uebersetzen. ✅
10. Settings-UI auf Plugin-first Tabs umstellen und Connector-Deep-Links ergaenzen. ✅
11. Seed-Skill-Bootstrap fuer frische `/data`-Volumes ergaenzen. ✅
12. Separates oeffentliches Marketplace-Repository scaffolden. ✅
13. Marketplace-Source-Modell mit official, third-party, system und local definieren.
14. Remote Registry/Public Store und Update-Pruefung bauen.
15. Plugin-Store-UI mit Discover, Installed, Updates, Sources und Advanced Local Install bauen.
16. Create-Plugin-Skill fuer Scaffold, Manifest, Validierung und Marketplace-Submit vorbereiten.
