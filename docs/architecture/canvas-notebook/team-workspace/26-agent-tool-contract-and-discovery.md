# Agent-Tools: Laufzeitstatus, Automationsvertrag und Konfigurationskatalog

Stand: 2026-09-30. Befund aus dem lokalen Repository; der ausgelieferte Production-Stand wurde nicht geprüft.

## Befund und umgesetzte Korrekturen

Ein abgebrochener Modell-Turn kann einen unvollständigen Tool-Call enthalten. Die Pi-Agent-Schleife beendet bei `error` oder `aborted` den Lauf vor der Tool-Ausführung, ohne für diesen Call ein `tool_execution_end` zu senden. Die Chat-Projektion zeigte solche Calls weiter als laufend an. Das erklärt den Spinner nach `[Error] terminated`; es belegt keinen Timeout der Agent-Management-Anwendungsschicht.

Die Projektion und Runtime-Reconciliation beenden diese Anzeigen bei terminalen Turns oder bestätigtem Idle. Ein später eintreffendes echtes Tool-Ergebnis ersetzt die Unterbrechungsanzeige. Bereits abgeschlossene Calls und nachfolgende laufende Turns bleiben korrekt dargestellt. Unterbrechung bedeutet ausdrücklich, dass der Abschluss der Operation nicht bestätigt werden konnte.

Agent-Management-Operationen haben ein Bot-Icon und deutsche/englische Aktionsnamen. Das Gateway zeigt bereits anhand seiner Argumente an, ob es Operationen sucht, beschreibt oder beispielsweise einen Agenten erstellt.

Die Automationsdatenbank und der Runner unterstützen bereits `agentId` und mehrere Session-Modi. Der KI-Adapter hat diese Argumente bisher nicht im Schema angeboten und nicht weitergegeben. Dadurch verwendete eine über das Tool erstellte Automation die Defaults Bradley und `new_session`, selbst wenn zusätzliche Argumente übergeben wurden. Ein Persona-Text im Prompt ersetzt keine Runtime-Zuweisung.

Erstellen und Bearbeiten bieten jetzt denselben Satz von Ausführungsfeldern an:

| Feld | Bedeutung und Validierung |
| --- | --- |
| `agentId` | Tatsächlicher Runtime-Agent; Zugriffsprüfung im Automationsworkspace für den ausführenden Nutzer. Default bei Erstellung: Bradley. |
| `preferredSkill` | Skill-Name oder `auto`; Prompt-Hinweis, keine Installation oder Rechtevergabe. |
| `deliverySessionMode` | `new_session`, `channel_active` oder `fixed_session`. |
| `deliverySessionId` | Für `fixed_session` erforderlich. Eigener, nicht archivierter Conversation-Chat des verantwortlichen Nutzers, passenden Agenten und Workspaces. |
| `deliveryMode` | Zustellroute, unabhängig vom Session-Modus. |
| `deliveryChannelId` | Zielkanal, standardmäßig `web`. |
| `deliveryChannelSessionKey` | Vorhandener Routing-Key eines verknüpften Kanals. Web-Routing wird abgeleitet. |

Bei Updates bleiben ausgelassene Felder erhalten. Explizites `null` löscht optionale Kanal-/Chat-Ziele. Prompt-Updates behalten ihre Inspektions- und Revisionsprüfung. Unbekannte Argumente werden vom Gateway abgewiesen; `sessionMode` ist kein Alias für `deliverySessionMode`.

`new_session` erzeugt einen neuen Automationschat. `channel_active` verwendet einen gültigen aktiven Chat des Kanals und Agenten; ohne passenden aktiven Chat erstellt der Runner einen neuen Chat und protokolliert eine Warnung. `fixed_session` verwendet ausschließlich das geprüfte Chat-Ziel; ein ungültiges Ziel wird abgewiesen.

Das lesende, planning-safe Tool `inspect_automation_job_options` liefert zugängliche Agent-IDs, die drei Session-Modi und paginierte gültige Chat-Ziele. Mit `jobId` verwendet es den Workspace und Agenten des bestehenden Jobs; beim Erstellen den aktuellen Workspace. Andere Bearbeiter erhalten keine privaten Chat-Ziele des verantwortlichen Nutzers.

Spezialagenten können erlaubte Automationsoperationen wie `create_automation_job` und `update_automation_job` in ihrer Tool-Konfiguration bekommen. Der Gateway-Name `automation_manage` ist kein konfigurierbarer Operationsname. Während einer Automationsausführung entfernt die Registry weiterhin Automationsverwaltung, um rekursive Automationen zu verhindern. Diese beiden Situationen müssen in Discovery getrennt beschrieben werden.

## Geplante Ergänzung: vollständiger Konfigurationskatalog

Status: geplant, Aufgabe 55. Die Agent-/Chat-Discovery ist umgesetzt; ein vollständiger Katalog für Agent-Erstellung sowie Skill-/Plugin-Auswahl ist damit noch nicht vorhanden.

Ein gemeinsamer lesender Konfigurationsservice soll UI und KI-Tools dieselben zulässigen Werte liefern. Der Service verwendet den Actor-, Workspace-, Projekt- und Organization-Kontext sowie die bestehenden Capability- und Access-Resolver. Er gibt keine Secrets oder fremden persönlichen Ressourcen aus.

1. **Agenten und Runtime-Eignung:** stabile Agent-ID, Name, Scope, `canUse`/`canEdit`/`canManage`, Readiness und Gründe für fehlende Ausführbarkeit. Bei bestehenden Automationen die Rechte des verantwortlichen Nutzers berücksichtigen; reine Sichtbarkeit des Bearbeiters ist keine Laufzeitfreigabe.
2. **Skills und Plugins:** stabile `resourceType`-/`resourceId`-Referenzen, Name, Scope, Version, Policy, effektive Aktivierung, Konflikte und Connection-Readiness. Für den gewählten Agenten zusätzlich wirksame Bindings und zulässige Skill-Namen ausgeben. Organization-Agenten dürfen keine persönlichen Ressourcen binden.
3. **Agent-Felder:** auswählbare Provider-Installation, Modelle und Thinking-Werte samt Katalogrevision; kanonische Tool-Operationsnamen und Einschränkungen; gültige Icons, Managed Files, Skill-/Plugin-Bindings, Connections und Grant-Ziele. Beschreibungen kennzeichnen Pflichtfelder, Defaults und Abhängigkeiten.
4. **Automationsfelder:** Unterschied zwischen Runtime-Agent, Skill-Hinweis, Zustellroute, Session-Modus und Continuity erklären. Kanal-Readiness und echte Routing-Keys gezielt abfragbar machen. Einen direkten Plugin-Parameter erst anbieten, wenn Speicher- und Runner-Semantik dafür definiert sind; derzeit laufen Plugins über Agent-Bindings.
5. **Validierung:** ungültige oder veraltete Referenzen mit maschinenlesbarem Fehler und Korrekturhinweis abweisen. Fehlende Secrets verlinken auf `/settings?tab=integrations`. Keine erfolgreiche Antwort, wenn Felder still ignoriert wurden.
6. **Abnahme:** echte Tool-Aufrufe von Discovery über Gateway-Mutationen bis zu Speicherung und Runtime prüfen. Positive und negative Fälle für persönliche/Organization-Agenten, Revocation, blockierte Ressourcen, fremde Connections und wechselnde Workspaces. UI auf Desktop und Mobilgerät prüfen.

Die Umsetzung erfolgt nacheinander: gemeinsamer Katalogservice, lesendes Tool, Integration in Agent-Erstellung, Integration in Automations-Skill-/Plugin-Auswahl, dann Abnahme und jeweiliger Commit. Die bestehenden Resolver bleiben die fachliche Quelle; es entsteht kein separater KI-Berechtigungspfad.

## Verifikation der umgesetzten Korrekturen

- `scripts/chat-tool-batches-test.ts`: terminale Modellfehler, Idle, spätere Ergebnisse, mehrere Turns und weiterlaufende Folgeturns.
- `scripts/agent-tool-display-test.ts`: Aktionsnamen, Gateway-Argumente und Icons/Tones.
- `scripts/pi-tool-registry-test.ts`: Gateway-Schemata, Speicherung von Agent/Skill/Session-Einstellungen, Erhalt ausgelassener Felder, Null-Reset, ungültige Modi und fremde/archivierte/falsche Chat-Ziele. Isolierte PGlite-Datenbank mit realem Schema.
- `scripts/automation-delivery-test.ts`: Session-/Kanalauflösung und Fallback-Verhalten.
- `scripts/automation-runner-tool-context-test.ts`: Runner-Kontext, Tool-Beschränkungen und Persistenz.
- `tests/agent-tool-lifecycle.spec.ts`: tatsächliche Chat-Komponenten, terminale Spinner, Aktionsnamen, Desktop- und Mobile-Dialoge einschließlich Automationsoptionen. Isolierter Komponenten-Harness ohne zweiten Test-Container.

Production-Abnahme und Deployment sind durch diese lokalen Prüfungen nicht ersetzt.
