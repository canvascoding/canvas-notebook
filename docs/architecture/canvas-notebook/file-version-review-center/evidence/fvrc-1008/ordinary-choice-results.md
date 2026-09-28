# Gewöhnliche Alternativen und Ersetzungen

Stand: 26. September 2026. Produktbasis `7bbb4cce8`; Ergänzung innerhalb von
FVRC-1008, keine vollständige Abnahme oder Produktionsaktivierung.

## Gefundene Lücken und Korrektur

Die gewöhnlichen Agentenwerkzeuge verstanden bereits die expliziten
`alternative_to`-/`existing`-/`replaces`-Verträge, der Runtime-Adapter übergab
aber keine Relationship-Policy. Die bisherige positive Auswahlgruppen-Fixture
legte ihre Gruppen gesondert an; sie bewies nicht diesen Authoring-Pfad.

Der Runtime-Adapter verwendet jetzt eine gemeinsame Domain-Policy innerhalb
der vorhandenen Provenance-/Operations-SQL-Transaktion. Sie prüft Scope,
Lebenszyklus, Ziel-CAS, Kandidatenhash, genaue Voraussetzung, Gruppenrevision
und frische Verwaltungsrechte. Ersetzungen behalten Voraussetzung und Gruppe;
sie werden nicht zu Kindern des ersetzten Vorschlags. Der allgemeine
Provenance-Service bleibt ohne injizierte Policy weiterhin fail-closed.

Der erste echte PGlite-Lauf fand zusätzlich die unmittelbare Foreign-Key-Grenze:
Ein neuer Vorschlag kann seine Auswahlgruppe nicht referenzieren, bevor deren
Zeile existiert. Ein optionaler `beforeInsert`-Schritt legt deshalb zunächst
die Gruppe mit ihrem bestehenden Ziel an; anschließend werden der neue Node
und seine Mitgliedschaft ergänzt und der vollständige Graph validiert. Dieser
temporäre Ein-Mitglied-Zustand wird nie separat committed. Der Zielvergleich
erlaubt ausschließlich den eigenen CAS-Schritt und die eigene Gruppenzuordnung;
andere zwischenzeitliche Änderungen werden nicht toleriert.

Die begrenzte aktive Projektion darf abgeschlossene Mitglieder ausblenden.
`putChoiceGroup` erhält deren dauerhafte Mitgliedschaftszeilen und prüft unter
dem Graph-Lock die exakte ausgelassene Anzahl, terminalen Lebenszyklus sowie
passende Gruppe/Voraussetzung. Offene, fehlende oder widersprüchliche Mitglieder
dürfen nicht als archiviert ausgegeben werden.

## Browseraufbau und feste Orakel

`tests/file-version-center-ordinary-choices.spec.ts` verwendet registrierte
`read`-/`edit_file`-Werkzeuge in eigenen Prozessen, reale APIs und PostgreSQL
des einzigen verwalteten Team-Seat-Stacks. Keine direkt eingesetzten
Proposal-Nodes oder Auswahlgruppen, kein LLM. Neues Dokument: Review zunächst
aus, dann ausdrücklich am Editor-Toggle eingeschaltet; `tiptap_blocks`.

Getestet wird der aktuelle Host-Dev-Quellstand auf **127.0.0.1:3000**, nicht
das ältere Notebook-Image auf **3100**. Alle vier verwalteten Dienste waren
gesund. Keine Env-/Dependency-/Containeränderung; beide Workspace-Varianten
nutzen den Administrator. Isolierte UUID-Dateien und Agent-Sessions werden
nach dem Fall entfernt.

Ausgang: Kosten 10 EUR, Lieferzeit 5 Tage, Deckung 100 EUR.

- P1: Kosten 12 EUR.
- P2 und A lesen jeweils frisch P1. P2: Lieferzeit 3 Tage; A: 2 Tage und
  ausdrücklich Alternative zu P2.
- D liest P2: Deckung 150 EUR. E liest A: Deckung 175 EUR.

Die gezielte gemischte Auswahl D+A ist per API blockiert. Auch „Review all
changes“ mit allen fünf Vorschlägen bietet keine Annahme an: kein Aktions-POST,
kein Inhaltswechsel, keine Revision, insbesondere keine Teilübernahme von P1.

| Variante | Entscheidung | Festes Ergebnis | Abschluss |
|---|---|---|---|
| `choose-descendant` | Nur D bestätigen | Kosten 12, Lieferzeit 3, Deckung 150 | P1/P2 `included`, D `applied`, A `alternative_not_selected`, E offen und `blocked_by_parent` |
| `replace-then-reject` | R ersetzt P2 auf Basis P1 und behält Gruppe; R ablehnen; anschließend nur E bestätigen | Kosten 12, Lieferzeit 2, Deckung 175 | P2 bleibt `superseded`, R `rejected`, D offen/blockiert, P1/A `included`, E `applied` |

Beide Varianten erzeugen genau **eine** Inhaltsrevision. Ersetzen und Ablehnen
ändern davor keinen Dokumentinhalt und erzeugen keine Inhaltsrevision. Die
bestätigte Aktion bindet exakte ausgewählte, erforderliche, anzuwendende und
zu schließende IDs. Dauerhafte Belege prüfen deren genaue Abschlussmenge.
Identische Aktions-Retries liefern denselben Beleg, ohne zweiten Effekt.
Der Ersetzungsfall wiederholt außerdem denselben gewöhnlichen Tool-Aufruf.
Originale Block-IDs, Blockreihenfolge, vollständiger Endtext und historische
Zustände werden separat geprüft. Geschlossene Vorschläge haben keine Aktionen.

## Laufnachweise

Ein Worker, serielle Einzelfälle mit 55 Sekunden Abstand; der gemeinsame
Fehlerbeobachter behandelt beobachtete Review-429/5xx als Testfehler.
Berichte: `/tmp/fvrc1008-choices-{personal|team}-{choose|replace}-r1-report/index.html`.

| Variante | Personal | Team |
|---|---|---|
| `choose-descendant` | bestanden, 44,4 s | bestanden, 43,1 s |
| `replace-then-reject` | bestanden, 56,3 s | bestanden, 56,3 s |

Die Personal-Auswahlvorschau und die blockierte Sammelauswahl wurden visuell
geprüft: sichtbare Voraussetzungen und Abschluss der Alternative, konkrete
Konfliktmeldung, ausklappbare Diagnose, keine Legacy-Timeline-Fehlerschleife.
Auch die Team-Ersetzungsvorschau wurde visuell geprüft: der ersetzte Parent
bleibt im Kontext, sein blockiertes Kind ist erkennbar und die andere
Alternative erhält eine eigene Annahmevorschau. Alle vier Fälle bestanden
ohne Skip und ohne beobachteten Review-429/5xx-Fehler.
Die vier `ordinary-choice-evidence.json`-Anhänge wurden zusätzlich direkt aus
den eingebetteten ZIP-Daten der HTML-Reports ausgelesen und nachgeprüft:
fester Endtext, genau eine Revision, ein beziehungsweise zwei UI-Aktions-POSTs,
exakte Abschlussanzahl und `content_changed`. Der unabhängige Test-Quellreview
fand keine blockierenden Mengen-/Orakelfehler; er hat selbst keine Browserläufe
gestartet und die eingebetteten JSON-Anhänge nicht verifiziert.

Die ausgeführten Produktdateien und der Browserfall blieben danach unverändert.
SHA-256:

- `proposal-tool-relationships.ts`: `8334baf98d20c88fd8bf7de8c943c3fd2d953badba0b2b6454fd6fe703be3cac`
- `proposal-provenance-service.ts`: `ff73d8b93fbfffcaaf9ce5e86ab6540c535834f26e0c39bb4e4da315a3c2644a`
- `proposal-agent-runtime.ts`: `2abe94fc9e1147c683ee35cc8a88bbc5268c09cc1fc03eb809c022b7232ec540`
- `proposal-storage.ts`: `274da25a1722bec3df0600c68d305374178b55068c692a4ce5d07995a49d4f14`
- `file-version-center-ordinary-choices.spec.ts`: `86a7ca85dd92fc59da9838fee2d1ee50048b924a9c8c66da259089e619c85a65`

## Datenbank- und Regressionsprüfungen

`npm run test:proposal-graph:tool-relationships` prüft 14 Gruppen gegen
isoliertes **PGlite** mit echten Migrationen, Operation-/Graph-/Artefaktzeilen
und Transaktionen. Authentifizierung und Live-Grenze sind im Harness
kontrolliert; dies wird nicht als echter PostgreSQL-Prozesslauf bezeichnet.

Zusätzlich zu Anlage, bestehender Gruppe, Ersetzung, Ablehnung und Retry werden
veraltete CAS/Hashes/Gruppenrevisionen, fremde Quellen, entzogene Verwaltungsrechte
unmittelbar vor `beforeInsert`/`apply`, Fehler nach Gruppenanlage und nach
Ersetzung sowie manipulierte Archivangaben geprüft. Vollständige relevante
SQL-Snapshots einschließlich Graphrevision/Reservierung müssen bei Fehlern
gleich bleiben. Live-Yjs-Inhalt bleibt während sämtlicher Vorschlagsanlagen
unverändert. Die Suite ist auch in `test:proposal-graph:tools` eingebunden.

Der vollständige Tools-Lauf und die nachgeschärften 14 Gruppen sind grün;
Logs: `/tmp/fvrc1008-choices-tools-final.log` und
`/tmp/fvrc1008-choices-relationships-final.log`. Die Archiv-Negativprüfung wurde
gezielt so geschärft, dass ein korrekt gezähltes ausgelassenes **offenes**
Mitglied am Lebenszyklusschutz scheitert und nicht bereits am Zählfehler.

Ebenfalls bestanden: Storage, aktive Projektion, Orchestrator, Graphmodell,
Fences und `test:proposal-graph:review-actions` (letzteres protokolliert in
`/tmp/fvrc1008-choices-review-actions-r1.log`). Vorhandene isolierte Auth-/Base-URL-
Warnungen dieser Node-Harnesses sind kein Browser- oder Provider-Erfolgsbeleg.
Ein unabhängiger Subagenten-Quellreview fand keine konkrete Sicherheits- oder
Idempotenzlücke im FK-Ordnungsfix und in der Archivbehandlung.

`npm run build` besteht mit 353 generierten Seiten
(`/tmp/fvrc1008-choices-build-r1.log`). Vollständiges `npm run lint` besteht mit
sieben vorhandenen Warnungen außerhalb der geänderten Dateien und null Fehlern
(`/tmp/fvrc1008-choices-full-lint-r1.log`); fokussierter ESLint ist warnungsfrei.
TypeScript ohne inkrementellen Cache und `git diff --check` bestehen ebenfalls.
Logs: `/tmp/fvrc1008-choices-typecheck-final.log` und
`/tmp/fvrc1008-choices-lint-final.log`. Der Build wurde nicht in ein neues
Containerimage überführt.

Der vollständig erneuerte GitNexus-Index meldet für das staged Paket zehn
erwartete Dateien, 84 Symbole, einen betroffenen Anlageprozess und mittleres
Risiko. Der gesamte Branchvergleich zu lokalem `main` bleibt kritisch:
175 Dateien, 1331 Symbole und 27 Prozesse. Das Einzelpaket ist deshalb keine
Merge-/Produktionsfreigabe des Gesamtbranches. Generierte `AGENTS.md`-/
`CLAUDE.md`-Indexzähler bleiben außerhalb des Commits.

## Grenzen

PG-S08/09/10 und MR-11 werden nur für die beschriebenen Orakel nachgewiesen.
Diese ausdrücklich exklusiven Alternativen sind nicht mit gewöhnlichen
kollidierenden Geschwistervorschlägen gleichzusetzen: Letztere bleiben nach
der ersten Annahme offen und konflikthaft, statt automatisch geschlossen zu
werden. Dafür gilt der separate `ordinary-closure-results.md`-Nachweis.

Manuelle Konfliktauflösung ist weiterhin P12. Zwei vollständige Matrixläufe,
weitere Rechte-/Race-/Restart-/Rich-Text-Varianten und das frisch gebaute
Produktionsimage sind durch dieses Paket nicht pauschal abgenommen.
FVRC-1008 bleibt `in_progress`; kein Push, Containerneubau oder Rollout.
