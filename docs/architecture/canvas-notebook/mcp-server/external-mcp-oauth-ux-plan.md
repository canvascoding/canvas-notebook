# Externe MCP-Verbindungen: OAuth-Reparatur und verständliche Einstellungen

Stand: 1. Oktober 2026. Status: Analyse und Umsetzungsplan; noch keine Produktänderung.

## Verifizierte Ursache und Umsetzung

TODO 1 ist abgeschlossen. Eine lesende Prüfung der laufenden Instanz
`canvas.canvasnotebook.app` bestätigt, dass kein äußerer Master-Key verloren ging.
Im System- und im betroffenen persönlichen Secrets-Bereich liegt jeweils ein
E-Mail-Credential im Adapterformat `enc:v1`. Beide Einträge authentifizieren
erfolgreich mit dem bereits vorhandenen E-Mail-Schlüssel und enthalten gültige
E-Mail-Credentials. Es wurden ausschließlich Prüfstatus, keine Secrets ausgegeben.

Der zentrale ENV-Leser verwechselt diese inneren E-Mail-Envelopes mit seiner
eigenen äußeren Verschlüsselung. Das blockiert auch OAuth/MCP und weitere Leser
desselben Bereichs. Die tatsächliche Reparatur benötigt eine eindeutige äußere
Formatkennung und authentifiziertes, kompatibles Lesen der bestehenden Einträge;
keinen neuen Master-Key und keinen Credential-Reset. Das ist die konkretisierte
Umsetzung von TODO 2. Die Instanz wurde während der Diagnose nicht verändert.

## Ziel

Externe MCP-Verbindungen lassen sich über ein verständliches Formular hinzufügen,
bearbeiten und verbinden. OAuth funktioniert im Browser und in der Electron-App.
Technische Konfiguration erscheint erst nach aktiviertem Entwicklermodus und
bewusstem Öffnen der Entwickleroptionen. Bestehende Secrets und Verbindungen
bleiben bei einem Konfigurationsfehler erhalten.

## Befunde aus dem aktuellen Code

### 1. Der Secrets-Fehler entsteht vor dem erfolgreichen OAuth-Abschluss

`app/lib/integrations/env-config.ts:28` wirft die gemeldete Fehlermeldung, sobald
`readUnifiedEnvState()` einen nicht lesbaren Eintrag meldet. Die Entscheidung gilt
für den gesamten Secrets-Bereich, nicht nur für den angefragten MCP-Eintrag.

`app/lib/secrets/unified-env-store.ts:41` verwendet für die äußere Verschlüsselung
in dieser Reihenfolge `CANVAS_SECRETS_MASTER_KEY`, `INTEGRATIONS_ENV_MASTER_KEY`
und `AGENTS_ENV_MASTER_KEY` aus der Prozessumgebung. `stateFromPhysical()` fängt
Entschlüsselungsfehler ab und setzt `readable: false`. Fehlender Schlüssel,
ungültiges Speicherformat und fehlgeschlagene Authentifizierung werden dadurch
in der übergeordneten Meldung zusammengefasst. Eine fehlgeschlagene
GCM-Authentifizierung allein beweist nicht, ob der Schlüssel falsch ist oder
der verschlüsselte Inhalt verändert wurde.

OAuth berührt sowohl den persönlichen Secrets-Bereich, unter anderem über
`app/lib/mcp/env-runtime.ts:6`, als auch den Systembereich für den inneren
MCP-Verschlüsselungsschlüssel. Der Screenshot und die Fehlermeldung bestimmen
nicht, welcher Bereich in der betroffenen Installation scheitert. Das muss am
laufenden Backend geprüft werden; Produktionskonfiguration und Logs wurden in
dieser Analyse nicht untersucht.

### 2. Zwei Verschlüsselungsebenen haben unterschiedliche Schlüsselquellen

`app/lib/mcp/secret-store.ts:80` nutzt für MCP-Credentials zunächst
`INTEGRATIONS_ENV_MASTER_KEY`, ansonsten `MCP_CREDENTIAL_KEY` aus dem zentralen
System-Secrets-Speicher. `CANVAS_SECRETS_MASTER_KEY` allein provisioniert diesen
inneren Schlüssel derzeit nicht.

Zusätzlich blendet `app/lib/secrets/env-registry.ts:24` `MCP_CREDENTIAL_KEY` und
`MCP_CREDENTIAL_PREVIOUS_KEYS` aus dem Secrets-Editor aus und reserviert sie für
interne Lebenszyklusadapter. Die Fehlermeldung verweist aber noch auf
`/settings?tab=integrations`. Auch `docs/security/mcp-connection-storage.md`
beschreibt einen veralteten Dateipfad und die Einrichtung über diese Ansicht.
Damit fehlt im aktuellen UI ein nachvollziehbarer Weg, die fehlende innere
Verschlüsselung einzurichten.

### 3. Die Popup-Strategie passt nicht zur Electron-App

`runMcpServerAction()` in
`app/components/settings/IntegrationsSettingsClient.tsx:2331` öffnet vor dem
API-Aufruf `window.open('about:blank', '_blank')`. Bei einem fehlenden Fenster
bricht die Funktion mit der Popup-Meldung ab.

`setupNavigationGuards()` in `electron/main/main.mjs:187` lehnt sämtliche neuen
Fenster ab. `about:blank` wird dort auch nicht extern geöffnet. Die separate
Erlaubnis für `about:blank` in `isAllowedNavigation()` betrifft Navigation im
bestehenden Fenster und repariert diesen Konflikt nicht.

Die Preload-Bridge stellt `canvasDesktop.openExternal()` bereit. Der zugehörige
IPC-Handler in `electron/main/main.mjs:317` akzeptiert jedoch nur Nachrichten
vom Setup-Bildschirm. Die angemeldete Canvas-Seite kann ihn aktuell nicht nutzen.

Die Electron-Dokumentation bestätigt die Fenstersteuerung durch
[`setWindowOpenHandler`](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwindowopenhandlerhandler)
und das Öffnen des Standardbrowsers über
[`shell.openExternal`](https://www.electronjs.org/docs/latest/api/shell#shellopenexternalurl-options).
Für native OAuth-Anmeldungen empfiehlt
[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252#section-4.1) einen externen Browser.
Canvas bleibt dabei der serverseitige OAuth-Client; die Electron-App transportiert
keine Provider-Tokens.

### 4. Externes Öffnen allein reicht nicht

`app/api/mcp/oauth/callback/route.ts:34` verlangt aktuell über
`requireMcpRequestActor()` eine angemeldete Canvas-Session des zurückkehrenden
Browsers. Ein im Systembrowser angemeldeter anderer Canvas-Nutzer wäre ebenfalls
keine geeignete Autorität für den in Electron begonnenen Vorgang.

Die Electron-Session kann nicht als vorhandene Systembrowser-Session vorausgesetzt
werden. Der Desktop-Ablauf benötigt deshalb eine Rückgabe, die an den ursprünglich
angemeldeten Nutzer und dessen Verbindung gebunden ist.

Das UI pollt zurzeit ungefähr 89 Sekunden, obwohl der OAuth-State zehn Minuten
gültig ist. Nach Ende des Pollings wird kein klarer Ablauf- oder Abbruchstatus
angezeigt. `getMcpOAuthStatus()` bildet Secrets-Fehler außerdem als allgemeines
`unavailable` ab; die Oberfläche erklärt die Ursache nicht gezielt.

### 5. Entwicklerdetails sind an Bearbeitungsrechte gekoppelt

`McpConfigCard()` zeigt bei `canManageConfiguration` Dateiname, JSON-Format,
Unix-Dateirechte und den aufklappbaren Raw-Editor. Redirect-URI, Transport,
Cache-Zähler und mehrere technische Statusanzeigen stehen direkt in der Liste.
Ein eigener Entwicklermodus wird dieser Komponente nicht übergeben.

Der normale Bearbeitungsdialog existiert bereits. Er zeigt allerdings unmittelbar
Command, Argumente, ENV-Namen und Header; neue Verbindungen beginnen als `stdio`.
Für einen gewöhnlichen externen HTTP-Server ist dieser Einstieg unnötig komplex.

## Umsetzung in abgeschlossenen, aufeinanderfolgenden Schritten

Jeder Schritt endet mit seinen Prüfungen und einem eigenen Commit. Der nächste
Schritt beginnt erst nach Abschluss des vorherigen.

### TODO 1 — Betroffene Installation diagnostizieren und Daten wieder lesbar machen

- Im tatsächlich laufenden Backend prüfen, welcher Secrets-Bereich betroffen ist
  und welche Schlüsselquelle aktiv ist. Nur Status und Quellenbezeichnung ausgeben,
  keine Schlüsselwerte, Token-Inhalte oder vollständigen ENV-Dateien.
- Aktuelle Deployment-Konfiguration mit der Konfiguration zum Zeitpunkt der
  Verschlüsselung bzw. einem geeigneten Backup vergleichen. Besonders prüfen,
  ob eine neue kanonische Variable einen bisherigen Legacy-Schlüssel überschattet
  oder ein Update einen Runtime-Parameter nicht mehr übergibt.
- Bei vorhandenen verschlüsselten Daten den ursprünglichen Schlüssel wieder in
  der geschützten Deployment-Konfiguration bereitstellen und den Dienst mit dieser
  Konfiguration neu laden. Keinen neuen Schlüssel über bestehende Daten legen.
- Erst nach erfolgreicher Entschlüsselung den inneren MCP-Schlüssel prüfen.
  Sind Schlüssel oder Daten nicht wiederherstellbar, betroffene Credentials
  ausdrücklich als nicht wiederherstellbar behandeln und eine gezielte erneute
  Anmeldung planen; keinen automatischen Reset aller Secrets durchführen.

Abnahme: Die bisher betroffenen Einträge sind lesbar und bestehende Verbindungen
bleiben nutzbar. Die genaue Produktionsursache ist dokumentiert. Benötigte
Deployment-Zugriffe werden vor Ausführung dieses Schritts festgestellt.

### TODO 2 — Verschlüsselungsbereitschaft und konkrete Fehler im Produkt abbilden

- Einen gemeinsamen, lesenden Diagnosevertrag für Secrets/MCP ergänzen:
  `ready`, `master_key_missing`, `decryption_failed`, `invalid_secret_format`
  und `mcp_credential_key_missing`. Keine falsche Unterscheidung zwischen einem
  falschen Schlüssel und manipuliertem GCM-Inhalt versprechen.
- Vor OAuth-Discovery bzw. Registrierung die für diesen Vorgang benötigte
  Speicher- und Verschlüsselungsbereitschaft prüfen. Probleme als strukturierte
  API-Codes zurückgeben, damit UI und OAuth-Status dieselbe Erklärung verwenden.
- Normalen Nutzern anzeigen: „Die sichere Speicherung dieser Verbindung ist
  noch nicht eingerichtet. Bitte kontaktiere die Administration.“ Administratoren
  erhalten Diagnose und einen Link zu `/settings?tab=secrets`.
- Dort klar zwischen dem Master-Key der Deployment-Konfiguration und dem intern
  verwalteten MCP-Schlüssel unterscheiden. Den äußeren Master-Key nicht über den
  von ihm verschlüsselten ENV-Editor speichern.
- Eine interne, gesperrte und idempotente Provisionierung des MCP-Schlüssels
  ergänzen. Automatisches Erzeugen ist nur bei nachweislich erstmaliger Einrichtung
  ohne bestehende MCP-Ciphertexte zulässig. Fehlende Schlüssel bei bestehenden
  Envelopes benötigen Wiederherstellung. Vorhandene Schlüsselpräzedenz, Key-IDs,
  AAD-Bindungen und vorherige Schlüssel bleiben kompatibel.
- Veraltete Fehlermeldungen, Einrichtungshinweise und Pfade korrigieren.
  Deployment-Templates auf dauerhafte Schlüsselübergabe prüfen; Änderungen an
  externem Control-Plane-Provisioning als separate Abhängigkeit dokumentieren.

Abnahme: Fehlender äußerer Schlüssel, nicht authentifizierbare Daten und fehlender
innerer Schlüssel haben passende Handlungswege. Fehler führen nie zu einem
Secrets-Overwrite oder einem unverschlüsselten OAuth-Fallback. Ein Neustart
ändert keine bestehenden Schlüssel.

### TODO 3 — OAuth in Electron einschließlich Rückgabe reparieren

- Einen gemeinsamen Client-Adapter für OAuth-Starts einführen. Im normalen Browser
  bleibt das während des Klicks vorab geöffnete Fenster möglich. In Electron wird
  nach erfolgreichem, authentifiziertem Start die validierte Authorization-URL über
  eine schmale Preload-/IPC-Funktion im Systembrowser geöffnet.
- IPC nur aus dem Hauptfenster der konfigurierten Canvas-Origin zulassen;
  fremde Frames und fremde Origins ablehnen. URL-Typ, HTTPS in Produktion,
  eingebettete Zugangsdaten und unerlaubte Schemes auch im Main-Prozess prüfen.
  Die URL gegen die serverseitig ermittelte OAuth-Zieladresse prüfen, nicht gegen
  eine starre Liste weniger Provider. Die bestehende Sandbox bleibt erhalten.
- Für Desktop-Vorgänge einen kurzlebigen, serverseitigen Transaktionsdatensatz
  anlegen, gebunden an Nutzer, Connection-ID, Organisation, PKCE, Issuer,
  Konfigurationsversion und Lifecycle-Generation. Die öffentliche Callback-Route
  findet diesen Vorgang über einen zufälligen, einmal verwendbaren State;
  Nutzeridentität kommt niemals aus einer frei übergebenen User-ID.
- Bevorzugter Rückgabeweg: Der Desktop-Callback validiert die Transaktion und
  hinterlegt das Provider-Ergebnis kurzzeitig geschützt. Der ursprünglich
  angemeldete Electron-Client schließt den Vorgang anschließend über einen
  authentifizierten Endpunkt ab. Erst dort erfolgen die erneute Rechteprüfung,
  der Token-Austausch und die dauerhafte Speicherung. Bestehende Browser-Flows
  behalten ihre Session-Bindung. Die Änderung ist kein pauschales Entfernen der
  Session-Prüfung aus dem bestehenden Callback.
- Einen anderen im Systembrowser angemeldeten Canvas-Nutzer nicht als Besitzer
  übernehmen. Ungültige/abgelaufene States, Wiederholungen, deaktivierte/gelöschte
  Verbindungen, entzogene Mitgliedschaft und geänderte Konfiguration abweisen.
- Status für `waiting`, `completed`, `cancelled`, `expired` und `failed` bereitstellen.
  Polling an die Gültigkeit der Transaktion anpassen, beim Verlassen aufräumen
  und bei Rückkehr in die App fortsetzen. Kein Erfolg aufgrund eines alten Tokens.
- Browser zeigt nach Rückgabe eine verständliche Abschlussseite; Electron
  aktualisiert die Verbindung automatisch. Für diesen ersten Fix ist kein
  neuer registrierter App-URL-Scheme erforderlich.

Abnahme: Anmeldung funktioniert bei ausschließlich in Electron angemeldetem
Canvas-Nutzer und ohne Canvas-Cookies im Systembrowser. Zwei Canvas-Nutzer,
abgelehnte Zustimmung, mehr als 90 Sekunden Login-Zeit und verspätete Callbacks
sind gezielt geprüft.

### TODO 4 — Externe MCP-Oberfläche vereinfachen

- Standardansicht: Name/Icon, verständlicher Verbindungsstatus und eine passende
  Hauptaktion („Verbinden“, „Erneut anmelden“ oder „Verbindung prüfen“).
  Bearbeiten, Umbenennen, Teilen und Entfernen kommen in ein Aktionsmenü.
  Aktivierung bleibt zugänglich und ist eindeutig beschriftet.
- Technische Dateiangaben, Unix-Rechte, Transportbezeichnungen, Redirect-URI,
  Cache-Interna und Diagnosen aus der Standardansicht entfernen. Tools werden
  verständlich als verfügbare Funktionen dargestellt; ein noch nicht geladener
  Tool-Cache wird nicht als Verbindungsfehler ausgegeben.
- Bearbeitung bleibt auch ohne Entwicklermodus möglich: Name, Server-Adresse,
  Anmeldung und bei Bedarf API-Token. Remote-HTTP wird der Standard für neue
  externe Verbindungen. Command/Args, ENV-Namen, eigene Header und manuelle
  OAuth-Endpunkte liegen in den Entwickleroptionen.
- Explizite Benutzerpräferenz „Entwicklermodus“ mit Standardwert `false` ergänzen.
  Dieser Modus ist eine Darstellungspräferenz und gewährt keine zusätzlichen
  Rechte. Raw-Bearbeitung benötigt weiterhin die bestehenden Verwaltungsrechte.
- Nur im Entwicklermodus erscheint „Entwickleroptionen“. Darin ist „Raw mcp.json“
  nochmals standardmäßig geschlossen; CodeEditor und Diagnosen werden erst beim
  Öffnen gerendert. Dateiname/Format/Permissions erscheinen innerhalb dieses
  Bereichs. Der physische Speicher wird nicht wegen der UI-Beschriftung umbenannt.
- Bestehende Secret-Referenzen, Connection-Identitäten und unbekannte JSON-Felder
  beim Formularspeichern erhalten. Secrets bleiben im zentralen Service.
- Deutsch/Englisch, Tastaturbedienung, schmale Fenster und eindeutige Fehleraktionen
  berücksichtigen. Entwicklermodus konsistent an den Secrets-Editor weiterreichen,
  dessen derzeitiger Standardwert `true` nicht als Benutzerentscheidung gelten darf.

Abnahme: Ohne Entwicklermodus sind keinerlei Raw-/Datei-/Format-/Permissions-
Hinweise sichtbar. Alle normalen Verbindungsschritte sind dennoch ausführbar.
Entwickleroptionen starten geschlossen und enthalten keine Provider-Tokens.

### TODO 5 — Regression, UI-Abnahme und Übergabe

- Tests für tatsächliches Verhalten ergänzen: Secrets nicht überschreiben,
  Schlüsselquellen und Migration, sichere erstmalige Provisionierung, IPC-Sender,
  externe URL-Validierung, sessionunabhängiger Desktop-Callback mit authentifiziertem
  Abschluss sowie die genannten OAuth-Abbruch- und Rechtefälle.
- Passende vorhandene Suites ausführen: `test:secrets:store`,
  `test:secrets:mcp`, `test:mcp:storage`, `test:mcp:oauth`,
  `test:mcp:oauth-lifecycle`, `test:electron` sowie betroffene API-/Secrets-UI-Tests.
  Breitere Secrets-Regression ist erforderlich, wenn der gemeinsame Leser oder
  das Verschlüsselungsformat verändert werden.
- `npm run build` abschließen. UI im Browser und in der echten Electron-App
  prüfen; Rollen, Entwicklermodus, HTTP-Bearbeitung und OAuth einbeziehen.
  Playwright oder vergleichbare Browserautomation erst nach ausdrücklicher
  Freigabe gemäß AGENTS.md verwenden. Das ist eine geplante Abnahme, keine
  bereits durchgeführte Browserprüfung.
- Für ein lokales Dev-Setup `canvas-local-team-seat-dev` verwenden. Container
  nur auf ausdrücklichen Auftrag bauen, zuvor den Build prüfen und immer nur
  eine frisch aktualisierte Testumgebung betreiben.
- Vor jedem Implementierungscommit GitNexus-Impact für geänderte Symbole und
  `detect_changes()` ausführen. Abschließende Screenshots und Prüfschritte für
  einen späteren PR festhalten.

## Änderungsrisiko und Grenzen dieser Analyse

GitNexus meldet für `readScopedEnvState()` **CRITICAL**: 28 direkte Aufrufer,
140 erreichbare Symbole bis Tiefe drei und 15 Module, darunter E-Mail, Composio,
Agent-Runtime und MCP. Für `configuredKeyValues()` und `setupNavigationGuards()`
ist der graphbasierte Radius kleiner. Ihre Schlüssel- und OAuth-Verantwortung
erfordert dennoch gezielte Regression.

Der verwendete Index gehört zum Hauptcheckout bei Commit `ce3a9595d4`; für diesen
Worktree existiert kein eigener Index. Die geprüften Secrets-/OAuth-/Electron-
Dateien sind gegenüber diesem Commit unverändert. Der Integrations-Client hat
eine kleine Änderung außerhalb der untersuchten Abläufe. GitNexus lieferte für
diese Abfragen keine Prozesszuordnung; diese fehlende Zuordnung belegt keinen
fehlenden Laufzeiteinfluss. Vor der Implementierung den Worktree aktuell indexieren.

Die vorliegende Arbeit prüft den Quellcode und den beigefügten Screenshot.
Es wurden keine Produktdateien, Deployment-Secrets oder laufenden Verbindungen
verändert, keine Container gebaut und keine automatisierten UI-Tests ausgeführt.
