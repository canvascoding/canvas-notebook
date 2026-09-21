# Verlässliches Zusammenführen von Dokumentänderungen

Stand: 2026-09-21

Status: konkreter Verbesserungsplan, noch keine Implementierungs- oder Produktionsabnahme.
Die Aufgaben und ihr Status werden ausschließlich in [`todo.json`](./todo.json) geführt.
Dieser Plan konkretisiert die offenen Tasks `FVRC-1005` bis `FVRC-1008` und ergänzt
`FVRC-P12` für eine persistente, PR-ähnliche Konfliktauflösung. Die bestehenden
[Graphregeln](./proposal-graph-contracts-v1.md) und [46 Szenarien](./proposal-graph-scenarios.md)
bleiben verbindlich. Weitere Datei-/Codeadapter folgen danach.

## 1. Ausgangslage und überprüfbare Ziele

Produktionsmeldung: Nach Annahme einiger Änderungen bleiben weitere Vorschläge
mit „Vergleich nicht mehr aktuell“ liegen. Der Screenshot beweist weder eine
Blockverschiebung noch einen bestimmten Fehlercode. Produktions-Build,
Operationstyp, Zielanker und Auswertung müssen für die konkrete Ursache erfasst
werden; bis dahin ist die Zuordnung eine Hypothese.

Im untersuchten Code sind folgende Grenzen nachweisbar:

- `legacyMarkdownTargetStillMatches` in `agent-operations.ts` bindet ältere
  `rich_markdown_patch`-Vorschläge an den vollständigen ursprünglichen Zustand.
  Eine unabhängige Dokumentänderung kann deshalb schon die sichere Anwendung sperren.
- Moderne Text-/Blockziele besitzen feinere Anker. Reine Ortsänderungen sind nicht
  grundsätzlich Konflikte; Strukturvoraussetzungen können jedoch tatsächlich verletzt sein.
- `previewAgentOperationContent` reduziert verschiedene Fehler auf `null`/`stale`.
  `compare-service.ts` und `FileVersionComparison.tsx` zeigen daraus eine Sammelmeldung
  und teilweise `+0 / −0`, obwohl kein Vergleich berechnet wurde.
- Graphmodell, persistente Artefakte und Action-Orchestrator sind vorhanden.
  Die öffentliche Graph-Auswertung, Center-Anbindung und vollständige Abnahme fehlen.
  `rebase` im Orchestrator ist ohne neue graphfähige Auswertung ausdrücklich gesperrt.
- Serverseitige Collaboration-Diagnostik existiert, ist aber keine im Center
  zugängliche, auswertungsspezifische Erklärung.

Erfolgsmaßstab: Zehn belegbar unabhängige Vorschläge an zehn Stellen erzeugen
nach Annahme von drei Vorschlägen weiterhin sieben korrekt prüfbare Vorschläge.
Diese lassen sich einzeln oder gemeinsam übernehmen, ohne fremde Änderungen
zu verlieren. Tatsächliche Konflikte bekommen einen gangbaren Auflösungsweg.

Eine lokale Testsuite oder interne Implementierung beweist keinen Produktionsrollout.
Die bisherige Absicherung des sicheren Sperrens/Ablehnens ersetzt diesen Erfolgsmaßstab nicht.

## 2. Verbindliche Produktregeln

1. Der Hauptvergleich bleibt **aktuelles Dokument gegen effektives Ergebnis**.
   Die ursprüngliche Basis ist zusätzlich für Konfliktklärung verfügbar.
2. Positionen/Zeilennummern sind Anzeigeinformationen, keine alleinigen Merge-Anker.
   Blockidentitäten, relative Textanker, lokale Wirkung und Strukturbedingungen
   entscheiden über die Anwendbarkeit. Kein unscharfes Suchen-und-Ersetzen.
3. Eine neue Auswertung verändert weder den ursprünglichen Vorschlag noch dessen Basis.
   Aktuelle Wirkung und historischer Annahmestatus werden getrennt geprüft.
4. Kein LLM ist für Merge, Diagnose oder Tests erforderlich. KI-Unterstützung
   darf später einen neuen prüfbaren Entwurf erzeugen, aber keine Konflikte still entscheiden.
5. Zehn Diff-Stellen können zu einem Vorschlag oder zehn Vorschlägen gehören.
   P10 übernimmt vollständige Vorschläge beziehungsweise bereits ausdrücklich
   unabhängige Einheiten. Neue freie Hunk-Teilannahme ist kein implizites Nebenfeature.
   Existierende `partially_applied`-Operationen brauchen einen belegbaren Restumfang.
6. Ein Batch gilt für genau ein Dokument und eine ausdrücklich angezeigte Auswahl.
   Keine dokumentübergreifende Atomaritätszusage und keine still ergänzten Vorschläge.
7. Review bleibt für neue Dokumente standardmäßig ausgeschaltet (`safe_direct`).
   Einschalten ist explizit; offene Reviews verschwinden nicht beim Ausschalten.
   Organisationsrichtlinien und harte Sicherheitsbedingungen bleiben wirksam.

## 3. Gemeinsame Architektur

Die vorhandenen Mechaniken werden integriert, nicht durch einen zweiten Merge-Pfad ersetzt:

- **Domänenorchestrierung:** prüft Rechte, Dokument-Lifecycle, Proposal-Beziehungen,
  Auswahl, Alternativen, Lifecycle-Übergänge und Fehlerklassifizierung.
- **Reine Mechaniken:** `proposal-graph-model.ts`, `proposal-yjs-candidate.ts` und
  `proposal-action-fence.ts` berechnen Abhängigkeiten, Kandidaten und Freigaben
  aus expliziten Eingaben. Kein versteckter Datenbankzugriff in diesen Funktionen.
- **Persistenzadapter:** `proposal-storage.ts` und `proposal-storage-projection.ts`
  liefern unveränderliche Artefakte, Auswertungen, Locks und Receipts.
- **Schreibgrenze:** `proposal-action-orchestrator.ts` verwendet den vorhandenen
  dauerhaften Collaboration-Apply einschließlich Recovery. UI und Chat schreiben
  keine eigene Merge-Logik und führen keine Schleife einzelner Accept-Aufrufe aus.

Der neue Auswertungspfad lädt einen konsistenten aktuellen Snapshot plus Graphrevision,
berechnet die gesamte notwendige Wirkungsmenge und projiziert sie auf eine isolierte
Kopie. Das Ergebnis bindet Auswahl, Kandidat, Rechte/Scope, Current-Proof und Graphrevision.
Lesen/Auswerten verändert weder Live-Dokument noch Proposal-Lifecycle; gespeicherte
Auswertungsartefakte und befristete Pins sind zulässig.

Timeline, Vergleich und Aktionsfreigabe verwenden dieselbe Auswertungsidentität.
Diff-Folgeseiten dürfen nicht aus verschiedenen Auswertungen gemischt werden.
Inhalt, Struktur und Löschwirkung sind Teil des Current-Proofs; ein State-Vector
allein reicht nicht. Beim finalen Apply erfolgt die erneute Prüfung unter der
vorhandenen dokumentweiten Serialisierung.

## 4. Geordnete Umsetzung und Abnahme

Die Schritte werden in dieser Reihenfolge abgeschlossen, geprüft und separat
committet. Kein nachfolgender Implementierungstask beginnt vor der Abnahme des
vorherigen. Diese Dokumentationsänderung markiert keinen Laufzeittask als fertig.

### Schritt 1 — Reproduktion, Harness und Diagnosevertrag (`FVRC-1005`, Teil A)

- Deterministisches Zehn-Änderungen-Fixture mit stabilen IDs und vorab festgelegtem
  Ergebnis erstellen; Varianten für Textanker, Blockoperationen und Legacy-Patches.
  Den bekannten Ausfall zuerst als Regression abbilden, nicht nur die Warnung testen.
- Betroffene Browsertests auf `tests/helpers/managed-test-context.ts` vereinheitlichen:
  Auth-Zustand je Identität und Origin wiederverwenden, getrennte Owner-/Peer-Kontexte,
  geprüfte Workspace-Zuordnung und atomare Fixture-Erstellung.
- Ein gemeinsamer Runner prüft Base-URL, Auth-Origin, Fixture-IDs, Datenbank, DATA,
  Server-/Buildidentität und Bereitschaft. Keine ausgegebenen Secrets, kein
  pauschales Deaktivieren der Login-Ratenbegrenzung und keine Schlafpausen als Ersatz.
- Ablaufende Sessions gezielt erneuern; Rollenwechsel, entzogene Rechte und
  beschädigter Auth-Cache werden getestet. Ein grüner Einzellauf zählt nicht als
  grüner Gesamtlauf. Nicht verfügbare Pflicht-Fixtures führen zum Gate-Fehler, nicht Skip.
- Versionierten Compare-/Diagnosevertrag ergänzen: Auswertungs-ID, fachlicher
  Zustand, erlaubte Aktionen, Grundcode, betroffene autorisierte Ziele,
  Korrelations-ID und sicher darstellbare Metadaten.

Abnahme: Der Harness führt die bestehende Review-Suite zweimal vollständig ohne
Login-429 durch. Die neue Regression ist reproduzierbar; ihr rot/grün-Status wird
getrennt vom Harness protokolliert. Unbekannte Fehler bleiben sicher gesperrt und
haben einen korrelierbaren, inhaltsfreien Diagnoseeintrag.

### Schritt 2 — Aktuelle Auswertung und sichere Legacy-Brücke (`FVRC-1005`, Teil B)

- Einzel- und Batchauswertung an die vorhandenen Graph-/Yjs-Mechaniken anschließen.
  Nach Accept, Reject, Replace, Restore und externem Edit betroffene Auswertungen
  invalidieren. Im geöffneten Center begrenzt und zusammengefasst neu auswerten;
  Serverprüfungen bleiben auch bei verlorenen Events verbindlich.
- Unabhängige Vorschläge auf aktuellem Stand anwenden; offene erforderliche
  Vorfahren genau einmal einschließen. Angenommene Vorfahren nicht erneut schreiben,
  sondern ihre heute noch vorhandene notwendige Wirkung prüfen.
- Gleiche Einfügestelle, gelöschtes/neu erzeugtes Ziel, unklare Struktur oder
  widersprüchliche Voraussetzungen ergeben einen expliziten Konflikt, keinen Zufallsgewinner.
- Legacy klassifizieren: belegbar eigenständig; belegbar teilweise angewendet;
  unzureichende Herkunft/Basis. Nur die ersten beiden dürfen bei vollständigem
  Beleg in den Graphpfad übernommen werden, mit unveränderten Audit-Referenzen.
- Alte Patches niemals durch Abschalten der Snapshotprüfung „reparieren“.
  Bei ausreichender Basis einen verankerten Ersatz vorbereiten und neu prüfen;
  andernfalls `upgrade_required` mit „Neuen Vorschlag auf aktuellem Stand erstellen“.
  Fehlender Inhalt wird nicht aus Metadaten-only-Versionen erfunden.

Abnahme: Zehn unabhängige Vorschläge bleiben nach drei Annahmen korrekt anwendbar.
Gleiche Inhalte mit fremder Identität, verlorene Voraussetzungen und unbewiesene
Legacy-Reste werden sicher abgewiesen. Auswertung und spätere Anwendung ergeben
denselben geprüften Kandidaten. Keine Rechteausweitung durch Parent- oder Batchauswahl.

### Schritt 3 — Verständliche Zustände und ausklappbare Details (`FVRC-1006`, Teil A)

Die UI verwendet die vorhandenen Canvas-Komponenten, Tokens, Abstände und
Dialogstrukturen. Farben unterstützen Beschriftungen, ersetzen sie aber nicht.

| Zustand | Anzeige und nächster Schritt |
|---|---|
| `clean` / `clean_rebased` | Diff anzeigen; anwendbar, gegebenenfalls „Auf aktuellen Stand abgeglichen“ |
| Current/Graph zwischenzeitlich geändert | Neu berechnen; bei neuem Ergebnis erneute Bestätigung verlangen |
| `conflicted` | „Änderungen überschneiden sich“; betroffene Bereiche anzeigen; später „Konflikte lösen“ |
| `blocked_by_parent` / `prerequisite_lost` | Fehlende Voraussetzung erklären und die autorisierte Referenz öffnen |
| `satisfied_elsewhere` / `empty_effect` | „Bereits enthalten“ beziehungsweise „Keine wirksame Änderung“; keine leere Version |
| `unavailable` / `upgrade_required` | Inhalt/Basis fehlt oder Altformat nicht sicher übertragbar; klarer Wiederherstellungs-/Neuvorschlagsweg |
| Lifecycle-/Rechtewechsel | Ursache erklären; nicht durch Aktualisieren eine Schreibfreigabe vortäuschen |
| Speichern/Recovery | Dauerhaften Abschluss abwarten; Timeout nicht als gesicherten Fehlschlag darstellen |

- `+0 / −0` nur bei erfolgreich berechnetem Null-Diff; sonst Zähler ausblenden.
- „Technische Details“ standardmäßig eingeklappt, auch im Fehlerzustand erreichbar.
  Inhalt: Reason-Code, Phase, Auswertungs-/Vorschlags-/Korrelations-ID,
  verkürzte Zustandsreferenzen, Zeit, Buildversion, Zielart und erlaubte nächste Aktionen.
- Begrenzte strukturierte Ereignisliste statt ungefiltertem Serverlog; „Diagnose kopieren“
  erzeugt dasselbe redigierte Format. Keine Dokumenttexte, Pfade, E-Mails, Tokens,
  Promptinhalte oder Stacktraces. Detaillierte Betriebslogs bleiben administrativ geschützt.
  Nur für den aktuellen Nutzer lesbare Referenzen ausgeben, auch bei versteckten Parents.
- Refresh unterscheidet „erneut veraltet“, fachlichen Konflikt und technischen Ausfall.
  Keine automatische Endlosschleife; letzter Prüfzeitpunkt sichtbar.

Abnahme: Die Produktionswarnung lässt sich jedem simulierten Grund eindeutig
zuordnen. Ablehnen bleibt bei lesbarem, berechtigt verwaltbarem Vorschlag auch
ohne Kandidateninhalt möglich. Diagnosekopie und Anzeige sind identisch redigiert.

### Schritt 4 — „Alle Änderungen akzeptieren“ (`FVRC-1006`, Teil B)

- Im Review-Bereich eine dokumentbezogene Sammelaktion plus Einzelauswahl anbieten.
  Der Erstklick berechnet und öffnet die Gesamtvorschau, er schreibt noch nichts.
- „Alle“ meint alle berechtigt bearbeitbaren offenen Vorschläge dieses Dokuments,
  nicht nur die momentan geladene Listenseite. Auslassungen wegen fehlender Rechte
  werden ohne Offenlegung fremder Inhalte erklärt. Neue Vorschläge nach der Auswahl
  werden nicht still eingeschlossen; sie bleiben für einen neuen Durchlauf offen.
- Server löst Abhängigkeiten und Alternativgruppen auf. Notwendige Parents und
  geschlossene Alternativen sind vor Bestätigung sichtbar. Zwei exklusive Alternativen
  erfordern eine Auswahl. Technische Nichtüberlappung erzeugt keine erfundene Unabhängigkeit.
- Eine gemeinsame Vorschau, ein gebundener Freigabenachweis, eine synthetische
  Collaboration-Operation und eine logische Inhaltsrevision für einen erfolgreichen
  inhaltsändernden Batch. Herkunft aller enthaltenen Vorschläge bleibt nachvollziehbar.
- Konflikt vor Apply: keine Teilmutation und kein Teil-Erfolg. Optional „Konfliktfreie
  Auswahl prüfen“ für eine deterministisch begründete, abhängigkeitsvollständige
  Teilmenge; anschließend eigener Diff und eigene Bestätigung. Keine Behauptung
  einer maximalen Teilmenge und keine willkürliche Wahl zwischen kollidierenden Vorschlägen.
- Prozessabbruch nach Live-Apply: bestehende Receipt-/Recovery-Semantik nutzen;
  nicht behaupten, eine SQL-Transaktion könne einen Live-Apply rückgängig machen.

Abnahme: Nach drei Einzelannahmen übernimmt der Batch die restlichen sieben genau
einmal. Bei normalem Inhalt ergeben sich drei Einzelrevisionen plus eine Batchrevision,
ohne zusätzliche Zwischenrevisionen des Batches. Doppelclick, verlorene Antwort und
Restart verursachen keine zweite Wirkung. Unvollständige/trunkierte Vorschauen müssen
vor Freigabe vollständig geprüft werden können oder die Aktion bleibt gesperrt.

### Schritt 5 — Einstiegspunkte und P10-Abnahme (`FVRC-1007`, `FVRC-1008`)

- Editor, Dateibrowser, Chat-Widget und vorhandene Notifications öffnen dieselbe
  autorisierte Auswahl im globalen Center. Kein zweiter Batch-Button mit eigener Logik.
- Exakte alte Links bleiben exakte Referenzen; Ersatz und Auflösung separat verlinken.
  Auswahl, Scrollposition und Fokus bleiben nach Neuauswertung sinnvoll erhalten.
- Bestehende Benachrichtigungen aktualisieren, aber keinen neuen Notification-Ausbau
  vor die Merge-Zuverlässigkeit ziehen.
- Alle bisherigen PG-S/PG-U-Fälle und die zugehörigen MR-Fälle unten in einem
  zusammenhängenden Lauf prüfen. Zwei vollständige Wiederholungsläufe ohne Pflicht-Skips.
- Graph-Funktionen erst nach vollständiger P10-Abnahme freigeben. Diagnoseverbesserungen
  dürfen getrennt ausgeliefert werden, ohne Graph-Mutationen vorzeitig zu aktivieren.

Abnahme: Commit- und Build-bezogene Evidence für Personal und Team, zwei reale
Browserclients, Desktop und Mobile. Der Mehrfach-Merge gilt erst dann als ausgeliefert,
wenn diese Gates und ein dokumentierter Rollout vorliegen.

### Schritt 6 — PR-ähnliche Konfliktauflösung (`FVRC-P12`)

**1200 — Contract und Speicher:** Einen benutzergebundenen, wiederaufnehmbaren
Resolution-Entwurf pro ausgewähltem Änderungssatz definieren. Er referenziert
Dokument-Lifecycle, eingefrorene Proposal-Auswahl, Basisartefakte, Current-Proof,
Auswertungs-ID, Konfliktentscheidungen und Ergebnisartefakt. Entwurfsversion/CAS,
Retention-Pins, Größenlimits, Ablauf/Bereinigung und Rechteverlust explizit absichern.
Keine Veränderung des Live-Dokuments oder Schließung von Originalvorschlägen beim
Öffnen, Autosave oder Verwerfen eines Entwurfs.

**1201 — Auflösungsservice:** Konflikte je nach verfügbarer Basis als Ausgang /
Aktuell / Vorgeschlagen / Ergebnis aufbereiten. Bei mehreren Basen keinen falschen
gemeinsamen Ausgang erfinden. „Aktuell behalten“, „Vorschlag übernehmen“ und
manuelle Kombination erzeugen einen neuen, validierten Kandidaten auf dem aktuellen
Snapshot. Blockidentitäten, Formatierungen und nicht betroffene Nutzeränderungen
erhalten; keinen pauschalen Whole-Document-Replacement-Fallback einbauen.

Der Entwurf ist zunächst **kein** `replaces`-Vorschlag: Nach dem vorhandenen Contract
würde dessen Erstellung das Original bereits schließen. Stattdessen versionierten
Resolution-Contract mit expliziter Herkunft und Abschlussentscheidung ergänzen.
Ein veränderter Vorschlag darf nicht fälschlich als unverändert `applied` gelten.
Vorgesehen ist ein terminaler Resolution-Nachweis mit Disposition pro Original
(unverändert übernommen, verändert aufgelöst, aktuell behalten, nicht Teil der Aktion).
Die genaue Contract-Erweiterung und Kompatibilitätsprojektion gehören zu 1200.
Nicht einbezogene Vorschläge bleiben offen; abhängige Kinder werden neu ausgewertet,
nicht automatisch auf den Entwurf umgehängt.

Der Service bietet bereits die autorisierte Finalisierung durch den vorhandenen
Action-Orchestrator mit dauerhaftem Receipt an. Damit kann die nachfolgende UI
gegen den echten Schreibpfad geprüft werden; die öffentliche Aktivierung bleibt gesperrt.

**1202 — Konflikteditor:** Im gleichen globalen Popup eine Konfliktliste und
Ergebnisbearbeitung anbieten, mobil mit Tabs statt vier zu schmalen Spalten.
Autosave-/Wiederaufnahmezustand, Anzahl ungelöster Konflikte und Abschlusswirkung
sichtbar machen. Endaktion „Zusammenführung prüfen“, danach Gesamtdiff und
„Zusammenführung übernehmen“. Ein reines „Aktuell behalten“ kann eine explizite
Resolution abschließen, ohne eine leere Inhaltsrevision zu erzeugen.

Bei paralleler Dokumentänderung bleiben Entwurfsentscheidungen gespeichert,
werden aber anhand ihrer exakten Voraussetzungen erneut validiert. Nur weiterhin
gültige Entscheidungen bleiben bestätigt. Neue Konflikte verlangen erneut eine
Entscheidung; ein neuer Gesamtdiff verlangt einen neuen Klick. Zwei Tabs oder
Benutzer können Entwürfe nicht unbemerkt überschreiben oder denselben Satz doppelt mergen.

**1203 — Härtung und Freigabe:** Den integrierten finalen Apply einschließlich
gemeinsamer Auditbindung und Recovery über dauerhafte Receipts absichern. Schema-/Roundtripfehler,
Frontmatter, Tabellen, Listen, Codeblöcke und reine Löschungen gesondert prüfen.
Manuelle Auflösung separat hinter einer serverseitigen Capability freigeben.
P10 bleibt ohne P12 nutzbar, verspricht aber dann noch keinen manuellen Konflikteditor.

## 5. Verbindliche zusätzliche Testmatrix

Alle Fälle sind **geplant**, nicht durch diese Dokumentation bestanden.
Jede Mutation prüft vorab festgelegte Inhalte, Blockidentitäten, erhaltene fremde
Änderungen, Proposal-Status, Receipts und Revisionszahl. Ablehnungen dürfen keine
Inhalts-/Lifecycle-Teilmutation hinterlassen. Testorakel nicht aus derselben
Merge-Funktion ableiten, die gerade getestet wird.

| ID | Szenario und erwartetes Ergebnis | Gate |
|---|---|---|
| MR-01 | 10 unabhängige Vorschläge, 3 einzeln, 7 einzeln; in mehreren deterministischen Reihenfolgen identisches Endergebnis | 1005, 1008 |
| MR-02 | 10 → 3 einzeln → 7 als Batch; 4 neue Inhaltsrevisionen, keine Duplikate | 1006, 1008 |
| MR-03 | Alle 10 direkt als Batch; genau eine Inhaltsrevision | 1006, 1008 |
| MR-04 | Ein Vorschlag mit 10 Teiländerungen; ganze Einheit anwenden; belegte Legacy-Teilanwendung berücksichtigt nur Rest | 1005, 1008 |
| MR-05 | Zielblock verschoben, fremder Block eingefügt/gelöscht; unabhängiger Textedit bleibt korrekt verankert | 1005, 1008 |
| MR-06 | Zwei disjunkte Textstellen im selben Block vs. echte Überlappung; nur belegbare unabhängige Wirkung automatisch | 1005, 1008 |
| MR-07 | Gleiche Einfügestelle, konkurrierende Moves, Parentwechsel, strukturelle Preconditions; kein stiller Gewinner | 1005, 1008 |
| MR-08 | Ziel gelöscht und identischer Text mit neuer ID angelegt; keine Verwechslung durch Textgleichheit | 1005, 1008 |
| MR-09 | P1 zuerst, dann P2; P2 zuerst inklusive P1; P1 danach nicht erneut anwendbar | 1005, 1008 |
| MR-10 | P1 abgelehnt/ersetzt oder Wirkung durch Restore/Revert verloren; P2 nachvollziehbar blockiert | 1005, 1008 |
| MR-11 | Gemeinsame Vorfahren und Alternativen im Batch; Ancestor einmal, exklusive Optionen nicht gemeinsam | 1006, 1008 |
| MR-12 | Konflikthafter Batch schreibt nichts; ausdrücklich geprüfte konfliktfreie Teilmenge schreibt nur ihre Closure | 1006, 1008 |
| MR-13 | Wirkung bereits identisch vorhanden / leer; expliziter Abschluss, keine neue Inhaltsversion | 1005, 1008 |
| MR-14 | Legacy mit/ohne Basis, fehlendes Artefakt, Metadaten-only-Historie; begründeter Ersatz oder upgrade_required | 1005, 1008 |
| MR-15 | Current/Graph ändert sich nach Vorschau; alter Accept abgelehnt, neuer Diff und neuer Klick | 1006, 1008 |
| MR-16 | Zwei Nutzer/Tabs, Doppelclick, gleicher Key mit anderem Body, verlorene Antwort, Prozessabbruch an Apply-/Persistenzgrenzen | 1008 |
| MR-17 | Rename/Move in gleicher Lineage vs. Delete/Recreate; exakte Links, kein Lifecycle-Übergriff | 1007, 1008 |
| MR-18 | Personal/Team, Read-only, fremder Initiator, versteckter Parent, entzogene Rechte, Cross-Workspace-IDs | 1008 |
| MR-19 | Auswahl über mehrere Seiten, neuer Vorschlag nach Auswahl, verspätete Antworten; keine still geänderte Menge | 1006, 1008 |
| MR-20 | Auswertungsgebundene Diff-Seiten, Byte-/Graph-/Zeitlimits; keine Freigabe ungezeigter Änderungen | 1008 |
| MR-21 | Jeder Diagnosegrund, technischer Fehler, redigierte Kopie und fehlende Rechte; keine falschen Null-Zähler/Leaks | 1006, 1008 |
| MR-22 | Desktop/Mobile, Touch/Tastatur/Screenreader, DE/EN, Light/Dark; scrollender Trenner, stabile Auswahl und Details erreichbar | 1008 |
| MR-23 | Gesamtlauf zweimal ohne Login-429; getrennte Rollen, ungültiger Auth-Cache, Sessionablauf, Provider offline | 1005, 1008 |
| MR-24 | Review-Toggle aus/an; vorhandene Reviews, Default safe_direct und strengere Richtlinien bleiben korrekt | 1008 |
| MR-25 | Entwurf öffnen/autosaven/schließen/wiederaufnehmen/verwerfen; Live-Dokument und Originalstatus unverändert | 1200–1203 |
| MR-26 | Aktuell/Vorschlag/manuelle Kombination; exakter Gesamtdiff, Abschlussdispositionen, No-op ohne leere Version | 1201–1203 |
| MR-27 | Während Entwurf editiert Peer; Entscheidungen erhalten, ungültige Stellen erneut offen, stale Merge blockiert | 1201–1203 |
| MR-28 | Zwei Entwurfstabs, Restart, Retention und verlorene Abschlussantwort; CAS, Pins und einmalige Finalisierung | 1200–1203 |
| MR-29 | Markdown-Strukturen, Formatierungen, Unicode, Frontmatter, CRLF, Delete-only; keine strukturellen Verluste | 1201–1203 |
| MR-30 | Manueller Ersatz einer Voraussetzung; Kinder nicht automatisch umhängen, ausgeschlossene Vorschläge bleiben offen | 1201–1203 |
| MR-31 | Fehlende/verschiedene Basis, unzulässiger Ergebnisinhalt, Rechteverlust und geschützter fremder Entwurf | 1200–1203 |
| MR-32 | Feature aus/älterer Client: Entwürfe und Reviews bleiben erhalten, unbekannte Resolution-Zustände fail-closed | 1203 |

## 6. Testumgebung, Evidence und Rollout

- Für Laufzeittests nur den verwalteten Stack gemäß `canvas-local-team-seat-dev`
  verwenden; Notebook typischerweise `127.0.0.1:3100`. Den tatsächlich laufenden
  Commit/Build vor jedem Abnahmelauf mit dem getesteten Code abgleichen.
- Keine Container ohne explizite Freigabe bauen/starten; kein paralleler Teststack.
  Vor einem genehmigten Containerbuild muss `npm run build` bestehen. Einen alten
  Container nicht als Prüfung neuer Host-Codeänderungen ausgeben.
- Browsertests gemäß Repository-Regeln nur mit ausdrücklicher Freigabe ausführen.
  Der Plan ist keine Ausführungsfreigabe. Zwei echte Browserclients und reales
  PostgreSQL für Sync/Concurrency; PGlite-Tests getrennt kennzeichnen.
- Deterministische Vorschläge über den echten Agent-Tool-/Servicepfad vorbereiten;
  Auswertung, Rechte, Persistenz und Accept nicht mocken. Kein erreichbares KI-Modell
  als Voraussetzung für den Merge-Regressionstest. Modellintegration separat prüfen.
- Unit-/Propertytests, API-/Contracttests, reale PostgreSQL-/Yjs-Integration und
  Browser-End-to-End bilden getrennte Evidence-Ebenen. Pflicht-Skips, rote Tests
  und Infrastrukturblocker dürfen nicht als erfolgreiches Gesamtgate erscheinen.
- Evidence je Lauf: Commit, Build/Image, URL, Fixture-/Test-IDs, Soll/Ist, Ergebnisse,
  Screenshots/Trace bei Fehlern und redigierte Diagnose. Produktionsdaten nur nach
  gesonderter Berechtigung diagnostizieren; keine echten Reviews zu Testzwecken verändern.
- Freigabe gestuft: inaktive neue Schreibpfade → autorisierte Lese-/Auswertungsprüfung
  → P10-Canary → breiter P10-Rollout → separat P12-Canary. Kein Umgehen offener Gates
  durch einen Client-Schalter oder leere Env-Variable.
- Rollback deaktiviert neue Aktionen, erhält aber Artefakte, Entwürfe, History und
  Audit. Laufende Receipts werden vor Wiederfreigabe aufgelöst. Abhängige/aufgelöste
  Vorschläge dürfen nie wieder als unabhängige Legacy-Roots erscheinen.

## 7. Definition of Done

P10 ist fertig, wenn die 46 bestehenden Szenarien und MR-01 bis MR-24 mit exakter
Evidence bestanden sind, „10 → 3 → 7“ tatsächlich erfolgreich durchläuft und
Batchannahme plus verständliche Diagnose im globalen Center funktionieren.
P12 ist zusätzlich erst fertig, wenn MR-25 bis MR-32 samt vollständiger
P10-Regression bestanden sind und manuelle Konfliktauflösung dauerhaft,
wiederaufnehmbar und ohne Datenverlust funktioniert.

Vor Implementierungsänderungen: GitNexus-Upstream-Impact für betroffene Symbole,
HIGH/CRITICAL vorab melden. Vor jedem Commit: `detect_changes` und Diffprüfung.
Implementierungsgates benötigen Typecheck, Lint, fokussierte Tests und Build.
Für die vorliegende reine Planung genügen JSON-/Referenz-/Abhängigkeitsvalidierung
und Diffprüfung; sie rechtfertigen keine Aussage über bereits behobene Laufzeitfehler.
