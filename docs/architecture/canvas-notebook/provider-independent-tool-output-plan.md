# Providerunabhängige Web- und Tool-Ausgaben

Stand: 2026-09-09. Planungsgrundlage: Canvas Notebook `caba97d5`, lokales Hermes-Repo `f293e7206b`. Umsetzung läuft: Schritte 1 bis 4 implementiert; gemeinsame Kontextbudgets und UI-Darstellung folgen.

## Umsetzungsstand

- Schritt 1: Charakterisierung und Fixtures in Commit `27ce0b96`; lange erste Treffer verdrängen im Ausgangsstand nachfolgende Quellen.
- Schritt 2: Private Ergebnisablage mit 4-MiB-Datei- und 64-MiB-Sitzungsgrenzen, sitzungsrelative `tool-output://`-Verweise, lesbare Manifeste, Offset-Paginierung in `read`, Nachschlagen mit `rg`, Schreibschutz, selektiver Fork und Sitzungsbereinigung. Die vorhandene Kernel-Sperrfunktion schützt die Quota über Prozesse hinweg. Gespeicherte Identität und Verweise enthalten keinen absoluten DATA-Pfad; ein Umzug des Datenverzeichnisses ist getestet. Der bestehende Full-Backup-Scanner schließt `tool-outputs` nicht aus und übernimmt Datei-Statistiken ins Archiv.
- Schritt 3: Brave direkt, Brave managed und Ollama verwenden dieselbe auf 6.000 Zeichen begrenzte Tool-Darstellung mit höchstens 800 Zeichen Suchauszug pro Treffer. Vollständiger bereinigter Quelltext wird vor der Darstellung gespeichert. Managed-Antworten übernehmen nur validierte Felder. HTTP-Seitenabrufe und nachgeladene Suchseiten nutzen denselben Extraktionsdienst; zehn URLs teilen sich maximal 10.000 Zeichen. Metadaten werden zuerst reserviert, überlange URLs über vollständige Quelldateien nachgelesen. Der gemeinsame HTTP-Transport begrenzt den Datenstrom vor dem vollständigen Puffern, prüft Weiterleitungen und unterstützt eine Gesamtdauer sowie Abbruch während DNS und Body-Übertragung. Provider-JSON hat zusätzlich eine 16-MiB-Eingangsgrenze.
- Schritt 4: Gemeinsame Aufbereitung an der Tool-Ausführungsgrenze; MCP direkt/Proxy normalisieren identisch, Composio und Browser speichern vor der Ausgabegrenze. Kleine Ergebnisse behalten ihre Verträge. Große Originale werden als gültiges JSON mit kompakter Vorschau und Referenz gespeichert; kleine UI-Felder, Status, Authentifizierungsinformationen und Mutationskennungen bleiben erhalten. Bilder folgen weiter dem getrennten Medienpfad. Ein prozessinterner Identitätsmarker verhindert doppelte Ablage und lässt sich nicht durch Provider-JSON setzen. Gespeicherte `read`-Fenster werden nicht erneut ausgelagert.
- Externe Vertragstests: `npm run test:pi:external-outputs` führt echte Adapter und Ablage mit simulierten Providern und einem simulierten Seitenobjekt aus. Abgedeckt sind MCP-Gleichheit/Fehler/Ressourcen, vollständige Composio-Schemas und Ergebnisse, Auth-JSON, Browser-extract/evaluate, kleine Mutationen/Bilder, neue Provider am gemeinsamen Wrapper, Weitergabe von Abbruchsignal und Updates, gefälschte Marker, fehlende Identität, Serialisierungs- und Größenfehler. Die vorhandene MCP-Proxy-Suite besteht. Die vorhandene MCP-Direct-Suite stoppt beim Laden von `@earendil-works/pi-ai` in ihrem Registry-Teil; die neuen Tests decken den echten Direct-Adapter isoliert ab.
- Web-Prüfungen: `npm run test:pi:web-outputs`, Suchservice und aktualisierte Charakterisierung. Die Tests führen alle drei aktiven Suchtools sowie einen Dummy-Provider durch die gemeinsame Formatierung aus, lesen ausgelassene Inhalte aus der Ablage und prüfen Weiterleitungen auf private Adressen, DNS-Abbruch, Stream-Limit und fehlende Ablageidentität.
- Automatische Prüfungen: `npm run test:pi:tool-outputs`, bestehender `workspace-mutation-lock-test.ts`, ESLint der geänderten Dateien und vollständiger Typecheck. Die umfassende vorhandene Tool-Registry-Suite erreicht ohne PostgreSQL-Konfiguration ihren Datenbankteil nicht; die neuen Lifecycle-Tests führen die echten Fork-/Löschfunktionen mit isolierten DB-Mocks und echten temporären Dateien aus.
- Nutzerentscheidung: Nur Code und automatisierte Tests; interaktive UI-Abnahme später. Keine Browser-Tests und keine Container-Builds für diese Umsetzung.

## Ziel und Umfang

Suchtreffer sollen im Modellkontext kurz und vollständig identifizierbar bleiben. Lange Quellen und externe Tool-Ergebnisse sollen gezielt nachlesbar sein. Die Regeln gelten unabhängig vom Suchanbieter und vom verwendeten Sprachmodell.

Umfang: Brave direkt, Brave über die Control Plane, Ollama direkt, HTTP-Seitenabruf, Browser-Extraktion sowie direkte und vermittelte MCP-/Composio-Ergebnisse. Zukünftige Provider müssen denselben Ausgabe-Vertrag erfüllen. Bestehende Datei-, Mutations-, Authentifizierungs- und Medienverträge bleiben bei der Integration ausdrücklich prüfpflichtig.

Es wird kein weiterer Suchanbieter benötigt. Automatische LLM-Zusammenfassungen sind für die Ausgabeaufbereitung nicht vorgesehen. Die bestehende Gesprächskompaktion bleibt für tatsächlich wachsende Gesprächsverläufe zuständig.

## Befund im aktuellen Code

| Weg | Aktuelle Umsetzung | Konsequenz |
| --- | --- | --- |
| Brave direkt | `app/lib/integrations/brave-search-service.ts:230`: Trefferzahl begrenzt; `description` unverändert als `snippet` | Keine eigene Textgrenze pro Treffer |
| Ollama direkt | Derselbe Service, Zeile 294: `content` unverändert als `snippet`; API-Anfrage maximal zehn Treffer | Lange Inhalte trotz `include_content: false`; `max_content_length` begrenzt diese Snippets nicht |
| Brave managed | Derselbe Service, Zeile 351: `/v1/managed/brave/search`; `results` wird als `WebSearchResult[]` übernommen | Keine erneute Feldvalidierung oder verbindliche Ausgabelimitierung im Notebook |
| Control Plane | `apps/api/src/routes/managedServices.ts:1687` im benachbarten Repo normalisiert Brave ohne Textlimit | Auch dieser Weg benötigt die gemeinsame Notebook-Begrenzung |
| Managed Ollama | Control Plane besitzt bereits `/managed/ollama/search`; im untersuchten Notebook-Suchservice nicht angebunden | Im Providervertrag berücksichtigen; Aktivierung ist keine Voraussetzung für diese Arbeit |
| Suchtreffer mit Seiteninhalt | `searchWeb`, Zeile 425: zusätzliches HTTP-Nachladen; standardmäßig 5.000, maximal 20.000 Zeichen pro Seite | Kein gemeinsames Budget über Treffer, Snippets und Seiteninhalte |
| `web_fetch` | `app/lib/pi/web-tools.ts:35,269`: separate HTTP-/Readability-/Turndown-Implementierung; bis zehn URLs; standardmäßig 10.000 Zeichen pro Seite | Doppelte Extraktionslogik; bis etwa 100.000 Inhaltszeichen mit Standardwerten; abgeschnittene Teile werden hier nicht gespeichert |
| Browser | `app/lib/pi/browser/content.ts:34`, `browser/gateway.ts:481,565`: lokale Kürzung für Extraktion/evaluate | Eine spätere gemeinsame Ablage könnte bereits verlorenen Text nicht zurückholen |
| MCP | `app/lib/mcp/direct-tools.ts:33` und `proxy-tool.ts:383`: Textblöcke werden zusammengefügt; vollständiges Resultat zusätzlich in `details` | Zwei Formatierungspfade ohne eigene Gesamtgrenze; strukturierte Metadaten und Text können groß werden |
| Composio | `app/lib/composio/composio-tools.ts:45,109`: JSON wird bei 8.000 Zeichen abgeschnitten, `details` leer | Ausgabe kann ungültiges JSON sein; der Rest ist über diesen Rückgabepfad verloren |
| Modellkontext | `app/lib/pi/message-projection.ts:6,151`: 12.000 Textzeichen pro Tool-Ergebnis, vom Anfang abgeschnitten | Ein sehr langer erster Suchtreffer kann alle weiteren Treffer aus der Modellansicht verdrängen |
| Live-Kompaktion | `app/lib/pi/live-runtime.ts:2217`: zuerst Projektion, danach vollständiger Verlauf und kanonisches Provider-Payload | Der aktuelle Stand vermeidet bereits Kompaktion allein aufgrund sehr großer Rohausgaben; diesen Fix erhalten |
| Nachlesen | `app/lib/pi/core-tools.ts:134`: `read` hat `maxChars`, aber keinen Text-Offset; `session_search` kürzt Nachrichtentext auf 1.200 Zeichen | Ein Dateiverweis allein stellt noch keine funktionierende Paginierung bereit |
| Temporäre Dateien | `app/lib/pi/agent-runtime-temp.ts:9`: standardmäßig 24 Stunden Aufbewahrung | Als einzige Ablage für Quellen in wiederaufgenommenen Gesprächen ungeeignet |

Der Befund erklärt große Rohausgaben und verlorene spätere Treffer. Ohne konkrete Sitzung und Provider-Telemetrie beweist er nicht, dass das aktuelle Deployment tatsächlich sein Modellkontextlimit überschreitet. Es wurden keine Zugangsdaten oder Nutzersitzungen gelesen und keine Live-Provider-Abfragen ausgeführt.

## Geplante Architektur

```text
Provider / externes Tool
  -> anbieterbezogene Antwortvalidierung
  -> vollständiges, begrenztes Ausgangsergebnis sichern
  -> gemeinsame Ausgabeaufbereitung
       Suche: Quellenliste + kurze Snippets
       Seiten: Metadaten aller Quellen + verteilte Textauszüge
       sonstige große Ergebnisse: Vorschau + Nachleseverweis
  -> ToolResult mit kompakter Modellansicht und Referenzmetadaten
  -> Budget für den neuen Tool-Aufrufblock
  -> bestehende Kontextprojektion und kanonisches Provider-Payload
  -> Modell

Nachlesen: read mit Offset / rg -> gespeichertes Ausgangsergebnis
```

Provideradapter besitzen Authentifizierung, Endpoint, Parameterübersetzung und Antwortvalidierung. Eine gemeinsame, deterministische Formatierung besitzt Längenregeln, Quellenreihenfolge, Auslassungshinweise und Referenzen. Ein separater kleiner Speicherdienst besitzt Ablage, Lebensdauer und Zugriff. Diese Mechanik gehört weder mehrfach in Provideradapter noch als große zusätzliche Funktion in `LivePiRuntime`.

Konkrete neue Module: `app/lib/pi/tool-output-policy.ts`, `tool-output-store.ts` und `tool-output-format.ts`. Die bestehende Suchdatei kann ihren Namen zunächst behalten. Ein gemeinsamer HTTP-Extraktionsdienst unter `app/lib/integrations/web-content-service.ts` ersetzt die doppelte Extraktionsmechanik in Suchservice und `web-tools.ts`; Browser-Navigation bleibt im Browser-Modul.

## Vorgeschlagene Startbudgets

Die Werte sind Implementierungs-Startwerte, keine bereits gemessenen Qualitätsoptima. Zeichenbudgets enthalten Überschriften, Metadaten und Nachladehinweise. Der vorhandene Schätzer für das tatsächlich serialisierte Provider-Payload bleibt maßgeblich für Kontextgrenzen.

| Ausgabe | Startwert |
| --- | --- |
| Suche | Standard fünf Treffer; höchstens 800 Zeichen Snippet je Treffer; 6.000 Zeichen insgesamt |
| Seitenabruf | Bis 6.000 Inhaltszeichen je Seite; 10.000 Zeichen insgesamt über alle angefragten URLs |
| Sonstiges großes Tool-Ergebnis | Vorhandene Grenze von 12.000 Zeichen als Obergrenze; bei Überschreitung 1.500 Zeichen Vorschau plus Referenz |
| Gezielt nachgeladener Text | Standard 6.000, maximal 10.000 Zeichen pro Leseaufruf, einschließlich benötigtem Platz für Metadaten |
| Einzelnes Tool-Ergebnis bei kleinen Modellen | Zusätzlich höchstens 5 % des effektiven Kontextfensters als geschätztes Tokenbudget |
| Neuer Tool-Aufrufblock | Höchstens 6.000 geschätzte Tokens beziehungsweise 15 % des Kontextfensters, falls kleiner |

Ein Tool-Aufrufblock ist eine Assistant-Nachricht mit ihren zugehörigen Tool-Ergebnissen, nicht das ganze Gespräch und nicht die gesamte Nutzeraufgabe. Einträge werden nicht gelöscht, um das Budget einzuhalten: übergroße Einträge erhalten eine kleinere Modellansicht mit weiterhin vorhandenem Ergebnisverweis. Reicht selbst das Referenzminimum nicht, übernimmt die bestehende Kompaktions-/Fehlerbehandlung. Kein Mindestbudget darf die reale freie Kapazität überstimmen.

Für Suchlisten zuerst Budget für Quellenkennungen und Metadaten reservieren, dann den verbleibenden Platz auf Snippets verteilen. Bei normalen fünf Treffern bleiben alle URLs sichtbar. Bei extrem langen URLs oder sehr vielen angeforderten Treffern erhalten Quellen eine kurze Kennung und einen abrufbaren vollständigen Manifest-Eintrag; verkürzte URLs dürfen nicht als anklickbare Original-URLs ausgegeben werden. Tatsächliche Trefferzahl, dargestellte Trefferzahl und ausgelassene Einträge werden getrennt ausgewiesen.

Für Seiten ebenfalls zuerst pro URL Titel, Status und Referenz erhalten, danach Auszüge gleichmäßig verteilen. Anfang/Ende ist eine brauchbare deterministische Vorschau; das ist keine Behauptung, die relevantesten Passagen gefunden zu haben. Exakte Details kommen über `rg` und paginiertes `read`.

## Umsetzung in abgeschlossenen Schritten

### 1. Verhaltensverträge und gezielte Regressionsfälle

- Tests um lange erste und spätere Treffer bei Brave direkt, Brave managed und Ollama ergänzen, einschließlich `include_content: false`.
- Gemeinsame Fälle für überlange Titel/URLs, ungültige Managed-Antworten, Unicode, Base64-Bilddaten, leere Treffer und HTTP-Fehler definieren.
- Bestehende Testfälle für Kontextprojektion und normalisierten Kompaktions-Preflight als Ausgangspunkt verwenden.
- Abschlusskriterium: Grüne Charakterisierungstests und wiederverwendbare Fixtures belegen das heutige Verhalten. Neue Ziel-Invarianten werden mit dem jeweils zugehörigen Implementierungsschritt aktiviert; kein Zwischencommit hinterlässt absichtlich eine rote Suite. Eine Dummy-Providerantwort prüft später, dass die Regeln nicht vom Providernamen abhängen.

### 2. Ergebnisablage und tatsächlich nutzbares Nachlesen

- Neue Ablage unter dem aufgelösten `DATA`-Root, vorgeschlagen `tool-outputs/<org>/<user>/<session>/<toolCallId>/`; keine Schlüssel in Dateinamen, keine globalen URL-basierten Dateinamen.
- Pro Quelle bereinigten Text und ein kleines Manifest mit Original-URL, Titel, Provider, Zeitpunkt, Umfang und Vollständigkeitsstatus speichern. Bei generischen JSON-Antworten gültiges Original-JSON speichern; Vorschau ausdrücklich als Text kennzeichnen.
- Zunächst höchstens 4 MiB pro gespeicherter Quelldatei und 64 MiB pro Sitzung; Prüfungen auch auf tatsächlich geschriebene Bytes. Bei überschrittenem Limit oder Schreibfehler nur eine ehrliche begrenzte Ausgabe mit Fehler-/Unvollständigkeitshinweis zurückgeben. Niemals behaupten, der Volltext sei vorhanden, wenn das Speichern scheiterte.
- Private, atomare, gegen Symlink-Ausbrüche geprüfte Ablage; sessiongebundene Leseerlaubnis in der vorhandenen Pfadprüfung ergänzen. Besitz und Workspace-Zugriff serverseitig prüfen. Unvertrauenswürdige Providerfelder dürfen keine vertrauenswürdigen Dateireferenzen erzeugen.
- `read` um `offset` für Text ergänzen: nullbasiert, dieselbe Zeichenindexierung wie `maxChars`, Rückgabe von `nextOffset`, `eof` und Gesamtumfang. Server erzeugt den nächsten gültigen Offset; Unicode-Grenzen beachten. Hash bezieht sich weiterhin auf die gesamte Datei. PDF- und Live-Collaboration-Verhalten separat erhalten.
- `rg` muss die freigegebenen Ergebnisdateien lesen können. Paginierte Leseergebnisse dürfen nicht erneut auf dieselbe Datei ausgelagert werden und dadurch eine Endlosschleife erzeugen.
- Aufbewahrung an die Sitzung koppeln; beim Löschen der Sitzung Dateien entfernen. Verwaiste, nie persistierte Ausgaben gesondert bereinigen. Backup/Restore und Session-Fork berücksichtigen: Referenzen einer geforkten Sitzung müssen kopiert oder explizit mit korrekter Lebensdauer geteilt werden. Delegierte Sitzungen erhalten nur ausdrücklich freigegebene Ergebnisreferenzen.
- Abschlusskriterium: Ein Detail aus der ausgelassenen Mitte ist nach Neustart abrufbar; fremde Sitzung kann es nicht lesen; Löschen/Fork und Dateifehler sind abgedeckt.

### 3. Alle eingebauten Suchanbieter und HTTP-Seitenaufrufe umstellen

- Nach der Provider-Normalisierung einen gemeinsamen Such-Ausgabevertrag anwenden. Brave managed im Notebook ebenso strikt prüfen und begrenzen wie direkte Providerantworten.
- Umfangreichen Ollama-`content` sowie Brave-`description` als Ausgangstext behandeln; aus beiden dieselbe kompakte Snippet-Darstellung erstellen.
- `include_content: false` bedeutet kurze Suchauszüge. `include_content: true` bleibt kompatibel, lädt Seiten zusätzlich, verwendet jedoch dasselbe Seiten-/Gesamtbudget und erzeugt Nachleseverweise.
- Gemeinsamen HTTP-Extraktionsdienst verwenden. Den schon vorhandenen sicheren HTTP-Fetch mit Byte- und Zeitgrenze, Abbruchsignal und Redirect-Prüfung für beide Aufrufwege nutzen; vor der Ausgabegrenze speichern. HTML/Markdown-Konvertierung und Entfernung eingebetteter Base64-Bilder zentralisieren. Bestehende MIME-Unterstützung beibehalten; PDF-Unterstützung ist keine Voraussetzung.
- Zahlenparameter serverseitig validieren/clampen, nicht nur im Schema beschreiben. Kürzungshinweise nennen den tatsächlichen Wert statt immer „10.000 Zeichen“.
- Abschlusskriterium: Alle drei aktiven Suchwege liefern identische Budgeteigenschaften; lange erste Quelle verdrängt spätere Treffer nicht. Jeder gekürzte Seiteninhalt besitzt einen funktionierenden Nachleseverweis oder eine explizite Speicherfehlermeldung.

### 4. Externe Tools, MCP, Composio und Browser anbinden

- Gemeinsame Ergebnisaufbereitung unmittelbar nach der Tool-Ausführung anbinden; `wrapToolWithExecutionContext` beziehungsweise dessen Aufrufer ist die bereits vorhandene gemeinsame Grenze. Speicheridentität explizit aus dem Ausführungskontext übergeben.
- MCP direkt und Proxy verwenden dieselbe Normalisierung. Strukturierte Ergebnisse, reine Textblöcke, Fehlermeldungen und Ressourcenreferenzen erhalten. Beliebiges JSON darf nicht durch Abschneiden als vermeintlich gültiges JSON ausgegeben werden.
- Composio vor `truncateResult` anbinden, damit Originaldaten gespeichert werden können. Auth-/Connect-Informationen, Fehlerstatus und für Mutationen notwendige Ergebniskennungen müssen auch in der kurzen Darstellung erhalten bleiben.
- Browser-Extraktion und `evaluate` vor ihrer eigenen destruktiven Kürzung anbinden. Element-IDs und Navigationsinformationen der Browsersteuerung erhalten; Screenshot-/Bildbudgets bleiben separat.
- Bereits aufbereitete Ergebnisse intern kennzeichnen, um doppelte Ablage oder doppelte Kürzung zu vermeiden. Providerpayloads können diese interne Kennzeichnung nicht selbst setzen.
- Modellansicht und kleine Referenzmetadaten in neuen Sitzungsnachrichten persistieren; vollständige große Ergebnisse referenzieren statt sie zusätzlich in `content` und `details` zu duplizieren. Existierende UI-relevante strukturierte Felder gezielt erhalten. Alte Datenbanknachrichten zunächst unverändert lassen.
- Bei Ausführung ohne gültige Sessionidentität keine globale Ersatzablage verwenden: begrenzte Ausgabe mit explizit fehlender Nachlademöglichkeit liefern.
- Abschlusskriterium: Gleiche Eingabe über MCP direkt/Proxy liefert dieselbe zugängliche Information. Composio-Restdaten sind nachlesbar. Kleine Ergebnisse und Mutationserfolge behalten ihre bisherigen Verträge.

### 5. Gemeinsames Budget und Konsistenz der Laufzeit

- Den neuen Tool-Aufrufblock vor der nächsten Modellanfrage als Gruppe budgetieren. Einzelergebnis-Limits allein verhindern nicht die Summe vieler mittlerer Ausgaben.
- Überzähligen Text durch kleinere referenzierte Ansichten ersetzen; Tool-Call-IDs, Resultatpaare, Reihenfolge, Fehlersignale und Nachleseverweise erhalten.
- Modellansichten für abgeschlossene Blöcke mit Policy-Version stabil speichern. Früher gesendete Ergebnisse nicht bei jeder Anfrage je nach Restbudget neu verkürzen. Bei einem expliziten Modellwechsel muss die Budgetprojektion bewusst neu berechnet werden.
- Integration mit `projectAgentMessageForLoadedContext`, `preparePiFinalPayload`, Live-/gespeicherter Kontextmessung und Kompaktions-Preflight gemeinsam prüfen. Legacy-Ergebnisse behalten zunächst die bestehende 12.000-Zeichen-Notbegrenzung; für bereits sauber vorbereitete neue Ergebnisse ist sie nur die letzte Absicherung.
- Die Grenze gilt für jeden Modellprovider. Kontextgrößen aus bestehender Modellauflösung übernehmen; keine Ollama-Sonderwerte oder zweite konkurrierende Kontextanzeige einführen.
- Größen und Entscheidungen messen: Rohausgabe, Modellansicht, ausgelagerte Bytes, dargestellte/ausgelassene Treffer, angewendete Policy, endgültige Payload-Tokens. Keine Suchtexte, Quellinhalte oder Zugangsdaten ins Diagnoselog schreiben.
- Abschlusskriterium: Aktive und wiederaufgenommene Sitzung berechnen dieselbe Modellansicht. Große Rohdaten allein lösen keine Kompaktion aus; echte Kontextüberlastung wird weiterhin erkannt. Live-Chat, Automation und delegierte Ausführung werden geprüft.

### 6. Darstellung und Abnahme

- Tool-Karten zeigen Anzahl der Quellen und „Auszug – vollständiger Inhalt verfügbar“. Große Originaltexte nur bei gezieltem Öffnen laden; sie nicht automatisch erneut ans Modell senden.
- Fehler beim Speichern/Nachladen sichtbar halten. Web- und Mobile-Verbraucher müssen neue Referenzmetadaten tolerieren; die serverseitige Ausgabeoptimierung darf nicht von einem Mobile-Update abhängen.
- Automatische Prüfungen: Suchservice, MCP direkt/Proxy, Composio-Formate, paginiertes Lesen, Speicherisolation und Löschung/Fork; bestehende Tests für Kontextbudget, Projektion, normalisierten Kompaktions-Preflight und multimodale Payloads.
- Mindestens Kontextgrößen 16k, 32k und 262k mit derselben gemischten Ergebnisfolge prüfen. Bei kleinen Fenstern zählt auch der Platz für Systemprompt, Tool-Schemas, Antworten und Sicherheitsreserve.
- Danach Typecheck/Lint und `npm run build`. UI-/E2E-Abnahme nach ausdrücklicher Freigabe gemäß `AGENTS.md`: erst Suche, dann Detail aus der ausgelassenen Mitte nachlesen, Sitzung neu laden, Kontextanzeige kontrollieren. Lokales Setup über `canvas-local-team-seat-dev`; Container nur bei ausdrücklichem Auftrag, genau ein verwalteter Stack.
- Jeder Schritt wird erst nach seinen Abschlusskriterien abgeschlossen und separat committed. Vor Symboländerungen erneute GitNexus-Impact-Analyse; vor Commits `detect_changes()`.

## Änderungsrisiko und Rollout

GitNexus wurde gegen den Index des gleichnamigen Code-Stands `caba97d5` im Worktree `789e` abgefragt; die Befunde wurden mit den Dateien dieses Worktrees abgeglichen. Der Graph enthält nicht für jeden Treffer einen benannten Prozess; leere Prozesslisten sind keine Aussage über fehlende Laufzeitwirkung.

| Einstiegspunkt | Graphbefund | Folgerung |
| --- | --- | --- |
| `formatWebSearchResults` | LOW, ein direkter Aufrufer | Suchformatierung lässt sich als enger Schritt einführen |
| `wrapToolWithExecutionContext` | HIGH, acht betroffene Symbole, drei Module | Externe Tool-Anbindung gesondert integrieren und Automations-/Mobile-Pfade prüfen |
| `projectAgentMessageForLoadedContext` | CRITICAL, 38 betroffene Symbole, sieben Module | Eigener Integrationsschritt mit Persistenz-, Status- und Kompaktionsregressionen |

Empfohlene Reihenfolge: Verträge → Ablage/Nachlesen → alle eingebauten Webwege → externe Tools/Browser → Blockbudget/Kontextkonsistenz → UI-Abnahme. Das sind aufeinander aufbauende Teile derselben Änderung, keine parallelen unabhängigen Umbauten.

Neue Ergebnisreferenzen müssen auch nach einem Rollback lesbar bleiben. Daher Ablage-/Leseunterstützung zuerst ausliefern; Erzeugung neuer referenzierter Ergebnisse anschließend aktivieren. Ein Rollback der Ausgabeaufbereitung entfernt weder Dateien noch Lesefunktion. Bestehende Suchparameter und Providerkonfiguration bleiben kompatibel.

Vor einem Ausbau der Control-Plane-API ist keine Freigabe neuer Anbieter erforderlich: Die Notebook-Seite setzt ihre Ausgabegrenzen selbst durch. Ein dort vorhandener Managed-Ollama-Weg kann später mit denselben Vertragstests angebunden werden.

## Quellen zur Hermes-Referenz

- Lokales `tools/web_tools.py:635,736,1532`: fünf Standardtreffer; 15.000 Zeichen je extrahierter Seite; Anfang/Ende und Dateiverweis.
- Lokales `tools/tool_result_storage.py:1` und `tools/budget_config.py:139`: Ergebnisablage, Vorschau und an die Kontextgröße angepasste Budgets.
- [Hermes: Web Search & Extract](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search)
- [Ollama: Web search](https://docs.ollama.com/capabilities/web-search)

Die Untersuchung und der ursprüngliche Plan erfolgten ohne Produktänderungen. Der aktuelle Umsetzungs- und Prüfstand steht oben; UI-/E2E-Abnahme und Container sind weiterhin ausgenommen.
