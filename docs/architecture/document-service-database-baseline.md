# Dokument- und Linkservice: Aufrufer und Messbasis

Stand: 26.10.2026, lokale PostgreSQL-18-Fixtures auf dem Fix-Branch. Dies ist eine
Arbeitsgrundlage für `document-write-database-performance-plan.md`, keine Abnahme
des gesamten Umbaus oder Aussage über Produktionslatenzen. Review Center und Undo
werden für diese Arbeit nicht weiterentwickelt.

## Aufrufkarte

| Ablauf | Tatsächlicher Einstieg | Gemeinsame Mechanik |
| --- | --- | --- |
| Dokument lesen, HTTP | `app/api/documents/read/route.ts` | `documents/service.ts` → `collaboration/native-document-read.ts` |
| Dokument lesen, Agent | `pi/document-read-tool.ts` | derselbe Dokumentleser mit tatsächlichem PI-Principal |
| Dokument lesen, MCP | `mcp/server/workspace-tools.ts` | derselbe Dokumentleser mit tatsächlichem MCP-Principal |
| Backlinks/Graph, HTTP | `app/api/markdown/link-index/route.ts` | `markdown/workspace-document-link-index.ts` → `workspace-source-authority-stage.ts` |
| Dokumentbeziehungen, Agent | `pi/document-relations-tool.ts` | derselbe Dokumentindex und Quellenleser |
| Markdown anlegen, Agent | `pi/agent-file-operations.ts` | `collaboration/markdown-file-import-persistence.ts` → bestehende Birth-/Projektionsdienste |
| Markdown anlegen, MCP | `mcp/server/ingest-tools.ts` | derselbe Create-Engine mit ursprünglicher MCP-Identität |
| Normaler Editor speichern | `server/collaboration-server.ts`, `onStoreDocument` | `collaboration/persistence.ts`, `persistCollaborationYDoc`; anschließende Dateiprojektion über bestehenden Projektionslauf |
| Native Agenten-/MCP-Änderung | `documents/edit-public-service.ts` | `documents/edit-service.ts` und echter Raum-/Speicherbesitzer |
| Verschieben mit Linkpflege | `files/workspace-file-operation-service.ts` | bestehender Original-Move-Owner, Quellenbeobachtung und native Linkpersistenz |

Die Pfade in der Tabelle liegen unter `app/lib/`, soweit sie nicht ausdrücklich
mit `app/api/` oder `server/` beginnen. Bestehende Mechanik wird weiterentwickelt;
diese Karte fordert keine zusätzliche zweite Dokument-Wahrheit.

## Beobachtete Ausgangswerte

| Messbereich | SQL-Anweisungen | Pool-Ausleihen | Einordnung |
| --- | ---: | ---: | --- |
| Gemeinsamer HTTP-Dokumentleser, erster erfolgreicher Fall | 114 | 12 | Serviceoperation; nicht vollständiges Browseröffnen |
| Registrierter Agenten-Dokumentleser | 145 | 3 | normaler erfolgreicher Toolfall |
| Registrierter MCP-Dokumentleser | 74 | 4 | 15 erfolgreiche Leseoperationen konstant; Transportauthentifizierung vor Serviceeintritt separat |
| Nativer Store nach tatsächlichem WebSocket-Edit | 5 | 1 | zwei geänderte Saves; 4 Anweisungen für nachfolgenden No-op |
| Tiefe Agenten-Markdown-Neuanlage | 8.480 | 51 | ab gemeinsamem Create-Engine; davon 5.954 Anweisungen in 229 Berechtigungsprüfungen |
| MCP-Markdown-Neuanlage, erster erfolgreicher Fall | 3.428 | 27 | ab gemeinsamem Create-Engine; Originalwiederholung gesondert auswerten |
| Dokumentindex über echte Cookie-HTTP-Route, 10 Dokumente, warm | 37 | 7 | vollständige Route einschließlich Workspace-Zugriff |
| Dieselbe Indexroute, 200 Dokumente, warm | 37 | 7 | gleiche SQL-Anzahl; Datenmenge und Rechenarbeit skalieren weiterhin |
| Original Move mit nativem Ziel und eingehendem Link | 2.342 | noch nicht erfasst | gesamter bestehender Owner-Testfall einschließlich eigener Vorbereitung |
| Original Move mit PDF und nativem Link | 2.431 | noch nicht erfasst | derselbe unabhängige Bestandsprofiler |

Die Messbereiche sind unterschiedlich. Ihre Zahlen dürfen nicht als direkt
vergleichbare Gesamtkosten oder prozentuale Verbesserung ausgegeben werden.
Insbesondere sind WebSocket-Zutritts-/Nachrichtenprüfung und asynchrone
Dateiprojektion nicht in den fünf Anweisungen des nativen Stores enthalten.
Der Move-Bestandsprofiler zählt auch Callback-Abfragen, kann aber nicht für alle
deren Abschlusszeit beobachten; diese Lücke steht in `unobserved`. Seine Zahlen
ersetzen noch keine einheitliche Messung von Pool-Wartezeit und Parallelität.

Für die Agenten-Neuanlage wurde zusätzlich jede vierte echte SQL-Antwort um eine
Millisekunde verzögert. Das simuliert Antwortlatenz ohne Ersetzung von SQL,
Authentifizierung oder Serviceergebnissen. Die 9,34 Sekunden dieses gesamten
mehrphasigen Ablaufs sind kein Produktionsbenchmark. Die bestehenden
Zeitgrenzen einzelner Phasen bleiben unverändert.

## Erste gebündelte Leser

Die identische verzögerte Agenten-Neuanlage wird nach jedem abgeschlossenen
Umbau erneut geprüft. Die Werte beziehen sich auf denselben Messbereich:

| Stand | SQL im Create-Engine | SQL in Berechtigungsprüfungen | Größte Transaktion |
| --- | ---: | ---: | ---: |
| Ausgangsmessung | 8.480 | 5.954 | 3.089 |
| Gemeinsamer Ein-Abfrage-Workspace-Leser in PI und Agenten-Kontext | 7.480 | 5.038 | 2.713 |
| Zusätzliche Konto-/Mitgliedschaftsbeobachtung ohne Workspace-Aufzählung | 6.452 | 4.122 | 2.337 |

Alle 229 aktuellen Berechtigungsprüfungen bleiben erhalten. Der Konto-Baustein
liest entsperrt eine aktuelle SQL-Momentaufnahme und mit Sperren drei Abfragen in
der bestehenden Reihenfolge Organisation → Benutzer → Mitgliedschaften. Er erzeugt
keine Workspace-Berechtigung und hält keine Entscheidung über einen Aufruf hinaus
vor. Die unveränderte vollständige Ressourcenberechtigung verwendet dieselbe
ausgelagerte Auswertungslogik und behält ihre benötigte Workspace-Aufzählung.

Nachweise: 19 vorhandene Workspace-Paritätsvarianten, 13 zusätzliche Konto-Varianten
einschließlich echter Peer-Sperren und Selbstwiderruf, 49 Agenten-Principal-Fälle,
zwölf Neuanlage-Gruppen und 21 Dokumentleser-Fälle. Die Zielbudgets des Gesamtplans
sind damit weiterhin nicht erreicht. Eine zeitweise rote Fixture-Abschlussprüfung
wurde auf die verzögerte Abmeldung eines eigenen PostgreSQL-Backends zurückgeführt;
die Fixture wartet jetzt begrenzt auf tatsächlich null eigene Backends vor dem
Löschen ihres Schemas. Die Anforderung null Verbindungen bleibt unverändert.

Weitere aktuelle Messungen nach gebündelten Member-/MCP-Workspace-Lesern und
kohärenter Workspace-Auswahl/-Aufzählung:

| Messbereich | Aktuelle SQL-Anweisungen | Pool-Ausleihen |
| --- | ---: | ---: |
| Gemeinsamer HTTP-Dokumentleser, erster erfolgreicher Fall | 104 | 12 |
| Registrierter Agenten-Dokumentleser | 132 | 3 |
| Registrierter MCP-Dokumentleser | 72 | 4 |
| MCP-Markdown-Neuanlage, erster erfolgreicher Fall | 3.224 | 27 |
| Dokumentindex, 10 und 200 Dokumente, warm | 36 | 7 |

66 echte Member-Principal-Fälle und zwölf MCP-Pfad-Principal-Gruppen bestehen.
Die bisherigen Rechteentscheidungen bleiben erhalten. Ein zusätzlich nachgewiesener
Parallelitätsfehler bei der allgemeinen Workspace-Auswahl/-Aufzählung ist behoben:
Ein alter Freigabestand darf nicht mit einer neu hinzugekommenen Teammitgliedschaft
kombiniert werden. Workspace und zugehörige Zugriffsmerkmale stammen jetzt aus
derselben SQL-Momentaufnahme.

## Diagnosefamilien und Move-Messung

Die gemeinsame Messung ergänzt elf feste Abfragefamilien mit Anzahl, Datenbankzeit
und Fehlerzahl. Jede Anweisung zählt genau einmal; die Summe der Gruppen entspricht
der Gesamtsumme. Die Einordnung nach fest vorgegebenen SQL-Merkmalen ist heuristisch:
Bei mehreren Treffern gewinnt die erste Familie, und Schreibweisen in Kommentaren
oder Literalen können ebenfalls treffen. Unbekannte, übergroße und nur über Getter
oder Proxy lesbare SQL-Formen zählen als `other`. Diese Einordnung dient der Diagnose;
konkrete Optimierungen benötigen weiterhin Quellenprüfung und echte Abfragepläne.
Im Bericht stehen nur feste Gruppennamen und Zahlen. SQL-Texte und Parameter werden
weder gespeichert noch ausgeliefert.

Der identische verzögerte Agenten-Create besteht mit diesen Gruppen:

| Diagnosefamilie | Anweisungen |
| --- | ---: |
| Katalog-/Verbindungskontext | 1.826 |
| Konto-/Organisationsdaten | 1.070 |
| Workspace-/Projektdaten | 1.020 |
| Agenten-/Grantdaten | 953 |
| Übrige Familien zusammen | 1.583 |
| Gesamt | 6.452 |

Die 4.122 Anweisungen innerhalb von Berechtigungsprüfungen sind ein überlappender
Phasenmesswert und dürfen nicht zur Gruppensumme addiert werden. Die 229 Prüfaufrufe,
51 Pool-Ausleihen und vier maximal gleichzeitig gehaltenen Pool-Verbindungen bleiben
offene Optimierungsziele. Alle Abfragen und Pool-Ausleihen sind vor Messende beendet.

Der echte Original-Move-Owner-Test benutzt zusätzlich dieselbe gemeinsame Messung.
Seine 22 bestehenden Fälle behalten ihre Daten-, Konflikt-, Wiederholungs- und
Cleanup-Prüfungen. Das erste native Move-Szenario benötigt 2.342 Anweisungen und
29 Pool-Ausleihen, das PDF-Szenario 2.431 und 31; beide halten maximal zwei
Pool-Verbindungen gleichzeitig. Beide Messungen umfassen den gesamten jeweiligen
Owner-Testfall mit Vorbereitung und Ausführung. Sie ersetzen weiterhin keine
vollständige Browseraktion. Der unabhängige Bestandsprofiler bleibt als Vergleich
erhalten; die gemeinsame Messung beobachtet zusätzlich echte Callback-Abschlüsse,
Pool-Wartezeit und Verbindungen.

## Dokumentweise Leseprojektion

Der Quellenleser hat bereits zwei gebündelte native SQL-Abfragen je Prüfdurchlauf.
Die neue Wiederverwendung spart Dekodieren und Parsing nach exaktem Vergleich der
Metadaten sowie SHA-256 von nativen Bytes und Zustandsvektor. Sie gilt ausschließlich
für `sourceScope: 'document-index'`. Aktuelle Rechte, Katalog, beide SQL-Durchläufe,
Bytegrenzen und physische Quellen werden weiterhin geprüft. Mutationseingänge
verwenden den bisherigen vollständigen Inspektionspfad.

Im tatsächlichen HTTP-/PostgreSQL-Test gilt für 10 und 200 native Dokumente:

- Unveränderte warme Aufrufe verursachen keine neue native Inspektion.
- Eine Inhaltsänderung verursacht genau eine neue native Inspektion.
- Ein neues Ziel repariert 200 zuvor unaufgelöste Verweise.
- Physische externe Quellen werden beim nächsten tatsächlichen Lesen erfasst.
- Ergebnisse stimmen mit erzwungenem vollständigem Neuaufbau überein.
- Nach deaktivierter Mitgliedschaft gibt die tatsächliche Authentifizierung 401
  zurück; aus einer warmen Projektion wird kein Index ausgeliefert.

Der Cache ist auf 10.000 Einträge und 32 MiB serialisierten Inventarinhalt begrenzt.
Er ersetzt weder aktuelle Autorität noch die noch ausstehende inkrementelle
Zielauflösung. Native Binärzustände werden weiterhin frisch gelesen; ein warmer
Index ist damit noch kein vollständig inkrementeller Workspace-Leser.

## Reproduzierbare Nachweise und offene Messungen

`scripts/document-operation-metrics-postgres-test.ts` prüft echte pg-Promise-,
Callback- und Drizzle-Aufrufe, Fehlertreue, konkurrierende Scopes, Pool-Wartezeit,
spätere Callback-Ausführung und private Diagnoseempfänger. Die Messung speichert
weder SQL-Text noch Parameter, Inhalte, Pfade oder Benutzeridentitäten.

`scripts/document-operation-dispatch-baseline-postgres-entry.ts` verwendet die
bestehenden isolierten Fixtures. `CANVAS_DOCUMENT_BASELINE_CASE` wählt
`editor-save`, `mcp-read` oder `mcp-create`.
`scripts/document-link-index-route-postgres-test.ts` misst die echte Indexroute.
Beide benötigen einen absoluten, noch nicht vorhandenen Ausgabepfad in
`CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT`; Berichte werden mit Modus 0600 angelegt.
Start über den vorhandenen Real-Source-ESM-Runner
`scripts/run-document-read-tool-dispatch-test.mjs`. Die Fixtures brauchen die
verwaltete lokale PostgreSQL-Testkonfiguration und sind keine generische CI-Suite.

Noch erforderlich: einheitliche vollständige Editor-/Projektions- und
Rename-/Move-Messung, kalte/warme Dokumentleser auf größeren Datenbeständen,
dominante Abfragegruppen für alle Adapter sowie tatsächliche Abfragepläne.
Erst dann ist Arbeitspaket 1 insgesamt abgenommen. Berechtigungsbündelung,
inkrementelle Zielauflösung, vollständige UI-/Gesamtsuite, CI und Einführung bleiben
separate offene Anforderungen des Gesamtplans.
