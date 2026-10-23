# Descriptorgebundene Veröffentlichung: geprüfte Grundlage

Stand: 14. Oktober 2026. Autorencommit `ff9a9ec3152db69944e22aab4a9c3a78dcfbd99f`, Root-Integrationsbasis `35af752e0f66fd1076a8d4fe90d5d6bd9ea82325`.

## Zweck und Grenze

Die echte I-04-Gegenprobe zeigte eine Veröffentlichung durch den Pythonprozess, nachdem dessen letzte bestätigte Freigabe veraltet, die SQL-Publikationsverbindung beendet und die Session widerrufen war. Die API lehnte den Abschluss ab; das Ziel existierte trotzdem. Der Parentpublisher benötigt deshalb eigene, synchron verwendbare Verzeichnisdeskriptoren. Die Korrektur des I-04-Publishers ist ein eigener anschließender Schritt und durch dieses Paket noch nicht erledigt.

[fd-publication.ts](../app/lib/files/fd-publication.ts) liefert ausschließlich mechanische Dateisystemoperationen. Deskriptoren verleihen keine Dokument-, Session- oder Schreibautorität. Der Aufrufer bleibt für Originalrequest, echte aktuelle Guards, Lebensdauer, benannte Inodes, Inhaltsbelege, SQL-Abschluss und Wiederanlauf verantwortlich. Eine atomare Transaktion zwischen PostgreSQL und Dateisystem wird nicht behauptet.

## Plattformen und Vertrag

- Linux verwendet ausschließlich die vorhandene `/proc/self/fd`-Schnittstelle und synchrone Node-Dateisystemoperationen. Ein Compiler oder natives Linux-Artefakt wird nicht benötigt.
- macOS verwendet den kleinen [Darwin-Node-API8-Baustein](../tools/native-fs/fd-publication.c) für `openat`, `mkdirat`, `linkat`, `unlinkat` und begrenztes Lesen des gepinnten Verzeichnisses.
- Die gemeinsame API bietet `openDirectoryAt`, `openFileAt`, `mkdirAt`, `linkAt`, `unlinkFileAt` und `hasExactNameAt`. Jeder zurückgegebene FD gehört dem Aufrufer. Es gibt keinen Pfad-, Childprozess- oder anderen Backendfallback.
- Einzelne Namenskomponenten, echte eigene Verzeichnis-FDs und reguläre eigene Quellen werden streng geprüft. Links überschreiben keine Ziele. Unlink prüft das vollständige übergebene private Profil mit `dev`, `ino`, UID und Modus `0600`; es ist kein allgemeiner Ziel- oder Verzeichnislöscher.
- Die Suche nach einem exakten Namen ist auf 100.000 Verzeichniseinträge begrenzt. Eine überschrittene Suche liefert keinen negativen Vollständigkeitsbeleg.
- Fehler enthalten begrenzte Codes und eine feste Nachricht; private Namen, Pfade und OS-Causes verlassen den Adapter nicht.

## Build und Laden

`npm run build:fd-publication` verwendet auf macOS ausschließlich vorhandene Node-Header und den vorhandenen C-Compiler. Es installiert und lädt keine Toolchain nach. Der bestehende `prebuild` führt diese Vorbereitung aus. Ein frischer macOS-Dev-Checkout benötigt denselben Vorbereitungsschritt, bevor I-04 den Baustein nutzen kann.

Die generierten Dateien liegen unter `native/fd-publication/<platform>-<arch>/`, bleiben aus Git und dem Linux-Docker-Buildkontext ausgeschlossen und werden bei einem Darwin-Next-Build ausdrücklich getraced. Es wurden keine Dependencies, Lockfiles oder Docker-Buildstufen verändert. Das Manifest bindet API-Version, Node-API-Version, Plattform, Architektur sowie die tatsächlichen Source- und Binärhashes. `npm run verify:fd-publication` prüft das Artefakt ohne Neubau. Fehlende oder abweichende Artefakte blockieren; der I-04-Aufrufer muss die Verfügbarkeit vor nativer DML prüfen.

## Tatsächliche Prüfungen

Die [gemeinsame Matrix](../scripts/fd-publication-test.mjs) verwendet echte Dateisystemoperationen und die unveränderte Produktquelle. Eigene temporäre Verzeichnisse, FDs und Prozesse werden geschlossen. Root hat die Autorenquelle unabhängig geprüft und beide Plattformmatrizen ausgeführt; das anschließend im Root neu kompilierte Darwin-Artefakt besteht gesondert dieselben neun Familien.

Darwin arm64, Node 26.7.0: neun Testfamilien prüfen echte Rename-/Peer-Alias-Fälle bei gepinnten Deskriptoren, gleiche Inodes und Bytes, exklusive Anlage und Link, private Recordveröffentlichung und -entfernung, genaue Namen, Symlink-/FIFO-/Verzeichnisabwehr, strikte Argumente und Profile, geschlossene/ungeeignete FDs, echte 100.001-Einträge-Grenze, rohe immutable Exports sowie tatsächliche neue Prozesse mit neun fehlerhaften Manifestvarianten. Ein realer Compilerfehler erhält das frühere Artefakt und entfernt den eigenen Pending-Baustein.

Root fand vor dem Abschluss einen echten Gegenfall: Ein direkter nativer Aufruf mit 256 ASCII-Zeichen erzeugte einen 255-Byte-Namen. Der C-Adapter prüft nun die vollständige UTF-8-/UTF-16-Länge vor dem begrenzten Bufferlesen und die anschließend geschriebene Länge. Die Matrix enthält 24 rohe Gegenaufrufe über alle sechs Methoden; keiner erzeugt einen gekürzten Alias. Native Exports sind bereits vor dem TypeScript-Laden eingefroren.

Linux arm64, Node 24.18.0, UID 1000: dieselben sechs mechanischen Testfamilien bestehen im einzigen bereits vorhandenen verwalteten Notebookcontainer. Build und Verify wählen tatsächlich den eingebauten Backendpfad. Es wurde kein Container gebaut, neu gestartet oder umkonfiguriert. Root bestätigt in separaten Prozessen die Abwesenheit der eigenen Darwin-/Linux-Testprozesse und Fixtures.

Frisches vollständiges Root-TypeScript ohne Incrementalcache, fokussiertes ESLint und Diffprüfung bestehen. Die acht übernommenen Quelldateien sind bytegleich dem Autorencommit; elf weitere geschützte Root-Dateien, darunter Principal, nativer Reader, Transport, Sessionservice, Lifecycle, Aktivierung, Dockerfile und Lockfile, bleiben bytegleich der Integrationsbasis.

## Noch offene Abnahme

Die reale I-04-Timeout-/Widerrufsgegenprobe muss mit dem angeschlossenen Parentpublisher erneut bestehen. Birth-/Journal-Wiederanlauf und dessen Verzeichnisinitialisierung bleiben eigene Gates. Keine Browser-, Appbuild-, Geräte-, Produktions- oder x64-Abnahme wird aus den beschriebenen Prüfungen abgeleitet; das native Produktaktivierungsgate bleibt deaktiviert.
