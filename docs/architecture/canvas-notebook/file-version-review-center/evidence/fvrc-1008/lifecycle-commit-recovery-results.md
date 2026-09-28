# Lifecycle-COMMIT und nachholbare Normalisierung

Stand: 27. September 2026. Aufbauend auf `b924d50c0`.
Diese Ergänzung schließt die Commit-/Rollback-Lücke des
[Snapshot-Fence](lifecycle-snapshot-results.md), nicht das gesamte FVRC-1008-Gate.

## Fehler und Korrektur

Die Normalisierung schrieb die Datei bisher innerhalb einer noch offenen
SQL-Transaktion. Ging die Bestätigung eines tatsächlich erfolgreichen COMMIT
verloren, konnte die Fehlerbehandlung den alten Dateiinhalt zurückschreiben.
Ein Absturz nach Dateischreiben, aber vor SQL-COMMIT hinterließ ebenfalls
widersprüchliche Zustände ohne zuverlässig erkennbaren Nachholbedarf.

Jetzt gilt dieselbe Transaktionsmechanik für Kompaktierung und Formatwechsel:

1. Backup, Lifecycle-/Yjs-Zustand und Operations-Expiration gemeinsam committen.
   Die vorab erzeugte eindeutige Backup-ID dient zugleich als Ergebnisbeleg.
2. Bei Normalisierung die gesamte bisherige Checkpoint-Zuordnung behalten:
   Sequenz, Zeitpunkt, kanonischer Hash und serialisierter Hash. Die erhöhte
   Dokumentsequenz macht eine ausstehende Dateiprojektion dauerhaft erkennbar.
3. Erst nach bestätigtem Commit die vorhandene Checkpoint-Pipeline aufrufen.
   Deren persistente Versuchs-/Ergebnisbelege sichern die folgenden Datei- und
   Metadatenphasen ab. Kein Zurückschreiben alter Dateien als Kompensation.
4. Bei ungewissem COMMIT die Writer-Verbindung verwerfen. Eine frische
   Transaktion sperrt die Zustandszeile und prüft den exakten Backup-Beleg.
   Fehlender Beleg bedeutet keine Freigabe und insbesondere keinen Replay.
5. Der aktuelle Zustand muss dieselbe Lifecycle-Identität und entweder exakt
   dieselben Bytes/Vector oder einen kausal umfassenderen Yjs-Stand besitzen.
   Eine höhere Sequenz allein genügt nicht; auch Delete-Sets werden geprüft.
6. Scheitert ROLLBACK, die Verbindung ebenfalls verwerfen und beide Fehler
   erhalten. Eine unaufgelöste Transaktion geht nicht normal in den Pool zurück.

Die gemeinsame Hilfsfunktion enthält nur Verbindungs-/Transaktionsmechanik;
Backup-Beleg, Snapshot-Fence und Zustandsprüfung bleiben in der Persistenz.
Damit folgt die Aufteilung dem `code-structure`-Skill, ohne eine zweite
Dateischreib- oder Recovery-Pipeline einzuführen.

## Nachweise und Grenzen

- Acht neue Transaktions-Unit-Tests: Commit, BEGIN-/Execute-Fehler, fehlschlagendes
  Rollback, verlorene Commit-Bestätigung, fehlgeschlagenes Verwerfen, fehlende
  Recovery und Release-Fehler nach Commit. Bestandteil der Lifecycle-Suite.
- Echte PostgreSQL-Konkurrenzsuite: 16 Prüfgruppen einschließlich der bisherigen
  Snapshot-Matrix, positivem Backup-Beleg nach verlorener Commit-Antwort,
  abgelehntem COMMIT ohne Beleg und verworfener Rollback-Verbindung.
- Der Materializer sieht den SQL-Commit über eine andere PG-Verbindung; bis zu
  seinem Erfolg bleibt die gesamte alte Checkpoint-Zuordnung erhalten.
- Materializer-Fehler lassen einen committed Rich-Zustand mit Sequenzlücke
  zurück. Höhere, nicht umfassende Recovery-Stände und gleichsequenzige falsche
  Bytes/Vector werden abgelehnt; ein kausal umfassenderer Stand wird frisch
  weitergereicht. Ein ersetzter Lifecycle löst keinen veralteten Callback aus.
- Breite Datei-Agenten-Integration prüft mit echtem Rich-Codec und Dateisystem:
  fehlgeschlagene Projektion lässt die alte Datei unverändert; anschließende
  normale Materialisierung holt den committed Zustand nach.
- Separate PostgreSQL-Projection-Lifecycle-Integration: sechs Szenarien mit
  Dateisystem, Rename/Trash/Restore und Formatwechsel bestanden.
- Vollständige Lifecycle- und Projection-Suites, vollständige
  `test:collaboration:operations` inklusive Personal-Workspace, Typprüfung,
  fokussiertes ESLint und Produktionsbuild bestanden. Der Build behält die
  bekannten Tracing-Warnungen; kein Container wurde gebaut.
- Die endgültige fokussierte PG-Suite wurde zusätzlich unabhängig durch den
  Hauptagenten wiederholt: ebenfalls alle 16 Prüfgruppen bestanden.

Die fokussierte Konkurrenzsuite injiziert lokale Raum-/Workspace-Locks,
Markdown-Codecs und Verbindungsfehler. Sie ist **kein SIGKILL-/Mehrprozess-
Lifecycle-Handoff-Nachweis**. Die echte Codec-/Datei-Integration ist separat
ausgewiesen. SQL-Tests laufen ausschließlich in eigenen UUID-Schemas bzw.
frisch migrierten UUID-Datenbanken, die danach entfernt werden.

### Laufprotokolle

- `/tmp/fvrc1008-lifecycle-transaction-causality.log`
- `/tmp/fvrc1008-file-agent-operation-integration.log`
- `/tmp/fvrc1008-lifecycle-recovery-transaction.log`
- `/tmp/fvrc1008-lifecycle-recovery-projection-pg.log`
- `/tmp/fvrc1008-lifecycle-recovery-pg-repeat.log`
- `/tmp/fvrc1008-lifecycle-transaction-operations-full.log`
- `/tmp/fvrc1008-lifecycle-recovery-unit-final.log`
- `/tmp/fvrc1008-lifecycle-recovery-projection-unit.log`
- `/tmp/fvrc1008-lifecycle-recovery-types-final.log`
- `/tmp/fvrc1008-lifecycle-recovery-lint-final.log`
- `/tmp/fvrc1008-lifecycle-recovery-build-final.log`

### Browser auf aktuellem Host-Dev 3000

- Personal: Markdown-E-Mail-Dokument öffnen, Darstellung/Dateiinhalt prüfen
  und im Rich-Editor neu laden: bestanden, **12,7 s**.
- Team: Live-Quelltext wird im Lesemodus beobachtet; aktive zweite Sitzung
  verhindert Migration, nach deren Ende gelingt der explizite Rich-Wechsel:
  bestanden, **9,7 s**. Die nachfolgenden Export-/Zugriffsfehler sind in diesem
  bestehenden Test absichtlich per Route injiziert, keine echten Serverausfälle.
- Erster Team-Lauf scheiterte vor dem Migrationspfad an der veralteten Annahme
  „Öffnen startet in Lesen“. Testvorbereitung wählt Lesen jetzt explizit;
  Inhalts-, Peer-Sperr-, Migrations- und Recovery-Assertions bleiben unverändert.
- Personal B/C-Regression mit gewöhnlichen `edit_file`-Vorschlägen: C zuerst
  angenommen, B bleibt `open`/`conflicted`, keine zweite Annahme und kein
  Timeline-Fehler oder falsches Null-Diff. Exakter Endtext und genau eine neue
  Inhaltsrevision: bestanden, **17,6 s**. Screenshot angesehen.
- Derselbe B/C-Fall im Team-Workspace: bestanden, **15,6 s**, mit denselben
  Inhalts-, Revisions-, offenen Konflikt- und Nicht-Annahme-Assertions.
  Auch dieser Screenshot wurde angesehen.

Die drei Screenshots wurden angesehen. Der Dev-Issue-Indikator bleibt sichtbar;
der E-Mail-Test meldet keine `pageerror`s. Bestehende fehlende lokale Skill-Dateien
werden weiterhin im Host-Dev-Log gemeldet und nicht als Teil dieses Fixes gelöst.
Berichte/Artefakte unter `/tmp/fvrc1008-lifecycle-recovery-`:
`email-report`, `email-results`, `migration-r2-report`, `migration-r2-results`;
Personal-Konflikt: `personal-report/index.html`, `personal-browser.log`;
Team-Konflikt: `team-report/index.html`, `team-browser.log`;
Logs jeweils `*-browser.log`. Der fehlgeschlagene erste Team-Lauf bleibt unter
`migration-browser.log` erhalten. Läufe seriell, ein Worker, mindestens
55 Sekunden nach bestätigtem Abschluss vor dem Folgelauf.

Der verwaltete Stack ist unverändert: vier gesunde Container; Notebook **3100**
bleibt das ältere Image. Aktueller Quellcode läuft auf **3000**. Der Cleanup-Check
bestätigt null verbleibende Testschemas/-datenbanken und null aktivierte
Owner-Epochen (`stack-final.log`, `cleanup.log` unter demselben Präfix).

## Review der Änderung

Ein unabhängiger Subagent hat Commit-Beleg, Lock-Reihenfolge, erhaltene
Checkpoint-Zuordnung und die kausale Ergebnisprüfung geprüft. Seine zunächst
gefundene Lücke „höhere Sequenz ohne kausalen Nachweis“ wurde vor dem finalen
PG-Lauf geschlossen und mit positiven/negativen Fällen abgesichert.
GitNexus meldet für den staged Ausschnitt LOW, bildet neue/geänderte Funktionen
im vorhandenen Index aber nur teilweise ab. Deshalb ersetzt das Ergebnis
weder manuelle Diff-Prüfung noch Tests. Der gesamte Branchvergleich gegen
`main` bleibt CRITICAL (254 Dateien, 26 betroffene indizierte Abläufe);
der Nutzer wurde vor Commit ausdrücklich darauf hingewiesen.

## Offene Gesamt-Gates

Prozessübergreifendes Admission/Drain und Lifecycle-Owner-Entzug, atomarer
Kandidatencommit vor Live-Publish, vollständige Crash-/Reconnect-Abnahme,
die gesamte PG-/MR-Matrix und P12 bleiben offen. Owner-Aktivierung im normalen
Bootstrap bleibt aus. Keine Produktionsaktivierung, kein Container-Rebuild,
kein Fixture-Reset und kein Push in dieser Runde.

Zwei begrenzte Verhaltensdetails: Ein Release-Fehler nach bestätigtem COMMIT
kann weiterhin Erfolg verdecken, aber keine SQL-/Dateikompensation auslösen;
die Sequenzlücke bleibt nachholbar. Das zurückgegebene `canonicalContent`
entspricht dem gegebenenfalls neueren, kausal geprüften Ergebniszustand.

FVRC-1008 bleibt `in_progress`.
