# DA-01: dauerhafte Reservation und atomare Claim-Sperre

Stand: 27. September 2026, aufbauend auf `2d4e38b0c`. Teil des
[Distributed-Admission-Plans](distributed-admission-plan.md). **Keine vollständige
Lifecycle-Übergabe, keine Aktivierung und kein Abschluss von FVRC-1008.**

## Implementierung

Eine additive Migration legt drei Tabellen für Requests, reservierte
Pfadbereiche und konkrete Dokumenttargets an. Sie verändert keine alten
Zustände. Ein partieller Unique-Index verhindert mehrere aktive Targets für
dasselbe Dokument; der optionale Receipt-Fremdschlüssel bereitet dessen spätere
Retention-Bindung vor. Er wird in DA-01 noch nicht als Release-Nachweis gesetzt.

Der interne Dienst erhält seine Verbindungen ausdrücklich über einen Adapter.
Er hat keinen produktiven Aufrufer und erteilt keine Rechte auf ein Dokument.
Actor, Aktion und fachlicher Digest, vollständige Scopes und erwartete
Dokumentidentitäten werden vor dem ersten `await` kopiert, geprüft, eingefroren
und kanonisch gehasht. Dieselbe Request-ID mit verändertem Auftrag ist kein Retry.

Reservation: Request-ID-Xact-Guard → sortierte Workspace-Admission-Xact-Guards →
Scope-Überlappung prüfen → Zustandszeilen in stabiler Reihenfolge sperren →
exakte erwartete Dokumentmenge prüfen → Request/Scopes/Targets gemeinsam
committen. Alle aktiven Dokumente in den Scopes und ausdrücklich ausgewählte
archivierte Generationen müssen genau übereinstimmen. Der aktuelle Owner wird
mit Epoch, Token und Backend-Identität erfasst, nicht vorzeitig invalidiert.

Scopes sind segmentweise und literal: `a/` sperrt nicht `ab/`, `%` und `_` sind
keine SQL-Wildcards. Leere Zielbereiche werden auch ohne vorhandenes Target
reserviert. Ein Organisationswechsel innerhalb derselben Workspace-ID umgeht
die Sperre nicht. Limits: 64 Scopes, 16 Workspaces, 1024 Dokumente; keine
stillschweigende Kürzung eines zu großen oder inzwischen geänderten Footprints.

Owner-Claim: BEGIN → Workspace-Admission-Guard → Scope- und aktive Targetprüfung
→ nicht blockierender Owner-Try-Lock → Zustand/Scope prüfen → Epoch/Token/COMMIT.
Bei Reservation oder gehaltenem Room-Lock wird zurückgerollt; dieselbe
Owner-Sitzung bleibt danach benutzbar. Kein Warten auf den Room-Lock unter dem
Admission-Guard. Bestehende Owner-Stores und Releases prüfen die Reservation
bewusst nicht und können den finalen gefenceten Store weiterhin abschließen.

Nur ein noch nicht gestarteter Request kann explizit abgebrochen werden:
gebundene Identität, Header-CAS und unveränderte Target-Phase werden geprüft.
Request-Abschluss und Deaktivierung seiner Targets sind atomar. Angefangener
Drain, gesetzter Release-Beleg oder ungewisse Folgephase werden nicht durch
diesen Abbruch freigegeben. Es gibt keinen TTL- oder Restart-Autoclear.

Die gemeinsame Lifecycle-Transaktionsmechanik behandelt verlorene COMMIT-
Antworten: unsichere Verbindung zuerst verwerfen, dann den exakten gespeicherten
Request beziehungsweise Cancel-CAS auf einer frischen Verbindung prüfen. Fehlt
der Nachweis, bleibt `ADMISSION_RECOVERY_REQUIRED`; kein kompensierendes Delete
und kein blindes Wiederholen mit einer neuen ID. Read-only-Recovery hält die
Header-Sperre auch beim Lesen ihrer Targets, damit kein zerrissener Status entsteht.

## Verifikation

- Sieben reine Vertragstests: kanonischer Digest, unveränderliche Kopien,
  Identitäts-/Pfadvalidierung, Org-Drift, segmentweise Überlappung und Grenzwerte.
- Sieben bestehende Owner-Session-Fehlerszenarien bleiben grün. Der Fake kennt
  die beiden neuen Admission-Queries ausdrücklich; unbekannte SQL bleibt ein Fehler.
- Echte bestehende PostgreSQL-Ownership-Suite grün, inklusive Claims, finalen
  Writes, Epoch-Wechsel, verlorener Sitzung und Commit-Antwortverlust.
- Sechs echte PostgreSQL-Release-Szenarien grün, inklusive verlorener Antwort,
  kausaler Löschungsprüfung und fehlendem Receipt bei nicht committetem Release.
- Komplette Lifecycle-Suite einschließlich tatsächlicher Hocuspocus-Pfade und
  regulärer Migrationsabdeckung grün. TypeScript und fokussiertes ESLint grün.
- Produktionsbuild mit 353 Seiten und Lizenzprüfung grün.

Logs dieser Prüfungen unter `/tmp/fvrc1008-admission-`: `owner-pg.log`,
`release-pg.log`, `lifecycle-first.log`, `types-first.log`, `lint-final.log`,
`build.log`. Abschließendes TypeScript: `types-final.log`.

GitNexus vor dem Commit: staged 15 erwartete Dateien, 92 berührte Symbole,
0 zugeordnete Prozesse, automatisch LOW. Das ersetzt nicht die vorherige
Impact-Warnung für die zentrale Migration (CRITICAL, 42 direkte Abhängigkeiten).
Der gesamte Branchvergleich gegen `main` bleibt CRITICAL: 273 Dateien,
2603 berührte Symbole und 30 Prozesse. Keine Gesamtbranch- oder Mergefreigabe.

### Neue echte PostgreSQL-Abnahme

`scripts/collaboration-room-admission-postgres-test.ts` besteht auf PG18 mit
getrennten Backend-Verbindungen. Zwei erzwungene Interleavings halten je einen
wirklichen COMMIT an; `pg_blocking_pids` und `wait_event_type = Lock` belegen
das tatsächliche Warten für Claim-vor-Reservation und Reservation-vor-Claim.
Danach entsteht entweder der exakte Owner-Snapshot oder ein sauber verweigerter
Claim ohne Epoch-Sprung. Dieselbe Sitzung übernimmt nach bestätigtem Cancel
erfolgreich; reine Verweigerung ist nicht das einzige Orakel.

Während einer aktiven Reservation speichert ein expliziter Test-Writer echte
Yjs-Bytes und Vector unter Row-Lock und dem produktiven Owner-Fence. Anschließend
erstellt der produktive durable Release den exakten Receipt für Token/Sequenz.
Der Target bleibt ausdrücklich noch `reserved`, aktiv und ohne Receipt-Bindung:
die atomare Target-Bestätigung ist erst DA-02. Dieser Writer ist kein vollständiger
Hocuspocus-Pfad; die bestehende Owner-PG-Suite prüft separat den produktiven
`persistCollaborationYDoc`-Pfad.

Weitere belegte Fälle: konkurrierende leere Zielbereiche, disjunkte Scopes,
Workspace-Root, literale `%`/`_` und `a` gegenüber `ab` in den echten SQL-Abfragen,
vollständiger Subtree, exakt ausgewählte Archivgeneration, unerwarteter zusätzlicher
Zustand, Scope-/Identitätsdrift, Mutation der Caller-Arrays, gebundene Retries und
frische Serviceinstanz. Ein bereits begonnenes Target verhindert Cancel.

Reserve- und Cancel-COMMIT werden tatsächlich ausgeführt, dann wird ihre Antwort
gezielt verloren. Erst nach Schließen des unsicheren Backends darf eine neue
Verbindung den exakten Beleg lesen. Bei abgelehntem COMMIT wird dagegen kein
Request bestätigt; ein Retry mit **derselben ID** nach dem Absenznachweis besteht
einschließlich anschließendem Cancel. Bei fehlgeschlagenem Discard erfolgt gar
kein automatischer Recovery-Read. Keine TTL oder blindes kompensierendes Delete.

Finaler Lauf mit Exit 0 und erfolgreichem UUID-Schema-Cleanup:
`/tmp/fvrc1008-admission-postgres-verified.log`. Ein früherer Shell-Wrapper benutzte
versehentlich eine read-only zsh-Variable; für dessen äußeren Exitstatus wird
keine Abnahme behauptet. Die nachfolgenden sauberen Läufe und der abschließende
erweiterte Test sind grün. Tests mit mehreren Backends und neuer Serviceinstanz
sind ausdrücklich noch kein Zwei-App-Prozess- oder Betriebssystem-Crashtest.

### Browser-Regressionen am aktuellen Host-Dev

Personal-B/C besteht in **29,8 s**, Team-B/C in **19,1 s**. Nach Annahme von C
bleibt B als konkreter Konflikt mit separater/ersetzender Weiterbearbeitung
sichtbar; kein Timeline-Fehler. Personal „10 → 3 einzeln → 7 gemeinsam“ besteht
in **58,2 s**, der entsprechende Team-Fall in **54,6 s**, jeweils mit exaktem
Endtext, vier neuen Inhaltsrevisionen und idempotenten Wiederholungen. Alle vier
Ergebnisscreenshots wurden visuell geprüft.

Der erste Personal-Aufruf startete vor der HTTP-Bereitschaft und scheiterte
schon beim Login mit `ECONNREFUSED`. Er zählt nicht als bestandener Test; nach
positivem Healthcheck wurde er ohne abgeschwächte Assertions wiederholt.
Logs/Reports: `personal-conflict-r2`, `team-conflict`, `personal-batch`, `team-batch` unter
dem Präfix `/tmp/fvrc1008-admission-`. Browser seriell, je ein Worker, mindestens
55 Sekunden Abstand nach bestätigtem Abschluss.

Diese Browserläufe verwenden den normalen Server ohne aktivierte Ownership.
Sie belegen UI-/Tool-Regressionen, nicht eine schon produktiv angeschlossene
verteilte Übergabe. Deren DA-01-Nachweis steht im getrennten PG-Test oben.

## Grenzen und nächste Arbeit

DA-01 bindet noch keinen Owner-Drain an ein Target-Ack, beweist keine Vacancy,
benachrichtigt keinen anderen Prozess und autorisiert keine Lifecycle-Mutation.
Normaler snapshotloser Unload bleibt ausdrücklich kein dauerhafter Nachweis.
Read exponiert bisher den eingefrorenen Target-Ausgangszustand, nicht eine
bereits implementierte Drain-/Receipt-Fortschrittsmaschine.

Vor Aktivierung fehlen DA-02 bis DA-06: Owner-Benachrichtigung und atomarer
Receipt-/Target-Abschluss, normaler Unload und Crash-Recovery, gehaltener
Coordinator-Guard, sämtliche Dokument-/Agent-Neuzulassungen und Domainpfade,
Zwei-App-Prozess-Nachweis und Mixed-Version-Gate. Der bestehende
`room_owner_epoch > 0`-Lifecycle-Schutz wird nicht gelockert.

Der Default-Server aktiviert weiterhin keine Owner-Session. Lesender Preflight
des verwalteten App-Datenbestands nach Start des neuen Codes: **0 Owner-Epochen
größer null, 0 Admission-Requests**. Abschließender lesender Check nach allen vier
Browserfällen bestätigt diese Werte und **0 verbliebene Admission-Testschemata**.
Host-Dev auf Port 3000 (PID 34864), bestehende
Container unverändert; Port 3100 enthält weiterhin das ältere Image. Keine
Dependencies, Lockfiles, Secrets oder Lizenzdaten wurden verändert.

Die Datenbank-Harnesses verwenden ausschließlich eigene UUID-Schemata an der
verwalteten PG18-Instanz und entfernen sie nach Schließen ihrer Verbindungen.
Das ist keine vollständige Mehrprozess-/Crash-Abnahme und keine Produktionsfreigabe.
