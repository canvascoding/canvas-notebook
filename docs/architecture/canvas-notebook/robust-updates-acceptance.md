# Robuste App-Updates: Laufzeitabnahme

Datum: 2026-10-02. Die Abnahme erfolgte aus den Branches `fix/robust-app-updates`
in Notebook und Control Plane. Es wurden ausschließlich lokale Testdienste
und die vorhandene VM `canvas-managed-e2e` verwendet.

Geprüfter Quellstand: Notebook `587f72905` auf Basis von `87d45c7ac`,
Control Plane `6efea0d` auf Basis von `79847bd`. Die Änderungen der VM-Abnahme sind in getrennten Commits abgelegt.
Die anschließend geprüfte Integration in `main` ist unten dokumentiert.

Während der Abnahme ist Notebook-`origin/main` auf `4b7e29f31` weitergelaufen.
Der Vergleich damit enthält zusätzliche Kollaborationsänderungen und wird
von GitNexus als HIGH bewertet. Gegen die feste Ausgangsbasis umfasst der
Update-Plan 18 Dateien (63 zugeordnete Symbole, LOW); der Control-Plane-Diff
umfasst fünf Dateien (LOW). Diese VM-Abnahme lag vor der Integration in das inzwischen aktualisierte
`main`. Rebase und erneute Integrationschecks wurden anschließend
durchgeführt; siehe den Abschnitt zur Main-Integration.

## Umsetzung

Die App verwendet ihre Update-API; im verwalteten Modus übergibt diese den
Auftrag an die Control Plane. Der Host-Agent führt die CLI aus. Bei einer
Standalone-Installation übernimmt der Host-Updater den API-Auftrag und ruft
ebenfalls die CLI auf. Die gemeinsame Prozessaufsicht begrenzt Laufzeit und
Ausgaben und beendet bei Abbruch auch die POSIX-Prozessgruppe. Ein erzwungener
Abbruch nach dem Austausch des Dienstes erhält den Status `indeterminate`,
solange der endgültige Zustand nicht bestätigt ist.

Ein Client speichert vor dem Start eine UUID. Notebook und Control Plane
binden diese dauerhaft an Kanal und erwartetes Release; ein Wiederholungsstart
mit derselben UUID liefert denselben Auftrag. Ältere Server ohne explizite
Capability behalten den bisherigen Request-Vertrag. Die Standalone-Bindung
gilt innerhalb der bestehenden Journal-Aufbewahrung, nicht unbegrenzt.

Der direkte Statuszugang wird erst angefordert, sobald POST oder GET die
Annahme des Auftrags bestätigt. Dadurch kann die vorab reservierte UUID kein
verfrühtes Ticket-404 auslösen; die Oberfläche erhält das Ticket unmittelbar
nach Bestätigung und vor dem Austausch des Dienstes.

Container- und Image-Inspektionen verwenden die lokale Docker Engine API mit
Versionsaushandlung, validierten Antworten sowie Zeit- und Größenlimits.
Remote-/TLS-Kontexte und explizite API-Versionen bleiben über die CLI
kompatibel. Docker Compose führt weiterhin den eigentlichen Dienstwechsel aus.

## QA-Inventar

| Verhalten | Prüfung und erwarteter Nachweis |
| --- | --- |
| Aktueller Produktionsstand | Hostbuild vor Dockerbuild; frische Images aus beiden Worktrees; eine aktive Notebook-Testinstanz |
| Anmeldung | Echter Bootstrap-Admin-Login über die Oberfläche |
| Verfügbarkeit | Verwalteter Modus, konkretes Release, Startbereitschaft und `idempotentStart` |
| Bestätigung | Dialog öffnen und abbrechen: kein neuer Auftrag; erneut öffnen und bestätigen: genau ein Auftrag |
| Verlorene Startantwort | Browser leitet den echten POST weiter und verwirft die Antwort; UUID steht bereits vor dem POST im Browser-Speicher |
| Wiederaufnahme | GET und Seitenreload finden denselben Auftrag wieder; Startabsicht wird nach bestätigter Annahme entfernt |
| Idempotenz und Konflikte | Live: acht Wiederholungen desselben Schlüssels liefern denselben Auftrag; geänderte Bindung wird abgewiesen. Neuer konkurrierender Schlüssel: Control-Plane-Service-/Route-Regressionen |
| Hostausführung | Aktueller Agent ruft aktuelle CLI auf; unveränderlicher Image-Digest und Container-ID wechseln wirklich |
| Neustartphase | Enger direkter Statuszugang bleibt während der App-Unterbrechung lesbar und zeigt Fortschritt |
| Abschluss | Erfolg erst nach CLI-Health-/Imageprüfung und zentralem Postflight; keine zweite Ausführung |
| Darstellung | Separate visuelle Prüfung von Dialog, Fortschritt und Abschluss bei 1440×1000 und 390×844; kein horizontaler Überlauf |

Die verlorene Antwort und ein Reload während der Wiederaufnahme sind die
beiden gezielt geprüften Fehlerpfade. Zusätzlich prüfen API-Konflikte, dass
ein unsicherer Start nicht zu einer weiteren Ausführung führt.

## Bereits abgeschlossene Regressionen

- Prozessaufsicht: echte Prozesse und widerspenstige Kindprozesse, Timeout,
  Abbruch, Signalaustritt, erneuter Start und unbestätigter Zustand nach Apply.
- Standalone-Start: echte Unix-HTTP-Schnittstelle und atomare Journaldateien;
  parallele Startversuche, verlorene Antwort, Neustart, verwaiste Receipt-Datei
  und injizierter Schreibfehler.
- Oberfläche: Persistenz vor POST, Wiederaufnahme, verspätete Antwort,
  temporäres 404, ältere Server ohne Capability und Authfehler 401/403.
  Zusätzlich: kein verfrühter Ticket-Request, sofortiger Ticket-Erwerb nach
  GET-Bestätigung, direkter Status während App-Unterbrechung und keine
  zusätzliche Ticket-Schleife pro Status-Snapshot bei 401/403.
- Control Plane: dauerhafte Request-ID, parallele Starts, Bindungsprüfung und
  Wiederaufnahme nach Annahme bzw. Abschluss; echte Route-/Backend-Integration.
- Docker Engine: zwölf Fixture-Gruppen für Socket-/Context-Auswahl,
  API-Verhandlung, strukturierte Inspektion, 404, Protokollfehler, Größenlimits
  und absolute Fristen. Timeout oder Abbruch einer CLI-Leseabfrage wird nicht
  als fehlender Container interpretiert.
- Live-Abgleich am OrbStack-Docker-Socket: Engine-Container-/Image-IDs und
  Laufzustand entsprechen der Docker-CLI.
- Vollständige Notebook-Typprüfung und Produktionsbuild, CLI-Typprüfung,
  Control-Plane-API-Typprüfung sowie frische Docker-Produktionsbuilds.

Der erste lokale Docker-Start scheiterte an zu restriktiven Rechten der
generierten Public-Assets durch eine private Build-`umask`. Die Abnahme
verwendet den erneut gebauten Stand mit normalen Asset-Rechten; dessen
Lesbarkeit als Container-Benutzer `node`, Healthcheck und Admin-Login wurden
vor dem VM-Test bestätigt.

## Lokale Ende-zu-Ende-Abnahme

Der erste reale Lauf (`a9683e71-6697-4705-b99b-d7d0cdd301bd`, Source
`24f345313`) bestätigte Containerwechsel, acht parallele Same-ID-Replays,
Bindungskonflikt und genau einen Update-Auftrag. Er zeigte zugleich die
verfrühte Ticket-Anfrage vor Annahme. Diese Lücke ist mit `587f72905` behoben
und durch zusätzliche UI-Regressionen abgesichert.

Der zweite reale Lauf (`0a183047-c266-4b08-9f39-33e4b61ab17a`, Source
`587f72905`) bestätigte die behobene Ticket-Reihenfolge und den realen
Dienstwechsel. Der Testtreiber lud die Seite zu spät, bereits während der
App-Unterbrechung, neu. Daher wurde der komplette Browserpfad mit sofortigem
Reload im dritten Lauf erneut geprüft. Alle drei Läufe verwenden bewusst
verschiedene UUIDs; innerhalb eines Laufs entsteht jeweils genau ein Auftrag.

**Abschließende Abnahme: bestanden.** Der dritte Lauf verwendet Notebook
`587f72905` und Control Plane `6efea0d`, frisch gebaute Produktionsimages,
den regulär installierten aktuellen Host-Agent und die aktuelle CLI.

| Nachweis | Ergebnis |
| --- | --- |
| Auftrag | `dc2640bf-e750-42c3-8dcb-e55059bf78c8` |
| Release | `758bc93c-42b7-4300-8473-c58262fee8c7` |
| Startantwort | Reales HTTP 202 angenommen, anschließend im Browser absichtlich verworfen |
| Reload / Wiederaufnahme | Reload 00:30:31.697 UTC; GET bestätigt dieselbe UUID um 00:30:32.318 UTC; Startabsicht wird entfernt |
| Browser-Requests | Genau ein Start-POST und ein Status-Ticket; kein Ticket vor bestätigter Annahme |
| Parallele Wiederholungen | Acht HTTP-202-Antworten, identische UUID; Auftragszahl bleibt 15; vor dem initialen Start waren es 14 |
| Geänderte Release-Bindung | HTTP 409 `request_conflict` |
| Reale App-Unterbrechung | 57 fehlgeschlagene Health-Samples zwischen 00:30:40.149 und 00:31:36.191 UTC |
| Direkter Fortschritt währenddessen | 28 erfolgreiche Control-Plane-Statusantworten; beobachtete Sequenz steigt von 32 auf 63 |
| CLI-Abschluss | Exit 0, 00:31:38.713 UTC |
| Zentraler Postflight | Heartbeat verifiziert, 00:31:40.361 UTC |
| Browser-Abschluss | `succeeded` erst danach, um 00:31:41.002 UTC |
| Laufzeitwechsel | Neue Container-ID und neuer unveränderlicher Image-Digest; Heartbeat meldet Ziel-Digest und `healthy` |
| Docker Engine | Reale installierte CLI liest Container-/Image-Zustand über Unix-Socket ohne Docker-Unterprozess |
| Statuszugang | Zehn Prüfungen einschließlich ungültiger/abgelaufener Tickets, anderer UUID/VM, falschem Origin und CORS-Preflight bestanden |
| Oberfläche | Dialog, Fortschritt und Abschluss auf Desktop/Mobil geprüft; kein horizontaler Überlauf; keine Browser-JavaScriptfehler |

Die zwei Abschluss-Screenshots zeigen denselben tatsächlich abgeschlossenen
Auftrag nach erneuter Wiederaufnahme seiner UUID. Das erfolgte nach dem
automatischen Seitenreload; es wurde dafür kein neues Update gestartet.

Die [Browser-Evidenz](robust-updates-evidence/browser-proof.json) enthält
Requests ohne Ticket-Query, Statuszeitpunkte, echte Health-Samples und 15
bestandene Checks. Die [Host-/Control-Plane-Evidenz](robust-updates-evidence/managed-update-proof.json)
enthält die geprüften Quellstände, CLI-/Agent-Hashes, Idempotenznachweise,
Containerwechsel und zentralen Postflight. Secrets, Tickets und rohe
Laufzeitkonfigurationen sind aus den Exporten ausgeschlossen.

## Grenzen der Abnahme

Der reale Dienstwechsel lief unter Linux arm64 in der lokalen verwalteten VM.
Das signierte Testrelease ist ein `image_rebuilt` derselben echten Version
`2026.10.1.2`: RootFS und Laufzeitkonfiguration entsprechen dem finalen
Produktionsbuild, zusätzliche Image-Metadaten erzeugen den neuen Digest.
Ein Versionssprung auf ein anderes öffentliches Release und ein erzwungener
Rollback wurden live nicht ausgeführt. Der Standalone-Pfad wurde mit echten
Prozessen, Unix-HTTP und Journaldateien geprüft, nicht mit einer zusätzlichen
kompletten Standalone-VM. Remote-/TLS-Docker-Kontexte sind durch die
Kompatibilitätsregressionen abgedeckt. Für den Test erlaubte HTTP-Origins sind
explizit auf die lokale Umgebung begrenzt.

Ein konkurrierender *neuer* Request-Schlüssel wurde im Live-Lauf nicht
abgeschickt, damit der Test nach einem möglichen Abschluss keinen weiteren
Auftrag startet. Dieser Konflikt wird durch die Control-Plane-Service-/Route-
Regressionen geprüft. Die Integration in das inzwischen fortgeschrittene `main` wurde
anschließend mit den unten aufgeführten Checks geprüft.

## Bilder und bereinigter Abschlusszustand

| Ansicht | Desktop | Mobil |
| --- | --- | --- |
| Bestätigungsdialog | [Bild](robust-updates-evidence/03-confirm-desktop.png) | [Bild](robust-updates-evidence/04-confirm-mobile.png) |
| Reale Update-Vorbereitung | [Bild](robust-updates-evidence/05-progress-desktop.png) | [Bild](robust-updates-evidence/06-progress-mobile.png) |
| Echter bestätigter Abschluss | [Bild](robust-updates-evidence/07-success-desktop.png) | [Bild](robust-updates-evidence/08-success-mobile.png) |

Der Dialog wurde im realen Lauf geöffnet, abgebrochen und anschließend
bestätigt. Seine ersten Screenshots erfassten die Übergangsanimation.
Die verlinkten Dialogbilder wurden deshalb ergänzend mit einer expliziten
[UI-Fixture](robust-updates-evidence/dialog-visual-proof.json) aufgenommen;
der Start-POST war dabei blockiert und wurde nicht ausgelöst. Sie sind ein
separater Darstellungsnachweis, kein zusätzlicher Live-Update-Lauf. Alle
verlinkten Aufnahmen wurden visuell geprüft.

Die [ursprüngliche Host-Anzeige](robust-updates-evidence/01-host-manual-desktop.png)
und die [reale VM-Startbereitschaft](robust-updates-evidence/02-managed-ready-desktop.png)
sind ebenfalls dokumentiert.

Um 00:37:08 UTC war die Bereinigung abgeschlossen: genau eine frisch
recreatete Host-Notebook-Testinstanz aus dem finalen Image, kein laufendes
VM-Notebook, VM-Agent gestoppt und Test-Tunnel beendet. Alle vier Dienste
sind healthy; Bootstrap-Login und lokale Team-Seat-/License-/Workspace-/
Ollama-Fixtures wurden nochmals geprüft. Ursprüngliche CP-/VM-Präferenzen,
Credentials und Daten sind erhalten. Die Historie bleibt bei 15 Aufträgen,
0 aktiv. Die separate lokale Instanz auf Port 3000 wurde nicht verändert.
Der [Cleanup-Nachweis](robust-updates-evidence/cleanup-proof.json) enthält
die geprüften Zustände; der reguläre Testzugang ist wieder
`http://127.0.0.1:3100`.

## Geprüfte Integration in main

Auf ausdrücklichen Wunsch wurden beide Branches am selben Tag auf den
aktuellen Remote-Stand rebasiert. Notebook-Basis:
`4b7e29f31c906c41d00850495eba6b1c14abfd32`; Control-Plane-Basis:
`79847bd4fa6be70350661e3974ef3ed383fddbae`. Beide Rebases sind konfliktfrei.
Alle sechs ursprünglichen Notebook-Commits sind laut `git range-diff`
inhaltlich unverändert. Der zentrale Ticket-Fix entspricht jetzt
`28d8dce4f`; der Control-Plane-Commit bleibt `6efea0d`.

Nach dem Rebase wurden folgende Prüfungen erneut erfolgreich ausgeführt:

- Vollständiger Notebook-Produktionsbuild und `tsc --noEmit`.
- Gesamte System-Update-/UI-Suite, echte Standalone-Idempotenz,
  Lifecycle, Updater und Apply-Gate.
- Notebook-Backend-/Auth-/Route-Integration gegen den geprüften
  Control-Plane-Quellstand.
- Zwölf Docker-Engine-Tests, portable CLI-Regressionssuite und CLI-Typecheck.
- Sämtliche elf Skripte von `npm run test:postgres:startup`, einschließlich
  Health-Timeout, Serverstart und Scheduling.
- Control Plane: 23 fokussierte Service-/Route-/Rollback-/Event-Tests,
  49 Orchestrierungsregressionen mit echter isolierter PostgreSQL-Datenbank,
  API-Typecheck sowie API-/Agent- und Web-Produktionsbuild.

Die neue Health-/Projection-Diagnose auf `main` und der DB-Startpfad wurden
zusätzlich gegen den CLI-Health-Vertrag geprüft. Drei von `main` geerbte
Testfixtures enthielten unvollständige Import-/Server-Mocks. Der separate
Commit `830a03266` aktualisiert ausschließlich diese Fixtures, erhält ihre
bestehenden Assertions und prüft zusätzlich, dass ein Diagnosefehler keine
private Fehlermeldung und keinen falschen Health-Ausfall erzeugt. Die
Produktlogik wurde dabei nicht geändert. GitNexus bewertete die Anpassung
als LOW ohne betroffene Produktprozesse.

Die temporäre Control-Plane-Testdatenbank wurde entfernt. Die bestehende
VM-Update-Historie blieb bei 15 Aufträgen und 0 aktiven Aufträgen. Für den
Rebase wurde kein weiterer VM-Update-Lauf und kein Containerbuild ausgeführt;
die vorherigen realen E2E-Belege bleiben ihrem ursprünglichen Quellstand
zugeordnet, ergänzt durch die Integrationstests oben.

Für keinen der beiden Branches existiert ein zugehöriger PR. Die aktiven
Notebook-Main-Regeln verbieten Löschen und Non-Fast-forward-Pushes; sie
fordern weder PR noch zusätzliche Statuschecks. Der aktuelle Notebook-
Basiscommit hat vier erfolgreiche CodeQL-Checks. GitHub meldet die
Control-Plane-Main-Branch als ungeschützt und ohne Commit-Checks. Beide
Integrationen erfolgen als reguläre Fast-forwards, ohne Force-Push.
