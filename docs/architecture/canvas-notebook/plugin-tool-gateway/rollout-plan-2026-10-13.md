# Gemeinsame Integrationssuche: verbleibende Umstellung

Stand: 13. Oktober 2026. Ziel ist, die vorhandene gemeinsame Suche über `integrations` zum regulären Einstieg für externe MCP- und Composio-Tools zu machen. Die Implementierung existiert bereits; der verbleibende Schwerpunkt ist Abnahme und Einführung. Der Gesamtstatus in [implementation.json](implementation.json) bleibt `in_progress`.

## Was bereits vorhanden ist

`buildPiToolRegistryAsync` entscheidet zwischen den bisherigen Einstiegspunkten und dem gemeinsamen Gateway. Der experimentelle Schalter `integrationToolGatewayEnabled` aktiviert den gemeinsamen Einstieg für reguläre Agenten. Verbindlich konfigurierte Workflow-Agenten verwenden ihn bereits unabhängig vom globalen Schalter. MCP und Composio bleiben getrennte Ausführungsadapter hinter demselben Vertrag: Provider suchen, Tools suchen, Schema beschreiben, exakt gebundenen Aufruf ausführen. Bestehende Verbindungsrechte und Profile bleiben maßgeblich.

Der zusammengeführte Notebook-Stand ist durch die [Main-Abnahme](evidence/main-integration-2026-10-12.md) belegt. Eine [echte Composio-/Canva-Modellabnahme](evidence/step-7-live-composio-model-acceptance.md) existiert. Diese Belege ersetzen keinen allgemeinen Produktionsrollout.

Die zugehörigen Managed-Composio-Endpunkte wurden am 13. Oktober über [Control Plane PR #19](https://github.com/canvascoding/canvas-control-plane/pull/19) in Control Plane `main` integriert und aus Remote-main `27c8ce37da082244f006ca376068cde6b98845d5` deployt. Die anschließende Notebook-Produktivdiagnose konnte für LinkedIn, Canva MCP und Shopify Tools auflisten und Schemas laden; Shopify benötigte weiterhin Autorisierung. Diese Diagnose belegt Discovery/Schema-Zugriff, keinen geschäftlichen Provider-Aufruf. Ein eingerichteter Account allein beweist keinen funktionierenden Tool-Zugriff. Der globale Gateway-Schalter war bei dieser Diagnose aus.

Das persönliche To-do-Widget hatte zusätzlich eine unabhängige Bereichsprüfung mit falschem Organisationsvergleich. Der [separat geprüfte Fix](../../../product/qa/todo-widget-scope-2026-10-13.md) betrifft die native To-do-Funktion. Die gemeinsame externe Suche wird nach dessen Einführung weitergeführt.

## Reihenfolge und Abnahmekriterien

| Schritt | Konkrete Arbeit | Fertig, wenn |
| --- | --- | --- |
| 1. To-do-Korrektur einführen | Den separaten Notebook-Fix nach Review veröffentlichen und ausrollen; denselben persönlichen Workspace mit Organisationszuordnung erneut prüfen. | Render/Refresh und Agent-Inspect/Update funktionieren; fremde Workspaces bleiben gesperrt. Die aktuelle Code/API-Abnahme ist dokumentiert, eine Produktionsabnahme steht aus. |
| 2. Gateway-Abnahme schließen | Die vorhandenen Gateway-/Registry-/Workflow-Tests gegen den aktuellen gepaarten Notebook-/Control-Plane-Stand ausführen. Danach einen echten externen MCP-Anbieter und Managed-Composio mit gewöhnlichen Nutzern und konkreten persönlichen/gemeinsamen Bindungen lesend prüfen. | Suche, Describe und Call verwenden dieselbe aktuelle Verbindung und Schema-Version. Rechteentzug wird vor dem Aufruf wirksam; nicht autorisierte Verbindungen bleiben klar als `auth_required` sichtbar. Ein tatsächlicher Modelllauf und Provider-/Audit-Nachweis schließen die externe MCP-Lücke. |
| 3. Eine Instanz kontrolliert umstellen | Nach der Provider-Abnahme den vorhandenen administrativen Schalter zunächst auf einer ausgewählten Instanz einschalten. Vergleichbare Aufträge im bisherigen und neuen Modus mit denselben Nutzern, Workspaces, Rechten und Verbindungen prüfen. | Suchtreffer, Schema-/Aufruf-Erfolg, Latenz und Fehlerklassen sind nachvollziehbar. Keine zusätzliche App oder Verbindung wird freigegeben. Persistierte Chats/Widgets, delegierte Aufträge und Automationen funktionieren im vorgesehenen Modus. |
| 4. Rollback und Standard festlegen | Rückkehr über den Schalter für neue reguläre Agentenläufe testen; Verhalten bereits laufender/fest gebundener Workflows prüfen. Bedienungs- und Betriebsdokumentation ergänzen und den dann aktuellen Stand vollständig abnehmen. | Der Rollback ist belegt, Providerfehler werden von Auth-/Policy-/Vertragsfehlern unterscheidbar und die Vergleichsergebnisse erlauben den Default-Wechsel. Erst danach den Gateway-Default aktivieren und Schritt 7 abschließen. |
| 5. Legacy-Einstiege abbauen | Nach einer stabilen Einführung verbleibende Aufrufer der bisherigen Composio-/MCP-Einstiege inventarisieren und gezielt migrieren; interne Metadaten- und Kompatibilitätswege separat prüfen. | Reguläre externe Aufrufe verwenden den gemeinsamen Vertrag; die Entfernung alter Einstiegspunkte hat eigene Regressionsevidenz. |

## Beobachtung und offene Grenzen

Fehlernachweise müssen mindestens Discovery, Describe und Call unterscheiden sowie Quelle, Modus (lokal/Managed), Fehlerklasse und aktuelle Vertragsfähigkeit zuordnen. Ein fehlender Managed-Endpunkt darf nicht allein als abgelaufener OAuth-Token erklärt werden. Logs/Audits enthalten keine Credentials oder vollständigen Provider-Antworten. Falls vorhandene Telemetrie diese Unterscheidung nicht liefert, ist deren Ergänzung Teil von Schritt 3, bevor die Einführung bewertet wird.

Der Schalter gilt für die Instanz; ein Nutzer-Canary ist derzeit keine belegte Funktion. Durch ihn entstehen weder neue OAuth-Verbindungen noch zusätzliche Freigaben. Das Zurückschalten für reguläre Agenten ist außerdem kein vollständiger Rückbau fest gebundener Workflow-Agenten, da diese unabhängig vom Flag das Gateway verwenden. Dieser Unterschied gehört in den Rollback-Test.

Aktuell wird kein Produktionsschalter geändert und kein neuer Provider-Aufruf ausgeführt. Auf ausdrückliche Nutzerwahl beschränkt sich diese To-do-Korrektur auf Code/API-Prüfungen. Die spätere echte Modell-/MCP-Abnahme benötigt eine eigene Durchführung; vorhandene Browserbelege werden dafür nicht als frische Abnahme ausgegeben. Der separate strikte Mobile-Audit bleibt offen.
