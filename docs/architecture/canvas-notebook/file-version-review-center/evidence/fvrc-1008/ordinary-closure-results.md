# Gemeinsame Voraussetzungen und dreistufige Vorschlagsketten

Stand: 26. September 2026. Zehn bestandene Browserfälle für PG-S07/MR-11/MR-12 in FVRC-1008;
kein vollständiges Gate und keine Produktionsfreigabe.

## Umfang und Umgebung

Produktbasis `dbdfcae3b`. Nur neue Tests und Evidence; kein Produktcode,
Dependency-, Env- oder Containerwechsel. Der Host-Dev-Server auf Port 3000 läuft
aus dem aktuellen Worktree mit echtem PostgreSQL 18.4/pgvector 0.8.3 des einzigen
verwalteten Team-Seat-Stacks. Alle vier Dienste waren gesund. Das ältere
Notebook-Image auf Port 3100 zählt nicht als Nachweis für diesen Quellstand.

`tests/file-version-center-ordinary-closure.spec.ts` verwendet die gemeinsamen
authentifizierten Fixtures und gewöhnlichen registrierten `read`-/`edit_file`-
Werkzeuge in eigenen Prozessen. Review wird am standardmäßig ausgeschalteten
Editor-Toggle ausdrücklich eingeschaltet. Keine direkt eingesetzten
Graphknoten und kein LLM. Beide Workspace-Varianten verwenden den Administrator.

## Szenarien und feste Orakel

Ausgang A: Kosten 10 EUR, Lieferzeit 5 Tage. P1 schlägt Kosten 12 EUR vor und
fügt einen neuen Absatz `Deckung: 100 EUR` ein. P2 liest ausdrücklich den
offenen P1-Kandidaten und bearbeitet dessen neue Block-ID auf Deckung 150 EUR.
Alle Vorschläge entstehen vor der ersten Annahme; Darstellung ist nachweislich
`tiptap_blocks` und die Live-Datei bleibt bis dahin unverändert.

| Variante | Dritter Vorschlag | UI-Annahmen | Fester Endzustand | Inhaltsrevisionen |
|---|---|---|---|---|
| `fork-batch` | P3 hängt ebenfalls von P1 ab; Lieferzeit 5 → 3 Tage | Alle drei gemeinsam | Kosten 12, Deckung 150, Lieferzeit 3 | +1 |
| `fork-parent-first` | Wie oben; beide Kinder haben denselben Parent | P1, dann beide verbleibenden Vorschläge gemeinsam | Kosten 12, Deckung 150, Lieferzeit 3 | +2 |
| `chain-batch` | P3 liest P2 und ändert dessen Deckung 150 → 175 EUR | Alle drei gemeinsam | Kosten 12, Deckung 175, Lieferzeit 5 | +1 |
| `chain-leaf` | Gleiche dreistufige Kette | Nur P3 auswählen und inklusive P1/P2 annehmen | Kosten 12, Deckung 175, Lieferzeit 5 | +1 |

Jeder Fall prüft getrennt:

- Explizite Quellbeziehungen mit Parent-CAS/Hash; keine Ersetzung oder
  exklusive Auswahlgruppe. Alle drei Vorschlags-IDs sind unterschiedlich.
- Leaf-Auswahl per Review-API und tatsächlich über die UI gewählte Menge.
  Die gemeinsamen Voraussetzungen sind dedupliziert und die Anwendungsmenge
  enthält nur noch offene Vorschläge.
- Den tatsächlichen signierten UI-Aktionsauftrag: exakte Auswahl,
  Voraussetzungsmengen und Anwendungsmenge. Unabhängige Geschwister werden
  ohne unbegründete Sortierungsannahme verglichen.
- Exakte betroffene IDs und Abschlusszustände im dauerhaften Aktionsbeleg.
  Bei P1-zuerst enthält der zweite Beleg P1 weiterhin in der geprüften Menge,
  aber nicht nochmals in Anwendung oder Abschlussauflösungen. Bei P3-allein
  werden P1/P2 `included`, P3 `applied`; bei Gesamtauswahl sind alle `applied`.
- Identischer Retry jedes Aktionsauftrags liefert denselben Beleg. Kein
  zweiter Inhaltseffekt und keine zusätzliche Revision.
- Vollständige feste Markdown-Zwischen-/Endtexte, unveränderte originale
  Block-IDs und Reihenfolge sowie dieselbe neue Deckungs-ID über alle Ebenen.
- Geschlossene Vorschläge haben keine weiteren Annahmeaktionen. Der exakte
  historische P1-Link bleibt `Applied` beziehungsweise `Included`, ohne
  stillen Wechsel auf einen Nachfolger.

`clean_rebased` bei den Geschwistern ist korrekt: Der zweite Geschwister-Edit
wird auf den bereits mit dem ersten Geschwister-Edit zusammengesetzten
Vorschaustand angewendet. Dafür muss noch keine Live-Annahme erfolgt sein.
Die lineare Kette komponiert exakt ihre jeweiligen Quellen und ist `clean`.
Der erste Lauf hatte eine zu enge `clean`-Testerwartung; sie wurde nach Prüfung
der Composer-Implementierung korrigiert. Kein Produktfix war dafür notwendig.

## Läufe

Ein Worker, serielle Einzelfälle mit Abstand. Der gemeinsame Fehlerbeobachter
macht beobachtete Review-429-/5xx-Antworten zum Testfehler; alle direkt verwendeten
APIs werden auf den erwarteten Status geprüft. Berichte unter
`/tmp/fvrc1008-closure-{personal|team}-{variante}-r2-report/index.html`.

| Variante | Personal | Team |
|---|---|---|
| `fork-batch` | bestanden, 41,0 s | bestanden, 31,2 s |
| `fork-parent-first` | bestanden, 34,9 s | bestanden, 35,1 s |
| `chain-batch` | bestanden, 31,7 s | bestanden, 31,4 s |
| `chain-leaf` | bestanden, 30,6 s | bestanden, 30,2 s |

Die JSON-Belege enthalten nur Ziel-/Vorschlags-/Block-Identitäten, feste
Erwartungen, Revisions-/POST-Anzahlen und Ergebnisse – keine signierten
Freigaben, Secrets oder Agentenausführungskontexte. Alle acht positiven
Belege wurden unabhängig aus den HTML-Reports geprüft: exakte Abschlussmengen,
eindeutige Revisions-IDs und +1/+2 Revisionen. Die Personal-Geschwister- und
Team-Kettenvorschau wurden zusätzlich visuell kontrolliert.

Der unabhängige Subagenten-Review hat Quelltext und Orakel geprüft, nicht selbst
die Browserläufe ausgeführt. Er fand keine konkrete falsche Erwartung in den
Auswahl-/Voraussetzungs-/Anwendungs- und Abschlussmengen.

## Inkompatible Geschwister: separate Negativprüfung mit anschließendem Merge

`tests/file-version-center-ordinary-sibling-conflict.spec.ts` ergänzt den
atomaren Gegenfall in Personal und Team. Hier ändert P1 nur Kosten 10 → 12 EUR.
P2 und P3 hängen ausdrücklich von P1 ab, ändern aber dieselbe originale
Lieferzeit-Block-ID von 5 auf 3 beziehungsweise 2 Tage.

Die Gesamtprüfung muss `conflicted`/`PROPOSAL_BATCH_CONFLICT` liefern, ohne
Annahmefreigabe, ohne Aktions-POST aus der UI und ohne Inhalts-/Revisionsänderung.
Insbesondere darf der konfliktfreie P1-Anteil nicht vorzeitig übernommen werden.
Danach wird P2 ausdrücklich neu geöffnet und mit eigener Vorschau/Freigabe
angenommen: P1 wird einmal `included`, P2 `applied`, P3 bleibt offen. Der feste
Endtext enthält Kosten 12 EUR und Lieferzeit 3 Tage, mit originalen Block-IDs
und genau einer neuen Revision. P3 bleibt anschließend konkret als
`conflicted`/`PROPOSAL_BATCH_CONFLICT` sichtbar und nicht annehmbar. Da P1s
Kostenänderung erhalten bleibt, handelt es sich nicht um verlorene Voraussetzung.

Beide ergänzenden Browserfälle bestanden auf dem endgültigen Testquellstand:
Personal in 29,5 s, Team in 30,0 s. Berichte:
`/tmp/fvrc1008-sibling-conflict-{personal|team}-r4-report/index.html`.
Die beiden JSON-Belege wurden unabhängig aus den Reports geprüft: konkrete
Konfliktzustände, exakte Abschlussmengen und genau eine Inhaltsrevision. Die
Personal-Konfliktansicht wurde visuell geprüft: konkrete Konfliktmeldung,
ausklappbare Diagnose, kein Sammel-Annehmen und kein Legacy-Timeline-Fehler.
Der abschließende unabhängige Quell-Review fand keine wesentliche falsche
Erwartung oder fehlende Assertion. Er hat nicht selbst Browserläufe ausgeführt.

Die ersten beiden Personal-Versuche stoppten beim Anlegen des zweiten Kindes:
Der Test hatte denselben ausgewerteten P1-Quellbeleg wiederverwendet. Das erste
Kind erhöht die Graph-Revision; deshalb verweigert der Server den veralteten
Beleg korrekt mit `PROPOSAL_PARENT_CHANGED`. Der Test liest jetzt vor jedem
Kind ausdrücklich P1 neu, prüft dieselbe Parent-ID und denselben ursprünglichen
Kandidatenhash sowie feste Block-IDs/-Inhalte. Er wechselt weder die gemeinsame
Basis noch schwächt er die Serverprüfung ab. Kein Produktfix war notwendig.
Der unabhängige Subagent hat diese Ursache und Testkorrektur bestätigt.
Der folgende Lauf erreichte den korrekten blockierten Batch, den erfolgreichen
Einzel-Merge und den weiter offenen Konflikt. Er scheiterte erst an der
Testerwartung, dass die Kontextmenge des offenen Geschwisters auch jeden bereits
geschlossenen Geschwisterknoten enthalten müsse. Abschlusszustände werden jetzt
über die jeweilige exakte Operation geprüft, einschließlich fehlender Aktionen
bei abgeschlossenen Vorschlägen. Auch hierfür wurde kein Produktcode geändert.

TypeScript ohne inkrementellen Cache, fokussiertes ESLint und Diff-Prüfung
bestanden. Ebenfalls grün: `test:proposal-graph:model`,
`test:proposal-graph:candidates`, `test:proposal-graph:orchestrator`.
Die Orchestrator-Storage-Prüfung verwendet isoliertes PGlite und wird nicht als
echter PostgreSQL-Nachweis bezeichnet; die Browserfälle verwenden den echten
verwalteten PostgreSQL-Stack. Logs: `/tmp/fvrc1008-closure-typecheck-final3.log`,
`/tmp/fvrc1008-closure-lint-final3.log`,
`/tmp/fvrc1008-closure-domain-regression.log`.

Die zehn abschließenden Einzelfälle liefen ohne Skip und ohne beobachteten
Review-429-/5xx-Fehler. SHA-256 der ausgeführten, danach unveränderten Tests:

- `file-version-center-ordinary-closure.spec.ts`:
  `5d336efcda7cb356bf0cced549a8c57f4f2188a4a127bd7a9ddba012edeec622`
- `file-version-center-ordinary-sibling-conflict.spec.ts`:
  `ae9624464053c2a8ba84c89a9e1f24fd8099902a65112afb3e936dc927ed6136`

Kein neuer Anwendungsbuild für dieses reine Test-/Dokumentationspaket;
der erfolgreiche Produktbuild der Basis ist im vorherigen Detach-Nachweis
dokumentiert. Der GitNexus-Index wurde erfolgreich vollständig erneuert.
Die abschließende staged Prüfung meldet fünf erwartete Test-/Dokumentationsdateien,
39 Symbole, keine betroffenen indexierten Produktprozesse und niedriges Risiko.
Der gesamte Branchvergleich zu lokalem `main` bleibt kritisch: 171 Dateien,
1259 Symbole und 27 betroffene Prozesse. Dieses kleine Testpaket ist deshalb
keine Freigabe für den gesamten Branch. Generierte `AGENTS.md`-/`CLAUDE.md`-
Indexzähler bleiben außerhalb des Commits.

## Grenzen

Diese Fälle prüfen kompatible gemeinsame Vorfahren, dreistufige Ketten,
atomare Verweigerung inkompatibler Geschwister und die danach ausdrücklich
neu geprüfte Annahme eines einzelnen Kindes einschließlich seiner Voraussetzung.
Sie sind kein beliebiger Mehrfachauswahl- oder manueller Konflikteditor-Nachweis.
Exklusive Alternativen mit gemeinsamen Vorfahren, die vollständige
Liste-/Marks-/GC-/Restart-Matrix, zwei vollständige Gesamtmatrixläufe und ein
frisch gebautes Produktionsimage sind damit nicht pauschal abgenommen.
FVRC-1008 bleibt in Arbeit; P12 bleibt nachgelagert. Kein Push und keine
Produktionsaktivierung.
