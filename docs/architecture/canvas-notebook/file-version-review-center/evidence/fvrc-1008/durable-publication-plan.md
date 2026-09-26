# Dauerhafte Speicherung vor Veröffentlichung eines Review-Kandidaten

Stand: 26. September 2026. Ergänzung zu FVRC-1008 / PG-S19, keine
Produktionsfreigabe. Ausgangspunkt: [Preparing-Crash-Nachweis](proposal-preparing-crash-results.md).

## Problem und unveränderliche Regeln

Der aktuelle Direct-Connection-Pfad veröffentlicht das Yjs-Update synchron an
Peers, bevor der asynchrone Operationsbeleg und der PostgreSQL-Snapshot
gespeichert sind. Ein Absturz nach `preparing → applying` kann deshalb sowohl
„nie angewendet“ als auch „von einem Peer bereits empfangen“ bedeuten. Gleiche
gespeicherte Ausgangsbytes beweisen keinen wirkungslosen Auftrag.

- Kein blindes erneutes Anwenden eines ungewissen Auftrags.
- Keine Freigabe seiner Reservierung allein aufgrund von Text-/Base-Gleichheit.
- Keine Generationserhöhung zum stillen Verwerfen fremder Offline-Änderungen.
- Neue UI-Annahmen bleiben an eine exakte aktuelle Vorschau gebunden.
- Erst ein atomarer dauerhafter Kandidat samt Beleg darf veröffentlicht werden.

## Geordnete Umsetzung

### 1. Lokale Raum-Mutationssperre (aktueller Baustein)

Eine gemeinsame FIFO-Sperre gehört zur konkreten Y.Doc-Rauminstanz, nicht nur
zum Dateipfad. `beforeSync` hält sie für SyncStep2/Update bis
`afterHandleMessage`, sodass auch Fehler innerhalb von MessageReceiver.apply
eingeschlossen sind. Awareness, Stateless und SyncStep1 benötigen keine
Mutationssperre. Eine fehlgeschlagene Vorprüfung gibt ihre eigene Sperre frei. Nach dem
Warten werden Zugriffsrecht und Raumidentität geprüft. Ein Disconnect darf
eine noch laufende Mutation nicht durch vorzeitige Freigabe überholen.

Die Direct Connection erwirbt zuerst die Workspace-Sperre, dann dieselbe
Raumsperre, und hält beide durch Validierung, Mutation, Operationsbestätigung
und synchrones Speichern beim Disconnect. Begrenzte Warteschlangen und
Wartefristen verhindern unbeschränktes Aufstauen; ein laufender kritischer
Abschnitt wird nie nach einem Timer automatisch freigegeben.

**Nicht** dieselbe Sperre in `onStoreDocument` erwerben: Ein Timer-Store kann
bereits Hocuspocus.saveMutex halten, während ein Direct-Disconnect unter der
Raumsperre auf genau diesen Store wartet. Das wäre ein Deadlock.

Dieser Baustein serialisiert lokale Änderungen. Er ändert weder den Zeitpunkt
der Veröffentlichung noch die konservative Legacy-Recovery und ist daher
allein ausdrücklich **keine** Lösung der Absturzlücke.

### 2. Veraltete Speicherungen und fremde Raum-Owner abgrenzen (offen)

Vor dem Cutover müssen alle Whole-Room-Stores vor einem veralteten Write
geschützt sein: erwartete Lifecycle-/Schema-/Pfadidentität, Sequenz und
vollständiger Zustandsnachweis, nicht nur Text oder State Vector. Ein verzögert
eintreffender Snapshot darf einen schon bestätigten Kandidaten nicht ersetzen.
Bei einem fehlgeschlagenen CAS muss sicher neu abgeglichen oder der betroffene
Raum als nicht schreibfähig behandelt werden; keine unbedingte Wiederholung.

Eine lokale WeakMap und die kooperative Workspace-Dateisperre belegen keine
exklusive Raumzuständigkeit über zwei App-Prozesse. Für den Cutover ist eine
dauerhaft gefencete Raum-Owner-Regel mit Wiederanlauf und Invalidierung
veralteter Owner erforderlich. Ein Lease-Ablauf allein berechtigt einen alten
Owner nicht zu weiteren Writes. Browser-Reconnect und Offline-Caches müssen
ohne Verlust unabhängiger Nutzeränderungen getestet werden.

### 3. Atomarer Commit, dann Live-Veröffentlichung (offen)

Unter den gültigen Fences den exakten Live-Zustand in eine temporäre Y.Doc
kopieren, dort den genehmigten Kandidaten anwenden und vollständig prüfen.
Keine asynchrone Funktion als Y.Doc.transact-Callback verwenden.

Eine PostgreSQL-Transaktion speichert Kandidatenbytes, Vector und nächste
Dokumentsequenz gemeinsam mit dem Operationssnapshot/-beleg. Sie prüft die
unveränderte vorbereitete Operation, den Graph-Auftrag, den Raum-Owner sowie
die erwartete Dokumentidentität und den bisherigen dauerhaften Zustand.
Die neue Operation bleibt bis zum Commit sicher `preparing`; die neue
Implementierung darf keinen mehrdeutigen Live-vor-Commit-Zwischenzustand
erzeugen. Erst nach bestätigtem Commit wird die exakt geprüfte Änderung an
die weiterhin gesperrte Live-Rauminstanz und ihre Peers weitergegeben.

Ein verlorenes Commit-Ergebnis wird anhand des dauerhaften Belegs abgeglichen,
nicht als sicher unangewendet behandelt. History und Graph-Abschluss müssen
idempotent nachholbar bleiben. Bestehende ungewisse `applying`-Aufträge aus
älteren Versionen behalten die konservative Recovery; ein neuer Mechanismus
macht ihre frühere Veröffentlichung nicht rückwirkend beweisbar.

### 4. Gezielte Crash-/Concurrency-Abnahme vor Cutover (offen)

- Echte Prozessabbrüche vor SQL-Commit, nach Commit vor Live-Publish, nach
  Publish vor History und nach History vor Abschlussbeleg.
- Peer sieht vor Commit keinen Kandidaten; nach Commit genau den bestätigten
  Inhalt. Reconnect und Offline-Wiederanlauf erzeugen weder Doppelwirkung
  noch spätes Wiederaufleben eines abgelehnten Kandidaten.
- Gleichzeitiger Nutzer-Edit, verzögerter Whole-Room-Store, Rename, Restore,
  Rechteentzug und zwei echte App-Prozesse: keine verlorene Änderung und kein
  Write durch einen alten Owner.
- Nach Recovery funktionieren weitere explizit bestätigte Aktionen; reine
  sichere Verweigerung reicht als Abnahme nicht aus.
- Personal/Team, vollständige PG-S-/MR-Matrix zweimal seriell, exakte
  Binary-/Proof-/Sequenz-/History-Orakel und anschließend Produktionsimage.

Containerneubau und Produktionsaktivierung bleiben separate Freigaben. P12
(persistenter manueller Konflikteditor) wird nicht mit diesem Fundament als
erledigt erklärt.
