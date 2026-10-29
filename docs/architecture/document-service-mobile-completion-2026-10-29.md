# Dokumentservice: mobiler Speicherabschluss

Stand: 29.10.2026. Der ausdrücklich aktivierte mobile Recovery-Test meldete am
Produktstand `dc6bece03312c0779d310c09dc07dfe226e6378b` beim ersten Speichern
HTTP 500. Die native Änderung und ihr dauerhafter Operationsbeleg waren bereits
gespeichert. Das vollständige Serverprotokoll zeigt `ADMISSION_CONFLICT` in der
abschließenden Prüfung des Direct-Activity-Handlers. Ein anschließender gebauter
Linux-Lauf zeigt dieselbe Writer-Prüfung auch beim tatsächlichen Dokumentlesen
innerhalb der Antwortbildung. Der jeweilige historische konkurrierende
Lock-Inhaber ist nicht aufgezeichnet; seine genaue Herkunft bleibt unbekannt.

## Änderung

Die feste Prüfung nach Rückkehr des Verbrauchers und die interne aktuelle
Prüfung des installierten Dokumentlesers verwenden die vorhandene gemeinsame
Admission-Prüfung. Die Änderung betrifft nur die gebundene Direct-Activity eines
Benutzers; normale Aufrufe ohne diese Sitzung behalten ihren bestehenden Ablauf.
Aktuelle Sitzung,
Berechtigungen, Workspace-/Organisationszuordnung, native Dokumentidentität,
Owner und aktive Reservierungen werden weiterhin geprüft. Eine echte exklusive
Workspace-Sperre wird weiterhin abgewiesen. Der gemeinsame Leser und seine
generischen Aufrufverträge werden nicht umgeschrieben.

Eintritt und sämtliche vom Verbraucher erreichbaren Prüfmethoden behalten die
strenge Writer-Prüfung. Auch die tatsächliche native Mutation behält ihre eigene
Writer-Prüfung. Öffentliche Methoden nehmen keinen wählbaren Prüfmodus
entgegen. Excalidraw behält auch beim Abschluss seine bestehende strenge Prüfung.
Fehlerabbildung, Zeitlimits und Wiederholungen wurden nicht geändert.

## Nachweis

Der neue Test `scripts/native-direct-activity-completion-postgres-test.ts`
verwendet den tatsächlichen Serverhandler, Better Auth, native Dokumentdaten und
PostgreSQL. Ein zweiter echter Datenbankclient hält seine Sperre erst nach dem
streng autorisierten Eintritt. Fünfzehn Gruppen bestehen:

- unveränderter Kontrollaufruf und erneut erfolgreicher Kontrollaufruf nach Fehlern;
- Abschluss unter einer wirklichen gemeinsamen Lesersperre;
- Ablehnung einer exklusiven Sperre und einer tatsächlich angelegten Reservierung;
- weiterhin strenge öffentliche Prüfmethode trotz zusätzlicher Auswahlargumente;
- Ablehnung einer abgelaufenen Sitzung und einer geänderten nativen Identität;
- Ablehnung einer nach ihrem Lebensende verwendeten Sitzungsfassade;
- tatsächliches Dokumentlesen unter der gemeinsamen Sperre, mit exakt
  unverändertem Originaltext einschließlich abschließender Newline;
- Ablehnung exklusiver Sperren, Reservierungen, abgelaufener Sitzungen und
  geänderter Identitäten durch den tatsächlichen Leser;
- Ablehnung eines anderen Dokuments innerhalb der gebundenen Sitzung;
- weiterhin abgewiesene native Mutation unter derselben gemeinsamen Lesersperre,
  ohne Aufruf des eigentlichen Mutationscallbacks.

Die Gruppen prüfen die tatsächlichen Fehlerklassen beziehungsweise Fehlercodes.
Bei lesenden Fällen bleiben Registry- und Native-Zeilen einschließlich `xmin`
sowie Dateibytes unverändert. Die bewusst veränderten eigenen Fehlerfixtures
werden wiederhergestellt; nur deren dabei zwangsläufig verändertes `xmin` wird
ausdrücklich neu beobachtet. Eigene Schemas, Dateien, Pools und Clients werden
geschlossen beziehungsweise entfernt; es erfolgen keine externen Fetches.

Ein privates `git archive` des genannten bisherigen Produktstands enthält nur
den neuen Test und seine Runner-Registrierung als Teständerungen. Das native
Dateisystemmodul wird aus dessen eigener C-Quelle gebaut. Derselbe echte Test
scheitert dort an der gemeinsamen Lesersperre mit `ADMISSION_CONFLICT`; auch der
Fehlerlauf bereinigt seine Ressourcen vollständig. Der erweiterte tatsächliche
Lesefall reproduziert am Produktstand
`f5df88e5a551dd3827ef431a00905668b9897c1a` außerdem den zweiten Konflikt, bevor die
interne Leseprüfung korrigiert wird. SQL-Ergebnisse, Autorität und IO-Ergebnisse
werden für keinen dieser Nachweise ersetzt.

Die bestehenden PostgreSQL-Suiten `authenticated-native-session-transport` und
`native-document-search-room` bestehen mit der Änderung. Die erweiterte
TypeScript-Prüfung erfasst 23 Wurzeln und 5.120 Quelldateien ohne Diagnose;
Release-TypeScript und ESLint bestehen ebenfalls. GitNexus ordnet die geänderten
bestehenden Symbole dem erwarteten Server-/Runner-Bereich zu. Die dynamische
Reichweite des gemeinsamen Lesers ist mit 79 Symbolen und 13 direkten Aufrufern
als CRITICAL eingestuft; die Produktänderung bleibt deshalb im privaten
Direct-Activity-Kontext, mit gesondertem Nachweis der unverändert strengen
Schreibgrenzen.

## Gebaute UI-Abnahme

Am Produktstand `32880bee06531b816df918a3e9d64679cc4c549f` bestehen der vollständige
Host-Build, der frische Linux-Build und der echte Containerstart. Das Image ist
`sha256:18cac533c0fe13b8e33424a9716ceb7267a0380426b27199170aac9f15a8bf03`.
Nur der verwaltete Notebook-Container wurde ersetzt. Dieselbe PostgreSQL-
Testdatenbank und dieselben Volumes bleiben erhalten; alle elf anderen Container
behalten ihre Identität.

Ein unverändertes `git archive` dieses sauberen Produktstands dient als privater
Linux-Testtreiber mit eigenen Entwicklungsabhängigkeiten. Es gibt keine Overlays
von Produktquellen. Alle sieben ausdrücklich aktivierten Recovery-/Linkfälle
bestehen mit einem Worker, null Retries, null Skips und null Flakes in 254.447 ms.
Die 15 aktuellen Python-Speicherfälle und alle neun CI-Prüfungen bestehen ebenfalls.
Review Center ist in der Testinstanz ausgeschaltet; die vorhandenen Prüfungen der
Undo-Freigabepolitik bleiben unverändert.

Der mobile HTTP-Fall bestätigt beim absichtlich gesperrten Dateiexport eine
dauerhafte native Änderung mit `projectionPending`. Eine Wiederholung behält die
ursprüngliche Operations-ID und erhält spätere Peer-Änderungen; ein anderer Inhalt
unter demselben Schlüssel wird mit `IDEMPOTENCY_CONFLICT` abgewiesen. Auch Legacy-
Wiederholungen behalten ihre Operations-ID. Die übrigen Fälle prüfen unterbrochenen
ersten Sitzungsaufbau, explizite Create-Recovery sowie Frontmatter-Links und
Reparaturen nach Rename/Move. Der visuell geprüfte Webeditor zeigt die erwarteten
abschließenden Inhalte `Legacy` und `Peer Keep`.

Alle zehn Abschnitte der geschützten ursprünglichen Upload-Probe sind nach dem
gesamten Browserlauf exakt gleich: Registry-/Native-/Birth-/Receipt-Zeilen mit
`xmin`, Originalbytes und Identitäten einschließlich der Speicheranker. Das
Browser-Artefaktarchiv hat SHA-256
`dde488ee1e52b99a8555749873082f73ca94e78ac60229e57ac56030bb26d33f`.

## Verbleibende Abnahme

Diese Abnahme umfasst den mobilen HTTP-Speicherweg mit aktivem Webeditor und die
genannten Recovery-/Linkfälle. Die letzte vollständige reguläre Gesamtsuite gilt
weiterhin für `dc6bece03`; der endgültige Produktstand muss sie erneut bestehen.
Leistungsbudgets, übrige Servicepakete, abschließende Desktop-/Mobilmatrix,
Produktionsbackup/-restore und Deployment des
[Gesamtplans](../document-write-database-performance-plan.md) bleiben erforderlich.
