# Abhaengige und parallele Agentenvorschlaege

Stand: 2026-09-17

Status: geplant; Szenario-Review vom 2026-09-17 eingearbeitet

Zugehoeriger Umsetzungsplan:
[`todo.json`](./todo.json), Paket `FVRC-P10`.

Konkrete Szenarien, UI-Abnahme und Testzuordnung stehen in
[`proposal-graph-scenarios.md`](./proposal-graph-scenarios.md).

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
3. Jede erfolgreich gespeicherte, inhaltsaendernde Annahme erzeugt genau eine
   neue autoritative Version; Retries und wirkungslose Aktionen erzeugen keine.
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

Der effektive Kandidat ist der gegen den aktuellen Stand neu ausgewertete
Zielstand eines Vorschlags einschliesslich aller noch erforderlichen Vorgaenger.
Er bewahrt zwischenzeitliche kompatible Aenderungen anderer Autoren und ist die
rechte Seite des sichtbaren Vergleichs. Der unveraenderliche urspruengliche
Kandidat dient als Herkunftsnachweis, nicht als Whole-File-Ersatz fuer den
aktuellen Stand.

### 2.4 Invarianten

- Der autoritative Revisionsverlauf ist linear und unveraenderlich.
- Proposal-Kanten zeigen nur auf Vorschlaege derselben Dokument-Lineage und
  Lifecycle-Generation.
- Der Graph ist azyklisch.
- Ein Vorschlag besitzt hoechstens einen zwingenden Elternvorschlag. Eine
  spaetere Zusammenfuehrung mehrerer Zweige wird als neue Batch-Komposition
  modelliert, nicht als frei editierbarer Multi-Parent-Graph.
- Vorschlagsinhalt, Basis und Abhaengigkeit sind nach Erstellung unveraenderlich.
  Eine Ueberarbeitung erzeugt einen neuen Vorschlag. Neue Ersatz- und
  Auswahlbeziehungen werden versioniert angehaengt; sie schreiben keinen
  urspruenglichen Kandidaten um.
- Annahme, Ablehnung, Rebase, Detach und Batch-Annahme sind idempotent und
  besitzen eigene Action-Fences.
- Jede Aenderung des autoritativen Stands entwertet alle zuvor ausgegebenen
  Annahme-Tokens noch offener Vorschlaege.
- Kein Vorschlag wird allein aufgrund nicht ueberlappender Textbereiche als
  semantisch unabhaengig eingestuft.

## 3. Graphmodell

```text
Autoritativ: Version 27
├── Auswahlgruppe A
│   ├── P1  Einleitung ueberarbeiten
│   │   └── P3  erweitert P1 um Quellen
│   └── P4  Alternative zu P1; enthaelt P1 nicht
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

Die folgenden Bezeichnungen sind Produktbegriffe, kein einzelnes exklusives
Enum fuer alle Kanten. Die zwingende Basis (`dependencyProposalId` oder
autoritative Revision), eine Ersetzung (`replacesProposalId`) und die
Alternativgruppe sind getrennte Dimensionen. So koennen P2 und P3 beide P1
erweitern und zugleich Alternativen zueinander sein. Eine neue Fassung von P2
erbt die Abhaengigkeit von P1; sie setzt nicht versehentlich P2 voraus.

Nur Dependency-Kanten werden in die Annahmekette aufgenommen. Ersatzkanten
muessen separat azyklisch sein. Alternativgruppen bestehen aus gleichrangigen
Optionen mit derselben Voraussetzung. Ein Vorfahr und sein Nachfahre koennen
keine Alternativen derselben Gruppe sein.

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
alte Vorschlag wird erst nach erfolgreicher Speicherung der expliziten
Ersetzung atomar `superseded`. Die UI zeigt `Durch P<n> ersetzt` und behaelt ihn
fuer Audit und Vergleich. Ein fehlgeschlagener Generierungslauf ersetzt nichts.

Offene Kinder des alten Vorschlags werden `blocked_by_parent`; sie werden
nicht auf den Ersatz umgehaengt. Eine Weiterfuehrung erstellt nach erneutem
Review neue Kinder auf dem Ersatz. Wird der Ersatz spaeter abgelehnt, lebt das
Original nicht automatisch wieder auf. Ein angenommener Vorschlag kann nicht
nachtraeglich ersetzt werden; eine Korrektur ist ein neuer Vorschlag gegen den
aktuellen Dokumentstand.

### 4.4 `alternative`

Der Vorschlag ist eine bewusst konkurrierende Loesung. Alternativen werden in
einer gemeinsamen Auswahlgruppe dargestellt. Die Annahme einer Alternative
schliesst die anderen als `alternative_not_selected`. Deren offene Kinder
werden blockiert. Auch die Annahme eines Kindes waehlt die Alternative seines
erforderlichen Vorfahren. Die betroffene Auswahlgruppe muss vollstaendig
aufgeloest und die Aufloesung autorisiert sein. Ein angenommenes Gruppenergebnis
wird durch spaetere neue Optionen nicht rueckgaengig gemacht. Eine
spaetere Wiederaufnahme erzeugt einen neuen, gegen den dann aktuellen Stand
revalidierten Vorschlag.

### 4.5 Beziehung ist Pflichtinformation

Wenn ein Agent auf einen offenen Vorschlag Bezug nimmt, muss sein Tool-Aufruf
die Proposal-ID, den erwarteten Kandidaten-Hash und den Basisnachweis explizit
uebergeben. Eine unabhaengige Erstellung benoetigt entsprechend einen gueltigen
autoritativen Basisnachweis. Fehlende oder ungueltige Proposal-Referenzen werden
bei einer angeforderten Weiterbearbeitung abgewiesen; sie duerfen niemals auf
`independent` zurueckfallen. Der Server darf keine Abhaengigkeit aus Chattext
oder Diff-Aehnlichkeit erraten. Er kann Herkunft und Anker technisch pruefen,
aber nicht beliebige inhaltliche Abhaengigkeiten verstehen; diese muessen Agent
und Nutzer ausdruecklich benennen.

## 5. Nutzeraktionen und Folgezustaende

### 5.1 Unabhaengigen Vorschlag annehmen

1. Der Server laedt aktuellen Stand und Proposal-Fence.
2. Der Vorschlag wird gegen den aktuellen Stand neu geprueft.
3. Nur bei noch gueltiger, bereits angezeigter Auswertung wird geschrieben.
   Ein inzwischen erforderlicher Rebase erzeugt zuerst eine neue Vorschau;
   er fuehrt nicht innerhalb des alten Annahme-Klicks zur stillen Anwendung.
4. Alle anderen offenen Vorschlaege werden als `rebase_pending` markiert und
   erhalten nach ihrer naechsten autoritativen Auswertung einen neuen Fence.
5. Bei Ueberlappung wird nichts geschrieben und der Vorschlag bleibt
   `conflicted` beziehungsweise `needs_review`.

### 5.2 Erweiterung direkt annehmen

Bei Annahme eines `extends`-Kindes wird die transitiv erforderliche, noch offene
Vorgaengerkette ermittelt. Die Kette wird in stabiler Reihenfolge komponiert,
auf einem Clone validiert und als eine atomare Dokumenttransaktion angewendet.

Dabei umfasst die Pruef-Closure auch bereits aufgeloeste Vorfahren und deren
Auswahlgruppen; nur die Apply-Menge beschraenkt sich auf noch offene Aenderungen.
So bleiben Berechtigungen, heutige Voraussetzungen und Alternativwahl pruefbar,
ohne einen angewendeten Vorfahren erneut zu schreiben. Ein abgelehnter,
ersetzter oder abgelaufener Pflichtvorfahr stoppt die Aktion.

Die neue Revision speichert `includedProposalIds`. Vorgaenger erhalten den
terminalen Zustand `included`, damit sie nicht ein zweites Mal angewendet werden
koennen. Nach dauerhaftem Erfolg darf P1 nach einer Annahme von P2 inklusive P1
nicht noch einmal angenommen werden. Er verweist auf die erzeugte Revision.
Bei mehreren Kindern wird ein gemeinsamer Vorfahr genau einmal komponiert.

### 5.3 Nur den Elternvorschlag annehmen

Der Elternvorschlag erzeugt eine neue Version. Offene Kinder bleiben erhalten,
werden aber neu ausgewertet. Ein Kind ist erst wieder annehmbar, wenn sein neuer
Fence gegen den aktuellen Stand ausgegeben wurde.

`applied` oder `included` belegen nur eine fruehere Anwendung. Fuer jedes Kind
muss zusaetzlich geprueft werden, ob die benoetigte Wirkung des Elternteils im
aktuellen Dokument noch vorhanden ist. Nach Revert, Restore oder manueller
Aenderung dieser Voraussetzung gilt `prerequisite_lost`; das Kind ist blockiert.
Die urspruengliche Elternaenderung wird nicht heimlich erneut angewendet.
Unabhaengige Aenderungen ausserhalb der Voraussetzung bleiben erhalten.

### 5.4 Kind ohne Elterninhalt verwenden

Ein `extends`-Kind darf nicht ohne seine Voraussetzung angewendet werden. Die UI
bietet stattdessen `Ohne Vorgaenger neu erstellen`. Dadurch entsteht ein neuer
`independent`-Vorschlag gegen die aktuelle autoritative Version. Diese Aktion
ist eine neue Agenten-/Servertransformation und keine versteckte Teilannahme.
Sie kann scheitern oder Rueckfragen erfordern. Der neue Vorschlag bleibt stets
reviewpflichtig, auch bei ausgeschaltetem Dokument-Toggle. Abgelehnte
Elterninhalte duerfen nicht ohne sichtbaren Hinweis erneut enthalten sein;
ein blosses Loeschen der Parent-ID ist kein Detach.

### 5.5 Elternvorschlag ablehnen

- `independent`-Geschwister bleiben unberuehrt.
- `extends`-Nachfahren wechseln auf `blocked_by_parent`.
- Ein bereits ersetzter Knoten kann nicht nochmals abgelehnt werden. Sein
  Nachfolger wird nach seinen eigenen Voraussetzungen ausgewertet.
- Alternativen bleiben entsprechend ihrer Auswahlgruppe verfuegbar.
- Blockierte Nachfahren koennen als Zweig abgelehnt oder ueber Detach neu
  erstellt werden.

### 5.6 Ersetzung oder Alternative annehmen

- Bei `replaces` bleibt das Original seit Speicherung des Ersatzes
  `superseded`; die Annahme wendet nur den neuen Kandidaten und dessen echte
  Voraussetzungen an.
- Bei `alternative` werden die anderen Optionen terminal
  `alternative_not_selected`, sofern der Nutzer sie nicht vorher explizit als
  unabhaengige neue Vorschlaege abtrennt.

### 5.7 Revert

Revert bleibt eine neue autoritative Operation und oeffnet keinen alten
Proposal-Zweig erneut. Alle noch offenen Vorschlaege werden danach wie bei jeder
anderen neuen Version revalidiert.

Bereits angenommene Nachfolger werden nicht automatisch mit rueckgaengig
gemacht. Revert benoetigt eine eigene aktuelle Vorschau und Konfliktpruefung;
betroffene bekannte Voraussetzungen werden angezeigt. Historische Aufzeichnungen
bleiben wahr, auch wenn ihre Wirkung im aktuellen Dokument nicht mehr besteht.

### 5.8 Bereits enthaltene oder wirkungslose Aenderungen

Ist die gesamte Wirkung nachweislich schon vorhanden, zeigt die UI
`Bereits im aktuellen Stand enthalten`. Ein explizites Abschliessen kann
`satisfied_elsewhere` samt Referenz auf den bestehenden Stand auditieren; es
erzeugt keine neue Inhaltsversion und waehlt keine Alternative automatisch.
Unklare oder nur teilweise vorhandene Wirkung bleibt im Review. Ein technisch
identischer Texthash beweist bei strukturiertem Markdown keine gleiche Wirkung.

Hebt eine Kette alle eigenen Aenderungen wieder auf, wird kein leerer Accept
ausgefuehrt. Die UI bietet Ablehnen oder Neu-Erstellen an. Sie darf nicht alle
Vorgaenger als inhaltlich angewendet markieren.

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
- Elternteil plus Kind und mehrere Kinder mit gemeinsamem Vorfahr werden
  dedupliziert. Zwei Optionen derselben Alternativgruppe sind unzulaessig,
  auch wenn der Widerspruch erst in der Dependency-Closure sichtbar wird.
- Reihenfolge allein loest keine Konflikte. Nur nachweislich kompatible
  Operationen duerfen gemeinsam angewendet werden; identische Textstellen,
  Inserts am selben Anker und Format-/Strukturaenderungen werden mitgeprueft.
- Atomaritaet gilt fuer eine Dokument-Lineage. Dateiuebergreifende Change Groups
  zeigen Outcomes pro Dokument und bieten in P10 kein globales `Alle annehmen`.

Eine freie Teilannahme einzelner Diff-Hunks ist in der ersten Ausbaustufe nicht
vorgesehen. Auch die neue Graph-Batch-API nimmt nur ganze Vorschlaege an.
Vorhandene Legacy-Teiloperationen werden mit explizitem Restumfang angezeigt;
sie duerfen erst nach nachgewiesener Gruppenunabhaengigkeit als neue Kandidaten
teilnehmen. Eine neue Teilannahme-UI mit Abhaengigkeitsmodell auf Gruppenebene
bleibt ausserhalb von P10.

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
- `prerequisite_lost`: frueher angewendete Voraussetzung wurde entfernt oder
  inkompatibel veraendert.
- `conflicted`: Ziel oder Struktur wurde inkompatibel geaendert.
- `stale_lifecycle`: Dokumentgeneration, Schema oder Lineage ist nicht mehr
  gueltig.
- `unavailable`: Inhalt, Storage oder Berechtigung reicht fuer eine sichere
  Auswertung nicht aus.

Ein technisch nicht ueberlappender Diff beweist keine semantische
Unabhaengigkeit. Nur explizite Beziehung und servervalidierte Herkunft erlauben
die getrennte Annahme.

Lifecycle-Status (`open`, `applied`, `included`, `rejected`, `superseded`,
`alternative_not_selected`, `satisfied_elsewhere`, `expired`) und berechneter
Auswertungsstatus werden getrennt gespeichert. Eine neue Auswertung mutiert
keinen urspruenglichen Kandidaten. Sie bindet ihren Ergebnis-Hash, die
Ankerabbildung und ihre Gueltigkeit an genau einen Current-/Graph-Stand.
Bei unbekannten semantischen Voraussetzungen bleibt die Grenze des Modells
sichtbar; ein konfliktfreier Textmerge ist kein allgemeiner Qualitaetsbeweis.

## 8. Races und Action-Fences

Die bestehende Serialisierung pro Dokument und die doppelte
Proposal-Revalidierung bleiben erhalten. Der neue Action-Fence bindet
zusaetzlich:

- aktuelle autoritative Revision, Content-/Struktur-Hash und Zustandsnachweis
  inklusive Loeschungen; ein Yjs-State-Vector allein erkennt reine Loeschungen
  nicht zuverlaessig,
- Proposal-ID und Proposal-CAS-Version,
- Relationship-/Graph-Revision,
- Dependency-Closure und deren Kandidaten-Hashes,
- ausgewaehlte Batch-Mitglieder und Reihenfolge,
- Nutzer, Workspace, Lineage, Lifecycle und Schema,
- Operationstyp, Ergebnis-Hash, betroffene Gruppenauswahl und Ablaufzeit.

Wenn zwei Nutzer gleichzeitig Vorschlaege annehmen, gewinnt nicht der letzte
Schreibzugriff. Die erste serialisierte Operation erzeugt die neue Version; die
zweite Aktion verliert ihren Fence und muss neu bewertet werden.

Accept, Reject, Replace, Branch-Reject und Gruppenwahl teilen dieselbe
Serialisierungsgrenze. Neue Kinder waehrend einer Zweigaktion veraendern deren
Graphrevision; ein alter Dialog darf sie nicht unbemerkt mit ablehnen. Nach
Rechteentzug muessen auch bereits ausgegebene Fences scheitern. Derselbe
Idempotency-Key gilt nur fuer denselben Scope, Aktionstyp und Requestinhalt;
abweichende Wiederverwendung wird abgewiesen.

### 8.1 Dauerhaftes Apply und Wiederanlauf

Die existierende Prozess-Queue allein belegt keine serveruebergreifende
Exklusivitaet. Beim Implementieren sind Room-Ownership, Datenbank-CAS und alle
anderen Schreibpfade (Nutzeredit, Agenten-Direktedit, Restore, Lifecycle) in
dieselbe gueltige Dokumentgeneration einzubinden. Direkt vor der Live-Mutation
werden Vorschau und Zustand erneut geprueft, ohne dazwischen I/O freizugeben.

Eine Yjs-Transaktion ist kein Rollback einer PostgreSQL-Transaktion. Die
gesamte Closure wird vorab auf einem Clone validiert und als eine gemeinsame
Operation mit dauerhaftem Action-Receipt angewendet. Ein Aufruf der alten
Accept-Route fuer jeden einzelnen Knoten waere keine atomare Kettenannahme.

Der Contract unterscheidet `applying`, `awaiting_durability`,
`recovery_required` und dauerhaften Erfolg. Revision, enthaltene Proposal-IDs
und terminale Status werden erst nach bestaetigter Persistenz des vollstaendigen
Ergebnisses finalisiert. Bei einem Absturz nach Live-Apply verhindert das
Receipt eine Wiederanwendung; Recovery bestaetigt das Resultat oder blockiert
weitere widerspruechliche Aktionen, bis der Zustand geklaert ist. Checkpoint
und Autosave duerfen dieselbe logische Anwendung nicht doppelt versionieren.
Fehlgeschlagene Notifications machen einen erfolgreichen Apply nicht rueckgaengig.

`Atomar` bedeutet hier: kein Teil-Apply bei fachlichem
Konflikt, ein dokumentweites Ergebnis und ein wiederaufnehmbarer Commitpfad.
Er bedeutet keine vorgetaeuschte ACID-Transaktion ueber Speicher und Live-Room.

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
- operation_id
- dependency_proposal_id?
- replaces_proposal_id?
- source_snapshot_ref / source_proof_hash
- graph_revision
- incremental_payload_ref
- incremental_payload_hash
- cumulative_candidate_ref
- cumulative_candidate_hash
- dependency_candidate_hash?
- lifecycle_status
- cas_version
- created_by_user_id
- actor_id
- created_at / updated_at / resolved_at?

file_proposal_choice_memberships
- group_id / proposal_id / dependency_scope
- group_revision / chosen_option_id?

file_proposal_evaluations
- evaluation_id / proposal_id / current_fence / graph_revision
- applicability / reason_code / effective_candidate_hash
- anchor_mapping_ref / effect_preconditions_ref / expires_at

file_proposal_action_receipts
- action_id / request_digest / idempotency_scope
- action_type / affected_proposal_ids / status
- resulting_state_proof / resulting_revision_id?

file_revision_proposal_bindings
- revision_id
- proposal_id
- resolution: applied | included | batch_applied | satisfied_elsewhere
- application_order
```

Die genaue Migration darf bestehende `collaboration_agent_operations` nicht
duplizieren. Eine Proposal-Zeile referenziert die zugrundeliegende Operation;
Yjs-Apply-, Durability- und Revert-Receipts bleiben dort autoritativ.
Neue Action-Receipts verknuepfen diese Belege; sie erfinden keine zweite
Apply-Wahrheit. Kandidaten und Anker benoetigen bei Yjs dieselbe rekonstruierbare
Identitaet: Ein Kind kann einen Block bearbeiten, den sein offener Parent erst
anlegt. Reine Markdown-Strings reichen dafuer nicht. Snapshot oder
deterministische Ankerabbildung und deren Retention sind verpflichtend.

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
- dauerhaften Apply und gemeinsame Finalisierung von Revision und
  Proposal-Aufloesungen ueber Receipts koordinieren,
- Nutzerfehler und Konfliktklassen bestimmen.

### 10.2 Gemeinsame Mechaniken

Kleine, explizite Services stellen wiederverwendbare Mechaniken bereit:

- `resolveProposalClosure(...)`
- `composeProposalCandidate(...)`
- `rebaseProposalCandidate(...)`
- `validateProposalRelationships(...)`
- `buildProposalActionFence(...)`
- `validateProposalGraph(...)`

Diese Funktionen erhalten alle Daten explizit und mutieren keine Domain-Tabellen
verdeckt. Accept-Route, Compare-Service, Timeline, Chat-Widget und Notifications
duerfen keine eigene Variante der Graphregeln implementieren.

## 11. API- und Tool-Contracts

Erweiterungen benoetigen versionierte Contracts fuer:

- Erstellung mit versionierter Basisreferenz, Kandidaten-Hash und getrennten
  Dependency-, Replacement- und Choice-Referenzen,
- Timeline-Projektion mit Parent, Relation, Dependency-Status und
  `includedProposalIds`,
- Vergleich eines effektiven Einzel- oder Batch-Kandidaten,
- Accept mit Graph-Fence und optionaler Batch-Auswahl,
- Reject eines Knotens oder ganzen Zweigs,
- Detach und inhaltliche Ueberarbeitung als neue Proposal-Erstellung;
  deterministischer Rebase als neue Auswertung desselben Vorschlags,
- stabile Fehlercodes wie `PROPOSAL_PARENT_CHANGED`, `PROPOSAL_CYCLE`,
  `PROPOSAL_DEPENDENCY_BLOCKED`, `PROPOSAL_GRAPH_CHANGED` und
  `PROPOSAL_BATCH_CONFLICT`.

Chat- und Dateiwerkzeuge geben nach einem Review-Vorschlag dessen ID und
Kandidaten-Hash zurueck. Eine spaetere Weiterbearbeitung dieses Vorschlags muss
diese Referenz wieder einreichen. Normale Datei-Leseoperationen liefern
weiterhin nur den autoritativen Dokumentstand.

Ein expliziter Proposal-Read liefert den unveraenderlichen Kandidaten samt
verifizierbarer Basis- und Ankerreferenz. Fehlt diese oder passt sie nicht,
stoppt der Schreibaufruf. Safe-Direct darf ausstehende Voraussetzungen nie
implizit mit genehmigen. Legacy-Clients und alte Accept-/Grant-/Revert-Routen
muessen graphgebundene Operationen serverseitig erkennen und entweder den neuen
Contract verwenden oder eine verstaendliche Upgrade-Antwort liefern.

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

### 12.1 Verbindliche UI-Ergaenzungen

- Die normale Timeline bleibt `Agenten-Reviews`, `Aktuell`, `Versionshistorie`.
  Innerhalb der Reviews sind Dependency-Zweige einklappbar; Alternativen
  besitzen eine explizite Auswahl. Abgeschlossene Vorschlaege bleiben ueber
  einen Filter und die zugehoerige Revision auffindbar.
- Karten trennen `Erstellt auf Version N` und `Jetzt verglichen mit Version M`.
  Die Aktionsleiste nennt mit angewendete und mit geschlossene Vorschlaege.
  Automatisch benoetigte Vorfahren sind markiert und koennen nicht abgewaehlt
  werden, solange ein Kind gewaehlt bleibt.
- Bei `prerequisite_lost`, Konflikt oder fehlenden Daten stehen Grund und
  naechster Schritt: `Vergleich aktualisieren`, `Auf aktuellem Stand neu
  erstellen` oder `Zweig ablehnen`. Kein generisches `Vergleich nicht verfuegbar`
  fuer alle Fehler. Eine neue Agentenfassung bleibt ein neues Review.
- Neue Current-/Graph-Staende sperren die alte Annahme sofort. Auswahl, Fokus
  und Scrollposition bleiben erhalten; nach Refresh sieht der Nutzer den neuen
  Diff vor einem neuen Klick. Verspaetete Antworten zu anderer Auswahl, Datei
  oder anderem Workspace duerfen weder Diff noch Aktionsleiste ueberschreiben.
- `Angewendet, Speicherung wird bestaetigt` und `Status wird geprueft` sind
  eigene Zustaende. Ein Timeout oder das Schliessen des Dialogs gilt nicht als
  fehlgeschlagenes oder abgebrochenes Apply. Wiederoeffnen fragt das Receipt ab.
- Lokale noch nicht synchronisierte Editor-Aenderungen werden vor einer
  Annahme abgeglichen; andernfalls bleibt die Aktion mit Hinweis gesperrt.
  Nicht synchronisierte Daten anderer Offline-Clients kann der Server nicht
  vorhersagen; deren spaetere Ankunft wird erneut als Dokumentaenderung geprueft.
- Anzeigen, Annehmen, Ablehnen und Wiederherstellen haben getrennte Rechte.
  Fehlendes Restore-Recht allein bedeutet nicht `Nur ansehen` fuer Reviews.
  Ohne Leserecht wird auch eine alte gecachte Vorschau entfernt.
- Der Trenner vor der Historie liegt im scrollenden Timeline-Inhalt; fuer ihn
  darf keine feststehende mobile Panelkante einspringen. Lange Titel, mehrere
  Beziehungs-Badges und tiefe Zweige muessen innerhalb der Kartenbreite bleiben.

Komponenten und genaue Browserfaelle sind im Szenariodokument zugeordnet.

## 13. Chat-Widgets und Notifications

- Ein Widget behaelt die exakte historische Proposal-Referenz und aktualisiert
  deren Status. Bei Ersetzung zeigt es `Durch P<n> ersetzt` mit explizitem Link
  zum Nachfolger. Ein alter Link darf nicht still eine andere Fassung oeffnen.
- Ein zusammenfassendes Zweig-Widget darf eine Auswahlansicht oeffnen. Bei
  mehreren Blaettern wird keines stillschweigend als `das neueste` genehmigt.
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
- Der Server prueft Leserechte zu allen benoetigten Inhalten und
  Schreib-/Manage-Rechte fuer die gesamte Aktionsmenge erneut: enthaltene
  Vorfahren, ersetzte Knoten und terminal zu schliessende Alternativen. Ein
  fremdes Kind darf keine Berechtigungen fuer seinen Parent verleihen.
- Kandidaten, Diffs und Parent-Inhalte erscheinen nie in URL, Notification oder
  Log-Metadaten.
- Ersetzungs- und Include-Zustaende sind auditierbar und nicht vom Client frei
  setzbar.
- Graph- und Proposal-Fences werden wie bestehende Freigabe-Tokens nie
  in Telemetrie oder URLs ausgegeben. Dauerhafte Receipts speichern nur den
  erforderlichen Request-Digest und Zustandsnachweis, keine wiederverwendbare
  Freigabe.
- History-Restore und Revert innerhalb derselben Lifecycle-Generation
  revalidieren offene Vorschlaege. Delete, Trash-Restore mit neuer Generation
  oder Schemawechsel sperren alte Kandidaten bis zur expliziten Neuerstellung.
  Rename und Move innerhalb desselben Workspace behalten Lineage und Graph;
  Workspace-Wechsel und Kopien erzeugen keinen automatisch mitkopierten Graphen.
- Retention pinnt auch Basissnapshots und Ankerbelege. Abgelaufene oder fehlende
  Belege fuehren zu einem sichtbaren `expired`/`unavailable` statt unsicherem
  Fallback. Limits werden vor grossen Clone-/Diff-Allokationen geprueft.

## 15. Migration und Rollout

1. Contracts und reine Graphvalidierung hinter serverseitigem Flag einfuehren.
2. Schema und read-only Projektion migrieren; nachweislich eigenstaendige
   bestehende Operationen erscheinen als Roots. Ungeklaerte oder partielle
   Herkunft bleibt sichtbar und gesperrt bis zur sicheren Auswertung.
3. Alle alten Mutationsrouten erkennen Graphbindungen und blockieren den
   Einzelpfad fuer abhaengige, ersetzte oder alternativgebundene Vorschlaege.
4. Neue Beziehungen intern anlegen und read-only anzeigen. Graphaktionen
   bleiben gesperrt, bis Closure, Recovery und Propagation gemeinsam bereit sind.
5. Vollstaendigen Chain-Apply, Reject/Replace und Alternative-Propagation
   gemeinsam aktivieren; Batch-Annahme kann danach separat folgen.
6. Widgets, exakte Deep-Links und gruppierte Notifications aktivieren.
7. Mischbetrieb mit alten Clients und Rollback pruefen; unbekannte Legacy-
   Herkunft und partielle Operationen nicht pauschal als unabhaengig freigeben.
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
- Alternative und Ersetzung eines bereits abhaengigen Kindvorschlags,
- Parent erzeugt einen Block, Kind referenziert dessen noch nicht live
  vorhandene Yjs-Identitaet,
- Parent angewendet, danach Revert/Restore/manuell entfernte Voraussetzung,
- sauberer Rebase nach fremder nicht ueberlappender Aenderung,
- Konflikt nach ueberlappender Nutzer- oder Agentenaenderung,
- gleichzeitige Annahme durch zwei Nutzer,
- stale Graph-, Parent-, Proposal- und Current-Fences,
- Retry nach verlorener Antwort ohne doppelte Version,
- atomare Batch-Annahme und Batch-Konflikt ohne Teilwrite,
- bereits vorhandene Wirkung, leere Netto-Kette und Legacy-Restvorschlag,
- Reject-, Replace-, Include-, Detach- und Revert-Audit,
- Rename/Move, Delete/Restore, Schema- und Lifecycle-Wechsel,
- Retention mit offenem Nachfahren,
- Timeline, Compare, Chat-Widget, Notification und Deep-Link nach Reload,
- Desktop, Mobile, Tastatur, Screenreader, Reduced Motion und Light/Dark.

Die verbindlichen Given/When/Then-Faelle mit IDs, Testebene und Task-Zuordnung
stehen in [`proposal-graph-scenarios.md`](./proposal-graph-scenarios.md).

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
- jede inhaltsaendernde, dauerhaft bestaetigte Annahme genau eine neue
  autoritative Version erzeugt und No-ops/Retries keine Doppelversion erzeugen,
- kein alter Fence, Retry oder paralleler Nutzer eine doppelte oder stille
  Anwendung erzeugen kann,
- nachweislich eigenstaendige bestehende Einzelreviews ohne Inhaltsmigration
  weiter funktionieren; unbekannte Herkunft und partielle Zustaende bleiben
  explizit gekennzeichnet und gesperrt, bis sie sicher ausgewertet wurden,
- alle Contract-, PostgreSQL-, Security-, Build- und freigegebenen UI/E2E-Gates
  bestanden sind.
