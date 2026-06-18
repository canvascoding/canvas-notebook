# Offboarding und Recovery Policy

Stand: 2026-06-18

## Zweck

Dieses Dokument konkretisiert, wie User in Team-Instanzen deaktiviert, archiviert und bei Bedarf kontrolliert wiederhergestellt oder eingesehen werden. Es trennt normales Offboarding von einem expliziten Owner-/Admin-Recovery-Flow.

Es ergaenzt die Aufgaben `22`, `29` und `30` im Aufgabenindex.

## Grundentscheidung

User werden in Team-Instanzen nicht hart geloescht. Sie werden deaktiviert und archiviert, damit Audit, Creator-Referenzen, Studio Assets, To-dos, Automations und historische Agent-/File-Aktionen nachvollziehbar bleiben.

Regeln:

- Offboarding ist ein Workflow, keine direkte Delete-Aktion.
- Der letzte Owner oder letzte admin-faehige User darf nicht deaktiviert werden.
- Offboarding erzeugt einen Review-Report, bevor es final angewendet wird.
- Private Credentials und OAuth-Verbindungen werden revoked oder geloescht.
- Historische Referenzen auf den User bleiben erhalten.
- Der Personal Workspace des Users bleibt archiviert erhalten.
- Zugriff auf den archivierten Personal Workspace ist nur ueber einen Owner-/Admin-Recovery-Flow mit Warnung und Audit erlaubt.

## Offboarding Preflight

Vor dem finalen Offboarding muss die App mindestens pruefen:

- Ist der User letzter Owner/Admin oder letzter admin-faehiger Recovery-User?
- Hat der User aktive Personal Automations?
- Ist der User `responsibleUserId`, `createdByUserId`, `approvedByUserId` oder `lastEditedByUserId` von Organization Automations?
- Hat der User aktive Agent-Sessions oder laufende Tool-/Background-Jobs?
- Hat der User offene To-dos oder zugewiesene Aufgaben?
- Besitzt der User user-owned Agents, Prompts oder Tool-Stacks?
- Hat der User OAuth-/Composio-/E-Mail-/Telegram-/MCP-Verbindungen?
- Gibt es Public Links, Dateien oder Studio Outputs, die auf Aktionen dieses Users verweisen?
- Gibt es offene Exporte, Imports, Backups oder Restore-Jobs des Users?

Der Preflight erzeugt eine Review-Liste mit Blockern, Warnungen und vorgeschlagenen Aktionen.

## User Status

Empfohlene Statuswerte:

- `active`: normaler User.
- `disabled`: Login und neue Sessions blockiert, historische Daten bleiben.
- `archived`: offboarded; keine normale Nutzung, historische Referenzen bleiben sichtbar.
- `recovery_locked`: archivierter User mit Personal Workspace, der nur ueber Recovery-Flow erreichbar ist.

Ein deaktivierter oder archivierter User:

- kann sich nicht einloggen,
- kann keine neuen Agent-Sessions starten,
- hat keine aktiven User-Secrets,
- besitzt weiterhin historische Creator-/Actor-Referenzen.

## Personal Workspace Recovery

Der Personal Workspace eines offboarded Users bleibt erhalten, ist aber nicht normal im File Browser sichtbar.

Regeln:

- Normaler Zugriff durch andere User ist verboten.
- Owner/Admin-Zugriff ist nur ueber einen expliziten Recovery-Flow erlaubt.
- Recovery-Flow zeigt Warnung und Zweckabfrage.
- Recovery-Flow schreibt Audit Event mit `requestedByUserId`, `targetUserId`, `workspaceId`, Zweck, Aktion und Zeit.
- Recovery kann read-only Browse, Export oder gezielte Copy-to-Team erlauben.
- Agenten duerfen nicht direkt im archivierten Personal Workspace arbeiten.
- Wenn Dateien weiter genutzt werden sollen, muessen sie kontrolliert in einen aktiven Workspace kopiert werden.

Recovery-Aktionen:

- `inspect_metadata`: nur Groessen, Pfade, Dateiliste, keine Inhalte.
- `export_personal_workspace`: archivierten Personal Workspace exportieren.
- `copy_selected_to_team`: explizit ausgewaehlte Dateien/Ordner in Team Workspace kopieren.
- `restore_to_user`: spaeter optional, wenn ein User reaktiviert wird.

## Agents und Sessions

User-owned Agents:

- werden deaktiviert oder archiviert.
- koennen vor Offboarding als Organization Template kopiert oder an einen anderen User uebertragen werden.
- private Secrets, MCP-Verbindungen, Plugins oder Mailboxen des alten Users werden nie mit uebertragen.

Aktive Sessions:

- werden beendet oder auf read-only Historie gesetzt.
- duerfen nach Credential-Revocation keine Tools mehr ausfuehren.
- behalten Audit- und Usage-Verlauf.

## Automations

Personal Automations:

- pausieren sofort beim Offboarding.
- muessen pro Automation geloescht, archiviert oder auf einen anderen User migriert werden.
- benoetigen nach Migration neue User-Secrets/Reconnections.

Organization Automations:

- pausieren, wenn der User `responsibleUserId` ist.
- zeigen Admins, dass ein neuer verantwortlicher User zugeordnet werden muss.
- koennen erst nach Neuzuordnung und Review reaktiviert werden.
- werden reviewpflichtig, wenn der User Creator, Approver oder letzter Editor war.
- werden pausiert, wenn Approval, Secret oder Workspace-Permission nicht mehr gueltig ist.

## To-dos und Zuweisungen

To-dos mit `assigneeUserId` des offboarded Users brauchen eine Entscheidung:

- neu zuweisen,
- archivieren,
- loeschen,
- als unassigned offen lassen, wenn die Organization Policy das erlaubt.

Creator-Referenzen bleiben historisch erhalten. Die App darf To-dos nicht stillschweigend dem Admin zuweisen.

## Credentials, MCP, Plugins und Channels

Beim Offboarding:

- User-Secrets loeschen oder revoken.
- OAuth Tokens revoken, soweit Provider das erlaubt.
- E-Mail-/Composio-/Telegram-/MCP-Verbindungen deaktivieren.
- User-MCP-Transport-State und Plugin-Runtime-State deaktivieren.
- Organization-Secrets bleiben bestehen, werden aber auf Abhaengigkeiten geprueft.
- Keine Organization-Connection darf still als Fallback fuer fehlende User-Credentials eingesetzt werden.

## Studio Assets

Studio Assets bleiben erhalten:

- Assets bleiben organizationweit sichtbar.
- `createdByUserId` bleibt auf den archivierten User referenziert.
- UI zeigt Archiv-/Deaktiviert-Status am Creator.
- Offboarding loescht keine Studio Assets automatisch.

## Audit

Zu auditieren:

- Offboarding gestartet.
- Preflight erzeugt.
- Entscheidungen fuer Automations, To-dos, Agents und Workspace-Recovery.
- Credential-/OAuth-Revocation.
- User deaktiviert/archiviert.
- Recovery-Flow gestartet.
- Recovery-Export oder Copy aus archiviertem Personal Workspace.
- Abbruch oder Fehler.

Audit Events bleiben klein und referenziell. Inhalte aus Personal Workspaces werden nicht in Audit Logs kopiert.

## Tests

Pflichttests:

- Letzter Owner/Admin kann nicht offboarded werden.
- Offboarding erzeugt Preflight mit Automations, To-dos, Agents, Credentials und Workspace-Hinweisen.
- User wird deaktiviert und kann sich nicht mehr einloggen.
- User-Secrets/OAuth werden revoked oder disabled.
- Personal Automations pausieren.
- Organization Automations pausieren, wenn der verantwortliche User offboarded wird, und werden reviewpflichtig, wenn Creator/Approver/Editor offboarded wird.
- To-dos werden nicht stillschweigend dem Admin zugewiesen.
- Studio Assets bleiben sichtbar und zeigen archivierten Creator.
- Archivierter Personal Workspace ist nicht normal sichtbar.
- Zugriff auf archivierten Personal Workspace geht nur ueber Recovery-Flow mit Audit.
- Recovery Copy schreibt in aktiven Ziel-Workspace und laeuft ueber Workspace Resolver.

## Noch separat zu klaeren

- Ob reaktivierte User ihren alten Personal Workspace direkt wiederbekommen oder ob ein Restore-Schritt noetig ist.
- Wie lange archivierte User im UI sichtbar bleiben.
- Welche Offboarding-Entscheidungen blockierend sind und welche nachtraeglich korrigierbar bleiben.
