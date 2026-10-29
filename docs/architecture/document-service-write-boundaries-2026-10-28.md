# Dokumentservice: frische Prüfungen an Schreib- und Ergebnisgrenzen

Stand: 28.10.2026, Vergleich mit `c2a37547391c0ff7d88801a5c6505d49934f30a1`.
Weiterer Teil von Paket 2 des [Gesamtplans](../document-write-database-performance-plan.md).

## Ursache und Änderung

Eine native Schreibprüfung las bereits aktuelle Rechte und prüfte anschließend
den privaten Dateibeleg. Dessen rein lesender Helfer startete innerhalb derselben
gehaltenen Phase weitere vollständige Rechte-/Kontextprüfungen. Bei Veröffentlichung
kamen vollständige native Beobachtungen an Verifikationsgrenzen hinzu. Die reine
Leseaktion konnte selbst weder veröffentlichen noch einen Store/Anker reparieren.

Diese internen Lesegrenzen prüfen weiterhin die genaue aktive Invocation, den
tatsächlichen Owner, Quelle und gepinnten Namensraum. Die echte aktuelle
Berechtigungsprüfung findet nach dem tatsächlichen Helferende an der umgebenden
nativen Schreibgrenze statt. Agent und MCP verwenden dort die bereits vollständig
aktuelle Herkunfts-/Policy-Prüfung; Request-Verbraucher behalten zusätzlich ihren
bisherigen tatsächlichen `assertCurrent`-Aufruf. Es gibt keinen neuen Skip-Schalter
und keine gespeicherte Berechtigung.

Der generische Projektionswächter verifiziert zuerst den privaten Dateibeleg und
liest danach den vollständigen aktuellen nativen Stand. Identität, Generation,
Sequenz, Zustandsvektor und Bytes müssen weiterhin zum ursprünglichen Zustand
passen. Auch die abschließende Publikationsphase prüft ihren vollständigen nativen
Stand nach ihrer letzten Verifikation. Die eigenständige frische Principal-Phase
nach Publikations-COMMIT bleibt erhalten, einschließlich ihrer Abschlussprüfung.
Mutierende Helfer, tatsächliche Publikationsgrenzen, Sperren und Fristen bleiben
unverändert geschützt. Review Center und Undo werden nicht weiterentwickelt.

Vorab meldet GitNexus MEDIUM für die native Scope-Prüfung (fünf direkte Aufrufer,
zwei Module), ansonsten LOW. Der dynamische Aufrufer aus `projection-identity.ts`
ist zusätzlich direkt geprüft. Fünf bestehende Funktionen einer Produktdatei
ändern sich. Keine Produktfunktion kommt hinzu; 134 andere Top-Level-Funktionen
der beiden untersuchten Produktmodule bleiben bytegleich.

## Nachweise

Der neue Test scheitert am alten Produkt an 88 zusätzlichen tatsächlichen
Berechtigungs-SQL-Aufrufen innerhalb reiner Verifikation statt null. Ein Fehler
des ersten Diagnose-Wrappers bei Multiquery-Ergebnissen ist getrennt erhalten;
der danach ausführbare Ausgangsvergleich scheitert am tatsächlichen Produktverhalten.

Am endgültigen Teststand bestehen neun tatsächliche PostgreSQL-Fälle. Agent und
MCP haben je eine Kontrolle, eine auf dem gehaltenen Backend gespeicherte
Kontosperre und einen lokalen Schemawechsel am echten Verify-Prozessende vor
nativer DML. Agent prüft zusätzlich dort deaktivierte Tools. In allen fünf
Fehlerfällen verweigert die umgebende Schreibgrenze vor nativer DML; Rollback
erhält die ursprünglichen Berechtigungszeilen samt `xmin`. Explizite Wiederholung
behält Claim, Intent und Operations-ID und erzeugt genau ein vollständiges Dokument.

Zwei weitere Fehlerfälle sperren das Konto nach Publikations-COMMIT am Ende der
abschließenden Dateiverifikation. Die äußere frische Principal-Abschlussprüfung
verweigert die Erfolgsmeldung. Bereits gespeicherte Dokument-, Lineage-, Native-,
Birth- und Receipt-Zeilen/xmin sowie physische Inhalte bleiben erhalten. Die
explizite Wiederholung ändert diese abgeschlossenen Zeilen nicht. Der Snapshot
gibt den nativen Owner-Token ausschließlich als Hash wieder.

Zwölf PostgreSQL-Suiten bestehen, darunter die bisherigen acht Last-Verify-
Fehlerfälle mit nativer Sequenz-/Konto-/Schemaabweichung, beide echten Speicher-
COMMIT-Antwortverluste, Herkunfts-/Policy-Profile, native Zustände und Owner sowie
die vollständigen manuellen Anlagen und Uploads. Positive SQL-/IO-Antworten werden
nicht ersetzt. Retries und Zeitlimits werden nicht erhöht; Identitäten und Anker
werden nicht zurückgesetzt.
Alle eigenen Fixtures schließen.

Release-TypeScript, erweitertes TypeScript (31 Wurzeln/5117 Quellen/keine
Diagnosen) und ESLint ohne Warnungen bestehen. Der neue Test läuft über
`npm run test:documents:create:write-boundary` in der bestehenden geschützten
lokalen PostgreSQL-Testumgebung.

## Vergleich

Vier frische Vorher-/Nachher-Fixtures mit jeweils zehn regulär hochgeladenen
Quellen schließen alle 16 Fenster. Beide Quellstände verwenden ihr tatsächlich
gebautes natives Addon. Unbeteiligte Registry-/Lineage-/Native-/Metadatenzeilen/xmin
und physische Bytes bleiben unverändert; ursprüngliche Wiederholungen behalten
ihre Identitäten. Der vorhandene Aufrufer-Profiler beobachtet alle Fenster ohne
Stackfehler und zählt exakt dieselben tatsächlichen SQL-Aufrufe wie die reguläre
Messung. Es werden nur Codepositionen und Zählwerte gespeichert.

| Vollständiger Einstieg | Vorher: SQL / Ausleihen | Jetzt: SQL / Ausleihen |
| --- | ---: | ---: |
| Agent, beide warmen Neuanlagen | 1523 / 43 | 1347 / 43 |
| MCP, beide warmen Neuanlagen | 1152 / 32 | 973 / 32 |
| Agent, ursprüngliche Wiederholung | 168 / 7 | 168 / 7 |
| MCP, ursprüngliche Wiederholung | 102 / 12 | 102 / 12 |

Der erste Agenteneinstieg sinkt von 1628 auf 1452 SQL bei 77 Ausleihen, MCP von
1173 auf 994 bei 45 Ausleihen. Alle Fenster enden ohne fehlgeschlagene oder
unbekannte Queryformen und ohne offene Abfragen/Verbindungen. Lokale Laufzeiten
sind Diagnose; kontrollierte Latenz-/Parallelitäts- und endgültige 200-Quellen-
Abnahme bleiben offen.

Die nachgelagerte Vergleichsauswertung hatte aus dem vorherigen Phasenabbau
fälschlich zusätzlich weniger Ausleihen verlangt. Hier bleiben die Verbindungen
konstruktionsbedingt gleich. Der ursprüngliche Bericht und sämtliche erfolgreichen
Fixture-Läufe sind erhalten. Ein separater Audit verlangt weniger warme SQL-
Aufrufe, exakt unveränderte Ausleihen und Originalwiederholungen sowie sämtliche
Quell-, Zählungs- und Cleanup-Invarianten. Der
[maschinenlesbare Nachweis](document-service-write-boundaries-2026-10-28.json)
dokumentiert diese Auswertung.

Leistungsbudgets und endgültige Größen-/Latenz-/Parallelitätsabnahmen bleiben
offen. Inkrementelle Links, gemeinsame normale Schreibwege und die finalen Build-,
UI-, Gesamtsuite-, CI-, Review-, Backup-/Restore- und Release-Gates bleiben Teil
des Gesamtplans. Produktion und veröffentlichtes Release sind unverändert.
