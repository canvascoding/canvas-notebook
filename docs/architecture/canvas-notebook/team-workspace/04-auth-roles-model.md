# Auth, Organization and Role Model

Stand: 2026-06-18

## Zweck

Dieses Dokument schliesst Umsetzungsschritt 3 ab: ein Better-Auth-basiertes Rollenmodell fuer Canvas Notebook Team-Instanzen festlegen.

## Quellen und lokaler Stand

- Lokale Better-Auth-Version: `1.6.18` (`package.json`: `^1.6.9`).
- Aktuell aktivierte Auth-Plugins: `admin()`, `bearer()`, `nextCookies()`.
- Aktuell nicht aktiv: `organization()`.
- Aktuelles Schema hat `user.role`, aber keine `organization`, `member`, `invitation` oder `organizationRole` Tabellen.
- Offizielle Better-Auth-Dokumentation:
  - Admin Plugin: https://better-auth.com/docs/plugins/admin
  - Organization Plugin: https://better-auth.com/docs/plugins/organization
  - Database/Schema-Erweiterung: https://better-auth.com/docs/concepts/database

## Grundentscheidung

Canvas Notebook nutzt fuer Team-Instanzen den Better-Auth-Organization-Plugin als fachliche Grundlage fuer Organizations, Memberships, Rollen und Invitations. Es wird keine parallele eigene Auth-Schicht gebaut.

Das globale Better-Auth-Admin-Plugin bleibt fuer instanzweite User-Verwaltung, Bootstrap, Recovery und Community-/Single-User-Kompatibilitaet erhalten. Es ist aber nicht die fachliche Quelle fuer Team-Rechte.

Damit gibt es zwei unterschiedliche Ebenen:

| Ebene | Quelle | Zweck |
|---|---|---|
| Instanzrolle | `user.role` aus Better Auth Admin Plugin | technische Instanzverwaltung, Bootstrap, Migration, Recovery |
| Organization-Rolle | Better Auth `member.role` | fachliche Team-Rechte innerhalb einer Organization |

Wichtig: `user.role === "admin"` darf langfristig nicht als alleinige Berechtigung fuer Team-Workspace-, Team-Automation-, Public-Link-, Export- oder Offboarding-Aktionen gelten. Diese Aktionen muessen Organization Membership und Organization Permissions pruefen.

## V1-Rollen

| Rolle | Quelle | Bedeutung |
|---|---|---|
| `owner` | Organization Member Role | Genau ein User pro Organization. Vollzugriff auf Organization Governance. |
| `admin` | Organization Member Role | Kann User verwalten, Policies konfigurieren, Exporte ausfuehren und Team-Funktionen administrieren. |
| `member` | Organization Member Role | Normaler interner Mitarbeiter. Darf grundsaetzlich Agenten ausfuehren und im Personal Workspace arbeiten. |
| `external` | Organization Member Role, custom | Externer Kunde/Gast. V1 nur vorbereiten, produktiv spaeter mit Projekt-/Kunden-Workspaces aktivieren. |

Better Auth bringt im Organization Plugin bereits `owner`, `admin` und `member` als Default-Rollen mit. `external` wird als Canvas-spezifische Custom Role vorbereitet, aber nicht als Kern-V1-Feature erzwungen.

## Owner- und Admin-Invarianten

V1 muss diese Invarianten serverseitig erzwingen:

1. Jede Team-/Managed-Organization hat genau einen Owner.
2. Der Owner ist immer aktives Organization-Mitglied.
3. Der Owner hat in Better Auth `member.role` die Rolle `owner`.
4. Es muss mindestens ein aktiver admin-faehiger User verbleiben.
5. Admin-faehig bedeutet in V1: Rolle `owner` oder `admin`.
6. Der letzte admin-faehige User darf nicht deaktiviert, geloescht, gebannt oder auf `member`/`external` herabgestuft werden.
7. Ein Ownership Transfer ist fuer V1 nicht als UI-Flow noetig, aber das Datenmodell darf ihn nicht blockieren.

Empfohlene technische Absicherung:

- Eine Canvas-eigene Organization-Metadaten-Tabelle speichert `ownerUserId`.
- Better Auth `member.role` bleibt die rollenbasierte Zugriffsbasis.
- Service-Transaktionen halten `ownerUserId` und `member.role` synchron.
- Last-admin-Pruefungen laufen in serverseitigen Mutations-Services, nicht nur in der UI.

## Per-User Permissions

Rollen reichen fuer die geplanten Teamrechte nicht aus. Canvas braucht zusaetzlich per-user Permissions innerhalb einer Organization.

Empfohlenes V1-Modell:

```txt
organization_user_permissions
- organizationId
- userId
- canWriteTeamWorkspace
- canCreatePublicLinks
- canCreateTeamAutomations
- canSharePluginsAndSkills
- canExport
- canDeleteTeamFiles
- canDeleteStudioAssets
- createdAt
- updatedAt
```

Default-Regeln:

| Permission | Owner | Admin | Member | External |
|---|---:|---:|---:|---:|
| Personal Workspace lesen/schreiben | ja | eigener | eigener | eigener/limitiert |
| Team Workspace lesen | ja | ja | ja | nein, bis Projekt-Scope existiert |
| Team Workspace schreiben | ja | ja | ja, wenn Team-Zugriff aktiv | nein |
| Team Workspace Dateien loeschen | ja | ja | ja, wenn Team-Zugriff aktiv | nein |
| Public Links aus Personal Workspace | ja | eigener | eigener | nein |
| Public Links aus Team Workspace | ja | ja | ja, wenn Team-Zugriff aktiv | nein |
| Team-Automations erstellen | ja | ja | nein in V1 | nein |
| Personal Automations erstellen | ja | ja | ja, im eigenen Personal Workspace | nein/limitiert |
| Plugins/Skills teilen/freigeben | ja | ja | nur wenn erlaubt | nein |
| Vollstaendige Exporte | ja | ja | nur wenn explizit erlaubt, default nein | nein |
| Postgres Migration / Full Backup | ja | ja | nein | nein |
| Studio Assets loeschen | ja | ja | ja, wenn Studio-Zugriff aktiv | nein |
| Andere User-To-dos sehen/bearbeiten | ja | ja | nein, ausser spaetere Delegation | nein |
| Offboarding starten | ja | ja | nein | nein |

Diese Permissions sind Organization-spezifisch und duerfen nicht im globalen `user.role` gespeichert werden.

Owner-Regel:

- Der Owner hat immer Team-Workspace-Rechte, inklusive Lesen, Schreiben, Loeschen, Public-Link-Verwaltung, Migration und Full Backup.

Public-Link-Details:

- Eigene Personal-Workspace-Dateien duerfen public geteilt werden.
- Team-Dateien duerfen in V1 von allen aktiven internen Usern public geteilt und verwaltet werden, die im Team Workspace arbeiten duerfen.
- `canCreatePublicLinks` bleibt als explizites Permission-Feld erhalten, default ist fuer Owner/Admin und teamfaehige Member aber `true`.
- Eine spaetere restriktivere Organization Policy kann Public Links global oder folder-/workspace-scoped einschraenken.
- Public Links folgen in V1 der neuesten Dateiversion und werden bei Move/Delete deaktiviert.

Automations-Details:

- Personal Automations duerfen alle internen User in ihrem eigenen Personal Workspace erstellen.
- Personal Automations duerfen den Team Workspace nur lesen, wenn die normale Cross-Workspace-Read-Policy das erlaubt.
- Automations mit Team-Workspace-Schreibrechten oder Organization-Scope duerfen nur Owner/Admins erstellen.
- Jede Automation hat einen verantwortlichen User; beim Archivieren/Deaktivieren dieses Users wird die Automation pausiert und muss neu zugeordnet werden.

External-Regel:

- `external` bekommt in V1 keinen direkten Team-Workspace-Zugriff.
- Externe Mitarbeit ist fuer spaetere Projekt-/Kunden-Workspaces vorgesehen.

## Organization-Identitaet

Eine Canvas Notebook Team-Instanz bedient genau eine Organization. Trotzdem soll `organizationId` explizit gespeichert werden, damit Export/Import, Audit, Backups und spaetere Migrationen stabil bleiben.

Aufloesungsreihenfolge fuer die initiale Organization-ID:

1. `CANVAS_ORGANIZATION_ID`, wenn gesetzt.
2. `organizationId` Claim aus `CANVAS_LICENSE_CERT`, sobald Control Plane Claims erweitert sind.
3. Lokal generierte ID fuer Community/Development/Legacy-Migration.

Die persistierte Organization-ID ist danach die lokale Wahrheit. Bei Managed-Instanzen muss sie gegen Env/License Claim abgeglichen werden; ein Konflikt ist ein Start-/Health-Problem und darf nicht still ignoriert werden.

## Empfohlene Tabellen

Better Auth Organization Plugin Tabellen:

```txt
organization
- id
- name
- slug
- logo?
- metadata?
- createdAt

member
- id
- userId
- organizationId
- role
- createdAt

invitation
- id
- email
- inviterId
- organizationId
- role?
- status
- createdAt
```

Canvas-spezifische Tabellen:

```txt
canvas_organization_settings
- organizationId
- ownerUserId
- deploymentMode
- teamFeaturesEnabled
- createdAt
- updatedAt

organization_user_permissions
- organizationId
- userId
- canWriteTeamWorkspace
- canCreatePublicLinks
- canCreateTeamAutomations
- canSharePluginsAndSkills
- canExport
- canDeleteTeamFiles
- canDeleteStudioAssets
- createdAt
- updatedAt
```

Optional spaeter:

```txt
organization_user_status
- organizationId
- userId
- status: active | archived | disabled
- archivedAt?
- disabledAt?
- disabledReason?
```

Wenn Better Auth Member- oder User-Felder sauber erweiterbar sind, koennen einzelne Canvas-Felder dort liegen. Fuer V1 ist eine eigene Canvas-Permission-Tabelle robuster, weil sie unabhaengig von Better-Auth-Plugin-Migrationen und Custom Role Storage bleibt.

## Server-Gates

Neue serverseitige Guards:

```txt
requireInstanceAdmin()
requireOrganizationSession()
requireOrganizationRole(role[])
requireOrganizationPermission(permission)
requireWorkspaceAccess(workspaceId, action)
```

Bestehende `isAdminUser()`-Nutzung muss danach klassifiziert werden:

- Instanz-/Migration-/Recovery-Aktion: darf `requireInstanceAdmin()` bleiben.
- Team-/Organization-Aktion: muss auf Organization Role/Permission wechseln.
- User-private Aktion: prueft Session-User und Owner des Objekts.

## Bootstrap-Verhalten

Community/Single-User:

- Erstnutzer bleibt globaler `admin`.
- Eine lokale Default-Organization kann trotzdem angelegt werden, aber Team-Features bleiben per Lizenz/Deployment Mode gesperrt.
- Personal Workspace kann spaeter aus `data/workspace` gemappt werden.
- `/setup` und `bootstrap-admin` muessen denselben Zielzustand erzeugen: User, lokale Organization, Owner Membership, Owner Permissions, Personal Workspace und scoped User-Runtime-Verzeichnisse.

Managed-Team:

- Erstnutzer wird globaler Instanz-Admin fuer Recovery.
- Erstnutzer wird Organization Owner.
- Organization wird aus `CANVAS_ORGANIZATION_ID` oder License Claim initialisiert.
- Default Permissions fuer Owner/Admin werden gesetzt.
- Weitere User entstehen ueber Admin/Invitation-Flows, nicht ueber offenes Signup.
- Team Workspace wird initial leer angelegt; bestehende `data/workspace`-Daten werden nicht automatisch Team-Daten.

Die detaillierte Fresh-Install- und Update-Migrationslogik ist in `09-initial-setup-and-update-migration.md` verbindlich dokumentiert. Besonders wichtig: Wenn bei einem Update mehrere moegliche Owner-Kandidaten existieren, muss die Migration stoppen und Admin-Review verlangen, statt zufaellig einen Owner zu waehlen.

## Umsetzungsschritte fuer Todo 4/5

1. Better Auth `organization()` serverseitig in `app/lib/auth.ts` ergaenzen.
2. `organizationClient()` in `app/lib/auth-client.ts` ergaenzen.
3. Drizzle-Schema/Migration fuer Organization-Plugin-Tabellen und Canvas-Permission-Tabellen ergaenzen.
4. Bootstrap-Setup so erweitern, dass Erstnutzer Organization Owner wird.
5. Bootstrap-Setup so erweitern, dass Personal Workspace und scoped User-Runtime-Verzeichnisse entstehen.
6. Update-Migration fuer bestehende Single-User-Instanzen mit eindeutiger Owner-Aufloesung bauen.
7. Guards fuer Instance Admin, Organization Role und Organization Permission bauen.
8. Bestehende Admin-Gates klassifizieren und nur passende Gates ersetzen.
9. User Management UI spaeter von globalen `admin/user` Rollen auf Organization Membership umstellen.

## Tests fuer die erste Implementierung

- Bootstrap erzeugt Erstnutzer, Organization, Owner Membership und Owner Settings.
- Bootstrap erzeugt Personal Workspace, User-Runtime-Root und aktiven Default Workspace.
- `/setup` und `bootstrap-admin` erzeugen denselben Zielzustand.
- Unvollstaendiger Bootstrap wird beim naechsten Start idempotent vervollstaendigt.
- Community Mode laesst nur Single-User-Teamfunktionen zu.
- Managed-Team Mode verlangt Organization-ID aus Env oder License Claim.
- Bestehende Single-User-Instanz migriert `data/workspace` in den Owner-Personal-Workspace.
- Mehrdeutige bestehende Multi-User-Instanz stoppt mit Admin-Review.
- Member darf keine Admin-/Export-/Team-Policy-Aktion ausfuehren.
- Member mit Team-Zugriff darf Team-Dateien schreiben, loeschen und Public Links verwalten, solange `canCreatePublicLinks` durch keine Organization Policy deaktiviert ist.
- External darf den Team Workspace nicht lesen.
- Admin darf Member-Permissions aendern.
- Nur Owner/Admin darf Postgres Migration oder Full Backup starten.
- User mit Studio-Zugriff darf Studio Assets loeschen; Loeschung wird auditiert.
- Owner kann nicht entfernt oder herabgestuft werden.
- Letzter admin-faehiger User kann nicht deaktiviert, geloescht oder gebannt werden.
- `npm run build` nach Code-Aenderungen.

## Offene Punkte

- Ob `external` in V1 nur als reservierter Rollenwert oder schon als Better-Auth-Custom-Role registriert wird.
- Ob Ownership Transfer direkt mit implementiert wird oder nur als Service-intern vorbereitete Operation.
- Ob globale Better-Auth-Admin-User in Managed-Team produktiv sichtbar bleiben oder nur fuer Recovery/Support gedacht sind.
- Wie stark Better Auth Invitations in der ersten Team-Version genutzt werden oder ob Admins User zunaechst direkt anlegen.
