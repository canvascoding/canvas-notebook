# FVRC-1006 – Graph-Review, Einzelannahme und Sammelannahme

Stand: 26. September 2026, 09:06 UTC. **FVRC-1006 abgeschlossen.**
Verbindlicher Status: [todo.json](../../todo.json), `done` für diesen Arbeitsschritt.
FVRC-1007/1008 und der manuelle Konflikteditor FVRC-1200..1203 sind nicht abgeschlossen.

## Umgebung und Testgrenzen

- Isolierter Worktree `review-conflict-resolution/canvasstudios-notebook`,
  Branch `codex/review-conflict-resolution-20260925`, Basis `d792e987c`
  (damaliges origin/main), Plan-Commit `84a91374f`, letzter Commit `182ccbf4a`.
  Die folgenden Nachweise prüfen den Inhalt des FVRC-1006-Commits, der diesen
  Evidence-Stand enthält. Die Testläufe fanden vor seinem Commit statt.
- Getesteter Host-Dev-Server: **http://127.0.0.1:3000**,
  Marker `fvrc1006-182ccbf4a-dirty-r3`, HMR aus diesem Worktree.
  **Der bestehende Container auf 3100 ist nicht dieser Teststand.**
- Einziger verwalteter Team-Seat-Stack gemäß `canvas-local-team-seat-dev`:
  PostgreSQL auf 55433, bestehende Control-Plane-Dienste. Keine zweite Umgebung,
  kein Container-Neubau, kein Push und keine Produktionsaktivierung.
- Schreibfreigabe nur lokal durch `CANVAS_PROPOSAL_REVIEW_LOCAL_TEST=1`.
  Der Produktionspfad bleibt bis FVRC-1008 gesperrt.
- Browser: reale Anmeldung, Upload-/Collaboration-APIs, Proposal-Service,
  PostgreSQL, Yjs und normale Review-Aktionen; kein gemocktes Merge-/Apply-Ergebnis.
  Eigene UUID-Dateien werden anschließend entfernt. Die Rechte-Suite nutzt
  ausschließlich einen neu angelegten eigenen Team-Workspace.
- Deterministische Vorschlagserzeugung ohne KI-Provider. Exklusive Choice-Gruppen
  werden über den echten Storage-Vertrag eingerichtet. Das belegt Review/Apply,
  **nicht** die spätere Aktivierung gewöhnlicher Agenten-Tools in FVRC-1008.
- Ein Browser-Worker, 65 Sekunden Abstand zwischen Fällen, Abbruch beim ersten
  Fehler. Produktionslimits bleiben unverändert. Alle Graph-Suites lassen
  Hintergrundantworten der Proposal-Endpunkte mit HTTP 500+ oder 429 fehlschlagen.
- Screenshots werden zusätzlich visuell geprüft. Accessibility-Nachweise umfassen
  DOM-Semantik, Tastatur, Touch, Fokus und Reduced Motion; kein manueller
  Screenreader-Lauf. Der 200-%-Layoutfall emuliert CSS-Viewport/Pixeldichte,
  nicht die native Zoom-Bedienung des Browsers.

## Behobene Produktfehler

1. **Authentifizierte Review-Aktion:** Nutzerannahmen verwenden die tatsächliche
   serverseitige Reviewer-Session. Actor-/Session-Angaben des Clients ersetzen
   keine Autorisierung. Closure, Scope und aktuelle Rechte werden erneut geprüft.
2. **Dauerhafter Dateistand:** Commit `182ccbf4a` liest den persistierten Yjs-Stand.
   Eine verzögerte Dateiprojektion erzeugt beim Lesen keine alten/neuen/alten
   Historieneinträge. Inhaltsrevisionen gehören zum Schreib-/Checkpoint-Pfad.
3. **Sichere Recovery:** Vor Mutationsbeginn nachweislich gescheiterte Verbindungen
   gelten als nicht angewendet. Nach Mutationsbeginn bleibt eine unbestätigte
   Aktion in Recovery. Metadatenabschlüsse sind ebenfalls wiederaufnehmbar.
   Ein bestätigter Recovery-Abschluss sperrt die alte Freigabe sofort.
4. **Historische Vorschläge:** Exakte Links auf geschlossene Vorschläge bleiben
   berechtigt lesbar, ohne Accept-/Reject-Aktionen für abgeschlossene Originale.
5. **PostgreSQL-Deadlock:** Review, Aktionen und Vorschlagserzeugung sperren
   einheitlich Lineage → Dokument → Yjs-State. Scope-/Lifecycle-Prüfungen bleiben
   erhalten. Der reale Zwei-Verbindungs-Locktest besteht.
6. **Redigierte Diagnose:** Grund, Phase, Zeit, Korrelationsreferenz und Build sind
   auch bei Fehlern sichtbar/kopierbar. Kein Inhalt, privater Pfad, Fence-Token
   oder SQL-Exception-Text im UI-Befund; Serverlog und UI teilen eine Prüf-ID.
7. **Aktuelle Auswertung:** Karten und Vergleich unterscheiden Inhaltskonflikt,
   fehlende Voraussetzung, fehlende Grundlage, Transportfehler und bestätigten
   No-op. Genau ein automatischer Retry bei überholtem Current-/Graph-Proof;
   kein unbegrenzter Refresh und kein automatischer Retry bei HTTP 429.
8. **Zugriffsverlust:** Timeline und Vergleich werden bei 401/403/404 verworfen;
   ein vorübergehender Transportfehler wird davon getrennt.
9. **Timeline-Pagination:** Current bleibt auf der ersten Standardseite auch bei
   mehr als 24 Reviews sichtbar. Cursor verhindern Duplikate. Alte Cursor bleiben
   kompatibel; Seitenlimit 1 läuft bis zum Ende statt Current endlos zu wiederholen.
10. **No-op-Abschluss:** `empty_effect` und `satisfied_elsewhere` sind konsistent
    als expliziter Metadatenabschluss erlaubt, nur mit erforderlichen Nachweisen.
    Keine leere Inhaltsrevision; fehlende Witnesses bleiben abgewiesen.
11. **Mobile/Fokus:** Lange Aktionslabels umbrechen. Nutzerinitiierte Vorschau und
    Bestätigung erhalten Fokus; Hintergrundupdates sollen ihn erhalten.
    Der Dialog animiert nur Opazität/Transformation, nicht seine Viewport-Kanten:
    die bisherige `transition: all` verschob bei 320 px kurzfristig Buttons aus
    dem sichtbaren Bereich. Der reale Bounds-Test besteht nach dem Fix zweimal.
12. **Gleiche Rechte in Liste und Detail:** Aktive Vorschläge werden nach derselben
    Owner-/Workspace-Manager-Regel gefiltert wie ihre Detailansicht. Fremde
    Vorschläge erzeugen so keine Summary-404, die die erlaubte Dokumentansicht
    irrtümlich verschwinden lässt. Current und Revisionen bleiben lesbar.
13. **Fokus bei Peer-Annahme:** Während einer frischen Auswertung bleibt allein
    die strukturelle Root-Zuordnung innerhalb derselben Nutzer-/Workspace-/
    Dokumentidentität erhalten. Das verhindert das Remounten der fokussierten
    Kindkarte. Alte Status-, Diff- oder Aktionsnachweise werden nicht übernommen.
    Komponentenregression und echter Zwei-Client-Fall bestehen.
14. **Mobile Lesefläche:** Der Vergleich verwendet unterhalb des Desktop-
    Breakpoints natürlichen Inhaltsfluss statt einer zusammenschrumpfenden
    inneren Flex-Fläche. Der äußere Dialogbereich scrollt; der Desktop behält
    seinen getrennt scrollbaren Vergleich. Mindestens 192 px tatsächlich
    sichtbarer Vergleichsbereich werden mit allen Overflow-Vorfahren gemessen,
    auch bei geöffneter Annahmebestätigung. Beide Layoutfälle bestehen zweimal.

## Bestandene Browserfälle

Einzelne Reports liegen lokal unter `/tmp`; sie sind keine Produktionsfreigabe.
Die Liste ersetzt frühere grüne Zwischenläufe, die noch Hintergrundfehler hatten.

| Fall | Festes Orakel | Aktuell belegter Lauf |
|---|---|---|
| C zuerst, danach B | Text 130, B schon vor Auswahl als Konflikt, keine +0/−0, genau +1 Revision | `final-r14-bc-c`, 9,0 s |
| B zuerst, danach C | Text 120, C entsprechend im Konflikt, genau +1 Revision | `final-r9-bc-b`, 9,7 s |
| Alle zehn unabhängig | Text A1..J1, eine Batch-Aktion, genau +1 Revision | `final-r9-all10`, 8,4 s |
| Personal: drei einzeln + sieben gemeinsam | Text A1..J1, vier Receipts, genau +4 Revisionen | `final-r14-personal`, 17,0 s |
| Team/Organization: drei + sieben | Gleiche Bytes und exakt +4 Revisionen | `final-r9-team`, 17,7 s |
| 26 über mehrere Seiten, 27. später | Current sichtbar; genau ursprüngliche 26 ausgewählt; 27. bleibt offen; ein Batch/+1 Revision | `final-r9-page26`, 15,5 s |
| B-Antwort verspätet, inzwischen C ausgewählt | C bleibt ausgewählt, nur C wird bestätigt, genau +1 Revision | `final-r8-delayed`, 6,0 s |
| Verspätete Antwort über Datei-/Workspace-Wechsel | Tatsächlicher Personal→Team-Wechsel über Notebook; altes B überschreibt C nicht; nur C schreibt +1, Personal unverändert | `navigation-r17`, 10,4 s |
| Team-Rechte | Eigene/Manager-Sicht korrekt; gespeicherter Write-Fence nach Downgrade abgewiesen; Read-only weiter lesbar; Cache nach Read-Entzug entfernt | `final-r14-permissions`, 9,8 s |
| Gleiche unabhängige Wirkung | Zweiter Vorschlag nachweislich enthalten; expliziter Metadatenabschluss, keine neue Revision | `final-r7-same-effect`, 7,5 s |
| Detach / Replace | Neue Vorschläge ohne sofortige Live-/History-Mutation; erst separate Annahme schreibt +1 Revision | `final-r6-detach` / `replace`, 16,4 / 18,5 s |
| Kind mit Parent und Alternativabschluss | Ein gemeinsamer Effekt/+1 Revision; nicht gewählte Alternative zu, historische Links lesbar | `final-r6-flow-child`, 8,1 s |
| Parent zuerst, dann Kind | Parent +1; Kinder offen; Kind zeigt Restdiff A1\|B0→A1\|B1; danach insgesamt +2 | `final-r6-flow-parent`, 9,8 s |
| Zweig ablehnen | Parent und abhängige Alternativen zu, keine Inhaltsrevision | `final-r6-flow-reject`, 6,7 s |
| Apply-Antwort verloren | Schließen/Wiederöffnen, Status-Recovery, genau ein POST/+1 Revision | `final-r6-flow-recovery`, 8,0 s |
| Parent-Annahme im zweiten Client, danach Peer-Edit | Kind bleibt ausgewählt/fokussiert; exakter Restdiff; anschließend konkrete Kollision und keine alte Freigabe | `u02-r12`, 14,1 s |
| Peer + späte Offline-Änderung | Freigabe invalidiert; zusätzlicher Edit nach HTTP-, vor Collaboration-Reconnect; Bytes nach Reconnect/Reload exakt erhalten | `final-r14-late-peer`, 18,0 s |
| 320/390/768/1280 px | DE/EN, Light/Dark, Tastatur/Touch, Scrolltrenner, Pane-/Button-Grenzen; ≥192 px wirklich sichtbarer mobiler Vergleich | `natural-flow-r15` / `r16`, jeweils 2/2 mit Deep, 19,7 / 18,1 s |
| Sechs Ebenen | Branch-/Timeline-Scrollbewegung, kein horizontaler Überlauf; Footer bei 320×720 erreichbar; ≥192 px Lesefläche auch bei geöffnetem Confirm | `natural-flow-r15` / `r16`, jeweils 2/2 mit Responsive |

Report-Verzeichnisse: `/tmp/fvrc1006-<Laufname>-report`.
Sichtbelege: [B-Konflikt nach C](./desktop-after-c-conflict.png),
[320 px](./mobile-320-conflict.png), [390 px, dunkel](./mobile-390-dark-conflict.png),
[320 px mit sechs Ebenen und offenem Confirm](./mobile-320-deep-comparison.png).
Die mobilen Bilder stammen vom abschließenden `natural-flow-r16`-Lauf und
wurden zusätzlich durch den Hauptagenten visuell geprüft. Beim Deep-Bild ist der
Dialog zum Lesen nach oben gescrollt; die offene Bestätigung liegt weiter unten.

## Automatisierte Regression

Auf dem aktuellen Produktionscode bestanden:

- `npm run build`, danach `test:collaboration:production-modules`
  (Log-Suffix `r15`): gebaute Browser-/Node-Module verwenden den geprüften Yjs-Pfad.
- `test:proposal-graph:review-ui` (`r15`), `review-actions`, `orchestrator`,
  `review-summary` (`r9`): Contracts, gebundene Antworten/Folgeseiten, Aktionen,
  Status/Recovery, Transform-Vorschau, Diagnose und Legacy-UI.
- `test:file-version-center:hardening` und Query-Service-Test (`r9`):
  Rollout-/Rechte-, Restore-, Legacy-Aktions-, Timeline-/Widget-Regression sowie
  Rechtefilter und Cursor-Grenzfälle.
- `tsc --noEmit` und vollständiges ESLint (`r15`): null Fehler,
  sieben vorhandene Warnungen außerhalb des Änderungsumfangs.
- Zusätzlich bestanden: Graphmodell einschließlich 80 deterministischer DAGs,
  Storage, Tools, Projektion/Evaluator, Collaboration- und Agent-Durability.
  CR-04/05/10 sind Mechanik-/Evaluator-Nachweise, kein eigener Browserlauf.
- Echter PostgreSQL-Storage-/Concurrency-Lauf: isolierte neue Testdatenbank,
  zwei Backend-Verbindungen, Lock-Timeout, CAS, Restart und Idempotenz; danach
  nur diese eigene Datenbank entfernt. Log `fvrc1006-storage-postgres-final.log`.
- Statischer Autorisierungsreview: kein neuer konkreter Befund in den abgegrenzten
  Review-/Action-/Recovery-Routen. Dies ersetzt keine dynamischen Rechte-Tests.

## Abnahme und verbleibende Grenzen

Die offenen FVRC-1006-Nachweise sind abgeschlossen: PG-U02, PG-U04, PG-U07,
PG-U08 und die verschärfte mobile Lesbarkeit bestehen; aktuelle Screenshots
sind gesichtet. Build, Produktionsmodul-Parität, UI-Regression, TypeScript,
Lint und Diff-/Scopeprüfung bestehen nach dem letzten Produktfix.
Dies ist **keine** Abnahme von FVRC-1007/1008 oder P12 und keine
Produktionsfreigabe. Native Screenreader-/Zoom-Bedienung ist nicht behauptet.

Die manuelle Sichtprüfung des ursprünglich grünen 320×720-Tests zeigte einen
nur etwa 14 px hohen Vergleichsbereich. Deshalb wurden Leseflächen-Orakel und
Produktfix ergänzt; die älteren reinen Footer-/Bounds-Tests allein gelten nicht
als ausreichender Nachweis der mobilen Lesbarkeit.

## Änderungsumfang und Risiko

GitNexus `detect_changes` im expliziten Implementierungs-Worktree: staged
46 indizierte Symbole, 76 Textdateien, ein Prozess, Risiko **medium**. Gegen
lokales `main`: 68 Symbole, 98 Dateien, acht Prozesse, Risiko **high**. Auch
gegen die tatsächliche Task-Basis `d792e987c` bleibt die Bewertung **high**
(50 Symbole, 83 Dateien, acht Prozesse): der bereits enthaltene zentrale
Dateilese-Fix berührt indirekt Auth-/Workspace-Pfade. Diese erhöhte Reichweite
wurde dem Nutzer gemeldet; Dateilesen, Rechte und Persistenz wurden geprüft.
Das ältere lokale `main` enthält zusätzlich bereits vorher vorhandene
Branch-Differenzen. Neue, noch nicht indizierte Module wurden separat über
Imports/Consumer und Sicherheits-/Regressionstests geprüft; die Indexzählung
ist kein vollständiger Nachweis und kein Grund, unbekanntes Risiko niedrig
einzustufen. Fremde Statistikänderungen in `AGENTS.md`/`CLAUDE.md` bleiben
außerhalb des Commits. Keine Dependency-/Lockfile-Änderung.

## Einordnung früherer Fehlläufe

Frühere grüne Vordergrundprüfungen enthielten noch PostgreSQL-Deadlocks im
Hintergrund; sie wurden nicht als Abnahme gezählt. Der gemeinsame Lock und das
strengere HTTP-Fehler-Orakel korrigieren diese Lücke. Schnelle aufeinanderfolgende
Fälle trafen das unveränderte 30/min-Limit; sie laufen nun einzeln mit Abstand.

Weitere reine Harness-Fehler: fehlendes vorhandenes Yjs-`postinstall`-Patch;
mehrdeutiges Fixture-Token E0 in LATE0; Timeline-Folgeseite am falschen Endpoint;
clean_rebased fälschlich nicht als prüfbar akzeptiert; inkonsistenter Basistext
und Verwechslung von Proposal-/Operation-ID in der Rechte-Fixture. Diese wurden
im Harness korrigiert, nicht durch schwächere Inhalts-/Revisions-/Rechte-Orakel.

PG-U02: `bringToFront()` löste headless keinen zuverlässigen Fokus-Event aus;
der Harness dispatcht diesen Browser-Event jetzt ausdrücklich. Danach wurde ein
echter Fokusverlust durch wechselnde Gruppenschlüssel reproduziert und behoben
(Punkt 13). PG-U04: ungültiger Fixture-Name/Basistext/Startpfad, ein doppelt
gerenderter Workspace-Schalter und dessen durch den offenen Dialog versteckte
Accessibility-Rolle wurden im Harness abgegrenzt. Der unveränderte Scope-/
Diff-/Apply-Nachweis besteht vollständig in `navigation-r17`; hierfür war kein
zusätzlicher Produktfix erforderlich.

Native Screenreader-/Zoom-Bedienung bleibt ausdrücklich nicht behauptet.
Einstiegspunkte/Notifications, Aktivierung gewöhnlicher Agententools, doppelte
P10-Gesamtabnahme und manuelle Konfliktauflösung bleiben den Folgetasks zugeordnet.
