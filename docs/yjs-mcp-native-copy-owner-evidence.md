# MCP-Copy im regulären nativen Copy-Owner

Stand: 18. Oktober 2026. Der tatsächliche aktuelle MCP-Copy-Principal erreicht jetzt den bestehenden nativen Copy-Owner und dessen feste Veröffentlichungs- und Recoveryphasen. Öffentlicher MCP-Handler, reine Status-/Recoveryadapter, Ansichtsfinalisierung im öffentlichen Dienst und SDK-Dateiaktionen sind weiterhin eigene offene Anschlüsse. Der normale Aktivierungsschalter bleibt aus.

## Gemeinsamer Owner und aktuelle Autorität

V2-Herkunft bezeichnet die ursprüngliche Operation und erteilt keine Rechte. Der aktuelle opake `mcpPrincipal` wird separat im Aufruf gehalten. Die private Registryprüfung prüft vor Poolbezug Brand, Capture-Lifetime, feste Quelle/Ziel und Ablaufzeit; sie ersetzt keine SQL-Berechtigungsprüfung. Ein abgefangener falscher Brand-, Scope- oder Busy-Aufruf vergiftet den tatsächlichen Capture. Die gemeinsame bisherige Ablaufprüfung von JWT und Lizenz ist unverändert in einen privaten Helfer ausgezogen.

Owner und Phasen wählen für V2 ausschließlich den tatsächlichen MCP-Adapter. Jede feste B-Phase prüft Quelle READ und Ziel WRITE einschließlich aktueller Session-, Consent-, Client- und Workspacegrants auf ihrer geliehenen Verbindung. Es gibt keine zusätzliche äußere MCP-Phase. V1-Web-/PI-Aufrufe behalten ihre bisherigen Adapter und lehnen ein vorhandenes `mcpPrincipal`-Feld ab.

`bindOriginal`, Parent-/Path-Veröffentlichung, B1/B2 und Recovery behalten den aktuellen Handle bei. Nur serialisierbare Original-A-Herkunft gelangt in Stage, Journal und Receipts. Eine tatsächliche neue SID_B kann den historischen A-Auftrag unter frischen Rechten wiederaufnehmen; sie darf keinen frischen Auftrag mit einer alten A-Session anlegen. Clone-, Link-, Metadaten-, Scene-/Asset-, Stage- und Journalformate wurden nicht geändert.

## Tatsächliche Prüfungen

Alle acht Folgen liefen seriell über den vorhandenen ESM-Quellenrunner gegen PostgreSQL 18. Alle Originalprozesse endeten mit Exit 0 ohne Signal.

| Folge | Tatsächliches Ergebnis |
| --- | --- |
| MCP-Copy-Principal | 9/9, Originalexit 0 |
| Neuer tatsächlicher MCP-Copy-Owner | 5/5, Originalexit 0 |
| Bestehender Web-/PI-Copy-Owner | 26/26, Originalexit 0 |
| Bestehender Copy-Metadaten-/Scene-Owner | 15/15, Originalexit 0 |
| Direct-MCP-Read-Principal | 20/20, Originalexit 0 |
| Direct-MCP-Create-Principal | 8/8, Originalexit 0 |
| Nativer Edit-Principal | 9/9, Originalexit 0 |
| Web-/PI-Copy-Principal | 17/17, Originalexit 0 |

Insgesamt sind **109 tatsächliche Prüfgruppen** bestanden. Die unveränderte 26. Owner-Negativgruppe führt V2-Herkunft ausdrücklich ohne aktuellen echten MCP-Handle zu; sie bleibt vor Poolbezug abgelehnt.

Die fünf neuen Ownerfamilien verwenden tatsächliche Fixture-JWTs, SQL-Grants, PostgreSQL 18 und das echte Dateisystem. Sie prüfen gemischte projectionlose native Dokumente, Scene samt Bildassets, gewöhnliche PDF-Datei und leere Ordner; frische Dokument-/Lineage-/Yjs-Identitäten und richtige Zielverweise; unveränderte nur lesbare Quelle; abgeschlossenen Retry unter echter erneuerter Session mit unveränderten SQL-`xmin` und Dateisystemidentitäten; verlorene Bestätigung nach tatsächlich ausgeführtem und unabhängig sichtbarem B1-COMMIT; realen Grantentzug nach B1 und anschließende Wiederaufnahme mit Originalstage und festen Identitäten. Die Kopie einer gewöhnlichen PDF-Datei ist keine PDF-zu-Notizbuch-Konvertierung.

Die Fehlerprobe wirft erst nach dem realen erfolgreichen COMMIT. Die Widerrufsprobe entfernt den tatsächlichen Zielgrant anschließend über eine separate Verbindung und verlangt ausbleibende B2-/Scene-/Asset-Births. Fehlender, gefälschter, entkommener und echter falscher Principal werden ohne Owner-Poolbezug und ohne dauerhafte Änderung abgewiesen. Die neunte Autoritätsfamilie prüft zusätzlich falsche feste Auswahl, Busy und reale Tokenexpiration ohne Poolbezug; die Zeitprobe wartet außerhalb einer B-Phase auf den Ablauf eines tatsächlich signierten Tokens.

Die erste enge Typprüfung meldete einen möglicherweise undefinierten entkommenen Testhandle. Der Test bindet ihn nach der echten Assertion an eine lokale Konstante; Compilerregeln und Produktdeklarationen wurden nicht abgeschwächt. Der anschließende gezielte TypeScript-Abschluss einschließlich beider Ownerfolgen und der neuen Suite sowie Scoped-Lint bestehen mit Exit 0. Unabhängige Quellenreviews fanden im finalen Owner-/Phasen- und Testkandidaten keinen konkreten Blocker.

## Quellen und Ressourcenabschluss

Die privaten Originale liegen unter `/private/tmp/canvas-mcp-copy-owner-5di_x8m0/`. `tested-source-pins.json`, `all-suite-source-pins.json` und `tested-source/` halten die tatsächlich geprüften Quellen fest. Ausgangsstände: Root `5c666c9f4dd76b353836716659c1791e23c63517`, QA `656092e8917b7faceba7ac557e6adddf4190e1a8`; beide erhielten bytegleich dieselben sechs Code-/Teständerungen.

| Geänderte Quelle | SHA-256 |
| --- | --- |
| `app/lib/files/workspace-operation-native-copy-owner.ts` | `c3e897717d99259142a38c7683a4774dadc106f052f6ab989b7a0d2f7832a1bd` |
| `app/lib/files/workspace-operation-native-copy-phase.ts` | `5daff095ba8012783d553000613ca24b9af27030007233159cc7bcb6977d1cd7` |
| `app/lib/mcp/server/document-read-principal.ts` | `8b1079f3670a57e39df98ae567db77a5aa7b701abb7a2bd26e87f7c700aa20e5` |
| `scripts/direct-mcp-workspace-copy-principal-postgres-test.ts` | `a83a346d3a70a7518657b57aac804fdeb7929aa6eb5077e44907189f7f1847a7` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `df33ae334c1cdf0fdf4b5ad3aa197d07ca2ae90346aa997b0214538d01a504ff` |
| `scripts/direct-mcp-native-copy-owner-postgres-test.ts` | `da0a5bc2a1c25c5fbfb1f3312afcbc16250ff28c9284fefc9023c5250010747a` |

| Originallog | SHA-256 |
| --- | --- |
| `direct-mcp-workspace-copy-principal-postgres-test.log` | `447101db4930985dcaa3eefdf1808a8808575fbe9abc2d88966863c529f2500d` |
| `direct-mcp-native-copy-owner-postgres-test.log` | `a5b3341a3ea67b287705c089c7fdf534e4a7000a580a0d34543ad186bc9cf0dd` |
| `workspace-operation-native-copy-owner-postgres-test.log` | `c2af93206942fa0c088209bec97dbf217eaa1121eda0fa3f02150b6b5bd2319c` |
| `workspace-operation-native-copy-metadata-owner-postgres-test.log` | `c755c0696544f3ba36bcb1d4e940daf7f61104423f033a1f7c9e705fea8576e0` |
| `direct-mcp-document-read-principal-postgres-test.log` | `9ef570c1d4656851eae8cb575894a003542253dbbf79a86490b33adcaa4f8bb0` |
| `direct-mcp-document-create-principal-postgres-test.log` | `fd863c709aa1615bdcdcccdd0315dd9e42e1f97355c7a0569f42e30177df4d0c` |
| `native-document-edit-principal-postgres-test.log` | `8be5dfbd48f979c02375555d59ae72ad3bde5c1a3e5c477bc0e45ea9ddba7891` |
| `workspace-copy-principal-postgres-test.log` | `fcf01e38dcfa0d747bfdf8c892cc485276422d8064426aae652e5cdb3da535ab` |

Die unabhängige frische RR-/READ-ONLY-Abschlussprüfung endet mit Exit 0. Sie bestätigt alle acht Originalberichte und Quell-/Loghashes, vor und nach den Tests null passende Schemas und Backends, 7 tatsächlich geloggte eigene DATA-Verzeichnisse und 15 bekannte Runner-/Fixture-PIDs abwesend. Die Prüfverbindung besitzt keine zugewiesene XID und wird geschlossen. Vier verwaltete Dienste behalten ihre IDs und gesunden Zustand; drei Health-URLs liefern HTTP 200. `resources-after.json` hat SHA-256 `a09fcae6dfcafd251869ef57d7a263baaebdc56d67a059e6cc3b23e30145a78f` und `testsSucceeded: true`. Dies ist eine begrenzte Abschlussbeobachtung, keine Vollhistorie unbeobachteter Prozesse. Container wurden nicht gebaut oder verändert.

Der historische Hauptplansuffix und der vorhandene Root-/QA-Unterschied für Aktivierung und zwei frühere Belegtexte bleiben unverändert. Die eigenen Ressourcen sind geschlossen; andere Prozesse oder Daten wurden nicht entfernt.

## Offene Abnahmegrenzen

Dies ist ein tatsächlicher Owner-/PG-/Dateisystemnachweis, keine öffentliche MCP-Tool-, HTTP-/OAuthbrowser-, SDK-, neue Build- oder Gesamt-E2E-Abnahme. `copy_knowledge_source` bleibt ausdrücklich intern reserviert und wird nicht durch `tools/list` angeboten. Der öffentliche Dienst muss Preview/Apply, reine historische Statusabfrage, begrenzte ausdrückliche Recovery und reguläre Ansichtsfinalisierung anschließen; Status darf nicht durch `execute` mit Cleanup oder Recovery ersetzt werden. Move/Delete, SDK-Dateiaktionen und die weitere Import-/Skill-/Sandboxmatrix bleiben Teil des Gesamtauftrags. Das SQL-Phasenbudget ist keine Laufzeit- oder Abbruchgarantie für den gesamten Auftrag. Dateiaktions-Undo, Review Center und allgemeine Aktivierung bleiben ausgeschaltet; keine Veröffentlichung.
