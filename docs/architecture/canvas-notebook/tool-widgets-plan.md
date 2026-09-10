# Plan: Canvas-Tools als HTML-Widgets im Chat

Stand: 10. September 2026. Basis: `main` bei `4c55fb97` nach PR #138 und #139.
Status: geplant. Dieses Dokument ersetzt den vor dem Main-Update erstellten
Entwurf für die Umsetzung. Es enthält noch keine implementierten Arbeitspakete.

## Ziel und erster Lieferumfang

Bestehende interne Canvas-Tools können nach einer erfolgreichen Ausführung eine
HTML-Oberfläche im Chat anzeigen. Interne und externe Widgets verwenden denselben
Host, dieselbe Sandbox und dieselbe Nachrichtenverarbeitung.

Die erste vollständige Umsetzung ist eine Automationskarte mit Name, Zeitplan,
Zeitzone, nächstem Lauf, Status und den Aktionen **Öffnen**, **Bearbeiten** sowie
**Pausieren/Fortsetzen**. Die Karte bleibt bei eingeklappten Tool-Details, im
Minimalmodus und nach einem Neuladen sichtbar. Bearbeiten öffnet zunächst den
vorhandenen Automationseditor.

**Jetzt ausführen**, Löschen, ein vollständiger Editor im Widget und weitere
Widget-Typen folgen nach diesem abgeschlossenen Lieferumfang. Die Veröffentlichung
interner Tools über den extern erreichbaren Canvas-MCP-Server ist ein eigener
späterer Schritt.

## Was Main bereits liefert

| Vorhanden | Wiederverwendung |
| --- | --- |
| `McpAppWidget` mit AppBridge, Initialisierung, Größenanpassung, Reload und Tool-Freigaben | Gemeinsamen Host daraus entwickeln; vorhandenes MCP-Verhalten über einen Adapter erhalten. |
| `apps-host.ts` mit begrenzten, kurzlebigen Tickets und erneuter Berechtigungsprüfung | Ticketmechanik für interne Ressourcen erweitern. |
| Fester Canvas-Relay und inneres iframe mit opaker Origin | Bestehende Isolation und Routing ohne zusätzliche Konfiguration beibehalten. |
| `McpAppFrameTransport` mit Fenster-/Origin-Bindung und Nachrichtenlimits | Für beide Widget-Quellen verwenden. |
| MCP-Metadaten, Resource-Lesen und Anzeigeprojektion für gespeicherte Ergebnisse | Kompatibel um interne Widget-Referenzen ergänzen. |
| OAuth-Connection-Health und Reconnect-Hinweise | Für externe Widgets weiterverwenden; interne Karten benötigen keine MCP-Verbindung. |

Die geltenden Grenzen stehen in [MCP Apps security model](../../security/mcp-apps.md).
Externe Netzwerkzugriffe aus Widgets und allgemeine Host-Navigation sind derzeit
nicht freigegeben. Auch interne HTML-Bundles müssen innerhalb dieser Grenzen
funktionieren. Eine neue Subdomain, ein zweiter Server oder eine neue OAuth-Schicht
sind für diesen Plan nicht erforderlich.

## Architekturentscheidungen

```mermaid
flowchart LR
  I[Interne Canvas-Tools] --> B[Builtin-Adapter und Widget-Registry]
  E[Externe MCP-Tools] --> M[Bestehender MCP-Adapter]
  B --> P[Gemeinsame Widget-Projektion]
  M --> P
  P --> H[Gemeinsamer Chat-Host und AppBridge]
  H <--> S[Bestehende HTML-Sandbox]
  H --> A[Autorisierte Aktionen des jeweiligen Adapters]
```

- Interne Widgets sind versionierte, mit Canvas ausgelieferte HTML/JS/CSS-Bundles.
  Die KI liefert Tool-Argumente; ausführbarer Widget-Code stammt aus der Registry.
- Ein gemeinsamer Descriptor unterscheidet ausdrücklich `builtin` und `mcp`.
  Interne Widgets bekommen keine fingierte `connectionId`.
- Vorhandene `details.mcpApp`-Nachrichten bleiben lesbar. Neue interne Ergebnisse
  erhalten einen versionierten `details.toolApp`-Eintrag; eine gemeinsame Funktion
  normalisiert beide Formate für den Host. Es gibt keine zweite persistierte Kopie
  der Widget-Daten im Frontend-Nachrichtenmodell.
- Eine interne Referenz enthält Ressourcen-/Schema-Version, tatsächliche Operation,
  Bezug zum Tool-Aufruf, Entitätsreferenz und einen kleinen freigegebenen Snapshot.
  Beispielressource: `ui://canvas/automation-job/v1`.
- Backend und Registry bestimmen zulässige Ressourcen und Aktionen. Vom Browser
  übergebene Tool-Namen, Job-IDs oder Deskriptoren begründen keine Berechtigung.
- Im Chat gespeichert werden Ergebnisdaten und Referenzen. HTML-Bundles, kurzlebige
  Ticket-URLs, Freigaben und Secrets werden nicht als Widget-Historie gespeichert.

## Verbindliche Reihenfolge

Jedes Arbeitspaket wird abgeschlossen, angemessen getestet und einzeln committed,
bevor das nächste beginnt. Vorgeschlagene neue Dateinamen sind noch keine Dateien.

### 1. Gemeinsamen Vertrag und internen Backend-Adapter ergänzen

- [ ] Unter `app/lib/tool-apps/` Typen, Registry und Normalisierung ergänzen.
- [ ] Vorhandene MCP-Deskriptoren über einen Kompatibilitätsadapter übernehmen.
- [ ] Die Ticket-/Ressourcenmechanik aus `apps-host.ts` gemeinsam nutzen; je nach
  Quelle die zuständige Autorisierung aufrufen. Interne Widgets verwenden normale
  Chat-/Agent-/Workspace- und Automationsrechte, keine MCP-Adminberechtigung.
- [ ] Interne Render-/Aktionsanfragen an eine serverseitig verifizierte Nachricht
  samt `toolCallId` binden. Die daraus abgeleitete Automation muss mit der
  angefragten Entität übereinstimmen. Bei noch nicht gespeicherten Live-Ergebnissen
  entweder die autoritative Runtime-Zuordnung prüfen oder die Speicherung abwarten.
- [ ] Die Render-Auslieferung prüft Sitzung und aktuelle Rechte erneut. Eine
  nicht registrierte Ressource oder Operation wird abgewiesen.

**Betroffen:** `app/lib/mcp/apps-types.ts`, `apps-host.ts`,
`app/api/mcp/apps/route.ts`; neue interne Adapter-/Routenanbindung. Gemeinsame
Mechanik extrahieren, fachliche Regeln in den jeweiligen Adaptern behalten.

**Abnahme:** Alte MCP-Deskriptoren funktionieren weiterhin. Ein berechtigter Nutzer
kann eine interne Testressource laden; fremde Chats, falsche Tool-Aufrufe,
ausgetauschte Job-IDs und entzogene Berechtigungen werden abgewiesen.

### 2. Bestehenden Host teilen und Canvas-Stil übertragen

- [ ] Aus `McpAppWidget.tsx` einen gemeinsamen `ToolAppWidget` entwickeln; die
  MCP-Anbindung bleibt ein schlanker Adapter. Transport, Fehlerbehandlung,
  Initialisierung, Resize und Aufräumen werden nur einmal implementiert.
- [ ] Unterstützte Fähigkeiten pro Adapter begrenzen. Externe MCP-Tool-Aufrufe
  behalten die bestehende sichtbare Allow-/Reject-Freigabe.
- [ ] Canvas-Tokens für Farben, Schrift, Abstände, Rahmen und Radius an das
  iframe übergeben. Theme, Sprache und Zeitzone explizit aktualisieren.
- [ ] Kleine wiederverwendbare Widget-Komponenten aus vorhandenen UI-Primitiven
  und Formatierern aufbauen. Assets und gegebenenfalls Schriftdateien werden
  gebündelt/eingebettet, da die bestehende CSP externe Abrufe blockiert.
- [ ] Produktionsbuild um die Auslieferung der internen Bundles ergänzen; die
  bestehenden Ticket-Routen und den globalen Abschaltschalter weiterverwenden.

**Betroffen:** `McpAppWidget.tsx`, `McpAppChatContext.tsx`,
`apps-browser-transport.ts`, `app/globals.css`, `components/ui/`, neue Widget-Bundles
und deren Build-Anbindung. Keine neue parallel laufende Sandbox implementieren.

**Abnahme:** Interne Testansicht und bestehende MCP-Fixtures verwenden denselben
Host. Hell/Dunkel, schmale Breite und Localewechsel funktionieren; die bisherigen
Sandbox- und Freigabegrenzen bleiben wirksam.

### 3. Widgets sichtbar und zuverlässig im Chat verankern

- [ ] Widget-Ausgabe aus `ToolCallPill` herauslösen. `ChatMessageList` platziert sie
  unabhängig von `ToolBatchDisclosure` und `hiddenToolMessageIds`.
- [ ] Eine stabile Instanzkennung aus Chat und Tool-Aufruf verwenden. Mehrere
  Aufrufe desselben Tools erzeugen getrennte Karten; wiederholte Events erzeugen
  keine zusätzlichen Karten. Innerhalb einer Tool-Gruppe Aufrufreihenfolge erhalten.
- [ ] Live-Updates, finales Nachrichtensynchronisieren und gespeicherten Verlauf
  durch dieselbe Normalisierung führen. Gateway-Aufrufe anhand der tatsächlichen
  `details.operation` erkennen, nicht nur am äußeren Tool-Namen.
- [ ] Bestehende Display-/Kontext-/Persistenzprojektionen gezielt erweitern:
  registrierte Referenz und begrenzte Anzeigedaten bleiben gültig; UI-Metadaten
  gelangen nicht automatisch in den Modellkontext. Bestehende Sicherheitsfilter
  dürfen für interne Job-Daten nicht pauschal umgangen werden.
- [ ] Nur sichtbare Widgets aktiv halten und bestehende Ticketlimits beachten.
  Resize erhält den Scrollanker; Schließen/Wechseln räumt Bridge und Anfragen auf.
- [ ] Alte Nachrichten, unbekannte Versionen, übergroße Daten und Clients ohne
  Widget-Host behalten einen verständlichen Text-Fallback. Teilen und Export
  erweitern keine Datenberechtigungen und übernehmen keine aktiven Tickets.

**Betroffen:** `ChatMessageList.tsx`, `ChatToolRunMessages.tsx`,
`useChatRuntimeEvents.ts`, `chatMessageMapping.ts`, `app/lib/chat/run-collapse.ts`,
`app/lib/pi/message-projection.ts`, `visual-data-projection.ts` und die bestehende
Nachrichtenspeicherung. Zunächst keine neue Datenbanktabelle erforderlich.

**Abnahme:** Interne und externe Widgets bleiben bei eingeklappten Details und im
Minimalmodus sichtbar. Live, Reload und Reconnect zeigen pro Aufruf genau eine
Karte. Verlaufsanzeige löst keine erneute schreibende Tool-Ausführung aus.

### 4. Automationskarte vollständig umsetzen

- [ ] `create_automation_job`, `inspect_automation_job` und `update_automation_job`
  liefern nach Erfolg dieselbe registrierte Kartenart. Fehler und Abbrüche
  erzeugen keine falsche Erfolgskarte.
- [ ] Name, lesbarer Zeitplan, Zeitzone, nächster Lauf und Aktiv-/Pausiert-Status
  anzeigen. Agent-/Workspace-Kontext nur im zulässigen Umfang weitergeben.
- [ ] **Öffnen** und **Bearbeiten** führen über konkrete, vom Canvas-Host erzeugte
  Aktionen in die vorhandene Automationsansicht. Keine allgemeine Navigation für
  beliebige iframe-Anfragen freischalten.
- [ ] **Pausieren/Fortsetzen** als klar beschriftete, vom Host gerenderte Aktion
  ausführen. Der bewusste Nutzerklick löst die enge Backend-Operation aus; interne
  Widget-Skripte erhalten keinen generischen Zugriff auf alle Canvas-Tools.
- [ ] Gemeinsame Automationsaktionen für API und Widget verwenden. Insbesondere
  Composio-Synchronisierung, Verantwortlichkeit, Audit und Rate Limits aus der
  bestehenden PATCH-Route erhalten; nicht direkt am Store vorbeiorchestrieren.
- [ ] Versionsprüfung und serialisierte/gegen Wiederholung abgesicherte
  Statusänderungen einbauen. Konflikte dürfen keine veralteten Änderungen
  überschreiben; Prüfungen müssen vor externen Nebenwirkungen wirksam sein.
- [ ] Historischen Erstellungserfolg und aktuellen Jobzustand unterscheiden.
  Nach Nutzeraktionen Zustand aktualisieren und ein kurzes, gespeichertes
  Aktionsereignis für den weiteren Chatkontext erzeugen. Ein Refresh startet
  keinen neuen Modelllauf.
- [ ] Gelöschte Jobs und Rechteentzug zeigen einen passenden Zustand ohne aktive
  Aktionen. Bei fehlender Verbindung einer Automation deren tatsächliche
  Integrationszuordnung verwenden; „aktiv“ bedeutet nicht „alle Verbindungen ok“.

**Betroffen:** `app/lib/pi/scoped-tools.ts`, neue Automations-Widget-Ressource,
`app/lib/automations/presentation.ts`, gemeinsame Domain-Aktionen,
`app/api/automations/jobs/[jobId]/route.ts`, `messages/de.json`, `messages/en.json`.

**Abnahme:** Eine im Chat erstellte Automation lässt sich über die Karte öffnen,
bearbeiten und pausieren/fortsetzen. Fremde Nutzer, Doppelklicks, veraltete Versionen
und private Composio-Verbindungen umgehen keine bestehenden Regeln.

### 5. Gesamtabnahme und dokumentierten Lieferumfang abschließen

- [ ] Bestehende Prüfungen ausführen: `test:mcp:apps`, `test:mcp:apps-host`,
  `test:mcp:message-projection`; relevante Chat-Gruppierungs- und Automationstests.
- [ ] Gezielte Tests für Adapter-Bindung, Ereignis-Deduplizierung, Verlauf,
  Berechtigungswechsel, Statuskonflikte und Widget-Aktionen ergänzen.
- [ ] Browserprüfung für Erstellung, Reload, Minimalmodus, mehrere Karten,
  Hell/Dunkel, mobile Breite, Tastatur/Fokus, Scrollverhalten und Fehlerzustände.
  Laut Repository-Regel UI-Automation erst nach ausdrücklicher Nutzerfreigabe.
- [ ] `npm run build` erfolgreich abschließen. Container nur auf ausdrücklichen
  Wunsch bauen; für einen lokalen Stack den verwalteten Dev-Skill verwenden.
- [ ] `docs/security/mcp-apps.md` um interne Ressourcen, Aktionen und den
  tatsächlichen unterstützten Umfang ergänzen; diese Checkliste aktualisieren.

Vor Produktänderungen GitNexus-Impact für die betroffenen Symbole ausführen und
hohe Risiken melden. Vor jedem Commit `detect_changes` im aktuellen Worktree
ausführen. Der für diesen Plan verfügbare Hauptcheckout-Index enthält nicht alle
neuen MCP-Apps-Symbole; die Befunde wurden deshalb im aktuellen Quellcode geprüft.
Vor der Umsetzung muss die Impact-Grundlage aktuell sein.

**Lieferkriterium:** Arbeitspakete 1–5 sind abgeschlossen und verifiziert. Dann
folgen weitere Widgets über die Registry, beginnend mit Todo-Karten und
Artefaktansichten. Externe MCP-Widgets behalten ihre bisherigen Fähigkeiten und
Reconnect-Hinweise und profitieren von derselben verbesserten Chat-Platzierung.
