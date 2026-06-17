# Workspace Switching UI und Agent-Kontext

Stand: 2026-06-17

## Zweck

Dieses Dokument konkretisiert die Frontend- und Runtime-Regeln fuer den Wechsel zwischen Personal Workspace und Team Workspace. Der Workspace-Wechsel ist ein globaler Arbeitskontext, muss aber bei Agent-Sessions kontrolliert zu einer neuen Session fuehren, damit ein laufender Chat nicht unbemerkt in einem anderen Workspace weiterarbeitet.

Diese Entscheidung ergaenzt die Aufgaben `10`, `12`, `13`, `14`, `15`, `16`, `21`, `23` und `24` im Aufgabenindex.

## Produktregel

Canvas Notebook hat einen aktiven Workspace pro User-Oberflaeche. Dieser aktive Workspace ist auf allen relevanten Oberflaechen sichtbar und umschaltbar.

Relevante Oberflaechen:

- Startseite Header,
- Chat Header,
- Notebook/File Browser Header,
- Studio Save-to-Workspace Flows,
- Automations Workspace-Auswahl,
- Todos mit Datei-/Workspace-Bezug,
- Public-Share-Verwaltung.

Wenn der aktive Workspace an einer Stelle gewechselt wird, muessen alle anderen Oberflaechen denselben globalen Workspace-Status sehen.

## Globaler Workspace State

Der Frontend-State darf nicht nur lokaler Component State sein. Es braucht einen gemeinsamen Workspace Store oder Provider.

Pflichtdaten:

- `activeWorkspaceId`
- `activeWorkspaceType`: `personal` oder `team`
- `activeWorkspaceName`
- `organizationId`
- `canWrite`
- `canShare`
- `lastUpdatedAt`

Der Store wird aus einem serverseitigen Workspace Resolver initialisiert. Local Storage darf nur als UI-Cache dienen, nicht als Berechtigungsquelle.

Serverseitig bleibt die Wahrheit:

- welche Workspaces der User sehen darf,
- welcher Workspace der Default ist,
- ob der User im Team Workspace schreiben darf,
- ob ein Workspace fuer die aktuelle Lizenz verfuegbar ist.

## Umschaltverhalten

Workspace Switching muss sich fuer den User aehnlich anfuehlen wie Agent Switching, aber mit klarer Session-Semantik.

Regeln:

1. Ein Workspace-Wechsel aktualisiert den globalen aktiven Workspace.
2. File Browser, Breadcrumbs, Uploads, Search und Workspace-Referenzen wechseln sofort auf den neuen Workspace.
3. Neue Agent-Chats verwenden immer den aktiven Workspace.
4. Eine bestehende Agent-Session behaelt ihren gespeicherten `workspaceId`.
5. Wenn der User im Chat Header den Workspace wechselt, wird eine neue Chat-Session im Ziel-Workspace gestartet.
6. Wenn der User ausserhalb des Chats den Workspace wechselt, wird die aktuelle Chat-Oberflaeche in den neuen Workspace versetzt und der aktive Chat auf eine neue/leere Session gesetzt.
7. Bereits laufende Sessions duerfen nicht stillschweigend in einen anderen Workspace migriert werden.
8. Queue, Runtime Status und laufende Tool-Ausfuehrungen muessen an die alte Session gebunden bleiben.

Damit ist ein Workspace-Wechsel eindeutig: Die App arbeitet global im neuen Workspace, aber historische oder laufende Agent-Sessions bleiben auditierbar und unveraendert ihrem urspruenglichen Workspace zugeordnet.

## Chat Header

Der Chat Header bekommt neben Session und Agent Selector einen Workspace Selector.

Mindestfunktionen:

- aktiven Workspace anzeigen,
- zwischen Personal und Team wechseln,
- Schreibberechtigung anzeigen,
- Team Workspace sichtbar deaktivieren, wenn Lizenz oder Permission fehlt,
- bei Wechsel neue Chat-Session starten,
- bestehende Session mit Workspace-Badge kennzeichnen.

UI-Verhalten:

- Desktop: Workspace Selector neben Agent Selector oder Session-Badge.
- Mobile: Workspace Selector in der kompakten Header-Zeile oder im Header-Details-Menue.
- Tooltip/Label zeigt, ob der Agent im Personal oder Team Workspace schreibt.

## Startseite

Die Startseite ist der primaere Ort, an dem der User seinen Arbeitskontext bewusst setzt.

Anforderungen:

- Workspace Switcher im oberen Header.
- Aktiver Workspace beeinflusst alle Tool Cards und Starter Prompts.
- Oeffnet der User Notebook, Chat, Studio oder Automations, wird der aktive Workspace mitgenommen.
- Bei Community/Single-User Betrieb wird der Switcher ausgeblendet oder zeigt nur Personal Workspace.

## File Browser

Der File Browser ist die sichtbarste Workspace-Flaeche und muss den globalen Workspace State setzen koennen.

Anforderungen:

- Workspace Selector im File Browser Header/Toolbar.
- Wechsel laedt den Dateibaum des neuen Workspace.
- `currentDirectory`, Search Query, Selection, Multi-Select und Preview werden beim Wechsel zurueckgesetzt oder workspace-spezifisch gespeichert.
- Uploads, Create, Rename, Delete, Copy und Public Share verwenden den aktiven `workspaceId`.
- Copy Personal <-> Team ist eine explizite Aktion, kein Nebeneffekt des Umschaltens.

## Agent Runtime

Der Agent lernt den aktiven Workspace nicht nur ueber UI-Text, sondern ueber den Runtime-Kontext.

Bei Session-Erstellung werden gespeichert:

- `workspaceId`
- `workspaceType`
- `organizationId`
- `userId`
- `agentId`

Jeder Turn bekommt im `ChatRequestContext` den Workspace-Kontext. Der Server validiert ihn gegen die gespeicherte Session. Wenn Client-Kontext und Session-Kontext nicht zusammenpassen, gewinnt die serverseitig gespeicherte Session.

Der System Prompt beschreibt:

- aktiven Workspace-Namen,
- Workspace-Typ,
- erlaubte Datei-Roots,
- ob Team-Schreibzugriff erlaubt ist.

Die Datei-Tools erzwingen denselben Workspace serverseitig. Der Prompt ist Orientierung, nicht Sicherheit.

Schreiben ist immer an den gespeicherten Workspace der Session gebunden. Explizite Cross-Workspace Reads koennen erlaubt sein, wenn sie auf den eigenen Personal Workspace oder einen berechtigten Team Workspace zeigen; fremde Personal Workspaces bleiben vollstaendig gesperrt.

## Andere Flows

### Studio

Studio-Outputs brauchen eine klare Zielauswahl:

- Save to active workspace,
- Save to personal workspace,
- Save to team workspace, wenn erlaubt.

Der Save-Dialog muss auch bei Batch-Auswahl explizit zeigen, wohin kopiert wird. In Team-Instanzen darf die API nicht mehr nur `targetPath` akzeptieren, sondern muss `targetWorkspaceId` und `targetPath` serverseitig validieren.

### Automations

Automations muessen beim Erstellen einen Workspace bekommen. Der aktive globale Workspace kann vorausgewaehlt werden, aber der gespeicherte Job besitzt seinen eigenen `workspaceId`.

### Todos

Todos mit Datei-Links muessen den Workspace anzeigen. Beim Erzeugen aus dem Agenten wird der Workspace der Session uebernommen.

### Public Shares

Public Shares zeigen Workspace, Pfad und spaeter Revision. Team-Workspace-Shares brauchen Team-Permission.

## Implementierungsreihenfolge

1. Workspace Resolver API: Workspaces und aktiven Default fuer User laden.
2. Globaler Workspace Store/Provider im Frontend.
3. Shared `WorkspaceSwitcher` und `WorkspaceBadge` Komponenten.
4. Startseite und Suite Header anzeigen den aktiven Workspace.
5. File Browser APIs und UI auf `workspaceId` umstellen.
6. Chat Header erhaelt Workspace Selector.
7. Session-Erstellung speichert `workspaceId`; Workspace-Wechsel im Chat startet neue Session.
8. Agent Runtime, System Prompt und File Tools nutzen den gespeicherten Session-Workspace.
9. Studio, Automations, Todos und Public Shares migrieren.

## Tests

Pflichttests fuer die Umsetzung:

- Workspace Store uebernimmt serverseitigen Default.
- Workspace-Wechsel im File Browser aktualisiert globalen State.
- Workspace-Wechsel im Chat startet eine neue Session.
- Bestehende Sessions behalten ihren `workspaceId`.
- Neue Chats nach globalem Wechsel verwenden den neuen Workspace.
- File API blockiert Zugriff auf fremde Workspace Roots.
- Team Workspace Switcher ist ohne Permission deaktiviert.
- Community Mode zeigt keinen irrefuehrenden Team Switcher.
