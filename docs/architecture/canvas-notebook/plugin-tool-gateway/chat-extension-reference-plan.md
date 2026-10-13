# Einheitlicher Erweiterungskontext für Chat und Agenten

Stand: 13. Oktober 2026. **Vorschlag zur Besprechung; Chat-Suche und neue Agent-Konfiguration noch nicht implementiert.** Quellenbasis der erweiterten Bestandsaufnahme: Notebook `a99553e7f2d4456fe272c9ac5994c6b39412189b`. Der separat beauftragte MCP-Icon-Nachtrag verändert diese Verträge nicht. Dieser Plan wird zunächst gemeinsam optimiert; seine Speicherung ist kein Auftrag zur Umsetzung.

Nachfolgend wurde die Umsetzung mit abschließender E2E-Prüfung ausdrücklich beauftragt. Der aktuelle [Umsetzungs- und Abnahmestand](chat-agent-extension-implementation.md) dokumentiert die Schritte, offenen Anforderungen und tatsächlichen Nachweise; der folgende Text bleibt der Zielvertrag.

## Entscheidungsvorschlag

`/` öffnet einen gemeinsamen Erweiterungs-Picker für **Plugins, Skills, Composio-Integrationen und direkte MCP-Server**. Ohne Suchtext stehen die zuletzt im aktuellen Workspace im Chat verwendeten Einträge zuerst. Tippen durchsucht alle vier Typen; optionale Typfilter schränken dieselbe Suche ein. Die Auswahl wird als konkrete Referenz an die Nachricht gebunden. Der Server prüft sie beim Senden und vor der späteren Ausführung erneut und gibt dem Agenten einen kurzen, präzisen Nutzungskontext.

**Dieselbe Auswahl und derselbe Kontextresolver sollen auch die Erstellung und Bearbeitung von Agenten tragen.** Ein Spezialagent erhält seine fest konfigurierten Erweiterungen bei jedem Start im Systemkontext. Im allgemeinen Chat entstehen zusätzliche Paket-/Verbindungshinweise durch ausdrücklich referenzierte Erweiterungen. Ohne Referenz kann der Agent weiterhin passende Skills suchen und deren Anleitung bei Bedarf laden.

Der vorhandene [Pluginseiten-Katalog](plugin-page-integration-catalog-plan.md) liefert die gemeinsame Suchgrundlage. Die jeweilige Projektion ergänzt die tatsächliche Nutzbarkeit für Chat beziehungsweise Agent-Konfiguration. Auswahl, Paketinstallation, Account-Autorisierung und Agent-Freigabe bleiben separate Entscheidungen. Für diesen Plan wird der globale Tool-Router nicht vorausgesetzt.

Der [klickbare Wireframe](wireframes/chat-extension-picker.html) zeigt Recents, eine gemischte Canva-Suche, optionale Typfilter, Accountauswahl und Nachrichtenchips. Er ist eine eigenständige HTML-Demo mit synthetischen Beispielen und ohne API-Aufrufe. Seine Initialen vertreten die späteren verfügbaren Logos. Eine Demo-Nachricht aktualisiert nur die lokale Reihenfolge; sie sendet keinen echten Chat-Auftrag.

## Was heute schon vorhanden ist und was fehlt

| Bereich | Aktueller Stand | Erforderliche Ergänzung |
| --- | --- | --- |
| `/`-Popup | Plugins und Skills; getrennte alte Listen, namensbasierte Treffer | Alle vier Typen aus demselben Katalog; genaue Referenzen statt Zusammenlegung gleicher Namen |
| Auswahl im Composer | Schreibt nur `/name` in den Text | Sichtbarer entfernbarer Kontextchip mit strukturierter Ressourcen-/Verbindungsauswahl |
| Reihenfolge | Kurze Namen/alphabetisch bei leerer Suche | Letzte bestätigte Chat-Verwendung; bei Suchtext Relevanz zuerst |
| Transport | Bekannte Felder werden ausdrücklich normalisiert | Auswahl in Send-Snapshot, WebSocket/HTTP, Queue, Retry und Entwürfen erhalten |
| Plugin-Kontext | Beschreibung, Default-Prompts, enthaltene Skills und deklarierte Connector-Hinweise für `/name` | Exakte veröffentlichte Quelle, relevante Kinder, tatsächliche Verbindung und konkreter Tool-Suchweg |
| Skill-Kontext | Kurze Beschreibung plus autorisierter `SKILL.md`-Lesepfad | Ausgewählten Skill und Plugin-Herkunft eindeutig erhalten |
| Runtime | Frische Ressourcen-/Verbindungsrechte, versionierte Bindungen und gemeinsamer Gateway vorhanden | Auswahl daran anschließen, ohne Rechte zu erweitern |
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

Die Agent-Persistenz erweitert den bestehenden Capability-/Workflow-Vertrag und dessen Bindungen. Es entsteht kein zusätzlicher unabhängiger Skill-/Tool-Speicher in Promptdateien. Heute akzeptiert die private Bindungskonfiguration nur Paket-Workflowdaten; für exakte Standalone-Verbindungen ist deshalb eine versionierte Schemaerweiterung samt Migration erforderlich. Vorhandene Workflow-V1-Pins und persönliche Auswahlregeln bleiben über einen geprüften Adapter erhalten. Eine unabhängige Verbindung wird nicht als erfundene Plugin-Deklaration gespeichert.

### Ein serverseitiger Resolver

Vorgeschlagen ist ein gemeinsamer `resolveEffectiveExtensionContext`-Dienst. Er nutzt die vorhandenen Paket-, Workflow-, Verbindungs- und Runtime-Policy-Dienste und liefert einen abgeleiteten, privaten Selektionsstand mit Fingerprint:

- genaue Ressourcen, Paketversionen und Kindidentitäten;
- ausgewählte konkrete Verbindungen beziehungsweise erlaubte persönliche Auswahl;
- autorisierte Skill-Lesepfade, Herkunft und kurze Anleitung;
- Einrichtungs-/Nutzbarkeitsstatus und zulässige Tool-Grenzen;
- Suchrezepte ausschließlich für tatsächlich registrierte Tools;
- kompakte Ausgabe für System-/Turn-Kontext sowie eine sichere Vorschau für den Nutzer.

Systemprompt, Skill-Readroots und Toolhinweise verwenden denselben abgeleiteten Selektionsstand. Die tatsächlichen Tool-Grenzen ergeben sich weiterhin aus der Schnittmenge von Ressourcenrechten, Agent-Konfiguration, nativen `enabledTools`, Delegation und Laufmodus. Der Fingerprint hilft, widersprüchliche Stände zu erkennen; er ersetzt **nicht** die frischen Rechte-/Bindungsprüfungen beim Lesen, Beschreiben und Ausführen.

Heute werden Teile dieser Autorität gemeinsam verwendet, aber Promptloader, Readroots und Gateway-Policy lösen teilweise getrennt auf. Der gemeinsame Resolver ist deshalb ein konkreter Implementierungsschritt. Ein langfristig gecachter Promptsnapshot darf niemals eine spätere Ausführung autorisieren.

## Kontextregeln für allgemeine und spezialisierte Agenten

### Spezialagent: feste Zuweisung immer vorhanden

Neue Spezialagenten verwenden eine ausdrücklich feste Erweiterungsauswahl. Ihr Systemkontext enthält bei jedem Start die konfigurierten Plugins, Skills und Verbindungen: Zweck, genaue Herkunft, ausgewählte Plugin-Kinder, Skill-Lesepfade und den konkreten Tool-Suchweg. Plugin-Anforderungen und tatsächlich gebundene Accounts werden getrennt benannt. Ein MCP-Ausfall entfernt keine weiterhin zulässige lokale Skill-Anleitung.

„Immer vorhanden“ bedeutet einen kompakten Index und die passende geprüfte Paketanleitung. Vollständige Skilltexte und Toolschemas werden bei Bedarf geladen. Ein Plugin kann als Paket ausgewählt werden; seine zugelassenen Bestandteile werden daraus nachvollziehbar abgeleitet. Ein Kind kann außerdem gezielt ausgewählt oder ausgeschlossen werden, soweit Pflichtbestandteile und Paketregeln das erlauben. Eine zusätzliche Standalone-Auswahl desselben Kindes wird über die genaue Herkunft dedupliziert.

Diese Teilmengenauswahl benötigt eine ausdrückliche Normalisierung: Workflow V1 unterscheidet heute ganzes Plugin und ausgewählte Skills; beim zweiten Modus werden Plugin-Root-Deklarationen nicht einfach mitgeführt. Der neue Vertrag muss Elternanforderungen erhalten, während optionale Kinder abgewählt werden. Die UI darf keine Teilmengenauswahl anbieten, die erforderliche Connector-/Skill-Deklarationen des Elternpakets still entfernt.

Ein Slash-Chip beim Spezialagenten fokussiert einen bereits zulässigen Bestandteil. Er erweitert dessen feste Auswahl nicht. Eine andere Verbindung kann nur gewählt werden, wenn die gespeicherte Konfiguration genau diese Wahl erlaubt. Für nicht erlaubte Erweiterungen zeigt die UI den berechtigten Weg zur Agent-Konfiguration oder zum allgemeinen Chat.

Bei Organisationsagenten kann eine Verbindung fest gemeinsam bereitgestellt oder als ausdrücklich erlaubte persönliche Auswahl konfiguriert werden. Im zweiten Fall löst jeder ausführende Nutzer seine eigene zulässige Wahl auf. Das private Konto des Erstellers wird nicht stillschweigend für alle Mitglieder hinterlegt. Fehlende notwendige Einrichtung wird vor Nutzung angezeigt; optional fehlende Bestandteile blockieren keine unabhängigen erlaubten Fähigkeiten.

### Allgemeiner Chat: gezielt referenzieren oder Skills suchen

Der allgemeine Systemprompt enthält die gemeinsame Discovery-Anleitung sowie unverzichtbare Core-/Pflichthinweise. Er erhält künftig nicht automatisch den vollständigen Katalog sämtlicher aktivierter Skills. Detaillierter Plugin-/MCP-/Composio-Auswahlkontext entsteht durch die expliziten Referenzen des aktuellen Turns.

Ohne Slash darf der Agent aufgrund der Aufgabe nach einem passenden **bereits zulässigen Skill** suchen, dessen genaue Quelle auflösen und `SKILL.md` vor Nutzung lesen. Das erzeugt keinen dauerhaften Agent-Bindingeintrag und keine automatische App-/Accountauswahl. Ein gefundenes Store-Angebot oder eine ungebundene Integration ist ein Einrichtungsvorschlag, keine Ausführungsfreigabe.

Es gibt bereits Management-Read-Discovery: `inspect_canvas_resource` sucht lesbare installierte Ressourcen; `list_canvas_package_store` umfasst zusätzlich Angebote. `canvas_extensions.search` sucht heute Managementoperationen. Keine dieser Suchen liefert allein die gewünschte auf den effektiven Agenten begrenzte Skill-/Plugin-Nutzbarkeit; `integrations` deckt MCP/Composio ab. Der Plan ergänzt daher eine **ausdrücklich neue** read-only Runtime-Suchoperation auf denselben Katalogdiensten, vorzugsweise über das vorhandene `canvas_extensions`-Gateway. Name und endgültiges Schema werden in Schritt 1 festgelegt; es wird keine bereits vorhandene All-in-one-Toolsuche behauptet.

Diese Operation durchsucht Name, kurze Beschreibung und Paket-/Kindherkunft, einschließlich geprüfter Manifestbeschreibungen. Sie gibt genaue zulässige Referenzen, kurze Beschreibungen und den Leseschritt zurück. Beim Spezialagenten bleibt sie auf dessen feste effektive Auswahl begrenzt. Im Planungsmodus ist die sichere Metadatensuche ausdrücklich erlaubt; externe Accountprobes und Ausführung bleiben ausgeschlossen. Suche führt keine Provider-Gesundheitsprüfung als Voraussetzung für lokal verfügbare Skills durch.

### Bestehende Agenten ausdrücklich migrieren

`relevantSkills: null` bedeutet heute Vererbung aller verfügbaren Skills; `enabledTools: null` kann native Tools erben. Diese Bedeutungen werden nicht stillschweigend in eine leere feste Auswahl geändert. Die Migration zeigt den bisherigen Modus, leitet eindeutige alte Ressourcen ab und verlangt für mehrdeutige Skillnamen beziehungsweise `connection:<name>` eine konkrete Wahl. Gehaltene Workflow-V1-Versionen werden übernommen, ohne auf einen neuen veröffentlichten Stand zu wechseln.

Die neue Oberfläche zeigt deshalb ausdrücklich **feste Auswahl** beziehungsweise **bestehende Vererbung**. Neue Spezialagenten beginnen mit fester Auswahl plus verpflichtender Basis. Bestehende Vererbung bleibt bis zur bewussten Umstellung erhalten und wird nicht als bereits präzise zugeordnete Verbindung dargestellt.

## Agent-Erstellung und Bearbeitung mit Progressive Disclosure

Der Bereich heißt **„Erweiterungen und Werkzeuge“**. Erstellung und spätere Bearbeitung bieten denselben gemeinsamen Picker. Kein separates Skill-, MCP- und Composio-Suchfeld:

1. **Erste Ebene:** eine Suche, optionale Typfilter und die ausgewählten Pakete/Einzelbestandteile als kurze Liste mit Logo oder Initialen. Bei leerer Suche zuletzt verwendete, in diesem Konfigurationskontext zulässige Einträge; bei Suche Relevanz zuerst. Pflichtbestandteile sind sichtbar und erklärt.
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

Ein Entwurf ist kein ausführbarer, vollständig eingerichteter Agent. Ob fehlende notwendige Einrichtung einen nicht startbaren gespeicherten Agenten oder einen reinen Formularentwurf erzeugt, wird vor Implementierung am bestehenden Readiness-/Startvertrag festgelegt; die UI darf keinen fertigen Zustand behaupten. Die Skizze bezeichnet diesen noch festzulegenden Zustand ausdrücklich als Entwurf.

Betroffene bestehende Komponenten: [CreateAgentDialog](../../../../app/components/settings/CreateAgentDialog.tsx), [EditAgentProfileDialog](../../../../app/components/agents/EditAgentProfileDialog.tsx), [AgentSettingsPanel](../../../../app/components/settings/AgentSettingsPanel.tsx), [ChatAgentSelector](../../../../app/components/canvas-agent-chat/ChatAgentSelector.tsx), [PackageAgentSetup](../../../../app/components/plugins/PackageAgentSetup.tsx), [AgentWorkflowManagementDialog](../../../../app/components/agents/AgentWorkflowManagementDialog.tsx), [WorkflowPackageSelectionSection](../../../../app/components/agents/WorkflowPackageSelectionSection.tsx), [WorkflowCapabilityBindingSection](../../../../app/components/agents/WorkflowCapabilityBindingSection.tsx) und die vorhandenen Account-Choice-Picker. Gemeinsame Picker-/Auflösungslogik ersetzen doppelte Optionen; bestehende exakte Workflow-Auswahl wird integriert.

### Derselbe vollständige Vertrag im Agent-Tool

`create_agent`, `update_agent_configuration`, POST und PATCH der Agent-API werden künftig dieselben vollständigen serverseitigen Schema-, Auswahl-, Readiness- und Berechtigungsdienste verwenden. Der endgültige Create-Vertrag akzeptiert den vollständigen versionierten Erweiterungsstand einschließlich genauer Paketpins, Standalone-Verbindungen und erlaubter Wahl-/Toolgrenzen. Agent und Bindungen werden atomar gespeichert. Eine Fehlerantwort darf keinen unvollständigen ausführbaren Agenten zurücklassen.

Vor dem Aufruf erhält der erstellende Agent auswählbare, servergelieferte Referenzen über dieselbe Optionsprojektion wie die UI. Vorhandene `list_agent_workflow_options` und persönliche Choice-Discovery werden für Paketbindungen weitergenutzt; Standalone-Optionen werden über den gemeinsamen Vertrag ergänzt. Anzeigenamen, Toolkit-Slugs oder selbst erfundene `providerRef`-Strings reichen nicht als Accountbindung. Persönliche Account-Probes bleiben ein ausdrücklicher Schritt und im Planungsmodus ausgeschlossen.

Die heutige Workflow-Optionsprojektion verlangt einen bereits vorhandenen Agenten und dessen Revisionen. **Vor Create** braucht es deshalb zusätzlich eine geplante Options-API und entsprechende Tooloperation für einen noch nicht gespeicherten Zielkontext: Zielbereich, vom Server geprüfter Eigentümer-/Organisationskontext und Workspace. Diese Dry-run-Projektion legt keinen provisorischen ausführbaren Agenten an. Auswahlreferenzen werden an den zulässigen Zielkontext gebunden und bei atomarem Create erneut geprüft. **Nach Create** verwendet der gleiche Optionsdienst die echte Agent-ID und aktuellen Revisionen.

Create/Update geben den kanonischen gespeicherten Stand, Revisionen und Einrichtungsergebnisse zurück. Update behält die vorhandene atomare Revisionsprüfung. Tool-seitig erstellte Agenten müssen in der UI exakt gleich aussehen; UI-Änderungen müssen über Inspect/Workflow-Tools denselben Stand zurückgeben. Freigaben für den Agenten und Freigaben für seine Ressourcen werden getrennt geprüft: ein teilbarer Agent macht ein persönliches Konto nicht automatisch teilbar.

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

Vor der Navigation zur Einrichtung wird der scoped Nachrichtenentwurf erhalten. Die Rückkehr verweist auf denselben Benutzer, Workspace, Agenten und Chat beziehungsweise Entwurf und den genauen Katalogeintrag; Credentials und Authzustände gehören nicht in diesen Link. Ein OAuth-Rückkehrmarker beweist keine Autorisierung. Erst die frisch bestätigte konkrete Verbindung darf anschließend ausgewählt werden; ein Wechsel zu einem anderen Standardkonto bleibt ausgeschlossen.

### 3. Auswahl als Nachrichtenkontext

Nach Auswahl bleibt ein entfernbarer Chip am Composer, etwa **Canva · Integration · Team Design**. Text und strukturierte Auswahl sind getrennt. Nur die tatsächlich angehefteten Chips bilden den expliziten Kontext der nächsten Nachricht; frei eingegebene Namen erzeugen keine verdeckte Account-Auswahl.

Ein Chip allein sendet keinen Auftrag. Der bestehende Vertrag bleibt bestehen: Nachrichtentext oder Attachment ist erforderlich. Eine Auswahl ohne anschließenden akzeptierten Auftrag verändert die Recents nicht; Plugin-Default-Prompts werden nicht ungefragt als Nachricht abgeschickt.

Pfeiltasten navigieren, Enter/Tab wählen, Escape schließt. Fokus und aktive Option sind für Screenreader erkennbar; IME-Komposition darf keine versehentliche Auswahl auslösen. Auf schmalen Webansichten nutzt derselbe Picker die verfügbare Breite; weiterführende Verbindungsauswahl darf als Sheet erscheinen.

Ältere `/skill-name`-/`/plugin-name`-Texte bleiben kompatibel, soweit sie im aktuellen zulässigen Kontext eindeutig sind. Mehrdeutige Namen benötigen eine konkrete Auswahl. Neue Nachrichten und Verlaufchips verwenden die gespeicherte genaue Herkunft und Version; sie werden nicht nachträglich aus dem heutigen Namenskatalog rekonstruiert.

## Such- und Referenzvertrag

Vorgeschlagen ist eine authentifizierte Chat-Projektion **`GET /api/chat/extensions/search`**. Der Endpoint verwendet die vorhandenen Katalogdienste und ergänzt Session-/Agent-Nutzbarkeit; er baut keinen zweiten Composio- oder MCP-Katalog.

Anfrage: aktueller `workspaceId`, zulässiger `agentId`, optional `sessionId`, `q`, `types`, begrenztes `limit` und gebundener `cursor`. Actor, Session-Eigentum und effektiver Agent werden serverseitig geprüft. Antwort: dieselben vier Kinds, sichere Logos, Quellenabdeckung und Pagination; außerdem `recent`/`suggested`-Kennzeichnung und eine zulässige Aktion `select`, `setup` oder `unavailable`. Menschliches `canRead` auf der Plugin-Seite ist allein kein Agent-Use-Recht.

Der gemeinsame `ExtensionSelection`-Vertrag bekommt eine versionierte Nachrichtenhülle `ChatExtensionSelection` und eine persistente Agent-Konfigurationshülle. Die Identitäten sind in beiden gleich; Dauer, Konfigurationsrevisionen und erlaubte Account-Wahl unterscheiden sich:

- **Plugin/Skill:** diskriminierter Typ, `resourceRef`, erwartete veröffentlichte Revision/Checksumme; bei enthaltenem Skill zusätzlich exakte Elternressource und Kindidentität.
- **Integration:** kanonischer Toolkit-Slug plus ausdrücklich gewählte öffentliche persönliche/gemeinsame Verbindung; no-auth als eigener zulässiger Fall. Profil-/Accountwerte nur soweit der bestehende persönliche Referenzvertrag sie benötigt; keine Composio-Entity-ID oder Credentials.
- **MCP:** exakte persönliche/gemeinsame Verbindung. Eine Definition ist ein Setup-Verweis und wird nicht als ausführbare Verbindung an die Runtime übergeben.
- **Anzeigewerte:** Name und Logo sind UI-Metadaten, keine Autorität. Clientseitiger Skilltext, Status und `providerRef` werden nicht als vertrauenswürdiger Ausführungskontext übernommen.

Beim Senden erzeugt der Server aus diesen Referenzen den aktuellen begrenzten Kontext. Entfernte Ressourcen, nicht mehr überprüfbare oder nicht mehr erlaubte gehaltene Paketrevisionen, widerrufene Nutzung oder veränderte konkrete Verbindung führen zu einem verständlichen Auswahl-/Einrichtungsfehler. Eine neuere veröffentlichte Head-Version allein macht eine weiterhin vorhandene, überprüfte und autorisierte immutable Revision nicht ungültig. Es gibt keinen stillen Namens- oder Account-Fallback. Ein neuer Picker-Aufruf kann einen aktuellen Paketstand anbieten; ein bereits eingefrorener Send-Snapshot wird nicht unbemerkt auf eine andere Version umgeschrieben.

Die Referenzen gehören in `ChatRequestContext` **und dessen Normalisierung**, den unveränderlichen Send-Snapshot, WebSocket-/HTTP-Vertrag, Queue-Änderungen, Steer/Follow-up/Retry und versionierte Drafts/Handoffs. Beim Queue-Start werden Rechte und Quelle erneut geprüft. Eine während eines laufenden Turns gewählte neue Erweiterung darf dessen bereits erfassten Kontext nicht ersetzen.

## „Zuletzt verwendet“ eindeutig definieren

Empfehlung: Ein Eintrag zählt als verwendet, wenn seine explizite Auswahl serverseitig geprüft und als Teil einer Chat-Nachricht akzeptiert wurde. Ein nachfolgender Providerfehler ändert nicht die Tatsache, dass der Nutzer diesen Kontext angefordert hat. Reines Suchen, Öffnen, Hover, Abbrechen und ein nicht akzeptierter Send zählen nicht.

Ein eigener begrenzter serverseitiger Recents-Dienst speichert höchstens etwa **30 Identitäten je Benutzer und Workspace** mit `lastUsedAt`. Eine atomare Speicherung und `clientMessageId` verhindern Doppelzählung durch Retry/Reconnect. Der aktuell ausgewählte Agent filtert die Nutzbarkeit; optional kann seine letzte Verwendung als Gleichstands-Kriterium dienen. Recents werden weder im Capability-Aktivierungsspeicher noch als ungefilterte globale LocalStorage-Liste abgelegt.

Gespeichert werden nur Typ, exakte Identität, gegebenenfalls Eltern-/Verbindungsreferenz und serverseitiger Zeitpunkt. Labels, aktuelle Revisionen und Rechte werden beim Lesen frisch aufgelöst. Gelöschte oder entzogene Einträge verschwinden; ein alter Profil-/Accountbezug wandert nicht zum neuen Standardkonto. `providerRef`, `toolRef`, `schemaRef`, Skillinhalte und Secrets gehören nicht in den Recents-Speicher. Die Nachricht selbst behält ihren geprüften Herkunfts-Snapshot für Verlauf und Nachvollziehbarkeit.

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

**Der Gateway ist heute ein Tool `integrations`.** Wenn es im effektiven Manifest registriert ist, soll der Server die ausgewählte Verbindung über die vorhandenen Adapter-/Bindungsdienste gezielt zu ihrem aktuellen zulässigen Provider-Descriptor auflösen. Die private Verbindungsautorität wird dabei frisch geprüft; weder Anzeigename noch Clientdaten konstruieren eine Gateway-Referenz. Dieser gezielte Metadatenresolver ist ein notwendiger Implementierungsschritt, nicht schon durch die UI-Suche erledigt.

Mit einer so gelieferten aktuellen `providerRef` beginnt der Agent direkt bei der **Tool-Suche in dieser Verbindung**:

1. `integrations`: `action: "search"`, `target: "tools"`, servergelieferte `providerRef`, auftragsbezogene `query`.
2. `integrations`: `action: "describe"`, die aus der Suche zurückgegebene `toolRef`.
3. `integrations`: `action: "call"`, dieselbe `toolRef`, die zurückgegebene `schemaRef` und schema-konforme `arguments`.

Wenn zunächst nur eine deklarierte Plugin-Anforderung vorliegt, lautet das gezielte Suchrezept `target: "providers"` mit den tatsächlich unterstützten Filtern `source`, `application`, `pluginRef` beziehungsweise `capabilityRef`. Der heutige Requestvertrag hat dort **kein beliebiges `connectionRef`-Filterfeld**. Deshalb darf der Plan keine solche schon vorhandene API behaupten. Mehrere passende Instanzen werden ausdrücklich aufgelöst; ein zurückgegebener Provider wird nicht wegen Namensähnlichkeit anstelle der gewählten Verbindung benutzt.

`providerRef`, `toolRef` und `schemaRef` gelten für den aktuellen Kontext und werden nicht aus alten Nachrichten wiederverwendet oder erfunden. Geänderte Bindung/Schema erfordert frische Auflösung. `outcome_unknown` darf keine automatische Wiederholung einer Mutation auslösen.

Solange der gemeinsame Router im konkreten Agenten nicht registriert ist, wird das Suchrezept aus dem tatsächlich vorhandenen `mcp`-/`composio`-Vertrag erzeugt. Die Anleitung darf keine nicht vorhandenen Tools empfehlen. Der allgemeine Gateway-Schalter bleibt unverändert; verbindliche Workflow-Version 1 und deren bereits vorhandene Registrierung werden respektiert. Für den neuen expliziten Agent-Vertrag muss in Schritt 1 die zugehörige begrenzte Tool-Registrierung festgelegt werden. Eine feste Standalone-Auswahl darf weder ein leeres Suchrezept erzeugen noch verdeckt den globalen Router einschalten. Gesperrte/spezialisierte Agenten bekommen durch einen Chip keine zusätzlichen Apps oder Aktionen.

Ein Legacy-Vertrag muss die genaue gewählte Verbindung auch tatsächlich unterstützen. Fehlt beispielsweise ein zulässiger Weg für die ausgewählte geteilte Instanz, zeigt die Chat-Projektion diese Einschränkung und gegebenenfalls den berechtigten Konfigurationsweg. Sie behauptet keine sofortige Nutzbarkeit und ersetzt die Instanz nicht durch ein persönliches Konto.

### Kontextgröße und Vertrauen

Vorgeschlagene anfängliche Chat-Grenze: höchstens **fünf explizite Turn-Auswahlen**. Für festen Agent-Kontext und Turn-Ergänzung gilt ein gemeinsames, separat vom übrigen Systemprompt verwaltetes Budget; **8 KiB UTF-8** ist der zu prüfende Startwert. Die bestehende Agent-Konfigurationsgrenze wird nicht auf fünf Ressourcen reduziert. Größe wird vor Speichern beziehungsweise Senden berechnet; ein nicht darstellbarer Pflichtindex erzeugt einen konkreten Konfigurationsfehler statt stiller Auslassung.

Grenze, Kürzung und Priorität werden zentral implementiert, nicht unabhängig pro Connectorarray. Zuerst bleiben feste/ausgewählte genaue Identität, Rechte-/Einrichtungsstatus und Suchrezept erhalten; danach kurze relevante Beschreibungen und Skillhinweise. Große Pakete geben einen sichtbaren Hinweis auf weitere bei Bedarf lesbare Inhalte. Es werden keine vollständigen Toolkataloge oder vollständigen Skilltexte eines großen Plugins in den Prompt kopiert. Derselbe Skill beziehungsweise dieselbe exakte Verbindung aus fester und Turn-Auswahl erscheint nur einmal; unterschiedliche Accounts oder Versionen werden nicht zusammengelegt.

Die Auswahl relevanter Kinder bleibt nachvollziehbar: ausdrücklich gewählte Skills zuerst; anschließend zulässige Plugin-Kinder anhand Titel/Beschreibung und des Auftragstexts nach derselben Metadaten-Relevanz wie in der Suche ordnen. Bei Gleichstand gilt eine stabile Reihenfolge. Ohne aussagekräftigen Text wird ein kurzer Skill-Index statt einer erfundenen Workflow-Auswahl geliefert. Beim Spezialagenten bleibt der konfigurierte kompakte Index auch ohne aktuelle Nutzerreferenz vorhanden; Relevanz verändert die Detailtiefe, nicht die konfigurierte Verfügbarkeit. Weitere Inhalte müssen über tatsächlich vorhandene autorisierte Lesemöglichkeiten erreichbar sein; fehlt dem Agenten dafür ein Tool, wird dies als fehlende Nutzbarkeit ausgewiesen.

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
7. Chip entfernen, Text bearbeiten, Draftreload, Handoff, Follow-up/Steer, Queueedit und Retry erhalten oder entfernen Referenzen eindeutig.
8. Rechteentzug zwischen Auswahl, Send, Queue-Start, Schema und Call stoppt jeweils vor unberechtigter Nutzung. Historische Chips behaupten keinen heutigen Zugriff.
9. Router registriert/nicht registriert sowie verbindlicher Workflow-Agent: Kontext nennt nur tatsächlich vorhandene Tools und bleibt in deren erlaubtem Umfang.
10. Ausgewähltes Plugin führt den Agenten zu relevantem `SKILL.md` und genau passenden Tools; ein großes Plugin hält die gemeinsame Kontextgrenze ein.
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

Zusätzlich: manuelles Öffnen ohne Slash erhält Text/Caret; Auswahl entfernt nur die erfasste Slash-Range. Ein Chip ohne Text/Attachment erzeugt weder Nachricht noch Recency.

Bestehende Agent-Konfigurations-, Capability-Scope-, Workflow-/Readroot-, Chat-Referenz-, Chip-Scope-, Draft- und Send-Transaction-Prüfungen werden gezielt erweitert. Ein echter Modelllauf muss zusätzlich nachweisen, dass der Agent sowohl einen nicht explizit referenzierten passenden Skill findet als auch den gelieferten gezielten Tool-Suchweg nutzt; ein Snapshot des Prompttexts allein beweist das nicht. Externe Providerabnahme und allgemeiner Gateway-Rollout bleiben im [bestehenden Rollout-Plan](rollout-plan-2026-10-13.md).

## Punkte für die nächste gemeinsame Optimierung

- Soll ein ausgewähltes Plugin zunächst alle zulässigen Bestandteile übernehmen oder eine vom Paket angebotene Standardauswahl? Empfehlung: Paketstandard transparent anzeigen; Abweichungen aufklappen, Pflichtbestandteile erhalten.
- Wie soll ein Agent mit noch fehlender notwendiger Einrichtung gespeichert werden? Empfehlung: klar als nicht startbarer Entwurf, mit genauem Einrichtungsweg; finalen Zustand am vorhandenen Readiness-Vertrag festlegen.
- Soll Vererbung für neue Spezialagenten noch als erweiterte Option angeboten werden? Empfehlung: neue Agenten mit fester Auswahl; bestehende Vererbung sichtbar erhalten und gezielt migrieren.
- Kontextbudget und Ergebnisanzahl anhand kleiner/großer realer Pakete prüfen. Eine Performance-/Modellabnahme muss zeigen, dass der kompakte Index ausreicht und Suche gezielt bleibt.

Diese Punkte verfeinern den gespeicherten Vorschlag. Sie sind keine Voraussetzung dafür, jetzt den Plan zu besprechen, und keine pauschale Freigabe zur Implementierung.
