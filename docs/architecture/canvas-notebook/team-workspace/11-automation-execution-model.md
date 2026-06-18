# Automation Execution Model

Stand: 2026-06-18

## Zweck

Dieses Dokument konkretisiert Automations fuer Team-Instanzen: Ownership, Workspace-Scope, Service Actor, Secret-Nutzung, Approval, Webhooks, Offboarding, Retry-Verhalten und Audit.

Es ergaenzt die Aufgaben `21`, `22`, `26`, `29` und `30` im Aufgabenindex.

## Grundentscheidung

Automations sind strenger als interaktive Agent-Chats.

Regeln:

- Jede Automation hat genau einen primaeren `workspaceId`.
- Der primaere Workspace ist der einzige Schreib-Workspace.
- Automations sollen standardmaessig nicht mehrere Workspaces sammeln, crawlen oder zusammenfuehren.
- Multi-Workspace-Reads sind fuer V1 keine normale Member-Funktion.
- Wenn Multi-Workspace-Reads spaeter noetig werden, duerfen sie nur admin-created, explizit genehmigt, read-only und auditpflichtig sein.
- Fremde Personal Workspaces sind immer tabu.
- Jede Automation bleibt einem verantwortlichen User zugeordnet, auch wenn eine Organization Automation technisch ueber Service Actor laeuft.

## Automation-Typen

### Personal Automation

Personal Automations laufen im Auftrag eines Users.

Pflichtfelder:

- `scope = "personal"`
- `ownerUserId`
- `organizationId`
- `workspaceId`
- `agentId`
- `status`
- `triggerType`
- `createdByUserId`
- `lastEditedByUserId`

Regeln:

- Der Owner ist der fachliche Actor.
- Secrets kommen aus dem User-Scope des Owners.
- Personal Automations pausieren beim Offboarding oder Deaktivieren des Owners.
- Interne User duerfen Personal Automations fuer ihren eigenen Personal Workspace erstellen.
- Wenn eine Automation in den Team Workspace schreiben soll, ist sie keine normale Member-Personal-Automation mehr, sondern braucht Owner/Admin-Rechte und Team-Workspace-Permission.
- Ohne Team-Permission darf eine Personal Automation keinen Team Workspace schreiben.
- Lesen aus dem Team Workspace ist fuer Personal Automations nur nach der normalen Cross-Workspace-Read-Policy erlaubt und bleibt auditpflichtig.
- Personal Automations duerfen Organization-Secrets nicht nutzen.

### Organization Automation

Organization Automations laufen fuer die Organization, nicht fuer einen privaten User.

Pflichtfelder:

- `scope = "organization"`
- `organizationId`
- `serviceActorId`
- `responsibleUserId`
- `workspaceId`
- `agentId`
- `status`
- `triggerType`
- `createdByUserId`
- `approvedByUserId`
- `lastEditedByUserId`

Regeln:

- Nur Owner/Admins duerfen Organization Automations erstellen.
- Organization Automations duerfen in V1 nur im Team Workspace laufen.
- Der Runtime Actor ist ein Organization Service Actor.
- `responsibleUserId`, `createdByUserId`, `approvedByUserId` und `lastEditedByUserId` bleiben fuer Audit sichtbar.
- Secrets kommen nur aus Organization- oder erlaubtem System-/Managed-Scope.
- Organization Automations duerfen keine privaten User-Secrets verwenden.
- Wenn der verantwortliche User archiviert oder deaktiviert wird, pausiert die Automation und zeigt an, dass sie einem neuen User zugeordnet werden muss.

## Workspace Policy

V1-Default:

- Eine Automation hat genau einen `workspaceId`.
- Lesen und Schreiben erfolgen in diesem Workspace.
- Keine Automation darf eigenstaendig ueber mehrere Workspaces crawlen.
- Keine Automation darf fremde Personal Workspaces lesen.

Team Workspace:

- Personal Automations von Membern schreiben nicht in den Team Workspace.
- Organization Automation ist Team-Workspace-only und braucht Owner/Admin-Erstellung und Approval.
- Team Workspace Delete/Overwrite braucht riskante Aktion mit finalem Permission-Check.

Multi-Workspace-Ausnahme:

- Nur Owner/Admin darf eine Automation mit mehreren Read-Workspaces anlegen.
- Multi-Workspace bleibt read-only fuer Zusatz-Workspaces.
- Der primaere Workspace bleibt einziger Schreib-Workspace.
- Jede zusaetzliche Quelle muss explizit als Read-Grant gespeichert werden.
- Diese Funktion ist fuer V1 moeglichst auszuklammern und erst nach separater Review zu aktivieren.

## Service Actor

Organization Automations brauchen einen technischen Service Actor.

Empfohlenes Modell:

```txt
automation_service_actors
- id
- organizationId
- displayName
- status
- createdByUserId
- createdAt
- updatedAt
```

Run-Kontext:

```txt
automation_runs
- id
- automationId
- organizationId
- actorType: user | organization_service
- actorUserId?
- serviceActorId?
- workspaceId
- startedAt
- finishedAt
- status
```

Regeln:

- Service Actor ist keine normale Login-Identitaet.
- Service Actor darf nicht in UI als normaler User erscheinen.
- Service Actor kann keine privaten User-Secrets besitzen.
- Alle Aenderungen am Service Actor sind admin-only und auditpflichtig.

## Riskante Aktionen und Approval

Diese Aktionen brauchen fuer Automations besondere Freigabe:

- E-Mail senden,
- Public Link erstellen,
- Dateien loeschen,
- Dateien im Team Workspace ueberschreiben,
- externe API/MCP mit Seiteneffekten,
- kostenintensive AI-/Studio-Generierungen,
- Webhook-Ausloesung durch externe Systeme.

V1-Regel:

- Personal Automations duerfen riskante Aktionen nur im eigenen Scope und mit Owner-Permission ausfuehren.
- Organization Automations brauchen Admin-Approval.
- Riskante Writes pruefen direkt vor dem Commit aktuelle Permission und Status.

## Webhooks

Webhook-getriggerte Automations sind oeffentliche Angriffsoberflaechen.

Pflichtregeln:

- Jeder Webhook hat ein eigenes Secret.
- Webhook-Signatur wird serverseitig geprueft.
- Rate Limit pro IP, Webhook, Organization und optional User.
- Replay-Schutz ueber Timestamp/Nonce.
- Optional IP-Allowlist fuer Enterprise.
- Webhook-Payload wird mit Runtime-Schema validiert.
- Webhook darf nie direkt Tool-Parameter ungeprueft an den Agenten geben.

Anonyme Public Webhooks duerfen in V1 keinen Agent-Turn mit Schreibrechten starten.

## Keine Meta-Automations

Automations duerfen keine Automations erstellen, aendern, aktivieren oder loeschen.

Begruendung:

- schwer auditierbar,
- erhoeht Risiko von Endlosschleifen,
- erschwert Offboarding und Approval,
- kann Permissions indirekt ausweiten.

Automation-Verwaltung bleibt UI/API-Aktion eines berechtigten Users oder Admins.

## Offboarding

Der allgemeine Offboarding- und Recovery-Flow ist in `16-offboarding-and-recovery-policy.md` verbindlich beschrieben. Dieses Dokument konkretisiert nur die Automation-Folgen.

Personal Automations:

- pausieren sofort, wenn der Owner deaktiviert oder offboarded wird.
- Admin entscheidet: transferieren, loeschen, archivieren oder manuell reaktivieren.
- User-Secrets werden revoked; betroffene Automations bleiben disabled bis Reconnect.

Organization Automations:

- pausieren, wenn `responsibleUserId` archiviert oder deaktiviert wird.
- zeigen Admins an, dass ein neuer verantwortlicher User zugeordnet werden muss.
- werden reviewpflichtig, wenn `createdByUserId`, `approvedByUserId` oder `lastEditedByUserId` offboarded wird.
- werden pausiert, wenn Approval nicht mehr gueltig ist oder benoetigte Organization-Secrets revoked sind.

## Retry, Fehler und Schleifen

Regeln:

- Jede Automation hat eine explizite Retry-Policy.
- Nach wiederholten Fehlern wird sie automatisch pausiert.
- Fehler erzeugen Notifications an Owner oder Admins.
- Keine unbounded Retries.
- Keine Selbsttrigger-Schleifen ohne Loop-Schutz.
- Datei-/Webhook-/E-Mail-Trigger muessen Deduplication Keys speichern.

Empfohlene Mindestfelder:

```txt
retryPolicyJson
maxConsecutiveFailures
consecutiveFailureCount
lastFailureAt
lastSuccessAt
nextRunAt
dedupeKey
```

## UI

Die UI trennt:

- `Meine Automations`,
- `Organization Automations`.

Regeln:

- Normale User sehen und verwalten eigene Personal Automations.
- Owner/Admins sehen Organization Automations.
- Organization Automation Editor zeigt Service Actor, Workspace, Secrets, Trigger, riskante Aktionen und Approval-Status.
- Organization Automation Editor zeigt den verantwortlichen User und blockiert Aktivierung ohne gueltigen `responsibleUserId`.
- Team-/Organization-Automations duerfen nicht in derselben UI-Flaeche wie private Automations unklar vermischt werden.

## Audit

Zu auditieren:

- create/update/delete/pause/resume,
- Approval/Revocation,
- Trigger-Eingang,
- Run Start/Ende,
- Tool-Calls,
- Secret-Refs,
- WorkspaceId,
- ServiceActorId oder ownerUserId,
- responsibleUserId,
- riskante Aktion und finaler Permission-Check,
- Offboarding-Entscheidung.

Audit speichert keine Secret-Werte und keine grossen Tool-Payloads.

## Tests

Pflichttests:

- Member kann Personal Automation im eigenen Personal Workspace erstellen.
- Member kann keine Organization Automation erstellen.
- Owner/Admin kann Organization Automation erstellen und approven.
- Personal Automation nutzt nur User-Secrets des Owners.
- Organization Automation nutzt keine User-Secrets.
- Personal Automation pausiert beim Offboarding des Owners.
- Organization Automation pausiert, wenn der verantwortliche User archiviert wird.
- Organization Automation kann erst nach Zuordnung eines neuen verantwortlichen Users reaktiviert werden.
- Organization Automation wird reviewpflichtig, wenn Approval-User offboarded wird.
- Organization Automation kann nur Team Workspace als primaeren Workspace speichern.
- Automation hat genau einen Schreib-Workspace.
- Multi-Workspace Read ist fuer normale User blockiert.
- Webhook ohne gueltige Signatur wird blockiert.
- Webhook ist rate-limited.
- Automation darf keine Automation erstellen oder aendern.
- Wiederholte Fehler pausieren die Automation.
- Riskante Aktionen pruefen Permission direkt vor Commit.
