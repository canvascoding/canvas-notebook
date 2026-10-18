# Copy wartet begrenzt auf reguläre Workspace-Reader

Stand: 18. Oktober 2026. Lokale Korrektur innerhalb des weiterhin offenen Copy-/Dokumentauftrags. Allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben ausgeschaltet.

## Ausgangsbefund

Der [kompilierte gemeinsame Browserlauf](./yjs-scene-document-tree-evidence.md#dritter-build-und-erste-gemeinsame-browserfolge) auf Root `6af340bf6` / QA `190d713c6` endet mit fünf bestandenen und einem fehlgeschlagenen Copy-Fall. Die übrigen 14 vorgesehenen Fälle werden nicht gestartet. Nach erfolgreicher mobiler Vorschau antwortet Apply mit `409 NATIVE_COPY_LIFECYCLE_BUSY`. Die vorherigen Persistenz- und Raumfreigabeprüfungen bestehen; temporäre Poll-Abweichungen sind keine terminalen Versionsfehler.

Die Fehlerstelle ist der sofortige `pg_try_advisory_lock` im ursprünglichen dedizierten Copy-Owner. Ein Tree-GET überlappt Apply und verwendet denselben Workspace-Key geteilt. Der ursprüngliche Lockhalter bleibt aus dem Trace unbekannt. Die folgende Gegenprobe konstruiert deshalb ausdrücklich einen bekannten regulären Reader, ohne ihn nachträglich als den ursprünglichen Halter auszugeben.

## Kontrollierte Gegenprobe und Änderung

Die neue PG-Suite verwendet die bestehende private Metadata-Owner-Fixture mit tatsächlichem Upload, signiertem Fixture-Cookie und gewöhnlichem Copy-Service. Nach vollständiger Vorschau hält `withNativeWorkspaceFilesRead` einen echten READ-ONLY-Reader auf einem initialisierten Yjs-Dokument ohne Markdown-Projektion. Der Callback hält seine geteilte Admission-Sperre; eine separate tatsächliche Owner-Verbindung versucht Copy. `pg_locks` und `pg_blocking_pids` liefern die Synchronisation, SQL-Antworten und Principals werden nicht ersetzt.

Auf unverändertem Produktcode endet der erste Fall nach 18,809 Sekunden tatsächlich mit Exit 1: Copy liefert sofort `NATIVE_COPY_LIFECYCLE_BUSY`, bevor eine wartende exklusive Lockzeile beobachtet werden kann. Reader, Owner, privates Schema und DATA schließen auch bei diesem Fehler vollständig.

Die Produktänderung betrifft ausschließlich `withSession`: Der bestehende dedizierte Owner erwirbt dieselben sortierten, deduplizierten Workspace-Keys jetzt blockierend unter seinem bereits vorhandenen `lock_timeout='4s'` und `statement_timeout='5s'`. Nur `55P03` dieses einzelnen Akquisitionsaufrufs wird mit erhaltener Ursache auf `NATIVE_COPY_LIFECYCLE_BUSY` abgebildet. Andere Fehler und unbestätigter Sessionabschluss bleiben Fehler. Aktuelle Principal-, Scope-, Versions- und Publikationsprüfungen folgen nach vollständigem Erwerb; die Gesamtoperation wird nicht wiederholt.

Die vier Sekunden gelten **pro Key**. Eine Kopie zwischen zwei Workspaces kann deshalb bis zu acht Sekunden auf Datenbanksperren warten. Das ist keine Gesamtfrist einschließlich eines vorgelagerten lokalen Mutex. Bei einem Fehler nach Erwerb des ersten Keys wird weiterhin die ganze tatsächliche Session mit allen eigenen Locks verworfen.

## Tatsächliche Ergebnisse

| Prüfung | Ergebnis |
| --- | --- |
| Ursprünglicher Produktcode, kontrollierter Shared-Reader | Echter RED, Exit 1 mit sofortigem Busy |
| Readerfreigabe nach belegtem exklusivem Wait | Copy abgeschlossen; neue Dokument-/Lineage-Identität, vollständige Receipts und unveränderte Quelle |
| Reader bleibt auf demselben Workspace bestehen | Tatsächliche Vier-Sekunden-Grenze, Busy, keine Stage/Clone-/Journalgeburt; Reader bleibt gültig |
| Schreibrecht im Ziel während der belegten Wartephase entzogen | Aktuelle Principal-Prüfung verweigert Copy vor der Publikation |
| Vollständige neue PG-Folge | 3/3, tatsächlicher Exit 0 nach 32,062 Sekunden |
| Unabhängiger Ressourcenabschluss von RED und GREEN | Zwei Schemanamen/OIDs und ihre Sessions sowie zwei DATA- und Bundleverzeichnisse abwesend; vier verwaltete Dienste unverändert gesund |
| Scoped-Lint der drei geänderten Code-/Testdateien | Exit 0 |
| Cachefreier vollständiger Compiler mit acht GiB | Tatsächlicher Exit 2 nach 78,038 Sekunden, bytegleich die 69 geerbten Main-Diagnosen; keine zusätzliche Diagnose |
| Bestehende vollständige Owner-Folge | 25/25, tatsächlicher Exit 0 nach 619,060 Sekunden |
| Gemischte Managed-Owner-Folge | 7/7, tatsächlicher Exit 0 nach 166,759 Sekunden |
| Unabhängiger Abschluss der beiden Regressionsprogramme | Zwei weitere Schemanamen/OIDs und Sessions sowie zwei weitere DATA- und Bundleverzeichnisse abwesend; vier verwaltete Dienste unverändert gesund |
| Neuer Originalbuild und vollständige Browserfolge 20/20 | Noch ausstehend |

Der unabhängige Codereview bestätigt den einzelnen Funktionshunk, enge Fehlerzuordnung, erhaltene Sortierung, Sessionentsorgung und aktuelle Rechteprüfung. Er ersetzt keine Laufprüfung. Die neue Dienstfolge ist kein HTTP-/Browsernachweis und beweist den ursprünglichen mobilen Lockhalter weiterhin nicht.

Der erste reine Ressourcenbeobachter erwartete zunächst acht statt der tatsächlich zwei neu angelegten Fixtures und stoppte vor dem Datenbankzugriff. Beide Originalprogramme legen jeweils genau eine Fixture für sämtliche ihrer Gruppen an. Nach Abgleich mit diesen Quellen und den tatsächlichen Anlagebelegen prüft der korrigierte Beobachter genau die beiden ursprünglichen Namen/OIDs sowie deren Prozesse, Verzeichnisse und Bundles erfolgreich. Die Produkt- und Testprogramme werden dafür nicht geändert oder wiederholt.

Private Originale: `/private/tmp/canvas-copy-reader-contention-a4948rqu/`. Geprüfte neue Testdatei: SHA-256 `87e502979bafa0d00683d735c5f9d0dd7992a2e4a6300c8b0e538f597e05bc94`; Produktdatei nach Korrektur: `279ea544c790a9871c932c210e5692ed4a0bf5173ab8dd217c5fcc2b798d287e`. Der vollständige Typvergleich bleibt an die geerbte Ausgabe mit SHA-256 `f87d64a219dd9317c7a22890a2687240cbf81b79851e829dd8117faa2ea561e3` gebunden. Ursprüngliche Browser-/Buildfehler und ihre Belege bleiben erhalten.
