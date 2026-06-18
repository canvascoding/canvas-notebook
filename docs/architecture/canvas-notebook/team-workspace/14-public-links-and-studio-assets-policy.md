# Public Links und Studio Asset Policy

Stand: 2026-06-18

## Zweck

Dieses Dokument konkretisiert zwei bisher offene Produktentscheidungen im Team-Workspace-Umbau:

- Public Links fuer Personal- und Team-Workspace-Dateien.
- Organization-weite Studio Assets und Save-/Copy-to-Workspace.

Es ergaenzt die Aufgaben `23`, `24`, `29` und `30` im Aufgabenindex.

## Public Links

### Berechtigung

Personal Workspace:

- Dateien im eigenen Personal Workspace duerfen oeffentlich geteilt werden.
- Ein User darf keine Public Links fuer fremde Personal Workspaces erstellen.
- Organization Policies koennen Public Links global deaktivieren, aber der V1-Produktdefault erlaubt Public Links fuer den eigenen Personal Workspace.

Team Workspace:

- Team-Dateien duerfen nur oeffentlich geteilt werden, wenn der User Owner/Admin ist oder die explizite Permission `canCreatePublicLinks` hat.
- Team-Share-Erstellung muss serverseitig gegen Organization Membership, Workspace-Zugriff und Permission geprueft werden.
- Ein Team-Public-Link speichert immer `organizationId`, `workspaceId`, `createdByUserId` und Zielreferenz.

### Latest-Verhalten

V1-Public-Links zeigen auf die jeweils neueste Version der Datei.

Regeln:

- Der Link ist nicht auf eine historische Revision gepinnt.
- Datei-Updates werden automatisch unter demselben Public Link sichtbar.
- Der Share speichert trotzdem die letzte bekannte Revision oder den letzten Content Hash fuer Audit und Debugging.
- Eine spaetere Option fuer feste Revisionen ist moeglich, aber nicht V1-Default.

### Move, Delete und Revocation

Wenn die geteilte Datei verschoben oder geloescht wird, wird der Public Share beendet.

Regeln:

- Delete der Ziel-Datei widerruft oder deaktiviert den Public Link.
- Move/Rename der Ziel-Datei widerruft oder deaktiviert den Public Link in V1.
- Workspace-Delete oder Workspace-Archive deaktiviert alle betroffenen Public Links.
- Der Public Endpoint darf dann keinen Fallback auf alte Pfade oder absolute Serverpfade versuchen.
- Reaktivierung nach Move ist eine neue explizite Share-Aktion.

### Ablauf, View und Download

- Ablaufdatum/Expiration bleibt Bestandteil der Share-Policy.
- Wenn eine Datei public ist, darf sie gesehen und heruntergeladen werden.
- V1 braucht keine getrennte View-only-vs-Download-Policy.
- Optional spaeter kann Download-Blocking oder View-only ergaenzt werden, aber das ist kein aktueller Default.

### Passwortschutz

Passwortgeschuetzte Public Links werden als spaetere Erweiterung vorbereitet.

V2-Anforderungen:

- Optionaler Passwortschutz pro Public Link.
- Passwort nur gehasht speichern, nie im Klartext.
- Rate Limits fuer Passwortversuche.
- Audit/Operational Log fuer fehlgeschlagene und erfolgreiche Passwortfreigaben.
- Expiration und Revocation greifen unabhaengig vom Passwort.

### Audit und Logs

Zu auditieren:

- Public Link erstellt.
- Public Link widerrufen/deaktiviert.
- Public Link wegen Move/Delete/Workspace-Archive automatisch deaktiviert.
- Ablaufdatum geaendert.
- Optional spaeter Passwortschutz aktiviert/deaktiviert.

Operational Logs duerfen keine absoluten Serverpfade oder geheimen Tokens enthalten.

## Studio Assets und geteilte Bibliotheken

### Sichtbarkeit

In Team-Instanzen sind generierte Studio Assets organizationweit sichtbar.

Regeln:

- Es gibt in V1 keine privaten Studio Generations.
- Studio Generations, Outputs und Assets speichern `organizationId` und `createdByUserId`.
- Die Studio UI zeigt organizationweite Assets.
- Die Studio UI bekommt einen Filter nach Creator/User, damit Assets eines bestimmten Users schnell gefunden werden koennen.
- Spaetere Projekt-/Kundenfilter bleiben vorbereitet, sind aber nicht V1-Pflicht.

### Creator und Offboarding

Offboarding archiviert den User, loescht aber seine Studio Assets nicht automatisch.

Regeln:

- Assets bleiben organizationweit sichtbar.
- `createdByUserId` bleibt erhalten.
- UI zeigt den Creator weiter an, bei archivierten Usern mit Archiv-/Deaktiviert-Status.
- Audit- und Usage-Zuordnung bleiben erhalten.
- Loeschung von Assets ist keine automatische Offboarding-Folge.

### Loeschen

Studio Assets sind keine privaten Generations. In V1 duerfen Organization User mit Studio-Zugriff Assets loeschen, sofern keine restriktivere Organization Policy gesetzt ist.

Sicherheitsregeln:

- Loeschungen muessen auditiert werden.
- Loeschung sollte als Soft Delete/Trash modelliert werden, wenn Storage und Retention das erlauben.
- Referenzen aus Workspaces, Public Media Routes oder Jobs muessen vor physischer Loeschung geprueft werden.
- Admin Cleanup kann spaeter strengere Regeln oder Bulk-Loeschung ergaenzen.

### Save/Copy to Workspace

Studio Outputs bleiben zunaechst im Studio Asset/Output Store. Wenn ein User ein oder mehrere Outputs in einen Workspace kopieren oder verschieben will, muss ein Dialog den Ziel-Workspace abfragen.

UI-Anforderung:

- Copy-/Save-to-Workspace oeffnet einen verpflichtenden Ziel-Dialog.
- Der Dialog erlaubt:
  - eigener Personal Workspace,
  - Team Workspace, wenn der User dort schreiben darf.
- Der aktive globale Workspace kann vorausgewaehlt werden, ersetzt aber nicht die serverseitige Pruefung.
- Team-Ziel ist sichtbar, aber deaktiviert oder mit klarer Fehlermeldung gesperrt, wenn Permission fehlt.
- Bei Batch-Auswahl zeigt der Dialog Anzahl der Outputs, Zielordner, Namenskollisionen und erwartete Pfade.

API-Anforderung:

- Request enthaelt `outputIds`, `targetWorkspaceId`, `targetPath` und Operationstyp `copy` oder spaeter `move`.
- Server prueft Organization-Sichtbarkeit des Outputs.
- Server prueft Schreibrecht im Ziel-Workspace.
- Server schreibt nur ueber den Workspace Resolver.
- Server speichert `sourceStudioOutputId`, `createdByUserId`, `copiedByUserId`, `workspaceId` und optional `sessionId`.

Nicht erlaubt:

- Save/Copy ohne `targetWorkspaceId` in Team-Instanzen.
- Save/Copy in fremde Personal Workspaces.
- Save/Copy in den Team Workspace ohne Team-Write-Permission.

## Tests

Pflichttests:

- User kann eigene Personal-Workspace-Datei public teilen.
- User kann fremde Personal-Workspace-Datei nicht public teilen.
- Team-Datei public teilen ist fuer Admin/Owner erlaubt.
- Team-Datei public teilen ist fuer Member ohne `canCreatePublicLinks` blockiert.
- Public Link liefert nach Datei-Update die neueste Version.
- Delete der Datei deaktiviert Public Link.
- Move/Rename der Datei deaktiviert Public Link.
- Public Link erlaubt View und Download.
- Passwortschutz ist als nicht aktiver V2-Flag/Schema vorbereitet, aber nicht V1-Pflicht.
- Studio Assets sind organizationweit sichtbar.
- Studio UI kann Assets nach `createdByUserId` filtern.
- Offboarding archiviert User, aber loescht Studio Assets nicht.
- Studio Save/Copy fragt Ziel-Workspace ab.
- Studio Save/Copy in Team Workspace ohne Permission wird blockiert.
- Studio Asset Delete schreibt Audit Event und respektiert Soft-Delete/Retention-Policy.

## Noch separat zu klaeren

Diese Themen sind nicht durch dieses Dokument entschieden:

- Granularer Export/Import/Backup/Restore.
- Offboarding-Schritte und Blocker.
- Konflikte, Logs, Revisionen und Locking fuer Team-Dateien.
