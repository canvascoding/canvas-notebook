# Konflikte im Review Center verständlich und vollständig lösen

Stand: 2026-09-25. Konkreter Umsetzungsplan, keine Implementierungsabnahme.
Der verbindliche Aufgabenstatus steht ausschließlich in [todo.json](./todo.json).
Dieser Plan konkretisiert FVRC-1006 bis FVRC-1008 und FVRC-1200 bis FVRC-1203
aus dem [Merge-Plan](./merge-reliability-plan.md); er ersetzt keine bestehenden
Graph-, Rechte-, Recovery- oder Testanforderungen.

## 1. Ziel und nachgewiesene Ausgangslage

Ausgang A enthält „Preis: 100 €“. Zwei offene Vorschläge basieren auf A:
B ändert denselben Bereich auf 120 €, C auf 130 €. Nach Annahme von C bleibt
B sichtbar, erhält automatisch „Konflikt – Entscheidung erforderlich“ und kann
über „Konflikt lösen“ bewusst mit dem aktuellen Dokument zusammengeführt werden.
Eine neue Version entsteht erst durch den dauerhaften Abschluss einer Inhaltsänderung.
B und C sind bis zur Annahme Vorschläge, keine durchnummerierten Dokumentversionen.

FVRC-1005 hat serverseitige Graphauswertung, Projektion und Compare ergänzt.
Das bestehende Center verwendet weiterhin den bisherigen `compareFileVersion`-Pfad;
dieser kann verschiedene Ursachen als `stale`/fehlenden Kandidaten darstellen.
FVRC-1006 und P12 sind offen. Die später auf Main integrierten Verbesserungen
am Laden und Erhalt sichtbarer Ansichten schließen diese fachliche Lücke nicht.
Die Umsetzung muss auf aktuellem Main aufsetzen und dessen Request-Abbruch,
Auswahlidentität und Schutz vor verspäteten Antworten erhalten.

Zwei getrennte Lieferstände:

- **Meilenstein A / P10:** aktuelle Auswertung im Center, verständliche Gründe,
  gemeinsame Vorschau und sichere Sammelannahme konfliktfreier Auswahlen.
  Damit ist manuelle Konfliktlösung noch nicht fertig.
- **Meilenstein B / P12:** wiederaufnehmbarer Konfliktentwurf, bewusste Entscheidungen
  und dauerhaftes Zusammenführen. Erst damit ist der hier beschriebene Nutzerablauf fertig.

## 2. Verbindlicher Nutzerablauf

1. Nutzer akzeptiert C. Nach bestätigtem Abschluss aktualisieren sich aktueller
   Stand, Historie und Auswertungen der offenen Vorschläge automatisch.
2. B bleibt ausgewählt beziehungsweise auffindbar. Die Karte zeigt den Konflikt;
   unabhängige Vorschläge bleiben annehmbar. Falls nachweisbar und autorisiert,
   nennt die Erklärung C als Ursache, sonst neutral „zwischenzeitliche Änderung“.
3. „Konflikt lösen“ öffnet eine Ansicht innerhalb desselben großen Popups.
   Keine zusätzlichen übereinanderliegenden Review-Dialoge.
4. Pro Konfliktbereich werden **Aktuell**, **Vorschlag B** und **Ergebnis** gezeigt.
   Die ursprüngliche Basis A ist über „Ausgangsversion anzeigen“ verfügbar.
   Der Vorschlag wird als historische Absicht gekennzeichnet; sein Inhalt ist
   nicht bereits das auf das heutige Dokument geprüfte Endergebnis.
5. Nutzer entscheidet pro Bereich: „Aktuellen Inhalt behalten“, „Änderung aus B
   übernehmen“ oder „Selbst zusammenführen“. Beim Übernehmen von B wird die
   Überschreibung der aktuellen Änderung im Ergebnis sichtbar. Kein pauschales
   „Beide übernehmen“ und keine vorab bestätigte Konfliktentscheidung.
6. Konfliktfreie Änderungen der ausdrücklich ausgewählten Vorschläge sind Teil
   des Ergebnisentwurfs. Der Nutzer entscheidet nur die Konflikte und prüft danach
   trotzdem den vollständigen Gesamtdiff. Abhängige Teiländerungen bilden eine
   gemeinsame Entscheidungseinheit, wenn sie nicht getrennt validierbar sind.
7. „Zusammenführung prüfen“ erzeugt den Vergleich **aktuelles Dokument → Ergebnis**.
   Darunter stehen die Folgen für die ausgewählten Originalvorschläge. Erst
   „Zusammenführung übernehmen“ schreibt; offene Konflikte sperren diesen Schritt.
8. Dauerhaft abgeschlossenes Ergebnis erscheint als neue aktuelle Version mit
   Herkunftsreferenzen. A, C und die ursprüngliche Absicht von B bleiben nachvollziehbar.

Desktop: Konfliktliste plus nebeneinanderliegende Quellen und ausreichend großer
Ergebnisbereich. Mobil: dieselben Inhalte über Tabs, sichtbarer Konfliktzähler und
bedienbare Abschlussleiste. Canvas-Dialoge, Typografie, Farben und Abstände verwenden;
Status nie nur durch Farbe ausdrücken. Unveränderte Bereiche einklappbar, geänderte
Bereiche vollständig erreichbar, Auswahl/Fokus/Scrollposition erhalten.

## 3. Zustände und Abschlusssemantik

| Zustand | Anzeige | Nächste Aktion |
|---|---|---|
| Auswertung läuft | „Änderungen werden geprüft“ | Vorherige Ansicht darf sichtbar bleiben; Annahme gesperrt |
| `clean` / `clean_rebased` | Diff; ggf. „Mit aktuellem Stand abgeglichen“ | Prüfen und annehmen |
| Auswertung durch neues Dokument/Graph überholt | „Dokument wurde geändert, Vergleich wird aktualisiert“ | Begrenzt neu auswerten; neuen Diff bestätigen |
| `conflicted` | „Konflikt – Entscheidung erforderlich“ mit betroffenen Bereichen | Konflikt lösen, wenn P12 verfügbar; sonst klarer Hinweis auf erforderlichen neuen Vorschlag |
| `blocked_by_parent` / `prerequisite_lost` | Fehlende Voraussetzung verständlich erklären | Autorisierte Voraussetzung prüfen; keine automatische Umhängung |
| Bewiesene gleiche Wirkung / `empty_effect` | „Bereits enthalten“ / „Keine wirksame Änderung“ | Explizit abschließen ohne leere Version |
| `unavailable` / `upgrade_required` | „Grundlage fehlt“ / „Vorschlag muss erneuert werden“ | Neuen Vorschlag auf aktuellem Stand erstellen |
| Transport-/Serverfehler | „Vergleich konnte nicht geladen werden“ | Erneut versuchen; nicht als Inhaltskonflikt ausgeben |
| Apply oder Recovery ungeklärt | „Übernahme wird abgeschlossen“ | Dauerhaften Status abfragen; kein zweiter Schreibversuch mit neuer Identität |

Ein gespeicherter Originalstatus und die heutige Anwendbarkeit sind getrennt:
B kann weiterhin offen sein und aktuell kollidieren. Ein Leseaufruf lehnt B nicht ab.
Ein Konflikt im gleichen Block ist nur bei tatsächlicher Überschneidung oder
verletzter Strukturvoraussetzung zwingend; die Blocknummer allein reicht nicht.

Resolution-Receipt erhält die Herkunft und die Entscheidung je Original und Bereich:

- Unveränderte vollständige Wirkung übernommen: „Übernommen“.
- Nur ein Teil der Originalwirkung übernommen: „Teilweise übernommen“ mit Details.
- Manuell verändertes Ergebnis: „Mit Anpassungen zusammengeführt“; nicht als
  unverändertes `applied` protokollieren.
- Gesamte Originalwirkung bewusst verworfen: „Nicht übernommen“.
- Nachweisbar schon enthalten: „Bereits enthalten“ mit eigener Begründung.
- Nicht ausgewählt: bleibt offen.

Die UI-Beschriftung „Teilweise übernommen“ ist eine abgeschlossene Resolution-
Disposition. Sie darf nicht versehentlich den bisherigen aktiven
`partially_applied`-Status mit erneut annehmbarer Restwirkung erzeugen.
Die neue Contract-/Kompatibilitätsabbildung wird in FVRC-1200 festgelegt.
Ein reines „Aktuell behalten“ schließt die bestätigte Auswahl nachvollziehbar,
erzeugt aber keine Inhaltsrevision. Entwurf verwerfen oder Popup schließen
schließt keine Originalvorschläge.

## 4. Umsetzung in verbindlicher Reihenfolge

Jeder vorhandene Task wird einschließlich seiner bisherigen Abnahmekriterien
abgeschlossen, bevor der nächste beginnt. Die folgenden Arbeitsschritte sind
Ergänzungen innerhalb dieser Tasks, keine konkurrierende Statusliste.

### 1 — FVRC-1006: Center anbinden, Konflikt erklären, Batch prüfen

- Reproduktion über den echten Vorschlags-Erstellungspfad: A → B/C, C annehmen,
  B öffnen. Den produktiven API-/UI-Pfad prüfen, nicht nur den Merge-Kern.
- Graphfähige Vorschläge über `proposal-review-read-service.ts`,
  `proposal-review-runtime.ts` und `proposal-review-compare-service.ts` auswerten.
  Client-/API-Adapter ergänzen; `FileVersionCenterHost`, `FileVersionComparison`
  und `FileVersionActions` konsumieren dieselbe ausgewählte Auswertung.
- Alte Einzeloperationslinks und historische Revisionen weiter korrekt auflösen.
  Legacy nur bei belegbarer Herkunft in den Graphpfad überführen. Unzureichende
  Basis ausdrücklich anzeigen; keine Snapshotprüfung abschalten.
- Nach Accept/Reject/Restore und Dokument-/Graphereignissen betroffene Ansicht
  zusammengefasst invalidieren. Beim Wiederöffnen/Fokus neu prüfen; verlorene
  Events werden spätestens serverseitig vor Apply abgefangen. Ein automatischer
  Wiederholungsversuch pro überholter Anfrage, danach ruhiger sichtbarer Zustand
  mit manueller Wiederholung statt Endlosschleife.
- Strukturierte Gründe anzeigen; `+0 / −0` nur nach erfolgreichem Null-Diff.
  „Technische Details“ auch bei Fehlern erreichbar: Grund, Phase, Prüfzeitpunkt,
  Auswertungs-/Korrelationsreferenz und Build. Kopie enthält dieselbe redigierte
  Information; keine Dokumentinhalte, Secrets oder unberechtigten Referenzen.
- „Alle Änderungen akzeptieren“ ermittelt alle berechtigt bearbeitbaren offenen
  Vorschläge des Dokuments über alle Seiten. Erstklick öffnet die gemeinsame
  Vorschau. Auswahl wird eingefroren; später eintreffende Vorschläge bleiben offen.
- Konflikte/Alternativen/Voraussetzungen vor Bestätigung auflösen. „7 konfliktfrei,
  3 benötigen eine Entscheidung“ darf keine maximale oder beliebige sichere
  Teilmenge behaupten. Optional ausdrücklich eine vollständig ausgewertete
  konfliktfreie Auswahl anbieten, mit eigener Vorschau und Bestätigung.
- Bestehenden `proposal-action-orchestrator.ts` für Einzel-/Batch-Aktionen anbinden;
  fehlende autorisierte API-Adapter innerhalb dieses Tasks ergänzen. Keine Schleife
  einzelner Accept-Aufrufe. Neue Graph-Schreibpfade bleiben bis 1008 capability-gesperrt.

**Abnahme:** B zeigt nach C einen konkreten Konflikt, kein Refresh-Dauerversprechen.
Unabhängige Vorschläge bleiben prüfbar. Batch mit Konflikt schreibt nichts;
konfliktfreier Batch schreibt den vollständig gezeigten Kandidaten genau einmal.
Komponenten-/API-Tests und echte Browserprüfung dieses Weges sind Pflicht.

### 2 — FVRC-1007 und danach FVRC-1008: Einstiegspunkte und P10-Abnahme

- Editor, Dateibrowser, Chat und vorhandene Notifications öffnen dieselbe genaue
  Dokument-/Vorschlagsauswahl. Alte Links behalten ihre Identität; Nachfolger sind
  explizite Links. Erweiterungen der Notification-Zentrale bleiben nachgeordnet.
- Reale Markdown-Text- und Blocktools bei der Aktivierung nachweislich an den
  Graphpfad anschließen. Ein synthetisches Fixture allein beweist keine Migration
  gewöhnlicher Agentenvorschläge. Altvorschläge und Feature-off weiter testen.
- MR-01..MR-24, bestehende PG-Fälle und die unten P10 zugeordneten CR-Fälle prüfen;
  zusammengeführtes Main mit korrekter Build-ID verwenden. Erst nach bestandenem
  Gate kontrolliert aktivieren und dokumentieren, dass P12 noch aussteht.

**Abnahme:** „10 → 3 → 7“ und „alle 10“ funktionieren über die echte Oberfläche;
Zahlen der Inhaltsrevisionen stimmen. Diagnose erklärt echte Konflikte getrennt
von fehlenden Grundlagen und Netzwerkfehlern. Rollback erhält History und Proposals.

### 3 — FVRC-1200: Entwürfe, Entscheidungen und Abschlussvertrag

- Versionierten Resolution-Vertrag und additive Persistenz ergänzen: Nutzer,
  Workspace, Lineage/Lifecycle, feste Auswahl samt Proposal-Versionen,
  Basisartefakte, Graphrevision, Current-Proof, Entscheidungen, Ergebnis und
  Entwurfsversion. Ein Draft gehört einem Nutzer; andere Nutzer teilen sich
  nicht implizit dessen Entscheidungen.
- Autorisierte Create/Get/Save/Discard/Preview/Finalize-Operationen festlegen.
  Save mit Versionsprüfung (CAS), Finalize mit gebundener Vorschau und
  Idempotenzschlüssel. Alle IDs/Scopes serverseitig erneut prüfen.
- Entwurfszustände bearbeiten, neu prüfen, bereit, wird übernommen, abgeschlossen,
  verworfen, abgelaufen trennen. Originale erst nach bestätigtem Abschluss ändern;
  Draft ist kein sofort wirksamer `replaces`-Vorschlag.
- Dispositionen aus Abschnitt 3, Retention/Pins, Größen-/Zeitgrenzen und sichere
  Projektion für ältere Clients definieren. Originale und Basis nicht verändern.

**Abnahme:** Draft-Öffnen, Save, Reload und Discard verändern weder Live-Dokument
noch Originalstatus. Zwei Tabs überschreiben sich nicht. Entwürfe sind nach
Restart wiederaufnehmbar und bei Rechteverlust nicht mehr zugänglich.

### 4 — FVRC-1201: Kandidaten und dauerhaften Abschluss implementieren

- Pure Konflikt-/Kandidatenmechanik verarbeitet explizite Snapshots und Entscheidungen;
  Orchestrierung verantwortet Rechte, Status, Abhängigkeiten und Abschluss.
  Vorhandene Yjs-, Storage-, Action-Fence- und Recovery-Mechaniken wiederverwenden.
- Stabile Konfliktgruppen nach Wirkung und Strukturvoraussetzungen bilden.
  Bei mehreren kollidierenden Vorschlägen alle autorisierten Optionen zeigen,
  keine versteckte Reihenfolge als Gewinner wählen.
- Nicht betroffene Änderungen erhalten, Struktur-/Markdown-Roundtrip validieren.
  Kein Ganzdokument-Ersatz als pauschaler Fallback. Fehlende oder unterschiedliche
  Basen klar ausweisen, keine gemeinsame Ausgangsversion erfinden.
- Bei aktuellem Peer-Edit Entscheidungen anhand ihrer konkreten Voraussetzungen
  erneut prüfen: gültige behalten, betroffene neu öffnen. Geänderter Gesamtkandidat
  verlangt immer eine neue Vorschau und Bestätigung.
- Finalisierung unter dokumentweiter Serialisierung durch den bestehenden
  Action-Orchestrator; aktuelles Dokument, Graph, Auswahl, Draft-Version und Rechte
  erneut binden. Genau ein dauerhafter Abschlussnachweis und eine logische Revision
  bei Inhaltsänderung; kein zweiter Effekt bei Wiederholung oder verlorener Antwort.
- Nicht einbezogene Vorschläge und abhängige Kinder neu auswerten. Ein manuell
  angepasstes B erfüllt nicht automatisch die Voraussetzungen seines Kindes.

**Abnahme:** Alle drei Konfliktentscheidungen erzeugen das vorab festgelegte
Ergebnis. Current behalten erzeugt keine leere Version. Absturz und Retry führen
zu Recovery desselben Vorgangs; Originale gelten nicht vorzeitig als erledigt.

### 5 — FVRC-1202: Konflikteditor vollständig integrieren

- Konfliktliste, Quellen, Ergebniseditor und optionale Basisansicht entsprechend
  Abschnitt 2 einbauen. Zähler „Noch 2 Konflikte“ und Fokus zum nächsten Konflikt.
- „Konflikt lösen“ nur bei vorhandener Capability und ausreichender Grundlage.
  Geöffneter Draft verwendet den echten Service aus 1201; kein UI-eigener Merge.
- Autosave zeigt „Wird gespeichert“, „Gespeichert“ oder „Speichern fehlgeschlagen“.
  Schließen bleibt bedienbar. Bei noch nicht gesicherten Änderungen eine konkrete
  Auswahl „Speichern und schließen“ / „Ungespeicherte Änderungen verwerfen“ / weiter
  bearbeiten anbieten. Gespeicherte Entwürfe über die Vorschlagskarte wieder öffnen.
- Nach allen Entscheidungen Gesamtdiff und Originaldispositionen prüfen lassen.
  Während laufender Finalisierung darf der Dialog schließen; der Vorgang läuft
  nachvollziehbar weiter und lässt sich beim Wiederöffnen abfragen.
- Nach Merge aktuelle Version, Reviewkarten und Einstiegspunkte aktualisieren.
  Wiederherstellen nutzt die bestehende Versionshistorie und erzeugt eine neue
  Version; frühere geschlossene Vorschläge nicht automatisch wieder öffnen.

**Abnahme:** A → B/C → C annehmen → B lösen → Gesamtdiff → übernehmen klappt
ohne technische Vorkenntnisse auf Desktop und Mobil. Abbruch/Reload verlieren
keinen bestätigt gespeicherten Entwurf. Alle P12-UI-Zustände sind DE/EN zugänglich.

### 6 — FVRC-1203: Gesamtabnahme und Freigabe

- Gesamte CR-Matrix unten sowie MR-25..MR-32 und P10-Regression prüfen.
  Unit-/Contracttests, reale PostgreSQL-/Yjs-Integration und Browsernachweise getrennt.
- Zwei vollständige Browserläufe im einzigen verwalteten Team-Seat-Stack gemäß
  `canvas-local-team-seat-dev`, mit Personal-/Team-Fixtures und zwei echten Clients.
  Freigaben aus der Sitzung beachten; Containerbuild nur ausdrücklich autorisiert
  und nach erfolgreichem `npm run build`. Vor Prüfung den tatsächlichen Build abgleichen.
- End-to-End deterministische Vorschläge über echte Tool-/Servicepfade erzeugen;
  Accept, Rechte, Persistenz und Re-Evaluation nicht mocken. Kein KI-Provider nötig.
- Evidence je Fall: Commit, Build, Eingabe, erwarteter Inhalt, tatsächlicher Inhalt,
  Originalstatus, Receipt, Revisionszahl, Testergebnis und bei Fehlern Trace/Diagnose.
- Capability getrennt ausrollen; Rollback erhält gespeicherte Entwürfe, Originale,
  Audit und laufende Recovery. Produktionsaktivierung separat autorisieren.

**Abnahme:** Kein Pflicht-Skip, keine offene Recovery, keine ungeklärte Abweichung.
Ein grüner Kern-/API-Test ersetzt nicht den Erfolg des Nutzerszenarios im Center.

## 5. Zusätzliche konkrete Abnahmetests

Alle folgenden Fälle sind geplant. Feste Solltexte und Status-/Revisionsorakel
werden vor Implementierung definiert und nicht vom getesteten Merge-Code abgeleitet.

| ID | Szenario | Erwartung | Gate |
|---|---|---|---|
| CR-01 | A=100, B=120, C=130 im selben Bereich; C zuerst | B sichtbar als konkreter Konflikt; C unverändert; kein Refresh-Loop | P10, P12 |
| CR-02 | Derselbe Fall, B zuerst | C gleichermaßen konfliktbehaftet; Reihenfolge bevorzugt keinen Vorschlag | P10, P12 |
| CR-03 | B/C ändern disjunkte Stellen desselben Blocks | Bei belegter Unabhängigkeit beide korrekt übernehmbar | P10, P12 |
| CR-04 | Vor dem Ziel wird ein Block eingefügt oder das Ziel verschoben | Identität entscheidet, nicht die alte Blocknummer 10 | P10, P12 |
| CR-05 | Ziel gelöscht und textgleich neu angelegt | Keine automatische Verwechslung; begründeter Konflikt | P10, P12 |
| CR-06 | 10 unabhängige Vorschläge, 3 einzeln, 7 als Batch | Alle 10 Effekte genau einmal; 4 logische Inhaltsrevisionen | P10, P12 |
| CR-07 | B enthält 10 Änderungen, 9 unabhängig, 1 kollidiert mit C | 9 bleiben im Entwurf; nur nötige Konfliktentscheidungen; vollständiger Gesamtdiff | P12 |
| CR-08 | Drei getrennte Läufe: C behalten / B übernehmen / manuell 125 € | Exakt 130 / 120 / 125 €; entsprechende Originaldisposition | P12 |
| CR-09 | Alle Konfliktstellen aktuell behalten, keine übrige Wirkung | Expliziter Abschluss „Nicht übernommen“; 0 neue Inhaltsrevisionen | P12 |
| CR-10 | Identische Wirkung mit Beleg bzw. nur textgleicher fremder Identität | Nur bewiesene Wirkung „Bereits enthalten“; kein falscher Accept/Replay | P10, P12 |
| CR-11 | Kind hängt von genau der Originalwirkung von B ab; B wird manuell angepasst | Kind neu auswerten, ggf. Voraussetzung verloren; nicht automatisch umhängen | P12 |
| CR-12 | Batch enthält B und C oder exklusive Alternativen | Kein willkürlicher Gewinner, keine Teilmutation; Auswahl/Resolution erforderlich | P10, P12 |
| CR-13 | Peer ändert konfliktbetroffene Stelle während Draft oder nach Vorschau | Betroffene Entscheidung wieder offen; alter Merge gesperrt | P12 |
| CR-14 | Peer ändert unabhängige Stelle | Peer-Inhalt erhalten; gültige Entscheidungen erhalten; neuer Gesamtdiff vor Apply | P12 |
| CR-15 | Zwei Tabs speichern denselben Draft; zwei Nutzer finalisieren konkurrierende Drafts | CAS bzw. Current-Fence greift; keine stille Überschreibung | P12 |
| CR-16 | Doppelclick, Timeout nach Apply, verlorene Antwort, Serverrestart | Ein Effekt/Receipt; Abschlussstatus wiederherstellbar | P10, P12 |
| CR-17 | Read-only, Rechteverlust, fremder Draft/Parent, Workspacewechsel | Erlaubte Ansichten korrekt; keine Schreibfreigabe oder Informationslecks | P10, P12 |
| CR-18 | Legacy ohne belastbare Basis, fehlendes Artefakt, andere Basen | Ursache statt Merge-Behauptung; klarer Neuvorschlagsweg | P10, P12 |
| CR-19 | Autosave, Schließen, Reload, Verwerfen, fehlgeschlagener Save | Gespeicherte Arbeit wiederaufnehmbar; keine stille Verlust-/Abschlussmeldung | P12 |
| CR-20 | Frontmatter, Liste, Tabelle, Codeblock, Formatierung, Emoji, CRLF, reine Löschung | Struktur/Identität/unbetroffener Inhalt erhalten; Schemafehler blockieren Apply | P12 |
| CR-21 | Batch über mehrere Seiten; neuer Vorschlag während Vorschau; verspätete HTTP-Antwort | Genau die gezeigte Auswahl; alte Antwort erzeugt keine Freigabe | P10, P12 |
| CR-22 | Netzwerkfehler vs. Konflikt vs. fehlende Grundlage; Diagnose kopieren | Verschiedene verständliche Anzeigen; keine falschen Null-Diffs; redigierte Details | P10, P12 |
| CR-23 | Desktop/Mobil, DE/EN, Light/Dark, Tastatur, Screenreader; alle Einstiegspunkte | Gleiches Dokument/gleicher Draft; lesbare Quellen; kein blockiertes Schließen | P12 |
| CR-24 | Feature aus, älterer Client, Rollback, Versionsrestore nach Merge | Daten/Audit erhalten; kein Replay geschlossener Vorschläge; neue aktuelle Prüfung | P12 |

## 6. Grenzen und Fertigkriterium

Markdown und bereits unterstützte Textrepräsentationen zuerst. Keine neuen
Dateiadapter, automatische KI-Konfliktentscheidung oder allgemeine freie
Hunk-Teilannahme als Nebenfeature. Ein Konfliktentwurf darf mehrere Wirkungsteile
bewusst entscheiden; sein Ergebnis wird anschließend als eine Zusammenführung
geprüft und abgeschlossen.

Diese Arbeit ist erst vollständig, wenn beide Meilensteine abgenommen sind:
C akzeptieren, B verständlich als Konflikt sehen, B öffnen, entscheiden, prüfen,
dauerhaft zusammenführen und das Ergebnis nach Reload wiederfinden. Ein dauerhaft
gesperrter Accept oder eine klarere Fehlermeldung allein erfüllt das Ziel nicht.
