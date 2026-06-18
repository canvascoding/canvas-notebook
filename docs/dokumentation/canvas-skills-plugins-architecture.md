# Canvas Skills and Plugins Architecture

Stand: 2026-06-17

## Implementierter Stand

Die Canvas-Skill-Runtime, die Canvas-Plugin-Runtime und der erste offizielle Canvas Plugin Store sind implementiert.

- Skills werden aus `/data/skills` und aktivierten Plugin-Paketen geladen.
- Plugins werden unter `/data/plugins/installed/<plugin-name>/<version>/` installiert.
- Die lokale Plugin-Registry liegt unter `/data/plugins/registry.json`.
- Plugin-Skills werden beim Installieren eines Plugins nach `/data/skills/<skill-name>/` materialisiert, sofern dort noch kein Standalone-Skill mit diesem Namen existiert.
- Wenn ein Skill-Name bereits als Standalone-Skill existiert, ueberschreibt das Plugin ihn nicht. Das Plugin wird trotzdem installiert und merkt im Plugin-Record, dass dieser Skill bereits vorhanden war.
- Plugin-Skills koennen weiterhin aus dem Plugin-Paket als Fallback geladen werden, falls ein aelteres Plugin noch nicht materialisiert wurde oder der Standalone-Skill spaeter entfernt wurde.
- Skill- und Plugin-Assets werden ueber authentifizierte Asset-Endpunkte ausgeliefert.
- Der Chat-Composer nutzt `/` als gemeinsamen Picker fuer Plugins und Skills. Aktive Plugins werden zuerst angezeigt, danach aktive Skills.
- Referenzierte Plugins werden im Composer und in der Chat-History mit Plugin-Icon oder Initialen-Fallback gerendert.
- Wenn ein Nutzer `/plugin-name` referenziert, erzeugt die Agent-Runtime fuer diesen Turn einen Canvas-Kontextblock mit Pluginbeschreibung, gebuendelten Skills und Connector-Hinweisen.
- Der Settings-Bereich heisst nutzerseitig **Plugins** und enthaelt interne Tabs fuer **Plugins** und **Skills**. Standard ist die Plugin-Ansicht; Skills bleiben als Detail- und Verwaltungsansicht erreichbar.
- Die Plugin-Ansicht ist Store-first: **Discover**, **Installed**, **Updates** und **Advanced**. Der offizielle Store wird aus `registry.json` geladen; lokale Serverpfad-Installation bleibt als Advanced-Entwickleroption erhalten.
- Der Store wird paginiert und serverseitig nach Query/State gefiltert. Die UI laedt standardmaessig nur die aktuelle Seite, damit grosse Marketplace-Registries nicht komplett in den Browserzustand geladen werden.
- Store-Plugins koennen direkt aus der Registry installiert werden. Canvas laedt das Archiv, extrahiert den in `packagePath` angegebenen Plugin-Ordner, prueft die Package-Checksumme und installiert danach ueber denselben lokalen Installer.
- Installierte Store-Plugins zeigen Update-Status, wenn die Registry eine hoehere `latestVersion` kennt.
- Der Skills-Tab hat intern **Installiert**, **Skill Library** und **Updates**. Installiert bleibt die lokale Datei-/Detailverwaltung; Library und Updates laden reine Standalone-Skills aus derselben Registry-Quelle wie der Plugin Store.
- Reine Store-Skills werden nach `/data/skills/<skill-name>/` installiert, in `/data/skills/registry.json` versioniert und vor Ueberschreiben unter `/data/skills/.backups/<skill-name>/` gesichert.
- Installierte Library-Skills zeigen Update- und Modified-Status. Standalone-Skills koennen aus der Store-Version oder, falls vorhanden, aus `/app/seed_skills/<skill-name>/` wiederhergestellt werden.
- Die interne Datei `/data/skills/registry.json` ist Runtime-Status und wird nicht im Skill-Dateibaum angezeigt.
- Die offizielle Marketplace-Registry enthaelt neben `plugins[]` auch `skills[]`. Kuratierte Plugin-Skills werden dort einzeln veroeffentlicht und tragen `sourcePlugin`, damit die Skill Library anzeigen kann, aus welchem Plugin sie stammen.
- Plugins mit MCP-, E-Mail- oder Composio-Empfehlungen zeigen Connector-Karten mit Setup-CTA. Store-Plugins laden App-/Connector-Status erst per explizitem Preflight fuer das konkrete Plugin; installierte Plugins duerfen ihren Connector-Status anzeigen. Die Connector-Angaben werden als Metadaten gespeichert, enthalten keine Secrets und werden nicht automatisch in Connector-Konfigurationen geschrieben.
- Beim Containerstart werden nur kuratierte Default-Seed-Skills aus `/app/seed_skills` nach `/data/skills` kopiert. Zusaetzlich werden kuratierte Default-Seed-Plugins aus `/app/seed_plugins` nach `/data/plugins/installed` installiert. Bestehende Skills und Plugins werden nicht ueberschrieben.
- Der Seed-Skill `/create-plugin` beschreibt Scaffold, Manifest, Connector-Empfehlungen, Validierung und Marketplace-Vorbereitung fuer neue Canvas Plugins.

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
    "composio": [
      {
        "toolkit": "hubspot",
        "label": "HubSpot",
        "recommended": true,
        "reason": "Use CRM records and company data during sales workflows."
      }
    ],
    "email": [
      {
        "kind": "mailbox",
        "label": "Sales inbox",
        "providers": ["gmail", "imap-smtp"],
        "recommended": true,
        "reason": "Read and send sales emails through Canvas Email."
      }
    ],
    "mcp": [
      {
        "name": "sales-research",
        "label": "Sales Research MCP",
        "configPath": "./connectors/sales-research.mcp.json",
        "recommended": true,
        "env": ["SALES_RESEARCH_API_KEY"],
        "oauth": true,
        "reason": "Optional external research tools."
      }
    ]
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

Connectoren sind Empfehlungen und Setup-Hinweise. Ein Plugin installiert oder aktiviert keine Composio-Verbindung, kein E-Mail-Konto und keinen MCP-Server automatisch. Der Nutzer entscheidet im UI selbst, welche Connectoren eingerichtet werden.

MCP- und Composio-Konfigurationen duerfen keine Secrets enthalten. Sie referenzieren Umgebungsvariablen, die zentral ueber `/data/secrets/Canvas-Integrations.env` verwaltet werden. E-Mail-Empfehlungen laufen ueber die interne Canvas-E-Mail-Konfiguration; Gmail soll nicht ueber Composio empfohlen werden.

## Connector-Empfehlungen

Version 1 behandelt Connectoren als lesbare Empfehlungen mit Statusanzeige:

- **Composio:** Ein Plugin nennt Toolkit-Slugs wie `hubspot`. Canvas gleicht sie mit der Composio-Toolkit-Liste ab, zeigt Logo und Verbindungsstatus und verlinkt in `Settings -> Integrations -> Connected Apps`. Triggers werden in Version 1 nicht vom Plugin-Modell erfasst.
- **Canvas Email:** Ein Plugin kann ein Postfach empfehlen. Der Nutzer verbindet Gmail, SMTP/IMAP oder spaeter weitere Provider ueber die interne E-Mail-Integration.
- **MCP:** Ein Plugin kann eine Beispielkonfiguration referenzieren. Canvas zeigt Pfad, benoetigte Env-Variablen und OAuth-Hinweise und verlinkt in die bestehende MCP-Konfiguration. Die Konfiguration wird nicht automatisch gemerged.

Der Store fuehrt diese Checks lazy aus: Beim Listen der Plugins wird keine globale Composio-Toolkit-Liste und keine MCP-/E-Mail-Konfiguration fuer alle Store-Eintraege geladen. Sobald der Nutzer bei einem konkreten Plugin **Apps pruefen** ausloest, ruft Canvas einen Preflight auf. Dieser Preflight prueft nur die Connector-Empfehlungen dieses Plugins, gibt Logos/Status zurueck, wenn verfuegbar, und blockiert die Installation nicht dauerhaft. Der Nutzer kann die empfohlenen Verbindungen einrichten oder das Plugin trotzdem installieren.

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

## Default Seed Skills

`seed_skills/` bleibt das App-interne Quellverzeichnis fuer Standalone-Skills, die mit dem Image ausgeliefert werden. Damit neue Installationen nicht mit zu vielen Spezial-Skills starten, installiert der Bootstrap aber nur eine explizite Basisliste automatisch:

- `create-plugin` — Canvas Plugins scaffolden und marketplace-faehig vorbereiten.
- `skill-creator` — neue Canvas Skills erstellen oder bestehende Skills verbessern.
- `find-skills` — passende installierbare Skills fuer eine Aufgabe finden.
- `frontend-slides` — webbasierte, visuell anspruchsvolle Slide-Artefakte erstellen.
- `marp-slides` — Markdown-native Marp-Decks erstellen, pruefen und fuer Canvas Preview/Export vorbereiten.

Der Bootstrap installiert Default-Seed-Plugins vor Standalone-Seed-Skills. Beim Installieren eines Seed-Plugins werden dessen Skills nach `/data/skills/<skill-name>/` materialisiert, falls sie dort noch nicht existieren. Danach werden Standalone-Seed-Skills mit gleichem Namen uebersprungen. Dadurch kann ein Skill wie `marp-slides` sowohl als einzeln wiederherstellbares Seed-Paket als auch innerhalb der `document-suite` existieren, ohne doppelte Skill-Namen in neuen Instanzen zu erzeugen.

Alle anderen Skills duerfen weiterhin in `seed_skills/` liegen, werden aber nicht automatisch nach `/data/skills` kopiert. Sie sollen bevorzugt ueber die Canvas Skill Library im Marketplace oder ueber Seed-Plugins angeboten werden. Bestehende Installationen werden nicht bereinigt; die neue Regel betrifft nur Bootstrap-Laeufe, bei denen ein Skill im Zielverzeichnis noch fehlt.

Admins koennen die Bootstrap-Auswahl bei Bedarf mit `CANVAS_BOOTSTRAP_SEED_SKILLS` als kommaseparierte Liste ueberschreiben, zum Beispiel:

```text
CANVAS_BOOTSTRAP_SEED_SKILLS=create-plugin,skill-creator,find-skills,frontend-slides,marp-slides
```

## Default Seed Plugins

`seed_plugins/` ist das App-interne Quellverzeichnis fuer Plugin-Bundles, die mit dem Image ausgeliefert und bei frischen Installationen direkt installiert werden sollen. Der Bootstrap installiert aktuell:

- `document-suite` — Buendelt die Skills `pdf`, `pptx`, `xlsx`, `docx`, `marp-slides` und `excalidraw-diagram` als ein Office-/Dokumenten-Plugin.

Seed-Plugins werden nach `/data/plugins/installed/<plugin-name>/<version>/` kopiert und in `/data/plugins/registry.json` registriert. Wenn ein Plugin bereits installiert ist, wird es nicht ueberschrieben. Wenn einer seiner Skill-Namen bereits als Standalone-Skill unter `/data/skills` existiert und dieser Skill nicht eindeutig aus demselben Plugin stammt, wird nur dieser einzelne Skill nicht materialisiert; das Plugin selbst wird trotzdem installiert. Plugin-eigene materialisierte Skills duerfen bei einem Reinstall, Update oder Repair ersetzt werden, damit geloeschte, veraenderte oder veraltete Plugin-Skills wiederhergestellt werden koennen. Bei frischen Installationen laufen Seed-Plugins vor Standalone-Seed-Skills, damit Kernpakete wie `document-suite` ihre Skills als Plugin bereitstellen und gleichzeitig einzeln in `/data/skills` sichtbar machen koennen.

Admins koennen die Bootstrap-Auswahl bei Bedarf mit `CANVAS_BOOTSTRAP_SEED_PLUGINS` als kommaseparierte Liste ueberschreiben, zum Beispiel:

```text
CANVAS_BOOTSTRAP_SEED_PLUGINS=document-suite
```

## Remote Registry und Installation

Das offizielle Marketplace-Repository ist als separates oeffentliches Repository angelegt: `canvas-notebook-plugin-marketplace`.

```text
canvas-notebook-plugin-marketplace/
  registry.json
  schemas/
    registry.schema.json
  plugins/
    document-suite/
      1.1.0/
        .canvas-plugin/plugin.json
        skills/
        assets/
    google-workspace/
      1.0.0/
  skills/
    create-plugin/
      1.0.0/
        SKILL.md
        agents/canvas.yaml
        assets/
```

`registry.json` listet Marketplace-Metadaten, Plugin-Versionen, Skill-Versionen, Download-Pfade, Checksums, Kategorien, Icons, Publisher und Connector-Hinweise. Plugins bleiben der primaere Distributionsweg; die `skills`-Sektion bietet kuratierte Einzel-Skills an. Ein Skill-Eintrag kann entweder auf ein reines Skill-Paket zeigen oder ueber `sourcePlugin` auf einen Skill-Unterordner innerhalb eines Plugin-Archives.

Canvas Notebook installiert Pakete nach:

```text
/data/plugins/installed/<plugin-name>/<version>/
/data/plugins/registry.json
/data/skills/<skill-name>/
/data/skills/registry.json
/data/skills/.backups/<skill-name>/<timestamp>/
```

Standalone Skills bleiben moeglich. Plugin-Skills werden bei der Installation als Standalone-Skills materialisiert und im lokalen Skill-Registry-Eintrag mit `sourceType: "plugin"`, `sourcePluginName` und `sourcePluginVersion` markiert. Das Plugin bleibt weiterhin das Bundle fuer Connector-Kontext, Kuration und Marketplace-Installation.

Plugin-Installation laeuft aktuell ueber diesen Ablauf:

1. Offizielle Registry aus `CANVAS_PLUGIN_STORE_REGISTRY_URL` laden; falls nicht gesetzt, wird die Canvas-GitHub-Registry verwendet.
2. Plugin-Liste serverseitig paginiert und gefiltert ausliefern (`page`, `pageSize`, `q`, `state`).
3. Plugin-Version auswaehlen, standardmaessig `latestVersion`.
4. Falls Connector-Empfehlungen vorhanden sind, vor dem Download per Preflight Status und Setup-CTAs fuer Composio, Canvas Email oder MCP anzeigen.
5. Paket erst nach Nutzerbestaetigung aus `downloadUrl` herunterladen.
6. Checksum gegen Registry pruefen.
7. `.canvas-plugin/plugin.json` validieren.
8. Paket nach `/data/plugins/installed/<name>/<version>/` kopieren.
9. Jeden enthaltenen Skill nach `/data/skills/<skill-name>/` materialisieren, falls dort noch kein Standalone-Skill existiert.
10. Bereits vorhandene Standalone-Skills nicht ueberschreiben; sie werden im Plugin-Record als `preexistingStandalone` markiert.
11. Neu materialisierte Skills in `/data/skills/registry.json` mit `sourceType: "plugin"` registrieren.
12. Lokale Plugin-Registry atomar aktualisieren.
13. Neu materialisierte Skills aktivieren, wenn der Nutzer `Install` bestaetigt. Spaeteres Deaktivieren oder Entfernen des Plugins deaktiviert oder loescht diese Standalone-Skills nicht automatisch.

Standalone-Skill-Installation nutzt denselben Grundablauf mit einem kleineren Paketformat:

1. Offizielle Registry aus `CANVAS_PLUGIN_STORE_REGISTRY_URL` laden und die optionale `skills`-Sektion normalisieren.
2. Skill-Liste serverseitig paginiert und gefiltert ausliefern (`page`, `pageSize`, `q`, `state`).
3. Skill-Version auswaehlen, standardmaessig `latestVersion`.
4. Paket aus `downloadUrl` herunterladen und den in `packagePath` angegebenen Skill-Ordner extrahieren.
5. Checksum gegen Registry pruefen.
6. `SKILL.md` am Paket-Root validieren und sicherstellen, dass der Skill-Name zum Registry-Eintrag passt.
7. Falls ein Standalone-Skill bereits existiert, ihn nach `/data/skills/.backups/<skill-name>/<timestamp>/` sichern.
8. Paket nach `/data/skills/<skill-name>/` kopieren.
9. Lokale Skill-Registry atomar aktualisieren.
10. Skill aktivieren, wenn der Nutzer `Install` oder `Restore` bestaetigt.

Mehrere Marketplace-Quellen bleiben ein geplanter Ausbau. Das Datenmodell und die Store-UI sind so gehalten, dass spaeter zusaetzliche Quellen neben dem offiziellen Store angebunden werden koennen.

## Lokale API

Die lokale Runtime stellt diese authentifizierten Endpunkte bereit:

- `GET /api/plugins` — installierte Plugins listen
- `GET /api/plugins/store` — offiziellen Plugin Store mit Installations-, Update- und Skill-Health-Status listen; Query: `page`, `pageSize`, `q`, `state=all|available|installed|updates`
- `POST /api/plugins/store/preflight` — Connector- und Skill-Health-Preflight fuer ein Store-Plugin ausfuehren (`name`, optional `version`). Der Response enthaelt `skills[]`, `skillSummary` und `hasSkillIssues`, damit das Frontend fehlende oder reparierbare Plugin-Skills direkt im Plugin-Detail anzeigen kann.
- `POST /api/plugins/store/install` — Plugin aus dem Store installieren (`name`, optional `version`, `enable`, `replace`)
- `GET /api/plugins/[name]` — Plugin-Details lesen
- `POST /api/plugins/validate` — lokales Plugin-Paket validieren (`sourcePath`)
- `POST /api/plugins/install` — lokales Plugin-Paket installieren (`sourcePath`, optional `enable`, `replace`)
- `POST /api/plugins/[name]/enable` — Plugin aktivieren
- `POST /api/plugins/[name]/disable` — Plugin deaktivieren
- `DELETE /api/plugins/[name]` — Plugin entfernen
- `GET /api/plugins/asset?plugin=<name>&path=<relative-image-path>` — Plugin-Bilder laden
- `GET /api/skills/store` — offizielle Skill Library mit Installations-, Update- und Modified-Status listen; Query: `page`, `pageSize`, `q`, `state=all|available|installed|updates`
- `POST /api/skills/store/install` — Standalone-Skill aus der Library installieren (`name`, optional `version`, `enable`, `replace`)
- `POST /api/skills/[name]/restore` — Standalone-Skill aus Store oder Seed wiederherstellen (`prefer=store|seed`, optional `version`, `enable`)

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
plugins/document-suite/1.0.0/
plugins/document-suite/1.1.0/
```

Die lokale Registry zeigt nur eine aktive Version pro Plugin. Alte Versionen koennen fuer Rollback erhalten bleiben.

## Seed Collection

Canvas Notebook liefert eine kleine Seed Collection direkt mit. Beim ersten Start werden kuratierte Default-Plugins und danach kuratierte Standalone-Skills installiert, sofern sie im Zielverzeichnis noch fehlen.

Aktuell liefert das Docker-Image `seed_plugins/` unter `/app/seed_plugins` und `seed_skills/` unter `/app/seed_skills` mit. Der Bootstrap kopiert Default-Plugins nach `/data/plugins/installed`, materialisiert deren Skills nach `/data/skills` und registriert beides in `/data/plugins/registry.json` bzw. `/data/skills/registry.json`; danach kopiert er Default-Standalone-Skills nach `/data/skills`, sofern sie noch fehlen. Dadurch bleiben lokale Anpassungen erhalten, und neue Installationen bekommen die Document Suite als Plugin plus einzeln sichtbare Document-Skills und Creator-/Discovery-Skills als Standalone-Basis. Wenn ein Nutzer spaeter einen von einem Plugin bereitgestellten Skill loescht, meldet der Plugin-Store diesen Skill als fehlend/reparierbar; ein Reinstall desselben Plugin-Pakets materialisiert den Skill erneut.

Der offizielle Remote Store bleibt trotzdem die Update- und Erweiterungsquelle: `document-suite` ist dort als versioniertes Marketplace-Paket enthalten. Zusaetzlich bietet dieselbe Registry kuratierte Plugin-Skills in `skills[]` einzeln an, darunter `pdf`, `pptx`, `xlsx`, `docx`, `marp-slides` und `excalidraw-diagram`. Weitere Plugins und Skills werden nicht automatisch installiert, sondern im Store sichtbar gemacht.

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
14. Connector-Empfehlungen fuer Composio, Canvas Email und MCP definieren. ✅
15. Plugin-UI um Composio-Status/Logo und Connector-CTAs erweitern. ✅
16. Remote Registry/Public Store und Update-Pruefung bauen. ✅
17. Plugin-Store-UI mit Discover, Installed, Updates und Advanced Local Install bauen. ✅
18. Store-Pagination und lazy Connector-Preflight vor Download/Installation ergaenzen. ✅
19. Create-Plugin-Skill fuer Scaffold, Manifest, Validierung und Marketplace-Submit vorbereiten. ✅
20. Mehrere Marketplace-Quellen mit Sources-Verwaltung ergaenzen.
21. Seed-Plugins bzw. nicht-loeschbare System-Plugins einfuehren, falls Basispakete nicht nur als Skills ausgeliefert werden sollen. ✅
