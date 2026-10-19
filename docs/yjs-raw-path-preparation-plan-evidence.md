# Raw-Move/Delete: reiner Importvorbereitungsplan

Stand: 19. Oktober 2026. Produktbasis vor diesem Teilschritt: Root `5b42214fb600d385747e2396bb585d5a556354a7`.

## Umgesetzt

`workspace-path-import-preparation-plan.ts` ergänzt einen getrennten, nicht ausführbaren Vertrag für Move/Rename/Delete. Die bestehenden Batchpläne 1/2/3, historischen Source-Evidence-Verträge und Owner werden nicht geändert. Aus vollständiger tatsächlich reparster V3-Quellen-Evidence entstehen ursprüngliche Pfadwirkungen, die deduplizierte Raw-Importkohorte, physische Linkintents und Importprofile aus den Originalbytes. Zukünftige native IDs, Referenzen oder Schreibwerte werden nicht erfunden.

Ausgewählte Raw-Dateien einschließlich Ordnernachfahren benötigen Import. Überlebende unselektierte Quellen benötigen ihn nur bei konkretem Rewrite/Unlink; ein weiterhin identisch aufgelöster Alias bleibt lesend. Eigene Links gelöschter Quellen entfallen. Ursprünglich fehlende/mehrdeutige Links dürfen durch die Aktion nicht unbemerkt aufgelöst werden. Ein vollständiger abschließender Kantenvergleich erhält diese Konflikte als Blocker. Vorher-/Nachher-Graphnachweise binden auch den vollständigen Namespace bei Aktionen ohne Links. Decoder rekonstruiert die abgeleiteten Daten; Current reparst die frischen Originalbytes und berechnet den Plan erneut. Diese Datenprüfung erteilt keine Autorität.

## Tatsächlich ausgeführte Prüfung

Die separate Runnerdatei ruft den exportierten Test tatsächlich auf; der bestehende echte ESM-Runner bindet die kritischen Produktquellen genau einmal ein. Auf unveränderten **4.172** Produkt-/Test-/Typ-/Paketquellen bestehen:

- gezieltes TypeScript: Exit 0, 18,224 Sekunden;
- Scoped-ESLint: Exit 0, 1,896 Sekunden, keine Lintwarnung;
- neue Vorbereitung: **14/14 reine Testfamilien**, Exit 0;
- unveränderte Raw-Copy-Planung: **8/8 reine Familien**, Exit 0.

Geprüft sind Originalbytes und echte private Yjs-Zustände als reine Codeceingaben, Auswahl/Ordnernachfahren, doppelte Linkvorkommen, stabile Aliase, ausgehende relative Links verschobener Raw-Quellen, Delete-Unlinks, Missing-/Ambiguous-Capture, Kollision/Überlappung, BOM/CRLF/Unicode, veränderte Originalbytes/Identität/Scope, historische Manipulationen, Getter/Proxy und Größenlimits. Ein vollständiger rekursiver Vergleich prüft unveränderte Inputs und eingefrorene Ergebnisse.

Ein konkreter Reviewbefund wird zuerst tatsächlich rot: Ein ausgewähltes Raw-Dokument mit weiterhin aufgelöstem Notebook-URL-Link meldete Importbereitschaft, obwohl der folgende Native-Planner dieses Format ausdrücklich ablehnt. Der neue Guard prüft diese bekannte Beschränkung vor dem Abbruch bei unveränderter Auflösung. Derselbe Test besteht danach, während unselektierte stabile Aliasquellen weiterhin ohne Import bleiben. Ein zusätzlicher neuer Requestguard verwirft ungepaarte UTF16-Surrogate vor dem bestehenden URI-Formatter. Eine reine Test-Typkorrektur erhält leere Tupel im veränderlichen Klontyp; keine Laufzeit oder Assertion wird dafür gelockert.

## Quellen und Originale

| Quelle | SHA-256 |
| --- | --- |
| Produktmodul | `d1a726757a03be78d7e8139b564156562772f1e01c44d78226703d6a24993f80` |
| Test | `f1fd457dadfbe78a9e0c41d3ba44be47cf1a3c3a3c8d0cb91e4e579767da8e2f` |
| Ausführender Runner | `3b1daec0010a7ad0ebf867cd75e63b543ea39b84f644f876bdb9e24a3c8a5ec6` |
| Finales `terminal.json` | `0458e45f96ab7031d084bd9997887e18580b94b03a15ef56a0ed47453f764421` |

Private Originale: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-raw-path-prep-kv4qcbnp`. Elternlauf: ursprünglicher TypeScript-Exit 2 ausschließlich im Test-Klontyp. `run2`: TypeScript/Lint Exit 0, unveränderter fachlicher Notebook-URL-Test Exit 1. `run3`: alle vier Programme Exit 0, Quellen vor/nach identisch. Beide tatsächlichen ESM-Temporärverzeichnisse werden bestätigt entfernt; die ursprünglichen Runner-/Compilerprozesse enden. Es wurde kein Container gebaut oder neu gestartet.

GitNexus weist den vorhandenen gemischten Planner mit vier direkten Aufrufern und einem betroffenen Prozess als MEDIUM aus. Er wird nicht verändert. Neue Symbole sind im bestehenden Index nicht vorhanden und bleiben beim Vorab-Impact ausdrücklich UNKNOWN; fehlende Treffer werden nicht als Nullrisiko behandelt. Unabhängige Quellenreviews und die engen Folgeprüfungen der drei Produktkorrekturen melden abschließend keine weiteren konkreten P1/P2.

## Verbleibende Ausführung

Dies ist eine reine Planabnahme. **Der öffentliche Move/Delete-Service verwendet diese Vorbereitung noch nicht.** Sie führt keine Originalimporte, SQL-/FD-Mutationen oder HTTP-/Browseraktionen aus und ist keine M1-/MVP-Freigabe. Auf einem eigenen tatsächlichen B0 müssen Originalimporte, Physical→Native-Bindungen, frischer vollständiger Native-Plan und dauerhafter Vorbereitungsbeleg gemeinsam entstehen. Aktuelle echte Web-/MCP-Principals, FD-/Lifecycle-Fences, bestätigter Commit sowie ursprüngliche Status-/Recoverybindung bleiben anzuschließen. Der öffentliche Auftrag muss seine ursprüngliche Preview-ID behalten; der echte neue native Plan erhält seine eigene belegte ID. Keine stille Neuplanung bei Retry.

Danach folgen die tatsächliche Owner-/PG-/FD-/Recoveryabnahme und die übrigen Gates des [MVP-Launchplans](./yjs-document-authority-mvp-launch-plan.md). Produktionsaktivierung bleibt aus; Dateiaktions-Undo und Review Center bleiben aus.
