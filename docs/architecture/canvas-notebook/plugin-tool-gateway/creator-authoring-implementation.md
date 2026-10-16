# Skill-/Plugin-Creator: Umsetzung und Abnahme

Grundlage ist der [bestätigte Org-Creator-Plan](creator-authoring-marketplace-plan.md), einschließlich Nutzerpräzisierung: organisationsverwaltete Pakete, neue und vorhandene Skills, Custom-MCP/Composio, beschreibendes SVG, verbindliche Paketvalidierung und vollständiger E2E-Test. Marketplace-Publikation ist nicht Teil des Auftrags.

## Fortschritt

| Schritt | Status | Nachweis |
| --- | --- | --- |
| P1 Neuanlage und Wiederaufnahme | Backend-/API-Grundlage abgeschlossen | Sourcefreier Org-Create, aktorprivate Liste/Status, dauerhafte Operationsbelege; native PostgreSQL-, API-, Gateway- und Regressionsprüfungen bestanden. Erstellungsoberfläche und Chat-E2E folgen P5/P7. |
| P2 Vollständige Skill-/Integrationskomposition | Backend-/API-Grundlage abgeschlossen | Vollständige gemeinsame Komposition, private Quellen, explizite Legacyimporte und Gateway; erweiterte native PostgreSQL-, Parallelitäts- und Paketregressionen bestanden. |
| P3 Creator und SVG-Teilskill | Offen | Noch keine Abnahme. |
| P4 Schema-/Paket-/SVG-Validierung | Offen | Noch keine Abnahme. |
| P5 Oberfläche | Offen | Noch keine Abnahme. |
| P6 Org-Bereitstellung und Laufzeit | Offen | Noch keine Abnahme. |
| P7 Creator-Agentenlauf und E2E | Offen | Noch keine Abnahme. |

Einzelne Codeänderungen oder grüne Teiltests bedeuten keine vollständige Umsetzung. Die Phasen werden der Reihe nach abgeschlossen.

## Prüfumfang

- **Paketlebenszyklus:** Quelle wirklich optional nur bei Neuanlage; bestehende Edit-/Forkrechte unverändert; aktuelle Organisationsautorität; private Entwürfe; CAS; Wiederaufnahme nach Create/Publish-Antwortverlust; eindeutige Publish-/Discardbelege.
- **Komposition:** Vollständige neue und übernommene Skills einschließlich Parent-Ressourcen, Connector-Hoist, Konflikte, exakte Quellen und Versionen.
- **Creator:** Geschütztes Core-Plugin, kompatible bestehende Skill-IDs, gezielter vollständiger SVG-Teilskill, gemeinsame Gateway-Aktionen statt Legacy-Installation.
- **Validierung:** Kanonisches Schema und vollständiger Paketbaum, SVG als vorhandenes passives Bild mit sinnvollem viewBox/Titel/Beschreibung; erneute Prüfung bei Publish; Altbestandskompatibilität.
- **Oberfläche:** Gemeinsamer Einstieg, Progressive Disclosure, Grafikdarstellung, zugängliche Einbettung, Reload/Fortsetzung, schmale Darstellung und Versionswechsel.
- **Nutzung:** Org-Besitz, Use-Grants und Aktivierung getrennt; exakte Chat-/Agentreferenz; eigene zulässige Verbindungen; gezielte MCP-/Composio-Discovery und Ausführung.
- **E2E:** Vollständiger neuer plus vorhandener Skill mit beiden Integrationsarten und SVG, echter Creator-Agentenlauf, tatsächlicher UI-Weg, unabhängiger API-/SQL-/Dateiabgleich und negative Fälle. Reale externe Provider und kontrollierte Testprovider werden getrennt ausgewiesen.

## Lokaler Prüfrahmen

Der vorhandene verwaltete lokale Stack wurde vor Änderungen inventarisiert. Notebook auf Port 3100, Control Plane auf 4001/4004 und PostgreSQL auf 55433 laufen. Bestehende andere Projektcontainer werden nicht verändert. Für UI-Prüfungen wird der aktuelle Quellstand über den vom Skill unterstützten Hostserver verwendet beziehungsweise nur ein ausdrücklich erforderlicher verwalteter Container aktualisiert. Keine parallele zweite Testumgebung und keine Wiederverwendung eines alten Containerstands als Beleg für neuen Code.

Browserprüfung ist durch den Umsetzungsauftrag mit E2E ausdrücklich beauftragt. Noch kein Browser-/Providerlauf für diesen Creator-Ausbau erfolgt.

## P1: Paketlebenszyklus und Wiederaufnahme

Neue `create`-Entwürfe besitzen keine Quelle und erlauben kein vom Aufrufer gewähltes Organisationsziel. Die Organisation und aktuelle Zielverwaltung kommen aus dem authentifizierten Kontext. Erst erfolgreicher Publish erzeugt die Org-Ressource; sie startet eingeschränkt und deaktiviert. Edit/Fork behalten ihre bisherigen Quellen- und Revisionsprüfungen.

Eine aktorprivate Operationstabelle erhält Create-, Publish- und Discardergebnisse über die Lebensdauer des Entwurfs hinaus. Ein Requestschlüssel ist an die tatsächliche Eingabe einschließlich Zielorganisation gebunden. Gleiche Wiederholungen erzeugen keine zweite Version; vollständige Publish-Replays verlangen heutiges Leserecht. Reine Recovery-Metadaten erteilen keine Datei-/Nutzungsrechte. Neue Agentreads und REST-Recovery verwenden dieselben Dienste.

Die Migration läuft einmalig mit eigenem Datenmigrationsbeleg, Advisory-Lock und atomarem DDL. Legacy-Edit/Forkquellen bleiben verpflichtend; nur sourcefreie Creates erlauben vollständig leere Quellherkunft. Diese Bedingungen sind sowohl im Schema als auch in der Bestandsmigration enthalten.

Bereits abgeschlossene Prüfungen:

| Prüfung | Ergebnis |
| --- | --- |
| `npm run test:capabilities:packages` | PASS: Bytes/Pfade, SQL-Autorität, neue HTTP-Neuanlage, Edit/Fork, Gateway, Runtime und sichere Bereinigung. Die neue separate Migrationsprüfung ist inzwischen zusätzlich in diese Kette aufgenommen. |
| `npm run test:capabilities:packages:drafts` | PASS: aktorprivate Liste/Status, Pagination, Kontextbindung, Rechteentzug und CAS. |
| `capability-package-actions-test.ts` mit nativem PostgreSQL | PASS: parallele Create-/Publishwiederholungen, Requestkonflikte, genau eine Version, echte Paketdateien und bisherige Edit-/Forkpfade. Ausschließlich eigene Nonce-Datenbank auf bestehendem lokalen PostgreSQL; wieder entfernt. |
| `capability-package-native-test.ts` | PASS: native SQL-Sperren/CAS, wartender Publisher nach Rechteentzug, Registry-/SQL-Rollback und konkurrierende Namenskonflikte. |
| `capability-package-authoring-migration-test.ts` | PASS mit PGlite und nativem PostgreSQL: alte DDL-Form, injizierter Fehler mit vollständigem Rollback, Quellbedingungen, genau ein Migrationsbeleg, stabile Constraint-IDs und parallele Wiederholung. |
| `capability-package-artifacts-test.ts` und `planning-progressive-runtime-test.ts` | PASS: echte Gateway-/SDK-/SQL-Pfade; Recoveryreads erlaubt, Schreiben im Planningmodus weiterhin gesperrt. Keine Modell-/Provideraufrufe als Teil dieser Tests. |
| `capability-package-store-provenance-test.ts` | PASS: tatsächliche Storeimporte, genaue Quellen, Forkherkunft, Konflikte und später Rechteentzug. |
| `capability-package-store-application-test.ts` | PASS: sechs genaue Installations-/Updatebereiche, bestehende Agent-Pins, Legacy-/Seedhistorie, Konflikte, Rollback, ungewisser Commit und echte HTTP-/Agentwege. Veralteten Fixtureauftrag auf den heutigen vollständigen `extensions`-Schreibvertrag portiert; keine Produkt-Abwärtskompatibilität erzwungen und keine Fälle übersprungen. |
| `tsc -p tsconfig.release.json --noEmit --incremental false` | PASS mit 12-GiB-Heap; Produktquellen. |
| Fokussierter TypeScript-Lauf aller geänderten TS-/TSX-Dateien samt Abhängigkeiten und Projektdeklarationen | PASS mit 12-GiB-Heap. |

Die breite TypeScript-Prüfung umfasst auch ältere Scriptfixtures. Ein unabhängiger CompilerHost-Lauf über die unveränderten HEAD-Quellen `fbf20b981` mit denselben Abhängigkeiten bestätigt 58 bestehende Scriptdiagnosen. P1-Typfolgen wurden behoben; der abschließende fokussierte Lauf ist sauber. Daraus wird kein grüner Gesamt-Typecheck behauptet. Neue Erstellungsoberfläche, Creator-Inhalt und durchgängiger Browser-/Agentenlauf sind hiermit ausdrücklich noch nicht abgenommen.

## P2: Kontrollierte vollständige Komposition

`compose_canvas_package_skills` und der entsprechende REST-Weg übernehmen einen begrenzten Batch vollständig in genau eine Entwurfsrevision. Die Auswahl bindet Quelle, genaue Veröffentlichung, Checksumme und gegebenenfalls den deklarierten Parent-Unterordner. Parent- und Geschwisterressourcen bleiben aufgelöst; strukturierte Bild-, Markdown-, Connector- und Workflowreferenzen werden gezielt angepasst. Standalone-MCP-Deklarationen wandern zum Elternplugin. Geänderte Skills erhalten eine konsistente unabhängige Ableitungsversion. Gemeinsame Anforderungen vereinigen die ausgewählten Skillzuordnungen; unterschiedliche Deklarationen oder Dateiinhalte führen zum atomaren Konflikt.

Quellbytes werden vor dem Parsen vollständig erfasst. Aggregierte Datei-/Bytebudgets, wiederverwendete Parentcaptures, begrenzte Strukturprüfung und vollständige MCP-Konfigurationsprüfung gelten auch für Legacyimporte. Private Accounts, Zugangswerte oder lokale Verbindungen werden nicht übernommen. Lizenz-/Autoren-/Quellangaben bleiben erhalten. Die private Herkunft wird in derselben SQL-Transaktion wie der Entwurf gespeichert; aktuelle Quellleserechte werden bis zum ersten Publish erneut geprüft. Eine sortierte gemeinsame Ressourcenlock-Menge schließt gegenseitige A/B-Kompositionen ein.

Alte verwaltete Workspaceentwürfe lassen sich ausdrücklich anhand ihrer serverseitig aufgelösten Identität prüfen und in einen leeren gemeinsamen Entwurf importieren. Es gibt keine frei übergebbaren Serverpfade, automatische Installation oder Löschung der alten Quelle. Umbenennungen passen Workflowreferenzen und Versionen an. Inspector und Versionsliste sind im Planningmodus lesbar; Komposition und Import bleiben dort gesperrt.

Abgeschlossene Prüfungen:

- `npm run test:capabilities:packages` besteht vollständig: IO, SQL-Store, Migration, erweiterte Actions, tatsächlicher Agentgateway, exakte Runtime und sichere Bereinigung.
- Der gesamte `capability-package-actions-test.ts` besteht auf nativem PostgreSQL einschließlich HTTP, vollständiger Komposition, exakter historischer Dateien, gemischter neuer/vorhandener Skills, Querreferenzen nach Umbenennung, gemeinsamer Capabilities, privater MCP-Konfigurationen, frischem Quellrechteentzug und Plugin-/Skill-Legacyimport. Der danach ergänzte Legacy-MCP-Kompatibilitätsfall besteht zusätzlich über denselben fokussierten nativen Actionsweg: Deklaration und Config bleiben zusammen erhalten; keine geratenen Servernamen.
- Der native Parallelitätstest beobachtet zwei tatsächlich gleichzeitig wartende PostgreSQL-Aktionen. Beide enden ohne Retry erfolgreich, erzeugen jeweils genau eine SQL-/COW-Generation und verändern weder vorherige Entwurfsdateien noch veröffentlichte Quellen. Datenbankname und expliziter Fixture-Pool werden vor Mutationen auf dieselbe eigene Nonce-Datenbank geprüft. Ein ursprünglich zu enges Beobachtungsfenster wurde auf ein begrenztes realitätsnahes Budget angepasst; es wurde kein Produktdeadlock durch Retry verdeckt.
- `capability-package-native-test.ts` besteht mit acht PostgreSQL-Clients: CAS, wartender Publisher nach Rechteentzug, Registry-/SQL-Rollback, unveränderlicher Head und Namenskonkurrenz.
- Gateway und `planning-progressive-runtime-test.ts` bestehen mit tatsächlichem Agent-SDK und SQL. Versions-/Legacyreads bleiben lesbar, Komposition und Import werden vor Ausführung aus dem Planninggateway entfernt.
- Produkt-TypeScript, fokussierte geänderte TypeScript-Abhängigkeiten und ESLint bestehen. Die in P1 belegten unabhängigen alten Scriptdiagnosen werden dadurch nicht als behoben ausgegeben.

P2 weist die Backend-/API-Komposition nach. Creatorinhalt, Oberfläche und vollständige UI-/Agentabnahme bleiben P3–P7.
