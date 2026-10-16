# Quellenautorität gewöhnlicher Dateien neben nativen Dokumenten

Stand: 16. Oktober 2026. Diese Korrektur betrifft reguläre Dateiaktionen. Dateiaktions-Undo bleibt ausdrücklich ausgeschaltet; Review Center bleibt außerhalb des Auftrags.

## Fehler und enge Korrektur

Der tatsächliche erste Browserlauf der Undo-Abschaltung scheiterte bereits beim normalen Delete einer neuen nativen Markdown-Datei mit `NATIVE_SOURCE_EVIDENCE_INVALID`. Im selben Workspace lag eine gewöhnliche, über die Datei-API erstellte TXT-Datei. Die Quellenprüfung hatte dieser noch nie nativ initialisierten Registryzeile eine native Dokument-ID zugeordnet, ohne dass ein entsprechender nativer Zustand oder ein natives Binding existierte.

`readWorkspaceLinkSourceAuthorityOnConnection` lässt solche pristine Einträge jetzt bei ihrer tatsächlichen Dateisystem-Identität: Dokument-ID und Generation im Namespace bleiben null. Fehlt die tatsächliche Datei, blockiert `missing-physical-source` unabhängig von der Dateiendung. Nur native Einträge belegen zusätzliche Registry-Verzeichnisse ohne physische Identität.

Der strikte Evidencevalidator bleibt unverändert. Native Dokumente behalten ihre Registry-/Generationsbindung auch ohne Projektion oder bei anderer Dateiendung. Fehlender nativer Zustand erlaubt keinen Dateifallback. Pristine Markdown bleibt importpflichtig. Die wiederholten Katalog-, Zustands-, Berechtigungs- und Dateiprüfungen bleiben erhalten.

## Tatsächliche Gegenprobe und lokale Prüfung

Die neue eingefrorene Folge `scripts/workspace-pristine-asset-native-evidence-test.ts` verwendet echte FS-/Yjs-Daten und tatsächliche eingebettete PGlite-Abfragen. Mit dem vorherigen Collector scheitern fünf der neun Unterfälle: drei gewöhnliche Assettypen, identische Bytes auf einem ersetzten Inode und eine fehlende registrierte TXT-Datei. Dieselbe unveränderte Folge besteht mit der Korrektur: neun Unterfälle, im TAP einschließlich Elternfall 10/10, tatsächlicher Exit 0. SHA256 `e975a544744b3768cfd588398f8a0e497f2a6327706e133d6170fa31965761ee`. Sie prüft außerdem Plain/XML/Blocks mit Sequenz null sowie die beibehaltene Markdown-Importpflicht. Dies ist keine echte PG18-/Auth-/Mutationsabnahme.

Sechs bestehende angrenzende Testdateien bestehen zusammen mit 112/112 TAP-Fällen und Exit 0: strikter Collector, Quellenstage, native Evidence, nativer Deleteplan, gemischte Batchplanung und autoritativer Plannersnapshot. Die vorhandenen Auth-Konfigurationswarnungen dieses isolierten Node-Testlaufs werden nicht als tatsächliche Anmeldung ausgegeben. Vollständiges TypeScript ohne Incrementalcache, Scoped ESLint und Diffprüfung bestehen; die unabhängige Quellenprüfung meldet keinen materiellen Befund.

Die neue `scripts/workspace-source-authority-pristine-postgres-test.ts` besteht anschließend tatsächlich mit acht PG18-Familien und Exit 0. Personal/Cookie und Team/Bearer nutzen echte Workspace-/Startererstellung, den regulären File-Create-Handler und den echten ursprünglichen Dateiimport. Die Quellenbeobachtung läuft unter aktuellen Rechten auf derselben Verbindung und dem bereits gehaltenen Shared-Admissionkey. Echte TXT-Dateien bleiben physisch; absichtlich entfernte pristine Dateien blockieren; tatsächlich importiertes TXT wird nativ und bleibt ohne Projektion lesbar; echter Verlust des initialisierten Zustands blockiert ohne Fallback. Eigene Schemas, Verbindungen und DATA sind nachweislich entfernt. Der Lauf ist keine Browser- oder vollständige Dateiaktionsabnahme.

Der erste PG18-Versuch scheiterte nach bestandenen ersten Quellenprüfungen am Testaufbau: Er verlangte die erneute Create-Anlage am absichtlich entfernten, weiterhin registrierten Pfad. Der korrigierte Test isoliert diese negative Quelle in einem eigenen tatsächlich angelegten Workspace und benötigt weder Dateireparatur noch Registryänderung. Die ursprünglichen Collector-/Native-Assertions bleiben bestehen. Historischer Test-SHA256 `0dd218699c0773014cab178fe5be2c0b6948ff770dda658d776c31933f87ccce`; finale Fixture `51f82dbaa2e2a955a4ad1c611f52e0bc4a6636b3b0cb2fae0e74dcf9077fbdf9`; privater erfolgreicher PG18-Log `8ff0d3c2875de32f0d650879905119a24ad80d1680865f8c15881b552da550e9`. Auch der erste Versuch bestätigt seinen eigenen Ressourcenabschluss.

GitNexus wurde vor der Produktänderung auf das genaue Collectorsymbol angewendet: sieben direkte Treffer, kritische transitive Reichweite; der Nutzer wurde vor der Änderung darauf hingewiesen. Die Änderung bleibt auf diese eine Funktion begrenzt. Ein Indexrefresh scheitert an `LOWER: Invalid UTF-8`; der anschließende exakte Impact und die Änderungsprüfung liefern das betroffene Symbol beziehungsweise die zwei erwarteten Apply-Prozesse. Das ist kein bestätigter vollständiger Indexrefresh.

## Noch erforderliche integrierte Prüfung

Ein neuer Produktionsbuild und ein frischer Originalsupervisor-Browserlauf stehen für diesen Codecommit noch aus. Beide normalen Delete-Ziele (native Markdown-Datei und gewöhnliche TXT-Datei), Erfolgsmeldung ohne Undo, alte abgewiesene Undo-API-Aufrufe sowie Desktop-/Mobile-Navigation bleiben in der Spec enthalten. Der zusätzliche V1-Verbindungskonflikt ist bisher ein separater Quellenbefund und keine im vorherigen Browserlauf erreichte Ursache.

Die zwölf ursprünglichen QA-/Build-/Room-Helfer und fünf Adapter bleiben unverändert. Die neue Korrektur ist keine allgemeine Aktivierung, kein Produktionsrollout und kein Abschluss der noch offenen Move-/Copy-/Link-/SDK-/MCP-/Such-/PDF-Arbeit.
