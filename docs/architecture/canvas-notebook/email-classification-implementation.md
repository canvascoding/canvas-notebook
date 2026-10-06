# E-Mail-Klassifizierung und Fokus: Umsetzungsnachweis

Branch: `codex/email-classification-plan`. Grundlage: `email-classification-harness-plan.md`.
Der Nutzer hat Umsetzung und Playwright freigegeben und Mailpit für lokale Mailtests vorgegeben. Container werden nur bei gesondertem ausdrücklichem Auftrag gebaut.

## Sequenzielle Phasen

- [x] 1. Decision-Vertrag, Providerfähigkeiten, Vier-Felder-Schema, deterministische Policy und versionierte synthetische Evaluation.
- [x] 2. PostgreSQL-Persistenz, Settingsrevision, lokale/verwaltete Mailboxidentität, unabhängiger Metadatenindex, Jobs/Leases, Korrekturen und persönlicher Fokuszustand.
- [ ] 3. Zentrale System-Credentials, Admin-Settings/Availability, Provider-Vertragsabnahme und Limits/Abbruch.
- [ ] 4. Hintergrund-Synchronisation/Klassifizierung, vollständiger autorisierter Gesamtfeed, Paging/Ranking, Cache-Anreicherung und Lifecycleinvalidierung.
- [ ] 5. Adminoberfläche und sichere Secrets-Anbindung.
- [ ] 6. Fokus/Klassisch, Alle/Einzel/Persönlich/Arbeit, Progressive Disclosure, Herkunft bei Mailaktionen und persönliche Erledigung.
- [ ] 7. Qualitäts-/Recovery-Dokumentation, relevante Regressionsprüfungen, Typecheck/Lint/Build und abschließende E2E-/UI-Abnahme.

## Abschlussanforderungen

| Anforderung | Autoritativer Nachweis | Status |
| --- | --- | --- |
| Austauschbare Decision-Provider ohne Mail-/DB-Wissen | `npm run test:decision-models`; TypeSafe und kompatibler Adapter, unabhängige Registry | Phase 1 geprüft |
| Vier Felder und echte Wahrscheinlichkeiten, unbekannt ungleich null Prozent | `npm run test:email:classification:policy`; Choice-Verteilungen getrennt von Provider-Confidence | Phase 1 geprüft |
| Zentraler Adminschalter, standardmäßig aus, keine persönlichen AI-Schalter | Admin-/Availability-/Worker-Tests und Browser | Offen |
| System-Secrets ohne Prozess-/Userfallback | Credential-/Route-Tests, Secrets-UI | Offen |
| Sichere dauerhafte Persistenz, Leases/Revisionen/Toggle-Rennen | PGlite mit echter Startupmigration und zusätzliche PostgreSQL-18-Prüfung über unabhängige Sessions in eigenem temporärem Schema | Phase 2 geprüft; API-Anschluss offen |
| Persönliche/Workspace-Rechte samt Senderpolicy auch bei Cachetreffer | Feed-/Boundary-/Revocation-Tests | Offen |
| Lokale und verwaltete persönliche, vorhandene gemeinsame Postfächer | Registry-/Service-/Feedtests | Offen |
| Metadatensync unabhängig von AI; Verarbeitung bei geschlossenem Browser | Scheduler-/Worker-/Restarttests | Offen |
| Batch-Anreicherung ohne AI im Read-Pfad und ohne verlorene Korrekturen | Cache-/Enrichmenttests | Offen |
| Globales Ranking über synchronisierten Bestand, stabile Cursor und ehrliche Coverage | Mehrseitige Feedtests | Offen |
| Fokus/Klassisch und alle Postfachscopes, gespeicherte Moduswahl | Browser-E2E samt Reload und zentralem Toggle | Offen |
| Mailaktionen/Anhänge/Absender verwenden Herkunft der gewählten Mail | Browser-/Route-Tests mit gleichen IDs in verschiedenen Postfächern | Offen |
| Unbewertete/unsichere/gestörte Quellen sichtbar, Prozentdetails bei Bedarf | Responsive Browser-E2E | Offen |
| Persönliches Erledigen/Undo schließt keinen Team-Case | Store-/Policy-/Browserprüfungen | Offen |
| Compose/Review, Sendefehler und unklarer Versandstatus bleiben erhalten | Bestehende und neue Mail-/Reviewregressionen | Offen |
| Keine springende Liste oder verlorenen Entwürfe bei Scope-/Moduswechsel | Browser-E2E | Offen |
| Typecheck, relevante Lints, Produktionsbuild | Aktuelle Command-Ergebnisse | Offen |
| Abschließender E2E-Test mit visueller Prüfung Desktop/Mobile | Aktueller Playwright-Report und Screenshots | Offen |
| Lokale echte Mailtests mit Mailpit | SMTP-Eingang, Notebook-Abruf/Klassifizierung und Antwort an Mailpit | Offen |
| Reale Jev-Anbindung | Synthetischer Providerrequest mit zentral konfiguriertem User-Key | Offen; Key noch nicht konfiguriert |

Die synthetischen Canary-Mails sind keine statistische Kalibrierung. Automatische Spam-Ausblendung bleibt ohne explizit dokumentiertes geprüftes Schwellenprofil deaktiviert.

## Phase 1: Ergebnisse

Neue allgemeine Module unter `app/lib/decision-models/` liefern Choice/Binary/Ordinal, Providerfähigkeiten, strenge Input-/Antwortprüfung, unveränderlichen Requeststand, begrenzte sichere HTTP-Requests, Timeout/Abort und strukturierte Fehler. Jev und System-One-kompatible Dienste verwenden denselben Vertrag; E-Mail/DB/Secretszugriff liegen außerhalb des Harness. Der aktuelle TypeSafe-Vertrag wurde anhand offizieller API-/Modelldokumentation geprüft.

Die Mailmodule unter `app/lib/email/classification/` definieren das Vier-Felder-Schema, begrenzten Mailzustand, persönliche/geschäftliche Kriterien, Normalisierung und deterministische Gruppen. Konservative Startschwellen sind explizite Konfigurationswerte, kein Qualitätsnachweis. Automatische Spam-Ausblendung benötigt eine Evaluationreferenz für den tatsächlichen Provider-/Modell-/Schemastand. Wichtiger Spamkonflikt, unbekannter Antwortstatus, manuelle Korrekturen und persönliche Erledigung sind eigene Zustände. Synthetische Canary-Daten liegen in `scripts/fixtures/email-classification-evaluation.v1.json` mit getrennten Development-/Calibration-/Testfällen.

Geprüft am 2026-10-06: beide fokussierten Tests, ESLint für neue Module/Tests und globales `npx tsc --noEmit --pretty false` bestanden. Ein zunächst gefundener Typfehler in der Harness-Antwortvalidierung wurde vor der erfolgreichen Wiederholung korrigiert. Keine reale Jev-Anfrage, Browserprüfung oder Produkt-UI in dieser Phase. Branch-/Scopeprüfung erfolgt vor jedem Commit mit GitNexus.

## Phase 2: Ergebnisse

Additive PostgreSQL-Migration im bestehenden zentralen Startup-Migrationspfad. GitNexus bewertete diesen Anschluss vor Änderung als CRITICAL (49 direkte Abhängigkeiten, 244 insgesamt); die Änderung besteht dort aus einem Import und einem Aufruf. Neue Tabellen halten Settings, Mailboxregistry, Metadatenindex, Jobs, dauerhafte Ergebnisse/Korrekturen, persönlichen Fokuszustand und tägliches Attempt-Budget getrennt. Verwaltete Accounts benötigen keinen lokalen Account-Fremdschlüssel. Eigentümerlöschung kaskadiert.

Der neue Store pinnt jede Transaktion an eine Verbindung. Settings-CAS, Lease-/Claim-Token, aktueller Fingerprint/Binding/Policy, gespätete Ergebnisübernahme nach Abschalten und persönliches Done/Undo sind geprüft. Syncabschlüsse verwenden erwartete Quellrevisionen; abgeänderte Quellen bekommen frische Abdeckung. Normale Tokenrotation ändert die fachliche Bindingrevision nicht. Wiederverbundene abgebrochene Jobs können fortgesetzt werden, endgültig fehlgeschlagene Jobs werden nicht durch jeden Listenabruf neu gestartet. Das tägliche Attempt-Budget ist atomar und bleibt bei Toggle/Modellwechsel erhalten.

Die Registry verwendet bestehende Nutzer-/Workspace-Autorisierung und löst Owner und lokale/verwaltete Quelle serverseitig auf. Aktuelle gespeicherte Senderpolicies haben Vorrang vor einem zwischenzeitlich veralteten Katalog. Persönliche UI-Leserechte und eingeschränkte Hintergrund-AI werden getrennt behandelt. IMAP erfordert UIDVALIDITY/UID/Ordner; synthetische Google-/Microsoft-`isAnswered:false`-Werte bleiben unbekannt.

Ein separater Evaluation-Fingerprint erlaubt die Wiederverwendung gültiger Rohbewertungen nach Aus-/Einschalten und Änderungen an Laufzeitlimits. Modell, Endpoint, Schema und fachliche Kriterien sind Bestandteil dieses Fingerprints; reine manuelle Korrekturen erzeugen keine Modellbewertung.

Geprüft am 2026-10-06: neue Identitäts-/Configtests, PGlite-Storetests, bestehende Workspace-Mailmigration, Personal-Boundary- und Mailbox-/Mutations-/AI-Actor-/Tool-/Attachmenttests bestanden. Zusätzlich native PostgreSQL 18 mit unabhängigen Sessions: Settings- und Fokus-CAS, exklusive Claims, Tagescap, verspäteter Sync und Abschalten vor Ergebnisübernahme bestanden. Das eigene temporäre Schema wurde anschließend entfernt; bestehende Daten blieben außerhalb dieses Schemas. Nach der Fingerprint-Ergänzung wurden die neuen Tests, native PostgreSQL-Prüfung, scoped ESLint und globale Typeprüfung erfolgreich wiederholt. GitNexus Scopeprüfung: 15 erwartete Dateien, keine fremden Produktabläufe.
