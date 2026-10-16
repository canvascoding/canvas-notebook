# Workspace-Startdokument: fehlender nativer Anlegepfad

**Starter-Anschluss implementiert:** Die [gemeinsame Web-/Mobile-Initialisierung](./yjs-workspace-starter-initialization-evidence.md) erhält den wirklichen Workspace-Teilabschluss und nimmt denselben gespeicherten Originalimport wieder auf. Elf neue tatsächliche Personal-/Team-/Auth-/PG18-Familien und die 29 bestehenden Original-Bootstrap-Familien bestehen. Der davor dokumentierte 409-Browserlauf bleibt ein historischer Fehlversuch; frischer Build, neue Starter-UI-Spec und unveränderter native Delete-/Undo-Folgelauf stehen für diesen Anschluss noch aus. Keine allgemeine Aktivierung und kein Gesamtabschluss.


Stand: 16. Oktober 2026. Beobachteter Produktstand Root `49dfd9beee380c43bbc96b114c758af48c39ef67`, QA `bae26a9716b0ac70427eb1427e39fe71428d68d7`. Der folgende Befund ist ein fehlgeschlagener echter Browserlauf und keine abgeschlossene Dateiaktionsabnahme.

## Tatsächlicher Folgelauf

Nach dem Neuaufbau der verwalteten Notebook-Testumgebung läuft der unveränderte Originalsupervisor gegen eine eigene Anwendung, Datenbank und Lizenz. Beide nativen Browserfälle erreichen nun die bestätigte Eingabe, den gebundenen Raumread, normale Raumfreigabe und den echten Filebrowser-Delete. Die API antwortet jeweils mit HTTP 409 und `NATIVE_SOURCE_IMPORT_REQUIRED`. Der Originalreport enthält zwei deklarierte Fälle, null bestandene, zwei fehlgeschlagene und keine Skips, Testtimeouts oder Unterbrechungen. Undo wird nicht erreicht. Die anschließend ausgewählte physische Datei-/Linkregression startet nicht.

Beide Traces zeigen vor Delete genau zwei Markdowndateien im neu erzeugten Workspace: `Erste Schritte.md` und das ausdrücklich native Testdokument. Das Startdokument wird im Browserlauf nicht geöffnet. Die neue native Raumbeobachtung scheitert nicht mehr an der früheren Stelle; das erklärt den früheren Beobachtertimeout nicht rückwirkend.

## Quellenabgleich

`POST /api/workspaces` ruft `createPostgresWorkspaceForActor` auf. Dessen `insertWorkspaceRecord` legt das Workspaceverzeichnis an und ruft `seedWorkspaceStarterDocument` auf. Der Seeder schreibt das Startdokument ausschließlich mit `writeFileSync`, `flag:'wx'`, `mode:0600`; Registry, Lineage und nativer Yjs-Zustand werden dabei nicht angelegt. Dieser Pfad gilt auch für andere Aufrufer der gemeinsamen Workspaceanlage.

Sobald das daneben erzeugte Testdokument native Autorität besitzt, wählt der Dateiaktionsplan den nativen Arm. Dessen vollständiger Quellenbeleg verwirft physische Markdownquellen ohne native Zuordnung. Die Quelle und die tatsächlichen Dateilisten grenzen damit den fehlenden nativen Anlegepfad des Startdokuments ein. Die öffentliche 409-Antwort benennt selbst keinen verursachenden Pfad. Der Schutz bleibt erforderlich: Ein unbeobachtetes Dokument darf mögliche Links enthalten.

Das Startdokument wird weder aus dem Produkt noch aus dem Test entfernt. Es wird nicht vorab durch Testcode geöffnet oder künstlich in die Datenbank geschrieben. Der unveränderte Browserlauf bleibt die spätere Gegenprobe für die Produktkorrektur.

## Erforderlicher zentraler Anschluss

Alle bestehenden Aufrufer des Workspace-Startdatei-Seeders müssen einen regulär nutzbaren nativen Dokumentzustand herstellen; die expliziten Personal-, Team-, Organisations- und Projektfälle sind getrennt zu prüfen. Der Default-Personal-Bootstrap verwendet dagegen `ensureWorkspaceRecord`, das heute lediglich das Verzeichnis anlegt. Dieser Pfad erhält keine erfundene HTTP-Sitzung und wird nicht ungeprüft zu einem zusätzlichen Seeder umgebaut. Das Startdokument behält seinen Inhalt und erhält eine echte Registry-/Lineage-/Generationsbindung. Bereits vorhandene oder zwischenzeitlich ersetzte Inhalte werden nicht überschrieben oder als neue Templatebytes ausgegeben.

Für eine bereits physisch erzeugte Originaldatei existiert `persistPristineOriginalWorkspaceFileForWrite`. Dieser Dienst verlangt den tatsächlichen `NextRequest`, prüft aktuelle Schreibrechte und besitzt seine eigenen echten Lifecycle-/Mutationsverbindungen. Er darf erst nach COMMIT und Schließen der Workspace-Erzeugerverbindung laufen. Er ist ein möglicher Admission-Anschluss für ein erhaltenes Original, aber noch kein vollständiger atomarer Workspace-Birth-Vertrag und kein Nachweis eines abgeschlossenen First-Projection-Handshakes.

Die bestehende vollständige First-Projection-Engine akzeptiert echte Uploadquellen oder die deklarierte leere manuelle Quelle. Ein nicht leeres, serverseitig erzeugtes Startdokument darf diese Quellen nicht vortäuschen. Für native-first Templateanlage ist ein enger, tatsächlich erzeugter Template-/Completion-Handoff nötig. Dessen Autorität muss aus dem realen Erzeugungsvorgang und aktuellen Workspaceberechtigungen stammen; ein frei konstruierbarer Descriptor oder ein direkter DAL-Aufruf genügt nicht. Fehler nach bereits bestätigter Workspaceanlage müssen diesen tatsächlichen Teilabschluss sichtbar erhalten, statt eine vollständige Rücknahme oder einen sicheren erneuten Create vorzugeben.

Die erste Wiederverwendung soll den bereits vorhandenen festen Schreibimport verwenden. Die gemeinsame Web-/Mobile-Koordination benötigt dafür aus dem wirklichen Erzeugungsvorgang Starterpfad, tatsächliches `created`/`existing`, Originaldateiversion sowie behaltene Attempt-/Completion-IDs. Eine Wiederaufnahme adressiert denselben bereits angelegten Workspace und denselben Importversuch; ein Importfehler nach Workspace-COMMIT darf keinen unkontrollierten neuen Workspace-Create auslösen. Eine direkte Registryinitialisierung im Seeder oder ein synthetischer Upload-/Manual-Empty-Descriptor ersetzen diesen Anschluss nicht.

Abzunehmen sind neue Workspaces sämtlicher betroffener Typen, die getrennten Actor-only-/Bootstrapgrenzen ohne künstliche HTTP-Sitzung, bestehende Startdatei, parallele Änderung/Ersetzung, Rechteentzug, SQL-/FS-Unterbrechung und unklarer COMMIT. Danach wird derselbe native Delete-/Undo-Browserfall unverändert wiederholt; die physische Linkregression und die vollständige Datei-/SDK-/PDF-Abnahme bleiben weitere Anforderungen.

## Build- und Ressourcenbelege

Der erste verwaltete Neuaufbau besteht Host- und Docker-Build, erreicht aber die Gesundheit nicht. Eine getrennte echte `next.prepare()`-Diagnose im Image liefert `EACCES` beim Lesen von `/app/public/_canvas-tool-apps`. Der private Logwrapper hatte Umask `077` an den Host-Build vererbt; dessen erzeugter öffentlicher Ordner war `0700`, die fünf Ausgabedateien `0600`. Nur diese sechs ignorierten öffentlichen Outputeinträge wurden auf `0755`/`0644` korrigiert. Der zweite unveränderte Skill-Lauf verwendet ausdrücklich Build-Umask `022` bei separat privat geöffnetem Log und endet mit tatsächlichem Exit 0. Hostbuild, Dockerbuild, regulärer Start, Gesundheitsantwort, Anmeldung und Fixtures bestehen. Das Laufzeitkonto kann die öffentlichen Assets lesen. Es wurde kein Startup-/Timeout-/QA-Guard geändert.

Das erfolgreiche Image ist `sha256:845915461f15fdf85e42517a3e4e75121e2374454c3af86da38ad08ea1c3c48d`. PostgreSQL und beide Control-Plane-Container behalten ihre IDs und Startzeiten, die gemeinsame Compose-Konfiguration bleibt bytegleich. Der zwischenzeitlich lange zweite Next-Compile-Schritt endet regulär; seine tatsächliche Warteursache ist nicht bewiesen.

Vor und nach dem fehlgeschlagenen Browserlauf bestehen das originale Build-Siegel und separate Quellen-/Buildvergleiche: Source `7b36b8f6f1f86c42c5d98671012eac91013bd6f17d425c821c1504bff4a37c2c`, Build `03fe500d5751b98e19832003ccb813d29d83f691e4e31d8330efc83740d00f0c`. Zwölf Originalhelper, fünf Adapterdateien und drei bekannte Root-/QA-Deltas sind unverändert.

Die eigene fehlgeschlagene Fixture `canvas-yjs-authority-ec6P4J` wurde anschließend separat geschlossen: eigene Prozesse/Gruppen und Ports fehlen, Runlock ist frei, beide eigenen Datenbanken wurden nach frischer Namens-/OID-/Owner-/Marker- und Null-Sessions-Prüfung ohne FORCE entfernt; DATA/tmp sind entfernt. Originalreceipts bleiben unverändert `preserved`, `passed:false`, `uncertain:true`. Der getrennte Abschlussbeleg `manual-cleanup.json` trägt SHA256 `68673c2a8ed044714e24368f0a84dfee94487338ccce33a42a93b730ca88f4ac`. Rohtraces, Runtime-ENV und Zertifikate bleiben privat. Der unabhängige POST-Beleg trägt SHA256 `1705adb8c1366eb685aea5119d0fd4c3519e42848aea3ac1bac3f229546ca153`.

Allgemeine native Aktivierung und Gesamt-E2E bleiben offen. Review Center bleibt ausgeschaltet. Dieser Lauf verändert keine Produktion.
