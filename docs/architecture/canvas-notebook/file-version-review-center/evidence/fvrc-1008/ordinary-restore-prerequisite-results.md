# Restore darf verlorene Vorschlags-Voraussetzungen nicht wiederbeleben

Stand: 26. September 2026. Alle vier abschließenden Browserfälle bestanden.
Teilnachweis für PG-S11/MR-10 in FVRC-1008; keine Produktionsfreigabe.

## Umgebung

Unveränderter Produktcode `542c99dc2`, Testbasis `3c5dfc7f4`. Aktueller Worktree
auf Port 3000 mit echtem PostgreSQL 18.4/pgvector 0.8.3 des einzigen verwalteten
Team-Seat-Stacks. Personal und Team verwenden den Administrator. Der ältere
Notebook-Container auf 3100 zählt nicht als Nachweis für diesen Quellstand.
Kein Container, keine Runtime-Env, Dependency oder Produktfunktion wurde geändert.

Der Test verwendet `withOrdinaryAgentDocument` und `runOrdinaryAgentTool`.
Er erstellt und entfernt nur seine UUID-Markdown-Datei und Agentensitzung über
authentifizierte APIs. Review wird am standardmäßig ausgeschalteten Editor-
Toggle ausdrücklich eingeschaltet. Keine direkt eingesetzten Graphknoten,
kein LLM und keine künstlich freigeschalteten Workspace-/Lizenzrechte.

## Szenarien und feste Orakel

`tests/file-version-center-ordinary-restore.spec.ts` erzeugt zwei Vorschläge
vor der ersten Annahme. P1 setzt Kosten von 10 auf 12 EUR und fügt den Absatz
`Deckung: 100 EUR` ein. P2 liest den offenen P1-Kandidaten über das registrierte
`read`-Werkzeug und erweitert mit `edit_file` ausdrücklich dessen neue Block-ID
auf `Deckung: 150 EUR`. CAS-/Quellnachweis und explizite Abhängigkeit werden
vom gewöhnlichen Werkzeugpfad übernommen. Darstellung ist `tiptap_blocks`.

1. P1 wird im Browser angenommen. Exakter Text und eine neue Revision sind
   belegt. P2 ist anschließend `clean_rebased`, neu anzuwenden wäre nur P2.
   Dessen signierte Annahmevorbereitung wird für den späteren Stale-Test behalten.
2. Über den historischen Link und den tatsächlichen Restore-Dialog wird die
   ursprüngliche Version A wiederhergestellt. Der vollständige Inhalt entspricht
   exakt A, der Versicherungsabsatz fehlt. Genau eine weitere Revision entsteht.
3. Derselbe Restore-Auftrag wird per API identisch wiederholt. Er liefert
   `already_restored` mit demselben Ergebnis und erzeugt keine zusätzliche Revision.
4. P2 bleibt im Graph-Review `open`, P1 historisch `applied`. Status ist
   `prerequisite_lost`, Grund `PROPOSAL_PREREQUISITE_LOST`. Es gibt keine
   Annahmeaktion. Der Browser zeigt den konkreten Warnhinweis „Required basis
   is missing“, nicht den alten generischen Timeline-Fehler.
5. Der vor dem Restore gültige signierte Annahmeauftrag wird einmal per API
   gesendet. Erwartet werden HTTP 409 und `PROPOSAL_CURRENT_CHANGED`, unveränderte
   Datei und Revisionsanzahl. Browser-Aktionszähler zählen diesen bewussten
   API-Aufruf nicht mit; er wird getrennt geprüft.
6. In der zweiten Variante wird zusätzlich die historische P1-Version über den
   Browser restauriert und deren Wiederholung geprüft. Der Text stimmt wieder
   exakt mit dem angenommenen P1 überein. Der Versicherungsabsatz hat aber nicht
   die ursprüngliche Block-ID. P2 bleibt deshalb wegen verlorener Voraussetzung
   blockiert: Textgleichheit allein ist kein Nachweis für den alten Yjs-Bezug.

Beide Varianten prüfen die vollständigen geordneten Blocktexte und den Verlust
der alten Versicherungs-ID. Es gibt genau eine Browser-Annahme und je nach
Variante ein beziehungsweise zwei Browser-Restores, insgesamt +2 beziehungsweise
+3 Inhaltsrevisionen. Diagnose- und Ergebnisbelege enthalten keine signierten
Freigabetokens, Zugangsdaten oder Agentenausführungskontexte.

## Ergebnisse

Ein Worker, serielle Einzelfälle, Abstand zwischen den Logins. Das gemeinsame
Fixture meldet beobachtete Review-429-/5xx-Antworten als Fehler; jede direkt
aufgerufene API wird auf ihren erwarteten Status geprüft.

| Variante | Personal | Team |
|---|---|---|
| Ursprüngliche Version restaurieren | bestanden, 24,4 s | bestanden, 24,2 s |
| Danach gleichen P1-Text restaurieren | bestanden, 28,2 s | bestanden, 28,4 s |

Alle vier JSON-Belege wurden zusätzlich aus den HTML-Reports gelesen und
unabhängig geprüft: genaue Revisions-/POST-Anzahlen, Diagnose, Verlust der
alten Block-ID und durchgängige `priorRevisionId`-/`restoredRevisionId`-
Verkettung. Personal-/Team-Warnhinweise einschließlich Team-Roundtrip wurden
visuell kontrolliert. Kein Skip und kein beobachteter Review-429-/5xx-Fehler
in den abschließenden Läufen.

Reportmuster: `/tmp/fvrc1008-restore-{personal|team}-{original|equal}-r2-report/index.html`.
Logs und Artefaktverzeichnisse verwenden denselben Präfix. Der erste Personal-
Lauf (`r1`) bestand bereits Restore und Graph-Diagnose, scheiterte aber an einem
mehrdeutigen UI-Locator: derselbe Status steht im Badge und im Warnhinweis. Der
abschließende Test adressiert ausdrücklich `graph-review-blocked`. Kein
Produktcode wurde dafür geändert.

TypeScript und fokussiertes ESLint bestanden:
`/tmp/fvrc1008-restore-typecheck-final.log` und
`/tmp/fvrc1008-restore-lint-final.log`.
Der staged Test-Diff gegen `3c5dfc7f4` hat SHA-256
`a652e44480d381237f4ae7cd6adc1ad38b24f408779484cfbe1a1d650a22e9eb`.
Ein unabhängiger Quell-Review bestätigt die erwartete Trennung zwischen
historischem P1-Status und aktuell nachgewiesener Voraussetzung. Legacy-
Revalidierung nach Restore darf die exakte Graph-Auswahl nicht verdrängen;
dies wird mit API-Modus und tatsächlicher Graph-UI geprüft.

GitNexus wurde vollständig aktualisiert. Der geänderte Warnhinweis-Locator
betrifft einen Test-Aufrufer und keinen Produktprozess, Risiko niedrig. Auch
die staged Scopeprüfung findet keine betroffenen Produktprozesse. Der gesamte
Branchvergleich zu lokalem `main` bleibt kritisch: 166 Dateien, 1198 Symbole,
27 Prozesse bei dieser Prüfung. Die generierten `AGENTS.md`-/`CLAUDE.md`-
Änderungen bleiben außerhalb dieses Commits. Kein erneuter Produktbuild für
diese reinen Test-/Dokumentationsänderungen; der erfolgreiche Build der
unveränderten Produktbasis ist in `hardening-progress.md` protokolliert.

## Abgrenzung

Diese Fälle belegen eine beabsichtigte sichere Blockierung nach tatsächlichem
Restore, keinen erfolgreichen Konflikt-Merge und keine manuelle Auflösung.
Die erfolgreichen abhängigen Merges stehen separat in
`ordinary-dependent-merge-results.md`. Gleichzeitiges Restore/Accept über zwei
App-Prozesse, Abstürze an Restore-Persistenzgrenzen und eine komplette
Undo-/Redo-Matrix sind hiermit nicht abgedeckt. Der vollständige FVRC-1008-Gate,
zwei vollständige Matrixläufe, frisches Produktionsimage und P12 bleiben offen.
Kein Push, keine Produktionsaktivierung.
