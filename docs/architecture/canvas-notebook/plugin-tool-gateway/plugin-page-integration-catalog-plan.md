# Plugin-Seite: Pakete, Skills und Integrationen gemeinsam entdecken

Stand: 13. Oktober 2026. Geprüfte Notebook-Basis: `8d6401a08261ca4efe6063fed4001be024fdfb8d` (Remote-main einschließlich To-do-Fix aus PR #170). Dies ist ein Vorschlag für die nächste Umsetzung. Die Prüfung erfolgte anhand der aktuellen Route, tatsächlich eingebundenen Komponenten, Dienste und vorhandenen Abnahmeberichte; eine neue Browser-/Produktivabnahme wurde nicht durchgeführt.

## Ergebnis der Bestandsaufnahme

Die fachliche Grundlogik ist vorhanden. Ein Plugin kann Skills, Scripts, MCP-Vorlagen und Composio-Anforderungen bündeln. Einzelne Skills sowie persönliche und gemeinsame MCP-/Composio-Verbindungen sind eigenständig nutzbar. Die aktuelle Plugin-Seite bildet diese Möglichkeiten jedoch noch nicht als vollständige gemeinsame Such-, Einrichtungs- und Verwaltungsoberfläche ab.

| Bereich | Aktuell umgesetzt | Verbleibende Lücke |
| --- | --- | --- |
| Plugin als Paket | Manifest mit Skills, MCP-/Composio-Connectoren und Workflow-Fähigkeiten; versionierte Installation, Herkunft, Updates und separate Freigaben. | Installation zeigt Anforderungen, führt deren konkrete Einrichtung aber nicht als zusammenhängenden Paketablauf. |
| Einzelner Skill | Eigener Store-/Ressourcentyp `skill`, unabhängige Installation und Verwaltung. Plugin-Skills behalten ihre Elternreferenz. | In der gemeinsamen Oberfläche Herkunft und eigenständige Installation verständlich unterscheiden. |
| Eigener MCP-Server | Persönliche Einstellungen mit bestehenden Transport-/Auth-Verträgen; gemeinsame Verbindungsressourcen mit eigenständigen Rechten. | Persönliche Einrichtung auf der Plugin-Seite fehlt. Gemeinsame Verbindungen liegen unter „Erweitert“; neue gemeinsame Server werden dort über HTTP eingerichtet. |
| Einzelne Composio-App | App-Katalog, Accounts, Profile, OAuth, lokale/Managed-Anbindung und gemeinsame Verbindungen sind vorhanden. | Keine Composio-Suche in der zentralen Plugin-Suche. Gemeinsame Erstellung verlangt bislang einen manuell eingegebenen Toolkit-Slug. |
| Plugin-Seite | Installiert, Store, Updates und Entwürfe; Bereichsauswahl, Suche und Typfilter für Plugins/Skills. | Integrationsangebote und tatsächliche Verbindungsinstanzen fehlen in diesen Hauptlisten. |
| Paket-Verbindungen | Aktuelle Detailseite zeigt deklarierte Anforderungen und separat die allgemeinen gemeinsamen Verbindungen; persönliche Verwaltung führt über „Erweitert“ zu Settings. | Keine durchgehend an konkreten Paketanforderungen ausgerichtete Auswahl, Einrichtung und Readiness. |
| Gemeinsamer Integrations-Gateway | Einheitliche Provider-Suche, aktuelle Rechte, explizite Referenzen, getrennte Zustände und Fehler; Composio-Seiten werden vollständig oder ausdrücklich teilweise erfasst. | Sichere Verwaltungsprojektion und gemeinsame UI fehlen. Die ältere Settings-Liste verwendet einen eigenen Katalogpfad. |

Entscheidende Quellen:

- [PluginWorkspace](../../../../app/components/plugins/PluginWorkspace.tsx): aktive Seitenschale; persönlicher Settings-Verweis und Paket-/Skill-Typfilter.
- [Plugin-Katalogvertrag](../../../../app/lib/plugins/plugin-workspace-catalog-contracts.ts): derzeit ausschließlich `plugin` und `skill`.
- [Paketdarstellung](../../../../app/components/plugins/PackageDetailPresentation.tsx) und [Paketdetails](../../../../app/components/plugins/PackageDetailWorkspace.tsx): deklarierte Anforderungen sind kein Account-/Erreichbarkeitsnachweis.
- [Installationswizard](../../../../app/components/plugins/StorePackageWizard.tsx): Vorschau, Freigabe und Abschluss; kein vollständiger Verbindungswizard.
- [Gemeinsame Verbindungsformulare](../../../../app/components/plugins/SharedConnectionForms.tsx): eigenständige MCP-/Composio-Erstellung, Profile, Auth und Freigaben.
- [ConnectedAppsPanel](../../../../app/components/settings/ConnectedAppsPanel.tsx): lokale Filterung der geladenen Liste; Katalogfehler werden beim Laden abgefangen, ohne einen eigenen Fehlerzustand zu zeigen.
- [Alte Toolkit-Registry](../../../../app/lib/composio/composio-toolkit-registry.ts) und [alte Toolkit-Route](../../../../app/api/composio/toolkits/route.ts): die Route reicht keine Such-/Cursorparameter weiter; der lokale SDK-Wrapper liefert keine verlässliche Cursor-Abdeckung.
- [Composio-Gateway-Adapter](../../../../app/lib/integration-tools/adapters/composio.ts): seitenfähiger Katalog, Profile, gemeinsame Verbindungen und ausdrückliche Teilfehler; [Gateway-Katalog](../../../../app/lib/integration-tools/catalog.ts): nur Metadaten, getrennte Quellenfehler.

Der frühere `PluginsPanel` enthält bereits Connector-Aktionen, ist aber nicht die von `/plugins` eingebundene neue Seitenschale. Vorhandener Code in diesem Panel beweist deshalb keinen aktuellen Bedienweg.

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

- **Meine Erweiterungen** und **Entdecken** bilden die primären Ansichten. Paket-Updates und eigene Entwürfe bleiben erreichbar; ihre Zähler gelten nur für passende Pakettypen.
- Ein Suchfeld, darunter die Filter **Alle / Plugins / Integrationen / Skills**. Plugins stehen in der allgemeinen Entdecken-Ansicht zuerst. Bei einer Suche werden passende Pakete und einzelne Komponenten in klar beschrifteten Gruppen gezeigt.
- Nur bei gewähltem Integrationsfilter erscheinen **Verbunden / Verfügbar** sowie bei Bedarf die Quelle **Composio / Eigene MCP-Server**. „Verfügbar“ heißt hier im Katalog vorhanden und im Kontext einrichtbar; es behauptet noch keinen ausführbaren Account.
- **MCP-Server hinzufügen** ist als gezielte Aktion erreichbar, auch ohne Plugin. Import-/Erstellungswege für Pakete und Skills behalten ihre eigenen Fachabläufe.
- Der aktive persönliche/Team-/Organisationsbereich ist sichtbar. Unlesbare Verbindungen fehlen in den Listen; mögliche Installations-/Erstellungsbereiche werden separat serverseitig geprüft.
- Jede Zeile zeigt zunächst Logo, Name, kurzen Nutzen, Typ/Herkunft, Zustand und eine passende Hauptaktion. Große Tool-Listen, Profile und Konfiguration werden erst bei Auswahl geladen.

### Ebene 2: Ausgewählter Eintrag

Ein Eintrag öffnet eine Detailansicht innerhalb der Plugin-App; „Zurück“ stellt Suche, Filter und Listenposition wieder her. Sie erläutert Nutzen und Herkunft. Ein Plugin zeigt „Enthält …“ und „Benötigt …“; ein Integrationsangebot zeigt passende vorhandene Verbindungen oder „Verbinden“. Bei mehreren Accounts, Profilen oder Bereichen werden diese bewusst ausgewählt. Gleichnamige Canva-MCP- und Composio-Angebote bleiben als verschiedene Zugänge erkennbar.

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

## Technische Umsetzung in abgeschlossenen Schritten

| Schritt | Arbeit | Fertig, wenn |
| --- | --- | --- |
| 1. Gemeinsame Kataloggrundlage | Composio-Katalogmetadaten und autorisierte Verbindungszustände als wiederverwendbare Dienste anbieten. Die vorhandene Gateway-Paginierung/Fehlerklassifizierung nutzen; persönliche und gemeinsame Instanzen erhalten getrennte exakte Referenzen. Eine authentifizierte Verwaltungsprojektion ergänzen, z. B. unter `/api/integrations/catalog`. | Ein Treffer außerhalb der ersten Upstream-Seite ist auffindbar; lokaler und Managed-Modus sind gleichwertig. Cursor, Suchbegriff und aktuelle Bereichs-/Profilrechte werden geprüft. Fehler/Teilabdeckung werden nicht als leerer vollständiger Katalog ausgegeben. Nur sichere DTOs verlassen den Server. |
| 2. Plugin-Seite durchsuchen | Gemeinsames Suchfeld/Typfilter und Integrationslisten in die aktuelle `PluginWorkspace` einbinden. Paketkatalog und Integrationsprojektion getrennt laden, aber einheitlich darstellen. Pro Quellgruppe passende Pagination beibehalten. Navigation/Deep Links für Anbieter und konkrete Verbindungen erweitern. | Composio-App finden, verbundene Accounts erkennen und verfügbare Apps entdecken gelingt auf `/plugins`. Ein Quellenausfall löscht keine erfolgreichen anderen Ergebnisse. Workspace-/Profilwechsel können keine alten Zeilen nachliefern. |
| 3. Einzelne Komponenten einrichten | Kontextbezogene Composio- und persönliche/gemeinsame MCP-Formulare aus Settings/Plugins gemeinsam verwenden. Manuelle Composio-Slug-Eingabe durch Katalogauswahl ersetzen. Existierende OAuth-/Desktop-Rückwege auf die neue Eintragsauswahl erweitern. | Ohne Plugin lassen sich ein Skill, ein Composio-Angebot und ein eigener MCP-Server unabhängig hinzufügen. Auth-Abbruch, Profilmehrdeutigkeit, zentrale Secrets und fehlendes Manage-Recht sind nachvollziehbar; Rückkehr und Wiederaufnahme behalten die exakte Auswahl. |
| 4. Paketablauf schließen | Die bisherigen Anforderungen mit aktuellen, passenden Integrationsoptionen verbinden. Geführte Einrichtung nach Installation und in bestehenden Paketdetails; optionalen Agent-Konfigurationsschritt anschließen. | Ein Plugin mit Skill plus Composio/MCP lässt sich als zusammenhängender Ablauf einrichten. Bereits vorhandene Verbindungen werden ausdrücklich wiederverwendet. Abbruch/Update/Entfernung erhalten unabhängige Integrationsinstanzen und bestehende Bindungen. |
| 5. Oberfläche abnehmen und Übergang vollenden | Alte Settings-Einstiege über dieselben Komponenten/Dienste weiter bedienen. DE/EN, responsive Darstellung, Tastatur/Fokus, Loading/Empty/Error und sichere bereichsgebundene Aktionen prüfen. Web-/Mobile-Verträge der wiederverwendeten APIs erhalten. | Code/API-/Regressionstests und Produktionsbuild bestehen; anschließend eine ausdrücklich freigegebene Browserabnahme der tatsächlichen Bedienwege. Erst danach werden überflüssige Einstellungslisten entfernt oder weitergeleitet. |

Es wird kein neuer Credential-Store eingeführt und keine zweite Ausführungs-/Berechtigungslogik gebaut. Die Verwaltungsprojektion verwendet menschliche Session-/Workspace-Rechte; sie erfindet keinen Agenten oder Chat, um einen Runtime-Zugriff zu simulieren. App-Metadaten dürfen gecacht werden, Accounts und Nutzungsrechte werden getrennt aktuell aufgelöst. Unterschiedliche Managed-/Local-Projektkataloge und bestehende ausgeblendete/gesperrte Apps werden respektiert.

Die Kataloggrundlage ist von der allgemeinen Aktivierung des Agent-Flags unabhängig. Die vorhandene gemeinsame Agentensuche ist das Runtime-Ziel; diese UI-Erweiterung schaltet sie nicht ungeprüft für alle Nutzer an. Die separat offenen echten Provider-/Rollout-Abnahmen bleiben im [Rollout-Plan](rollout-plan-2026-10-13.md).

## Konkrete Abnahmefälle

1. Suche „Canva“ liefert passende echte Paketangebote, Composio-Toolkits und lesbare eigene/gemeinsame MCP-Verbindungen getrennt; ohne Treffer existiert kein erfundenes Paket.
2. Ein Toolkit auf einer späteren Katalogseite wird gefunden; wiederholte/malformed Cursor und Teilausfall führen zu einem ausdrücklichen unvollständigen Ergebnis.
3. Dieselbe App mit persönlichem und Team-Account behält beide Instanzen. Mehrere Accounts werden nicht über den Anzeigenamen zusammengelegt oder stillschweigend gewechselt.
4. ACTIVE, abgelaufene Autorisierung, no-auth, gesperrte Apps und eine autorisierte, aktuell unerreichbare Verbindung bekommen korrekte unterschiedliche Aktionen.
5. Ein normaler Nutzer mit Use-Recht kann verwenden, aber nicht Account, Secrets oder Freigaben verwalten. Paketfreigabe allein eröffnet keinen Accountzugriff.
6. Ein Plugin mit Skill und Integrationsanforderungen lässt sich installieren und die Einrichtung nach OAuth-Abbruch fortsetzen. Bestehende kompatible Verbindungen werden wiederverwendet; fehlende und optionale Anforderungen bleiben erkennbar.
7. Ein einzelner Skill, ein eigener MCP-Server und eine einzelne Composio-App funktionieren ohne Gesamtpaket. Plugin-Skills behalten ihre Herkunft und werden nicht als unabhängige Neuinstallation ausgegeben.
8. Persönliche/Team-/Organisationswechsel, verzögerte Antworten, Zurück/Deep Link, DE/EN und schmale Bildschirme erhalten Auswahl, Rechte und Entwürfe.
9. Paket-Update/-Entfernung trennt keine unabhängige Verbindung; Rechteentzug vor Verwendung stoppt den Aufruf. Verbindliche Agent-Bindungen bleiben an exakte Ressourcen und Revisionen gebunden.

Relevante vorhandene Regressionseinstiege: `test:plugins:workspace-ui`, `test:plugins:app`, `test:integrations:gateway:catalog`, `test:integrations:connections` und die gepaarten Managed-Verträge. Neue Prüfungen müssen die obigen Bedien- und Rechtefälle ergänzen, statt nur Markup oder die Implementierung nachzubilden.
