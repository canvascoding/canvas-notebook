# Collaboration und File Conflict Policy

Stand: 2026-06-18

## Zweck

Dieses Dokument konkretisiert, wie Canvas Notebook Team-Dateien bearbeitet, wenn mehrere User oder Agenten gleichzeitig arbeiten. Es trennt echte kollaborative Textbearbeitung von Dateiarten, die in V1 nur ueber Locks, Revisionen und Konfliktaufloesung sicher funktionieren.

Es ergaenzt die Aufgaben `34`, `43` und `44` im Aufgabenindex.

## Grundentscheidung

Team Workspace bedeutet nicht, dass jede Dateiart live kollaborativ bearbeitet werden kann.

V1-Ziel:

- Markdown und reine Textdateien (`.md`, `.markdown`, `.txt`) bekommen eine echte kollaborative Grundlage auf CRDT-Basis, bevorzugt Yjs.
- QMD-, JSON-, YAML- und Code-Dateien bleiben in V1 revision- und konfliktgeschuetzt, aber nicht live kollaborativ.
- Office-Dateien, PDFs, Bilder, Videos, Audio und andere binaere Assets bekommen Lock-/Check-out-, Revision- und Konfliktlogik.
- Agenten duerfen keine aktive menschliche Bearbeitung ueberschreiben.
- Alle Speicherpfade bleiben workspace-aware und auditierbar.

## Dateiarten

| Dateiart | V1-Strategie | Begruendung |
|---|---|---|
| Markdown/Text | CRDT/Yjs-basierte Live-Collaboration vorbereiten oder direkt nutzen | Autosave und haeufige kleine Edits kollidieren sonst schnell. |
| QMD/JSON/YAML | Revision Check plus Konfliktanzeige | Seltener fuer nicht-technische Team-Workflows; V1 bleibt konservativ. |
| Code-Dateien | optional CRDT/Yjs oder Revision Check plus Konfliktanzeige | Haengt vom Editor ab; sicherer Default ist Revision Check. |
| Word/Excel/PowerPoint | exklusiver Lock/Check-out plus Revision | Serverseitiges Live-Merge ist nicht verlaesslich ohne spezialisierten Editor. |
| PDF | Lock/Revision, keine Live-Collaboration | PDF wird meist generiert oder annotiert, nicht sauber gemerged. |
| Bilder/Videos/Audio | Lock/Revision, keine Live-Collaboration | Binaere Assets koennen nicht sinnvoll automatisch gemerged werden. |
| Studio Outputs | Copy-to-Workspace erzeugt neue Datei/Revision | Studio Asset Store bleibt Quelle, Workspace-Datei ist Zielkopie. |

## Markdown und Autosave

Markdown-Dateien sind der kritischste Fall, weil Editor-Autosave und `dirty`-States sehr haeufig schreiben.

Regeln:

- Ein klassischer "ganze Datei speichern"-Autosave ist fuer gemeinsam geoeffnete Team-Dateien riskant.
- Wenn eine Markdown-Datei im Team Workspace von mehreren Usern geoeffnet ist, soll die Bearbeitung ueber kollaborativen Dokumentzustand laufen.
- CRDT-Updates werden als kleine Operationen gespeichert und nicht als konkurrierende Komplettdatei-Overwrites.
- In regelmaessigen Intervallen oder bei ruhigem Zustand wird ein Snapshot als neue Dateirevision geschrieben.
- Der lokale `dirty`-State zeigt nur ungesyncte lokale Aenderungen, nicht Besitz an der Datei.
- Wenn CRDT fuer eine Datei nicht aktiv ist, muss ein Revision Check vor jedem Save laufen.

Empfohlene technische Grundlage:

- Yjs als CRDT-Bibliothek fuer Textdokumente.
- WebSocket-Verbindung ueber die Canvas Notebook App.
- Postgres fuer persistente Collaboration-Events, Snapshots oder Checkpoints.
- Kein Redis als V1-Pflicht. Redis/NATS kann spaeter fuer Multi-Node oder hohe Eventlast kommen.

## Locks und Check-out

Fuer nicht live kollaborative Dateiarten gilt:

- Beim Oeffnen zur Bearbeitung kann ein Lock gesetzt werden.
- Der Lock speichert `workspaceId`, `filePath`, `fileRevision`, `lockedByUserId`, `lockedBySessionId`, `lockType`, `expiresAt`.
- Andere User sehen, wer gerade bearbeitet.
- Schreibversuche ohne gueltigen Lock werden blockiert oder erzeugen eine neue Konfliktkopie, je nach Dateiart.
- Owner/Admins koennen stale Locks mit Warnung und Audit aufheben.
- Locks laufen ab, wenn Browser/Session abstuerzt, duerfen aber nicht zu kurz sein.

Word/Excel/PowerPoint:

- V1 behandelt diese Dateien als exklusive Bearbeitung.
- Upload/Overwrite einer neu gespeicherten Version erzeugt eine neue Revision.
- Wenn zwischen Download und Upload eine andere Revision entstanden ist, wird der Upload als Konflikt gemeldet.

## Agenten und aktive Bearbeitung

Agenten sind eigene Actors, duerfen aber keine User-Arbeit verlieren lassen.

Regeln:

- Agent-Dateioperationen pruefen aktuelle Revision und aktive Locks.
- Bei lockpflichtigen Dateien blockiert der Agent Write, wenn ein anderer User aktiv bearbeitet.
- Bei CRDT-faehigen Textdateien darf der Agent nur ueber einen serverseitig kontrollierten Patch-/Operation-Flow schreiben, nicht durch blindes Overwrite.
- Wenn die Datei aktiv von Menschen bearbeitet wird, soll der Agent Aenderungen vorschlagen oder als Review-Patch bereitstellen, sofern kein sicherer Merge moeglich ist.
- Der Review-Patch-Flow ist ein eigenes Editor-Feature: Patch-Vorschlag, Diff-Anzeige, Annahme/Ablehnung und anschliessende serverseitige Anwendung auf die aktuelle Revision.
- Bis dieser Review-Patch-Flow existiert, darf der Agent bei aktiv geoeffneten CRDT-Dateien keine stillen Direktwrites ausfuehren.
- Jede Agent-Aenderung speichert `userId`, `sessionId`, `agentId`, `workspaceId`, `previousRevision` und `nextRevision`.

## Revisionen und Konflikte

Jede schreibende Operation muss auf einer bekannten Ausgangsrevision basieren.

Pflicht:

- `baseRevisionId` bei Save/Overwrite.
- Server vergleicht `baseRevisionId` mit aktueller Revision.
- Bei Abweichung: kein stilles Ueberschreiben.
- Konfliktantwort enthaelt aktuelle Revision, eigene Basisrevision und moegliche Aktionen.

Konfliktaktionen:

- eigene Version als Konfliktkopie speichern,
- aktuelle Datei neu laden und lokale Aenderungen erneut anwenden,
- bei Textdateien Merge/Patch versuchen,
- bei Admin/Owner mit Warnung force-overwrite erlauben, wenn bewusst auditierbar.

## Presence und UI

Die UI muss Kollaboration sichtbar machen.

Anforderungen:

- File Tree zeigt, wenn eine Datei aktiv bearbeitet oder gelockt ist.
- Editor Header zeigt aktive User, Lock-Status, Workspace und Revision.
- Chat/Agent Header zeigt, wenn der Agent in einer Datei mit aktivem Lock nicht schreiben darf.
- Bei Workspace-Wechsel werden lokale Editor-States nicht still in den neuen Workspace uebernommen.
- Konfliktmodals muessen klar sagen, dass eine neuere Version existiert.

## Datenmodell

Mindesttabellen:

```txt
file_revisions
- id
- organizationId
- workspaceId
- path
- contentHash
- createdByUserId
- createdByActorType: user | agent | automation
- baseRevisionId?
- createdAt
```

```txt
file_locks
- id
- organizationId
- workspaceId
- path
- revisionId
- lockedByUserId
- lockedBySessionId?
- lockType: edit | upload | agent_write
- status: active | released | expired | force_released
- expiresAt
- createdAt
- updatedAt
```

Optional fuer CRDT:

```txt
collaboration_documents
- id
- organizationId
- workspaceId
- path
- provider: yjs
- stateVersion
- snapshotRevisionId?
- updatedAt
```

```txt
collaboration_events
- id
- documentId
- actorUserId
- actorSessionId
- sequence
- payloadRef
- createdAt
```

## Tests

Pflichttests:

- Zwei Saves mit derselben `baseRevisionId` erzeugen keinen stillen Overwrite.
- Markdown-Autosave nutzt Revision/CRDT-Schutz und ueberschreibt keine neuere Team-Version.
- Lockpflichtige Datei blockiert parallelen Write.
- Stale Lock kann nur Owner/Admin mit Audit aufheben.
- Agent Write wird bei aktivem fremdem Lock blockiert.
- Agent Write fuer Textdatei braucht Patch-/Operation-Flow oder aktuelle Revision.
- Office-Datei-Upload mit veralteter Basisrevision erzeugt Konflikt.
- File Tree zeigt Lock-/Presence-Status.
- Workspace-Wechsel uebernimmt keine lokalen `dirty` Edits in anderen Workspace.
