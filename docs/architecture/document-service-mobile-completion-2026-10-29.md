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

## Offene Abnahme

Am Stand `f5df88e5a` bestehen Host-/Linux-Build, Start, neun CI-Prüfungen und sechs
der sieben aktivierten Recovery-/Linkfälle. Der mobile Fall bleibt wegen der
internen Reader-Prüfung rot. Die ursprünglichen geschützten Daten bleiben auch
nach diesem vollständigen Fehlerlauf exakt erhalten. Mit der ergänzten Korrektur
stehen ein neuer Linux-Container, der tatsächliche mobile Recovery-Ablauf und die
abschließende Gesamtsuite noch aus. Der gezielte
Handler-Test benötigt keinen geladenen Dokumentraum; der Browserfall muss auch
Mutation, Raum-Owner und dauerhaften Beleg zusammen prüfen. Der Fix ist keine
Leistungsabnahme und kein Produktionsdeployment. Sämtliche übrigen Pakete des
[Gesamtplans](../document-write-database-performance-plan.md) bleiben erforderlich.
