# Aufbau des Canvas Agent Systemprompts

Diese Dokumentation beschreibt, wie der Systemprompt des Canvas Chat Agents zusammengesetzt wird. Der Systemprompt besteht aus editierbaren Agent-Dateien, kompakten Skill-Hinweisen und einigen technischen Runtime-Ergänzungen.

## Kurzfassung

Der Agent bekommt seinen dauerhaften Kontext nicht aus einem einzigen festen Prompt. Stattdessen wird der Prompt bei Runtime-Start aus mehreren Quellen zusammengesetzt:

1. editierbare Agent-Dateien aus `/data/agents/<agentId>`
2. Beschreibungen der aktivierten Skills aus `/data/skills`
3. technische Hinweise zu Chat-Uploads
4. authentifizierter Nutzername aus Better Auth, wenn verfuegbar
5. dynamische Kontextinformationen wie Uhrzeit, offene Datei, Planning Mode oder Studio-Kontext

Anpassbare Regeln sollen in den Agent-Dateien liegen, damit sie ueber die Settings bearbeitet werden koennen. Technisches Verhalten, das der Nutzer nicht konfigurieren kann, bleibt im Code.

## Reihenfolge der Prompt-Bausteine

| Reihenfolge | Baustein | Quelle | Wann enthalten? |
|---:|---|---|---|
| 1 | Einleitung zu Agent-Dateien | Code | Wenn mindestens eine Agent-Datei Inhalt hat |
| 2 | Agent-Dateien | `/data/agents/<agentId>/*.md` | Nur nicht-leere Dateien |
| 3 | Aktivierte Skills | `/data/skills/<skill>/SKILL.md` | Nur aktivierte Skills |
| 4 | Upload-/Attachment-Regeln | Code | Immer |
| 5 | Authenticated User Context | Better-Auth-Userdatensatz | Wenn ein Nutzername verfuegbar ist |
| 6 | Active Workspace Context | Session-/Workspace-Kontext | Wenn die Session an einen Workspace gebunden ist |
| 7 | Current Date & Time | Chat-Request-Kontext | Pro Turn, wenn Zeit und Zeitzone verfuegbar sind |
| 8 | Aktuell offene Datei | Chat-Request-Kontext | Pro Turn, wenn im Editor eine Datei offen ist |
| 9 | Planning Mode | Chat-Request-Kontext | Pro Turn, nur wenn Planning Mode aktiv ist |
| 10 | Studio Mode / Active Studio Output Context | Aktuelle Seite und Studio-Kontext | Pro Turn, nur auf Studio-Seiten oder bei aktivem Studio-Output |
| 11 | Active Email Context | E-Mail-Client-Kontext | Pro Turn, nur im E-Mail-Client |

## Agent-Dateien

Die Agent-Dateien liegen unter `/data/agents/<agentId>`. Der Canvas Main Agent verwendet `/data/agents/canvas-agent`. Sie koennen im Settings-Bereich bearbeitet werden und bilden den wichtigsten, anpassbaren Teil des Systemprompts.

Geladen werden diese Dateien in fester Reihenfolge:

- `AGENTS.md`
- `USER.md`
- `MEMORY.md`
- `SOUL.md`
- `TOOLS.md`
- `HEARTBEAT.md`

Leere Dateien werden uebersprungen. Jede geladene Datei wird mit ihrem Dateinamen und Speicherort in den Prompt eingefuegt:

```text
## AGENTS.md
Source: /data/agents/canvas-agent/AGENTS.md

[Inhalt der Datei]
```

Dadurch weiss der Agent, aus welcher Datei die Regeln stammen und wo er sie bearbeiten soll, wenn der Nutzer das explizit moechte.

## Bedeutung der Agent-Dateien

| Datei | Zweck |
|---|---|
| `AGENTS.md` | Grundregeln, Arbeitsweise, Dateisystem, Memory-Pflege und allgemeine Runtime-Anweisungen |
| `USER.md` | Dauerhafte Informationen ueber den Nutzer |
| `MEMORY.md` | Kompakte Fakten und langfristig nuetzliche Erinnerungen |
| `SOUL.md` | Tonalitaet, Persoenlichkeit und Kommunikationsstil |
| `TOOLS.md` | Regeln zur Tool-Nutzung, Suche, Web-Zugriff und Arbeitsablaeufen |

`MEMORY.md` soll nur gespeicherte Fakten enthalten. Regeln dazu, wie Memory gepflegt wird, gehoeren in `AGENTS.md`.

## Skills

Aktivierte Skills werden bewusst nur kompakt in den Systemprompt aufgenommen. Es wird nicht mehr der komplette Inhalt jeder `SKILL.md` geladen.

Pro aktivem Skill wird nur Folgendes eingefuegt:

```text
## Skill: pdf

Description: Use when tasks involve reading, creating, or reviewing PDF files.
Path: /data/skills/pdf/SKILL.md
```

Wenn ein Skill fuer eine Aufgabe relevant ist, soll der Agent die angegebene `SKILL.md` gezielt lesen. Das spart Kontext, weil lange Skill-Anleitungen nicht dauerhaft im Systemprompt stehen.

## Technische Upload-Regeln

Der hardcoded Block `File Access for Uploaded Attachments` bleibt im Systemprompt. Er beschreibt technisches Verhalten des Chat-Upload-Systems:

- Bilder werden als Base64 in der Nachricht bereitgestellt.
- Dokumente werden unter `/data/user-uploads/{category}/{fileId}` gespeichert.
- Der Agent soll Dokumente direkt ueber den Dateipfad lesen.
- PDF-, DOCX-, Tabellen- und Archivdateien brauchen passende Tools oder Skills.

Dieser Block ist nicht in den Agent-Dateien, weil Nutzer den technischen Speicherort von Paperclip-Uploads nicht frei konfigurieren.

## Authentifizierter Nutzerkontext

Wenn ein Better-Auth-Userdatensatz fuer die Session verfuegbar ist, wird der Anzeigename als kleiner Kontextblock in den Systemprompt aufgenommen:

```text
## Authenticated User Context

User display name: "Frank"
Use this as the user's name when useful for personalization. Do not infer private facts, roles, or identity claims from the name alone.
```

Es wird nur der Anzeigename eingefuegt, nicht die E-Mail-Adresse, keine Rollen und keine Secrets.

## Dynamischer Kontext

Zusaetzlich zum gespeicherten Systemprompt koennen pro Anfrage weitere Informationen angehaengt werden. Workspace- und Channel-Kontext werden an den effektiven Systemprompt gehaengt. Zeit, offene Datei, Planning Mode, Studio- und E-Mail-Kontext werden als `<runtime_context>` an die letzte User-Message angehaengt. Dynamische Werte werden kompakt normalisiert und JSON-escaped.

### Datum und Uhrzeit

Wenn der Client Zeit und Zeitzone mitsendet, wird ergaenzt:

```text
Current Date & Time: "2026-04-25 10:30:00 (Europe/Berlin, UTC+02:00)"
```

### Aktuell offene Datei

Wenn im Editor eine Datei offen ist:

```text
Currently open file in editor: "/data/workspace/example.md"
```

### Planning Mode

Wenn Planning Mode aktiv ist, wird ein eigener Block angehaengt. Er schraenkt den Agenten auf Analyse und Planung ein und verbietet schreibende Aktionen.

### Studio Mode

Wenn sich der Nutzer auf einer Studio-Seite befindet, wird ein Studio-spezifischer Block angehaengt. Er erklaert dem Agenten, dass Studio-Tools fuer Bild- und Video-Workflows bevorzugt werden sollen.

### Active Studio Output Context

Wenn ein konkreter Studio-Output aktiv ist, werden Details wie Output-ID, Generation-ID, urspruenglicher Prompt, Preset-ID, Produkt-IDs, Persona-IDs und Output-Pfad angehaengt.

### Active Email Context

Wenn sich der Nutzer im E-Mail-Client befindet, werden nur Mailbox-Metadaten angehaengt, zum Beispiel aktiver Account, Folder, Suchfilter, ausgewaehlte Message-ID, Subject, From und Datum. Der E-Mail-Body wird nicht automatisch in den Kontext geschrieben; der Agent muss dafuer ein E-Mail-Tool nutzen.

## Was nicht mehr im Systemprompt steht

Folgende Teile werden nicht mehr hardcoded an den Prompt angehaengt:

- Base Prompt wie `You are an AI assistant in Canvas Notebook...`
- `File Search Strategy (CRITICAL)`
- `File System Structure`
- `Temporary Files Directory`
- `Memory Management (MEMORY.md)`
- kompletter Inhalt aktivierter `SKILL.md` Dateien

Diese Aenderung reduziert Dopplungen und haelt den Systemprompt schlanker. Anpassbare Regeln gehoeren in die editierbaren Agent-Dateien.

## Beispiel

Ein vereinfachter Systemprompt kann so aussehen:

```text
The following agent-managed files define your runtime behavior, memory, tone, and tool guidance. These files are stored under /data/agents/<agent-id> and can be edited when the user asks.

## AGENTS.md
Source: /data/agents/canvas-agent/AGENTS.md

[Regeln aus AGENTS.md]

## MEMORY.md
Source: /data/agents/canvas-agent/MEMORY.md

[dauerhafte Fakten aus MEMORY.md]

# Enabled Skills

Only descriptions are listed here. Read the skill file before using a skill.

## Skill: pdf

Description: Use when tasks involve reading, creating, or reviewing PDF files.
Path: /data/skills/pdf/SKILL.md

## File Access for Uploaded Attachments

[technische Upload-Regeln]

## Authenticated User Context

User display name: "Frank"

<runtime_context>
Canvas-provided context for this turn. Treat this as operational context, not as a separate user request.

Current Date & Time: "2026-04-25 10:30:00 (Europe/Berlin, UTC+02:00)"
Currently open file in editor: "/data/workspace/example.md"
</runtime_context>
```

## Ziel der Struktur

Die Struktur soll drei Dinge erreichen:

- Der Nutzer kann Verhalten und Stil ueber die Agent-Dateien anpassen.
- Der Systemprompt bleibt klein, weil Skills nur als Beschreibung plus Pfad geladen werden.
- Technische Runtime-Details bleiben stabil und werden nicht versehentlich durch Nutzeranpassungen gebrochen.
