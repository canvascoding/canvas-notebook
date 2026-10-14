# Gemeinsame Erweiterungsauswahl: Feedback und Besprechungsplan

Besprechungsstand: 14. Oktober 2026. Feedback und Plan wurden auf ausdrücklichen Wunsch zuerst in `docs` gesichert. Die folgende Produktansicht ordnet den inzwischen fortgesetzten Umsetzungsstand ein; einzelne Implementierungs- und Testnachweise stehen im verlinkten Journal. Die offenen Produktentscheidungen bleiben Vorschläge und gelten durch einen Umsetzungsauftrag nicht automatisch als bestätigt.

Dies ist die kurze Produktansicht. Weiterführend: [technischer Gesamtplan](chat-extension-reference-plan.md), [Umsetzungs-/Abnahmejournal](chat-agent-extension-implementation.md), [synthetischer Chat-Wireframe](wireframes/chat-extension-picker.html).

**Aktuelle UI-Präzisierung:** Auswahl direkt im Nachrichtentext als hervorgehobene Referenz mit Icon, keine zusätzliche Chat-Auswahlleiste. Löschen im Text entfernt die zusätzliche Referenz; nach dem Senden bleibt sie inline sichtbar. Kontext und genaue Zuordnung werden im Hintergrund übergeben. Der [konkrete Inline-Anschlussplan](chat-inline-reference-plan.md) ersetzt die frühere Chipdarstellung. Dropdown und gemeinsame `/`-Suche bleiben erhalten.

## Einschätzung

Die Richtung passt: **eine gemeinsame Suche und ein gemeinsames Referenz-/Kontextsystem für Plugins, Skills, Composio und MCP**. Ein Plugin bündelt Anleitung, Skills und deklarierte Verbindungen. Alle Bestandteile bleiben unabhängig auswählbar. Composio verwaltet Katalog und Werkzeuganbindung extern; in der UI bleiben dies „Integrationen“, getrennt von selbst angebundenen MCP-Servern. Der vorhandene lokale Aufrufweg verwendet auch das Composio-SDK; ein MCP-Transport wird nicht pauschal vorausgesetzt.

Der Stand ist **teilweise umgesetzt**. Plugin-Katalog, genaue Auswahlverträge, Agent-Schreibwege und gemeinsame Kontextaufbereitung sind als Grundlagen vorhanden. Gemeinsame Agent-Editoren sind eingecheckt und inzwischen mit frischem Build, 28 Browserfällen und anschließendem tatsächlichem Tool-Inspect lokal abgenommen. Der Chat verwendet weiterhin getrennte Plugin-/Skill-Listen mit Namen; gemeinsame Turn-Auswahl, Recents und durchgehend dauerhafte Zustellung fehlen. Die interne Aufnahmegrenze 4a ist lokal abgeschlossen: versionierte Speicherung, strenger Codec, vollständige Quellenprüfung und privater SQL-Wiederleser bestehen einschließlich nativer Konkurrenz- und Rollbackprüfungen. Der Dienst ist noch nicht an den tatsächlichen Chat, Queue und Runtime angeschlossen. Ein größerer Slash-Picker allein würde diese Unterschiede bestehen lassen.

Mein Feedback: **Die fachliche Richtung ist richtig; die durchgängige Übergabe im Chat ist die wichtigste Restlücke.** Wir sollten vorhandene Katalog-, Agent- und Kontextbausteine verbinden. Eigene Such- und Promptlogik pro Oberfläche würde dieselben Konto-, Versions- und Rechteprobleme erneut erzeugen. Die Quellwiederherstellung für gespeicherte Nachrichten (4b1) ist inzwischen implementiert und lokal mit echter SQL-Prüfung abgenommen. Sie ist weder ein fertiger Chat-Anschluss noch eine Ausführungsfreigabe. Der separate interne Ausführungsdienst 4b2 ist nun ebenfalls mit echter Runtime-Registrierung und nativer Zwei-Prozess-Konkurrenz lokal geprüft; sein tatsächlicher Chat-Anschluss folgt. Dieser Stand belegt auch keinen aktuellen Main- oder Produktionsrollout.

| Bereich | Aktueller lokaler Stand | Noch notwendig |
| --- | --- | --- |
| Plugin-Seite | Gemeinsamer Vier-Typen-Katalog und vorhandene Logoquellen umgesetzt | Dieselben Identitäten und Darstellungskomponenten in den weiteren Flächen verwenden |
| Agent-Erstellung und Agent-Tool | Gemeinsame Optionen, Auswahl und Vorschau; Tool/UI-Roundtrip lokal abgenommen | Beim Chat-Anschluss die feste Auswahl und die jeweiligen Nutzungsgrenzen erhalten |
| System-/Turn-Kontext | Gemeinsamer Resolver und registrierungsabhängige Tool-Rezepte vorhanden | Für jede tatsächlich gestartete Chat-Nachricht frisch und passend einsetzen |
| Nachrichtenannahme | Interne Annahme, frische Quellen, Ausführungsbesitz, Queue-Steuerung und atomisches Ersetzen geprüft | Versionierten Inline-Body und Wiederaufnahme ergänzen; tatsächliche Runtime, Queue und Transport anschließen |
| Chat-Suche | Bisher getrennte Skill-/Plugin-Einstiege | Gemeinsamer Picker, genaue Inline-Referenzen, Einrichtung mit Rückkehr und Recents |

## Gleiche Auswahl, erkennbare Wirkung

| Verwendung | Wirkung |
| --- | --- |
| Plugin-Seite: „Einrichten“ | Ressource installieren oder Verbindung einrichten; noch keine automatische Agent-Zuweisung. |
| Agent-Erstellung/-Bearbeitung: „Dauerhaft für diesen Agenten“ | Genaue Auswahl samt Grenzen speichern und bei jedem Start im geprüften Systemkontext berücksichtigen. |
| Chat: „Für diese Nachricht“ | Auswahl an diese Nachricht und ihren Lebenszyklus binden; keine dauerhafte Agent- oder Standardkontoänderung. |
| Gemeinsamer Agent: „Meine Verbindung“ | Die ausdrücklich erlaubte persönliche Kontowahl des aktuellen Nutzers speichern. |
| Aufgabe ohne Referenz | Erlaubte Skills bedarfsgerecht suchen und autorisiert laden; keine automatische Installation oder Kontowahl. |

UI und Agent-Tool verwenden dieselben serverseitigen Optionen, Schreibverträge und Inspect-Ergebnisse. Paketstand, Kind-Skill, konkrete Verbindung, Bereich und Werkzeuggrenzen bleiben beim Roundtrip erhalten. Anzeigenamen sind keine Identitäten. Reine Profiländerungen behalten die Erweiterungsauswahl; Ersetzen benötigt die aktuelle Ausgangsrevision.

Das gemeinsame System teilt Ressourcenidentität, Metadatensuche, Details, Icons und Kontextcompiler. Die Suchansichten berücksichtigen ihren jeweiligen Zweck: Der Katalog darf ein noch nicht eingerichtetes Angebot zeigen, der Chat darf es erst nach erforderlicher Einrichtung als nutzbare Auswahl übernehmen. Eine im Katalog lesbare Integration ist nicht automatisch für jeden Agenten freigegeben. Ressourcenrechte, Agent-/Toolgrenzen und gewählter Account werden serverseitig durchgesetzt; Prompttext erweitert sie nicht.

Für die Agent-Erstellung ist ein gemeinsamer Abschnitt **„Erweiterungen und Werkzeuge“** vorgesehen. Die gemeinsame Suche bietet die vier Erweiterungstypen an. Die daraus verfügbaren Werkzeuge und die nativen Werkzeuge sollen zusätzlich mit ihren effektiven Grenzen sichtbar sein; Anpassungen und die Kontextvorschau öffnen unter „Erweitert“. Das Agent-Tool verwendet dieselbe vollständige Konfiguration und kann sie über Inspect zurücklesen.

## Progressive Disclosure

1. **Finden:** Ein Suchfeld, gemischte Treffer und optional „Filtern“. Ohne Eingabe zuletzt akzeptierte explizite Chat-Auswahlen; ohne Historie als Vorschläge bezeichnete Einträge. Beim Tippen Relevanz zuerst, letzte Nutzung nachrangig. Filter erhalten den Suchtext.
2. **Verstehen:** Logo, Name, Typ, kurzer Nutzen und ein handlungsrelevanter Status je Zeile. Plugin-Details zeigen enthaltene Skills und notwendige/optionale Verbindungen. Erst hier erscheinen Konten; auch ein einziges Konto bleibt vor Bestätigung sichtbar.
3. **Anpassen:** Bestandteile, Profil-/Kontowahl sowie bei Bedarf Werkzeuggrenzen und Kontextvorschau. Fehlende Pflichtverbindungen werden sofort erklärt; technische Diagnose bleibt aufklappbar.

Composio verwendet das Toolkit-Logo aus den API-Metadaten. Eigene MCPs verwenden die vorhandene geprüfte Domain-Iconquelle, Plugins/Skills ihre mitgelieferten Icons. Fehlt ein Bild oder lädt es nicht, erscheinen Namensinitialen. Das gilt auch nach erneutem Öffnen gespeicherter Auswahlen; Logoanzeige löst keine Account- oder Providerprüfung aus.

Ein Logo kennzeichnet die App, nicht das Konto. Account, Profil und Bereich bleiben deshalb zusätzlich als zulässige Textmetadaten sichtbar. Fehlt ein lesbarer Kontoname, lautet die Anzeige beispielsweise „Gespeichertes persönliches Konto · Profil Arbeit“; die UI erfindet weder Kontonamen noch einen Gesundheitsstatus. Pro Treffer erscheint zunächst die wichtigste erforderliche Aktion; weitere Zustände stehen in den Details. Nicht lesbare Ressourcen bleiben verborgen. Fehlendes Nutzungsrecht, fehlende Einrichtung und ein erreichbarkeitsbezogener Fehler erhalten unterschiedliche Hinweise.

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

Erstelle mit [Icon Content Studio] einen Entwurf.       [Senden]
```

Die feste Auswahl eines Spezialagenten bleibt in dessen vorhandenen Details sichtbar. Sie erzeugt keine zusätzliche Ressourcenleiste über dem Composer:

```text
Gewählter Agent: Content Studio                       [Details]
Recherchiere mit [Icon Recherche] die Grundlagen.       [Senden]
```

Eine Inline-Referenz entfernt oder ersetzt keine dauerhafte Zuweisung. Für einen zulässigen Kontowechsel wird die konkrete Paketanforderung geändert und sichtbar bestätigt; eine weitere Canva-Referenz allein überschreibt keine bestehende Bindung. Löschen im Text entfernt die zusätzliche Turn-Referenz; bei mehreren gleichen Vorkommen bleibt sie bis zum letzten erhalten. Ein neuer Turn übernimmt alte Referenzen nur nach erneuter ausdrücklicher Auswahl. Interne Fortsetzungen derselben Nachricht behalten deren ursprüngliche Auswahl.

Nachrichten bleiben voneinander getrennt: Wird B mit einem anderen Plugin oder Konto eingereiht, behält der laufende Auftrag A seinen bisherigen Kontext und seine Werkzeuge. Auch eine als Steer vorgezogene Nachricht übernimmt erst nach Abschluss der laufenden Toolarbeiten und bestätigter Abwicklung von A. Die UI zeigt bis dahin „wartet auf laufende Aktion“.

Zwei Fälle müssen unterschiedlich bedient werden: Eine neu angeheftete Plugin-Auswahl mit fehlender Pflichtverbindung bleibt ein markierter Entwurf; Senden zeigt den genauen Einrichtungsweg. Bei einem bereits eingerichteten gemeinsamen Agenten mit noch fehlender zulässiger persönlicher Wahl bleibt erlaubter lokaler Chat möglich; externe Workflow-Aktionen bleiben gesperrt und „Meine Verbindung einrichten“ bleibt sichtbar.

Die überarbeitete HTML-Demo zeigt Inline-Einfügen, Löschen im Text und dieselbe Hervorhebung in der gesendeten Nachricht. Auch eine einzelne Verbindung wird vor dem Einfügen bestätigt; ein Plugin zeigt seine erforderliche Verbindung. Die Demo verwendet Beispieldaten und simulierte Recents. Sie ist kein Nachweis des noch offenen Produkt-Codecs, Transportwegs oder Modells; echte Historie und Annahmestatus benötigen weiterhin ihre eigene Abnahme.

## Präziser System-/Nachrichtenkontext

Die gemeinsame serverseitige Aufbereitung liefert einen kompakten Index: geprüfter Paketstand, relevante Plugin-Anleitung, zugehörige ausgewählte Skills, genaue autorisierte Lesepfade und tatsächlich vorhandene Tool-Suchwege. Vollständige Skill-Anleitungen und Werkzeugschemas werden bei Bedarf geladen. Für MCP und Composio führt das Rezept über die genaue ausgewählte Provider-/Verbindungsreferenz zu Toolsuche, Schema und anschließend demselben Toolaufruf. Konten werden nicht stillschweigend ersetzt.

Das konkrete Rezept wird aus dem tatsächlichen Toolmanifest erzeugt: den ausgewählten Skill über den autorisierten `read`-Weg lesen; weitere zulässige Skills über `search_canvas_extensions` direkt oder dessen registriertes Gateway finden; MCP-/Composio-Tools über `integrations` mit der genauen `providerRef` suchen, die zurückgegebene `toolRef` beschreiben und dieselbe `toolRef` samt aktueller `schemaRef` aufrufen. Ist der jeweilige Weg nicht registriert oder nicht erlaubt, sagt der Kontext das ausdrücklich. Der experimentelle Router darf daher keine geratenen Toolnamen und keinen Ausweichaccount verursachen.

Beim Spezialagenten gehört der feste Index zu jedem Start. Im allgemeinen Chat ergänzt eine ausdrückliche Referenz den jeweiligen Turn. Core-/Pflichthinweise und natürliche Skill-Suche bleiben erhalten. Bestehende Vererbung wird sichtbar erhalten und ausdrücklich migriert. Die Ausgabe berücksichtigt registrierte Tools und den tatsächlichen Routerzustand; Prompttext erteilt keine Rechte.

Feste Agent-Auswahl und zusätzliche Turn-Auswahl werden gemeinsam gegen das bestehende 8-KiB-Kontextbudget geprüft. Optionaler Beschreibungstext darf gekürzt werden; Identitäten, notwendige Zuordnungen und erforderliche Suchwege bleiben erhalten. Passt der notwendige Kontext nicht, bekommt der Nutzer vor Annahme eine verständliche Aufforderung, die Auswahl zu reduzieren. Eine bestandene Vorschau zweier getrennt betrachteter Auswahlen genügt dafür nicht.

## Reihenfolge und Abschluss

| Schritt | Ergebnis | Fertig, wenn |
| --- | --- | --- |
| 1. Vorhandene Agent-Auswahl als Grundlage erhalten | Gemeinsamer Editor in Create, Edit und persönlicher Wahl; vollständige Agent-Tool/UI-Parität. Diese Stufe ist lokal abgeschlossen. | Die bestehende Abnahme bleibt erhalten; Chat-Verwendung verändert keine feste Konfiguration oder fremde persönliche Wahl. |
| 2. Nachrichtenweg schließen | Dauerhafte Annahme und privater Wiederleser, danach Runtime, Queue, Draft, Send, Steer, Retry, Handoff und Verlauf anschließen. | Reload und Serverneustart separat geprüft; gleiche Nachrichten-ID mit gleicher Auswahl wird wiedererkannt. Verlorene Bestätigung wiederholt keine möglicherweise begonnene Geschäftsaktion automatisch. |
| 3. Chat-Picker und Recents anschließen | `/` und Kontextknopf öffnen dieselbe Suche mit Filtern, Details und Inline-Referenzen; zuletzt verwendete Einträge aus dauerhaft angenommenen expliziten Auswahlen. | Alle vier Typen, gleiche Namen, einzelne und mehrere Konten, Tastatur und Rückkehr aus Einrichtung funktionieren. Paketabhängigkeiten und Auswahlgrenzen sind vor Bestätigung verständlich. |
| 4. Gesamten Web-/Modellweg abnehmen | Produktionsbuild, echte UI-Bedienung und Modelllauf mit Skill-Lesen und gezielter Discovery. | Kontextwechsel, Rechteentzug, Accounttreue, Routerzustände und Wiederaufnahme nachgewiesen; API-, Browser-, Modell- und Providerbelege getrennt. |
| 5. Native Flächen anschließen | Gemeinsame Verträge im eigenen nativen Composer und Agent-UX verwenden. | Eigene Geräte-/Accessibility-Abnahme; schmaler Browser ersetzt sie nicht. |

Jeder Integrationsschritt wird abgeschlossen, bevor der nächste beginnt. **Die Agent-Stufe ist lokal abgeschlossen:** frischer Produktionsbuild, alle 28 Browserfälle und unabhängiger tatsächlicher Tool-Inspect bestehen im Lauf `3qFxAz`. Für die Chat-Stufe ist die interne dauerhafte Nachrichtenannahme abgeschlossen; als Nächstes folgen Runtime/Transport und danach der sichtbare Picker. Diese Reihenfolge verhindert, dass die UI eine Auswahl anbietet, die der heutige Transport verwirft. Chat, tatsächlicher Modelllauf und Native Mobile bleiben offen; der Gesamtplan ist nicht abgeschlossen.

Vor Schritt 2 werden vier Vertragsfragen verbindlich präzisiert: eigenes Chat-Turn-Ziel mit Use- statt Edit-Rechten und tatsächlichem Session-/Workspace-Kontext; explizite Slot-/Revisionszuordnung bei erlaubtem Turn-Accountwechsel; gemeinsames 8-KiB-Budget aus fester und zusätzlicher Auswahl; neue strukturierte Inline-Bodies durch denselben dauerhaften Annahmepfad führen; alte reine Namen bleiben ohne neue Autorität. Eine weitere Kontoreferenz allein überschreibt keine Plugin-Bindung.

Schritt 2 wird intern in überprüfbare Teile zerlegt: gespeicherte Auswahl mit frischen Rechten wiederlesen und exklusiven Ausführungsbesitz samt Revision sichern (beide intern lokal geprüft); dann die bestehende Runtime und Queue anschließen; anschließend Transport und Composer. Jede Nachricht behält ihre eigene Server-ID, ihren Paketstand und ihre konkreten Accounts. Sicher unbegonnene Aufträge können nach erneuter Prüfung wiederaufgenommen werden. Bei möglicherweise bereits ausgeführten Geschäftsaktionen wird der ungewisse Zustand angezeigt und nicht automatisch erneut ausgeführt. Reload, tatsächlicher Serverneustart und verlorene Send-Bestätigung benötigen jeweils einen eigenen Nachweis.

Die interne Queue-Steuerung ist inzwischen ebenfalls lokal mit tatsächlichem PostgreSQL geprüft: Vorziehen stellt ältere wartende Nachrichten atomar zurück; Fortsetzen betrifft ausdrücklich benannte unbegonnene Aufträge; Entfernen cancelt genau die erwarteten Versionen. Die bestehende sichtbare RAM-/SDK-Queue verwendet diese Dienste noch nicht. Alte reine Zustellbestätigungen und `outcome_unknown` sperren die automatische Folgeausführung. Der spätere Nutzerweg muss den blockierenden Auftrag erklären und eine neue Sitzung oder einen eigenen ausdrücklichen Auflösungsschritt anbieten.

Queue-Aktionen haben eindeutige Wirkungen: „Vorziehen“ ändert die Zustellreihenfolge derselben Nachricht; „Entfernen“ cancelt den wartenden Auftrag; „Bearbeiten und ersetzen“ nimmt einen neuen Auftrag auf und cancelt die betroffenen wartenden Aufträge gemeinsam. Erst die dauerhafte Bestätigung ändert die sichtbare Queue. Eine bereits vom SDK abgeholte, inzwischen entfernte Nachricht muss vor dem Modellstart ebenfalls gestoppt werden. „Abgebrochen“ bestätigt den Ausführungszustand und behauptet keine Rücknahme früherer Geschäftsaktionen.

Für die abschließende Abnahme zählt die gesamte Kette: UI-Auswahl → dauerhafte Annahme → passender System-/Turn-Kontext → tatsächliches Skill-Lesen beziehungsweise gezielte Toolsuche. Hinzu kommen unterschiedliche Konten in aufeinanderfolgenden Nachrichten, Queue/Steer, Rechteentzug, Paketupdate mit gehaltenem alten Stand, Routerzustände und defekte Icons. Ein Prompt-Snapshot allein beweist keine erfolgreiche Modellnutzung; lokale Provider-Fixtures beweisen keine produktive Canva-/LinkedIn-/Shopify-Erreichbarkeit.

## Vorschläge zur anschließenden Optimierung

- **Plugin-Vorauswahl:** Tatsächlich deklarierten Standard zeigen; sonst alle zulässigen Bestandteile anbieten. Optionale Abwahl aufklappen, Pflichtbestandteile erhalten.
- **Auswahlgrenze:** Fünf sichtbare Hauptauswahlen vorschlagen und Paketabhängigkeiten getrennt begrenzen. Der bestehende Vertrag zählt fünf genaue Referenzen und muss vor einer abweichenden UI-Regel angepasst werden.
- **Entwürfe:** Vollständiges Formular im gleichen Nutzer-/Workspace-/Zielkontext fortsetzbar halten; sieben Tage als Vorschlag. Nach Save oder bewusstem Verwerfen löschen; keine Secrets oder kurzlebigen Accountbelege speichern.
- **Startansicht:** Sechs bis acht sichtbare Treffer und etwa 30 Recents je Nutzer/Workspace als Startwerte; mit kleinen und großen Paketen prüfen.
- **Recents erneut verwenden:** Frühere Paketversion, Kind-Auswahl und Kontozuordnung anzeigen, frisch prüfen und bestätigen. Kein stiller Wechsel auf aktuelle Paketvorgaben oder ein anderes Standardkonto. Typfilter gelten auch in dieser Startansicht. Hover, bloßes Öffnen und Agent-Speichern zählen nicht als Chat-Nutzung.
- **Wiederaufnahme:** Vorschlag für den ersten Ausbau: Nach tatsächlichem Serverneustart sicher wartende Nachrichten anzeigen und mit „Fortsetzen“ nach frischer Prüfung starten. Ein Browser-Reload unterbricht einen weiterhin laufenden Serverauftrag nicht. Bei ungewissem Ausgang zuerst Verlauf und bekannte Toolergebnisse öffnen; ein erneuter Auftrag benötigt eine ausdrückliche neue Send-Aktion und darf keine stillschweigende Wiederholung sein. Ob sicher wartende Nachrichten später automatisch fortgesetzt werden, bleibt eine eigene Produktentscheidung.

Diese Werte sind Diskussionsvorschläge. Dieser Dokumentationscheckpoint ändert keine Produktgrenzen, Freigaben oder Ausführungsregeln.

Mein Vorschlag für die nächste gemeinsame Optimierung ist, zuerst **Paketvorauswahl und Zählung der Hauptreferenzen samt Abhängigkeiten** festzulegen. Danach werden Chat- und Agent-Wireframe auf dieselben Regeln gebracht. Ergebnisanzahl und Aufbewahrungsdauer lassen sich anschließend anhand der Bedienung verfeinern. Die Planung trennt damit die wesentlichen Produktentscheidungen von einstellbaren Startwerten.
