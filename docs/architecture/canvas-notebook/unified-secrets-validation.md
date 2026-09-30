# Abnahme: gemeinsamer Secret-Speicher

Stand: 2026-09-30. Branch: `codex/unified-settings-secrets`. Ausgangsstand: `634af5ca5`.

Dieser Bericht unterscheidet tatsächliche lokale Browser-/Datei-/HTTP-Prüfungen von simulierten Anbietergrenzen. Betriebsvertrag: [unified-secrets-operations.md](unified-secrets-operations.md). Ursprünglicher Plan: [unified-secrets-env-plan.md](unified-secrets-env-plan.md).

## Nachweise

| Bereich | Reproduzierbarer Test | Beweis |
| --- | --- | --- |
| Datei, Parser, Migration | `npm run test:secrets:store` | User/Organisation/System, abweichende Agent-/Integrationsprofile, alte Systempfade und Overrides, getrennte alte Master-Keys, verschlüsselte Speicherung, Kommentare/Literalsyntax, Revisionen, geschützte Datensätze und parallele Prozesse. Hashzeichen und quoted Alt-Escapes bleiben beim Import exakt erhalten; unveränderte öffentliche PATCHes behalten Bytes und Revision. |
| Rechte und API | `npm run test:secrets:api` | Echte Route und Dateispeicherung mit auth-/rollenbezogenen Fixtures: zwei User und zwei Organisationen; fremde IDs, Admin-/Organisationsrechte, gezielte Writes, Text-Revisionskonflikte, Reserved-Redaktion. Änderungen bestehender View-Zuordnungen heben deren Herkunft nicht auf. |
| Kaskaden | `npm run test:secrets:cascade` | Agent-Installationen nutzen exakt ihren Credential-Scope; keine persönlichen/orgweiten Prozess-Key-Übernahmen. Agent vor Integration für Runtime/MCP; Integration vor Agent für Studio. Studio nutzt expliziten Scope vor System vor Prozess. Managed-Provider verwenden die Instanzidentität. |
| Manuelle Verbraucher | `npm run test:secrets:consumers` | Gemini/OpenAI/Groq/KIE, Brave/Ollama und Composio lesen die gemeinsamen Dateien. Fehlende Werte folgen ihren bisherigen Fallbacks; fehlerhafte Verschlüsselung stoppt die Auflösung trotz angebotener Prozess-Decoys. Composio-Identität bleibt bei parallelen Writes eindeutig. |
| PI Runtime / OAuth | `npm run test:secrets:pi` und `npm run test:secrets:oauth` | Persönliche/systemweite Priorität, explizites OAuth ohne stillen API-Key-Fallback; Login, Refresh, Reconnect und Logout für zwei User. Mehrere Prozesse aktualisieren verschiedene Provider verlustfrei; derselbe Provider wird nur einmal refreshed. Altdateien/Overrides können Rotation und Logout nicht zurückspielen. |
| Mailboxen | `npm run test:secrets:email` | Persönliche und Workspace-Konten, SMTP/IMAP- und OAuth-Daten, Refresh, Tombstones, verschlüsselte Altimporte und falsche Schlüssel. Bestehende Mail-Service-/Cache-Tests prüfen ergänzend den echten lokalen Service einschließlich konkurrierender OAuth-Requests. |
| Composio-Webhooks | `npm run test:secrets:webhooks` | Neuer verschlüsselter ENV-Verweis, Import alter Klartext-/Ciphertext-Daten, authoritative Rotation/Tombstones und unveränderte Revision beim Lesen. Tatsächlicher Subscription-Gateway verwendet denselben gespeicherten Verweis in beiden DB-Schreibpfaden. |
| MCP-Konfiguration / Clients | `npm run test:secrets:mcp-config`, `npm run test:secrets:mcp`, `npm run test:secrets:mcp-env` | Verbindungswerte liegen im ENV-Scope des Owners; Referenzen/Template-Layer funktionieren. OAuth-Bindung/AAD, Logout, Reconnect, Verschlüsselung, Revisionsstabilität, selektive Client-Invalidierung und Fehler zwischen ENV-/Konfigurationswrite sind abgedeckt. Bestehende Manager-Suiten benutzen echte lokale stdio-/HTTP-Testserver. |
| Provider-Konfiguration | `npm run test:secrets:provider-config` | Tatsächlicher Katalogleser entfernt verbotene gespeicherte Credentialfelder und bewahrt ausschließlich sichere Konfiguration. |
| Bootstrap | `npm run test:secrets:bootstrap` | Tatsächlicher Bootstrap-Prozess: Fresh Install erzeugt nur die kanonische Systemdatei mit `0600`; Upgrade erhält divergierende Profile und verschlüsselte Werte. Zwei gleichzeitige Erststarts funktionieren. Neustart liest keine geänderten Altwerte erneut ein. |
| Control Plane / Medien | `npm run test:secrets:control-plane` | Echter Studio-Resolver und Seedance-Service: User-/Org-BYOK erreicht die Anbietergrenze mit dem richtigen Key und ohne CP-Anfrage. Fehlender Key führt zum echten Managed-Media-Client. Lokaler HTTP-CP prüft Bild/Video/Sound mit Create→Poll→Download→Ack; alle Requests verwenden die Instanzidentität, keine BYOK-Werte im Body. Deaktivierter Fallback versendet keine Anfrage. |
| Organisations-Aufrufweg | `npm run test:studio:organization-scope` | Tatsächliche Request-/Workspace-/Studio-Scope-Funktionen mit DB-Mitgliedschaftsfixtures: getrennte Organisationen, richtige Credentials und Speicherwurzeln; fremde Workspace-Query wird trotz erlaubtem Header abgewiesen. |
| Export / Wiederherstellung | `npm run test:secrets:recovery` | Tatsächliche ZIP-Dateien: bekannte kanonische/alte/custom Credentials fehlen im portablen Export; bekannte Konfigurationen werden nur in der Archivkopie redigiert. Reconnect-Manifest enthält keine Werte. Full-Backup-DATA-Extraktion erhält User/Org/System-Profile und rotierte Credentials; echte PI-/MCP-/Mailbox-Leser lesen sie nach Wiederherstellung. Falscher Master-Key scheitert. Kein DB-Restore wird behauptet. |
| Komponenten | `npm run test:secrets:ui` | Gemeinsamer Editor, Provider/Ollama und Search/Email/MCP-Formulare: gezielte Änderungen, unveränderte Felder bleiben erhalten, Maskierung, mehrzeilige Bearbeitung, fremde asynchrone Ergebnisse, ungespeicherte Eingaben, Konflikte und erfolgreiche Änderungsbenachrichtigungen. |
| Browser | `npm run test:secrets:browser` mit privatem Fixture-Setup | Autorisierter Chromium-Lauf am aktuellen Worktree mit echter Bootstrap-/Mitgliedsanmeldung, tatsächlicher API und isolierter PostgreSQL-/DATA-Kopie. User/Org/System, Mitgliederrechte, manipulierte User-ID, Kategorien, Formular/Text, Kommentar-/Escape-Roundtrip, sichtbarer HTTP-409-Konflikt mit erhaltenem Entwurf, abgebrochener Scope-Wechsel, DE/EN und mobile Breite geprüft. Desktop-/Mobilbilder visuell geprüft, Werte verdeckt. |

## Endstand

Die abschließende Sammelprüfung, Typecheck, Lint, Build und GitNexus-Prüfung werden nach dem letzten Review-Fix hier eingetragen. Die Browser-Abnahme ist bestanden; es wurde kein Container gebaut und kein Produktionssystem verändert.

## Bereits bestehende, separat reproduzierte Einschränkung

`npm run test:pi:tools` scheitert an `automation_job_state: delegated worker cannot receive bound automation tools` (erwartet false, erhält true). Der identische Fehler wurde mit dem vollständigen unveränderten Ausgangsstand `634af5ca5` in einem separaten temporären Checkout reproduziert. Diese breite Automationsprüfung wird deshalb nicht als erfolgreich ausgewiesen. Die gezielten Secrets-/PI-/Provider-Verifikationsverträge laufen unabhängig davon.

## Grenzen der Aussagen

Es wurden keine kostenpflichtigen externen Generierungen und keine externen E-Mails versendet. Anbieter-SDKs/HTTP-Endpunkte und OAuth-Refresh sind an den externen Grenzen simuliert; sie beweisen Key-Auswahl und Requestverträge, nicht die Gültigkeit realer Anbieterkeys oder die Erreichbarkeit aller Anbieter.

Der verwaltete lokale Control Plane und der aktuelle Notebook-Host beantworteten ihre Health-Prüfungen mit HTTP 200. Die verwendete Browser-Fixture enthält keine Managed-Service-Instanzkonfiguration; ein echter Managed-Medienauftrag wurde daher nicht behauptet. Der vollständige Managed-Medienvertrag wird gegen einen lokalen HTTP-CP geprüft.

Die Recovery-Prüfung extrahiert DATA mit vorhandenen Fixture-Schlüsseln und liest echte Credentials; der PostgreSQL-Dump wird im Archivtest kontrolliert simuliert. Ein vollständiger Datenbank-/Anwendungs-Restore ist nicht Teil dieses Nachweises. Bestehende vollständige Backups haben für Dateien weiterhin den Vertrag `online_best_effort`, keine über alle Dateien und Datenbank hinweg atomische Momentaufnahme. Master-Keys/Deployment-ENV müssen gesondert verfügbar sein.

Die portable Redaktion gilt für verwaltete Credentialpfade und bekannte Runtime-Konfigurationen. Beliebige Benutzerdateien werden nicht als allgemeiner Secret-Scanner behandelt.
