# Dokumentservice: frische Agentenprofil- und Rechtebeobachtung

Stand: 28.10.2026. Dieser Teilschritt gehört zur Datenbankbündelung in
[Paket 2 des Gesamtplans](../document-write-database-performance-plan.md).
Er ist keine Abnahme der Leistungsbudgets oder Produktionsfreigabe.

## Änderung

Die Tool-Policy für eine echte Agenten-Neuanlage las das vollständige
Agentenprofil zusätzlich zu jeder bereits nötigen aktuellen Rechteprüfung.
Die neue Create-Phase liest das rohe Profil zusammen mit ihrer abschließenden
Workspace- und Verbindungskontextbeobachtung auf derselben gehaltenen Verbindung.
Die Policy beobachtet die aktuellen Daten weiterhin zweimal und vergleicht die
Profile vor und nach ihrer Entscheidung. Berechtigungsfristen und Sperren bleiben
erhalten; es werden keine Berechtigungs- oder Profildaten zwischengespeichert.

Nur das tatsächlich von der Create-Phase ausgegebene Zugriffsobjekt erhält den
festen Leser. Kopierte oder per Proxy umhüllte Objekte erhalten ihn nicht.
Falsche Verbindungen, zurückbehaltene Leser, parallele oder nicht abgewartete
Aufrufe und unterdrückte Fehler verweigern die Veröffentlichung. Andere
Agentenaufrufe und die bestehende Beobachter-Schnittstelle behalten ihren
bisherigen Policy-Ablauf.

Die bisherige reine Profilabbildung wird wiederverwendet. Rohe SQL-Werte,
einschließlich Date-Objekten und optionaler Profilspalten, bleiben erhalten.
Agenten- und Workspace-Organisation sowie deren Owner werden getrennt gelesen;
zusätzliche Profilspalten können die vertrauenswürdigen Kontextfelder nicht
überschreiben. Historische Herkunftsdaten werden intern gehalten und verleihen
selbst keine Berechtigung.

## Vergleich und Prüfungen

Frischer Vorher-/Nachher-Vergleich mit zehn regulär angelegten Quellen und
derselben Messgrenze. Die Produktquellen vor der Änderung entsprechen
`eed21ee6e79578253201140a79dc9271b9ad8d6e`; die vier geänderten Produktdateien
sind im privaten Ergebnis mit SHA-256 festgehalten.

| Ablauf | Vorher: SQL / Ausleihen | Nachher: SQL / Ausleihen |
| --- | ---: | ---: |
| Erster Adapteraufruf samt Anlage | 2024 / 80 | 1840 / 80 |
| Warme frische Anlage, beide Messungen | 1919 / 46 | 1735 / 46 |
| Wiederholung der ursprünglichen Operation | 178 / 7 | 168 / 7 |

Die ursprünglichen Identitäten, Inhalte, Registry-/Native-/Metadatenzeilen samt
`xmin` und physischen Bytes bleiben erhalten. Beide Messläufe schließen ihre
eigenen Datenbank- und Dateisystemressourcen vollständig. Die Laufzeiten dienen
hier nur der Diagnose und sind kein belastbarer Latenzvergleich.

Der neue Runner `npm run test:documents:create:agent-policy` besteht mit 15 echten
PostgreSQL-Testgruppen. Sie prüfen Profilparität für drei Agententypen, rohe
Datumswerte, echte konkurrierende Sperren, Herkunft und Lebensdauer des Lesers,
Rechte-/Schema-/Workspace-/Profiländerungen, dauerhafte Fehlerverweigerung und
die bisherige Beobachter-Schnittstelle. Autoritätszeilen bleiben exakt erhalten;
die eigenen Schemas, Verbindungen, temporären Dateien und Testbundles werden
entfernt. Netzwerkaufrufe: null.

Zusätzlich bestehen 29 bestehende PostgreSQL-Suiten für Member-, Agenten-,
Job- und Gastrechte, Create-Speicherphasen und COMMIT-Recovery, native
Lese-/Such-/Schreibwege, MCP und öffentliche Freigaben. Ein Diagnosehelfer für
die tatsächlich beobachtete ACK-Transaktion erkennt jetzt auch die getrennten
Kontextspalten; die Sperr-, Transaktions-, Inhalts- und Widerrufsassertionen bleiben
erhalten. Release-TypeScript und gezieltes ESLint bestehen ebenfalls.

Die [reguläre Browser-Gesamtsuite](document-service-regular-suite-2026-10-28.md)
ist am vorherigen gebauten Produktstand grün. Für diese jüngste Produktänderung
stehen Build und UI-Abnahme zum Dokumentationszeitpunkt noch aus. Die
Pool-Ausleihen sind unverändert, die SQL-Budgets noch nicht erreicht.
Abschließende Größen-, Latenz- und Parallelitätsvergleiche sowie die übrigen
Pakete des Gesamtplans bleiben offen. Review Center und Undo werden nicht
weiterentwickelt.
