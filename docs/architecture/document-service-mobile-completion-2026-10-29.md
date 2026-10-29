# Dokumentservice: mobiler Speicherabschluss

Stand: 29.10.2026. Der ausdrücklich aktivierte mobile Recovery-Test meldete am
Produktstand `dc6bece03312c0779d310c09dc07dfe226e6378b` beim ersten Speichern
HTTP 500. Die native Änderung und ihr dauerhafter Operationsbeleg waren bereits
gespeichert. Das vollständige Serverprotokoll zeigt `ADMISSION_CONFLICT` in der
abschließenden Prüfung des Direct-Activity-Handlers. Der historische konkurrierende
Lock-Inhaber ist nicht aufgezeichnet; seine genaue Herkunft bleibt unbekannt.

## Änderung

Nur die feste Prüfung nach Rückkehr des Verbrauchers verwendet die vorhandene
gemeinsame Admission-Prüfung. Danach folgt keine Mutation. Aktuelle Sitzung,
Berechtigungen, Workspace-/Organisationszuordnung, native Dokumentidentität,
Owner und aktive Reservierungen werden weiterhin geprüft. Eine echte exklusive
Workspace-Sperre wird weiterhin abgewiesen.

Eintritt und sämtliche vom Verbraucher erreichbaren Prüfmethoden behalten die
strenge Writer-Prüfung. Öffentliche Methoden nehmen keinen wählbaren Prüfmodus
entgegen. Excalidraw behält auch beim Abschluss seine bestehende strenge Prüfung.
Fehlerabbildung, Zeitlimits und Wiederholungen wurden nicht geändert.

## Nachweis

Der neue Test `scripts/native-direct-activity-completion-postgres-test.ts`
verwendet den tatsächlichen Serverhandler, Better Auth, native Dokumentdaten und
PostgreSQL. Ein zweiter echter Datenbankclient hält seine Sperre erst nach dem
streng autorisierten Eintritt. Acht Gruppen bestehen:

- unveränderter Kontrollaufruf und erneut erfolgreicher Kontrollaufruf nach Fehlern;
- Abschluss unter einer wirklichen gemeinsamen Lesersperre;
- Ablehnung einer exklusiven Sperre und einer tatsächlich angelegten Reservierung;
- weiterhin strenge öffentliche Prüfmethode trotz zusätzlicher Auswahlargumente;
- Ablehnung einer abgelaufenen Sitzung und einer geänderten nativen Identität;
- Ablehnung einer nach ihrem Lebensende verwendeten Sitzungsfassade.

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
Fehlerlauf bereinigt seine Ressourcen vollständig.

Die bestehenden PostgreSQL-Suiten `authenticated-native-session-transport` und
`native-document-search-room` bestehen mit der Änderung. Die erweiterte
TypeScript-Prüfung erfasst 23 Wurzeln und 5.120 Quelldateien ohne Diagnose;
Release-TypeScript und ESLint bestehen ebenfalls. GitNexus ordnet die geänderten
bestehenden Symbole dem erwarteten Server-/Runner-Bereich mit niedrigem Risiko zu.

## Offene Abnahme

Der neu gebaute Linux-Container, der tatsächliche mobile Recovery-Ablauf und die
abschließende Gesamtsuite mit diesem Produktstand stehen noch aus. Der gezielte
Handler-Test benötigt keinen geladenen Dokumentraum; der Browserfall muss auch
Mutation, Raum-Owner und dauerhaften Beleg zusammen prüfen. Der Fix ist keine
Leistungsabnahme und kein Produktionsdeployment. Sämtliche übrigen Pakete des
[Gesamtplans](../document-write-database-performance-plan.md) bleiben erforderlich.
