# Schritt 4b: gemeinsame Verbindungen

Stand: 2026-10-06, lokale Abnahme auf `feat/plugin-integration-gateway`. Notebook und isolierter Control-Plane-Branch verwenden denselben additiven Vertrag. Control-Plane-Commit: `a052a627cde3e16efae44e56c9a42303322ba9d5`. Keine Veröffentlichung und kein Container-Build.

## Verbindungs- und Berechtigungsvertrag

- Gemeinsame Ressourcen haben ausdrücklich Organisations- oder Team-Eigentum. Ersteller, letzter Bearbeiter und verantwortliche Person sind gesonderte Metadaten; gelöschte Einrichter löschen keine gemeinsame Verbindung oder gemeinsames Profil.
- `canUse` und `canManage` sind unabhängig. Eine Verwaltung darf dadurch nicht automatisch Provider-Tools ausführen. Neue Verbindungen sind ohne Nutzungsfreigaben eingerichtet. Interne Bereichsvererbung ist ausdrücklich wählbar; externe Personen benötigen gezielte Freigaben und gültige aktuelle Laufzeitrechte.
- Eine Verbindung bindet einen konkreten MCP-Backend-Identifier oder ein konkretes Composio-Profil, eine App, einen festen Provider-Modus und einen ausgewählten Account. Öffentliche DTOs und Account-Picker zeigen keine Backend-Accounts, Provider-Nutzeridentitäten, Credentials oder private Konfiguration.
- Aktueller Nutzer, aktive Organisation und Team, Workspace, persistierte Agentensession, Grants und Tool-Grenzen werden vor Discovery und Ausführung geprüft. Gesperrte beziehungsweise archivierte Quellen starten keine SDK-Discovery und fallen nicht auf einen persönlichen Account zurück. Zwei Nutzer verwenden denselben freigegebenen Backend-Account mit getrennten Canvas-Auftraggebern und Audit-Zuordnungen.
- Metadaten, Freigaben und Anbieterbindung haben getrennte Revisionen. Alte Änderungen und OAuth-Rückkehr werden bei Konflikt oder Widerruf abgewiesen. Die UI bewahrt einen Entwurf bei `409` bis zum ausdrücklichen Neuladen.
- MCP-Secrets sind verschlüsselte, ausschließlich der Verbindung gehörende Slots im zentralen Organisationsspeicher. Ein Veröffentlichungsmarker wird mit der tatsächlich committed Bindung verglichen; ein Fehler zwischen SQL und ENV/Dateischreiben bleibt gesperrt und benötigt eine ausdrückliche Reparatur.
- Gemeinsame lokale Composio-Profile lesen ausschließlich den Organisationskey. Managed-Zugriff verwendet den versionierten Control-Plane-Vertrag; ältere Gegenseiten werden ausdrücklich als nicht unterstützt behandelt. Persönliche Defaults, Workspace-Overrides und bestehende Trigger behalten ihren bisherigen Vertrag.

## Tatsächliche Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| Vollständiges `npm run test:integrations:gateway`, einschließlich neuer Connection-Gates | PASS auf endgültigem Produktcode |
| Native PostgreSQL mit acht Pool-Clients: gemeinsame Store-/API-Rechte, CAS, Widerruf nach beobachteter Sperre und parallele Änderungen | PASS |
| Native Sperrregression gegen die kanonische Organisationsaktualisierung | Vorher tatsächliches `40P01`; nach Vereinheitlichung Organisation → Nutzer beide Transaktionen erfolgreich |
| Bestehender Capability-Resource-Store unter nativem PostgreSQL sowie Store/Actions/Access/Entrypoints mit tatsächlichem PostgreSQL-Engine-Schema | PASS |
| Tatsächliche MCP HTTP-, OAuth- und STDIO- sowie lokale Composio SDK-Fixtures | PASS; exakte Bindung, aktuelle Rechte, Key-/Account-Wechsel, keine persönliche Ausweichbindung |
| Zwei tatsächliche `getPiTools`-Nutzerkontexte mit demselben ausgewählten gemeinsamen Composio-Account | PASS; getrennte Auftraggeber-/Session-Audits, gleicher Provider-Account |
| Notebook SQL → tatsächlicher Fastify-Control-Plane-Router → Composio SDK | PASS; gemeinsames Profil, Status, OAuth, Auswahl, Rotation und exakter Disconnect |
| Control-Plane-Binding und vier bestehende Composio-Regressionsgruppen | 23 Prüfungen PASS; vollständiger Workspace-Typecheck PASS |
| `npm run test:plugins:app` | PASS |
| `npm run build`, vollständiger `tsc --noEmit`, ESLint aller 82 geänderten Source-/Fixture-Dateien, `git diff --check` | PASS |
| Playwright: gemeinsame Verbindungsverwaltung | 3/3 PASS, ein Worker, keine Retries, 22 Sekunden am endgültigen Produktionsbuild |
| Playwright: bestehende Ressourcenverwaltung nach Berechtigungsänderung | 1/1 PASS, ein Worker, keine Retries, 14 Sekunden |

Der Browserlauf benutzt die tatsächlichen Bootstrap-/Member-Identitäten und APIs des lokalen PostgreSQL-Servers. Er richtet eine Team-MCP-Verbindung und ein Organisations-Composio-Profil ein, wählt ein undurchsichtiges Account-Handle aus, ändert Verantwortliche über den suchbaren Picker mit Tastatur und Maus, vergibt ein begrenztes Nutzungsrecht, prüft `403` für Verwaltung ohne Recht und prüft direkten Entzug mit verschwundener UI-Ressource. Ein konkurrierendes API-Update erzeugt den tatsächlichen UI-Revisionenkonflikt.

1280px und 390px, hell und dunkel: keine horizontale Überbreite, tatsächlich geladene Formularfelder, erreichbares Speichern und gezielte Freigaben. Die stabilen Screenshots wurden visuell geprüft. Lokale Browserartefakte: `/tmp/canvas-plugin-gateway-stage4b-shared-browser-artifacts` und `/tmp/canvas-plugin-gateway-stage4b-resource-browser-artifacts`.

## Bereinigung und Grenzen

Eigene kurzlebige native Testdatenbanken wurden nach Eigentumsprüfung entfernt. Bereits bestehende fremde Testdatenbanken blieben erhalten. Die Browser-Fixture restaurierte den ursprünglichen Organisationskey mit Revisions-/Wertprüfung, entfernte ihren MCP-Secret-Slot, archivierte ihre eigenen Verbindungen und ihr Profil und deaktivierte ausschließlich selbst angelegte Teams. Archiv- und Auditdatensätze bleiben nachvollziehbar. Danach wurden der eigene Notebook-Server und der eigene Provider-Prozess beendet; PostgreSQL und Control Plane blieben bestehen.

Die Provider-Fixtures sind kein Nachweis für einen echten Drittanbieter-Account. Echte MCP-/Composio-Accounts und ein real geteilter Canva-Account bleiben Schritt 7. Gemeinsame MCP-App-Tickets und Desktop-OAuth sind bis Schritt 6b ausdrücklich nicht unterstützt. Versionierte Skill-Pakete, begrenzte Script-Ausführung, verbindliche Workflow-Agenten und das vollständige Plugin-Seiten-Redesign sind weiterhin die folgenden Umsetzungsschritte. Die Gateway-Flag bleibt standardmäßig ausgeschaltet.
