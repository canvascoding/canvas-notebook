# Plugin-Seite: Plugins, Skills, Integrationen und MCP-Server gemeinsam suchen

Stand: 13. Oktober 2026. Die Schritte 1–5 sind implementiert und am Notebook-Stand `dc20226b1308f564236ba95799640c1c7e097db5` mit frischem Produktionsbuild und 15/15 Browserfällen lokal abgenommen. Die Browserprüfung verwendet echte Notebook-APIs, PostgreSQL, SDK-/HTTP-Verbindungen und kontrollierte Provider-/Store-Fixtures. Sie ist keine Drittanbieter-, Modell-, Geräte- oder Produktionsabnahme. Die Settings-Katalogliste ist in dieselbe Suche migriert; Profil- und Providerverwaltung bleiben in Settings. [Prüfstand, Nachweise und Grenzen](evidence/plugin-page-integration-catalog-acceptance-2026-10-13.md).

## Historische Bestandsaufnahme vor der Umsetzung

Die folgende Prüfung beschreibt die Ausgangsbasis `8d6401a08261ca4efe6063fed4001be024fdfb8d` vom 13. Oktober einschließlich des To-do-Fixes aus PR #170. Damals war die fachliche Grundlogik vorhanden: Ein Plugin konnte Skills, Scripts, MCP-Vorlagen und Composio-Anforderungen bündeln; einzelne Skills und Verbindungen waren eigenständig nutzbar. Die gemeinsame Such-, Einrichtungs- und Verwaltungsoberfläche fehlte noch. Für den heutigen Stand gelten die Statusbeschreibung oben und die Umsetzungstabelle unten.

| Bereich | Damals umgesetzt | Damalige Umsetzungslücke |
| --- | --- | --- |
| Plugin als Paket | Manifest mit Skills, MCP-/Composio-Connectoren und Workflow-Fähigkeiten; versionierte Installation, Herkunft, Updates und separate Freigaben. | Installation zeigt Anforderungen, führt deren konkrete Einrichtung aber nicht als zusammenhängenden Paketablauf. |
| Einzelner Skill | Eigener Store-/Ressourcentyp `skill`, unabhängige Installation und Verwaltung. Plugin-Skills behalten ihre Elternreferenz. | In der gemeinsamen Oberfläche Herkunft und eigenständige Installation verständlich unterscheiden. |
| Eigener MCP-Server | Persönliche Einstellungen mit bestehenden Transport-/Auth-Verträgen; gemeinsame Verbindungsressourcen mit eigenständigen Rechten. | Persönliche Einrichtung auf der Plugin-Seite fehlt. Gemeinsame Verbindungen liegen unter „Erweitert“; neue gemeinsame Server werden dort über HTTP eingerichtet. |
| Einzelne Composio-App | App-Katalog, Accounts, Profile, OAuth, lokale/Managed-Anbindung und gemeinsame Verbindungen sind vorhanden. | Keine Composio-Suche in der zentralen Plugin-Suche. Gemeinsame Erstellung verlangt bislang einen manuell eingegebenen Toolkit-Slug. |
| Plugin-Seite | Installiert, Store, Updates und Entwürfe; Bereichsauswahl, Suche und Typfilter für Plugins/Skills. | Integrationsangebote und tatsächliche Verbindungsinstanzen fehlen in diesen Hauptlisten. |
| Paket-Verbindungen | Aktuelle Detailseite zeigt deklarierte Anforderungen und separat die allgemeinen gemeinsamen Verbindungen; persönliche Verwaltung führt über „Erweitert“ zu Settings. | Keine durchgehend an konkreten Paketanforderungen ausgerichtete Auswahl, Einrichtung und Readiness. |
| Gemeinsamer Integrations-Gateway | Einheitliche Provider-Suche, aktuelle Rechte, explizite Referenzen, getrennte Zustände und Fehler; Composio-Seiten werden vollständig oder ausdrücklich teilweise erfasst. | Sichere Verwaltungsprojektion und gemeinsame UI fehlen. Die ältere Settings-Liste verwendet einen eigenen Katalogpfad. |

Quellen der damaligen Prüfung:

- [PluginWorkspace](../../../../app/components/plugins/PluginWorkspace.tsx): aktive Seitenschale; persönlicher Settings-Verweis und Paket-/Skill-Typfilter.
- [Plugin-Katalogvertrag](../../../../app/lib/plugins/plugin-workspace-catalog-contracts.ts): derzeit ausschließlich `plugin` und `skill`.
- [Paketdarstellung](../../../../app/components/plugins/PackageDetailPresentation.tsx) und [Paketdetails](../../../../app/components/plugins/PackageDetailWorkspace.tsx): deklarierte Anforderungen sind kein Account-/Erreichbarkeitsnachweis.
- [Installationswizard](../../../../app/components/plugins/StorePackageWizard.tsx): Vorschau, Freigabe und Abschluss; kein vollständiger Verbindungswizard.
- [Gemeinsame Verbindungsformulare](../../../../app/components/plugins/SharedConnectionForms.tsx): eigenständige MCP-/Composio-Erstellung, Profile, Auth und Freigaben.
- [ConnectedAppsPanel](../../../../app/components/settings/ConnectedAppsPanel.tsx): lokale Filterung der geladenen Liste; Katalogfehler werden beim Laden abgefangen, ohne einen eigenen Fehlerzustand zu zeigen.
- [Alte Toolkit-Registry](../../../../app/lib/composio/composio-toolkit-registry.ts) und [alte Toolkit-Route](../../../../app/api/composio/toolkits/route.ts): die Route reicht keine Such-/Cursorparameter weiter; der lokale SDK-Wrapper liefert keine verlässliche Cursor-Abdeckung.
- [Composio-Gateway-Adapter](../../../../app/lib/integration-tools/adapters/composio.ts): seitenfähiger Katalog, Profile, gemeinsame Verbindungen und ausdrückliche Teilfehler; [Gateway-Katalog](../../../../app/lib/integration-tools/catalog.ts): nur Metadaten, getrennte Quellenfehler.

Der frühere `PluginsPanel` enthält bereits Connector-Aktionen, ist aber nicht die von `/plugins` eingebundene neue Seitenschale. Vorhandener Code in diesem Panel beweist deshalb keinen aktuellen Bedienweg.

## Implementierter Stand

`/plugins` öffnet die gemeinsame Suche mit allen vier Typen und allen lesbaren Bereichen. Installiert und Verfügbar sind Bestandsfilter derselben Suche; Typ, Herkunft, Bereich, eigene/geteilte Ressourcen und Team sind optionale Filter. Details, OAuth-Rückkehr und Zurücknavigation behalten den Suchbegriff und die exakte Auswahl. Updates, Entwürfe und die erweiterte Verwaltung bleiben sekundäre Bedienwege.

Die [Verwaltungsprojektion](../../../../app/lib/plugins/plugin-extension-search.ts) und [authentifizierte Suchroute](../../../../app/api/plugins/search/route.ts) verwenden aktuelle menschliche Session-/Workspace-Rechte. Die [gemeinsame Seitenschale](../../../../app/components/plugins/PluginExtensionWorkspace.tsx) und [Einrichtung der Paketanforderungen](../../../../app/components/plugins/PackageRequirementsSetup.tsx) verwenden bestehende Formulare, Autorisierungswege und Agent-Konfiguration. MCP-Vorlagen und passende bestehende Zugänge werden aus dem exakten aktuellen Paket gelesen; gleiche Namen ersetzen weder Endpoint-/Prozesskompatibilität noch Ressourcen- oder Verbindungsreferenzen.

Verfügbare öffentliche Logos und bereichsgebundene Paketbilder erscheinen in Suchzeilen, Paket-/Skill-Details, Einrichtung und den weiteren aktiven Plugin-Listen. Der [gemeinsame Avatar](../../../../app/components/plugins/PluginExtensionAvatar.tsx) fällt bei fehlenden oder fehlgeschlagenen Bildern auf Namensinitialen zurück. Bildmetadaten sind an Quelle, Ressource und Kontext gebunden; installierte Bilder werden über eine erneut autorisierte exakte Ressourcenroute gelesen. Vorhandene MCP-Bildmetadaten werden nur bei passender aktueller Verbindung und Herkunft verwendet. Katalogdarstellung startet keine neue Provider-/Favicon-Suche.

Der Composio-Einstieg in Settings öffnet nun die gemeinsame Suche mit Integrationsfilter und dem aktuellen Workspace. Die separate Toolkit-Liste entfällt; Profilverwaltung und lokale Providerkonfiguration bleiben in Settings. Lokale API-Schlüssel werden über einen gezielten zentralen System-PATCH gespeichert; Rechteprüfung, Abort-/Kontextschutz und vorhandene persönliche MCP-Schreibwege bleiben erhalten. Der abschließende Browserfall bestätigt Profilwahl und Katalogöffnung im aktuellen Workspace.

## Fachliches Modell

**Das Plugin bleibt das bevorzugte vollständige Paket. Seine Bestandteile bleiben zugleich unabhängig nutzbar.**

Ein Plugin enthält konkrete Skill-/Script-Dateien sowie Integrationsanforderungen oder MCP-Konfigurationsvorlagen. Die tatsächlich verbundene Integration ist eine separate Instanz mit eigenem Account, Besitz, Berechtigungen und Zustand. Eine passende vorhandene Verbindung soll von mehreren Plugins verwendet werden können. Paketfreigabe und Accountfreigabe bleiben getrennte Entscheidungen.

Der UI-Katalog führt diese Typen zusammen, ohne Composio-Apps oder MCP-Verbindungen zu künstlichen Plugin-Paketen mit erfundener Paketversion/Checksumme umzudeuten:

| Sichtbarer Typ | Identität | Aktion |
| --- | --- | --- |
| Plugin-Paket | Exaktes Store-Angebot oder installierte Paketressource | Installieren, Einrichtung abschließen, verwalten |
| Einzelner Skill | Exaktes Skill-Angebot oder Skill-Ressource; gegebenenfalls mit Plugin-Herkunft | Installieren oder öffnen |
| Composio-Angebot | Quelle plus kanonischer Toolkit-Slug | Verbinden oder ohne Anmeldung verwenden |
| Verbundene Integration | Exakte persönliche/gemeinsame Verbindung einschließlich Bereich und Profil/Accountbindung | Verwenden, prüfen oder bei Manage-Recht verwalten |
| Eigener MCP-Server | Exakte Server-/Verbindungsidentität | Einrichten, autorisieren oder verwalten |

Composio nennt seine App-Angebote „Toolkits“; deren Tools können über API/SDK oder MCP bereitgestellt werden. In Canvas verwendet die bestehende Anbindung einen Composio-Adapter. Die verständliche UI-Bezeichnung lautet deshalb **„Integration über Composio“**. Die neue Oberfläche benötigt keine Umwandlung jedes Toolkits in eine eigene MCP-Konfigurationsdatei. [Composio Toolkits](https://docs.composio.dev/reference/v3/api-reference/toolkits), [Integration in einen bestehenden Agenten](https://docs.composio.dev/examples/harness-integration).

## Vorgeschlagene Oberfläche

Die Plugin-App bleibt der zentrale Einstieg. Die vorhandene Seitenschale wird erweitert; die neue Funktion bekommt keinen zweiten, konkurrierenden Store.

### Ebene 1: Finden und eigener Bestand

- **Eine Seite, ein Suchfeld, eine gemeinsame Ergebnisliste.** Standardmäßig durchsucht jede Eingabe alle vier Typen: **Plugins, Skills, Integrationen und MCP-Server**. Dafür muss weder eine Unterseite noch vorab ein Typ ausgewählt werden. „Meine Erweiterungen“ und „Entdecken“ werden Bestandsfilter dieser Suche, keine getrennten Suchräume.
- Direkt darunter stehen die optionalen Typfilter **Alle / Plugins / Skills / Integrationen / MCP-Server**. Ein Typfilter schränkt dieselbe Suche ein und behält ihren Suchbegriff. Er ist kein Seitentab mit eigener Suche. Standard bleibt „Alle“.
- Ein kompakter **Filter**-Button öffnet erst auf Anforderung weitere Kriterien: **Alle / Installiert oder verbunden / Verfügbar zum Hinzufügen**, Herkunft und gegebenenfalls Besitz/Freigabe. Aktive Filter bleiben auch nach dem Zuklappen sichtbar und einzeln entfernbar. „Verfügbar“ heißt im Katalog vorhanden und im Kontext einrichtbar; es behauptet noch keinen ausführbaren Account. Ohne Anmeldung verwendbare Angebote erhalten einen eigenen zutreffenden Nutzungszustand.
- Ohne Suchbegriff stehen Plugins zuerst. Mit Suchbegriff entscheidet die Relevanz: exakte Namen vor Präfixen, Namensbestandteile vor Beschreibungen. Eine leichte Plugin-Präferenz gilt nur bei gleicher Relevanz. Eine exakte Composio-App darf nicht hinter entfernt passenden Plugin-Beschreibungen verschwinden. Die Typkennzeichnung jeder Zeile bleibt sichtbar; keine dauerhaft getrennten Ergebnisgruppen erzwingen erneut eine Entscheidung über den Suchraum.
- **MCP-Server hinzufügen** ist als gezielte Aktion erreichbar, auch ohne Plugin. Import-/Erstellungswege für Pakete und Skills behalten ihre eigenen Fachabläufe.
- Der aktive Workspace sowie der geltende persönliche/Team-/Organisationskontext sind sichtbar. Im Standardkontext erscheinen die dort lesbaren eigenen und freigegebenen Ressourcen; ein Besitzfilter darf sie gezielt einschränken. Der Zielbereich einer neuen Installation oder Verbindung wird separat gewählt und serverseitig geprüft. Unlesbare Verbindungen fehlen in den Listen.
- Jede Zeile zeigt zunächst Logo, Name, kurzen Nutzen, Typ/Herkunft, Zustand und eine passende Hauptaktion. Große Tool-Listen, Profile und Konfiguration werden erst bei Auswahl geladen.
- Paket-Updates und Entwürfe bleiben als sekundäre Verwaltungsaktionen erreichbar. Ihre Zähler gelten nur für Pakete; sie bekommen kein konkurrierendes Katalogsuchfeld.

Die MCP-Suche umfasst tatsächlich bekannte persönliche/gemeinsame Server sowie vorhandene, eindeutig gekennzeichnete Konfigurationsvorlagen. Es gibt keinen erfundenen weltweiten Katalog beliebiger MCP-Endpunkte. Ein unbekannter eigener Server wird über **Hinzufügen → MCP-Server** eingerichtet. „Integration“ bezeichnet hier das separat einrichtbare Composio-Angebot; der Typfilter „MCP-Server“ bezeichnet direkte Serververbindungen. Der technische Transport einer Composio-App entscheidet nicht über ihre UI-Kategorie.

### Ebene 2: Ausgewählter Eintrag

Ein Eintrag öffnet eine Detailansicht innerhalb der Plugin-App; „Zurück“ stellt Suche, Filter, Listenposition und Fokus auf den ursprünglichen Treffer wieder her. Der gemeinsame Suchkopf bleibt erhalten; eine neue Suche kehrt zu den Treffern zurück. Auf schmalen Bildschirmen nimmt der Detailinhalt die ganze Inhaltsbreite ein. Sie erläutert Nutzen und Herkunft. Ein Plugin zeigt „Enthält …“ und „Benötigt …“; ein Integrationsangebot zeigt passende vorhandene Verbindungen oder „Verbinden“. Bei mehreren Accounts, Profilen oder Bereichen werden diese bewusst ausgewählt. Bei genau einer zulässigen Option entfällt der entsprechende Auswahlschritt. Gleichnamige Canva-MCP- und Composio-Angebote bleiben als verschiedene Zugänge erkennbar.

Vorgeschlagene Status-/Aktionssprache:

| Zustand | Sichtbare Aktion |
| --- | --- |
| Im Katalog, noch nicht verbunden | Verbinden |
| Ohne Anmeldung nutzbar | Verwenden; kein OAuth-Dialog |
| Verbunden und nutzbar | Öffnen/Verwenden; Verwalten nur mit entsprechendem Recht |
| Autorisierung erforderlich/abgelaufen | Verbindung herstellen/erneuern |
| Verbunden, Dienst aktuell nicht erreichbar | Status prüfen/erneut prüfen; kein automatischer Trenn-/Neuverbinden-Vorschlag |
| Plattform-/Profilkonfiguration fehlt | Einrichtung öffnen; Verwaltungsaktion nur für berechtigte Nutzer |
| Nicht für Nutzung freigegeben | Konkreten Freigabestatus zeigen, wenn der Eintrag überhaupt lesbar ist |
| Katalog nur teilweise geladen | Ergebnisse erhalten und betroffene Quelle als unvollständig anzeigen |

„Verbunden“, „erreichbar“ und „darf dieser Agent verwenden“ bleiben fachlich getrennt. Ein no-auth-Angebot wird nicht als vorhandener OAuth-Account dargestellt.

### Ebene 3: Einrichtung

**Einzelne Composio-App:** App auswählen → passenden Bereich/Profil wählen, falls nötig → vorhandenen Account auswählen oder OAuth durchführen → aktuellen Zustand nachlesen → zum gleichen Eintrag zurückkehren.

**Eigener MCP-Server:** Name und Endpunkt → benötigte Authentifizierung → Verbindung prüfen. Transportwahl, STDIO-Konfiguration und zusätzliche Header/ENV-Referenzen erscheinen unter Erweitert, soweit der jeweilige persönliche/gemeinsame Vertrag sie tatsächlich unterstützt. Es werden keine zusätzlichen Shared-Transporte allein durch UI-Umsortierung versprochen.

**Plugin-Paket:** Vorschau → Zielbereich/Freigabe → Paket installieren → nur fehlende erforderliche Integrationen einrichten oder vorhandene ausdrücklich auswählen → optional eine weitere empfohlene Integration hinzufügen → Einrichtung abschließen. Bei optionalen Alternativen genügt der vom Manifest vorgegebene erfüllte Pfad; es werden nicht automatisch alle Varianten verbunden.

Abgebrochenes OAuth lässt das bereits installierte Paket als **„Einrichtung unvollständig“** wiederaufnehmbar. Ein Paket-Update darf bestehende Accounts, Rechte und konkrete Workflow-Bindungen nicht ungefragt ersetzen. Das Entfernen eines Pakets trennt keine separat verwendete Verbindung. Bei verbleibender Nutzung zeigt das Trennen einer Verbindung die betroffenen, für den Nutzer lesbaren Anforderungen.

„Im Agenten verwenden“ greift auf die vorhandene Agent-/Workflow-Konfiguration zurück. Verbindliche Workflow-Bindungen bleiben am tatsächlichen Agenten und dessen konkretem Paketstand; für gewöhnliche Nutzung bleibt der aktuelle Workspace-/Profilkontext maßgeblich. Paketinstallation oder der UI-Status „verbunden“ darf keine stillschweigende Agent-Freigabe oder einen beliebigen Account-Fallback erzeugen.

### Ebene 4: Erweiterte Verwaltung

Profilwechsel, Verbindungsrechte, gezielte Tool-Limits, technische Diagnosen und Secrets-Verweise erscheinen auf Anforderung. Einstellungen und Plugin-Seite verwenden dieselben Formulare und Dienste. In Settings bleiben die grundlegende Plattformkonfiguration und Secrets-Verwaltung erreichbar. Credential-Werte bleiben im gemeinsamen bereichsgebundenen ENV-Service.

### Sichtbarkeitsregeln für Progressive Disclosure

| Moment | Sichtbar | Erst nach einer Aktion |
| --- | --- | --- |
| Seite öffnen | Kontext, ein Suchfeld, Typfilter, kompakte gemischte Treffer, Hinzufügen | Bestands-/Herkunfts-/Besitzfilter |
| Eintrag wählen | Nutzen, Herkunft, tatsächlicher Zustand, passende Hauptaktion; beim Plugin enthaltene und benötigte Komponenten | Tool-Liste und technische Details |
| Installieren/Verbinden | Nur die aktuell fehlenden und notwendigen Einrichtungsschritte | Account-/Profil-Auswahl bei Mehrdeutigkeit; optionale Komponenten nach den erforderlichen |
| Verwalten | Aktionen entsprechend aktuellen Rechten und aktuellem Zustand | Freigaben, Limits, Header, ENV-Referenzen und Diagnosen |

Erweiterte Details werden durch Bedarf geöffnet, nicht allein durch das Vorhandensein einer Berechtigung. Ein Admin sieht auf der Startseite daher keine permanente Profil-/Secret-/Tool-Konfiguration. Ein Fehler mit notwendiger Nutzeraktion bleibt dagegen unmittelbar sichtbar.

Der begleitende klickbare Wireframe zeigt diese Hierarchie mit Beispieldaten: gemeinsame Suche (z. B. „Canva“), Typ-/Bestandsfilter, Plugin-Anforderungen, eine simulierte Composio-Autorisierung und die separate MCP-Einrichtung. Die Interaktionen stellen keine tatsächlichen Accounts oder Provider-Zustände dar.

## Konkreter Suchvertrag

Die UI verwendet **`GET /api/plugins/search`** als authentifizierten Einstieg für die gemischte Suche. Das ist eine Verwaltungsprojektion über bestehende Fachservices, kein Ersatz der Agent-Tools. Sie verwendet die Paket-/Skill-Katalogdienste, die persönlichen/gemeinsamen Verbindungsdienste und die seitenfähige Composio-Kataloggrundlage. Die vorhandenen fachlichen Endpunkte können weiter bestehen.

**Anfrage:** `q`, optionale `types`, `stock`, `source`, `scope`, `audience`, `teamId`, expliziter `workspaceId`, `limit`, opaker `cursor` und exaktes `selected`. Ohne `types` sind alle vier Typen enthalten; `scope` ist standardmäßig `all`. Filteränderungen setzen die Seitencursor zurück, nicht den Suchbegriff. Die Browser-URL verwendet `extensionId` für die Auswahl und `extensionCursor` für die Fortsetzung. Geheime Account-/Profilwerte gehören nicht in die URL.

**Antwort:** `schemaVersion: 1`, normalisierte `query`, geordnete `items`, `selectedItem`, aktuell lesbare `scopes`, `coverage` und `pagination`. `selectedItem` wird unabhängig von Suchbegriff, Listenfiltern und aktuellem Seitenbatch frisch autorisiert aufgelöst. Ein DTO unterscheidet `plugin`, `skill`, `integration` und `mcp`. Die vier Typen tragen gemeinsame Anzeigenfelder, aber eigene fachliche Referenzen und Aktionen:

- Plugins/Skills behalten die vorhandenen Store-/Ressourcenreferenzen, Paketrevisionen und die Elternreferenz eines enthaltenen Skills.
- Ein Composio-Angebot enthält den kanonischen Toolkit-Slug und berechtigte Verbindungszusammenfassungen. Eine bestehende Verbindung wird über eine exakte Instanzreferenz ausgewählt, niemals über den Anzeigenamen. Dieselbe App mit mehreren Accounts bleibt eine App mit mehreren getrennten wählbaren Verbindungen.
- MCP-Treffer behalten die genaue Server-/Verbindungsreferenz und den Bereich; reine Vorlagen werden als solche gekennzeichnet. Gleichnamige Server und Composio-Apps werden nicht dedupliziert.
- Installation/Verbindung, Autorisierung, zuletzt geprüfte Erreichbarkeit und Lese-/Nutzungs-/Verwaltungsrechte bleiben getrennte Felder. Eine vorhandene Autorisierung ergibt kein „healthy“ ohne entsprechende Prüfung; Katalogladen ruft keine Provider-Geschäftsaktion auf.
- Jede Quelle meldet `complete`, `partial`, `unavailable` oder `not_configured`, gegebenenfalls mit Fortsetzung und sicherem Fehler. Ein Gesamtzähler wird nur als vollständig ausgegeben, wenn diese Aussage belegt ist; sonst etwa „12 Treffer geladen“.

Die Suchdienste arbeiten mit begrenzter Parallelität, getrennten Zeitbudgets und Quellencursoren. Die gemeinsame Seitengrenze sortiert geladene Kandidaten nachvollziehbar; weitere Quellen-Seiten bleiben über „Weitere Treffer“ erreichbar. Ranking gilt für tatsächlich durchsuchte Kandidaten: Ein unvollständig geladener Upstream-Katalog darf nicht als vollständig nach globaler Relevanz sortiert gelten. Unterstützt eine Quelle serverseitige Suche, wird `q` weitergereicht. Andernfalls muss eine vollständig indizierte Metadatenbasis oder eine ausdrücklich gekennzeichnete fortgesetzte Suche spätere Seiten einbeziehen. Insbesondere darf die erste Composio-Seite nicht stillschweigend als ganzer Katalog gelten. Cursor werden an Kontext, Suchbegriff und Filter gebunden; Zugriffsrechte werden bei Folgeseiten und jeder Aktion erneut geprüft.

Clientseitig wird die Eingabe kurz entprellt (etwa 250 ms). `AbortController` plus Anfragegeneration verwerfen veraltete Ergebnisse bei Suche, Filter-, Workspace- und Profilwechsel. Bestehende Treffer dürfen während des Nachladens sichtbar bleiben, werden aber als aktualisierend markiert und nicht mit dem neuen Kontext verwechselt. Teilfehler erhalten erfolgreiche Quellen. Ohne erste Antwort gibt es Skeletons; bei tatsächlichem Leerstand einen konkreten Empty-State. Filter werden per Tastatur erreichbar, aktiv markiert und zurücksetzbar; Zurücknavigation stellt Fokus und Position wieder her.

## Technische Umsetzung und Abnahmestand

| Schritt | Status | Arbeit | Fertig, wenn |
| --- | --- | --- | --- |
| 1. Gemeinsame Kataloggrundlage | Implementiert; lokal und im 15-Fall-Lauf abgenommen | Sichere gemeinsame DTOs definieren; Composio-Metadaten und autorisierte Verbindungszustände als wiederverwendbare Dienste anbieten. Die vorhandene Gateway-Paginierung/Fehlerklassifizierung nutzen; persönliche und gemeinsame Instanzen behalten exakte Referenzen. Den menschlich authentifizierten Such-Endpunkt über Paket-/Skill-/Integrations-/MCP-Quellen ergänzen. | Ein Suchbegriff liefert alle vier Typen ohne vorherigen Typfilter. Ein Treffer außerhalb der ersten Upstream-Seite ist auffindbar; lokaler und Managed-Modus sind gleichwertig. Cursor, Suchbegriff und aktuelle Bereichs-/Profilrechte werden geprüft. Fehler/Teilabdeckung werden nicht als leerer vollständiger Katalog ausgegeben. Nur sichere DTOs verlassen den Server. |
| 2. Plugin-Seite durchsuchen | Implementiert; 15-Fall-Browserabnahme bestanden | `PluginWorkspace`, `usePluginWorkspaceData` und die bestehenden Listen um die vier Typen und genau einen Such-/Filterzustand erweitern. Bestandsansichten zu Filtern dieser Suche machen; zusätzliche Filter erst aufklappen. URL, Deep Links, gemischte Pagination und Zurücknavigation gemeinsam verwalten. | „Canva“ kann gleichzeitig ein passendes Paket, einen Skill, eine Composio-App und einen bekannten MCP-Zugang liefern. Typ-/Bestandsfilter behalten den Suchbegriff. Ein Quellenausfall löscht keine erfolgreichen anderen Ergebnisse. Workspace-/Profilwechsel können keine alten Zeilen nachliefern. |
| 3. Einzelne Komponenten einrichten | Implementiert; 15-Fall-Browserabnahme bestanden | Kontextbezogene Composio- und persönliche/gemeinsame MCP-Formulare aus Settings/Plugins gemeinsam verwenden. Manuelle Composio-Slug-Eingabe durch Katalogauswahl ersetzen. Existierende OAuth-/Desktop-Rückwege auf die neue Eintragsauswahl erweitern. | Ohne Plugin lassen sich ein Skill, ein Composio-Angebot und ein eigener MCP-Server unabhängig hinzufügen. Auth-Abbruch, Profilmehrdeutigkeit, zentrale Secrets und fehlendes Manage-Recht sind nachvollziehbar; Rückkehr und Wiederaufnahme behalten die exakte Auswahl. |
| 4. Paketablauf schließen | Implementiert; 15-Fall-Browserabnahme bestanden | Die bisherigen Anforderungen mit aktuellen, passenden Integrationsoptionen verbinden. Geführte Einrichtung nach Installation und in bestehenden Paketdetails; optionalen Agent-Konfigurationsschritt anschließen. | Ein Plugin mit Skill plus Composio/MCP lässt sich als zusammenhängender Ablauf einrichten. Bereits vorhandene Verbindungen werden ausdrücklich wiederverwendet. Abbruch/Update/Entfernung erhalten unabhängige Integrationsinstanzen und bestehende Bindungen. |
| 5. Oberfläche abnehmen und Übergang vollenden | Implementiert; Settings-Migration und 15-Fall-Browserabnahme bestanden | Alte Settings-Einstiege über dieselben Komponenten/Dienste weiter bedienen. DE/EN, responsive Darstellung, Tastatur/Fokus, Loading/Empty/Error und sichere bereichsgebundene Aktionen prüfen. Web-/Mobile-Verträge der wiederverwendeten APIs erhalten. | Code/API-/Regressionstests und Produktionsbuild bestehen; anschließend eine ausdrücklich freigegebene Browserabnahme der tatsächlichen Bedienwege. Erst danach werden überflüssige Einstellungslisten entfernt oder weitergeleitet. |

Es wird kein neuer Credential-Store eingeführt und keine zweite Ausführungs-/Berechtigungslogik gebaut. Die Verwaltungsprojektion verwendet menschliche Session-/Workspace-Rechte; sie erfindet keinen Agenten oder Chat, um einen Runtime-Zugriff zu simulieren. App-Metadaten dürfen gecacht werden, Accounts und Nutzungsrechte werden getrennt aktuell aufgelöst. Unterschiedliche Managed-/Local-Projektkataloge und bestehende ausgeblendete/gesperrte Apps werden respektiert.

Die Kataloggrundlage ist von der allgemeinen Aktivierung des Agent-Flags unabhängig. Die vorhandene gemeinsame Agentensuche ist das Runtime-Ziel; diese UI-Erweiterung schaltet sie nicht ungeprüft für alle Nutzer an. Die separat offenen echten Provider-/Rollout-Abnahmen bleiben im [Rollout-Plan](rollout-plan-2026-10-13.md).

## Konkrete Abnahmefälle

1. Eine einzige Suche „Canva“ liefert in einer gemeinsamen Liste passende echte Paket-/Skill-Angebote, Composio-Toolkits und lesbare eigene/gemeinsame MCP-Verbindungen mit Typkennzeichnung. Alle vier Typfilter sowie Bestand/Herkunft schränken dieselbe Suche ein; bei „Alle“ kehren ihre Treffer zurück. Ohne Treffer existiert kein erfundenes Paket.
2. Ein Toolkit auf einer späteren Katalogseite wird gefunden; wiederholte/malformed Cursor und Teilausfall führen zu einem ausdrücklichen unvollständigen Ergebnis.
3. Dieselbe App mit persönlichem und Team-Account behält beide Instanzen. Mehrere Accounts werden nicht über den Anzeigenamen zusammengelegt oder stillschweigend gewechselt.
4. ACTIVE, abgelaufene Autorisierung, no-auth, gesperrte Apps und eine autorisierte, aktuell unerreichbare Verbindung bekommen korrekte unterschiedliche Aktionen.
5. Ein normaler Nutzer mit Use-Recht kann verwenden, aber nicht Account, Secrets oder Freigaben verwalten. Paketfreigabe allein eröffnet keinen Accountzugriff.
6. Ein Plugin mit Skill und Integrationsanforderungen lässt sich installieren und die Einrichtung nach OAuth-Abbruch fortsetzen. Bestehende kompatible Verbindungen werden wiederverwendet; fehlende und optionale Anforderungen bleiben erkennbar.
7. Ein einzelner Skill, ein eigener MCP-Server und eine einzelne Composio-App funktionieren ohne Gesamtpaket. Plugin-Skills behalten ihre Herkunft und werden nicht als unabhängige Neuinstallation ausgegeben.
8. Persönliche/Team-/Organisationswechsel, verzögerte Antworten, Zurück/Deep Link, DE/EN und schmale Bildschirme erhalten Auswahl, Rechte und Entwürfe.
9. Paket-Update/-Entfernung trennt keine unabhängige Verbindung; Rechteentzug vor Verwendung stoppt den Aufruf. Verbindliche Agent-Bindungen bleiben an exakte Ressourcen und Revisionen gebunden.

Die neuen Regressionseinstiege sind `test:plugins:extension-search`, `test:plugins:extension-ui`, `test:plugins:extension-setup`, `test:plugins:extension-agent-ui`, `test:plugins:extension-avatar-ui`, `test:plugins:extension-icons`, `test:plugins:extension-settings`, die getrennten nativen PostgreSQL-Profil-/MCP-Prüfungen und `test:plugins:extension-e2e`. Bestehende Elternprüfungen bleiben `test:plugins:workspace-ui`, `test:plugins:app`, `test:integrations:gateway:catalog`, `test:integrations:connections` und die gepaarten Managed-Verträge. [Konkrete Evidenz und Aussagegrenzen](evidence/plugin-page-integration-catalog-acceptance-2026-10-13.md).
