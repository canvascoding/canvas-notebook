# Teammate-Onboarding: verbleibende Fehler

Dieser Durchlauf setzt die vier offenen Befunde des [vorherigen vollständigen QA-Berichts](../teammate-onboarding-fixes-2026-10-11/report.md) um. Lokaler Production Stack, synthetische Testkonten, keine Veröffentlichung.

## Prüfumfang

| Befund | Funktionsprüfung | Sichtbare Prüfung | Nachweis |
| --- | --- | --- | --- |
| QA5-1: Seat-Quote | Gleicher Bestand mit neuer Heartbeat-Revision; echte Bestandsänderung; Refresh; Cancel; Reaktivierung; verspätete Antwort; Parallelität | Neues Angebot nach Stale, Aktivierung mit eigenem Passwort, Abbruch ohne Nutzerkonto | Isolierte Notebook- und echte PostgreSQL-Tests; Playwright im frischen Container |
| QA5-2: Human Activity | Vertrauenswürdige öffentliche Origin bei internem Containerhost; fremde Origin ablehnen | Normale Onboarding-/Home-Interaktion | Route-Regression und Playwright-Requests |
| QA5-3: Profil-Onboarding | Persönlichen Workspace exakt binden; Hydration; Reload; Skip bei laufendem Request | Bradley-Begrüßung und bedienbarer Skip | Komponenten-/Diensttests und Playwright |
| QA5-4: Sitzung beendet | Aktuelle 401 beendet privates UI/Polling; alte Antworten dürfen neue Sitzung nicht beenden | Automatischer lokalisierter Login nach Offboarding | Clientregression und Playwright mit normalem Offboarding |

## QA5-1: Seat-Erneuerung und Abbruch

Die Browserprüfung läuft auf dem frisch gebauten Notebook-Image `00eff7b02488d20a80420dc41c6b3ed3ff60332c216c5629f299018ade12900a` mit dem aktualisierten Control Plane, PostgreSQL und Mailpit im bestehenden verwalteten Stack. Keine parallele Testumgebung und keine Veröffentlichung.

- Einladung über die Administrationsoberfläche erstellt; tatsächliche Ankunft und Link in Mailpit geprüft.
- Direkt angelegten Nutzer mit Initialpasswort aktiviert; später denselben Nutzer gesperrt und mit neuer Seat-Freigabe reaktiviert.
- Abgelaufene Einladung mit neuem Angebot von 3 auf 4 Seats erneuert und aktiviert.
- Im abschließenden Durchlauf eine noch gültige Einladung von 2 auf 3 Seats vorbereitet. Die Reaktivierung des anderen Kontos änderte den Bestand auf 3; die alte Freigabe wurde mit `TEAM_SEAT_QUOTE_STALE` abgewiesen.
- Die unmittelbar folgende Erneuerung lieferte in **164 ms** ein neues Angebot von 3 auf 4 Seats. Quote-ID wechselte; Mitgliedschaft und Einladungs-Request blieben unverändert. Kein Warten auf Worker oder Lease-Ablauf.
- Anschließend angenommene Einladung über „Decline activation“ widerrufen. Öffentliche Ansicht meldet den Widerruf. Eigene aktivierte Konten über normales Offboarding zurückgeführt; abschließend **2 beobachtete / 2 lizenzierte Seats, in sync**.

Der Browser fand beim ersten Durchlauf eine zusätzliche Ursache: Der direkte Execute-Pfad hielt eine definitive CP-Ablehnung bis zum Worker-Lauf auf `processing`. Der ergänzte Fehlerpfad speichert nur passende definitive STALE-/EXPIRED-409 des unveränderten eigenen Claims sofort. Unklare Ergebnisse und vorhandene Billing-Evidenz bleiben durch die bestehenden CP-Prüfungen geschützt.

Nachweise: [Browserprüfungen](seat-browser-checks.json), [sofort erneuertes Angebot](04-immediate-refresh-current.png), [widerrufene Einladung auf Mobilbreite](05-cancelled-mobile.png). Die Mobilansicht passt in 390 px ohne horizontales Überlaufen. Keine JavaScript-Seitenfehler; absichtliche Stale-/Revoked-Antworten und die noch offene Human-Activity-403 werden im JSON getrennt aufgeführt.

Der [schreibgeschützte PostgreSQL-Abgleich](seat-postgres-state-proof.json) besteht **22/22** Prüfungen: kein Nutzer-/Authkonto für die abgebrochene Einladung, ursprüngliche Request-ID und Token-Hash exakt erhalten, alte STALE-/SUPERSEDED-/CANCELLED-Historie vorhanden, alle drei zugehörigen CP-Freigaben widerrufen und unverbraucht, keine Billing-Operation. Der Abgleich verwendet ausschließlich schreibgeschützte Transaktionen.

Automatisierte Prüfung: **46/46** isolierte Notebook-Recovery-Szenarien, vier echte PostgreSQL-Sperrkonkurrenzen, bestehende Membership-/Invitation-/Removal-Suiten, vollständiger Typecheck und gezieltes ESLint. CP: 26 Core-Fälle sowie echte PostgreSQL- und Loopback-HTTP-Fälle für Snapshot-Konstanz, Änderungen, Lease-/Zeitgrenzen, Retirement und Prepare-Idempotenz. Host- und Container-Production-Builds erfolgreich. Das beweist den lokalen Test-/Development-Stack; externe SMTP-Zustellung, Stripe und Remote-CI wurden nicht geprüft.

Zusätzliche Setup-Beobachtung: Der erste Admin-Bootstrap unmittelbar nach dem Recreate traf einen PostgreSQL-Deadlock beim Schreiben von Organisationseinstellungen. Der gezielte erneute Bootstrap, Login-Check und Fixture-Check waren erfolgreich. Ein begrenzter Retry im Setup-Helfer wäre eine weitere Verbesserung.

## QA5-2: öffentliche Origin für Nutzeraktivität

Die Route verwendet den bestehenden Check für konfigurierte vertrauenswürdige Origins nach der Sitzungsprüfung. Die öffentliche Adresse `127.0.0.1:3100` muss dadurch nicht mit dem internen Next-Request-Host `0.0.0.0:3000` übereinstimmen. Forwarded-Header erweitern die erlaubten Origins nicht.

Route-Regression bestanden: öffentliche Origin über internen Host, bestehende Localhost-Origin, 401, Drosselung und Neustart-Persistenz. Sechs Negativfälle liefern jeweils vor und nach gespeichertem Zeitstempel 403 ohne Änderung: fehlende/fremde/interne unkonfigurierte Origin, gefälschte Forwarded-Header und Cross-Site-Markierung. Der Test verwendet eigene temporäre Datei-Persistenz und eine gemockte Sitzung. ESLint, vollständiger Typecheck sowie Host- und Container-Build bestanden.

Im frisch recreateten Notebook-Image `2f436e8af125101112f6a1a301e8fb5081e6f3f8334bf475e9ac24055e2fd964` bestehen **5/5** [Browserkontrollen](activity-browser-checks.json): echte vertrauenswürdige Eingabe mit öffentlicher Origin liefert 200 und schreibt den Zeitstempel, unmittelbare weitere Eingaben innerhalb 818 ms erzeugen keinen weiteren POST, fremde Origin bleibt 403 und fehlende Sitzung bleibt 401. Für die Beobachtung des Response-Bodys wurde im Browser eine Kopie der unveränderten Antwort gelesen. Keine JavaScript-Seitenfehler.

## QA5-3: persönlicher Workspace für Bradley

Der Service liefert für neue und bereits vorhandene Profil-Sitzungen die verbindliche Workspace-ID. Auch vorhandene Nachrichten überspringen keine Prüfung von persönlichem Owner, Organisation und Lese-/Agent-Rechten. Bootstrap und Skip verwenden denselben Session-Lock; ein nach Skip wartender Bootstrap prüft den Status erneut.

Die Oberfläche lädt die Workspaces neu und startet den Chat erst im exakt bestätigten aktiven persönlichen Workspace. Ein bereits aktiver Workspace ist gültig, auch wenn die Wechselmethode keinen Wechsel meldet. Generationsprüfung und Abort verhindern verspätete Bindungen nach Skip, Retry oder Unmount. Der Chat erhält die Workspace-ID ausdrücklich; eine abweichende URL kann ihn nicht in einen anderen Workspace oder in einen dauerhaften Loader lenken. Der Workspace-Switcher ist im Profil-Chat ausgeblendet.

Die Änderung am gemeinsam genutzten Workspace-Store ergänzt ein optionales Abbruchsignal. GitNexus bewertet den gesamten Store wegen seiner 87 direkten Aufrufer und 11 Abläufe als CRITICAL. Bestehende Wechsel ohne Signal sowie echte Abbrüche während erfolgreicher oder fehlgeschlagener Dokument-Speicherung sind geprüft. Der tatsächlich gestagte Patch ist MEDIUM mit drei betroffenen Abläufen; der breite main-Vergleich enthält zusätzlich bereits vorhandene und divergente Upstream-Änderungen.

Automatisierte Prüfung: **14** echte React/JSDOM-Regressionsgruppen für verzögerte Requests, Hydration und Wechsel, Skip/Unmount, Fehler/Retry, Reload und Rechte. Der Service-Test verwendet nun eine eigene PGlite-Datenbank und temporäre Daten, prüft neue/bestehende Sitzungen, Idempotenz, fremde/gesperrte Workspaces und beide Bootstrap-/Skip-Reihenfolgen. Kein kanonischer DB-Zugriff oder HTTP-/AI-Aufruf im Service-Test. Bestehende Chat-Bootstrap-Races, Workspace-Switcher-Prüfung, Onboarding-UI-Smoke, vollständiges TypeScript und gezieltes ESLint bestehen. ESLint meldet nur die bereits bestehende Warnung zur internen Navigation im Sprachwechsel.

Im frisch gebauten Image `431884ad50d2199a1ef8591a3b907bfbac2130d7741cd97d4b3a9ac19bee59bd` bestehen **15/15** [Browserprüfungen](profile-browser-checks.json): tatsächliche Mailpit-Einladung, Aktivierung und Login des Mitglieds, [Bradley-Begrüßung](06-bradley-exact-personal-workspace.png), persönlicher Workspace trotz gemeinsamem Workspace in Cache und Reload-URL, dieselbe Sitzung und genau eine gespeicherte Begrüßung nach Reload. Auf [390 px](07-bradley-mobile-skip.png) bleiben Inhalt und Skip erreichbar, ohne horizontales Überlaufen. Skip und Tour-Abschluss führen in die App.

Ein direkt angelegter Administrator aktiviert seinen Account mit Initialpasswort und erhält keine automatische Einladungsmail. Für den [Skip während Vorbereitung](08-admin-skip-pending-profile.png) wurde ausschließlich die Auslieferung einer echten erfolgreichen Profil-Antwort verzögert. Skip liefert 200 und führt zur Tour; die anschließend freigegebene alte Antwort öffnet keinen Chat und erzeugt keinen Chat-Bootstrap. Auch dieser Nutzer erreicht die App. Keine JavaScript-Seitenfehler. Host-/Container-Build, Bootstrap, Login und Fixtures sind erfolgreich.

Die beiden eigenen Konten bleiben für QA5-4 vorübergehend aktiv und werden bei der abschließenden Bereinigung offboarded. Die ursprünglichen fünf Mailpit-Nachrichten sind erhalten. Der Browser hat keinen AI-Provider-Prompt gesendet; Profil-Completion und Memory-Persistenz sind im isolierten Service-Test geprüft.

Weitere UX-Notiz: Der Profil-Chat zeigt weiterhin die allgemeine Chat-Werkzeugleiste einschließlich „Neuer Chat“ und Subagenten. Ein kompakterer Einstieg könnte die Profilfragen und den Skip deutlicher hervorheben.

Testbetrieb: Eine Debug-Momentaufnahme gab synthetische Testpasswörter aus; beide aktiven eigenen Testkonten erhielten anschließend neue Passwörter. Die automatische Node-REPL-Objektausgabe gab außerdem Umgebungsdaten aus. Sie ist jetzt gesperrt, weitere Log-Ausgaben redigieren bekannte Secrets. Das betroffene MCP-Token (`CANVAS_CONTROL_PLANE_MCP_TOKEN` / `CANVAS_MCP_TOKEN`, gleicher Wert) und `HF_TOKEN` sollten beim jeweiligen Aussteller rotiert werden; keine Secret-Werte stehen in diesem Bericht oder den QA-Artefakten.

## QA5-4: sofortiges Ende einer privaten Sitzung

Geschützte Benachrichtigungsabfragen und Mutationen erfassen die vorhandene Auth-Scope mit Nutzer, Session-ID und Epoch. Sie prüfen diese vor dem Request, nach den Response-Headern und nach dem Body. Eine aktuelle 401 setzt einen einmaligen Ablaufzustand, nutzt das bestehende BetterAuth-Signal zur Löschung von Document-Receipts, QueryClient und gespeichertem Chat und leitet zum Login in der aktuellen Sprache weiter. Alte 200/401 sowie abgebrochene Requests dürfen eine neue Sitzung weder überschreiben noch abmelden. 403, 5xx und Transportfehler lösen keinen Logout aus.

Auch der direkte BetterAuth-Übergang von einer zuvor bestätigten Sitzung zu einem abgeschlossenen anonymen Ergebnis wird behandelt. Initiale Anonymität und noch laufende Abfragen sind davon ausgenommen. Die Ablaufmarkierung bleibt für dieselbe Sitzung erhalten und wird erst durch eine neue bestätigte Identität oder Session-ID zurückgesetzt. Öffentliche Login-, Setup-, Einladung- und Consent-Seiten bleiben erreichbar.

Eine gemeinsame Boundary blendet den gesamten privaten Provider-Baum aus. Home und Bell starten erst nach bestätigter Anmeldung; Abort, Generation und Scope schützen verspätete Ergebnisse. Unmount beendet Intervalle, geplante Refreshes und Event-Listener. Die Bell prüft nach einer Mutation erneut die Sitzung vor Navigation; erwartete Ablauf-/Unmount-Fehler bei „Mark all read“ und Dismiss erzeugen keine unbehandelten Rejections. Der Activity-Recorder entfernt seine Listener, bricht Requests ab und konsumiert erfolgreiche Response-Bodies.

Automatisierte Prüfung: `npm run test:auth:session-expiry` besteht mit zentralem Registry-/Cache-/Boundary-Test, **13** echten Bell-Race-Gruppen und **14** echten Home-/Activity-Gruppen. Darin sind verspätete Header und Bodies, Parallelität, Logout/Neuanmeldung, direkte anonyme Auth-Ergebnisse, ausstehende Timer, Cache-Purge, Public-Routen und fehlgeschlagene Mutationen enthalten. Beide bestehenden Bell-Tests sowie QueryClient-, Chat-Cache- und Home-Notification-Regressionen bestehen. Vollständiger Typecheck, gezieltes ESLint und Diff-Prüfung sind erfolgreich. Diese Tests verwenden isolierte Daten und kontrollierte Transportzustände; keine kanonische DB oder externen Provider.

Der neue Index bewertet den zentralen Snapshot wegen drei direkter Aufrufer und insgesamt 17 erreichter Symbole als CRITICAL; die Summary erreicht zwei direkte Aufrufer und ist HIGH. Die Risiken wurden vor der Browserabnahme gemeldet. Der fokussierte gestagte Patch enthält 15 Code-/Testdateien und 182 Symbole, LOW in `detect_changes`; der breitere main-Vergleich enthält zusätzlich divergente und vorherige Änderungen und bleibt MEDIUM. Das Fehlen eines indexierten betroffenen Ablaufs ersetzt keine Funktionsprüfung.

Host- und Container-Production-Builds, frisches Recreate, Bootstrap, Login und Fixtures sind erfolgreich. Das finale Image ist `cb6c947bbb7515057c647d78a8a45d821b627e84885284d0885d472a62a9f6de`; seine neun Produktdateien sind seit dem Build unverändert. Control Plane und PostgreSQL wurden bei diesem Recreate weiter betrieben.

Im Browser liefern beide normalen Offboarding-Aktionen 200 und die betroffenen Sitzungen echte 401. Der private Bereich verschwindet bereits, während ausschließlich die Auslieferung des echten Login-Dokuments zurückgehalten wird: [Mitglied](09-member-private-hidden-before-login.png), [Administrator](10-admin-private-hidden-before-login.png). Die Aufnahmen und der DOM-Beobachter prüfen die tatsächliche Oberfläche; keine fachliche API-Antwort wurde ersetzt. Anschließend erscheint automatisch der [deutsche Login](09-member-session-expired-de.png) bzw. [englische Login](10-admin-session-expired-en.png), ohne manuellen Reload.

Die [abschließende Browserprüfung](expiry-browser-checks.json) besteht **11/11** Kontrollen. Nach dem Login wurden beide Seiten länger als 65 Sekunden beobachtet; auch neue vertrauenswürdige Eingaben und gültige Refresh-Events erzeugen keinen privaten Summary-Request oder Activity-POST. Keine JavaScript-Seitenfehler im korrigierten Lauf. Zwei vom Test selbst mit einem ungültigen `session_updated`-Event ohne `detail` ausgelöste Fehler sind im JSON gesondert erhalten; der Lauf mit dem tatsächlichen CustomEvent-Vertrag besteht.

Die beiden eigenen Profil-Testkonten sind archiviert. Der Lizenzabgleich bestätigt wieder **2 beobachtete / 2 lizenzierte Seats, in sync**. Damit sind alle vier Korrekturen lokal abgenommen.

## Abschließender vollständiger Workflow

Alle vier Wege laufen auf demselben frisch gebauten finalen Image mit unveränderten Produktdateien. Die [Zustandsprüfungen](final-workflow-checks.json) bestehen **57/57**; der zusätzliche Fehler des ersten Cleanup-Versuchs ist im selben JSON ausdrücklich erhalten.

| Einstieg | Rolle | Login und Onboarding | Rechte und App-Nutzung | Bereinigung |
| --- | --- | --- | --- | --- |
| Einladung, tatsächlicher Mailpit-Link | Administrator | Deutsch, persönlicher Bradley-Workspace, Skip, Abschluss, Reload | Nutzerverwaltung zugänglich | Offboarding 200 |
| Direkte Kontoanlage mit Initialpasswort | Mitglied | Englisch, persönlicher Bradley-Workspace, Skip, Abschluss, Reload | Nutzerverwaltung 403; eigene Notiz erstellt, bearbeitet und nach Reload gelesen | Erster Versuch 500, erneuter UI-Versuch 200 |
| Einladung, tatsächlicher Mailpit-Link | Mitglied | Deutsch, persönlicher Bradley-Workspace, Skip, Abschluss, Reload | Geschützte App-Abfragen 200, Nutzerverwaltung 403 | Offboarding 200 |
| Direkte Kontoanlage mit Initialpasswort | Administrator | Englisch, persönlicher Bradley-Workspace, Skip, Abschluss, Reload | Nutzerverwaltung zugänglich | Offboarding 200 |

Beide Einladungen kommen tatsächlich in Mailpit an; beide direkt angelegten Nutzer erhalten keine automatische Einladungsmail. Alle Konten erreichen die App, behalten den abgeschlossenen persönlichen Onboarding-Status nach Reload und haben die passende Rolle. Keine JavaScript-Seitenfehler bei diesen vier Wegen. Chromium bei 390 bzw. 1440 px; keine reale Mobilgerät-Prüfung.

Nachweise: [eingeladener Administrator](11-final-invite-admin-bradley.png), [direkt angelegtes Mitglied](11-final-direct-member-bradley.png), [eingeladenes Mitglied auf Mobilbreite](11-final-invite-member-bradley.png), [direkt angelegter Administrator](11-final-direct-admin-bradley.png), [bearbeitete persönliche Notiz](12-member-created-edited-note.png).

Die [Bereinigung](cleanup-checks.json) besteht **8/8** Kontrollen. Alle acht in diesem Durchlauf tatsächlich angelegten eigenen Konten sind gesperrt/archiviert; die abgebrochene Einladung hat weiterhin kein Nutzerkonto. Kontohistorie und persönliche Workspaces bleiben nach normalem Offboarding für Recovery erhalten. Fünf eigene Mailpit-Nachrichten wurden über ihre exakten IDs entfernt, die ursprünglichen fünf vollständig erhalten. Die zentrale SMTP-Testkonfiguration ist entfernt, die ursprüngliche Einstellung `configured=false`, `deliveryMode=local` wiederhergestellt. PostgreSQL, Control Plane und Notebook sind gesund; andere Container wurden nicht verändert.

Der aktuelle Seat-Abgleich ist **2/2, in sync**. Die aggregierte Historie zeigt weiterhin 70 fehlgeschlagene und einen ausstehenden Vorgang; sie wurde nicht pauschal gelöscht oder als fehlerfreie Gesamtqueue dargestellt.

## Weitere Befunde und Grenzen

- **Offboarding nach Dokumentnutzung:** Beim direkt angelegten Mitglied lieferte die normale Offboarding-Aktion einmal 500 trotz erfolgreicher Vorprüfung. Das Konto blieb aktiv. Der erneute identische UI-Versuch lieferte 200, entfernte den Zugriff und gab den Seat frei. Die Ursache ist nicht eingegrenzt; dieser zusätzliche Befund bleibt offen und gehört nicht zu den vier bereits implementierten Korrekturen.
- **Home-Einstieg:** Ein neues Mitglied sah zahlreiche ältere Hinweise aus dem lesbaren Shared Test Workspace. Eine klarere Behandlung von bereits vorhandenen Team-Hinweisen beim ersten Login könnte den Einstieg ruhiger machen. Zeitweise zeigte die E-Mail-Karte einen Fehlerhinweis; eine spätere echte Widget-Abfrage lieferte 200 mit `ready`. Ursache und Darstellung sollten getrennt weiter geprüft werden.
- **Profil-UX:** Die allgemeine Chat-Werkzeugleiste und Subagenten bleiben im Profil sichtbar; nach Skip bleibt die Bradley-Onboarding-Sitzung im Notebook auswählbar. Ein kompakterer Profil-Einstieg und ein klarer Übergang zum normalen Arbeiten wären weitere Verbesserungen.
- **Prüfgrenze:** Die Browserfälle verwenden den Profil-Skip. Kein KI-Profilgespräch oder externer SMTP-/Stripe-/Remote-CI-Nachweis. Profil-Completion und Memory-Persistenz sind im isolierten Service-Test geprüft. Die bereits oben beschriebene Rotation der ausgegebenen MCP-/HF-Tokens bleibt offen.

Die vier Korrekturen sind lokal umgesetzt, einzeln committed und abgenommen. Vollständige Rollenprüfung, eigene Testdaten-Bereinigung und Abschlussdokumentation sind fertig; zusätzliche Befunde bleiben ausdrücklich dokumentiert.
