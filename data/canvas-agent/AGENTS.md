# AGENTS

Du arbeitest in einem Docker Container auf Linux.

## Dateisystem-Struktur

```mermaid
graph TD
    A[/data/] --> B[workspace/]
    A --> C[canvas-agent/]
    A --> D[skills/]
    A --> E[temp/]
    A --> F[secrets/]
    A --> G[cache/]
    A --> H[(sqlite.db)]
    
    B --> B1[image-generation/]
    B --> B2[nano-banana-ad-localizer/]
    B --> B3[veo-studio/]
    B --> B4[... user folders ...]
    
    C --> C1[AGENTS.md]
    C --> C2[SOUL.md]
    C --> C3[MEMORY.md]
    C --> C4[TOOLS.md]
    C --> C5[pi-runtime-config.json]
    
    D --> D1[skill-name/]
    D1 --> D2[SKILL.md]
    
    E --> E1[skills/]
    E1 --> E2[{skill-name}/]
    
    F --> F1[Canvas-Integrations.env]
    F --> F2[Canvas-Agents.env]
    
    style B fill:#90EE90,stroke:#228B22,stroke-width:2px
    style C fill:#FFB6C1,stroke:#DC143C,stroke-width:2px
    style D fill:#87CEEB,stroke:#4169E1,stroke-width:2px
    style E fill:#FFD700,stroke:#FF8C00,stroke-width:2px
    style F fill:#DDA0DD,stroke:#8B008B,stroke-width:2px
    style G fill:#D3D3D3,stroke:#696969,stroke-width:2px
    style H fill:#D3D3D3,stroke:#696969,stroke-width:2px
```

## Verzeichnis-Übersicht

| Pfad | Inhalt | User-sichtbar | Beschreibung |
|------|--------|---------------|--------------|
| `/data/workspace/` | User-Dateien | ✅ Ja | **Einziger sichtbarer Ordner im Web UI**. Enthält 3 System-Ordner (image-generation, nano-banana-ad-localizer, veo-studio) + user-spezifische Ordner |
| `/data/canvas-agent/` | Agent-Config | ❌ Nein | Deine Systemprompt-Dateien (AGENTS.md, SOUL.md, MEMORY.md, TOOLS.md) + Runtime-Config |
| `/data/skills/` | Skill-Doku | ❌ Nein | SKILL.md Dateien für alle verfügbaren Skills |
| `/data/temp/` | Temp-Dateien | ❌ Nein | Temporäre Verarbeitungsdateien (`/data/temp/skills/{skill-name}/`) |
| `/data/secrets/` | API-Keys | ❌ Nein | Zentral verwaltete Secrets und Env-Variablen |
| `/data/cache/` | Cache-Daten | ❌ Nein | System-Cache |
| `/data/sqlite.db` | Datenbank | ❌ Nein | SQLite Datenbank für Sessions, Usage, etc. |

## Workspace-Struktur

**System-Ordner** (immer vorhanden):
- `image-generation/` - Bildgenerierung Outputs
- `nano-banana-ad-localizer/` - Ad-Localization Outputs  
- `veo-studio/` - Video-Generierung Outputs

**User-Ordner** (variabel):
- Der User kann beliebige eigene Ordnerstrukturen anlegen
- Beispiele: `01_PROJEKTE/`, `02_RESOURCES/`, `documents/`, etc.

> **Hinweis:** Du kannst diese AGENTS.md Datei bei Bedarf aktualisieren, um die aktuelle Workspace-Struktur des Users zu dokumentieren. Füge neue wichtige Ordner hinzu, wenn du sie kennenlernst.

## Temp-Dateien Workflow

Bei Skill-Verwendung:
1. **Arbeitsverzeichnis**: `/data/temp/skills/{skill-name}/` für temporäre Dateien
2. **Finale Ergebnisse**: IMMER nach `/data/workspace/` kopieren
3. **Aufräumen**: Temp-Dateien nach erfolgreicher Fertigstellung löschen

**Wichtig:** Der User sieht NUR Dateien in `/data/workspace/`. Temp-Dateien sind für ihn unsichtbar.

## Skills

Alle Skills liegen unter `/data/skills/{skill-name}/SKILL.md`:
- Jeder Skill hat seine eigene Dokumentation
- Enthält Beschreibung, Parameter und Anleitungen
- Werden automatisch geladen und im Systemprompt verfügbar gemacht

## Secrets

API-Keys und sensible Daten:
- Zentral in `/data/secrets/Canvas-Integrations.env` verwaltet
- Niemals hardcoden!
- Über Settings-UI (`/settings?tab=integrations`) konfigurierbar
