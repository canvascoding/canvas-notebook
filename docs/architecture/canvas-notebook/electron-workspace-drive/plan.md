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

## Verbindlicher V1-Scope

V1 ist bewusst kleiner als die langfristige Zielarchitektur. Sie umfasst:

- genau einen gleichzeitig verbundenen Personal Workspace pro Desktop-Installation;
- vollstaendige lokale Spiegelung in einen explizit ausgewaehlten, leeren Ordner;
- initialen Download und bidirektionale create-, change-, rename-, move- und
  delete-Synchronisierung, die nach dem Verbinden automatisch laeuft;
- persistente Offline-Queue, Resume, atomare Transfers und sichtbaren Status;
- Konfliktkopien fuer Text- und Binaerdateien, aber keinen automatischen
  dreiseitigen Merge;
- serverseitigen Papierkorb, Massenmutationsschutz und die verbindliche Regel,
  dass ein fehlender lokaler Root niemals Serverdaten loescht;
- einen normalen lokalen Ordner, keine Platzhalterdateien und keinen nativen
  Mount.

Team-/Projekt-Workspaces, selektive Synchronisierung, automatische Text-Merges,
Yjs-/Excalidraw-Integration und native File-Provider sind Ausbaustufen. Die
abstrakten Interfaces duerfen diese Erweiterungen nicht verhindern, V1 muss sie
aber weder vortaeuschen noch bereits teilweise implementieren.

## Bestehende Grundlagen und Abgrenzung

Der Workspace-Server besitzt bereits stabile Workspace-IDs, serverseitig
aufgeloeste Roots, Berechtigungen, atomare Dateiwrites, Revisionen, Locks,
Papierkorb und File-Watcher-Hinweise. Diese Regeln bleiben verbindlich,
insbesondere:

- `../team-workspace/07-filesystem-migration-and-write-policy.md` fuer
  Workspace-Roots und Zugriffskontrolle;
- `../team-workspace/18-collaboration-and-file-conflict-policy.md` fuer
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

                                   Canvas Server
                                         |
                         WorkspaceSyncOrchestrator (Domain Policy)
                                         |
                 +-----------------------+-----------------------+
                 |                       |                       |
          WorkspaceFileService     SyncMutationJournal    TransferService
          Revision/Lock/Trash      Cursor/Outbox/Deltas    Chunk/Range/Hash
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

Auf dem Server gilt dieselbe Trennung: Der `WorkspaceSyncOrchestrator` besitzt
fachliche Entscheidungen wie Auth, Permission, Revision, Lock, Trash und
Konfliktklassifikation. Wiederverwendbare Mechanik wie Chunk-Transfer, Hashing,
Range-Downloads und atomare Dateiersetzung liegt in kleinen Services. Der Sync
darf nicht als zweiter File-Stack neben den bestehenden Workspace-Datei- und
Upload-Services entstehen.

## Datenmodell und Synchronisationsprotokoll

### Stabile Identitaeten

- Eine lokale Verbindung referenziert immer `workspaceId`, nie einen
  Anzeigenamen oder absoluten Serverpfad.
- Eine lokale Replik hat eine zufaellige `replicaId`; jede Installation eines
  Clients besitzt eine eigene ID.
- Die Replik ist dauerhaft an `serverOrigin`, `accountId`, `workspaceId` und
  `replicaId` gebunden. Ein Server- oder Accountwechsel kann keine bestehende
  Zuordnung still uebernehmen.
- Dateien und Verzeichnisse verwenden serverseitige, unveraenderliche Entry-IDs
  und eine `revisionId` beziehungsweise einen ETag. Pfade allein sind bei
  Rename/Move keine ausreichende Identitaet.
- Der Sync-State liegt ausserhalb des replizierten Ordners. Eine geloeschte
  lokale Ordner-Metadatei darf den Client nicht zu einer neuen oder fremden
  Workspace-Zuordnung verleiten.

### Erforderliche Remote-Contracts

Der Server braucht einen expliziten Delta-Feed; der bestehende File-Watcher ist
nur ein fluechtiger UI-Hinweis und kein vollstaendiges Sync-Protokoll.

```txt
POST /api/workspaces/{workspaceId}/sync/snapshots
GET  /api/workspaces/{workspaceId}/sync/manifest?snapshot={id}&pageToken={token}
GET  /api/workspaces/{workspaceId}/sync/delta?cursor={cursor}
GET  /api/workspaces/{workspaceId}/sync/blobs/{fileId}?revision={revisionId}
POST /api/workspaces/{workspaceId}/sync/mutations             (create/move/delete)

POST /api/files/uploads                                       (Session anlegen)
PUT  /api/files/uploads/{sessionId}                            (Chunk schreiben)
POST /api/files/uploads/{sessionId}/complete                   (atomar abschliessen)
```

Jede Delta-Antwort enthaelt einen monotonen Cursor und alle relevanten Events:
create, change, move, delete/tombstone, restore, Lock- und Collaboration-
Zustaende. Uploads und Mutationen tragen die erwartete Basisrevision. Der Server
antwortet bei Abweichung mit einem strukturierten Konflikt statt still zu
ueberschreiben.

Der vorhandene resumierbare Workspace-Upload wird fuer Datei-Uploads erweitert
und wiederverwendet. Die Sync-Completion erhaelt `replicaId`, `operationId`,
erwartete Basisrevision und Content-Hash. Ein zweites paralleles Uploadprotokoll
ist nicht vorgesehen.

### Durables serverseitiges Mutation-Journal

Jede fachlich sichtbare Serveraenderung muss in einem persistenten, Workspace-
geordneten Mutation-Journal landen. Das gilt unabhaengig vom Ausloeser:

- File-API und serverseitiger Dateibrowser;
- Terminal- und Shell-Schreibvorgaenge;
- Agenten, Automationen und Studio-Outputs;
- Collaboration-Checkpoints und Excalidraw-Snapshots;
- Restore, Migration und direkte externe Dateisystemaenderungen.

Der normale Workspace-File-Service schreibt Dateizustand, Revision, Audit und
Outbox-Eintrag als eine nachvollziehbare Operation. Weil Dateisystem und
Datenbank keine gemeinsame ACID-Transaktion besitzen, verwendet der Server eine
persistente Operations-State-Machine (`prepared`, `file_applied`,
`journal_committed`, `failed`) und repariert unvollstaendige Operationen nach
einem Neustart.

Direkte Dateisystemaenderungen, insbesondere aus einer Terminal-Shell, koennen
nicht ausschliesslich ueber File-Services erzwungen werden. Ein serverseitiger
Reconcile-Scanner vergleicht deshalb regelmaessig Entry-IDs, Pfade, Groessen und
Hashes mit dem letzten bekannten Zustand und materialisiert fehlende Journal-
Events. `fs.watch` darf diesen Scan beschleunigen, ist aber niemals die einzige
Quelle. Journal-Events enthalten mindestens Cursor, Entry-ID, Operationstyp,
Revision, Pfad, vorherigen Pfad, Actor/Source und Zeitstempel, jedoch keine
Dateiinhalte.

Kann ein Rename bei einer direkten Dateisystemaenderung nicht sicher ueber
Entry-ID, Plattformidentitaet oder Hash erkannt werden, materialisiert der
Reconcile konservativ Delete plus Create. Er darf Pfadidentitaet nicht erraten.

### Snapshot-, Cursor- und Retry-Semantik

Der Initial-Sync verwendet einen konsistenten Snapshot:

1. Der Server erzeugt `snapshotId` und den zugehoerigen Cursor `C`.
2. Der Client liest ein paginiertes Manifest, das exakt diesen Snapshot abbildet.
3. Er laedt und verifiziert die benoetigten Inhalte.
4. Danach verarbeitet er alle Deltas strikt nach `C`.

Manifest-Eintraege referenzieren immutable `revisionId`s. Blob-Downloads lesen
genau diese Revision, nicht den inzwischen moeglicherweise veraenderten aktuellen
Dateipfad. Der Server pinnt die benoetigten Revision-Blobs mindestens fuer die
Snapshot-Lebensdauer; andernfalls ist ein konsistenter Initial-Sync nicht
garantierbar.

Weitere Invarianten:

- Mutation- und Upload-Requests tragen einen stabilen Idempotency Key aus
  `replicaId` und `operationId`. Retries liefern dasselbe Ergebnis und erzeugen
  keine doppelte Datei oder Revision.
- Deltas duerfen doppelt eintreffen; der Client verarbeitet sie idempotent und
  in Cursor-Reihenfolge. Luecken erzwingen Nachladen, nicht Ueberspringen.
- Cursor besitzen eine dokumentierte Retention. Ist ein Cursor zu alt, antwortet
  der Server mit einem expliziten `CURSOR_EXPIRED`; der Client startet einen
  sicheren Full-Reconcile und verwirft keine pending lokalen Operationen.
- Batch-Mutationen definieren, ob sie atomar sind. Bei partiellen Ergebnissen
  wird jeder Eintrag mit eigenem Status, neuer Revision und Cursor quittiert.
- Der Server liefert `protocolVersion`, Capability Flags und minimale/maximale
  kompatible Clientversion. Inkompatible Clients pausieren sichtbar und schreiben
  nicht weiter.

### Lokaler State

SQLite speichert mindestens:

- Workspace-Verbindung, `replicaId`, lokalen Root und letzten Remote-Cursor;
- Datei-ID, relativen Pfad, lokale und Remote-Revision, Content-Hash, mtime und
  Groesse;
- persistente Upload-/Download-Queue mit Retry- und Backoff-Information;
- Tombstones und bereits verarbeitete Events;
- Konflikte, Nutzerentscheidung und Diagnosedaten ohne Dateiinhalte;
- eine Transaktions-/Operation-ID zur Erkennung eigener lokaler Writes.

Der Store besitzt eine versionierte Schema-Migration. Vor Migration wird ein
kleines Backup des Sync-States angelegt. Bei Korruption oder nicht unterstuetztem
Downgrade bleibt die lokale Replik unangetastet; der Client kann den State aus
Manifest, lokalem Scan und pending Operations neu aufbauen.

Dateiuebertragungen sind resumierbar, hash-verifiziert und atomar: Download in
eine Staging-Datei, `fsync`, Rename; Upload aus einem stabilen Snapshot. Teil-
Dateien duerfen weder im Server noch im sichtbaren lokalen Ordner erscheinen.

## Authentifizierung und Verbindungsidentitaet

Der Hintergrund-Sync verwendet eine eigene, widerrufbare Desktop-Session mit
minimalem Workspace-Sync-Scope. Er darf weder Renderer-Cookies auslesen noch ein
allgemeines Admin- oder API-Token erhalten.

Verbindlicher Ablauf:

1. Der bereits angemeldete Renderer startet einen serverseitigen Desktop-
   Authorization-Flow fuer den aktuellen User und Server-Origin.
2. Der Server stellt nach sichtbarer Zustimmung ein kurzlebiges Access Token und
   ein rotierendes, widerrufbares Refresh Credential aus.
3. Nur der Main Process speichert das Refresh Credential im OS-Keychain; der
   Renderer erhaelt nur Verbindungs- und Statusinformationen.
4. Refresh revalidiert Account, Membership, Workspace-Permission, Replica und
   Protokollversion.
5. Logout, Accountwechsel, Server-URL-Reset oder serverseitiger Widerruf pausiert
   die Replik sofort und entfernt Credentials. Lokale Daten und pending Aenderungen
   werden niemals still geloescht.

Jede Credential-Zuordnung enthaelt mindestens `serverOrigin`, `accountId`,
`workspaceId`, `replicaId`, Scope, Ablauf und serverseitige Session-ID. TLS-
Fehler und Zertifikatswechsel werden nicht automatisch umgangen.

## Sync-State-Machine und Desktop-Lifecycle

Der Lifecycle wird als explizite State-Machine implementiert:

```txt
disconnected -> authorizing -> initializing -> catching_up -> synchronized
                                      |              |             |
                                      v              v             v
                                    error <------ reconciling <-> offline
                                      |
                         paused | blocked | deauthorized
```

Jeder Zustand hat erlaubte Uebergaenge, persistierte Ursache und eine klare UI-
Darstellung. `error` ist kein Sammelbecken: mindestens Netzwerk, Auth,
Permission, lokaler Root, Speicherplatz, Protokoll, Konflikt und Serverfehler
werden getrennt klassifiziert.

Damit die Funktion einem Drive entspricht, laeuft der Main Process auf macOS,
Windows und Linux nach dem Schliessen des Fensters standardmaessig weiter, sobald
ein Workspace bewusst verbunden wurde. V1 bekommt:

- ein Tray-/Menueleisten-Icon mit Gesamtstatus, Pause, Fenster oeffnen und
  „Canvas vollstaendig beenden“;
- eine standardmaessig aktive Einstellung „Im Hintergrund synchronisieren“ und
  die standardmaessig deaktivierte Option „Bei Anmeldung starten“;
- einheitliches Close-Verhalten auf allen Plattformen;
- Sleep-/Wake-, Netzwerkwechsel- und OS-Shutdown-Hooks;
- einen kontrollierten Update- und Quit-Barrier: keine neue Operation starten,
  laufende atomare Schritte abschliessen, Queue/SQLite flushen, dann Update oder
  Exit erlauben.

Ohne aktivierten Hintergrundbetrieb wird in der UI deutlich angezeigt, dass bei
beendeter App keine Synchronisierung stattfindet.

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

### Auswahl und Validierung des lokalen Roots

- V1 akzeptiert standardmaessig nur einen leeren Zielordner. Import oder Merge
  eines nichtleeren Ordners ist ein separater, spaeterer Flow.
- Laufwerksroot, Home-Verzeichnis, Systemordner, ein anderer Canvas-Replica-Root
  sowie verschachtelte Replica-Roots sind unzulaessig.
- Bekannte iCloud-, OneDrive-, Dropbox- und Netzlaufwerkpfade werden erkannt und
  standardmaessig blockiert oder mit einer expliziten, nicht uebergehbaren
  Produktpolicy behandelt, damit keine Sync-Schleifen entstehen.
- Beim Einrichten werden Volume-ID, Case-Sensitivity, freie Kapazitaet,
  Schreibbarkeit und Unterstuetzung atomarer Renames geprueft. Wechsel von Volume
  oder Root-Identitaet pausiert die Replik.
- Vor *Replik trennen*, Logout und Serverwechsel zeigt die UI ausstehende lokale
  Aenderungen. Sie bietet *erst synchronisieren*, *lokale Aenderungen exportieren*
  oder ein deutlich bestaetigtes *verwerfen* an.

## Konflikt-, Collaboration- und Dateitypregeln

| Fall | Verhalten in V1 |
| --- | --- |
| Nur lokal geaendert | Upload mit erwarteter Basisrevision |
| Nur remote geaendert | atomarer Download in die lokale Replik |
| Beide Seiten Text geaendert | V1 erstellt eine Konfliktkopie und verlangt eine UI-Entscheidung; automatischer dreiseitiger Merge folgt spaeter |
| Beide Seiten Binaerdatei geaendert | keine automatische Zusammenfuehrung; Konfliktkopie |
| Server-Lock aktiv | lokaler Upload bleibt wartend und ist sichtbar blockiert |
| Aktives Yjs-/Excalidraw-Dokument | Server policy entscheidet Checkpoint/Lock; kein blindes Whole-File-Ueberschreiben |
| Lokale Datei waehrend Upload erneut geaendert | Upload-Snapshot fertigstellen, neue Aenderung erneut einreihen |
| Offline | Queue persistieren; keine stillen Datenverluste |

Konfliktkopien erhalten einen deterministischen, plattformgueltigen Namen wie
`Bericht (Konflikt von MacBook, 2026-08-28).md`. Der Originalinhalt wird nie
automatisch verworfen. Bei nicht mergefaehigen Dateien ist Lock/Check-out der
bevorzugte Schutzmechanismus.

Ein aktives Collaboration-Dokument wird als eigener blockierter Zustand
modelliert (`waiting_for_collaboration_checkpoint`) und nicht als generischer
Dateikonflikt. V1 fuer Personal Workspaces aktiviert keine neue Collaboration-
Integration; der Server lehnt unzulaessige Whole-File-Writes weiterhin ab.

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

Ignore-Regeln wirken als Replikationsfilter, niemals als Delete-Anweisung. Wird
eine zuvor synchronisierte Datei spaeter ignoriert, bleibt die Serverdatei
erhalten und die lokale Entfernung erfordert eine separate Policy. Eine
Policy-Aenderung loest einen Reconcile aus und zeigt vor Massenveraenderungen eine
Vorschau. Serverseitige und lokale Regeln werden gemeinsam versioniert; der
restriktivere Sicherheitsfilter gewinnt.

Fuer plattforminkompatible Namen gilt eine explizite Policy. Case- oder Unicode-
Kollisionen, Windows-reservierte Namen und zu lange Pfade werden nicht still
umbenannt. V1 blockiert die betroffenen Entries sichtbar und ermoeglicht eine
serverseitige Umbenennung. Ein spaeteres Encoding muss reversibel sein und darf
keine zwei Serverpfade auf denselben lokalen Pfad abbilden.

## Sicherheit und Betrieb

- Auth-Tokens liegen nur verschluesselt im OS-Keychain beziehungsweise über
  Electron `safeStorage`; niemals im Renderer, im Workspace-Ordner oder in
  Logs.
- Alle Requests pruefen aktuelle Mitgliedschaft und Workspace-Permission; ein
  Cursor oder eine Datei-ID ist keine Berechtigung.
- Der lokale Root wird beim Einrichten nach `realpath` validiert. Vor jeder
  Operation werden Root-Grenze und Linkstatus erneut geprueft; Zugriffe folgen
  keinen Symlinks/Junctions und muessen Link-Swap-/TOCTOU-Angriffe abfangen. Ein
  Adapter darf ausserhalb dieses Roots niemals lesen oder schreiben.
- Sync-Status, Konflikte, fehlgeschlagene Rechtepruefungen und Queue-Backlog
  werden datensparsam telemetriert; Dateiinhalte und Pfade nur, soweit sie fuer
  lokale Diagnose erforderlich sind.
- Kontrollierter App-Shutdown flusht SQLite und die Queue-Metadaten, beendet
  aber keine aktiven atomaren Dateioperationen unkontrolliert.
- Der lokale Spiegel besteht aus normalen, fuer den eingeloggten OS-User lesbaren
  Dateien. Die UI und Admin-Dokumentation weisen auf Device Encryption, lokale
  Backups, Suchindexierung und Cloud-Backup-Tools hin. Ein serverseitiger
  Rechteentzug kann bereits lokal kopierte Inhalte nicht verlaesslich remote
  loeschen; V1 verspricht deshalb keinen Remote-Wipe.
- IPC-Handler validieren Sender-Origin, Payload-Schema und Berechtigung pro
  Aktion. `contextIsolation`, Renderer-Sandbox, deaktiviertes Node-Integration
  und Navigation-Allowlist bleiben verpflichtend.

### Betrieb, Diagnose und Ressourcen

- Manifest und Deltas sind paginiert; Uploads, Downloads und Hashing besitzen
  begrenzte Parallelitaet und faire Priorisierung zwischen Workspaces.
- Sync reagiert auf Akkubetrieb, getaktete Verbindungen, Speicherplatz und
  Bandbreitenlimits. Defaults sind konservativ und im Status sichtbar.
- Logs sind redacted, groessenbegrenzt und besitzen Retention. Ein exportierbares
  Support-Bundle enthaelt Versionen, Zustandsuebergaenge, Cursor, Queue-Statistik
  und Fehlercodes, aber keine Tokens oder Dateiinhalte.
- Telemetrie umfasst Queue-Alter, Reconcile-Haeufigkeit, Konfliktrate,
  Transferfehler, Cursor-Expiry und Journal-Recovery. Alarmierung erfolgt bei
  dauerhaftem Backlog oder wiederholten Integritaetsfehlern.
- Reparaturaktionen sind explizit: *Verbindung testen*, *lokalen Scan starten*,
  *sicher neu abgleichen* und *Diagnose exportieren*. Ein Neuabgleich bewahrt
  pending lokale Inhalte als Snapshot oder Konfliktkopie.

## UX

Im Desktop-Client gibt es eine Workspace-Drive-Seite oder einen Bereich in den
Workspace-Einstellungen:

- „Lokal verfuegbar machen“ mit Ordnerwahl und initialer Groessenprognose;
- in V1 genau ein Personal Workspace; spaeter auswählbare Workspaces und
  selektive Unterordner;
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
| 0. Spike und Contracts | Auth, Snapshot/Cursor, Mutation-Journal, Dateityp-Policy, lokaler State, Prototyp mit einem Workspace | 1–2 Wochen |
| 1. Read-only Replica | Einrichten, Initial-Download, Status, sicheren Root-Schutz, Resume | 2–3 Wochen |
| 2. Bidirektionaler Kern | Journal/Reconcile, Queue, vorhandenen Chunk-Upload anbinden, Preconditions, Retry, Offline | 3–5 Wochen |
| 3. V1 Desktop-Produktisierung | Konfliktkopien, Root-/Disconnect-UX, Hintergrundbetrieb, Tray/Autostart, Massenmutation-Schutz | 2–3 Wochen |
| 4. Erweiterungen | Team-/Projekt-Workspaces, Locks/Collaboration, automatische Text-Merges, selektiver Sync, Admin-Policies | 3–5 Wochen |
| 5. Hardening | Zwei-Client-/Offline-/Sleep-/Plattform-E2E, Last- und Security-Tests | 2–4 Wochen |

Ein brauchbares, bewusst begrenztes MVP fuer einen einzelnen Personal Workspace
liegt damit bei etwa **7–10 Engineering-Wochen**. Wenn Desktop-Auth,
Hintergrundbetrieb und bestehender Chunk-Upload ohne groessere Umbauten
wiederverwendet werden koennen, ist ein technischer Spike in **5–8 Wochen**
moeglich. Fuer die in `v1-pipeline.md` definierte, plattformgepruefte Opt-in-Beta
einschliesslich Security-, Recovery- und Release-Hardening sind **9–13
Engineering-Wochen** realistischer. Eine produktionsreife
bidirektionale Drive-Funktion fuer Personal-, Team- und Projekt-Workspaces
liegt realistisch bei **16–24 Engineering-Wochen**, ohne nativen virtuellen Mount.
Ein echter Mount ist ein separates Folgeprojekt und fügt je Plattform grob
**6–12 Wochen** plus dauerhafte native Wartung hinzu.

## Verbindliche Test-Gates

Vor produktivem Rollout muessen mindestens folgende Nachweise automatisiert
werden:

- Unit-Tests fuer State-Machine, Cursor, Retry, Ignore-Regeln und
  Konfliktauflösung;
- Contract-Tests fuer Server-Delta, Precondition, Tombstone und Rechteentzug;
- Recovery-Tests fuer Neustart zwischen Dateiwrites und Journal-Commit,
  verlorenes Watcher-Event, Cursor-Expiry, doppelten Request und partiellen
  Batch-Fehler;
- Electron-Integrationstests mit temporaeren lokalen Roots und einem Mock-
  Remote-Adapter;
- End-to-End-Test mit zwei Desktop-Clients, offline Aenderungen, parallelem
  Rename und Konfliktkopie;
- manuelle macOS- und Windows-Pruefung fuer Finder/Explorer, Sleep/Wake und
  Rechteverhalten;
- Security-Tests fuer Traversal, Symlinks, Token-Leaks, Workspace-Isolation und
  Massenloesch-Schutz einschliesslich Link-Swap-/TOCTOU-Faellen;
- Restore-Test: lokaler Root geloescht, Serverdaten unveraendert, Reconnect in
  einen neuen Ordner erfolgreich.
- Lifecycle-Test fuer Tray, echtes Beenden, Autostart, Sleep/Wake, Logout,
  Serverwechsel und Auto-Update mit pending Queue.
- Plattformtest fuer Case-/Unicode-Kollisionen, Windows-reservierte Namen,
  gesperrte Dateien, volles Laufwerk und verschachtelte/cloud-synchronisierte
  Roots.

## Nicht in V1

- nativer virtueller Finder-/Explorer-Mount;
- serverseitiges Ausfuehren lokaler Dateien;
- automatische Konfliktueberschreibung von Binaerdateien;
- automatische dreiseitige Text-Merges;
- Team-/Projekt-Workspaces und aktive Yjs-/Excalidraw-Sync-Integration;
- selektive Synchronisierung und Import eines nichtleeren lokalen Ordners;
- Synchronisierung beliebiger Pfade ausserhalb eines explizit verbundenen
  Workspace-Roots;
- vollstaendige On-Demand-Platzhalterdateien wie bei iCloud/OneDrive.

## Offene Produktentscheidungen vor Phase 0

1. Welche Dateigroesse, Dateianzahl und Gesamtquote sind fuer V1 akzeptabel?
2. Welche lokale Datenaufbewahrung wird bei Logout oder Rechteentzug angeboten,
   ohne einen nicht garantierbaren Remote-Wipe zu versprechen?
3. Wie lange werden Delta-Cursor, Mutation-Deduplizierung und Workspace-
   Papierkorb serverseitig aufbewahrt?
4. Welche Admin- und Audit-Anforderungen gelten fuer spaetere Team-Workspaces und
   Massenmutationen?
