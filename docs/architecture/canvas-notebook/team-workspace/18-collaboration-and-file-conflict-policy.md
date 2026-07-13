# Collaboration und File Conflict Policy

Stand: 2026-07-13

## Zweck

Dieses Dokument ist der verbindliche Detailplan fuer echte Zusammenarbeit an Team-Dokumenten in Canvas Notebook. Es trennt:

- bereits vorhandene Revision-, Lock- und Konfliktschutz-Grundlagen,
- noch zu implementierende Yjs-basierte Real-Time Collaboration fuer Markdown und Text,
- Workspace-weite Presence im File Tree vor dem Oeffnen einer Datei,
- sichere Agent-, Automation- und externe Dateiaenderungen,
- Lock-/Check-out-Verhalten fuer nicht merge-faehige Dateiarten.

Es konkretisiert die Aufgaben `34`, `43` und `44` und ist die Grundlage fuer Aufgabe `48` im Aufgabenindex.

## Verbindliche Statusabgrenzung

Der bisherige Implementierungsstand ist eine Collaboration Foundation, aber noch keine echte Real-Time Collaboration.

Bereits vorhanden:

- workspace-aware File Reads und Writes,
- Datei-Revisionen und `baseRevisionId`-Pruefungen,
- SHA-basierte Konflikterkennung,
- Lock-Metadaten und Lock-API fuer lockpflichtige Dateien,
- `collaboration_documents`-Metadaten mit `provider=yjs`,
- File-Watcher-/SSE-Hinweise auf externe Dateiaenderungen,
- Collaboration-/Revision-Hinweise im Editor Header,
- Agent-Pruefungen gegen Revisionen und aktive Locks.

Noch nicht vorhanden und Teil der spaeteren Aufgabe `48`:

- ein echter `Y.Doc` als gemeinsamer Dokumentzustand,
- Tiptap-/CodeMirror-Bindings an Yjs,
- ein Collaboration-WebSocket-Backend,
- persistierter binaerer Yjs-State in Postgres,
- Awareness, Live-Cursor und Selections,
- aktive Nutzer im File Tree vor dem Oeffnen der Datei,
- CRDT-basierte Agent-Aenderungen oder Review-Patches,
- robuste Checkpoint-Synchronisation zwischen Yjs-State und Workspace-Datei.

Todo `44` gilt deshalb nur fuer die abgeschlossene Foundation aus Revisionen, Locks, Metadaten und Guards. Echte Live-Collaboration bleibt eine eigene geplante Aufgabe.

## Produktentscheidung

Team Workspace bedeutet nicht, dass jede Dateiart live kollaborativ bearbeitet werden kann.

V1-Ziel:

- Markdown und reine Textdateien (`.md`, `.markdown`, `.txt`) erhalten echte Yjs-basierte Real-Time Collaboration, soweit die Datei innerhalb der definierten Format- und Groessenlimits liegt.
- Nutzer sehen bereits im File Tree oder File Explorer, welche Teammitglieder eine Datei gerade ansehen oder aktiv bearbeiten, ohne selbst den Dokument-Room zu oeffnen.
- QMD-, MDX-, JSON-, YAML- und Code-Dateien bleiben in V1 revision- und konfliktgeschuetzt, aber nicht live kollaborativ.
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
- laufende Agent-Aktivitaet mit `Agent im Auftrag von <User>`, Zielabschnitt und Status `preparing | applying`; eine getrennte Review-Karte zeigt anschliessend gegebenenfalls `needs_review`,
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
- Wenn Zielanker fehlen, der Zielabschnitt geloescht wurde oder seit Agent-Start semantisch ueberlappend geaendert wurde, wechselt der Run auf `needs_review`; der Agent darf den aktuellen Inhalt nicht erraten oder per Whole-File-Merge ersetzen.
- Bis Direct-Connection und Review-Patch existieren, werden Agent Writes an aktiv geoeffneten CRDT-Dateien blockiert.
- Jede angewendete Agent-Aenderung speichert `initiatedByUserId`, `sessionId`, `agentId`, `agentRunId`, `workspaceId`, Dokument-ID, Zielanker, vorherigen/nachfolgenden State Vector und Checkpoint-Revision.
- Agent-Transaktionen werden nicht in die lokalen Undo-Stacks anderer User aufgenommen. Der Auftraggeber erhaelt eine eigene Aktion `Agent-Aenderung rueckgaengig machen`, die erneut serverseitig gegen den aktuellen State prueft und bei Ueberlappung einen Review-Diff oeffnet.

Dieselben Regeln gelten fuer Automations und serverseitige Integrationen. Sie erhalten eigene Actor-/Origin-Metadaten.

### Kritischer Co-Authoring-Flow: User A, User B und Agent B

Verbindliches Szenario:

1. User A und User B arbeiten im selben Yjs-Dokument.
2. User A tippt manuell an einer Stelle. User B markiert einen bestimmten Absatz oder referenziert ihn eindeutig und beauftragt seinen Agenten mit einer Ueberarbeitung.
3. Der Server erfasst fuer den Agent-Run den aktuellen State Vector, stabile Zielanker und einen Hash des gelesenen Zielinhalts. Reine Zeilen-/Zeichenoffsets aus einem Markdown-Snapshot sind nicht zulaessig.
4. Fuer strukturiertes Markdown verwenden Zielanker persistente Tiptap-Node-IDs und/oder Yjs Relative Positions. Fuer `Y.Text` werden Yjs Relative Positions fuer Start und Ende verwendet.
5. Solange der Agent arbeitet, sehen A und B `KI-Agent im Auftrag von User B` am Dokument und am betroffenen Abschnitt. Diese Anzeige stammt aus serverseitiger Agent-Presence, nicht aus frei gesetzter Client-Awareness.
6. Direkt vor Apply prueft der Server erneut Membership, Write Permission, Agent-Run, Dokument-ID, Representation, aktuellen State Vector, Zielanker und Zielinhalt.
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
targetAnchors[]
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
- provider: yjs
- documentKind: tiptap_markdown | raw_text
- schemaVersion
- stateBinary: BYTEA
- stateVectorBinary?: BYTEA
- stateVersion
- snapshotRevisionId?
- lastCheckpointAt?
- status: active | archived | conflicted
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
- transactionOrigin
- sequence
- baseStateVectorHash?
- resultingStateVectorHash?
- targetAnchorHash?
- payloadRef?
- payloadHash?
- expiresAt?
- createdAt
```

Presence bleibt fluechtig und ist keine Pflicht-Datenbanktabelle.

Fuer laenger laufende oder reviewpflichtige Agent-Aenderungen wird zusaetzlich eine kleine `collaboration_agent_operations`-Entitaet geplant. Sie speichert Status, duale Attribution, Dokument, Target-/State-Hashes und Checkpoint-Referenz; vorgeschlagener Text beziehungsweise Raw-Operations liegen nur kurzlebig ueber `payloadRef` vor und folgen der Content-Retention.

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
collaboration_agent_needs_review
collaboration_agent_finished
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
- Tiptap-Node-IDs/Yjs Relative Positions, Base-Target-Hash und Overlap-/Rebase-Pruefung implementieren.
- duale Attribution `Agent im Auftrag von User`, Agent-Presence und serverseitig gestempelten Transaction Origin umsetzen.
- Review-Patch mit Diff, Accept/Reject und aktuellem State Vector fuer mehrdeutige oder autonome Aenderungen bauen.
- separates Rueckgaengigmachen von Agent-Aenderungen und Ausschluss aus fremden lokalen Undo-Stacks umsetzen.
- Agent-Origin, Auftraggeber, Zielanker, State-Vectors und Checkpoint-Revision auditieren.

Abnahme:

- Agent kann aktive menschliche Edits nicht ueberschreiben.
- User A kann manuell tippen, waehrend ein von User B beauftragter Agent einen anderen Absatz als Yjs-Transaktion aendert; beide Clients konvergieren und zeigen die korrekte duale Attribution.
- gleichzeitige inkompatible Aenderungen desselben Zielabschnitts wechseln fuer User B auf `needs_review`, ohne Aenderungen von User A zu verlieren.
- direkt angewendete und angenommene Agent-Patches erscheinen live bei allen Clients.
- abgelehnte Patches aendern weder Yjs-State noch Workspace-Datei.

### Phase 8: Hardening und Rollout

- Offline/Reconnect, Backpressure, grosse Dokumente und Schema-Mismatch testen.
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
- parallele inkompatible Aenderung desselben Absatzes erzeugt `needs_review` statt Direkt-Apply,
- autonome Agent-Runs erhalten bei aktiven Menschen einen Review-Patch statt silent write,
- fremde lokale Undo-Stacks nehmen die Agent-Transaktion nicht auf; die dedizierte Revert-Aktion prueft den aktuellen State,
- Shell-, File-Tool-, Automation- und Integrationspfade koennen den Collaboration-Agent-Service nicht per Whole-File-Write umgehen,
- externe Datei-Aenderung bei aktivem Room erzeugt Konfliktstatus,
- Force-Overwrite braucht Admin, Audit und trennt Clients kontrolliert.

### Datei-Lifecycle und Backups

- Rename/Move behaelt Dokument-ID und Presence,
- Copy erzeugt unabhaengigen State,
- Delete flusht und archiviert,
- Restore reaktiviert den konsistenten Zustand,
- Full Backup enthaelt Postgres-Yjs-State und materialisierte Dateien,
- Restore startet ohne doppelte Initialisierung oder verlorene History.

UI- und End-to-End-Pruefungen werden gemaess Repository-Regeln erst nach expliziter Freigabe mit Playwright oder Chrome DevTools ausgefuehrt.

## Nicht-Ziele fuer V1

- Live-Merge fuer Office, PDF, Bilder, Video oder Audio.
- Live-Collaboration fuer MDX, QMD, JSON, YAML oder Code.
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
- [Yjs: CodeMirror-6-Binding](https://github.com/yjs/y-codemirror.next)
