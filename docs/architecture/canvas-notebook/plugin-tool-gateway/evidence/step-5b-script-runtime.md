# Schritt 5b: deklarierte Skill-Code-Laufzeit

Stand: Implementiert und lokal abgenommen. Keine Veröffentlichung oder Container-Abnahme.

## Verhalten und Grenzen

- Veröffentlichtes vollständiges Skill-Paket mit `.canvas-skill/runtime.json`; kurze Liste, aktuelle Beschreibung und ausdrücklich erlaubter Run. Core-/Legacy-Skills benötigen eine veröffentlichte Variante. Installation allein erlaubt keine Ausführung.
- Node und Python laufen auf einem exakten unveränderlichen Snapshot in einem eigenen privaten Session-Laufverzeichnis. Paket, Runtime und SDK sind lesbar, der eigene Scratchbereich beschreibbar. Es gibt keinen direkten Netzwerkzugang, keine Provider-Secrets und keine zusätzlichen Prozesse. Fehlende Isolation verhindert den Start.
- Native Tools behalten die bestehende Canvas-Ausführung und menschliche Review-Verträge. Externe Aliase verwenden die vorhandene MCP-/Composio-Dispatcher-Strecke mit tatsächlicher Account-, Schema- und Versionsbindung. Keine zweite Provider-Implementierung.
- Jede Operation prüft aktuelle Agentenauswahl, Session, Paketbytes und Nutzungsrechte. Die Brücke begrenzt Aufrufe, Nachrichten und Zeit. Unbekannte Ergebnisse stoppen den Run und verwenden die bestehende dauerhafte Turn-/Delegationssperre. Bestätigte Teilwirkungen bleiben im Ergebnis erhalten.
- Nur ausdrücklich zugeordnete Ausgabedateien gelangen über die vorhandenen Canvas-Dateioperationen in den Workspace. Konfliktprüfung, Review, Undo und Zusammenarbeit bleiben erhalten. Der Run nennt die konkrete veröffentlichte Revision und Prüfsumme.
- Planning erlaubt Liste und Beschreibung; Run ist ausgeschlossen. Run bleibt standardmäßig deaktiviert. Der gemeinsame Integrations-Gateway-Schalter bleibt standardmäßig ausgeschaltet.

## Abnahme

- Manifest- und Autorisierungsfixtures: strenge Deklaration, tatsächliche PostgreSQL-Engine, veröffentlichte Paketbytes, held v1 nach v2, Auswahl und Widerruf.
- Bridge-Fixture: tatsächliche SQL-/Agentenauthorität, native Outbox-Review, echtes MCP-HTTP und Composio-SDK, genaue Accounts, bekannte Lesefehler ohne unklare Schreibwirkung, Abort/Deadline, dauerhafte Unsicherheit einschließlich Elternturn und fehlgeschlagener Persistenz.
- Echter Darwin/arm64- und Linux/arm64-Prozess: Node/Python-SDK, wiederholte RPCs, Paketmutation/fremde Dateien verweigert, TCP/IPv6/UDP/Unix ohne Egress, zusätzliche Prozesse verweigert, Abort/Revoke/Frame-/Byte-/Loggrenzen und tatsächliches 60-Sekunden-Limit. Verzögerte Watcher nach Prozessende lösen keinen weiteren Abbruch aus.
- Bestehende Tool-Registry, Datei-Referenzvertrag, vollständige Gateway-Regression und sechs Paketregressionen bestanden. Native x86-64-Kernel wurden nicht geprüft.
- Tatsächlicher Cross-Process-Preference-Test: derselbe Datei-Lock sperrt konkurrierende Schreiber, Fremdeinträge bleiben erhalten, gleicher CAS hat genau einen Gewinner, stale Writes verändern keine Bytes. Test-Cleanup entfernt nur den exakt receiptierten eigenen Aktivierungseintrag.

## Abschlussbelege

- `npm run test:skills:scripts`: vollständige Manifest-/Autorisierungs-/Bridge-/Actions-Suite PASS. Ein zunächst roter NativeRead wurde auf überlappende Test-Transaktionen derselben PGlite-Sitzung zurückgeführt (PG25001). Der Testadapter verwendet nun tatsächliche isolierte Transaktions-Leases; eine eigene SQL-Regression und die vollständige Suite bestehen. Produktcode blieb unverändert.
- `npm run test:capabilities:preferences:lock`: tatsächliche konkurrierende Prozesse und CAS PASS. Bestehende Cleanup-Guard-Suite PASS.
- Finaler `npm run build`, vollständiges TypeScript und ESLint aller geänderten Produkt-/Fixturequellen PASS. Der Build enthält Warnungen zu dynamischer Dateiverfolgung und zur fehlenden Buildzeit-OAuth-URL; das tatsächlich gestartete Notebook war mit PostgreSQL gesund.
- Playwright `tests/skill-script-runtime-local.spec.ts`: vollständiger erster Lauf 3/3 PASS, ein Worker, keine Retries, 3.5 Minuten. Tatsächliche natürliche Modellanfragen an den privaten ausgewählten Agenten führen genau den gewünschten Node-/Python-Einstiegspunkt aus; gespeicherte Tool-Ergebnisse, Revision, Prüfsumme und Scratchmarker stimmen. Planning verwendet kein Run-Tool.
- Abschließender gezielter Node-/Python-Lauf nach Screenshot-Readiness-Korrekturen: 2/2 PASS, ein Worker, keine Retries, 2.6 Minuten. Der Test wartet auf das echte Runtime-Ergebnis und den fertigen Composer, prüft den zugänglichen Mobile-Agentennamen und öffnet bei Bedarf die legitimerweise geschlossene Desktop-Dateiseitenleiste. Frühere Capture-Fehler waren Testannahmen über Hydration/responsiven Layoutzustand; keine Produktänderung.
- Stabile 1280px-/390px-Screenshots hell/dunkel, kompakt/erweitert, geprüft. Kompakte Zeilen enthalten keine technischen Paketreferenzen; die geöffneten Details zeigen konkrete Revision und Prüfsumme, bleiben im Viewport und lassen sich schließen.
- Cleanup einschließlich eigener persönlicher Aktivierung bestand. Unabhängige PostgreSQL-/Filesystem-Readbacks bestätigten für alle Browserfixtures eigene Ressourcen/Entwürfe/Versionen/Preferences/Intake jeweils 0. Nur der anhand PID, CWD und Kommando geprüfte eigene Notebook-Server wurde beendet.
- Frischer vollständiger GitNexus-Index: 60676 Knoten, 163430 Beziehungen, 2667 Cluster, 300 Flows. Staged-Erkennung: 382 Symbole/35 Dateien; Compare-main: 2507 Symbole/284 Dateien über alle abgeschlossenen Schritte, ein bereits geprüfter MCP-Scope-Normalisierungsflow. Erwartete Laufzeit-/Registry-/Gateway-/Dateireferenz-/Fixture-Änderungen und die vollständige Diff wurden neben den zuvor gemeldeten HIGH-/CRITICAL-Einzelimpacts geprüft. Automatisch erzeugte AGENTS-/CLAUDE-Blöcke wurden ohne Änderung anderer Inhalte zurückgesetzt.

Die vorhandene verwaltete PostgreSQL-/Control-Plane-Umgebung und eine bereits laufende Linux-Test-VM wurden verwendet. Es wurde kein Container gebaut, keine neue Testumgebung gestartet und nichts veröffentlicht. Tatsächliche Drittanbieter-Accounts und gemeinsame Canva-Abnahme bleiben Schritt 7.
