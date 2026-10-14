# Gemeinsame Erweiterungsauswahl: Feedback und Besprechungsplan

Besprechungsstand: 14. Oktober 2026. Aufbauend auf dem Feedbackcheckpoint `23354e883` ist hier der Plan mit dem aktuellen Arbeitsbaum abgeglichen. Die nachfolgenden Produktregeln und offenen Entscheidungen sind die gemeinsame Besprechungsgrundlage. Einzelne Implementierungs- und Testnachweise stehen im verlinkten Journal.

Dies ist die kurze Produktansicht. Weiterführend: [technischer Gesamtplan](chat-extension-reference-plan.md), [Umsetzungs-/Abnahmejournal](chat-agent-extension-implementation.md), [synthetischer Chat-Wireframe](wireframes/chat-extension-picker.html).

## Einschätzung

Die Richtung passt: **eine gemeinsame Suche und ein gemeinsames Referenz-/Kontextsystem für Plugins, Skills, Composio und MCP**. Ein Plugin bündelt Anleitung, Skills und deklarierte Verbindungen. Alle Bestandteile bleiben unabhängig auswählbar. Composio verwaltet Katalog und Werkzeuganbindung extern; in der UI bleiben dies „Integrationen“, getrennt von selbst angebundenen MCP-Servern. Der vorhandene lokale Aufrufweg verwendet auch das Composio-SDK; ein MCP-Transport wird nicht pauschal vorausgesetzt.

Der Stand ist **teilweise umgesetzt**. Plugin-Katalog, genaue Auswahlverträge, Agent-Schreibwege und gemeinsame Kontextaufbereitung sind als Grundlagen vorhanden. Gemeinsame Agent-Editoren sind eingecheckt und inzwischen mit frischem Build, 28 Browserfällen und anschließendem tatsächlichem Tool-Inspect lokal abgenommen. Der Chat verwendet weiterhin getrennte Plugin-/Skill-Listen mit Namen; gemeinsame Turn-Auswahl, Recents und durchgehend dauerhafte Zustellung fehlen. Die interne Aufnahmegrenze 4a ist lokal abgeschlossen: versionierte Speicherung, strenger Codec, vollständige Quellenprüfung und privater SQL-Wiederleser bestehen einschließlich nativer Konkurrenz- und Rollbackprüfungen. Der Dienst ist noch nicht an den tatsächlichen Chat, Queue und Runtime angeschlossen. Ein größerer Slash-Picker allein würde diese Unterschiede bestehen lassen.

## Gleiche Auswahl, erkennbare Wirkung

| Verwendung | Wirkung |
| --- | --- |
| Plugin-Seite: „Einrichten“ | Ressource installieren oder Verbindung einrichten; noch keine automatische Agent-Zuweisung. |
| Agent-Erstellung/-Bearbeitung: „Dauerhaft für diesen Agenten“ | Genaue Auswahl samt Grenzen speichern und bei jedem Start im geprüften Systemkontext berücksichtigen. |
| Chat: „Für diese Nachricht“ | Auswahl an diese Nachricht und ihren Lebenszyklus binden; keine dauerhafte Agent- oder Standardkontoänderung. |
| Gemeinsamer Agent: „Meine Verbindung“ | Die ausdrücklich erlaubte persönliche Kontowahl des aktuellen Nutzers speichern. |
| Aufgabe ohne Referenz | Erlaubte Skills bedarfsgerecht suchen und autorisiert laden; keine automatische Installation oder Kontowahl. |

UI und Agent-Tool verwenden dieselben serverseitigen Optionen, Schreibverträge und Inspect-Ergebnisse. Paketstand, Kind-Skill, konkrete Verbindung, Bereich und Werkzeuggrenzen bleiben beim Roundtrip erhalten. Anzeigenamen sind keine Identitäten. Reine Profiländerungen behalten die Erweiterungsauswahl; Ersetzen benötigt die aktuelle Ausgangsrevision.

Für die Agent-Erstellung ist ein gemeinsamer Abschnitt **„Erweiterungen und Werkzeuge“** vorgesehen. Die gemeinsame Suche bietet die vier Erweiterungstypen an. Die daraus verfügbaren Werkzeuge und die nativen Werkzeuge sollen zusätzlich mit ihren effektiven Grenzen sichtbar sein; Anpassungen und die Kontextvorschau öffnen unter „Erweitert“. Das Agent-Tool verwendet dieselbe vollständige Konfiguration und kann sie über Inspect zurücklesen.

## Progressive Disclosure

1. **Finden:** Ein Suchfeld, gemischte Treffer und optional „Filtern“. Ohne Eingabe zuletzt akzeptierte explizite Chat-Auswahlen; ohne Historie als Vorschläge bezeichnete Einträge. Beim Tippen Relevanz zuerst, letzte Nutzung nachrangig. Filter erhalten den Suchtext.
2. **Verstehen:** Logo, Name, Typ, kurzer Nutzen und ein handlungsrelevanter Status je Zeile. Plugin-Details zeigen enthaltene Skills und notwendige/optionale Verbindungen. Erst hier erscheinen Konten; auch ein einziges Konto bleibt vor Bestätigung sichtbar.
3. **Anpassen:** Bestandteile, Profil-/Kontowahl sowie bei Bedarf Werkzeuggrenzen und Kontextvorschau. Fehlende Pflichtverbindungen werden sofort erklärt; technische Diagnose bleibt aufklappbar.

Composio verwendet das Toolkit-Logo aus den API-Metadaten. Eigene MCPs verwenden die vorhandene geprüfte Domain-Iconquelle, Plugins/Skills ihre mitgelieferten Icons. Fehlt ein Bild oder lädt es nicht, erscheinen Namensinitialen. Das gilt auch nach erneutem Öffnen gespeicherter Auswahlen; Logoanzeige löst keine Account- oder Providerprüfung aus.

Schematische Agent-Auswahl mit Beispieldaten:

```text
Erweiterungen und Werkzeuge
[ Plugins, Skills, Integrationen und MCP suchen … ] [Filtern]

Ausgewählt – dauerhaft für diesen Agenten
[Logo] Content Studio                  Plugin       [Details]
       2 Skills · Canva: Marketing-Team
[Logo] Recherche                       Skill        [Entfernen]
[Logo] Internes CRM                    MCP          [Details]

! LinkedIn: Meine Verbindung einrichten              [Öffnen]
[Erweitert: Werkzeuggrenzen und Kontextvorschau]
                                      [Agent speichern]
```

Eine gültige Regel „jeder Nutzer wählt sein eigenes Konto“ darf gespeichert werden. Bis zur erforderlichen persönlichen Wahl sperrt die heutige Runtime externe Workflow-Aktionen; zulässige lokale Skills bleiben verfügbar. Fehlende feste Bindungen oder ungültige Wahlregeln bleiben dagegen Formularentwürfe. Provider-Ausfall und fehlende Autorisierung erhalten unterschiedliche Meldungen; `provider_unavailable` begründet kein automatisches Trennen und Neuverbinden.

Schematische Chat-Auswahl mit Beispieldaten:

```text
Für diese Nachricht
[ Plugins, Skills, Integrationen und MCP suchen … ] [Filtern]
Zuletzt im Chat verwendet
[Logo] Content Studio     Plugin       2 Skills · Canva: Team
[Logo] Canva              Integration  Mein Konto · persönlich
[Logo] Internes CRM       MCP          Organisation
[Logo] Recherche          Skill        eigenständig

Nach Auswahl eines Plugins: [Bestandteile und Verbindungen]
Canva: Marketing-Team · Profil Arbeit                 [Ändern]
                         [Für diese Nachricht hinzufügen]

[Content Studio · Canva: Team ×]  [Nachricht schreiben …]
```

Die vorhandene HTML-Demo zeigt die Suchidee. Ihre unmittelbare Einzelkonto-Auswahl, vereinfachten Plugin-Bindungen und lokal simulierten Recents sind noch kein vollständiger Zielentwurf. Bei ihrer nächsten Überarbeitung müssen auch die Bestätigung eines einzelnen Kontos, fehlende Plugin-Pflichtverbindungen und „ausstehend“ gegenüber „dauerhaft angenommen“ sichtbar werden. Die echte Historie unterscheidet konkrete Accounts und Paketstände.

## Präziser System-/Nachrichtenkontext

Die gemeinsame serverseitige Aufbereitung liefert einen kompakten Index: geprüfter Paketstand, relevante Plugin-Anleitung, zugehörige ausgewählte Skills, genaue autorisierte Lesepfade und tatsächlich vorhandene Tool-Suchwege. Vollständige Skill-Anleitungen und Werkzeugschemas werden bei Bedarf geladen. Für MCP und Composio führt das Rezept über die genaue ausgewählte Provider-/Verbindungsreferenz zu Toolsuche, Schema und anschließend demselben Toolaufruf. Konten werden nicht stillschweigend ersetzt.

Beim Spezialagenten gehört der feste Index zu jedem Start. Im allgemeinen Chat ergänzt eine ausdrückliche Referenz den jeweiligen Turn. Core-/Pflichthinweise und natürliche Skill-Suche bleiben erhalten. Bestehende Vererbung wird sichtbar erhalten und ausdrücklich migriert. Die Ausgabe berücksichtigt registrierte Tools und den tatsächlichen Routerzustand; Prompttext erteilt keine Rechte.

## Reihenfolge und Abschluss

| Schritt | Ergebnis | Fertig, wenn |
| --- | --- | --- |
| 1. Agent-Auswahl fertigstellen | Gemeinsamer Editor in Create, Edit und persönlicher Wahl; vollständige Agent-Tool/UI-Parität. | Tool→UI→Tool erhält Identitäten, Versionen, Konten und Grenzen. Gespeicherte Namen/Logos, fehlende Pflichtwahl, genaue Einrichtungslinks und Save bei Refreshfehler sind abgenommen. |
| 2. Nachrichtenweg schließen | Dauerhafte Annahme und privater Wiederleser, danach Runtime, Queue, Draft, Send, Steer, Retry, Handoff und Verlauf anschließen. | Reload und Serverneustart separat geprüft; gleiche Nachrichten-ID mit gleicher Auswahl wird wiedererkannt. Verlorene Bestätigung wiederholt keine möglicherweise begonnene Geschäftsaktion automatisch. |
| 3. Chat-Picker und Recents anschließen | `/` und Kontextknopf öffnen dieselbe Suche mit Filtern, Details und Chips; zuletzt verwendete Einträge aus dauerhaft angenommenen expliziten Auswahlen. | Alle vier Typen, gleiche Namen, einzelne und mehrere Konten, Tastatur und Rückkehr aus Einrichtung funktionieren. Paketabhängigkeiten und Auswahlgrenzen sind vor Bestätigung verständlich. |
| 4. Gesamten Web-/Modellweg abnehmen | Produktionsbuild, echte UI-Bedienung und Modelllauf mit Skill-Lesen und gezielter Discovery. | Kontextwechsel, Rechteentzug, Accounttreue, Routerzustände und Wiederaufnahme nachgewiesen; API-, Browser-, Modell- und Providerbelege getrennt. |
| 5. Native Flächen anschließen | Gemeinsame Verträge im eigenen nativen Composer und Agent-UX verwenden. | Eigene Geräte-/Accessibility-Abnahme; schmaler Browser ersetzt sie nicht. |

Jeder Integrationsschritt wird abgeschlossen, bevor der nächste beginnt. **Die Agent-Stufe ist lokal abgeschlossen:** frischer Produktionsbuild, alle 28 Browserfälle und unabhängiger tatsächlicher Tool-Inspect bestehen im Lauf `3qFxAz`. Für die Chat-Stufe ist die interne dauerhafte Nachrichtenannahme abgeschlossen; als Nächstes folgen Runtime/Transport und danach der sichtbare Picker. Diese Reihenfolge verhindert, dass die UI eine Auswahl anbietet, die der heutige Transport verwirft. Chat, tatsächlicher Modelllauf und Native Mobile bleiben offen; der Gesamtplan ist nicht abgeschlossen.

Vor Schritt 2 werden vier Vertragsfragen verbindlich präzisiert: eigenes Chat-Turn-Ziel mit Use- statt Edit-Rechten und tatsächlichem Session-/Workspace-Kontext; explizite Slot-/Revisionszuordnung bei erlaubtem Turn-Accountwechsel; gemeinsames 8-KiB-Budget aus fester und zusätzlicher Auswahl; eindeutige alte `/name`-Referenzen früh in genaue Referenzen übersetzen und durch denselben dauerhaften Annahmepfad führen. Ein weiterer Konto-Chip allein überschreibt keine Plugin-Bindung.

## Vorschläge zur anschließenden Optimierung

- **Plugin-Vorauswahl:** Tatsächlich deklarierten Standard zeigen; sonst alle zulässigen Bestandteile anbieten. Optionale Abwahl aufklappen, Pflichtbestandteile erhalten.
- **Chip-Grenze:** Fünf sichtbare Hauptauswahlen vorschlagen und Paketabhängigkeiten getrennt begrenzen. Der bestehende Vertrag zählt fünf genaue Referenzen und muss vor einer abweichenden UI-Regel angepasst werden.
- **Entwürfe:** Vollständiges Formular im gleichen Nutzer-/Workspace-/Zielkontext fortsetzbar halten; sieben Tage als Vorschlag. Nach Save oder bewusstem Verwerfen löschen; keine Secrets oder kurzlebigen Accountbelege speichern.
- **Startansicht:** Sechs bis acht sichtbare Treffer und etwa 30 Recents je Nutzer/Workspace als Startwerte; mit kleinen und großen Paketen prüfen.

Diese Werte sind Diskussionsvorschläge. Dieser Dokumentationscheckpoint ändert keine Produktgrenzen, Freigaben oder Ausführungsregeln.

Mein Vorschlag für die nächste gemeinsame Optimierung ist, zuerst **Paketvorauswahl und Zählung der Hauptchips samt Abhängigkeiten** festzulegen. Danach werden Chat- und Agent-Wireframe auf dieselben Regeln gebracht. Ergebnisanzahl und Aufbewahrungsdauer lassen sich anschließend anhand der Bedienung verfeinern. Die Planung trennt damit die wesentlichen Produktentscheidungen von einstellbaren Startwerten.
