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

QA5-1, QA5-2 und QA5-3 sind lokal abgenommen. QA5-4 und die abschließende Gesamtprüfung/Bereinigung sind weiterhin offen.
