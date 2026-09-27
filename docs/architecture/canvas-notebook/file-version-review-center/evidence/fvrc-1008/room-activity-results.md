# Vollständige lokale Activity-Zulassung vor einem Drain

Stand: 27. September 2026. Aufbauend auf `c016409dc`.
Weiterer FVRC-1008-Baustein, **kein terminaler oder verteilter Live-Handoff**.

## Problem und Umsetzung

Die bisherige kurze Raumreservierung endet schon nach dem Verbindungsaufbau
und läuft nach 30 Sekunden automatisch aus. Sie beweist nicht, dass ein Direct-
Auftrag einschließlich Workspace-/Room-Wartezeit und finalem Store beendet ist.
Ein Drain, der vorher den Room-Lock nimmt, kann mit einem solchen Auftrag
deadlocken: Direct hält Workspace und wartet auf Room, während Drain Room hält
und über History-Capture auf Workspace wartet.

Die optionale Ownership-Runtime erhält daher ein separates Activity-Gate:

- Nicht verfallende, idempotent freigebbare Leases. Grenzen: 256 Dokumente,
  128 Aktivitäten pro Dokument, 1024 Aktivitäten insgesamt. Kein Timer erklärt
  einen laufenden Auftrag künstlich für beendet.
- Drain schließt die Zulassung synchron. `idle` löst erst nach tatsächlicher
  Freigabe aller bereits zugelassenen Aktivitäten. Ein früher Fehler oder das
  Dispose des Gates senkt keinen Zähler künstlich.
- Nur der exakte Drain-Handle darf nach `idle` ausdrücklich wieder öffnen;
  wiederholtes Finish oder ein alter Handle verändert keinen späteren Drain.
- Direct erwirbt die Lease vor dem ersten Workspace-/Room-Await und hält sie
  im äußeren `finally` bis nach dem erfolgreichen oder fehlgeschlagenen
  Disconnect. Ein zuvor zugelassener Auftrag darf vollständig fertig werden.
- Schreibende Sync-Frames erwerben Activity vor dem Room-Mutex, prüfen nach
  diesem sowie nach asynchroner Rechteprüfung erneut das Gate und geben bei
  Vorprüfungsfehlern oder am Ende der Nachrichtenverarbeitung frei.
- Live-Reader, Reconciliation und asynchrone semantische Konfliktprüfung nutzen
  dieselbe zentrale `withRoomActivity`-Hülle mit `finally`-Freigabe.
- Gewöhnliches Hocuspocus-Unload bleibt während eines expliziten Activity-Drains
  gesperrt. Der Owner-Fence bleibt gültig, damit zugelassene Aufträge final
  speichern können. `idle` ist ausdrücklich **kein** Durability-Beleg.

Das Gate gehört zu einer Server-Runtime und ist pro Dokument-ID adressiert.
Vor einem terminalen Drain müssen zusätzliche konkrete Doc-Instanz-/Scope-
Prüfungen folgen. Der reguläre Bootstrap liefert weiterhin keine Owner-Factory;
ohne optionale Ownership ist die neue Activity-Hülle transparent.

## Nachweise

Die acht fokussierten Gate-Tests prüfen Kapazitätsgrenzen, echte Freigabe,
synchrone Schließung, wartende Peer-Prüfung, ablaufende Direct-Aktivität,
Handle-Identität, unabhängige Dokumente und Dispose ohne falschen Ruhezustand.
Sie laufen regulär in `test:collaboration:room-owner:runtime` mit.

Der echte Hocuspocus-Test ergänzt drei kontrollierte Reihenfolgen:

1. Ein Direct-Auftrag ist bereits admitted, wartet aber am tatsächlich gehaltenen
   Room-Mutex. Drain bleibt pending; nach Freigabe laufen Callback, Store und
   Disconnect durch, erst danach wird `idle` erfüllt.
2. Ein Direct-Auftrag wartet zunächst in `onApplied`, danach im finalen Store.
   Beide Phasen halten Activity aktiv. Ein zweiter Auftrag wird vor `transact`
   abgelehnt, gewöhnliches Unload blockiert, und nach `idle` bleibt der alte
   Owner-Fence ausdrücklich gültig statt als freigegeben zu gelten.
3. Ein Client-Frame wartet vor Drain am Room-Mutex. Nach Freigabe verwirft die
   erneute Zulassungsprüfung den Frame; Inhalt bleibt unverändert, Activity und
   Mutex werden frei, die nächste Mutex-Anforderung gelingt.

Das sind reale Receiver-/DirectConnection-/Unload-Pfade und echte lokale
Mutationssperren, aber simulierte Owner-/SQL-Grenzen. Der Workspace-Lock dieses
Harness ist weiterhin ein No-op. Daraus wird **kein** Dateisystem-/Mehrprozess-
Deadlock- oder PostgreSQL-Handoff-Nachweis abgeleitet.

Die unabhängige Codeprüfung fand keine neuen Sperrzyklen oder verlorenen Leases
im begrenzten Slice. Vollständige Lifecycle-, Projection- und Operationssuites
bestanden; Operations lief in einer frisch migrierten UUID-Datenbank, die danach
entfernt wurde. Die gezielten Gates ersetzen keine kommende Aktivierungsabnahme.
Logs: `/tmp/fvrc1008-room-activity-lifecycle-final.log`, `projection.log` und
`operations.log` mit demselben Präfix; zusätzlicher unabhängiger Servertestlauf:
`/tmp/fvrc1008-room-owner-runtime-activity-drain-final.log`.

Der finale TypeScript-Check, fokussiertes ESLint und Build mit 353 Seiten sind
grün (`types-final.log`, `lint-final.log`, `build-final.log`, gleicher Präfix).
Ein früher Build erwischte eine noch unvollständige Test-Callback-Änderung;
die finale Testdatei und der vollständige abschließende Build bestehen.

Nach frischem Start des Host-Dev **127.0.0.1:3000** bestehen die gewöhnlichen
B/C-Browserfälle: Personal **22,8 s**, Team **15,5 s**. C wird angenommen, B bleibt
konkret konflikthaft statt einen Timeline-Fehler zu zeigen. Exakter Endtext und
genau eine neue Inhaltsrevision sind geprüft; beide Screenshots wurden angesehen.
Berichte unter `/tmp/fvrc1008-room-activity-{personal,team}-conflict-report/`.
Diese Browserläufe prüfen den Default ohne aktive Ownership, nicht das neue
optionale Gate. Dieses ist in den gesonderten Hocuspocus-Tests eingeschaltet.

Der gewöhnliche Zehnerfall besteht ebenfalls in Personal (**54,8 s**) und Team
(**55,5 s**): zehn unabhängige `edit_file`-Vorschläge, drei Einzelannahmen in
nicht fortlaufender Reihenfolge und anschließend sieben gemeinsam. Exakter
Endtext, genau vier neue Inhaltsrevisionen, exakte betroffene Vorschlags-IDs
und idempotente Wiederholungen auch mit im Tool-Prozess deaktiviertem Graph-
Gate sind geprüft. Ein veränderter Wiederholungsauftrag bleibt abgelehnt.
Beide abschließenden Screenshots zeigen null offene Reviews und fünf Versionen
einschließlich importiertem Ausgangsstand; sie wurden angesehen.
Berichte: `/tmp/fvrc1008-room-activity-{personal,team}-batch-report/index.html`.
Alle vier Browserläufe liefen seriell mit einem Worker und mindestens 55 Sekunden
Abstand nach bestätigtem Abschluss des vorherigen Laufs.

Lesender Bestandscheck: null aktive Owner-Epochen, null zurückgebliebene
Owner-/Release-Testschemas und null isolierte Editor-Testdatenbanken. Genau vier
verwaltete Container bleiben gesund; 3100 enthält weiterhin das ältere Image.

GitNexus wurde vollständig aktualisiert und anschließend mit absolutem
Worktree-Pfad abgefragt. Der Commitumfang umfasst neun Dateien / 48 indexierte
Symbole / keine indexierten Prozessketten, LOW. Die Runtime-Funktion hat acht
direkte indexierte Aufrufer, MEDIUM. Der Gesamtbranch gegen `main` bleibt mit
261 Dateien / 30 Prozessketten CRITICAL; diese Teilprüfung ist keine Mergefreigabe.

## Abgrenzung und nächste Integration

Noch kein Produktaufrufer startet einen Activity-Drain. Startup-Admission über
Authentifizierung und `connected` sowie die vollständige terminale Sequenz
bleiben offen: Peers schließen, **ohne Workspace-/Room-/Save-Lock** auf Activity
null warten, erst dann Room-Lock nehmen, final speichern, vollständigen Snapshot
an den Release-Beleg binden, verlorene Commit-Antwort prüfen und exakt die alte
Instanz entladen. `beforeUnloadDocument` darf diesen Übergang nicht beginnen.

Der spätere Lifecycle-Writer muss zusätzlich eine dauerhafte prozessübergreifende
Reservation und denselben SQL-Advisory-Guard bis nach seinem Commit halten.
Die lokale Activity-Lease ersetzt das nicht. Ebenso offen bleiben atomarer
Kandidatencommit vor Live-Publish, Crash-/Reconnect-Recovery, PG-/MR-Gesamtabnahme
und P12. Kein Feature-Gate wurde geöffnet, kein Container neu gebaut, kein Push.

Zwei vor Aktivierung zu behandelnde Diagnosefragen: Die Runtime meldet derzeit
geschlossenes Drain-Gate und Kapazitätsmangel beide als `ROOM_OWNER_BUSY`.
Abgelehnte Reconciliation läuft in den bisherigen Persistence-Fehlerpfad; beim
später aktivierten Drain soll das eine Übergangsmeldung statt einer vermeintlichen
Speicherstörung werden. Beides verliert keine bestätigten Änderungen.
