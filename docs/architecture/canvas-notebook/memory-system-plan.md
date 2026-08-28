# Canvas Notebook Memory System Plan

Stand: 2026-08-28

## Ziel und Produktentscheidung

Canvas Notebook ersetzt die laufzeitrelevanten Prompt-Dateien `USER.md` und
`MEMORY.md` durch ein datenbankbasiertes Memory-System. Das System speichert
kuratierten, langlebigen Kontext mit eindeutiger Eigentuemlichkeit,
Berechtigungen, Audit-Herkunft und gezielter Prompt-Einblendung.

Die bisherige Dateiloesung bleibt nur als Import- und Exportformat bestehen.
Neue Chats und Agenten lesen `USER.md` und `MEMORY.md` nach der Migration nicht
mehr als Runtime-Quelle.

Die uebrigen Managed Files bleiben Markdown-Dateien:

| Datei | Entscheidung | Begruendung |
| --- | --- | --- |
| `AGENTS.md` | bleibt Datei | stabile, menschlich editierbare Rollen- und Arbeitsinstruktionen |
| `SOUL.md` | bleibt Datei | stabile Ton- und Verhaltensbeschreibung des Agenten |
| `TOOLS.md` | bleibt Datei | stabile Tool-Praeferenzen und Hinweise |
| `USER.md` | wird abgeloest | braucht Scopes, Kategorien, Rechte, Herkunft und Eintragsverwaltung |
| `MEMORY.md` | wird abgeloest | braucht Scopes, Kategorien, Rechte, Herkunft und Eintragsverwaltung |

Memory ist Faktenkontext, keine zusaetzliche Instruktionshierarchie. Es darf
Systemregeln, Sicherheitsgrenzen, Organisationsrichtlinien oder den aktuellen
Nutzerauftrag nie ueberstimmen.

## Bestehende Ausgangslage

Die vorhandene Implementierung ist eine brauchbare Migrationsbasis, aber kein
vollstaendiges Multi-Workspace-Memory:

- `app/lib/agents/memory-store.ts` verwaltet flache, ID-basierte Eintraege in
  `USER.md` und `MEMORY.md`.
- User-Memory ist bereits pro `userId` gespeichert; Agent-Memory ist pro
  `userId` und `agentId` gespeichert.
- `AgentStorageScope` traegt bereits `organizationId`, `workspaceId`,
  `projectId` und Agent-Ownership, doch der aktuelle Memory Store nutzt nur
  `userId`.
- Memory ist im UI ausschliesslich als Rohdatei unter
  `/settings?tab=agent-settings` > Managed Files sichtbar.
- Workspace-Mitgliedschaften besitzen bereits `canRead`, `canWrite` und
  `canManage`; Organisationen besitzen eigene Rollen und Permissions.

Das neue System erweitert diese vorhandenen Resolver. Es schafft keine zweite
parallel laufende Berechtigungslogik.

## Scope-Modell

### Scope-Typen

| Scope | Eigentum | Typische Inhalte | Sichtbarkeit |
| --- | --- | --- | --- |
| `user` | ein Nutzer | Profil, Praeferenzen, Kommunikation, Interessen, Tech Stack | nur dieser Nutzer |
| `agent` | Nutzer + Agent | agentenspezifische, langlebige Arbeits- und Umgebungsfakten | nur dieser Nutzer in diesem Agenten |
| `workspace` | Workspace | Entscheidungen, Marken-, Kunden- und Projektkontext, lokale Konventionen | berechtigte Workspace-Mitglieder |
| `organization` | Organisation | freigegebene Standards, Begriffe und organisationsweiter Kontext | berechtigte interne Organisationsmitglieder |

Ein `project` ist in V1 kein eigener Memory-Scope. Projekt-Workspaces benutzen
`workspace`-Memory und die bestehende Projektmitgliedschaft. Das verhindert
eine zusaetzliche, schwer nachvollziehbare Hierarchie.

### Prompt-Zusammenstellung

Fuer jeden Agent-Turn wird ein stabiler Snapshot gebildet:

```text
Statische Agent-Dateien
  + veroeffentlichtes Organisations-Memory
  + veroeffentlichtes Memory des aktiven Workspaces
  + privates User-Memory
  + privates Memory des aktiven Agenten
```

- Ein Workspace-Eintrag wird nur im exakt passenden `workspaceId` geladen.
- Organisations-Memory wird nur in einem Workspace derselben Organisation und
  nie fuer externe Mitglieder geladen.
- Persoenliches Memory bleibt privat, auch wenn ein User in einem Team-Chat
  arbeitet.
- Nicht veroeffentlichte Vorschlaege werden nie in einen Prompt eingeblendet.
- Der Resolver begrenzt die Gesamtkapazitaet und waehlt nur relevante
  Collections und Eintraege aus.

## Rechte und Freigaben

### User- und Agent-Memory

- Der Eigentuer darf lesen, erstellen, bearbeiten und loeschen.
- Andere Nutzer, Organisationen und Workspaces erhalten keinen Zugriff.
- Ein Agent handelt immer im Rechtekontext des ausloesenden Users; ein Agent
  hat keine eigenstaendigen, weitergehenden Memory-Rechte.

### Workspace-Memory

| Aktion | Erforderliche vorhandene Berechtigung | Verhalten |
| --- | --- | --- |
| Lesen und Prompt-Einblendung | `canRead` | nur veroeffentlichte Eintraege |
| Vorschlag erstellen | `canWrite` | Eintrag bleibt `pending` |
| Veroeffentlichen, bearbeiten, loeschen | `canManage` | Aenderung wird auditiert und ist danach promptrelevant |
| Automatischer Review | Rechte des ausloesenden Users | erstellt bei `canWrite` nur einen Vorschlag |

Diese Freigabestufe ist absichtlich verpflichtend: Ein Chat eines Mitglieds
mit Schreibrecht darf nicht unbemerkt Fakten in den Prompt aller anderen
Mitglieder schreiben.

### Organisations-Memory

- Aktive interne Mitglieder duerfen veroeffentlichte Eintraege lesen.
- Mitglieder duerfen Vorschlaege einreichen.
- Veroeffentlichen, Bearbeiten, Loeschen und Sensitivitaetsrichtlinien
  erfordern Owner/Admin oder die neue explizite Permission
  `canManageOrganizationMemory`.
- `canWriteTeamWorkspace` wird dafuer nicht wiederverwendet: Dateischreiben
  im Team-Workspace ist nicht gleichbedeutend mit organisationsweitem
  Agentenkontext.
- Externe Mitglieder erhalten kein organisationsweites Memory.

## Datenmodell

### Collections

`memory_collections` bilden die in der UI sichtbaren Karten ab.

```text
id
scope_type: user | agent | workspace | organization
user_id?
agent_id?
organization_id?
workspace_id?
category
title
summary
sensitivity: standard | sensitive
status: active | archived
revision
created_by_user_id?
created_at
updated_at
```

Empfohlene Kategorien:

- User: `profile`, `preferences`, `communication`, `interests`, `tech-stack`,
  `recent-work`, `area`.
- Workspace/Organisation: `context`, `decisions`, `conventions`, `brand`.
- Agent: `agent-context`.

### Entries und Audit

```text
memory_entries
  id, collection_id, content, status: pending | published | archived
  source_session_id?, source_agent_id?, created_by_user_id?
  created_at, updated_at

memory_events
  id, entry_id, action, actor_type, actor_user_id?, session_id?
  reason, evidence_reference?, created_at
```

`memory_events` wird nicht in Agent-Prompts eingeblendet. Es stellt fuer Nutzer
und Admins nachvollziehbar dar, ob ein Eintrag manuell, durch einen Agenten,
einen automatischen Review oder einen Import entstanden ist.

## Automatisches Merken

### Prinzip

Automatisches Merken ist ein separater Hintergrundpfad nach einer erfolgreichen
Antwort. Es darf weder die Antwortlatenz erhoehen noch den aktiven Chatverlauf
mutieren.

Der Reviewer erhaelt nur:

- einen begrenzten relevanten Konversationsausschnitt,
- den aktuellen Memory-Snapshot und vorhandene Eintrags-IDs,
- den effektiven `AgentExecutionContext`,
- eine strikt strukturierte Ausgabeschnittstelle.

Er erhaelt keinen Shell-, Datei-, Browser-, Integrations- oder
Workspace-Schreibzugriff. Seine Ausgabe ist ein Kandidat, kein direkter
Datei-Write.

### Kandidatenschema

```text
action: add | update | archive | no_op
scope_type
collection_category
entry_id?                 # fuer update/archive
content
reason
evidence_reference
confidence
```

Der Memory-Service prueft serverseitig Scope, Berechtigung, Sensitivitaet,
Duplikate, Konflikte und Revision. Nur danach entsteht ein Eintrag oder ein
Vorschlag.

### Regeln

- Explizite Nutzerworte wie „merk dir“ sind starke Signale.
- Wiederholte Korrekturen, stabile Praeferenzen und bestaetigte Entscheidungen
  sind geeignete Kandidaten.
- Session-Zusammenfassungen, Logs, To-dos, Einmalaufgaben, grosse Toolausgaben,
  Secrets und fluechtige Zwischenstaende sind ausgeschlossen.
- Sensitive Fakten werden nie automatisch gespeichert, solange der User nicht
  explizit in den Memory-Einstellungen zugestimmt hat.
- Workspace- und Organisationskandidaten werden standardmaessig `pending`.
- Der Hintergrundjob ist budgetiert, rate-limitiert und wird bei einer neuen
  User-Nachricht abgebrochen.

## UI und Einstellungen

### Zentrale Memory-Seite

Neue Seite: `/settings?tab=memory`.

Sie ist der primaere Ort zum Anzeigen, Suchen, Bearbeiten, Archivieren,
Exportieren und Importieren von Memory. Der neue Punkt steht in der
Settings-Navigation unter Account.

```text
Memory
  [Mein Memory] [Aktueller Workspace] [Organisation] [Agent]

  You
    Preferences       Profil

  Topics
    Communication     Interests     Recent Work     Tech Stack

  Areas
    Canvas Notebook   weitere Areas

  Context
    Aktiver Workspace / Organisation / Agent
```

Eine Collection-Karte zeigt Titel, Kurzfassung, Anzahl der Eintraege,
Aktualisierungszeit, Scope, Status und Herkunft. Beim Oeffnen werden einzelne
Eintraege, ihre Historie sowie die zulassigen Aktionen sichtbar.

### Weitere Einstiegspunkte

- Workspace-Einstellungen erhalten eine Karte „Workspace Memory“, die auf
  `/settings?tab=memory&scope=workspace&workspaceId=...` verweist.
- Agent Settings ersetzen den `MEMORY.md`-Editor durch einen Link „Agent
  Memory verwalten“. Der Editor fuer `AGENTS.md`, `SOUL.md` und `TOOLS.md`
  bleibt bestehen.
- Chat-Toolruns zeigen „Memory aktualisiert“ bzw. „Memory-Vorschlag erstellt“
  und verlinken auf die konkrete Collection oder den Pending-Eintrag.

### Persoenliche Einstellungen

Die zentrale Seite enthaelt:

- automatisches Merken an/aus,
- sensible Themen an/aus (standardmaessig aus),
- Benachrichtigungen fuer gespeicherte und wartende Vorschlaege,
- Export und kontrollierten Import,
- vollstaendiges Loeschen des eigenen Memory.

## Migration

1. Neue Tabellen, Migrationen und den Scope-/Berechtigungsresolver einfuehren.
2. Bestehendes `USER.md` in User-Collections importieren.
3. Bestehendes `MEMORY.md` in private Agent-Collections importieren.
4. Ein Import-Protokoll speichern; doppelte Eintraege anhand normalisierten
   Inhalts vermeiden.
5. Nach erfolgreicher, bestaetigter Migration `USER.md` und `MEMORY.md` aus
   der Systemprompt-Zusammenstellung entfernen.
6. Alte Dateien als einmaligen Export behalten und anschliessend nicht mehr
   zur Laufzeit aktualisieren.

Migrationen muessen idempotent, wiederaufnehmbar und pro User/Agent isoliert
sein. Team- und Organisations-Memory werden nicht automatisch aus alten
privaten Dateien erzeugt.

## Umsetzungsschritte

1. **Memory-Vertrag und Tests:** Typen, Scope-Matrix, Statusmodell,
   Sensitivitaet und Rechte als Architektur-/Testvertrag festlegen.
2. **Persistenz:** Datenbankschema, migrationsfaehigen Memory-Service und
   Audit implementieren.
3. **Runtime:** Prompt-Resolver sowie das Memory-Tool auf den neuen Service
   umstellen; `USER.md`/`MEMORY.md` nur noch migrieren/exportieren.
4. **Team-Governance:** Workspace-/Organisation-Resolver, Pending-/Publish-
   Ablauf und neue Organisationspermission integrieren.
5. **Zentrale UI:** Memory-Tab, Collection- und Entry-Ansichten sowie
   Deep-Links aus Workspace, Agent Settings und Chat implementieren.
6. **Automatischer Review:** isolierten, budgetierten Kandidaten-Worker nach
   dem stabilen manuellen Pfad hinzufuegen.
7. **Migration und Rollout:** Importvorschau, opt-in bzw. bestaetigte
   Umschaltung, Export und Rueckfallstrategie bereitstellen.

Jeder Schritt wird einzeln abgeschlossen, getestet und committed, bevor der
naechste beginnt.

## Test- und Abnahmekriterien

- Ein User kann weder persoenliches noch Agent-Memory anderer User lesen.
- Ein Workspace-Mitglied mit `canRead` sieht nur veroeffentlichtes
  Workspace-Memory.
- Ein Mitglied mit `canWrite` kann einen Vorschlag, aber keine veroeffentlichte
  gemeinsame Erinnerung erzeugen.
- Nur `canManage` kann einen Workspace-Eintrag veroeffentlichen, bearbeiten
  oder loeschen.
- Externe Nutzer erhalten kein Organisations-Memory.
- Der Agent kann nur innerhalb seines effektiven User-/Workspace-Kontexts
  Memory vorschlagen oder aktualisieren.
- Persistierte Session-Summaries, Secrets und sensitive Fakten ohne Opt-in
  werden abgelehnt.
- Ein Memory-Snapshot bleibt innerhalb eines Turns stabil und beachtet das
  Prompt-Budget.
- Migrationen sind mehrfach ausfuehrbar, ohne Duplikate zu erzeugen.
- Die zentrale UI, Workspace-Deep-Link und Agent-Deep-Link werden per
  End-to-End-Test mit einem echten Team-Workspace und unterschiedlichen
  Berechtigungen geprueft.

## Offene Produktentscheidungen

Diese Punkte muessen vor der Implementierung gemeinsam entschieden werden:

1. Sollen Workspace-Mitglieder mit `canWrite` nach einer gewissen
   Vertrauensstufe direkt veroeffentlichen duerfen, oder bleibt Publish immer
   `canManage`-pflichtig?
2. Sollen Organisations-Admins die neue Permission
   `canManageOrganizationMemory` einzeln vergeben koennen, oder ist sie strikt
   Owner/Admin vorbehalten?
3. Wie lange bleiben `pending`-Vorschlaege sichtbar, bevor sie automatisch
   archiviert werden?
4. Soll Memory-Import aus anderen AI-Anbietern schon im ersten Release Teil
   der UI sein oder erst nach der stabilen Migration?
5. Welche sensiblen Kategorien muessen neben dem globalen Opt-in noch eine
   explizite Einzelbestaetigung brauchen?
6. Soll die erste Version Topics/Areas manuell anlegen oder bereits durch den
   Review-Worker vorschlagen lassen?
