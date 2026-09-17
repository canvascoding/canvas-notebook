# Abhaengige und parallele Agentenvorschlaege

Stand: 2026-09-17

Status: geplant

Zugehoeriger Umsetzungsplan:
[`todo.json`](./todo.json), Paket `FVRC-P10`.

## 1. Problem und Ziel

Der bestehende Review-Workflow sichert eine einzelne Agentenoperation durch
autoritative Yjs-Revalidierung, zielgebundene Proposal-Versionen, CAS und eine
pro Dokument serialisierte Anwendung ab. Dieses Modell verhindert, dass ein
veralteter einzelner Vorschlag blind angewendet wird.

Mehrere offene Vorschlaege benoetigen zusaetzlich eine fachliche
Abhaengigkeitssemantik. Ein Textdiff allein kann nicht unterscheiden, ob zwei
Vorschlaege:

- unabhaengig voneinander sind,
- aufeinander aufbauen,
- denselben Vorschlag in neuer Fassung ersetzen,
- oder konkurrierende Alternativen darstellen.

Ohne diese Information kann eine technisch konfliktfreie, aber semantisch
abhaengige Folgeaenderung ohne ihre Voraussetzung angewendet werden. Umgekehrt
kann ein legitimer Kindvorschlag nach Annahme seines Elternvorschlags
faelschlich als veraltet erscheinen.

Das Ziel ist deshalb:

1. Der autoritative Dokumentverlauf bleibt strikt linear.
2. Offene Vorschlaege bilden einen temporaeren, expliziten Proposal-Graphen.
3. Jede Annahme erzeugt genau eine neue autoritative Version.
4. Abhaengigkeiten, Alternativen und Ersetzungen sind fuer den Nutzer sichtbar.
5. Kein alter Freigabe-Token und kein implizites Last-Writer-Wins darf eine
   Revalidierung umgehen.

## 2. Begriffe und verbindliche Invarianten

### 2.1 Autoritative Version

Eine autoritative Version ist ein dauerhaft gespeicherter und angewendeter
Dokumentstand. Nur solche Staende erhalten eine Revisionsnummer wie
`Version 27` oder `Version 28`.

### 2.2 Vorschlag

Ein Vorschlag ist ein unveraenderlicher Kandidat mit Operationen, Basisbezug und
Status. Ein offener Vorschlag ist keine Dokumentversion. Die UI verwendet daher
`Vorschlag`, nicht Bezeichnungen wie `Version 27.1`.

### 2.3 Effektiver Kandidat

Der effektive Kandidat ist der kumulative Zielstand eines Vorschlags
einschliesslich aller zwingend erforderlichen Vorgaenger. Er ist die rechte
Seite des sichtbaren Vergleichs.

### 2.4 Invarianten

- Der autoritative Revisionsverlauf ist linear und unveraenderlich.
- Proposal-Kanten zeigen nur auf Vorschlaege derselben Dokument-Lineage und
  Lifecycle-Generation.
- Der Graph ist azyklisch.
- Ein Vorschlag besitzt hoechstens einen zwingenden Elternvorschlag. Eine
  spaetere Zusammenfuehrung mehrerer Zweige wird als neue Batch-Komposition
  modelliert, nicht als frei editierbarer Multi-Parent-Graph.
- Vorschlagsinhalt und Beziehung sind nach Erstellung unveraenderlich. Eine
  Ueberarbeitung erzeugt einen neuen Vorschlag.
- Annahme, Ablehnung, Rebase, Detach und Batch-Annahme sind idempotent und
  besitzen eigene Action-Fences.
- Jede Aenderung des autoritativen Stands entwertet alle zuvor ausgegebenen
  Annahme-Tokens noch offener Vorschlaege.
- Kein Vorschlag wird allein aufgrund nicht ueberlappender Textbereiche als
  semantisch unabhaengig eingestuft.

## 3. Graphmodell

```text
Autoritativ: Version 27
├── P1  Einleitung ueberarbeiten
│   ├── P3  erweitert P1 um Quellen
│   └── P4  Alternative zu P1
└── P2  aktualisiert eine unabhaengige Preistabelle
```

Nach Annahme eines Vorschlags wird keine alte Version umgeschrieben:

```text
Version 27 --Annahme P2--> Version 28
                               |
                               +-- P1, P3 und P4 werden gegen Version 28
                                   neu bewertet und erhalten neue Fences.
```

## 4. Beziehungstypen

### 4.1 `independent`

Der Vorschlag ist ein eigenstaendiger Kandidat gegen eine autoritative
Basisversion. Andere Vorschlaege duerfen vorher oder nachher angenommen werden.
Nach jeder Annahme muss er jedoch gegen den neuen aktuellen Stand revalidiert
werden.

### 4.2 `extends`

Der Kindvorschlag setzt den effektiven Kandidaten des Elternvorschlags voraus.
Eine direkte Annahme des Kindes umfasst die gesamte noch nicht angewendete
Vorgaengerkette.

Wird zuerst nur der Elternvorschlag angenommen, wird das Kind gegen den neuen
autoritativen Stand neu materialisiert. Stimmt der neue Stand exakt mit dem
erwarteten Elternkandidaten ueberein, zeigt die Vorschau anschliessend nur noch
die zusaetzliche Kind-Aenderung.

### 4.3 `replaces`

Der neue Vorschlag ist eine ueberarbeitete Fassung des alten Vorschlags. Der
alte Vorschlag bleibt fuer Audit und Vergleich erhalten, ist aber nicht mehr
annehmbar. Die UI zeigt `Durch P<n> ersetzt`.

### 4.4 `alternative`

Der Vorschlag ist eine bewusst konkurrierende Loesung. Alternativen werden in
einer gemeinsamen Auswahlgruppe dargestellt. Die Annahme einer Alternative
schliesst die anderen standardmaessig als `alternative_not_selected`. Eine
spaetere Wiederaufnahme erzeugt einen neuen, gegen den dann aktuellen Stand
revalidierten Vorschlag.

### 4.5 Beziehung ist Pflichtinformation

Wenn ein Agent auf einen offenen Vorschlag Bezug nimmt, muss sein Tool-Aufruf
die Proposal-ID und die erwartete Kandidaten-Hash explizit uebergeben. Fehlt
diese Referenz, wird die Operation ausschliesslich gegen den aktuellen
autoritativen Stand als `independent` vorbereitet. Der Server darf keine
Abhaengigkeit aus Chattext oder Diff-Aehnlichkeit erraten.

## 5. Nutzeraktionen und Folgezustaende

### 5.1 Unabhaengigen Vorschlag annehmen

1. Der Server laedt aktuellen Stand und Proposal-Fence.
2. Der Vorschlag wird gegen den aktuellen Stand neu geprueft.
3. Bei sauberem Rebase wird genau eine neue Version geschrieben.
4. Alle anderen offenen Vorschlaege werden als `rebase_pending` markiert und
   erhalten nach ihrer naechsten autoritativen Auswertung einen neuen Fence.
5. Bei Ueberlappung wird nichts geschrieben und der Vorschlag bleibt
   `conflicted` beziehungsweise `needs_review`.

### 5.2 Erweiterung direkt annehmen

Bei Annahme eines `extends`-Kindes wird die transitiv erforderliche, noch offene
Vorgaengerkette ermittelt. Die Kette wird in stabiler Reihenfolge komponiert,
auf einem Clone validiert und als eine atomare Dokumenttransaktion angewendet.

Die neue Revision speichert `includedProposalIds`. Vorgaenger erhalten den
terminalen Zustand `included`, damit sie nicht ein zweites Mal angewendet werden
koennen.

### 5.3 Nur den Elternvorschlag annehmen

Der Elternvorschlag erzeugt eine neue Version. Offene Kinder bleiben erhalten,
werden aber neu ausgewertet. Ein Kind ist erst wieder annehmbar, wenn sein neuer
Fence gegen den aktuellen Stand ausgegeben wurde.

### 5.4 Kind ohne Elterninhalt verwenden

Ein `extends`-Kind darf nicht ohne seine Voraussetzung angewendet werden. Die UI
bietet stattdessen `Ohne Vorgaenger neu erstellen`. Dadurch entsteht ein neuer
`independent`-Vorschlag gegen die aktuelle autoritative Version. Diese Aktion
ist eine neue Agenten-/Servertransformation und keine versteckte Teilannahme.

### 5.5 Elternvorschlag ablehnen

- `independent`-Geschwister bleiben unberuehrt.
- `extends`-Nachfahren wechseln auf `blocked_by_parent`.
- `replaces`-Nachfolger bleiben annehmbar, weil sie den alten Vorschlag
  ausdruecklich ersetzen.
- Alternativen bleiben entsprechend ihrer Auswahlgruppe verfuegbar.
- Blockierte Nachfahren koennen als Zweig abgelehnt oder ueber Detach neu
  erstellt werden.

### 5.6 Ersetzung oder Alternative annehmen

- Bei `replaces` wird der ersetzte Vorschlag terminal `superseded`.
- Bei `alternative` werden die anderen Optionen terminal
  `alternative_not_selected`, sofern der Nutzer sie nicht vorher explizit als
  unabhaengige neue Vorschlaege abtrennt.

### 5.7 Revert

Revert bleibt eine neue autoritative Operation und oeffnet keinen alten
Proposal-Zweig erneut. Alle noch offenen Vorschlaege werden danach wie bei jeder
anderen neuen Version revalidiert.

## 6. Mehrere Zweige und Batch-Annahme

Mehrere unabhaengige Vorschlaege duerfen gemeinsam ausgewaehlt werden. Der
Server erzeugt daraus eine kurzlebige Batch-Komposition mit expliziter
Reihenfolge und Dependency-Closure.

- Der sichtbare Vergleich zeigt `aktueller Stand gegen kombinierten Kandidaten`.
- Die Auswahl wird zuerst vollstaendig auf einem Clone ausgefuehrt.
- Ueberlappende oder strukturell unvertraegliche Gruppen verhindern die
  Gesamtannahme.
- Die erfolgreiche Batch-Annahme erzeugt eine Version mit allen enthaltenen
  Proposal-IDs.
- Es gibt kein stilles Last-Writer-Wins zwischen ausgewaehlten Vorschlaegen.

Eine freie Teilannahme einzelner Diff-Hunks ist in der ersten Ausbaustufe nicht
vorgesehen. Teilannahme ist nur fuer bereits serverseitig als unabhaengig
deklarierte Operationsgruppen erlaubt. Der Rest wird danach als neuer Vorschlag
gegen die neue aktuelle Version materialisiert.

## 7. Rebase- und Konfliktmodell

Rebase ist eine deterministische Serveroperation, kein neuer freier LLM-Lauf.
Sie verwendet:

- autoritative Basisrevision und Basis-State-Vector,
- aktuellen autoritativen Stand,
- stabile Zielanker und Target-/Format-Hashes,
- inkrementelle Operationen,
- kumulativen Kandidaten-Hash und Parent-Kandidaten-Hash.

Ergebnisse:

- `clean`: Kandidat ist gegen den aktuellen Stand annehmbar.
- `clean_rebased`: nicht ueberlappende Aenderungen wurden deterministisch auf
  den aktuellen Stand uebertragen; Audit speichert den Rebase.
- `blocked_by_parent`: erforderlicher Vorgaenger ist nicht mehr verfuegbar.
- `conflicted`: Ziel oder Struktur wurde inkompatibel geaendert.
- `stale_lifecycle`: Dokumentgeneration, Schema oder Lineage ist nicht mehr
  gueltig.
- `unavailable`: Inhalt, Storage oder Berechtigung reicht fuer eine sichere
  Auswertung nicht aus.

Ein technisch nicht ueberlappender Diff beweist keine semantische
Unabhaengigkeit. Nur explizite Beziehung und servervalidierte Herkunft erlauben
die getrennte Annahme.

## 8. Races und Action-Fences

Die bestehende Serialisierung pro Dokument und die doppelte
Proposal-Revalidierung bleiben erhalten. Der neue Action-Fence bindet
zusaetzlich:

- aktuelle autoritative Revision und State-Vector-Hash,
- Proposal-ID und Proposal-CAS-Version,
- Relationship-/Graph-Revision,
- Dependency-Closure und deren Kandidaten-Hashes,
- ausgewaehlte Batch-Mitglieder und Reihenfolge,
- Nutzer, Workspace, Lineage, Lifecycle und Schema.

Wenn zwei Nutzer gleichzeitig Vorschlaege annehmen, gewinnt nicht der letzte
Schreibzugriff. Die erste serialisierte Operation erzeugt die neue Version; die
zweite Aktion verliert ihren Fence und muss neu bewertet werden.

## 9. Persistenzmodell

Die bestehende Operationstabelle wird nicht zu einem unstrukturierten
Graphspeicher erweitert. Vorgesehen sind explizite Proposal-Metadaten und
Revision-Bindungen, beispielsweise:

```text
file_change_proposals
- proposal_id
- workspace_id
- lineage_id
- document_id
- lifecycle_generation
- base_revision_id
- base_state_vector_hash
- parent_proposal_id?
- relation: independent | extends | replaces | alternative
- alternative_group_id?
- graph_revision
- incremental_payload_ref
- incremental_payload_hash
- cumulative_candidate_ref
- cumulative_candidate_hash
- parent_candidate_hash?
- status
- cas_version
- created_by_user_id
- actor_id
- created_at / updated_at / resolved_at?

file_revision_proposal_bindings
- revision_id
- proposal_id
- resolution: applied | included | batch_applied
- application_order
```

Die genaue Migration darf bestehende `collaboration_agent_operations` nicht
duplizieren. Eine Proposal-Zeile referenziert die zugrundeliegende Operation;
Yjs-Apply-, Durability- und Revert-Receipts bleiben dort autoritativ.

Eltern-Payloads und Kandidaten duerfen nicht durch Retention entfernt werden,
solange offene Nachfahren darauf verweisen. Nach terminaler Aufloesung gelten
die bestehenden Content- und Audit-Retention-Regeln.

## 10. Servicearchitektur

### 10.1 Domain-Orchestrierung

Ein Proposal-Orchestrator besitzt die fachlichen Regeln:

- Beziehung und Berechtigung pruefen,
- Dependency-Closure bestimmen,
- Statusuebergaenge und CAS ausfuehren,
- Accept, Reject, Detach, Replace, Alternative und Batch koordinieren,
- autoritative Revision und Proposal-Aufloesungen gemeinsam committen,
- Nutzerfehler und Konfliktklassen bestimmen.

### 10.2 Gemeinsame Mechaniken

Kleine, explizite Services stellen wiederverwendbare Mechaniken bereit:

- `resolveProposalClosure(...)`
- `composeProposalCandidate(...)`
- `rebaseProposalCandidate(...)`
- `classifyProposalRelationship(...)`
- `buildProposalActionFence(...)`
- `validateProposalGraph(...)`

Diese Funktionen erhalten alle Daten explizit und mutieren keine Domain-Tabellen
verdeckt. Accept-Route, Compare-Service, Timeline, Chat-Widget und Notifications
duerfen keine eigene Variante der Graphregeln implementieren.

## 11. API- und Tool-Contracts

Erweiterungen benoetigen versionierte Contracts fuer:

- Erstellung mit `basedOnProposalId`, erwarteter Parent-Kandidaten-Hash und
  Beziehung,
- Timeline-Projektion mit Parent, Relation, Dependency-Status und
  `includedProposalIds`,
- Vergleich eines effektiven Einzel- oder Batch-Kandidaten,
- Accept mit Graph-Fence und optionaler Batch-Auswahl,
- Reject eines Knotens oder ganzen Zweigs,
- Detach/Rebase als neue Proposal-Erstellung,
- stabile Fehlercodes wie `PROPOSAL_PARENT_CHANGED`, `PROPOSAL_CYCLE`,
  `PROPOSAL_DEPENDENCY_BLOCKED`, `PROPOSAL_GRAPH_CHANGED` und
  `PROPOSAL_BATCH_CONFLICT`.

Chat- und Dateiwerkzeuge geben nach einem Review-Vorschlag dessen ID und
Kandidaten-Hash zurueck. Eine spaetere Weiterbearbeitung dieses Vorschlags muss
diese Referenz wieder einreichen. Normale Datei-Leseoperationen liefern
weiterhin nur den autoritativen Dokumentstand.

## 12. UI im Versionen-&-Aenderungen-Center

Die Timeline gruppiert offene Vorschlaege nach Root und Beziehung, ohne den
aktuellen Stand oder die Historie zu verdraengen.

Jede Karte zeigt mindestens:

- Vorschlagstitel und Actor,
- `Basiert auf Version N`,
- `Enthaelt P1` beziehungsweise `Ersetzt P1`,
- Rebase-, Konflikt- oder Blockierungsstatus,
- Zahl enthaltener Aenderungen und optionaler Nachfolger.

Der sichtbare Vergleich bleibt immer:

```text
aktueller autoritativer Dokumentstand
gegen
effektiver Kandidat der aktuellen Auswahl
```

Bei Auswahl eines Kindes vor Annahme des Elternteils zeigt der Vergleich die
kumulative Kette. Nach Annahme des Elternteils zeigt dieselbe Kindkarte nur noch
die verbleibende Aenderung und fordert vor Annahme einen frischen Fence an.

Aktionstexte muessen die Wirkung benennen:

- `P3 inklusive P1 annehmen`
- `Nur P1 annehmen`
- `Ohne P1 neu erstellen`
- `Durch P3 ersetzen`
- `Alternative auswaehlen`
- `Zweig ablehnen`

Auf Mobile wird die Hierarchie ueber Einrueckung, Verbindungslinie, Text und
Icon transportiert; Farbe allein reicht nicht.

## 13. Chat-Widgets und Notifications

- Ein Widget referenziert den neuesten autoritativen Proposal-Knoten, nicht
  dauerhaft einen inzwischen ersetzten Aktionszustand.
- Ersetzungen aktualisieren das Widget auf den Nachfolger und kennzeichnen den
  alten Vorschlag als ersetzt.
- Eine Erweiterung kann als Kette dargestellt werden; der Hauptbutton oeffnet
  den aktuell annehmbaren Blattknoten.
- Notifications werden pro Root/Zweig gruppiert, damit P1 und ein P1
  einschliessendes P2 nicht als zwei unabhaengige Aufgaben erscheinen.
- Ein blockierter Nachfahre erzeugt keine wiederholte Annahme-Notification,
  sondern eine einzelne Aktion `Neu erstellen oder Zweig ablehnen`.
- Deep-Links enthalten nur IDs und Auswahlabsicht. Inhalte und Fences bleiben
  serverseitig und werden nach dem Oeffnen neu autorisiert.

## 14. Sicherheit, Limits und Retention

- Maximale Tiefe, Knotenzahl pro Root, offene Wurzeln pro Dokument und
  Batchgroesse werden serverseitig begrenzt.
- Zyklus-, Cross-Workspace-, Cross-Lineage- und Lifecycle-Kanten werden beim
  Schreiben abgewiesen.
- Der Server prueft Leserechte zum Parent und Schreib-/Manage-Rechte fuer jede
  Mutation erneut.
- Kandidaten, Diffs und Parent-Inhalte erscheinen nie in URL, Notification oder
  Log-Metadaten.
- Ersetzungs- und Include-Zustaende sind auditierbar und nicht vom Client frei
  setzbar.
- Graph- und Proposal-Fences werden wie bestehende Freigabe-Tokens nie
  persistiert oder in Telemetrie ausgegeben.
- Restore, Delete, Schemawechsel und Lifecycle-Wechsel koennen offene Graphen
  terminal veralten lassen; Rename und Move behalten Lineage und Graph.

## 15. Migration und Rollout

1. Contracts und reine Graphvalidierung hinter serverseitigem Flag einfuehren.
2. Schema und read-only Projektion migrieren; bestehende offene Operationen
   erscheinen als unabhaengige Root-Vorschlaege.
3. Neue Agenten-/Tool-Aufrufe koennen explizite Beziehungen schreiben.
4. Timeline stellt Beziehungen read-only dar, Actions verwenden weiter den
   bisherigen Einzelpfad.
5. Extends-/Replace-/Reject-Propagation aktivieren.
6. Atomare Chain- und Batch-Annahme aktivieren.
7. Widgets und Notifications gruppieren.
8. Nach PostgreSQL-, Build- und ausdruecklich freigegebenem UI/E2E-Gate das
   Feature fuer Markdown ausrollen.

Rollback deaktiviert neue Graphmutationen und Batch-Aktionen, behaelt Proposal-
und Auditdaten und faellt fuer weiterhin sicher eigenstaendige Vorschlaege auf
den bestehenden Einzelreview zurueck. Abhaengige Vorschlaege bleiben
fail-closed und werden nicht still als unabhaengig behandelt.

## 16. Testmatrix

Mindestens folgende Faelle sind verpflichtend:

- zwei unabhaengige Vorschlaege an derselben Version, beide Annahmereihenfolgen,
- `extends`: Kind direkt annehmen und Elternteil zuerst annehmen,
- `extends`: Elternteil ablehnen, Kind blockieren und detach neu erstellen,
- `replaces`: alter Vorschlag nicht mehr annehmbar,
- Alternativgruppe mit expliziter Auswahl,
- mehrere Kinder desselben Elternteils,
- drei Ebenen tiefe Kette und maximale Tiefengrenze,
- semantische Abhaengigkeit ohne Textueberlappung,
- sauberer Rebase nach fremder nicht ueberlappender Aenderung,
- Konflikt nach ueberlappender Nutzer- oder Agentenaenderung,
- gleichzeitige Annahme durch zwei Nutzer,
- stale Graph-, Parent-, Proposal- und Current-Fences,
- Retry nach verlorener Antwort ohne doppelte Version,
- atomare Batch-Annahme und Batch-Konflikt ohne Teilwrite,
- serverseitig unabhaengige Teilgruppen und Restvorschlag,
- Reject-, Replace-, Include-, Detach- und Revert-Audit,
- Rename/Move, Delete/Restore, Schema- und Lifecycle-Wechsel,
- Retention mit offenem Nachfahren,
- Timeline, Compare, Chat-Widget, Notification und Deep-Link nach Reload,
- Desktop, Mobile, Tastatur, Screenreader, Reduced Motion und Light/Dark.

## 17. Definition of Done

Die Erweiterung ist fertig, wenn:

- mehrere Vorschlaege aus derselben Version aus Nutzersicht eindeutig
  unterschieden und in sicherer Reihenfolge angenommen werden koennen,
- Erweiterung, Ersetzung, Alternative und Unabhaengigkeit explizit sichtbar
  sind,
- die Annahme eines Kindes seine erforderlichen Vorgaenger eindeutig umfasst,
- die Annahme eines Elternteils offene Kinder sicher neu validiert,
- Ablehnung und Ersetzung deterministisch auf Nachfahren wirken,
- jeder Vergleich weiterhin den aktuellen autoritativen Stand verwendet,
- jede Annahme genau eine neue autoritative Version erzeugt,
- kein alter Fence, Retry oder paralleler Nutzer eine doppelte oder stille
  Anwendung erzeugen kann,
- bestehende Einzelreviews ohne Datenmigration als unabhaengige Roots weiter
  funktionieren,
- alle Contract-, PostgreSQL-, Security-, Build- und freigegebenen UI/E2E-Gates
  bestanden sind.
