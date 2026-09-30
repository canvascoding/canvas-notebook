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
| MCP-Konfiguration / Clients | `npm run test:secrets:mcp-config`, `npm run test:secrets:mcp-transport`, `npm run test:secrets:mcp`, `npm run test:secrets:mcp-env` | Verbindungswerte liegen im ENV-Scope des Owners; Referenzen/Template-Layer funktionieren auch in bekannten Credential-URLs und Startargumenten (`?key=`, `--key`, Header). Echte stdio-/HTTP-Transporte erhalten die aufgelösten Werte. OAuth-Bindung/AAD, Logout, Reconnect, Verschlüsselung, Revisionsstabilität, selektive Client-Invalidierung und Fehler zwischen ENV-/Konfigurationswrite sind abgedeckt. URL-Rotation während eines offenen Callbacks oder während der Refresh-Metadatenabfrage wird vor Token-Anfrage und Veröffentlichung abgewiesen. |
| Provider-Konfiguration | `npm run test:secrets:provider-config` | Tatsächlicher Katalogleser entfernt verbotene gespeicherte Credentialfelder und bewahrt ausschließlich sichere Konfiguration. |
| Bootstrap | `npm run test:secrets:bootstrap` | Tatsächlicher Bootstrap-Prozess: Fresh Install erzeugt nur die kanonische Systemdatei mit `0600`; Upgrade erhält divergierende Profile und verschlüsselte Werte. Zwei gleichzeitige Erststarts funktionieren. Neustart liest keine geänderten Altwerte erneut ein. |
| Control Plane / Medien | `npm run test:secrets:control-plane` | Echter Studio-Resolver und Seedance-Service: User-/Org-BYOK erreicht die Anbietergrenze mit dem richtigen Key und ohne CP-Anfrage. Fehlender Key führt zum echten Managed-Media-Client. Lokaler HTTP-CP prüft Bild/Video/Sound mit Create→Poll→Download→Ack; alle Requests verwenden die Instanzidentität, keine BYOK-Werte im Body. Deaktivierter Fallback versendet keine Anfrage. |
| Organisations-Aufrufweg | `npm run test:studio:organization-scope` | Tatsächliche Request-/Workspace-/Studio-Scope-Funktionen mit DB-Mitgliedschaftsfixtures: getrennte Organisationen, richtige Credentials und Speicherwurzeln; fremde Workspace-Query wird trotz erlaubtem Header abgewiesen. |
| Export / Wiederherstellung | `npm run test:secrets:recovery` | Tatsächliche ZIP-Dateien: bekannte kanonische/alte/custom Credentials fehlen im portablen Export; bekannte Konfigurationen werden nur in der Archivkopie redigiert. Reconnect-Manifest enthält keine Werte. Full-Backup-DATA-Extraktion erhält User/Org/System-Profile und rotierte Credentials; echte PI-/MCP-/Mailbox-Leser lesen sie nach Wiederherstellung. Falscher Master-Key scheitert. Kein DB-Restore wird behauptet. |
| Komponenten | `npm run test:secrets:ui` | Gemeinsamer Editor, Provider/Ollama und Search/Email/MCP-Formulare: gezielte Änderungen, unveränderte Felder bleiben erhalten, Maskierung, mehrzeilige Bearbeitung, fremde asynchrone Ergebnisse, ungespeicherte Eingaben, Konflikte und erfolgreiche Änderungsbenachrichtigungen. |
| Browser | `npm run test:secrets:browser` mit privatem Fixture-Setup | Autorisierter Chromium-Lauf am aktuellen Worktree mit echter Bootstrap-/Mitgliedsanmeldung, tatsächlicher API und isolierter PostgreSQL-/DATA-Kopie. User/Org/System, Mitgliederrechte, manipulierte User-ID, Kategorien, Formular/Text, Kommentar-/Escape-Roundtrip, sichtbarer HTTP-409-Konflikt mit erhaltenem Entwurf, abgebrochener Scope-Wechsel, DE/EN und mobile Breite geprüft. Desktop-/Mobilbilder visuell geprüft, Werte verdeckt. |

## Endstand

Bestanden am abschließenden Implementierungsstand:

- `npm run test:secrets`: alle 17 Prüfgruppen, einschließlich tatsächlicher Dateispeicherung, Prozesssperren, Service-Leser, lokaler Transportgrenzen, Recovery und UI-Komponenten.
- `npm run test:secrets:regression`: alle 22 aufgerufenen Prüfgruppen der vorhandenen Integrations-, Medien-, Runtime-, MCP-, Mail-, Export-/Backup- und Diktatverträge.
- `npx tsc --noEmit --incremental false` und ESLint für die geänderten Quell-/Testdateien; abschließende Korrekturen erneut geprüft.
- `npm run build`, einschließlich Tool-App-Build, Lizenzprüfung, TypeScript und Seitenvorbereitung. Der Build meldet 33 Warnungen zu dynamischem Filesystem-/Import-Tracing sowie Node-localStorage-/Yjs-Hinweise, beendet sich aber erfolgreich.
- Die autorisierte Browser-Abnahme am aktuellen Worktree mit isolierter DB/DATA und echten Anmeldungen.

Ein erster abschließender Sammellauf offenbarte eine Timing-Annahme in der Backup-Test-Fixture: Der Status `completed` kann kurz vor Freigabe der letzten Sperre erscheinen. Die Fixture wartet jetzt auf die tatsächliche Freigabe und lässt ausschließlich den erwarteten Busy-Zustand auslaufen; der vollständige Sammellauf wurde danach erfolgreich wiederholt.

GitNexus-Impactprüfungen liefen vor den Symboländerungen. Für den finalen Scope-Abgleich wurde der Index vollständig neu aufgebaut, weil die inkrementelle Analyse einen `Invalid UTF-8`-Fehler ausgab. `detect-changes` für den letzten Implementierungscommit: 12 Dateien, 47 Symbole, keine neu zugeordneten Abläufe, Risiko LOW. Vergleich gegen `main`: 93 Dateien, 618 Symbole, drei betroffene Abläufe, Risiko MEDIUM. Die Abläufe betreffen die erwarteten Workspace-Sperren, Settings und MCP-Scope-Auflösung. Acht Dictation-/Übersetzungsdateien unterscheiden sich bereits zwischen `main` und dem Ausgangsstand `634af5ca5`; diese vorhandenen Änderungen wurden beim Scope-Abgleich separat berücksichtigt.

Es wurde kein Container gebaut und kein Produktionssystem verändert. Die Implementierung ist in getrennten fachlichen Commits auf `codex/unified-settings-secrets` abgelegt.

Die eigens erzeugte isolierte UI-Datenbank, private ENV-/DATA-Kopie und der temporäre Baseline-Checkout wurden nach der Abnahme entfernt. Der verwaltete lokale Stack blieb bestehen; verdeckte Browserbilder und der Ergebnisreport sind lokal unter `/tmp/canvas-secrets-a2cd-ui-evidence` erhalten.

## Erneute Prüfung vor Übernahme auf main

Nach ausdrücklicher Push-Freigabe wurde der inzwischen fortgeschrittene Remote-Stand `1e9b7a6c3` konfliktfrei integriert. Die automatisch zusammengeführte `package.json` enthält sowohl die neuen Main-Testskripte als auch alle Secrets-Prüfgruppen. Auf diesem gemeinsamen Stand bestanden erneut `test:secrets`, `test:secrets:regression`, der Typecheck und `npm run build`. Zusätzlich bestanden die Managed-Runtime-/Auth-Verträge und die beiden neuen Link-Diagnostik-Tests aus Main.

Die autorisierte Browser-Abnahme wurde gegen einen frisch gestarteten Host mit eigener PostgreSQL-/DATA-Kopie wiederholt: tatsächliche Anmeldung, API und Dateispeicherung, alle Bereiche, Berechtigungen, Kategorien, Formular/Text, Konflikte, DE/EN und Mobilansicht. Beide verdeckten Screenshots wurden visuell geprüft. Host und private DB-/ENV-/DATA-Kopie wurden anschließend entfernt; der verwaltete Stack blieb unverändert. Ergebnis und Bilder liegen lokal unter `/tmp/canvas-secrets-a2cd-main-ui-evidence`.

Der GitNexus-Abgleich gegen den aktuellen Remote-Main weist ausschließlich die erwarteten Secrets-Änderungen aus: 85 Dateien, 600 Symbole, drei Abläufe, Risiko MEDIUM. Die separat übernommenen Main-Änderungen haben einen größeren als CRITICAL eingestuften Umfang; sie wurden durch Build/Typecheck, die erneuten Secrets-/Regressionstests und die ergänzenden Integrationsverträge geprüft.

## Bereits bestehende, separat reproduzierte Einschränkung

`npm run test:pi:tools` scheitert an `automation_job_state: delegated worker cannot receive bound automation tools` (erwartet false, erhält true). Der identische Fehler wurde mit dem vollständigen unveränderten Ausgangsstand `634af5ca5` in einem separaten temporären Checkout reproduziert. Diese breite Automationsprüfung wird deshalb nicht als erfolgreich ausgewiesen. Die gezielten Secrets-/PI-/Provider-Verifikationsverträge laufen unabhängig davon.

## Grenzen der Aussagen

Es wurden keine kostenpflichtigen externen Generierungen und keine externen E-Mails versendet. Anbieter-SDKs/HTTP-Endpunkte und OAuth-Refresh sind an den externen Grenzen simuliert; sie beweisen Key-Auswahl und Requestverträge, nicht die Gültigkeit realer Anbieterkeys oder die Erreichbarkeit aller Anbieter.

Der verwaltete lokale Control Plane und der aktuelle Notebook-Host beantworteten ihre Health-Prüfungen mit HTTP 200. Die verwendete Browser-Fixture enthält keine Managed-Service-Instanzkonfiguration; ein echter Managed-Medienauftrag wurde daher nicht behauptet. Der vollständige Managed-Medienvertrag wird gegen einen lokalen HTTP-CP geprüft.

Die Recovery-Prüfung extrahiert DATA mit vorhandenen Fixture-Schlüsseln und liest echte Credentials; der PostgreSQL-Dump wird im Archivtest kontrolliert simuliert. Ein vollständiger Datenbank-/Anwendungs-Restore ist nicht Teil dieses Nachweises. Bestehende vollständige Backups haben für Dateien weiterhin den Vertrag `online_best_effort`, keine über alle Dateien und Datenbank hinweg atomische Momentaufnahme. Master-Keys/Deployment-ENV müssen gesondert verfügbar sein.

Die portable Redaktion gilt für verwaltete Credentialpfade und bekannte Runtime-Konfigurationen. Beliebige Benutzerdateien werden nicht als allgemeiner Secret-Scanner behandelt.

Die Migration startet keinen automatischen vollständigen Datenbank-Backupjob bei einem gewöhnlichen ENV-Lesezugriff. Sie bewahrt die ENV-Importquellen und bestätigt neue Credentials vor der bestehenden MCP-Bereinigung. Für einen Rollout sind vollständiges Backup und separat verfügbare Deployment-Schlüssel weiterhin erforderlich; diese Betriebsentscheidung ersetzt den ursprünglichen Vorschlag einer automatisch vorgeschalteten Gesamtsicherung.
