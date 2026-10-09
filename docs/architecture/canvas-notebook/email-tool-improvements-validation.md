# E-Mail-Verbesserungen: Implementierungsvalidierung

Stand: 9. Oktober 2026. Lokale Implementierung, Datenbank-/Browserprüfungen und
Produktionsabnahme werden getrennt dokumentiert.

## Schritt 1: Unicode-Erfassung

Die Normalisierung repariert beschädigten Unicode, entfernt Nullzeichen und hält
die bisherigen Feldgrenzen ein, ohne vollständige Zeichenpaare zu zertrennen.
Abgedeckt sind Absender, Betreff, Datum, Vorschau, To/Cc und Thread-ID.
Die ursprünglichen Provider-Metadaten werden dabei nicht verändert.

Bestandene Prüfungen:

- Store-Suite mit PGlite und gemeinsamer Matrix: 13 Fälle für alle sieben
  Textpfade, tatsächliche JSONB-Speicherung, optionaler/null Thread-Zustand,
  Empfängergrenze, idempotente Wiederholung und anschließender Folgeeintrag.
- Native PostgreSQL-18-Suite gegen ein eigenes temporäres Schema im vorhandenen
  verwalteten Testdienst; das Schema wird nach der Prüfung entfernt.
- Worker-Suite mit tatsächlichem JSONB-Fehler mitten in einer Seite: gespeicherter
  Cursor und letzter erfolgreicher Scan bleiben erhalten, der Cooldown wird
  eingehalten, Wiederholung erfasst schließlich 125 eindeutige Nachrichten.
  Modell-, Inhalt- und Credential-Aufrufe bleiben in dieser deaktivierten
  Vorbereitung bei null.
- Fokussiertes ESLint für die geänderten Store-/Testdateien.
- TypeScript-Prüfung des Gesamtprojekts.

Der GitNexus-Index wurde nach einem gescheiterten inkrementellen Lauf vollständig
neu aufgebaut. Die erneute Analyse des Worker-Testaufrufers ist LOW; der Store-
Speicherpfad ist MEDIUM. Das ist keine Produktions- oder Liveprovider-Abnahme.

Die zuvor in Produktionslogs beobachtete Störung bleibt bis zum Rollout und
einer erfolgreichen Erfassung der betroffenen Postfächer produktiv offen.

## Schritt 2: Sichere, getrennte Fehlerdiagnose

Postfacherfassung speichert ausschließlich sechs erlaubte Fehlercodes. Die
additive Migration begrenzt sie auch auf Datenbankebene. Erfolgreiche Erfassung
sowie Quellen-/Rechteänderungen löschen den alten Grund; letzte erfolgreiche
Erfassung und Wiederaufnahmecursor bleiben bei Fehlern erhalten. Die Feed-Coverage
liefert Namen und Diagnosen nur für aktuell freigegebene Quellen. KI-Bewertungen
behalten eigene pending/failed/stale-Zähler.

Native PostgreSQL-18-Prüfung bestanden: alle sechs Codes, Ablehnung eines freien
Fehlertextes, Schema-Upgrade zweimal, veraltete Quellenrevision, fremde Lease,
gültige Lease, erfolgreicher Wiederholungslauf und Löschen des Fehlergrunds.
Das eigene temporäre Schema wurde entfernt. Gesamt-TypeScript und fokussiertes
ESLint für diese PostgreSQL-Prüfung sind bestanden.

`auth_required` bedeutet Zugang/Verbindung prüfen. Es kann auch einen
Managed-Zugang betreffen und behauptet deshalb keine bestimmte OAuth-Ursache.

Store-, Worker- und Feed-Suites sowie fokussiertes ESLint sind bestanden. Die
Feed-Prüfung deckt leere fehlerhafte Quellen, Berechtigungsentzug während eines
Requests und Aktualisierungshinweise bei geändertem Erfassungsgrund sowie
`pending` -> `failed` eines aktuellen KI-Jobs ab. Snapshot-Reihenfolge bleibt bis
zum bewussten Neuladen stabil. Frische unabhängige Quellprüfung ohne Blocker.
