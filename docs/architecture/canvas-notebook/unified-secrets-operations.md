# Betrieb des gemeinsamen Secret-Speichers

Stand: 2026-09-30. Architektur und ursprünglicher Plan: [unified-secrets-env-plan.md](unified-secrets-env-plan.md).

## Speicherung und Bearbeitung

Jeder Berechtigungsbereich verwendet genau eine aktive Datei:

```text
<DATA>/users/<userId>/secrets/Canvas-Secrets.env
<DATA>/organizations/<organizationId>/secrets/Canvas-Secrets.env
<DATA>/system/secrets/Canvas-Secrets.env
```

`DATA` steht für den aufgelösten Datenpfad. `CANVAS_DATA_ROOT` hat Vorrang; ansonsten gelten die vorhandenen DATA-/Container-/Projektregeln. `CANVAS_SECRETS_ENV_PATH` überschreibt ausschließlich die aktive Systemdatei. Agent Runtime, Medien und Integrationen sind Kategorien desselben Bestands, keine weiteren Dateien. Ein Key kann mehreren Kategorien angehören.

Unter `/settings?tab=secrets` gibt es das normale Formular und die technische Ansicht „ENV-Text“. Persönliche Werte gehören zur angemeldeten Person. Organisation und System sind nur für berechtigte Administratoren verfügbar; die Organisation benötigt zusätzlich die bestehenden Organisationsrechte. Fachliche Provider-/Integrationsformulare bleiben erhalten und ändern dieselben Werte gezielt.

Formularwerte sind zunächst verdeckt. Mehrzeilige Werte werden erst nach „Wert anzeigen“ in einem Textfeld bearbeitet. Der Textmodus zeigt die bearbeitbaren Werte bewusst im Klartext; er erhält Kommentare und Formatierung. `${KEY}` und `$KEY` bleiben in der ENV-Datei literal: Die Speicherung führt keine Shell-Ausführung oder Variable-Interpolation aus. MCP expandiert seine bereits unterstützten Referenzen erst bei der Verbindungsauflösung.

OAuth-, Mailbox-, Webhook- und MCP-Verbindungscredentials werden als geschützte `CANVAS_CREDENTIAL_*`-Datensätze in dieser Datei gespeichert. Der allgemeine Editor zeigt diese Datensätze und interne Schlüsselmaterialien nicht an. Verbinden, Refresh, Reconnect und Logout erfolgen weiterhin über die fachlichen Funktionen. Kurzlebige MCP-PKCE-Zustände bleiben in ihrer bisherigen versiegelten Ablage; Konten-/Verbindungsmetadaten bleiben außerhalb der ENV.

## API und konkurrierende Änderungen

`GET /api/integrations/env?scope=all&secretScope=user` liefert bearbeitbare Einträge, Kategorien, Rohtext und Revision. `secretScope` kann bei entsprechender Berechtigung auch `organization` oder `system` sein. `scope=agents|integrations` sind kompatible fachliche Ansichten desselben Speichers.

Einzelfelder verwenden `PATCH` mit `patches: [{ key, value }]`; `value: null` löscht den Eintrag. Der gemeinsame Formular-Editor sendet zusätzlich seine geladene `baseRevision`. Technische Rohtextänderungen verwenden `PUT` mit `mode: "raw"`, `rawContent` und verpflichtender `baseRevision`. Veraltete Revisionen liefern HTTP 409. Der Browser erhält den Entwurf und bietet das Neuladen an. Geschützte Datensätze werden serverseitig bewahrt; ihre direkte Bearbeitung wird abgewiesen.

Die Datei wird unter einer prozessübergreifenden Sperre atomisch ersetzt, mit Dateirechten `0600`. Verschiedene Kategorien und Refresh-Vorgänge können keine vollständigen veralteten Listen zurückschreiben. MCP-Verbindungen werden nur geschlossen, wenn eine von ihnen tatsächlich verwendete ENV-Referenz geändert wurde.

Unveränderte öffentliche PATCH-Anfragen behalten auch in den kompatiblen Agent-/Integrationsansichten die vorhandenen Dateibytes und ihre Revision. Ein erstmaliger leerer Bootstrap erzeugt weiterhin die kanonische Datei.

## Verwendungsabhängige Reihenfolge

Die Vereinheitlichung ersetzt die bisher unterschiedlichen Verbraucherregeln nicht durch eine pauschale User→Organisation→System-Kaskade:

| Verbraucher | Reihenfolge / Grenze |
| --- | --- |
| Provider-Installation in der Agent Runtime | Ausschließlich der konfigurierte Credential-Scope; Agent-Ansicht vor Integrations-Ansicht. Nur Systeminstallationen dürfen anschließend Prozesswerte verwenden. Persönliche/Organisationsinstallationen übernehmen keine fremden Instanz-Keys. |
| Älterer persönlicher PI-Resolver | Eigener Benutzerbereich, Agent-Ansicht vor Integrations-Ansicht; kein Prozess-Fallback. |
| Älterer System-PI-Resolver | Prozesswerte vor Agent- vor Integrationswerten, wie bisher. |
| Studio-Medien | Expliziter User- oder Organisationsbereich, danach System, danach Prozess, danach verfügbarer Managed-Fallback. Innerhalb eines Bereichs Integrations- vor Agent-Ansicht. |
| MCP | Persönlicher oder System-Owner; Agent-Ansicht vor Integrations-Ansicht. Passthrough und Verbindungsreferenzen bleiben verbindungsspezifisch. Keine neue direkte Organisations-ENV-Kaskade. |
| Brave / Ollama Search | Gewählte Integrations-Ansicht; vorhandene Prozess-/Managed-Regeln bleiben erhalten. |
| Composio-Projektkey | System, danach bestehender persönlicher/Organisations-Übergang, danach Prozess nur ohne Managed-Konfiguration. |
| Mailbox-Credentials | Exakt der Eigentümer des Secret-Refs: persönliches Konto→User, Workspace-Konto→System. OAuth-Konfiguration folgt separat dem bestehenden Konto-/Provider-Vertrag. |
| Control Plane | Die vorhandene Instanzidentität authentifiziert Managed-Anfragen. Provider-BYOK-Secrets werden nicht als Control-Plane-Token verwendet. Deployment-/Lizenzidentität und Infrastruktur-ENV bleiben in ihren bisherigen Installationsmechanismen. |

Ein nicht lesbarer oder fehlerhaft entschlüsselbarer Speicher stoppt die betreffende Auflösung. Er wird nicht wie ein fehlender Key behandelt, der stillschweigend einen anderen Scope oder Prozess-Key auswählt.

## Migration und Schlüssel

Alte `Canvas-Integrations.env` / `Canvas-Agents.env`, inklusive alter Pfad-Overrides, sind Importquellen. Der erste Zugriff importiert sie unter derselben Sperre; danach gewinnt die kanonische Datei. Abweichende Agent-Werte bleiben als `CANVAS_PROFILE_AGENTS__<KEY>` erhalten; Herkunftskonflikte als weitere Profile. Interne Metadaten erhalten die früher unabhängig verwalteten Ansichten. Neue gemeinsame Keys werden in beiden Ansichten verwendet.

Der Altimport erhält die bisherige Interpretation von Hashzeichen und Escape-Sequenzen. Der neue Texteditor unterstützt Kommentare und quoted Werte, interpretiert aber keine Shell-Ausdrücke. Ungültige oder doppelte Zuweisungen werden abgewiesen.

`CANVAS_SECRETS_MASTER_KEY` verschlüsselt Werte mit AES-256-GCM. Ohne diesen Parameter gelten als kompatible Fallbacks zuerst `INTEGRATIONS_ENV_MASTER_KEY`, dann `AGENTS_ENV_MASTER_KEY`. Ohne einen Master-Key werden ENV-Werte nicht zusätzlich auf Dateiebene verschlüsselt. Der Master-Key gehört in die geschützte Deployment-Konfiguration und muss für Wiederherstellung separat verfügbar sein. Nicht durch einfaches Austauschen eines aktiven Master-Keys rotieren: Bestehende Werte müssen zuvor mit dem alten Schlüssel entschlüsselt und mit dem neuen neu verschlüsselt werden.

Alte Master-Keys müssen für noch nicht importierte Legacy-Dateien verfügbar bleiben. Importdateien sind kein automatischer Rollback: Nach Rotation/Refresh dürfen sie keine veralteten Tokens erneut aktivieren. Logout schreibt leere Provider-Maps bzw. Tombstones, die Altimporte dauerhaft überstimmen.

MCP-Konfiguration und ENV sind zwei Dateien. Der ENV-Write wird zuerst bestätigt, dann die Konfigurationsreferenz. Scheitert der zweite Write, kann Neuladen die Migration abschließen; auch ein fehlgeschlagener Save kann bereits neue ENV-Werte hinterlassen. Bei einer erstmalig erzeugten Verbindungs-ID kann ein Abbruch einen unreferenzierten ENV-Eintrag hinterlassen. Bestehende Werte gehen dabei nicht verloren. Diese Fehlerfälle sind gezielt getestet.

MCP-ENV-/Header-Werte sowie bekannte Credentialfelder in URLs und Startargumenten werden durch verbindungsspezifische ENV-Referenzen ersetzt. Gewöhnliche URLs und Argumente bleiben Konfiguration. Die Auflösung verwendet ausschließlich den MCP-Owner und dessen bestehende Ansichtsreihenfolge. OAuth bleibt an die tatsächlich aufgelöste Server-URL gebunden; ein Wechsel dieser URL verlangt eine neue Autorisierung. URL-Benutzername/Passwort bleibt gemäß der vorhandenen Netzwerkregel als Transport unzulässig.

## Backup, Export und Rückkehr

Vollständige Backups enthalten den DATA-Bestand einschließlich aller kanonischen Bereiche und einer gegebenenfalls externen System-ENV-Datei. Für eine Wiederherstellung sind die passende Deployment-Konfiguration und Schlüssel notwendig; diese werden durch das DATA-Archiv allein nicht ersetzt. Das Wiederherstellen der Dateien mit vorhandenen Fixture-Schlüsseln wird durch echte Credential-Leser geprüft. Eine vollständige automatische Wiederherstellung der gesamten Anwendung ist kein neu eingeführtes Feature.

Kanonische und bekannte alte Credentialdateien sowie der Datenbank-Dump erhalten im Archiv private Dateirechte `0600`, auch wenn eine Altdatei vorher weitergehende Rechte hatte. Normale Projektdateien behalten ihre ursprünglichen Rechte. Sperrdateien des kanonischen ENV-Speichers werden nicht mitgesichert.

Portable Migrationsexporte enthalten keine Secret-Dateien oder OAuth-Tokens. Ihr Reconnect-Manifest enthält nur Bereiche, Pfade/Key-Namen und Hinweise zum erneuten Verbinden; bestehende Inline-Credentials bekannter MCP-Konfigurationen werden in der exportierten Kopie entfernt. Die Quelldateien bleiben unverändert. Benutzerdateien werden nicht pauschal auf beliebige eingebettete Geheimnisse durchsucht.

Ein Rollback nach neuen Writes benötigt eine geprüfte Rückübertragung der aktuellen Credentials in das alte Format oder einen konsistenten Restore mit dem damit verbundenen Änderungsverlust. Nur alte Dateien wieder freizuschalten ist unzulässig.

## Prüfungen

Die reproduzierbaren Prüfungen und ihre Grenzen stehen im [Abnahmebericht](unified-secrets-validation.md). `npm run test:secrets` bündelt die fokussierten Verträge. Der Browserlauf benötigt ein isoliertes lokales DATA/DB-Setup und private Login-Fixturedateien; er verändert keine Produktionsdaten und verwendet keine fest hinterlegten Zugangsdaten.
