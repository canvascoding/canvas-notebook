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
