# Canvas Notebook Memory System Plan

Stand: 2026-08-28

## Ziel und Produktentscheidung

Canvas Notebook ersetzt die laufzeitrelevanten Prompt-Dateien `USER.md` und
`MEMORY.md` durch ein datenbankbasiertes Memory-System. Das System speichert
kuratierten, langlebigen Kontext mit eindeutiger Eigentuemlichkeit,
Berechtigungen, Audit-Herkunft und gezielter Prompt-Einblendung.

Memory wird im Normalbetrieb vollstaendig durch den Assistant und einen
isolierten Memory-Manager gepflegt. Der User muss keine Memory-Dateien und
keine Datenbankeintraege selbst schreiben. Die UI dient primaer der
Inspektion, Korrektur, Freigabe und Kontrolle der Automatik.

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
  id, collection_id, semantic_key?, content
  status: pending | published | archived
  priority: 0..100, pinned, sensitivity, confidence?
  estimated_tokens
  source_session_id?, source_message_id?, source_agent_id?
  created_by_actor_type, created_by_user_id?
  last_confirmed_at, last_used_at?, revision
  created_at, updated_at

memory_events
  id, entry_id, action, actor_type, actor_user_id?, session_id?
  source_message_id?, decision_code?, created_at
```

`memory_events` wird nicht in Agent-Prompts eingeblendet. Es stellt fuer Nutzer
und Admins nachvollziehbar dar, ob ein Eintrag manuell, durch einen Agenten,
einen automatischen Review oder einen Import entstanden ist.

`semantic_key` identifiziert eine bekannte, aktualisierbare Aussage wie
`communication.preferred_response_language`. Eine spaetere Korrektur ersetzt
oder archiviert den bisherigen Wert, statt einen widerspruechlichen zweiten
Eintrag anzulegen. Fuer freie Areas darf der Memory-Service einen stabilen
Schluessel aus Scope, Kategorie und normalisiertem Inhalt bilden.

Es werden keine Gedankengaenge, Chain-of-Thought-Inhalte oder freien
Review-Begruendungen gespeichert. `decision_code` ist lediglich ein kurzer,
technischer Auditwert wie `explicit_user_preference`, `duplicate`,
`superseded` oder `sensitive_without_opt_in`.

### Feldverantwortung

| Komponente | Schreibt |
| --- | --- |
| Runtime und Job-Erzeuger | Session-, Message- und Turn-Referenz sowie den Idempotency-Key |
| isolierter Memory-Manager | strukturierte Kandidaten: Aktion, Kategorie, `semantic_key`, kompakter Inhalt, Prioritaet, Sensitivitaet und Confidence |
| serverseitiger Memory-Service | konkrete Scope-IDs, Collection, Rechteentscheidung, Status, Deduplizierung, Revision und Audit-Event |
| Datenbank und Service-Defaults | IDs, Zeitstempel, normalisierte Hashes und Token-Schaetzung |

`userId`, `agentId`, `workspaceId` und `organizationId` stammen ausschliesslich
aus der gespeicherten Session und dem effektiven `AgentExecutionContext`. Das
Modell darf einen Scope vorschlagen, aber niemals verbindliche Scope-IDs oder
Berechtigungen setzen.

### Review-Jobs

Automatische Reviews werden nicht nur als In-Memory-Event gestartet, sondern
dauerhaft eingeplant:

```text
memory_review_jobs
  id, user_id, session_id, source_assistant_message_id
  from_message_sequence, through_message_sequence
  trigger_type: turn_interval | idle | session_close | maintenance
  scheduled_for?, status
  attempts, lease_until?, error_code?
  created_at, started_at?, completed_at?
```

Die Kombination aus Session und dem geschlossenen Sequenzbereich ist eindeutig.
Ein Job kann nach Prozessneustart oder Providerfehler wiederholt werden, ohne
Memory-Eintraege doppelt anzulegen. Ueberlappende Turn-, Idle- und
Session-Close-Trigger werden auf denselben noch ungeprueften Bereich
dedupliziert.

## Automatisches Merken

### Prinzip

Automatisches Merken ist ein separater Hintergrundpfad nach erfolgreichen
Antworten. Jeder geeignete Turn wird durch einen dauerhaften Review-Checkpoint
abgedeckt. Ein Modellreview verarbeitet immer den noch ungeprueften Delta-
Bereich seit dem letzten erfolgreichen Review und darf weder die
Antwortlatenz erhoehen noch den aktiven Chatverlauf mutieren.

Das Vorgehen ist von Hermes inspiriert, aber fuer Canvas erweitert: Hermes
zaehlt User-Turns, startet standardmaessig nach zehn Turns einen isolierten
Hintergrundreview nach der Antwort und erlaubt dafuer ein separates
Provider-/Modell-Paar. Canvas uebernimmt verbindlich denselben Zehn-Turn-
Rhythmus und den isolierten Review, verwendet aber eine dauerhafte Job-Queue
statt eines rein best-effort Hintergrundthreads.

### Review-Rhythmus

- Nach jeweils zehn neuen User-Turns seit dem letzten erfolgreichen Review wird
  sofort ein Review-Job fuer den gesamten noch ungeprueften Delta-Bereich
  eingeplant. Tool-Loops, synthetische Fortsetzungen und Assistant-Nachrichten
  erhoehen diesen Zaehler nicht.
- Nach jeder erfolgreichen Assistant-Antwort wird ein Idle-Flush fuer 15
  Minuten spaeter geplant beziehungsweise auf diesen Zeitpunkt verschoben.
- Bleibt der Chat 15 Minuten ohne neue User-Nachricht, werden auch verbleibende
  ein bis neun Turns reviewed.
- Beim Archivieren oder einem expliziten Session-Close wird ein vorhandener
  Restbereich sofort eingeplant.
- Erreichen der Zehn-Turn-Schwelle und Idle/Close denselben Bereich, wird nur
  ein Job ausgefuehrt.

Der Zehn-Turn-Rhythmus und der 15-Minuten-Idle-Flush sind feste V1-
Produktwerte und keine eigene User-Konfiguration. Dadurch bleibt die
Kostenlogik fuer alle Runtimes vorhersehbar. Der User konfiguriert weiterhin
das dafuer verwendete Memory-Manager-Modell.

Ein explizites „merk dir“ darf bereits im aktiven Turn ueber das `memory`-Tool
gespeichert werden. Der spaetere Review erkennt den bestehenden Eintrag und
erzeugt kein Duplikat.

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
scope_hint
collection_category
semantic_key?
entry_id?                 # fuer update/archive
content
priority
sensitivity
evidence_message_ids
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
- Ein neuer User-Turn verschiebt nur den noch nicht gestarteten Idle-Flush. Ein
  bereits laufender Review arbeitet auf seinem unveraenderlichen
  `through_message_sequence`-Snapshot weiter. Nicht abgeschlossene Jobs bleiben
  wiederaufnehmbar.
- Der Memory-Manager darf nur Fakten verwenden, die durch User-Aussagen,
  bestaetigte Entscheidungen oder verlaessliche Toolresultate belegt sind.
  Behauptungen ausschliesslich aus einer Assistant-Antwort sind keine Quelle.

### Bestehendes Memory-Tool

Das einzelne Tool `memory` bleibt erhalten und wird auf den neuen
datenbankbasierten Memory-Service umgestellt:

- Die Aktionen `read`, `add`, `update` und `delete` bleiben fuer Kompatibilitaet
  bestehen; serverseitig darf `delete` als archivierte, auditierbare Mutation
  umgesetzt werden.
- Die Targets werden auf `user`, `agent`, `workspace` und `organization`
  erweitert. Konkrete IDs kommen immer aus dem Runtime-Kontext.
- Workspace- und Organisationsmutationen beachten denselben Pending-/Publish-
  Ablauf wie automatische Reviews.
- Ein optionaler bisheriger `reason`-Parameter wird waehrend der Umstellung nur
  noch als veraltet akzeptiert und nicht persistiert; anschliessend wird er aus
  dem Tool-Schema entfernt.
- Das Tool und der automatische Reviewer verwenden denselben Memory-Service,
  dieselben Limits und dieselbe Deduplizierung.

## Begrenzung, Priorisierung und laufende Pflege

### Speicher und Prompt-Projektion sind getrennt

Die Datenbank darf mehr Memories enthalten, als ein Agent in einem Turn sieht.
Der Prompt-Resolver erzeugt fuer jeden Turn eine begrenzte Projektion statt
alle aktiven Eintraege zu laden.

- Ein Memory-Eintrag soll atomar sein und moeglichst unter 400 Zeichen bleiben;
  das harte V1-Limit betraegt 800 Zeichen.
- `estimated_tokens` wird bei jeder Mutation neu berechnet.
- `memory_prompt_max_tokens` ist eine User-Einstellung. Der empfohlene
  Ausgangswert ist 2.000 Tokens; effektiv gilt zusaetzlich hoechstens zehn
  Prozent des nutzbaren Modell-Kontextfensters und ein hartes Maximum von
  4.000 Tokens.
- Collections liefern eine kurze Zusammenfassung und nur die am besten
  bewerteten atomaren Eintraege.
- Pending-, archivierte und nicht zugelassene sensible Eintraege werden nie in
  den Prompt eingeblendet.

Die Auswahl kombiniert:

1. Relevanz fuer den aktuellen User-Turn,
2. manuelles `pinned` und serverseitige Prioritaet,
3. Aktualitaet und `last_confirmed_at`,
4. Scope-Naehe zum aktiven Workspace und Agenten,
5. Confidence und verbleibendes Token-Budget.

Die UI kann nach Prioritaet, Aktualitaet und letzter Verwendung sortieren. Ein
`last_used_at`-Update darf gesammelt geschrieben werden, damit Prompt-Aufbau
nicht bei jedem Eintrag einzelne Datenbankwrites erzeugt.

### Maintenance-Reviews

Der Memory-Manager fuehrt neben der Erkennung neuer Fakten wiederkehrende
Pflegelaeufe aus. Sie duerfen:

- Duplikate zusammenfassen,
- widerspruechliche Werte ueber `semantic_key` ersetzen,
- lange Eintraege kuerzen oder in atomare Eintraege teilen,
- Prioritaeten und `last_confirmed_at` aktualisieren,
- alte, niedrig priorisierte Memories archivieren,
- Collection-Zusammenfassungen neu erzeugen.

Automatische Pflege loescht Eintraege nicht endgueltig. Archivierte Eintraege
bleiben inspizierbar und koennen wiederhergestellt werden. `pinned`-Eintraege
werden weder automatisch archiviert noch inhaltlich zusammengefuehrt.

Ein Maintenance-Review startet periodisch sowie dann, wenn eine Collection
70 Prozent ihres konfigurierten Speicher- oder Prompt-Budgets erreicht. Seine
Aenderungen laufen durch denselben Berechtigungs- und Audit-Service wie neue
Memories.

## Memory-Manager-Modell

Der Memory-Manager verwendet eine eigene, leichte Runtime-Auswahl und ist nicht
automatisch an das Modell des aktiven Chats gebunden.

Die Auswahl wird nicht global vorkonfiguriert. Jeder User muss in
`/settings?tab=memory` explizit eine bereits installierte Provider-Verbindung
und ein dafuer freigegebenes Modell auswaehlen. API-Keys werden nicht im
Memory-System gespeichert; die Auswahl referenziert die bestehende zentrale
Provider-Installation und den Runtime-Modellkatalog.

Konfigurierbare User-Werte:

```text
automatic_memory_enabled
provider_installation_id
model_id
memory_prompt_max_tokens
sensitive_memory_enabled
```

- Ohne ausgewaehltes Modell bleiben automatische Reviews sichtbar im Zustand
  `awaiting_model_configuration`; es gibt keinen stillen Rueckfall auf das
  teurere Chatmodell.
- Das direkte `memory`-Tool funktioniert weiterhin, weil seine
  Datenbankmutationen kein separates Review-Modell benoetigen.
- Der Reviewer erhaelt nur den Delta-Ausschnitt seit dem letzten erfolgreichen
  Review, relevante bestehende Eintraege und ein kleines strukturiertes
  Ausgabelimit.
- Fuer Workspace-Kandidaten gilt in V1 die Modellkonfiguration des ausloesenden
  Users. Eine zentral finanzierte Organisationskonfiguration kann spaeter
  ergaenzt werden.

## UI und Einstellungen

### Zentrale Memory-Seite

Neue Seite: `/settings?tab=memory`.

Sie ist der primaere Ort zum Anzeigen, Suchen, Korrigieren, Archivieren,
Freigeben, Exportieren und Importieren von Memory. Manuelles Erstellen ist eine
optionale Nebenfunktion, nicht der erwartete Normalfall. Der neue Punkt steht
in der Settings-Navigation unter Account.

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
- Provider- und Modellauswahl fuer den Memory-Manager,
- Anzeige des festen Rhythmus: alle zehn User-Turns plus 15-Minuten-Idle-Flush,
- maximales Memory-Prompt-Budget,
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

1. **Memory-Vertrag und Tests:** Typen, Scope-Matrix, Statusmodell, Limits,
   Sensitivitaet und Rechte als Architektur-/Testvertrag festlegen.
2. **Persistenz:** Datenbankschema, User-Modellkonfiguration, dauerhafte
   Review-Jobs, migrationsfaehigen Memory-Service und Audit implementieren.
3. **Automatische Runtime:** das bestehende Memory-Tool auf den Service
   umstellen und den isolierten, wiederaufnehmbaren Review-Worker integrieren.
4. **Prompt-Projektion:** budgetierten Relevanz-Resolver, Priorisierung und
   stabile Memory-Snapshots pro Turn implementieren.
5. **Team-Governance:** Workspace-/Organisation-Resolver, Pending-/Publish-
   Ablauf und neue Organisationspermission integrieren.
6. **Zentrale UI:** Memory-Manager-Konfiguration, Collection-/Entry-Ansichten,
   Reviewstatus und Deep-Links aus Workspace, Agent Settings und Chat umsetzen.
7. **Migration und Rollout:** `USER.md`/`MEMORY.md` importieren, die Runtime
   erst nach erfolgreichem Auto-Review- und Prompt-Budget-Nachweis umstellen
   sowie Export und Rueckfallstrategie bereitstellen.

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
- Ein Eintrag ueber 800 Zeichen wird abgelehnt oder vor der Persistierung
  atomisiert.
- Prioritaet, Aktualitaet und Relevanz bestimmen reproduzierbar die begrenzte
  Prompt-Projektion; die Gesamtausgabe ueberschreitet nie das effektive
  Token-Budget.
- Jeder eingeplante Review ist idempotent und wird nach Prozess- oder
  Providerfehler wiederaufgenommen.
- Vor dem zehnten User-Turn erfolgt ohne Idle/Close kein periodischer
  Modellreview; der zehnte Turn plant genau einen Delta-Review ein.
- Ein Chat mit ein bis neun ungeprueften Turns plant nach 15 Minuten Inaktivitaet
  genau einen Rest-Review ein; eine neue Nachricht vor Ablauf verschiebt ihn.
- Turn-, Idle- und Session-Close-Trigger koennen denselben Nachrichtenbereich
  nicht doppelt verarbeiten.
- Ohne User-Modellkonfiguration wird kein verborgenes Ersatzmodell verwendet;
  der Reviewstatus bleibt sichtbar und das direkte Memory-Tool funktioniert.
- Maintenance-Reviews koennen Eintraege kuerzen, zusammenfassen und archivieren,
  aber keine gepinnten Eintraege automatisch veraendern.
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
