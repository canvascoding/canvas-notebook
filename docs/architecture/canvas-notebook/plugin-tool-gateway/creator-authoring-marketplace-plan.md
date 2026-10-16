# Skill- und Plugin-Erstellung: konkreter Umsetzungsplan

Stand: 16. Oktober 2026. **Planung; keine Produktimplementierung dieses Ausbaus.**

Ziel: Nutzer beschreiben einen wiederkehrenden Ablauf. Canvas erstellt daraus in der laufenden App einen eigenständigen Skill oder ein Plugin aus vollständigen Skills und deklarierten Integrationsanforderungen. Die erzeugten Pakete werden zunächst ausschließlich für die Organisation verwaltet. Erstellung, Bearbeitung, Wiederaufnahme, Validierung und interne Bereitstellung verwenden denselben Paketlebenszyklus.

**Verbindliche Scope-Präzisierung durch den Nutzer:** Der öffentliche Marketplace wird vom Nutzer gepflegt. Direkter Public-Publish, Einreichungsautomatisierung, Marketplace-Release-/CI-Umbau und ein neuer Exportworkflow gehören nicht zu diesem Ausbau. Der Marketplace liefert Format- und Inhaltsbeispiele. Statt des bisherigen Marketplace-Arbeitspakets sind Schema-/Paketvalidierung, eine beschreibende SVG-Grafik je neuem Plugin und die vollständige E2E-Abnahme verbindlich.

## 1. Geprüfter Ausgangsstand

| Repository | Geprüfte Quelle | Bedeutung |
| --- | --- | --- |
| Canvas Notebook | `4cf80f98ca31b1068e42973bdc3e496252cecdea`, Branch `codex/plan-plugin-integration-catalog`, PR #171 | Grundlage dieser Anschlussplanung; keine Aussage über Produktion oder eine Integration mit neuerem `main`. |
| Plugin Marketplace | `54ce6573502f67f4cb6227871000aa315ab87dbe`, lokales und frisch geholtes `origin/main` | Registry, tatsächliche Plugin-/Skill-Verzeichnisse, Veröffentlichungsnachweise und CI gelesen. |

Die Prüfung war statisch. Sie umfasst keine Installation, Providerprobe, neue Modell-, UI- oder Geräteabnahme. Die vorhandenen früheren Chat-/Agentenabnahmen werden durch diesen Plan nicht auf eine neue Creator-Funktion ausgedehnt.

### Marketplace-Inventar

| Plugin | Aktuell | Tatsächlicher Inhalt |
| --- | --- | --- |
| Canvas Basics | 1.0.0 | Ein Skill zum Prüfen der Plugin-Grundfunktionen. |
| Document Suite | 1.4.0 | Sieben Skills: DOCX, Excalidraw, Marp, PDF, PPTX, XLSX und Mermaid. Historische Pluginversionen 1.1.0/1.2.0 bleiben erhalten. |
| Sales Connectors Demo | 1.0.0 | Ein Readiness-Skill sowie Empfehlungen für HubSpot über Composio, Canvas Email und ein Research-MCP. Kein ausführbarer Sales-Fachworkflow. |

Der Katalog enthält drei Plugins mit fünf Versionseinträgen und neun als einzeln installierbar gelistete Skills mit 16 Versionseinträgen. Acht Einzel-Skills zeigen über `sourcePlugin` und `packagePath` auf einen Skill-Unterordner im jeweiligen Pluginarchiv. Mermaid 1.0.0 besitzt eine eigene Quelle unter `skills/mermaid/1.0.0/`.

Die Skillversion ist unabhängig von der Pluginversion: Document Suite 1.4.0 enthält weiterhin fünf unveränderte Skills mit Version 1.2.0, Mermaid 1.0.0 und Excalidraw 1.4.0. Diese Semantik bleibt erhalten.

Konkrete Grenzen der vorhandenen Beispiele:

- Sales Connectors Demo enthält keinen `workflow`-Block. Sein MCP-Endpunkt ist `https://example.com/mcp/sales-research`, `enabled: false`. Das ist ein deaktivierter Platzhalter, kein funktionierender Research-Dienst.
- Ein Child-Verzeichnis ist nicht automatisch ein eigenständiges Paket: Die UI-Metadaten des Sales-Skills referenzieren `../../assets/icon.svg` im Elternplugin. `sourcePlugin` beschreibt die Herkunft, keinen automatischen Parent-Installvertrag. Eine vollständige Einzelinstallation wurde hier nicht ausgeführt; eine spätere Einzelpaketableitung müsste solche Abhängigkeiten auflösen und gehört nicht zum aktuellen Ausbau.
- Document Suite 1.4.0 wurde ausdrücklich vor dem erforderlichen Excalidraw-Backendupdate veröffentlicht. Der Releasebeleg lässt `backendRelease` und `minCanvasVersion` ehrlich auf `null`. Eine Installation beweist nicht das Vorhandensein der Scene-Service-Tools.
- `CONTRIBUTING.md:26` verlangt noch, Document Suite 1.4.0 außerhalb der Registry zu halten. Das widerspricht dem aktuellen README und dem tatsächlichen Veröffentlichungsbeleg.
- Die einzige CI ist auf Document Suite und Mermaid zugeschnitten. Der Document-Suite-Verifier bindet sogar die vollständigen aktuellen Registrybytes an einen historischen Releasebeleg. Neue Katalogeinträge würden diesen Gate ohne gezielten Umbau brechen. Historische Belege werden deshalb nicht bei jeder neuen Veröffentlichung umgeschrieben.

### Bereits vorhandene Canvas-Bausteine

- `skill-creator` und `create-plugin` sind geschützte Core-Skills. Ihre Workspace-Werkzeuge können vollständige Pakete erstellen, persönlich installieren und mit Versions-/Checksum-Prüfung aktualisieren.
- Der neuere gemeinsame Paketservice verwaltet aktorprivate Entwürfe, Dateien, vollständige Validierung, unveränderliche Veröffentlichungsrevisionen, Eigentum und Freigaben. Seine Entwurfsanlage kennt bisher nur `edit` und `fork` einer vorhandenen Quelle.
- Die aktorprivate Entwurfsliste existiert bereits als REST-Weg. Dem Agenten fehlen gleichwertige Listen-/Recovery-Operationen. Der Editor setzt zur Wiederaufnahme noch eine vorhandene Quellressource voraus.
- `workflow.version: 1` und `integrationCapabilities` bilden bereits MCP-/Composio-Anforderungen ab. Private Agent-/Chatbindungen, konkrete Accountauswahl, Toolgrenzen und präzise Kontextübergabe existieren ebenfalls.
- Die vorhandenen Manifestfelder `interface.logo` und `interface.icon` können paketlokale SVG-Dateien referenzieren. Der Manifestvalidator prüft dort bisher nur relative Paketpfade; eine Pflicht für vorhandene, gültige SVG-Bilddateien ist damit noch nicht umgesetzt. Die Paketbildauslieferung besitzt bereits eine separate Prüfung auf passive Bilddaten.
- Die gemeinsame `/`-Suche und Inline-Referenzen bleiben der Einstieg. Der Ausbau fügt keine zusätzliche Auswahlleiste oberhalb der Nachricht ein.

## 2. Verbindliches Zielmodell

### Skill und Plugin

Ein **Skill** ist ein vollständiges Paket für einen konkreten Ablauf: `SKILL.md`, optionale Canvas-UI-Metadaten, Referenzen, Assets und ausführbare Helfer. Er kann selbst Integrationsanforderungen besitzen.

Ein **Plugin** bündelt im aktuellen Canvas-Format mindestens einen solchen Skill, gemeinsame Darstellung und bei Bedarf Custom-MCPs, Composio-Apps und deren Workflowanforderungen. Ein Plugin muss nicht alle Integrationsarten enthalten. Bereits vorhandene einzelne Skills, MCPs und Composio-Integrationen bleiben separat nutzbar.

Der Creator kann:

1. einen neuen eigenständigen Skill erstellen;
2. in einem neuen Plugin neue Skills erstellen;
3. vorhandene eigene oder zulässig lesbare Skills als genaue Kopie aufnehmen;
4. neue und vorhandene Skills im selben Plugin kombinieren;
5. bestehende Plugins bearbeiten oder als eigenes Paket ableiten.

Ein neuer Child-Skill kann direkt im Pluginentwurf entstehen. Eine vorherige Installation als eigenständiger Skill ist dafür nicht erforderlich. Die zusätzliche Extraktion als Marketplace-Einzelangebot ist kein Arbeitspaket dieses Ausbaus.

### Organisationsverwaltung als einziges Erstellziel

Die Organisation wird serverseitig aus dem authentifizierten Kontext bestimmt; aktuelle Mitgliedschaft und bestehende Berechtigungen zum Erstellen/Verwalten bleiben erforderlich. Aktuell sind Organisationsneuanlagen Owner/Admin mit `canShare` vorbehalten. Der Creator erhält keine Sonderrechte. Neue Creator-Ziele sind ausschließlich `ownership: organization`; eine ausgeblendete Bereichsauswahl allein genügt nicht. Bestehende persönliche Pakete und gespeicherte Referenzen werden nicht migriert oder ungültig gemacht.

Entwürfe bleiben aktorprivat, auch wenn ihr Ziel die Organisation ist. Vor dem Speichern werden nur Vorschau und strukturelle Prüfung angeboten. Der abgeschlossene Erstellauftrag speichert eine unveränderliche Organisationsversion. Eine persönliche Previewveröffentlichung ist nicht erforderlich und gehört nicht zum neuen Ablauf.

**Organisationsbesitz, Nutzungsfreigabe und Aktivierung sind getrennt:** Neue Ressourcen starten derzeit eingeschränkt mit leeren Grants. Verwaltung erlaubt nicht automatisch `canUse`, und Aktivierung erteilt keine Nutzungsrechte. Der Abschlussüberblick benennt deshalb den beauftragten Nutzungsadressaten, etwa Mitglieder dieser Organisation oder einen zulässigen engeren Kreis. Der gemeinsame Dienst setzt die entsprechende bestehende Use-Regel/Grants und Aktivierung mit aktuellen Revisionsprüfungen um. Daraus entstehen keine pauschalen Bearbeitungs-/Verwaltungsrechte für andere Mitglieder. Ein Auftrag nur zum Entwerfen bleibt beim Entwurf.

### Vier getrennte Ebenen

| Ebene | Inhalt | Zuständige vorhandene Systeme |
| --- | --- | --- |
| Portables Paket | Vollständige Skills, Dateien, Darstellung, Connectorbeschreibungen, Workflowanforderungen | Canvas-Manifeste, Paketdateien, Paketvalidator |
| Privater Entwurf | Aktor, Zielbereich, Entwurfsrevision, Herkunft der übernommenen Inhalte, Wiederaufnahme | `capabilities/packages` und dessen vorhandener Store |
| Konkrete Einrichtung | Gewählte MCP-Definition/Verbindung oder Composio-Profil/Account; persönliche oder freigegebene Nutzung | Bestehende Setup-, Connection-, Workflow- und Accountdienste |
| Laufzeit | Exakte Paketrevision, ausgewählte Skills, aktuelle Rechte, erlaubte Provider/Tools und Schema-Referenzen | Gemeinsamer Chat-/Agent-Kontextresolver und Integrationsgateway |

Paketdateien enthalten keine persönlichen Account-/Profil-/Connection-IDs, Tokens, `accountSelectionRef`, lokalen Definition-UUIDs oder gehaltenen Laufzeitbelege. ENV-Schlüsselnamen dürfen deklariert werden; Werte bleiben im zentralen Secret-Service.

Composio-Apps werden mit ihrem tatsächlichen Toolkit-Slug beschrieben. Custom-MCPs besitzen eine stabile paketlokale Connectoridentität und gegebenenfalls eine Konfigurationsvorlage. Die konkrete lokale MCP-Definition wird erst bei der Einrichtung zugeordnet. Ein Anzeigename allein ist kein Identitätsbeleg.

### Connectorbeschreibung und Workflowanforderung

- `connectors` beschreibt Einrichtung, Darstellung und zulässige Vorlagen.
- `workflow.integrationCapabilities` beschreibt, welcher Skill welche Funktionen benötigt.
- Mehrere erforderliche Capabilities sind **UND**. Verifizierte Alternativen innerhalb einer Capability sind **ODER**.
- `requiredTools` bezeichnet benötigte tatsächliche Toolnamen, erteilt aber keine Rechte. Namen werden aus echter Discovery/Schemaabfrage oder einer verifizierten Serverbeschreibung übernommen.
- Eine OR-Alternative hebt keine separat erforderliche Legacy-Connectordeklaration auf. Der Creator erzeugt beide Teile widerspruchsfrei.
- Canvas Email bleibt beim bestehenden Mailbox-/Fachtoolweg. V1-Workflowalternativen unterstützen ausschließlich MCP und Composio; Email wird nicht als weiterer Provider erfunden.

### Vorhandene Skills vollständig übernehmen

Eine Auswahl nach Namen reicht nicht. Composition erfasst serverseitig die autorisierte Quelle, deren genaue Revision beziehungsweise aktuellen Legacy-Quellstempel, Checksumme und tatsächlichen Skill-Unterordner. Alle erforderlichen Dateien werden in den Pluginentwurf materialisiert.

Bei einem Skill aus einem anderen Plugin gehören dazu gegebenenfalls Assets, Konfigurationen und Connectoranforderungen außerhalb seines Child-Verzeichnisses. Solche Abhängigkeiten werden nur innerhalb des genau erfassten, autorisiert lesbaren Quellpakets aufgelöst, in das Ziel übernommen und gezielt neu referenziert. Ein gleicher Dateiname im Ziel darf nicht still eine andere Ressource zuordnen. Nicht auflösbare oder außerhalb des zulässigen Pakets liegende Abhängigkeiten stoppen die Übernahme.

Unveränderliche Veröffentlichung lehnt lokale Seed-`skillRefs` bereits ab. Es werden weder frei schwebende Verweise auf andere installierte Pakete noch eine neue rekursive Dependency-Sprache eingeführt.

Besonderheit beim Einbetten eines eigenständigen Skills: Er darf `workflow.mcpConnectors` besitzen, ein Plugin-Kind dagegen nicht. Composition muss deshalb:

1. benötigte MCP-Connectoren und Konfigurationsdateien zum Elternplugin übernehmen;
2. gleiche Deklarationen anhand ihrer vollständigen Semantik vergleichen;
3. widersprüchliche Namen oder Konfigurationen mit einer klaren Auswahl stoppen;
4. strukturierte Connector-/Workflowreferenzen und relative Dateipfade gezielt anpassen;
5. dem Creator die daraus entstandenen Änderungen zur Prüfung liefern.

Keine blinde Textumbenennung und keine Übernahme privater Accountbindings. Unveränderte kopierte Skills behalten ihre eigene Version. Werden Inhalt oder Deklarationen angepasst, erhält die Ableitung eine nachvollziehbare neue Skillversion und Herkunftsangabe. Quellpakete werden dabei nicht verändert.

Für übernommene Quellen gilt bis zur internen Veröffentlichung mindestens die bestehende Fork-Semantik: aktuelle Quellleserechte und Zielberechtigung werden erneut geprüft. Herkunftsreferenzen werden privat am Entwurf geführt und sind selbst keine Autoritätsbelege. Bestehende Lizenz-/Autorenangaben bleiben erhalten.

### Beschreibendes SVG als Teil des Pluginpakets

Jedes neu vom Creator erzeugte Plugin erhält eine eigene kleine, editierbare SVG-Grafik, die seinen Zweck vermittelt. Als Standard dient `assets/logo.svg`, im bestehenden Manifest über `interface.logo: "./assets/logo.svg"` referenziert. Eine zusätzliche kompakte Variante kann `interface.icon` bedienen; die Darstellung bevorzugt derzeit `logo` vor `icon`. Es wird kein neues Assetfeld erfunden.

Die Grafik erhält ein einfaches Zweckmotiv, beispielsweise CRM-Datensätze plus Dokument beim Account-Brief-Plugin. Eine quadratische Zeichenfläche, beispielsweise `viewBox="0 0 256 256"`, wenige Farben und wenig oder kein Text eignen sich für Karten, Details und kleine Referenzen. Die konkrete Größe ist eine Creator-Konvention, keine nachträgliche Formatpflicht für Altbestände. Normale Composio-Logos und MCP-Domainbilder bleiben die Kennzeichnung der jeweiligen verbundenen Dienste.

Das systemeigene Plugin-Creator-Plugin bündelt einen kleinen Teilskill, vorgeschlagener Name `plugin-visual`, abgeleitet aus dem vom Nutzer bereitgestellten `create-svg-illustrations`. Er enthält nur Regeln für Zweckmotiv, einfache Formen, `xmlns`, korrektes `viewBox`, explizite Textstile falls nötig, `<title>`/`<desc>`, zugängliche Einbettung und Prüfung in der tatsächlichen UI. Keine Folien-/Marp-Workflows und keine Abhängigkeit auf lokale Entwickler-Skillpfade. Die vollständigen benötigten Regeln werden im Core-Paket mitgeliefert und vom Creator bei der Bildphase gezielt geladen; eine zusätzliche Installation ist nicht erforderlich.

Canvas akzeptiert hier ausschließlich paketlokale passive SVGs: keine Skripte, `foreignObject`, externen URLs/Schriftdateien oder eingebetteten Data-URL-Bilder. Die vorhandene passive Bildprüfung mit maximal 2 MiB wird wiederverwendet und um echte XML-/SVG-Struktur und die Creator-Metadaten ergänzt. Diese Prüfung bestätigt weder sinnvolle Gestaltung noch guten Kontrast; dafür bleibt die Sichtprüfung erforderlich. Host-Alttext beziehungsweise ein semantisches Äquivalent kommt zusätzlich zu den internen SVG-Metadaten aus der UI.

Fehlende oder ungültige Grafik blockiert den Abschluss eines neuen Creator-Plugins serverseitig. Der Entwurf kann zur Reparatur gespeichert bleiben. Bestehende Pakete werden durch diese neue Creator-Anforderung nicht rückwirkend ungültig; deren bisherige Icon-/Initialen-Fallbacks bleiben erhalten.

## 3. Konkreter Nutzerablauf

1. **Einstieg:** `/Skill Creator`, `/Plugin Creator` oder „Erstellen → Skill / Plugin“ auf der Plugin-Seite. Die Auswahl bleibt eine Inline-Referenz im Text. Der Seitenknopf öffnet denselben Chat mit passender Creator-Referenz.
2. **Ziel klären:** Zweck, Eingaben und gewünschtes Ergebnis aus dem Auftrag übernehmen. Nur fehlende Angaben nachfragen. Beim Plugin zusätzlich neue/vorhandene Skills und benötigte Integrationen bestimmen.
3. **Entwurf anlegen:** Ein aktorprivater Paketentwurf mit festem Organisationsziel entsteht im gemeinsamen Dienst. Der Chat nennt einen Link zum Entwurf. Derselbe Entwurf erscheint unter „Meine Entwürfe“ und lässt sich in einem anderen Chat fortsetzen.
4. **Zusammenstellen:** Neue Skills direkt im Entwurf schreiben; vorhandene Skills kontrolliert aufnehmen. Die Integrationssuche verwendet denselben Katalog wie die übrige App und zeigt vorhandene, noch einzurichtende und nicht verfügbare Verbindungen getrennt.
5. **Grafik und Vorschau:** Der Creator erstellt das Zweck-SVG. Zunächst Grafik, Name, Zweck, enthaltene Abläufe, Zielorganisation, Nutzungsadressat, Verbindungsstatus und fehlende Voraussetzungen zeigen. Dateien, Manifest, technische Identitäten und Versionsdetails erst unter „Details“.
6. **Validieren:** Schema, vollständigen Paketbaum, Referenzen und SVG prüfen. Fehler erscheinen mit Datei/Feld und Reparaturhinweis. Ein fehlerhafter Entwurf bleibt bearbeitbar; der Server verhindert seine interne Veröffentlichung. Unbearbeitete Draft-Dateien werden nicht an der Runtime-Autorisierung vorbei ausgeführt.
7. **Intern bereitstellen:** „Für die Organisation speichern“ speichert die gültige Org-Version und führt die beauftragte Nutzungsfreigabe/Aktivierung über bestehende Aktionen aus. Bereits ausdrücklich beauftragtes Erstellen und Bereitstellen benötigt keine zusätzliche pauschale Bestätigungsrunde. Die konkrete Organisation und Reichweite sind vorher sichtbar; es gibt keinen Public-Publish-Schritt.
8. **Ergebnis und Probe:** Link, Version, SVG, enthaltene Skills und genauer Einrichtungsstatus. „Im Chat ausprobieren“ verwendet die bereits intern veröffentlichte exakte Revision und die gemeinsame Inline-Auswahl. Ein spezialisierter Agent bekommt dieselben Paket-/Verbindungsverträge. Eine neue Änderung öffnet einen neuen Edit-Entwurf und verändert keine bereits gespeicherte Revision.

Die Zustände **Paket/SVG gültig**, **Org-Version gespeichert**, **Nutzungsfreigabe/Aktivierung abgeschlossen**, **Verbindungen eingerichtet**, **aktuelle Toolnutzung geprüft** und **Beispiel ausprobiert** bleiben getrennte Ergebnisse. `authorized`/`healthy` oder eine optionale Empfehlung beweisen keine aktuelle Provider-Erreichbarkeit. Bei `provider_unavailable` wird weder Erfolg behauptet noch automatisch getrennt, erneut verbunden oder ein anderes Konto gewählt.

Ein gültiges Paket darf mit offenen Verbindungen intern gespeichert werden. Der Creator zeigt dann „Einrichtung erforderlich“ beziehungsweise „Tools ungeprüft“. Ein Probefall nach Org-Publish folgt den bestehenden Ausführungs-/Reviewregeln und wiederholt keine Aktion mit ungewissem Ausgang. Externe Geschäftsaktionen sind kein beiläufiger Verbindungstest. Der Entwicklungs-E2E-Test läuft in der isolierten Testorganisation des verwalteten Teststacks, ohne parallele zweite Testumgebung.

## 4. Beispiel: Account-Brief-Plugin

Geplanter vertikaler Abnahmefall, kein bereits vorhandenes Marketplacepaket:

- Neuer Skill `account-brief`: aus CRM- und Researchdaten einen nachvollziehbaren Firmenbrief vorbereiten.
- Vorhandener DOCX-Skill aus genau gewählter Document-Suite-Veröffentlichung: als vollständigen Inhalt mit eigener Skillversion übernehmen.
- Composio-App HubSpot: konkrete CRM-Anforderung; tatsächliche Tools erst nach Discovery/Describe eintragen.
- Custom-MCP `company-research`: vorhandenen Server exakt zuordnen oder über den bestehenden MCP-Setupweg einrichten.
- Zweck-SVG: CRM-Datensätze und Research führen zu einem Firmenbrief; das erzeugte Paketbild wird im Plugin-UI angezeigt.
- Eigenständiger Skill bleibt separat erstellbar; die Kombination wird als organisationsverwaltetes Plugin gespeichert.

```text
account-brief-suite/
  .canvas-plugin/plugin.json
  skills/account-brief/SKILL.md
  skills/account-brief/agents/canvas.yaml
  skills/docx/SKILL.md
  skills/docx/...vollständige Ressourcen...
  connectors/...nur tatsächlich verwendete MCP-Vorlagen...
  assets/logo.svg
```

Workflowausschnitt des geplanten Elternmanifests; kein vollständiges installierbares Paket und kein Provider-Funktionsnachweis:

```json
{
  "workflow": {
    "version": 1,
    "integrationCapabilities": [
      {
        "id": "crm-context",
        "application": "hubspot",
        "required": true,
        "alternatives": [{ "source": "composio", "toolkit": "hubspot" }],
        "skillRefs": ["account-brief"]
      },
      {
        "id": "company-research",
        "application": "research",
        "required": true,
        "alternatives": [{ "source": "mcp", "connector": "company-research" }],
        "skillRefs": ["account-brief"]
      }
    ]
  }
}
```

Das vollständige Manifest benötigt die dazu passenden `connectors`-Deklarationen. Ein Custom-MCP kann eine bestehende, ausdrücklich zu bestätigende Nutzerverbindung verlangen; ein neues Backend entsteht nicht durch diese Deklaration. Automatisches Bauen/Starten/Hosting paketlokalen MCP-Codes ist ein eigener Ausbau und wird hier nicht als vorhandene Funktion vorausgesetzt.

## 5. Umsetzung in abgeschlossenen Schritten

Der laufende Status und die konkreten Prüfbelege stehen im [Umsetzungs-/Abnahmejournal](creator-authoring-implementation.md). P1 ist als Backend-/API-Grundlage abgeschlossen; die weiteren Integrationsschritte bleiben offen. Jeder Schritt erhält seine Abnahme vor dem nächsten Integrationsschritt. Der durchgängige UI-/Creator-Nachweis wird in P7 erbracht.

### P1 — Gemeinsamen Entwurf um echte Neuanlage und Wiederaufnahme erweitern

- [x] `operation: 'create'` für Skill/Plugin, stabilen Namen und serverseitig festes Organisationsziel ergänzen. Aktuelle Organisation und bestehende Verwaltungsberechtigung prüfen; persönliche-/Teamziele für neue Creator-Vorgänge auch über direkte API-/Agentaufrufe abweisen, ohne vorhandene Altvorgänge zu beschädigen.
- [x] Diskriminierten Herkunftsvertrag für neue gegenüber aus einer Quelle abgeleiteten Entwürfen einführen. Keine erfundenen Quellrevisionen und keine aufgeweichten Source-Prüfungen für `edit`/`fork`.
- [x] Store, additive Datenmigration, Actions, Dateidienste und REST auf sourcefreie Neuanlage erweitern. Neue Ressourcen wie bei Fork erst beim erfolgreichen Publish atomar anlegen.
- [x] Bestehende aktorprivate Listen-/Statusdienste als Agentoperationen bereitstellen; Wiederaufnahme über `draftRef` statt über einen versteckten Workspacepfad.
- [x] Aktorprivate Korrelations-/Idempotenzschlüssel für Neuanlage und Veröffentlichung ergänzen. Den Veröffentlichungsbeleg `draftRef + draftRevision → resourceRef + publishedRevisionRef` atomar mit dem Publish dauerhaft speichern; verworfene Entwürfe als eigenes Ergebnis unterscheiden. Der aktuell beim Publish gelöschte Entwurf und ein späteres `404` genügen dafür nicht.
- [x] Namenskonflikte, zwei schreibende Chats, Rechte-/Workspacewechsel und verlorene Antworten mit aktuellen Entwurfsrevisionen behandeln. Nach ungewissem Ergebnis zuerst den korrelierten Status/Beleg lesen, nicht blind neu anlegen/veröffentlichen. Ein Beleg ersetzt keine aktuelle Zugriffsprüfung auf den erzeugten Inhalt.

**Hauptdateien:** `app/lib/capabilities/packages/{contracts,schemas,actions,store,io}.ts`, zugehöriges DB-Schema/Migration, `app/api/capabilities/packages/drafts/`, `app/lib/pi/{scoped-tools,progressive-tool-gateway}.ts`.

**Abnahme:** Ohne installierte Quelle Skill und Plugin für die aktuelle Organisation erstellen, schließen, in einem zweiten Chat wiederfinden und intern veröffentlichen. Unzulässige Organisationsziele und fehlende Erstellrechte werden abgewiesen. Antwortverlust nach tatsächlichem Create-/Publish-Commit findet denselben Entwurf beziehungsweise dieselbe erzeugte Version; keine zweite Anlage. Fremde Nutzer sehen Entwürfe und Operationsbelege nicht. Konflikt oder Rechteverlust erzeugt keine halbe freigegebene Ressource. Bestehende `edit`-/`fork`-Datensätze bleiben lesbar.

### P2 — Skills und Integrationsanforderungen kontrolliert zusammenstellen

- [ ] Kleine gemeinsame Capture-/Composition-Aktion für vorhandene Skills ergänzen: Zielentwurf und erwartete Draftrevision, genaue autorisierte Quelle, Skill-Unterordner und gewünschter Zielpfad.
- [ ] Vollständige Dateien über vorhandene Inventar-, Snapshot- und Pfadschutzfunktionen übernehmen; die eigentliche Quelle bleibt unverändert. Auch Legacyquellen autorisiert auflösen und exakt erfassen; keine vorherige Adoption oder Verwaltungsrechte verlangen, wo aktuelles Leserecht für eine Ableitung genügt.
- [ ] Bei übernommenen Plugin-Kindern auch benötigte Parent-Assets, Configs und Anforderungen innerhalb der autorisierten Quellpaketgrenze erfassen. Pfade und Referenzen gezielt materialisieren/anpassen; keine stillen Abhängigkeiten auf die Installation des Quellplugins oder zufällig gleich benannte Zieldateien.
- [ ] MCP-Deklarationen eigenständiger Skills zum Parent überführen; Konflikte, Configpfade, Child-Workflowreferenzen, Herkunft und abgeleitete Versionen nachvollziehbar verarbeiten.
- [ ] Connectoren und `workflow.integrationCapabilities` gemeinsam erzeugen/validieren. Neue Autoren schreiben die kanonischen Felder; bestehende Aliase werden nur beim Lesen normalisiert.
- [ ] Vorhandene Workspaceentwürfe ausdrücklich in einen neuen privaten Paketentwurf importieren können. Erfolgreichen Import quittieren; alte Ordner weder automatisch installieren noch löschen.

**Hauptdateien:** neue eng begrenzte Composition-Aktion unter `capabilities/packages`, vorhandene `artifacts.ts`, `io.ts`, Manifest-/Workflowparser, API und Gateway-Adapter.

**Abnahme:** Neuer plus vorhandener Skill im selben Plugin; kopierte Assets/Helfer vollständig; gleiche Namen oder widersprüchliche Connectoren führen zu einer verständlichen Entscheidung. Fehlende Quellrechte oder Änderungen während Capture hinterlassen keine Teilübernahme. Spätere Quellupdates verändern den erzeugten Inhalt nicht.

### P3 — Skill Creator und Plugin Creator auf denselben Dienst umstellen

- [ ] Beide Core-Anleitungen auf `canvas_extensions → search → describe → call` und den gemeinsamen Entwurfs-/Datei-/Validierungs-/Publishweg ausrichten.
- [ ] Canvas-fremde Claude-CLI-Evaluation aus dem normalen Canvas-Ablauf lösen. Kurze Canvas-Anleitungen mit bedarfsweise geladenen Referenzen, Beispielprompts und normalem Runtime-Test verwenden.
- [ ] Skill Creator kann einen eigenständigen Entwurf oder einen klar gebundenen Child-Skill im Pluginentwurf bearbeiten. Plugin Creator orchestriert Komponenten und gemeinsame Anforderungen.
- [ ] Ziel bleibt ein sichtbares, systemeigenes **Plugin Creator**-Core-Plugin mit passenden Erstellungs-/Bearbeitungs-Skills; Skill Creator bleibt einzeln nutzbar. Dafür geschützten Core-Pluginstatus und Loader-/Katalogidentität ausdrücklich modellieren: ein zusätzlicher normaler Seedpluginname genügt nicht.
- [ ] Den vollständigen kleinen Teilskill `plugin-visual` gemäß Abschnitt 2 im Creator-Paket bündeln und beim Erstellen eines neuen Plugins gezielt laden: Zweck verstehen, SVG-Datei erzeugen, bestehenden Manifestpfad setzen, prüfen und reparieren. Nur die einschlägigen Regeln der Nutzervorlage übernehmen; die Base64-Ausnahme der allgemeinen Illustrationsempfehlung gilt nicht für SVG-Inhalte in Canvas.
- [ ] Bisherige Core-Skill-IDs kompatibel erhalten; gespeicherte Referenzen und exakte alte Revisionpins nicht auf neue Eltern-/Kindidentitäten umschreiben. Doppelte Suchtreffer vermeiden.

**Hauptdateien:** `seed_skills/{skill-creator,create-plugin}`, systemeigene Creator-Paketdefinition/Loader, `app/lib/skills/core-skills.ts`, `app/lib/plugins/default-seed-plugins.ts`, Katalog-/Kontextadapter und Gatewayoperationen.

**Abnahme:** Natürlicher Auftrag und explizite `/`-Referenz führen zur richtigen Creator-Anleitung und aktuellen Tools. Ein neues Plugin erhält ein zum Zweck passendes SVG mit korrektem Manifestpfad. Bestehende verwaltete Pakete lassen sich bearbeiten, ohne im Legacy-Installer zu enden. Unterbrechung und Fortsetzung im anderen Chat behalten denselben Entwurf.

### P4 — Schema, vollständiges Paket und SVG verbindlich validieren

- [ ] Einen versionierten kanonischen Schemakontrakt für neu erzeugte Plugin-Manifeste festlegen, einschließlich Pflichtmetadaten, Typen, Versionen, Interface, Connectoren und Workflow-V1. Den vorhandenen Manifest-/Workflowparser als Grundlage verwenden; maschinenlesbares Schema, Creator-Vorlage und Runtimevalidierung aus derselben Quelle ableiten oder durch gemeinsame Konformitätsfälle auf Gleichlauf prüfen. Kein zweiter widersprechender Schemaparser nur im Creatorprompt.
- [ ] Vorhandene Request-/CAS-Schemata, Manifest-/Workflowvalidierung und `validateCompleteCapabilityPackage()` zu einem gemeinsamen Validierungsbericht verbinden. Kind-Skills vollständig parsen; vorhandene Datei-/Inventarlimits, Paketgrenzen, Connector-/Skillreferenzen, Versionen und stabile Checksummen prüfen. Seedverweise müssen vor internem Publish materialisiert sein.
- [ ] Für neue Creator-Plugins eine vorhandene lokale SVG-Datei am deklarierten Bildpfad verlangen. Die bestehende passive Bildprüfung und ihr strengeres 2-MiB-Limit nutzen; zusätzlich XML-/SVG-Struktur ohne externe Ressourcen, gültiges `viewBox`, `<title>` und `<desc>` prüfen. Schadhafte oder fehlende Bildbytes dürfen nicht erst beim UI-Abruf zu einem stillen Initialen-Fallback führen.
- [ ] Schema-/SVG-Anforderungen serverseitig bei expliziter Draftvalidierung und erneut am abschließenden Publish durchsetzen. Ein direkt aufrufendes Tool darf diese nicht umgehen. Der Bericht bindet sich an die aktuelle Entwurfsrevision/Checksumme; Änderungen nach der Prüfung benötigen eine neue Validierung. Alte Pakete anhand ihrer bestehenden Verträge weiter lesen, neue Creator-Anforderungen nicht pauschal rückwirkend anwenden.
- [ ] Fehlermeldungen enthalten Code, Datei-/Feldpfad und verständlichen Reparaturhinweis. Ein Fehler lässt den privaten Entwurf erhalten und verhindert Org-Publish; der Creator darf gezielt reparieren und erneut prüfen. Schema-/SVG-Validität wird nicht als Beleg für Providerverfügbarkeit oder fachlichen Erfolg dargestellt.

**Hauptdateien:** `app/lib/plugins/canvas-plugin-manifest.ts`, `app/lib/skills/canvas-skill-manifest.ts`, `app/lib/capabilities/workflow-contracts.ts`, `capabilities/packages/{schemas,artifacts,actions,package-icon-image}.ts`, gemeinsamer versionierter Schemakontrakt und Validierungsbericht.

**Abnahme:** Ungültige Typen/Pflichtfelder, fehlender Kind-Skill, kaputte Connectorreferenz, fehlendes oder ungültiges SVG, zu großes Asset und Änderung nach Validate blockieren die Veröffentlichung mit genauem Fehler. Die reparierte aktuelle Revision besteht. Direkter Publish ist ebenfalls geschützt; historische gültige Pakete bleiben lesbar.

### P5 — Progressive Oberfläche im Web und passenden Mobile-Einstieg anschließen

- [ ] Auf der aktiven Plugin-Seite „Erstellen → Skill / Plugin“ anbieten; denselben Creator-Chat verwenden.
- [ ] Paketeditor und Entwurfsnavigation ohne vorausgesetzte Quellressource öffnen. Neu/übernommen, Herkunft und Versionsänderungen verständlich zusammenfassen.
- [ ] Zweck-SVG, Name, Organisation, Nutzungsadressat, Skills, Anforderungen und Status zuerst; gerenderte Skill-Vorschau, Validierungsdetails und technische Dateien unter Details. Keine neue ausgewählte-Ressourcen-Leiste und keine öffentliche Veröffentlichungsaktion.
- [ ] Neue Skills, vorhandene Skills, Custom-MCPs und Composio über den gemeinsamen Katalog auswählen. Composio-Logos, Paketbilder und bestehende MCP-Domainbilder nutzen; Initialen als Fallback.
- [ ] Das generierte SVG über die bestehenden geschützten Bild-/Paketpräsentationsdienste in Karten, Details und Inline-Referenzen anzeigen. Zugänglichen Host-Alttext beziehungsweise ein semantisches Äquivalent bereitstellen; im kleinen Inline-Kontext neben bereits sichtbarem Namen keine redundante Ansage. Lesbarkeit bei kleinen Größen, Skalierung, Kontrast, hell/dunkel, Reload und Versionswechsel prüfen. Initialen bleiben ein Lade-/Legacyfallback, kein erfolgreicher Abschluss einer neuen fehlerhaften Grafik.
- [ ] Native Creator-Einstiege verwenden dieselbe Inline-Referenz und serverseitige Autorität. Entwurfsvorschau/-fortsetzung über klar unterstützte Mobile-Verträge bereitstellen; ältere Clients zeigen verständlich fehlende Fähigkeit an.

**Hauptdateien:** `PluginExtensionWorkspace.tsx`, `PluginWorkspace.tsx`, `PackageDraftsWorkspace.tsx`, `PackageEditorSection.tsx`, Plugin-Navigation und Chatstartadapter; Mobile-Erweiterungshub, Chat-/Entwurfsnavigation und API-Adapter.

**Abnahme:** Desktop und schmale Darstellung, Reload, direkter Entwurfslink, Navigation mit ungespeicherten Änderungen, fremder oder entzogener Zugriff. Zweckgrafik ist im tatsächlichen UI sichtbar und sinnvoll skaliert; Alttext/semantisches Äquivalent vorhanden. Derselbe Inhalt erscheint im Chat und unter „Meine Entwürfe“.

### P6 — Organisationsbereitstellung, Einrichtung und genaue Laufzeitübergabe abschließen

- [ ] Vorhandene Requirements-, Setup-, Presentation-, Account- und Workflowdienste für das neue Paket wiederverwenden.
- [ ] Persönliche Composio-Profile/Accounts und eigene MCPs exakt wählen; freigegebene Quellen nur innerhalb vorhandener Grants verwenden. Eine Definitionsliste oder ein passender Anzeigename ersetzt keine bestätigte Zuordnung.
- [ ] Organisations-Publish, beauftragte Nutzungsfreigabe, Aktivierung und Aufnahme in einen Chat/Agenten als verständliche Schritte führen. Nutzungsadressat und bestehende Orgpolicy bestimmen den zulässigen Use-Grant beziehungsweise die Use-Regel. Org-Verwaltung und Aktivierung allein gelten nicht als Nutzungsberechtigung; keine zusätzlichen Edit-/Manage-Grants an alle Mitglieder vergeben.
- [ ] Scheitern Freigabe/Aktivierung nach erfolgreichem Publish, die bereits erzeugte Version und den offenen Schritt anzeigen und gezielt fortsetzen; keine zweite Veröffentlichung als Ersatz. Bereits vom Erstellauftrag umfasste Bereitstellung ohne pauschale erneute Bestätigungsrunde abschließen.
- [ ] Vor Publish nur Vorschau/strukturelle Prüfung; ein Verhaltenstest verwendet erst danach die genaue Org-Veröffentlichungsrevision über den normalen Resolver. Skills, Dateilesewurzeln und Toolregeln stimmen mit dieser Revision überein; kein pauschales Laden aller Integrationen und keine persönliche Previewressource als zusätzlicher Produktweg.
- [ ] Nach erfolgreichem Publish ist der ursprüngliche Entwurf verbraucht. Weiterbearbeitung öffnet einen neuen Edit-Entwurf mit erneuten Ziel-, Quell- und Revisionsprüfungen. Ein Prüfergebnis gehört nur zum genau getesteten Stand und wird nicht ungeprüft auf eine spätere Version übertragen.
- [ ] Bei Updates Bedeutung und Identitäten stabil halten. Neue Paketversionen benötigen einen bewussten Vergleich und erneute zulässige Verbindungszuordnung. Die vorhandene Binding-Retention gilt nur für identische Revisionsslots und ist keine automatische Migration zwischen Versionen.

**Hauptdateien:** vorhandene Paket-Presentation-/Requirementsdienste, `capabilities/resources` und Paketaktivierung, `agents/workflow-*`, `integration-tools/workflow-personal-bindings.ts`, Chat-Referenz-/Kontextdienste; keine zweite Providerregistry.

**Abnahme:** Ein berechtigtes Orgmitglied kann das freigegebene aktivierte Paket verwenden; ein Nutzer ohne Use-Recht trotz lesbarer/verwaltbarer Metadaten nicht. Zweiter Nutzer verwendet eigene zulässige Accounts; eine fremde Organisation erhält keinen Zugriff. Nach Publish wird für Bearbeitung ein neuer Edit-Entwurf angelegt. Mehrere Accounts, optionale/erforderliche Capabilities, gesperrte Tools, `provider_unavailable`, veraltete Schema-/Paketbelege und widerrufene Rechte werden korrekt unterschieden. Kein automatischer Accountwechsel, Rechtezuwachs oder Wiederholen ungewisser Geschäftsaktionen.

### P7 — Vertikalen Referenzfall und Abschlussabnahme liefern

- [ ] Account-Brief-Beispiel aus Abschnitt 4 mit neuem Skill, autorisiert übernommenem DOCX-Skill, Custom-MCP, Composio und neu erzeugtem Zweck-SVG vollständig durch den Creator als Orgpaket erzeugen. Mindestens ein echter Agentenlauf muss die Creator-Anleitung und die normalen Gateway-/Datei-/Validierungs-/Publishoperationen verwenden; ein vorgebautes Manifest oder bloße Toolmocks ersetzen diesen Nachweis nicht.
- [ ] Den vollständigen Erstellungs-/Bündelungsablauf mit Playwright im verwalteten Teststack prüfen: Einstieg per `/` und Pluginseite, Auftrag, Entwurf, Quellenaufnahme, Grafik, Vorschau, Validierung, Org-Speicherung, Use-Grant/Aktivierung, Reload, Suche, Chat-/Agentreferenz und Verwendung der genauen veröffentlichten Revision. API-/SQL-/Datei-/Checksumme unabhängig mit dem sichtbaren Ergebnis abgleichen.
- [ ] Kontrollierte MCP-/Composio-Dienste für deterministische Toolfälle verwenden, bei echten Canvas-API-/SQL-/Kontextwegen. Tatsächliche Discovery, Accountzuordnung, Schemaabfrage und gezielte Ausführung prüfen. Fixture-Providerergebnisse und reale externe Providerabnahmen getrennt ausweisen; ein Dummy-Endpunkt gilt nicht als Nachweis einer erreichbaren Geschäftsintegration.
- [ ] Negativfälle durch dieselben Produktwege prüfen: fehlender/fehlerhafter Skill, ungültiges Schema oder SVG, Grafik gelöscht nach Validate, Namens-/Revisionskonflikt, Rechteentzug, fremde Organisation, nicht berechtigter Ersteller, fehlendes Use-Recht trotz Aktivierung, Providerfehler sowie Antwortverlust nach Commit. Kein ungültiges veröffentlichtes Paket und kein Duplikat.
- [ ] Grafiken in Karten, Details und Inline-Referenzen tatsächlich visuell prüfen: kleine Größen, Desktop/schmale Darstellung, hell/dunkel, Kontrast, Zuschnitt und zugängliche Einbettung. Fortsetzung in anderem Chat, Bearbeitung als neue Version und unveränderte alte Pins ebenfalls abnehmen. Unterstützte native Einstiege haben eigene Clientnachweise; Web-E2E ersetzt keine native Geräteabnahme.
- [ ] Die isolierte Testorganisation im vorhandenen verwalteten Teststack nutzen; keine zweite parallele Testumgebung. Den Skill `canvas-local-team-seat-dev` befolgen, vor einem ausdrücklich erforderlichen Containerbuild `npm run build` bestehen lassen und aktuelle Testcontainer neu laden. Browser-/Containerläufe gehören zur späteren Implementierungsabnahme, nicht zur jetzigen Planänderung.

**Abschlusskriterium:** P7 gilt erst mit nachvollziehbaren E2E-Laufbelegen, echtem Creator-Agentenlauf, unabhängiger Paket-/Datenprüfung und tatsächlicher Sichtprüfung als fertig. Schema-/API-Tests allein reichen nicht. Marketplacepublikation ist kein Abnahmeschritt.

## 6. Abnahmematrix

| Fall | Erwartetes Ergebnis |
| --- | --- |
| Neuer Skill ohne Integration | Vollständiger privater Entwurf mit Organisationsziel, Validierung, Org-Version und freigegebene Nutzung ohne Plugin-Zwang. |
| Plugin mit neuem und vorhandenem Skill | Exakte vollständige Aufnahme; richtige Herkunft und unabhängige Skillversionen. |
| Plugin-Kind mit Parent-Ressourcen übernehmen | Benötigte Dateien/Anforderungen vollständig auflösen und gezielt referenzieren; neue Ableitungsversion bei Änderungen. Kein Zwang zur Installation des Quellplugins. |
| Standalone-Skill mit eigener MCP-Deklaration einbetten | Connector-/Configübernahme zum Parent und gültige Referenzen; Konflikt statt stiller Überschreibung. |
| Neues Pluginbild | Beschreibendes gültiges SVG im Paket und im Manifest; tatsächliche Darstellung in Karten/Details/Referenzen geprüft, zugängliche Einbettung vorhanden. |
| Fehlendes SVG / ungültiges Schema / Änderungen nach Validierung | Verständlicher Datei-/Feldfehler; interner Publish blockiert, Entwurf reparierbar, alte veröffentlichte Pakete unverändert. |
| Erstellziel und Rechte | Neue Creator-Pakete ausschließlich für die authentifizierte Organisation; fehlende Verwaltungsrechte oder fremdes Ziel auch bei direktem Agent-/API-Aufruf abgewiesen. |
| Privater Organisationsentwurf | Nur der erstellende Aktor kann Entwurf/Operationsbeleg sehen; keine persönliche Paketveröffentlichung erforderlich. |
| Organisationsbesitz / Aktivierung / Nutzungsfreigabe | Getrennt geprüft; Aktivierung oder Verwaltung allein erlaubt keine Ausführung. Zulässige Use-Freigabe verleiht keine zusätzlichen Edit-/Manage-Rechte. |
| Custom-MCP plus Composio erforderlich | Beide Anforderungen müssen im gewählten Nutzungskontext erfüllt sein. |
| Tatsächlich austauschbare Alternativen | Eine zugelassene Alternative genügt; keine zusätzliche versehentliche Legacy-Pflicht. |
| Keine oder mehrere Composio-Accounts | Einrichtung beziehungsweise konkrete Auswahl; niemals „ersten Account“ verwenden. |
| Paket gültig, Provider nicht erreichbar | Org-Version darf bestehen; Nutzung/Probe zeigt den konkreten offenen Zustand. |
| Zwei Chats / Rechtewechsel / verlorene Antwort | CAS-Konflikt oder korrelierte Recovery über atomare Operationsbelege, auch nach bereits erfolgtem Commit und gelöschtem Entwurf; keine fremde Sichtbarkeit, Teilkopie oder doppelte Veröffentlichung. |
| Funktionsprobe und spätere Bearbeitung | Vor Publish nur strukturelle Prüfung/Vorschau; Probe an exakter Org-Version, Weiterbearbeitung in neuem Edit-Entwurf. E2E in isolierter Testorganisation. |
| Plugin für zwei Nutzer | Gleiches Orgpaket, jeweils eigene zulässige Accounts; keine Übernahme der Creator-Verbindung und kein Zugriff aus fremder Organisation. |
| Neue Pluginversion | Alte Pins bleiben exakt; Upgrade und neue Verbindungsbestätigung explizit. |
| Vollständiger Creator-E2E | Neuer plus vorhandener Skill, Custom-MCP, Composio und SVG durch realen Erstellungsweg; Schema, Org-Speicherung, Rechte, sichtbares Bild und tatsächlicher Tool-/Kontextweg belegt. |

Backend-/Parserprüfungen, tatsächliche API-/SQL-/Runtimeprüfungen, UI-Bedienung, native Builds/Geräte und reale Providerabnahme werden jeweils mit eigener Quelle und Ergebnis dokumentiert. Eine bestandene strukturelle Paketvalidierung ersetzt keinen funktionierenden Fachablauf.

## 7. Quellen und Anschluss

- [Bestehender Workflowvertrag](workflow-contract.md): portable Anforderungen, getrennte Account-/Connectionbindings, Runtime-Policies.
- [Canvas-Creator-Anleitungen](../../../../seed_skills/create-plugin/SKILL.md), [Skill Creator](../../../../seed_skills/skill-creator/SKILL.md).
- [Entwurfsverträge](../../../../app/lib/capabilities/packages/contracts.ts), [Schemen](../../../../app/lib/capabilities/packages/schemas.ts), [Store](../../../../app/lib/capabilities/packages/store.ts), [vollständiger Paketvalidator](../../../../app/lib/capabilities/packages/artifacts.ts).
- [Manifest und Bildpfade](../../../../app/lib/plugins/canvas-plugin-manifest.ts), [passive Paketbildprüfung](../../../../app/lib/capabilities/packages/package-icon-image.ts), [Organisationsrechte/Grants](../../../../app/lib/capabilities/resources/store.ts), [Paketaktivierung](../../../../app/lib/capabilities/packages/activation.ts).
- Vom Nutzer bereitgestellte Gestaltungsvorlage: `create-svg-illustrations/SKILL.md`, `references/core-rules.md` und `references/embedding.md`. Für den Creator werden die genannten kompakten Regeln als eigener vollständiger Core-Teilskill übernommen; ein lokaler Entwicklerpfad ist kein Laufzeitvertrag.
- [Marketplace-Registry am geprüften Commit](https://github.com/canvascoding/canvas-notebook-plugin-marketplace/blob/54ce6573502f67f4cb6227871000aa315ab87dbe/registry.json), [README](https://github.com/canvascoding/canvas-notebook-plugin-marketplace/blob/54ce6573502f67f4cb6227871000aa315ab87dbe/README.md), [Sales-Beispiel](https://github.com/canvascoding/canvas-notebook-plugin-marketplace/blob/54ce6573502f67f4cb6227871000aa315ab87dbe/plugins/sales-connectors-demo/1.0.0/.canvas-plugin/plugin.json).
- [Marketplace-Beitragsregeln](https://github.com/canvascoding/canvas-notebook-plugin-marketplace/blob/54ce6573502f67f4cb6227871000aa315ab87dbe/CONTRIBUTING.md), [Releaseverifier](https://github.com/canvascoding/canvas-notebook-plugin-marketplace/blob/54ce6573502f67f4cb6227871000aa315ab87dbe/scripts/document-suite-release.mjs), [CI](https://github.com/canvascoding/canvas-notebook-plugin-marketplace/blob/54ce6573502f67f4cb6227871000aa315ab87dbe/.github/workflows/validate-document-suite.yml).
- OpenAI als Bedienvorbild: [Skills erstellen](https://developers.openai.com/plugins/build/skills), [Plugins im Gespräch erstellen/bearbeiten](https://learn.chatgpt.com/docs/build-plugins). Canvas behält sein bestehendes Paketformat und seine eigene Authority; ein Formatwechsel auf OpenAI-Manifeste ist für diesen Ausbau nicht nötig.

Die historischen Marketplace-Befunde bleiben Referenz für die getrennte Maintainerarbeit. Die frühere P6-Planung für Public-Export/Marketplace-CI ist durch die Scope-Präzisierung ersetzt und keine Voraussetzung für diesen Ausbau.

Dieser Plan ergänzt die bestehende gemeinsame Suche und Inline-Kontextübergabe um organisationsverwaltete Erstellung, Schema-/SVG-Prüfung und vollständige E2E-Abnahme. Er behauptet keine bereits abgeschlossene Implementierung oder durchgeführte Browser-/Providerprüfung.
