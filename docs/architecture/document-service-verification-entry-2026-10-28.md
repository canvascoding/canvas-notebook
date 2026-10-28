# Dokumentservice: Eintritt in die private Verifikation

Stand: 28.10.2026. Weiterer abgegrenzter Schritt aus Paket 2 des
[Gesamtplans](../document-write-database-performance-plan.md).

Die wiederholte Kontrolle eines bestehenden privaten Anlagebelegs lud am
Eintritt und Ausgang dieselbe vollständige Rechte-/Native-Prüfkette. Innerhalb
der tatsächlich gehaltenen Publikationsphase verwendet nun ausschließlich der
Eintritt in eine echte `verify`-Nachricht die bereits gehaltene Phase. Owner,
Quelle, Root und das vorhandene private Zeitbudget werden weiterhin geprüft.
Am Ausgang bleibt die vollständige frische Rechte-/Native-/Belegbeobachtung
erhalten. Veröffentlichung, Prepare, Observe und Complete bleiben unverändert
vollständig geprüft; es gibt keinen neuen Berechtigungs- oder Datenzeilencache.

Ein kleiner privater `AsyncLocalStorage`-Kontext kennzeichnet nur den tatsächlichen
Eintritts-Callback von `invoke`. Er bindet die aktive Nachricht an das exakte,
intern erfasste und eingefrorene Eingabeobjekt. Ein Datenprüfer liefert allein
einen booleschen Kontextbefund; er gibt weder Principal noch Schreibbefugnis aus.
Kopien, Proxies, Aufrufer-Stage-Strings und abgelaufene asynchrone Kontexte können
den Weg nicht auswählen. Nach dem Callback wird die Eintrittsmarkierung in
`finally` gelöscht; nach der Nachricht wird auch deren Lebensdauer geschlossen.

Drei bestehende Funktionen in zwei Produktdateien ändern sich; ein Datenprüfer
kommt hinzu. 133 weitere bestehende Funktionen bleiben bytegleich. Die
Risikoprüfung für den gemeinsamen Speicherhelfer war HIGH/CRITICAL und wurde vor
der Änderung benannt. Der direkte Quellvergleich ergänzt den veralteten Index.

## Tatsächliche Prüfungen

`npm run test:documents:create:verification-phase` besteht mit acht Fällen über
die registrierten Agenten-/MCP-Werkzeuge und den tatsächlichen Speicherhelfer.
Sechs Fehlerfälle halten ausschließlich die Zustellung des tatsächlichen letzten
Verify-Prozessabschlusses auf. Auf der wirklichen gehaltenen Verbindung werden
native Sequenz, Kontosperre oder Suchpfad geändert; echte Exitwerte und positive
SQL-Antworten bleiben unverändert. Die erhaltene Ausgangsprüfung verweigert den
Abschluss. Rollback stellt ursprüngliche Zeilen samt `xmin`, native Bytes,
Receipt und Account wieder her. Die bereits veröffentlichten Originalbytes bleiben
vollständig erhalten; die explizite Wiederaufnahme behält ursprüngliche Identitäten.
Kopierte Wire-Eingaben werden auch innerhalb tatsächlicher SQL-Callbacks abgewiesen.

Alle zehn bestehenden PostgreSQL-Suiten bestehen unverändert: native Beobachtung,
Publikationsgrenzen, Owner, Bereich/Anlagebeleg, Agenten-Speicherphase und
COMMIT-Antwortverlust, MCP-Speicherphase und native Anlage, authentifizierter Upload
und vollständige manuelle Anlage. Die bestehenden tatsächlichen Publikations-ACKs
behalten ihren vollständigen nativen Nachweis. Release-TypeScript, gezieltes
TypeScript mit 20 Wurzeln/5083 Quellen/null Diagnosen und gezieltes ESLint bestehen.

## Direkter Vergleich

Vier neue Fixtures vergleichen den tatsächlichen Stand
`9e9706cc62f50308da59677539d944c2a2438e85` mit der Korrektur, jeweils mit zehn
über normale Uploads angelegten Quellen. Der Baseline-Quellordner baut und prüft
sein eigenes natives Modul. Der Vergleich umfasst 16 Messfenster.

| Fenster | Vorher: SQL / Ausleihen | Jetzt: SQL / Ausleihen |
| --- | ---: | ---: |
| Agent – erster Einstieg und Anlage | 1800 / 80 | 1704 / 80 |
| Agent – warme Anlage, beide Fenster | 1695 / 46 | 1599 / 46 |
| Agent – ursprüngliche Wiederholung | 168 / 7 | 168 / 7 |
| MCP – erster Einstieg und Anlage | 1293 / 46 | 1213 / 46 |
| MCP – warme Anlage, beide Fenster | 1272 / 33 | 1192 / 33 |
| MCP – ursprüngliche Wiederholung | 102 / 12 | 102 / 12 |

Alle Fenster enden ohne offene Verbindungen/Abfragen, fehlgeschlagene Anweisungen
oder unbekannte Queryformen. Ursprüngliche Zeilen/xmin und physische Bytes bleiben
je Fixture exakt erhalten; alle eigenen Ressourcen und der Baseline-Quellordner
sind geschlossen/entfernt. Zeiten sind diagnostisch, keine kontrollierte Latenzabnahme.

Die Gesamtbudgets bleiben unerreicht. Weitere Bündelung, finale Größen-/Latenz-/
Parallelitätsvergleiche, inkrementelle Links, gemeinsame normale Schreibwege und
die endgültigen Build-/UI-/Gesamtsuite-/CI-/Review-Gates bleiben erforderlich.
Review Center und Undo werden nicht weiterentwickelt. Produktion und Release
bleiben unverändert.
