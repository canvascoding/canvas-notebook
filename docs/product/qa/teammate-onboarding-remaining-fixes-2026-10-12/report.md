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

QA5-1 ist lokal abgenommen. QA5-2, QA5-3 und QA5-4 sind weiterhin offen. Die vollständige Abnahme aller vier Befunde steht noch aus.
