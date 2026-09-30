# Vereinheitlichung der Secrets in den Einstellungen

Stand: 2026-09-30. Status: Architekturvorschlag und Grundlage für die Umsetzungsplanung. Untersuchte Codebasis: `634af5ca5`. Es wurden keine Secrets gelesen, Dienste angesprochen oder Funktionstests ausgeführt.

## Umsetzungsstand

Die Umsetzung wurde anschließend beauftragt. Der obige Stand beschreibt die ursprüngliche Analyse.

- Phase 1 abgeschlossen: unveränderte Charakterisierungstests für zwei Benutzer, zwei Organisationen, System-/Prozess-Credentials und Managed-Identität.
- Phase 2 implementiert: gemeinsamer ENV-Speicher, automatische einmalige Migration, Literalsyntax ohne Interpolation, Verschlüsselung, Revisionen, atomische Writes und wiederverwendete Kernel-Sperre. Speicher-, Cascade-, Studio-, Diktat- und Lock-Regressionstests bestehen; Typecheck und gezieltes Lint bestehen.
- Phase 3 implementiert: kompatible ENV-Ansichten und gemeinsame API, gezielte PATCH-Änderungen, revisionsgeprüfter Textmodus, geschützte Credentials sowie Verwendungs-Metadaten. API-Rechte-/Konflikt-/Redaktionsprüfungen, manuelle Verbraucher, PI-Auflösung und selektive MCP-Invalidierung sind durch zusätzliche Tests abgedeckt. Die bestehenden MCP-Tests mit echten lokalen stdio-/HTTP-Testservern bestehen ebenfalls.
- Die weiteren Phasen und die Browser-/Gesamtabnahme stehen noch aus. Browser-Tests sind inzwischen ausdrücklich freigegeben; Container-Builds wurden nicht beauftragt.

Eine bewusste Korrektur aus dem Plan betrifft den älteren PI-Resolver: Persönliche Runtimes übernehmen keine instanzweiten Prozess-Credentials mehr. Die vorhandene Systempriorität dieses Resolvers (Prozess vor Agent- vor Integrationswerten) bleibt erhalten. Explizit ausgewähltes OAuth wechselt bei einem Lesefehler nicht stillschweigend auf einen API-Key. Die normalen Kaskaden der anderen Verbraucher bleiben unverändert; ein fehlerhafter oder unlesbarer Secret-Speicher stoppt die betroffene Auflösung, anstatt einen anderen Prozess-Key auszuwählen.

MCP liest manuelle ENV-Werte bisher aus dem persönlichen oder dem Systembereich, nicht direkt aus einer Organisations-ENV. Organisationsänderungen erhalten deshalb keine unzulässige MCP-Owner-Scope-Konvertierung. Persönliche/Systemänderungen vergleichen die tatsächlich wirksamen Werte (Agent-Ansicht vor Integrations-Ansicht) und schließen nur Verbindungen, deren Konfiguration den geänderten Key referenziert.

Die aktive bisherige Systemquelle hat beim Import Vorrang: konfigurierter Legacy-Override, dann globale Legacy-Datei, danach der zuvor nicht kanonische explizite Systempfad. Unterschiedliche Werte bleiben als Profil-Einträge erhalten. Agent-Abweichungen verwenden `CANVAS_PROFILE_AGENTS__<KEY>`; interne Herkunftsmetadaten bewahren die bisherigen unabhängigen Ansichten. Neue ausdrücklich gemeinsame Keys werden von beiden Ansichten genutzt. OAuth-/Verbindungsadapter verwenden geschützte `CANVAS_CREDENTIAL_*`-Datensätze, die der allgemeine Texteditor nicht verändern darf.

Neue Systempfad- und Verschlüsselungsparameter sind `CANVAS_SECRETS_ENV_PATH` und `CANVAS_SECRETS_MASTER_KEY`. Die beiden alten Pfad-Overrides sind nur Importquellen. Die alten Master-Keys entschlüsseln ihre jeweiligen Importdateien; der neue Schlüssel verschlüsselt den gemeinsamen Speicher (Fallback auf Integrations-, dann Agent-Master-Key). Bestehende Importdateien werden nicht verändert; nach Anlage der gemeinsamen Datei werden sie nicht erneut importiert.

Ziel ist eine gemeinsame ENV-Verwaltung für Agent Runtime, Mediengenerierung und Integrationen. Technische Benutzer sollen dieselben Daten als Text mit `KEY=value` bearbeiten können, die nicht-technische Benutzer über verständliche Formulare konfigurieren. Kategorien bleiben im Frontend erhalten, bestimmen aber nicht mehr die physische Speicherung.

## Empfohlene Entscheidung zur Speicherung

Empfohlen wird **eine ENV-Datei je Berechtigungsbereich**, in der alle Kategorien zusammenliegen:

```text
<DATA>/users/<userId>/secrets/Canvas-Secrets.env
<DATA>/organizations/<organizationId>/secrets/Canvas-Secrets.env
<DATA>/system/secrets/Canvas-Secrets.env
```

`<DATA>` bezeichnet den aufgelösten Datenpfad; im Container ist dies üblicherweise `/data`. Kategorien wie Agent Runtime oder Mediengenerierung erzeugen keine weiteren ENV-Dateien.

Damit wird der ursprüngliche Vorschlag einer einzigen physischen Datei für sämtliche Benutzer konkretisiert: Eine Datei je User-, Organisations- oder Systemebene ist für die bestehende Architektur sinnvoller. Sie bewahrt die vorhandene Trennung persönlicher und geteilter Daten, vereinfacht Migration und Löschung und vermeidet einen gemeinsamen Schreibengpass bei OAuth-Refresh und Einstellungen unterschiedlicher Benutzer.

Eine einzige instanzweite Datei wäre ebenfalls umsetzbar, benötigt aber Namensräume für Eigentümer und Credential-Profile, stärkere zentrale Zugriffsprüfungen sowie gemeinsame Sperren für alle Benutzer. Das bringt für das gewünschte Frontend keinen zusätzlichen Nutzen und ist deshalb nicht das empfohlene Ziel. Diese Entscheidung muss vor der Implementierung als Scope feststehen.

Der bisherige globale Speicher unter `<DATA>/secrets/` wird als Legacy-Quelle behandelt. Zentral verwaltete Werte werden nach Prüfung ihrer bisherigen Verwendung in den System-Scope übernommen. Persönliche Werte werden dadurch nicht automatisch geteilt oder einer Organisation zugeordnet.

## Befund im aktuellen Code

| Bereich | Aktueller Zustand | Bedeutung für den Umbau |
| --- | --- | --- |
| ENV-Service | `env-config.ts` unterscheidet `agents` und `integrations`; Pfade existieren für User, Organisation, System und Legacy | Dateityp und Berechtigungsbereich müssen getrennte Begriffe werden |
| Globale Einstellungen | Die ENV-API verwendet für `secretScope=system` derzeit die Legacy-Dateien unter `<DATA>/secrets/`, obwohl ein expliziter Systempfad vorhanden ist | System- und Legacy-Auflösung gemeinsam migrieren; nicht nur Dateinamen ändern |
| Provider-Installationen | Lesen beide ENV-Dateien im gewählten Credential-Scope; Agent-Einträge überschreiben gleichnamige Integrations-Einträge | Konflikte bei identischen Namen explizit behandeln |
| Älterer PI-Resolver | Vereint Integrations-, Agent- und Prozess-Environment; Prozesswerte überschreiben zuletzt | Bestehende Auflösung charakterisieren und ungewolltes Übergreifen auf persönliche Scopes beseitigen |
| Studio | Prüft optionalen Scope, anschließend zentrale Dateien, Prozess-Environment und Managed-Fallback; innerhalb eines Scopes Integrationen vor Agenten | Bestehende Versorgung und Fallbacks erhalten; Scope des tatsächlichen Aufrufs prüfen |
| Diktat | Liest zentrale Integrations-, Agent- und Prozesswerte | Gemeinsame Keys und aktuelle Quellenanzeige umstellen |
| Formulare | Provider-, Search-, E-Mail- und MCP-Formulare schreiben teilweise vollständige ENV-Listen zurück | Einzelne Änderungen statt veralteter vollständiger Listen speichern |
| Developer-Ansicht | API unterstützt `raw`; der untersuchte Secrets-Editor zeigt nur die strukturierte Eingabe | Sichtbaren Textmodus mit gemeinsamer Validierung ergänzen |
| Verschlüsselung | Agent- und Integrations-Dateien haben getrennte optionale Master-Keys; atomische Writes und prozessinterne Warteschlangen existieren | Alte Verschlüsselung lesbar halten, Schlüsselmigration und prozessübergreifende Schreibsicherheit ergänzen |
| Weitere Secrets | PI-OAuth in `auth.json`, MCP-Credentials in gebundenen verschlüsselten Dateien, Mailbox-Credentials in eigenen Secret-Dateien | Eigene Speicheradapter nötig, wenn alle dauerhaften Einstellungs-Secrets vereinheitlicht werden |
| Betrieb | Bootstrap, Legacy-Migration, Exporte und Agent-Instruktionen nennen alte Pfade | Diese Verbraucher gehören zur Umstellung |

Die Befunde stammen aus dem aktuellen Quellcode. Für diesen Worktree war kein eigener GitNexus-Index registriert; eine belastbare Graph-Impact-Auswertung steht vor Codeänderungen noch aus. Bestehende Architekturtexte sind Kontext, keine Bestätigung des aktuellen Laufzeitverhaltens.

## Umfang und Grenzen

In die gemeinsame Verwaltung kommen manuell konfigurierte API-Keys, Tokens, Integrationsvariablen, OAuth-Client-Secrets, System-E-Mail-Zugangsdaten und die dauerhaften Zugangsdaten persönlicher oder geteilter Verbindungen. Für Provider-OAuth, MCP und Mailboxen ist die Vereinheitlichung ein eigener Implementierungsschritt und darf nicht als erledigt gelten, wenn nur die beiden bisherigen ENV-Dateien ersetzt wurden.

Modelle, Endpoints, Provider-Installationen, Berechtigungen und Verbindungsdefinitionen bleiben Konfiguration. Sie dürfen Credential-Referenzen enthalten, aber keine duplizierten Secret-Werte. Unterstützende ENV-Werte wie Regionen oder Provider-URLs können weiterhin über die bestehende Provider-Eingabe verwaltet werden; ihre Zugehörigkeit ist in der Registry festgelegt.

Deployment-Startparameter und der Schlüssel zur Entschlüsselung bleiben außerhalb der Datei, die mit diesem Schlüssel verschlüsselt wird. Extern verwaltete Provider-Secrets der Control Plane werden nicht ins Notebook kopiert. Das lokal provisionierte Instance-Token bleibt eine geschützte System-/Managed-Ressource; dessen Einbindung in den neuen Resolver erfordert einen geprüften Bootstrap-Vertrag.

Passwort-Hashes, Session-Daten und nur kurzlebige OAuth-State-/PKCE-Daten werden nicht zu frei bearbeitbaren ENV-Variablen. Von externen SDKs verwaltete AWS-/Google-Credential-Dateien oder Workload-Identitäten benötigen weiterhin ihre bestehenden Authentifizierungsadapter. Falls „alle Secrets“ auch solche Deployment-Ressourcen umfassen soll, ist dies separat zu planen.

## Datenmodell und Zugriff

Jeder Eintrag benötigt einen logischen Variablennamen, Eigentümer-/Scope-Zuordnung und bei Bedarf ein Credential-Profil. Die Scope-Zuordnung ergibt sich aus dem serverseitigen Kontext und dem Speicherpfad. Ein Profil ermöglicht unterschiedliche Keys desselben Providers innerhalb eines Scopes, beispielsweise getrennte OpenAI-Abrechnung für Agent Runtime und Studio.

Eine zentrale Registry beschreibt Anzeigename, Kategorien, Datentyp, Sensitivität, Pflichtfelder, Aliase und betroffene Verbraucher. Mehrere Kategorien dürfen auf denselben gespeicherten Eintrag verweisen. Unbekannte benutzerdefinierte Variablen erscheinen unter „Weitere Variablen“ und werden nicht verworfen.

Für einfache Werte bleibt `KEY=value` erhalten. Profile und verbindungsbezogene Credentials benötigen eindeutige technische Bezeichner innerhalb der Datei. Das genaue Format wird in der ersten Phase entschieden. Dauerhafte OAuth-Daten benötigen einen versionierten, validierten Datensatz mit Access-Token, Refresh-Token und Ablaufdaten; eine Sammlung unabhängig editierter Felder ohne Transaktion ist nicht ausreichend.

Nicht geheime Profil- und Verwendungsreferenzen dürfen in der bestehenden Konfiguration stehen. Die ENV-Datei bleibt die einzige aktive Quelle der dazugehörigen Secret-Werte.

Zugriffsregeln:

- Persönliche Secrets gehören dem Benutzer; Administratorrechte allein erlauben keine Einsicht in fremde persönliche Werte.
- Organisations-Secrets werden gemäß vorhandenen Verwaltungsrechten gepflegt und nur für berechtigte Ressourcen aufgelöst.
- System-/Managed-Secrets besitzen eigene Verwaltungsregeln; normale Benutzer dürfen sie gegebenenfalls indirekt nutzen, aber nicht auslesen.
- Kategorie-Filter und Developer-Modus verleihen keine zusätzlichen Rechte.
- Ein zentraler Resolver erhält Actor, Organisation, Ressource, Zweck und Credential-Referenz. Tools und Provider erhalten nur die benötigten Werte.
- User-/Organisations-Provider dürfen nicht pauschal auf System-Keys oder `process.env` zurückfallen. Studio, Diktat und Managed-Dienste behalten ihre ausdrücklich definierte Versorgung.
- Secrets werden nicht global in `process.env`, Client-Konfiguration oder Agent-Prompts geladen.

## Gemeinsamer Speicher und API

Der Secret-Service besitzt Pfadauflösung, Parsing, Validierung, Verschlüsselung, Änderungen, Löschung und Revisionen. Verbraucher besitzen ihre fachliche Auswahl und Fallback-Policy, nicht eigene Dateiformate oder Kopien der Werte.

Erforderliche Eigenschaften:

- Atomische Änderungen mit `0600` für Dateien und restriktiven Verzeichnisrechten.
- Prozessübergreifende Sperren je Datei für Formularänderungen, Migration und Token-Refresh; Prüfung des tatsächlichen lokalen Dateisystems und der Serverprozesse.
- Versionsprüfung für veraltete Editorstände. Einzeländerungen dürfen andere Keys nicht überschreiben.
- Gemeinsamer Parser für Formular und Textmodus mit festgelegter Behandlung von Quotes, Escapes, Kommentaren, CRLF, leeren und mehrzeiligen Werten.
- Doppelte Namen und ungültige Zeilen werden mit konkreten Fehlern gemeldet. Keine Shell-Auswertung und keine implizite Variableninterpolation im Secret-Speicher.
- Kommentare und benutzerdefinierte Werte bleiben bei strukturierten Änderungen erhalten.
- Bestehende verschlüsselte Werte müssen lesbar bleiben. Nicht entschlüsselbare Werte dürfen beim Speichern nicht gelöscht oder durch Leerwerte ersetzt werden.
- Verschlüsselte Datensätze berücksichtigen Eigentümer, Verbindung und Zweck; die bestehende MCP-Bindung darf durch die Verlagerung nicht entfallen.

Die bestehende `/api/integrations/env` bleibt zunächst als kompatibler Adapter bestehen. Alte Parameter `scope=agents|integrations` werden als bisherige Ansicht verstanden, nicht als Dateiauswahl. Insbesondere darf ein alter gefilterter PUT nicht die ganze neue Datei ersetzen. Profile und unbekannte Legacy-Keys benötigen dabei eine nachvollziehbare Zuordnung.

Neue Formularaufrufe senden gezielte Upserts/Löschungen. Der Texteditor ersetzt ausschließlich den autorisierten Editorbereich und benötigt dessen Ausgangsrevision. Geschützte Datensätze werden serverseitig erhalten oder Änderungen daran ausdrücklich abgewiesen. System-E-Mail und Managed-Credentials bleiben besonders geregelt.

Standardantworten liefern Konfigurationsstatus und Metadaten. Werte werden nur an autorisierte Bearbeitungs-/Auflösungswege ausgegeben. Audit und Fehler enthalten keine Secret-Werte. Fehlende Keys führen zu einer verständlichen Meldung und einem funktionierenden Link zur passenden Einstellungsansicht; bestehende Integrationslinks bleiben kompatibel.

## Frontend

Die Secrets-Verwaltung erhält die unabhängigen Auswahlen „Persönlich / Organisation / System“ und „Alle / Agent Runtime / Mediengenerierung / Integrationen / Weitere Variablen“. Angeboten werden nur autorisierte Bereiche.

Im normalen Modus bleiben fachliche Provider- und Integrationsformulare erhalten. Sie zeigen verständliche Namen, benötigte Felder, verdeckte Werte, Verbindungsstatus und „Wird verwendet für …“. Ein gemeinsam verwendeter Key wird in allen passenden Ansichten sichtbar. Rotation oder Löschung zeigt die betroffenen Verwendungen. Unterschiedliche Credential-Profile werden nicht stillschweigend zusammengeführt.

Der Developer-Modus zeigt autorisierte Einträge als Text mit `KEY=value`, einschließlich Zeilennummern, Validierungsfehlern, Speichern/Neu laden und Konflikterkennung. Bei Verschlüsselung bearbeitet er eine entschlüsselte Projektion; das Speichern verschlüsselt wieder. Ein Kategorie-Filter darf keinen vollständigen Dateiersatz auslösen. Die Implementierung muss ungespeicherte Änderungen beim Modus-, Kategorie- oder Scope-Wechsel bewahren oder einen klaren Wechselkonflikt anzeigen.

OAuth-, MCP- und Mailbox-Verbindungen werden im normalen Modus weiterhin über Verbinden, Neu verbinden und Trennen verwaltet. Technische Bearbeitung ihrer dauerhaften Datensätze muss schema-validiert und transaktional erfolgen. Schlüsselmaterial für Verschlüsselung sowie kurzlebige Login-Zustände werden nicht als gewöhnliche Formularfelder angeboten.

## Betroffene Module

Die Liste benennt die untersuchten Einstiegspunkte; Phase 1 vervollständigt die Verbraucher und dynamischen Zugriffe.

| Bereich | Einstiegspunkte |
| --- | --- |
| Speicherung und Pfade | `app/lib/integrations/env-config.ts`, `app/lib/runtime-data-paths.ts` |
| ENV-API und Settings | `app/api/integrations/env/route.ts`, `app/components/settings/IntegrationsSettingsClient.tsx`, `ProviderEnvEditor.tsx`, `ProviderInstallationCredentialEditor.tsx`, `AiProviderCredentialsPanel.tsx`, `ai-runtime/AiProviderEditorDialog.tsx`, `app/lib/pi/provider-help.ts` |
| Agent Runtime | `app/lib/agent-runtime-policy/installation-credentials.ts`, `provider-runtime.ts`, `provider-verification-service.ts`, `app/lib/pi/api-key-resolver.ts`, `app/lib/pi/oauth.ts`, `app/lib/agents/storage.ts`, Provider-Verifikations- und Onboarding-Routen |
| Medien | `app/lib/integrations/studio-provider-credentials.ts`, `studio-config.ts`, `image-generation-providers.ts`, `veo-generation-service.ts`, `seedance-generation-service.ts`, `sound-generation-service.ts`, `managed-media-client.ts`, Studio-Web-/Mobile-/Agent-Aufrufwege |
| Sprache | `app/lib/dictation/credentials.ts`, `app/lib/integrations/audio-transcription-service.ts`, Diktat-Credential-API und Settings |
| Integrationen | `app/lib/integrations/brave-search-service.ts`, `app/lib/composio/composio-client.ts`, `composio-identity.ts`, `composio-profiles.ts`, `composio-webhook-secret.ts`, Search-/Composio-Einstellungen |
| MCP | `app/lib/mcp/manager.ts`, `secret-store.ts`, `credential-storage.ts`, OAuth-Lifecycle, Verbindungs- und Settings-Speicherung |
| E-Mail | `app/lib/email/local-service.ts`, `system-smtp-config.ts`, `secret-store.ts`, OAuth- und Mailbox-Lifecycle sowie zugehörige Formulare |
| Betrieb und Migration | `scripts/bootstrap-agent-runtime.ts`, `app/lib/integrations/legacy-secret-migration.ts`, `app/lib/migration/export-service.ts`, Restore-/Backup-Wege, `server/load-app-env.js`, Agent-Instruktionen und Produktdokumentation |

## Umsetzung in abgeschlossenen Phasen

Jede Phase endet mit einer überprüfbaren Abnahme und einem fokussierten Commit. Die nächste Phase beginnt erst, wenn die vorherige abgeschlossen ist. Feature-Schalter und Adapter dürfen Übergänge ermöglichen, aber nach einer Migration darf es nicht zwei aktive Schreibquellen für dieselben Credentials geben.

1. **Verträge und Bestandsaufnahme:** Alle Leser/Schreiber, Scopes, Aliase, Fallbacks und Secret-Typen erfassen. Bestehende Prioritäten mit Charakterisierungstests festhalten. Dateiformat, Profilreferenzen, Systempfad, API-Kompatibilität und Rollback-Vertrag festlegen. GitNexus für den aktuellen Worktree aktualisieren und Impact vor Symboländerungen prüfen.
2. **Speicher und Migration:** Gemeinsamen Service, Parser, Verschlüsselung, prozessübergreifende Sperren und Revisionen implementieren. Beide bisherigen ENV-Dateien je Scope verlustfrei migrieren und kompatible Adapter bereitstellen. Berechtigungs-, Konflikt- und Wiederanlauftests müssen bestehen, bevor produktive Verbraucher umgestellt werden.
3. **ENV-API und manuelle Verbraucher:** API sowie Agent-, Studio-, Search-, Composio-, Diktat- und System-E-Mail-Leser/Schreiber auf gemeinsame Auflösung und gezielte Änderungen setzen. Bestehende Runtime- und Managed-Fallbacks prüfen. Nur betroffene Caches und Verbindungen invalidieren.
4. **Dauerhafte Verbindungszugangsdaten:** Provider-OAuth, MCP- und Mailbox-Secrets über validierte Adapter vereinheitlichen. Refresh, Reconnect, Logout, Löschung und Verbindungsbindung testen. Bei technischen Einschränkungen bleibt diese Phase ausdrücklich offen; der Gesamtumbau ist dann noch nicht vollständig.
5. **Frontend:** Gemeinsame Scope-/Kategorie-Auswahl, fachliche Formulare und Developer-Textmodus integrieren. Browser-Abnahme für Bearbeitung, Rechte und Wechsel zwischen Ansichten durchführen; erforderliche Browser-Freigabe vorher einholen.
6. **Betrieb und Abschluss:** Bootstrap, Pfad-Overrides, Backups, Migrationsexporte, Restore und Dokumentation umstellen. Vollständige Regression sowie reale minimale Verbindungstests durchführen. Alte aktive Schreibwege erst nach erfolgreicher Abnahme entfernen.

Vor Beginn werden die Phasen in kleine ausführbare Aufgaben mit konkreten Dateien, Abnahmekriterien und Abhängigkeiten zerlegt. Dieses Dokument startet die Implementierung nicht.

## Migration und Rollback

Die Migration berücksichtigt User-, Organisations-, explizite System- und globale Legacy-Dateien, konfigurierte `INTEGRATIONS_ENV_PATH`-/`AGENTS_ENV_PATH`-Overrides und vorhandene `/home/node`-Migrationen. Legacy-Importmarker müssen mit der neuen Migration abgestimmt werden, damit alte Dateien später keine veralteten Werte erneut importieren.

Gleiche Werte im gleichen Credential-Kontext werden zusammengeführt. Abweichende Werte bleiben als getrennte Profile erhalten oder erfordern eine dokumentierte Auswahl. Die bisherigen Agent-/Studio-Prioritäten werden durch Verwendungsreferenzen abgebildet, statt einen der Werte zu verwerfen. Prozess-Environment-Werte werden nicht ungeprüft übernommen.

Alte verschlüsselte Werte werden mit ihrem jeweiligen Master-Key gelesen und in das neue Format übertragen. E-Mail-/MCP-Verschlüsselungsschlüssel und frühere Schlüsselversionen dürfen nicht verschwinden, solange noch Datensätze davon abhängen. Fehlende Schlüssel stoppen die betroffene Migration ohne Datenverlust.

Migrationen sind versioniert, wiederholbar und nach Unterbrechung fortsetzbar. Ein Bericht enthält Herkunft, Scope, Key-Namen, Konflikte und Status, aber keine Werte. Vor dem Umschalten wird ein geschützter konsistenter Backup-Stand erstellt.

Ein Rollback nach neuen Schreibvorgängen erfordert die geprüfte Rückübertragung aktueller Werte/Token in das alte Format oder einen konsistenten Restore mit entsprechendem Änderungsverlust. Alte Dateien liegenzulassen genügt nicht als Rollback, insbesondere nach OAuth-Refresh. Dieser Vertrag wird vor Phase 2 getestet.

## Tests und Abnahme

| Testgruppe | Erforderlicher Nachweis |
| --- | --- |
| Parser und Speicherung | Formular/Text-Roundtrip; Quotes, Backslashes, Sonderzeichen, Kommentare, CRLF, leere/mehrzeilige Werte; doppelte Keys und ungültige Zeilen; Verschlüsselung und Dateirechte |
| Schreibsicherheit | Zwei Browser mit altem Stand, mehrere Serverprozesse, gleichzeitig gespeicherte Kategorien und Token-Refresh; keine verlorenen Änderungen; Fehler/Abbruch vor und nach atomischem Austausch |
| Scope und Rechte | Zwei Benutzer und zwei Organisationen; eigene und fremde Einträge; erlaubte indirekte Systemnutzung; keine pauschale persönliche Secret-Einsicht für Admins; manipulierte Requests |
| Filter und Profile | Mehrfach zugeordnete Keys erscheinen ohne Duplikate; unbekannte Keys bleiben erhalten; getrennte Provider-Profile; gefiltertes Speichern löscht keine anderen Werte |
| Migration | Fresh Install und Upgrade; alle alten Scopes, Overrides und Marker; gleiche/abweichende Keys; verschiedene Master-Keys, fehlender Schlüssel, Unterbrechung, Wiederholung und Rollback nach Rotation |
| Agent Runtime | Provider-Verifikation und Chat mit richtigem Scope/Profil; OAuth, Anthropic-Auth-Varianten, Azure-/AWS-/Google-Konfiguration, Ollama/OpenAI-compatible; bestehende Runtime, Modellwechsel, Automations und Delegation |
| Medien | Bild-, Veo-, Seedance- und Sound-Aufträge; persönliche/Organisations-Overrides nur in tatsächlich unterstützten Aufrufwegen; zentrale Versorgung; Prozess-Fallback als Übergang; Managed-Fallback; Status, Ergebnis und Fehler |
| Integrationen | Brave-Anfrage und Composio-Aufruf; MCP stdio/HTTP, `${KEY}`-Referenzen und Passthrough; OAuth-Refresh/Reconnect; fehlende Keys und hilfreiche Settings-Links |
| E-Mail und Sprache | Persönliche/geteilte Mailboxen; SMTP/IMAP, OAuth-Refresh, System-E-Mail; Diktat und Transkription; geschützte System-E-Mail-Einträge bei allgemeinen ENV-Änderungen |
| Laufende Clients | Rotation, Löschung und Refresh werden wirksam; unbeteiligte MCP-Verbindungen bleiben aktiv; keine Weiterverwendung falscher gecachter Credentials |
| Datenabfluss | Keine Werte in Logs, Audit, Fehlermeldungen, Modellkatalog, Client-Bundles, unbeteiligten Subprozess-Umgebungen oder Migrationsexporten |
| Betrieb | Bootstrap/Neustart, Backup/Restore samt Schlüsselverfügbarkeit; Update und Datenpfad-Umzug; Migrationsexporte weiterhin redacted/Reconnect-Manifest |
| Frontend | Normal-/Developer-Modus, Sichtbarkeit, Speichern/Neu laden, Fehlermeldungen, ungespeicherte Änderungen, Scope-/Kategorie-Wechsel, veraltete Revision, DE/EN und mobile Darstellung |

Vorhandene Suiten als Ausgangspunkt: `test:integrations:env-scope`, `test:scoped-data-paths`, `test:studio:provider-credentials`, `test:agent:provider-verification`, `test:agent:runtime-settings-ui`, `test:mcp:storage`, `test:mcp:manager`, `test:mcp:oauth-lifecycle` sowie die betroffenen Mail-, Diktat-, Studio- und Migrationsprüfungen. Ergänzende gezielte Tests müssen die neue Architektur prüfen; bestehende Tests allein sind keine ausreichende Abnahme.

Nach Codeänderungen sind passende Tests, Lint/Typecheck und `npm run build` erforderlich. UI-/E2E-Abnahme erfolgt mit Playwright oder Chrome DevTools erst nach ausdrücklicher Nutzerfreigabe. Für das lokale Setup ist der Skill `canvas-local-team-seat-dev` verbindlich. Container werden ausschließlich auf ausdrücklichen Auftrag gebaut, erst nach erfolgreichem Build; nur eine verwaltete Testumgebung, bei neuem Lauf mit aktuellem Stand neu erstellt.

Live-Verbindungstests verwenden eingerichtete Testkonten und minimale Aufträge. Sie prüfen echte Authentifizierung und mindestens eine fachliche Operation pro eingerichteter Anbindung. Kostenpflichtige Medienaufträge und Mailversand werden im konkreten Testumfang abgestimmt. Mock-Tests belegen nicht die Erreichbarkeit externer Anbieter. Vor Produktionsdeploy ist `npm run test:all` erforderlich; die darin enthaltene Browser-Nutzung muss autorisiert sein.

## Einsatz von Subagenten

Der Nutzer hat Subagenten für die spätere Umsetzung mit dem kleinsten sinnvoll geeigneten Modell angefordert. Die Modelle werden pro begrenzter Aufgabe gewählt, nicht pauschal für den ganzen Umbau:

- **`gpt-6-luna`** als Startmodell für eng beschriebene Aufgaben wie Verbraucher-Inventar, klar definierte Adapter, Registry-/Formularänderungen, Dokumentation und Tests nach festgelegtem Vertrag.
- **`gpt-6.1-sol`** für Aufgaben, bei denen der kleinere Agent konkrete Schwierigkeiten meldet oder die vorab komplexe Scope-, Migrations-, Verschlüsselungs- oder Token-Refresh-Logik betreffen. Solche Änderungen erhalten einen gezielten unabhängigen Review.
- Größere Modelle nur bei einer belegten ungelösten Schwierigkeit. Ein einfaches Schema- oder Testproblem rechtfertigt keinen automatischen Sprung zum größten Modell.

Delegationen erhalten einen kleinen Scope, Dateizuständigkeit, Eingangsverträge, Abnahmekriterien und das Verbot, Secret-Werte auszugeben. Die Modellwahl wird bei tatsächlicher Ausführung anhand verfügbarer Modelle überprüft. Der Hauptagent verantwortet Architektur, Integration, Risikobewertung, Tests und Commit-Abnahme.

Subagenten arbeiten innerhalb der aktiven Phase. Es werden keine späteren Aufgaben begonnen, solange die vorige wichtige Aufgabe nicht abgeschlossen ist. Überschneidende Dateien werden nicht parallel bearbeitet; Review folgt dem fertigen Änderungsvorschlag. Pro Aufgabe möglichst ein passender Agent statt mehrerer Agenten mit derselben Recherche.

Vor Symboländerungen ist GitNexus-Impact erforderlich; HIGH/CRITICAL-Risiken werden vor dem Edit berichtet. Vor jedem Commit wird `detect_changes()` ausgeführt. Fertige Aufgaben werden sauber committed; Push nur für einen beauftragten PR oder auf ausdrücklichen Wunsch.

## Gesamtabnahme

Der Umbau ist abgeschlossen, wenn sämtliche vereinbarten dauerhaften Einstellungs-Secrets pro Berechtigungsbereich aus `Canvas-Secrets.env` kommen, Formulare und Developer-Modus denselben Datenbestand bearbeiten, Kategorien keine zusätzlichen Dateien erzeugen und alle Verbraucher ihre Eigentums-, Profil- und Fallback-Regeln nachweislich einhalten. Migration, Rotation, Token-Refresh, Wiederherstellung und die autorisierte Browser-Abnahme müssen bestanden sein.

## Referenzen

- [ENV-Service](../../../app/lib/integrations/env-config.ts) und [Speicherpfade](../../../app/lib/runtime-data-paths.ts)
- [ENV-API](../../../app/api/integrations/env/route.ts) und [Secrets-Frontend](../../../app/components/settings/IntegrationsSettingsClient.tsx)
- [Provider-Credentials](../../../app/lib/agent-runtime-policy/installation-credentials.ts), [älterer PI-Resolver](../../../app/lib/pi/api-key-resolver.ts) und [Provider-Formular](../../../app/components/settings/ProviderEnvEditor.tsx)
- [Studio-Credentials](../../../app/lib/integrations/studio-provider-credentials.ts) und [Managed-Media-Client](../../../app/lib/integrations/managed-media-client.ts)
- [PI-OAuth](../../../app/lib/pi/oauth.ts), [MCP-Credential-Speicherung](../../../app/lib/mcp/credential-storage.ts) und [Mailbox-Secrets](../../../app/lib/email/secret-store.ts)
- [Migrationsexporte](../../../app/lib/migration/export-service.ts) und [Legacy-Secret-Migration](../../../app/lib/integrations/legacy-secret-migration.ts)
- [Architektur der User- und Organisations-Secrets](team-workspace/08-user-scoped-secrets-runtime.md)
