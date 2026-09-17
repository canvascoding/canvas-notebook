# Proposal-Graph: Speicherung V1

Task: `FVRC-1001`. Die Speicherung ist eine additive Grundlage; sie aktiviert
noch keinen neuen Agenten- oder UI-Schreibpfad.

## Grenzen und Verantwortlichkeiten

`proposal-storage.ts` nimmt eine explizite Datenbank und einen bereits
autorisierten Dokument-Scope entgegen. Der spaetere Orchestrator verantwortet
Benutzerrechte, die vollstaendige Wirkungsmenge und die Live-Yjs-Pruefung.
Die Speicherung erzwingt Scope, unveraenderliche Herkunft, Referenzen, CAS,
Retention und vollstaendige Finalisierung. Keine dieser Funktionen wendet
selbst Dokumentinhalt an.

Jeder Aufruf von `withLockedGraph` verwendet eine PostgreSQL-Transaktion mit
`FOR UPDATE` auf genau dem Graphen. Artefakterstellung, Proposal-Erstellung
und ihre Pins gehoeren in denselben Aufruf. Ungepinnte Artefakte sind kein
ueber Transaktionsgrenzen dauerhaft verfuegbarer Zwischenstand.

## Datenmodell

| Tabelle | Aufgabe |
|---|---|
| `file_proposal_graphs` | Unveraenderlicher Scope, Graphrevision und reservierte Aktion |
| `file_proposal_artifacts` | Hashgepruefte vollstaendige Yjs-Updates und JSON-Belege |
| `file_change_proposals` | Unveraenderlicher Inhalt/Basis; getrennte Lifecycle-/CAS-Spalten |
| `file_proposal_choice_groups` | Voraussetzung und einmalige Wahl einer Alternative |
| `file_proposal_choice_memberships` | Angehaengte, nicht umgehaengte Gruppenmitgliedschaft |
| `file_proposal_evaluations` | Unveraenderliche aktuelle Auswertung eines Kandidaten |
| `file_proposal_action_receipts` | Idempotente Aktion mit dem exakt freigegebenen Request |
| `file_revision_proposal_bindings` | Geordnete Proposal-Zuordnung zur neu erzeugten Revision |
| `file_proposal_artifact_pins` | Schutz benoetigter Belege vor Retention |

Historische Generationen bleiben erhalten. Foreign Keys verbinden Proposal und
Operation mit demselben Workspace, Dokument, derselben Lineage und Generation;
sie referenzieren nicht die veraenderliche aktuelle Yjs-Generation. Rename/Move
aendert somit weder Identitaet noch Grundlage eines Vorschlags.

## Aktionen und Finalisierung

Eine vorbereitete Aktion reserviert das Dokument dauerhaft. Ein Timeout gibt
diese Reservierung nicht frei. Andere Mutationen bleiben blockiert, bis die
urspruengliche Aktion oder die Recovery einen belegten terminalen Zustand
erreicht. SQL verhindert parallele aktive Receipts auch ueber Generationen
desselben Dokuments hinweg.

Der gespeicherte Request enthaelt Fence und eventuell eine vorbereitete
Neuerstellung, aber keinen Freigabe-Token und keinen rohen Idempotency-Key.
Neue Erstellungspayloads werden ebenfalls gepinnt. Ein Retry mit demselben
Key und anderem Inhalt wird abgewiesen.

Inhaltsaendernder Erfolg verlangt den bestehenden dauerhaften Operationsbeleg
und genau dessen Revisions-ID. Vor COMMIT werden die terminalen Proposal-Zustaende
und die vollstaendige geordnete Revisionszuordnung kontrolliert. Ein vergessenes
Binding oder ein unvollstaendiger Lifecycle-Uebergang rollt die Finalisierung
zurueck; es wird kein falscher Erfolg gespeichert.

`complete_satisfied` erzeugt keine Revision und kein neues Revision-Proposal-
Binding. Seine vorhandene autoritative Referenz steht im unveraenderlichen
Metadata-Receipt unter `result.current.revisionId`; `result.revisionId` bleibt
`null`. Damit wird bestehender Inhalt nicht nachtraeglich als neuer Apply ausgegeben.

## Retention und begrenzte Projektion

Offene Vorschlaege pinnen ihre Quellen und Kandidaten. Offene Nachfahren
halten die gesamte Voraussetzungskette sowie referenzierte Auswertungen fest.
Unabgeschlossene Aktionen besitzen eigene Pins. Bereinigung gibt nur alte,
nicht mehr benoetigte Pins frei und entfernt ausschliesslich ungepinnte Artefakte.
Audit-Zeilen bleiben erhalten; fehlende historische Inhalte sind spaeter als
solche zu melden, nicht durch Current zu ersetzen.

Die aktive Graphprojektion ist begrenzt, nicht die Zahl aller jemals erstellten
Vorschlaege. Historische Referenzen bleiben gezielt aufloesbar. Archivierte
Ersatzreferenzen und Mitgliederzahlen sind explizit; fehlende Voraussetzungen
duerfen dagegen nicht als archiviert weggelassen werden.

Artefakte sind auf 8 MiB pro Objekt sowie 128 MiB / 4096 Objekte pro Graph-Scope
begrenzt. Deduplizierung erfolgt nur innerhalb desselben Scopes und Formats.
Bei erschoepftem Budget erfolgt ein expliziter Fehler, niemals das Entfernen
noch gepinnter Belege. Hash, Laenge und erwartetes Format werden beim Lesen geprueft.

## Migration und Testbetrieb

Die Migration ist wiederholbar. Schema-Rollback entfernt nur neue Tabellen;
bestehende Agentenreviews und Inhaltsrevisionen bleiben bestehen. Eine normale
Produkt-Ruecknahme deaktiviert spaeter den Graph-Schreibpfad und fuehrt kein
Schema-DOWN aus. Bei einem vollstaendigen Test-Rollback muss die Proposal-Migration
vor ihrer FVRC-Basismigration zurueckgenommen werden.

Die Speichersuite laeuft mit PGlite und echtem PostgreSQL. Der reale Runner
akzeptiert ausschliesslich eine explizite, leere `proposal_graph_test_*`-Datenbank.
Der lokale Notebook-Datenbestand wird nicht als Testfixture verwendet.
