# Canvas Notebook Team Workspace Plan

Stand: 2026-06-17

## Zielbild

Canvas Notebook soll fuer Team- und Managed-Use-Cases nicht mehr als eine einzelne private Notebook-Instanz pro Mitarbeiter gedacht werden. Das bessere Zielbild ist eine Canvas Notebook Team-Instanz pro Organization, in der mehrere User gemeinsam arbeiten koennen.

Das Control Plane bleibt fuer Provisioning, Lizenzierung, Billing, Monitoring, Updates und Organization-Verwaltung zustaendig. Die eigentliche Team-Workspace-Logik muss in Canvas Notebook selbst umgesetzt werden, weil dort die Dateioperationen, Agent-Sessions und User-Kontexte entstehen.

Produktentscheidung:

- Community/Free: Single User, lokaler Workspace, keine Teamfunktionen.
- Team/Managed: Multi-User, Organization, persoenliche Workspaces, geteilter Team Workspace, Audit Trail, Backups und zentrale Governance.
- Enterprise/On-Prem: gleiche Teamlogik, aber Stripe optional deaktiviert und Betrieb auf Kundeninfrastruktur moeglich.

Damit wird Teamfaehigkeit ein echtes Upsell-Feature statt nur ein Infrastrukturdetail.

## Warum nicht ein Server pro Mitarbeiter

Der aktuelle Ansatz mit einer kleinen VM pro Mitarbeiter liefert einfache technische Isolation, erzeugt aber fuer Teams zu viel operative Komplexitaet:

- Ubuntu- und Security-Updates pro Mitarbeiter-VM.
- Canvas Notebook Versionsdrift zwischen Nutzern.
- Hoehere Infrastrukturkosten pro Team.
- Mehr Backup-, Monitoring- und Support-Aufwand.
- Schwieriger gemeinsamer Dateistand, weil viele lokale Wahrheiten synchronisiert werden muessen.
- Teamfunktionen wie Knowledge Base, Skills, Agents und geteilte Assets muessen ueber Instanzgrenzen hinweg koordiniert werden.

Fuer Marketing-Agenturen und technische Teams ist der eigentliche Mehrwert nicht "jeder Nutzer bekommt einen Server", sondern ein gemeinsamer AI-Produktionsraum mit klarer Governance:

- gemeinsame Dateien und Assets,
- zentrale Knowledge Base,
- Rollen und Rechte,
- nachvollziehbare Agent-Aenderungen,
- zentrale Skills/Plugins,
- Backups und Restore,
- Modellnutzung und Abrechnung auf Organization-Ebene.

## Zielarchitektur fuer Team-Instanzen

Eine Team-Instanz ist eine Canvas Notebook Installation fuer genau eine Organization. Innerhalb dieser Instanz verwaltet Better Auth mehrere User, Rollen und Sessions.

Die Instanz enthaelt mehrere Workspace-Typen:

```txt
/data/workspaces/
  personal/
    {userId}/
      files/
      trash/
      revisions/
  team/
    {organizationId}/
      files/
      trash/
      revisions/
```

Die konkrete physische Pfadstruktur wird in `07-filesystem-migration-and-write-policy.md` verbindlich konkretisiert. Wichtig ist die fachliche Abstraktion:

- `personal`: privater Workspace eines einzelnen Users.
- `team`: geteilter Workspace fuer alle berechtigten User der Organization.
- `project`: optional spaeter fuer Kunden, Projekte oder Zugriffgruppen.

Die App darf nicht mehr davon ausgehen, dass es genau einen globalen Workspace gibt.

User-nahe Runtime-, Secret-, MCP-, Skill- und Plugin-Daten werden separat unter `/data/users/{userId}/...` gespeichert. Organization-Templates, geteilte Organization-Secrets und Policies liegen unter `/data/organizations/{organizationId}/...`; Managed-/System-Secrets liegen unter `/data/system/...`. Diese Trennung ist in `08-user-scoped-secrets-runtime.md` verbindlich.

## Datenbank- und Installer-Grundentscheidung

Canvas Notebook laeuft heute mit SQLite unter `/data/sqlite.db`. Das bleibt fuer Community, lokale Entwicklung und einfache Single-User-Installationen erlaubt. Fuer Team-/Advanced-Features wird Postgres Pflicht.

Produktentscheidung:

- SQLite: Community/Free, lokale Entwicklung, einfache Single-User-Installationen und optional `managed-single` ohne Team-RAG/Collaboration.
- Postgres: Pflicht fuer `managed-team`, Team Workspace als produktiver Shared Workspace, Team/Organization Knowledge, Embeddings, RAG, Knowledge Graph, echte Collaboration und Managed/Enterprise-Backups.
- pgvector: vorgesehener Vektorpfad fuer produktive Embeddings und RAG.

Empfohlene Provider-ENV:

```env
CANVAS_DATABASE_PROVIDER=sqlite
```

oder:

```env
CANVAS_DATABASE_PROVIDER=postgres
DATABASE_URL=postgresql://canvas:<password>@postgres:5432/canvas_notebook
CANVAS_POSTGRES_VECTOR_ENABLED=true
```

Team-/Advanced-Lizenzen duerfen nicht nur durch lokale Boolean-ENV aktiviert werden. Canvas Notebook muss `CANVAS_DATABASE_PROVIDER`, `CANVAS_DEPLOYMENT_MODE` und `CANVAS_LICENSE_CERT` zusammen auswerten. Wenn ein Teamplan mit SQLite startet, muss Setup/Health blockieren und Postgres-Provisioning oder SQLite-zu-Postgres-Migration verlangen.

Die Installation betrifft zwei Codebasen:

- Canvas Notebook CLI und App in diesem Repository.
- Control Plane Provisioning im Repository `../canvas-control-plane`.

Beide Installer muessen dieselbe Entscheidung umsetzen: sobald Team/Advanced/RAG gewaehlt wird, wird eine Compose-Konfiguration mit App-Container plus Postgres-Container und pgvector-faehiger Datenbank erzeugt. Produktions-Compose soll kein ungebundenes `latest`-Tag fuer Postgres verwenden, sondern eine aktuell unterstuetzte, gepinnte Version.

Die Detailpolicy steht in `17-database-provider-postgres-rag-collaboration-policy.md`.

## Workspace-Regeln

Persoenlicher Workspace:

- Jeder User bekommt einen eigenen Workspace.
- Nur der jeweilige User darf seinen persoenlichen Workspace sehen und bearbeiten.
- Andere User duerfen weder in der UI noch ueber API/Agent-Dateioperationen darauf zugreifen.
- Der persoenliche Workspace ist der Standardarbeitsbereich fuer private Arbeit.

Team Workspace:

- Alle berechtigten User der Organization duerfen den Team Workspace sehen.
- Schreibrechte koennen rollenbasiert eingeschraenkt werden.
- Der Team Workspace ist der gemeinsame Produktionsraum fuer Dateien, Kampagnen, Kundenassets und gemeinsam bearbeitete Inhalte.
- Aenderungen im Team Workspace muessen auditiert werden.

Kopieren zwischen Workspaces:

- User koennen Dateien aus ihrem persoenlichen Workspace in den Team Workspace kopieren.
- User koennen Dateien aus dem Team Workspace in ihren persoenlichen Workspace kopieren.
- Der erste Mechanismus sollte Kopieren sein, nicht direktes Teilen oder Verschieben.
- Spaeter koennen Publish-, Move-, Version- oder Review-Flows ergaenzt werden.

## Zentrale Workspace-Abstraktion

Canvas Notebook braucht eine Workspace-Service-Schicht, durch die alle Dateioperationen laufen.

Geplantes Modell:

```txt
Workspace
- id
- organizationId
- type: personal | team | project
- ownerUserId?
- rootPath
- permissions
- createdAt
- updatedAt
```

Jede Dateioperation muss den User- und Workspace-Kontext kennen:

- Wer ist der User?
- In welcher Organization arbeitet er?
- Welcher Workspace ist aktiv?
- Darf der User lesen?
- Darf der User schreiben?
- Ist die Datei gerade gelockt?
- Muss eine neue Revision geschrieben werden?
- Welche Audit-Zeile entsteht?

Direkte Zugriffe auf den alten globalen `workspace`-Ordner muessen schrittweise auf diese Abstraktion migriert werden.

## Abstraktion bestehender App-Funktionen

Der Team-Umbau betrifft nicht nur den Workspace-Ordner. Alle bestehenden Canvas Notebook Funktionen muessen darauf geprueft werden, ob sie aktuell implizit global fuer die ganze Instanz gelten. In einer Team-Instanz darf keine User-nahe Einstellung einfach an der gesamten VM haengen, wenn sie fachlich einem einzelnen User, einer Session, einem Workspace oder einer Organization gehoert.

Grundregel:

- User-private Daten gehoeren an `userId`.
- Workspace-bezogene Daten gehoeren an `workspaceId`.
- Gemeinsame Teamdaten gehoeren an `organizationId` und optional `workspaceId`.
- Instanz-/Runtime-Daten gehoeren nur dann global an die VM, wenn sie wirklich technische Infrastruktur betreffen.
- Jede Agent- oder Automations-Aktion muss `userId`, `sessionId` und `workspaceId` kennen, wenn sie im Auftrag eines Users passiert.

Scope-Matrix fuer bestehende Funktionen:

| Bereich | Aktuelle Annahme | Ziel-Scope |
|---|---|---|
| Workspace-Dateien | ein globaler Workspace | `personal workspace` pro User plus `team workspace` pro Organization |
| Agent-Runtime-Einstellungen | tendenziell instanzweit | Defaults auf Organization-/Instanz-Ebene, konkrete Overrides pro User, Agent, Session oder Workspace |
| Composio | eine Composio-ID fuer die VM | Composio Connections pro User; optionale Organization-Connections nur fuer explizit geteilte Integrationen |
| E-Mail-OAuth | ein Credential-/OAuth-Kontext | E-Mail-Accounts und OAuth-Credentials pro User; Team-Mailboxen optional als Organization-Ressource |
| Notifications | instanzweite Einstellungen | Notification Preferences pro User; Team-/Admin-Alerts optional auf Organization-Ebene |
| Notification Channels | aktuell nur ein Telegram Channel | Channels pro User und optional Organization-Channels fuer Team-Alerts |
| Plugins und Skills | instanzweit installierter Tool-Stack | User-spezifische Tool-Stacks; optional Organization-geteilte Plugins/Skills mit Freigabe |
| MCP-Konfiguration | instanzweite Settings-Datei | User-spezifische MCP-Konfiguration und Tokens; Organization-Templates nur als Freigabe/Default |
| To-dos | unklar/global oder sessionnah | Organization-To-dos mit `assigneeUserId`, `createdByUserId`, Status und optional Workspace/Projekt |
| Automations | instanzweit oder usernah ohne Workspace-Scope | Automations gehoeren einem User oder der Organization und laufen explizit in Personal oder Team Workspace |
| Agent-Definitionen | instanzweit wiederverwendbar | Agenten pro User; optional als Organization-Templates teilbar |
| Public File Links | Link verweist implizit auf einen Workspace | Public Link referenziert `workspaceId`, `filePath`, `revision`, `createdByUserId`, `organizationId` und Access Policy |
| Studio Route | generierte Assets instanzweit | Assets gehoeren zur Organization, speichern `createdByUserId` und sind nach User filterbar |
| Studio Produkte/Personas/Stile | unklar/global | Organization-geteilte Bibliotheken |

Admin-Bootstrap und Administration:

- Beim initialen Setup muss ein erster Admin-User gesetzt werden.
- In Community/Single-User-Installationen ist dieser Admin zugleich der einzige produktive User.
- In Team-/Managed-Instanzen ist dieser Admin der initiale Owner der Canvas Notebook Organization.
- Das initiale Setup muss sofort Organization, Owner Membership, Owner Permissions, Personal Workspace und scoped User-Runtime-Verzeichnisse erzeugen.
- `/setup` und `bootstrap-admin` muessen denselben Zielzustand erzeugen.
- Es gibt genau einen Owner, aber mehrere Admins sind erlaubt.
- Der Owner oder ein Admin kann andere User zu Admins machen.
- Es muss immer mindestens ein Admin in der Organization verbleiben.
- Fuer Authentication und User-/Rollenverwaltung soll genutzt werden, was Better Auth bereitstellt. Es soll keine parallele eigene Auth-/Userverwaltung neben Better Auth aufgebaut werden.
- Administrative Aktionen duerfen nicht nur durch UI-Ausblendung geschuetzt sein, sondern muessen serverseitig Rollen pruefen.
- Nur Admins duerfen kritische Instanz- und Organization-Einstellungen verwalten, z. B. User, Rollen, Team Policies, globale Runtime Defaults, Team Workspace Policies, Export, Backup/Restore, Organization Channels und Organization-geteilte Integrationen.
- Billing-Rollen sind in Canvas Notebook nicht noetig, weil Billing ueber das Control Plane laeuft.

Fresh Install und Update-Migration:

- Neuinstallationen und bestehende Instanzen nach Update muessen denselben scoped Zielzustand erreichen.
- Bestehende globale `data/workspace`-Daten werden dem Owner-Personal-Workspace zugeordnet, nicht dem Team Workspace.
- Team Workspace startet bei Migration leer; Team-Freigaben alter Daten passieren spaeter explizit.
- Bestehende globale Env-, MCP-, Skill-/Plugin- und Runtime-Dateien werden nicht automatisch fuer alle User aktiviert.
- Wenn der Owner bei einem Update nicht eindeutig bestimmbar ist, muss die Migration stoppen und Admin-Review verlangen.
- Die Migrationslogik muss versioniert, idempotent und wiederaufnehmbar sein.

Rollen und User-Permissions:

- Rollen sollten auf Better Auth aufbauen.
- V1-Rollen: `owner`, `admin`, `member`, `external`.
- `owner`: genau ein User, initial beim Setup gesetzt, volle Kontrolle.
- `admin`: kann User verwalten, Admins ernennen, Team-Policies konfigurieren, Exporte ausfuehren, Offboarding starten und Team-Funktionen administrieren.
- `member`: normaler interner Mitarbeiter.
- `external`: externer Kunde oder Projektgast mit eingeschraenktem Zugriff auf freigegebene Projekte/Workspaces.
- Jeder normale Mitarbeiter darf grundsaetzlich Agenten ausfuehren.
- Pro User sollen Admins einstellen koennen, ob der User in den Team Workspace schreiben darf.
- Pro User sollen Admins einstellen koennen, ob der User Public Links erstellen darf.
- Pro User sollen Admins einstellen koennen, ob der User Automations im Team Workspace anlegen darf.
- Pro User sollen Admins einstellen koennen, ob der User Plugins/Skills freigeben oder teilen darf.
- Pro User sollen Admins einstellen koennen, ob der User Exporte ausfuehren darf. Vollstaendige App-/Organization-Exporte bleiben standardmaessig Admin-only.
- Andere User-To-dos sehen oder bearbeiten darf standardmaessig nur ein Admin oder eine explizit berechtigte Rolle.
- Externe User duerfen nur in explizit freigegebenen Projekten/Workspaces arbeiten und sollen keine globalen Organization-Daten sehen.

Export und Migration:

- Canvas Notebook braucht einen Admin-only Export fuer die komplette App bzw. Organization-Instanz.
- Der Export muss granular konfigurierbar sein, damit Migrationen auf andere oder weitere Apps moeglich sind.
- Exportierbare Bereiche sollten einzeln waehlbar sein: persoenliche Workspaces, Team Workspace, Knowledge Base, Agenten, Skills/Plugins, Automations, To-dos, Studio Assets, Produkte/Personas/Stile, Composio-/Integration-Metadaten, E-Mail-Connection-Metadaten, Notification Settings, Public Links, Audit Trail und App-Konfiguration.
- Secrets und OAuth-Tokens duerfen nicht unkontrolliert im Klartext exportiert werden. Fuer sensible Daten braucht es bewusstes Redaction-, Reconnect- oder verschluesseltes Export-Verhalten.
- Der Export muss `organizationId`, `userId`, `workspaceId` und relevante Relationen erhalten, damit Imports spaeter korrekt gemappt werden koennen.
- Migration Exports enthalten keine aktiven Public Links oder Public-Link-Tokens; Links muessen im Zielsystem neu gesetzt werden.
- Full/Admin Export darf Personal Workspaces enthalten, muss aber explizit gewaehlt, gewarnt und auditiert werden.
- Export-/Import-Manifeste muessen User-, Workspace-, Chat-/Session-, Agent-, Automation-, To-do- und Studio-Referenzen so beschreiben, dass sie im Import-Dry-Run gemappt oder als `unresolved` gemeldet werden koennen.
- Export-Aktionen muessen auditiert werden.

Agent-Runtime-Einstellungen:

- Technische Defaults wie verfuegbare Runtime, Tool-Policies oder globale Limits koennen auf Organization-/Instanz-Ebene liegen.
- User-nahe Defaults wie bevorzugte Agent-Konfiguration, Modus, erlaubte Tools oder Standard-Kontext sollten pro User oder Workspace gespeichert werden.
- Eine Session muss eine aufgeloeste Runtime-Konfiguration bekommen, die aus Organization Policy, User Preferences, Workspace Policy und Session-Auswahl zusammengesetzt wird.
- Der Runtime Resolver muss `organizationId`, `userId`, `workspaceId`, `sessionId` und `agentId` erhalten und eine revisionsfaehige Effective Config liefern.
- Agent-Schreibzugriffe muessen immer in den aktiven Workspace gehen, nicht in einen impliziten globalen Arbeitsordner.

Plugins und Skills:

- Plugins und Skills sollten standardmaessig userbezogen sein, weil jeder User seinen eigenen Tool-Stack, seine eigenen Integrationen und seine eigenen Arbeitsweisen haben kann.
- Jeder User muss eigene Skills/Plugins installieren, konfigurieren, aktualisieren und verbessern koennen, soweit die Organization Policy das erlaubt.
- Organization-Admins koennen erlaubte Plugins/Skills kuratieren, sperren oder als empfohlene Defaults bereitstellen.
- User koennen Skills/Plugins optional intern teilen, z. B. als Organization-Template oder Registry-Eintrag, aber die aktive Installation/Konfiguration bleibt pro User kontrollierbar.
- Agent-Sessions muessen den Tool-Stack des ausloesenden Users verwenden, nicht einen globalen Instanz-Tool-Stack.
- Skill-/Plugin-Aenderungen brauchen Audit, weil sie das Verhalten von Agenten veraendern koennen.

Composio-Management:

- Eine einzelne Composio-ID fuer die komplette VM reicht fuer Team-Instanzen nicht.
- OAuth-Connections und Tool-Berechtigungen muessen pro User trennbar sein.
- Wenn eine Integration teamweit geteilt werden soll, braucht sie einen expliziten Organization-Scope mit Admin-Freigabe.
- Jede Composio-Ausfuehrung muss auditierbar sein mit `userId`, `connectionId`, `tool`, `sessionId` und `workspaceId`.

E-Mail-OAuth:

- E-Mail-Credentials duerfen nicht global fuer alle User gelten.
- Jeder User verbindet eigene Mail-Accounts per OAuth.
- Team-Mailboxen koennen spaeter als Organization-Ressource modelliert werden, brauchen dann aber Rollen, Freigabe und Audit.
- E-Mail-Aktionen des Agenten muessen im Namen des ausloesenden Users oder einer explizit geteilten Team-Mailbox laufen.
- Managed-/Gateway-E-Mail-Aufrufe muessen vor dem Senden oder Empfangen auf einen internen `userId` oder eine erlaubte Organization-Mailbox gemappt werden.
- Eine Organization- oder Team-Mailbox darf niemals als Fallback fuer fehlende User-Mail-Credentials dienen.

Notifications und Channels:

- Notification Preferences muessen pro User funktionieren.
- Channels wie Telegram, E-Mail oder spaeter Slack/Discord muessen mehreren Usern separat zugeordnet werden koennen.
- Der aktuell einzelne Telegram Channel muss auf `userId` oder optional `organizationId` abstrahiert werden.
- Teamweite Alerts wie Storage Critical, Backup Failed oder Billing Issues koennen an Organization-Channels und Admin-Rollen gehen.

To-do-Management:

- To-dos sollten organizationfaehig modelliert werden.
- Jedes To-do braucht mindestens `organizationId`, `createdByUserId`, optional `assigneeUserId`, Status, Titel, Beschreibung, Faelligkeit und optional `workspaceId` oder Projekt/Kundenbezug.
- User muessen eigene To-dos filtern koennen.
- Teams muessen To-dos nach zugewiesenem User filtern koennen.
- Admins oder berechtigte Rollen koennen To-dos anderen Usern zuweisen.
- Agenten duerfen To-dos nur im Auftrag eines Users oder einer erlaubten Automation erstellen/aendern.
- Statusaenderungen und Zuweisungen muessen auditierbar sein.

Automations:

- Automations duerfen nicht implizit global fuer die ganze Instanz laufen.
- Eine Automation gehoert entweder einem User oder explizit der Organization.
- Personal Automations laufen im Auftrag eines `ownerUserId`.
- Organization Automations laufen ueber einen Organization Service Actor und brauchen Owner/Admin-Erstellung plus Approval.
- Beim Erstellen muss ausgewaehlt werden, ob sie im persoenlichen Workspace des Owners oder im Team Workspace laufen soll.
- Jede Automation braucht genau einen primaeren `workspaceId`, Trigger, Berechtigungen und aktiven Agent-/Tool-Kontext.
- Multi-Workspace-Reads sind nicht normaler V1-Scope; wenn spaeter noetig, nur admin-created, read-only, explizit und auditpflichtig.
- Automations, die im Team Workspace laufen, brauchen Rollen- oder Admin-Freigabe.
- Automation-Ausfuehrungen muessen mit `userId`/Owner, `workspaceId`, Agent, verwendeten Tools und Ergebnis auditiert werden.
- Wenn ein User deaktiviert oder entfernt wird, muss geregelt sein, ob seine Automations pausieren, uebertragen oder geloescht werden.
- Automations duerfen keine Automations erstellen, aendern, aktivieren oder loeschen.
- Webhook-getriggerte Automations brauchen Signaturpruefung, Rate Limits, Replay-Schutz und Payload-Validierung.

Agent-Definitionen:

- Von Usern angelegte und konfigurierte Agenten sollten userbezogen gespeichert werden.
- Jeder User kann eigene wiederverwendbare Agenten, Prompts, Tool-Stacks und Runtime-Defaults pflegen.
- Agenten koennen optional als Organization-Template geteilt werden, damit andere User sie kopieren oder wiederverwenden koennen.
- Geteilte Agenten sollten nicht automatisch die privaten Credentials, Plugins oder E-Mail-/Composio-Connections des Erstellers uebernehmen.
- Agent-Ausfuehrungen muessen weiterhin dem ausloesenden User, der Session und dem aktiven Workspace zugeordnet werden.

Public Links:

- Public Links muessen fuer mehrere Workspaces neu modelliert werden.
- Ein Link auf eine Datei aus dem eigenen persoenlichen Workspace darf vom Owner erstellt oder verwaltet werden.
- Ein Link auf eine Datei aus dem Team Workspace darf nur von Owner/Admin oder Usern mit `canCreatePublicLinks` erstellt werden.
- V1-Links zeigen auf die jeweils neueste Version der Datei.
- Links muessen widerrufbar sein und bei Move/Rename/Delete der Ziel-Datei deaktiviert werden.
- Ablaufdatum bleibt aktiv; optionaler Passwortschutz wird als spaetere Erweiterung vorbereitet.
- Public bedeutet in V1 View und Download.
- Public-Link-Audit muss speichern, wer den Link erstellt hat und auf welche Datei, letzte bekannte Revision oder letzten Content Hash er zeigt.

Studio Route:

- Produkte, Personas und Stile sollen in Team-Instanzen als Organization-geteilte Bibliotheken funktionieren.
- Generierte Assets sollen ebenfalls in einer gemeinsamen Organization-Sammlung sichtbar sein.
- Jedes generierte Asset muss `createdByUserId`, `organizationId`, optional `workspaceId`, Prompt-/Generator-Metadaten und Zeitstempel speichern.
- Die Studio Route braucht Filter: alle Assets, eigene Assets, Assets eines bestimmten Users, optional Workspace/Projekt.
- Teammitglieder duerfen generierte Assets anderer User sehen und herunterladen.
- In V1 gibt es keine privaten Studio Generations.
- Organization User mit Studio-Zugriff duerfen Assets loeschen, sofern keine restriktivere Organization Policy gesetzt ist; Loeschungen brauchen Audit und sollten Soft Delete/Trash nutzen.

Offboarding:

- User sollen in Team-Instanzen bevorzugt archiviert/deaktiviert werden, nicht hart geloescht.
- Vor dem Entfernen oder Deaktivieren eines Users muss ein Offboarding-Flow durchlaufen werden.
- Der Flow muss anbieten, den persoenlichen Workspace des Users vorher zu sichern oder zu exportieren.
- Der archivierte Personal Workspace ist danach nicht normal sichtbar; Zugriff ist nur ueber Owner-/Admin-Recovery-Flow mit Warnung und Audit erlaubt.
- Agenten, die der User angelegt hat, werden standardmaessig geloescht, sofern sie nicht vorher als Organization-Template kopiert oder uebertragen werden.
- Automations des Users muessen reviewed werden. Admins waehlen pro Automation: auf anderen User migrieren, pausieren oder loeschen.
- To-dos, die dem User zugewiesen sind, muessen im Offboarding bestaetigt und entweder geloescht, neu zugewiesen oder archiviert werden.
- OAuth-Verbindungen und private Credentials des Users werden geloescht bzw. revoked. Dazu gehoeren E-Mail, Composio, Telegram und andere User-Channels.
- Studio Assets bleiben erhalten, weil sie zentral in der Organization-Sammlung liegen. Der archivierte User bleibt als historischer Creator referenzierbar.
- Es muss verhindert werden, dass der letzte Admin entfernt oder deaktiviert wird.
- Ownership Transfer kann spaeter als eigener Flow ergaenzt werden. Fuer V1 reicht: genau ein Owner, mehrere Admins, mindestens ein Admin bleibt erhalten.

Search, Embeddings und Retrieval:

- Ein Embeddings-/Search-Layer ist aktuell noch nicht Kernbestandteil, soll aber als spaetere Schicht vorbereitet werden.
- Produktive Team Knowledge, Embeddings, RAG und Knowledge Graph werden nur im Postgres/pgvector-Mode freigeschaltet.
- SQLite darf Knowledge-Metadaten, Scan-Status und einfache lokale Suche vorbereiten, aber keine produktive Team-RAG-Funktion tragen.
- Jeder Such- oder Retrieval-Eintrag muss `organizationId`, `workspaceId`, optional `userId`, Sichtbarkeit und Source-Referenz speichern.
- Retrieval darf keine Inhalte aus fremden persoenlichen Workspaces leaken.
- Team Knowledge Base, Team Workspace und persoenliche Workspaces muessen getrennte Sichtbarkeitsregeln fuer Search/Embeddings haben.
- Agent-Kontext aus Search/Retrieval muss dieselben Rechte pruefen wie normale Datei- und Knowledge-Base-Zugriffe.
- Knowledge-Ingestion soll automatisch laufen, aber nach Scope getrennt: Personal Knowledge pro User und policy-gesteuerte Team Knowledge.
- E-Mail-Inhalte werden in V1 nicht automatisch indexiert.
- Studio-Medien werden in V1 nicht als Vollinhalt indexiert; nur explizite Textartefakte oder Metadaten koennen nach Policy aufgenommen werden.
- Secret-/PII-Scan laeuft vor Chunking und Embedding; Embeddings gelten als abgeleitete sensible Daten.

Background Jobs und Usage:

- Alle Background Jobs muessen Actor und Scope kennen: `userId`, optional `organizationId`, `workspaceId`, `sessionId`, Job-Typ und Trigger.
- Jobs duerfen nicht anonym im globalen Instanzkontext laufen, wenn sie fachlich im Auftrag eines Users gestartet wurden.
- Wenn ein User deaktiviert wird, muessen seine Jobs und Automations pausiert, uebertragen oder geloescht werden koennen.
- Generierungen, Agent-Ausfuehrungen, Studio Jobs, Automations, Indexing, Import/Export, E-Mail-Sync und Composio-Sync muessen auditierbar sein.
- Kosten und Usage werden im Control Plane organizationbasiert abgerechnet, sollten aber zusaetzlich `userId` speichern, damit Teams nachvollziehen koennen, welcher User Kosten verursacht hat.

Secrets und Credentials:

- Secrets muessen strikt nach Scope getrennt werden: user-owned, organization-owned und managed/system-owned.
- Canvas Notebook muss verhindern, dass ein Agent versehentlich Credentials eines anderen Users verwendet.
- Geteilte Agenten, Skills oder Plugins duerfen keine privaten Secrets des Erstellers mitkopieren.
- User-spezifische lokale Secrets liegen unter `/data/users/{userId}/secrets`.
- Organization-Secrets liegen unter `/data/organizations/{organizationId}/secrets` und werden nur bei expliziter Policy-Freigabe injiziert.
- System-/Managed-Secrets liegen unter `/data/system/secrets` und duerfen nicht in normale User-Tool-Stacks durchsickern.
- Die Aufloesung erfolgt serverseitig ueber einen Context mit `userId`, `organizationId`, `workspaceId`, `sessionId`, `agentId` und Zweck. Der Client darf keine Secret-Pfade oder Scope-Roots bestimmen.
- Jede Secret-Verwendung durch Agenten, Automations oder Integrationen muss den aktiven User- und Workspace-Kontext kennen.
- Audit speichert Secret-Refs und Scope, aber niemals Secret-Werte.

Import:

- Der Export-Plan braucht einen passenden Import-Flow.
- Import muss User korrekt anlegen oder auf bestehende User mappen koennen.
- Workspaces, Agenten, To-dos, Automations, Studio Assets, Public Links und Audit-/Historienreferenzen brauchen stabile Mapping-Strategien.
- Public Links werden bei Migration nicht aktiv importiert; sie werden im Import-Report als neu zu erstellen markiert.
- Zuweisungen zu Usern, Chats/Sessions, Agenten, Workspaces, To-dos und Automations muessen explizit gemappt werden.
- Unaufloesbare Referenzen duerfen nicht stillschweigend auf den importierenden Admin oder Owner umgebogen werden.
- OAuth-Tokens und externe Credentials sollten beim Import nicht blind importiert werden. In der Regel braucht es Reconnect-Flows.
- Ein Import sollte einen Dry-Run oder Preview-Modus haben, bevor Daten geschrieben werden.
- Import-Aktionen muessen auditiert werden.

Update-Migration bestehender Instanzen:

- Bestehende Single-User-Instanzen werden in eine lokale Organization mit genau einem Owner migriert.
- `/data/workspace` wird als Owner-Personal-Workspace importiert oder gemappt.
- `/data/settings/*.json`, `/data/secrets/*.env`, `/data/skills`, `/data/plugins`, MCP-OAuth-State und Agent-Markdown-Dateien bekommen Review- oder Scope-Metadaten.
- Dotenv- und OAuth-Dateien werden bei Mehruser-/Team-Migration nicht blind als Organization-Secrets aktiviert.
- Ein Migration-State-Manifest oder eine DB-Tabelle muss festhalten, welche Schritte abgeschlossen, wiederaufnehmbar oder reviewpflichtig sind.

Audit, Retention und Datenloeschung:

- Audit Trail ist ein zentrales Team-Feature, nicht nur ein technisches Log.
- Zu auditieren sind mindestens: Login-/Admin-Aktionen, User-/Rollen-Aenderungen, Plugin-/Skill-Aenderungen, OAuth connect/disconnect, Public Link create/revoke, Export/Import, Automation create/run/change, Agent-Ausfuehrung, Datei-Aenderung, To-do-Aenderung und Studio-Asset-Erzeugung.
- Geloeschte Dateien sollten fuer Teamplaene mindestens eine Retention-/Trash-Strategie haben, statt sofort unkontrolliert zu verschwinden.
- Public Links muessen bei Datei-/Workspace-Loeschung automatisch widerrufen oder deaktiviert werden.
- Public Links auf eigene Personal-Workspace-Dateien sind erlaubt; Public Links auf Team-Dateien brauchen Owner/Admin oder explizite `canCreatePublicLinks` Permission.
- V1-Public-Links folgen der neuesten Dateiversion. Bei Move/Rename/Delete der Ziel-Datei wird der Link deaktiviert. Public bedeutet in V1 View und Download; optionaler Passwortschutz wird fuer spaeter vorbereitet.
- Offboarding sollte User-Daten archivieren, private Credentials loeschen und historische Creator-/Audit-Referenzen erhalten.
- Retention fuer Audit Logs, Studio Assets, Trash und Backups muss spaeter konfigurierbar sein.

Path Security:

- Alle Dateioperationen muessen Workspace Root Boundaries strikt erzwingen.
- Pfade mit `../`, absolute Pfade ausserhalb des Workspace Roots und unerlaubte Symlinks muessen blockiert werden.
- Public Links duerfen keine absoluten Serverpfade leaken.
- Agent-Dateioperationen muessen dieselben Workspace-Grenzen respektieren wie normale API-Dateioperationen.
- Shell- oder Tool-Ausfuehrungen des Agenten duerfen nicht dazu fuehren, dass fremde persoenliche Workspaces gelesen oder geschrieben werden koennen.

Projekt-/Kundenebene:

- Fuer Agenturen sollte spaeter eine Ebene fuer Projekte oder Kunden vorbereitet werden.
- `project` Workspaces sollten optional unterhalb der Organization liegen und koennen externe User gezielt einladen.
- Produkte, Personas, Stile, Knowledge, To-dos und Assets sollten spaeter projekt-/kundenspezifisch gefiltert oder zugeordnet werden koennen.
- Das Datenmodell sollte diese Ebene nicht blockieren, auch wenn V1 mit Personal Workspace und Team Workspace startet.

## Studio Assets

Generierte Studio Assets sind in Team-Instanzen organizationweit sichtbar.

Regeln:

- Es gibt in V1 keine privaten Studio Generations.
- Studio Generations, Outputs und Assets speichern `organizationId` und `createdByUserId`.
- Die Studio UI zeigt organizationweite Assets und bietet einen Filter nach Creator/User.
- Offboarding archiviert den User, loescht aber seine Studio Assets nicht automatisch.
- Studio Asset Deletes sind fuer Organization User mit Studio-Zugriff erlaubt, sofern keine restriktivere Policy gesetzt ist; sie muessen auditiert und moeglichst als Soft Delete/Trash umgesetzt werden.
- Save/Copy-to-Workspace fuer Studio Outputs muss immer einen Ziel-Workspace abfragen: eigener Personal Workspace oder berechtigter Team Workspace.

## KI-Agent Kontext

Der Agent darf nicht standardmaessig vollen Zugriff auf alle Workspaces bekommen.

Grundregel:

- Der Agent arbeitet immer im aktiven Workspace der Session.
- Eine private Session nutzt standardmaessig den persoenlichen Workspace des Users.
- Eine Team-Session nutzt nur dann den Team Workspace, wenn der User diesen aktiv ausgewaehlt hat oder die Session explizit als Team-Session gestartet wurde.
- Eine Agent-Session nutzt den Tool-Stack, die MCP-Verbindungen, Skills, Plugins, Mailboxen und Secrets des ausloesenden Users.
- Jeder Agent-Turn bekommt serverseitig einen `AgentExecutionContext`, der erlaubte Tools, Read-Grants, Write-Workspace, Secret-Refs, MCP-Server und Runtime-/Tool-Stack-Revisionen fixiert.
- Die App hat einen globalen aktiven Workspace pro User-Oberflaeche. Ein Wechsel auf Startseite, Chat Header oder File Browser muss denselben globalen Workspace-Status aktualisieren.
- Ein Workspace-Wechsel im Chat Header verhaelt sich wie ein Agent-Wechsel: Es wird eine neue Chat-Session im Ziel-Workspace gestartet.
- Bestehende Agent-Sessions behalten ihren gespeicherten `workspaceId` und werden nicht stillschweigend in einen anderen Workspace migriert.
- Team-Dateien werden nicht automatisch vollstaendig als Modellkontext geladen.
- Der User kann konkrete Team-Dateien oder Ordner explizit in den Kontext nehmen.
- Die Team Knowledge Base kann als separate Retrieval-Quelle genutzt werden, sofern die Lizenz und die Rolle das erlauben.
- Schreiben ist nur in den Workspace erlaubt, der an der Agent-Session gespeichert ist.
- Lesen aus anderen erlaubten Workspaces ist fuer mehrere explizit referenzierte Dateien oder ausgewaehlte Ordner erlaubt; fremde Personal Workspaces sind immer tabu.
- Shell-/Terminal-Tools duerfen keine Cross-Workspace-Read-Grants nutzen; sie bleiben auf den Session-Workspace begrenzt.

Jede Agent-Aenderung muss dem ausloesenden User zuordenbar sein:

```txt
AuditEvent
- organizationId
- workspaceId
- userId
- sessionId
- agentId?
- action
- filePath
- previousRevision?
- nextRevision?
- createdAt
```

Der Agent schreibt technisch als Prozess, fachlich aber im Auftrag eines Users. Dieses Mapping ist Pflicht fuer Teamfaehigkeit.

Die detaillierte Tool-Ausfuehrungspolitik ist in `10-agent-tool-execution-policy.md` verbindlich beschrieben. Besonders wichtig: Blockierte Tool-Calls duerfen textlich Alternativen vorschlagen, aber keinen automatischen Retry in einem anderen Workspace ausfuehren.

## Collaboration-Modell

Ein geteilter Team Workspace bedeutet nicht automatisch echte Real-Time Collaboration fuer alle Dateitypen.

Empfohlener Start:

- Gemeinsamer Team Workspace auf dem Team-Server.
- Dateioperationen laufen ueber Canvas Notebook Services.
- Revisionen und Audit Trail fuer relevante Aenderungen.
- File Locks fuer riskante Bearbeitungen.
- Konflikterkennung, wenn zwei Sessions dieselbe Datei auf Basis unterschiedlicher Revisionen speichern.

Fuer viele Marketing-Dateien ist Locking besser als Live-Merging:

- Bilder,
- Videos,
- PDFs,
- grosse Assets,
- generierte Projektdateien,
- binaere Dateien.

Fuer Textdateien, Markdown und Knowledge-Base-Inhalte kann spaeter echte Real-Time Collaboration ergaenzt werden. Dafuer sollte dann eine dedizierte Collaboration Engine wie CRDT/OT genutzt werden, nicht ein simples gemeinsames Schreiben auf dieselbe Datei.

Datenbank-Folge:

- SQLite reicht fuer einfache Revision Checks in Single-User-/Community-Installationen.
- Produktive Multi-User-Collaboration mit Presence, Edit Events, CRDT/OT-State oder vielen parallelen Writes braucht Postgres.
- Redis ist fuer V1 keine Pflicht. Leichte Events koennen zunaechst ueber App-WebSockets und Postgres-Tabellen/Notifications geplant werden; Multi-Node oder hohe Eventlast wird spaeter separat entschieden.

## Lizenz- und Feature-Gating

Die bestehende Lizenzlogik sollte Teamfunktionen freischalten oder sperren.

Der aktuelle Managed Mode im Control Plane bedeutet bereits, dass eine Canvas Notebook Instanz Managed Services und eine Managed License vom Control Plane bekommt. Technisch werden aktuell diese Werte in `vm_config.env` geschrieben und beim Installieren oder per Agent-Config-Sync an Canvas Notebook uebergeben:

```env
CANVAS_MANAGED_SERVICES_ENABLED=true
CANVAS_CONTROL_PLANE_URL=https://api...
CANVAS_INSTANCE_ID=<vmId>
CANVAS_INSTANCE_TOKEN=<managed-service-token>
CANVAS_LICENSE_CERT=<signed-license-jwt>
```

Dieser bestehende Managed Mode beschreibt aber noch keinen Team-Betrieb. Er sagt nur, dass die Instanz managed Modell-, Medien-, Composio-, E-Mail- und Lizenzfunktionen verwenden darf. Fuer den Teamplan muss Managed deshalb erweitert werden.

Empfohlene Trennung:

- `CANVAS_MANAGED_SERVICES_ENABLED`: aktiviert Control-Plane-backed Managed Services.
- `CANVAS_DEPLOYMENT_MODE`: beschreibt die Produkt-/Betriebsart der Notebook-Instanz.
- `CANVAS_LICENSE_CERT`: bleibt die kryptografisch pruefbare Quelle fuer Feature-Rechte und Quotas.

Geplante Deployment Modes:

```txt
community
managed-single
managed-team
enterprise-onprem
```

Community-Lizenz:

- Single User.
- Multi-User UI gesperrt.
- Team Workspace gesperrt.
- Organization-Teamfunktionen gesperrt.
- Lokaler Workspace bleibt nutzbar.

Team-/Managed-Lizenz:

- Multi-User aktiv.
- Organization aktiv.
- Persoenliche Workspaces pro User.
- Team Workspace aktiv.
- Audit Trail aktiv.
- Team Knowledge Base aktiv.
- Rollen/Rechte aktiv.
- Backups und Restore Policies aktiv.

On-Prem/Enterprise:

- Gleiche Teamfunktionen.
- Stripe kann deaktiviert sein.
- Lizenz kann ueber lokalen oder manuellen Freischaltmechanismus geprueft werden.
- Control Plane kann optional Provisioning, Updates und Monitoring uebernehmen.

Die Lizenz-Claims sollten fuer Team-/Managed-Instanzen mindestens diese Rechte enthalten:

```json
{
  "deploymentMode": "managed-team",
  "managedServices": true,
  "multiUser": true,
  "personalWorkspaces": true,
  "teamWorkspace": true,
  "teamKnowledgeBase": true,
  "auditTrail": true,
  "managedBackups": true
}
```

Quotas sollten ebenfalls ueber die Lizenz kommen:

```json
{
  "notebooks": 1,
  "users": 10,
  "teamWorkspaces": 1,
  "storageGb": 100
}
```

Die ENV ist fuer Bootstrap und klare Runtime-Konfiguration sinnvoll. Die verbindliche Berechtigung sollte aber aus `CANVAS_LICENSE_CERT` kommen, damit Teamfunktionen nicht allein durch lokale ENV-Manipulation freigeschaltet werden koennen.

Zusaetzliche ENV-Werte fuer Team-Instanzen:

```env
CANVAS_DEPLOYMENT_MODE=managed-team
CANVAS_ORGANIZATION_ID=<organizationId>
CANVAS_DATABASE_PROVIDER=postgres
DATABASE_URL=postgresql://canvas:<password>@postgres:5432/canvas_notebook
CANVAS_POSTGRES_VECTOR_ENABLED=true
CANVAS_TEAM_FEATURES_ENABLED=true
CANVAS_MULTI_USER_ENABLED=true
CANVAS_PERSONAL_WORKSPACES_ENABLED=true
CANVAS_TEAM_WORKSPACE_ENABLED=true
CANVAS_AUDIT_TRAIL_ENABLED=true
CANVAS_MANAGED_BACKUPS_ENABLED=true
```

Diese Booleans koennen Canvas Notebook beim Bootstrapping und bei UI-Defaults helfen. Fuer finale Rechtepruefungen sollte Canvas Notebook sie gegen die signierte Lizenz abgleichen.

## Control Plane Verantwortlichkeiten

Das Control Plane sollte die Team-Workspace-Funktion nicht als externen Bucket-Sync erzwingen, wenn eine Team-Instanz alle User einer Organization lokal bedient.

Verantwortlichkeiten im Control Plane:

- Organization und Billing-Account verwalten.
- Team-/Managed-Lizenz ausstellen und pruefen.
- Canvas Notebook Team-Instanz provisionieren.
- Versionen, Updates und Host Maintenance verwalten.
- Backups konfigurieren und ueberwachen.
- Storage-Auslastung der Team-Instanz ueberwachen und fruehzeitig warnen, bevor Workspaces oder Backups fehlschlagen.
- Managed Models und Usage auf Organization-Ebene abrechnen.
- Optional zentrale Policies fuer Teamfunktionen setzen.
- Beim Provisioning den richtigen `CANVAS_DEPLOYMENT_MODE` und die Organization-ID an Canvas Notebook uebergeben.
- Beim Provisioning den richtigen `CANVAS_DATABASE_PROVIDER` setzen.
- Fuer Teamplaene Postgres mit pgvector-faehiger Datenbank als separaten Compose-Service bereitstellen.
- DB-Secrets sicher erzeugen und an Canvas Notebook uebergeben, ohne sie Agent-Tools verfuegbar zu machen.
- Postgres-/pgvector-Health, DB-Wachstum, WAL/Volume-Wachstum und Backup-Status ueberwachen.
- Managed-Lizenz-Features und Quotas fuer Team-/Enterprise-Instanzen ausstellen.
- `vm_config.env` so erweitern, dass Team-Instanzen beim Installieren und spaeter per Agent-Config-Sync dieselben Feature- und Identitaetswerte erhalten.

Verantwortlichkeiten in Canvas Notebook:

- Multi-User Sessions.
- Initiales Admin-Setup und serverseitige Rollenpruefung fuer administrative App-Funktionen.
- Better Auth fuer Authentifizierung, User und Rollen nutzen, keine parallele eigene Auth-Schicht.
- Rollenmodell mit genau einem Owner, mehreren Admins, Members und optional externen Projekt-/Kunden-Usern umsetzen.
- Per-User Permissions fuer Team-Workspace-Schreiben, Public Links, Team-Automations, Plugin-/Skill-Freigabe und Exporte verwalten.
- Offboarding-Flow fuer User mit Workspace-Sicherung, Automation-Review, To-do-Behandlung und Credential-Revocation umsetzen.
- Workspace-Abstraktion.
- Datei-Rechte.
- Team Workspace UI.
- Agent-Kontext und Agent-Dateioperationen.
- User-/Workspace-/Organization-Scoping fuer bestehende App-Funktionen.
- Agent-Runtime-Einstellungen auf User, Workspace, Session und Organization abstrahieren.
- Plugins und Skills als User-Tool-Stacks mit optionaler Organization-Freigabe modellieren.
- Composio-Connections und E-Mail-OAuth pro User bzw. explizit pro Organization verwalten.
- Notification Preferences und Channels pro User bzw. Organization verwalten.
- Organization-faehiges To-do-Management mit User-Zuweisungen bauen.
- Automations an Owner, Workspace und Ausfuehrungskontext binden.
- Wiederverwendbare Agent-Definitionen pro User und optional als Organization-Templates modellieren.
- Public Links workspace- und revisionsbewusst absichern.
- Admin-only Export mit granularer Auswahl fuer Migrationen bereitstellen.
- Import-Flow mit User-/Workspace-Mapping und Reconnect fuer Secrets/OAuth vorbereiten.
- Background Jobs, Search/Retrieval, Usage und Audit immer mit Actor- und Scope-Kontext speichern.
- Schwere Background Jobs fuer Parsing, OCR, Embeddings, Reindex und Maintenance muessen Resource Budgets, Backpressure und Degradation beachten.
- Secrets und Credentials nach User, Organization und Managed/System isolieren.
- Path Security fuer alle Workspace- und Agent-Dateioperationen erzwingen.
- Retention, Trash und Datenloeschung fuer Teamdaten planen.
- Studio-Produkte, Personas, Stile und generierte Assets teamfaehig modellieren.
- Audit Trail fuer User-/Agent-Aenderungen.
- Knowledge-Base-Integration.
- Database-Provider-Gates fuer SQLite/Postgres, pgvector-Status und RAG-/Collaboration-Freischaltung.

## Backup- und Restore-Anforderungen

Backups sind fuer Team Workspaces kritisch, weil mehrere Nutzer und Agents an gemeinsamen Produktionsdaten arbeiten.

Mindestens zu sichern:

- Datenbank provider-spezifisch: SQLite Snapshot/WAL oder Postgres Dump/Snapshot inklusive pgvector-/Extension-/Schema-Informationen,
- persoenliche Workspaces,
- Team Workspace,
- Knowledge Base,
- Audit Trail,
- Konfiguration von Skills/Plugins,
- Agent-Definitionen,
- Agent-Runtime-Einstellungen und Policies,
- User- und Organization-Agent-Templates,
- To-dos und Zuweisungen,
- Automations und deren Ausfuehrungskontext,
- User-Permissions und Rollen-Metadaten,
- Offboarding-/Archivierungsstatus,
- Composio-/Integration-Connection-Metadaten,
- E-Mail-OAuth-Connection-Metadaten,
- User-/Organization-Secrets nur nach bewusstem Exportmodus, sonst Redaction/Reconnect,
- Notification Preferences und Channel-Konfiguration,
- Public-Link-Metadaten,
- Import-/Export-Manifeste,
- Audit- und Retention-Metadaten,
- Studio-Produkte, Personas, Stile und generierte Asset-Metadaten,
- Lizenz-/Organization-Metadaten,
- relevante Datenbanktabellen der Canvas Notebook Instanz.

Restore-Anforderungen:

- Restore einer kompletten Organization-Instanz.
- Restore einzelner Dateien oder Ordner.
- Restore vorheriger Dateirevisionen.
- Granularer Admin-Export fuer Migrationen in andere oder weitere Apps.
- Re-Import-faehige Relationen zwischen Users, Workspaces, Agenten, To-dos, Automations, Studio Assets und Public Links.
- User-Mapping beim Import in bestehende oder neue Organizations.
- Reconnect-Flows fuer OAuth/Credentials nach Import.
- Nachvollziehbarkeit, welcher User oder Agent eine Revision erzeugt hat.

Full-Backup-Anforderungen:

- Full Backup sichert die komplette Instanz fuer Disaster Recovery, nicht nur exportierbare User-Daten.
- Backups muessen ueber Admin-Kontext, Control Plane, Host-/Container-CLI oder spaeter Schedule getriggert werden koennen.
- Taegliche Backups sollen vorbereitet werden; konkrete Retention/Schedule wird spaeter planabhaengig festgelegt.
- DB, WAL/Journal oder Postgres Dump/Snapshot, `/data/workspaces`, `/data/studio`, scoped Settings, Runtime-Konfiguration und Secrets/OAuth-State muessen konsistent und verschluesselt gesichert werden.
- Im Postgres-Mode reicht ein `/data`-Backup nicht aus; Postgres-Dump oder Postgres-Volume-Snapshot ist zwingend Teil des Full Backups.
- Workspace-Dateien selbst bleiben in V1 im Container-Dateisystem unverschluesselt; App-Rechte und Audit sind die Zugriffskontrolle, Backup-Artefakte werden verschluesselt.
- Public Links und Tokens duerfen in Full Backups fuer gleiche Disaster-Recovery-Ziele enthalten sein, aber nicht in Migration Exports.
- Backup-Jobs brauchen Resource Budget, Logging, Integritaetschecks und Schutz gegen parallele Laeufe.

## Storage-Monitoring und Kapazitaetsmanagement

Team Workspaces machen den Speicher der verwalteten VM zu einer produktkritischen Ressource. Wenn eine IONOS-VM z. B. 240 GB lokalen Speicher hat, reicht das fuer viele kleinere Teams am Anfang aus. Trotzdem muss das Control Plane frueh erkennen, wenn der Speicher voll laeuft, weil sonst Uploads, Agent-Schreibzugriffe, Datenbankoperationen, Docker, Backups und Restore-Vorbereitung fehlschlagen koennen.

Das Storage-Monitoring ist eine generelle Control-Plane-Aufgabe, wird aber fuer Teamplaene besonders wichtig, weil mehrere User und Agents denselben Speicherpool nutzen.

Zu tracken:

- Gesamtspeicher der VM.
- Belegter und freier Speicher.
- Prozentuale Auslastung.
- Wachstum des Workspace-Verzeichnisses.
- Wachstum des Team Workspace.
- Backup-Speicherbedarf und letzte Backup-Groesse.
- Optional spaeter: Aufteilung nach persoenlichen Workspaces, Team Workspace, Datenbank, Docker Images/Volumes und Logs.

Mindestanforderung fuer V1:

- Der Agent liefert regelmaessig Root-Disk-Metriken an das Control Plane.
- Das Control Plane zeigt Disk-Auslastung im VM-/Instance-Dashboard an.
- Warnschwelle, z. B. ab 75 Prozent.
- Kritische Schwelle, z. B. ab 90 Prozent.
- Alerts fuer `storage_warning` und `storage_critical`.
- Storage-Status fliesst in Health/Provisioning-/Team-Instance-Uebersicht ein.

Moegliche Massnahmen bei hoher Auslastung:

- Admin im Dashboard und per E-Mail warnen.
- Nicht notwendige Logs/alte temporaere Dateien bereinigen.
- Alte generierte Artefakte oder Cache-Verzeichnisse zur Loeschung vorschlagen.
- Backup vor groesseren Updates erzwingen, wenn noch genug Platz vorhanden ist.
- Bei kritischem Speicherstand riskante Schreibaktionen blockieren oder deutlich warnen.
- Upgrade auf groesseren Compute-/Storage-Plan anbieten.
- Spaeter: Team Workspace oder grosse Assets auf externen Object Storage auslagern.

Offen bleibt, ob Storage-Quotas in der ersten Team-Version nur als Anzeige/Warnung umgesetzt werden oder ob pro Organization/User harte Limits durchgesetzt werden.

## Compute-, Memory- und Job-Backpressure

Neben Storage sind RAM und CPU bei Team-Instanzen ein zentrales Bottleneck. Besonders Docling, OCR, Embedding-Erzeugung, Knowledge-Graph-Aufbau, Reindex, Bulk Import/Export, Backup-Vorbereitung und Studio-Batch-Jobs koennen kleine VMs blockieren oder OOM-Kills ausloesen.

Mindestanforderung:

- Schwere Jobs laufen nur in Background Queues, nie synchron im Request-Pfad.
- Schwere Knowledge-Ingestion, Docling, OCR, Embeddings und Remote Parsing starten in V1 default `off` und muessen ueber Admin-Setting, Onboarding oder Managed Policy explizit aktiviert werden.
- Vor schweren Jobs wird ein Resource Budget aus Memory, CPU, Disk, Queue-Tiefe, Container-Limits und Admin-/Managed-Policy berechnet.
- V1-Default fuer Docling/OCR bleibt max. ein schwerer Parse-Job gleichzeitig.
- Bei knappen Ressourcen werden Jobs deferiert, nativ/degradiert verarbeitet, nur als Metadaten registriert oder kontrolliert abgebrochen.
- Sicherheitspruefungen bleiben hart: Ohne erfolgreichen Secret-/PII-/ACL-Check werden keine Embeddings erzeugt.
- Admin-UI und Control Plane zeigen Parser-Status, Queue-Tiefe, Resource Profile, OOM-/Timeout-Zaehler und Backpressure-Gruende.
- Strukturierte Operational Logs erfassen Settings-Aenderungen, Resource-Entscheidungen, Queue-State, Parser-Exit, Timeout, Crash und Cleanup, aber keine Dokumentinhalte oder Secrets.

Die verbindliche Detailregel steht in `13-resource-aware-ingestion-and-job-backpressure.md`.

## Offene Entscheidungen

- Ob der Team Workspace in der ersten Version nur ein lokaler Serverordner ist oder bereits eine interne Revisionstabelle fuer Dateien bekommt.
- Wie granular Rechte im Team Workspace sein sollen: global, Ordner, Projekt oder Datei.
- Ob es direkt `project` Workspaces fuer Kunden/Kampagnen geben soll oder erst nach dem Team Workspace.
- Wie stark Better Auth Organizations/Teams in Canvas Notebook selbst genutzt werden.
- Ob der Agent im Team Workspace nur nach expliziter Auswahl schreiben darf oder ob Admins Default-Policies setzen koennen.
- Welche Dateitypen in V1 Locks bekommen und welche nur per Revision/Konflikt behandelt werden.
- Ob Team Knowledge Base als Teil des Team Workspace oder als eigene Datenquelle modelliert wird.
- Welche gepinnte Postgres-/pgvector-Image-Linie fuer den ersten produktiven Installer verwendet wird.
- Ob `CANVAS_TEAM_FEATURES_ENABLED` und verwandte Boolean-ENV-Keys langfristig benoetigt werden oder ob Canvas Notebook vollstaendig ueber `CANVAS_DEPLOYMENT_MODE` plus `CANVAS_LICENSE_CERT` entscheidet.
- Ob `CANVAS_ORGANIZATION_ID` aus dem Control Plane direkt in Canvas Notebook gespeichert wird oder nur als Claim im License Cert vorkommt.
- Ob Managed-Instance-Token neue Scopes fuer Backup-/Policy-Reporting brauchen, z. B. `backup:report`, `backup:restore`, `team:config` oder `usage:report`.
- Welche Storage-Schwellen fuer Teamplaene gelten und ob Storage-Quotas weich oder hart durchgesetzt werden.
- Ob Workspace-spezifische Speicherbelegung von Canvas Notebook gemeldet wird oder ob das Control Plane nur Host-Disk-Metriken aus dem Agent nutzt.
- Welche Compute-/Memory-Profile in Managed Plans angeboten werden und welche Defaults fuer Docling/OCR/Reindex daraus folgen.
- Welche schweren Knowledge-/Parsing-Features in welchem Plan durch Onboarding aktiviert werden duerfen und welche explizit Admin-only bleiben.
- Welche bestehenden Canvas Notebook Tabellen und Settings aktuell implizit global sind und auf `userId`, `workspaceId` oder `organizationId` migriert werden muessen.
- Ob Composio nur user-scoped startet oder ob Organization-geteilte Connections direkt in V1 benoetigt werden.
- Ob E-Mail Team-Mailboxen in V1 Teil des Teamplans sind oder ob zuerst nur User-Mailboxen unterstuetzt werden.
- Welche Notification Channels user-scoped, organization-scoped oder beides sein sollen.
- Wie optionaler Public-Link-Passwortschutz technisch und im UI umgesetzt wird.
- Ob Studio Assets spaeter zusaetzlich projekt-/kundenspezifische Sichtbarkeit bekommen.
- Welche administrativen Aktionen nur Admins duerfen und welche an feinere Rollen delegiert werden koennen.
- Welche Export-Bereiche fuer V1 enthalten sein muessen und wie Secrets/OAuth-Tokens im Export behandelt werden.
- Ob User-Plugins/Skills nur individuell installierbar sind oder ob eine Organization Registry direkt in V1 benoetigt wird.
- Ob To-dos nur Organization-intern sind oder auch aus Agent-Sessions/Automations automatisch entstehen duerfen.
- Wie Automations beim Entfernen eines Users behandelt werden: pausieren, uebertragen oder loeschen.
- Ob geteilte Agenten als kopierbare Templates oder als live referenzierte Organization-Agenten funktionieren sollen.
- Welche Better-Auth-Rollen/Metadaten fuer `owner`, `admin`, `member` und `external` genutzt werden.
- Ob externe User direkt in V1 kommen oder erst mit Projekt-/Kunden-Workspaces.
- Welche per-User Permissions als Booleans starten und welche spaeter rollenbasiert werden.
- Welche Offboarding-Schritte blockierend bestaetigt werden muessen und welche nachtraeglich korrigierbar bleiben.
- Ob reaktivierte User ihren alten Personal Workspace direkt wiederbekommen oder ob ein Restore-Schritt noetig ist.
- Wie Search/Embeddings im Postgres/pgvector-Mode konkret indiziert werden, nachdem der Provider-Gate steht.
- Welche Background-Job-Typen User-owned, Organization-owned oder System-owned sind.
- Wie User-Env, Organization-Env, Instanz-Env und Managed-Control-Plane-Env technisch zusammengefuehrt werden.
- Welche Import-Konflikte per Dry-Run erkannt werden muessen.
- Welche Retention Policies fuer Audit, Trash, Studio Assets und Backups als Default gelten.
- Wie Path Security bei Agent-Shell-/Tool-Ausfuehrungen robust erzwungen werden kann.
- Wie Projekt-/Kundenebene spaeter eingefuehrt wird, ohne Personal/Team Workspace zu migrieren.

## Umsetzungsschritte

1. Bestehende Canvas Notebook Datei- und Workspace-Zugriffe inventarisieren.
2. Bestehende Canvas Notebook Funktionen nach Scope klassifizieren: user, workspace, organization oder instance.
3. Better-Auth-basiertes Rollenmodell mit genau einem Owner, Admins, Members und optional Externals festlegen.
4. Initiales Admin-/Owner-Setup und Admin-only Rechte fuer kritische App-Funktionen absichern.
5. Per-User Permissions fuer Team Workspace, Public Links, Team-Automations, Plugin-/Skill-Freigabe und Exporte bauen.
6. Control Plane Managed Mode in Lizenz-Claims und Deployment Modes aufteilen.
7. `managedFeatures` und `managedQuotas` im Control Plane um Teamrechte erweitern.
8. `applyManagedEnvToVmConfig()` und `ensureManagedEnvForVmConfig()` um Team-ENV-Werte erweitern.
9. Control Plane Provisioning so anpassen, dass Team-Instanzen als Organization-Runtime verstanden werden, nicht als eine VM pro Mitarbeiter.
10. Workspace-Modell und Workspace-Service in Canvas Notebook einfuehren.
11. Community-Lizenz auf Single-User-Betrieb begrenzen.
12. User-spezifische persoenliche Workspaces anlegen.
13. Team Workspace fuer Team-/Managed-Lizenzen anlegen.
14. UI zum Wechsel zwischen Personal Workspace und Team Workspace bauen.
15. Kopieraktionen zwischen Personal und Team Workspace implementieren.
16. Agent-Runtime-Einstellungen und Agent-Sessions an User-/Workspace-Kontext binden.
17. Plugins, Skills und Agent-Definitionen auf User-Scope mit optionaler Organization-Teilung migrieren.
18. Secrets/Credentials pro User, Organization und Managed/System isolieren.
19. Composio-Management, E-Mail-OAuth, Notifications und Channels auf User-/Organization-Scope migrieren.
20. To-do-Management mit Organization-Scope, User-Zuweisung und Status-Tracking bauen.
21. Automations an Owner, Workspace-Auswahl und Ausfuehrungskontext binden.
22. Offboarding-Flow fuer User mit Workspace-Sicherung, Automation-Review, To-do-Behandlung und Credential-Revocation bauen.
23. Public Links workspace- und revisionsbewusst neu modellieren.
24. Studio Route auf Organization-geteilte Bibliotheken und user-filterbare Asset-Sammlung umbauen.
25. Search/Retrieval-Scope fuer spaetere Embeddings vorbereiten.
26. Background Jobs und Usage mit `userId`, `organizationId`, `workspaceId` und Job-Scope versehen.
27. Admin-only Export mit granularer Auswahl fuer Migrationen implementieren.
28. Import-Flow mit User-/Workspace-Mapping, Dry-Run und Reconnect fuer Secrets/OAuth vorbereiten.
29. Vollstaendigen Audit Trail fuer Admin, Auth, Files, Agenten, Automations, Plugins, Integrationen, Export/Import und Studio umsetzen.
30. Retention, Trash und Datenloeschung fuer Teamdaten planen.
31. Path Security fuer alle Workspace- und Agent-Dateioperationen erzwingen.
32. Projekt-/Kundenebene im Datenmodell vorbereiten.
33. Agent-Dateiaenderungen mit User, Session, Workspace und Revision auditieren.
34. Einfache Locks oder Revision-Checks fuer Team-Dateien einfuehren.
35. Storage-Monitoring und Alerts fuer Team-Instanzen im Control Plane absichern.
36. Backup- und Restore-Konzept fuer Team-Instanzen implementieren.
37. Knowledge-/Parsing-Settings mit Default-off Toggles, Resource-Status und redacted Logging umsetzen.
38. Database-Provider-Abstraktion fuer SQLite/Postgres in Canvas Notebook einfuehren.
39. Canvas Notebook CLI Installer um SQLite/Postgres-Auswahl, Team-Postgres-Zwang und Compose-Generierung erweitern.
40. Control Plane VM-Provisioning in `../canvas-control-plane` um Postgres/pgvector-Service, DB-ENV und DB-Secrets fuer Teamplaene erweitern.
41. SQLite-zu-Postgres-Migrationstool mit Maintenance Mode, Snapshot, Referenzpruefung und Reindex-Status bauen.
42. Export/Import/Backup/Restore provider-aware machen, inklusive Postgres-Dump und Provider-Kompatibilitaetspruefung.
43. RAG, Embeddings, Knowledge Graph und echte Collaboration serverseitig an Postgres/pgvector-Gates binden.

## Bezug zu bestehenden Control-Plane-Dokumenten

- Organization- und Rollenbasis: `docs/enterprise-auth-organization-plan.md`
- Stripe- und Lizenz-/Entitlement-Strategie: `docs/stripe-billing-plan.md`
- Host Maintenance fuer verwaltete Server: `docs/ubuntu-host-maintenance-plan.md`
- Managed IONOS Provisioning: `docs/ionos-reverse-proxy-plan.md`
