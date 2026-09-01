# Collaboration und File Conflict Policy

Stand: 2026-09-01

## Zweck

Dieses Dokument ist der verbindliche Detailplan fuer echte Zusammenarbeit an Team-Dokumenten in Canvas Notebook. Es trennt:

- bereits vorhandene Revision-, Lock- und Konfliktschutz-Grundlagen,
- noch zu implementierende Yjs-basierte Real-Time Collaboration fuer Markdown und Text,
- separat implementierte Excalidraw-Scene-Collaboration ausserhalb des Yjs-Textmodells,
- Workspace-weite Presence im File Tree vor dem Oeffnen einer Datei,
- sichere Agent-, Automation- und externe Dateiaenderungen,
- Lock-/Check-out-Verhalten fuer nicht merge-faehige Dateiarten.

Es konkretisiert die Aufgaben `34`, `43` und `44` und ist die Grundlage fuer Aufgabe `48` im Aufgabenindex.

Excalidraw-Live-Collaboration ist als eigene Aufgabe `52` gemaess `22-excalidraw-live-collaboration-policy.md` implementiert und erweitert den Scope von Aufgabe `48` nicht.

## Verbindliche Statusabgrenzung

Aufgabe `48` hat die echte Yjs-basierte Real-Time Collaboration implementiert. Die produktive Abnahme bleibt jedoch erst dann vollstaendig, wenn die in diesem Dokument definierten Durability-, Agent-UX-, Snapshot- und Multi-Actor-Hardening-Kriterien nachweislich erfuellt sind.

Implementiert:

- workspace-aware File Reads und Writes,
- Datei-Revisionen und `baseRevisionId`-Pruefungen,
- SHA-basierte Konflikterkennung,
- Lock-Metadaten und Lock-API fuer lockpflichtige Dateien,
- `collaboration_documents`-Metadaten mit `provider=yjs`,
- File-Watcher-/SSE-Hinweise auf externe Dateiaenderungen,
- Collaboration-/Revision-Hinweise im Editor Header,
- Agent-Pruefungen gegen Revisionen und aktive Locks,
- ein echter `Y.Doc` als gemeinsamer Dokumentzustand,
- Tiptap-/CodeMirror-Bindings an Yjs,
- ein Collaboration-WebSocket-Backend,
- persistierter binaerer Yjs-State in Postgres,
- Awareness, Live-Cursor und Selections,
- aktive Nutzer im File Tree vor dem Oeffnen einer Datei,
- CRDT-basierte Agent-Aenderungen und Review-Patches,
- versionierte Checkpoint-Synchronisation zwischen Yjs-State und Workspace-Datei.

Im Hardening vom 2026-09-01 umgesetzt:

- getrennte monotone Client-Zustaende fuer Verbindung, lokale Uebergabe, Serverempfang, Postgres-Yjs-Persistenz und Datei-Checkpoint; die alte einzelne `saved`-Aussage ist im Collaboration-Modus nicht mehr die Quelle der Wahrheit,
- Editor-Freigabe erst nach lokaler IndexedDB-Hydration und initialem Provider-Sync,
- ein kompakter, nicht layoutverschiebender Agent-Aktivitaets-/Review-Popover im Editor-Header sowie direkt im Tiptap-/CodeMirror-Dokument verankerte Zielmarkierungen,
- Owner-/Manager-gepruefte Accept-, Reject- und Revert-Aktionen; reine Reader sehen Aktivitaet und Historie, koennen aber keine Operation entscheiden,
- strukturelle Rich-Markdown-Reviews ueber den gemeinsamen Y-ProseMirror-Diff statt Loeschen und Neuklonen des gesamten `Y.XmlFragment`,
- struktur- und positionsbewusster Erhalt bestehender Tiptap-Node-IDs; neue Bloecke erhalten neue IDs und bestehende Yjs Relative Positions in unberuehrten Bloecken bleiben aufloesbar,
- serverseitig aus dem persistierten binaeren Yjs-State abgeleitete autoritative Markdown-/Text-Snapshots; Client-Markdown ist keine zweite Checkpoint-Wahrheit,
- monotone `documentSequence`/`checkpointSequence` plus State Vector in Session, WebSocket-Durability-Snapshot und Checkpoint-Antwort,
- Checkpoint-Fencing gegen User, Session, Workspace, Dokument-ID, Lifecycle-Generation, Representation, Pfad und erwarteten State Vector,
- explizite `checkpoint_superseded`-/HTTP-409-Reconciliation statt eines irrefuehrenden 500-Fehlers bei einem legitimen Concurrent-Checkpoint.

Noch produktiv erneut abzunehmen:

- echter Postgres-/WebSocket-Multi-User-E2E-Lauf mit User A, User B und Agent im Auftrag von User B,
- Browser-Abnahme fuer Reconnect, Tab-Sleep, Offline-Queue und simulierten Persistence-/Checkpoint-Fehler,
- Betriebsabnahme fuer Shutdown-Flush, Backup/Restore und Compaction mit realem Postgres-Profil.

Todo `44` bleibt die abgeschlossene Foundation aus Revisionen, Locks, Metadaten und Guards. Todo `48` bezeichnet die implementierte Live-Collaboration-Basis; diese Statusangabe ersetzt nicht die noch offenen Hardening- und Abnahmekriterien dieses Dokuments.

Bewusst nicht Teil von Aufgabe `48` ist die inzwischen in Aufgabe `52`
implementierte Excalidraw-spezifische Scene-Collaboration. Sie verwendet einen
eigenen Canvas-Provider, `/ws/collaboration/excalidraw`, Postgres-Szenenstate,
separate Assets und portable Datei-Checkpoints; aktive Rooms verwenden keinen
parallelen Whole-File-JSON-Autosave.

## Produktentscheidung

Team Workspace bedeutet nicht, dass jede Dateiart live kollaborativ bearbeitet werden kann.

V1-Ziel:

- Markdown und reine Textdateien (`.md`, `.markdown`, `.txt`) erhalten echte Yjs-basierte Real-Time Collaboration, soweit die Datei innerhalb der definierten Format- und Groessenlimits liegt.
- Nutzer sehen bereits im File Tree oder File Explorer, welche Teammitglieder eine Datei gerade ansehen oder aktiv bearbeiten, ohne selbst den Dokument-Room zu oeffnen.
- QMD-, MDX-, JSON-, YAML- und Code-Dateien bleiben in V1 revision- und konfliktgeschuetzt, aber nicht live kollaborativ.
- `.excalidraw` besitzt ueber den separaten Scene-Provider aus Aufgabe `52` echte Live-Collaboration; die Datei wird nicht als JSON-String in `Y.Text` gespeichert.
- Office-Dateien, PDFs, Bilder, Videos, Audio und andere binaere Assets verwenden Lock-/Check-out-, Revision- und Konfliktlogik.
- Agenten, Automations und externe File Writes duerfen keine aktive menschliche Bearbeitung ueberschreiben.
- Alle Speicher-, Presence- und Transportpfade bleiben workspace-aware, permission-geprueft und auditierbar.
- Produktive Team-Collaboration ist an Team-Capability, Postgres, Collaboration-Health und ein explizites Feature-Gate gebunden.

## Dateiarten und Repraesentationen

| Dateiart | V1-Strategie | Gemeinsamer Yjs-Typ | Editor |
|---|---|---|---|
| `.md`, `.markdown`, rich-faehig | strukturierte Live-Collaboration | `Y.XmlFragment` | Tiptap Collaboration |
| `.md`, `.markdown`, source-only | Raw-Text-Live-Collaboration | `Y.Text` | CodeMirror-Yjs-Binding |
| `.txt` | Raw-Text-Live-Collaboration | `Y.Text` | CodeMirror-Yjs-Binding |
| `.excalidraw` | separate elementbasierte Scene-Collaboration, implementiert in Aufgabe `52` | keiner; eigener Excalidraw Provider | vorhandener Excalidraw npm-Editor |
| `.mdx`, `.qmd` | Revision Check und Konfliktanzeige | keiner | vorhandener Source Editor |
| JSON/YAML/Code | Revision Check und Konfliktanzeige | keiner | vorhandener Code Editor |
| Word/Excel/PowerPoint | exklusiver Lock/Check-out plus Revision | keiner | vorhandene Office-Flows |
| PDF | Lock/Revision, keine Live-Collaboration | keiner | Viewer/Download/Upload |
| Bilder/Videos/Audio | Lock/Revision, keine Live-Collaboration | keiner | Viewer/Asset-Flows |
| Studio Outputs | Copy-to-Workspace erzeugt neue Datei/Revision | keiner | Studio Asset Store bleibt Quelle |

### Verbindliche Representation-Regel

Ein Collaboration-Dokument hat genau eine gespeicherte Representation:

- `tiptap_markdown` fuer ein strukturiertes `Y.XmlFragment`,
- `raw_text` fuer ein `Y.Text`.

Rich- und Raw-Editor duerfen nicht gleichzeitig zwei schreibbare Wahrheiten desselben Dokuments fuehren. Die Representation wird beim erstmaligen Aktivieren der Collaboration festgelegt und in `collaboration_documents.documentKind` gespeichert.

Regeln:

- Normale, vom bestehenden Markdown-Roundtrip unterstuetzte Dokumente verwenden `tiptap_markdown`.
- Markdown mit erzwungenem Source Mode, nicht sicher serialisierbaren Konstrukten oder ueberschrittenem Rich-Editor-Limit verwendet `raw_text`.
- Ein Representation-Wechsel ist kein lokaler UI-Toggle, sondern eine serverseitige Migration bei leerem Dokument-Room mit vorherigem Checkpoint und anschliessender Validierung.
- Wenn eine sichere Representation nicht bestimmt werden kann, bleibt die Datei im Revision-Check-Modus.
- Alle Clients eines Dokuments muessen dieselbe Editor-Schema-Version verwenden. Inkompatible Clients werden read-only und muessen aktualisieren.

## Zielarchitektur

```txt
Tiptap Collaboration / CodeMirror-Yjs
              |
              | Yjs Updates + Awareness
              v
Canvas Collaboration WebSocket auf /ws/collaboration
              |
              | Hocuspocus Server + Auth/Permission Hooks
              v
Postgres collaboration_documents (binaerer Yjs-State)
              |
              | debounced Checkpoint
              v
Workspace-Datei (.md/.txt) + file_revisions + Audit + File Watcher

Hocuspocus Awareness Hooks
              |
              v
Workspace Presence Registry
              |
              | Initial Snapshot + Presence-Deltas
              v
File-Watcher-SSE / File Tree, ohne Dokument-Room-Beitritt
```

Technische Grundlage:

- Yjs als CRDT.
- `@tiptap/extension-collaboration` fuer strukturierte Markdown-Dokumente.
- `@tiptap/extension-collaboration-caret` fuer Remote-Cursor und Selections.
- `@tiptap/extension-unique-id` fuer stabile Absatz-/Block-IDs, insbesondere als Zielanker fuer Agent-Operationen.
- eine Yjs-Bindung fuer den vorhandenen CodeMirror-6-Editor bei `Y.Text`.
- Hocuspocus als selbst gehostetes Yjs-WebSocket-Backend.
- Hocuspocus Database Extension oder eine gleichwertige eigene Persistence Extension fuer Postgres.
- bestehender Canvas-HTTP-Server und Port; kein separater oeffentlicher Collaboration-Port.
- `/ws/chat` und `/ws/collaboration` verwenden getrennte Protokolle und getrennte Handler.
- Redis/NATS ist keine V1-Pflicht. Es wird erst bei Multi-Node-Betrieb oder nachgewiesener Last eingefuehrt.

### Dokumentations- und Versions-Baseline

Der Plan basiert auf der aktuellen offiziellen Hocuspocus-v4-, Tiptap-v3- und Yjs-Dokumentation. Zum Planungszeitpunkt verwendet das Repository bereits Tiptap `3.27.x`, CodeMirror 6 und Node.js 24 im Container. Damit ist die dokumentierte Mindestanforderung von Node.js 22 fuer Hocuspocus v4 erfuellt.

Vor Phase 2 werden die konkreten Paketversionen noch einmal gegen den Lockfile-Stand geprueft und gemeinsam gepinnt:

- alle `@hocuspocus/*` Pakete verwenden denselben Major,
- `@tiptap/extension-collaboration` und `@tiptap/extension-collaboration-caret` folgen der vorhandenen Tiptap-v3-Linie,
- `@tiptap/extension-unique-id` folgt derselben Tiptap-v3-Linie; der Editor wird erst nach Provider-Sync gemountet, damit die ID-Erweiterung keinen leeren Anfangszustand persistiert,
- genau eine kompatible Yjs-Version wird im Client- und Server-Bundle aufgeloest,
- die CodeMirror-6-Bindung wird mit dem vorhandenen `@uiw/react-codemirror`-Wrapper in einem kleinen Spike getestet,
- Upgrade-Router, Provider und Server bestehen vor Editor-Integration einen Protokoll-/Reconnect-Smoke-Test.

Verbindliche Herstellerhinweise:

- Yjs-State wird binaer als `Uint8Array` gespeichert; aus JSON bei jedem Connect neu erzeugte Y-Dokumente verlieren die gemeinsame History und koennen Inhalte duplizieren.
- Hocuspocus `onStoreDocument` ist debounced; kontrollierter Shutdown muss pending Stores flushen.
- `beforeHandleAwareness` und `onAwarenessUpdate` sind die vorgesehenen Hooks zum Validieren und Aggregieren fluechtiger Presence.
- `openDirectConnection` ist der vorgesehene serverseitige Pfad fuer Agent-/Automation-Transaktionen, die weiterhin Hooks, Synchronisation und Persistenz ausloesen sollen.
- Tiptap Collaboration verwendet eigene History; normales StarterKit Undo/Redo wird im Collaboration-Modus deaktiviert.
- Yjs Relative Positions werden fuer verschiebungsstabile Text-/Selection-Anker verwendet; normale Integer-Offsets sind bei parallelen Edits nicht stabil.

## Dokumentidentitaet

Relative Dateipfade sind keine stabile Collaboration-Identitaet.

Pflicht:

- Jeder kollaborativen Datei wird eine opaque `collaborationDocumentId` zugeordnet.
- WebSocket-Room-Namen verwenden nur diese ID plus Schema-Version, niemals einen frei gelieferten Dateipfad.
- `workspaceId` und aktueller Pfad werden serverseitig aus der Dokument-ID aufgeloest.
- Rename und Move behalten dieselbe Dokument-ID.
- Copy und Cross-Workspace-Copy erzeugen eine neue Dokument-ID und einen unabhaengigen Yjs-State.
- Delete archiviert den Collaboration-State nach einem finalen Checkpoint.
- Restore reaktiviert Datei, Dokument-Mapping und letzte konsistente Revision gemeinsam.
- Ein Dokument darf nie durch eine Pfad-Kollision aus einem anderen Workspace geladen werden.

## Initialisierung und Source of Truth

### Erstmalige Aktivierung

1. Client fordert eine Collaboration Session fuer `workspaceId` und Dateipfad an.
2. Server prueft Session, Team-Capability, Workspace Read/Write Permission, Postgres, Feature-Gate, Dateityp, Groesse und Editor-Kompatibilitaet.
3. Server liest aktuelle Datei und aktuelle Revision.
4. Wenn noch kein Collaboration-Dokument existiert, wird genau einmal ein `Y.Doc` aus dieser Revision erzeugt.
5. Binaerer Yjs-State, Representation, Schema-Version und `snapshotRevisionId` werden atomar gespeichert.
6. Erst danach wird ein kurzlebiges Collaboration-Ticket ausgegeben.

### Laufende Collaboration

Sobald ein Collaboration-Dokument aktiv ist, ist der Yjs-State die schreibbare Wahrheit. Die `.md`- oder `.txt`-Datei ist ein materialisierter, interoperabler Snapshot fuer:

- Download und Public Links,
- Agent-Kontext und nicht kollaborative Reader,
- Search/Knowledge-Ingestion,
- Backups und Exporte,
- Git- oder externe Datei-Workflows.

Die Workspace-Datei darf waehrend aktiver Collaboration nicht parallel durch normales Editor-Autosave als zweite Wahrheit geschrieben werden.

## WebSocket, Auth und Berechtigungen

Der bestehende HTTP-Server bekommt einen zentralen Upgrade-Router:

- `/ws/chat` bleibt fuer Chat-Sessions.
- `/ws/collaboration` wird fuer Hocuspocus/Yjs reserviert.
- Next.js darf akzeptierte Collaboration-Upgrades nicht erneut verarbeiten.
- Trusted-Origin-Pruefung, Heartbeat, Groessenlimits, Backpressure und redacted Logging gelten fuer beide Pfade.

### Collaboration Ticket

Der Browser erhaelt ueber eine authentifizierte API ein kurzlebiges, signiertes Ticket mit:

```txt
ticketId
userId
organizationId
workspaceId
collaborationDocumentId
permission: read | write
sessionId
schemaVersion
expiresAt
```

Regeln:

- Der Client darf `userId`, Workspace, Dokument oder Permission nicht selbst festlegen.
- Ticket-Lebensdauer ist kurz; Reconnect holt ein neues Ticket.
- `onAuthenticate` revalidiert aktive Membership, Workspace-Zugriff und Collaboration-Gate.
- Read-only User duerfen Zustand und Presence empfangen, aber keine Yjs-Updates senden.
- Permission- oder Membership-Entzug beendet laufende Schreibberechtigung und trennt die Verbindung bei Bedarf.
- Personal Workspaces bleiben fuer fremde User unsichtbar; Presence darf ihre Existenz nicht verraten.

## Persistenz und Checkpoints

### Yjs-Persistenz

Postgres speichert den binaeren Yjs-State. Der gespeicherte State muss exakt wieder geladen werden; bei jedem Connect neu aus Markdown erzeugte Y-Dokumente sind verboten.

V1-Ziele:

- Remote-Propagation im Normalfall unter 250 ms.
- Zusammengefuehrte Yjs-Updates werden kurz gebatcht, ohne spuerbare Editor-Latenz.
- Persistenter Yjs-Checkpoint spaetestens wenige Sekunden nach einer Aenderung.
- Pending Stores werden bei kontrolliertem Shutdown geflusht.
- Fehler beim Persistieren bleiben sichtbar und werden erneut versucht; die UI darf in diesem Zustand nicht dauerhaft "gespeichert" anzeigen.

`collaboration_events` ist kein dauerhafter Vollinhalt-Audit pro Tastendruck. Inhalte und Raw-Updates unterliegen eigener Retention. Der dauerhafte Audit Trail speichert Actor, Dokument, Zeitraum, Revisionen, Hashes und Ergebnis, nicht den kompletten Text jeder Operation.

### Workspace-Datei-Checkpoint

Ein Materialisierungs-Checkpoint wird ausgeloest:

- nach einer kurzen Idle-/Debounce-Phase,
- regelmaessig waehrend langer Sessions,
- beim letzten Disconnect,
- vor Rename, Move, Delete, Export oder Backup,
- beim kontrollierten Server-Shutdown.

Checkpoint-Ablauf:

1. aktuellen Yjs-State konsistent lesen,
2. anhand der gespeicherten Representation in Markdown oder Text serialisieren,
3. Format-/Roundtrip-Validierung ausfuehren,
4. Workspace-Datei ueber den normalen workspace-aware File-Service schreiben,
5. neue `file_revision` mit Actor-Typ `collaboration` erzeugen,
6. `snapshotRevisionId`, `stateVersion` und Checkpoint-Zeit aktualisieren,
7. Audit Summary und File-Watcher-Mutation publizieren.

File-Watcher-Events brauchen `source=collaboration_checkpoint`, `documentId` und `revisionId`, damit ein verbundener Collaboration-Editor seinen eigenen Snapshot nicht als externe Dateiaenderung behandelt.

## Workspace-weite Presence vor dem Oeffnen

### Produktziel

Der File Tree und alle File-Explorer-Darstellungen zeigen bereits vor dem Oeffnen einer Datei, welche berechtigten Teammitglieder daran arbeiten. Der betrachtende User muss dafuer nicht selbst dem Yjs-Dokument-Room beitreten und erzeugt dadurch auch keine falsche Dokument-Presence.

"Vor dem Oeffnen" bedeutet:

- Der File Explorer nutzt nur seinen workspace-weiten Presence-/File-Watcher-Kanal.
- Die eigentliche Dokument-WebSocket-Verbindung wird erst beim Oeffnen des Editors aufgebaut.
- Presence-Metadaten enthalten keine Dokumentinhalte und keine Yjs-Updates.

### Presence-Zustaende

Pro User und Dokument werden menschliche Aktivitaet und beauftragte Agent-Aktivitaet getrennt modelliert:

- `editing`: User hat den Editor fokussiert oder kuerzlich eine lokale Aenderung erzeugt.
- `viewing`: User ist mit dem Dokument-Room verbunden, aber aktuell nicht aktiv schreibend.
- `agent_editing`: Ein serverseitig verifizierter Agent-Run bearbeitet das Dokument im Auftrag dieses Users.

`agent_editing` darf einen User nicht als manuell tippend ausgeben. Die UI zeigt deshalb immer die duale Attribution, zum Beispiel `KI-Agent im Auftrag von Mia Schmidt`. Ist Mia gleichzeitig als User verbunden, erscheint sie nur einmal und ihr Marker erhaelt ein zusaetzliches KI-Badge. Ist sie nicht im Dokument-Room, darf die laufende Agent-Aktivitaet trotzdem als kurzlebiger, serverseitig erzeugter Presence-Eintrag sichtbar sein.

Ein User mit mehreren Tabs erscheint nur einmal. Der Server fuehrt intern die Connection-Anzahl, damit der menschliche User erst nach dem letzten Tab verschwindet; ein laufender Agent-Run hat einen eigenen Lifecycle und TTL.

### Server Presence Registry

Hocuspocus-/Awareness-Hooks pflegen eine fluechtige Registry:

```txt
workspaceId
collaborationDocumentId
currentPath
userId
displayName
avatarRef?
colorToken
humanActivity: viewing | editing | none
connectionCount
agentActivity?:
  agentId
  agentRunId
  phase: preparing | applying
  startedAt
lastSeenAt
```

Regeln:

- Awareness/Presence wird nicht dauerhaft in Postgres gespeichert.
- Disconnect entfernt Presence sofort, wenn die letzte Verbindung des Users endet.
- Verwaiste Eintraege laufen nach Heartbeat-/TTL-Ablauf aus.
- Rename/Move aktualisiert den aufgeloesten Pfad, ohne Presence zu verlieren.
- Nur berechtigte Workspace-Mitglieder erhalten Presence fuer sichtbare Dateien.
- E-Mail-Adressen, Tokens, Session-IDs und Dokumentinhalte werden nicht an andere Clients verteilt.
- Agent-Presence wird ausschliesslich serverseitig aus einem autorisierten Agent-Run erzeugt und kann nicht durch Client-Awareness vorgetaeuscht werden.
- Agent-Presence endet bei Apply, Review-Uebergabe, Abbruch oder Fehler und wird bei verlorenen Runs per TTL entfernt.

### File-Tree-Datenfluss

1. Beim Aufbau des File Explorers liefert eine permission-gepruefte Presence-API einen Snapshot fuer den aktiven Workspace und die aktuell sichtbaren/angefragten Pfade.
2. Der bestehende workspace-aware File-Watcher-SSE-Kanal wird um `presence_snapshot` und `presence_change` erweitert oder bekommt einen gleichwertigen Workspace-Presence-Stream.
3. Hocuspocus Presence Hooks publizieren kleine Deltas an diesen Workspace-Kanal.
4. Der Client speichert Presence getrennt vom File Tree, z. B. `Record<path, FilePresenceSummary>`.
5. Tree-, List- und Grid-Ansicht verwenden denselben Presence-State.
6. Workspace-Wechsel trennt den alten Presence-Stream, leert dessen State und abonniert den neuen Workspace.

Der File Tree darf nicht fuer jede sichtbare Datei einen eigenen WebSocket oder Polling-Timer starten.

### File-Tree- und File-Explorer-UI

Jede aktive Datei kann rechts am Dateinamen eine kompakte Presence-Gruppe zeigen:

- kleine farbige Avatar-/Initial-Kreise,
- maximal drei sichtbare Personen, danach `+N`,
- voller Name und Aktivitaet im Tooltip/Popover,
- solide farbige Markierung fuer `editing`,
- dezentere oder umrandete Markierung fuer `viewing`,
- KI-Badge oder Sparkle am User-Marker fuer `agent_editing`,
- eigener Nutzer optional mit zusaetzlichem Ring, aber nicht doppelt,
- Lock-Symbol separat von Presence, damit Lock und Live-Collaboration nicht verwechselt werden.

Farbregeln:

- Farbe wird stabil aus Organization und User abgeleitet oder als zugreifbares User-Farbtoken gespeichert.
- Text, Ring und Tooltip muessen in Light/Dark Mode ausreichenden Kontrast haben.
- Farbe ist nie der einzige Informationstraeger; Initialen, Avatar, Tooltip und Aktivitaetsform ergaenzen sie.
- Bei vielen aktiven Dateien darf Presence keine Layout-Spruenge oder starkes Tree-Flackern erzeugen.

Akzeptanzbeispiel:

```txt
campaign-brief.md        [FW] [MS] [+2]
                               ^ solid = editing
research-notes.md        (AK)  ^ outline = viewing
annual-report.pdf        [Lock] FW
```

Der Tooltip kann beispielsweise anzeigen:

```txt
Frank Weber - bearbeitet gerade
Mia Schmidt - sieht die Datei an
KI-Agent im Auftrag von Alex Kim - ueberarbeitet einen Abschnitt
2 weitere Personen
```

## Editor Presence und Status

Nach dem Oeffnen zeigt der Editor Header:

- aktive Nutzer mit denselben Farben wie im File Tree,
- Remote-Cursor und Selections,
- laufende Agent-Aktivitaet mit `Agent im Auftrag von <User>`, Anzahl und Hervorhebung der Zielabschnitte sowie Status `preparing | applying`; eine getrennte Review-Karte zeigt anschliessend gegebenenfalls `needs_review`, `partially_applied` oder `semantic_conflict`,
- Connection State: `connecting | synced | reconnecting | offline | denied`,
- Persistence State: `pending | checkpointing | saved | error`,
- Workspace und letzte materialisierte Revision,
- Read-only-, Lock- oder Schema-Mismatch-Hinweise.

Der bisherige lokale `dirty`-State wird im Collaboration-Modus ersetzt durch:

- lokale Updates noch nicht an Provider uebergeben,
- Provider synchronisiert oder offline,
- Server-State noch nicht persistent gecheckpointet,
- Workspace-Datei noch nicht materialisiert.

Ein einzelnes "gespeichert" darf erst angezeigt werden, wenn der definierte Persistenzzustand erreicht ist.

### Verbindlicher Client-Durability-Vertrag

Der Editor fuehrt Connection und Durability getrennt. Die Connection kann bereits `synced` sein, waehrend der neueste lokale Inhalt noch nicht in Postgres oder noch nicht als Workspace-Datei materialisiert ist.

Die Durability-Abfolge ist monoton pro `documentSequence`:

```txt
local_pending
  -> server_received
  -> persisted_yjs
  -> checkpoint_pending
  -> checkpointed_file
```

Regeln:

- Ein `durability_snapshot` vom Server enthaelt Dokument-ID, Lifecycle-Generation, `documentSequence`, `checkpointSequence` und den State Vector des persistierten Yjs-State.
- Der Client wartet vor der State-Vector-Bewertung auf Provider-Sync und vergleicht den Snapshot mit dem lokal konvergierten `Y.Doc`.
- Ein alter Snapshot darf keine neuere lokale oder serverseitige Sequenz zurueckstufen.
- `persisted_yjs` bedeutet dauerhaft in Postgres, aber noch nicht zwingend aktueller Download-/File-Watcher-Inhalt.
- `checkpointed_file` darf nur fuer denselben autoritativen State Vector oder eine serverseitig bestaetigte neuere Sequenz angezeigt werden.
- `Cmd/Ctrl+S` fordert im Collaboration-Modus einen Checkpoint an; es schreibt keinen vom Client serialisierten Whole-File-Snapshot.
- Beim Schliessen wird ein noch nicht an den Provider uebergebenes lokales Update nicht als gespeichert markiert.

### Verbindlicher Checkpoint-Vertrag

Die Workspace-Datei ist eine abgeleitete Projektion. `POST /api/files/collaboration/checkpoint` uebermittelt daher keinen kanonischen Markdown-Inhalt, sondern nur Identitaet und erwarteten State Vector. Der Server:

1. revalidiert Ticket, Session, Workspace, Permission, Dokument-ID, Lifecycle, Pfad und Representation,
2. laedt den aktuell persistierten binaeren Yjs-State,
3. prueft dessen State Vector gegen die Erwartung des Aufrufers,
4. validiert bei Rich Markdown Schema, Stable IDs und exakten Markdown-Roundtrip,
5. leitet den Dateiinhalt ausschliesslich aus diesem persistierten State ab,
6. materialisiert Revision und Checkpoint mit Sequenz-Fencing,
7. liefert den autoritativen Durability-Snapshot zur Client-Reconciliation zurueck.

Ein inzwischen ueberholter Checkpoint ist ein erwarteter Concurrent-Fall und antwortet mit `409`, nicht mit einem generischen Serverfehler.

## Locks und Check-out

Fuer nicht live kollaborative Dateiarten gilt:

- Beim Oeffnen zur Bearbeitung wird ein Lock gesetzt oder explizit angefordert.
- Der Lock speichert `workspaceId`, Pfad, Revision, User, Session, Typ und Ablaufzeit.
- Andere User sehen im File Tree Lock-Owner und Ablaufstatus getrennt von Presence.
- Schreibversuche ohne gueltigen Lock werden blockiert oder erzeugen eine Konfliktkopie, je nach Dateiart.
- Owner/Admins koennen stale Locks mit Warnung und Audit aufheben.
- Locks werden per Heartbeat verlaengert und laufen nach Browser-/Session-Absturz aus.

Word/Excel/PowerPoint:

- V1 behandelt diese Dateien als exklusive Bearbeitung.
- Upload/Overwrite erzeugt eine neue Revision.
- Wenn zwischen Download und Upload eine andere Revision entstanden ist, wird der Upload als Konflikt gemeldet.

## Agenten, Automations und aktive Bearbeitung

Agenten sind eigene Actors, duerfen aber keine User-Arbeit verlieren lassen. Ein von einem User explizit beauftragter Agent ist ein kollaborativer Co-Autor mit dualer Attribution: technisch handelt `actorType=agent`, fachlich `initiatedByUserId=<auftraggebender User>`. Der Agent darf niemals so protokolliert oder dargestellt werden, als haette der User die Zeichen selbst getippt.

Regeln:

- Agent-Dateioperationen pruefen aktuelle Revision, Lock, Collaboration-Dokument und Presence.
- Lockpflichtige Dateien blockieren Agent Writes bei fremdem aktivem Lock.
- Aktive CRDT-Textdokumente duerfen nicht ueber `fs.writeFile()` oder den normalen Whole-File-Save ueberschrieben werden.
- Explizit von einem schreibberechtigten User angeforderte, zielgenau verankerte Agent-Aenderungen duerfen auch bei weiteren aktiven Menschen ueber eine serverseitige Hocuspocus-/Yjs-Direct-Connection angewendet werden.
- Presence ist dabei nur UX-Signal und niemals Lock oder alleinige Sicherheitsentscheidung. Die Apply-Entscheidung wird unmittelbar gegen den aktuellen Yjs-State getroffen.
- Autonome, zeitgesteuerte oder nicht eindeutig auf einen User-Auftrag zurueckfuehrbare Aenderungen werden bei aktiven Menschen als Review-Patch bereitgestellt.
- Wenn Zielanker fehlen, ein Zielabschnitt geloescht wurde oder seit Agent-Start semantisch ueberlappend geaendert wurde, wechselt die betroffene atomare Operationsgruppe auf `needs_review`; der Agent darf den aktuellen Inhalt nicht erraten oder per Whole-File-Merge ersetzen.
- Bis Direct-Connection und Review-Patch existieren, werden Agent Writes an aktiv geoeffneten CRDT-Dateien blockiert.
- Jede angewendete Agent-Aenderung speichert `initiatedByUserId`, `sessionId`, `agentId`, `agentRunId`, `workspaceId`, Dokument-ID, Zielanker, vorherigen/nachfolgenden State Vector und Checkpoint-Revision.
- Agent-Transaktionen werden nicht in die lokalen Undo-Stacks anderer User aufgenommen. Der Auftraggeber erhaelt eine eigene Aktion `Agent-Aenderung rueckgaengig machen`, die erneut serverseitig gegen den aktuellen State prueft und bei Ueberlappung einen Review-Diff oeffnet.

Dieselben Regeln gelten fuer Automations und serverseitige Integrationen. Sie erhalten eigene Actor-/Origin-Metadaten.

### Kritischer Co-Authoring-Flow: User A, User B und Agent B

Verbindliches Szenario:

1. User A und User B arbeiten im selben Yjs-Dokument.
2. User A tippt manuell an einer Stelle. User B markiert einen bestimmten Absatz oder referenziert ihn eindeutig und beauftragt seinen Agenten mit einer Ueberarbeitung.
3. Der Server erfasst fuer den Agent-Run den aktuellen State Vector, stabile Zielanker und einen eigenen Hash fuer jeden gelesenen Zielbereich. Reine Zeilen-/Zeichenoffsets aus einem Markdown-Snapshot sind nicht zulaessig.
4. Fuer strukturiertes Markdown verwenden Zielanker persistente Tiptap-Node-IDs und/oder Yjs Relative Positions. Fuer `Y.Text` werden Yjs Relative Positions fuer Start und Ende verwendet.
5. Solange der Agent arbeitet, sehen A und B `KI-Agent im Auftrag von User B` am Dokument und am betroffenen Abschnitt. Diese Anzeige stammt aus serverseitiger Agent-Presence, nicht aus frei gesetzter Client-Awareness.
6. Direkt vor Apply prueft der Server erneut Membership, Write Permission, Agent-Run, Dokument-ID, Representation, aktuellen State Vector sowie jeden Zielanker und Zielinhalt.
7. Hat A ausserhalb des Zielabschnitts gearbeitet oder kann der Agent-Patch deterministisch auf den aktuellen Zielabschnitt rebased werden, wird er als eine atomare Yjs-Transaktion mit Agent-Origin angewendet und sofort an A und B synchronisiert.
8. Hat A denselben Zielabschnitt inkompatibel geaendert, wurde der Absatz geloescht oder ist der Rebase mehrdeutig, wird nichts direkt geschrieben. User B erhaelt einen Review-Patch gegen den aktuellen Inhalt.
9. Nach erfolgreichem Apply werden Agent-Operation, duale Attribution, State-Vectors, Zielhash und spaetere Checkpoint-Revision auditiert. Agent-Presence wird beendet.

Yjs garantiert dabei die technische Konvergenz gleichzeitiger Operationen, aber nicht automatisch die semantische Qualitaet zweier widerspruechlicher Absatz-Ueberarbeitungen. Deshalb ist die Ueberlappungs-/Rebase-Pruefung ein Pflicht-Gate und kein optionales UI-Feature.

### Struktur einer Agent-Operation

Der Agent liefert keine komplette neue Markdown-Datei, sondern eine begrenzte Operation:

```txt
agentRunId
initiatedByUserId
agentId
sessionId
collaborationDocumentId
baseStateVector
operationGroups[]:
  groupId
  atomicity: all_or_nothing | independent
  targets[]:
    targetId
    nodeIds[]?
    relativeStart
    relativeEnd
    baseTargetHash
    operations[]
requestedMode: direct_apply | review
```

Der Server setzt fuer die Yjs-Transaktion einen nicht vom Client kontrollierbaren Origin:

```txt
source: agent
initiatedByUserId
agentId
agentRunId
sessionId
```

Operationen ausserhalb der autorisierten Zielanker werden abgelehnt. `requestedMode=direct_apply` ist nur eine Anfrage; die finale Entscheidung trifft der Server nach Revalidierung und Overlap-Pruefung.

### Mehrere Zielbereiche und atomare Gruppen

Ein Agent-Auftrag darf beliebig viele getrennte Bereiche adressieren, zum Beispiel den Einleitungstext und einen spaeteren Ergebnisabschnitt. Sichtbare Zeilenangaben wie `1-3` und `20-30` sind nur UI-Eingaben. Beim Start werden sie in stabile Block-IDs beziehungsweise Yjs Relative Positions umgewandelt.

Regeln:

- Jeder Zielbereich besitzt eigene Start-/Endanker, `targetId`, `baseTargetHash` und begrenzte Operationen.
- Alle Bereiche eines einzelnen User-Auftrags bilden standardmaessig eine `all_or_nothing`-Gruppe. Kollidiert ein Bereich, wird kein anderer Bereich dieser Gruppe teilweise angewendet.
- Nur fachlich unabhaengige Aenderungen duerfen vor dem Apply in getrennte `independent`-Gruppen zerlegt werden. Diese Zerlegung muss in Agent-Plan und UI sichtbar sein und darf nicht nach einem Konflikt still erfunden werden.
- Alle Zielanker werden vor der ersten Mutation aufgeloest. Ueberlappende oder verschachtelte Agent-Ziele muessen zu einer eindeutigen Operation normalisiert werden oder werden als mehrdeutig abgelehnt.
- Fuer `Y.Text` werden validierte, nicht ueberlappende Ersetzungen innerhalb der Transaktion in absteigender aktueller Dokumentposition angewendet, damit eine fruehe Ersetzung keinen spaeteren Zielbereich verschiebt.
- Fuer `Y.XmlFragment` werden Block-/Node-IDs und Baumbeziehungen validiert; konkurrierende Operationen auf Parent und Child desselben Teilbaums sind ohne explizite normalisierte Baumoperation nicht zulaessig.
- Innerhalb einer Gruppe werden Validierung und Apply in einer serverseitig serialisierten Document-Apply-Section ausgefuehrt. Zwischen letzter Overlap-Pruefung und `ydoc.transact(...)` darf kein anderer serverseitiger Apply eingeschoben werden.
- Eine erfolgreiche Gruppe wird als genau eine Yjs-Transaktion angewendet. So sehen alle Clients entweder die komplette fachliche Gruppe oder nichts davon.
- Bei mehreren unabhaengigen Gruppen duerfen sichere Gruppen angewendet werden, waehrend kollidierende Gruppen auf `needs_review` wechseln. Der Gesamtstatus lautet dann `partially_applied`; UI und Audit nennen exakt angewendete und offene Gruppen.
- Lokale Selection-/Cursor-Presence anderer User kann frueh vor moeglicher Ueberlappung warnen, ist aber kein verlaesslicher Konfliktnachweis und kein Lock.

Beispiel: User B beauftragt den Agenten mit Aenderungen an den in der UI als Zeilen `1-3` und `20-30` sichtbaren Bereichen. User A bearbeitet gleichzeitig Text in beiden Bereichen. Der Server arbeitet nicht mit diesen Zeilennummern weiter, sondern mit den beim Auftrag erzeugten Ankern. Sind beide Ziele Teil derselben Standardgruppe, wird bei einer inkompatiblen Aenderung keines der beiden Agent-Ergebnisse direkt angewendet. Sind sie vorher explizit als zwei unabhaengige Gruppen modelliert, wird jede Gruppe einzeln bewertet; ein Teil-Apply ist dann sichtbar und nie still.

Konfliktmatrix:

| Zustand pro Operationsgruppe | Ergebnis |
|---|---|
| Kein Ziel seit `baseStateVector` relevant geaendert | direkte atomare Yjs-Transaktion |
| Nur Einfuegungen ausserhalb der stabilen Zielanker | Anker neu aufloesen und direkt anwenden |
| Zielaenderung ist deterministisch und semantisch sicher rebasierbar | rebased atomar anwenden und auditieren |
| Ein Ziel einer `all_or_nothing`-Gruppe ist inkompatibel geaendert oder geloescht | gesamte Gruppe `needs_review`, nichts anwenden |
| Eine `independent`-Gruppe kollidiert, andere nicht | sichere Gruppen anwenden, kollidierende Gruppe Review, Gesamtstatus `partially_applied` |
| Zielanker lassen sich nicht mehr eindeutig aufloesen | betroffene Gruppe `needs_review` |

### In-Flight-, Offline- und Spaetankunfts-Races

Yjs-Updates koennen den Server erreichen, waehrend der Agent rechnet oder unmittelbar nach dessen Apply eintreffen. Deshalb fuehrt der Collaboration-Service fuer laufende Agent-Operationen ein kurzlebiges Change Window pro Dokument und Zielgruppe:

- Bereits empfangene User-Transaktionen seit `baseStateVector` werden vor Apply ueber aktuelle Zielhashes und betroffene Yjs-/Tiptap-Typen geprueft.
- Revalidierung und Agent-Transaktion laufen in derselben serialisierten Apply-Section auf demselben serverseitigen `Y.Doc`.
- Der Server vergibt eine monotone `documentSequence` fuer relevante User-/Agent-Transaktionen. Eine connection-gebundene Sync-Epoch oder gleichwertige Companion-/Stateless-Metadaten halten fest, bis zu welcher Sequence ein Client den Dokumentzustand gesehen hatte.
- Trifft danach eine User- oder Offline-Transaktion ein, deren bestaetigte Sync-Epoch vor dem Agent-Apply lag und die dieselben Zielanker beruehrt, bleibt der Yjs-State technisch konvergent, aber der Server erzeugt `collaboration_semantic_conflict`.
- Kann die Ausgangs-Epoch einer spaeten ueberlappenden Transaktion technisch nicht verlaesslich bestimmt werden, gilt konservativ ebenfalls `collaboration_semantic_conflict`; fehlende Metadaten duerfen keinen stillen Erfolg erzeugen.
- Bei `collaboration_semantic_conflict` wird nichts automatisch zurueckgerollt. A und B sehen den zusammengefuehrten aktuellen Zustand sowie einen gezielten Vergleich der betroffenen Gruppe und koennen bewusst bestaetigen oder korrigieren.
- Change-Window-Metadaten enthalten IDs, State-/Target-Hashes, Actor und Zeit, aber keine dauerhaft gespeicherten Dokumentinhalte.

Damit werden auch echte Gleichzeitigkeit, Netzwerklatenz und ein spaeter reconnectender User beruecksichtigt. CRDT-Konvergenz bleibt garantiert; semantische Ueberlappung wird sichtbar und reviewbar statt still als korrekt angenommen.

## Verpflichtende Hardening-Gates fuer Agent-Koautorenschaft

Die folgenden Regeln sind keine spaetere Komforterweiterung, sondern Bestandteil der Abnahme von Phase 7/8. Yjs garantiert die Konvergenz gueltiger CRDT-Updates, loest aber nicht automatisch Idempotenz eines fachlichen Agent-Auftrags, semantische Konflikte, Persistenzfehler oder Editor-Grenzfaelle.

### Operationsidentitaet, Idempotenz und Zustandsmaschine

- Jeder Agent-Auftrag erhaelt vor dem Modellaufruf eine serverseitige `operationId`, einen fuer Dokument und Auftraggeber eindeutigen `idempotencyKey` und eine `runGeneration`.
- Ein Retry mit demselben `idempotencyKey` liefert die vorhandene Operation und darf weder einen zweiten Modelllauf noch eine zweite fachliche Aenderung erzeugen. Dasselbe binaere Yjs-Update ist zwar idempotent anwendbar; eine neu erzeugte semantische Ersetzung ist es nicht.
- Alle Statuswechsel verwenden einen Compare-and-Swap auf `version`, `runGeneration` und erwarteten Vorstatus. Nur der Collaboration-Agent-Service darf terminale Status beziehungsweise Apply-/Persistenzstatus setzen.
- Ein Operationsgruppen-Payload wird vor dem Apply kanonisch serialisiert und gehasht. Derselbe `operationId` darf nach `applied_to_ydoc` nicht mit anderem Payload fortgesetzt werden.
- Accept, Reject, Cancel und Revert besitzen eigene Idempotenzschluessel. Doppelklick, HTTP-Retry oder Queue-Redelivery fuehren immer zu demselben Ergebnis.
- Terminale Zustaende sind mindestens `cancelled`, `expired`, `superseded`, `failed`, `rejected` und `reverted`. Ein terminaler Lauf darf nicht durch ein spaetes Modell- oder Worker-Ergebnis wieder aktiv werden.

### Mehrere parallele Agent-Runs

- Mehrere Runs am selben Dokument duerfen planen, aber ihre Revalidierung und Yjs-Apply-Transaktionen werden pro Dokument serialisiert.
- Zielabsichten koennen in Presence und Review-UI als weiche Hinweise erscheinen, sind jedoch keine Locks und blockieren menschliches Tippen nicht.
- Zwei nicht ueberlappende, weiterhin gueltige Agent-Gruppen duerfen nacheinander direkt angewendet werden. Ueberlappende Gruppen werden in stabiler Reihenfolge gegen den dann aktuellen State neu bewertet.
- Ein Run darf einen anderen nur mit expliziter, auditierter `supersedesOperationId` abloesen. Implizites Last-Writer-Wins zwischen Agenten ist verboten.
- Nach einer begrenzten Zahl von Rebase-Versuchen oder bei fortlaufender menschlicher Aenderung desselben Ziels wechselt der Agent in `needs_review`; kein Run darf Menschen durch endlose Retries aushungern oder sich mit einem anderen Run gegenseitig neu basieren.

### Cancel, Timeout, spaete Ergebnisse und Server-Neustart

- Cancel vor Beginn der autoritativen Yjs-Transaktion setzt `cancelled`; ein spaeter Modell- oder Tool-Callback wird durch `runGeneration` und CAS verworfen.
- Sobald die atomare Yjs-Transaktion committed ist, kann Cancel sie nicht unsichtbar zurueckdrehen. Die UI bietet stattdessen eine explizite, zustandsgepruefte Revert-Operation an.
- Timeouts setzen `expired` oder `failed` und entfernen Agent-Presence. Ein Timeout darf keinen Hintergrund-Apply nach sich ziehen.
- Beim Server-/Worker-Neustart werden nicht-terminale Operationen anhand ihres letzten dauerhaften Zustands rekonstruiert. `preparing` kann sicher auslaufen oder mit neuer Generation neu gestartet werden; `applying` wird ueber Payload-/State-Hash auf bereits erfolgten Commit geprueft und niemals blind erneut angewendet.
- Vor jedem Apply werden ausser Permissions auch Dokumentgeneration, Existenz, Archive-/Delete-Zustand, Workspace, Representation und `schemaVersion` revalidiert. Rename/Move behaelt die Dokument-ID; Delete, Restore oder Schemawechsel koennen einen alten Run verfallen lassen.

### Sichtbarkeit, Yjs-Persistenz und Datei-Checkpoint

Ein Agent-Erfolg hat getrennte, monotone Meilensteine:

1. `applied_to_ydoc`: Die Gruppe ist im autoritativen `Y.Doc` committed und fuer verbundene Clients sichtbar.
2. `persisted_yjs`: Der resultierende Yjs-State beziehungsweise das Update ist durch den Persistence-Hook dauerhaft in Postgres bestaetigt.
3. `checkpointed_file`: Die abgeleitete Markdown-/Textdatei und File Revision sind materialisiert.

Regeln:

- Die UI darf nach `applied_to_ydoc` "live angewendet" anzeigen, aber erst nach `persisted_yjs` "dauerhaft gespeichert" und erst nach `checkpointed_file` einen aktuellen Datei-/Download-Checkpoint behaupten.
- Debounce, Retry und Queueing des Store-Hooks werden in Status und Metriken sichtbar. Ein fehlgeschlagener Checkpoint macht einen bereits persistierten Yjs-State nicht rueckgaengig.
- Schlaegt die Yjs-Persistenz ueber das definierte Retry-/Zeitbudget hinaus fehl, wird das Dokument `degraded`; neue serverautorisierte Agent-/Automation-Writes werden blockiert, bis die Durability wieder gesund ist. Menschen erhalten einen klaren Reconnect-/Read-only-Hinweis statt eines falschen Saved-Status.
- Recovery vergleicht `resultingStateVectorHash`, Yjs-State-Version und Checkpoint-Revision. Sie darf aus einem neueren Checkpoint keinen aelteren Yjs-State rekonstruieren.

### Review-Accept, Reject und Revert gegen aktuellen State

- Accept ist kein Apply des alten Diffs. Unmittelbar davor werden Permission, Dokumentgeneration, Schema, alle Anker, Target-Hashes, Gruppenatomicity, Overlap und aktuelle State Vector erneut geprueft.
- Eine inzwischen kollidierende Review-Gruppe bleibt `needs_review` und zeigt einen aktualisierten Vergleich; sie wird nicht aufgrund einer alten Nutzeransicht erzwungen.
- `independent`-Gruppen duerfen nur durch eine vorab deterministische Serverregel oder eine explizite Auswahl des Users getrennt werden. Das LLM darf nach einem Konflikt nicht allein eine atomare Gruppe aufspalten.
- Reject aendert keinen Yjs-State. Revert ist eine neue, attribuierte Operation gegen den aktuellen State und wechselt bei fremden Folgeaenderungen auf Review, statt Bereiche blind zurueckzusetzen.

### Schema-, Struktur- und Update-Preflight

- Eine Agent-Gruppe wird zuerst auf einem isolierten Clone des aktuellen `Y.Doc` angewendet. Erst wenn Schema, Zielumfang und Serialisierung gueltig sind, darf dieselbe validierte Operationsgruppe in der autoritativen serialisierten Apply-Section ausgefuehrt werden.
- Der Preflight prueft erlaubte Tiptap-Nodes/-Marks, `schemaVersion`, maximale Struktur-/Textgroesse, Markdown-Roundtrip, Target-Scope und dokumentweit eindeutige Node-IDs.
- Stable IDs werden bei Aktivierung, Paste, Import, Split, Merge und Agent-Apply validiert. Bei Split/Merge ist deterministisch festgelegt, welcher Block seine ID behaelt; neue beziehungsweise duplizierte Bloecke erhalten serverseitig neue IDs oder die Operation wird abgelehnt.
- Vom Client kommende Yjs-Updates und Awareness sind untrusted. Auth, Dokument-/Workspace-Scope, Byte-/Rate-Limits und erlaubte Message-Typen werden vor Annahme geprueft; rich-text-semantische Updates werden begrenzt auf einem Clone validiert, bevor sie den autoritativen State erreichen.
- Ein nicht mehr eindeutig aufloesbarer Stable-ID-/Relative-Position-Anker fuehrt zu Review, nie zu heuristischer Ersetzung des "aehnlichsten" Absatzes.

### Grenzen, IME und Unicode

- Jeder Textanker speichert eine explizite `boundaryPolicy`, die auf die `assoc`-Semantik der Yjs Relative Positions abgebildet wird. Der sichere Default schliesst konkurrierende Einfuegungen direkt ausserhalb der Zielgrenzen nicht nachtraeglich in eine Agent-Ersetzung ein.
- Ein Agent-Apply, der eine aktive IME-/Composition-Range eines Clients ueberlappt, wird bis zum Composition-Ende zurueckgestellt oder auf Review gesetzt. Nicht ueberlappende Gruppen duerfen weiterlaufen.
- Textoperationen duerfen keine UTF-16-Surrogate, Combining-Sequenzen oder Grapheme-Cluster wie ZWJ-Emoji teilen. Selection-/Offset-Konvertierung verwendet die Editor-APIs beziehungsweise eine Grapheme-Segmentierung und wird nicht mit naiven String-Indizes implementiert.
- Boundary-Tests umfassen Einfuegungen exakt vor, auf und nach Start/Ende sowie leere Ziele, Absatzanfang/-ende und geloeschte Grenzzeichen.

### Streaming, Feedback-Loops und Ressourcenlimits

- Gestreamte Modell-Tokens sind ausschliesslich Vorschau. Autoritativer Yjs-State wird erst mit einer vollstaendigen, validierten Operationsgruppe veraendert; ein abgebrochener Stream hinterlaesst keine Teiltransaktion.
- Jeder Seiteneffekt traegt `correlationId`, `causationId`, `idempotencyKey` und eine begrenzte `triggerDepth`. Checkpoint, File Watcher, Knowledge-Indexing, Automation und Agent-Trigger duerfen dieselbe Kausalkette nicht erneut ausloesen.
- Die Outbox darf technisch erneut zustellen; alle Consumer deduplizieren ueber die Kausalkette und fuehren den fachlichen Seiteneffekt dadurch effektiv genau einmal aus. Ein Retry des Checkpoints erzeugt nicht mehrere Agent-Runs oder doppelte Revisionen.
- Pro Operation gelten konfigurierbare Obergrenzen fuer Payload-Bytes, Zielanzahl, Gruppenanzahl, Dokumentgroesse, Laufzeit, Rebase-Versuche und gleichzeitige Runs pro Dokument/User/Organization. Ueberschreitungen erzeugen Review oder einen klaren Fehler, keinen Whole-File-Fallback.
- Backpressure priorisiert menschliche Updates und Persistenz vor Agent-Apply. Agent-Presence nennt `queued`, `applying` oder `needs_review`, damit Wartezeit nicht wie aktive Bearbeitung aussieht.

### Encoding, GC, Datei-Lifecycle und Cross-Document-Operationen

- V1-Collaboration akzeptiert nur valide UTF-8-Textrepraesentationen. Binaere oder nicht sicher dekodierbare `.txt`-Dateien bleiben im Revision-/Lock-Modus.
- Im `Y.Text` gilt kanonisch LF ohne BOM. `lineEnding` (`lf | crlf`) und `bom` werden als Serialisierungsprofil getrennt gespeichert und beim Checkpoint reproduziert; kanonischer Inhalts-Hash und serialisierter Datei-Hash sind getrennt.
- Yjs-Garbage-Collection bleibt in V1 aktiviert. Pending Reviews/Agent-Operationen duerfen nicht auf unbegrenzt erhaltene Tombstones vertrauen, sondern speichern kurzlebige, verschluesselte Payload-/Vergleichsartefakte mit TTL. Abgelaufene Anker wechseln auf `expired` oder erneuten Review.
- State-Compaction erfolgt nur bei leerem Room und ohne laufende/pending Operationen, nach bestaetigtem Checkpoint und Backup-Marker. Revert basiert auf Revisionen beziehungsweise expliziten Gegenoperationen, nicht auf ewiger Yjs-Historie.
- Rename/Move behaelt ID und Generation. Delete cancelt offene Operationen; Copy erzeugt einen neuen State ohne pending Agent-Runs; Restore erhoeht die Dokumentgeneration. Ein Representation-/Schemawechsel quiesziert den Room und setzt alte Operationen auf Review/Expired.
- Ein Auftrag ueber mehrere Dokumente besitzt in V1 keine verteilte CRDT-Atomaritaet. Er wird als Saga mit Status pro Dokument, expliziter Kompensation beziehungsweise Review ausgefuehrt; gefordertes Cross-Document-`all_or_nothing` wird als nicht direkt unterstuetzt angezeigt.
- Der Client besitzt pro geoeffnetem Dokument genau eine Provider-Instanz mit `connectionInstanceId`. React Strict Mode, Remount, Tab-Sleep und Reconnect duerfen keine doppelten Provider, Awareness-Eintraege oder Listener erzeugen; Cleanup und Event-Deduplizierung sind verbindlich.

## Externe Dateiaenderungen und Konflikte

Auch bei Yjs bleiben externe Writes moeglich, etwa durch Restore, Import oder einen kontrollierten Host-Prozess.

Regeln:

- Normale App-Flows muessen aktive Collaboration-Dokumente erkennen und duerfen nicht direkt schreiben.
- Eine externe Dateiaenderung bei leerem Dokument-Room kann ueber einen versionierten Import-Flow in einen neuen Yjs-State uebernommen werden.
- Eine externe Dateiaenderung bei aktiven Clients wird nicht automatisch importiert.
- Der Dokumentzustand wechselt auf `conflicted`; Editor und File Tree zeigen einen sichtbaren Hinweis.
- Konfliktaktionen sind: externe Version vergleichen, als Konfliktkopie behalten, serverseitig als Patch anwenden oder bewusst verwerfen.
- Ein Admin-Force-Overwrite braucht Warnung, finalen Checkpoint, Audit und Trennung der aktiven Clients.

Nicht kollaborative Dateien behalten `baseRevisionId`-/SHA-Konfliktverhalten.

## Datenmodell

### File Revisionen

```txt
file_revisions
- id
- organizationId
- workspaceId
- path
- contentHash
- sizeBytes
- createdByUserId?
- createdByActorType: user | agent | automation | collaboration | system
- sourceSessionId?
- baseRevisionId?
- createdAt
```

### Locks

```txt
file_locks
- id
- organizationId
- workspaceId
- path
- revisionId?
- lockedByUserId
- lockedBySessionId?
- lockType: edit | upload | agent_write
- status: active | released | expired | force_released
- expiresAt
- createdAt
- updatedAt
```

### Collaboration-Dokumente

```txt
collaboration_documents
- id
- organizationId
- workspaceId
- currentPath
- lifecycleGeneration
- provider: yjs
- documentKind: tiptap_markdown | raw_text
- schemaVersion
- serializationEncoding: utf8
- lineEnding: lf | crlf
- bom: boolean
- stateBinary: BYTEA
- stateVectorBinary?: BYTEA
- stateVersion
- canonicalContentHash?
- serializedContentHash?
- snapshotRevisionId?
- lastCheckpointAt?
- status: active | degraded | archived | conflicted
- createdAt
- updatedAt
```

### Kurzlebige Updates und Audit-Referenzen

```txt
collaboration_events
- id
- documentId
- initiatedByUserId?
- actorSessionId?
- actorType: user | agent | automation | system
- agentId?
- agentRunId?
- operationId?
- transactionOrigin
- correlationId?
- causationId?
- idempotencyKey?
- triggerDepth?
- documentSequence
- clientSyncEpoch?
- operationGroupId?
- targetIds?
- baseStateVectorHash?
- resultingStateVectorHash?
- targetAnchorHash?
- payloadRef?
- payloadHash?
- expiresAt?
- createdAt
```

Presence bleibt fluechtig und ist keine Pflicht-Datenbanktabelle.

Fuer laenger laufende, direkte oder reviewpflichtige Agent-Aenderungen wird zusaetzlich folgende Entitaet geplant:

```txt
collaboration_agent_operations
- id
- organizationId
- workspaceId
- documentId
- documentLifecycleGeneration
- idempotencyKey: UNIQUE(documentId, initiatedByUserId, idempotencyKey)
- runGeneration
- version
- initiatedByUserId
- actorSessionId?
- agentId
- agentRunId
- supersedesOperationId?
- status: preparing | ready | applying | applied_to_ydoc | persisted_yjs | checkpointed_file | partially_applied | needs_review | semantic_conflict | cancel_requested | cancelled | expired | superseded | failed | rejected | reverted
- atomicity: all_or_nothing | independent
- baseStateVectorHash
- baseDocumentSequence
- operationGroupsRef
- operationGroupsHash
- resultingStateVectorHash?
- checkpointRevisionId?
- cancelRequestedAt?
- appliedAt?
- persistedAt?
- checkpointedAt?
- expiresAt?
- errorCode?
- createdAt
- updatedAt
```

`version`, `runGeneration`, erwarteter Vorstatus und Payload-Hash bilden gemeinsam den CAS-Guard. Vorgeschlagener Text, Raw-Operations und Review-Vergleiche liegen nur kurzlebig ueber `operationGroupsRef` beziehungsweise `payloadRef` vor, sind verschluesselt und folgen der Content-Retention.

## API- und Event-Vertraege

Geplante APIs:

- `POST /api/files/collaboration/session`: prueft Gate, initialisiert Dokument und liefert Ticket/Room-Konfiguration.
- `POST /api/files/collaboration/checkpoint`: nur interner oder kontrollierter Flush; kein frei vertrauenswuerdiger Client-Overwrite.
- interner Collaboration-Agent-Service: erstellt zielverankerte Agent-Operationen, revalidiert sie und wendet sie ueber Hocuspocus Direct Connection an oder erzeugt einen Review-Patch.
- `GET /api/files/presence`: permission-gepruefter Initial-Snapshot fuer sichtbare Workspace-Dateien.
- bestehende Lock-API bleibt fuer lockpflichtige Dateien.
- bestehende Read-API liefert Collaboration-Capability, Dokument-ID, Representation und Health, aber keinen geheimen Ticketwert.

Geplante Workspace-Events:

```txt
presence_snapshot
presence_change
collaboration_checkpoint
collaboration_conflict
collaboration_document_moved
collaboration_document_archived
collaboration_agent_started
collaboration_agent_applied
collaboration_agent_persisted
collaboration_agent_checkpointed
collaboration_agent_partially_applied
collaboration_agent_needs_review
collaboration_agent_cancelled
collaboration_agent_superseded
collaboration_agent_finished
collaboration_semantic_conflict
collaboration_persistence_error
```

Alle Events tragen mindestens `workspaceId`, Dokument-ID beziehungsweise Pfad, Zeit und eine monotone oder vergleichbare Version. Clients ignorieren Events aus einem nicht mehr aktiven Workspace.

## Feature-Gates und Fehlerverhalten

Live-Collaboration darf nur aktiv werden, wenn:

- Team-/Multi-User-Capability erlaubt ist,
- `CANVAS_DATABASE_PROVIDER=postgres` aktiv und gesund ist,
- Collaboration-Migrationen aktuell sind,
- WebSocket-/Hocuspocus-Backend bereit ist,
- Persistenz-Health erfolgreich ist,
- Organization Setting `liveCollaborationEnabled=true` gesetzt ist,
- Dateiart, Representation und Groesse unterstuetzt werden.

Der Settings-Schalter allein darf nicht behaupten, das Feature sei funktionsfaehig. Die UI unterscheidet:

- `disabled`: bewusst ausgeschaltet,
- `available`: technisch bereit, noch nicht aktiviert,
- `blocked`: Provider, Lizenz, Migration oder Health fehlt,
- `enabled`: Gate aktiv und Backend gesund,
- `degraded`: Verbindungen moeglich, aber Persistenz oder Presence ist gestoert.

Fallback:

- Vor dem ersten Yjs-Dokument darf bei deaktivierter Collaboration der Revision-Check-Modus verwendet werden.
- Ein bereits aktives Yjs-Dokument faellt bei Backend-Ausfall nicht still auf Whole-File-Autosave zurueck.
- Stattdessen bleibt der Editor offline/reconnecting oder read-only und zeigt den Zustand deutlich.

## Observability, Datenschutz und Retention

Metriken:

- aktive Collaboration-Verbindungen,
- aktive Dokument-Rooms,
- aktive User pro Workspace und Dokument,
- Update- und Awareness-Rate,
- Sync-/Checkpoint-Latenz,
- Persistenzfehler und Retry-Anzahl,
- Yjs-State-Groesse,
- Presence-TTL-Bereinigungen,
- Schema-Mismatch- und Auth-Rejections.

Logs und Audit:

- keine Dokumentinhalte, Yjs-Payloads, Tokens oder E-Mail-Adressen in normalen Logs,
- strukturierte IDs, Actor-Typ, Workspace, Dokument, Dauer, Bytegroesse und Resultat,
- Raw-Debug-Updates nur explizit, redacted und kurzlebig,
- Awareness wird nicht als langfristige Mitarbeiteraktivitaets-Historie gespeichert,
- File-Tree-Presence dient der aktuellen Zusammenarbeit, nicht der Leistungskontrolle.

## Umsetzung in strikt aufeinanderfolgenden Phasen

Keine Phase beginnt, bevor die vorherige Phase fertig, getestet und committed ist.

### Phase 1: Plan- und Gate-Korrektur

- Todo `44` auf Foundation-Scope praezisieren.
- neue Aufgabe `48` fuer echte Live-Collaboration aufnehmen.
- Settings-/Health-Vertrag um `available`, `blocked`, `enabled`, `degraded` planen.
- keine UI als "live" bezeichnen, solange kein Provider verbunden ist.

Abnahme:

- Dokumentation und Todo JSON sind konsistent.
- bestehende Foundation bleibt unveraendert funktionsfaehig.

### Phase 2: Postgres Repository und Migration

- native provider-aware Collaboration-Repository-Schicht bauen.
- `stateBinary`, Representation, Schema-Version und Checkpoint-Felder migrieren.
- bestehende SQLite-Metadaten nicht als produktiven Yjs-State behandeln.
- Dokument-ID-/Path-Lifecycle implementieren.

Abnahme:

- binaerer Yjs-State roundtript exakt durch Postgres.
- Workspace-Isolation, Rename, Copy, Archive und Restore sind getestet.

### Phase 3: WebSocket-/Hocuspocus-Backend

- Upgrade-Router fuer Chat und Collaboration bauen.
- Hocuspocus unter `/ws/collaboration` integrieren.
- Ticket-API, Auth, Permission, Origin, Limits und Revocation implementieren.
- Persistence Hooks und Shutdown Flush anbinden.

Abnahme:

- zwei rohe Yjs-Clients synchronisieren ueber denselben App-Port.
- unberechtigte Workspace-/Dokumentzugriffe werden blockiert.
- Neustart laedt denselben Yjs-State.

### Phase 4: Editor-Bindings

- Tiptap Collaboration und Caret fuer `Y.XmlFragment` integrieren.
- UniqueID fuer freigegebene Blocktypen konfigurieren und den Editor erst nach Provider-Sync mounten.
- StarterKit Undo/Redo im Collaboration-Modus deaktivieren und Yjs History verwenden.
- CodeMirror an `Y.Text` binden.
- Whole-File-Autosave und externe `setContent`-Synchronisierung im Collaboration-Modus abschalten.
- Connection-, Persistence- und Read-only-State im Editor abbilden.

Abnahme:

- zwei Editor-Clients konvergieren bei parallelen Edits.
- Tabellen, Bilder, Task Lists, Mermaid, Slash Commands und Block-Reorder bleiben stabil.
- Raw-Text- und Source-only-Dokumente konvergieren ebenfalls.

### Phase 5: Workspace-Datei-Checkpoints

- Yjs-State in `.md`/`.txt` materialisieren.
- Revision, Audit, Public Share, Search/Knowledge und File Watcher anbinden.
- eigene Checkpoint-Events im Collaboration-Editor unterdruecken.
- Backup-, Export-, Rename-, Move- und Delete-Flush implementieren.

Abnahme:

- Download und Public Share zeigen den letzten bestaetigten Checkpoint.
- Neustart, Backup und Restore verlieren keine bestaetigten Edits.
- kein Save-Loop zwischen File Watcher und Collaboration Provider.

### Phase 6: Workspace Presence und File Tree

- Presence Registry aus Awareness Hooks bauen.
- initiale Presence-API und Workspace-Deltas anbinden.
- File Store um separaten Presence-State erweitern.
- Tree-, List- und Grid-Ansicht mit farbigen User-Hinweisen ausstatten.
- Tooltips, `+N`, viewing/editing/agent_editing, duale Agent-Attribution, Dark Mode und Accessibility umsetzen.
- Rename, Workspace-Wechsel, Disconnect und TTL behandeln.

Abnahme:

- User A sieht im File Tree, dass User B eine Datei bearbeitet, bevor A sie oeffnet.
- A tritt durch die reine File-Tree-Anzeige nicht dem Dokument-Room bei.
- Tree Presence verschwindet nach dem letzten Disconnect oder TTL.
- mehrere Tabs desselben Users erzeugen nur einen sichtbaren Nutzer.
- ein laufender Agent-Run erscheint mit KI-Badge am Auftraggeber, auch wenn dieser nicht im Dokument-Room ist, und verschwindet nach Apply, Review-Uebergabe, Abbruch, Fehler oder TTL.
- User sehen keine Presence aus unberechtigten Workspaces oder Dateien.

### Phase 7: Agent-/Automation-Patch-Flow

- direkte Whole-File-Writes an aktive Collaboration-Dokumente blockieren.
- serverseitige Yjs Direct Connection fuer explizit beauftragte, zielverankerte Agent-Operationen bauen.
- Tiptap-Node-IDs/Yjs Relative Positions, per-Target-Hashes, Multi-Range-Operationsgruppen und Overlap-/Rebase-Pruefung implementieren.
- `all_or_nothing` als Default, explizite `independent`-Gruppen, serialisierte Document-Apply-Section und Change Windows fuer In-Flight-/Offline-Races umsetzen.
- persistierte Operationszustandsmaschine mit Idempotenzschluessel, CAS, `runGeneration`, Cancel/Timeout/Restart-Recovery und serialisierten parallelen Agent-Runs umsetzen.
- Agent-Operationen zunaechst auf isoliertem Y.Doc-Clone gegen Schema, Stable-ID-Eindeutigkeit, Zielumfang, Groesse und Markdown-Roundtrip pruefen.
- duale Attribution `Agent im Auftrag von User`, Agent-Presence und serverseitig gestempelten Transaction Origin umsetzen.
- Review-Patch mit Diff, idempotentem Accept/Reject und erneuter kompletter State-/Permission-/Target-Pruefung fuer mehrdeutige oder autonome Aenderungen bauen.
- separates Rueckgaengigmachen von Agent-Aenderungen und Ausschluss aus fremden lokalen Undo-Stacks umsetzen.
- gestreamte Modellantwort nur als Vorschau behandeln und ausschliesslich vollstaendige validierte Operationsgruppen autoritativ anwenden.
- Agent-Origin, Auftraggeber, Zielanker, State-Vectors, Kausalkette, Yjs-Persistenz und Checkpoint-Revision auditieren.

Abnahme:

- Agent kann aktive menschliche Edits nicht ueberschreiben.
- User A kann manuell tippen, waehrend ein von User B beauftragter Agent einen anderen Absatz als Yjs-Transaktion aendert; beide Clients konvergieren und zeigen die korrekte duale Attribution.
- gleichzeitige inkompatible Aenderungen desselben Zielabschnitts wechseln fuer User B auf `needs_review`, ohne Aenderungen von User A zu verlieren.
- ein Agent-Auftrag fuer mehrere getrennte Bereiche wird standardmaessig all-or-nothing angewendet; ein Konflikt in einem Bereich erzeugt keinen stillen Teil-Apply der restlichen Bereiche.
- explizit unabhaengige Gruppen koennen teilweise angewendet werden, zeigen dann aber `partially_applied` mit exakter Gruppenauflistung.
- spaet eintreffende oder Offline-User-Aenderungen an bereits vom Agent angewendeten Zielbereichen erzeugen `collaboration_semantic_conflict` und einen gezielten Vergleich.
- derselbe Agent-Auftrag kann nach Client-/Queue-Retry nicht doppelt angewendet werden; parallele Agent-Runs werden gegen den jeweils aktuellen State serialisiert und ueberlappende Runs nicht per Last-Writer-Wins entschieden.
- Cancel, Timeout, spaetes Modellresultat oder Server-Neustart erzeugen keinen unbemerkten Apply beziehungsweise Replay.
- Review-Accept und Revert werden unmittelbar gegen den aktuellen Dokumentzustand revalidiert und sind idempotent.
- die UI unterscheidet live angewendet, dauerhaft als Yjs gespeichert und als Datei-Checkpoint materialisiert; ein Persistenzfehler erzeugt `degraded` statt falschem Saved-Status.
- direkt angewendete und angenommene Agent-Patches erscheinen live bei allen Clients.
- abgelehnte Patches aendern weder Yjs-State noch Workspace-Datei.

### Phase 8: Hardening und Rollout

- Offline/Reconnect, Backpressure, grosse Dokumente, Schema-Mismatch, IME/Unicode, Provider-Doppelmounts und Boundary-Semantik testen.
- UTF-8-/LF-Kanonisierung, CRLF-/BOM-Reproduktion, Yjs-GC/Compaction, Review-TTL und Datei-Lifecycle-Generationen hardenen.
- Ressourcenlimits und Fairness fuer Payload, Ziele, Laufzeit, Rebase-Versuche und parallele Runs festlegen.
- Feedback-Loops zwischen Agent, Checkpoint, File Watcher, Knowledge und Automations ueber Kausalkette und Idempotenz verhindern.
- Metrics, Alerts, Retention und Admin-Health fertigstellen.
- Preview-Gate kontrolliert fuer Postgres-Team-Instanzen aktivieren.
- Admin-/User-Dokumentation und Release Notes erstellen.

Abnahme:

- `npm run build`, relevante Integrationstests und freigegebene UI-/E2E-Tests bestehen.
- kein Container-Build ohne ausdrueckliche Anforderung.
- Multi-Node bleibt deaktiviert, bis Redis/NATS und entsprechende Lasttests umgesetzt sind.

## Verbindliche Tests

### CRDT und Persistenz

- zwei Clients editieren gleichzeitig verschiedene Stellen und konvergieren,
- zwei Clients fuegen gleichzeitig an derselben Position ein und konvergieren,
- Offline-Edit plus Reconnect konvergiert ohne stillen Verlust,
- Server-Neustart laedt denselben Yjs-State,
- Pending Store wird bei kontrolliertem Shutdown geflusht,
- Checkpoint erzeugt valide Markdown-/Textdatei und neue Revision,
- UI-/Operationsstatus unterscheidet `applied_to_ydoc`, `persisted_yjs` und `checkpointed_file`; simulierter Store-Fehler erzeugt `degraded` und blockiert neue Agent-Writes,
- Recovery nach Neustart erkennt einen bereits angewendeten, aber noch nicht als fertig markierten Run ueber State-/Payload-Hash und spielt ihn nicht erneut ab,
- LF-internes Dokument wird gemaess gespeichertem Profil als LF oder CRLF und mit/ohne BOM reproduziert; kanonischer und serialisierter Hash bleiben korrekt,
- Compaction laeuft nur bei leerem Room ohne pending Operationen und verliert weder bestaetigten State noch Review-/Revisionsreferenzen,
- Tiptap-Markdown-Roundtrip bleibt fuer alle freigegebenen Nodes stabil,
- Source-only- und Grossdatei-Fallback ist deterministisch.

### Auth und Scope

- fremder Personal Workspace wird als nicht vorhanden behandelt,
- Team-User ohne Write Permission ist read-only,
- Permission-Entzug beendet laufende Schreibberechtigung,
- Ticket kann nicht fuer anderes Dokument oder Workspace wiederverwendet werden,
- abgelaufenes Ticket wird abgelehnt,
- untrusted Origin wird abgelehnt.

### File Tree Presence

- Presence ist vor dem Oeffnen der Datei sichtbar,
- Tree-Abonnent ist nicht als Dokument-Viewer sichtbar,
- `editing` und `viewing` werden unterscheidbar dargestellt,
- `agent_editing` zeigt `KI-Agent im Auftrag von <User>` und kann nicht durch Client-Awareness vorgetaeuscht werden,
- farbige Marker stimmen zwischen File Tree und Editor ueberein,
- drei Nutzer plus Overflow zeigen `+N`,
- Tooltip nennt erlaubte Anzeigenamen und Aktivitaet,
- mehrere Tabs werden pro User dedupliziert,
- Disconnect, Browser-Crash und TTL entfernen stale Presence,
- Workspace-Wechsel leert alte Presence sofort,
- Rename verschiebt Presence ohne kurzzeitige Doppelanzeige,
- Tree, List und Grid zeigen denselben Zustand,
- Dark Mode, Keyboard-Fokus, Screenreader-Label und Kontrast werden geprueft.

### Agenten und Konflikte

- Agent Whole-File-Write wird bei aktivem Collaboration-Dokument blockiert,
- serverseitige Agent-Yjs-Transaktion konvergiert bei leerem Room,
- User A tippt, waehrend der von User B beauftragte Agent einen nicht ueberlappenden Absatz live aendert; beide Clients konvergieren,
- Transaktion, UI und Audit zeigen `Agent im Auftrag von User B`, nicht eine manuelle Aenderung von B,
- Agent-Zielanker bleiben bei parallelen Einfuegungen vor dem Absatz stabil,
- zwei Agent-Zielbereiche in `Y.Text` werden vor Mutation gemeinsam aufgeloest und in sicherer Reihenfolge angewendet; der erste Write verschiebt nicht den zweiten,
- ueberlappende Agent-Zielbereiche beziehungsweise Parent-/Child-Baumoperationen werden normalisiert oder abgelehnt,
- parallele inkompatible Aenderung desselben Absatzes erzeugt `needs_review` statt Direkt-Apply,
- Agent adressiert zwei getrennte Bereiche; parallele User-Aenderung in einem Bereich blockiert bei `all_or_nothing` beide Agent-Aenderungen,
- dieselbe Situation mit zwei vorab explizit unabhaengigen Gruppen wendet nur die sichere Gruppe an und meldet `partially_applied`,
- parallele User-Aenderungen in beiden Agent-Zielbereichen erzeugen pro Gruppe korrekte Konfliktzuordnung,
- ein User-Update, das zwischen letzter Vorpruefung und Apply eintrifft, wird durch die serialisierte Apply-Section vor dem Agent-Commit beruecksichtigt,
- ein Offline-Update mit altem Ausgangs-State trifft nach Agent-Apply am selben Ziel ein und erzeugt `collaboration_semantic_conflict`,
- fehlende oder unklare Client-Sync-Epoch bei spaeter Zielueberlappung fuehrt konservativ zu `collaboration_semantic_conflict`,
- ein Retry mit demselben `idempotencyKey` startet und wendet denselben fachlichen Agent-Auftrag genau einmal an,
- zwei parallele Agent-Runs auf nicht ueberlappenden Zielen werden nacheinander gegen aktuellen State angewendet; bei ueberlappenden Zielen entscheidet kein Last-Writer-Wins,
- Cancel vor Apply, Timeout, spaetes Modellresultat und Worker-Neustart koennen keinen terminalen Run spaeter anwenden; Cancel nach Apply wird als neue Revert-Anfrage behandelt,
- doppeltes oder veraltetes Review-Accept wird idempotent verarbeitet und revalidiert alle Gruppen gegen den aktuellen State,
- Preflight lehnt ungueltiges Tiptap-Schema, Operationen ausserhalb der Ziele, duplizierte Stable IDs und nicht roundtrip-faehiges Markdown vor Mutation des autoritativen Y.Doc ab,
- Stable IDs bleiben bei Paste, Import, Split und Merge dokumentweit eindeutig; unaufloesbare Anker wechseln auf Review,
- Boundary-Tests vor/auf/nach Start und Ende folgen der festgelegten `assoc`-/`boundaryPolicy` und beziehen fremde Randeinfuegungen nicht versehentlich ein,
- aktive IME-Composition am Ziel wird nicht zerstoert; Emoji-, Surrogate-, Combining- und ZWJ-Grapheme werden nie geteilt,
- ein abgebrochener Modellstream hinterlaesst keine autoritative Teiloperation,
- Checkpoint-, File-Watcher-, Knowledge- und Automation-Events mit derselben Kausalkette triggern keinen zweiten Agent-Run oder doppelte Revision,
- Limits und Backpressure verhindern uebergrosse beziehungsweise endlos rebasierende Agent-Runs und priorisieren menschliche Updates,
- autonome Agent-Runs erhalten bei aktiven Menschen einen Review-Patch statt silent write,
- fremde lokale Undo-Stacks nehmen die Agent-Transaktion nicht auf; die dedizierte Revert-Aktion prueft den aktuellen State,
- Shell-, File-Tool-, Automation- und Integrationspfade koennen den Collaboration-Agent-Service nicht per Whole-File-Write umgehen,
- externe Datei-Aenderung bei aktivem Room erzeugt Konfliktstatus,
- Force-Overwrite braucht Admin, Audit und trennt Clients kontrolliert.

### Datei-Lifecycle und Backups

- Rename/Move behaelt Dokument-ID und Presence,
- Copy erzeugt unabhaengigen State ohne pending Agent-Operationen,
- Delete flusht, archiviert und cancelt offene Operationen,
- Restore reaktiviert den konsistenten Zustand mit neuer Lifecycle-Generation und laesst alte Runs nicht spaet anwenden,
- Representation-/Schemawechsel quiesziert den Room und setzt alte Operationen kontrolliert auf Review oder Expired,
- eine dokumentuebergreifende Agent-Saga weist Teilstatus und Kompensation/Review aus und behauptet keine verteilte Atomaritaet,
- React-Strict-Mode, Remount, Tab-Sleep und Reconnect erzeugen pro Dokument keine doppelten Provider, Awareness-Eintraege oder Listener,
- Full Backup enthaelt Postgres-Yjs-State und materialisierte Dateien,
- Restore startet ohne doppelte Initialisierung oder verlorene History.

UI- und End-to-End-Pruefungen werden gemaess Repository-Regeln erst nach expliziter Freigabe mit Playwright oder Chrome DevTools ausgefuehrt.

## Nicht-Ziele fuer V1

- Live-Merge fuer Office, PDF, Bilder, Video oder Audio.
- Live-Collaboration fuer MDX, QMD, JSON, YAML oder Code.
- Excalidraw-Live-Collaboration innerhalb von Aufgabe `48`; sie bleibt Aufgabe `52` mit eigener Repraesentation und Policy.
- Multi-Node-Hocuspocus ohne Redis/NATS.
- dauerhafte Speicherung von Presence als Mitarbeiteraktivitaets-Historie.
- automatische Uebernahme externer File Writes in aktive Yjs-Dokumente.
- ein zweiter oeffentlicher App-Port nur fuer Collaboration.
- stille Rueckkehr zu Whole-File-Autosave bei Collaboration-Ausfall.

## Offizielle technische Referenzen

- [Tiptap/Hocuspocus: Collaborative Editing](https://tiptap.dev/docs/hocuspocus/guides/collaborative-editing)
- [Hocuspocus: Server Usage und Direct Connections](https://tiptap.dev/docs/hocuspocus/server/usage)
- [Hocuspocus: Hooks, Auth, Awareness und Store-Lifecycle](https://tiptap.dev/docs/hocuspocus/server/hooks)
- [Hocuspocus: Persistence](https://tiptap.dev/docs/hocuspocus/guides/persistence)
- [Hocuspocus: Generic Database Extension](https://tiptap.dev/docs/hocuspocus/server/extensions/database)
- [Hocuspocus: v4 Upgrade und Node.js-Anforderung](https://tiptap.dev/docs/hocuspocus/getting-started/upgrade)
- [Tiptap: Collaboration Caret](https://tiptap.dev/docs/editor/extensions/functionality/collaboration-caret)
- [Tiptap: UniqueID und Verwendung mit Collaboration](https://tiptap.dev/docs/editor/extensions/functionality/uniqueid)
- [Yjs: Shared Types](https://docs.yjs.dev/getting-started/working-with-shared-types)
- [Yjs: Relative Positions](https://docs.yjs.dev/api/relative-positions)
- [Yjs: Document Updates und Idempotenz](https://docs.yjs.dev/api/document-updates)
- [Yjs: Y.Doc und Garbage Collection](https://docs.yjs.dev/api/y.doc)
- [Yjs: CodeMirror-6-Binding](https://github.com/yjs/y-codemirror.next)
- [CodeMirror 6 Reference: Composition, Text und Changes](https://codemirror.net/docs/ref/)
