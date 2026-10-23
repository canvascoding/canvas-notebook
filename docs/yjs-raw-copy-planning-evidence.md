# Raw-Copy: Zielimportplanung

Stand: 19. Oktober 2026. Geprüfter Ausgangscommit Root `5122be4367d602f62d1f0745f192392aff590564`; dieser Schnitt ergänzt ausschließlich die Planung. Der öffentliche Copy-Owner verwendet weiter den bisherigen Vertrag. Die tatsächliche READ-only-Raw-Copy-Gegenprobe bleibt am bisher dokumentierten `MANAGED_COPY_PLAN_IMPORT_REQUIRED`; ein neuer öffentlicher Apply-Pass wird hier nicht behauptet.

## Verhalten

`compileWorkspaceMixedImportCopyBatchV4` erweitert den gemeinsamen Compiler um einen ausdrücklichen Vertrag 4 für genau eine Copy-Anfrage. Tatsächliche physische Inventare bleiben Quellen ohne erfundene native Identitäten. Logische Ziele erhalten `unbound-import`, eigene Anforderungen für Originalhash/FD-Fakten/Zielpfad und getrennte physische Vorkommensbindungen. Deren Link-Intents beschreiben Zielpfad, Fragment, Alias und Embed; native Referenzen und native Schreibwerte entstehen erst nach tatsächlichem Zielimport und Binder.

Managed-Plan 5 bindet SourceEvidence 4, die vollständige Compilation, neue Pfadprojektion sowie tatsächliche `prepareMarkdownFileImport(originalBytes, auto)`-Ergebnisse. Der strikte begrenzte Decoder prüft den transportierten Plan, Quellen und Zielanforderungen. Er ersetzt keine aktuelle Autorisierung und kann aus einem historischen Inventar allein keinen heutigen nativen Inhalt oder die ursprüngliche Profilwahl neu beweisen. Stage 6 muss mit tatsächlichen nativen Records und gespeicherten Originalbytes erneut kompilieren.

Historische V2-/V3-Einstiege behalten ihre bisherigen Ergebnisse. Physische Quellen und Importpolicy verwenden weiter Parser 2; die separate neue native Binder-Zielinspektion 3 ist ein anderer Vertrag. Plan 4 und SourceEvidence 4 sind unverändert.

## Tatsächliche Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| Cachefreies gezieltes TypeScript | Exit 0 |
| Scoped ESLint aller sechs Code-/Testdateien | Exit 0 |
| Neuer reiner Plan5-/Compiler4-Test | Acht Familien, Exit 0; tatsächlicher Parser und Yjs-Konstruktor, keine SQL-/FD-Autoritätsbehauptung |
| Drei unveränderte vorhandene Node-Programme | 37 Tests bestanden, keine übersprungenen Fälle |
| Tatsächlicher Vorher-/Nachhervergleich mit vor der Änderung gesicherten Root-Modulen | 60 V2-Pläne, 63 V2-Compiler, 300 V3-Pläne und 315 V3-Compiler vollständig bytegleich; darunter 158 bereite Ergebnisse |
| Unabhängiger lesender Quellenreview | Keine konkreten P1/P2-Befunde; weitere Owner-Abnahme ausdrücklich offen |

Die 738 Vergleiche verwenden dieselben tatsächlichen Yjs-Ausgangszustände für alte und neue Module über alle drei Repräsentationen. Sie enthalten Move/Rename/Copy/Delete, Cross-Workspace und geordnete Folgen, unveränderte sowie linktragende physische Quellen, Aliasauflösung und abweisende Versions-/Proof-/Coveragefälle. Die physischen Identitäten sind in dieser reinen Vergleichsprobe ausdrücklich modelliert; kein aktueller Principal oder echter Dateideskriptor wird behauptet.

Erhaltene Vorstufen: Der erste gezielte Typecheck findet drei echte Typfehler. Die Korrektur vervollständigt das neue Pfadmapping um den bereits geprüften Zielworkspace, erhält bei der Union-Typverengung die bisherige Property-Reihenfolge und bindet die nachweislich leere V2-Testcoverage explizit. Die nächste reine Folge findet zusätzlich die unvollständige neue Decoder-Pfaderwartung; diese wird ebenfalls um den Zielworkspace ergänzt. Der erste private Paritätsstarter scheitert vor Testbeginn an der Auflösung installierter Pakete außerhalb des Repositories. Die zweite Probe verwendet einen privaten `node_modules`-Link auf die tatsächliche Root-Installation. Kein Produktpaket, Export oder Test wurde dafür ersetzt.

Die akzeptierten sechs Quellenpins bleiben während der Typ-/Lint-/Purefolge unverändert. Die akzeptierte Paritäts-/Bestandsfolge prüft alle 1.200 tatsächlichen Bundle-Eingänge vor/nach Ausführung auf unveränderte Bytes. Keine Container-, Datenbank- oder Produktionsaktion erfolgt.

Private Originale: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-raw-copy-birth-z_ax5eva/`, Unterordner `plan5-before`, `plan5-validation1` bis `plan5-validation3`, `plan5-parity` und `plan5-parity2`. Finaler unabhängiger Review: `/private/tmp/canvas-raw-copy-planning-final-ro-review-20261019.md`.

## Noch notwendiger Anschluss

Stage-6-Speicherung der Originalbytes, tatsächlicher atomarer B1-Zielimport mit stabilen IDs und Vorkommensbindung, zentrale native Linkänderungen, vollständiger B2-Katalog-/Graphabschluss, dauerhafter Projektionsschutz und gebundene historische Wiederaufnahme fehlen weiterhin. Dieser Planungsschnitt schließt M1 nicht und ist keine öffentliche Copy-, Browser-, Produktions- oder MVP-Freigabe.
