# File Version & Review Center

Stand: 2026-09-17

Status: Markdown-Kernfeature umgesetzt; Proposal-Graph und weitere Adapter geplant

Repository: `canvasstudios-notebook`

Die maschinenlesbare, strikt sequenzielle Umsetzungsliste liegt in
[`todo.json`](./todo.json).

Die Erweiterung fuer parallele, abhaengige, ersetzende und alternative
Agentenvorschlaege ist in
[`proposal-graph.md`](./proposal-graph.md) spezifiziert.

## 1. Zielbild

Canvas Notebook erhaelt einen globalen **Versionen-&-Aenderungen-Center** fuer
unterstuetzte Dokumente. Derselbe grosse Dialog wird aus dem Editor, dem
Dateibrowser, einem Chat-Widget und aus der Benachrichtigungszentrale
geoeffnet.

Der Center vereint drei bisher getrennte Konzepte:

1. ausstehende Agentenvorschlaege, die angenommen oder abgelehnt werden muessen,
2. den aktuellen autoritativen Dokumentstand,
3. dauerhaft gespeicherte historische Versionen, die verglichen oder als neue
   Version wiederhergestellt werden koennen.

Markdown ist die erste und wichtigste Ausbaustufe. Die Architektur muss weitere
Text- und Codeformate ueber Capability- und Storage-Adapter ergaenzen koennen,
ohne fuer jeden Dateityp eine eigene UI oder einen eigenen Review-Workflow zu
erzeugen.

## 2. Verbindliche Produktentscheidungen

### 2.1 Ein globaler Center statt mehrerer Vorschaufenster

Alle Einstiegspunkte oeffnen denselben global montierten Dialog. Der vorhandene
kleine Agenten-Popover bleibt waehrend der Migration funktionsfaehig, wird danach
aber nicht als zweite Review-Oberflaeche weitergefuehrt.

### 2.2 Vergleichsbasis ist immer der aktuelle Stand

Der sichtbare Vergleich lautet immer:

```text
aktueller autoritativer Dokumentstand
gegen
ausgewaehlten Agentenvorschlag oder ausgewaehlte historische Version
```

Bei einem ueberholten Agentenvorschlag berechnet der Server die Vorschau gegen
den aktuellen Stand neu und markiert den Vorschlag als veraltet oder
konfliktbehaftet. Die urspruengliche Basisversion darf in den technischen Details
angezeigt werden, ersetzt aber nicht den primaeren Vergleich.

### 2.3 Wiederherstellen erzeugt eine neue Version

Eine historische Version wird niemals in-place zurueckgeschrieben oder aus der
Historie entfernt. Vor dem Restore wird der aktuelle Stand gesichert. Das
Wiederherstellen schreibt anschliessend einen neuen Stand mit Quelle `restore`.

### 2.4 Review-Einstellung ist nutzer- und dokumentbezogen

Der Editor-Toggle gilt fuer zukuenftige Agentenoperationen des aktuellen Nutzers
an genau dieser Dokument-Lineage:

```text
userId + workspaceId + lineageId
```

Damit kann ein Teammitglied die Agenten anderer Teammitglieder nicht unbemerkt
auf direkte Bearbeitung umstellen. Spaetere Workspace- oder
Organisationsrichtlinien duerfen Review erzwingen, aber niemals durch eine
schwaechere Nutzereinstellung aufgehoben werden.

### 2.5 "Direkt bearbeiten" bleibt fail-safe

Bei ausgeschaltetem Review-Toggle duerfen neue Aenderungen direkt angewendet
werden, **sofern sie sicher anwendbar sind**. Folgende Bedingungen erzwingen
weiterhin ein Review:

- fehlende aktuelle Schreib- oder Agentenberechtigung,
- ueberholter Hash, State Vector oder Dokument-Lifecycle,
- parallele Aenderung eines betroffenen Ziels,
- semantischer oder struktureller Konflikt,
- nicht unterstuetzte Transformation,
- expliziter Review-Modus der Operation,
- Queue-Backpressure oder gestoerte Persistenz,
- uebergeordnete Workspace- oder Organisationsrichtlinie.

Bereits ausstehende Vorschlaege werden durch Umschalten nicht automatisch
angenommen. Die UI erklaert deshalb: "Gilt fuer neue Agentenaenderungen".

### 2.6 Benachrichtigungen sind ein eigener Adapter

Editor, Dateibrowser, Chat-Widget und globaler Dialog bilden den Kern. Die
Benachrichtigungszentrale wurde als getrenntes Paket `FVRC-P08` ergaenzt. Sie
speichert keine Dokumentinhalte, sondern nur autorisierbare Referenzen auf
Dokument und Operation. Der Proposal-Graph erweitert diese Projektion um
gruppierte Zweige, ohne eine zweite fachliche Zustandsmaschine einzufuehren.

## 3. Bestehende Grundlagen und erkannte Luecken

Canvas besitzt bereits wichtige Bausteine:

- `file_collaboration_lineages` bietet eine pfadunabhaengige Dateiidentitaet.
- `file_revisions` speichert Revisionsmetadaten wie Hash, Groesse, Actor,
  Basisrevision, Lineage und Revisionsnummer.
- Markdown, Markdown-Dateien mit `.markdown` sowie `.txt` verwenden die
  `crdt_text`-Strategie.
- Agentenoperationen besitzen persistierte Review-Zustaende, Vorschauziele und
  Accept/Reject/Revert-Aktionen.
- Direkte Agentenbearbeitung ist heute ueber eine maximal 30 Minuten gueltige,
  eng an Nutzer, Workspace, Agent, Sitzung, Dokument und Lifecycle gebundene
  Freigabe abgesichert.
- Built-in Tool Apps existieren bereits fuer Todos, Automationen und Public
  Shares.
- `DialogContent` unterstuetzt bereits ein grosses `viewport`-Layout.

Die wesentlichen Luecken sind:

- `file_revisions` speichert noch keinen dauerhaft wiederherstellbaren Inhalt.
- Die vollstaendige Versionshistorie ist nicht allgemein fuer
  Workspace-Dokumente verfuegbar.
- Der vorhandene Agenten-Popover ist fuer umfangreiche Vergleiche zu klein.
- Direkte Bearbeitung wird nur ueber kurzlebige, operationsbezogene Freigaben
  gesteuert; eine dauerhafte Dokumentpraeferenz fehlt.
- Datei-Tools erzeugen noch kein dauerhaftes, im Chat erneut aufrufbares
  Change-Group-Objekt.
- Die vorhandenen Einstiegspunkte besitzen keinen gemeinsamen Open-Contract.

## 4. Informationsarchitektur des Dialogs

### 4.1 Desktop

Der Dialog verwendet `DialogContent layout="viewport"` und gliedert sich in:

1. **Kopfzeile** mit Dateiname, Pfad, Review-Status, Review-Toggle und Schliessen.
2. **Timeline links** mit Reviews, aktuellem Stand und Historie.
3. **Vergleich in der Mitte** mit Diff, Markdown-Vorschau und Quelltext.
4. **Details/Aktionen rechts oder im Footer** mit Actor, Zeitpunkt, Quelle,
   Annehmen, Ablehnen, Wiederherstellen und Weiterbearbeiten.

### 4.2 Tablet und Mobile

- Tablet reduziert Details auf ein ausklappbares Panel.
- Mobile nutzt den vollflaechigen Dialog.
- Timeline und Vergleich werden als zwei aufeinanderfolgende Ansichten gezeigt.
- Die ausgewaehlte Version und ungespeicherte Aktionen bleiben beim Wechsel
  erhalten.
- Alle Aktionen muessen tastaturbedienbar sein und Focus Trap, Escape und
  Reduced Motion respektieren.

### 4.3 Timeline-Reihenfolge und Farben

Die Reihenfolge ist verbindlich:

1. ausstehende Agentenvorschlaege, angeheftet oberhalb aller Versionen,
2. aktueller autoritativer Stand,
3. historische Versionen absteigend nach Erstellungszeit und Revisionsnummer.

Semantische Farben verwenden bestehende Theme-Tokens:

- Violett: Agentenvorschlag,
- Amber: veraltet, teilweise anwendbar oder konfliktgefaehrdet,
- Rot: blockierender Konflikt oder fehlgeschlagene Operation,
- leichtes Emerald: aktueller Stand,
- neutrale Background-/Muted-Tokens: Historie.

Farbe ist nie das einzige Statussignal. Jeder Zustand besitzt Icon und Text.

### 4.4 Vergleichsansichten

- **Aenderungen:** zeilen- oder blockweiser Diff mit Additions-/Loeschstatistik.
- **Markdown-Vorschau:** bereinigte, nicht netzwerkaktive gerenderte Vorschau.
- **Quelltext:** alter und ausgewaehlter Inhalt mit synchronem Scrollen.
- **Details:** Revisions-ID, Quelle, Actor, Agent, Chat-Sitzung, Hash und Zeitpunkt,
  soweit der aktuelle Nutzer diese Metadaten sehen darf.

Grosse Dateien verwenden begrenzte, paginierte Diff-Hunks. Der Browser erhaelt
nicht automatisch zwei unbeschraenkte Volltexte.

## 5. Einstiegspunkte

### 5.1 Editor: Agenten-Button

Der vorhandene Bot-Button bleibt der schnelle Einstieg fuer Agentenaktivitaet:

- Violetter Badge: ausstehende Reviews.
- Amber: Konflikt oder teilweise anwendbare Operation.
- Klick oeffnet den Center mit `initialView: "reviews"`.
- Die neueste offene Operation wird ausgewaehlt.
- Ohne Agentenaktivitaet darf der Button ausgeblendet bleiben.

Nach erfolgreicher Migration werden Preview und Mutationsaktionen nicht mehr
parallel im kleinen Popover implementiert. Der Center verwendet die bestehenden
autorisierten Accept/Reject/Revert-Endpunkte.

### 5.2 Editor: Versionen-Button

Neben dem Agenten-Button wird fuer unterstuetzte Dateien ein History-Button
angezeigt:

- immer sichtbar, auch ohne bisherige Agentenoperation,
- Klick oeffnet `initialView: "history"`,
- aktueller Stand ist vorausgewaehlt,
- Tooltip und Screenreader-Text lauten "Versionen & Aenderungen".

### 5.3 Editor: Review-Toggle

Auf Desktop steht neben den beiden Buttons ein kompakter Switch mit Shield-Icon.
Die sichtbare Beschriftung kann bei geringer Breite entfallen. Auf Mobile ist die
gleiche Einstellung zusaetzlich ueber das Dateiaktionsmenue erreichbar.

Zustaende:

- an: `review_required`,
- aus: `safe_direct`,
- gesperrt an: durch uebergeordnete Richtlinie erzwungen,
- lade-/fehlerhaft: fail-closed als `review_required`.

### 5.4 Dateibrowser-Kontextmenue

`FileActionsDropdown` erhaelt den Eintrag "Versionen & Aenderungen". Da der
Dateibrowser-Rechtsklick und das Drei-Punkte-Menue im Editor dieselbe Komponente
verwenden, bleibt die Aktion konsistent.

Die Sichtbarkeit wird aus einer serverseitig validierten Capability abgeleitet,
nicht aus einer zweiten, im UI gepflegten Extension-Liste.

### 5.5 Chat-Widget

Nach einer erfolgreichen wirklichen Aenderung durch `write`, `edit_file` oder
`apply_patch` erzeugt der Tool-Result-Contract eine persistierte Change Group.
Das Built-in Widget zeigt:

- Dateiname oder Liste betroffener Dateien,
- angewendet, Review erforderlich oder Konflikt,
- Additions-/Loeschstatistik, soweit verfuegbar,
- "Aenderungen ansehen",
- optional "Datei oeffnen".

Bei einem Batch oeffnet jede Dateizeile den Center fuer genau dieses Dokument.
Bei `changed: false` wird kein Aenderungswidget erzeugt. Ein gespeichertes Widget
muss nach einem Chat-Reload den aktuellen Operationsstatus anzeigen.

### 5.6 Benachrichtigungszentrale, spaeter

Die zweite Ausbaustufe erzeugt Benachrichtigungen primaer fuer:

- `needs_review`,
- `semantic_conflict`,
- eine fehlgeschlagene sichere Direktanwendung.

Erfolgreich direkt angewendete Aenderungen erscheinen in Historie und Chat, aber
nicht standardmaessig als einzelne ungelesene Benachrichtigung. Spaeter ist eine
gruppierte Information moeglich.

## 6. Globaler Open-Contract

Der globale Zustand enthaelt ausschliesslich Navigationsabsicht, keine geladenen
Dokumentinhalte:

```ts
type FileVersionCenterRequest = {
  workspaceId: string;
  lineageId?: string;
  documentId?: string;
  pathHint?: string;
  changeGroupId?: string;
  selectedEntry?:
    | { kind: 'agent_operation'; id: string }
    | { kind: 'revision'; id: string };
  initialView: 'reviews' | 'history';
  source: 'editor' | 'file_browser' | 'chat' | 'notification' | 'deep_link';
};
```

Ein kleiner Zustandsspeicher stellt `openVersionCenter(request)` und
`closeVersionCenter()` bereit. Der einmalig im gemeinsamen authentifizierten
Locale-Layout montierte Host:

1. loest Operation, Change Group, Document oder Pfad auf die aktuelle Lineage
   und den aktuellen Pfad auf,
2. prueft Zugriff und Capabilities serverseitig,
3. laedt Timeline und Auswahl,
4. synchronisiert optional einen reload-faehigen Deep-Link,
5. entfernt den Deep-Link beim Schliessen ohne andere Queryparameter zu
   zerstoeren.

Deep-Links enthalten nur IDs und notwendige Navigationsdaten, niemals
Dokumentinhalt oder Freigabetokens.

## 7. Capability-Modell

Der Server liefert je Datei:

```ts
type FileVersionCapabilities = {
  history: boolean;
  compare: boolean;
  restore: boolean;
  agentReviewPolicy: boolean;
  preview: 'markdown' | 'text' | 'structured' | 'metadata';
  reason?: 'unsupported_type' | 'read_only' | 'missing' | 'policy_forced';
};
```

V1 unterstuetzt `.md`, `.markdown` und `.txt`. `.mdx`, JSON, YAML und
Quellcodedateien folgen ueber einen Revision-Check-Adapter. Office- und
Binaerformate erhalten eigene Adapter und werden nicht als angeblich
unterstuetzte Text-Diffs dargestellt.

## 8. Datenmodell

### 8.1 Bestehende Tabellen bleiben fachlich erhalten

`file_revisions` bleibt das Revisionsledger. Der bestehende breite Contract von
`ensureFileRevisionForCurrentContent` wird nicht in einem Schritt umgebaut, da
er zahlreiche Schreibpfade und Ausfuehrungsprozesse beeinflusst.

### 8.2 Neue Inhaltsebene

Vorgesehene Tabellen:

```text
file_version_blobs
  content_hash PK
  codec
  payload
  raw_size_bytes
  stored_size_bytes
  created_at

file_revision_contents
  revision_id PK/FK -> file_revisions.id
  content_hash FK -> file_version_blobs.content_hash
  content_format
  created_at
```

Blobs sind immutable, komprimiert und ueber den Inhaltshash dedupliziert. Die
Revision referenziert den Blob. Ein fehlender historischer Blob darf nicht als
wiederherstellbare Version dargestellt werden.

### 8.3 Change Groups fuer Agenten-Tools

```text
file_change_groups
  id PK
  user_id
  workspace_id
  source_session_id
  tool_call_id
  operation
  created_at

file_change_group_entries
  group_id FK
  ordinal
  lineage_id
  document_id nullable
  operation_id nullable
  revision_id nullable
  path_hint
  outcome
```

Eine Change Group verbindet genau einen Tool-Aufruf mit einer oder mehreren
Dateiaenderungen. Sie ist die stabile, authorisierbare Entity des Chat-Widgets.

### 8.4 Review-Policy

```text
file_agent_review_policies
  user_id
  workspace_id
  lineage_id
  mode: review_required | safe_direct
  revision
  updated_at
  PRIMARY KEY (user_id, workspace_id, lineage_id)
```

Die Policy-Aenderung verwendet Compare-and-Swap oder eine erwartete Revision,
damit parallele Tabs keine neuere Nutzerentscheidung ueberschreiben.

### 8.5 Retention und Quota

Die verbindlichen V1-Grenzen werden im ersten Umsetzungspaket festgeschrieben.
Ausgangsvorschlag:

- jede angenommene oder direkt angewendete Agentenaenderung behalten,
- vor und nach jedem Restore eine Version behalten,
- manuelle Versionen schuetzen,
- automatische Checkpoints zeitlich buendeln,
- mindestens 100 automatische Versionen pro Lineage,
- Blob-Deduplizierung und komprimierte Groessenabrechnung,
- Loeschen erst ueber eine auditable Retention-Operation, niemals waehrend eines
  normalen Reads oder Restores.

## 9. Service-Grenzen

Die Umsetzung wird in kleine, gerichtete Komponenten getrennt:

- **version-history-service:** Version erfassen, Metadaten und Inhalt verbinden.
- **version-content-store:** Blob-Deduplizierung, Kompression und Limits.
- **version-center-query:** Timeline aus Reviews, aktuellem Stand und Historie
  zusammenfuehren.
- **version-compare-service:** aktuellen Stand und Kandidat begrenzt vergleichen.
- **version-restore-service:** Restore mit Revisions-Fence und Idempotenz.
- **file-version-capabilities:** Dateityp, Workspace und Berechtigungen bewerten.
- **agent-edit-policy-service:** Nutzer-, Dokument- und spaetere
  Organisationsrichtlinien zu einer effektiven Policy zusammenfuehren.
- **file-change-group-service:** Tool-Aufrufe dauerhaft mit Dokumentaenderungen
  verbinden.

Bestehende Agenten-Accept/Reject/Revert-Logik wird aufgerufen und nicht im
Dialog dupliziert. Entry-Point-Komponenten duerfen weder Diff- noch
Restore-Logik enthalten.

## 10. Capture- und Restore-Ablauf

### 10.1 Version erfassen

```text
autoritative Mutation bestaetigt
  -> aktuellen kanonischen Inhalt ermitteln
  -> Hash und Groessenlimit pruefen
  -> Blob idempotent speichern
  -> file_revision und revision_content verbinden
  -> Change Group bzw. Operation aktualisieren
  -> UI-Invalidierungsereignis publizieren
```

Fuer Yjs-Dokumente ist der gespeicherte binaere Yjs-Stand autoritativ; die
Dateiprojektion darf fuer die Historie nicht faelschlich als alleinige Wahrheit
behandelt werden. Die genaue Ledger-Integration wird mit realer PostgreSQL-
Integration abgesichert, bevor weitere Einstiegspunkte gebaut werden.

### 10.2 Historische Version wiederherstellen

```text
Zugriff + Capability pruefen
  -> ausgewaehlten Blob laden und validieren
  -> aktuellen Hash/State Vector gegen UI-Fence pruefen
  -> aktuellen Stand als Version sichern
  -> Restore ueber den passenden Datei-/Yjs-Adapter anwenden
  -> neue Revision mit source=restore erzeugen
  -> offene Agentenvorschlaege neu validieren
```

Jede Mutation besitzt einen Idempotency Key. Ein unklarer Netzwerkfehler darf
keine doppelte Wiederherstellung erzeugen.

## 11. API-Oberflaeche

Die genauen Pfade werden im Contract-Paket eingefroren. Erwartete Faehigkeiten:

- Dokumentreferenz oder Change Group aufloesen,
- Capabilities und effektive Review-Policy lesen,
- Timeline paginiert lesen,
- einen Vergleich paginiert lesen,
- Review-Policy mit erwarteter Revision aendern,
- historische Version idempotent wiederherstellen,
- Change-Group-Status fuer das Built-in Widget lesen.

Mutation-Endpunkte pruefen Auth, Workspace, aktuelle Berechtigungen,
Dokument-Lifecycle und Revisions-Fence unmittelbar vor der Aenderung. Antworten
sind `private, no-store` und geben keine absoluten Serverpfade zurueck.

## 12. Sicherheit und Datenschutz

- Jede ID aus Chat, URL oder Notification ist untrusted Input.
- Der Server leitet Workspace und Dokumentzugriff nicht allein aus der ID ab,
  sondern gleicht sie mit der aktuellen Session ab.
- Read-only Nutzer duerfen erlaubte Historie vergleichen, aber weder Review-
  Policy, Accept/Reject noch Restore ausfuehren.
- Aktionen anderer Nutzer folgen den vorhandenen `actionsAllowed`-Regeln.
- Widgets und Notifications enthalten keine Dokumenttexte.
- Diff und Markdown-Preview werden gegen aktive Inhalte, externe Requests und
  unsicheres HTML gehaertet.
- Logs enthalten IDs, Status, Hashes und technische Groessen, aber keine
  Dokumentinhalte, Diff-Hunks oder Freigabetokens.
- Archivierte, geloeschte oder ersetzte Lineages werden nicht ueber einen alten
  Deep-Link auf eine neue Datei desselben Pfads umgebogen.

## 13. Fehler- und Konfliktverhalten

- Kann der aktuelle Stand nicht autoritativ geladen werden, ist Restore
  deaktiviert.
- Ist eine Auswahl inzwischen veraltet, wird sie neu geladen und der Nutzer
  erhaelt eine sachliche Meldung statt einer stillen Aktion.
- Ein abgelaufener oder entfallener Schreibzugriff schliesst den Dialog nicht;
  die Ansicht wechselt auf read-only.
- Ein fehlender historischer Inhalt zeigt "Nur Metadaten verfuegbar".
- Ein Agentenvorschlag ohne vollstaendig darstellbare Vorschau kann nicht
  angenommen werden.
- Das Ausschalten des Review-Toggles faellt bei jedem Policy-Ladefehler auf
  `review_required` zurueck.

## 14. Observability

Mindestens folgende Ereignisse werden ohne Dokumentinhalt erfasst:

- Version-Capture erfolgreich/fehlgeschlagen,
- Blob-Deduplizierung und gespeicherte Bytes,
- Vergleich abgeschnitten oder zu gross,
- Restore gestartet/erfolgreich/konfliktbehaftet,
- Review-Policy geaendert oder uebersteuert,
- Change Group erstellt und aufgeloest,
- Widget-/Deep-Link-Zugriff abgewiesen,
- Timeline-Ladezeit und Fehlercode.

Metriken muessen nach Dateityp und Workspace-Typ aggregierbar sein, ohne Pfad
oder Inhalt als Label zu verwenden.

## 15. Rollout

1. Interne Capability hinter einem serverseitigen Feature Flag.
2. Markdown und `.txt` fuer interne Test-Workspaces.
3. Shadow-Capture ohne sichtbare Restore-Aktion, um Speicher und Deduplizierung
   zu messen.
4. Center read-only aktivieren.
5. Review-Aktionen und Restore aktivieren.
6. Editor-, Dateibrowser- und Chat-Einstiege aktivieren.
7. Nach Stabilisierung Benachrichtigungen ergaenzen.
8. Weitere Text- und Codeformate adapterweise freischalten.

Ein Rollback deaktiviert neue Einstiege und Mutationen, behaelt aber gespeicherte
Versionen. Alte Agenten-Review-Aktionen bleiben waehrend der Migration
funktionsfaehig.

## 16. Teststrategie

### 16.1 Unit- und Contract-Tests

- Timeline-Reihenfolge und Statusfarben als semantische Zustandswerte,
- Capability-Matrix je Dateityp und Berechtigung,
- Policy-Praezedenz und fail-closed Verhalten,
- Blob-Deduplizierung, Kompression, Limits und Retention,
- Change-Group-Validierung und Batchreihenfolge,
- Diff-Hunk-Paginierung und Groessenlimits,
- Restore-Fence und Idempotenz.

### 16.2 PostgreSQL-Integration

- paralleles Capture desselben Inhalts,
- Yjs-Persistenz vor verzogerter Dateiprojektion,
- Rename, Move, Trash, Restore und Neuanlage am selben Pfad,
- paralleler Nutzeredit waehrend Restore,
- Accept/Reject und direkter Agentenedit mit Change Group,
- Widerruf und Lifecycle-Wechsel,
- keine Verbindungspool-Blockade.

### 16.3 UI- und Browser-Abnahme

Nach ausdruecklicher Nutzerfreigabe mit Playwright oder Chrome:

- alle Einstiegspunkte oeffnen denselben Center und dieselbe Auswahl,
- Desktop, schmale Ansicht und Mobile,
- Light, Dark und Reduced Motion,
- Tastatur, Fokus, Escape und Screenreader-Namen,
- Review an/aus sowie erzwungene Sicherheitsrueckfaelle,
- veralteter Vorschlag und Restore-Konflikt,
- Chat-Reload, Umbenennen und Deep-Link,
- Notification-Einstieg in der spaeteren Phase.

### 16.4 Repository-Gates

- Vor jeder Symbolaenderung GitNexus-Upstream-Impact ausfuehren.
- HIGH oder CRITICAL vor der Aenderung melden und den Zuschnitt pruefen.
- Vor jedem Commit `detect_changes({scope: "compare", base_ref: "main"})`.
- Pro abgeschlossenem To-do ein fokussierter Commit.
- Das naechste To-do beginnt erst nach bestandenem Exit-Gate des vorherigen.
- Fuer jedes Umsetzungspaket mindestens fokussierte Tests, `git diff --check`,
  ESLint fuer geaenderte Dateien und `npm run build`.
- Keine Container ohne ausdrueckliche Anforderung.
- Fuer ein lokales produktionsnahes Team-Seat-Setup den Skill
  `canvas-local-team-seat-dev` verwenden und niemals parallele Test-Container
  starten.

## 17. Definition of Done

Das Kernfeature ist fertig, wenn:

- Editor, Dateibrowser und Chat denselben globalen Dialog oeffnen,
- der Center auch ohne bereits geoeffnete Editor-Datei funktioniert,
- ausstehende Vorschlaege ueber dem aktuellen Stand und der Historie stehen,
- die aktuelle Version leicht farblich markiert ist,
- jeder sichtbare Vergleich den aktuellen autoritativen Stand verwendet,
- Markdown-Vorschau, Quelltext und begrenzter Diff verfuegbar sind,
- Accept, Reject und Restore die bestehenden Sicherheits- und
  Berechtigungsregeln einhalten,
- Restore immer eine neue Version erzeugt,
- der Review-Toggle nur zukuenftige eigene Agentenoperationen beeinflusst,
- direkte Bearbeitung Konflikt- und Sicherheitspruefungen nie umgeht,
- Versionen Rename, Move und App-Neustart ueberstehen,
- Chat-Widgets nach Reload den aktuellen Status zeigen,
- alle vereinbarten Tests und der Produktionsbuild bestehen.

Die Benachrichtigungszentrale besitzt ein eigenes, bereits abgeschlossenes
Exit-Gate. Weitere Dateiformate und der Proposal-Graph besitzen eigene Gates und
blockieren den Abschluss des Markdown-Kernfeatures nicht.

## 18. Proposal-Graph fuer mehrere offene Agentenvorschlaege

Der bestehende Einzelreview verhindert durch aktuelle Target-Pruefung,
Proposal-Fence und serialisiertes Apply ein blindes Anwenden veralteter
Operationen. Mehrere offene Vorschlaege benoetigen darueber hinaus eine
explizite fachliche Beziehung. Nicht ueberlappende Textbereiche beweisen keine
semantische Unabhaengigkeit.

Der autoritative Versionsverlauf bleibt deshalb linear, waehrend offene
Vorschlaege einen temporaeren, azyklischen Graphen bilden. Verbindliche
Beziehungen sind:

- `independent`: eigenstaendig gegen eine autoritative Basisversion,
- `extends`: Kind setzt den kumulativen Elternkandidaten voraus,
- `replaces`: neue Fassung macht den alten Vorschlag nicht mehr annehmbar,
- `alternative`: bewusst konkurrierende Auswahl fuer dasselbe Ziel.

Jede Annahme bestimmt zuerst die erforderliche Dependency-Closure, komponiert
den effektiven Kandidaten, revalidiert ihn gegen den aktuellen Stand und erzeugt
bei Erfolg genau eine neue autoritative Version. Alle noch offenen Vorschlaege
verlieren ihren alten Action-Fence und werden neu bewertet. Ablehnung,
Ersetzung, Detach, Batch-Annahme, Teilgruppen, Races, Retention, UI und
Notification-Gruppierung sind vollstaendig in
[`proposal-graph.md`](./proposal-graph.md) festgelegt.

Die Umsetzung erfolgt als neues Paket `FVRC-P10` vor dem weiterhin
zurueckgestellten Text-/Codeadapter-Paket `FVRC-P09`. Die vorhandenen IDs von
`FVRC-P09` bleiben fuer bestehende Referenzen stabil; die Ausfuehrungsreihenfolge
wird durch das explizite `order`-Feld in `todo.json` bestimmt.
