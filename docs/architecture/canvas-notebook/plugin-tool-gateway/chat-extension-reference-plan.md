# Einheitlicher Erweiterungskontext für Chat und Agenten

Plan vom 13. Oktober, erneut geprüft am 14. Oktober 2026. **Aktueller Auftrag: zuerst Feedback geben und diesen Plan in `docs` speichern; danach gemeinsam optimieren. Dieser Arbeitsschritt ändert ausschließlich Dokumentation.** Bereits vorhandene Implementierung wird als Bestand berücksichtigt, aber nicht als Freigabe für weitere Umsetzung oder als fertige Abnahme gewertet.

Geprüfte Grundlage ist der Feature-Branch mit Optionscheckpoint `edd2f26a2` und Plancheckpoint `9700cd201`. Danach liegt eine zusätzliche Kontextprüfung vor Agent- und Präferenz-Commit als noch nicht abgeschlossener lokaler Implementierungsentwurf im Arbeitsbaum. Die öffentliche Vorschau verwendet weiterhin ein leeres Registrierungsmanifest und lässt Teile des tatsächlichen Kontexts aus; sie ist daher noch keine vollständige Save-Vorprüfung. Der jeweilige Prüfstand steht im Umsetzungsjournal. Historische Ausgangsbasis ist Notebook `27425ddc7`; Backend- und Browservertragsgrundlagen umfassen `fbb7e3a6e` und `c3baf14c2`. Lokale Prüfungen älterer Teilstände sind weder Abnahme der neuen Chat-/Agent-Oberflächen noch Nachweis für Main oder Produktion.

Der vorausgegangene Implementierungsstand bleibt im [Umsetzungs- und Abnahmejournal](chat-agent-extension-implementation.md) nachvollziehbar. Dieses Dokument beschreibt das Ziel und die vorgeschlagenen Entscheidungen; vorhandene Grundlagen oder frühere Pluginseiten-Tests gelten nicht als Abnahme der neuen Chat-/Agent-Bedienung.

## Feedback und empfohlene Entscheidungen

**Die gewünschte Logik ist teilweise vorhanden, aber noch nicht durchgehend umgesetzt.** Der Pluginseiten-Katalog sucht bereits gemeinsam über alle vier Typen und liefert deren vorhandene Logoquellen. Genaue Auswahlverträge, Versionsleser, gemeinsamer Kontextcompiler und der vollständige Agent-Create-/Update-/Inspect-/Choice-Schreibweg sind als Backend-Grundlage vorhanden. Der Optionsdienst bietet gemeinsame Suche, Paketdetails, gezielte Verbindungswahl und eine vorläufige Vorschau über API und Agent-Tools. Die Chat-Auswahl verwendet dagegen weiterhin eigene Plugin-/Skill-Listen und Namen; gemeinsame Auswahloberflächen, vollständiger V2-Editor, vollständige Vorschau und dauerhafter Nachrichtentransport sind offen. Die zusätzliche finale Save-Prüfung ist lokaler Entwurf und noch kein abgeschlossener Bedienweg. Ein größerer Slash-Picker allein würde diese Unterschiede bestehen lassen.

Empfehlung: dieselben genauen Auswahlreferenzen und dieselbe serverseitige Kontextaufbereitung für Plugin-Seite, Chat, Agent-Tool und Agent-Oberfläche verwenden. Die Oberflächen teilen Katalog, Identität, Icons und Auswahlkomponenten; ihre jeweilige Nutzbarkeit wird für den aktuellen Nutzer, Workspace und Agenten geprüft.

„Verbunden“ oder „autorisiert“ im Katalog garantiert keinen erfolgreichen Agent-Aufruf. Sichtbarkeit, aktuelle Nutzungsrechte, Agent-/Toolgrenzen und tatsächliche Provider-Erreichbarkeit bleiben getrennte Zustände. Die neue Auswahlprojektion muss die konkrete Verbindung prüfen und diese Unterschiede verständlich anzeigen.

| Entscheidung | Empfohlener Ausgangspunkt |
| --- | --- |
| Plugin oder Einzelbestandteil | Plugin als bequemes Gesamtpaket anbieten; Skills, Composio und MCP bleiben unabhängig auswählbar. Gleich passende Vorschläge dürfen Plugins bevorzugen; ein genauer Einzel-Treffer bleibt sichtbar. |
| Suche | Ein Eingabefeld für alle vier Typen. Ohne Text zuletzt akzeptierte Chat-Auswahlen; mit Text Relevanz zuerst. Typfilter sind optional und erhalten die Query. |
| Progressive Disclosure | Zunächst Logo, Name, Typ, Nutzen und Status. Erst danach Paketbestandteile, mehrere Accounts, Toolgrenzen und Kontextvorschau aufklappen. Einrichtung führt zum genauen Katalogeintrag und erhält den Entwurf. |
| Spezialagent | Konfigurierte Erweiterungen bei jedem Start im Systemkontext. Ein Chat-Chip fokussiert die zulässige Auswahl; er erweitert keine dauerhafte Freigabe. |
| Allgemeiner Chat | Präziser Erweiterungskontext für explizite Turn-Auswahl. Zusätzlich auftragsbezogene Skill-Suche innerhalb bereits erlaubter Ressourcen, ohne vollständigen Skillkatalog im Systemprompt. |
| Agent-Tool und UI | Derselbe vollständige Create-/Update-Vertrag mit Paketversionen, konkreten Verbindungen und Toolgrenzen; gegenseitiger Inspect-/Edit-Roundtrip. |
| Logos | Composio-Toolkit-Logos, vorhandene Paket-/Skill-Icons und geprüfte MCP-Domain-Icons wiederverwenden; bei fehlendem oder nicht ladbarem Bild Namensinitialen. |

### Feedback für die nächste gemeinsame Optimierung

Das Ziel ist **ein Katalog, ein Referenzmodell und eine Kontextaufbereitung**, mit passender Aktion je Oberfläche. Die Plugin-Seite richtet Ressourcen ein; der Agent-Editor weist sie dauerhaft zu; der Chat hängt sie an eine Nachricht. Die gemeinsame Darstellung darf diese unterschiedlichen Wirkungen nicht verdecken.

| Zu präzisierender Punkt | Konkreter Vorschlag |
| --- | --- |
| Informationsmenge | Eine Trefferzeile zeigt Logo, Name, Typ, kurzen Nutzen und einen priorisierten Status. Paketinhalt und Account öffnen erst bei Bedarf; Werkzeuggrenzen und technische Kontextvorschau bleiben eine weitere Ebene. Kein dauerhaft offenes Verwaltungsformular im Chat. |
| „Zuletzt verwendet“ | Zunächst ausschließlich bestätigte explizite Chat-Auswahlen zählen. Derselbe Verlauf darf im Agent-Editor als **„Zuletzt im Chat verwendet“** vorgeschlagen werden, frisch auf dessen Zielrechte gefiltert. Speichern einer Agent-Konfiguration erzeugt keine vermeintliche Chat-Nutzung. |
| Plugin als Gesamtpaket | Ein Plugin bleibt ein Hauptchip mit seinen zugeordneten Verbindungen in den Details. Vorschlag: maximal fünf vom Nutzer gewählte Hauptchips; abhängige Verbindungen erhalten getrennte technische Grenzen. **Das erfordert eine Anpassung des vorbereiteten Vertrags:** Dessen heutige Fünfergrenze zählt auch einzeln transportierte Verbindungsreferenzen. Bis dahin keine irreführende Anzeige „fünf Plugins möglich“. |
| Accountwahl | Bestehende Verbindung ausdrücklich wählen, inklusive Profil/Bereich als Unterscheidung bei gleichen Namen. Eine Chat- oder Agentwahl verändert kein Workspace-Standardprofil. Der heutige Katalog-OAuth-Ablauf mit `applyProfile()` darf dafür nicht unverändert übernommen werden. |
| Gemeinsamer Agent mit persönlichen Konten | Eine vollständig konfigurierte Regel „jeder Nutzer wählt seine eigene zulässige Verbindung“ ist speicherbar. Die noch fehlende persönliche Pflichtwahl erscheint als **„Meine Verbindung einrichten“**. Nach heutiger Runtime bleiben externe Workflow-Aktionen bis zur vollständigen Pflichtwahl gesperrt; zulässige lokale Skills bleiben verfügbar. Das Erstellerkonto wird nicht als Ersatz gebunden. |
| Unvollständige feste Bindung | Fehlt dagegen die notwendige konkrete Bindung oder eine gültige Wahlregel, bleibt das Formular ein Entwurf. Es entsteht kein vermeintlich startbereiter Teilagent. Provider-Erreichbarkeit wird separat behandelt und nicht aus einem erfolgreichen Save abgeleitet. |
| Entwurf nach OAuth/Reload | Nutzer-/Workspace-/Zielbindung und Ausgangsrevisionen speichern; keine Secrets oder kurzlebigen Accountbelege. Vorschlag zur Abstimmung: sieben Tage Aufbewahrung, danach verwerfen; nach Save oder bewusstem Abbruch sofort löschen. |

Diese Werte und Regeln sind **Vorschläge zur Abstimmung**, keine in diesem Dokumentationsschritt vorgenommenen Vertrags- oder Produktänderungen. Zuerst sollten Lebensdauer, Kontowahl und Paketumfang abgestimmt werden; Ergebnisanzahl, Aufbewahrung und Budget lassen sich anschließend anhand realer kleiner und großer Pakete verfeinern.

Startwerte zur gemeinsamen Optimierung: sechs bis acht sichtbare Treffer und etwa 30 Recents je Nutzer/Workspace. Die vorbereiteten Verträge und der Renderer setzen derzeit fünf genaue Turn-Auswahlreferenzen beziehungsweise 8 KiB für den kompakten Erweiterungskontext um. Sichtbare Hauptchips und notwendige abhängige Verbindungen müssen vor der UI-Freigabe eindeutig gezählt und mit realen Paketen geprüft werden. Die dauerhaft konfigurierbaren Agent-Ressourcen sind davon getrennt. Offene Produktentscheidungen stehen am Ende des Plans; die technische Abnahmematrix ist weiter unten festgehalten.

### Konkrete Reihenfolge für den weiteren Ausbau

Die Bezeichnungen folgen den sechs Gesamtstufen weiter unten. Referenzvertrag und Runtime sind vorbereitete Grundlagen der Stufen 1 und 2; folgende Arbeit würde daran anschließen, sobald der Plan abgestimmt ist:

| Stufe | Nächste Arbeit | Überprüfbarer Abschluss |
| --- | --- | --- |
| 3a. Vorschau und Save | Lokalen Save-Entwurf abschließen; öffentliche Preview an denselben vollständigen Kontext mit tatsächlichen Tools, Modellvererbung, Pflichtskills, Paketpins und Verbindungen anschließen | Vorschau und Save stimmen überein. Fehlender Lese-/Suchweg oder zu großer Pflichtkontext blockiert atomar. Eine gültige persönliche Wahlregel bleibt von einer fehlenden festen Bindung unterscheidbar. |
| 3b–3d. Agent-Tool und Editor | Gemeinsame Auswahl in allen Erstellungs-/Bearbeitungswegen; Pakete, Kinder, Accountregeln, Werkzeuggrenzen, erhaltene Entwürfe und „Meine Verbindung“ | Tool-Create ist ohne Verlust in der UI bearbeitbar; UI-Create über Inspect identisch lesbar. Use ohne zentrale Edit-Rechte und Revisionskonflikte sind geprüft. |
| 4a. Chat-Picker | `/` und manueller Kontextknopf verwenden denselben Picker, Recents, Textsuche, optionale Filter, Details und Accountwahl | Alle vier Typen, genaue Accounts, Logos/Initialen und entfernbare Chips sind über Tastatur und Maus bedienbar. |
| 4b. Nachrichtenweg | Auswahl in Draft, Send, WebSocket/HTTP, Queue, Steer, Retry, Handoff und Verlauf erhalten | Reload und Serverneustart wechseln weder Paketpin noch Account. Recents ändern sich erst nach angenommenem Send; verlorene Bestätigungen wiederholen keine externe Mutation automatisch. |
| 5. Durchgehende Abnahme | Reale UI-Bedienung und echter Modelllauf: Suche, Accountwahl, Skill-Lesen, gezielte Tooldiscovery, Rechteentzug und Wiederaufnahme | API-, Browser-, Modell- und Providerbelege sind getrennt dokumentiert. Die vorhandene Pluginseiten-Abnahme ersetzt diese neuen Fälle nicht. |
| 6. Native Mobile | Eigene native Auswahl, Transport und Agent-Konfiguration anschließen | Eigene native Bedien-/Geräteabnahme; eine schmale Browseransicht genügt dafür nicht. |

Jeder dieser Schritte erhält ein überprüfbares Abschlusskriterium; die ausführlichen technischen Arbeitspakete und Abnahmefälle stehen weiter unten. Vor dem nächsten Codeabschnitt werden die Produktentscheidungen am Ende dieses Dokuments gemeinsam verfeinert. Die bereits vorhandene Backend-Arbeit wird dadurch weder verworfen noch pauschal als fertige Oberfläche bewertet.

### Aktueller Stand und wichtigste Restlücke

| Baustein | Stand am 14. Oktober | Was zur vollständigen Umsetzung fehlt |
| --- | --- | --- |
| Plugin-Seite | Gemeinsame Vier-Typen-Suche und bestehende Logoquellen implementiert; separate lokale Pluginseiten-Abnahme dokumentiert | Den gleichen Katalog und Avatar auch in Chat und Agent-Auswahl verwenden |
| Genaue Identität und Speicherung | Auswahl, Bindungsformate, V1/V2/Vererbung, Agent-Create/Update/Inspect/Choice sowie System-/Email- und Lifecycle-Restfälle als Backend-Grundlage lokal geprüft; Options→Writer-Roundtrip mit persönlichen Paketbindungen geprüft | Zusätzlichen lokalen Save-Entwurf abschließen und abnehmen; UI-Anschluss und langlebige Nachrichtenaufnahme |
| Gemeinsame Auswahloptionen | Browserfähige Verträge, Optionsdienst, API-/Tool-Anschluss und genaue persönliche Paketziele vorhanden; tatsächlicher Options→Writer-Roundtrip lokal mit SQL geprüft | Vollständige öffentliche Vorschau mit tatsächlichem Toolmanifest und Kontextbudget; UI anschließen |
| Gemeinsamer Runtime-Kontext | Compiler, begrenzte Prompt-Ausgabe, Skill-Discovery und Anschluss an Live-Runtime, Delegation und Automationen lokal geprüft; frische Toolrechte bleiben maßgeblich | Öffentliche Auswahl über Tool/API/UI anschließen; echten Modelllauf und vollständigen Bedienweg abnehmen |
| Chat und Agent-Oberfläche | Bisherige Plugin-/Skill-Auswahl weiterhin aktiv | Gemeinsamer Picker, genaue Accounts, Chips, Vorschau und Tool↔UI-Roundtrip |
| Nachrichten und Native Mobile | Neue Referenzen noch nicht vollständig angeschlossen | Send, Draft, Queue, Retry, Verlauf und Neustart; anschließend eigener nativer Anschluss und Abnahme |

**Wichtigster verbleibender Bedienweg:** Ein ausgewähltes Plugin kann eine Canva- oder MCP-Anforderung deklarieren, ohne bereits an eine konkrete Verbindung gebunden zu sein. Der Runtime-Vertrag kann diese Anforderung inzwischen einer ausdrücklich gewählten, kompatiblen Verbindung zuordnen und prüft die tatsächliche Paketdeklaration. Die UI muss diese Zuordnung noch verständlich anbieten: Bei mehreren passenden Accounts öffnet sie die Verbindungswahl; ohne passende Verbindung zeigt sie den Einrichtungsweg. Weder ein gleicher Name noch das Standardkonto gelten als Bindung. Das gilt auch für ein Plugin plus separat angeheftete Integration im allgemeinen Chat: bloße gemeinsame Anwesenheit genügt nicht. Lokale Skill-Anleitungen und die Einrichtung eines benötigten externen Werkzeugs bleiben getrennt erkennbar.

### Konkretes nächstes Arbeitspaket

Die folgenden Aufgaben schließen Schritt 3 ab, bevor der Chat-Anschluss beginnt:

Die Options→Writer-Grundlage ist inzwischen lokal geprüft: persönliche Paketziele kommen vom Server; eine neue V2-Accountbindung benötigt auch bei genau einem Account dessen ausdrücklichen Beleg. Echte No-auth-Bindungen und gehaltene Auswahl bleiben erhalten. Metadatensuche und Accountprüfung sind getrennt; der Browser berechnet keine Provider-Aliase. Die folgenden offenen Schritte bauen darauf auf.

1. **Öffentliche Vorprüfung vervollständigen:** Tatsächliche Toolregistrierung, Modell-/Provider-Vererbung, Pflicht-/Core-Skills, genaue gebundene Provider und Kontextbytes gemeinsam berechnen. Der endgültige Writer verwendet inzwischen den tatsächlichen vorbereiteten SQL-Stand vor Commit, einschließlich persönlicher Wahl. Er reserviert auch die maximale JSON-Größe des späteren Suchtexts. Eine vorläufig kleinere Metadatenvorschau gilt weiterhin nicht als bestandene Budgetprüfung. Abschluss: Preview verwendet dieselbe vollständige Aufbereitung ohne fingierten Agenten oder Runtime-Beleg; bislang nicht bestimmbarer Umfang bleibt ausdrücklich unbekannt.
2. **Gemeinsamen Picker und vollständigen Editor anbinden:** Katalogsuche, Trefferzeile, `PluginExtensionAvatar`, Paketdetails und Accountwahl teilen. Ein gemeinsamer Entwurf erhält Pakete, ausgewählte Kinder, Standalone-Verbindungen, Wahlregeln, Toolgrenzen sowie V1/V2/Vererbung vollständig. Create, Profil-Edit und Workflow-Edit verwenden denselben Editor; Profiländerungen ohne Auswahländerung lassen `extensions` weg. Abschluss: Tool-Create ist ohne Verlust in der UI bearbeitbar und UI-Create per Inspect identisch lesbar.
3. **Kontext und Einrichtung durchgängig erhalten:** Settings, Chat-Agentauswahl und Plugin-Setup reichen den tatsächlichen Nutzer-/Session-/Workspace-/Organisations-/Projektkontext weiter. Separate Anfragen für Suche, Paketdetails, Kontowahl und Vorschau werden gegen Kontextwechsel abgesichert. Notwendige OAuth-Einrichtung erhält den genauen Entwurf und Rückkehrkontext; normale Kontowahl verändert kein Workspace-Standardprofil. Abschluss: verspätete Antworten oder Redirects wechseln weder Zielagent noch Konto noch Entwurf.
4. **Agent-Stufe abnehmen:** Echter Tool↔UI-Roundtrip, persönliche Wahl mit Use ohne zentrale Edit-Rechte, konkurrierender Save und fehlende Einrichtung. Standalone-MCP und Composio funktionieren ohne Hilfsplugin. Fehlerhafte Erstellungen hinterlassen keinen ausführbaren Teilagenten; die vorhandenen Lifecycle- und Scope-Garantien bleiben erhalten.

Danach folgt Schritt 4 als zusammenhängender Nachrichtenweg: derselbe Picker für `/` und manuelles Öffnen, Recents und genaue Chips, dann Send-Snapshot, Draft, WebSocket/HTTP, Queue, Steer, Retry, Handoff und dauerhafte Wiederaufnahme. Ein sichtbarer Chip ohne zuverlässigen Nachrichtentransport erfüllt diesen Schritt nicht.

### Derselbe UI-Baukasten für Katalog, Agenten und Chat

Katalogsuche, Trefferzeile, Avatar, Paketdetails und Verbindungswahl werden gemeinsam verwendet. Die serverseitige Projektion erhält den jeweiligen Verwendungskontext; eine Suchzeile bedeutet je nach Oberfläche etwas anderes:

| Oberfläche | Primäre Aktion | Dauer der Auswahl |
| --- | --- | --- |
| Plugin-Seite | Installieren, verbinden, verwenden oder bei entsprechender Berechtigung verwalten | Ressource beziehungsweise Verbindung wird eingerichtet; dadurch entsteht keine automatische Agent-Zuweisung |
| Agent erstellen/bearbeiten | Für diesen Agenten zuweisen | Versionierte feste Konfiguration; Kontext bei jedem Start |
| Meine Verbindung für einen gemeinsamen Agenten | Eine von dessen Konfiguration erlaubte persönliche oder gemeinsame Option wählen | Eigene Präferenz innerhalb der vorgegebenen Auswahl; keine Änderung der zentralen Agent-Konfiguration und keine zentralen Edit-Rechte erforderlich |
| Chat-Picker | Für diese Nachricht anhängen | Genau dieser Turn; gespeicherte Agent-Konfiguration bleibt unverändert |

Die erste Ebene zeigt nur Suche, optionale Filter und kompakte Treffer. Eine Detailansicht öffnet Paketbestandteile oder erforderliche Accountwahl. Werkzeuggrenzen und die vom Server erzeugte Kontextvorschau bleiben zunächst geschlossen. Die Oberfläche benennt den Unterschied sichtbar mit **„Dauerhaft für diesen Agenten“** beziehungsweise **„Für diese Nachricht“**.

Die Statusanzeige unterscheidet **verfügbar**, **Einrichtung erforderlich**, **Autorisation erforderlich**, **verwendbar**, **keine Nutzungsberechtigung** und **Dienst aktuell nicht erreichbar**. Pro Treffer erscheint zunächst ein handlungsrelevanter Hauptstatus; die getrennten Zustandsdimensionen stehen in den Details. Ist die Erreichbarkeit nicht geprüft, behauptet die Metadatensuche keinen gesunden Provider. Eine ausgefallene Katalogquelle erhält eine kompakte Retry-Aktion, während vorhandene lokale Treffer nutzbar bleiben. Eine weiterführende Fehleransicht zeigt, ob Quelle, Zuordnung, Berechtigung, Autorisierung oder Provider betroffen ist.

### Drei Arten von Agent-Kontext

| Anlass | Verhalten | Dauer |
| --- | --- | --- |
| Im Spezialagenten konfiguriert | Bei jedem Start einen kompakten Index der festen Pakete, Skills und Verbindungen mit präzisen Lese-/Toolwegen in den Systemkontext aufnehmen | Bis zur ausdrücklichen Konfigurationsänderung; Rechte werden weiterhin frisch geprüft |
| Im Chat ausdrücklich ausgewählt | Nur die ausgewählten, für diesen Agenten erlaubten Ressourcen als Nachrichtenkontext ergänzen; Plugin-Anforderungen ausdrücklich ihren Verbindungen zuordnen | Für die akzeptierte Nachricht, einschließlich Queue und Wiederaufnahme |
| Keine Referenz, aber passende Aufgabe | Zugelassene Skill-/Plugin-Metadaten suchen und passenden Skill autorisiert lesen; kein vollständiger Katalog im Systemprompt und keine stillschweigende Kontoauswahl | Bedarfsgesteuerte Discovery für die Aufgabe |

Feste Verfügbarkeit bedeutet nicht, alle vollständigen Skilltexte bei jedem Start einzufügen. Paketbeschreibung, kompakter Skillindex und konkrete Suchwege erscheinen sofort; ausführliche Anleitungen und Toolschemas werden bei Bedarf geladen. Ein Plugin mit mehreren Accounts braucht eine tatsächliche Zuordnung seiner Anforderung. Das bloße Anhängen eines gleichnamigen Composio-Chips stellt diese Zuordnung nicht her.

### Beispiel für den vollständigen Nutzerfluss

Der Nutzer öffnet `/`, tippt `canva` und sieht Plugin, Skill, Composio-App und bekannte direkte MCP-Verbindung in derselben Liste. Er wählt das Plugin „Content Studio“. Die Detailansicht zeigt dessen enthaltene Skills und eine notwendige Canva-Verbindung. Bei mehreren passenden Konten wählt er ausdrücklich „Design-Team“. Danach erscheint ein eindeutig beschrifteter, vollständig zugeordneter Chip. Ohne passende Verbindung führt „Einrichten“ zum genauen Katalogeintrag und anschließend in denselben Entwurf zurück. Als Vorschlag für die Optimierung darf das Plugin bereits vorher im Entwurf angeheftet sein, sichtbar mit „Einrichtung fehlt“; eine fehlende Pflichtbindung muss vor Send aufgelöst werden. Fehlende optionale Verbindungen blockieren unabhängige zulässige Skills nicht. Der Picker darf Pflichtanforderungen dafür nicht stillschweigend entfernen.

```text
Für diese Nachricht                         [ Schließen ]
[ canva                                      ] [Filter]
  [Logo] Content Studio     Plugin · 3 Skills       ›
  [Logo] Canva              Integration · 2 Konten  ›
  [CD]   Canva prüfen       Skill                   +
  [Logo] Design-Server      MCP · Team               +

             Auswahl öffnen, falls nötig
  Content Studio · Bestandteile und Verbindungen
  3 Skills ausgewählt          [Anpassen ▸]
  Canva: [ Design-Team ▾ ]
  [ Werkzeuggrenzen ▸ ] [ Agent-Kontext ▸ ]
                                   [ Für Nachricht wählen ]

Nachricht: [Content Studio · Canva: Design-Team ×]
```

Derselbe Picker im Agent-Editor trägt die Überschrift **„Dauerhaft für diesen Agenten“** und speichert eine versionierte Konfiguration. Die persönliche Wahl für einen gemeinsamen Agenten heißt **„Meine Verbindung“** und verändert ausschließlich die eigene erlaubte Präferenz. Diese drei Wirkungen werden vor dem Bestätigen benannt; dieselbe Suche bedeutet keine identische Schreibaktion.

Aus der Chat-Auswahl erzeugt der Server beispielsweise folgenden kompakten Kontext. Die Platzhalter stehen für aktuell geprüfte Werte und sind keine vom Browser erzeugten Referenzen:

```text
Plugin: Content Studio, genaue veröffentlichte Ressource und Version.
Anleitung: kurze relevante Paketanleitung mit Herkunft.
Skills: Titel, Zweck und genaue autorisierte SKILL.md-Lesepfade.
Vor Anwendung den passenden Skill über den registrierten Leseweg öffnen.
Canva-Anforderung: ausdrücklich gebunden an „Design-Team“.
Toolsuche: integrations search(target=tools, providerRef=<aktuell>, query=<Aufgabe>).
Schema: integrations describe(toolRef=<Suchergebnis>).
Ausführung: integrations call(toolRef=<dasselbe>, schemaRef=<aktuell>, arguments=…).
Nur tatsächlich registrierte und erlaubte Operationen nennen.
```

Damit erhält der Agent sofort die relevante Paketorientierung und den gezielten Einstieg. Vollständige Skilltexte und Toolschemas werden erst bei Bedarf geladen. Der Kontextblock wird aus derselben geprüften Auswahl wie Readroots und Toolgrenzen erstellt; er ersetzt deren laufende Rechteprüfung nicht.

### Konkrete Anschlusslücken aus der aktuellen Quellprüfung

| Quellbefund | Verbindliche Anpassung |
| --- | --- |
| `CreateAgentDialog` sammelt weiterhin `capabilities`, `relevantSkills` und `relevantConnections`; `AgentSettingsPanel` überträgt diese Felder einzeln. | Dialog und tatsächliche POST-Eltern auf vollständiges `extensions` umstellen; keine neue Auswahl im Weiterreichen verlieren. Templates liefern Vorschläge, keine Autorität durch Skillnamen. |
| `agent-workflow-client.ts` akzeptiert nur V1/Vererbung; `ChatAgentSelector` zeigt Choice nur für V1 und Profil-Edit nur ohne Workflow. | V2-Descriptor samt Standalone-Wahl vollständig anzeigen und speichern; Use-only persönliche Wahl von zentralem Edit trennen. Ein gelockerter Versionsvergleich allein erfüllt keinen Roundtrip. |
| Persönliche Paketziele brauchen im bestehenden öffentlichen Workflow-Dialekt eine servergelieferte `providerRef`. | Der Optionsdienst liefert inzwischen `packageBinding` und `noAuthPackageBinding`; tatsächlicher Chooser→Create/Choice→Inspect ist lokal geprüft. Der UI-Anschluss übernimmt diese öffentliche Syntax und speichert kurzlebige Receipts nicht dauerhaft. |
| `PluginIntegrationDetail.connectPersonal` kann vor OAuth das Workspace-Profil ändern und führt zum Plugin-Katalog zurück. | Gemeinsame Präsentation wiederverwenden, Auswahl und Einrichtung jedoch getrennt anbinden. Normale Auswahl nutzt ausdrücklich das gewählte Profil; neue Einrichtung braucht einen passenden Entwurfs-/Rückkehrkontext. |
| Die aktuelle Preview rendert ohne tatsächliches Toolmanifest, ohne echte Provider-Routen und mit leerem zusätzlichem Skillindex; sie meldet selbst `runtimeReadiness: not_checked`. | Vorschau als vorläufig kennzeichnen. Gemeinsame Registrierung und Darstellung einschließlich geerbter Tools, Core-/Pflichtskills und echter Provider-Referenzen für den finalen Save verwenden. Der Runtime-Guard bleibt für spätere Nutzer-/Workspace-/Auftragsänderungen bestehen. |

Der gemeinsame Picker erhält eine austauschbare Datenprojektion. Agent-Auswahl benutzt die tatsächliche Agent-/Prospective-Optionsprojektion; Chat bekommt eine eigene geprüfte Turn-Projektion auf demselben Katalog. Ein fingierter Main-Agent als Zielkontext ist kein zulässiger Ersatz. URL-Navigation und Verwaltungsaktionen der Plugin-Seite bleiben außerhalb der gemeinsam verwendeten Trefferpräsentation.

## Entscheidungsvorschlag

`/` öffnet einen gemeinsamen Erweiterungs-Picker für **Plugins, Skills, Composio-Integrationen und direkte MCP-Server**. Ohne Suchtext stehen die zuletzt im aktuellen Workspace im Chat verwendeten Einträge zuerst. Tippen durchsucht alle vier Typen; optionale Typfilter schränken dieselbe Suche ein. Die Auswahl wird als konkrete Referenz an die Nachricht gebunden. Der Server prüft sie beim Senden und vor der späteren Ausführung erneut und gibt dem Agenten einen kurzen, präzisen Nutzungskontext.

**Dieselbe Auswahl und derselbe Kontextresolver sollen auch die Erstellung und Bearbeitung von Agenten tragen.** Ein Spezialagent erhält seine fest konfigurierten Erweiterungen bei jedem Start im Systemkontext. Im allgemeinen Chat entstehen zusätzliche Paket-/Verbindungshinweise durch ausdrücklich referenzierte Erweiterungen. Ohne Referenz kann der Agent weiterhin passende Skills suchen und deren Anleitung bei Bedarf laden.

Der vorhandene [Pluginseiten-Katalog](plugin-page-integration-catalog-plan.md) liefert die gemeinsame Suchgrundlage. Die jeweilige Projektion ergänzt die tatsächliche Nutzbarkeit für Chat beziehungsweise Agent-Konfiguration. Auswahl, Paketinstallation, Account-Autorisierung und Agent-Freigabe bleiben separate Entscheidungen. Für diesen Plan wird der globale Tool-Router nicht vorausgesetzt.

Der [klickbare Wireframe](wireframes/chat-extension-picker.html) zeigt Recents, eine gemischte Canva-Suche, optionale Typfilter, Accountauswahl und Nachrichtenchips. Er ist eine eigenständige HTML-Demo mit synthetischen Beispielen und ohne API-Aufrufe. Seine Initialen vertreten die späteren verfügbaren Logos. Eine Demo-Nachricht aktualisiert nur die lokale Reihenfolge; sie sendet keinen echten Chat-Auftrag.

## Historischer Ausgangsbefund vom 13. Oktober

Die folgende Tabelle dokumentiert den Ausgangsbefund vor dem weiteren Runtime-Anschluss. Für den aktuellen Teilstand gelten die Übersicht oben und das Umsetzungsjournal; insbesondere sind die dort genannten Codec-/Reader-Grundlagen inzwischen erweitert.

| Bereich | Aktueller Stand | Erforderliche Ergänzung |
| --- | --- | --- |
| `/`-Popup | Plugins und Skills; getrennte alte Listen, namensbasierte Treffer | Alle vier Typen aus demselben Katalog; genaue Referenzen statt Zusammenlegung gleicher Namen |
| Auswahl im Composer | Schreibt nur `/name` in den Text | Sichtbarer entfernbarer Kontextchip mit strukturierter Ressourcen-/Verbindungsauswahl |
| Reihenfolge | Kurze Namen/alphabetisch bei leerer Suche | Letzte bestätigte Chat-Verwendung; bei Suchtext Relevanz zuerst |
| Transport | Bekannte Felder werden ausdrücklich normalisiert | Auswahl in Send-Snapshot, WebSocket/HTTP, Queue, Retry und Entwürfen erhalten |
| Plugin-Kontext | Beschreibung, Default-Prompts, enthaltene Skills und deklarierte Connector-Hinweise für `/name` | Exakte veröffentlichte Quelle, relevante Kinder, tatsächliche Verbindung und konkreter Tool-Suchweg |
| Skill-Kontext | Kurze Beschreibung plus autorisierter `SKILL.md`-Lesepfad | Ausgewählten Skill und Plugin-Herkunft eindeutig erhalten |
| Runtime | Frische Ressourcen-/Verbindungsrechte, versionierte Bindungen und gemeinsamer Gateway vorhanden | Auswahl daran anschließen, ohne Rechte zu erweitern |
| Gemeinsame Auswahlverträge | Strikte öffentliche Referenzen, private Bindungsschemas und Versionshelper als vorbereitende Grundlage vorhanden | In tatsächliche Aufnahme, Persistenz, Runtime, Tool- und UI-Verträge integrieren; Schema allein erteilt keine Nutzung |
| Agent-Systemprompt | Allgemeiner Agent bekommt alle effektiven Skill-Namen/Beschreibungen/Pfade; beim Spezialagenten bedeutet `relevantSkills: null` ebenfalls alle Skills | Explizite feste Auswahl für Spezialagenten; allgemeine natürliche Skill-Suche statt automatischem vollständigem Skillkatalog im Prompt |
| Agent erstellen | UI und `create_agent` teilen `createManagedAgent`; Eingabe enthält Plugin-/Skill-Auswahl und namensbasierte Verbindungsanforderungen | Vollständiger gemeinsamer Vertrag mit veröffentlichten Paketständen und exakten eigenständigen MCP-/Composio-Verbindungen bereits beim Erstellen |
| Agent bearbeiten | UI und `update_agent_configuration` teilen atomare Konfiguration mit Revisionsprüfung; Workflow V1 bindet Pakete/Kinder und deklarierte Verbindungen exakt | V1 erhalten; Standalone-Verbindungen ergänzen und denselben vollständigen Vertrag bei Create/Update verwenden |
| Native Mobile | Eigener Composer und Transport | Eigene Folgestufe; responsiver Web-Chat übernimmt die gemeinsame Web-Komponente |

Wichtige Quellstellen:

- [Composer-Suche und Auswahl](../../../../app/components/canvas-agent-chat/useComposerReferences.ts): getrennte `/api/plugins`-/`/api/skills`-Abfragen, Namens-Deduplizierung und Text-Ersetzung.
- [Picker-Vertrag](../../../../app/components/canvas-agent-chat/ComposerReferencePicker.tsx) und [Slash-Erkennung](../../../../app/lib/chat/composer-references.ts): Erweiterung der Typunion; bestehende Grenzen für Pfade, URLs und Dateireferenzen erhalten.
- [ChatRequestContext](../../../../app/lib/chat/types.ts), [Server-Normalisierung](../../../../app/lib/pi/runtime-service.ts), [Send-Transaktionen](../../../../app/components/canvas-agent-chat/useChatControlActions.ts) und [Entwürfe](../../../../app/lib/chat/draft-storage.ts): Auswahl Ende zu Ende transportieren, nicht nur dem Popup hinzufügen.
- [Plugin-Kontext](../../../../app/lib/plugins/plugin-reference-context.ts), [Turn-Kontext](../../../../app/lib/pi/live-runtime.ts) und [Skill-Kontext](../../../../app/lib/skills/skill-context.ts): bestehende progressive Kontextaufbereitung verwenden.
- [Paket-Runtime-Bindungen](../../../../app/lib/capabilities/packages/runtime-bindings.ts), [Workflow-Bindungen](../../../../app/lib/agents/workflow-runtime.ts), [effektives Tool-Manifest](../../../../app/lib/pi/effective-tool-manifest.ts) und [Gateway-Vertrag](../../../../app/lib/integration-tools/contracts.ts): bestehende Autorität und tatsächlich registrierte Tools sind maßgeblich.
- [Agent-Erstellung und gemeinsame Dienste](../../../../app/lib/agents/management-actions.ts), [Agent-Tools](../../../../app/lib/pi/agent-management-tools.ts), [Agent-API](../../../../app/api/agents/route.ts), [atomare Workflow-Konfiguration](../../../../app/lib/agents/workflow-configuration.ts) und [Workflow-Vertrag](../../../../app/lib/agents/workflow-contracts.ts): Create ist noch nicht so präzise wie die vorhandene V1-Konfiguration.
- [Systemprompt](../../../../app/lib/agents/system-prompt.ts), [Skill-Auswahl](../../../../app/lib/skills/agent-skill-selection.ts), [effektive Runtime-Konfiguration](../../../../app/lib/agents/effective-runtime-config.ts) und [Runtime-Policy](../../../../app/lib/integration-tools/runtime-policy.ts): Skill-/Tool-Vererbung und tatsächliche Ausführungsgrenzen unterscheiden.
- [Ressourcen-Discovery](../../../../app/lib/pi/capability-resource-tools.ts): `inspect_canvas_resource` kann installierte Plugins/Skills bereits suchen; seine Benutzer-Leserechte entsprechen noch nicht der effektiven Agent-Nutzbarkeit.

## Gemeinsamer Vertrag statt mehrerer Kontextsysteme

### Eine Identität, zwei Lebensdauern

Ein versionierter, diskriminierter **`ExtensionSelection`-Vertrag** bildet Plugin, Skill, Composio und MCP ab. Er enthält genaue öffentliche Referenzen, Paket-/Kindherkunft und gehaltene Version beziehungsweise genaue Verbindungsauswahl. Die unten beschriebene `ChatExtensionSelection` ist seine Nachrichtenhülle, kein zweiter Ressourcenvertrag.

| Herkunft | Speicherung | Wirksamkeit |
| --- | --- | --- |
| `agent_configuration` | Dauerhaft in der versionierten Agent-Konfiguration | Bei jedem Start und bei sicherer Konfigurationsaktualisierung des Spezialagenten |
| `turn_reference` | Im unveränderlichen Nachrichten-/Queue-Snapshot und zugehörigen Entwurf | Für genau den zugehörigen Turn; keine dauerhafte Agent-Zuweisung |
| Skill durch Runtime-Suche gefunden | Geprüftes Suchergebnis und autorisiertes Laden im aktuellen Lauf | Aufgabenbezogene Nutzung innerhalb bereits erlaubter Ressourcen; kein neues Konto oder Paket installieren |

Die Agent-Persistenz erweitert den bestehenden Capability-/Workflow-Vertrag und dessen Bindungen. Es entsteht kein zusätzlicher unabhängiger Skill-/Tool-Speicher in Promptdateien. Private Paket-/Standalone-Formate, vollständiger öffentlicher Schreibvertrag und gemeinsame Auswahloptionen sind als Backend-Grundlage vorhanden; vollständige Vorschau, UI und unten genannte Restprüfungen fehlen noch. Vorhandene Workflow-V1-Pins und persönliche Auswahlregeln bleiben über einen geprüften Adapter erhalten. Eine unabhängige Verbindung wird nicht als erfundene Plugin-Deklaration gespeichert.

Die Versionsleser unterscheiden inzwischen Version 1, ausdrückliche Version 2 und SQL-NULL-Vererbung. Vor dem ersten produktiven Schreiben einer neuen festen Gesamtkonfiguration müssen auch Runtime, Readroots, Prompt und Tool-Registrierung gemeinsam vollständig geprüft sein. Unbekannte oder widersprüchliche Versionen dürfen nicht auf Vererbung zurückfallen.

### Ein serverseitiger Resolver

Die gemeinsame Aufbereitung ist mit `resolveEffectiveExtensionContext` als Grundlage angelegt. Sie nutzt die vorhandenen Paket-, Workflow-, Verbindungs- und Runtime-Policy-Dienste und liefert einen abgeleiteten, privaten Selektionsstand mit Fingerprint:

- genaue Ressourcen, Paketversionen und Kindidentitäten;
- ausgewählte konkrete Verbindungen beziehungsweise erlaubte persönliche Auswahl;
- autorisierte Skill-Lesepfade, Herkunft und kurze Anleitung;
- Einrichtungs-/Nutzbarkeitsstatus und zulässige Tool-Grenzen;
- Suchrezepte ausschließlich für tatsächlich registrierte Tools;
- kompakte Ausgabe für System-/Turn-Kontext sowie eine sichere Vorschau für den Nutzer.

Systemprompt, Skill-Readroots und Toolhinweise verwenden denselben abgeleiteten Selektionsstand. Die tatsächlichen Tool-Grenzen ergeben sich weiterhin aus der Schnittmenge von Ressourcenrechten, Agent-Konfiguration, nativen `enabledTools`, Delegation und Laufmodus. Der Fingerprint hilft, widersprüchliche Stände zu erkennen; er ersetzt **nicht** die frischen Rechte-/Bindungsprüfungen beim Lesen, Beschreiben und Ausführen.

Promptloader, Readroots und Gateway-Policy sind an dieselbe ausgegebene Auswahl angeschlossen und als Runtime-Grundlage lokal geprüft. Die noch fehlenden Auswahloptionen, UI-Vorprüfung und Nachrichtenaufnahme müssen genau diese Grundlage verwenden. Ein langfristig gecachter Promptsnapshot darf niemals eine spätere Ausführung autorisieren.

## Kontextregeln für allgemeine und spezialisierte Agenten

### Spezialagent: feste Zuweisung immer vorhanden

Neue Spezialagenten verwenden eine ausdrücklich feste Erweiterungsauswahl. Ihr Systemkontext enthält bei jedem Start die konfigurierten Plugins, Skills und Verbindungen: Zweck, genaue Herkunft, ausgewählte Plugin-Kinder, Skill-Lesepfade und den konkreten Tool-Suchweg. Plugin-Anforderungen und tatsächlich gebundene Accounts werden getrennt benannt. Ein MCP-Ausfall entfernt keine weiterhin zulässige lokale Skill-Anleitung.

„Immer vorhanden“ bedeutet einen kompakten Index und die passende geprüfte Paketanleitung. Vollständige Skilltexte und Toolschemas werden bei Bedarf geladen. Ein Plugin kann als Paket ausgewählt werden; seine zugelassenen Bestandteile werden daraus nachvollziehbar abgeleitet. Ein Kind kann außerdem gezielt ausgewählt oder ausgeschlossen werden, soweit Pflichtbestandteile und Paketregeln das erlauben. Eine zusätzliche Standalone-Auswahl desselben Kindes wird über die genaue Herkunft dedupliziert.

Diese Teilmengenauswahl benötigt eine ausdrückliche Normalisierung: Workflow V1 unterscheidet heute ganzes Plugin und ausgewählte Skills; beim zweiten Modus werden Plugin-Root-Deklarationen nicht einfach mitgeführt. Der neue Vertrag muss Elternanforderungen erhalten, während optionale Kinder abgewählt werden. Die UI darf keine Teilmengenauswahl anbieten, die erforderliche Connector-/Skill-Deklarationen des Elternpakets still entfernt.

Ein erlaubter Sonderfall ist ein Plugin, das über `skills: "."` eine `SKILL.md` an der Paketwurzel bereitstellt. Die ursprüngliche Runtime-Lücke ist in der Grundlagenarbeit korrigiert und gezielt geprüft; die vollständige Chat-/Modellabnahme bleibt offen. Welche Kinder existieren, bestimmt das veröffentlichte Manifest samt Loader, nicht eine erfundene UI-Verzeichnisliste.

Ein Slash-Chip beim Spezialagenten fokussiert einen bereits zulässigen Bestandteil. Er erweitert dessen feste Auswahl nicht. Eine andere Verbindung kann nur gewählt werden, wenn die gespeicherte Konfiguration genau diese Wahl erlaubt. Für nicht erlaubte Erweiterungen zeigt die UI den berechtigten Weg zur Agent-Konfiguration oder zum allgemeinen Chat.

Beispiel: Ein gespeicherter Verbindungsslot erlaubt ausdrücklich A und B und verwendet normalerweise A. Ein Chat-Chip darf B für diesen Turn wählen; die gespeicherte Auswahl und persönliche Präferenz bleiben A. Erlaubt der Slot ausschließlich A, ist B im Chat nicht auswählbar. Die tatsächliche Verbindung samt Revision und privater Identität wird geprüft; eine logische Slot-ID allein beweist keine unveränderte Bindung.

Bei Organisationsagenten kann eine Verbindung fest gemeinsam bereitgestellt oder als ausdrücklich erlaubte persönliche Auswahl konfiguriert werden. Im zweiten Fall löst jeder ausführende Nutzer seine eigene zulässige Wahl auf. Das private Konto des Erstellers wird nicht stillschweigend für alle Mitglieder hinterlegt. Fehlende notwendige Einrichtung wird vor Nutzung angezeigt; optional fehlende Bestandteile blockieren keine unabhängigen erlaubten Fähigkeiten.

### Allgemeiner Chat: gezielt referenzieren oder Skills suchen

Der allgemeine Systemprompt enthält die gemeinsame Discovery-Anleitung sowie unverzichtbare Core-/Pflichthinweise. Er erhält künftig nicht automatisch den vollständigen Katalog sämtlicher aktivierter Skills. Detaillierter Plugin-/MCP-/Composio-Auswahlkontext entsteht durch die expliziten Referenzen des aktuellen Turns.

Ohne Slash darf der Agent aufgrund der Aufgabe nach einem passenden **bereits zulässigen Skill** suchen, dessen genaue Quelle auflösen und `SKILL.md` vor Nutzung lesen. Das erzeugt keinen dauerhaften Agent-Bindingeintrag und keine automatische App-/Accountauswahl. Ein gefundenes Store-Angebot oder eine ungebundene Integration ist ein Einrichtungsvorschlag, keine Ausführungsfreigabe.

Es gibt bereits Management-Read-Discovery: `inspect_canvas_resource` sucht lesbare installierte Ressourcen; `list_canvas_package_store` umfasst zusätzlich Angebote. Diese menschlichen Leserechte sind allein keine Agent-Nutzung. Die neue read-only Runtime-Operation heißt **`search_canvas_extensions`** und liegt im vorhandenen `canvas_extensions`-Gateway; ihr Metadatenpfad ist als Grundlage implementiert. `integrations` bleibt für konkrete MCP-/Composio-Provider und deren Tools zuständig. Ein gemeinsamer UI-Katalog ersetzt daher weder aktuelle Tooldiscovery noch Berechtigungsprüfung.

Diese Operation durchsucht Name, kurze Beschreibung und Paket-/Kindherkunft, einschließlich geprüfter Manifestbeschreibungen. Sie gibt genaue zulässige Referenzen, kurze Beschreibungen und Skill-Orte zurück. Erst die aktuelle Auflösung mit einem tatsächlich verfügbaren Lese-Tool erzeugt das nutzbare Leserezept. Beim Spezialagenten bleibt die Suche auf dessen effektive Auswahl begrenzt. Im Planungsmodus ist die sichere Metadatensuche ausdrücklich erlaubt; externe Accountprobes und Ausführung bleiben ausgeschlossen. Suche führt keine Provider-Gesundheitsprüfung als Voraussetzung für lokal verfügbare Skills durch.

Das Systemrezept für natürliche Skill-Suche wird ebenso konkret wie der Integrationsweg: zuerst im tatsächlichen Toolmanifest feststellen, ob Discovery direkt oder über `canvas_extensions` registriert ist; darüber mit dem Aufgabenbegriff `search_canvas_extensions` anfordern; anschließend die genaue zurückgegebene Quelle über den tatsächlich verfügbaren autorisierten Read-Weg öffnen. Eine Unteroperation des progressiven Gateways wird nicht als separat aufrufbares Tool dargestellt. Fehlt ein erlaubter Such- oder Leseweg, benennt die Anleitung diese Grenze, statt einen Pfad zu erfinden.

### Bestehende Agenten ausdrücklich migrieren

`relevantSkills: null` bedeutet heute Vererbung aller verfügbaren Skills; `enabledTools: null` kann native Tools erben. Diese Bedeutungen werden nicht stillschweigend in eine leere feste Auswahl geändert. Die Migration zeigt den bisherigen Modus, leitet eindeutige alte Ressourcen ab und verlangt für mehrdeutige Skillnamen beziehungsweise `connection:<name>` eine konkrete Wahl. Gehaltene Workflow-V1-Versionen werden übernommen, ohne auf einen neuen veröffentlichten Stand zu wechseln.

Die neue Oberfläche zeigt deshalb ausdrücklich **feste Auswahl** beziehungsweise **bestehende Vererbung**. Neue Spezialagenten beginnen mit fester Auswahl plus verpflichtender Basis. Bestehende Vererbung bleibt bis zur bewussten Umstellung erhalten und wird nicht als bereits präzise zugeordnete Verbindung dargestellt.

## Agent-Erstellung und Bearbeitung mit Progressive Disclosure

Der Bereich heißt **„Erweiterungen und Werkzeuge“**. Erstellung und spätere Bearbeitung bieten denselben gemeinsamen Picker. Kein separates Skill-, MCP- und Composio-Suchfeld:

1. **Erste Ebene:** eine Suche, optionale Typfilter und die ausgewählten Pakete/Einzelbestandteile als kurze Liste mit Logo oder Initialen. Bei leerer Suche Vorschläge aus **„Zuletzt im Chat verwendet“**, frisch auf den Zielkontext des Agenten gefiltert; bei Suche Relevanz zuerst. Pflichtbestandteile sind sichtbar und erklärt.
2. **Plugin bei Bedarf öffnen:** enthaltene Skills und deklarierte Integrationen, Auswahlstatus, Paketversion und aktuelle Einrichtung. Nutzer können das passende Paket wählen und nur bei Bedarf einzelne Bestandteile ansehen.
3. **Verbindung bei Bedarf wählen:** konkrete gemeinsame Instanz oder erlaubte persönliche Auswahl; Bereich und sichtbarer Accountname. Mehrere Accounts brauchen eine ausdrückliche Wahl. Unverbundene Angebote führen zur bestehenden Einrichtung und erhalten den Agent-Entwurf.
4. **Werkzeuggrenzen aufklappen:** verfügbare native Werkzeuge und Grenzen der ausgewählten externen Verbindungen. Die Oberfläche zeigt, welche Auswahl tatsächlich wirksam ist; das Abwählen eines erforderlichen Lese-/Gateway-Tools erzeugt einen erklärten Konflikt.
5. **Vor Speichern:** kompakte Zusammenfassung „Dauerhaft für diesen Agenten“ mit eingerichteten und noch fehlenden Bestandteilen. Eine aufklappbare Vorschau zeigt den serverseitig abgeleiteten Kontext und Suchweg, keine Secrets und keinen zweiten bearbeitbaren Autoritätstext.

Skizze; Account- und Werkzeugdetails sind zunächst geschlossen:

```text
Agent erstellen · Marketing

Erweiterungen und Werkzeuge
[ Plugins, Skills, Integrationen und MCP suchen … ]
[ Alle ] [ Filter ▾ ]

Dauerhaft für diesen Agenten
[Logo] Content Studio      Plugin       3 Skills · 2 Verbindungen  ▸
[Logo] LinkedIn            Integration  Marketing-Team             ▸
[KB]   Wissensbasis        MCP          Organisation                ▸

[ + Erweiterung auswählen ]
[ Werkzeuggrenzen ▸ ]   [ Kontextvorschau ▸ ]

Einrichtung: 1 benötigte Verbindung fehlt
[ Als Entwurf speichern ]              [ Agent erstellen ]
```

Empfehlung für den ersten Ausbau: **ein erhaltener Formularentwurf**, solange eine notwendige feste Bindung, eine vollständige Wahlregel oder die Vorprüfung fehlt. Dafür wird kein provisorischer ausführbarer Agent angelegt. Davon zu unterscheiden ist eine gültige gemeinsame Agent-Konfiguration mit ausdrücklich erlaubter persönlicher Verbindung je Nutzer: Sie kann gespeichert werden, ohne das Konto des Erstellers für alle zu hinterlegen. Der jeweilige Nutzer richtet seine notwendige Wahl unter „Meine Verbindung“ ein. Bis alle Pflichtwahlen vorliegen, sperrt die heutige Runtime die externen Workflow-Aktionen insgesamt; zulässiger lokaler Skill-Kontext bleibt verfügbar. Eine feinere Freigabe einzelner unabhängiger externer Fähigkeiten wäre eine gesonderte Änderung. Das ist eine vollständige Konfiguration mit offener persönlicher Einrichtung, kein gespeicherter Agent-Draft.

Der bestehende Agentvertrag hat keinen gesonderten gespeicherten Draft-Status; ein solcher Status müsste mit Startverhalten und Migration ausdrücklich entwickelt werden. „Als Entwurf speichern“ in der Skizze meint deshalb den Formularentwurf im passenden Nutzer-/Workspace-Kontext. Nach der Einrichtung kehrt man zu genau diesem Entwurf zurück.

Dieser Formularentwurf soll OAuth-Rückkehr und Reload überleben. Seine Speicherung wird an authentifizierten Nutzer, Workspace, Zielbereich und gegebenenfalls die tatsächliche Agent-ID samt Ausgangsrevisionen gebunden. Nach Save oder ausdrücklichem Verwerfen wird er gelöscht; sieben Tage sind der vorgeschlagene, noch abzustimmende Höchstwert. Secrets und kurzlebige Accountbelege werden nicht als Entwurfsdaten gespeichert. Nach Wiederaufnahme werden Quelle, Revisionen und Verbindungswahl erneut geprüft. Ohne tatsächlich dauerhafte Speicherung darf die Oberfläche nur „Entwurf behalten“ anbieten und keine Reload-Sicherheit versprechen.

Betroffene bestehende Komponenten: [CreateAgentDialog](../../../../app/components/settings/CreateAgentDialog.tsx), [EditAgentProfileDialog](../../../../app/components/agents/EditAgentProfileDialog.tsx), [AgentSettingsPanel](../../../../app/components/settings/AgentSettingsPanel.tsx), [ChatAgentSelector](../../../../app/components/canvas-agent-chat/ChatAgentSelector.tsx), [PackageAgentSetup](../../../../app/components/plugins/PackageAgentSetup.tsx), [AgentWorkflowManagementDialog](../../../../app/components/agents/AgentWorkflowManagementDialog.tsx), [WorkflowPackageSelectionSection](../../../../app/components/agents/WorkflowPackageSelectionSection.tsx), [WorkflowCapabilityBindingSection](../../../../app/components/agents/WorkflowCapabilityBindingSection.tsx) und die vorhandenen Account-Choice-Picker. Gemeinsame Picker-/Auflösungslogik ersetzen doppelte Optionen; bestehende exakte Workflow-Auswahl wird integriert.

### Derselbe vollständige Vertrag im Agent-Tool

`create_agent`, `update_agent_configuration`, POST und PATCH der Agent-API verwenden bereits den vollständigen gemeinsamen Erweiterungsvertrag und serverseitige Schreibdienste. Der neue Editor muss genau daran anschließen. Die noch zu vereinheitlichende öffentliche Preview und finale Vorprüfung gehören ebenfalls in diesen gemeinsamen Weg. Create akzeptiert den vollständigen versionierten Erweiterungsstand einschließlich genauer Paketpins, Standalone-Verbindungen und erlaubter Wahl-/Toolgrenzen. Agent und Bindungen werden atomar gespeichert. Eine Fehlerantwort darf keinen unvollständigen ausführbaren Agenten zurücklassen.

Vor dem Aufruf erhält der erstellende Agent auswählbare, servergelieferte Referenzen über dieselbe Optionsprojektion wie die UI. Im aktuellen Arbeitsbaum übernimmt `list_agent_extension_options` Suche, Paketdetails, Verbindungsmetadaten und Vorschau; `list_agent_extension_accounts` prüft erst nach ausdrücklicher Profilwahl persönliche Accounts. Bestehende Workflow-Options-/Choice-Verträge bleiben für die Kompatibilität erhalten. Anzeigenamen, Toolkit-Slugs oder selbst erfundene `providerRef`-Strings reichen nicht als Accountbindung. Persönliche Account-Probes bleiben ein ausdrücklicher Schritt und im Planungsmodus ausgeschlossen.

Die ältere Workflow-Optionsprojektion verlangt einen bereits vorhandenen Agenten und dessen Revisionen. Der neue Optionsdienst im Arbeitsbaum ergänzt deshalb **vor Create** den noch nicht gespeicherten Zielkontext: Zielbereich, vom Server geprüfter Eigentümer-/Organisationskontext und Workspace. Diese Konfigurationsprojektion legt keinen provisorischen ausführbaren Agenten an. Auswahlreferenzen werden an den zulässigen Zielkontext gebunden und bei atomarem Create erneut geprüft. **Nach Create** verwendet der gleiche Optionsdienst die echte Agent-ID und aktuellen Revisionen. Persönliche Paketziele sind im Options→Writer→Inspect-Roundtrip lokal geprüft; der UI-Anschluss bleibt abzuschließen.

Create/Update geben den kanonischen gespeicherten Stand, Revisionen und Einrichtungsergebnisse zurück. Update behält die vorhandene atomare Revisionsprüfung. Tool-seitig erstellte Agenten müssen in der UI exakt gleich aussehen; UI-Änderungen müssen über Inspect/Workflow-Tools denselben Stand zurückgeben. Freigaben für den Agenten und Freigaben für seine Ressourcen werden getrennt geprüft: ein teilbarer Agent macht ein persönliches Konto nicht automatisch teilbar.

### Konkreter gemeinsamer Optionsdienst

Ein gemeinsamer serverseitiger Dienst liefert die Auswahl sowohl an die UI als auch an das Agent-Tool. Er unterscheidet einen noch nicht gespeicherten Zielkontext (`prospective`, persönlich oder Organisation) und einen bestehenden Agenten (`existing`, echte ID mit Profil-/Workflowrevision). Nutzer, Workspace und Organisation werden aus dem authentifizierten Request frisch geprüft. Eine erfundene Agent-ID oder simulierte Agent-Freigabe darf nicht als Vorprüfung dienen.

| Operation | Ergebnis | Zeitpunkt |
| --- | --- | --- |
| `search` | Gemischte Plugin-/Skill-/Integrations-/MCP-Metadaten, genaue Herkunft, Logo, zulässige Aktion, Teilabdeckung und gebundene Pagination | Während der gemeinsamen Suche |
| `package_version` | Geprüfter veröffentlichter Pin, echte Kind-Skills und Pflichtanforderungen | Wenn ein Paket gewählt oder geöffnet wird |
| `connection_choices` | Für genau diese Anforderung zulässige gemeinsame Verbindungen oder erlaubte persönliche Optionen | Bei notwendiger Zuordnung oder ausdrücklicher Accountwahl |
| `preview` | Sichere Kontextvorschau, effektive Werkzeuggrenzen sowie konkrete Konflikte bei Pflichtbindungen und Kontextbudget | Vor Speichern und bei relevanten Änderungen |

Der Dienst verwendet dieselbe Kataloggrundlage und dieselben Referenzverträge wie die Plugin-Seite, ergänzt jedoch die tatsächlichen Zielrechte. Die heutige menschliche Lesbarkeit ist keine Agent-Nutzungserlaubnis. Ein neuer Zielagent kann noch keine nur ihm erteilte Freigabe besitzen; bestehende Agenten müssen mit ihren tatsächlichen Freigaben geprüft werden. Standalone-MCP-Nutzung benötigt Use; Paket-MCP-Zuordnung behält die bestehende zusätzliche Verwaltungsprüfung.

Eine Metadatensuche legt keine Composio-Profile an und lädt nicht bei jeder Eingabe persönliche Accounts oder Toolschemas. Vorhandene Profile sind weder ein Accountnachweis noch ein Gesundheitsnachweis. Die Kontoprüfung mit echtem kurzlebigem Auswahlbeleg erfolgt erst im ausdrücklichen Chooser. Der Optionsdienst trennt diese Schritte bereits; der neue UI-Anschluss muss diese Trennung erhalten und darf die vollständige Verwaltungsprojektion nicht unverändert zur Agent-Suche erklären.

Auch eine einzige passende Verbindung wird vor dem Bestätigen mit Konto, Profil und Bereich sichtbar zusammengefasst. Sie braucht keinen leeren zusätzlichen Dropdown-Schritt; der Bestätigungsweg muss aber die konkrete Auswahl samt aktuellem Beleg prüfen. Bei mehreren Accounts öffnet sich der Chooser. Der vorhandene Einrichtungsdialog kann vor OAuth das Workspace-Standardprofil verändern; der neue Auswahl-/Rückkehrweg benötigt deshalb einen ausdrücklich gewählten Profilkontext statt einer impliziten Standardänderung.

Der katalogreine Loader wird im aktuellen Arbeitsbaum durch den gemeinsamen Optionsdienst verwendet. Beim lokalen Composio-Zugang liest er nach Prüfung des tatsächlichen Secret-Bereichs den Toolkit-Katalog ohne Profilanlage. Der Managed-Zugang benötigt nach aktuellem Adaptervertrag einen bestehenden, verifizierten Profilkontext. Fehlt dieser, zeigt die Projektion den konkreten Einrichtungsbedarf beziehungsweise eine teilweise verfügbare Quelle; sie erfindet weder Profil noch Nutzerzuordnung. Vorhandene freigegebene Verbindungen bleiben davon getrennt auswertbar. Toolkit-Logos stammen weiter aus der Composio-API, Konten und Erreichbarkeit werden daraus nicht abgeleitet. Die neue Suche führt keine eigene Secret-/Profilkonfiguration durch; vorhandene zentrale ENV-Lesedienste behalten ihre bestehende Import-/Migrationssemantik.

**Ziel der Preview:** denselben Compiler wie die Runtime und den tatsächlich wirksamen Werkzeugvertrag verwenden, ausschließlich vorhandene Lese-/Gateway-Wege empfehlen, fehlende Pflichtbindungen zeigen und das gemeinsame Budget prüfen. **Aktuelle Grenze:** der Optionsentwurf verwendet bereits die gemeinsame Darstellung, besitzt jedoch noch nicht das tatsächliche Registrierungsmanifest, alle Pflicht-/Core-Skills und genaue Laufzeit-Providerreferenzen. Seine Bytezahl ist deshalb keine vollständige bestandene Save-Prüfung. Noch nicht bestimmbarer Umfang muss als unbekannt erscheinen. Der endgültige Writer muss den echten vorbereiteten Ziel-/Quellstand innerhalb seines atomaren Schreibwegs prüfen. Die Prüfung gilt für diesen Stand; spätere Nutzerentscheidungen und auftragsabhängige Darstellung brauchen weiterhin den Runtime-Guard. Weder Vorschau noch Save-Prüfung führen eine Provider-Geschäftsaktion aus oder erteilen dauerhafte Ausführungsrechte.

Die Vorschau für einen noch nicht gespeicherten Agenten ist eine geprüfte Konfigurationsprojektion. Sie darf keine tatsächlich ausgegebene Runtime-Auswahl oder Ausführungsfreigabe vortäuschen. Gemeinsame Normalisierung und Darstellung werden wiederverwendet; gültig, unvollständig und blockiert bleiben sichtbar. Echte Paketkinder einschließlich einer `SKILL.md` an der Paketwurzel, Pflichtanforderungen der Eltern und gehaltene Paketversionen bleiben erhalten.

Die browserfähige gemeinsame Vertragsgrundlage ist mit `c3baf14c2` vorbereitet: öffentliche Workflow-Schemas liegen in `workflow-public-contracts.ts`; serverseitige Fingerprint-/Autorisierungslogik bleibt getrennt. Der UI-Anschluss verwendet diese gleichen Schemas, statt sie zu kopieren. Der vorhandene Browser-Plattform-Bundlecheck prüft die Modulgrenze; er ersetzt keine Bedienprüfung des späteren Agent-Editors.

### Restlücken vor Abschluss der Agent-Stufe

Die folgenden Befunde stammen aus der Planprüfung auf `9d64b2e59` und gehören ausdrücklich zu Schritt 3. Die nachfolgende Implementierung hat die System-/Email- und Lifecycle-Fälle inzwischen im Backend korrigiert und mit tatsächlichem PostgreSQL geprüft; [Nachweise und Grenzen](chat-agent-extension-implementation.md#fortsetzung-systemkontext-und-sicherer-agent-lebenszyklus). Der gemeinsame Optionsdienst ist ebenfalls vorhanden; UI, vollständige öffentliche Vorschau und Abschluss der lokalen finalen Kontextprüfung bleiben offen. Die Tabelle hält die Anforderungen fest und ist keine pauschale Liste weiterhin offener Backendfehler.

| Befund | Geplante Anpassung und Abnahme |
| --- | --- |
| Der bisherige [Workflow-Client](../../../../app/components/agents/agent-workflow-client.ts) akzeptiert nur V1/Vererbung und kennt keine vollständige Standalone-Wahl. | UI auf dem vollständigen kanonischen Erweiterungsdescriptor initialisieren. V1 und V2 roundtrippen; gespeicherte unbekannte oder nicht mehr verfügbare Einträge nicht still löschen. Auch persönliche Paketoptionen müssen V2 unterstützen. |
| Fehlende Lese-/Gateway-Tools und ein zu großer Pflichtkontext werden bisher erst in der Runtime vollständig sichtbar. | Gemeinsame Vorprüfung vor Save; konkrete Konflikte statt eines vermeintlich fertigen Agenten. Lokale erlaubte Skills bleiben bei einem optionalen Providerausfall verfügbar. |
| Neue V2-Scopeprüfungen behandeln Organisationen, aber System-/Email-Agenten noch nicht durchgehend als gesonderten gemeinsamen Kontext. | Für solche Agenten keine fest eingebetteten privaten Pakete oder Erstellerkonten. Gemeinsame Bindungen benötigen einen tatsächlich geprüften System-/Organisationskontext; erlaubte persönliche Wahl wird je ausführendem Nutzer aufgelöst. Bestehende V1-Konfigurationen nicht still verändern. |
| Email-Konfiguration verlangt Adminrechte; der allgemeine Inspect-Weg kann diese Verwaltungsprüfung derzeit auch für bloße Nutzer erreichen. | Sichere lesende Summary für zulässige Nutzer erhalten; editierbare Konfiguration ausschließlich mit effektiven Konfigurationsrechten liefern. Edit ohne Use und Use ohne Manage getrennt prüfen. |
| Nach Rollback folgt Dateibereinigung außerhalb des SQL-Erstellungsvorgangs. Eine zweite erfolgreiche Erstellung mit derselben ID könnte inzwischen dieselbe Ablage verwenden. | Dateibereinigung an echte Erstellungszuständigkeit oder einen bis zur Bereinigung gehaltenen Lifecycle-Lock binden. Einen tatsächlichen Parallelfall prüfen: fehlgeschlagene erste Erstellung darf die Dateien der erfolgreichen zweiten nicht löschen. |

Logos bleiben an die genaue Quelle gebunden. Ein alter gehaltener Paketpin darf kein Logo einer neu veröffentlichten Version übernehmen, wenn für ihn kein Bildnachweis vorhanden ist. Dann gelten Initialen. Für Composio bleibt das Toolkit-Logo aus der API maßgeblich, für eigene MCPs die geprüfte Domain-Icon-Ermittlung; Workspace-/Quellenwechsel verwerfen den alten Bildzustand.

## Bedienablauf mit Progressive Disclosure

### 1. Öffnen und suchen

Beim Eingeben von `/` am gültigen Wortanfang erscheint das Popup direkt über dem Composer. Ein sichtbarer Kontextknopf öffnet denselben Picker, damit der Einstieg auch ohne Tastatur funktioniert. `@` behält die Dateisuche.

Der Picker hält den Öffnungsmodus `slash | manual` und gegebenenfalls die genaue Text-Ersetzungsrange. Nur bei Slash-Auswahl wird dieses Suchfragment entfernt. Manuelles Öffnen benötigt keinen Slash und erhält vorhandenen Nachrichtentext und Caret. Die gemeinsame Suchfunktion bekommt in beiden Modi den Suchbegriff; sie hängt nicht von einem aktiven Slash-Regex-Treffer ab.

Während des geöffneten Slash-Pickers sind auch mehrteilige Namen wie `/google sheets` suchbar. Die Erweiterung der aktiven Query-Range muss zugleich URL-/Pfadgrenzen und bereits abgeschlossene Slash-Referenzen erhalten. Ein Leerzeichen darf nicht allein wegen der bisherigen Skillnamen-Grammatik die neue Suche schließen. Eine nicht bestätigte Eingabe bleibt normaler Nachrichtentext.

- Leere Eingabe: sechs bis acht **zuletzt im Chat verwendete** Einträge, absteigend nach letzter Verwendung. Bei leerer Historie aktuelle nutzbare Vorschläge; Plugins bevorzugt nur bei gleich geeigneten Vorschlägen.
- Eingabe wie `/canva`: gemeinsame Trefferliste über alle vier Typen. Exakter Name vor Präfix, Namensbestandteil vor Beschreibung; Recency entscheidet nur bei gleicher Relevanz. Ein häufiger, aber unpassender Treffer verdrängt keinen exakten Suchtreffer.
- Optional **Alle / Plugins / Skills / Integrationen / MCP**. Typwechsel erhält den Suchtext. Es gibt keine getrennten Such-Unterseiten.
- Zeile: Logo oder Initialen, Name, Typ, kurzer Nutzen und relevanter Bereich/Zustand. Bei einem Plugin-Skill steht die Plugin-Herkunft dabei. Gleiche Namen bleiben getrennte exakte Treffer.
- Die erste Ansicht zeigt keine Tool-Schemas, Secrets oder dauerhaften technischen Filter. Weitere Treffer werden innerhalb derselben Suche geladen; eine teilweise ausgefallene Quelle wird kompakt mit Retry angezeigt.

Picker, Agent-Auswahl und Chips verwenden dieselben vorhandenen Logoquellen: Composio-Logos aus der Toolkit-API; bei direkten MCPs die geprüfte Logo-/Domain-Ermittlung einschließlich Root-Domain-Fallback und bereichsgebundenem Cache. Verfügbare Paket-/Skill-Icons bleiben erhalten. Nur fehlende oder nicht ladbare Bilder fallen auf Namensinitialen zurück. Externe Bild-Discovery erfolgt bei sichtbarem Bedarf, nicht als Voraussetzung für die gemeinsame Textsuche.

Dafür wird `PluginExtensionAvatar` mit dem bestehenden `icon: { url, sourceKey }` wiederverwendet. Bildzustand und Cache gehören zur genauen Ressourcen-/Verbindungsauswahl, Bildquelle und zum Workspace; gleichnamige Einträge oder ein Accountwechsel übernehmen kein fremdes Bild. Ladefehler führen zu Initialen und blockieren weder Suche noch Auswahl.

Eingaben werden kurz entprellt; Anfragegeneration und Abort verwerfen alte Antworten bei Such-, Agent-, Workspace-, Profil- oder Benutzerwechsel. Ein Wechsel darf weder fremde alte Treffer noch einen alten ausgewählten Kontext nachliefern.

Startwerte: etwa 200–250 ms Entprellung und acht sichtbare Vorschläge; mehr Treffer per gebundenem Cursor. Das leere Popup löst bekannte Recent-Identitäten gezielt auf und benutzt vorhandene sichere App-Metadaten, statt zuerst den gesamten externen Katalog oder dessen Tools abzurufen. Quellen haben getrennte Zeitbudgets. Nach deren Ablauf liefert die Suche geprüfte Treffer mit ausdrücklich teilweiser Abdeckung und gegebenenfalls Fortsetzung; sie wartet nicht unbegrenzt auf einen vollständigen externen Katalog. Vor Auswahl und Send bleibt die aktuelle Autoritätsprüfung maßgeblich.

### 2. Eindeutig auswählen

| Gewählter Typ | Direkte Auswahl | Zusätzlicher Schritt nur bei Bedarf |
| --- | --- | --- |
| Plugin | Exakte installierte Paketressource und veröffentlichter Stand | Fehlende Einrichtung öffnen; relevante Skill-/Connector-Details aufklappen |
| Skill | Exakte eigenständige Ressource oder genaues Kind des Plugins | Herkunft/Anleitung ansehen |
| Composio-Integration | Tatsächlich zulässige Verbindung; no-auth ausdrücklich als solche | Bei mehreren Accounts eine zweite Ebene mit Bereich und sichtbarem Verbindungsnamen |
| Direkter MCP | Exakte persönliche oder freigegebene Verbindung | Bei mehreren gleichnamigen Instanzen die konkrete Instanz wählen |

Ein Integrationsangebot mit mehreren Accounts darf nicht automatisch den ersten Account auswählen. Bei genau einer nutzbaren Instanz kann die Auswahl unmittelbar erfolgen; ihr sichtbarer Account-/Bereichsname steht im Chip. Freigegebene MCP-Definitionen und unverbundene Angebote sind **einrichtbar**, nicht sofort ausführbar. Ihre Aktion führt zum genauen Eintrag im bestehenden Plugin-Katalog; nach Rückkehr wird dessen aktuelle Nutzbarkeit neu gelesen. Der Chat installiert oder autorisiert nicht beim Auswählen.

Die direkte Auswahl einer einzelnen persönlichen Composio-Instanz bestätigt trotzdem genau das sichtbare Konto und beschafft den echten kurzlebigen Aufnahmebeleg. Nur der zusätzliche Dialog entfällt; Accountprüfung und Auswahlbeleg entfallen nicht.

Vor der Navigation zur Einrichtung wird der scoped Nachrichtenentwurf erhalten. Die Rückkehr verweist auf denselben Benutzer, Workspace, Agenten und Chat beziehungsweise Entwurf und den genauen Katalogeintrag; Credentials und Authzustände gehören nicht in diesen Link. Ein OAuth-Rückkehrmarker beweist keine Autorisierung. Erst die frisch bestätigte konkrete Verbindung darf anschließend ausgewählt werden; ein Wechsel zu einem anderen Standardkonto bleibt ausgeschlossen.

### 3. Auswahl als Nachrichtenkontext

Nach Auswahl bleibt ein entfernbarer Chip am Composer, etwa **Canva · Integration · Team Design**. Text und strukturierte Auswahl sind getrennt. Nur die tatsächlich angehefteten Chips bilden den expliziten Kontext der nächsten Nachricht; frei eingegebene Namen erzeugen keine verdeckte Account-Auswahl.

Ein Chip allein sendet keinen Auftrag. Der bestehende Vertrag bleibt bestehen: Nachrichtentext oder Attachment ist erforderlich. Eine Auswahl ohne anschließenden akzeptierten Auftrag verändert die Recents nicht; Plugin-Default-Prompts werden nicht ungefragt als Nachricht abgeschickt.

Pfeiltasten navigieren, Enter/Tab wählen, Escape schließt. Fokus und aktive Option sind für Screenreader erkennbar; IME-Komposition darf keine versehentliche Auswahl auslösen. Auf schmalen Webansichten nutzt derselbe Picker die verfügbare Breite; weiterführende Verbindungsauswahl darf als Sheet erscheinen.

Bei Treffer → Paketdetails → Verbindungswahl → Zurück bleiben Suchtext, Typfilter, Scrollposition und ursprünglicher Zeilenfokus erhalten. Ist der ursprüngliche Treffer inzwischen nicht mehr zulässig, geht der Fokus zum Suchfeld zurück und ein kurzer Hinweis erklärt die Änderung. Ein verschachtelter Chooser setzt nicht die gesamte gemeinsame Suche zurück.

Ältere `/skill-name`-/`/plugin-name`-Texte bleiben kompatibel, soweit sie im aktuellen zulässigen Kontext eindeutig sind. Mehrdeutige Namen benötigen eine konkrete Auswahl. Neue Nachrichten und Verlaufchips verwenden die gespeicherte genaue Herkunft und Version; sie werden nicht nachträglich aus dem heutigen Namenskatalog rekonstruiert.

## Such- und Referenzvertrag

Vorgeschlagen ist eine authentifizierte Chat-Projektion **`GET /api/chat/extensions/search`**. Der Endpoint verwendet die vorhandenen Katalogdienste und ergänzt Session-/Agent-Nutzbarkeit; er baut keinen zweiten Composio- oder MCP-Katalog.

Anfrage: aktueller `workspaceId`, zulässiger `agentId`, optional `sessionId`, `q`, `types`, begrenztes `limit` und gebundener `cursor`. Actor, Session-Eigentum und effektiver Agent werden serverseitig geprüft. Antwort: dieselben vier Kinds, sichere Logos, Quellenabdeckung und Pagination; außerdem `recent`/`suggested`-Kennzeichnung und eine zulässige Aktion `select`, `setup` oder `unavailable`. Menschliches `canRead` auf der Plugin-Seite ist allein kein Agent-Use-Recht.

Die UI nennt den Composio-Typ **Integration** beziehungsweise `integration`; der kanonische Auswahlvertrag nennt ihn `composio`. Die gemeinsame Projektion bildet dies ausdrücklich ab. Ein direkter MCP bleibt `mcp`; beide werden nicht aufgrund ihres Transportwegs gleichgesetzt.

Der gemeinsame `ExtensionSelection`-Vertrag bekommt eine versionierte Nachrichtenhülle `ChatExtensionSelection` und eine persistente Agent-Konfigurationshülle. Die Identitäten sind in beiden gleich; Dauer, Konfigurationsrevisionen und erlaubte Account-Wahl unterscheiden sich:

- **Plugin/Skill:** diskriminierter Typ, `resourceRef`, erwartete veröffentlichte Revision/Checksumme; bei enthaltenem Skill zusätzlich exakte Elternressource und Kindidentität.
- **Integration:** kanonischer Toolkit-Slug plus ausdrücklich gewählte öffentliche persönliche/gemeinsame Verbindung; no-auth als eigener zulässiger Fall. Profil-/Accountwerte nur soweit der bestehende persönliche Referenzvertrag sie benötigt; keine Composio-Entity-ID oder Credentials.
- **MCP:** exakte persönliche/gemeinsame Verbindung. Eine Definition ist ein Setup-Verweis und wird nicht als ausführbare Verbindung an die Runtime übergeben.
- **Anzeigewerte:** Name und Logo sind UI-Metadaten, keine Autorität. Clientseitiger Skilltext, Status und `providerRef` werden nicht als vertrauenswürdiger Ausführungskontext übernommen.

Beim Senden erzeugt der Server aus diesen Referenzen den aktuellen begrenzten Kontext. Entfernte Ressourcen, nicht mehr überprüfbare oder nicht mehr erlaubte gehaltene Paketrevisionen, widerrufene Nutzung oder veränderte konkrete Verbindung führen zu einem verständlichen Auswahl-/Einrichtungsfehler. Eine neuere veröffentlichte Head-Version allein macht eine weiterhin vorhandene, überprüfte und autorisierte immutable Revision nicht ungültig. Es gibt keinen stillen Namens- oder Account-Fallback. Ein neuer Picker-Aufruf kann einen aktuellen Paketstand anbieten; ein bereits eingefrorener Send-Snapshot wird nicht unbemerkt auf eine andere Version umgeschrieben.

Die Referenzen gehören in `ChatRequestContext` **und dessen Normalisierung**, den unveränderlichen Send-Snapshot, WebSocket-/HTTP-Vertrag, Queue-Änderungen, Steer/Follow-up/Retry und versionierte Drafts/Handoffs. Beim Queue-Start werden Rechte und Quelle erneut geprüft. Eine während eines laufenden Turns gewählte neue Erweiterung darf dessen bereits erfassten Kontext nicht ersetzen.

Retry derselben Nachricht erhält genau ihre angenommene Auswahl und prüft deren heutige Autorität erneut. Ein neuer Follow-up-Turn übernimmt frühere Referenzen ausschließlich durch erneute ausdrückliche Auswahl; Verlauf, Zusammenfassungen und Rehydration aktivieren keine alten Chips als neue Turn-Freigabe. Ein Steer-Auftrag hat seinen eigenen geprüften Referenzstand und bindet den bereits gestarteten Lauf nicht rückwirkend um. Dauerhafte Spezialagent-Konfiguration bleibt hiervon unabhängig bei jedem Start wirksam.

Dazu passend werden die Chips erst nach bestätigter serverseitiger Annahme aus dem nächsten leeren Composer-Entwurf entfernt. Bei abgelehntem Send bleiben sie samt Text zur Korrektur erhalten. Bei verlorener Bestätigung bleibt der eingefrorene Auftrag sichtbar ausstehend; er wird zuerst über seine Nachrichtenidentität nachgelesen und nicht als neue Auswahl erneut gesendet. Historische Chips bleiben an ihrer ursprünglichen Nachricht sichtbar. „Erneut verwenden“ wäre eine ausdrückliche neue Auswahl mit aktueller Prüfung.

### Dauerhafte Referenzen und zuverlässige Wiederaufnahme

Die akzeptierte genaue Auswahl ist von kurzlebigen Aufnahmebelegen getrennt. Insbesondere ein fünf Minuten gültiger persönlicher Composio-Accountbeleg ist keine langlebige Verbindung und gehört weder in Verlaufchips noch in die gespeicherte Agent-Konfiguration. Nach einem Draftreload kann eine frische Bestätigung derselben konkreten Auswahl erforderlich sein; ein abgelaufener Beleg erlaubt keinen Wechsel auf das Standardkonto. Queue-Start und spätere Ausführung prüfen die angenommene Auswahl erneut über die vorhandenen Autoritätsdienste.

Die clientseitige Send-Transaktion und die serverseitige Idempotenz müssen die kanonische Auswahl berücksichtigen. Gleicher Text mit anderer Auswahl ist ein anderer Auftrag. Ein erneuerter Aufnahmebeleg für dieselbe Auswahl darf dagegen weder eine zweite Nachricht noch einen falschen Inhaltskonflikt erzeugen. Dazu wird die logische Nachrichtenidentität von erneuerbaren Aufnahmebelegen getrennt; ein abweichender Auftrag unter derselben Nachrichten-ID bleibt ein Konflikt.

Die derzeitige Runtime-Queue und ihr Nachrichtenkontext liegen im RAM. Browserreload und Server-/Runtime-Neustart sind deshalb verschiedene Fälle. Der neue Vertrag benötigt eine dauerhafte angenommene Queue-Auswahl samt eindeutigen Zuständen und Wiederaufnahme. Nach verlorener Bestätigung darf eine möglicherweise bereits gestartete externe Mutation nicht automatisch erneut ausgeführt werden. Verlauf und Status müssen eine ungewisse Ausführung nachvollziehbar anzeigen, ohne privaten Providerkontext offenzulegen.

Die vorbereitete Übergabe eines echten Aufnahmebelegs an einen Runtime-Turn funktioniert nur innerhalb des Prozesses. Für Neustart/Rehydration muss ein eigener Serverpfad die tatsächlich gespeicherte, der Nachricht zugeordnete Auswahl laden, ihre aktuelle Autorität erneut prüfen und einen neuen Runtime-Beleg ausstellen. Ein Client-DTO, JSON-Parser oder kopierter alter Handle darf diesen Nachweis nicht ersetzen. Der Restart-Fall ist deshalb eine eigene Abnahme, kein Nebenprodukt des Draftreloads.

## „Zuletzt verwendet“ eindeutig definieren

Empfehlung: Ein Eintrag zählt als verwendet, wenn seine explizite Auswahl serverseitig geprüft und als Teil einer Chat-Nachricht akzeptiert wurde. Ein nachfolgender Providerfehler ändert nicht die Tatsache, dass der Nutzer diesen Kontext angefordert hat. Reines Suchen, Öffnen, Hover, Abbrechen und ein nicht akzeptierter Send zählen nicht.

Ein eigener begrenzter serverseitiger Recents-Dienst speichert höchstens etwa **30 Identitäten je Benutzer und Workspace** mit `lastUsedAt`. Eine atomare Speicherung und `clientMessageId` verhindern Doppelzählung durch Retry/Reconnect. Der aktuell ausgewählte Agent filtert die Nutzbarkeit; optional kann seine letzte Verwendung als Gleichstands-Kriterium dienen. Recents werden weder im Capability-Aktivierungsspeicher noch als ungefilterte globale LocalStorage-Liste abgelegt.

Gespeichert werden nur Typ, exakte Identität einschließlich gehaltenem Paketpin, gegebenenfalls Eltern-/Verbindungsreferenz und serverseitiger Zeitpunkt. Labels, Logos, aktuelle Nutzbarkeit und Rechte werden beim Lesen frisch aufgelöst. Der verwendete Paketpin wird dabei nicht durch einen neu veröffentlichten Head ersetzt; dessen bewusste Auswahl ist eine neue Wahl. Gelöschte oder entzogene Einträge verschwinden; ein alter Profil-/Accountbezug wandert nicht zum neuen Standardkonto. `providerRef`, `toolRef`, `schemaRef`, Skillinhalte und Secrets gehören nicht in den Recents-Speicher. Die Nachricht selbst behält ihren geprüften Herkunfts-Snapshot für Verlauf und Nachvollziehbarkeit.

Die automatische Anwesenheit einer festen Spezialagent-Auswahl aktualisiert nicht bei jeder Nachricht sämtliche Recents. Für diesen Chat-Vertrag zählt die explizite akzeptierte Turn-Auswahl. Der Agent-Editor darf diese begrenzte Historie als Vorschläge wiederverwenden, prüft aber seinen eigenen Zielkontext neu; Speichern einer Agent-Konfiguration wird nicht als Chat-Verwendung gezählt.

In Recents dürfen zwei tatsächlich verwendete Canva-Accounts als zwei klar beschriftete Verbindungszeilen erscheinen. In der allgemeinen Suchliste bleibt Canva ein App-Angebot mit bedarfsweiser Instanzauswahl. So wird weder die Account-Historie zusammengelegt noch derselbe Katalogeintrag künstlich vervielfacht.

## Präziser Kontext für den Agenten

Die gemeinsame Systemanleitung beschreibt Discovery und Tool-Nutzung. **Feste Agent-Zuweisungen** werden bei jedem Start aus der gespeicherten Konfiguration für den Systemprompt kompiliert. **Explizite Chat-Auswahlen** kommen zusätzlich als servergeprüfter Kontext für genau diesen Turn hinzu und verändern die gespeicherte Agent-Konfiguration nicht. Beide Ausgaben entstehen durch denselben Resolver. So behält eine Queue-Nachricht ihre eigenen Referenzen und eine Folgeauswahl verändert keine früheren Turns.

| Auswahl | Sofort übermitteln | Erst bei Bedarf laden |
| --- | --- | --- |
| Plugin | Exakte Quelle/Version, kurzer Zweck, relevante Paket-Anleitung, passende enthaltene Skills mit autorisierten Lesepfaden, deklarierte Anforderungen und deren aktuelle konkrete Bindungen | Weitere Skilltexte, Assets und benötigte Toolschemas |
| Skill | Exakte Quelle und Elternherkunft, kurze Beschreibung, autorisierter `SKILL.md`-Pfad; Hinweis, diesen vor Nutzung zu lesen | Vollständiger Skilltext über das tatsächlich verfügbare `read`-Tool |
| Composio | Toolkit-Slug, ausdrücklich gewählte Verbindung/Bereich, aktuelle Nutzbarkeit, vom Server aufgelöste zulässige Provider-Referenz und Tool-Suchrezept | Passende Toolnamen und genau deren Schema |
| MCP | Exakte Verbindung/Bereich, aktuelle Nutzbarkeit, aufgelöste zulässige Provider-Referenz und Tool-Suchrezept | Tools dieser Verbindung und genau deren Schema |

**Der Gateway ist heute ein Tool `integrations`.** Wenn es im effektiven Manifest registriert ist, löst die vorbereitete Runtime die ausgewählte Verbindung über die vorhandenen Adapter-/Bindungsdienste gezielt zu ihrem aktuellen zulässigen Provider-Descriptor auf. Die private Verbindungsautorität wird dabei frisch geprüft; weder Anzeigename noch Clientdaten konstruieren eine Gateway-Referenz. Der öffentliche Auswahlweg muss diese Auflösung noch anschließen; die UI-Suche allein liefert keinen gültigen Toolaufruf.

Mit einer so gelieferten aktuellen `providerRef` beginnt der Agent direkt bei der **Tool-Suche in dieser Verbindung**:

1. `integrations`: `action: "search"`, `target: "tools"`, servergelieferte `providerRef`, auftragsbezogene `query`.
2. `integrations`: `action: "describe"`, die aus der Suche zurückgegebene `toolRef`.
3. `integrations`: `action: "call"`, dieselbe `toolRef`, die zurückgegebene `schemaRef` und schema-konforme `arguments`.

Jeder Schritt setzt die aktuelle Policy und die jeweiligen Toolgrenzen voraus. Die bloße Registrierung von `integrations` erlaubt nicht automatisch Search, Describe und Call. Eine nur zur Discovery zugelassene Konfiguration erhält einen entsprechenden Hinweis und keine Ausführungsanweisung; ein Suchtreffer erweitert keine Aktionsfreigabe.

Wenn zunächst nur eine deklarierte Plugin-Anforderung vorliegt, lautet das gezielte Suchrezept `target: "providers"` mit den tatsächlich unterstützten Filtern `source`, `application`, `pluginRef` beziehungsweise `capabilityRef`. Der heutige Requestvertrag hat dort **kein beliebiges `connectionRef`-Filterfeld**. Deshalb darf der Plan keine solche schon vorhandene API behaupten. Mehrere passende Instanzen werden ausdrücklich aufgelöst; ein zurückgegebener Provider wird nicht wegen Namensähnlichkeit anstelle der gewählten Verbindung benutzt.

`providerRef`, `toolRef` und `schemaRef` gelten für den aktuellen Kontext und werden nicht aus alten Nachrichten wiederverwendet oder erfunden. Geänderte Bindung/Schema erfordert frische Auflösung. `outcome_unknown` darf keine automatische Wiederholung einer Mutation auslösen.

Eine feste Agent-Auswahl oder tatsächlich servergeprüfte explizite Turn-Auswahl erhält in der vorbereiteten Runtime den auf diese Quellen begrenzten `integrations`-Gateway auch bei deaktiviertem globalem Experiment. Der globale Schalter selbst wird dadurch nicht verändert; für einen allgemeinen Chat ohne solche Auswahl bleibt er maßgeblich. Verbindliche Workflow-Version 1 bleibt erhalten. In verbleibenden Legacy-Kontexten wird ein Suchrezept ausschließlich aus dem tatsächlich vorhandenen `mcp`-/`composio`-Vertrag erzeugt. Die Anleitung darf keine nicht vorhandenen Tools empfehlen. Gesperrte/spezialisierte Agenten bekommen durch einen Chip keine zusätzlichen Apps oder Aktionen.

Ein Legacy-Vertrag muss die genaue gewählte Verbindung auch tatsächlich unterstützen. Fehlt beispielsweise ein zulässiger Weg für die ausgewählte geteilte Instanz, zeigt die Chat-Projektion diese Einschränkung und gegebenenfalls den berechtigten Konfigurationsweg. Sie behauptet keine sofortige Nutzbarkeit und ersetzt die Instanz nicht durch ein persönliches Konto.

### Kontextgröße und Vertrauen

Vorgeschlagene anfängliche Chat-Grenze: höchstens **fünf sichtbare, ausdrücklich gewählte Hauptchips**. Notwendige Verbindungszuordnungen eines Plugin-Chips bleiben darin sichtbar aufklappbar. Der vorbereitete Vertrag zählt derzeit stattdessen fünf genaue Auswahlreferenzen einschließlich separat transportierter Verbindungen; die vorgeschlagene Hauptchip-Regel benötigt deshalb vor UI-Anschluss eine bewusste Vertragsänderung mit separaten Grenzen für Abhängigkeiten und Gesamtgröße. Bis dahin muss die tatsächliche Zählung vor Bestätigung sichtbar sein; ein Paket darf nicht erst nach der Auswahl überraschend am Limit scheitern.

Für festen Agent-Kontext und Turn-Ergänzung gilt ein gemeinsames, separat vom übrigen Systemprompt verwaltetes Budget; **8 KiB UTF-8** ist der zu prüfende Startwert. Die bestehende Agent-Konfigurationsgrenze wird nicht auf fünf Ressourcen reduziert. Größe wird vor Speichern beziehungsweise Senden berechnet; ein nicht darstellbarer Pflichtindex erzeugt einen konkreten Konfigurationsfehler statt stiller Auslassung. Die Prüfung berücksichtigt tatsächliche Pflicht-/Core-Skills, effektive Tools aus Modell-/Provider-Vererbung und die maximale Größe späterer Suchrezepte. Eine gekürzte oder für die Anzeige redigierte Vorschau darf nicht mit einem dadurch kleineren internen Budget rechnen.

Grenze, Kürzung und Priorität werden zentral implementiert, nicht unabhängig pro Connectorarray. Zuerst bleiben feste/ausgewählte genaue Identität, Rechte-/Einrichtungsstatus und Suchrezept erhalten; danach kurze relevante Beschreibungen und Skillhinweise. Große Pakete geben einen sichtbaren Hinweis auf weitere bei Bedarf lesbare Inhalte. Es werden keine vollständigen Toolkataloge oder vollständigen Skilltexte eines großen Plugins in den Prompt kopiert. Derselbe Skill beziehungsweise dieselbe exakte Verbindung aus fester und Turn-Auswahl erscheint nur einmal; unterschiedliche Accounts oder Versionen werden nicht zusammengelegt.

Die Auswahl relevanter Kinder bleibt nachvollziehbar: ausdrücklich gewählte Skills zuerst; anschließend zulässige Plugin-Kinder anhand Titel/Beschreibung und des Auftragstexts nach derselben Metadaten-Relevanz wie in der Suche ordnen. Bei Gleichstand gilt eine stabile Reihenfolge. Ohne aussagekräftigen Text wird ein kurzer Skill-Index statt einer erfundenen Workflow-Auswahl geliefert. Beim Spezialagenten bleibt der konfigurierte kompakte Index auch ohne aktuelle Nutzerreferenz vorhanden; Relevanz verändert die Detailtiefe, nicht die konfigurierte Verfügbarkeit. Weitere Inhalte müssen über tatsächlich vorhandene autorisierte Lesemöglichkeiten erreichbar sein; fehlt dem Agenten dafür ein Tool, wird dies als fehlende Nutzbarkeit ausgewiesen. Ein genauer Lesepfad darf nur dann aus dem kompakten Index entfallen, wenn ein tatsächlich registrierter, zulässiger Discovery-Weg ihn zuverlässig liefern kann. Ohne diesen Suchweg bleiben notwendige Leserezepte Teil des Pflichtbudgets.

Paket-/Skilltexte bleiben fremde Inhaltsquellen mit klarer Herkunft. Nur die serverseitige Hülle bestimmt Ressource, aktuelle Berechtigung und Suchweg. Ein Pakettext kann weder Systemanweisungen überschreiben noch neue Konten, Secrets oder Freigaben erteilen. Relevante Anleitung wird aus dem geprüften veröffentlichten Stand gelesen, nicht aus einem vom Client gelieferten JSON-Text.

## Umsetzung in abgeschlossenen Schritten

| Schritt | Konkrete Arbeit | Abschlusskriterium |
| --- | --- | --- |
| 1. Gemeinsamer Vertrag und Autorität | Gemeinsame genaue Selectionidentität, Nachrichten-/Agent-Hüllen, versionierte Standalone-Bindungen, V1-Adapter, Runtime-Discovery und erforderliche Tool-Registrierung festlegen. | Gleiche Namen, Versionen und Accounts bleiben getrennt; keine stille Umdeutung von Vererbung oder Workflow V1; Suchergebnis und Ausführung bleiben aktuell begrenzt. |
| 2. Gemeinsamer Kontextcompiler | Feste Agent-Auswahl und Turn-Referenzen zusammen auflösen; Promptindex, Readroots, Toolhinweise, Readiness und Budget am gleichen Selektionsstand erzeugen; frische Ausführungsprüfungen erhalten. | Spezialagent erhält immer seine feste Auswahl; allgemeiner Agent findet Skills ohne vollständigen Katalogprompt; nur registrierte Tools werden empfohlen; Rechteentzug stoppt weiterhin. |
| 3. Agent-Tool und Agent-UX | Create/Update aus demselben vollständigen Vertrag ableiten; gemeinsame All-in-one-Suche mit Paketdetails, Accountwahl, Toolgrenzen und Kontextvorschau integrieren. | Atomarer Tool-Create und UI-Create erzeugen dieselbe genaue Konfiguration; UI-/Tool-Edit roundtrippt mit Revisionen; Standalone-Integration/MCP ist ohne Paket wählbar. |
| 4. Chat-Picker und Nachrichten | Chat-Suchroute, Recents, Logos, optionale Filter, Accountauswahl, Chips sowie Send/Queue/Steer/Retry, Drafts und Handoff anschließen. | `/` zeigt Recents beziehungsweise gemeinsame relevante Treffer; unveränderliche Nachrichtenreferenzen erreichen den Compiler; keine dauerhafte Agent-/Accountänderung durch Auswahl. |
| 5. Web-, Agent- und Modell-Abnahme | Agent-Erstellung/Verwaltung und Notebook/Vollchat, Dashboard, Desktop-/schmalen Web-Dock einschließlich Email, Studio, Todos, Knowledge, BrowserLab und Onboarding prüfen. | Reale Tool↔UI-Parität, Fokus, DE/EN, Kontextwechsel, Reload/Queue/Retry, neue/bestehende Agent-Chats und Modell-Toolrouting nachgewiesen; UI/API/Modell/Provider getrennt berichten. |
| 6. Native Mobile | Native API-/Realtime-Kontext, eigene Sheet-/Composer-Auswahl und scoped Drafts ergänzen; Agent-Konfiguration auf nativen Flächen inventarisieren; Hardwaretastatur/VoiceOver/Geräte prüfen. | Eigenständige native Abnahme; eine schmale Browseransicht gilt nicht als Ersatz. |

Jeder Schritt wird abgeschlossen, bevor der nächste beginnt. Im ersten Umsetzungsabschnitt sollten Schritte 1–5 als zusammenhängender Web-/Agent-Bedienweg fertig werden. Native Mobile ist eine ausdrücklich ausgewiesene Folgestufe. Der separate namensbasierte Skill-Selector im Automation-Editor wird später anhand seines Scheduler-/Webhookvertrags migriert; er ist keine Chat-Nachricht. Geplante/scheduled Läufe eines Spezialagenten müssen dessen feste Auswahl und aktuellen ausführenden Nutzerkontext bereits über den gemeinsamen Runtime-Compiler erhalten. Datei-Picker im E-Mail-Dialog und MCP-App-Widgets behalten ihre eigene Autorität.

## Verbindliche Abnahmefälle

1. Leeres `/`: aktuelle Recents, idempotente Speicherung erst nach akzeptiertem Send; keine Nutzung durch Hover oder Abbruch.
2. Eine Suche „Canva“ zeigt alle vier Typen; Typfilter behalten den Begriff; ein später Composio-Katalogtreffer wird gefunden.
3. Gleichnamiges Plugin, unabhängiger Skill, Plugin-Kind und zwei MCP-Verbindungen bleiben getrennte genaue Identitäten.
4. Persönlicher und Team-Account derselben App: ausdrückliche Auswahl; gewöhnlicher Nutzer kann mit Use ohne Manage verwenden; kein erster Account als Fallback.
5. Nicht installiert, Autorisierung erforderlich, no-auth, Dienst nicht erreichbar und nicht freigegeben erhalten zutreffende Aktionen.
6. Gehaltene Antworten bei Agent-/Workspace-/Profil-/Benutzerwechsel gelangen nicht in den neuen Picker oder Nachrichtenkontext.
7. Chip entfernen, Text bearbeiten, Draftreload, Handoff, Follow-up/Steer, Queueedit und Retry erhalten oder entfernen Referenzen eindeutig. Browserreload und Runtime-Neustart werden separat geprüft. Gleicher Text mit anderer Auswahl ist eine neue Transaktion; ein erneuerter Aufnahmebeleg derselben Auswahl erzeugt keine Doppelung. Eine ungewisse externe Ausführung wird nicht automatisch wiederholt.
8. Rechteentzug zwischen Auswahl, Send, Queue-Start, Schema und Call stoppt jeweils vor unberechtigter Nutzung. Historische Chips behaupten keinen heutigen Zugriff.
9. Router registriert/nicht registriert sowie verbindlicher Workflow-Agent: Kontext nennt nur tatsächlich vorhandene Tools und bleibt in deren erlaubtem Umfang.
10. Ausgewähltes Plugin führt den Agenten zu relevantem `SKILL.md` und genau passenden Tools; ein großes Plugin hält die gemeinsame Kontextgrenze ein. Plugins mit Root-`SKILL.md` und Plugins mit optionalen Kind-Skills werden geprüft; Teilmengenauswahl erhält notwendige Elternanforderungen.
11. Stale Paket-/Connection-/Schema-Revision löst eine konkrete Neuauflösung aus; keine automatische Mutation-Wiederholung.
12. Reale Tastatur-/IME-/Screenreader-Bedienung, DE/EN, Desktop und schmaler Web-Dock; native Geräteprüfungen getrennt.
13. Über das tatsächliche `create_agent`-Tool einen Agenten mit Plugin/Kind-Skill und eigenständigem MCP/Composio erstellen; die Management-UI zeigt exakt dieselben Quellen, gehaltenen Versionen, Verbindungen und Toolgrenzen.
14. Dieselbe Konfiguration über die UI erstellen; Inspect-/Workflow-Tools liefern denselben kanonischen Stand. Konkurrierender Update scheitert mit Revisionskonflikt; fehlerhafter Create hinterlässt keinen unvollständigen ausführbaren Agenten.
15. Neuer und bereits bestehender Spezialagent-Chat ohne Slash: feste Plugin-/Skill-/Verbindungshinweise im Systemprompt vorhanden. Eine neue Turn-Auswahl fokussiert nur die zulässige feste Menge.
16. Allgemeiner Chat ohne Referenz: kein automatischer vollständiger Skillkatalog; passende Skills sind durch tatsächliche auftragsbezogene Suche auffindbar und werden vor Nutzung autorisiert gelesen. Explizite Referenz erzeugt nur den zugehörigen Turn-Kontext.
17. Core-/Pflichtskills, Legacy-`null`-Vererbung und neue feste/leere Auswahl bleiben unterscheidbar. Mehrdeutige alte Namen/Verbindungen benötigen Auswahl; V1-Pins wechseln nicht still auf einen anderen Stand.
18. Organisationsagent mit gemeinsamer Verbindung versus persönlicher Wahl: jeder Nutzer erhält seinen eigenen aktuellen Bindungsstand; Erstellerkonto wird nicht automatisch geteilt. Use ohne Manage bleibt nutzbar; Agentfreigabe ersetzt keine Ressourcenfreigabe.
19. Fehlendes natives Lese-/Gateway-Tool, notwendige ungebundene Verbindung, optionaler Providerausfall und große Pakete erzeugen zutreffende Readiness-/Budgethinweise. Lokale erlaubte Skills bleiben unabhängig vom Providerhealth verfügbar.
20. Prompt, Readroots und Toolhinweise haben denselben Selektionsfingerprint; Actor-/Workspace-/Preferencewechsel sowie Konfigurationsaktualisierung erneuern sie sicher. Aktive Läufe werden nicht unbemerkt umgebunden; frische Read/Describe/Call-Prüfungen bleiben wirksam.
21. Im Planungsmodus funktioniert sichere Skill-/Plugin-Metadatensuche, ohne externe Accountprobe, Bindingänderung oder Provider-Ausführung. Delegierte und geplante Spezialagent-Läufe erhalten ihre feste Auswahl innerhalb ihrer aktuellen Policy.
22. Optionen vor Create funktionieren ohne angelegten Agenten; die Metadatensuche erzeugt keine Composio-Profile und lädt keine persönlichen Accounts. Erst der ausdrücklich geöffnete Chooser prüft das gewählte Konto. Die endgültige Erstellung prüft erneut.
23. System-/Email-Agent: keine neuen festen Erstellerkonten oder privaten Pakete; gemeinsamer Zielkontext eindeutig geprüft. Ein zulässiger gewöhnlicher Nutzer kann weiterhin sichere Metadaten lesen, ohne Verwaltungsrechte zu erhalten.
24. Zwei echte parallele Erstellungen mit derselben normalisierten Agent-ID: Rollback und Dateibereinigung der fehlgeschlagenen Erstellung beeinträchtigen weder SQL-Stand noch Dateien der erfolgreichen Erstellung.
25. Vor Save erscheinen fehlende Pflichttools, ungebundene notwendige Verbindungen und Budgetkonflikte in derselben Vorschau wie der spätere Runtime-Kontext. Einrichtung und Rückkehr erhalten den Formularentwurf; es entsteht kein provisorischer ausführbarer Agent.
26. Ein Nutzer mit Use, aber ohne zentrale Edit-Rechte kann unter „Meine Verbindung“ ausschließlich die vom gemeinsamen Agenten erlaubten Optionen wählen. Zentrale Auswahl, erlaubte Alternativen und Toolgrenzen bleiben unverändert; die Präferenz eines anderen Nutzers wird nicht übernommen.
27. Paketdetails und Accountwahl öffnen und wieder schließen: Suchbegriff, Filter, Scrollposition und Fokus bleiben erhalten. Ein währenddessen entzogener Treffer führt mit erklärendem Hinweis zurück zum Suchfeld.
28. Composio-Toolkitlogo, MCP-Domainlogo und veröffentlichtes Paket-/Skillbild erscheinen für die genaue Quelle. Fehlendes oder defektes Bild zeigt Initialen; Workspace-/Quellen-/Pinwechsel verwendet kein altes Bild. Die Auswahl bleibt bei jedem Bildfehler bedienbar.

Zusätzlich: manuelles Öffnen ohne Slash erhält Text/Caret; Auswahl entfernt nur die erfasste Slash-Range. Ein Chip ohne Text/Attachment erzeugt weder Nachricht noch Recency.

Bestehende Agent-Konfigurations-, Capability-Scope-, Workflow-/Readroot-, Chat-Referenz-, Chip-Scope-, Draft- und Send-Transaction-Prüfungen werden gezielt erweitert. Ein echter Modelllauf muss zusätzlich nachweisen, dass der Agent sowohl einen nicht explizit referenzierten passenden Skill findet als auch den gelieferten gezielten Tool-Suchweg nutzt; ein Snapshot des Prompttexts allein beweist das nicht. Externe Providerabnahme und allgemeiner Gateway-Rollout bleiben im [bestehenden Rollout-Plan](rollout-plan-2026-10-13.md).

## Punkte für die nächste gemeinsame Optimierung

- Die drei Entwurfsregeln bestätigen oder anpassen: Chips nach angenommenem Send entfernen; unvollständige Plugin-Auswahl als markierten Entwurf zulassen; Agent-Formularentwürfe über OAuth/Reload erhalten. Vorschlag für deren begrenzte Aufbewahrung: sieben Tage im gleichen Nutzer-/Workspace-/Zielkontext.
- Den vorhandenen Runtime-Zuordnungsvertrag für Plugin-Anforderungen im gemeinsamen Picker sichtbar machen: notwendige/optionale Bestandteile, fehlende Verbindung und Accountkonflikte vor dem Send erklären. Das ist ein notwendiger Bedienweg.
- Die gemeinsame Suche mit unterschiedlichen Nutzungsprojektionen statt drei auseinanderlaufenden Katalogen umsetzen. Einrichtung aus Chat und Agent-Editor muss in denselben erhaltenen Entwurf zurückführen.
- Soll ein ausgewähltes Plugin zunächst alle zulässigen Bestandteile übernehmen oder eine vom Paket angebotene Standardauswahl? Empfehlung: Einen tatsächlich vorhandenen Paketstandard transparent anzeigen; ohne deklarierten Standard alle zulässigen Bestandteile anbieten. Abweichungen aufklappen, Pflichtbestandteile erhalten. Die UI erfindet keine Paketvorgabe.
- Fehlende feste Bindung oder ungültige Wahlregel: Empfehlung bleibt ein erhaltener Formularentwurf mit genauem Einrichtungsweg. Eine gültige gemeinsame Konfiguration mit persönlicher Wahl je Nutzer ist dagegen speicherbar und zeigt „Meine Verbindung einrichten“. Fehlende persönliche Pflichtwahl sperrt externe Workflow-Aktionen insgesamt; zulässige lokale Skills bleiben verfügbar. Ein zusätzlicher gespeicherter Agent-Draftstatus bleibt eine gesonderte Produktentscheidung.
- Die Chip-Zählung abstimmen: Empfehlung fünf sichtbare Hauptauswahlen mit getrennten Grenzen für Plugin-Abhängigkeiten; der vorbereitete Vertrag zählt derzeit fünf genaue Referenzen. Die UI muss immer die tatsächlich geltende Grenze erklären.
- Soll Vererbung für neue Spezialagenten noch als erweiterte Option angeboten werden? Empfehlung: neue Agenten mit fester Auswahl; bestehende Vererbung sichtbar erhalten und gezielt migrieren.
- Kontextbudget und Ergebnisanzahl anhand kleiner/großer realer Pakete prüfen. Eine Performance-/Modellabnahme muss zeigen, dass der kompakte Index ausreicht und Suche gezielt bleibt.

Diese Punkte verfeinern den gespeicherten Vorschlag. Sie sind keine Voraussetzung dafür, jetzt den Plan zu besprechen, und keine pauschale Freigabe zur Implementierung.
