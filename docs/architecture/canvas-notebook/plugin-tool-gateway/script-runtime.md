# Deklarierte Skill-Scripts

Der eingeschränkte Script-Weg ergänzt die vorhandene Shell. Er verwendet ausschließlich einen ausgewählten veröffentlichten Skill aus einem unveränderlichen Paket. Ein Core- oder unversionierter Skill benötigt zuerst eine ausdrücklich veröffentlichte Variante. Die Installation allein aktiviert keine Script-Ausführung.

## Paketdeklaration

Im Skill-Verzeichnis liegt `.canvas-skill/runtime.json`. Bei einem Plugin befindet sich diese Datei im jeweiligen enthaltenen Skill-Verzeichnis. Die Datei gehört zum vollständigen veröffentlichten Snapshot.

```json
{
  "version": 1,
  "scripts": [{
    "id": "summarize",
    "displayName": "Summarize workspace input",
    "runtime": { "kind": "node", "minimumVersion": "22.0.0" },
    "path": "scripts/summarize.cjs",
    "argumentsSchema": {
      "type": "object",
      "properties": { "title": { "type": "string", "maxLength": 120 } },
      "required": ["title"],
      "additionalProperties": false
    },
    "tools": [{ "alias": "input", "kind": "native", "toolName": "read" }],
    "outputs": ["summary.txt"],
    "dependencies": [{ "kind": "bundled", "path": "scripts/helpers.cjs" }]
  }]
}
```

Unterstützt sind Node und Python mit optionaler minimaler Runtime-Version. Einstiegspunkt und deklarierte Abhängigkeiten müssen im tatsächlichen Skill-Snapshot vorhanden sein. Der Runner installiert keine Pakete. Abhängigkeiten werden vollständig mitgeliefert; eine Deklaration ist keine Erlaubnis, weitere Programme zu starten. Unbekannte Felder, externe Schema-Referenzen, übergroße Manifeste und unsichere Pfade werden abgewiesen.

Tool-Anforderungen nennen portable Aliase und die benötigte Operation. Native Tools verwenden ihren vorhandenen Canvas-Vertrag. E-Mail verwendet die Canvas-Outbox-Tools mit menschlicher Prüfung und deren Versionsregeln. Ein externer Alias sieht beispielsweise so aus:

```json
{ "alias": "designs", "kind": "integration", "source": "composio", "application": "canva", "toolName": "CANVA_LIST_DESIGNS" }
```

Der Toolname muss aus dem tatsächlichen Provider-Katalog stammen; das Beispiel garantiert kein verfügbares Canva-Tool. MCP verwendet `source: "mcp"`. Ein optionaler Appname verlangt belegte Provider-Metadaten, keine Übereinstimmung eines Anzeigenamens. Provider-, Account-, Tool- und Schema-Referenzen gehören nicht ins exportierbare Paket.

## Agent und Ausführung

Die Verwaltung weist dem Agenten den veröffentlichten Skill und ausdrücklich `run_canvas_skill_script` zu. Dieses Tool ist standardmäßig deaktiviert. `list_canvas_skill_scripts` liefert kurze Einstiegspunkte und Readiness; `describe_canvas_skill_script` liefert das Argumenteschema, erforderliche Tool-Aliase und Ausgabepfade. Im Planungsmodus bleiben diese beiden Leseoperationen verfügbar; Ausführen ist ausgeschlossen.

Ein externer Aufruf benötigt eine ausgewählte Tool-/Schema-Referenz aus dem gemeinsamen Integrations-Gateway im selben Nutzer-/Agenten-/Workspace-Kontext. Der Run-Request ordnet diese Referenzen dem deklarierten Alias über `selectedBindings` zu. Die Auswahl gewährt keine zusätzlichen Rechte. Die Brücke prüft die serverseitig bekannte tatsächliche Quelle, App, Operation, Toolversion und Account-Bindung; sie kann keine beliebige Route aus dem Paket übernehmen.

`arguments` folgt dem Einstiegspunkt-Schema. Optionale `outputs` ordnen einen deklarierten `sourcePath` einem relativen `destinationPath` im aktiven Workspace zu. Bestehende Ziele verlangen `overwrite: true` und deren aktuellen `expectedSha256`. Native Canvas-Dateioperationen behalten Freigaben, Versionskonflikte, Undo, Review und Zusammenarbeit bei. Ein Review-Ergebnis ist keine bereits angewendete Dateiänderung.

## Script-SDK und Prozessgrenze

Node lädt das bereitgestellte SDK über `require(process.env.CANVAS_SKILL_BRIDGE_MODULE)`. Python importiert `canvas_skill` aus dem vom Runner eingebundenen SDK. Beide bieten `arguments()`, `describe(alias)` und `call(alias, arguments)`. Die Node-Funktionen sind asynchron. `call` beschreibt den aktuellen Alias und verwendet anschließend den vom Host ausgegebenen Schema-Nachweis.

Der aktuelle Arbeitsordner ist ein eigener privater Laufbereich innerhalb der konkreten Nutzer-/Agenten-/Session-Ablage. Relative Ausgaben bleiben dort, bis Canvas sie ausdrücklich in den Workspace übernimmt. Das Script erhält nur lesbaren Zugriff auf seinen exakten Skill-Snapshot, das SDK und geprüfte Runtime-Bibliotheken. Andere Sessions, Workspace-Dateien, zentrale Secrets und der übrige Servercode werden nicht als Prozess-Lesewurzeln freigegeben.

Direkter Netzwerkzugriff ist in diesem Vertrag gesperrt. Netzwerkfähige Arbeit verwendet die Tool-Brücke im Hostprozess. Provider-Tokens und allgemeine Secrets gelangen nicht in das Script-ENV. Neue Prozesse, Shell-/Browser-/Delegationszugänge und allgemeine Verwaltungs-Gateways sind nicht Teil dieser Brücke. Linux verwendet Landlock und Seccomp, macOS ein eigenes Seatbelt-Profil; fehlende oder nicht prüfbare Isolation verhindert den Start.

Die Brücke verwendet zwei geerbte Dateideskriptoren mit begrenzten JSON-Nachrichten, getrennt von stdout/stderr. Pro Lauf gelten höchstens acht Fachaufrufe, 16 Beschreibungsaufrufe, ein gleichzeitig laufender RPC, 64 KiB je Nachricht und 1 MiB insgesamt. Der Prozess ist zeitlich begrenzt; Abbruch und aktueller Rechteentzug stoppen ihn. Jede Tool-Ausführung und Ausgabeübernahme prüft erneut die tatsächliche Session, Agentenauswahl, Rechte und vollständigen Paketbytes. SQL-Sperren bleiben nicht über den gesamten Prozesslauf bestehen.

Ein bestätigter Toolerfolg mit zu großer Rückgabe bleibt als ausgeführt festgehalten. Bei unklarer Ausführung werden Run und Agententurn angehalten; die vorhandene dauerhafte Turn-/Delegations-/Automationssperre verhindert automatische Wiederholung oder Wechsel zu einem anderen Provider. Vollständige native Ergebnisse und Review-Intents bleiben im Host erhalten. Bereits erfolgte Fachaufrufe oder einzelne Dateiübernahmen werden bei einem späteren Fehler nicht als rückgängig gemacht dargestellt.

Der Verbindungs-/Workflow-Editor in 5c und das Plugin-Seiten-Redesign in 6a bündeln diese bestehenden Verträge in der zentralen Oberfläche. Tatsächliche Drittanbieter-Accounts sowie die gemeinsame Canva-Abnahme gehören zu Schritt 7.
