# File Version & Review Center

Stand: 2026-09-17

Status: Markdown-Kernfeature umgesetzt; Proposal-Graph und weitere Adapter geplant

Repository: `canvasstudios-notebook`

Die maschinenlesbare, strikt sequenzielle Umsetzungsliste liegt in
[`todo.json`](./todo.json).

Die Erweiterung fuer parallele, abhaengige, ersetzende und alternative
Agentenvorschlaege ist in
[`proposal-graph.md`](./proposal-graph.md) spezifiziert.
Die nachgeprueften Randfaelle und 46 zugeordnete Tests stehen in
[`proposal-graph-scenarios.md`](./proposal-graph-scenarios.md).

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

Fehlt fuer diese Kombination eine gespeicherte Praeferenz, wird
`safe_direct` verwendet: Ein neues Dokument startet mit ausgeschaltetem
Review-Toggle. Das erste bewusste Einschalten speichert `review_required`.
Unbekannte oder fehlerhaft geladene Zustaende zaehlen nicht als fehlende
Praeferenz und bleiben fail-closed.

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
- neue oder bisher nicht konfigurierte Lineage: aus (`safe_direct`),
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
- neue Dokumente ohne gespeicherte Praeferenz mit ausgeschaltetem
  Review-Toggle starten,
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

Voraussetzung, Ersetzung und Alternativgruppe sind getrennte Beziehungen: Ein
Kind kann von P1 abhaengen und gleichzeitig Alternative zu einem anderen Kind
sein. Bereits angenommene Voraussetzungen werden auf ihre heute noch
vorhandene Wirkung geprueft, insbesondere nach Revert, Restore und Nutzeredits.

Jede Annahme bestimmt zuerst die erforderliche Dependency-Closure, komponiert
den effektiven Kandidaten, revalidiert ihn gegen den aktuellen Stand und erzeugt
bei dauerhaftem, inhaltsaenderndem Erfolg genau eine neue autoritative Version.
No-ops und Retries erzeugen keine leeren oder doppelten Versionen. Eine seit
der Anzeige geaenderte Vorschau erfordert vor Apply einen neuen Review-Klick.
Alle noch offenen Vorschlaege
verlieren ihren alten Action-Fence und werden neu bewertet. Ablehnung,
Ersetzung, Detach, dokumentweise Batch-Annahme, Legacy-Teiloperationen, Races,
Recovery, Retention, UI und Notification-Gruppierung sind in
[`proposal-graph.md`](./proposal-graph.md) festgelegt.

Die UI-Arbeiten sind Teil von P10: Beziehungen und betroffene Vorschlaege
anzeigen, Konflikte und verlorene Voraussetzungen erklaeren, Auswahl/Fokus bei
Refresh erhalten und dauerhafte Speicherung gesondert darstellen. Alte Links
behalten ihre exakte Proposal-Referenz. Der mitscrollende Historientrenner,
mobile Kartenbreiten und gleiche Verfuegbarkeit bei gleichen Capabilities in
Personal-/Team-Workspaces besitzen konkrete Browserfaelle im
[`Szenario- und Testplan`](./proposal-graph-scenarios.md).

Die Umsetzung erfolgt als neues Paket `FVRC-P10` vor dem weiterhin
zurueckgestellten Text-/Codeadapter-Paket `FVRC-P09`. Die vorhandenen IDs von
`FVRC-P09` bleiben fuer bestehende Referenzen stabil; die Ausfuehrungsreihenfolge
wird durch das explizite `order`-Feld in `todo.json` bestimmt.

## 19. Remediation: Default, Lifecycle und Browser-Abnahme

Die produktionsnahe Browser-Abnahme vom 17. September 2026 hat vier getrennte
Fehlerklassen sichtbar gemacht. Sie werden als vorgeschaltetes Paket
`FVRC-P11` abgeschlossen, bevor die noch offenen Laufzeit- und UI-Arbeiten des
Proposal-Graphen weitergehen.

### 19.1 Produktdefault fuer neue Dokumente

Fuer eine noch nicht gespeicherte Review-Praferenz gilt kuenftig
`safe_direct`. Damit ist der Toggle bei einem neu angelegten Dokument
standardmaessig aus. Der Nutzer aktiviert `review_required` bewusst ueber den
Agenten-Toggle. Die Einstellung bleibt weiterhin
nutzer-, workspace- und lineage-bezogen und beeinflusst nur zukuenftige eigene
Agentenoperationen.

Die Aenderung ist keine globale Datenmigration:

- bereits explizit gespeicherte Werte bleiben unveraendert,
- ein erzwungener Workspace-Modus bleibt `review_required`,
- ein Lade-, Berechtigungs-, Capability- oder Integritaetsfehler bleibt
  fail-closed `review_required`,
- eine Operation mit explizitem Force-Review bleibt reviewpflichtig,
- der Toggle zeigt erst nach erfolgreicher Policy-Aufloesung den gespeicherten
  oder den neuen Defaultzustand.

Damit bedeutet "aus" ausschliesslich einen erfolgreich aufgeloesten
`safe_direct`-Zustand und niemals einen unbekannten oder fehlerhaften Zustand.

### 19.2 Session-Loeschung und dauerhafte Review-Belege

Das Loeschen einer Chat-/Agentensession darf nicht an der referenziellen
Integritaet von `file_change_groups` scheitern. Vor der Implementierung wird
festgelegt, welche Review- und Auditbelege dauerhaft erhalten bleiben muessen.
Der gemeinsame Session-Loeschservice loest danach alle abhaengigen Datensaetze
in einer Transaktion in der fachlich richtigen Reihenfolge auf oder
anonymisiert die Session-Referenz. Ein partieller Erfolg ist unzulaessig.

Die verbindliche Retentionentscheidung lautet: Change Group und Entries bleiben
als dauerhafte Dokument-, Review- und Auditbelege erhalten. Nur die interne,
numerische `pi_session_db_id` wird vor der Session-Loeschung auf `NULL` gesetzt;
die stabile fachliche `source_session_id` im bereits erzeugten Beleg bleibt fuer
Idempotenz und bestehende Links erhalten. Der Foreign Key bleibt `RESTRICT`,
damit ein Loeschpfad ausserhalb des gemeinsamen Services nicht still Daten
abtrennt. Detach, Nachrichten-, Channel- und Session-Loeschung bilden eine
Datenbanktransaktion. Dateibasierte Tool-Outputs werden erst nach erfolgreichem
Commit entfernt.

Verifiziert werden mindestens: Session ohne Aenderung, Session mit offener
Review-Gruppe, Session mit abgeschlossener Gruppe, wiederholtes Loeschen,
fremder Workspace, Rollback nach provoziertem Fehler und echte PostgreSQL-
Constraints.

### 19.3 Testdaten und Authentifizierung

Browser-Fixtures duerfen aktive kollaborative Dokumente nicht ueber den
geschuetzten Whole-File-Write-Endpunkt ueberschreiben. Markdown-Testdateien
werden deshalb atomar mit ihrem Anfangsinhalt angelegt; spaetere Aenderungen
laufen ueber die produktiven Editor-/Yjs-Pfade.

Produktionsnahe Browserlaeufe verwenden ausserdem einmalig erzeugte,
rollenbezogene Playwright-Storage-States. Tests, die Anmeldung, Abmeldung oder
Berechtigungswechsel selbst pruefen, bleiben explizit unauthentifiziert. Die
produktive Rate-Limitierung wird weder deaktiviert noch fuer Tests aufgeweicht.

### 19.4 Globaler Center statt veralteter Kleinpanel-Annahmen

Alle Einstiege muessen denselben globalen Dialog oeffnen. Vorhandene
Playwright-Helfer duerfen deshalb nicht mehr auf ein entferntes oder verborgenes
kleines Agenten-Review-Panel warten. Ein eigener Center-Test prueft:

1. Agentenvorschlag anlegen und Zaehler sichtbar aktualisieren.
2. Center ueber Editor-Button oeffnen und exakten Vorschlag auswaehlen.
3. Aktuellen Stand gegen den Vorschlagskandidaten vergleichen.
4. Annehmen und Ablehnen einschliesslich stale-/konfliktbehafteter Antwort.
5. Center ueber Dateimenue und Chat-Widget mit derselben Auswahl oeffnen.
6. Personal- und Team-Workspace nach identischen Capabilities behandeln.
7. Mobile Scrollverhalten: Der Trenner zwischen "Aktuell" und
   "Versionshistorie" scrollt mit seiner Liste; Karten haben symmetrische
   Innenabstaende und keinen horizontalen Overflow.

Falls ein bestehender Test noch die alte Region anspricht, wird der Test auf
den globalen Dialog migriert. Falls der produktive Einstieg den Dialog dagegen
tatsaechlich nicht oeffnet, wird der gemeinsame Open-Contract behoben; ein
test-only Workaround ist nicht zulaessig.

### 19.5 Ausfuehrungs- und Exit-Reihenfolge

`FVRC-P11` wird streng in dieser Reihenfolge umgesetzt:

1. Defaultvertrag und Policy-Fixtures auf `safe_direct` umstellen.
2. Session-Loeschung gegen echte FK-Abhaengigkeiten haerten.
3. Atomare Markdown-Fixtures und wiederverwendbare Browser-Authentifizierung
   einfuehren.
4. Editor-, Datei- und Chat-Einstiege auf den globalen Center pruefen und den
   haengenden Interaktionspfad beheben.
5. Fokussierte Unit-/Contract-/PostgreSQL-Tests, Produktionsbuild und die
   freigegebene Playwright-Matrix im einzelnen verwalteten Team-Seat-Stack
   durchlaufen lassen.

Jeder Punkt erhaelt einen fokussierten Commit und beginnt erst nach bestandenem
Gate des vorherigen Punkts. Vor Symbolaenderungen wird der Upstream-Impact
geprueft; vor jedem Commit wird der Gesamtdiff gegen `main` analysiert. Der
Stack wird nicht parallel dupliziert. Ein Container-Rebuild erfolgt nur nach
erneuter ausdruecklicher Anforderung; ansonsten wird gegen den vorhandenen
gesunden Stack getestet.

### 19.6 Abnahmeergebnis vom 20. September 2026

Der globale Center besitzt jetzt fuer Editor-Toolbar, Datei-Kontextmenue und
Editor-Dateimenue denselben aufloesenden Clientpfad. Nur ein voruebergehend
nicht verfuegbarer Persistenzstand wird begrenzt erneut geladen. Veraltete
Deep-Link-Auswahlen und Current-Fences werden dagegen explizit neu aufgeloest;
ein Konflikt oder eine fremde Auswahl wird nicht still wiederholt.

Eine noch nie im kollaborativen Editor geoeffnete Datei darf bereits eine
aktive Dokumentprojektion, aber noch keinen Yjs-Zustand besitzen. In diesem
engen Fall ist der Workspace-Dateistand autoritativ und der Center bleibt auch
im Personal-Workspace verfuegbar. Sobald ein Yjs-Zustand existiert, bleiben ein
abweichender Workspace, Pfad, Lifecycle oder degradierter Zustand fail-closed.

Die Browserabnahme umfasst:

- Personal- und Team-Capabilities sowie den neuen `safe_direct`-Default,
- explizites Ein- und Ausschalten von Review im Editor,
- historische Markdown-Vergleiche ohne Modellrequest,
- Editor-, Dateibaum- und FileActions-Einstiege,
- 1600, 760 und 390 Pixel, Touch, Dark Mode und Reduced Motion,
- symmetrische 16-Pixel-Kartengutter, fehlenden Horizontal-Overflow und einen
  mit der Timeline scrollenden Historientrenner,
- vier reale Lifecycle-Szenarien fuer Move, Response-Loss/Retry, selektiven
  Revert mit Konflikt sowie einen geloeschten Zielblock,
- einen realen `ollama/kimi-k2.6:cloud`-Lauf: Review an, Vorschlag vergleichen
  und annehmen, Review aus, Folge-Edit direkt anwenden und eine parallele
  menschliche Aenderung erhalten.

Bekannter Restfehler der lokalen Testinfrastruktur: Der konfigurierte zweite
Team-Seat-Nutzer ist derzeit suspendiert. `testenv:fixtures` erkennt die
existierende Membership, versucht aber eine Neuanlage und endet mit
`MEMBERSHIP_OPERATION_CONFLICT`. Die anschliessende Reaktivierung ist blockiert,
weil ein idempotent wiederholter Membership-Snapshot in der Control Plane sein
altes Empfangsdatum behaelt und deshalb als zu alt gilt. Owner ist der
`canvas-local-team-seat-dev`-Fixture-Workflow. Die Produktabnahme verwendet bis
zur Reparatur zwei unabhaengige Browser-Sessions des aktiven Owners; Workspace-,
Policy-, Review- und Echtzeitgrenzen bleiben dabei produktiv aktiv.
