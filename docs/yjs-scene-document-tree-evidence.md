# Scenes im nativen Dateibaum

Stand: 18. Oktober 2026. Dieser Schnitt ergänzt die reguläre Copy-Integration aus Root `331502731` / QA `b20d60efe`. Er ist keine Gesamtfreigabe und kein Produktionsnachweis.

## Befund und Änderung

Der Copy-Owner kann eine initialisierte Scene aus SQL kopieren, auch wenn ihre Projektion fehlt. Die tatsächliche Dateibaumroute ergänzte zuvor jedoch ausschließlich den Yjs-Katalog zum physischen Verzeichnis. Eine Scene ohne Projektion war deshalb über die Dateiliste nicht auswählbar. Dieser Befund stammt aus dem vollständigen Aufrufpfad; ein alter Browserlauf wird dafür nicht als Reproduktion ausgegeben.

`readWorkspaceDocumentTree` liest jetzt zusätzlich den vorhandenen Scene-Katalog auf derselben Verbindung innerhalb der bestehenden READ-ONLY-Transaktion und gemeinsamen Admission-Sperre. Dazu erhält der Callback des Mehrdatei-Leserahmens seine bereits verwendete Verbindung als zweites Argument. Die Yjs-Export- und Downloadsemantik bleibt erhalten.

Beide Kataloge liefern nur gemeinsame Namensraumfakten für die Vereinigung. Scene-Header werden weder als Yjs-State noch als Textleseberechtigung behandelt. Sichtbarkeit, maximale Tiefe, Konflikte und das gemeinsame Limit von 10.000 Einträgen gelten über beide Provider. Fehlende Scene-Projektionen und daraus abgeleitete Ordner werden sichtbar; ein Registry-Eintrag ohne State löst keine Initialisierung aus. Aktive native Datei-Vorfahren einschließlich verwaister Scene-State-Pfade blockieren widersprüchliche Ordneranfragen. Der Scene-Katalog wird nach dem Dateisystemlesen vollständig erneut verglichen; Inhalte und Assetbytes werden dabei nicht geladen.

## Tatsächliche Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| Dateibaum-Vertragsfolge einschließlich sechs neuer Scene-Gruppen | 24/24 |
| Bestehender nativer Dateileser | 5/5 |
| Echter PostgreSQL-18-Schnitt | 6/6 Gruppen |
| Bestehende Dateievent-Klassifikation mit weitergereichter Originalverbindung | 14/14 |
| Abschließender Scoped-Lint aller sieben geänderten Code-/Testdateien | Exit 0 |
| Vollständiger Compiler ohne Cache | Bytegleich die 69 geerbten Main-Testdiagnosen, keine neue Diagnose |
| Unabhängiger Ressourcenabschluss | Drei Fixtures und sechs Bundles entfernt, zehn aktuelle Quellenpins unverändert |
| Erster Originalbuild auf Root `83b1c1f2b` / QA `a3010cfa9` | Prebuild stoppt am veralteten Lockfile-Hash im Lizenzcache; keine Browser gestartet |
| Neue kompilierte Browserfolge | Noch ausstehend; benötigt neuen Originalbuild nach Artefaktaktualisierung |

Die Datenbankfolge verwendet vollständige Migrationen und eigenes DATA/Schema. Sie prüft eine über den echten Scene-Service initialisierte Scene ohne Projektion und physische Eltern, gemischte Yjs-/Scene-/PDF-Verzeichnisse, Tiefe und ausgeblendete Pfade, Workspacegrenzen sowie Registry-only-Scene und pristine Yjs. Dieselbe echte SQL-Verbindung arbeitet READ ONLY ohne zugewiesene XID; vollständige Tabellenwerte einschließlich xmin und Dateisystemidentitäten/Bytes bleiben beim Lesen unverändert. Ein zweiter tatsächlicher Backendprozess verändert während der physischen Tree-Lesung den Scene-Header: Die abschließende Prüfung verwirft das Ergebnis und rollt zurück. Die Datenbank enthält danach ausschließlich die gezielte Gegenprobe.

Der erste reine Teststart scheiterte vor den Tests am CommonJS-Import von `@earendil-works/pi-ai/compat`. Dieselben Quellen bestehen über den vorhandenen ESM-Läufer mit echten installierten Konstruktoren. Der erste PG-Lauf bestand vier Gruppen und traf beim versuchten zweiten Identitätsaufbau auf `23505`. Die konkrete aktive Lineage-Constraint verhindert bereits diese doppelte Pfadbelegung. Die korrigierte Testgruppe erwartet diesen tatsächlichen Constraintfehler in einer eigenen zurückgerollten Transaktion und bestätigt anschließend unveränderte Yjs-Identität, Datenbank und Originaldatei. Es wird keine im Fixture nie erreichte doppelte Tree-Belegung behauptet. Die ursprünglichen Fehler bleiben als private Belege erhalten.

Der erste vollständige Typvergleich enthielt vier zusätzliche Testdiagnosen: Ein bestehender Dateievent-Testadapter reichte die neue zweite Callback-Verbindung noch nicht weiter; die neue PG-Probe verwendete drei unbekannt typisierte SQL-Ergebnisse ohne Eingangsprüfung. Der Adapter bestätigt jetzt die Identität der tatsächlichen Verbindung und reicht sie weiter. Die PG-Probe prüft Tabellenname, Digest und Backend-PID vor Verwendung, ohne Cast oder `any`. Die danach wiederholten PG6-, Event14- und Lintfolgen bestehen; die vollständige Compiler-Ausgabe entspricht mit SHA-256 `f87d64a219dd9317c7a22890a2687240cbf81b79851e829dd8117faa2ea561e3` exakt der geerbten Basis. Der vollständige Compiler ist dadurch nicht insgesamt fehlerfrei; neue Diagnosen wurden nicht als geerbt umdeklariert.

## Browsermatrix und Grenzen

Der ursprüngliche Build `canvas-yjs-build-VVp5nf` endet nach 4,107 Sekunden mit tatsächlichem Exit 1 in `test:licenses`. Der vorgesehene Aufruf `npm run licenses:refresh-cache` aktualisiert keine Paketnachweise und installiert keine Pakete: In genau drei abgeleiteten Dateien wird ausschließlich der Lockfile-SHA von `2f6fddb4…` auf den tatsächlichen Wert `9f92da66…` geändert. Die anschließende originale `third-party-license-compliance-test.ts` besteht. Lizenzprüfung und übriger Prebuild bleiben Teil des nächsten vollständigen Builds; der frühere Fehler wird nicht übergangen und sein ursprünglicher Quellen-/Buildbeleg bleibt erhalten.

Die neue Datei `tests/workspace-operation-managed-scene-copy.spec.ts` enthält vier Fälle: Desktop/Mobil jeweils eine aktuelle initialisierte Scene ohne Projektion sowie einen gemischten Ordner mit Markdown, Scene samt PNG-Asset, eigenständigem PNG und PDF. Fachliche Anlage, Änderung und Copy verwenden echte HTTP-/UI-Eintritte. Die Fehlprojektion wird ausschließlich an der zuvor per API angelegten eigenen Datei nach Root-, Workspace-, Parent-, FD-, Inode- und Hashprüfung hergestellt. Der Test rekonstruiert sie nicht für die Dateiliste. Neue Dokument-/Lineage-IDs, Quellgleichheit und das Ziel nach Reload werden geprüft. Review bleibt ausdrücklich ausgeschaltet. Die vier Fälle sind geschrieben und statisch geprüft, aber noch nicht als Browserlauf bestanden.

Die geplante gemeinsame Folge umfasst die bisherigen 16 Fälle und diese vier neuen Fälle. Ein neuer Originalbuild, Artefaktabgleich, sämtliche 20 Browserfälle und der unabhängige Ressourcenabschluss müssen vor einer gemeinsamen Aussage erfolgreich sein. Dieser Schnitt repariert weder Scene-Move/Delete noch innere Scene-Links, den PDF-Parser oder die noch fehlenden MCP-Dateiaktionsadapter. Dateiaktions-Undo und Review Center bleiben aus.

Private Originale: `/private/tmp/canvas-managed-copy-browser20-h_b2itqn/`. Die Source-Pins und tatsächlichen Exit-Berichte liegen dort getrennt von öffentlichen Dokumenten; Zugangsdaten und private Browsertraces gehören nicht in Git.
