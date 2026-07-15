# Excalidraw Live Collaboration Policy

Stand: 2026-07-15

## Zweck und Abgrenzung

Dieses Dokument plant echte Multi-User-Bearbeitung fuer `.excalidraw`-Dateien in Canvas Team Workspaces. Excalidraw wird als eigene Collaboration-Repraesentation behandelt und ausdruecklich nicht in Aufgabe `48` fuer Markdown-/Text-Yjs-Collaboration aufgenommen.

Gemeinsam genutzt werden duerfen die Canvas-Querschnittsmechaniken aus Aufgabe `48`:

- kurzlebige Collaboration-Tickets,
- Session-, Organization-, Workspace- und Datei-Permissions,
- WebSocket-Upgrade-Routing auf dem bestehenden App-Port,
- Workspace-weite Presence fuer File Tree, List und Grid,
- Postgres-Health, Persistenz, Audit und Datei-Checkpoints,
- stabile Dokumentidentitaet und Datei-Lifecycle-Regeln.

Nicht gemeinsam genutzt wird die Dokumentrepraesentation. Eine Excalidraw-Szene ist weder ein `Y.Text` noch ein Tiptap-`Y.XmlFragment`. Ihre Elemente besitzen bereits eigene IDs, Versionen, `versionNonce`, Loeschmarker, Bindings und Fractional Indices. Sie brauchen einen Excalidraw-spezifischen Scene-Provider und eine gegen die offizielle Reconciliation-Semantik getestete Merge-Logik.

## Status quo in Canvas

Canvas Notebook verwendet aktuell `@excalidraw/excalidraw` `0.18.1` als eingebettete npm-Komponente.

Der bestehende Editor:

- liest und schreibt portable `.excalidraw`-JSON-Dateien,
- serialisiert bei `onChange` die vollstaendige Szene inklusive `appState` und `files`,
- reicht das Ergebnis an den allgemeinen Editor-Draft weiter,
- speichert die komplette Datei nach drei Sekunden per Whole-File-Autosave,
- setzt `isCollaborating={false}`,
- laedt externe Dateiaenderungen nur neu, wenn der lokale Draft nicht dirty ist.

Die bestehende File-Collaboration-Policy behandelt nur `.md`, `.markdown` und `.txt` als `crdt_text`. `.excalidraw` faellt derzeit auf `revision_check` zurueck. Zwei gleichzeitig geoeffnete Clients koennen deshalb keine live konvergierende Szene bearbeiten; sie konkurrieren weiterhin um komplette JSON-Dateistaende.

## Offizieller Excalidraw-Befund

### npm-Editor ist nicht die Collaboration-App

Der offizielle Excalidraw-README trennt den eingebetteten npm-Editor von `excalidraw.com`. Real-Time Collaboration, E2EE und Local-first-Speicherung sind Funktionen der zusaetzlichen Web-App-Schicht. Die npm-Prop `isCollaborating` zeigt nur an, dass der Host die Komponente im Collaboration-Modus betreibt; sie startet weder Netzwerk, Room noch Persistenz.

Die offiziellen Maintainer beschreiben fuer Consumer zwei Wege:

1. die komplette `excalidraw-app` zusammen mit `excalidraw-room` forken und selbst bauen,
2. die benoetigte Collaboration-Logik in die eigene Integration uebernehmen, um keinen dauerhaften eigenen Excalidraw-Package-Fork warten zu muessen.

### Offizielle OSS-Architektur

Die aktuelle Open-Source-App verwendet:

- `socket.io-client` und einen Room mit zufaelliger Room-ID,
- einen im Share-Link liegenden Room-Key zur clientseitigen Verschluesselung,
- `SCENE_INIT` und `SCENE_UPDATE` fuer Szenenelemente,
- volatile Nachrichten fuer Cursor, Selektion, Idle und Follow-Mode,
- `reconcileElements()` fuer elementweise Konfliktaufloesung,
- `version` und bei Gleichstand `versionNonce` als deterministischen Gewinner,
- Fractional Indices fuer stabile Elementreihenfolge,
- periodischen Full-Scene-Sync zur Reparatur verlorener Nachrichten,
- Firebase/Firestore fuer verschluesselte Szenenpersistenz,
- Firebase Storage fuer separat gespeicherte Bild-/Binary-Dateien.

`excalidraw-room` ist laut eigenem README ein Beispiel-Collaboration-Server. Sein aktueller Code nimmt frei gewaehlte Room-IDs an und leitet verschluesselte Payloads per Socket.IO an andere Room-Mitglieder weiter. Er besitzt keine Canvas-Authentifizierung, keine Workspace-Permission-Pruefung, keine dauerhafte Szenenspeicherung und keine serverseitige Reconciliation. Das macht ihn zu einer nuetzlichen Protokollreferenz, aber nicht zu einem ungeaendert produktionsfaehigen Canvas-Team-Backend.

### Excalidraw+ ist kein eingebetteter Realtime-SDK

Die gehostete kostenlose Excalidraw-App erlaubt bereits unbegrenzt viele Collaborators. Excalidraw+ ergaenzt unter anderem Cloud-Persistenz, Zugriffsverwaltung, Teams und weitere Produktfunktionen.

Die aktuelle Excalidraw+-API ist eine REST-API in Public Beta fuer Scenes, Collections, Users, Invites, Logs und Workspace-Ressourcen. Der dokumentierte `PATCH`-Endpoint merged Elemente nach ID, `version` und `versionNonce`, zwingt verbundene Editoren aber ausdruecklich nicht zum Reload und kann bei paralleler Aenderung temporaer divergieren. Er ist damit keine dokumentierte Realtime-Transport-API fuer den eingebetteten Canvas-Editor.

Excalidraw+-Self-Hosting inklusive Real-Time Services und SSO ist noch in Entwicklung und fuer eine kuenftige Enterprise-Lizenz angekuendigt. Es kann spaeter neu bewertet werden, ist aber heute keine belastbare Abhaengigkeit fuer Canvas Team Workspaces.

## Bewertete Optionen

| Option | Startaufwand | Canvas-Integration | Betrieb/Daten | Langfristige Wartung | Entscheidung |
|---|---:|---|---|---|---|
| Vollstaendige `excalidraw-app` plus `excalidraw-room` forken | niedrig fuer einen Demo-Stack | schwach; eigene App-, Auth-, URL- und Datei-Wahrheit | zusaetzlicher Client/Relay/Storage; Auth und Persistenz fehlen trotzdem | hoch durch dauerhaften Upstream-Fork | nur Spike-/Referenzoption |
| Unveraendertes `excalidraw-room` an den npm-Editor haengen | mittel | unvollstaendig; npm-Paket enthaelt den benoetigten Collab-Wrapper nicht | Relay ohne Canvas-Permissions/Persistenz | hoch und sicherheitskritisch | ausgeschlossen |
| Excalidraw+ als externe SaaS-Wahrheit | niedrig fuer externes Oeffnen | schwach; separate Accounts, Workspaces, URLs und Dateiquelle | Excalidraw-Cloud und weiteres Abo | Anbieter-/Beta-API-Abhaengigkeit | optional spaeter, nicht Standard |
| Szene als ein JSON-String in `Y.Text` synchronisieren | scheinbar niedrig | technisch moeglich, aber falsche Konfliktgranularitaet | Canvas-intern | hohe Konflikt-/Undo-/Payload-Risiken | ausgeschlossen |
| Canvas-nativer Excalidraw Scene Provider mit offizieller Reconciliation-Semantik | mittel | hoch; bestehender Editor und `.excalidraw`-Datei bleiben erhalten | bestehender Canvas-Port, Postgres und Workspace-Speicher | kontrollierbar ohne Package-Fork | bevorzugtes Zielbild |

## Vorlaeufige Empfehlung und Entscheidungstor

Bevor Produktcode umgesetzt wird, baut Aufgabe `52` einen kleinen Zwei-Client-Spike. Er vergleicht:

- einen Canvas-nativen Scene-Provider um den bestehenden npm-Editor,
- die minimal erforderlichen Teile des offiziellen `Portal`-/`Collab`-Flows,
- optional einen isolierten Fork-Prototyp nur als Aufwand-Benchmark.

Der Spike muss nachweisen:

1. Zwei Canvas-User bearbeiten dieselbe vorhandene Workspace-Datei und konvergieren.
2. Gleichzeitige Aenderungen verschiedener Elemente gehen nicht verloren.
3. Gleichzeitige Aenderungen desselben Elements folgen deterministisch `version`/`versionNonce` und der lokalen In-Progress-Schutzregel.
4. Loeschen, Undo/Redo, Bindings, Gruppen, Frames und Elementreihenfolge bleiben gueltig.
5. Bilder werden nicht bei jedem Pointer-Move als komplette Data-URL uebertragen.
6. Reconnect und Server-Neustart laden denselben persistierten Szenenstand.
7. Der vorhandene npm-Package-Pfad bleibt upgradefaehig; ein Fork ist nicht erforderlich.

Wenn diese Kriterien erfuellt sind, wird der Canvas-native Provider umgesetzt. Ein Fork darf nur gewaehlt werden, wenn der Spike einen dokumentierten Blocker der oeffentlichen npm-API nachweist und Upgrade-, Security-, Storage- und Lizenzkosten explizit akzeptiert werden.

## Zielarchitektur

```txt
Canvas ExcalidrawEditor (@excalidraw/excalidraw)
        | onChange / onPointerUpdate / updateScene / addFiles
        v
Canvas Excalidraw Scene Provider
        | authenticated excalidraw-v1 messages
        v
/ws/collaboration auf dem bestehenden App-Port
        | Ticket + Workspace Permission + Room Registry
        v
Excalidraw Scene Repository in Postgres
        | serialisierte Reconciliation + Scene Sequence
        +----> Workspace Asset Store fuer BinaryFiles
        |
        +----> versionierter .excalidraw-Datei-Checkpoint
                    + file_revisions + Audit + File Watcher

Workspace Presence Registry
        +----> File Tree / List / Grid
```

Task `48` darf den gemeinsamen Upgrade-Router, Ticket-Issuer und Presence-Bus liefern. Hocuspocus bleibt nur fuer Yjs-Dokumente zustaendig. Der Upgrade-Router leitet anhand von Ticket/Protokoll auf `yjs-v1` oder `excalidraw-v1`; ein Excalidraw-Room wird nicht als Hocuspocus-`Y.Doc` modelliert.

## Dokumentidentitaet und Datenmodell

Eine kollaborative `.excalidraw`-Datei besitzt dieselbe stabile `collaborationDocumentId`-Semantik wie Text-Collaboration:

- Pfad ist kein Room-Key.
- Rename/Move behaelt Dokument-ID und Generation.
- Copy und Cross-Workspace-Copy erzeugen eine neue Dokument-ID und neuen Szenenzustand.
- Delete flusht, checkpointet und archiviert den Room.
- Restore reaktiviert einen konsistenten Checkpoint mit neuer Lifecycle-Generation.

`collaboration_documents` wird um einen Provider beziehungsweise Document Kind fuer Excalidraw erweitert, zum Beispiel:

```ts
type CollaborationProvider = "yjs" | "excalidraw";
type CollaborationDocumentKind =
  | "tiptap_markdown"
  | "raw_text"
  | "excalidraw_scene";
```

Der persistierte Szenenstand enthaelt mindestens:

- alle Elemente inklusive noch benoetigter `isDeleted`-Tombstones,
- persistierbaren `appState`, aber keine rein lokale Viewport-/Dialog-/Selection-Zustaende,
- Datei-/Asset-Metadaten,
- `sceneSequence`, Schema- und Excalidraw-Version,
- letzte materialisierte File Revision,
- Lifecycle-Generation und Status,
- Hash des kanonischen Szenenstands.

## Protokoll und Reconciliation

### Autoritative Nachrichten

V1 verwendet getrennte, versionierte Nachrichtentypen:

- `scene:init`: autoritativer Snapshot plus Sequence,
- `scene:update`: geaenderte Elemente inklusive Tombstones und erwartete Base-Sequence,
- `scene:ack`: akzeptierte Sequence, persistierter Status und Hash,
- `scene:resync_required`: Client fordert neuen Snapshot an,
- `asset:announce`, `asset:uploaded`, `asset:available`,
- `presence:pointer`, `presence:selection`, `presence:idle`, `presence:leave`.

Cursor, Selection und Idle sind fluechtig, gedrosselt und duerfen bei Last verworfen werden. Szenenaenderungen sind nicht volatil und brauchen Message-ID, Idempotenz und Acknowledgement.

### Merge-Regeln

Die serverseitige Scene-Apply-Section ist pro Dokument serialisiert. Sie:

1. prueft Ticket, Write-Permission, Dokumentgeneration, Schema, Payload- und Elementlimits,
2. restauriert/validiert Excalidraw-Elemente,
3. merged nach Element-ID,
4. bevorzugt die hoehere `version`,
5. entscheidet bei gleicher Version deterministisch ueber `versionNonce`,
6. behaelt Tombstones lange genug fuer Offline-/Reconnect-Konvergenz,
7. normalisiert und validiert Fractional Indices, Bindings, Gruppen und referenzierte Elemente,
8. persistiert Szene und monotone `sceneSequence` atomar,
9. broadcastet nur den akzeptierten Zustand beziehungsweise die akzeptierten Deltas.

Die Clientseite verwendet die offiziell exportierte `reconcileElements()`-Funktion oder eine gegen die exakte Upstream-Version getestete kompatible Fassung. Remote-Updates werden mit `CaptureUpdateAction.NEVER` ueber `updateScene()` angewendet, damit sie nicht in den lokalen Undo-Stack geraten. Elemente, die der lokale Client gerade textuell editiert, erstellt oder resized, folgen der offiziellen lokalen Schutzregel; nach Abschluss wird gegen den aktuellen autoritativen Stand erneut reconciled.

Alle uebernommenen oder angepassten Upstream-Teile werden in Aufgabe `51` mit Commit, MIT-Lizenztext und Copyright-Hinweis inventarisiert.

## Source of Truth, Persistenz und Checkpoints

Im aktiven Collaboration-Modus ist der persistierte Excalidraw-Szenenstand die schreibbare Wahrheit. Die Workspace-Datei bleibt ein portabler, versionierter Checkpoint fuer:

- normalen Download und Re-Import,
- Public Links und Read-only Preview,
- Backups, Exporte und Restore,
- Agent-/Tool-Reader,
- File-System-Interoperabilitaet.

Der aktuelle Drei-Sekunden-Whole-File-Autosave wird fuer verbundene Excalidraw-Rooms deaktiviert. Stattdessen erzeugt der Server debounced und bei Room-Leerstand, kontrolliertem Shutdown sowie Lifecycle-Aktionen eine kanonische `.excalidraw`-Datei und eine File Revision.

Die UI unterscheidet:

- `connecting`,
- `live`,
- `persisting`,
- `saved`,
- `offline/reconnecting`,
- `read_only`,
- `degraded/conflict`.

Bei Persistence-Fehler darf der Editor keinen falschen Saved-Status anzeigen. Er faellt auch nicht still auf Whole-File-Autosave zurueck.

## Binary Files und Bilder

Die heutige Canvas-Serialisierung bettet `BinaryFiles` als Data-URLs in die JSON-Datei ein. Das bleibt fuer portable Checkpoints moeglich, darf aber nicht das Live-Protokoll bestimmen.

V1 speichert Binary Files separat im workspace-scoped Asset Store:

- `fileId` und Content-Hash identifizieren ein Asset,
- Upload erfolgt einmalig ueber authentifizierte, begrenzte API oder signierte URL,
- WebSocket-Nachrichten transportieren nur Metadaten und Verfuegbarkeitsstatus,
- Empfaenger laden fehlende Assets permission-geprueft nach und rufen `addFiles()` auf,
- MIME, Groesse, Dateisignatur und Workspace-Zuordnung werden serverseitig validiert,
- verwaiste Assets werden erst nach Retention-/Referenzpruefung bereinigt,
- der portable `.excalidraw`-Checkpoint kann referenzierte Assets wieder einbetten oder nach einer versionierten Canvas-Erweiterung referenzieren; Standard-Export muss interoperabel bleiben.

## Auth, Presence und Datenschutz

Der Browser darf weder Room-ID noch User-/Workspace-Scope frei bestimmen. Ein serverseitig ausgestelltes, kurzlebiges Ticket bindet:

```txt
userId
organizationId
workspaceId
collaborationDocumentId
permission: read | write
sessionId
provider: excalidraw
schemaVersion
expiresAt
```

Membership- oder Permission-Entzug wird beim Reconnect und waehrend laufender Sessions revalidiert. Read-only-User koennen Szene und Presence empfangen, aber keine Szene oder Assets mutieren.

Editor-Cursor und Selections verwenden die `onPointerUpdate`-/`collaborators`-APIs von Excalidraw. File-Tree-Presence verwendet weiterhin den gemeinsamen Canvas-Workspace-Snapshot/-Delta-Bus und tritt keinem Szenen-Room bei.

Die offizielle Excalidraw-App verwendet E2EE mit einem Room-Key im URL-Fragment. Canvas V1 hat dagegen eine authentifizierte serverseitige Quelle fuer Checkpoints, Berechtigungen, Public Links, Backups und spaetere Agent-Operationen. Deshalb darf E2EE nicht still behauptet werden. Das Architektur-Gate entscheidet transparent zwischen:

- Canvas als vertrauenswuerdigem Server mit TLS, Zugriffskontrolle und Verschluesselung at rest, oder
- echtem E2EE mit clientseitigem Key-Management und den daraus folgenden Einschraenkungen fuer Server-Validation, Agenten, Preview, Backup und Recovery.

Ohne explizit geloestes Key-/Recovery-Modell ist die erste Canvas-native Version nicht Ende-zu-Ende-verschluesselt und wird auch nicht so beworben.

## Externe Writes, Agenten und Datei-Lifecycle

- File-Tools, Shell, Automations und Integrationen duerfen einen aktiven Excalidraw-Room nicht als komplette Datei ueberschreiben.
- Ein externer File-Watcher-Write erzeugt einen sichtbaren Konflikt-/Import-Flow; er wird nicht automatisch live gemerged.
- Agenten bearbeiten Excalidraw in V1 nur ueber einen servervalidierten Scene-Patch oder Review-Vorschlag, nie als unkontrollierten JSON-String.
- Solange Elementziele, Versionen, Bindings, Assets und Review-UI nicht sicher modelliert sind, bleiben direkte Agent-Writes bei aktiven Menschen blockiert.
- Public Links bleiben read-only und lesen den letzten bestaetigten Datei-Checkpoint.
- Full Backup und Restore enthalten Excalidraw-Szenenrepository, Assets, Collaboration-Metadaten und materialisierte Dateien.

## Umsetzungsphasen fuer Aufgabe 52

Die Phasen laufen nach Abschluss der jeweils vorherigen Phase:

1. **Architecture Spike:** Zwei-Client-Prototyp, npm-API-Grenzen, offizielle Reconciliation, Undo/Redo, Assets, Reconnect und Fork-Vergleich pruefen; Zielvariante dokumentiert freigeben.
2. **Datenmodell und Repository:** Provider/Kind, Szene, Sequence, Tombstones, Generation, Asset-Referenzen und Checkpoint-Metadaten in Postgres implementieren.
3. **Transport und Auth:** `excalidraw-v1` im gemeinsamen Upgrade-Router, Tickets, Permissions, Limits, Heartbeat, ACK/Resync und serialisierte Apply-Section bauen.
4. **Editor Provider:** Whole-File-Autosave deaktivieren, lokale Deltas/Elemente senden, Remote-Szene reconciliieren, Collaborators/Cursor rendern und Provider-Lifecycle hardenen.
5. **Assets:** separate workspace-scoped Upload-/Download-/Retention-Pipeline und portablen Checkpoint-Roundtrip umsetzen.
6. **Presence und UX:** File-Tree-/List-/Grid-Marker, Live-/Save-/Offline-/Read-only-/Degraded-Status, Accessibility und Permission-Entzug integrieren.
7. **Checkpoint und Lifecycle:** Revision, File Watcher, Public Link, Backup/Restore, Rename/Move/Copy/Delete/Restore und Konflikt-Import verbinden.
8. **Hardening und Rollout:** Zwei-/Mehrclient-, Offline-, Restart-, Last-, Security-, Upgrade- und Excalidraw-Schema-Kompatibilitaet testen; Feature-Gate stufenweise aktivieren.

## Abnahmebedingungen

- Zwei berechtigte User koennen dieselbe `.excalidraw`-Datei gleichzeitig bearbeiten und sehen Elemente, Cursor, Selections und Presence ohne manuellen Reload.
- Verschiedene und gleiche Elementkonflikte, Loeschungen, Undo/Redo, Bindings, Gruppen, Frames und Z-Reihenfolge konvergieren deterministisch.
- Bilder werden separat uebertragen und erscheinen nach Reconnect/Restart bei allen berechtigten Clients.
- Kein aktiver Collaboration-Client schreibt parallel per Drei-Sekunden-Whole-File-Autosave.
- Server-Neustart, Offline-Reconnect und verlorene Updates werden ueber Sequence/ACK/Resync ohne stillen Datenverlust repariert.
- Datei-Checkpoint, Revision, Public Preview, Export und Restore entsprechen dem bestaetigten Szenenstand.
- Permission-Entzug, Workspace-Isolation, Payload-Limits, untrusted Elemente/Assets und WebSocket-Origin werden serverseitig erzwungen.
- File Tree Presence ist vor dem Oeffnen sichtbar, ohne den Betrachter als Room-Teilnehmer zu zaehlen.
- Upstream-Upgrades besitzen Reconciliation-/Schema-Kompatibilitaetstests und aktualisierte Third-Party Notices.

UI-/E2E-Multi-User-Tests mit Playwright oder Chrome DevTools erfolgen gemaess Repository-Regel erst nach expliziter Freigabe.

## Nicht-Ziele fuer die erste Version

- Excalidraw in Aufgabe `48` oder als JSON-String in `Y.Text` zu behandeln.
- Excalidraw+ als verpflichtende externe Datenquelle vorauszusetzen.
- einen ungeprueften `excalidraw-room`-Server oeffentlich neben Canvas zu stellen.
- Excalidraw+-Kommentare, Voice Hangouts, Presentations oder das gesamte Plus-Workspace-Modell nachzubauen.
- ungepruefte direkte Agent-Co-Authoring-Operationen bei aktiven Menschen.
- E2EE zu behaupten, solange Canvas den Szeneninhalt serverseitig verarbeitet und kein explizites Key-/Recovery-Modell umgesetzt ist.

## Offizielle Referenzen

- [Excalidraw Repository: npm-Editor vs. Excalidraw.com-Features](https://github.com/excalidraw/excalidraw)
- [Excalidraw Maintainer-Antwort zur selbst zu implementierenden Collaboration](https://github.com/excalidraw/excalidraw/discussions/3879)
- [Excalidraw `Collab.tsx`](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Collab.tsx)
- [Excalidraw `Portal.tsx`](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Portal.tsx)
- [Excalidraw `reconcileElements`](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/data/reconcile.ts)
- [Excalidraw Firebase-Szenenpersistenz](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/data/firebase.ts)
- [Excalidraw npm API Props](https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/api/props/)
- [`excalidraw-room` Beispielserver](https://github.com/excalidraw/excalidraw-room)
- [Offizielle Self-Hosting-Dokumentation](https://docs.excalidraw.com/docs/introduction/development)
- [Excalidraw+ API Public Beta](https://plus.excalidraw.com/docs/api)
- [Excalidraw+ Scene PATCH und Reconciliation-Grenzen](https://plus.excalidraw.com/docs/api/scenes/sceneId-content-patch)
- [Excalidraw+ Self-Hosting Status](https://plus.excalidraw.com/docs/self-hosting/excalidraw-plus-self-hosting)
- [Excalidraw MIT License](https://github.com/excalidraw/excalidraw/blob/master/LICENSE)
- [`excalidraw-room` MIT License](https://github.com/excalidraw/excalidraw-room/blob/master/LICENSE)
