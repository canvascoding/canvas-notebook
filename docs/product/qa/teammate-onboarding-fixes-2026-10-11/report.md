# Teammate-Onboarding: Fix-Validierung

Begonnen am 11. Oktober 2026; abschließende Offboarding-Prüfung am 12. Oktober 2026 (Europe/Berlin). Lokale Produktionstestumgebung, keine Veröffentlichung.

## 1. Offboarding und Lizenzplätze

Status: abgeschlossen. Implementierung, automatisierte Prüfungen, Production-Browsertest, mobile Statusprüfung und Testkonto-Bereinigung bestanden.

Im ersten Production-Browsertest wurden zwei Konten innerhalb von 103 ms offboarded. Beide Zugänge und Sitzungen waren gesperrt. Die beiden parallelen Datenbanktransaktionen hatten jedoch jeweils drei verbleibende Mitglieder berechnet und deshalb zweimal eine Reduzierung von vier auf drei Plätze vorbereitet. Der zweite Auftrag scheiterte mit `TEAM_SEAT_RECONCILIATION_REQUIRED`; das Zertifikat blieb bei drei Plätzen.

Die Bestandsänderungen, Rollenänderungen und Snapshot-Erzeugung verwenden jetzt dieselbe kurze Organisationssperre. Sie ist mit den Fremdschlüsselprüfungen bei der Nutzeranlage kompatibel. Removal-Prepare und -Execute laufen pro Organisation nacheinander. Die Reihenfolge folgt der gespeicherten Mitgliedschaftsrevision statt den Request-Zeitstempeln. Ein noch offenes Execute oder ein früheres Prepare hält auch während seiner Retry-Wartezeit die nächste Vorbereitung zurück. Die Fälligkeit wird erst nach der Auswahl des ersten offenen Vorgangs geprüft.

Vor einer Reduzierung muss der aktuelle tatsächliche Mitgliederbestand als Snapshot bestätigt sein. Ein fehlender oder überholter Abgleich wird begrenzt wiederholt; ein Ziel unter dem aktiven Bestand wird abgelehnt. Ausführungsantworten werden der exakten Authorization ihres ursprünglichen Prepare-Auftrags zugeordnet.

Nach der verifizierten Ausführung werden der erfolgreiche Abschluss und ein neuer Snapshot atomar gespeichert. Dadurch erhält die Control Plane zeitnah den neuen Lizenzbestand. Ein wiederholtes Execute erzeugt keinen zweiten Snapshot; ein Fehler beim Speichern hinterlässt keinen halben Abschluss.

Die Nutzerverwaltung zeigt den nachgelagerten Status pro archiviertem Nutzer: läuft, freigegeben oder fehlgeschlagen. Historische Fehler anderer Aufträge werden diesem Status nicht zugerechnet. Der neue Status-Endpunkt verlangt die Organisationsberechtigung zur Wiederherstellung.

### Nachweise

- Elf Removal-Regressionsfälle mit echter PGlite-Datenbank einschließlich Certificate-Verifier-Abweisung, Snapshot-Insert-Fehler, atomischem Rollback und idempotentem Replay.
- Zwei unabhängige PostgreSQL-Verbindungen mit überlappenden Offboarding-Transaktionen: tatsächliche Sperrwartezeit nachgewiesen, gespeicherte Mengen und Snapshots `3 → 2`, streng steigende Revisionen. Reale Permission-Inserts prüfen die Verträglichkeit mit Fremdschlüssel-Sperren. Vertauschte Request-Zeitstempel reproduzierten zunächst den falschen Claim; dieselbe Prüfung besteht nach der Korrektur. Eine nicht fällige frühere Prepare blockiert die neuere fällige Prepare. Eigene temporäre Datenbank und Sessions anschließend entfernt.
- Snapshot-Barriere: fehlende/neue Bestätigung, falscher Hash, widersprüchliche Bestände, Frische, unsicheres Ziel und ausgeschöpfter Retry.
- Status-Service: historische Fehler, neue Auftragsketten, Reaktivierung, Organisationsisolation und unbestätigte Zertifikate.
- Bestehende Membership-, Aktivierungs-, Suspendierungs-, Snapshot-, Outbox- und Invitation-Tests bestanden.
- Signierte Non-Billable-Lizenzsuite bestanden. Sie ersetzt keinen Stripe- oder externen Provider-Test.
- Vollständige TypeScript-Prüfung und fokussiertes ESLint bestanden. Host- und Container-Build mit dem aktuellen Stand bestanden; nur Notebook wurde recreated. PostgreSQL und Control Plane liefen weiter.

Automatisierte Details: [offboarding-automated-checks.json](offboarding-automated-checks.json).

### Abschließender Production-Browsertest

Image: `sha256:a918078d83f82ac670e74694389eb7afd186b0e7e69546538bd165d6d71c5869`.

Zwei neue Konten wurden über die Nutzerverwaltungs-UI angelegt und anschließend angemeldet: ein Mitarbeiter und ein Administrator. Bei jeder Anlage bestätigte die Testquote den Provider `test`, `nonBillable=true`, null wiederkehrende Kosten und keine benötigte Billing-Freigabe. Der bestätigte Bestand stieg von zwei über drei auf vier.

Beide Offboardings wurden mit 12 ms Abstand bestätigt (ein UI-Vorgang und ein überlappender API-Aufruf nach erfolgreichem Preflight). Beide Sessions waren danach gelöscht; der geschützte Status-Endpunkt antwortete für beide mit HTTP 401. Die UI zeigte beide Reduzierungen zuerst als laufend und anschließend als abgeschlossen. Nach 48,096 Sekunden lagen tatsächlicher lokaler Bestand, bestätigter Control-Plane-Bestand und signiertes Zertifikat bei zwei. Snapshot-Revision und Hash waren bestätigt; Drift und Reconciliation waren `in_sync`.

Direkt danach ließ sich über denselben normalen UI-Ablauf ein weiterer Nutzer anlegen und anmelden. Der bestätigte Bestand und das Zertifikat stiegen auf drei. Auch dieses Konto wurde über die Offboarding-UI entfernt, seine Session gesperrt und sein Lizenzplatz automatisch freigegeben. Abschließend lagen lokaler Bestand, bestätigter Control-Plane-Bestand und signiertes Zertifikat wieder bei zwei; Revision 5752, bestätigter Hash, Drift und Reconciliation `in_sync`.

Screenshots: [laufende Freigaben](13-final-seat-reductions-pending.png), [beide Freigaben abgeschlossen](14-final-seat-reductions-completed.png), [erneute Nutzeranlage](15-final-next-user-created.png), [bereinigter Ausgangsstand](16-final-two-seat-clean-baseline.png), [mobile Statuskarten](17-final-mobile-seat-statuses.png). Bei 390 × 844 px zeigten alle drei Testkonten den abgeschlossenen Status; Dokumentbreite und sichtbare Breite waren jeweils 390 px.

Maschinenlesbarer Nachweis: [offboarding-production-ui-checks.json](offboarding-production-ui-checks.json). Keine JavaScript-Pageerrors im Durchlauf. Vier HTTP-403-Antworten auf `/api/instance/human-activity` wurden separat protokolliert; deren Ursache ist im vollständigen abschließenden QA-Durchlauf noch zu prüfen.

Ein anfänglicher 404-Aufruf im privaten QA-Helfer verwendete versehentlich `/offboard` statt des tatsächlichen API-Pfads `/offboarding`. Der Helfer wurde vor den Mutationen korrigiert; dies ist kein Produktbefund.

Die Lizenzkarten-Aktualisierung bleibt Gegenstand von Planpunkt 2. Dieser erste Planpunkt bestätigt die automatische tatsächliche Platzfreigabe und den nutzerbezogenen Abschlussstatus.



### Historie des Fehlertests

Der fehlgeschlagene ursprüngliche Prepare-Auftrag bleibt erhalten. Für die isolierte Testidentität wurde über die Snapshot-/Outbox-Anwendungsdienste im privaten QA-Harness eine neue Reduzierung auf den tatsächlichen Bestand eingereiht. Der normale Worker hat den Platz anschließend freigegeben und das signierte Zertifikat auf zwei Plätze aktualisiert. Dies war die Wiederherstellung des Test-Ausgangsstands; der oben dokumentierte eigenständige Test zweier neuer Entfernungen erfolgte anschließend.

Screenshots: [ursprünglicher Fehler](04-offboarding-current-status.png), [Status während der korrigierten Wiederholung](05-corrected-recovery-pending.png).

### Vorbestehende Testwerkzeuge

`test:organization:offboarding` verweist auf die fehlende Datei `scripts/organization-offboarding-test.ts`. Der Befehl gilt deshalb nicht als bestanden. Die tatsächlichen Offboarding-API- und UI-Abläufe sowie die neuen Datenbanktests sind die verwendeten Nachweise.

Das verwaltete lokale Startskript wurde wegen eines belegten `pipefail`/SIGPIPE-Fehlers in der Portprüfung als private, ansonsten identische Kopie ausgeführt. Diese konsumiert die gesamte `docker ps`-Ausgabe. Die Prüfung eines einzigen verwalteten Stacks, der Host-Build vor dem Container-Build und das gezielte Recreate nur von Notebook bleiben enthalten.

## 2. Einladungsdialog und Lizenzanzeige

Status: abgeschlossen. Fokussiertes ESLint und TypeScript, Host- und Container-Build sowie Production-Playwright-Abnahme bestanden.

Im aktuellen Production-Container reproduziert: Einladung erstellt (HTTP 201), Done, erneut Invite. Der alte Link blieb sichtbar und das neue Namensfeld fehlte. Die isolierte Einladung wurde danach über die UI widerrufen (HTTP 200). Ein normaler Reload löste keinen Request zu `/api/license/status` aus. Nachweis: [invitation-refresh-before-fix.json](invitation-refresh-before-fix.json), [Dialog vor dem Fix](18-invite-dialog-reset-before-fix.png), mit maskiertem Link.

Öffnen, Done und Schließen verwenden nun denselben Dialog-Reset. Der gemeinsame Aktualisierungsablauf lädt Nutzer und Lizenzstatus nach erfolgreichen Aktionen, Reload und Berechtigungsänderungen. Der vorhandene Status-Poll löst zusätzlich einen Lizenzabruf aus, wenn erstmals oder neu ein terminales Resultat sichtbar wird; unveränderte historische Resultate lösen keine weiteren Abrufe bei späteren Polls aus. Callback-Ref und Zustandsvergleich verhindern einen erneuten Start des Pollings. Lizenzrequests besitzen einen Latest-request-Schutz sowie Abort, Timeout und Unmount-Cleanup.

GitNexus-Auswirkungsanalyse: der gemeinsame Aktionshelfer hat zwölf Consumer im Nutzerverwaltungs-Panel (MEDIUM); die übrigen geänderten Abläufe sind LOW. Keine zusätzlichen App-Prozesse wurden als betroffen ausgewiesen. Kein zweites Pollintervall.

Production-Image: `sha256:8d113491f9632d1eb17166862eec052cc0734d8871ad511954be9624a10fdd2e`. Zwei unmittelbar aufeinanderfolgende Einladungen erhielten verschiedene Links und die erwarteten Rollen (admin/member). Nach Done, Cancel und Escape waren Name und E-Mail leer, die Administrator-Auswahl ausgeschaltet und der alte Link entfernt. Beide Einladungen wurden anschließend widerrufen; der gespeicherte Status ist jeweils `revoked`.

Nach der tatsächlichen Nutzeraktivierung zeigte die Karte ohne Seitenreload `3 / 3`. Der Reload-Button erzeugte zwei erfolgreiche Lizenzabrufe statt zuvor null. Nach Offboarding zeigte der automatische Refresh zunächst `2 / 3`; mit dem abgeschlossenen Execute wechselte die Karte nach 21,407 Sekunden ohne erneuten Reload auf `2 / 2`. Das Testkonto ist archiviert und seine Session gesperrt. Abschließend: lokaler Bestand, bestätigter Control-Plane-Bestand und Zertifikat zwei; Revision/Hash bestätigt, Drift und Reconciliation `in_sync`.

Die aufgezeichneten Requests stammen vom tatsächlichen UI, nicht von den separaten lesenden API-Checks. Während der laufenden Freigabe erzeugten unveränderte historische Abschlusszustände keine weiteren Lizenzabrufe. Keine JavaScript-Pageerrors; die drei erneut beobachteten HTTP-403-Antworten sind im maschinenlesbaren Nachweis separat enthalten.

Nachweise: [Production-Prüfungen](invitation-refresh-production-ui-checks.json), [automatisierte Validierung](invitation-refresh-automated-checks.json), [frischer Dialog](19-invite-dialog-reset-after-done.png), [Karte nach Aktivierung](20-license-card-after-user-activation.png), [Karte nach automatischer Freigabe](21-license-card-after-automatic-seat-release.png).


## 3. Mobiles Profilformular

Status: abgeschlossen. Der gemeinsame Profil-Editor wurde im Onboarding und im Einstellungsdialog mit Playwright gegen einen frisch gebauten Production-Container geprüft.

Vor dem Fix maß das Formular bei 390 px Sichtbreite 308 px, seine Icon-Galerie reichte jedoch rechts über den Formularrand. Rocket, Camera und Leaf waren abgeschnitten. Der Uploadtext wurde daneben stark zusammengedrückt. Nachweis: [Layout vor dem Fix](profile-layout-before-fix.json), [Screenshot vor dem Fix](22-mobile-profile-before-fix.png).

Die Grid-Spalten und das Optionspanel können jetzt schrumpfen. Mobile Flächen verwenden weniger Padding und stapeln den Uploadtext über der Schaltfläche. Die Galerie wählt ihre zwei bis sechs Spalten nach der tatsächlichen Breite des Optionscontainers. Avatar-Auswahl, Upload, Speicherung und Formularhandler sind unverändert. GitNexus: LOW, zwei direkte Nutzer des gemeinsamen Editors, betroffen sind Onboarding und Profileinstellungen.

Production-Image: `sha256:cb35b1bf70565212ef519c1a91326376aa6109610a731f32972c8efdf3c40fc5`. Acht Layoutprüfungen bestanden: Onboarding und Einstellungsdialog jeweils bei 360, 390, 820 und 1440 px Sichtbreite. Dokument und Formular hatten keinen horizontalen Überlauf; alle zwölf Icon-Schaltflächen lagen innerhalb des Formulars und waren mindestens 59 px breit. Auch Upload und Initialen-Zeile waren vollständig bedienbar. Visuelle Nachweise: [mobiler Einstellungsdialog](28-profile-settings-mobile-360.png), [schmaler Desktopdialog](29-profile-settings-narrow-desktop.png), [Desktopdialog](30-profile-settings-desktop.png). Dies sind Chromium-Viewportprüfungen, keine Tests auf physischen Mobilgeräten.

Die Bildauswahl wurde über die sichtbare Schaltfläche geöffnet. Die Icon-Auswahl im mobilen Onboarding und die Rückkehr zu Initialen im Einstellungsdialog antworteten jeweils mit HTTP 200 und blieben nach Reload erhalten. Der persönliche Einrichtungsablauf wurde abgeschlossen; die optionalen Bradley-Präferenzen wurden über die UI übersprungen, die Tour ist installationsseitig deaktiviert.

Das isolierte Testkonto wurde über die normale UI offboarded und seine Session entfernt. Binnen 29,411 Sekunden war der bereinigte Zustand verifiziert: lokaler und bestätigter Control-Plane-Bestand sowie signiertes Zertifikat zwei; Revision 5765 und Hash bestätigt, Drift und Reconciliation `in_sync`.

Fokussiertes ESLint, bestehender UI-Vertrag mit zwölf Icons sowie Host- und Container-Build einschließlich vollständiger TypeScript-Prüfung bestanden. Unabhängige Diff-Prüfung ohne Blocker. Maschinenlesbarer Nachweis: [Production-Layoutprüfungen](profile-layout-production-ui-checks.json), [automatisierte Prüfungen](profile-layout-automated-checks.json).

Keine JavaScript-Pageerrors. Separat protokolliert wurden vier HTTP-404-Antworten für das nicht konfigurierte öffentliche Markenlogo, sechs HTTP-403-Antworten auf Human Activity, ein HTTP 400 beim optionalen Bradley-Session-Bootstrap sowie eine Notification-HTTP-401 nach Offboarding. Die optionalen Bradley-Präferenzen gelten nicht als abgenommen; diese Beobachtungen werden im abschließenden Gesamtdurchlauf eingeordnet.

## Noch folgende Planpunkte

4. Automatische Einladungs-E-Mail über System-SMTP, Versandstatus, kontrollierter erneuter Versand und klare Passworttexte.
5. Vollständiger Production-Playwright-/Mailpit-Durchlauf für beide Rollen, wiederholte Einladungen und negative Fälle.

Der ursprüngliche Befundbericht bleibt unter [teammate-onboarding-local-production-2026-10-11.md](../teammate-onboarding-local-production-2026-10-11.md) erhalten.
