# Schritt 5a: versionierte Plugin- und Skill-Pakete

Stand: 2026-10-06, lokale Abnahme auf `feat/plugin-integration-gateway`. Keine Veröffentlichung, kein Container-Build.

## Paket- und Rechtevertrag

- Persönliche, Organisations- und logisch teameigene Plugins sowie eigenständige Skills verwenden denselben Paketdienst. Text, ausführbarer Quellcode, Konfiguration und Binärassets gehören zum vollständigen Paket. Enthaltene Plugin-Skills werden über ihr Parent-Paket bearbeitet oder ausdrücklich als eigenständige Variante ausgekoppelt. Core-Quellen bleiben schreibgeschützt.
- Entwürfe gehören ausschließlich ihrem Ersteller und liegen außerhalb der allgemeinen Workspace-Dateien. Änderungen erzeugen eine neue private Entwurfsrevision mit CAS; fehlgeschlagene Änderungen lassen die bestätigte alte Revision erhalten. UI und 14 Agentenoperationen verwenden dieselben strikten serverseitigen Actions.
- Bearbeiten und Veröffentlichen eines vorhandenen Pakets verlangen aktuelle Bearbeitungsrechte. Eine Variante verlangt aktuellen Lesezugriff auf die Quelle und Verwaltungsrecht im ausdrücklich gewählten Zielbereich. Ihr Name muss eindeutig sein; bis zur Veröffentlichung gibt es keine sichtbare Zielressource. Eine veröffentlichte Variante beginnt eingeschränkt, ohne übernommene Freigaben oder Accounts und ohne Standardaktivierung.
- Veröffentlichungen enthalten unveränderliche vollständige Snapshots, semantische Versionsbezeichnung, opake Revisionsreferenz und Checksummen. Tatsächlich autorisierte Seed-Abhängigkeiten werden vollständig eingebettet und in der Herkunft festgehalten. Ein laufender Agent verwendet eine einheitliche eingefrorene Paketversion, auch wenn inzwischen eine neue veröffentlicht wurde.
- Aktuelle Metadaten, Nutzungs-, Bearbeitungs- und Verwaltungsrechte bleiben unabhängig vom Inhalt. Die eigene Entwurfsstatusabfrage erlaubt nach Rechteentzug sichere Metadaten und Verwerfen; sie liefert keine Quelldateien oder Laufzeitwurzeln. Fremde Verwalter erhalten keinen privaten Entwurf.
- Der neue Paketeditor ändert die Standardaktivierung mit eigenem Verwaltungsrecht und CAS für Paketkopf, Metadaten, Grants und alten Standard. Diese Aktion verändert keine Bytes, Paketversion, Freigaben oder Herausgeber. Verwenden oder Bearbeiten allein erlaubt keine Änderung des Standards.

## Veröffentlichung und laufende Agenten

Ein bereichsgebundener Registry-Dateilock wird vor der kanonischen Quellauflösung und den SQL-Autoritäts-/Ressourcensperren gehalten. Veröffentlichung und Rückabwicklung behalten diese Reihenfolge bei. Bestehende Legacy-Schreibwege verwenden dieselben Plugin-/Skill-Locks und können ein verwaltetes Paket nicht überschreiben. Nicht verwaltete persönliche Legacy-Pakete behalten ihren bisherigen dateibasierten Vertrag.

Veröffentlichungsmarker, SQL-Kopf und tatsächliche vollständige Paketbytes müssen übereinstimmen. Fehlende Datenbankautorität, verwaiste Marker oder manipulierte Dateien sperren das Paket; es gibt keinen Rückfall auf einen älteren unverwalteten Pfad. Bereits ausgegebene Agenten-Lesewurzeln prüfen weiterhin aktuelle Rechte und vollständige Bytes vor Dateizugriff oder Bash-Start.

Prompt und Lesewurzeln verwenden denselben tatsächlich ausgegebenen Versionsnachweis. Ein Child-Agent kann nur dieselbe Revision mit einer weiter eingeschränkten Skill-Auswahl erhalten. Kopierte JSON-Daten ersetzen diesen internen Nachweis nicht; ein Widerruf beziehungsweise eine manipulierte Script-Datei verhindert den Prozessstart. Alte materialisierte Plugin-Skills dürfen den direkt gelesenen unveränderlichen Snapshot nicht überlagern.

## Tatsächliche Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| `npm run test:capabilities:packages`: IO, Store, Actions/HTTP, Artefakte/Agent, Laufzeit und Cleanup-Guards | PASS; sechs tatsächliche Dienste-/Dateisystem-Fixtures |
| Native PostgreSQL mit acht Pool-Clients | PASS; konkurrierende Entwurfs-CAS, Widerruf nach beobachteter SQL-Sperre vor Dateistaging, Registry-/SQL-Rollback, unveränderlicher Kopf und eindeutige Fork-Zielnamen |
| Store-/Action-/HTTP-/Agent-Fixtures mit tatsächlichem PostgreSQL-Engine-Schema | PASS; private Entwürfe, komplette Code-/Asset-Pakete, Zielbereich und Rechte, Versionskonflikte, Seed-Herkunft, Core-/Child-Schreibschutz und Standardaktivierung |
| Laufzeit-Fixture mit tatsächlichem installiertem Paket und SQL-Autorität | PASS; gehaltene v1 nach Veröffentlichung von v2, eingeschränkter Child-Kontext, Prompt-/Dateiparität, manipulierte Bytes und aktueller Widerruf vor Start |
| `npm run test:integrations:gateway`, `npm run test:plugins:app` und fokussierte bestehende Skill-/Plugin-/Bash-/Delegationsregressionen | PASS auf endgültigem Runtime-Code |
| `npm run build`, vollständiger TypeScript-Check und ESLint des endgültigen Editors sowie des finalen Browserfalls | PASS nach der automatischen UI-Sperre bei entzogenen Bearbeitungsrechten |
| Playwright-Paketverwaltung am endgültigen Produktionsbuild | 4/4 PASS, ein Worker, keine Retries, 1,6 Minuten |

Der Browser verwendet tatsächliche Bootstrap-/Member-Identitäten und die APIs des produktionsgebauten lokalen PostgreSQL-Notebooks. Geprüft sind komplette Script-/Binärasset-Bearbeitung, tatsächliche konkurrierende Änderungen mit `409`, erhaltener lokaler Text bei einem gescheiterten Lesen oder binärem Ersatz, v1 nach v2, getrennte eingeschränkte Organisations-/Team-Forks und Standardaktivierung ohne Metadaten-/Grant-/Inhaltsänderung. Nach Entzug allein der Bearbeitungsrechte bleibt veröffentlichtes Lesen erlaubt; ein tatsächliches Save-`403` verbirgt ohne manuelles Neuladen den Editor und die Veröffentlichung, lässt aber die eigene Statusabfrage und das Verwerfen zu. Fremder Entwurfsstatus bleibt `404`.

1280px und 390px, hell und dunkel: tatsächlich geladene und eingeklappte Ansichten, erreichbares Speichern und keine horizontale Überbreite. Stabile finale Screenshots wurden visuell geprüft. Artefakte: `/tmp/canvas-plugin-gateway-stage5a-package-browser-artifacts`.

Die nativen Parallelitätsprüfungen verwenden echte getrennte PostgreSQL-Verbindungen und beobachten die Sperrwartephase. Die übrigen SQL-Fixtures verwenden PGlite mit tatsächlichem Schema und Dienstcode; sie ersetzen diesen nativen Parallelitätsnachweis nicht. Agentenoperationen werden über die tatsächliche Tool-Factory und den progressiven Gateway aufgerufen; dies ist kein Nachweis eines vom Modell selbst erzeugten Paketbearbeitungsablaufs.

Zusätzliche echte Modell-Chats im Browser bestehen für MCP und Composio mit exakter Profil-/Account-/Toolversion. Der gemeinsame Lauf bestand für diese beiden Chats und die Admin-/Member-Flag-Prüfung. Im Planungsfall endete der Modellstream ohne `finish_reason`; es gab keine Tool-Aufrufe. Die gezielte Wiederholung von Admin- und Planungsfall bestand 2/2 in 38,2 Sekunden und bestätigte null Provider-Anfragen. Dies ist keine Behauptung eines einzelnen vollständigen 4/4-Laufs.

Nur der private lokale Testlauncher erlaubt HTTP und private Netzwerkziele für den eigenen Loopback-Provider. Die Produktvoreinstellungen bleiben unverändert. Kontrollierte MCP-/Composio-Provider sind kein Nachweis eines tatsächlichen Drittanbieter-Accounts.

## Bereinigung und verbleibende Grenzen

Kurzlebige native Testdatenbanken und private DATA-Verzeichnisse wurden nach Eigentumsprüfung entfernt. Die Browserbereinigung prüft exakte Ersteller, Ressourcenreferenzen, Freigaberevisionen, Versionen, Namen, vollständige Bytes und einen eigenen Fixture-Beleg. Plugin-/Skill-Dateilocks bleiben von der Bestandsaufnahme über den bestätigten SQL-Commit bis zur endgültigen Dateientfernung gehalten. Unbestätigter Commit, fremde Versionen oder geänderte Bytes verhindern das Löschen. Die wiederhergestellten Grants vergleichen ausschließlich ihre fünf semantischen Eingabefelder. Eine zusätzliche reine Leseprüfung bestätigte null eigene Ressourcen, Entwürfe, Versionen und Intake-Verzeichnisse. Eigener Notebook-Server und Provider-Prozess wurden nach Prüfung von Arbeitsverzeichnis und Prozesskommando beendet; andere Umgebungen wurden nicht verändert.

Der vollständig aktualisierte GitNexus-Index erfasst 562 geänderte Symbole in 73 Dateien für diesen Commit und 2138 Symbole in 260 Dateien gegenüber `main` über alle abgeschlossenen Schritte. Tatsächlicher Diff, betroffene Paket-/Katalog-/Registry-/Agentenpfade und die zuvor gemeldeten hohen Auswirkungen der gemeinsamen Runtime-Symbole wurden geprüft. Die geringe Zahl automatisch zugeordneter Prozesse ist kein Nachweis einer vollständigen Laufzeitabdeckung; die konkreten Vertrags-, Parallelitäts- und Browserprüfungen ergänzen die Graphanalyse.

Der Paketeditor ist ein Zwischenstand in der vorhandenen Plugin-Detailansicht. Der alte Toggle kann für verwaltete Pakete weiterhin `409` liefern; das Seitenredesign muss die Aktivierungssteuerung auf den neuen Vertrag vereinheitlichen. Eine globale Liste eigener privater Entwürfe, die auch bei verschwundener Quelle erreichbar bleibt, gehört ausdrücklich zu Schritt 6a.

Neue Script-Ausführung samt begrenzter Tool-Brücke und Netzwerkbegrenzung folgt in 5b; verbindliche Workflow-/Connector-Zuweisungen folgen in 5c. Store-/Installiert-/Updates-Navigation, Mobile-/MCP-App-/Desktop-OAuth-Verträge und tatsächliche geteilte Canva-Accounts bleiben 6a, 6b und 7. Der datenbanklose bestehende `agent-runtime-config-test` ist ohne PostgreSQL-`DATABASE_URL` weiterhin nicht ausführbar; diese Umgebungsgrenze wird nicht durch einen Produktfallback umgangen. Die Gateway-Flag bleibt standardmäßig ausgeschaltet.
