# Copy-Historie mit echten Fremdschlüsseln

Stand: 19. Oktober 2026. Ausgangscommit Root `07207ae1bd414b67187a06b7c71e77eea5bdd5d9`. Der strikte historische Parentreader verträgt jetzt echte PostgreSQL-RI-Trigger, während sein fachlicher Unveränderlichkeitstrigger unverändert geprüft bleibt.

## Reproduzierter Fehler und Korrektur

Der bisherige Reader zählt alle Trigger der Parenttabelle und verlangt genau einen. Ein echter referenzierender Fremdschlüssel erzeugt zwei zusätzliche interne Parenttrigger. Die neue tatsächliche Gegenprobe erstellt einen solchen FK mit bekanntem Tabellen-/Constraint-OID und führt einen gültigen Child-INSERT aus. Danach scheitert der unveränderte Produktreader in `storage-after-real-foreign-key` mit `NATIVE_COPY_HISTORY_STORAGE_CHANGED`; Originalprozess Exit 1.

Die einzige Produktänderung ergänzt `AND NOT t.tgisinternal` in der Auswahl des fachlichen Triggers. Sämtliche Namen, OIDs, Body-, Typ-, Timing-, Funktions-, Namespace- und Securityprüfungen dieses Triggers bleiben bytegleich. Interne RI-Trigger gelten damit nicht als Ersatz für den Anwendungstrigger. Ein zusätzlicher echter Anwendungstrigger muss die Storage-/Historyreads weiter abweisen. Nach gezieltem Entfernen ausschließlich dieses zusätzlichen Triggers bestehen dieselben Reads bei weiterhin vorhandenem FK und dessen zwei internen Parenttriggern. Ein tatsächlicher unzulässiger Parent-UPDATE bleibt SQL-55000; Zeile, `xmin`, `ctid` und heutige Dokumentzeilen bleiben unverändert.

## Tatsächliche Prüfung

- Cachefreies gezieltes TypeScript und Scoped ESLint: jeweils Exit 0.
- Vollständige tatsächliche PG18-Historyfolge: **19 Familien, Exit 0**, einschließlich aller bisherigen Fallkörper und der neuen FK-Familie.
- RED und GREEN verwenden dieselben Test-/Runnereinträge; zwischen beiden ändert sich ausschließlich die genannte Produktzeile.
- Die echten Historyreads verwenden weiterhin den bestehenden Caller-RR-/READ-ONLY-/No-XID-/No-current-state-Prüfpfad.
- Drei unabhängige Ressourcenabschlüsse bestätigen entfernte eigene Schemas/OIDs einschließlich Schatten, geschlossene ursprüngliche Backendidentität, geschlossene beobachtete Nodeprozesse und vier unverändert gesunde verwaltete Dienste. Diese Beobachtung ist keine vollständige historische Kindprozessinventur.

Die erste Ausführung erreicht die neue FK-Familie noch nicht: Die ältere Fixture kopiert eine inzwischen benötigte Excalidraw-Operationstabelle nicht. Nach quellenbasierter Prüfung der tatsächlichen Lifecycle-Abfrage und lesender Bestätigung der vorhandenen öffentlichen Vorlage wird nur diese Tabelle in die isolierte Fixture aufgenommen. Der nächste tatsächliche RED und finale GREEN verwenden beide genau diese vervollständigte Fixture. Keine Produktmigration oder produktive Tabelle wird verändert; sämtliche negativen Originale bleiben erhalten.

Der neue feste ESM-Runnereintrag verwendet die vorhandene reale Suite über einen additiven Exportalias, dieselben Originalmodule und tatsächlichen Konstruktoren. Die alte CLI-Einstiegsprüfung bleibt erhalten. Der Wrapper verlangt die verwaltete PG-Konfiguration, sodass dieser Einstieg nicht erfolgreich ohne Datenbank überspringt. Fixture-Open-/Close-Ausgaben machen die tatsächlichen Ressourcen nachprüfbar.

Private Originale: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-raw-copy-birth-z_ax5eva/`, Ordner `parent-fk-before`, `parent-fk-red`, `parent-fk-red2`, `parent-fk-green` und `parent-fk-slice-acceptance.json`.

Diese Korrektur ermöglicht den folgenden Raw-Birth-FK-Anschluss; dessen Migration, tatsächlicher B1-Import, Cohort-/Graphabschluss und Recovery sind hier noch nicht integriert. Der neue Birth-Historykandidat bleibt privat und benötigt seine eigene echte Abnahme. Keine Produktionsaktivierung oder MVP-Freigabe.
