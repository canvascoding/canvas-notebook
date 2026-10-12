# Schritt 5c-a: Agent-Autorität und Konfigurationskonflikte

Stand: Implementiert und lokal abgenommen. Keine Veröffentlichung oder Container-Abnahme.

## Verhalten

- Workspace-, Projekt- und Organisationsangaben werden aus den tatsächlichen aktuellen SQL-Rechten aufgelöst. Eine übergebene ID allein gewährt keine Agentenrechte. Persönliche Workspaces behalten die genaue Eigentümerprüfung und die aktuelle globale Workspace-Rolle; gemeinsame Bereiche verwenden die aktuelle Organisationsmitgliedschaft.
- Profiländerungen prüfen das tatsächliche Ergebnis des bedingten Updates. Bei derselben erwarteten Revision kann genau ein Schreiber gewinnen; ein verlorener Vergleich liefert einen Konflikt.
- Capability-Zuordnungen sowie das Setzen und Entfernen von Agent-Freigaben ändern Profil und abhängige SQL-Zeilen in derselben Transaktion. Die aktuelle Agent-Autorität wird nach einem möglichen Lock-Wait erneut geprüft. Ein SQL-Fehler rollt sämtliche Teiländerungen zurück; es gibt kein nachträgliches Zurückschreiben einer alten Zuordnung.
- Die vorbereitende Capability-Auflösung läuft vor der Schreibtransaktion. Dadurch halten wartende Änderungen keine zusätzlichen Pool-Leases für Katalogabfragen. Die Transaktion prüft die aktuelle Autorität und die erwartete Profilrevision nochmals.

## Nachweise und Grenzen

Die fokussierte Actor-Fixture verwendet die tatsächliche PostgreSQL-Engine und Schemaabfragen. Das native Konkurrenz-Gate verwendet die produktive `openDb`-/Drizzle-Strecke, einen Pool mit acht Clients und getrennte Beobachter/Locker. Es beobachtet tatsächliche Lock-Waits und verwendet echte SQL-Trigger für Fehlerfälle; API- und Agent-Tool-Aufrufe haben echte BetterAuth-Sitzungen beziehungsweise den tatsächlichen ausführenden Nutzer.

Der Transaktionsvertrag in diesem Schritt gilt für `updateManagedAgentCapabilities`, `setManagedAgentGrant` und `removeManagedAgentGrant`. Er ist keine Abnahme sämtlicher bestehender Profil-, Modell-, Datei- oder Löschabläufe. Die vorbereitende Katalogbereitschaft ist keine gehaltene Paket- oder Account-Freigabe; die Runtime prüft diese Rechte weiterhin aktuell. Verbindliche Workflow-Pakete, Versionen und Verbindungen folgen in 5c-b.

Die isolierte native Datenbank hat keine verifizierte Team-Lizenz für Member-HTTP; der native HTTP-Test prüft deshalb einen tatsächlich angemeldeten Nutzer mit ausschließlich Agent-Use und ohne Agent-Verwaltungsrecht. Die Browserabnahme verwendet den vorhandenen verwalteten Admin-/Member-Kontext. Tatsächliche Drittanbieter-Accounts bleiben Schritt 7.

## Abschlussprüfungen

- Actor-Fixture, vollständige `test:integrations:gateway`-Regression, `test:pi:tools`, sechs Paketregressionen und die vollständige deklarierte Skill-Script-Suite bestanden. Der erste Gateway-Lauf zeigte den External-/Personal-Regressionsfall; nach der engen Produktkorrektur besteht der vollständige Lauf. Der gesonderte Managed-Control-Plane-Opt-in wurde nicht erneut ausgeführt; dessen Code blieb unverändert.
- Finaler `npm run build` besteht. Der Build meldet die bereits bekannten fehlenden Buildzeit-OAuth-/Base-URLs; das mit den privaten verwalteten Laufzeitwerten gestartete Notebook ist PostgreSQL-gesund. Keine Container wurden für diesen Schritt gebaut oder verändert.
- Playwright `agent-workflow-foundation-local.spec.ts`: vier bestanden, ein ausdrücklich übersprungener Projektfall, ein Worker, keine Retries, 9.1 Sekunden. Tatsächliche vorhandene Admin-/Member-Sitzungen, Use-only ohne Edit-Control, HTTP-403 ohne Konfigurationsänderung, gleichzeitiger 200/409-Save mit identischem Profil-/Binding-Gewinner, gefälschter Team-Kontext und nach ausdrücklich zugewiesener Mitgliedschaft erlaubtes Update; persönlicher Owner bearbeitet und speichert über den echten Dialog.
- Desktop 1280px hell und Mobile 390px dunkel mit geladenem Agentenmenü ohne horizontale Überläufe; persönliche Bearbeitung und wieder geladenes Menü visuell geprüft. Der Projekt-Browserfall benötigt ein tatsächlich unerreichbares aktives Projekt im vorhandenen Katalog. Der Test erstellt mangels sicherem Projekt-Löschvertrag kein zusätzliches Projekt und ändert keinen Feature-Schalter; das native Gate prüft tatsächliche Projekt- und Projekt-Workspace-Kontexte separat.
- Browser-Cleanup verwendet genaue Creator-, Scope-, Profil-/Binding-/Grant-Snapshot- und Revisionsguards sowie tatsächliche Session-/Preview-Prüfungen. Eigene Agenten werden entfernt, das eigene Team nur deaktiviert. Globale Settings, Provider-Konfiguration und fremde Ressourcen werden nicht verändert.

- Finales natives PostgreSQL-Gate mit vollständigem Pooldruck besteht: acht tatsächlich beobachtete Runtime-Backend-Waiter bei Pool-Maximum acht, separater Locker/Beobachter, nach Freigabe genau ein vollständiger Profil-/Binding-Gewinner und sieben Versionskonflikte innerhalb der begrenzten Beobachtungsfrist. Die vollständigen CAS-, Trigger-Rollback-, drei Mutator-Widerrufs-, Team-/Projekt-/Personal-, API- und Agent-Tool-Fälle bestehen auf dem endgültigen Produktstand.
- Unabhängiges Browser-Readback bestätigt 0 Foundation-Agenten, 0 zugehörige Agent-Verzeichnisse und genau das deaktivierte eigene Team. Der anhand PID, Kommando und CWD verifizierte eigene Hostserver wurde beendet. Der parallel von einem anderen Branch verwendete Notebook-Container und die verwaltete PostgreSQL-/Control-Plane-Umgebung blieben unangetastet.
- Frischer vollständiger GitNexus-Index: 60759 Knoten, 163683 Beziehungen, 2670 Cluster, 300 Flows. Staged-Erkennung: 97 Symbole/13 Dateien; Compare-main: 2602 Symbole/294 Dateien über alle bisherigen Schritte, ein bereits geprüfter MCP-Scope-Normalisierungsflow. Vollständiger tatsächlicher Diff und die bereits gemeldeten HIGH-/CRITICAL-Einzelimpacts wurden separat geprüft; der zusammenfassende niedrige Staged-Risikowert ersetzt diese Prüfung nicht. Generierte AGENTS-/CLAUDE-Blöcke wurden ohne Änderung anderer Inhalte zurückgesetzt.
