# Skill- und Plugin-Erstellung: konkreter Umsetzungsplan

Stand: 16. Oktober 2026. **Planung; keine Produktimplementierung dieses Ausbaus.**

Ziel: Nutzer beschreiben einen wiederkehrenden Ablauf. Canvas erstellt daraus einen eigenständigen Skill oder ein Plugin aus vollständigen Skills und deklarierten Integrationsanforderungen. Erstellung, Bearbeitung, Wiederaufnahme, private Verwendung und spätere Verteilung verwenden denselben Paketlebenszyklus.

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
- Ein Child-Verzeichnis ist nicht automatisch ein eigenständiges Paket: Die UI-Metadaten des Sales-Skills referenzieren `../../assets/icon.svg` im Elternplugin. `sourcePlugin` beschreibt die Herkunft, keinen automatischen Parent-Installvertrag. Eine vollständige Einzelinstallation wurde hier nicht ausgeführt; der Export muss solche Abhängigkeiten ausdrücklich auflösen.
- Document Suite 1.4.0 wurde ausdrücklich vor dem erforderlichen Excalidraw-Backendupdate veröffentlicht. Der Releasebeleg lässt `backendRelease` und `minCanvasVersion` ehrlich auf `null`. Eine Installation beweist nicht das Vorhandensein der Scene-Service-Tools.
- `CONTRIBUTING.md:26` verlangt noch, Document Suite 1.4.0 außerhalb der Registry zu halten. Das widerspricht dem aktuellen README und dem tatsächlichen Veröffentlichungsbeleg.
- Die einzige CI ist auf Document Suite und Mermaid zugeschnitten. Der Document-Suite-Verifier bindet sogar die vollständigen aktuellen Registrybytes an einen historischen Releasebeleg. Neue Katalogeinträge würden diesen Gate ohne gezielten Umbau brechen. Historische Belege werden deshalb nicht bei jeder neuen Veröffentlichung umgeschrieben.

### Bereits vorhandene Canvas-Bausteine

- `skill-creator` und `create-plugin` sind geschützte Core-Skills. Ihre Workspace-Werkzeuge können vollständige Pakete erstellen, persönlich installieren und mit Versions-/Checksum-Prüfung aktualisieren.
- Der neuere gemeinsame Paketservice verwaltet aktorprivate Entwürfe, Dateien, vollständige Validierung, unveränderliche Veröffentlichungsrevisionen, Eigentum und Freigaben. Seine Entwurfsanlage kennt bisher nur `edit` und `fork` einer vorhandenen Quelle.
- Die aktorprivate Entwurfsliste existiert bereits als REST-Weg. Dem Agenten fehlen gleichwertige Listen-/Recovery-Operationen. Der Editor setzt zur Wiederaufnahme noch eine vorhandene Quellressource voraus.
- `workflow.version: 1` und `integrationCapabilities` bilden bereits MCP-/Composio-Anforderungen ab. Private Agent-/Chatbindungen, konkrete Accountauswahl, Toolgrenzen und präzise Kontextübergabe existieren ebenfalls.
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

Ein neuer Child-Skill kann direkt im Pluginentwurf entstehen. Eine vorherige Installation als eigenständiger Skill ist dafür nicht erforderlich. Soll er zusätzlich einzeln angeboten werden, wird das später aus demselben geprüften Inhalt abgeleitet.

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

Für übernommene Quellen gilt bis zur Veröffentlichung mindestens die bestehende Fork-Semantik: aktuelle Quellleserechte und Zielberechtigung werden erneut geprüft. Herkunftsreferenzen werden privat am Entwurf geführt und sind selbst keine Autoritätsbelege. Öffentliche Weitergabe benötigt zusätzlich nachvollziehbare Lizenz-/Autorenangaben; ein Leserecht ist kein Nachweis einer öffentlichen Weiterverbreitungserlaubnis.

## 3. Konkreter Nutzerablauf

1. **Einstieg:** `/Skill Creator`, `/Plugin Creator` oder „Erstellen → Skill / Plugin“ auf der Plugin-Seite. Die Auswahl bleibt eine Inline-Referenz im Text. Der Seitenknopf öffnet denselben Chat mit passender Creator-Referenz.
2. **Ziel klären:** Zweck, Eingaben und gewünschtes Ergebnis aus dem Auftrag übernehmen. Nur fehlende Angaben nachfragen. Beim Plugin zusätzlich neue/vorhandene Skills und benötigte Integrationen bestimmen.
3. **Entwurf anlegen:** Ein aktorprivater Paketentwurf entsteht im gemeinsamen Dienst. Der Chat nennt einen Link zum Entwurf. Derselbe Entwurf erscheint unter „Meine Entwürfe“ und lässt sich in einem anderen Chat fortsetzen.
4. **Zusammenstellen:** Neue Skills direkt im Entwurf schreiben; vorhandene Skills kontrolliert aufnehmen. Die Integrationssuche verwendet denselben Katalog wie die übrige App und zeigt vorhandene, noch einzurichtende und nicht verfügbare Verbindungen getrennt.
5. **Vorschau:** Zunächst Name, Zweck, enthaltene Abläufe, erforderliche/optionale Verbindungen und fehlende Voraussetzungen zeigen. Dateien, Manifest, technische Identitäten und Versionsdetails erst unter „Details“.
6. **Prüfen und ausprobieren:** Vollständige strukturelle Paketvalidierung. Ein Verhaltenstest verwendet eine genau bekannte Veröffentlichung einer nutzereigenen, nach aktuellen Grants nicht geteilten Ressource und den normalen Kontext-/Rechtepfad; unbearbeitete Draft-Dateien werden nicht an der Runtime-Autorisierung vorbei ausgeführt. Bei einem Team-/Organisationsziel oder einem bereits geteilten persönlichen Ziel entsteht dafür aus dem exakten Entwurfsstand eine neue private Previewressource ohne Fremdfreigaben. Die Probe veröffentlicht keinen geteilten Head. Ein privater Probestand ist als gespeicherte Version erkennbar.
7. **Verwenden:** „Für mich verwenden“ führt private Veröffentlichung und die beauftragte Aktivierung über bestehende Aktionen aus. Bereits ausdrücklich beauftragte private Erstellung/Verwendung benötigt keine zusätzliche pauschale Bestätigungsrunde. Team-/Organisationsfreigabe und öffentliche Distribution bleiben eigene, konkret beauftragte Vorgänge.
8. **Ergebnis:** Link, Version, enthaltene Skills und genauer Einrichtungsstatus. „Im Chat ausprobieren“ verwendet wieder die gemeinsame Inline-Auswahl; ein spezialisierter Agent bekommt dieselben exakten Paket-/Verbindungsverträge.

Die Zustände **Paket gültig**, **Version gespeichert/installiert**, **Verbindungen eingerichtet**, **aktuelle Toolnutzung geprüft** und **Beispiel ausprobiert** bleiben getrennte Ergebnisse. `authorized`/`healthy` oder eine optionale Empfehlung beweisen keine aktuelle Provider-Erreichbarkeit. Bei `provider_unavailable` wird weder Erfolg behauptet noch automatisch getrennt, erneut verbunden oder ein anderes Konto gewählt.

Ein gültiger Entwurf darf mit offenen Verbindungen privat gespeichert werden. Der Creator zeigt dann „Einrichtung erforderlich“ beziehungsweise „Tools ungeprüft“. Ein Probefall folgt den bestehenden Ausführungs-/Reviewregeln und wiederholt keine Aktion mit ungewissem Ausgang. Externe Geschäftsaktionen sind kein beiläufiger Verbindungstest.

## 4. Beispiel: Account-Brief-Plugin

Geplanter vertikaler Abnahmefall, kein bereits vorhandenes Marketplacepaket:

- Neuer Skill `account-brief`: aus CRM- und Researchdaten einen nachvollziehbaren Firmenbrief vorbereiten.
- Vorhandener DOCX-Skill aus genau gewählter Document-Suite-Veröffentlichung: als vollständigen Inhalt mit eigener Skillversion übernehmen.
- Composio-App HubSpot: konkrete CRM-Anforderung; tatsächliche Tools erst nach Discovery/Describe eintragen.
- Custom-MCP `company-research`: vorhandenen Server exakt zuordnen oder über den bestehenden MCP-Setupweg einrichten.
- Eigenständiger Skill bleibt separat erstellbar; die Kombination wird als Plugin gespeichert.

```text
account-brief-suite/
  .canvas-plugin/plugin.json
  skills/account-brief/SKILL.md
  skills/account-brief/agents/canvas.yaml
  skills/docx/SKILL.md
  skills/docx/...vollständige Ressourcen...
  connectors/...nur tatsächlich verwendete MCP-Vorlagen...
  assets/...tatsächliche Icons/Logos...
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

Alle Punkte sind **offen**. Jeder Schritt erhält seine Abnahme vor dem nächsten Integrationsschritt.

### P1 — Gemeinsamen Entwurf um echte Neuanlage und Wiederaufnahme erweitern

- [ ] `operation: 'create'` für Skill/Plugin, stabilen Namen und erlaubten Zielbereich ergänzen.
- [ ] Diskriminierten Herkunftsvertrag für neue gegenüber aus einer Quelle abgeleiteten Entwürfen einführen. Keine erfundenen Quellrevisionen und keine aufgeweichten Source-Prüfungen für `edit`/`fork`.
- [ ] Store, additive Datenmigration, Actions, Dateidienste und REST auf sourcefreie Neuanlage erweitern. Neue Ressourcen wie bei Fork erst beim erfolgreichen Publish atomar anlegen.
- [ ] Bestehende aktorprivate Listen-/Statusdienste als Agentoperationen bereitstellen; Wiederaufnahme über `draftRef` statt über einen versteckten Workspacepfad.
- [ ] Aktorprivate Korrelations-/Idempotenzschlüssel für Neuanlage und Veröffentlichung ergänzen. Den Veröffentlichungsbeleg `draftRef + draftRevision → resourceRef + publishedRevisionRef` atomar mit dem Publish dauerhaft speichern; verworfene Entwürfe als eigenes Ergebnis unterscheiden. Der aktuell beim Publish gelöschte Entwurf und ein späteres `404` genügen dafür nicht.
- [ ] Namenskonflikte, zwei schreibende Chats, Rechte-/Workspacewechsel und verlorene Antworten mit aktuellen Entwurfsrevisionen behandeln. Nach ungewissem Ergebnis zuerst den korrelierten Status/Beleg lesen, nicht blind neu anlegen/veröffentlichen. Ein Beleg ersetzt keine aktuelle Zugriffsprüfung auf den erzeugten Inhalt.

**Hauptdateien:** `app/lib/capabilities/packages/{contracts,schemas,actions,store,io}.ts`, zugehöriges DB-Schema/Migration, `app/api/capabilities/packages/drafts/`, `app/lib/pi/{scoped-tools,progressive-tool-gateway}.ts`.

**Abnahme:** Ohne installierte Quelle Skill und Plugin erstellen, schließen, in einem zweiten Chat wiederfinden und veröffentlichen. Antwortverlust nach tatsächlichem Create-/Publish-Commit findet denselben Entwurf beziehungsweise dieselbe erzeugte Version; keine zweite Anlage. Fremde Nutzer sehen Entwürfe und Operationsbelege nicht. Konflikt oder Rechteverlust erzeugt keine halbe freigegebene Ressource. Bestehende `edit`-/`fork`-Datensätze bleiben lesbar.

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
- [ ] Bisherige Core-Skill-IDs kompatibel erhalten; gespeicherte Referenzen und exakte alte Revisionpins nicht auf neue Eltern-/Kindidentitäten umschreiben. Doppelte Suchtreffer vermeiden.

**Hauptdateien:** `seed_skills/{skill-creator,create-plugin}`, systemeigene Creator-Paketdefinition/Loader, `app/lib/skills/core-skills.ts`, `app/lib/plugins/default-seed-plugins.ts`, Katalog-/Kontextadapter und Gatewayoperationen.

**Abnahme:** Natürlicher Auftrag und explizite `/`-Referenz führen zur richtigen Creator-Anleitung und aktuellen Tools. Bestehende verwaltete Pakete lassen sich bearbeiten, ohne im Legacy-Installer zu enden. Unterbrechung und Fortsetzung im anderen Chat behalten denselben Entwurf.

### P4 — Progressive Oberfläche im Web und passenden Mobile-Einstieg anschließen

- [ ] Auf der aktiven Plugin-Seite „Erstellen → Skill / Plugin“ anbieten; denselben Creator-Chat verwenden.
- [ ] Paketeditor und Entwurfsnavigation ohne vorausgesetzte Quellressource öffnen. Neu/übernommen, Herkunft und Versionsänderungen verständlich zusammenfassen.
- [ ] Zweck, Skills, Anforderungen und Status zuerst; gerenderte Skill-Vorschau und technische Dateien unter Details. Keine neue ausgewählte-Ressourcen-Leiste.
- [ ] Neue Skills, vorhandene Skills, Custom-MCPs und Composio über den gemeinsamen Katalog auswählen. Composio-Logos, Paketbilder und bestehende MCP-Domainbilder nutzen; Initialen als Fallback.
- [ ] Native Creator-Einstiege verwenden dieselbe Inline-Referenz und serverseitige Autorität. Entwurfsvorschau/-fortsetzung über klar unterstützte Mobile-Verträge bereitstellen; ältere Clients zeigen verständlich fehlende Fähigkeit an.

**Hauptdateien:** `PluginExtensionWorkspace.tsx`, `PluginWorkspace.tsx`, `PackageDraftsWorkspace.tsx`, `PackageEditorSection.tsx`, Plugin-Navigation und Chatstartadapter; Mobile-Erweiterungshub, Chat-/Entwurfsnavigation und API-Adapter.

**Abnahme:** Desktop und schmale Darstellung, Reload, direkter Entwurfslink, Navigation mit ungespeicherten Änderungen, fremder oder entzogener Zugriff. Derselbe Inhalt erscheint im Chat und unter „Meine Entwürfe“.

### P5 — Einrichtung, private Verwendung und genaue Laufzeitübergabe abschließen

- [ ] Vorhandene Requirements-, Setup-, Presentation-, Account- und Workflowdienste für das neue Paket wiederverwenden.
- [ ] Persönliche Composio-Profile/Accounts und eigene MCPs exakt wählen; freigegebene Quellen nur innerhalb vorhandener Grants verwenden. Eine Definitionsliste oder ein passender Anzeigename ersetzt keine bestätigte Zuordnung.
- [ ] Private Veröffentlichung, Aktivierung und Aufnahme in einen Chat/Agenten als verständliche Aktionen führen. Scheitert Aktivierung nach erfolgreichem Publish, die bereits erzeugte Version anzeigen und gezielt fortsetzen; keine zweite Veröffentlichung als Ersatz.
- [ ] Private Tests ausschließlich an nutzereigenen Ressourcen ohne Fremdfreigaben ausführen. Ein eigenes Ziel nur bei erneut geprüfter privater Autorität/Grants direkt veröffentlichen. Sonst den genauen Entwurfsstand in eine neue nutzereigene Previewressource ohne Fremdfreigaben übernehmen und dort normal veröffentlichen; das gilt auch für bereits geteilte persönliche Ziele. Revisionen besitzen aktuell keine eigene Sichtbarkeit. Deshalb niemals einen geteilten Ziel-Head für einen privaten Versuch aktualisieren; dessen Entwurf bleibt erhalten.
- [ ] Der Testchat erhält die genaue private Veröffentlichungsrevision über den normalen Resolver. Skills, Dateilesewurzeln und Toolregeln stimmen mit dieser Revision überein; kein pauschales Laden aller Integrationen. Ein Prüfergebnis gehört nur zum genau getesteten Stand und wird nicht ungeprüft auf ein späteres Ziel übertragen.
- [ ] Nach erfolgreichem Publish ist der ursprüngliche Entwurf verbraucht. Weiterbearbeitung einer veröffentlichten eigenen Version öffnet einen neuen Edit-Entwurf. Veröffentlichung im Team-/Organisationsziel bleibt ein eigener, beauftragter Schritt mit erneuten Ziel-, Quell- und Revisionsprüfungen.
- [ ] Bei Updates Bedeutung und Identitäten stabil halten. Neue Paketversionen benötigen einen bewussten Vergleich und erneute zulässige Verbindungszuordnung. Die vorhandene Binding-Retention gilt nur für identische Revisionsslots und ist keine automatische Migration zwischen Versionen.

**Hauptdateien:** vorhandene Paket-Presentation-/Requirementsdienste, `agents/workflow-*`, `integration-tools/workflow-personal-bindings.ts`, Chat-Referenz-/Kontextdienste; keine zweite Providerregistry.

**Abnahme:** Zweiter Nutzer verwendet eigene Accounts; zentrale Agentregeln bleiben unverändert. Privater Versuch eines Team-/Organisationsziels oder eines bereits geteilten persönlichen Ziels ändert dessen Head/Grants nicht und bleibt für andere Nutzer unsichtbar. Fortsetzung nach Testpublish erzeugt einen passenden neuen Edit-Entwurf. Mehrere Accounts, optionale/erforderliche Capabilities, gesperrte Tools, `provider_unavailable`, veraltete Schema-/Paketbelege und widerrufene Rechte werden korrekt unterschieden. Kein automatischer Accountwechsel, Rechtezuwachs oder Wiederholen ungewisser Geschäftsaktionen.

### P6 — Exakten Export und allgemeinen Marketplace-Veröffentlichungsweg bauen

- [ ] Notebook exportiert genau `resourceRef + publishedRevisionRef + checksum`, vollständige Child-Inhalte und bereinigte portable Metadaten. Eine geänderte Quelle nach Verpackung erfordert einen neuen Export; keine nachträgliche Mutation des geprüften Archivs.
- [ ] Paketformatvalidator und kanonische Paketbaum-Checksumme über einen schmalen, versioniert verwendbaren Node-/CLI-Einstieg im Notebook-Tooling zugänglich machen. Marketplace-CI verwendet dieselbe gepinnte Formatlogik; Actor-/Organisationspolitik und GitHub-Orchestrierung bleiben getrennt.
- [ ] Marketplace erhält generische Prüfungen für alle Pakete, Registry-/Manifestparität, Skill-Unterpfade, veröffentlichte Versionsverzeichnisse, Tags und Checksummen. ZIP-Hash und kanonische Paketchecksumme nicht verwechseln.
- [ ] Historische Document-Suite-Nachweise unverändert erhalten. Historischen Registrysnapshot als solchen prüfen; die aktuelle Registry darf durch neue Einträge wachsen, während bereits veröffentlichte Versionsdaten unverändert bleiben.
- [ ] Widerspruch in `CONTRIBUTING.md` korrigieren und den allgemeinen Weg dokumentieren: neue Version → Paketprüfung → PR → Review/Checks → unveränderlicher Tag/Archiv → genau dazu passender Registryeintrag. Eine Vorbereitung darf keinen aktiven Download auf einen noch fehlenden Tag veröffentlichen.
- [ ] Einzelangebote nur nach Prüfung ihrer vollständigen Eigenständigkeit ableiten: Parent-Assets, Configs, Connectoren und Workflowanforderungen müssen im eigenständigen Skillformat enthalten und korrekt referenziert sein. Ein bloßer Plugin-Unterpfad oder `sourcePlugin` erfüllt diesen Vertrag nicht.
- [ ] Ist der Child-Inhalt bereits eigenständig, genau diesen Inhalt mit eigener Skillversion/Checksumme referenzieren. Andernfalls erforderliche Ressourcen und Deklarationen durch eine nachvollziehbare Exporttransformation übernehmen, Pfade gezielt anpassen und eine abgeleitete Skillversion mit eigener Checksumme erzeugen; bei nicht auflösbaren Abhängigkeiten kein Einzelangebot veröffentlichen. `sourcePlugin` bleibt Herkunft, kein Parent-Installvertrag. Keine unabhängig gepflegte zweite Quelle und keine Mutation veröffentlichter Altversionen.
- [ ] Internes Publish, persönliche Verwendung, Teamfreigabe und öffentlicher Marketplace bleiben getrennte Veröffentlichungsreichweiten. Der Creator kann ein Einreichungspaket vorbereiten; ein Public-Publish wird nicht still aus „Plugin erstellen“ abgeleitet.

**Hauptdateien:** Notebook-Paketexport/-tooling; Marketplace-`registry.json`, `schemas/registry.schema.json`, generische Validierungs-/Releaseadapter, `.github/workflows/`, `CONTRIBUTING.md`. Bereits veröffentlichte Plugin-/Skillverzeichnisse werden nicht nachträglich geändert.

**Abnahme:** Ein neues Plugin und ein abgeleiteter Einzelskill lassen sich hinzufügen, ohne Document Suite 1.4.0 oder alte Receipts umzuschreiben. Der Einzelskill funktioniert strukturell ohne installierten Parent, einschließlich zuvor externer Icons und erforderlicher Connector-/Workflowdeklarationen. Tatsächlich erzeugtes Archiv, Tagpfad, Manifest, Registrymetadaten und beide Checksummen stimmen überein. Unbelegte Backendminimumversionen werden nicht erfunden.

### P7 — Vertikalen Referenzfall und Abschlussabnahme liefern

- [ ] Account-Brief-Beispiel aus Abschnitt 4 mit neuem Skill, autorisiert übernommenem DOCX-Skill, Custom-MCP und Composio vollständig durch den Creator erzeugen.
- [ ] Für deterministische Integrationstests kontrollierte MCP-/Composio-Dienste und echte Canvas-API-/SQL-/Kontextpfade nutzen; Provider-Geschäftsaktionen getrennt ausweisen.
- [ ] Den Beispielworkflow als neue Version beziehungsweise neues Referenzplugin vorbereiten. Sales Connectors Demo 1.0.0 und andere veröffentlichte Pakete unverändert lassen.
- [ ] Ein öffentliches Beispiel benötigt einen belegten Zielserver oder ein ehrliches Setup für die eigene bestätigte MCP-Verbindung. Ein Dummy-Endpunkt wird nicht als funktionsfähig oder „ready“ ausgewiesen.
- [ ] Tatsächliche Creator-Bedienung im Web und auf den unterstützten nativen Oberflächen prüfen: Erstellen, Fortsetzen, Probe, Verwenden, Bearbeiten, neue Version und Export.

## 6. Abnahmematrix

| Fall | Erwartetes Ergebnis |
| --- | --- |
| Neuer Skill ohne Integration | Vollständiger privater Entwurf, Validierung, private Version und normale Nutzung ohne Plugin-Zwang. |
| Plugin mit neuem und vorhandenem Skill | Exakte vollständige Aufnahme; richtige Herkunft und unabhängige Skillversionen. |
| Plugin-Kind mit Parent-Ressourcen übernehmen oder einzeln anbieten | Benötigte Dateien/Anforderungen vollständig auflösen und gezielt referenzieren; neue Ableitungsversion bei Änderungen, ansonsten kein Einzelangebot. Kein Zwang zur Installation des Quellplugins. |
| Standalone-Skill mit eigener MCP-Deklaration einbetten | Connector-/Configübernahme zum Parent und gültige Referenzen; Konflikt statt stiller Überschreibung. |
| Custom-MCP plus Composio erforderlich | Beide Anforderungen müssen im gewählten Nutzungskontext erfüllt sein. |
| Tatsächlich austauschbare Alternativen | Eine zugelassene Alternative genügt; keine zusätzliche versehentliche Legacy-Pflicht. |
| Keine oder mehrere Composio-Accounts | Einrichtung beziehungsweise konkrete Auswahl; niemals „ersten Account“ verwenden. |
| Paket gültig, Provider nicht erreichbar | Private Version darf bestehen; Nutzung/Probe zeigt den konkreten offenen Zustand. |
| Zwei Chats / Rechtewechsel / verlorene Antwort | CAS-Konflikt oder korrelierte Recovery über atomare Operationsbelege, auch nach bereits erfolgtem Commit und gelöschtem Entwurf; keine fremde Sichtbarkeit, Teilkopie oder doppelte Veröffentlichung. |
| Privater Versuch bei Team-/Organisationsziel oder geteiltem persönlichem Ziel | Nutze ausschließlich nutzereigene Previewressource ohne Fremdfreigaben; geteilter Head und Entwurf bleiben erhalten. Nach eigenem Testpublish neuen Edit-Entwurf verwenden. |
| Plugin für zwei Nutzer | Gleiches portables Paket, jeweils eigene zulässige Accounts; keine Übernahme der Creator-Verbindung. |
| Neue Pluginversion | Alte Pins bleiben exakt; Upgrade und neue Verbindungsbestätigung explizit. |
| Marketplace-Export | Keine privaten IDs/Secrets; kanonische Dateien, Skillpfade, Herkunft, Lizenzen und Checksummen nachvollziehbar. |
| Neuer Katalogeintrag | Alte Versionsdateien, Tags und historische Releasebelege bleiben unverändert und prüfbar. |

Backend-/Parserprüfungen, tatsächliche API-/SQL-/Runtimeprüfungen, UI-Bedienung, native Builds/Geräte und reale Providerabnahme werden jeweils mit eigener Quelle und Ergebnis dokumentiert. Eine bestandene strukturelle Paketvalidierung ersetzt keinen funktionierenden Fachablauf.

## 7. Quellen und Anschluss

- [Bestehender Workflowvertrag](workflow-contract.md): portable Anforderungen, getrennte Account-/Connectionbindings, Runtime-Policies.
- [Canvas-Creator-Anleitungen](../../../../seed_skills/create-plugin/SKILL.md), [Skill Creator](../../../../seed_skills/skill-creator/SKILL.md).
- [Entwurfsverträge](../../../../app/lib/capabilities/packages/contracts.ts), [Schemen](../../../../app/lib/capabilities/packages/schemas.ts), [Store](../../../../app/lib/capabilities/packages/store.ts), [vollständiger Paketvalidator](../../../../app/lib/capabilities/packages/artifacts.ts).
- [Marketplace-Registry am geprüften Commit](https://github.com/canvascoding/canvas-notebook-plugin-marketplace/blob/54ce6573502f67f4cb6227871000aa315ab87dbe/registry.json), [README](https://github.com/canvascoding/canvas-notebook-plugin-marketplace/blob/54ce6573502f67f4cb6227871000aa315ab87dbe/README.md), [Sales-Beispiel](https://github.com/canvascoding/canvas-notebook-plugin-marketplace/blob/54ce6573502f67f4cb6227871000aa315ab87dbe/plugins/sales-connectors-demo/1.0.0/.canvas-plugin/plugin.json).
- [Marketplace-Beitragsregeln](https://github.com/canvascoding/canvas-notebook-plugin-marketplace/blob/54ce6573502f67f4cb6227871000aa315ab87dbe/CONTRIBUTING.md), [Releaseverifier](https://github.com/canvascoding/canvas-notebook-plugin-marketplace/blob/54ce6573502f67f4cb6227871000aa315ab87dbe/scripts/document-suite-release.mjs), [CI](https://github.com/canvascoding/canvas-notebook-plugin-marketplace/blob/54ce6573502f67f4cb6227871000aa315ab87dbe/.github/workflows/validate-document-suite.yml).
- OpenAI als Bedienvorbild: [Skills erstellen](https://developers.openai.com/plugins/build/skills), [Plugins im Gespräch erstellen/bearbeiten](https://learn.chatgpt.com/docs/build-plugins). Canvas behält sein bestehendes Paketformat und seine eigene Authority; ein Formatwechsel auf OpenAI-Manifeste ist für diesen Ausbau nicht nötig.

Dieser Plan ergänzt die bestehende gemeinsame Suche und Inline-Kontextübergabe. Er behauptet keine bereits abgeschlossene Creator-Implementierung, automatische MCP-Bereitstellung oder öffentliche Marketplace-Publikation.
