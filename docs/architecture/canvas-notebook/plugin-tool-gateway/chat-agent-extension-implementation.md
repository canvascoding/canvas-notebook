# Gemeinsamer Chat-/Agent-Erweiterungskontext: Umsetzung und Abnahme

Ausgangsstand: Notebook `d92d8eb05`. Auftrag: „setz den plan um und mach ein e2e test wenn du fertig bist“. Verbindlicher Umfang ist der [gespeicherte Plan](chat-extension-reference-plan.md), einschließlich eigener nativer Folgestufe. Dies ist ein Fortschritts-/Nachweisjournal; eine geplante oder syntaktisch geprüfte Funktion ist hier keine vollständige Abnahme.

## Reihenfolge

| Schritt | Stand | Erforderlicher Nachweis |
| --- | --- | --- |
| 1. Gemeinsamer Referenzvertrag und Autorität | In Arbeit: strikte gemeinsame Identitäten, langlebige Bindungen und V1-Kompatibilität | Eindeutige Pakete/Kinder/Accounts; bestehende V1-Pins und Vererbung bleiben erhalten; aktuelle Rechte begrenzen Auflösung |
| 2. Gemeinsamer Kontextcompiler | Offen | Prompt, Skill-Readroots und Toolhinweise aus demselben geprüften Selektionsstand; frische Ausführungsprüfungen |
| 3. Agent-Tool und Oberfläche | Offen | Atomare Erstellung/Bearbeitung, exakte Standalone-Verbindungen und Tool↔UI-Roundtrip mit Revisionsprüfung |
| 4. Chat-Picker und Transport | Offen | Alle vier Typen, Recents, Suche/Filter, genaue Accountwahl, Chips, Drafts, Queue, Steer, Retry und Handoff |
| 5. Web-/Agent-/Modellabnahme | Offen | Frischer Produktionsbuild; reale Browserbedienung und echter Modelllauf mit selbst gefundener Skill-Anleitung und gezieltem Toolrouting |
| 6. Native Mobile | Offen | Eigener nativer Composer, Transport, Verlauf/Drafts und Agent-Konfiguration; eigene Simulator-/Geräte-/Accessibility-Nachweise |

Jeder Schritt muss abgeschlossen sein, bevor die nächste Integration beginnt. Parallele Bestandsaufnahme und Prüfung innerhalb eines Schritts sind keine vorgezogene Umsetzung späterer Schritte.

## Verbindliche Abnahmematrix

Alle folgenden Nachweise sind zunächst **offen**. Die 15 vorhandenen Pluginseiten-Browserfälle beweisen diese neuen Chat-/Agent-Anforderungen nicht.

| Planfall | Erforderlicher tatsächlicher Nachweis |
| --- | --- |
| 1 | Recents erst nach akzeptiertem Send; idempotent bei Retry; Hover/Abbruch ohne Speicherung |
| 2 | Gemeinsame Vier-Typen-Suche, optionale Filter und spätere Composio-Katalogseite |
| 3 | Gleichnamige Pakete/Skills/Kinder/Verbindungen als getrennte exakte Quellen |
| 4 | Persönlicher versus Team-Account; Use ohne Manage; keine erste Instanz als Ersatz |
| 5 | Installations-/Auth-/no-auth-/Ausfall-/Rechtesituationen mit zutreffenden Aktionen |
| 6 | Gehaltene Antworten nach Actor-/Workspace-/Agent-/Profilwechsel werden verworfen |
| 7 | Chip entfernen; Draftreload, Handoff, Follow-up/Steer, Queueedit und Retry erhalten die eigene Auswahl |
| 8 | Rechteentzug zwischen Auswahl, Send, Queue, Describe und Call stoppt vor Nutzung |
| 9 | Registrierter Gateway/Legacy-Vertrag/Workflow-Konfiguration: nur tatsächliche zulässige Tools empfohlen |
| 10 | Ausgewähltes Plugin: echter Modelllauf liest passenden Skill und verwendet exakt passende Tools; Budget eingehalten |
| 11 | Ungültige gehaltene Quelle/Bindung/Schema verlangt Neuauflösung; neue Head-Version allein invalidiert keinen erlaubten Pin |
| 12 | Tastatur/IME/Screenreader, DE/EN, Desktop/schmaler Web-Dock; native Nachweise getrennt |
| 13 | Tatsächliches `create_agent` mit Paket/Kinder/Standalone-Verbindungen → identischer Stand in Management-UI |
| 14 | UI-Create → identischer Tool-Inspect; atomarer Create und konkurrierender Edit mit Revisionen |
| 15 | Neuer/bestehender Spezialagent-Chat ohne Slash enthält seine feste Auswahl |
| 16 | Allgemeiner Chat ohne Slash/Skillnamen/Toolrezept: echtes Modell findet passenden Skill über Runtime-Discovery und liest ihn |
| 17 | Core/Pflicht, Legacy-Vererbung, feste/leere Auswahl und V1-Pins ohne stille Umdeutung |
| 18 | Organisationsagent: gemeinsame Verbindung versus zulässige persönliche Wahl je ausführendem Nutzer |
| 19 | Fehlendes Lese-/Gateway-Tool, notwendige/optionale Einrichtung, lokaler Skill trotz Providerausfall und große Pakete |
| 20 | Gleicher Selektionsfingerprint für Prompt/Readroots/Toolhinweise; sicherer Refresh und aktive Laufgrenzen |
| 21 | Planungsmodus: sichere Discovery; keine Accountprobe oder Ausführung; Delegation/Scheduler innerhalb aktueller Policy |

Zusätzlich: manuelles Öffnen erhält Nachrichtentext/Caret; Slash-Auswahl entfernt nur ihre erfasste Range; Auswahl allein sendet keinen Auftrag.

## Bestätigte Ausgangslücken

- Agent-Create unterstützt noch keinen vollständigen gehaltenen Workflowstand; Update und Create müssen denselben neuen Vertrag bekommen.
- Workflow V1 ist paketgebunden. Standalone-Verbindungen benötigen eine versionierte Erweiterung bestehender Bindungen; temporäre Account-Selection-Receipts dürfen nicht als langlebige Identität gespeichert werden.
- `ChatRequestContext` wird ausdrücklich normalisiert und gehört bisher nicht zur dauerhaften Nachrichtenprojektion. Runtime-Kontextsnapshots und Queues liegen im RAM; Reload-/Rehydrate-Nachweise benötigen tatsächliche Persistenz samt eindeutiger Zustände.
- Web- und Native-Drafts speichern bisher nur Text. Native-Realtime und Native-Agent-Editor haben eigene Verträge und müssen separat angepasst werden.
- Vorhandene Modellprüfung instruiert den Workflow stark. Für natürliche Skill-Discovery ist zusätzlich eine echte Aufgabe ohne Slash, Skillnamen oder vorgegebenes Toolrezept erforderlich.
- Zu Beginn sind keine nativen Simulatoren/ADB-Geräte aktiv. Simulator-/Build-Auswahl und physische Geräte-/Accessibility-Abnahme sind unterschiedliche Nachweise.

## Erster geprüfter Teil: Referenz- und Bindungsverträge

Die neuen gemeinsamen Schemas unterscheiden Plugin, eigenständigen/enthaltenen Skill, Composio und MCP. Nachrichten- und Agent-Hüllen teilen dieselbe genaue Identität; der Agent-Vertrag erhält vollständige Workflow-V1-Deklarationen und ergänzt feste/auswählbare Standalone-Verbindungen. `legacy_inherit` und eine leere feste Auswahl sind ausdrücklich verschieden. Kurzlebige Account-Receipts kommen ausschließlich bei der Annahme vor, nicht in akzeptierten Nachrichten oder privaten gespeicherten Bindungen.

- `npm run test:extensions:contracts`: bestanden; 92 öffentliche Fälle plus private Bindungs-, Slotreferenz- und Workflowversionsprüfungen.
- ESLint der neuen Vertrags-/Hilfsdateien und ihrer fokussierten Tests: bestanden; `git diff --check` ebenfalls bestanden.
- Typecheck der neuen Module und Tests einschließlich ihrer tatsächlichen importierten App-Abhängigkeiten und bestehenden Ambient-Typen: bestanden. Temporäre Konfiguration `/private/tmp/canvas-extension-foundation-typecheck-20261013.json`, ausgeführt mit `node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p … --pretty false`.
- Ein vollständiger `tsc --noEmit --incremental false` brach zunächst am Standard-Heaplimit ab. Mit 8 GiB berichtete er zahlreiche Fehler in anderen vorhandenen Script-/Testdateien sowie einen neu eingeführten Assert-Overload im Versions-Vertragstest. Der neue Overload wurde korrigiert. Dieser vollständige Repository-Typecheck wird nicht als bestanden ausgegeben; der fokussierte Nachweis schließt fremde Script-/Testdateien aus, nicht die importierten App-Abhängigkeiten.
- Die unabhängige Prüfung fand unterschiedliche öffentliche/private MCP-Definitions-ID-Grammatik. Die tatsächliche Quellvalidierung verlangt kanonische UUIDs; beide neuen Verträge und die gemeinsame Gegenprüfung wurden daran ausgerichtet.

Diese Nachweise prüfen Syntax, interne Konsistenz, gehaltene Identitäten, Grenzen und das Weglassen privater/kurzlebiger Eingabefelder. Sie beweisen noch keine aktuelle Actor-/Providerautorität, kein fertiges Agent-Create, keinen neuen Systemprompt und keine Chat-/Native-Bedienung. Die serverseitige Annahme einzelner Verbindungen wird anschließend mit den vorhandenen echten Berechtigungsdiensten und eigener isolierter Datenbank geprüft. Schritt 1 bleibt bis zu dieser Autoritätsprüfung offen.

## Wirkungsanalyse und Veröffentlichung

Die Runtime-Moduserkennung hat vier direkte Aufrufer (Workflowprojektion, Integrationspolicy und zwei Tool-Registry-Einstiege) und wurde von GitNexus als kritisch eingestuft. Kontextnormalisierung, Submission-Identität und Nachrichtenpersistenz haben ebenfalls einen breiten Wirkungsbereich über Chat, Tool-Apps, Delegation und Automationen. Unbekannte oder nicht indexierte API-Routen gelten nicht als risikofrei. Vor jeder bestehenden Symboländerung bleibt deren konkrete Impactprüfung erforderlich.

Dieser Auftrag erlaubt Implementierung und E2E. Ein neuer Docker-Testcontainer wird nicht vorausgesetzt. Ein späterer Testlauf verwendet einen frisch gebauten eigenen Node-Produktionshost und den verwalteten isolierten Test-Stack; fremde Instanzen und Produktionsdaten werden nicht umgebunden. Veröffentlichung über den bestehenden Feature-PR bleibt von Main-Merge, Release und Produktivdeployment getrennt.
