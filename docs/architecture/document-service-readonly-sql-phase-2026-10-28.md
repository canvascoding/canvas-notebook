# Dokumentservice: historische Verifikation ohne eigene SQL-Phase

Stand: 28.10.2026, Vergleich mit `26c95690d4ef485a32b724249a6370e973f7e41e`.
Ein weiterer Teil von Paket 2 des [Gesamtplans](../document-write-database-performance-plan.md).

Nach dem nativen Speichern und vor der ersten Veröffentlichung prüfte der
Coordinator den privaten Dateibeleg in einer zusätzlichen Principal-Transaktion.
Seit der [Voraussetzung für rein lesende Verifikation](document-service-readonly-birth-verification-2026-10-28.md)
kann diese Prüfung weder Dateien anlegen noch einen Store oder Anker reparieren.

Diese historische Leseaktion öffnet jetzt keine eigene SQL-/Principal-Phase mehr.
Der private Kontext beschreibt die tatsächliche Helferaktion, ihre Lebensdauer,
die genaue Eingabe und den genauen Funktionskörper. Eine Eingabekopie oder ein
anderer Callback kann die Auswahl nicht treffen. Aktueller Lifecycle-Owner,
Quelle und gepinnter Namensraum werden weiterhin an beiden Enden geprüft.
Eine solche Beobachtung verleiht keine Schreibberechtigung.

Bestehende native und Publikationsphasen behalten ihre echten Verbindungen und
Prüfungen. Mutierende Helfer behalten ihren Principal bis zum Ende aller ACKs und
des tatsächlichen Prozesses. Die abschließende Verifikation nach Publikations-
COMMIT bekommt ausdrücklich einen neuen echten Principal. Rechteverlust vor
der Erfolgsmeldung wird dadurch weiterhin frisch erkannt. Es gibt keine neue
Skip-Option, keinen Rechtecache und keine verlängerten Fristen.

Der für dieses Worktree neu erstellte GitNexus-Index meldet HIGH für den gemeinsamen
Helfer: vier direkte Aufrufer, drei mittelbar betroffene Module. Die tatsächliche
Änderung betrifft vier bestehende Funktionen; zwei reine Prädikate kommen hinzu.
133 weitere Top-Level-Funktionen der beiden Produktdateien bleiben bytegleich.
Der Python-Helfer bleibt gegenüber dem Vergleichsstand unverändert.

## Nachweise

Der neue PostgreSQL-Test scheitert am alten Produkt an einer tatsächlich geöffneten
zusätzlichen Transaktion (1 statt 0). Der neue Stand besteht mit sechs Fällen:
Kontrolle, tatsächlicher Kontowiderruf vor Veröffentlichung und tatsächlicher
Kontowiderruf nach deren COMMIT, jeweils für Agent und MCP. Der erste Widerruf
verhindert die physische Veröffentlichung; der zweite verhindert die Erfolgsmeldung.
Originale Zeilen/xmin, native Bytes und Receipt bleiben erhalten. Eine explizite
Wiederholung behält Dokument-, Lineage-, Operations- und Claim-Identität sowie
vollständige Inhalte. Nach bereits abgeschlossener Veröffentlichung bleiben auch
sämtliche beobachteten Zeilen/xmin exakt gleich. Kopierte Eingaben und fremde
Auswahlen werden während der echten SQL-Aufrufe abgewiesen.

Zehn PostgreSQL-Suiten bestehen: die neue Lesephase, Agent-/MCP-Speicherphasen mit
echten COMMIT-Antwortverlusten, vollständiger Verify-Exit, Realm/Beleg, native
Beobachtung, Owner, native MCP-Neuanlage, manuelle Anlage und Uploads. Alle eigenen
Fixtures schließen. Der gezielte Test besteht auch nach der reinen TypeScript-
Korrektur seiner Snapshot-Prüfung erneut am endgültigen Testquelltext.

Die beiden bisherigen Speicherphasen-Tests verlieren weiterhin die Antwort eines
tatsächlich erfolgreichen COMMIT vor der nativen Anlage. Ihr zweiter Fehlerfall
liegt jetzt an der erhaltenen abschließenden aktuellen Bestätigung nach der
Veröffentlichung: Die entfernte historische Lesephase hat keinen COMMIT mehr.
Es werden weder positive SQL-Antworten ersetzt noch automatische Wiederholungen
zugelassen. Die ergänzten Assertions verlangen für diesen zweiten Fall die
bereits veröffentlichten Bytes und die vollständige Gleichheit aller bisherigen
beobachteten Zeilen/xmin nach expliziter Wiederaufnahme.

Release-TypeScript, gezieltes TypeScript mit 27 Wurzeln/5111 Quellen/keinen
Diagnosen und ESLint ohne Warnungen bestehen. Der neue Test ist über
`npm run test:documents:create:readonly-phase` wiederholbar. Die eigenen
PostgreSQL-Fixtures benötigen weiterhin die konfigurierte geschützte lokale
Testumgebung.

## Vergleich

Vier frische Vorher-/Nachher-Fixtures mit jeweils zehn regulär hochgeladenen
Quellen schließen alle 16 Messfenster und eigenen Ressourcen. Der Vergleich
verwendet genau den bisherigen Produktstand, einschließlich seines selbst
gebauten nativen Addons. Laufende App-Dateien oder Datenvolumes werden nicht
überlagert. Unbeteiligte Registry-/Lineage-/Native-/Metadatenzeilen/xmin und
physische Bytes bleiben unverändert. Der
[maschinenlesbare Nachweis](document-service-readonly-sql-phase-2026-10-28.json)
bindet die Produktquellen über SHA-256.

| Vollständiger Einstieg | Vorher: SQL / Ausleihen | Jetzt: SQL / Ausleihen |
| --- | ---: | ---: |
| Agent, beide warmen Neuanlagen | 1599 / 46 | 1523 / 43 |
| MCP, beide warmen Neuanlagen | 1192 / 33 | 1152 / 32 |
| Agent, ursprüngliche Wiederholung | 168 / 7 | 168 / 7 |
| MCP, ursprüngliche Wiederholung | 102 / 12 | 102 / 12 |

Der erste Agenteneinstieg sinkt von 1704 / 80 auf 1628 / 77, MCP von 1213 / 46
auf 1173 / 45. Sämtliche Fenster enden ohne fehlgeschlagene oder unbekannte
Queryformen sowie ohne offene Abfragen/Verbindungen. Die Zählung enthält auch
Transaktions-, Sperr- und Kataloganweisungen. Lokale Laufzeiten sind nur Diagnose;
der endgültige 200-Quellen-, Latenz- und Parallelitätsnachweis bleibt erforderlich.

Leistungsbudgets, endgültige Größen-/Latenz-/Parallelitätsvergleiche, inkrementelle
Links, gemeinsame normale Schreibwege und sämtliche finalen Build-/UI-/Suite-/
CI-/Review-/Release-Gates bleiben offen. Review Center und Undo werden nicht
weiterentwickelt. Produktion und veröffentlichtes Release sind unverändert.
