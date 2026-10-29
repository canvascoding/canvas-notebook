# Dokumentservice: direkte Linkaktionen und Hintergrundabfragen

Stand: 28.10.2026. Dieser Teilschritt behandelt einen im echten Browser belegten
Wartezustand bei Linkvorschau und Dokumentnavigation. Die übrigen Anforderungen des
[Gesamtplans](../document-write-database-performance-plan.md) bleiben offen.

## Ursache und Korrektur

Der gemeinsame Client-Index bündelt Hintergrundabfragen und begrenzt sie lokal
auf einen Beginn je zehn Sekunden. Nach einer Invalidierung warteten auch
Linköffnungen und Vorschauen auf diese Frist. Im Browser konnte deshalb der
Fünf-Sekunden-Check für die Vorschau beziehungsweise den geöffneten Ziel-Tab
ablaufen, bevor überhaupt der neue Dokumentabruf begann. Die Links selbst waren
korrekt aufgelöst und nach Rename auf `C.md` umgeschrieben.

Ein kontrollierter Gegenvergleich am Produktstand
`62db6eb50a12cbbc002279495e9c326870bbb912` bestätigt die Ursache: Ein direkter
Nutzeraufruf tritt dem bereits wartenden Hintergrundabruf bei, startet aber keine
zeitnahe neue HTTP-Anfrage. Die neue Prüfung schlägt am vorherigen Produkt mit
genau dieser Assertion fehl. Eigene ausstehende Testanfragen werden auch bei
diesem absichtlich roten Vergleich vollständig abgeschlossen.

Direktes Linköffnen und der geöffnete Vorschaudialog melden nun ausdrücklich
interaktiven Bedarf. Sie ziehen denselben geplanten Abruf vor. Ein bereits
laufender HTTP-Abruf bleibt gemeinsam verwendet; ein nach Invalidierung nötiger
Nachfolger behält die interaktive Priorität. Normale Hintergrundleser und
eingebettete Inhalte verwenden weiterhin die bisherige Drosselung.

Server-Wartefristen werden getrennt geführt. Auch interaktive Aufrufe beachten
`Retry-After`; bei einer 429-Antwort ohne nutzbare Frist bleibt die lokale
Wartefrist als Rückfall erhalten. Eine vorhandene frische Indexantwort bleibt
wiederverwendbar. Die Änderung betrifft die Planung lesender Client-Anfragen;
serverseitige Berechtigungs- und native Schreibprüfungen bleiben bestehen.

## Prüfnachweise und Grenzen

Sechs neue kontrollierte Client-Testgruppen bestehen:

- Direktes Linköffnen zieht einen wartenden Hintergrundabruf vor.
- Eine Vorschau zieht auch einen gemeinsam wartenden Embed-Abruf vor und liest
  das Dokument einmal.
- Ein frischer Cache verursacht beim Nutzeraufruf keine zusätzliche Anfrage.
- Eine serverseitige Wartefrist von 60 Sekunden bleibt verbindlich.
- Nach einer Invalidierung startet ein frischer Nachfolger erst nach dem
  bisherigen HTTP-Abruf; parallele Anfragen entstehen nicht.
- Eine 429-Antwort ohne Wartefrist löst keine unmittelbare Anfrageschleife aus.

Die bestehenden Invalidierungs-/Bündelungsprüfungen bestehen unverändert. Auch
`test:files:background-events`, `test:files:discovery`,
`test:markdown:navigation-client`, `test:markdown:links`, Release-TypeScript und
gezieltes ESLint bestehen. Der vorhandene Discovery-CI-Workflow führt diese
Client-/Hintergrundprüfungen nun zusätzlich aus und berücksichtigt ihre Quellen
und Testdateien in den Pfadfiltern.

Sechs ältere Cache-Testassertionen verglichen die Objektidentität einer über
`filter` erzeugten Dateiliste. Sie scheitern nachweislich auch am unveränderten
vorherigen Quellstand. Die Korrektur vergleicht Werte und prüft zusätzlich die
Anzahl tatsächlicher Verzeichnisscans; der vollständige Workspace-Snapshot muss
weiterhin Verzeichnisse enthalten. Alle neun Fälle dieses Runners bestehen.
Am Dateisystem-Cache selbst wurde dafür nichts geändert.

Am vorherigen gebauten Produkt `ca7da2dc1`, mit Teststand `62db6eb50`, bestanden
sechs der sieben gezielten Browserfälle; Vorschau/Navigation war noch rot.
Am vollständig neu gebauten Produkt- und Teststand
`193685510b293c8aa6a49e9f6a62cb658c38183e` bestehen nun **alle sieben Fälle** mit
unveränderten Assertions und Timeouts, null Retries, null Skips und null Flakes.
Beide Create-Wiederaufnahmen, die erste unterbrochene Browsersitzung, mobiles
Speichern samt Wiederholung und späteren Änderungen sowie die Link-Lifecycle-
und Vorschau-/Navigationsprüfungen sind grün. Die Collaboration-Recovery-Fälle
sind in diesem Lauf ausdrücklich aktiviert.

Host-Produktionsbuild, Linux-Image-Build und echter Containerstart bestehen.
Das geprüfte Image ist
`sha256:58947764dd21f0a05484fc20b42d1ae754438a25531ff34b4da820ed68411159`.
Die Browserprüfung lief am 28.10.2026 von 20:19:17 bis 20:22:52 UTC im einzigen
verwalteten Notebook mit denselben eigenen Datenbank- und Datenvolumes.
Produktquellen wurden nicht in das Image kopiert. Das Browser-Artefaktarchiv hat
SHA-256 `e440cf438461e72910c1eeb2bc4905221c958012a7a216540bf65a87867e17dc`.
Die geschützten Zeilen samt `xmin`, Originalbytes, Inodes und drei Speicherankern
des ursprünglichen lokalen Uploads bleiben auch nach diesem Lauf exakt erhalten.

Die erweiterte Linux-CI deckte daneben eine Plattformannahme im bestehenden
Staging-Watcher-Test auf: Alle drei normalen Benutzer-`.tmp`-Dateien lieferten
aktuelle versionierte `change`-Ereignisse, die Assertion verlangte aber `add`.
Der tatsächliche Linux-Gegenvergleich erhält die ursprünglichen Assertions und
Wartezeiten und scheitert genau daran. Der native Watcher bündelt Ereignisse nach
Pfad; der Client aktualisiert den Verzeichnisstand sowohl bei `add` als auch bei
`change`. Der Test prüft deshalb einen positiven Projektionshinweis mit exakt
der tatsächlichen Dateiversion und zusätzlich die unveränderten Dateiinhalte.
Die bisherigen Prüfungen auf verborgene Staging-Dateien, sichtbare Nutzerdaten und
echte Löschungen bleiben bestehen. Der Produkt-Watcher wird dafür nicht geändert.

Die endgültige reguläre Gesamtsuite und die aktuellen CI-Gates bleiben eigene
Abnahmen. Dieser Bericht ist keine Gesamtabnahme oder Produktionsfreigabe.
Review Center und Undo werden nicht weiterentwickelt.
