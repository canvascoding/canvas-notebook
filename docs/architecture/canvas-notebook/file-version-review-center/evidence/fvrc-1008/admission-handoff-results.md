# DA-03/04: dauerhafter SQL-Übergabeabschluss

Stand: 27. September 2026, aufbauend auf `73f3c3453`.
Teil des [Distributed-Admission-Plans](distributed-admission-plan.md).
**Separater Protokollbaustein, noch keine Domain-/Runtime-Aktivierung.**
Vollständige Owner-Crash-Recovery, DA-05/06, FVRC-1008 und P12 bleiben offen.

## Ausführbarer Auftrag und atomarer Abschluss

Neue Aufträge können die konkreten Aktionsparameter als `actionPayloadText`
speichern. Der kanonische JSON-Objekttext ist begrenzt (64 KiB, Tiefe 16,
4096 Knoten) und über einen aktionsgebundenen Digest geschützt. Reservierungen
ohne Payload bleiben lesbar, sind über den neuen Handoff aber nicht ausführbar.
Eine neue Coordinator-Instanz kann den ursprünglichen Auftrag anhand seiner ID
laden; andere Parameter unter derselben ID sind kein Retry.

`createCollaborationAdmissionHandoffService().execute()` prüft zuerst die
Aufrufberechtigung, auch bei bereits abgeschlossenen Wiederholungen. Danach
erwirbt es die Room-Advisory-Guards try-only in stabiler Schlüsselreihenfolge
auf einer dedizierten SQL-Verbindung. Erst dann folgt der Workspace-Wrapper.
`prepare` ist für erneute Schreibberechtigung und Domain-/Pfadsperren zuständig.
Unter diesen Sperren werden Request, vollständiger Dokument-Footprint und
sämtliche Quiescence-Belege erneut geprüft. Ein bisher unbelegtes oder neu
hinzugekommenes Dokument verhindert die Mutation.

Die SQL-Domainmutation, exakte Poststate-Snapshots und der Abschluss des
Requests samt Targets liegen in **derselben Transaktion**. Jeder Snapshot
bindet Scope, Status, Generation, Darstellung, Schema, Epoch, Sequence und
vollständige Yjs-/Vektorhashes. Scope muss reserviert sein; Owner-Tuple bleibt
leer, Epoch unverändert, Generation und Sequence dürfen nicht zurückgehen.
Ein begrenztes Metadatenergebnis und die Digests der Eingangsbelege werden
unveränderlich mitgespeichert. Fehler rollen die Mutation zurück; Reservation
und Belege bleiben aktiv.
Schreib- und Lesepfad verwenden dieselbe Ergebnisgrenze von 32 MiB. Eine
Überschreitung wird vor COMMIT abgewiesen, statt einen später unlesbaren Erfolg
zu speichern. Die frühere isolierte Reader-Grenze von 4 MiB war für den
erlaubten Footprint von 1024 Dokumenten mit langen Pfaden zu klein.

Der Workspace-Wrapper umfasst COMMIT und Verbindungsabschluss. Die dedizierte
Verbindung wird auch bei Erfolg verworfen, damit kein Session-Guard in einen
Pool gelangt. Bei verlorenem COMMIT-Reply wird zuerst das alte Backend beendet,
danach der Workspace-Wrapper verlassen und erst dann das exakte historische
Ergebnis frisch gelesen. Ein inzwischen neuer Owner darf diesen Nachweis nicht
blockieren: Die Recovery verlangt keinen neuen Room-Guard und vergleicht nicht
mit dem inzwischen weiterentwickelten Current. Fehlender Beleg oder fehlgeschlagener
Backend-Discard erzeugt keinen Erfolg und keinen automatischen zweiten Write.

Die lesenden Helfer `readOutcome` und `loadRequest` sind interne Coordinator-
Schnittstellen, keine authentifizierten HTTP-Endpunkte. Aufrufende Domainpfade
müssen Auth, fachliche Parameterprüfung, Backup, Journal und Projektion selbst
übernehmen. Dieser Baustein macht Dateisystemschritte ausdrücklich nicht atomar.

## Nachfolgende Aktionen und alter lokaler Finish

Nach Move, Archive oder Darstellungswechsel passt ein ursprünglicher
Release-Receipt nicht mehr zum aktuellen Scope. Dafür ergänzt die Quiescence
den vierten Beleg `lifecycle_outcome`: exakter gespeicherter Poststate eines
abgeschlossenen Requests, kein „neuester“ oder bloß epochgleicher Beleg.
Der neue Request pinnt seinen Vorgänger über einen zusammengesetzten
Fremdschlüssel. Damit kann eine weitere Aktion in derselben freigegebenen
Owner-Epoch fortfahren, ohne eine erfundene Vacancy oder Generation zu erzeugen.

Ein echter `owner_drain` bleibt nach abgeschlossenem Request als exaktes altes
Ticket lesbar und pollbar. Der lokale Finish prüft Outcome, Quiescence, Receipt,
alten Fence und eingefrorene vollständige Livebytes. Er liest weder den neuen
Current noch beansprucht er dessen Guard. Das erlaubt ausschließlich das
Aufräumen der alten lokalen Instanz, keinen Store, Token-Clear oder neuen Drain.
Die bisherigen aktiven Drain-Prüfungen bleiben unverändert streng.

## Verifikation

- Payload-Vertrag **6/6**, lokaler Terminal-Finish **3/3**, erweiterter
  Drain-Schemavertrag **11/11** und die vollständige Lifecycle-Suite bestehen.
- Größenvertrag **2/2**: 1024 maximale, eindeutige escaped Pfade samt IDs und
  begrenztem Metadatenergebnis oberhalb der alten 4-MiB-Grenze roundtrippen
  durch den echten Reader. Oberhalb von 32 MiB verweigert der Writer die
  Serialisierung; der Reader verwirft den Header vor Target-Zugriffen.
  Hier ist nur die SQL-Verbindung simuliert, nicht Reader oder Decoder.
- Echte PostgreSQL-Regressionen für Reservation, Quiescence (**18 Grenzen**)
  und gebundenen Owner-Drain (**10 Grenzen**) bestehen weiterhin.
- Neues Handoff-Harness: **21 geprüfte Fälle**, erfolgreicher SQL-Move, gehaltene Room-Guards vor
  Workspace-Locks, konkurrierender Claim, Same-ID-Retry ohne zweite Wirkung,
  erneute Autorisierung vor Ergebnisrückgabe und frischer Coordinator mit
  tatsächlich geladenem Payload. Eine zweite Aktion nutzt den exakt gebundenen
  Outcome derselben Owner-Epoch.
- Positiver Archive-/Restore-Nachlauf erhöht die Generation auf 2 und 3,
  erhält die vollständigen Yjs-/Vektordaten und die bisherige Owner-Epoch.
  Jeder Folgeschritt verwendet einen neuen, exakt gebundenen Outcome-Beleg.
  Erst der anschließende erfolgreiche neue Owner-Claim erhöht seine Epoch.
- COMMIT-Antwortverlust wird nach Backend-Discard und außerhalb der Workspace-
  Sperre positiv nachgewiesen, auch bei inzwischen aktivem Ersatz-Owner.
  Abgewiesenes COMMIT erlaubt nur einen ausdrücklichen identischen Retry;
  fehlgeschlagenes Discard startet keinen Recovery-Read. Phantomdokumente,
  Callbackfehler und Epoch-/Generation-/Sequence-Rückschritte rollen zurück.
  Ein busy Guard bei mehreren Targets hinterlässt keine zuvor erworbenen Locks.
- Ein echter PostgreSQL-Fall geht durch Claim → gebundenen Drain → finalen
  Release → Proof → Handoff → neuen Claim → nachträglichen historischen Finish.
  Alte Tickets bleiben lesbar, während der aktuelle neue Owner unberührt bleibt.
- Die Migration wird wiederholt und gegen einen bestehenden Drei-Arten-CHECK
  geprüft; auch dieser wird korrekt erweitert. Legacy-Aufträge ohne Payload
  werden nicht ausgeführt.
- TypeScript, fokussiertes ESLint und Produktionsbuild bestehen. Der Peerreview
  fand zunächst den fehlenden Berechtigungscheck im Outcome-Retry. Dieser wurde
  durch den obligatorischen `authorize`-Schritt samt Regressionstest behoben.

Prüflogs: `/tmp/fvrc1008-handoff-lifecycle-verified.log`,
`/tmp/fvrc1008-da04-drain-contract.log`,
`/tmp/fvrc1008-da04-admission-postgres.log`,
`/tmp/fvrc1008-da04-quiescence-postgres.log`,
`/tmp/fvrc1008-da04-drain-postgres.log`,
`/tmp/fvrc1008-handoff-postgres-final.log`,
final einschließlich Archive/Restore: `/tmp/fvrc1008-handoff-postgres-archive-restore.log`,
erneut nach Ergebnisgrößenkorrektur: `/tmp/fvrc1008-handoff-postgres-verified.log`,
`/tmp/fvrc1008-handoff-types-final-verified.log`,
`/tmp/fvrc1008-handoff-admission-final.log`,
`/tmp/fvrc1008-handoff-size-lint-final.log`,
`/tmp/fvrc1008-handoff-lint-verified.log`,
`/tmp/fvrc1008-handoff-build-verified.log`.

Alle PostgreSQL-Fälle verwenden echte getrennte Backends in eigenen generierten
Schemata am verwalteten PG18 auf **55433**. Die Domainmutation im neuen Harness
ist ein expliziter SQL-Testadapter, kein produktiver Rename-/Archive-Aufrufer.
Es ist kein Zwei-OS-Prozess-/Fleet-Test. Der tatsächliche Absturz eines Owners
ohne finalen Receipt bleibt unverändert Recoveryfall, kein Erfolg durch Timeout.

## Browserprüfung und Grenzen

Nach Build wurde nur der eigene Host-Dev-Prozess auf **127.0.0.1:3000** neu
gestartet. Sein Health-Endpunkt bestätigt Auth, Datenbank und Collaboration.
Der unveränderte Notebook-Container auf **3100** verwendet sein älteres Image.
Der einzige Skill-Stack mit Control Plane und PostgreSQL 18.4/pgvector 0.8.3
ist gesund; keine Container wurden gebaut, ersetzt oder zusätzlich gestartet.

Team-B/C besteht in **23,5 s**. Nach C zeigt B einen konkreten Konflikt ohne
Timeline-Fehler; Screenshot visuell geprüft. Report:
`/tmp/fvrc1008-handoff-team-conflict-report/index.html`.
Nach der letzten Größenkorrektur, erneutem Build und frischem Host-Dev-Start
wiederholt: **23,9 s**, `/tmp/fvrc1008-handoff-team-conflict-verified-report/index.html`.
Team „10 → 3 einzeln → 7 gesammelt“ besteht in **55,2 s**: exakter Endtext,
vier neue Revisionen, idempotente Wiederholungen und keine offenen Reviews.
Screenshot visuell geprüft. Report:
`/tmp/fvrc1008-handoff-team-batch-report/index.html`.
Personal-B/C besteht in **18,0 s**; konkreter Konflikt und keine unsichere
Annahme, Screenshot visuell geprüft. Report:
`/tmp/fvrc1008-handoff-personal-conflict-report/index.html`.
Alle Fälle liefen seriell mit einem Worker und mindestens 55 Sekunden Abstand
nach bestätigtem Abschluss. Ein lesender Datenbankaudit findet **0 aktive
Owner-Epochen größer null, 0 Admission-Requests im App-Bestand und 0 verbliebene
Handoff-Testschema-Namespaces**. Keine Lizenz-/Secretänderung.

Die Browserfälle prüfen die normale Review-Oberfläche und ihre existierenden
Backendpfade, nicht den noch deaktivierten Admission-Handoff. Die Runtime
bleibt bis zur separaten Integration und Mehrprozess-Abnahme deaktiviert;
`lockUnchangedLifecycleSnapshot` erlaubt weiterhin keine unbelegte Owner-Epoch
größer null. Kein Push, keine Merge-/Produktionsfreigabe und kein P12-Abschluss.

Die finale GitNexus-Prüfung des eigenen Commitumfangs meldet **LOW**:
18 Dateien, 157 erfasste geänderte Symbole, keine betroffenen indexierten
Prozesse. Der gesamte Branch gegenüber `main` bleibt mit 295 Dateien und
30 betroffenen Abläufen **CRITICAL** und erfordert seine vollständigen Gates.
