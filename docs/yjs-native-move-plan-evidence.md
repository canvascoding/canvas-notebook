# Nativer Move-/Rename-Planvertrag

Stand: 16. Oktober 2026. Diese Etappe ergänzt den fehlenden privaten Jobplan für native Pfadänderungen. Sie ist eine Planungsgrundlage, keine freigeschaltete Move-Ausführung. Datei-Undo und Review Center bleiben aus. Der vollständige Auftrag umfasst weiterhin Verschieben, Kopieren und Löschen einschließlich zentraler Linkpflege sowie API/MCP/SDK/Suche/PDF und die integrierte Endabnahme.

## Vertrag und vorhandene Mechanik

[workspace-operation-native-move-plan.ts](../app/lib/files/workspace-operation-native-move-plan.ts) erzeugt Version 3, `kind:native-path-change`, mit genau einer Move-/Rename-Aktion und bis zu 1000 Auswahlen innerhalb desselben Workspaces. Eine Auswahl kann eine Datei, einen vollständigen Ordner oder ein Asset betreffen. Die ursprüngliche vollständige Quellenbeobachtung enthält Namespace, native Inventare, Dokument-/Lineage-/Generations-/Bytebelege und den vollständigen Workspace-Scope. Ein verschobenes PDF benötigt keine erfundene native Dokumentidentität; eingehende Links aus nativen Notizen werden dennoch geplant.

Der bestehende native Dateioperationsplaner berechnet sämtliche Pfadzuordnungen sowie eingehende und relative ausgehende Linkrezepte. Der bestehende Mixed-Batch-Compiler probt diese Wirkung auf tatsächlichen Yjs-Bytes in Plain/XML/Blocks und prüft den vollständigen virtuellen Ergebnisgraphen. Es wird kein zweiter Link- oder Clone-Motor eingeführt. Markdown-Projektionen, V1-Spans oder erfundene Dateihashes ersetzen keinen nativen Inhalt.

Der private JSON-Plan speichert den vollständigen deterministischen Pfad-/Rezeptsatz und zwei kompakte Compilerbelege: `compilerPlanProof` und `finalGraphProof`. Die nativen Binärzustände und der große Compilerkörper werden darin nicht zusätzlich dupliziert. Der historische Decoder rekonstruiert den Pfadplan vollständig aus den ursprünglichen Quellen und prüft exakte Felder, Scope, Hashsyntax und Gesamtintegrität. Die beiden opaken Compilerhashes sind in dieser Phase ausdrücklich Daten, keine bewiesene aktuelle Ausführbarkeit.

`assertWorkspaceOperationNativeMoveBatchPlanCurrent` prüft zuerst die neue vollständige Quellenbeobachtung gegen die ursprünglichen nativen Zustände und den gesamten Scope. Anschließend läuft der wirkliche Compiler erneut mit dem **ursprünglichen Namespace** und den frisch nachgewiesenen nativen Bytes. Beide tatsächlichen Compilerbelege müssen exakt übereinstimmen. Eine reine native Projektionsänderung oder erlaubte Verzeichniszeitänderung wird nicht als Inhaltsänderung behandelt; native Änderung, Generationen-/Scopewechsel und Assetersatz bleiben Konflikte. Die Funktion gibt Compilerdaten zurück und erteilt keine Actor-, Claim-, Raum- oder SQL-Autorität.

`readiness:ready` bezeichnet ausschließlich Planbarkeit. `executionReady:false` bleibt fest. V3 ist weder in die ausführbare Batchunion noch in Producer, Router oder Executor eingetragen; der bisherige Delete V2 wird nicht umetikettiert. Ein späterer Job muss diese Daten an seine tatsächliche Übernahme, aktuellen Rechte, Originalintents, Pfad-/Raumfences und Abschlussbelege binden.

## Gemeinsame Datenaufbereitung

[workspace-operation-native-plan-data.ts](../app/lib/files/workspace-operation-native-plan-data.ts) enthält die bisherige begrenzte Delete-Datenerfassung und vollständige native Snapshot-Konvertierung. Delete behält seine lokalen Wrapper und Fehlercodes. Die bisherigen Grenzen und Datenprüfungen bleiben identisch: 16 MiB, 400000 Knoten, Tiefe 40, begrenzte Arrays und ausschließlich eigene Datenfelder ohne Getterauswertung. Die neue Planung verwendet dieselbe Konvertierung. Die Grenzen der ursprünglichen Quellenbeobachtung gelten zusätzlich.

Vor der Extraktion wurden die betroffenen privaten Symbole mit GitNexus geprüft. Die transitive Bewertung war CRITICAL bei zwei beziehungsweise drei direkten Aufrufern und wurde vor Änderung gemeldet; der Graph war als partiell markiert. Original-Delete-Decoder, Compiler und Ausführungsautorität bleiben erhalten. Die ursprüngliche 28er Delete-Planfolge besteht nach der Extraktion mit tatsächlichem Exit 0.

Alle nach Ordnerexpansion abgeleiteten Zielpfade müssen zusätzlich den vorhandenen Kanonizitätsvertrag und die Quellenbeobachtungsgrenze von höchstens 33 Segmenten erfüllen. Die unabhängige Quellprüfung fand zuvor den konkreten Fall eines zulässigen 4096-Zeichen-Ordnerziels, dessen Kindpfad die Grenze überschreitet. Der neue Vertrag weist solche Pläne ab. Der Konstruktor liest auch seine äußeren Felder als eigene Datenfelder; Accessoren werden nicht ausgewertet.

## Tatsächliche fokussierte Prüfung

Die neue [Purefolge](../scripts/workspace-operation-native-move-plan-test.ts) endet auf den eingefrorenen Quellen tatsächlich mit Exit 0: **30/30 bestanden**, keine Skips oder Todos. Echte lokale Yjs-Dokumente werden jeweils verworfen; Registry-/Lineagebeobachtungen sind erklärte Fixture-Daten, keine SQL-, Rechte- oder Ownerbelege.

- Leere und beschriebene Plain/XML/Blocks-Dokumente, native-only und nicht verlustfrei als Markdown exportierbare Rich-Tabelle.
- Eingehende und ausgehende Links mit tatsächlichem nativem Recipe-Apply, vollständigen ursprünglichen Link-/finalen Entity-IDs und Erhalt unabhängiger externer Links.
- Vollständiger Ordner mit internen/externen Links und PDF/JPG-Zielen; eigenständiges PDF als ausgewähltes Ziel nativer Verweise; mehrere Auswahlen und unveränderte Originalidentitäten.
- Tatsächlich 1000 Assetauswahlen sowie Ablehnung von 1001; Kollision, Mehrdeutigkeit, Überlappung, Selbst-/Unterordnerziel und unzulässige Eltern.
- Erweiterte Längen-/Tiefengrenze mit gültigen Kontrollen; Getter, Symbole, Zyklen, Sparsearrays, Prototypen, Versions-/Shape-/Gesamthash- und neu signierte Rezeptfälschungen.
- Neu signierte opake Compilerhashes bestehen ausdrücklich nur den historischen Datencheck und scheitern zwingend am aktuellen echten Compilerreplay.
- Erlaubte Projektions-/Verzeichniszeitänderung gegenüber tatsächlicher nativer Änderung, Scope-/Generations-/Byteprofilabweichung und Assetersatz; kein Herausfiltern unbekannter physischer Markdown-Quellen.

| Eingefrorene Quelle | SHA-256 |
| --- | --- |
| Moveplan | `2ae89eb9e588062508c1125456dbd9b274d7669f6bff64a84f46dd5f1b6bf481` |
| Gemeinsame Datenaufbereitung | `ae1c4585bcb5e43a48176455fe245f7d1feee74f74aeffd14faa1d3e751295b5` |
| Deleteplan nach Delegation | `08719c6a132f723296f3f1b16c064bc2762a7ee23e00f4627ae46858e1b48515` |
| Neue Purefolge | `624b15902bb122e9715b8214fa2fc0fd9c51be1032e3f9f8b1888d34cb3969cc` |

Zwei erste Läufe der neu verfassten Testfolge scheiterten an Fixture-/DTO-Annahmen (21/26 beziehungsweise 25/26); diese wurden anhand der tatsächlichen vorhandenen Verträge korrigiert. Nachfolgende Läufe bestanden 26/26, 29/29 und schließlich 30/30. Daraus wird kein ursprünglicher Produkt-RED/GREEN-Nachweis abgeleitet. Scoped ESLint und die abschließende cachefreie vollständige Typprüfung mit 8-GiB-Heap bestehen. Der frische Build und die bestehende UI-Regressionsprüfung sind nachfolgend getrennt gebunden. Der unabhängige letzte Quellreview hat nach Bounds- und Accessorfix keine weiteren belegten Findings.

## Nächster notwendiger Ausführungsanschluss

1. Den echten Move-/Rename-Claim an ursprünglichen Scope, Plan und aktuelle Actorrechte binden. Der bisherige Job-Owner und sein Speichervertrag sind ausdrücklich auf Einzel-Delete beschränkt. Die bestehende DA04-Autorität darf nicht konstruiert oder mit diesem Owner verwechselt werden.
2. Native Pfadänderung und Linkdelta eines zugleich verschobenen Quelldokuments müssen denselben bewiesenen Übergang bilden. Eine Linkänderung verändert dessen Clock; ein anschließender Move gegen den alten Snapshot wäre falsch. Die bestehende Combined-Handoff-Mechanik kann nach Beweis ihrer tatsächlichen Autorität verwendet beziehungsweise ihre rein mechanische Transformation geteilt werden.
3. Ursprüngliche physische Quellen und vakante Ziele mit begrenztem dauerhaftem Journal erfassen, FS- und native-only-Pfade behandeln, SQL-/Sideeffect-/Publikationsbelege und Wiederanlauf schließen. Der bisherige physische Rename verschachtelt eigenständige Metadata-/Collaborationwriter und ist kein Same-Connection-Ersatz. Im vorhandenen FD-Backend fehlt außerdem eine echte atomare Rename-No-replace-Operation für Datei und Ordner. Ein vorgelagertes Exists-Prüfen mit anschließendem `fs.rename` schützt keine inzwischen belegte Destination. Die neue FD-relative Primitive braucht getrennte Linux-/Darwin-Belege, Original-/Parent-/Unterbaumpins und tatsächliche Durabilityprüfung beider Eltern; kein Copy/Delete-Fallback, automatisches Rückwärts-Rename oder Aufweichen des privaten Unlinkvertrags. Nach eigener FS-Pfadänderung benötigen Originalnamespace und Assetpfade eine ausschließlich an echte Original-/Stagingreceipts gebundene Zuordnung vor dem B2-Replay. Der bestehende Current-Check akzeptiert keine beliebigen nachträglichen Namespaceänderungen. Pristine Registry-Assets müssen ebenfalls an ihre ursprünglichen Zeilen gebunden bleiben.
4. Erst danach regulären Producer/Executor und Ergebnis-/Cacheereignisse anschließen. Der Router muss native Linkquellen auch dann berücksichtigen, wenn ausschließlich PDF/Bild/TXT ausgewählt ist. Erfolg darf nicht allein aus physischen Dateiprojektionen abgeleitet werden.
5. Echte PG-/API-/Desktop-/Mobile-Abnahme einschließlich eingehender und ausgehender Links, Ordner, Assets, Quellen-/Zielraces, Rollback und verlorener COMMIT-Bestätigung. Copy nutzt anschließend den vorhandenen nativen Clone-/Receipt-Motor samt wirklichem Clone-Link-Rebinding.

Der [zentrale Plan](./central-notebook-file-api-import-plan.md) bleibt maßgeblich. Keine Produktionsänderung oder Behauptung einer funktionierenden nativen Move-/Copy-Ausführung aus dieser Planungsgrundlage.


## Frischer Build und unveränderte bestehende Browserregression

Geprüfter Codecommit Root `63ec6b56ba9e005a193c1f8f22b090170bb5652c` / QA `58503f3d0c19b60176a58ce60fa0067bbe8cce99`; Control Plane `27c8ce37da082244f006ca376068cde6b98845d5`. Die sieben Commitdateien und der vollständige Patch sind in Root/QA identisch. Die drei bekannten historischen Abweichungen und das private QA-Sessiongate bleiben getrennt; die allgemeine Aktivierung im Hauptworktree bleibt aus.

Der frische Originalproduktionsbuild endet mit tatsächlichem Exit 0. Source-Fingerprint `2114f82a1714d0380ffd0b4444d2dd78ae0a2af9c39dc4f12bc591d26ec45660`, Build-Fingerprint `7e63dbf1c6164c7eec5923ce0d3a52dd6512dd76eee348d54df47f9c9811dee7`, Proof-SHA256 `19620aa621846f607cb61f6f6261c8c0d8a86662f06cf1deb9baefbdc7c28861`. Build-Parentlog-SHA256 `3c2af6d3831cc14f15c8a273f3dfcdc5b23f90614f874b1a068b0dec9530e589`.

Danach endet der unveränderte Originalsupervisor mit tatsächlichem Exit 0: **7/7 bestehende Browserfälle**, null Fehler, Skips, Testtimeouts oder Unterbrechungen. Undo-Sperren bestehen auf Desktop/Mobile 2/2, Starter 2/2, Fokus/Breite/Tabelle samt Delete 1/1 und nativer Link-Delete mit vollständigem Richvergleich nach frischem Browser-Reopen 2/2. Originalhelfer, Adapter und Specs sind unverändert. Dies ist die Regression des bestehenden Produktverhaltens nach gemeinsamer Datenaufbereitung, ausdrücklich **kein E2E-Nachweis nativer Move-Ausführung**.

Unabhängiger Postbuild-/Preruntime-Audit-SHA256 `810e07919ea80e6efba80dd9d3d3ecb72eecaa402c2d1ad10601e2b4ddc1bf64`; unabhängiger Postruntime-Audit `57eec1f190ef07d42581bbfe2ccddd5e69a67665b71d7bfc4ee2e621d8db6cf2`. Beide nutzen den Originalbuildguard sowie separate Quell-/Build-Fingerprints; der Nachaudit prüft zusätzlich alle vier tatsächlichen Reports mit dem Originalreportguard. Aktuelle Pins, saubere Heads und ganze bekannte Root-/QA-Abweichungen sind bestätigt. Runtime-Parentlog-SHA256 `494d89bb832616dedc2a87b5d0673ee8bb13ebd7351842dd4c98034fc5f6ba0f`.

Eigene Fixture `canvas-yjs-authority-PXIFoF`: Originalreceipt `cleaned`, `passed:true`, `uncertain:false`, beide eigenen Datenbanken und DATA entfernt. Die danach tatsächlich ausgeführte frische rein lesende Ressourcenprüfung besteht mit Exit 0, SHA256 `c0d060e74caa86fb96a0b2f5266192b6afeb94cbbf73a2f66fcc580e1fc1d3a9`: ursprüngliche PIDs/Gruppen, drei Ports und Runlock frei; beide exakten Datenbanknamen/OIDs und eigene Backends fehlen, eigene DATA/tmp fehlen, Prüfpool geschlossen, drei verwaltete HTTP-Dienste weiter 200. Originalreports und Receipts unverändert, keine Cleanupmutation durch den Verifier.

Der vollständige Ausführungsanschluss und die abschließende gemeinsame Move-/Copy-/API-/SDK-/PDF-/Sandboxabnahme bleiben offen. Keine Veröffentlichung oder Produktionsänderung.
