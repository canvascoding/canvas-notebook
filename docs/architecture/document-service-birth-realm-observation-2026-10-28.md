# Dokumentservice: gemeinsame Beobachtung des Anlagebelegs

Stand: 28.10.2026. Dieser Schritt bündelt zwei unmittelbar benachbarte Abfragen
im bestehenden Anlageablauf. Er gehört zu Paket 2 des
[Gesamtplans](../document-write-database-performance-plan.md); dessen Budgets
und übrige Pakete bleiben erforderlich.

## Änderung

`assertAuthenticatedMarkdownBirth` liest den aktuellen Speicherbereich und die
ursprüngliche Zeile aus `collaboration_markdown_create_births` gemeinsam auf
derselben tatsächlich gehaltenen Verbindung. Zwischen den bisherigen beiden
Abfragen lag weder ein Callback noch eine Mutation. Jede bisherige Prüfstelle
bleibt eine neue SQL-Beobachtung. Es entsteht kein Rechte- oder Datenzeilencache.

Der gemeinsame reine Validator verwendet dieselben Bedingungen für Schema,
Relationen, Datenbank und Suchpfad wie die bisherige Einzelprüfung. Eine fehlende
Belegzeile bleibt auch dann erkennbar, wenn der Kontext gültig ist. Die Rohwerte
der Zeile durchlaufen weiterhin den PostgreSQL-Treiber; JSON-Konvertierung wird
dafür nicht eingeführt. Interne Kontextspalten werden zuletzt und mit getrennten
Namen ausgewählt, damit zusätzliche Tabellenspalten sie nicht ersetzen können.
Eine beim Planen fehlende Relation führt zur bisherigen Kontextverweigerung;
eine abgebrochene Transaktion wird nicht wiederholt.

Zwei bestehende Funktionen ändern sich, ein reiner Validator kommt hinzu.
116 weitere Funktionen der Persistenzdatei bleiben bytegleich. Lebensdauer,
Sperren, aktuelle Rechte, native Versionsprüfungen und dauerhafte Originalbelege
bleiben erhalten. GitNexus meldet für den bisherigen Bereichsprüfer fünf direkte
Aufrufer und mittleres Risiko; die tatsächlichen Aufrufer sind zusätzlich geprüft.

## Echte PostgreSQL-Prüfungen

`npm run test:documents:create:birth-realm` besteht mit zwölf Fällen über die
registrierten Agenten-/MCP-Werkzeuge und den tatsächlichen Python-Speicherhelfer.
Zehn Fehlerfälle ändern auf der wirklichen gehaltenen Verbindung Suchpfad,
Tabellenzuordnung, Beleganwesenheit, Claim-Fingerprint oder Generation. Der
jeweils nächste erhaltene Validator verhindert die Dateiveröffentlichung.

Der normale Datenbanktrigger verbietet bereits Änderungen am unveränderlichen
Beleg. Für die zusätzlichen Korruptionsfälle wird er ausschließlich in der
eigenen fehlgeschlagenen Testtransaktion durch echte DDL deaktiviert. Anschließend
sind ursprüngliche Zeilen samt `xmin`, native Bytes, Receipt und der tatsächlich
wieder aktivierte Originaltrigger geprüft. Eine explizite Wiederholung desselben
Schlüssels behält Operations-, Dokument-, Lineage- und Claim-Identität und schreibt
den vollständigen ursprünglichen Unicode-Inhalt.

Zusätzliche gleichnamige Spalten mit falschen Kontext-/Anwesenheitswerten bleiben
in der Testtabelle vorhanden; alle nachfolgenden Fehlerfälle und erfolgreichen
Wiederaufnahmen bestehen dennoch. Zwölf echte Publikations-ACKs behalten jeweils
genau eine gemeinsame Kontext-/Belegabfrage und keine zusätzliche einzelne
Belegabfrage. Positive SQL- oder Helferantworten werden nicht ersetzt.

Neun bestehende PostgreSQL-Suiten bestehen unverändert: native Beobachtung,
Publikationsgrenzen, Owner-Beobachtung, Agenten-Speicherphase, verlorene
Agenten-COMMIT-Antworten, MCP-Speicherphase, native MCP-Anlage, authentifizierter
Upload und vollständige manuelle Anlage. Der Upload umfasst 16 Testfamilien,
die manuelle Anlage 15 einschließlich wirklicher Prozess-/Backend-Beendigung.
Die jeweiligen eigenen Aufräumprüfungen und der tatsächliche Exitcode bestätigen
den Abschluss. Release-TypeScript, gezieltes TypeScript mit 20 Wurzeln/5083 Quellen
und null Diagnosen sowie gezieltes ESLint bestehen.

## Direkter Vergleich

Vier neue Fixtures laufen nacheinander: bisheriger/neuer Agenten- und
bisheriger/neuer MCP-Ablauf, jeweils mit zehn über normale Uploads angelegten
Quellen. Baseline ist `bb0636aa67a4760648699d64ec830b48e910369b`. Der temporäre
Baseline-Checkout baut sein natives Modul aus dem tatsächlichen damaligen
Quellstand; keine Dateisystem-Schutzprüfung wird umgangen. Beide Varianten
verwenden dieselben vorhandenen Node-Abhängigkeiten und Messgrenzen.

| Fenster | Vorher: SQL / Ausleihen | Jetzt: SQL / Ausleihen |
| --- | ---: | ---: |
| Agent – erster Einstieg und Anlage | 1840 / 80 | 1800 / 80 |
| Agent – warme Anlage, beide Fenster | 1735 / 46 | 1695 / 46 |
| Agent – ursprüngliche Wiederholung | 168 / 7 | 168 / 7 |
| MCP – erster Einstieg und Anlage | 1333 / 46 | 1293 / 46 |
| MCP – warme Anlage, beide Fenster | 1312 / 33 | 1272 / 33 |
| MCP – ursprüngliche Wiederholung | 102 / 12 | 102 / 12 |

In allen 16 Messfenstern bleiben offene Verbindungen/Abfragen, fehlgeschlagene
Anweisungen und unbekannte Queryformen null. Ursprüngliche Registry-/Lineage-/
Native-/Metadatenzeilen samt `xmin` und physische Bytes bleiben je Fixture exakt
erhalten. Alle eigenen Datenbanken-Schemas, Datenverzeichnisse, Bundles,
Verbindungen und der temporäre Baseline-Quellordner sind geschlossen/entfernt.
Die Zeitwerte sind diagnostisch; dies ist keine kontrollierte Latenzabnahme.

Die Einsparung von 40 Aufrufen pro Neuanlage erreicht das Gesamtbudget weiterhin
nicht. Die abschließenden Größen-/Latenz-/Parallelitätsvergleiche, weitere
Bündelung, inkrementelle Links und gemeinsame normale Schreibwege bleiben offen.
Die Browserabnahme am vorherigen Produktstand ersetzt keine finale Build-/UI-/
Gesamtsuite-Abnahme des noch laufenden Umbaus. Review Center und Undo werden nicht
weiterentwickelt; Produktion und veröffentlichtes Release sind unverändert.
