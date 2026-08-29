# Electron Workspace Drive V1 Pipeline

Stand: 2026-08-28

## Zielzustand

Nach Abschluss der Pipeline kann ein Endnutzer in der gebauten Electron-App
einen Personal Workspace mit einem leeren lokalen Ordner verbinden. Der Client
spiegelt den Workspace initial, synchronisiert danach lokale und serverseitige
Aenderungen automatisch, arbeitet offline weiter, startet nach App-Neustart
sicher erneut und verhindert stille Konflikte oder Massenloeschungen.

Die Pipeline ist strikt sequenziell. Ein Gate ist eine Lieferbedingung, keine
Fortschrittsmarkierung: Solange ein Gate nicht bestanden ist, beginnt das
naechste Paket nicht.

## Automatischer Laufzeitpfad

```txt
App/Tray startet
  -> Desktop-Credential laden und revalidieren
  -> lokalen Root und Sync-State pruefen
  -> pending Queue wiederherstellen
  -> Remote-Deltas seit letztem Cursor laden
  -> lokale und remote Aenderungen klassifizieren
  -> sichere Downloads und Uploads ausfuehren
  -> Revisionen/Cursor atomar bestaetigen
  -> lokale Watcher- und Server-Delta-Schleife aktiv halten
  -> bei Offline/Fehler persistent pausieren und automatisch fortsetzen
```

Manuell bleiben nur Kontrolleingriffe: Pause/Fortsetzen, „Jetzt
synchronisieren“, sicherer Neuabgleich, Konfliktentscheidung,
Massenloeschbestaetigung und Trennen der Replik.

## Pipeline

| Stufe | Paket | Ergebnis | Exit-Gate |
| --- | --- | --- | --- |
| 0 | `WD-P00` Contracts und Sicherheitsbaseline | V1-Defaults, Protokoll, Datenmodell und Threat Model sind testbar festgelegt | `G0_CONTRACTS_LOCKED` |
| 1 | `WD-P01` Server-Journal und Reconcile | Jede Serveraenderung wird dauerhaft, geordnet und reparierbar erfasst | `G1_JOURNAL_DURABLE` |
| 2 | `WD-P02` Snapshot-, Delta- und Blob-API | Konsistenter, paginierter Read-only-Sync ist serverseitig moeglich | `G2_REMOTE_READ_READY` |
| 3 | `WD-P03` Desktop-Authorization | Main Process besitzt eine minimale, widerrufbare Sync-Session | `G3_DESKTOP_AUTH_READY` |
| 4 | `WD-P04` Frameworkneutraler Sync-Core | State-Machine, SQLite, Cursor und Queue funktionieren ohne Electron | `G4_SYNC_CORE_READY` |
| 5 | `WD-P05` Lokale Replik | Root, atomare IO, Watcher, Reconcile und Ignore-Policy sind sicher | `G5_LOCAL_REPLICA_READY` |
| 6 | `WD-P06` Bidirektionaler Sync | Automatische Uploads, Downloads, Offline-Resume, Trash und Konfliktkopien funktionieren | `G6_BIDIRECTIONAL_READY` |
| 7 | `WD-P07` Electron-Lifecycle | Main Process, Tray, Autostart, Sleep/Wake und Update-Barrier sind integriert | `G7_DESKTOP_RUNTIME_READY` |
| 8 | `WD-P08` Endnutzer-UX | Verbinden, Status, Konflikte, Reconnect, Trennen und Diagnose sind bedienbar | `G8_USER_FLOW_READY` |
| 9 | `WD-P09` Hardening und Beta-Release | Plattform-, Security-, Recovery- und Release-Gates sind bestanden | `G9_V1_BETA_RELEASED` |

## Gate 0: Contracts fest

Vor Servercode werden mindestens folgende Entscheidungen versioniert:

- maximale Dateigroesse, Dateianzahl und Workspace-Gesamtgroesse;
- Cursor-, Snapshot-, Deduplizierungs- und Papierkorb-Retention;
- Protokollversion, Capability Negotiation und Fehlerkatalog;
- Entry-, Revision-, Replica- und Operation-Identitaeten;
- Desktop-Authorization und Revocation;
- lokales Datenverhalten bei Logout oder Rechteentzug;
- Hintergrund-Sync standardmaessig aktiv nach bewusstem Verbinden, Autostart
  als explizite Einstellung.

## Gate 1: Durables Journal

Das Journal gilt erst als fertig, wenn API-, Agent-, Automation-, Collaboration-
und direkte Terminal-Aenderungen nachweislich als geordnete Deltas erscheinen.
Ein Neustart zwischen Dateioperation und Journal-Commit muss repariert werden.
`fs.watch` darf nur Latenz optimieren; ein Reconcile-Scan muss verlorene Events
finden.

## Gate 2: Read-only Vertical Slice

Ein Test-Client muss einen Snapshot bei Cursor `C` erzeugen, das Manifest
paginiert laden, immutable Revision-Blobs per Range herunterladen, Hashes
verifizieren und anschliessend alle Deltas nach `C` anwenden koennen. Aenderungen
waehrend des Initial-Downloads duerfen weder fehlen noch mit einer falschen
Revision gespeichert werden.

## Gate 3: Desktop-Authorization

Die Electron-App autorisiert eine eigene Desktop-Session. Refresh Credentials
liegen nur im OS-Keychain beziehungsweise verschluesselt ueber `safeStorage`.
Logout, Serverwechsel, Permission-Entzug und Revocation stoppen weitere Writes,
ohne lokale Daten oder pending Aenderungen still zu entfernen.

## Gate 4: Sync-Core

Der Core ist ohne Electron testbar. Er besitzt explizite Ports fuer Remote,
Local Replica, State Store, Clock, Connectivity und Events. Domainregeln bleiben
im Orchestrator; Transfer-, Hash-, SQLite- und Dateisystemmechanik bleiben in
kleinen Services. Queue und State-Machine ueberstehen Prozessabbruch und
Wiederanlauf.

## Gate 5: Lokale Replik

Nur ein leerer, sicherer Root wird akzeptiert. Symlinks, Junctions,
verschachtelte Canvas-Repliken, Home-/Laufwerksroots und bekannte Cloud-Sync-
Roots werden blockiert. Atomare Editor-Saves, Rename-Ketten, doppelte Watcher-
Events, Case-/Unicode-Probleme und eigene Sync-Writes werden korrekt erkannt
oder sichtbar blockiert.

## Gate 6: Bidirektionaler Kern

Der automatische Sync verarbeitet create, change, rename, move und delete in
beide Richtungen. Uploads verwenden den bestehenden Chunk-Service und stabile
Idempotency Keys. Offline-Aenderungen bleiben persistent. Text- und
Binaerkonflikte erzeugen Konfliktkopien. Grosse Loeschungen warten auf
Bestaetigung und landen serverseitig im Papierkorb.

## Gate 7: Electron-Runtime

Der Sync startet nach erfolgreicher App-Initialisierung automatisch und bleibt
bei aktiviertem Hintergrundbetrieb im Tray aktiv. Es gibt genau eine laufende
Sync-Instanz. Sleep/Wake, Netzwerkwechsel, echter Exit und Auto-Update verwenden
einen Quit-Barrier, der laufende atomare Operationen beendet und Queue/SQLite
flusht.

## Gate 8: Nutzerfluss

Die UI deckt Verbinden, Initialfortschritt, aktuell/offline/pausiert/blockiert,
Konflikte, Massenmutation, „Jetzt synchronisieren“, Reconnect, Neuabgleich,
Trennen und Diagnoseexport ab. Ein fehlender lokaler Root wird niemals als
Serverloeschung interpretiert.

## Gate 9: Beta-Release

V1 wird erst als Beta freigegeben, wenn folgende Nachweise gruen sind:

- Unit-, Contract-, Integration- und Recovery-Tests;
- Zwei-Client-Test mit Offline- und Konfliktfaellen;
- Security-Tests fuer Traversal, Link-Swap, Token-Leaks und Workspace-Isolation;
- manuelle macOS- und Windows-Pruefung fuer Finder/Explorer, Sleep/Wake,
  gesperrte Dateien und volles Laufwerk;
- Test eines signierten/notarisierten macOS-Artefakts und des Auto-Update-
  Neustarts mit pending Queue;
- Telemetrie, Support-Bundle, Rollback- und Kill-Switch-Verfahren;
- kleiner Opt-in-Pilot ohne ungeklärte Datenverlust- oder Sicherheitsbefunde.

## Rollout

1. Interner Entwicklungsmodus mit Mock Remote.
2. Lokaler Test gegen eine isolierte Notebook-Instanz.
3. Read-only Dogfood.
4. Bidirektionales Dogfood mit explizitem Backup.
5. Kleine Opt-in-Beta auf macOS und Windows.
6. Stufenweise Ausweitung nach Konflikt-, Fehler- und Backlog-Metriken.

Ein Server-Kill-Switch kann neue Desktop-Sync-Sessions und Writes deaktivieren.
Bereits laufende Clients wechseln dann in einen sichtbaren read-only- oder
pausierten Zustand; lokale Inhalte bleiben erhalten.
