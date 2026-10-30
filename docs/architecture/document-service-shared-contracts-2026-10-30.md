# Gemeinsame Dokument- und Linkverträge

Dieser Nachweis beschreibt die bestehenden gemeinsamen Datenverträge und ihre
tatsächlichen Aufrufer. Er führt keinen zweiten Berechtigungsdienst ein. Für die
weiteren Umbauten bleibt der [Gesamtplan](../document-write-database-performance-plan.md)
maßgeblich. Die tatsächliche PostgreSQL-Abnahme umfasst 72 Messfenster in drei
getrennten Prozessen mit Haupt- und Organisationsagent sowie echtem HTTP-/MCP-Dispatch.

## Identität und Versionsbeleg

[`NativeDocumentRefV1`](../../app/lib/documents/contracts.ts) enthält Workspace,
Organisation, native Dokument-ID, Lineage, Lebenszyklusgeneration, Repräsentation
und Schemaversion. Die Inhaltsversion verwendet die vollständige native Identität
und den Zustandsbeleg. Pfad, Titel und Metadatenversion sind getrennte Daten.
Ein verschobenes Dokument wird dadurch nicht zu einer neuen Dokumentidentität.

[`DocumentCurrencyV1`](../../app/lib/documents/contracts.ts) unterscheidet den
beobachteten Live- oder Persistenzstand vom dauerhaft gespeicherten Stand.
`DocumentProjectionV1` nennt den bestätigten Datei-Checkpoint und unterscheidet
`current`, `pending` und `unavailable`. Ein gelesener nativer Inhalt kann gültig
sein, während seine physische Datei noch nicht aktuell ist.

Im Linkpfad stehen die Belege in zwei bereits vorhandenen Strukturen:

| Struktur | Tatsächlicher Beleg | Grenze |
| --- | --- | --- |
| `NativeDocumentLinkInventory` | Native ID, Generation, Repräsentation, Schema, Sequenz/Zustandsbeleg, Parser-Version, extrahierte Links und Metadaten | Ein Inventar allein ist kein vollständiger Lineage- oder Berechtigungsnachweis. |
| `WorkspaceNativeSourceBinding` innerhalb der tatsächlichen Quellbeobachtung | Registry, Lineage, ursprünglicher Geltungsbereich, tatsächliche Version und Binär-/Vektorbelege | Bleibt private Beobachtung des aktuellen Lesers bzw. nativen Eigentümers. |
| Öffentlicher Dokument-Linkindex | Dokumentmetadaten, native ID/Generation als Navigation, Links, Zielentscheidungen und getrennte Diagnosen | Enthält keine native Schreibposition und keinen ausführbaren Änderungsplan. |

Die Lineage wird aus dem tatsächlichen Registry-/Lineage-Join gelesen. Ein
Lesecache erfindet keine Lineage und ersetzt keine fehlenden Zustandsdaten.
Physische Originaldateien erhalten ihre tatsächliche Dateiidentität und ihren
Bytebeleg; ihnen wird keine native Dokument-ID zugeteilt.

## Tatsächliche Aufrufer

| Aufrufer | Gemeinsame Mechanik | Eigene echte Eingangsprüfung |
| --- | --- | --- |
| HTTP-Dokumentleser | `documents/service.ts`: `consume` → `readPage` → `finish` | Originaler Better-Auth-Request und aktueller Request-Principal |
| Registriertes Agenten-Tool `read_document` | Derselbe native Dokumentleser und dieselben begrenzten Antwortseiten | Tatsächliche PI-Ausführung, gespeicherte Sitzung, aktuelles Agenten-/Toolprofil |
| MCP `read_knowledge_source` mit nativer Auswahl | Derselbe native Dokumentleser und dieselben begrenzten Antwortseiten | Tatsächliches OAuth-Token, Scope, Workspace-Freigabe und Direct-MCP-Principal |
| Editor-Backlinks, Wiki-Links, Eigenschaften und Codeeditor | `loadWorkspaceLinkIndex` → echte Indexroute → `readWorkspaceDocumentLinkIndex` | Request-/Workspace-Leserecht vor der Quellbeobachtung |
| Registriertes Agenten-Tool `inspect_document_relations` | Derselbe native/physische Index → `getWorkspaceDocumentRelations` | Tatsächliche Agentenausführung und erlaubter Workspace-Pfad |
| MCP-Neuanlage | Vorhandener nativer Birth-/Persistenz-/Projektionsweg; anschließende Indexbeobachtung | Eigenständige Schreibfreigabe, ursprünglicher Idempotenzbeleg und aktuelle native Guards |

MCP veröffentlicht derzeit kein eigenes `inspect_document_relations`-Tool. Die
Abnahme darf deshalb keinen erfundenen MCP-Linkendpunkt verwenden. Sie prüft die
vorhandenen nativen Leseseiten und die Linkwirkung einer tatsächlichen
MCP-Neuanlage über die gemeinsamen Indexkonsumenten.

## Parser und Zielauflösung

Native Links werden anhand des echten Yjs-Zustands und der tatsächlich gültigen
Grammatik inspiziert. Der lesende Projektionspfad verwendet Parser-Version 2.
Historische Parser-/Mutationsprofile 3 und 4 bleiben ausdrücklich unterscheidbar;
sie werden nicht durch Umbenennen zu einem vermeintlich gemeinsamen Profil.

Sowohl der Dokument-Linkindex als auch die nativen operativen Graphen verwenden
`resolveWorkspaceWikiFileLink` und `resolveExactWorkspaceLink`. Wiki-Aliase und
Dateinamensauflösung dürfen dem exakten Markdown-Pfad keine zusätzlichen Treffer
geben. Mehrdeutige Ziele bleiben mehrdeutig. Relative Links werden aus dem
tatsächlichen Quellpfad aufgelöst.

Der lesende Cache enthält Daten und Auflösungsabhängigkeiten. Die aktuelle
Auswahl der Quellen, Registry, Lineage und Zustände bleibt beim echten Leser.
Der `document-index`-Stage ist stets für Ausführung gesperrt. Eine native Mutation
benötigt die eigene frische Prüfung, ursprüngliche Native-Referenzen und ihre
Versions-/Speicherbelege.

## Getrennte Diagnosen

| Fall | Bedeutung |
| --- | --- |
| Fehlender, inaktiver, beschädigter oder widersprüchlicher nativer Zustand | Quellbeobachtung ist unvollständig oder global nicht bestätigbar; keine stille Reparatur durch Lesen. |
| Fehlerhaftes Frontmatter | Metadatenfehler; vorhandene übrige Dokumente und Links bleiben unterscheidbar. |
| HTML außerhalb des geprüften Leseprofils | Explizite HTML-Grenze; keine Behauptung einer vollständigen HTML-Auswertung. |
| Fehlender oder mehrdeutiger Linktarget | Ungelöster Verweis; allein daraus folgt kein fehlendes Quelldokument. |

`diagnostics.sourcesComplete`, `sourceGaps`, `metadataErrors` und `htmlSources`
bleiben von `brokenLinks` getrennt. Der gemeinsame Datenpfad darf die Warnung
über fehlende Quellen nicht pauschal ausblenden, um ungelöste Links zu verbergen.

## Phase, Autorität und Bestätigung

Eine gehaltene Verbindung allein beweist keine unveränderten Rechte. Die
aktuellen Konto-, Seat-, Sitzungs-, Workspace-, Agenten- und Toolentscheidungen
bleiben bei ihren jeweiligen tatsächlichen Aufrufern. Vorbereitete SQL-Pläne
sparen kein erforderliches erneutes Lesen. Datenobjekte, Cursor und native
Versionsbelege gewähren keine zusätzlichen Rechte.

Die privaten Phasen binden die tatsächliche Verbindung, Transaktion, Datenbank,
Schema-/Relationsidentitäten und ursprünglichen Geltungsbereich. Die bisherigen
Fristen und Prüfgrenzen bleiben wirksam. Ein erfolgreicher Leser wartet auf den
bestätigten Transaktionsabschluss und die Freigabe seiner Verbindung.

Änderungsergebnisse werden erst nach tatsächlichem COMMIT bzw. Aufklärung anhand
des ursprünglichen dauerhaften Belegs veröffentlicht. Ein unklarer Ausgang ist
kein Anlass für einen neuen Beleg oder eine blinde Wiederholung. Keine dieser
Regeln setzt ein neues Review Center oder Datei-Undo voraus.

## Abnahme und verbleibende Arbeit

Die bestandene Prüfung vergleicht vollständige native Leseseiten über HTTP,
registriertes Agenten-Tool und MCP im selben tatsächlichen Fixture. Sie vergleicht
außerdem Linkrelationen, Zielentscheidungen und Diagnosen zwischen dem vom Editor
genutzten HTTP-Index und dem echten registrierten Agenten-Tool, einschließlich
Linkwirkung einer MCP-Neuanlage und warmer Caches bei beschädigten Quellen.

Alle drei realen Programme und ihre 72 Messfenster sind bestanden. Dazu gehören
20 HTTP-Indexfenster bei zehn und 200 Dokumenten sowie je 26 Fenster mit
Haupt- und Organisationsagent. Die vollständige gezielte Typprüfung umfasst
5.140 tatsächliche Importdateien; sie ersetzt nicht die zusätzlich bestandenen
Datenbankläufe. Die physischen Beobachtungen sind vollständig, die SQL-Zähler
stimmen mit der Stackzuordnung überein und die eigenen Verbindungen sind geschlossen.

Die absichtlichen Fehler betreffen ausschließlich die eigene Fixture. Ihre
Änderungen erhöhen den xmin der betroffenen Zeile; ein unveränderter xmin wird
ausschließlich innerhalb jedes tatsächlichen Leseabschnitts behauptet. Die
ursprünglichen Zustandsdaten werden danach exakt wiederhergestellt. Physische
Dateien, Originaldaten außerhalb der Fixture und laufende Container bleiben erhalten.

Dies ist keine Browser- oder Modellturn-Abnahme und keine Produktions-OAuth-Ausstellung.
Weitere Bündelung von Berechtigungs- und Dokumentdaten, das Lesen nur geänderter
Inhalte, gemeinsame Änderungspfade und die vollständige Einführung bleiben offen.

### Prüfungen wiederholen

Die Fixture verwendet die private Datenbankkonfiguration des verwalteten lokalen
PostgreSQL-18-Stacks. Jeder Prozess erhält ein eigenes Schema und einen privaten
Datenordner; beides wird nach dem Schließen der eigenen Verbindungen entfernt.
Die Ergebnisdatei muss ein neuer absoluter Pfad in einem privaten Ordner sein.

```sh
NODE_ENV=test FILE_VERSION_CENTER_MODE=off CANVAS_POSTGRES_VECTOR_ENABLED=false \
CANVAS_DOCUMENT_BASELINE_AGENT_KIND=main \
CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT=/absolute/private/new-parity.json \
NODE_OPTIONS='--import=./scripts/helpers/document-physical-connection-profiler.mjs --import=./scripts/helpers/document-query-callsite-profiler.mjs' \
node scripts/run-document-read-tool-dispatch-test.mjs \
  scripts/document-link-adapter-parity-postgres-test.ts
```

Für den zweiten Agentenprozess `organization-member` und eine weitere neue
Ergebnisdatei wählen. Die eigenständige HTTP-Indexprüfung verwendet denselben
Runner mit `scripts/document-link-index-route-postgres-test.ts`.

Maschinenlesbare Werte: [Abnahme](document-service-link-adapter-acceptance-2026-10-30.json).
