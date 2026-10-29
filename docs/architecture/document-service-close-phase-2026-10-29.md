# Dokumentservice: eine echte Phase für den vollständigen Abschluss

Stand: 29.10.2026, Vergleich mit `852046e37f4f1cd64e38b5858e6c22ddecdd7326`.
Weiterer Teil von Paket 2 des [Gesamtplans](../document-write-database-performance-plan.md).

## Änderung

Nach Publikations-COMMIT liefen finale Verifikation sowie Prüfungen vor und nach
dem Schließen in drei getrennten Principal-Phasen. Während der tatsächlichen
Deskriptor-Schließungen war die vorherige Phase bereits beendet.

Agent und MCP verwenden jetzt eine einzige frische tatsächliche Principal-Phase
für die letzte private Verifikation, beide tatsächlichen Schließungen und die
abschließende Prüfung von Quelle und benannten Verzeichnissen. Die Phase bestätigt
ihren COMMIT erst danach. Native Speicherung und Veröffentlichung behalten ihre
eigenen bestehenden Grenzen; der gesamte Create wird nicht zu einer einzigen
langen Transaktion.

Öffentliche Claim-Methoden werden weiterhin nach ihrem bisherigen Callback
geschlossen. Der private Abschluss liest seinen eigenen Frame mit den noch
geöffneten gepinnten Deskriptoren. Die tatsächliche `invoke`-Funktion prüft diese
Roots vor und nach IO selbst; die Quellenprüfung öffnet keinen geschlossenen
öffentlichen Claim erneut. Aktiver Owner, genaue Invocation, Quelle und Namespace
bleiben erforderlich. Es gibt keine neue Skip-Option und keinen Rechtecache.

Verweigert die Authentifizierung den Eintritt in die Abschlussphase, werden die
eigenen Deskriptoren trotzdem geschlossen. Die Verweigerung bleibt ein Fehler.
Scheitert die Bestätigung nach einer tatsächlichen Schließung, werden Fehler
erhalten und kein Erfolg behauptet. Der bisherige Close-Helfer einschließlich
seines einzigen Wiederholungsversuchs bleibt bytegleich. Request-Verbraucher
behalten ihren bestehenden Verifikations-/Close-Ablauf.

Drei bestehende Top-Level-Produktfunktionen ändern sich; zwei lokale Helfer
strukturieren den Abschluss. 136 andere Top-Level-Funktionen der untersuchten
Produktmodule bleiben bytegleich. Die Risikoanalyse über den älteren Ersatzindex
meldet zunächst CRITICAL und wurde vorab berichtet. Der vollständig neu aufgebaute
Worktree-Index meldet LOW mit zwei direkten Aufrufern für den gemeinsamen Helfer;
die aktuellen Produktreferenzen wurden zusätzlich direkt geprüft. Nach einem
fehlerhaften inkrementellen Indexlauf wurde die lokale GitNexus-CLI verwendet.

## Nachweise

Der neue Test scheitert am unveränderten Vergleichsprodukt: Finale Verifikation
und die beiden tatsächlichen Schließungen teilen dort keinen gehaltenen Principal.
Die ursprünglichen Deskriptoren sind auch im fehlgeschlagenen Kontrolllauf
geschlossen; alle eigenen Ressourcen werden entfernt.

Acht echte PostgreSQL-Fälle bestehen für Agent und MCP: Kontrolle, Kontosperre
auf dem tatsächlichen gehaltenen Backend nach einer echten Schließung, verlorene
Antwort einer tatsächlich erfolgreichen Schließung und verweigerter Eintritt nach
Publikations-COMMIT. Zwölf tatsächliche Schließungen behalten die echten
Berechtigungssperren davor und danach; konkurrierende Änderungen werden mit
`55P03` blockiert. Vier weitere Deskriptoren schließen trotz verweigertem Eintritt.
Die letzte Verifikation und beide Schließungen verwenden denselben beobachteten
Backend-/Transaktionskontext; der tatsächliche Abschluss-COMMIT folgt ihnen.

Fehler und Widerruf liefern keinen Erfolg. Bereits veröffentlichte Dokument-,
Lineage-, Native-, Birth- und Receipt-Zeilen samt `xmin` sowie vollständige Bytes
bleiben erhalten. Explizite Wiederholung behält Originaloperation und Claim und
ändert die abgeschlossenen Zeilen nicht. Der Snapshot verwendet für den nativen
Owner-Token ausschließlich einen Hash. Keine positive SQL-/IO-Antwort wird ersetzt.

Dreizehn PostgreSQL-Suiten bestehen, einschließlich der bisherigen späten
Verifikationsfehler, echten Speicher-COMMIT-Antwortverluste, Herkunfts-/Policy-,
Native-/Owner-Prüfungen sowie vollständiger manueller Anlage und Uploads.
Release-TypeScript, erweitertes TypeScript (32 Wurzeln/5118 Quellen/keine
Diagnosen) und ESLint ohne Warnungen bestehen. Der Test ist über
`npm run test:documents:create:close-phase` in der geschützten lokalen Umgebung
wiederholbar. Die reguläre `test:all`-Auswahl und ihre bedingten Freigaben ändern
sich durch diesen gezielten Eintrag nicht; deren finale Ausführung bleibt offen.

## Vergleich

Vier frische Vorher-/Nachher-Fixtures mit zehn regulär hochgeladenen Quellen
schließen alle 16 Fenster und eigenen Ressourcen. Unbeteiligte Testquellen,
Registry-/Lineage-/Native-/Metadatenzeilen/xmin und physische Bytes bleiben gleich.
Der vorhandene Aufrufer-Profiler stimmt in allen Fenstern exakt mit der regulären
SQL-Zählung überein; Stackfehler: null. Beide Stände verwenden ihr tatsächlich
gebautes natives Addon. Der
[maschinenlesbare Nachweis](document-service-close-phase-2026-10-29.json)
bindet Produktquellen über SHA-256.

| Vollständiger Einstieg | Vorher: SQL / Ausleihen | Jetzt: SQL / Ausleihen |
| --- | ---: | ---: |
| Agent, beide warmen Neuanlagen | 1347 / 43 | 1219 / 37 |
| MCP, beide warmen Neuanlagen | 973 / 32 | 919 / 30 |
| Agent, ursprüngliche Wiederholung | 168 / 7 | 168 / 7 |
| MCP, ursprüngliche Wiederholung | 102 / 12 | 102 / 12 |

Der erste Agenteneinstieg sinkt von 1452 / 77 auf 1324 / 71, MCP von 994 / 45
auf 940 / 43. Die Auswertung verlangt weniger SQL und weniger Ausleihen bei
frischen Anlagen; ursprüngliche Wiederholungen bleiben gleich. Sämtliche Fenster
enden ohne fehlgeschlagene/unbekannte Queryformen und ohne offene Abfragen oder
Verbindungen. Lokale Laufzeiten dienen nur der Diagnose.

Leistungsbudgets und endgültige 10/200-/Latenz-/Parallelitätsabnahmen bleiben
offen. Inkrementelle Links, gemeinsame normale Schreibwege, ursprüngliche
Upload-Batch-Recovery sowie alle finalen Build-/UI-/Gesamtsuite-/CI-/Review-/
Backup-/Restore-/Release-Gates bleiben Teil des Gesamtplans. Review Center und
Undo werden nicht weiterentwickelt; Produktion ist durch diesen Schritt unverändert.
