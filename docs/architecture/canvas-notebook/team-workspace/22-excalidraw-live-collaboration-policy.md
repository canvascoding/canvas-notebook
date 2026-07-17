# Excalidraw Live Collaboration Policy

Stand: 2026-07-17

## Zweck und Abgrenzung

Dieses Dokument beschreibt die implementierte echte Multi-User-Bearbeitung fuer `.excalidraw`-Dateien in Canvas Team Workspaces. Excalidraw wird als eigene Collaboration-Repraesentation behandelt und ausdruecklich nicht in Aufgabe `48` fuer Markdown-/Text-Yjs-Collaboration aufgenommen.

Gemeinsam genutzt werden duerfen die Canvas-Querschnittsmechaniken aus Aufgabe `48`:

- kurzlebige Collaboration-Tickets,
- Session-, Organization-, Workspace- und Datei-Permissions,
- WebSocket-Upgrade-Routing auf dem bestehenden App-Port,
- Workspace-weite Presence fuer File Tree, List und Grid,
- Postgres-Health, Persistenz, Audit und Datei-Checkpoints,
- stabile Dokumentidentitaet und Datei-Lifecycle-Regeln.

Nicht gemeinsam genutzt wird die Dokumentrepraesentation. Eine Excalidraw-Szene ist weder ein `Y.Text` noch ein Tiptap-`Y.XmlFragment`. Ihre Elemente besitzen bereits eigene IDs, Versionen, `versionNonce`, Loeschmarker, Bindings und Fractional Indices. Sie brauchen einen Excalidraw-spezifischen Scene-Provider und eine gegen die offizielle Reconciliation-Semantik getestete Merge-Logik.

## Implementierungsstatus in Canvas

Canvas Notebook verwendet aktuell `@excalidraw/excalidraw` `0.18.1` als eingebettete npm-Komponente.

Der Editor im Einzelbenutzermodus:

- liest und schreibt portable `.excalidraw`-JSON-Dateien,
- serialisiert bei `onChange` die vollstaendige Szene inklusive `appState` und `files`,
- reicht das Ergebnis an den allgemeinen Editor-Draft weiter,
- speichert die komplette Datei nach drei Sekunden per Whole-File-Autosave,
- setzt `isCollaborating={false}` ausserhalb berechtigter Team-Collaboration,
- laedt externe Dateiaenderungen nur neu, wenn der lokale Draft nicht dirty ist.

Aufgabe `52` ist technisch implementiert. Berechtigte Postgres-Team-Workspaces
verwenden fuer `.excalidraw` jetzt `provider: excalidraw` und
`representation: excalidraw_scene`; Markdown und reine Textdateien bleiben
unveraendert beim Yjs-/Hocuspocus-Pfad aus Aufgabe `48`.

Der produktive Pfad umfasst:

- den getrennten WebSocket-Endpunkt `/ws/collaboration/excalidraw` auf dem
  bestehenden App-Port mit kurzlebigem, session-, workspace-, permission-,
  provider- und generation-gebundenem Ticket,
- einen Postgres-Szenenstand mit monotoner Sequence, idempotenten Operations,
  deterministischem `version`-/`versionNonce`-Merge, Tombstones, Fractional
  Indices, ACK und Full-Resync,
- die offizielle Client-Reconciliation aus `@excalidraw/excalidraw@0.18.1`
  und `CaptureUpdateAction.NEVER` fuer Remote-Aenderungen,
- 40-ms-Patch-Coalescing, 33-ms-Pointer-/Selection-Throttling und einen
  periodischen 20-Sekunden-Vollabgleich,
- workspace-scoped Assets mit Authentifizierung, MIME-/Signaturpruefung,
  20-MiB-Limit, inhaltsadressierter physischer Deduplizierung und portablem
  Datei-Checkpoint,
- Presence fuer Excalidraw-Cursor/Selections und den gemeinsamen Canvas-
  Presence-Bus sowie UI-Zustaende fuer Connecting, Live, Persisting, Saved,
  Reconnecting, Offline, Read-only und Degraded,
- serverseitige Checkpoints und File Revisions sowie Lifecycle-Verhalten fuer
  Move, Copy, Delete, Restore und kontrollierten Shutdown,
- einen eigenen Agent-Toolpfad `edit_excalidraw_scene` mit
  `observedSceneSequence`, Element-CAS, Same-Element-Review, erneutem Review
  nach menschlicher Intervention und idempotentem Accept/Reject/Cancel,
- einen Whole-File-Write-Guard; der Drei-Sekunden-Autosave und externe
  Voll-Reload werden im aktiven Excalidraw-Room nicht parallel ausgefuehrt.

Der autoritative Initial-Snapshot bleibt im Editor pro Workspace/Datei stabil;
eingehende Patches unmounten den Canvas nicht. Gueltige Excalidraw-Elemente mit
`boundElements: null` werden akzeptiert. Das Agent-Review-Panel liegt auch im
responsiven 900×650-Layout ueber dem Chat-Overlay und bleibt bedienbar.

Canvas verarbeitet die Szene serverseitig und behauptet deshalb fuer diesen
Pfad keine Excalidraw-E2EE. Es wurde kein `excalidraw-room`-,
`excalidraw-app/collab`- oder anderer Upstream-Code kopiert und keine neue
Runtime-Abhaengigkeit aufgenommen; die bestehende inventarisierte npm-Version
`@excalidraw/excalidraw@0.18.1` wird ueber ihre oeffentliche API verwendet. Der
kommerzielle Gesamt-Release bleibt unabhaengig davon am strikten Lizenz-Gate
aus Aufgabe `51` bis zur dokumentierten verantwortlichen/rechtlichen Freigabe
blockiert.

## Offizieller Excalidraw-Befund

### npm-Editor ist nicht die Collaboration-App

Der offizielle Excalidraw-README trennt den eingebetteten npm-Editor von `excalidraw.com`. Real-Time Collaboration, E2EE und Local-first-Speicherung sind Funktionen der zusaetzlichen Web-App-Schicht. Die npm-Prop `isCollaborating` zeigt nur an, dass der Host die Komponente im Collaboration-Modus betreibt; sie startet weder Netzwerk, Room noch Persistenz. Die Maintainer bestaetigen ausserdem, dass das npm-Paket nicht mit dem Collaboration-Wrapper veroeffentlicht wird und `isCollaborating` nur die Collaboration-UI beziehungsweise Avatare aktiviert.

Die offiziellen Maintainer beschreiben fuer Consumer zwei Wege:

1. die komplette `excalidraw-app` zusammen mit `excalidraw-room` forken und selbst bauen,
2. die benoetigte Collaboration-Logik in die eigene Integration uebernehmen, um keinen dauerhaften eigenen Excalidraw-Package-Fork warten zu muessen.

### Exakt verifizierte npm-API in Version 0.18.1

Die aktuell installierte und im Lockfile aufgeloeste Version ist
`@excalidraw/excalidraw@0.18.1`, Upstream-Tag/Commit
`a2ec2889babf7d2295469c6d90ebe77fae57df84`. Sie exportiert bereits die fuer
einen eigenen Host-Provider notwendigen Bausteine:

- `onChange(elements, appState, files)` fuer lokale Szenenaenderungen,
- `onPointerUpdate(...)` fuer Cursor-/Laser-Presence,
- `excalidrawAPI.updateScene()` und `collaborators` fuer Remote-Szene und
  Nutzeranzeige,
- `getSceneElementsIncludingDeleted()` fuer Tombstones,
- `getAppState()` und `getFiles()` fuer den aktuellen lokalen Stand,
- `addFiles()` fuer nachgeladene Binary Files,
- `reconcileElements()` als oeffentlich exportierte Konfliktfunktion,
- `CaptureUpdateAction.NEVER` fuer Remote-Updates und Initialisierung.

Damit gibt es nach heutigem Stand keinen nachgewiesenen npm-API-Blocker, der
einen dauerhaften Excalidraw-Fork als V1-Default rechtfertigt. Der
Zwei-Client-Spike bleibt trotzdem ein verpflichtender Kompatibilitaetstest,
weil Bindings, Frames, Gruppen, Fractional Indices und laufende Text-/Resize-
Interaktionen gemeinsam getestet werden muessen.

### Offizielle OSS-Architektur in Version 0.18.1

Die versionierte Open-Source-App verwendet:

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

Die konkreten Referenzwerte von `0.18.1` sind ein Cursor-Throttle von 33 ms
ungefaehr 30 Bildern pro Sekunde, ein periodischer Full-Scene-Sync nach 20
Sekunden und eine Tombstone-Aufbewahrung von mindestens einem Tag. Diese Werte
sind Ausgangswerte fuer den Spike und keine ungeprueft garantierten Canvas-
Produktionslimits.

`excalidraw-room` ist ein kleiner Collaboration-Relay. Der am 16. Juli 2026
aktuelle Commit `03ff435860b508d7cd9e005cfc90f7977ae2a593` nimmt frei gewaehlte
Room-IDs an und leitet verschluesselte Payloads per Socket.IO an andere
Room-Mitglieder weiter. Sein CORS-Origin ist ohne Konfiguration `*`. Er besitzt
keine Canvas-Authentifizierung, keine Workspace-Permission-Pruefung, keine
dauerhafte Szenenspeicherung und keine serverseitige Reconciliation. Das macht
ihn zu einer nuetzlichen Protokollreferenz, aber nicht zu einem ungeaendert
produktionsfaehigen Canvas-Team-Backend.

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

## Architekturentscheidung und Validierungstor

Die V1-Architekturentscheidung lautet:

> Canvas implementiert einen eigenen, authentifizierten Excalidraw Scene
> Provider um das bestehende npm-Paket. Hocuspocus/Yjs bleibt fuer Text;
> `excalidraw-room`, Excalidraw+ und ein eigener Excalidraw-Package-Fork werden
> nicht zur produktiven Szenenwahrheit.

Die Entscheidung stuetzt sich darauf, dass Version `0.18.1` die benoetigten
oeffentlichen Editor-, Reconciliation-, Undo-, Presence- und Asset-Hooks
exportiert. Sie passt ausserdem zur bestehenden Canvas-Wahrheit aus
Workspace-Datei, stabiler Dokument-ID, Postgres, Berechtigungen, Public Links,
Backups und Agent-Operationen.

Bevor die vollstaendige Produktimplementierung beginnt, baut Aufgabe `52` einen
kleinen Zwei-Client-Spike. Der Spike implementiert nur den Canvas-nativen
Providerpfad. Ein isolierter Fork-Prototyp wird nur dann nachgezogen, wenn eine
konkrete oeffentliche npm-API-Grenze den Spike blockiert.

Der Spike muss nachweisen:

1. Zwei Canvas-User bearbeiten dieselbe vorhandene Workspace-Datei und konvergieren.
2. Gleichzeitige Aenderungen verschiedener Elemente gehen nicht verloren.
3. Gleichzeitige Aenderungen desselben Elements folgen deterministisch `version`/`versionNonce` und der lokalen In-Progress-Schutzregel.
4. Loeschen, Undo/Redo, Bindings, Gruppen, Frames und Elementreihenfolge bleiben gueltig.
5. Bilder werden nicht bei jedem Pointer-Move als komplette Data-URL uebertragen.
6. Reconnect und Server-Neustart laden denselben persistierten Szenenstand.
7. Der vorhandene npm-Package-Pfad bleibt upgradefaehig; ein Fork ist nicht erforderlich.
8. Die initialen Latenz-, Payload- und Speicherbudgets werden mit einer
   realistischen grossen Szene gemessen.

Wenn diese Kriterien erfuellt sind, wird der Canvas-native Provider umgesetzt.
Ein Fork darf nur gewaehlt werden, wenn der Spike einen reproduzierbaren
Blocker der oeffentlichen npm-API nachweist und Upgrade-, Security-, Storage-
und Lizenzkosten explizit akzeptiert werden. Kopierter Upstream-Code wird
gemaess Aufgabe `51` als eigene Komponente inventarisiert; bevorzugt wird eine
eigenstaendige Canvas-Implementierung gegen die oeffentlichen APIs.

## Zielarchitektur

```txt
Canvas ExcalidrawEditor (@excalidraw/excalidraw)
        | onChange / onPointerUpdate / updateScene / addFiles
        v
Canvas Excalidraw Scene Provider
        | authenticated excalidraw-v1 messages
        v
/ws/collaboration/excalidraw auf dem bestehenden App-Port
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

Task `48` liefert den gemeinsamen App-Port, Ticket-Grundlagen und Presence-Bus.
Hocuspocus bleibt nur fuer Yjs-Dokumente auf `/ws/collaboration` zustaendig.
Der gemeinsame Server-Start registriert fuer Excalidraw den getrennten
Upgrade-Pfad `/ws/collaboration/excalidraw`; `isCanvasWebSocketRequest` kennt
beide Pfade sowie `/ws/chat`. Der Excalidraw-Handler prueft ein Ticket mit
`provider: excalidraw` und wird nicht als Hocuspocus-`Y.Doc` modelliert.

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

V1 verwendet getrennte Postgres-Strukturen statt die Szene in die bestehende
Yjs-State-Tabelle zu pressen:

```txt
collaboration_documents
  provider = excalidraw
  representation = excalidraw_scene

collaboration_excalidraw_states
  document_id PK
  lifecycle_generation
  excalidraw_version
  scene_schema_version
  elements_jsonb
  shared_app_state_jsonb
  scene_sequence
  checkpoint_sequence
  checkpoint_revision_id
  canonical_hash
  status / degraded_reason

collaboration_excalidraw_operations
  document_id + message_id UNIQUE
  base_sequence
  applied_sequence
  actor_type / actor_id
  accepted_delta_hash
  created_at

collaboration_excalidraw_assets
  workspace_id + file_id
  content_sha256
  mime_type / size_bytes / storage_key
  status / created_at / last_referenced_at
```

`collaboration_excalidraw_operations` ist das Idempotenzfenster fuer
wiederholte Client-Nachrichten und Agent-Operationen. Alte Operationen duerfen
nach einem dokumentierten Retention-Fenster verdichtet werden, solange
`scene_sequence`, Checkpoint und Audit nachvollziehbar bleiben.

## Client-Integration im bestehenden Editor

Der neue Provider sitzt zwischen `FileEditor` und `ExcalidrawEditor`.
`ExcalidrawEditor` bleibt der visuelle Editor; der Provider uebernimmt
Transport, Reconciliation, Presence, Assets und Save-Status.

### Verbindungsaufbau

1. `FileEditor` erkennt `.excalidraw` in einem berechtigten Team Workspace.
2. Der Client fordert eine Collaboration-Session mit
   `representation: excalidraw_scene` und `provider: excalidraw` an.
3. Der Server initialisiert den Szenenstand einmalig aus der vorhandenen
   Workspace-Datei oder laedt den bestehenden Postgres-Stand.
4. Der Client verbindet sich mit dem kurzlebigen Ticket auf
   `/ws/collaboration/excalidraw`.
5. `scene:init` wird restauriert, validiert und mit
   `CaptureUpdateAction.NEVER` angewendet.
6. Erst danach setzt der Host `isCollaborating={true}` und meldet `live`.

Ein Ticket-Renewal ersetzt die Authentifizierung derselben Verbindung oder
verbindet kontrolliert neu. Ein abgelaufenes Ticket darf nicht dazu fuehren,
dass lokale Aenderungen still verworfen oder als gespeichert angezeigt werden.

### Lokale Szenenaenderungen

Der Provider haelt fuer jedes Element den zuletzt serverbestaetigten Stand:

```ts
type AcknowledgedElementVersion = {
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  index: string | null;
  canonicalHash: string;
};
```

Bei `onChange`:

1. Lokales Rendering bleibt sofort und wartet nicht auf den Server.
2. Der Provider ignoriert reine lokale `appState`-Aenderungen.
3. Er sendet nur neue oder gegen den bestaetigten Stand veraenderte Elemente,
   einschliesslich `isDeleted`-Tombstones.
4. Aenderungen werden fuer Drag-/Resize-Frequenzen kurz koalesziert, nicht als
   vollstaendige Datei serialisiert.
5. Jede nichtvolatile Nachricht traegt `messageId` und die zuletzt bestaetigte
   `baseSequence`.
6. Ein periodischer Full-Element-Resync prueft und repariert moegliche
   Divergenz, ohne Binary Files in die WebSocket-Nachricht einzubetten.

Der Vergleich verwendet mindestens `version`, `versionNonce`, `isDeleted`,
Fractional Index und einen kanonischen Elementhash. Die offizielle App sendet
bei normalen Updates nur seit dem letzten Broadcast hoeher versionierte
Elemente und etwa alle 20 Sekunden einen Vollabgleich. Canvas uebernimmt das
Prinzip, ergaenzt aber ACK, Idempotenz und eine serverseitige Sequenz.

### Remote-Szenenaenderungen

Bei `scene:applied` oder `scene:init`:

1. Remote-Elemente werden mit der oeffentlich exportierten
   `reconcileElements(localElements, remoteElements, localAppState)`-Funktion
   der gepinnten npm-Version reconciled.
2. Die offizielle lokale Schutzregel behaelt ein Element, das gerade als Text
   bearbeitet, erstellt oder resized wird.
3. Hoehere Elementversion gewinnt. Bei gleicher Version gewinnt
   deterministisch die niedrigere `versionNonce`.
4. Das Ergebnis wird mit
   `updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER })`
   angewendet.
5. Fehlende Binary Files werden asynchron nachgeladen und mit `addFiles()`
   eingesetzt.
6. Nach Ende einer lokalen In-Progress-Interaktion wird erneut gegen die
   aktuelle Server-Sequence reconciled und ein noch neuerer lokaler Stand
   gegebenenfalls gesendet.

Remote-Updates landen dadurch nicht im lokalen Undo-/Redo-Stack. Lokale
Undo-/Redo-Aktionen erzeugen dagegen normale neue Elementversionen und werden
wie andere lokale Aenderungen uebertragen.

### Persistierbarer und lokaler App State

Canvas folgt fuer den gemeinsamen Szenenstate der Upstream-Server-Allowlist von
`0.18.1`:

- `viewBackgroundColor`,
- `gridSize`,
- `gridStep`,
- `gridModeEnabled`.

Viewport, Zoom, Scrollposition, aktives Werkzeug, aktuelle Style-Auswahl,
Selection, Dialoge, Sidebars, laufende Text-/Resize-Zustaende, Theme,
Collaborators und Follow-State bleiben clientlokal oder fluechtige Presence.
Diese Trennung verhindert, dass sich Nutzer gegenseitig Viewport, Auswahl oder
Werkzeugzustand ueberschreiben.

## Protokoll und Reconciliation

### Autoritative Nachrichten

V1 verwendet getrennte, versionierte Nachrichtentypen:

- `scene:init`: autoritativer Snapshot plus Sequence,
- `scene:patch`: geaenderte Elemente inklusive Tombstones und erwartete Base-Sequence,
- `scene:applied`: akzeptierte kanonische Elemente, neue Sequence und Hash,
- `scene:ack`: bestaetigt, bis zu welcher Sequence der Client angewendet hat,
- `scene:resync_required`: Client fordert neuen Snapshot an,
- `asset:announce`, `asset:uploaded`, `asset:available`,
- `presence:pointer`, `presence:selection`, `presence:idle`, `presence:leave`.

Cursor, Selection und Idle sind fluechtig, gedrosselt und duerfen bei Last verworfen werden. Szenenaenderungen sind nicht volatil und brauchen Message-ID, Idempotenz und Acknowledgement.

Eine clientseitige nichtvolatile Nachricht hat mindestens:

```ts
type ExcalidrawClientEnvelope = {
  schemaVersion: 1;
  type: "scene:patch" | "scene:ack" | "scene:resync_request";
  messageId: string;
  lifecycleGeneration: number;
  baseSequence: number;
  payload: unknown;
};
```

User, Organization, Workspace und Dokument werden nicht aus dem Payload
vertraut, sondern ausschliesslich aus dem verifizierten Connection-Ticket. Eine
optionale Dokument-ID im Payload muss exakt zum Ticket passen. Damit kann ein
Browser nicht durch eine frei gewaehlte Room-ID einem fremden Workspace-Room
beitreten.

### Merge-Regeln

Die serverseitige Scene-Apply-Section ist pro Dokument und auch ueber mehrere
Node-Prozesse hinweg durch eine Postgres-Transaktion mit Row-/Advisory-Lock
serialisiert. Sie:

1. prueft Ticket, Write-Permission, Dokumentgeneration, Schema, Payload- und Elementlimits,
2. restauriert/validiert Excalidraw-Elemente,
3. merged nach Element-ID,
4. bevorzugt die hoehere `version`,
5. bevorzugt bei gleicher Version deterministisch die niedrigere `versionNonce`,
6. behaelt Tombstones lange genug fuer Offline-/Reconnect-Konvergenz,
7. normalisiert und validiert Fractional Indices, Bindings, Gruppen und referenzierte Elemente,
8. persistiert Szene und monotone `sceneSequence` atomar,
9. speichert `messageId` und Ergebnis fuer idempotente Wiederholung,
10. broadcastet nur den akzeptierten Zustand beziehungsweise die akzeptierten Deltas.

Die serverseitige Merge-Funktion hat keine lokale Editor-In-Progress-Ausnahme,
weil der Server keinen Client-Viewport oder Editing-State besitzen darf. Sie
entscheidet nur ueber Elementversion, Nonce, Tombstone und Reihenfolge. Die
clientseitige `reconcileElements()`-Funktion ergaenzt den lokalen Schutz fuer
gerade bearbeitete Elemente.

Alle uebernommenen oder angepassten Upstream-Teile werden in Aufgabe `51` mit Commit, MIT-Lizenztext und Copyright-Hinweis inventarisiert.

### ACK, Reconnect, Offline und Resync

- Ein doppeltes `messageId` liefert das bereits persistierte Ergebnis und
  erhoeht `sceneSequence` nicht erneut.
- Eine `baseSequence` hinter dem aktuellen Stand ist zulaessig, solange die
  Elemente noch deterministisch reconciled werden koennen. Der Server sendet
  die akzeptierte kanonische Delta-Antwort.
- Unbekannte Lifecycle-Generation, zu grosse Luecke, ungueltige Tombstones oder
  nicht mehr aufloesbare Referenzen fuehren zu `scene:resync_required`.
- Beim Reconnect laedt der Client zuerst den aktuellen Snapshot, reconciled
  danach noch nicht bestaetigte lokale Elemente und sendet sie mit neuen
  Message-IDs erneut.
- Presence wird nach Disconnect verworfen und nicht aus einer Offline-Queue
  nachgesendet.
- Ein Server-Neustart laedt Szene und letzte Sequence aus Postgres. Der
  Workspace-Dateicheckpoint ist nicht die primaere Recovery-Quelle fuer einen
  aktiven Room, sondern der portable Fallback.
- Solange Persistenz oder ACK fehlt, zeigt der Client `persisting`,
  `offline/reconnecting` oder `degraded`, niemals `saved`.

Bei einem spaeteren horizontalen Multi-Instance-Betrieb braucht der
WebSocket-Broadcast zusaetzlich einen clusterweiten Bus, beispielsweise
Postgres `LISTEN/NOTIFY` mit Operation-Reload oder Redis. Bis dahin darf nur
eine Instanz pro Dokument als Collaboration-Writer aktiv sein.

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
representation: excalidraw_scene
schemaVersion
lifecycleGeneration
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
- Agenten bearbeiten Excalidraw nur ueber einen servervalidierten Scene-Patch
  oder Review-Vorschlag, nie als unkontrollierten JSON-String.
- Eine Agent-Operation nennt `observedSceneSequence`, Ziel-Element-IDs,
  erwartete `version`/`versionNonce`, beabsichtigte Create-/Update-/Delete-
  Aktionen und benoetigte Asset-Referenzen.
- Vor Apply validiert der Server Elementtypen, Bindings, Gruppen, Frames,
  Fractional Indices, Links, Embeddables, Assets, Workspace-Scope und
  Payload-Limits.
- Aendert ein Mensch waehrend der Agentenarbeit ein anderes Element, darf der
  Patch auf den neuen Szenenstand rebased werden.
- Aendert ein Mensch dasselbe Zielelement, wird die Operation
  `needs_review`; sie darf den neueren menschlichen Stand nicht blind
  ueberschreiben.
- Bei aktiven menschlichen Room-Teilnehmern ist der erste sichere Rollout ein
  sichtbarer Vorschlags-/Review-Flow. Eine spaetere Auto-Apply-Policy ist nur
  fuer konfliktfreie, voll validierte Operationen zulaessig.
- Ablehnen oder Abbrechen beendet die Agent-Operation idempotent. Bereits
  bestaetigte fremde Nutzerupdates werden dabei nie zurueckgerollt.
- Ein Agent erscheint im gemeinsamen Presence-Modell als `agent_editing` mit
  initiierendem User, darf aber keine User-Identitaet vortaeuschen.
- Solange Elementziele, Versionen, Bindings, Assets und Review-UI nicht sicher
  modelliert sind, bleiben direkte Agent-Writes bei aktiven Menschen blockiert.
- Public Links bleiben read-only und lesen den letzten bestaetigten Datei-Checkpoint.
- Full Backup und Restore enthalten Excalidraw-Szenenrepository, Assets, Collaboration-Metadaten und materialisierte Dateien.

## Performance- und Ladezeitbudgets

Die Multi-User-Funktion darf den lokalen Editor nicht auf eine Serverantwort
warten lassen. Lokale Pointer-, Drag-, Resize-, Text- und Undo-Aktionen werden
sofort gerendert; Netzwerk und Persistenz laufen optimistisch im Hintergrund.

Initiale V1-Ziele, die der Spike messen und bei Bedarf anpassen muss:

| Messpunkt | Ziel |
| --- | --- |
| lokales Feedback | innerhalb desselben Render-Frames |
| Cursor-/Laser-Versand | maximal etwa alle 33 ms, volatil |
| Koaleszierung von Elementupdates | 33 bis 50 ms waehrend kontinuierlicher Interaktion |
| Remote-Element sichtbar, gleicher Standort | p95 unter 250 ms |
| Session-/Snapshot-Start bis `live`, Szene bis 2 MiB | p95 unter 1,5 s bei warmer App |
| erneuter Full-Element-Abgleich | ungefaehr alle 20 s und bei Resync |
| nichtvolatile WebSocket-Einzelmessage | initial maximal 1 MiB |
| Binary File | nie im Scene-WebSocket; separater begrenzter Upload |

Die Limits sind Schutz- und Messwerte, keine stillen Abschneidegrenzen. Eine zu
grosse Szene oder ein zu grosses Asset erhaelt eine klare UI-Meldung und bleibt
download-/checkpointfaehig. Der Spike prueft mindestens eine Szene mit vielen
Elementen, Bildern, Gruppen, Frames und gebundenem Text und misst:

- JSON-/Restore-/Reconcile-Zeit,
- Zeit bis zum ersten sichtbaren Canvas,
- Speicherverbrauch pro Client und Server-Room,
- Delta- und Full-Sync-Groesse,
- Datenbank-Transaktionszeit,
- Reconnect nach Netzverlust und Server-Neustart.

Binary Files werden lazy geladen. Der Snapshot kann deshalb bereits sichtbar
und bearbeitbar sein, waehrend Bilder mit Platzhalterstatus nachgeladen werden.
Ein Asset-Fehler darf die restliche Szene nicht blockieren.

## Umsetzungsphasen fuer Aufgabe 52

Startbedingung ist der Abschluss der vorgelagerten Aufgabe `51`. Danach laufen
die Phasen nach Abschluss der jeweils vorherigen Phase:

1. **Architecture Spike:** Den bereits ausgewaehlten Canvas-nativen Provider als Zwei-Client-Prototyp gegen `0.18.1` pruefen; npm-API-Grenzen, offizielle Reconciliation, Undo/Redo, Assets, Reconnect und Performance messen. Fork nur bei reproduzierbarem API-Blocker benchmarken.
2. **Datenmodell und Repository:** Provider/Kind, Szene, Sequence, Tombstones, Generation, Asset-Referenzen und Checkpoint-Metadaten in Postgres implementieren.
3. **Transport und Auth:** `/ws/collaboration/excalidraw`, `excalidraw-v1`, Tickets, Permissions, Limits, Heartbeat, ACK/Resync und Postgres-serialisierte Apply-Section bauen.
4. **Editor Provider:** Whole-File-Autosave deaktivieren, lokale Deltas/Elemente senden, Remote-Szene reconciliieren, Collaborators/Cursor rendern und Provider-Lifecycle hardenen.
5. **Assets:** separate workspace-scoped Upload-/Download-/Retention-Pipeline und portablen Checkpoint-Roundtrip umsetzen.
6. **Presence und UX:** File-Tree-/List-/Grid-Marker, Live-/Save-/Offline-/Read-only-/Degraded-Status, Accessibility und Permission-Entzug integrieren.
7. **Checkpoint und Lifecycle:** Revision, File Watcher, Public Link, Backup/Restore, Rename/Move/Copy/Delete/Restore und Konflikt-Import verbinden.
8. **Agent Review Flow:** Elementbasierte Agent-Patches, Rebase, Same-Element-Konflikt, Accept/Reject/Cancel, Recovery und Audit integrieren.
9. **Hardening und Rollout:** Zwei-/Mehrclient-, Offline-, Restart-, Last-, Security-, Upgrade- und Excalidraw-Schema-Kompatibilitaet testen; Feature-Gate stufenweise aktivieren.

## Verbindliche Testmatrix

| Bereich | Mussfall |
| --- | --- |
| Basis | zwei und drei Clients oeffnen dieselbe bestehende Workspace-Datei und konvergieren |
| verschiedene Elemente | paralleles Erstellen, Verschieben, Stylen und Loeschen ohne Verlust |
| gleiches Element | gleiche `version`, verschiedene `versionNonce`; alle Clients waehlen denselben Gewinner |
| laufende User-Interaktion | Remote-Update waehrend Textedit, Resize, Rotation, Drag und neuer Elementerstellung |
| Undo/Redo | lokale Aktion undo/redo erzeugt neue Sync-Aenderung; Remote-Apply bleibt nicht undoable |
| Struktur | Bindings, gebundener Text, Gruppen, Frames, Pfeile und Fractional Indices bleiben gueltig |
| Tombstones | Delete, Offline-Client, Reconnect und spaeter Full-Resync erwecken kein geloeschtes Element |
| Transport | Duplicate, Out-of-order, verlorene ACKs, grosse Sequenzluecke und Resync |
| Neustart | App-/WebSocket-Neustart zwischen Patch, Persistenz und Checkpoint |
| Assets | Upload, Deduplizierung, falscher MIME-Typ, fehlendes Asset, Reconnect und portabler Export |
| Permission | Read-only, Membership-Entzug, abgelaufenes Ticket, fremder Workspace und untrusted Origin |
| Lifecycle | Rename, Move, Copy, Delete, Restore und alte Lifecycle-Generation |
| externe Writes | Whole-File-API, Shell, Automation, Integration und File Watcher umgehen den Room nicht |
| Agent konfliktfrei | Agent aendert anderes Element als aktive User; deterministischer Rebase |
| Agent Konflikt | User aendert dasselbe Element; Operation wird Review statt Overwrite |
| Agent Intervention | Accept, Reject, Cancel, Disconnect und Recovery sind idempotent |
| Performance | definierte grosse Szene, p95-Latenz, Initial Load, Speicher, Delta-/Full-Sync und DB-Zeit |
| Upgrade | dieselbe Matrix gegen jede neue `@excalidraw/excalidraw`-Version vor Freigabe |

Zur Abnahme wurden Service-/Integrationstests sowie ein echter UI-/E2E-
Multi-User-Test mit getrennten Browser-Kontexten ausgefuehrt. Der E2E-Test
prueft nicht nur Presence, sondern den nach Reload persistierten kanonischen
Szenenstand; Reconnect, Resync und persistenter Neustart werden zusaetzlich in
den nativen Repository-/Transporttests abgedeckt.

### Ausgefuehrte Verifikation am 17. Juli 2026

Die Implementierung wurde ohne lokalen Docker-Neubau gegen einen einzelnen
nativen, temporaeren Postgres-Testprozess und einen einzelnen Dev-Server auf
`localhost:3000` geprueft. Beide Prozesse wurden anschliessend beendet und die
Testdaten entfernt.

| Pruefung | Ergebnis |
| --- | --- |
| `npm run test:collaboration:excalidraw:spike` | gruen; `0.18.1`, kein Fork erforderlich, 20.000 Elemente in 47,8 ms gemerged |
| `npm run test:collaboration:excalidraw:live` | gruen; zwei Clients, Sequence 34, Postgres-Apply p95 1,1 ms |
| `npm run test:collaboration:excalidraw:assets` | gruen; Hash-Deduplizierung und zwei Assets im portablen Checkpoint |
| `npm run test:collaboration:excalidraw:security` | gruen; Ticket-, Element-, Referenz- und Limit-Negativfaelle einschliesslich gueltigem `boundElements: null` |
| `npm run test:collaboration:excalidraw:agent` | gruen; konfliktfreies Apply, Review und erneute User-Intervention jeweils angewendet |
| `tests/excalidraw-live-collaboration.spec.ts` | gruen in 27,4 s gegen einen frisch initialisierten Teststand; zwei isolierte Benutzer, Presence, Zeichnen, Remote-Move, Reload, Whole-File-Block, Agent-Review, Intervention, Accept, Reject und 900×650-UI |
| `npx tsc --noEmit` | gruen |
| `npm run build` | gruen; das nicht-strikte Lizenzinventar lief mit, der kommerzielle Release bleibt am separaten strikten Gate blockiert |

Die gemessene Server-Apply-Latenz liegt deutlich unter dem 50-ms-Ziel. Der
20.000-Elemente-Kompatibilitaetstest bleibt unter 50 ms. Der komplette
Browser-E2E-Lauf benoetigte 27,4 Sekunden inklusive Login, Workspace-/Datei-
Setup, zweier Browserkontexte, Agent-Subprozesse, Reload und Cleanup; er ist
kein Mass fuer die Realtime-Patchlatenz.

## Abnahmebedingungen

- Zwei berechtigte User koennen dieselbe `.excalidraw`-Datei gleichzeitig bearbeiten und sehen Elemente, Cursor, Selections und Presence ohne manuellen Reload.
- Verschiedene und gleiche Elementkonflikte, Loeschungen, Undo/Redo, Bindings, Gruppen, Frames und Z-Reihenfolge konvergieren deterministisch.
- Bilder werden separat uebertragen und erscheinen nach Reconnect/Restart bei allen berechtigten Clients.
- Kein aktiver Collaboration-Client schreibt parallel per Drei-Sekunden-Whole-File-Autosave.
- Server-Neustart, Offline-Reconnect und verlorene Updates werden ueber Sequence/ACK/Resync ohne stillen Datenverlust repariert.
- Datei-Checkpoint, Revision, Public Preview, Export und Restore entsprechen dem bestaetigten Szenenstand.
- Permission-Entzug, Workspace-Isolation, Payload-Limits, untrusted Elemente/Assets und WebSocket-Origin werden serverseitig erzwungen.
- File Tree Presence ist vor dem Oeffnen sichtbar, ohne den Betrachter als Room-Teilnehmer zu zaehlen.
- Agent-Operationen koennen konfliktfrei elementweise arbeiten; gleichzeitige
  menschliche Aenderungen am selben Element erzwingen Review statt Overwrite.
- Die gemessenen Initial-Load- und Realtime-Latenzen liegen innerhalb der
  dokumentierten Budgets oder besitzen vor Rollout eine begruendete,
  dokumentierte Anpassung.
- Upstream-Upgrades besitzen Reconciliation-/Schema-Kompatibilitaetstests und aktualisierte Third-Party Notices.

Der UI-/E2E-Multi-User-Test wurde nach expliziter Freigabe mit Playwright ausgefuehrt.

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
- [Excalidraw Release `0.18.1`](https://github.com/excalidraw/excalidraw/releases/tag/v0.18.1)
- [Excalidraw `Collab.tsx` in `0.18.1`](https://github.com/excalidraw/excalidraw/blob/v0.18.1/excalidraw-app/collab/Collab.tsx)
- [Excalidraw `Portal.tsx` in `0.18.1`](https://github.com/excalidraw/excalidraw/blob/v0.18.1/excalidraw-app/collab/Portal.tsx)
- [Excalidraw `reconcileElements` in `0.18.1`](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/data/reconcile.ts)
- [Excalidraw App-State-Storage-Allowlist in `0.18.1`](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/appState.ts)
- [Excalidraw Firebase-Szenenpersistenz in `0.18.1`](https://github.com/excalidraw/excalidraw/blob/v0.18.1/excalidraw-app/data/firebase.ts)
- [Excalidraw npm API Props](https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/api/props/)
- [Excalidraw npm Imperative API](https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/api/props/excalidraw-api)
- [`excalidraw-room` Relay-Quellcode am geprueften Commit](https://github.com/excalidraw/excalidraw-room/blob/03ff435860b508d7cd9e005cfc90f7977ae2a593/src/index.ts)
- [Offizielle Self-Hosting-Dokumentation](https://docs.excalidraw.com/docs/introduction/development)
- [Excalidraw+ API Public Beta](https://plus.excalidraw.com/docs/api)
- [Excalidraw+ Scene PATCH und Reconciliation-Grenzen](https://plus.excalidraw.com/docs/api/scenes/sceneId-content-patch)
- [Excalidraw+ Self-Hosting Status](https://plus.excalidraw.com/docs/self-hosting/excalidraw-plus-self-hosting)
- [Excalidraw MIT License in `0.18.1`](https://github.com/excalidraw/excalidraw/blob/v0.18.1/LICENSE)
- [`excalidraw-room` MIT License am geprueften Commit](https://github.com/excalidraw/excalidraw-room/blob/03ff435860b508d7cd9e005cfc90f7977ae2a593/LICENSE)
