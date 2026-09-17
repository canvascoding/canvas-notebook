# Proposal-Graph: Szenario-Review und Testplan

Stand: 2026-09-17

Status: Spezifikation geprueft und erweitert; Tests fuer P10 geplant, nicht
implementiert oder ausgefuehrt. Dieses Dokument ist keine UI-Abnahme.

Verbindliches Modell: [`proposal-graph.md`](./proposal-graph.md).
Umsetzung: [`todo.json`](./todo.json), `FVRC-1000` bis `FVRC-1008`.

## 1. Ergebnis des zweiten Reviews

Die Grundidee funktioniert, benoetigte aber folgende Korrekturen vor der
Implementierung:

| Luecke im ersten Plan | Verbindliche Ergaenzung | Tasks |
|---|---|---|
| Ein exklusives Beziehungs-Enum kann eine Alternative zu einem abhaengigen Kind nicht ausdruecken. | Voraussetzung, Ersatz und Alternativgruppe getrennt modellieren. Nur Voraussetzungen gehoeren in die Apply-Closure. | 1000, 1001, 1002 |
| `superseded` war sowohl bei Erstellung als auch erst bei Annahme des Ersatzes vorgesehen. | Erfolgreiche explizite Erstellung des Ersatzes schliesst das Original atomar. Alte Kinder bleiben an ihrer alten Basis und werden blockiert. | 1000, 1004 |
| Ein frueher angenommener Parent konnte faelschlich als dauerhaft erfuellte Voraussetzung gelten. | Historischen Apply-Beleg und heute vorhandene Wirkung getrennt pruefen, auch nach Revert und Restore. | 1002, 1004 |
| Ein sauberer Rebase waehrend Accept koennte ungezeigte Aenderungen anwenden. | Alte Freigabe ablehnen, neue Vorschau zeigen, neuen Klick verlangen. | 1004, 1005, 1006 |
| Ein Kind kann Elemente referenzieren, die nur im Parent-Kandidaten existieren. | Rekonstruierbare Yjs-Identitaeten oder deterministische Ankerabbildung persistieren und pinnen. | 1001, 1002, 1003 |
| Atomare DB-Finalisierung wurde mit atomarem Live-Apply gleichgesetzt. | Gemeinsame Operation, durable Receipt, Recovery und genau eine logische Revision. | 1001, 1004, 1008 |
| Ein alter Chat-Link sollte automatisch zum neuesten Blatt springen. | Exakte Referenz beibehalten, Nachfolger separat verlinken; mehrere Blaetter explizit auswaehlen. | 1005, 1006, 1007 |
| No-ops, Legacy-Teilanwendung und dokumentuebergreifende Batches waren unscharf. | Keine leeren Versionen, keine neue Hunk-Teilannahme in P10, atomare Annahme nur pro Dokument. | 1000, 1004, 1008 |
| Neue Beziehungen sollten schon mit alten Einzel-Accept-Routen aktiv sein. | Graphschutz in allen alten Mutationsrouten vor Aktivierung neuer Beziehungen. | 1003, 1004, 1008 |

Die Korrekturen sind in den Hauptplan eingearbeitet; diese Tabelle beschreibt
die gefundenen Planluecken, keine bereits behobenen Laufzeitfehler.

## 2. Gemeinsame Testdaten und Orakel

Als Fixture dient ein Markdown-Dokument `V0` mit stabilen Block-IDs:

```md
# Versand

Kosten: 10 EUR

Lieferzeit: 5 Tage
```

Vorschlaege:

- `P1` auf V0: Kosten auf 12 EUR und neuer Versicherungsblock mit 100 EUR Deckung.
- `P2` erweitert P1: Deckung im neu angelegten Block auf 150 EUR.
- `Q` unabhaengig auf V0: Lieferzeit auf 3 Tage.
- `X` unabhaengig auf V0: Kosten auf 15 EUR, kollidiert mit P1.
- `A` Alternative zu P1: Kosten 11 EUR, Versicherungsblock mit 80 EUR Deckung.
- `R` ersetzt P1: Kosten 13 EUR, Deckung 120 EUR.
- `P3` erweitert P1: Deckung auf 200 EUR; in einschlaegigen Tests Alternative zu P2.

Jeder Test bekommt einen isolierten Ausgangsstand. Eine Aenderung des Fixtures
oder der Beziehungsart ist im Test explizit; `X` wird nicht aus einer
Textueberlappung automatisch zur fachlichen Alternative.

Erwartungen werden aus fest angegebenen Zieltexten, Blockstrukturen,
Proposal-Aufloesungen und Revisionszahlen abgeleitet. Nicht bloss das Ergebnis
eines Helpers mit demselben Helper erneut berechnen. Fuer jede Mutation pruefen:
Dokumentinhalt, fremde erhaltene Aenderungen, betroffene Status, Revisionen,
Receipts und Rechte. Fuer abgewiesene Aktionen sind diese Werte unveraendert;
neue Auswertungsmetadaten duerfen entstehen.

## 3. Fachliche Szenarien

`U` = reine Unit-/Contracttests, `I` = Integration mit PostgreSQL und Yjs.
Die ID ist der stabile Verweis fuer Todo und spaetere Testnamen.

| ID | Ausgangslage und Aktion | Erwartung | Ebene |
|---|---|---|---|
| PG-S01 | P1 und Q auf V0; beide Annahmereihenfolgen. | Nach jeweils frischer Vorschau gleicher Endtext: Kosten 12, Deckung 100, Lieferzeit 3. Zwei neue Versionen, kein Verlust fremder Aenderungen. | U, I |
| PG-S02 | P1 und X auf V0; P1 annehmen, dann X versuchen. | Kosten bleiben 12; X wird Konflikt. Kein zweiter Write mit altem Fence. Identische Inserts am gleichen Anker und Loeschen gegen Formatierung separat parametrisieren. | U, I |
| PG-S03 | P2 vor P1 annehmen; danach P1 einzeln versuchen. | Kosten 12 und Deckung 150 in einer neuen Version; P2 applied, P1 included. Zweiter Versuch zeigt die bereits erfolgte Aufnahme und schreibt nichts. | U, I |
| PG-S04 | Erst P1, dazwischen Q, dann P2. | P2-Vorschau aendert nur Deckung 100 auf 150, Lieferzeit 3 bleibt. Drei neue Versionen. | U, I |
| PG-S05 | P1 ablehnen, dann P2 annehmen oder detach anfordern. | P2 ist blockiert, Q unbeeinflusst. Detach erstellt nur bei erfolgreicher Transformation einen neuen reviewpflichtigen Kandidaten; kein Anwenden von P1. | U, I |
| PG-S06 | P2 und P3 als normale Geschwister, dann als Alternativen testen. | Ohne Auswahlgruppe bleibt der andere nach einer Annahme offen und kollidiert bei Deckung; mit Gruppe wird er alternative_not_selected und seine Kinder blockiert. | U, I |
| PG-S07 | P1 und P2 gemeinsam markieren; zwei kompatible Kinder von P1 oder drei Ebenen einer Kette markieren. | Parent wird einmal komponiert; genau eine Batch-Revision. Inkompatible Geschwister verhindern den gesamten Apply; Pruef-Closure behaelt auch schon angewendete Vorfahren. | U, I |
| PG-S08 | P2 vorausgesetzt P1, P2 konkurriert mit P3; eine neue Fassung ersetzt P2. | Ersatz und Alternative behalten P1 als Voraussetzung. P2 wird nicht versehentlich Voraussetzung seines Ersatzes. | U, I |
| PG-S09 | R ersetzt P1 mit offenem P2; danach R ablehnen. | P1 bleibt superseded, P2 blockiert, keine automatische Rueckkehr zu P1. Neuer Kindkandidat auf R erfordert eigene Herkunft und Review. | U, I |
| PG-S10 | P1/A sind Alternativen; P2 inklusive P1 annehmen. | Wahl faellt auf P1; A und dessen offene Nachfahren werden entsprechend geschlossen/blockiert. Batch aus P2 und A scheitert schon an der Closure. | U, I |
| PG-S11 | P1 angewendet, dann dessen Versicherungsblock manuell entfernen, P1 revertieren oder V0 restaurieren. | P2 bekommt prerequisite_lost. Receipt von P1 bleibt historisch korrekt, beweist aber keine aktuelle Voraussetzung. P1 wird nicht automatisch erneut eingefuegt. | U, I |
| PG-S12 | Wirkung eines unabhaengigen Vorschlags ist bereits vollstaendig vorhanden; Kette hebt sich netto auf. | Im ersten Fall optional satisfied_elsewhere ohne neue Inhaltsversion; im zweiten keine Annahme mit falschem included. Teilweise oder nur textlich gleiche Wirkung nicht als vollstaendig ausgeben. | U, I |
| PG-S13 | P1 erstellt neue Blocks/Listen, P2 adressiert sie; danach Reload und Garbage Collection. | Kind referenziert exakt dieselben logischen Ziele; keine verwaisten Anker, doppelten Blocks oder verlorenen Marks. Unrekonstruierbare Herkunft blockiert. | U, I |
| PG-S14 | Kind aendert anderen Absatz, braucht aber inhaltlich eine neue Definition aus P1. | Explizite Dependency bleibt trotz nicht ueberlappendem Diff wirksam. Detach wird nicht durch blossen Textdiff als sicher erklaert. | U, I |

## 4. Nebenlaeufigkeit, Persistenz und Transport

| ID | Ausgangslage und Aktion | Erwartung | Ebene |
|---|---|---|---|
| PG-S15 | Diff gegen V0 anzeigen, dann Nutzer-/Direktedit; alten Accept senden. | Kein ungezeigter Rebase-Apply. Neue Auswertung und neuer Klick notwendig, auch wenn der Edit nicht kollidiert. | I |
| PG-S16 | Zwei Prozesse/Nutzer nehmen gleiche oder verschiedene Vorschlaege gleichzeitig an. | Ein gueltiger dokumentweiter Commit zur Zeit; zweiter identischer Retry liefert Receipt, anderer stale Request braucht neue Vorschau. Auch gegen Restore testen. | I |
| PG-S17 | Accept gegen Reject, Replace gegen Accept und Kind-Erstellung gegen Branch-Reject verschraenken. | Genau ein gueltiger Uebergang; keine Annahme eines abgelehnten Parents, kein stilles Ablehnen erst spaeter entstandener Kinder. CAS auf Graph und Knoten pruefen. | I |
| PG-S18 | Doppelklick, verlorene Antwort, Reload, Retry mit demselben bzw. veraendertem Payload. | Identischer Versuch wird nicht doppelt angewendet. Gleicher Key mit anderem Scope/Body scheitert. Client-Cache ist nicht die einzige Idempotenzgarantie. | I |
| PG-S19 | Fehler injizieren vor Apply, nach Live-Apply, nach Yjs-Persistenz und vor/nach History-Finalisierung. | Vor Apply kein Inhaltswrite; danach eindeutiger Recovery-Status. Nach Restart genau ein vollstaendiges Ergebnis und keine doppelte Revision. Keine blinde Wiederholung. | I |
| PG-S20 | Reine Text-/Blockloeschung bei unveraendertem State-Vector; bis zum leeren Dokument loeschen; pending Yjs Delete-Sets. | Content-/Strukturnachweis erkennt Aenderung; leerer Inhalt ist kein fehlender Inhalt. Persistenz wird erst fuer vollstaendige integrierte Wirkung bestaetigt. | U, I |
| PG-S21 | Letztes Batch-Mitglied fehlerhaft; Fehler nach Clone-Preflight aber vor Live-Mutation. | Kein erster Teil wird angewendet. Erneute Live-Pruefung stoppt stale Ergebnisse. Tests betrachten auch Proposal- und Gruppenstatus. | I |
| PG-S22 | Direkter Review-Toggle-Wechsel, abgelaufener Grant und ausstehender Parent beim naechsten Agentenedit. | Bereits offene Vorschlaege bleiben offen. Safe-Direct akzeptiert keine unfreigegebene Dependency. Neue eigenstaendige Direktedits invalidieren bestehende Previews. | I |
| PG-S23 | In einer Change Group sind zwei Dokumente, eines mit Konflikt. | Pro Dokument klarer Outcome; kein dokumentuebergreifendes Atomaritaetsversprechen. Graph-Batch weist gemischte Lineages vor erster Mutation ab. | U, I |
| PG-S24 | Persistenz langsam, Checkpoint wiederholt, Notification-Speicherung faellt aus. | UI zeigt pending statt Erfolg; nach Durability ein Apply-Receipt und eine logische Version. Notification-Retry fuehrt keinen Apply aus. | I |

## 5. Rechte, Herkunft und Lebenszyklus

| ID | Ausgangslage und Aktion | Erwartung | Ebene |
|---|---|---|---|
| PG-S25 | Nutzer darf Kind verwalten, aber nicht Parent, Ersatz-Ziel oder zu schliessende Alternative. | Gesamte Mutation gesperrt; kein Rechtegewinn ueber Closure. Fehlendes Leserecht verraet keine versteckten Titel/Inhalte/Beziehungen. | U, I |
| PG-S26 | Zwischen Vorschau und Apply Schreib-/Leserechte entziehen oder Workspace wechseln. | Server verweigert; Client entfernt nicht mehr lesbare Vorschau. Paginierte/verspaetete Antworten reaktivieren keinen Button. | I |
| PG-S27 | Dokument innerhalb Workspace umbenennen/verschieben; dann an alten Pfad neue Datei legen. | Graph folgt alter Lineage, nicht dem wiederverwendeten Pfad. Kopie oder anderer Workspace erbt keinen Graphen. | I |
| PG-S28 | History-Restore in gleicher Generation; Trash-Restore/neue Generation; Schemawechsel. | History-Restore revalidiert; neue Generation und inkompatibles Schema sperren alte Kandidaten. Reload aendert dieses Ergebnis nicht. | I |
| PG-S29 | Parent-/Basisblob fehlt, TTL abgelaufen oder Retention laeuft waehrend Apply. | Offene benoetigte Belege bleiben gepinnt. Sonst explicit expired/unavailable, kein Current-Fallback. Request pinnt benoetigte Belege bis Abschluss. | I |
| PG-S30 | Zyklus, Cross-Workspace-/Lineage-Kante, widerspruechliche Gruppe, Tiefe/Bytes/Knoten ueber Limit. | Fruehe Ablehnung ohne Teilknoten; Limits auch fuer expandierte Closure und dekomprimierte Kandidaten. Grenzwert und Grenzwert plus eins testen. | U, I |
| PG-S31 | Weiterbearbeitung mit fehlender, falscher oder fremder Proposal-/Snapshot-Referenz; Parent wird beim Generieren ersetzt. | Stabiler Herkunftsfehler, keine Umdeutung in independent. Normale Reads bleiben autoritativ; Proposal-Read ist ausdruecklich. | U, I |
| PG-S32 | Alte UI ruft Einzel-Accept/Reject/Revert/Direct-Grant auf graphgebundener Operation; Flag wird zurueckgerollt. | Keine Umgehung von Closure/Choice/Supersede. Upgrade oder gesperrter Graphstatus; sichere eigenstaendige Legacy-Operationen bleiben nutzbar. | I |
| PG-S33 | Legacy-Operation teilweise angewendet oder ihre Basis nicht mehr belegbar. | Migration erfindet keine unabhaengige Root mit vollem unapplied Inhalt. Angewendeter Umfang und sicherer Rest werden getrennt nachgewiesen. | U, I |
| PG-S34 | Markdown mit Frontmatter, Listenverschiebung, Tabellen, Links, Unicode, CRLF und gleichen Absatztexten. | Bestehende Adapter erhalten Semantik/Format oder melden Konflikt; keine falsche Ankerwahl. Preview-Sanitizing und keine externen Requests bleiben erhalten. | U, I |

## 6. UI-Szenarien und Komponenten

Die UI muss angepasst werden. Ein Server-Graph allein reicht nicht: Der Nutzer
muss die Wirkung seiner Auswahl und die Ursache gesperrter Aktionen sehen.
Das bestehende Canvas-Designsystem bleibt verbindlich.

| Bereich | Geplante Anpassung |
|---|---|
| `FileVersionTimeline` | Dependency-Gruppen, Alternativwahl, ein-/ausklappbare Zweige, terminaler Verlauf, stabile Auswahl und Zaehler mit ausdruecklicher Bedeutung |
| `FileVersionComparison` | Aktuell-gegen-Ergebnis-Diff, enthaltene Vorschlaege, genaue Konflikt-/Verfuegbarkeitsgruende, neu ausgewerteter statt ungezeigt angenommener Kandidat |
| `FileVersionActions` und `action-client` | Ganze Wirkungsmenge und getrennte Rechte, Batch/Detach, aktuelle Ergebnisbindung, pending/recovery/no-op; kein Erfolg aus blossem HTTP 200 |
| `FileVersionCenterHost` und Store | Identitaet aus Workspace, Lineage, Lifecycle, Auswahl und Auswertungsrevision; Abort/Antwort-Fencing, Fokus-/Scroll-Erhalt und Reconnect |
| Editor und Dateimenue | Gemeinsame Capability und Review-Zustand, auch ohne Collaboration-Room; Standard-Review bleibt an |
| Chat, Bell, Home und Deep-Links | Exakte historische Referenz plus sichtbarer Nachfolger; Zweigauswahl bei mehreren Blaettern und deduplizierte Updates |

`C` = Komponenten-/DOM-Interaktionstest, `B` = echter Browser mit Layout und
Netzwerksteuerung. Layout-Eigenschaften werden nicht ausschliesslich durch
Pruefung von CSS-Klassennamen als bestanden gewertet.

| ID | Ablauf | Erwartung | Ebene |
|---|---|---|---|
| PG-U01 | P2 aus Editor, Datei-Menue, Chat und Notification oeffnen. | Gleiche Auswahl, aktueller Diff inklusive P1, Button `P2 inklusive P1 annehmen`. Vorfahren zaehlen und Alternativ-Schliessung sichtbar. | C, B |
| PG-U02 | P1 annehmen, P2 ausgewaehlt lassen; danach fremder Edit waehrend offenem Dialog. | Erhaltene Auswahl/Fokus, aktualisierte Current-Karte und nur Restdiff; altes Accept sofort gesperrt, neuer Diff vor erneutem Klick. | C, B |
| PG-U03 | Kind/Parent-/Batch-Auswahl variieren, zwei Alternativen markieren, Zweig mit neuen Kindern ablehnen. | Benoetigte Vorfahren markiert; ungueltige Kombination erklaert. Branch-Reject bindet die angezeigte Wirkungsmenge und verlangt bei Aenderung erneute Auswahl. | C, B |
| PG-U04 | Compare fuer P1 langsam, zu P2 wechseln; anschliessend Datei-/Workspace-Wechsel. | Alte Antworten und Diff-Folgeseiten ueberschreiben weder neue Auswahl noch Aktionen. Jede Diff-Seite gehoert zur selben Auswertung. | C, B |
| PG-U05 | Alte Links auf included, rejected oder superseded oeffnen, Gruppenlink mit zwei Blaettern. | Historischer Status und expliziter Nachfolger-Link; kein stiller Sprung und keine vorgewaehlte fremde Annahme. Fehlender Inhalt erklaert. | C, B |
| PG-U06 | Nach Accept Netzwerk verlieren, Dialog schliessen, wieder oeffnen; Server meldet pending. | `Speicherung wird bestaetigt`/Recovery sichtbar, Statusabfrage statt zweitem Apply; Erfolg erst nach dauerhaftem Ergebnis. | C, B |
| PG-U07 | Ungespeicherten Editorinhalt/offline Queue haben, Review oeffnen; Reconnect und spaeten Offline-Edit simulieren. | Lokale Aenderungen bleiben erhalten, Sync-Hinweis sperrt Accept bis Abgleich. Spaeterer Edit invalidiert Auswertung und prueft Voraussetzungen neu. | C, B |
| PG-U08 | Historie vorhanden, kein Restore-Recht; separates Review-Recht; danach Leserecht verlieren. | Lesen/Vergleichen bleibt bei erlaubtem Zugriff moeglich, Aktionsrechte getrennt; kein pauschales Nur-ansehen aus restore=false. Cache nach Leserechtsverlust entfernt. | C, B |
| PG-U09 | 320/390/768/1280 px, lange Namen, tiefe Zweige, Zoom 200 %, Timeline scrollen. | Keine abgeschnittenen Karten/Actions oder horizontales Ueberlaufen. Aktuell-Historie-Trenner bewegt sich mit demselben Inhaltsabschnitt; Sticky-Footer ueberdeckt keine letzte Zeile. | B |
| PG-U10 | Tastatur, Screenreader, Light/Dark, Reduced Motion, Touch. | Beziehung und Sperrgrund ohne Farbe erkennbar, korrekte expand/selected-Attribute, sichtbarer Fokus und Rueckkehr zum Einstieg. Live-Updates stehlen keinen Fokus. | C, B |
| PG-U11 | Fehlende/false/true Feature-Konfiguration; Personal und Team; Dokument noch nie im Editor geoeffnet. | Fehlender Flag-Wert behaelt dokumentierten Default, false sperrt mit Grund. Gleiche unterstuetzte Dateien koennen bei gleichen Rechten Verlauf/Vergleich oeffnen; kein pauschaler Workspace-Ausschluss. | I, C, B |
| PG-U12 | Viele Reviews/paginierte Zweige, Root ausserhalb aktueller Seite; Replace und Reload im Chat/Bell/Home. | Auswahl gezielt aufloesbar, keine unsichtbaren mit angewendeten Knoten; getrennte Gesamt-/sichtbare Zaehler, begrenzte Payloads. Gruppierte Notification wird erst nach erfolgreichem autorisiertem Oeffnen gelesen. | C, B |

## 7. Testumsetzung und Gates

### 7.1 Kleine deterministische Tests zuerst

`FVRC-1000` fixiert Tabellen fuer Status und Aktionen sowie die konkreten
Fixture-Ausgaben. `FVRC-1002` testet Closure, Deduplizierung, Wahlkonflikte,
Ergebnisbildung und Grenzen ohne DB. Property-Tests erzeugen kleine acyclische
Graphen und pruefen Closure-Eindeutigkeit, No-write-bei-Konflikt und
Reihenfolgeunabhaengigkeit nur fuer explizit kompatible, disjunkte Operationen.
Snapshot-/Anker-Tests verwenden echte Yjs-Dokumente, keine String-Mocks.

Geplante neue Suites: `scripts/proposal-graph-contract-test.ts`,
`scripts/proposal-graph-model-test.ts` und
`scripts/proposal-graph-integration-test.ts`. Diese Dateien existieren noch
nicht; die Implementierung darf ihre Namen an die Repo-Konvention anpassen.

### 7.2 Integration mit kontrollierbaren Haltepunkten

`FVRC-1001`, `1003` und `1004` fuehren reale PostgreSQL-/Yjs-Tests durch.
Zwei getrennte Verbindungen beziehungsweise Prozesse muessen die
Serialisierung pruefen; ein Test mit nur zwei Promises im selben Prozess
beweist keine Instanzgrenze. Races verwenden Barrieren an Claim, Revalidierung,
Live-Apply, Durability und Finalisierung statt zufaellige Sleep-Aufrufe.

Fuer PG-S19 wird an jeder Grenze gezielt unterbrochen und anschliessend neu
gestartet. Pruefung umfasst gespeicherten Inhalt, Revision-/Receipt-Eindeutigkeit,
Knotenstatus und Wiederaufnahme weiterer Aktionen. Die bestehende Suite
`scripts/collaboration-agent-durability-test.ts` liefert relevante Regressionen
fuer reine Loeschungen und den Unterschied zwischen frueher gespeichertem und
heute noch vorhandenem Inhalt.

### 7.3 UI und Browser

`FVRC-1005` bis `1007` erweitern die bestehenden
`scripts/file-version-center-{timeline,comparison,actions}-test.tsx` sowie
Editor-/Dateimenue-/Widget-/Notificationtests um die oben zugeordneten Faelle.
Browserabnahme prueft echte Scrollkoordinaten, Viewport-Clipping und Touch-
Erreichbarkeit zusaetzlich zu Screenshots. Fuer PG-U09 muss nach Scrollen die
Position des Historientrenners um denselben Betrag wie sein Inhaltsabschnitt
wandern, waehrend die aeussere Panelkante unveraendert bleibt.

Browser-/Containertests erfolgen gemaess bereits erteilter Freigabe und
Repository-Regeln. Der genehmigte lokale Stack wird mit
`canvas-local-team-seat-dev` betrieben, mit aktuellem Build und genau einer
Testumgebung. Dieses Dokument startet keine Umgebung.

### 7.4 Abnahmeregel

Alle PG-S- und PG-U-Faelle sind P10-Gates; eine Auslassung muss mit begruendetem
Produktentscheid dokumentiert werden. `todo.json` ordnet sie den Tasks zu.
Kein Task wird aufgrund des hier beschriebenen Plans als getestet markiert.
Release-Evidence benennt Commit, Szenario, erwartetes und beobachtetes Ergebnis.

Vor Implementierung relevante bestehende Schutzmechaniken erneut nachvollziehen:

- [`agent-operations.ts`](../../../../app/lib/collaboration/agent-operations.ts):
  `acceptAgentOperation`, `applyStoredOperation`, Durability und Recovery.
- [`FileVersionActions.tsx`](../../../../app/components/file-version-center/FileVersionActions.tsx):
  heutige Einzelaktionen und Busy-/Retry-Zustaende.
- [`FileVersionTimeline.tsx`](../../../../app/components/file-version-center/FileVersionTimeline.tsx):
  heutige flache Reviewliste, scrollender Historientrenner und Rechtehinweise.

Diese Stellen wurden fuer den Plan gelesen, aber nicht veraendert. Beim
spaeteren Implementieren bleiben Upstream-Impact, fokussierte Regressionen und
Produktionsbuild verpflichtend.
