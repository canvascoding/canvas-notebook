# Original-Markdown an echte native Importreferenzen binden

Stand: 19. Oktober 2026. Ausgangscommits Root `920c4b397ce754e7557e187a5dac066356960ef8` / QA `2fc140d4e424027c26b0327824e222ab9dcd3259`. Dieser Schnitt implementiert und prüft die physisch/native Vorkommenszuordnung für den noch offenen Raw-Copy-Anschluss. **Die tatsächliche READ-only-Raw-Copy bleibt gesperrt; M1 und MVP bleiben offen.**

## Verhalten und Autoritätsgrenze

`bindPhysicalNativeImportLinks` prüft Originalinventar und vollständige Originalbytes, FD-Version, tatsächliche initiale native Identität/Lineage, Importreceipt, Profil, Binär-/Vektor-/Stateproof und vollständige Byte-Rückserialisierung. Eine gemeinsame Probe mit unterschiedlichen Zielwerten für jedes Vorkommen und die echte gezielte Rückänderung bestätigen die bijektive Zuordnung. Gleiche Linkliterale bleiben verschiedene Vorkommen. Native Referenzen stammen ausschließlich aus dem tatsächlichen importierten Zustand. Scratch-CRDT-Clocks gehen nicht in den deterministischen Beleg ein.

Die Funktion erteilt keine Schreibrechte und authentifiziert keinen SQL-Beleg. Der tatsächliche Owner muss die FD-/SourceCapture- und Operationsbindung zusätzlich beweisen. Der Output enthält keine Originalbytes, Updates oder Grants. Descriptorprüfungen, gemeinsame Größen-/Arbeitsbudgets und Grenzen vor Kopie/Parse begrenzen feindliche oder zu große Eingaben. Nicht belegbare Rich-Metadaten/Syntax bleiben ausdrücklich unsupported.

## Neuer expliziter Inspektionsarm, historische V2 unverändert

Die erste tatsächliche reine Probe findet einen realen Unterschied: V2 zählt bei Plain-Text die letzte YAML-Frontmatter-Zeile als Setext-Überschrift. Beispiel: `tags: [tag]` erscheint zusätzlich zur tatsächlichen Überschrift `Note`. Der vollständige Physical/Native-Metadatenvergleich lehnt dies ab; er wird nicht gelockert.

Die additive `NativeDocumentLinkInventoryV3` behält `contractVersion: 2` und verwendet ausdrücklich `parserVersion: 3`. Für Plain werden Überschriften und Caret-Block-IDs ausschließlich aus dem bereits geparsten Markdown-Body gewonnen. Rich-Struktur und Linkreferenzen behalten ihre Bedeutung. `inspectNativeDocumentLinksV3` / `inspectPersistedDocumentLinksV3` sind neue Exporte; nur der neue Import-Binder verwendet sie. Der vollständige frühere Modultext einschließlich beider V2-Funktionskörper bleibt bytegleich als Präfix erhalten. Die erste Testfamilie bestätigt zusätzlich den weiterhin identischen V2-Gegenfall und die korrigierte neue V3-Ansicht. SourceEvidence 4 und die bisherigen Copy-/Move-/Deleteverträge werden nicht umgedeutet.

## Tatsächliche Prüfungen

`binding-validation3` besteht für Typen, Scoped-ESLint, neun ausdrücklich aufgerufene reine Familien und sieben echte Originalimport-/PG18-Gruppen. Die reinen Familien verwenden tatsächliche Parser, Importvorbereitung, Yjs-Inventare und native Vorwärts-/Rückänderungen. Sie prüfen Plain mit BOM/CRLF/Unicode/Duplikaten/Wiki/Embed, beide Rich-Repräsentationen, andere Zielpfade/Workspaces, leere Dateien/Profile, pristine Identität sowie manipulierte/feindliche und begrenzte Eingaben. Reine Receipt-Fixtures sind ausdrücklich keine DB-Belege.

Die erweiterte bestehende echte PG-Folge bindet zwei vorherige tatsächliche SourceObservations an die jeweiligen realen Importreceipts, frisch geladenen nativen Zustände und vollständigen ID-Read einschließlich Lineage. Sie vergleicht die FD-Version ausdrücklich mit dem unveränderlichen tatsächlichen OriginalImportRequest. Beide Vorkommensbindungen laufen innerhalb der bestehenden NoWrite-Fenster mit beobachteter SQL-DML/DDL/Notify-Freiheit, vollständigen Domainzeilen/`xmin`, Tabellen-/OID-Inventar und vollständigem DATA-Baum. Die beiden tatsächlichen Importe liegen außerhalb dieser Fenster und behalten ursprüngliche Bytes/Dateiversion. Die übrigen sieben bestehenden Servicegruppen einschließlich ACK-Verlust und echter Sitzungserneuerung bleiben erhalten und bestehen. Dies ist ein beschreibbarer Inplace-Import, kein READ-only-Quell-Copy.

Die neue tatsächliche gewünschte Raw-Copy-Abnahme scheitert auf denselben Quellen noch vor der ersten Gruppe an `MANAGED_COPY_PLAN_IMPORT_REQUIRED`. Sie benutzt echte Quell-READ-/Ziel-WRITE-Rechte und signiertes MCP-JWT; die Vorschau führt keine Migration aus. Die NoWrite-Abschlussprüfungen ersetzen den ursprünglichen Fehler nicht. Nachfolgende Apply-, Linkgraph-, B1-ACK- und SID-B-Recoveryfamilien sind dadurch **ungetestet**. Der ursprüngliche Gesamtlauf endet deshalb mit Exit 1; er ist keine Gesamtfreigabe.

Zwei unabhängige Ressourcenabschlüsse bestätigen entfernte eigene Schema-Namen/OIDs, geschlossene eigene Sessions, entfernten DATA-Baum, beendete Originalprozesse und dieselben vier gesunden verwalteten Dienste. Kein Container wurde gebaut oder neu gestartet.

Erhaltene frühere Fehlversuche: `binding-validation1` endet bei einer uninitialisierten erst später gesetzten Sitzungsvariable am `prefer-const`-Lint; explizite Anfangsinitialisierung mit `undefined` korrigiert die Deklaration ohne Änderung der Sessionrotation. `binding-validation2` und die Metadatendiagnose belegen den tatsächlichen V2-Frontmatter-Unterschied. Der spätere Erfolg beruht auf der neuen ausdrücklichen Inspektionsversion, nicht auf einer gelockerten Metadata-/Byteassertion.

## Noch notwendiger produktiver Anschluss

Plan 5 / Compiler 4 müssen rohe Ziele als echte ungebundene Importanforderungen führen. Stage 6 muss Originalbytes begrenzt und dauerhaft binden. B1 benötigt zentrale tatsächliche Zielimporte, getrennte originale Birth-/Bindingbelege, anschließend native Linkreceipts und Reservationen auf derselben B. Eine native Clone-Receipt darf keine erfundene Quell-ID erhalten. Die tatsächliche Projection-Sperre muss auch diese Raw-Geburten bis B2 erkennen. FD-Publikation darf Originalbytes bestätigen und die Projektion ehrlich pending lassen; der bestehende zentrale Projektor muss ihren späteren Nachlauf ohne geöffnetes Dokument tatsächlich beweisen. Historische Recovery liest ausschließlich vollständige ursprüngliche Belege und bindet niemals einen späteren seq1-/D2-Zustand erneut als Initialzustand.

Diese Protokoll-/Owneranschlüsse werden noch nicht durch die reine beziehungsweise Inplace-PG-Bindung erfüllt. Die bisher im MVP-Plan genannten weiteren Launch-Gates bleiben vollständig bestehen.

## Quellen und Originale

Private Originale: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-raw-copy-birth-z_ax5eva`. `slice-acceptance.json` bindet die tatsächlichen positiven und negativen Originale sowie diese Quellen. Neue Symbole sind im veralteten GitNexus-Index UNKNOWN; fehlende Treffer gelten nicht als Sicherheitsfreigabe.

| Produkt-/Testquelle | SHA-256 |
| --- | --- |
| `app/lib/markdown/physical-native-import-binding.ts` | `6548b9255c235e8dc26d0fc83bc283c50aea45b13c9ece381d4bc0b4b13645ef` |
| `app/lib/markdown/workspace-native-link-inventory.ts` | `4a254e3cc81db5ffe2b55feed8192516a495bf0a8007725d17b51d75f8e94e4e` |
| `scripts/explicit-original-markdown-import-postgres-test.ts` | `c22dffeec2bf3bd80620c8bffdcfe493c768d0c28954aab19ffb2df17ee6f60f` |
| `scripts/physical-native-import-binding-test.ts` | `0c412d516ecf4b8b26cc4d6aea6a65ceac22b0507fc70c22ace51fed539757d9` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `9c25b0fe669b23918b6c5620e794d16c2d1898b650ac15b11676ada66161781c` |
| `scripts/workspace-operation-selected-raw-copy-postgres-test.ts` | `508b17bd257c83d25814a2ceb624c2ae71e58185ac6e3268f537179f069a0990` |

`slice-acceptance.json` SHA-256: `ced357a1fc0c89f49828ada97acbbf83cfc58cb14ee4cd54f6e6a658a3e98c61`.
