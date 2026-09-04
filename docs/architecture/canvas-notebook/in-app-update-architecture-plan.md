# In-App-Update-Architektur fuer Canvas Notebook

Stand: 2026-09-04

Status: Implementiert in acht abgeschlossenen Phasen

## Ziel

Nichttechnische Nutzer sollen Canvas Notebook sicher aus der Notebook-UI
aktualisieren koennen, ohne sich auf dem Host anzumelden oder die
`canvas-notebook`-CLI manuell auszufuehren.

Canvas Notebook bleibt eine containerbasierte Anwendung. Der Notebook-Container
erhaelt weder Zugriff auf den Docker-Socket noch allgemeine Host-Rechte. Die
privilegierte Updateausfuehrung bleibt ausserhalb des Containers und verwendet
den vorhandenen, abgesicherten CLI-Pfad fuer Image-Pull, Container-Recreate,
Health-Verifikation und Rollback.

Der Plan unterscheidet zwei vollstaendig unabhaengige Betriebsmodelle:

1. Standalone Canvas Notebook mit lokalem, minimalem Canvas Updater.
2. Managed Canvas Notebook mit Canvas Control Plane und bestehendem Control
   Agent.

Eine Standalone-Installation setzt keine Control Plane voraus, baut keine
Verbindung zu ihr auf und zeigt in der UI keine Managed- oder Fleet-Begriffe.

## Architekturentscheidung

### Gemeinsamer Vertrag, getrennte Systeme

Standalone-Updater und Managed Control Agent teilen nur einen schmalen,
versionierten Updatevertrag:

- Operationstypen,
- Updatephasen,
- Statuswerte,
- Fehlercodes,
- strukturierte CLI-Ereignisse,
- Release- und Verifikationsmetadaten.

Sie teilen keine notwendige Laufzeitinfrastruktur. Beide Systeme muessen ohne
das jeweils andere installierbar, startbar, aktualisierbar und diagnostizierbar
sein.

Der Control-Plane-Agent dient als Referenz fuer bewaehrte Mechaniken wie Locks,
persistente Operationen, Reconnect, Verifikation und Rollback. Der lokale
Standalone-Updater uebernimmt jedoch keine allgemeinen Control-Plane-
Funktionen.

### Updateausfuehrung bleibt in der Host-CLI

Die eigentliche Update-Transaktion wird weiterhin durch die Host-CLI
ausgefuehrt:

```text
canvas-notebook update --image <immutable-image@sha256:...>
```

Der Updater beziehungsweise Control Agent koordiniert diese Transaktion, darf
die Docker-, Datenbank-, Health- und Rollbacklogik aber nicht duplizieren.

### REST fuer Aktionen, SSE fuer Fortschritt

Ein Update wird ueber eine typisierte REST-Operation gestartet. Der Start gilt
erst als angenommen, wenn die Operation ausserhalb des Notebook-Containers
dauerhaft gespeichert und zur Ausfuehrung uebergeben wurde.

```http
POST /v1/updates

202 Accepted
{
  "operationId": "uuid",
  "statusUrl": "/v1/operations/uuid",
  "eventsUrl": "/v1/operations/uuid/events"
}
```

Live-Fortschritt wird per Server-Sent Events (SSE) transportiert. REST bleibt
die autoritative Statusabfrage und der Fallback bei unterbrochener
Eventverbindung.

Ein neuer Notebook-WebSocket waere nicht ausreichend, weil er gemeinsam mit
dem Notebook-Container waehrend des Recreate ausfaellt. Der stabile
Fortschrittsendpunkt muss beim lokalen Host-Updater oder bei der externen
Control Plane liegen.

Der bestehende bidirektionale WebSocket zwischen Managed Control Agent und
Control Plane bleibt unveraendert sinnvoll und wird nicht durch SSE ersetzt.

## Systemuebersicht

```text
                            Managed
                    +---------------------+
                    | Control Plane REST  |
                    | + Agent WebSocket   |
                    +----------+----------+
                               |
Canvas Notebook UI/API --------+-------- UpdateBackend
                               |
                    +----------+----------+
                    | Standalone Unix API |
                    +----------+----------+
                               |
                    Canvas Updater / Control Agent
                               |
                    canvas-notebook update
                               |
                 Docker Recreate + Health + Rollback

Browser ------ SSE oder Status-REST ------ stabiler Statusendpunkt
```

## Betriebsmodelle

### Standalone

Eine ueber den regulaeren Canvas-Installer eingerichtete unabhaengige
Installation erhaelt:

- Canvas Notebook Container,
- PostgreSQL im Managed- oder External-Modus,
- `canvas-notebook`-Host-CLI,
- minimalen `canvas-notebook-updater`,
- systemd Socket Unit,
- systemd Service Unit,
- optional Caddy fuer TLS und den downtime-festen Statuspfad.

Der Standalone-Updater enthaelt ausdruecklich keine:

- Control-Plane-Verbindung,
- WebSocket-Tunnel,
- Heartbeats,
- Host- oder Docker-Metriksammlung,
- Fleet-Orchestrierung,
- zentrale Konfigurationssynchronisation,
- Remote-Terminal-Funktion,
- Abrechnungs-, Lizenz- oder Monitoringlogik,
- freie Shell-Kommandoausfuehrung.

### Managed

Eine Managed-Installation verwendet weiterhin den bestehenden Control Agent:

- Die Control Plane ist fuer Releaseauswahl, Policy, Audit und Rollout
  autoritativ.
- Der bestehende Agent-WebSocket transportiert Updateauftraege und Ereignisse.
- Die Notebook-UI zeigt den Managed-Zustand klar an.
- Lokale autonome Updates werden nicht parallel aktiviert.
- Es gibt pro Installation genau einen autoritativen Update-Verantwortlichen.

### Manuelles Compose oder Plattformhosting

Wenn weder Standalone-Updater noch Managed Control Agent vorhanden sind, darf
die UI keinen scheinbar funktionsfaehigen Updatebutton anzeigen. Stattdessen
zeigt sie den erkannten Installationsweg und passende Anweisungen fuer Docker
Compose, Coolify oder die verwendete Plattform.

## Gemeinsame Notebook-UI

Die UI verwendet eine serverseitig ausgewaehlte Backend-Abstraktion:

```ts
interface UpdateBackend {
  getAvailability(): Promise<UpdateAvailability>;
  startUpdate(input: StartUpdateInput): Promise<UpdateOperation>;
  getOperation(operationId: string): Promise<UpdateOperation>;
}
```

Vorgesehene Implementierungen:

- `StandaloneUpdateBackend`: lokale Unix-Socket-API.
- `ManagedUpdateBackend`: Control Plane API.
- `ManualUpdateBackend`: nur Erkennung und Installationsanleitung.

Die Backend-Auswahl erfolgt serverseitig aus der autoritativen
Installationskonfiguration. Ein Standalone-Nutzer sieht keine Control-Plane-
Begriffe oder Konfigurationsoptionen.

## Minimaler Standalone-Updater

### Socket Activation

Der Updater wird nicht als dauerhaft laufender Daemon betrieben. systemd
Socket Activation startet ihn nur bei Bedarf:

```text
canvas-notebook-updater.socket
        |
        +-- canvas-notebook-updater.service
```

Startgruende:

- Versionspruefung,
- Updatebeginn,
- Status- oder Eventabfrage,
- optionaler systemd-Auto-Update-Lauf.

Waehrend einer aktiven Operation bleibt der Dienst am Leben. Nach einem
terminalen Status bleibt er fuer eine kurze Grace Period, zum Beispiel zehn
Minuten, erreichbar und beendet sich danach. Spaetere Statusabfragen aktivieren
ihn erneut und lesen das persistente Operationsjournal.

### Ressourcenbudgets

Folgende Budgets sind verbindliche Akzeptanzkriterien:

| Bereich | Ziel |
| --- | ---: |
| Updater-Prozesse im Idle | 0 |
| Updater-RAM im Idle | 0 MB durch Socket Activation |
| Updater-CPU im Idle | 0 % |
| Netzwerk im Idle | keine Verbindungen |
| RAM waehrend eines Updates | Zielwert unter 75 MB |
| Operationsjournal | maximal 10 MB oder letzte 20 Runs |
| Hintergrundtimer | nur bei explizit aktiviertem Auto-Update |
| Docker-Abfragen | nur bei Check, Status oder aktiver Operation |

Der Updater verwendet die mit der Host-CLI ausgelieferte Runtime. Es wird kein
zweiter grosser Runtime-Stack installiert.

### Erlaubte Funktionen

Der Standalone-Updater darf ausschliesslich:

- signierte Releaseinformationen pruefen,
- die Verfuegbarkeit einer neuen Version ermitteln,
- genau eine mutierende Canvas-Operation gleichzeitig verwalten,
- die Host-CLI aus einem verifizierten Releaseartefakt aktualisieren,
- ein per Digest gepinntes, verifiziertes Notebook-Image anwenden,
- strukturierte Fortschrittsereignisse speichern und ausliefern,
- Health und finale Version pruefen,
- Rollbackstatus melden,
- optional vor dem Update den bestehenden CLI-Backupbefehl ausfuehren.

Der Updater darf nicht:

- freie Shell-Kommandos annehmen,
- beliebige Image-Referenzen aus Browser oder Notebook-Container uebernehmen,
- einen allgemeinen Docker- oder Host-Management-Endpunkt anbieten,
- Dateien ausserhalb festgelegter Canvas-Pfade verwalten,
- sich im Standalone-Modus mit der Control Plane verbinden.

## Kommunikation und Sicherheitsgrenzen

### Mutierende Standalone-Kommunikation

Mutierende Auftraege laufen nur vom Notebook-Server ueber einen lokalen Unix
Socket zum Updater:

```text
Notebook Server -> /run/canvas-notebook-updater.sock -> Updater
```

Der Socket wird gezielt in den Notebook-Container eingebunden. Der
Docker-Socket bleibt ausserhalb des Containers.

Die lokale API bietet nur typisierte Operationen, zum Beispiel:

- `update.check`,
- `update.start`,
- `update.status`,
- `update.cancel`, solange noch keine irreversible Apply-Phase begonnen hat,
- optional `backup.create` als Teil eines Update-Preflights.

Ein kompromittierter Notebook-Container darf ueber diese Schnittstelle weder
beliebigen Hostcode ausfuehren noch ein vom Angreifer bestimmtes Image starten.

### Release-Vertrauen

Die App uebergibt nur Releasekanal und Nutzerentscheidung. Der Updater loest
das Ziel selbst aus einem signierten Release-Manifest auf.

Das Manifest enthaelt mindestens:

- Release-ID und Version,
- Kanal, zum Beispiel `stable` oder `beta`,
- immutable OCI-Image-Referenz mit SHA-256-Digest,
- Host-CLI-Version und Artefakt-Checksumme,
- minimale Ausgangsversion,
- Kompatibilitaetsinformationen,
- Kennzeichnung, ob ein Backup erforderlich ist,
- Release Notes oder eine verifizierte Referenz darauf.

Ein `latest`-Tag oder ein frei vom Browser uebermittelter Digest ist fuer einen
In-App-Updateauftrag nicht ausreichend.

### Downtime-fester Read-only-Status

Bei Installationen mit Caddy wird ein reservierter Pfad direkt und
containerunabhaengig zum Updater geroutet:

```text
GET /__canvas-host/operations/{operationId}
GET /__canvas-host/operations/{operationId}/events
```

Dieser Pfad ist ausschliesslich lesbar und verlangt ein kurzlebiges, auf eine
einzelne Operation begrenztes Ticket. Er bietet keine Start-, Abbruch-, Docker-
oder Hostaktionen.

Ohne stabilen Reverse Proxy behaelt die bereits geladene Notebook-Seite den
Updatezustand lokal und pollt den regulaeren Health-Endpunkt, bis Canvas wieder
erreichbar ist. Nach dem Reconnect wird der finale Operationsstatus ueber die
Notebook-API geladen.

## Persistenz

Der Standalone-Updater benoetigt keine eigene PostgreSQL-Datenbank. Ein kleines,
atomar geschriebenes Host-Journal reicht aus:

```text
/var/lib/canvas-notebook-updater/
|-- current-operation.json
|-- operations/
|   +-- <operation-id>.json
+-- events/
    +-- <operation-id>.ndjson
```

Gespeichert werden nur:

- Operation-ID,
- Zielversion und verifizierter Digest,
- Phase und Status,
- Zeitstempel und Eventsequenz,
- redigierte Fehlermeldung und Fehlercode,
- Rollbackstatus,
- verifizierte Abschlussversion.

Secrets, Datenbank-URLs, Tokens und ungefilterte Prozessumgebungen duerfen nicht
im Journal erscheinen.

Nach Prozess- oder Host-Neustart wird eine nichtterminale Operation anhand von
Journal, systemd-Unit und laufendem Container als `running`, `reconnecting`,
`verifying`, `failed` oder `indeterminate` rekonstruiert. Ein fehlender
In-Memory-Zustand darf nicht automatisch als Erfolg gewertet werden.

## Updatezustandsmodell

Vorgesehene Hauptzustaende:

- `queued`,
- `preflight`,
- `running`,
- `reconnecting`,
- `verifying`,
- `succeeded`,
- `rolled_back`,
- `failed`,
- `indeterminate`.

Vorgesehene Phasen:

1. `request_validation`
2. `operation_lock`
3. `release_verification`
4. `host_cli_capabilities`
5. `config_preflight`
6. `database_preflight`
7. `backup`, falls erforderlich
8. `image_pull`
9. `container_recreate`
10. `health_verification`
11. `version_verification`
12. `rollback`, nur im Fehlerfall
13. `completed`

Jedes Event enthaelt mindestens:

```json
{
  "eventId": "uuid",
  "sequence": 42,
  "operationId": "uuid",
  "stage": "health_verification",
  "status": "running",
  "message": "Canvas Notebook wird gestartet",
  "occurredAt": "2026-09-04T12:00:00.000Z"
}
```

## Strukturierter CLI-Vertrag

Die Host-CLI soll maschinenlesbare NDJSON-Ereignisse ausgeben, statt Phasen aus
menschenlesbarem Terminaltext abzuleiten:

```json
{"type":"update.phase","stage":"image_pull","status":"running"}
{"type":"update.phase","stage":"container_recreate","status":"succeeded"}
{"type":"update.phase","stage":"health_verification","status":"running"}
{"type":"update.completed","version":"2026.9.4","rolledBack":false}
```

Control Agent und Standalone-Updater konsumieren denselben versionierten
CLI-Vertrag. Menschenlesbare Ausgabe bleibt fuer direkte CLI-Nutzung erhalten.

## Nutzererlebnis

1. Die Systemseite zeigt eine verfuegbare Version und Release Notes.
2. Nur Owner oder berechtigte Administratoren duerfen ein Update starten.
3. Ein Preflight zeigt Readiness, Backupanforderung und erwartete Downtime.
4. Nach Bestaetigung wird die Operation ausserhalb des Containers persistiert.
5. Die UI zeigt laufende Phasen und bittet den Nutzer, das Fenster offen zu
   lassen.
6. Beim Container-Recreate bleibt die bereits geladene Seite aktiv und bezieht
   Status vom stabilen Endpunkt oder verwendet Health-Polling.
7. Nach erfolgreicher Verifikation wird Canvas automatisch neu geladen.
8. Nach Rollback wird die wiederhergestellte Version mit einer verstaendlichen
   Fehlermeldung angezeigt.
9. Bei `indeterminate` zeigt die UI Diagnose- und Supportschritte, ohne Erfolg
   vorzutaueschen.

Standalone-Texte verwenden nur Begriffe wie `System`, `Update`, `Version`,
`Sicherung` und `Neustart`. Control-Plane- und Fleet-Begriffe erscheinen nur im
Managed-Modus.

## Datenbank- und Rollbackvertrag

Ein Image-Rollback ist nur sicher, wenn Schemamigrationen mit der vorherigen
Anwendungsversion kompatibel bleiben. Releases muessen deshalb einen expliziten
Migrationsvertrag einhalten:

- bevorzugt additive Expand-/Contract-Migrationen,
- keine sofortige Entfernung von Spalten oder Tabellen, die die vorherige
  Version noch benoetigt,
- Release-Metadaten kennzeichnen erforderliche Backups,
- riskante Migrationen blockieren ein unbeaufsichtigtes Update,
- Postflight prueft angewandte Migrationen, Health und effektive Version,
- Rollback-Erfolg wird erst nach Health- und Versionsverifikation gemeldet.

## Umsetzung in abgeschlossenen Phasen

### Phase 1: Updatevertrag

- Gemeinsame Typen fuer Operation, Status, Event und Fehler definieren.
- Zustandsuebergaenge und Idempotenzregeln festlegen.
- Release-Manifest und Signaturpruefung spezifizieren.
- CLI-NDJSON-Vertrag definieren.
- Keine Abhaengigkeit zur Control Plane einfuehren.

### Phase 2: CLI-Ereignisse

- Vorhandenen sicheren CLI-Updatepfad um strukturierte Ereignisse erweitern.
- Pull, Recreate, Health, Verifikation und Rollback abdecken.
- Menschen- und Maschinenmodus getrennt testen.

### Phase 3: Minimaler Standalone-Updater

- Socket-aktivierten Dienst implementieren.
- Unix-Socket-API und strikte Operationsallowlist implementieren.
- Operationsjournal, Lock und Neustart-Recovery implementieren.
- Release-Manifest selbststaendig und verifiziert aufloesen.
- Ressourcenbudgets automatisiert pruefen.

### Phase 4: Installer-Integration

- Linux-Installer um Socket und Service Unit erweitern.
- Installation, Upgrade, Deinstallation und Diagnose abdecken.
- Standalone und Managed eindeutig erkennen.
- Sicherstellen, dass nie zwei Update-Verantwortliche aktiv sind.

### Phase 5: Notebook Update Center

- Serverseitige `UpdateBackend`-Abstraktion implementieren.
- Berechtigungen und Audit im Notebook durchsetzen.
- Versionsanzeige, Preflight, Bestaetigung und Fortschritt integrieren.
- Operation-ID browserseitig ueber Reconnect erhalten.

### Phase 6: Downtime-fester Fortschritt

- Read-only Caddy-Route zum Updater bereitstellen.
- Kurzlebige, operationsgebundene Tickets implementieren.
- SSE mit Eventsequenz und Reconnect implementieren.
- Health-Polling ohne Caddy als Fallback testen.

### Phase 7: Managed Backend

- Dieselbe Notebook-UI an die Control Plane anbinden.
- Bestehenden Control-Agent-WebSocket als Managed-Transport beibehalten.
- Lokale autonome Updates im Managed-Modus blockieren.
- Zentrale Policy, Audit und Rolloutautoritaet erhalten.

### Phase 8: Manuelle Plattformen

- Compose-, Coolify- und unbekannte Installationen erkennen.
- Sichere, plattformspezifische Updateanweisungen anzeigen.
- Keinen funktionslosen oder unsicheren Updatebutton anbieten.

## Test- und Sicherheitsmatrix

Mindestens folgende Szenarien muessen automatisiert und in der UI validiert
werden:

- Standalone-Update ohne Control-Plane-Konfiguration.
- Managed Update ohne aktivierten Standalone-Updater.
- Update bei fehlendem oder ungueltigem Release-Manifest.
- Manipulierter Image-Digest oder CLI-Checksumme.
- Gleichzeitiger zweiter Updateversuch.
- Browser-Reconnect vor, waehrend und nach Container-Recreate.
- Updater-Neustart waehrend Pull, Recreate und Health-Verifikation.
- Host-Neustart waehrend einer Operation.
- Health-Fehler mit erfolgreichem Rollback.
- Health-Fehler mit fehlgeschlagenem Rollback.
- PostgreSQL Managed und External.
- Erforderliches Backup erfolgreich und fehlgeschlagen.
- Installation mit Caddy und ohne Caddy.
- Journal-Rotation und Geheimnis-Redaktion.
- Nachweis der Idle- und Laufzeit-Ressourcenbudgets.
- Manuelles Compose/Coolify ohne Host-Updater.

## Akzeptanzkriterien

- Ein nichttechnischer Standalone-Nutzer kann ein Update vollstaendig in der
  Notebook-UI starten und abschliessen.
- Die Operation laeuft weiter, waehrend der Notebook-Container nicht erreichbar
  ist.
- Der Notebook-Container erhaelt keinen Docker-Socket und keine allgemeinen
  Host-Rechte.
- Der Standalone-Updater hat keine Control-Plane-Laufzeitabhaengigkeit und baut
  keine Managed-Verbindung auf.
- Der Updater verbraucht im Idle durch Socket Activation keine Prozessressourcen.
- Managed und Standalone koennen nicht gleichzeitig als Updateautoritaet aktiv
  sein.
- Alle Updateziele sind signiert beziehungsweise ueber verifizierte Metadaten
  auf immutable Digests aufgeloest.
- UI-Fortschritt bleibt ueber Reconnect rekonstruierbar.
- Erfolg, Rollback, Fehler und unklarer Zustand werden korrekt unterschieden.
- Manuelle Plattforminstallationen erhalten klare Anweisungen statt eines
  unsicheren oder wirkungslosen Updatebuttons.
