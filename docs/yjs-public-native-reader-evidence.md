# Native öffentliche Dokumente: Reader, Exporte und Vorschau

Stand: 16. Oktober 2026. Produktcode bis Root `94dd203c1` / QA `3582f5772`. Der native Reader, seine Consumer und der fokussierte Browserfall sind lokal bestanden. Allgemeine Aktivierung und Veröffentlichung sind nicht erfolgt.

## Vertrag

Token und Kurzcode liefern ausdrücklich entweder eine physische Datei oder einen nativen, dauerhaft gespeicherten Yjs-Snapshot. Der native Zweig braucht keine Markdownprojektion und behält ursprüngliche Dokument-ID, Lineage und Lifecycle-Generation. Anonyme Leser erhalten ausschließlich die echte Freigabeautorität; eine Anmeldung des Erstellers wird nicht nachgebildet. Historische all-NULL-Freigaben bleiben physisch.

Der Reader bindet die tatsächlichen SQL-Relationen und den aktuellen Workspace, sperrt Freigabe-/Workspacezeilen und prüft Originalziel, aktive Freigabe, Ablauf und native Shared-Admission auf derselben Verbindung. Inhalt und erfolgreicher Accesscounter verlassen die Grenze erst nach COMMIT und Cleanup. Reine Reads und HEAD ändern keine Freigabezeile. Ein unbestätigter Zähler-COMMIT liefert 503; er wird nicht erneut ausgeführt.

Die Vorschau übergibt begrenzte native JSON-Inhalte direkt an einen schreibgeschützten Tiptap-Viewer. JSON-Objekte mit Null-Prototyp werden vor der Clientübergabe in gewöhnliche JSON-Objekte umgewandelt. Das ist kein Markdown-Roundtrip. Der 5-MiB-Check liegt vor dieser Konvertierung und dem Bild-Rewrite; zu große Vorschauen gelangen nicht als Clientprop in den Browser.

Download, HEAD und Range benutzen tatsächlich geprüfte Exportbytes einschließlich BOM/CRLF und ehrlichem Dateinamen/MIME. Verlustbehafteter Markdownexport wird mit 409 abgewiesen; ein Export über dem Budget mit 413. Die native Vorschau ist unabhängig von der Exportfähigkeit. HTML-/PDF-/Marp-Consumer erhalten den nativen Export vor ihrer bisherigen Dateisuffixauswahl. Die native Assetroute liefert ausschließlich tatsächlich referenzierte, im Workspace aufgelöste und erneut geprüfte Assets. Gewöhnliche externe HTTP-/HTTPS-Bildquellen bleiben im Rewriter erlaubt.

## Tatsächliche Gegenproben und Korrekturen

- Der alte `syncPublicSharesAfterWrite` veränderte native Freigaben beim Schreiben einer Projektion. Der neue Fall scheitert vor der Korrektur nach 23 erfolgreichen Gruppen an der vollständigen Zeilengleichheit; danach bestehen alle 25 Gruppen. SELECT und UPDATE des Hooks erlauben jetzt ausschließlich all-NULL-Bindungen. Der physische Gegenfall aktualisiert weiterhin tatsächliche Revision, Identität und Größe mit genau einem Write. Root `9f2d9b2d3` / QA `1b4df542a`.
- Die ersten vier Browserläufe scheitern mit 404. Begrenzte Diagnosen zeigen im dritten Lauf PostgreSQL `55P03`, im vierten genau die Phase `relations`. Reader-`ROW EXCLUSIVE` auf `canvas_workspaces` ist mit den regulären Principal-`SHARE`-Sperren inkompatibel; der konkrete Blockerbackend des fehlgeschlagenen Browserlaufs wurde nicht gemessen. Ein zweiter echter PG-Client hält diese SHARE-Sperre mit `pg_locks`-Beleg: Der unveränderte Test scheitert zuvor nach 24 Gruppen mit derselben Phase und demselben Code. Mit Reader-`ROW SHARE` bestehen alle 26 Gruppen einschließlich reiner und zählender Reads unter der gehaltenen Sperre. Relationserhalt, Zeilensperren, Shared-Fence und COMMIT bleiben bestehen. Dies behauptet keine Sperre sämtlicher Trigger-DDL. Root `8ba3100c7` / QA `7ab7410c9`.
- Der fünfte Browserlauf passiert diese SQL-Grenze und scheitert mit 500 an Reacts Server-/Clientübergabe nativer Heading-/Paragraphattribute mit Null-Prototyp. Die begrenzte JSON-Konvertierung korrigiert diese Transportgrenze. Root `94dd203c1` / QA `3582f5772`.

Die ersten beiden Browserfehler sind damit nicht rückwirkend bis zu ihrer einzelnen ursprünglichen Sperre bewiesen. Der erste Build besitzt nur den unabhängigen Vorbeleg; bei den Builds zwei bis fünf stimmen unabhängige Vor-/Nachbelege tatsächlich überein. Die fehlgeschlagenen Läufe bleiben Fehlversuche, kein UI-Erfolgsnachweis.

## SQL- und statische Abnahme

`scripts/public-share-native-read-postgres-test.ts` besteht tatsächlich 26/26 Gruppen auf PG18. Eingefrorene Quelle: SHA-256 `f12738b895de7b18df117c061166e66691835a568d832c8c9d7fc0120f558b11`. Vollständige Assertion-/Abschlussmarker, Entfernung des eigenen Schemas und DATA sowie null offene Clients sind bestätigt. Die Matrix umfasst Plain/XML/Blocks, DOCX-Endung, BOM/CRLF, exakte Namen, nicht verlustfrei exportierbare Tabellen, Exportbudget, Widerruf, Ablauf, Generation, Quarantäne, Archivierung, Wiederanlage, all-NULL-Kompatibilität, Zähler, veraltete Snapshots, Assets, tatsächlichen COMMIT-Antwortverlust und entfernte Erstellersitzung.

Die unveränderten Create46- und Read12-Suiten bestehen auf dem Readeranschluss. Der Public-Securitytest besteht ebenfalls; seine Importwarnungen sind kein Nachweis einer vollständig gesunden Runtime. TypeScript ohne Incrementalcache und Scoped-ESLint bestehen nach den produktiven Korrekturen. GitNexus-Impact und staged `detect_changes` wurden verwendet; neue Reader-/Testsymbole fehlen teilweise im Index und bestehende Diffbereiche werden teils falsch zugeordnet. Diese Grenzen wurden durch direkte Aufrufer-/Quellprüfung und unabhängige Reviews ergänzt, nicht als Entwarnung gewertet.

## Browserabnahme

Der sechste frische Produktionsbuild und der unveränderte Fall `tests/public-share-native-owned.spec.ts` bestehen tatsächlich mit Exit 0 und 1/1 Fällen, ohne Fehler, Skips, Timeouts oder Unterbrechungen. Der Fall benutzt echten Upload/Import, Editor und Public-Link-Dialog sowie einen Browserkontext ohne Anmeldung. Native Darstellung und geladenes Bild, tatsächlicher Download mit exaktem Bytevergleich, HEAD/Range, UI-Widerruf und anschließender Zugriffsverlust bestehen. Review Center ist dabei ausdrücklich ausgeschaltet. Dies ist eine fokussierte lokale Abnahme, keine neue Gesamtmatrix oder Produktionsabnahme.

QA-Produktcommit `3582f5772e2d731f76c3fb26ecfabfb80c11b919`, Source-Fingerprint `c06f889e307a8b74da06d3c6be4e55dd012fc713a8a3c45af9dfcb31b0a0a9f9`, Build-Fingerprint `9ef6de6d2a57866ef66e86cbdbbebb712781064e5e15b740f0d5c2c2fcc33947`. Unabhängige Vor-/Nachbelege sind identisch. Der Originalsupervisor bestätigt `phase:cleaned`, `passed:true`, `uncertain:false`, DB-/DATA-Entfernung und vollständigen Specabschluss. Zusätzliche passive Prüfung bestätigt leeren Testport und tatsächlich fehlenden DATA-Pfad. Die vorherigen fünf fehlgeschlagenen Fixtures sind zur Diagnose erhalten; ihre Testports sind ebenfalls geschlossen.

Private Quellen-/Protokollsammlung mit 37 Einträgen: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-public-native-evidence-uo88kpps/manifest.json`, SHA-256 `d312e372e2bffda2093738de6d97cf70563c192f75e4006e95cf0f013296557f`. Keine Env-Datei, Zugangsdaten, Raw-Recoverymanifeste oder Browsertraces wurden in diese Sammlung oder ins Repository übernommen.

## Verbleibender Anschluss

Dies schließt die Public-Familie noch nicht insgesamt ab. Offen bleiben insbesondere automatische Owned-Lifecyclehooks, der physische Accesswriter und die vollständige native Datei-/Linkkoordination. Die exakten Public-Leseselektoren und die anschließend gefundenen Upload-/Navigations-/Metadata-Spacefälle sind im [Folgenachweis](./yjs-public-share-exact-path-evidence.md) dokumentiert. Die drei alten, nicht zuverlässig vollständig ausgeführten Testaliases benötigen weiterhin eigene Abnahme. Der Listenreader rekonstruiert derzeit pro nativer Zeile einen vollständigen Snapshot; ein Skalierungsnachweis fehlt.

Die nativen HTML-/PDF-/Marp-Anschlüsse brauchen eine tatsächliche Rendering-/Cacheänderungsabnahme; nicht exportierbare und übergroße Dokumente sind bisher SQL-/Serverfälle, keine bestandenen UI-Fälle. Der Standard-Skill, das SDK, PDF-Import und die abschließende integrierte Gesamt-E2E-Abnahme bleiben eigene offene Schritte. Die [bedarfsweise Skill-/Kontextgestaltung](./central-notebook-file-api-import-plan.md#41-standard-skill-und-kontext-erst-bei-bedarf) bleibt verbindlich. Review Center bleibt ausgeschaltet.
