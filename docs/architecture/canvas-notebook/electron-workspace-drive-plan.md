# Electron Workspace Drive Plan

Stand: 2026-08-28

## Ziel und Produktentscheidung

Canvas Notebook Desktop soll Endnutzer:innen einen lokalen, bidirektional
synchronisierten Ordner fuer einen oder mehrere Canvas Workspaces anbieten.
Ein Workspace erscheint dabei als Ordner unter einem gemeinsamen Canvas Drive:

```txt
~/Canvas Drive/
  Mein Workspace/       -> personal workspace
  Marketing/            -> team workspace
  Website Relaunch/     -> project workspace
```

Der Server bleibt die fachlich autoritative Quelle. Der lokale Ordner ist eine
replizierte Arbeitskopie, die auch offline bearbeitet werden kann. Aenderungen
aus Finder/Explorer und lokalen Programmen werden sicher zum Server synchronisiert;
Serveraenderungen werden in den lokalen Ordner uebernommen.

V1 verwendet bewusst einen normalen Ordner und kein virtuelles Betriebssystem-
Laufwerk. Ein echter Finder-/Explorer-Mount erfordert pro Plattform eigene native
Technik (macOS File Provider, Windows Cloud Files API, Linux FUSE) und ist kein
Electron-Feature. Ein normaler lokaler Ordner liefert den erwarteten Google-Drive-
Nutzen sofort, funktioniert mit allen Anwendungen und ist die stabile Grundlage
fuer einen spaeteren nativen Mount.

## Bestehende Grundlagen und Abgrenzung

Der Workspace-Server besitzt bereits stabile Workspace-IDs, serverseitig
aufgeloeste Roots, Berechtigungen, atomare Dateiwrites, Revisionen, Locks,
Papierkorb und File-Watcher-Hinweise. Diese Regeln bleiben verbindlich,
insbesondere:

- `team-workspace/07-filesystem-migration-and-write-policy.md` fuer
  Workspace-Roots und Zugriffskontrolle;
- `team-workspace/18-collaboration-and-file-conflict-policy.md` fuer
  Revisionen, Locks und aktive Echtzeit-Kollaboration.

Der Desktop-Sync ersetzt weder den Dateibrowser noch Yjs-/Excalidraw-
Collaboration. Er ist ein neuer Transport- und Replikationspfad. Er darf keine
aktiven Collaboration-Dokumente, Locks oder serverseitigen Revision-Guards
umgehen.

## Zielarchitektur

```txt
Canvas-Weboberflaeche                     Electron Main Process
        |                                           |
   enges, versionsiertes IPC                WorkspaceSyncService
        |                                           |
        |        +------------------+---------------+-------------------+
        |        |                  |                                   |
        |  LocalReplicaAdapter  RemoteWorkspaceAdapter              SyncStateStore
        |  (Dateisystem)        (HTTP/Delta/Blob API)               (SQLite)
        |        |                  |                                   |
        v        v                  v                                   v
  Status / Konflikte / Pause   lokaler Ordner                   Cursor, Queue,
                                                               Hashes, Tombstones
```

Der Sync laeuft im Electron-Hauptprozess. Dort sind Dateisystemzugriff,
Netzwerk-Queue, sichere Token-Speicherung, Hintergrundarbeit und kontrollierte
Shutdowns zentral beherrschbar. Der Renderer bekommt ausschliesslich minimale
IPC-Aktionen und Statusdaten; er darf weder beliebige lokale Pfade lesen noch
Sync-Tokens erhalten.

### Austauschbare Bausteine

Die Implementierung wird gegen kleine Interfaces gebaut, nicht direkt gegen
Electron-, Node- oder eine einzelne Server-API-Implementierung:

| Baustein | Aufgabe | Austauschbar fuer |
| --- | --- | --- |
| `WorkspaceSyncService` | Orchestriert Lifecycle, Prioritaeten, Backoff und Status | mehrere Workspaces, Headless-Agent, spaetere Background-Daemons |
| `LocalReplicaAdapter` | Listet, liest, schreibt, beobachtet und validiert lokale Dateien | spaeterer File-Provider/Mount statt normalem Ordner |
| `RemoteWorkspaceAdapter` | Deltas, Manifest, Blob-Transfer und Mutation mit Preconditions | HTTP v1, spaetere WebSocket-/gRPC-Optimierung |
| `SyncStateStore` | Persistiert Cursor, Revisionen, Operationen und Konflikte | SQLite v1, spaetere verschluesselte oder migrierte Stores |
| `ConflictResolver` | Entscheidet Merge, Konfliktkopie, Lock-Blockade oder Nutzerentscheidung | dateityp- und organisationsspezifische Policies |
| `SyncPolicy` | Ignore-Regeln, Groessenlimits, Bandbreite, selektive Ordner, Pausen | Produktplanausbau und Admin-Policies |
| `SyncEventBus` | Stellt Status- und Diagnoseevents fuer IPC bereit | Tray, UI, Telemetrie und spaetere Benachrichtigungen |

Jeder Baustein bekommt Contracts und isolierte Tests. Electron ist nur die
Composition Root; die Sync-Domaenenlogik bleibt in einer frameworkneutralen
TypeScript-Schicht.

## Datenmodell und Synchronisationsprotokoll

### Stabile Identitaeten

- Eine lokale Verbindung referenziert immer `workspaceId`, nie einen
  Anzeigenamen oder absoluten Serverpfad.
- Eine lokale Replik hat eine zufaellige `replicaId`; jede Installation eines
  Clients besitzt eine eigene ID.
- Dateien verwenden serverseitige, unveraenderliche Datei-IDs und eine
  `revisionId` beziehungsweise einen ETag. Pfade allein sind bei Rename/Move
  keine ausreichende Identitaet.
- Der Sync-State liegt ausserhalb des replizierten Ordners. Eine geloeschte
  lokale Ordner-Metadatei darf den Client nicht zu einer neuen oder fremden
  Workspace-Zuordnung verleiten.

### Erforderliche Remote-Contracts

Der Server braucht einen expliziten Delta-Feed; der bestehende File-Watcher ist
nur ein UI-Hinweis und kein vollstaendiges Sync-Protokoll.

```txt
GET  /api/workspaces/{workspaceId}/sync/manifest
GET  /api/workspaces/{workspaceId}/sync/delta?cursor={cursor}
GET  /api/workspaces/{workspaceId}/sync/blobs/{fileId}        (Range-faehig)
PUT  /api/workspaces/{workspaceId}/sync/files/{fileId}        (If-Match revision)
POST /api/workspaces/{workspaceId}/sync/mutations             (create/move/delete)
```

Jede Delta-Antwort enthaelt einen monotonen Cursor und alle relevanten Events:
create, change, move, delete/tombstone, restore, Lock- und Collaboration-
Zustaende. Uploads und Mutationen tragen die erwartete Basisrevision. Der Server
antwortet bei Abweichung mit einem strukturierten Konflikt statt still zu
ueberschreiben.

### Lokaler State

SQLite speichert mindestens:

- Workspace-Verbindung, `replicaId`, lokalen Root und letzten Remote-Cursor;
- Datei-ID, relativen Pfad, lokale und Remote-Revision, Content-Hash, mtime und
  Groesse;
- persistente Upload-/Download-Queue mit Retry- und Backoff-Information;
- Tombstones und bereits verarbeitete Events;
- Konflikte, Nutzerentscheidung und Diagnosedaten ohne Dateiinhalte;
- eine Transaktions-/Operation-ID zur Erkennung eigener lokaler Writes.

Dateiuebertragungen sind resumierbar, hash-verifiziert und atomar: Download in
eine Staging-Datei, `fsync`, Rename; Upload aus einem stabilen Snapshot. Teil-
Dateien duerfen weder im Server noch im sichtbaren lokalen Ordner erscheinen.

## Ordnerschutz und Loeschverhalten

Der Workspace-Root darf in Canvas selbst nie als normale loeschbare Datei oder
als loeschbarer Ordner behandelt werden. Es gibt keine „Delete workspace root“-
Operation im Dateibrowser oder Sync-Protokoll.

Ein Betriebssystem kann einen Ordner im Besitz des Endnutzers dennoch jederzeit
im Finder/Explorer entfernen oder verschieben. Das sollte nicht mit restriktiven
Dateirechten bekämpft werden, weil das normale lokale Arbeiten und Uninstall-
Verhalten verschlechtert. Stattdessen gelten diese zwingenden Regeln:

1. Ein fehlender, verschobener oder nicht erreichbarer lokaler Root pausiert
   ausschliesslich diese lokale Replik. Er loescht niemals etwas auf dem Server.
2. Die UI zeigt „Lokaler Canvas Drive nicht gefunden“ mit den Aktionen
   *Ordner erneut verbinden*, *neuen leeren Ordner erstellen* und
   *Replik trennen*. Kein automatisches Neu-Anlegen ohne Nutzerentscheidung.
3. *Replik trennen* entfernt nur die lokale Zuordnung und den Sync-State; die
   Serverdaten bleiben erhalten. *Lokale Kopie entfernen* ist eine separate,
   deutlich bestaetigte Aktion.
4. Eine serverseitige Workspace-Archivierung oder -Loeschung bleibt ein
   administrativer Lifecycle mit Berechtigung, Audit, Retention und Restore —
   niemals eine Folge einer lokalen Ordneraktion.
5. Das Loeschen eines Unterordners wird als potenziell umfangreiche Mutation
   behandelt. Ueberschreitet sie einen konfigurierten Schwellenwert, pausiert
   der Upload und verlangt eine explizite Bestaetigung. Serverseitig landet die
   Aktion zuerst im Workspace-Papierkorb.

## Konflikt-, Collaboration- und Dateitypregeln

| Fall | Verhalten in V1 |
| --- | --- |
| Nur lokal geaendert | Upload mit erwarteter Basisrevision |
| Nur remote geaendert | atomarer Download in die lokale Replik |
| Beide Seiten Text geaendert | dreiseitiger Merge, falls eindeutig; sonst Konfliktkopie und UI-Entscheidung |
| Beide Seiten Binaerdatei geaendert | keine automatische Zusammenfuehrung; Konfliktkopie |
| Server-Lock aktiv | lokaler Upload bleibt wartend und ist sichtbar blockiert |
| Aktives Yjs-/Excalidraw-Dokument | Server policy entscheidet Checkpoint/Lock; kein blindes Whole-File-Ueberschreiben |
| Lokale Datei waehrend Upload erneut geaendert | Upload-Snapshot fertigstellen, neue Aenderung erneut einreihen |
| Offline | Queue persistieren; keine stillen Datenverluste |

Konfliktkopien erhalten einen deterministischen, plattformgueltigen Namen wie
`Bericht (Konflikt von MacBook, 2026-08-28).md`. Der Originalinhalt wird nie
automatisch verworfen. Bei nicht mergefaehigen Dateien ist Lock/Check-out der
bevorzugte Schutzmechanismus.

## Zentrale Edge Cases

- Netzwerkwechsel, Schlafmodus, Token-Ablauf, Server-Restart, Cursor-Reset und
  teilweise fehlgeschlagene Batch-Operationen.
- Finder/Explorer-Operationen, atomisches Speichern durch Office/IDE, temporäre
  Dateien, schnell aufeinanderfolgende Rename-Ketten und doppelte Watcher-
  Events.
- macOS Unicode-Normalisierung und case-insensitive Volumes, Windows-reservierte
  Namen und Pfadlängen, Linux-Dateirechte sowie Zeitstempel mit geringer
  Aufloesung. Entscheidungen duerfen nie nur auf mtime beruhen.
- Symlinks, Junctions, Hardlink-artige Umgehungen, `..` und Pfade ausserhalb
  des Roots. V1 synchronisiert keine Links und folgt keinen Links.
- `.git`, `node_modules`, Build-Ausgaben, Cache, `.DS_Store`, Office-Tempfiles
  und Canvas-interne Metadaten. V1 startet mit sicheren Standard-Ignores plus
  einer versionierten, servervalidierten `.canvasignore`-Policy.
- Speicherplatzmangel, riesige Dateien, Quotas, Bandbreitenlimits,
  Drosselung, selektive Ordner-Synchronisierung und Cache-Eviction.
- Berechtigungsentzug, archivierte Workspaces, Wechsel von Personal zu Team,
  Offline-Queue nach fehlender Berechtigung und keine Offenlegung fremder
  Personal-Workspaces.
- Restore aus Papierkorb, Rename/Move waehrend eines Downloads, Duplikate durch
  mehrere Clients und ein Client mit einer alten Sync-Protokollversion.
- Ransomware-/Massenverschluesselungs-Szenarien: auffaellige Massenumbenennungen
  oder Hash-Aenderungen pausieren, alarmieren und bleiben ueber Revisionen/
  Papierkorb wiederherstellbar.

## Sicherheit und Betrieb

- Auth-Tokens liegen nur verschluesselt im OS-Keychain beziehungsweise über
  Electron `safeStorage`; niemals im Renderer, im Workspace-Ordner oder in
  Logs.
- Alle Requests pruefen aktuelle Mitgliedschaft und Workspace-Permission; ein
  Cursor oder eine Datei-ID ist keine Berechtigung.
- Der lokale Root wird beim Einrichten nach `realpath` validiert. Ein Adapter
  darf ausserhalb dieses Roots niemals lesen oder schreiben.
- Sync-Status, Konflikte, fehlgeschlagene Rechtepruefungen und Queue-Backlog
  werden datensparsam telemetriert; Dateiinhalte und Pfade nur, soweit sie fuer
  lokale Diagnose erforderlich sind.
- Kontrollierter App-Shutdown flusht SQLite und die Queue-Metadaten, beendet
  aber keine aktiven atomaren Dateioperationen unkontrolliert.

## UX

Im Desktop-Client gibt es eine Workspace-Drive-Seite oder einen Bereich in den
Workspace-Einstellungen:

- „Lokal verfuegbar machen“ mit Ordnerwahl und initialer Groessenprognose;
- auswählbare Workspaces sowie optional selektive Unterordner;
- sichtbarer Status pro Workspace: aktuell, synchronisiert, offline, pausiert,
  Konflikt, Fehler, wartet auf Lock;
- „Im Finder/Explorer anzeigen“, pausieren, wiederaufnehmen und sicher trennen;
- Konfliktansicht mit beiden Versionen, Diff fuer Text und klaren Optionen;
- keine versteckten Massenloeschungen, keine stillen Konfliktauflösungen.

Der serverseitige Dateibrowser bleibt weiter sichtbar. Nach einer lokalen
Mutation wird der Status sofort im Electron-UI angezeigt; nach Server-Ack und
Watcher-/Delta-Verarbeitung aktualisiert sich die Weboberflaeche wie jede andere
externe Workspace-Aenderung.

## Phasen und Aufwand

| Phase | Inhalt | Schaetzung, eine erfahrene Person |
| --- | --- | --- |
| 0. Spike und Contracts | Delta-Protokoll, Dateityp-Policy, lokaler State, Prototyp mit einem Workspace | 1–2 Wochen |
| 1. Read-only Replica | Einrichten, Initial-Download, Status, sicheren Root-Schutz, Resume | 2–3 Wochen |
| 2. Bidirektionaler Kern | Watcher, Queue, Upload/Download, Preconditions, Retry, Offline | 3–5 Wochen |
| 3. Konflikte und Collaboration | Locks, Tombstones, Textkonflikte, Konflikt-UX, Massenmutation-Schutz | 3–4 Wochen |
| 4. Produktreife | Team-/Projekt-Workspaces, Limits, selektive Syncs, Telemetrie, Migration | 2–4 Wochen |
| 5. Hardening | Zwei-Client-/Offline-/Sleep-/Plattform-E2E, Last- und Security-Tests | 2–4 Wochen |

Ein brauchbares, bewusst begrenztes MVP fuer einen einzelnen Personal Workspace
liegt damit bei etwa **5–8 Engineering-Wochen**. Eine produktionsreife
bidirektionale Drive-Funktion fuer Personal-, Team- und Projekt-Workspaces
realistisch bei **13–20 Engineering-Wochen**, ohne nativen virtuellen Mount.
Ein echter Mount ist ein separates Folgeprojekt und fügt je Plattform grob
**6–12 Wochen** plus dauerhafte native Wartung hinzu.

## Verbindliche Test-Gates

Vor produktivem Rollout muessen mindestens folgende Nachweise automatisiert
werden:

- Unit-Tests fuer State-Machine, Cursor, Retry, Ignore-Regeln und
  Konfliktauflösung;
- Contract-Tests fuer Server-Delta, Precondition, Tombstone und Rechteentzug;
- Electron-Integrationstests mit temporaeren lokalen Roots und einem Mock-
  Remote-Adapter;
- End-to-End-Test mit zwei Desktop-Clients, offline Aenderungen, parallelem
  Rename und Konfliktkopie;
- manuelle macOS- und Windows-Pruefung fuer Finder/Explorer, Sleep/Wake und
  Rechteverhalten;
- Security-Tests fuer Traversal, Symlinks, Token-Leaks, Workspace-Isolation und
  Massenloesch-Schutz;
- Restore-Test: lokaler Root geloescht, Serverdaten unveraendert, Reconnect in
  einen neuen Ordner erfolgreich.

## Nicht in V1

- nativer virtueller Finder-/Explorer-Mount;
- serverseitiges Ausfuehren lokaler Dateien;
- automatische Konfliktueberschreibung von Binaerdateien;
- Synchronisierung beliebiger Pfade ausserhalb eines explizit verbundenen
  Workspace-Roots;
- vollstaendige On-Demand-Platzhalterdateien wie bei iCloud/OneDrive.

## Offene Produktentscheidungen vor Phase 0

1. Soll V1 nur Personal Workspaces oder direkt Team-/Projekt-Workspaces
   abdecken?
2. Welche Dateigroesse und welche Gesamtquote sind fuer V1 akzeptabel?
3. Sind lokale Daten standardmaessig vollstaendig gespiegelt oder zunaechst nur
   bewusst ausgewaehlte Unterordner?
4. Soll bei Konflikten immer eine Kopie entstehen, oder duerfen Markdown-Dateien
   nach sichtbar gemachtem dreiseitigem Merge automatisch zusammengefuehrt
   werden?
5. Welche Admin- und Audit-Anforderungen gelten fuer Team-Workspaces und
   Massenmutationen?
