# Schritt 6b-a: Aktuelle Rechte vor mobilen Paketdaten

Lokal abgenommen am 2026-10-07 auf `feat/plugin-integration-gateway`.

## Änderung und nachgewiesene Fehler

Die mobilen Detail- und Bild-Endpunkte verwendeten den Registry-Lookup ohne konkrete Ressourcenfreigabe. Die isolierte echte PostgreSQL-/Dateisystem-Fixture zeigte für ein nicht freigegebenes Organisationsmitglied zweimal HTTP 200, obwohl der gemeinsame Ressourcen-Katalog die exakte Instanz ausschloss. Beide Endpunkte verwenden jetzt den vorhandenen autorisierten Paketleser, konkrete kanonische beziehungsweise historische Ressourcen-IDs und den aktuellen Workspace. Der bisherige berechtigte Name-plus-Bereich-Aufruf bleibt kompatibel. Persönliche und organisationseigene Instanzen werden nicht als Ersatz füreinander verwendet.

Die Bildroute lehnt Traversal, absolute Pfade, NUL-Zeichen und Symlinks ab, prüft die Rechte vor Dateizugriffen und erneut vor sowie nach dem Lesen und verwendet `private, no-store`. Die Detailroute prüft nach ihrer bestehenden sicheren Projektion nochmals die aktuellen Leserechte.

Zwei weitere reproduzierte Fälle sind zentral korrigiert:

- Der Katalog öffnete bei älteren Paketen private Skill-Dateien vor der Ablehnung. Die bestehende Ressourcenprüfung steht jetzt auch für unveröffentlichte Pakete vor dem frühen Rückgabepfad. Der zunächst beobachtete Fall mit sechs Inhaltslesevorgängen liefert danach null.
- Nicht zugängliche Workspaces lieferten einen generischen HTTP 500. Die gemeinsame Kontextauflösung übersetzt die Ablehnung jetzt in einen typisierten Ressourcenfehler; die mobilen Endpunkte liefern ohne Metadaten HTTP 404.

Die zentrale Katalogfunktion wurde vor Änderung als HIGH, der gemeinsame Ressourcenleser als CRITICAL eingestuft und entsprechend angekündigt. Eigentum, Freigaben und die getrennten Use-/Edit-/Manage-Rechte bleiben bei den vorhandenen gemeinsamen Actions und Stores.

## Abnahme

- `npm run test:mobile:plugin-resources`: PASS. Tatsächliche isolierte PGlite-Engine, Registry, Ressourcen-Actions, Dateien und mobile Handler; nur Datenbanktransport und HTTP-Sessionadapter sind Fixture-Einstiegspunkte. Berechtigte und abgewiesene kanonische/historische/persönlich freigegebene Referenzen, unabhängige Rechte, aktuelle Workspace-/Mitgliedschafts-/Nutzersperren, Pfadgrenzen und echter Widerruf nach dem PNG-Lesen sind geprüft. Zu Beginn abgewiesene private Paketinhalte bleiben ungeöffnet. Rechtmäßig lesbare andere Katalogressourcen werden dabei nicht als verbotene Zugriffe gezählt.
- Bestehende Ressourcen-Access-/Actions-/Entrypoint-Prüfungen, drei Plugin-Katalogprüfungen, sechs Store-Provenienzprüfungen, Plugin-App-Regressionen, gemeinsame Verbindungsprüfungen sowie Gateway-Settings-/Receipt-/Automation-Prüfungen: PASS. Die bestehenden gemeinsamen Ressourcen-Fixtures prüfen zusätzlich Team-Eigentum und Team-Freigaben.
- Ältere Source-Marker wurden auf die bereits vorhandenen exakten Leser aktualisiert. Zwei überholte Store-Erwartungen prüfen jetzt die konkrete installierte Ressource mit unbekannter Herkunft, ohne einen ungeprüften Upstream-Treffer zu behaupten.
- Finaler `npm run build`, anschließende vollständige TypeScript-Prüfung und ESLint aller geänderten Quellen/Fixtures: PASS. Die kleine Bild-Fixture wurde zusätzlich tatsächlich decodiert.
- Playwright `mobile-plugin-access-local.spec.ts`: **1/1 PASS**, ein Chromium-Worker, keine Wiederholungen, 15,8 Sekunden Test beziehungsweise 49 Sekunden Gesamtlauf. Tatsächlicher Produktionshost, vorhandene Admin-/Mitglieds-Logins, eigener HTTPS-Store und echte UI-Installation/Freigabe/Widerruf; keine API-/Provider-Mocks. Use-only-Freigabe liefert die sicheren mobilen Metadaten und exakten PNG-Bytes, Widerruf unmittelbar zweimal 404. Falsche Referenzen und Bereiche bleiben abgewiesen.
- Cleanup verwendet unveränderte strenge Publikations-, Revisions- und Source-Inode-Belege. Unabhängiger Rücklesetest: eigene Ressourcen, Entwürfe, Versionen, Präferenzen und Intake jeweils **0**. Nur eigene Host-/HTTPS-Prozesse wurden beendet; der fremde verwaltete Stack wurde nicht verändert.
- Frischer vollständiger GitNexus-Index: 63.015 Knoten, 170.140 Kanten, 2.774 Cluster und 300 Flows. Nur automatisch erzeugte Dokumentationsblöcke wurden danach wiederhergestellt. Staged-Prüfung: 88 Symbole in 14 Dateien, LOW; gesamter Vergleich gegen `main`: 4.713 Symbole in 455 Dateien, 16 erwartete bisherige Abläufe, CRITICAL entsprechend angekündigt.

## Offene Abnahmegrenzen

Die breitere Gateway-Suite besteht bis zur bestehenden Registry-Rollback-Schema-Assertion und bleibt dort rot. Eine separate Wiederholung mit den unveränderten HEAD-Versionen beider geänderten gemeinsamen Lesemodule reproduziert dieselbe Assertion; beide Ausgangsmodule wurden nachweislich geladen. Die genaue Schema-Abnahme wird in 6b-b zusammen mit effektiven Planning-Metadaten abgeschlossen. Die vollständige Gateway-Suite wird hier daher ausdrücklich nicht als bestanden gewertet.

Diese Abnahme betrifft Web-UI und cookie-authentifizierte mobile HTTP-Verträge. Native Geräte, Bearer-/OAuth-Rückkehr, die übrigen mobilen Ressourcenverträge und echte Drittanbieter-Accounts folgen in 6b beziehungsweise 7. Die neue Gateway-Feature-Flag bleibt standardmäßig ausgeschaltet. Keine Container wurden gebaut und nichts wurde gepusht oder veröffentlicht.
