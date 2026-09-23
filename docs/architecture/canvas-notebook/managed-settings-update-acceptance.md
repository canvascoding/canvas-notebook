# Managed Settings Updates: Laufzeitabnahme

Datum: 2026-09-22

Ergebnis: **Lokale Managed-Ende-zu-Ende-Abnahme bestanden**. Drei Codefehler
(CSP-Origin, Digest-Persistenz, explizite Vector-Policy) und eine inkonsistente
lokale Domain-Fixture wurden waehrend der Abnahme korrigiert. Erfolgs- und
Rollbackpfad danach mit echten Browser-, API-, Agent- und CLI-Aufrufen belegt.

Der Nutzer hat die zuvor offene Container-/Browser-/VM-Abnahme ausdruecklich
beauftragt. Getestet werden die Branches `fix/managed-settings-updates` in Notebook
und Control Plane. Produktion und veroeffentlichte Releases bleiben unberuehrt.

## QA-Inventar

| Pruefung | Aktion / erwartetes Ergebnis | Nachweis |
| --- | --- | --- |
| Aktueller Build | Host-Build vor Docker-Build; genau eine aktive Notebook-Testinstanz | Buildlog und Container-/Commit-Identitaet |
| Anmeldung | Bootstrap-Admin meldet sich ueber echte Login-Oberflaeche an | Browserzustand ohne Credentials |
| Update-Verfuegbarkeit | Settings zeigt verwaltete Instanz, Version und konkretes Release | Screenshot und API-Antwort ohne Token |
| Release-Kanal | Stable in der UI; Beta ueber API gesperrt (keine Kanalauswahl in dieser UI) | HTTP-Ergebnis |
| Update-Bestaetigung | Dialog abbrechen, erneut oeffnen und bestaetigen | Keine Operation nach Abbruch; persistente Operation nach Bestaetigung |
| Paralleler Start | Zweiten Start waehrend laufender Operation ablehnen | HTTP-Ergebnis und eine persistente Operation |
| Host-Ausfuehrung | CP sendet Command an VM-Agent; Host-CLI wechselt Container | Journal, Agent-/CLI-Ereignisse, Image-ID |
| Direkter Status | Bei gestoppter App bleibt Status ueber enges Ticket lesbar | Browser-Network-Metadaten und sichtbarer Fortschritt |
| Reload / Reconnect | Seite waehrend Update neu laden; nach Wiederkehr Status rekonstruieren | Operation-ID bleibt gleich, Abschluss sichtbar |
| Abschluss | Erfolg erst nach zentraler Zielversionspruefung | CP-Run, laufende Version, Screenshot |
| Rollback | Kontrollierter Fehler; vorheriges gesundes Image wiederhergestellt | Persistierter Image-Nachweis und UI-Status |
| Worker offline | Kein ausfuehrbarer Update-Button ohne Worker | Readiness und UI-Hinweis |
| Agent offline | Kein scheinbar ausfuehrbarer Auftrag ohne Host-Agent | Readiness und UI-Hinweis |
| Abgelaufener Statuszugang | Ticket wird verworfen/erneuert; kein endloses Reconnect | HTTP-Status und UI-Recovery |
| Abgelaufene Sitzung | Dauerhafter Authfehler zeigt Fehler mit Retry/Zurueck | Browserzustand |
| Darstellung | Desktop und schmaler Viewport; Dialog, Status und Fehler lesbar | Screenshots und kein horizontaler Ueberlauf |

## Durchfuehrung

### Vorbereitung und reale Befunde

- Verwalteter Stack gemaess Skill vollstaendig aus beiden Branches neu gebaut.
  Host-Builds liefen vor den Docker-Builds erfolgreich. Alle vier Dienste gesund;
  PostgreSQL 18.4 und pgvector 0.8.3; beide Benutzer-/Workspace-/Ollama-Fixtures
  durch Skill bestaetigt. Browser-Login des Bootstrap-Admins erfolgreich.
- Der normale Notebook-Container ohne Instanz-Token zeigt korrekt den manuellen
  Modus. Check-again und Details ein-/ausklappen geprueft. Screenshot
  [01-manual-container.png](acceptance-evidence/01-manual-container.png).
- Danach diesen Notebook-Container gestoppt und ausschliesslich die vorhandene
  OrbStack-VM `canvas-managed-e2e` fuer die verwaltete App verwendet. CP/API/UI und
  deren PostgreSQL bleiben im einen Skill-Stack. Die VM verwendet ihren bereits
  vorhandenen PostgreSQL-Container; keine neue Testumgebung wurde gestartet.
- Die alte VM-Registrierung gehoerte nicht zur aktuellen CP-Datenbank. VM ueber
  normale lokale APIs neu registriert: `48a75567-8666-4554-a213-66778e1c13ef`.
  Neuer Agent 2.3.13 mit Bundle-SHA
  `102719f63bba7e9b7ad78cd3c6069b3921d007a6059d00a0f3b01655a479e731`
  und CLI 2026.9.22.3 mit echten Eventstream-Faehigkeiten installiert.
- Quota-Befund: VM-Limit 40 GiB war erreicht, obwohl `df` 345 GiB global frei
  anzeigte. Das verursachte ENOSPC bei Registry und CLI-Sperrdatei. Ausschliesslich
  `machine.canvas-managed-e2e.disk_bytes` auf 120 GiB erhoeht; kein Loeschen von
  Nutzer-/Datenbankdaten. Nachher Schreibprobe und beide Image-Pushes erfolgreich.
- Private Sicherungen fuer bisherige Config/CLI/Agent liegen auf der VM unter
  `/var/tmp/canvas-managed-acceptance/backups`; bisherige Skill-Envdateien unter
  `~/.local/state/canvas-local-team-seat/managed-update-acceptance-before`.
- Lokale Registry ist ein nativer Prozess auf VM-Loopback `127.0.0.1:5000`.
  Neues App-Basisimage und Testvarianten wurden nur lokal uebertragen/gepusht.
  Die Varianten verwenden dieselbe echte Version 2026.9.22.3 als Rebuild mit
  unterschiedlichen Digests. Der externe CLI-Download ist bewusst nicht Teil
  dieser Abnahme: die exakt passende CLI ist regulär lokal vorinstalliert.
- Browser erreicht VM-App ueber SSH-Tunnel `127.0.0.1:3100 -> VM:3456`.
  `host.orb.internal` wird ausschliesslich im isolierten Playwright-Browser mit
  `--host-resolver-rules` auf Mac-Loopback aufgeloest. Lokales HTTP und exakte CORS-
  Origins sind explizit konfiguriert. Keine produktiven TLS-/URL-Regeln gelockert.
- CP-Config-Apply und PostgreSQL-Konfigurationsabgleich abgeschlossen;
  `config_apply_completed` und `env_sync_completed` persistiert, App-Health200.
  Bestehende VM-Daten bleiben erhalten. Persoenlicher Testmodus und lokaler
  Lizenzschluessel sind mit dem neuen CP abgestimmt. Bootstrap-Admin wurde mit
  den privaten Skill-Credentials angelegt. `ONBOARDING=false` ist fuer diese
  lokale Update-Abnahme aktiv; keine Modellgenerierung erforderlich.
- Signierter lokaler Release-Webhook akzeptiert das Erfolgsimage mit echtem
  Image-Digest, Commit und Archiv-Pruefsumme. Release-ID
  `f9c73c6a-7304-4781-90e0-2505367b9824`. Automatische Rollouts deaktiviert.
- Instanzgebundene Availability liefert HTTP200, ready=false und
  `managed_worker_disabled`. Startversuch liefert HTTP409; Run-Anzahl bleibt0.

### Erster realer Lauf: zwei Abnahmefehler gefunden

- Worker deaktiviert: UI zeigt gesperrten Start und konkreten Hinweis; nach
  aktiviertem Worker und gestopptem Agent entsprechend `managed_host_unavailable`.
  Siehe [02](acceptance-evidence/02-managed-worker-disabled.png) und
  [03](acceptance-evidence/03-managed-agent-offline.png).
- Beta wird per API mit `managed_channel_unsupported` abgelehnt. Die UI selbst
  verwendet Stable und besitzt keinen Kanalumschalter.
- Bestaetigungsdialog abgebrochen: kein Update-Run angelegt. Danach ueber echte
  UI bestaetigt: HTTP202, Operation `692f4a98-7d82-423a-8a19-3fead610a592`.
  Ein gleichzeitiger zweiter Start wurde mit HTTP409 `managed_update_conflict`
  abgewiesen. [Dialog](acceptance-evidence/04-confirm-update.png).
- Die Host-CLI zog den unveraenderlich adressierten lokalen Release-Digest,
  ersetzte den Container und bestaetigte Health sowie laufende Image-ID.
  Anschliessend scheiterte jedoch der Agent-Postflight mit
  `Control Plane config postflight failed`. Die zentrale Operation meldete
  korrekt `failed`, obwohl die CLI ihren Teil erfolgreich abgeschlossen hatte.
  Kein falscher Gesamterfolg. App weiterhin gesund und Zielimage aktiv.
- Browser erhielt HTTP201 mit engem Status-Ticket, aber `connect-src` der App-CSP
  erlaubte die konfigurierte CP-Origin nicht. Dadurch blockierte Chromium alle
  direkten Statusabrufe; waehrend des Neustarts blieb nur fehlgeschlagenes
  App-Polling. Dies ist ein echter Integrationsfehler, kein bestandener Test.
- Fehleranzeige mit technischen Details bei 390x844 pruefbar und ohne
  horizontalen Ueberlauf (Dokumentbreite 390). [Desktop](acceptance-evidence/05-first-run-failed.png),
  [schmaler Viewport](acceptance-evidence/06-failure-mobile.png).

Beide Fehler werden vor Wiederholung der Laufzeitabnahme korrigiert.

Ursachen und Korrekturen:

- CSP: Commit `646bcb18a` verwendet fuer Backend und Browser-CSP dieselbe reine
  Managed-URL-Validierung. Nur die konkrete CP-Origin wird zusaetzlich erlaubt;
  lokale HTTP-Ausnahme bleibt explizit. 28 Konfigurationsfaelle pruefen die
  tatsaechlichen Proxy-Header, einschliesslich unzulaessiger Wildcard-Hosts.
- Postflight: Nach dem erfolgreichen Wechsel blieb in der CLI-Konfiguration
  der alte mutable Tag `canvas-notebook:local-prod`. Die Image-Bereinigung
  entfernte diesen vom Container nicht direkt referenzierten Alias. Der
  folgende Config-Apply wollte den jetzt fehlenden Tag von Docker Hub laden
  und scheiterte. Ein Compose-Dry-Run bestaetigte genau diesen Pfad. Fuer
  verwaltete Updates muss der installierte Digest dauerhaft gespeichert werden.
  Der zuvor beobachtete Vector-Schalterunterschied loeste den Abgleich aus,
  war aber nicht die Ursache des gescheiterten Image-Pulls.
- CLI-Fix: Commit `6049e7d6c` persistiert den Digest fuer Managed-/Eventstream-
  Updates und erhaelt explizite Vector-Werte. Beide Regressionen zuerst rot
  nachgewiesen, danach Portable-Suite und CLI-TypeScript-Build gruen. Die
  autorisierte Wiederherstellung des fehlenden Alias erlaubte anschliessend
  die normale CLI-Journal-Recovery; kein manuelles Loeschen von Recovery-Daten.
  Native CLI erneut ueber den Installer installiert, deployed JavaScript mit
  Build verglichen. Archiv-SHA256:
  `7e47670ae2216e3e9eb12559243b0aadd124b06852e4d1355a15b299f41bdae2`.
- Nach CSP-Fix Host-Produktionsbuild und anschliessender Docker-Build erneut
  erfolgreich. Der Docker-Notebook-Dienst bleibt gestoppt, solange die VM-App
  fuer diese Abnahme aktiv ist.

### Status-Ticket und zentrale Wahrheitsquelle

Zehn echte HTTP-Pruefungen gegen den laufenden Control Plane bestanden:
gueltiger Snapshot 200; abgelaufenes, manipuliertes, fehlendes sowie einer
anderen Operation zugeordnetes Ticket 401; korrekt signiertes Ticket fuer
fremde VM 404; fremde Origin 403; erlaubter Preflight 204, fremder 403;
Cursor 35 liefert ausschliesslich Event 36. Fehler sind fuer die exakt erlaubte
Origin per CORS lesbar, ohne Credential-Freigabe. Snapshots sind `no-store`.
Abgelaufene/fremde Tickets wurden mit dem privaten lokalen Signierschluessel als
Testfixtures erzeugt, ohne Token zu protokollieren oder zu speichern.
[Maschinenlesbarer Nachweis](acceptance-evidence/status-ticket-tests.json).

Unabhaengige Datenbankpruefung des ersten Laufs: Run und Command fehlgeschlagen,
Exitcode 1, kein zentraler Heartbeat-Erfolg und kein Rollback-Ereignis. Die
weiterhin gesunde VM mit Zielversion ueberschreibt den fehlgeschlagenen
Postflight nicht. API meldet weiterhin `failed` und `rolledBack: false`.
[Journal](acceptance-evidence/first-update-events.json),
[Browser-Netzwerk ohne Header/Tickets](acceptance-evidence/first-update-network.json).

### Abgelaufene Sitzung

In einem separaten Browserkontext wurde eine zuvor authentifizierte Settings-
Seite geoeffnet, dann wurden ihre Cookies entfernt und die echte vorherige
Operation als wiederherzustellende Operation hinterlegt. Beim Oeffnen der
Update-Seite antwortete die echte App mit HTTP401. Die UI zeigte
`Update status unavailable / Unauthorized` mit `Try again` und
`Return to update overview`, ohne endlosen Reconnect. Retry erhielt erneut 401;
Zurueck entfernte die gespeicherte Operation. Kein HTTP-Mocking.
[Screenshot](acceptance-evidence/07-expired-session.png).

### Wiederholung mit korrigierten Artefakten

App-Image aus Commit `646bcb18a`, separat gebaute Host-CLI aus `6049e7d6c`.
Der CLI-Folgecommit aendert ausschliesslich Host-Code, keine App-Quelldateien.
Identische RootFS-Layer und Runtime-Konfiguration nach Transport in die VM
geprueft; tatsaechliche Paketversion bleibt 2026.9.22.3.

Die zweite Operation `78631e5b-58a3-4998-bce1-b3d976f7fb3f` bestaetigte den
behobenen direkten Statuskanal: App-Aufrufe schlugen waehrend des Neustarts fehl,
CP-Snapshots lieferten weiter 200. Ein echter Seiten-Reload waehrend der laufenden
Vorbereitung nahm dieselbe Operation aus dem Browser-Speicher wieder auf.

Der Lauf fand danach eine inkonsistente lokale Fixture: CP erwartete eine leere
Domain, waehrend die CLI `domain` gemaess `ensureBaseUrl` aus
`BASE_URL=http://127.0.0.1:3100` als `127.0.0.1` ableitet. Die strenge Pruefung
brach mit `Notebook domain does not match required update postflight config` ab.
Soll-Domain ueber regulaere CP-API auf `127.0.0.1` korrigiert; Config-Apply
`config_apply_ecf401a2-534c-433d-b35a-94ddfbef6b30` abgeschlossen, Env-Sync
idempotent uebersprungen. Caddy behandelt IP-Adressen als nicht oeffentliche
Domain und aktiviert dafuer kein TLS. Keine weitere Codekorrektur notwendig.
[Journal](acceptance-evidence/second-update-events.json),
[Netzwerk](acceptance-evidence/second-update-network.json).

### Erfolgreiches Update und Ticket-Recovery

Operation `38fb8717-5317-46b7-8a29-e4d09eb5a72c`, Release
`94bcc83a-2acc-4dd8-9202-4e30ad848656`, 19:58:45 bis 19:59:45 UTC:
**succeeded/completed**, 39 persistente Ereignisse. Ziel-Digest und tatsaechliche
laufende Image-ID stimmen ueberein:
`sha256:694cd09cac5df9ab28cb2a0f57b7c1a448d7f010d6b69921f43c30f051adbaa6`.
Die App zeigt `Update complete`, laedt anschliessend automatisch neu und meldet
`Canvas is up to date`. CLI-Konfiguration und CP-Updateziel stimmen ueberein.

Im Hauptbrowser 31 erfolgreiche direkte CP-Abfragen bei 25 fehlgeschlagenen
App-Abfragen aufgezeichnet. Ein zweiter Browserkontext erhielt fuer dieselbe
Operation ein korrekt signiertes, aber bereits abgelaufenes Test-Ticket mit
absichtlich veralteter lokal gespeicherter Ablauf-Metadatei. Die echte CP-Antwort
401 wurde genau einmal verarbeitet; das Ticket verschwand aus Session Storage.
Danach authentifizierter Fallback; nach 60 Sekunden erfolgreicher neuer
Statuszugang 201 und direkter Snapshot 200. Keine HTTP-Mocks und keine Secrets
in den Nachweisen.

- [Erfolg im Browser](acceptance-evidence/10-update-success.png)
- [Status waehrend Neustart](acceptance-evidence/11-fixed-update-downtime.png)
- [Uebersicht nach automatischem Reload](acceptance-evidence/12-after-success.png)
- [Vollstaendiges Journal](acceptance-evidence/successful-update-events.json)
- [Browser-Netzwerk](acceptance-evidence/successful-update-network.json)
- [Ticket-Recovery im Browser](acceptance-evidence/expired-ticket-browser-network.json)

### Kontrollierter Rollback

Operation `dd603edf-80ae-47a5-8b14-58eb0a17573b`, Release
`45fe8dc2-8892-4c60-b35a-adafc2daab0c`, 20:00:52 bis 20:05:01 UTC. Die lokale
Fehlervariante verwendet dasselbe App-Dateisystem, startet aber absichtlich
`sleep 900` statt des App-Servers. Ihr Digest:
`sha256:5adf6e1524794cee12ad8ce349ebdbb328de21116e386bf4f8ff44cc7344f5c3`.

Nach dem regulaeren Health-Timeout wurde das vorige Image automatisch
wiederhergestellt. Health200 und tatsaechliche laufende Image-ID erneut694cd09c….
Erst danach persistierte die CLI `rollbackImageVerified: true`. Der CP behielt
den fehlgeschlagenen Updateversuch als DB-Status `failed`/Command-Exit1, waehrend
die oeffentliche Operation korrekt `rolled_back`, `rolledBack: true` meldet.
Das bedeutet wiederhergestellter Altstand, keinen erfolgreichen Ziel-Release.

Ein unabhaengiger Collector verglich DB-Run, Command, Eventjournal, Ticket-API,
frischen gesunden Heartbeat und tatsaechlichen Host-RepoDigest. Alle Nachweise
passen zusammen; weder Versionsgleichheit allein noch ein gesundes Heartbeat
wurden als ausreichender Rollback-Nachweis akzeptiert.

- [Unabhaengige zentrale Verifikation](acceptance-evidence/central-verification.json)
- [Rollback im Browser](acceptance-evidence/16-verified-rollback.png)
- [Technische Details mit Image-Nachweis](acceptance-evidence/17-rollback-details.png)
- [Vollstaendiges Rollback-Journal](acceptance-evidence/rollback-update-events.json)
- [Status waehrend des Ausfalls](acceptance-evidence/rollback-update-network.json)
- [Laufender Update-Status bei 390px](acceptance-evidence/14-update-mobile.png)
- [Wiederherstellung bei 390px](acceptance-evidence/15-rollback-restoring-mobile.png)

Desktop 1440x1000 und schmaler Viewport 390x844 visuell geprueft. Kein horizontaler
Ueberlauf; technische Details und Zurueck-Aktion funktionieren.

## Abschlusszustand und Grenzen

- Gesundes Release694cd09c… erneut als aktuell eingetragen, Release-ID
  `b3890846-d740-4656-b9ce-12c4fd2ab3bb`. Defektes Test-Image ist nicht mehr die
  aktuelle Update-Auswahl. API: `updateAvailable: false`,
  `managed_already_current`; UI: `Canvas is up to date`.
  [Finale API-Antwort](acceptance-evidence/final-availability.json),
  [finale UI](acceptance-evidence/18-final-healthy.png).
- Genau eine laufende Notebook-Testinstanz: VM `canvas-managed-e2e`.
  App unter `http://127.0.0.1:3100` ueber den Test-SSH-Tunnel. Der normale
  `canvas-local-prod-notebook` bleibt gestoppt. CP/API4001, CP/UI4004 und
  verwalteter PostgreSQL55433 laufen gesund im bestehenden Skill-Stack.
  Vorhandener VM-PostgreSQL bleibt erhalten. App-Health: alle Kernpruefungen ok,
  PostgreSQL verbunden, keine DB-Blocker oder Warnungen.
- Native lokale Registry und SSH-Tunnel bleiben fuer die Nachpruefung aktiv.
  Private Sicherungen/Fixtures bleiben ausserhalb des Git-Repositories. VM-Quota
  bleibt 120GiB; fuer diesen Test wurde keine Nutzerdatenbereinigung ausgefuehrt.
  Der grosse temporaere Image-Transport-Tar wurde nach Abschluss entfernt.
- Nach CLI-Fix zusaetzlich `test:cli:update-rollback`, `test:cli:update` und
  `test:cli:postgres-reconcile` erfolgreich. CSP-/System-Update-Suite,
  Portable-CLI-Suite, TypeScript-/Host-/Docker-Builds ebenfalls erfolgreich.
- Nicht Teil dieser lokalen Abnahme: externer CLI-Artefakt-Download, produktive
  DNS-/TLS-Konfiguration, reale Versionsmigration mit geaendertem DB-Schema und
  der gesonderte Standalone-Updater. Hier echte gleiche-Version-Rebuilds mit
  unterschiedlichen unveraenderlichen Digests; keine kuenstliche Versionsnummer
  und keine Veroeffentlichung/Produktionsaenderung.
- Reload wurde waehrend einer laufenden Operation bei noch erreichbarer App
  geprueft. Ein vollstaendiger Browser-Neustart mitten im HTTP-Ausfall kann die
  App-Oberflaeche erst nach Wiederkehr erneut laden; die bereits offene Seite
  empfaengt waehrenddessen weiterhin CP-Status.
- Kleine verbleibende UX-Verbesserung: Waehrend des Host-Healthchecks zeigt die
  grobe Fortschrittskarte noch `Installing the update`/62%, waehrend die Details
  bereits korrekt `Waiting for Canvas Notebook health` anzeigen. Abschluss- und
  Rollback-Semantik sind davon nicht betroffen; kein offenes Funktionshindernis.
