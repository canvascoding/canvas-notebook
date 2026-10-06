# E-Mail-Klassifizierung und Fokus: Umsetzungsnachweis

Branch: `codex/email-classification-plan`. Grundlage: `email-classification-harness-plan.md`.
Der Nutzer hat Umsetzung und Playwright freigegeben und Mailpit für lokale Mailtests vorgegeben. Container werden nur bei gesondertem ausdrücklichem Auftrag gebaut.

## Sequenzielle Phasen

- [x] 1. Decision-Vertrag, Providerfähigkeiten, Vier-Felder-Schema, deterministische Policy und versionierte synthetische Evaluation.
- [x] 2. PostgreSQL-Persistenz, Settingsrevision, lokale/verwaltete Mailboxidentität, unabhängiger Metadatenindex, Jobs/Leases, Korrekturen und persönlicher Fokuszustand.
- [x] 3. Zentrale System-Credentials, Admin-Settings/Availability, Provider-Vertragsabnahme und Limits/Abbruch.
- [x] 4. Hintergrund-Synchronisation/Klassifizierung, vollständiger autorisierter Gesamtfeed, Paging/Ranking, Cache-Anreicherung und Lifecycleinvalidierung.
- [ ] 5. Adminoberfläche und sichere Secrets-Anbindung.
- [ ] 6. Fokus/Klassisch, Alle/Einzel/Persönlich/Arbeit, Progressive Disclosure, Herkunft bei Mailaktionen und persönliche Erledigung.
- [ ] 7. Qualitäts-/Recovery-Dokumentation, relevante Regressionsprüfungen, Typecheck/Lint/Build und abschließende E2E-/UI-Abnahme.

## Abschlussanforderungen

| Anforderung | Autoritativer Nachweis | Status |
| --- | --- | --- |
| Austauschbare Decision-Provider ohne Mail-/DB-Wissen | `npm run test:decision-models`; TypeSafe und kompatibler Adapter, unabhängige Registry | Phase 1 geprüft |
| Vier Felder und echte Wahrscheinlichkeiten, unbekannt ungleich null Prozent | `npm run test:email:classification:policy`; Choice-Verteilungen getrennt von Provider-Confidence | Phase 1 geprüft |
| Zentraler Adminschalter, standardmäßig aus, keine persönlichen AI-Schalter | Admin-/Availability-/Worker-Tests und Browser | API geprüft; Worker/UI offen |
| System-Secrets ohne Prozess-/Userfallback | Credential-/Route-Tests, Secrets-UI | Backend geprüft; Secrets-UI offen |
| Sichere dauerhafte Persistenz, Leases/Revisionen/Toggle-Rennen | PGlite mit echter Startupmigration und zusätzliche PostgreSQL-18-Prüfung über unabhängige Sessions in eigenem temporärem Schema | Phase 2 geprüft; API-Anschluss offen |
| Persönliche/Workspace-Rechte samt Senderpolicy auch bei Cachetreffer | Feed-/Boundary-/Revocation-Tests | Backend geprüft; UI offen |
| Lokale und verwaltete persönliche, vorhandene gemeinsame Postfächer | Registry-/Service-/Feedtests | Backend geprüft; reale lokale Abnahme offen |
| Metadatensync unabhängig von AI; Verarbeitung bei geschlossenem Browser | Scheduler-/Worker-/Restarttests | Worker/Runtime geprüft; laufender Host offen |
| Batch-Anreicherung ohne AI im Read-Pfad und ohne verlorene Korrekturen | Cache-/Enrichmenttests | Backend geprüft |
| Globales Ranking über synchronisierten Bestand, stabile Cursor und ehrliche Coverage | Mehrseitige Feedtests | Backend geprüft; UI offen |
| Fokus/Klassisch und alle Postfachscopes, gespeicherte Moduswahl | Browser-E2E samt Reload und zentralem Toggle | Offen |
| Mailaktionen/Anhänge/Absender verwenden Herkunft der gewählten Mail | Browser-/Route-Tests mit gleichen IDs in verschiedenen Postfächern | Offen |
| Unbewertete/unsichere/gestörte Quellen sichtbar, Prozentdetails bei Bedarf | Responsive Browser-E2E | Offen |
| Persönliches Erledigen/Undo schließt keinen Team-Case | Store-/Policy-/Browserprüfungen | Offen |
| Compose/Review, Sendefehler und unklarer Versandstatus bleiben erhalten | Bestehende und neue Mail-/Reviewregressionen | Offen |
| Keine springende Liste oder verlorenen Entwürfe bei Scope-/Moduswechsel | Browser-E2E | Offen |
| Typecheck, relevante Lints, Produktionsbuild | Aktuelle Command-Ergebnisse | Offen |
| Abschließender E2E-Test mit visueller Prüfung Desktop/Mobile | Aktueller Playwright-Report und Screenshots | Offen |
| Lokale echte Mailtests mit Mailpit | SMTP-Eingang, Notebook-Abruf/Klassifizierung und Antwort an Mailpit | Offen |
| Reale Jev-Anbindung | Synthetischer Providerrequest mit zentral konfiguriertem User-Key | Key als Desktop-Datei bereitgestellt; Import und Request offen |

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

## Phase 3: Ergebnisse

Provider-Credentials stammen ausschließlich aus zentralen System-Secrets. Fehlende, nicht lesbare oder ungültige Keys sind unterscheidbare sichere Statuswerte; Keys erscheinen weder in DTOs noch Auditdaten. Nur ein bewusst ohne Credential konfigurierter kompatibler privater Endpoint kann anonym genutzt werden. TypeSafe-Keys sind der bestehenden Integrationskategorie zugeordnet (GitNexus LOW, ein direkter Aufrufer).

Die neuen Settings- und Testrouten verlangen Instanzadminrechte, vertrauenswürdigen Mutation-Origin und verifizierte Sessionidentität für Rate Limits. Settingsänderungen verwenden den atomaren Store-CAS. Der Test nutzt ausschließlich eine serverseitige Beispielmail, darf vor Aktivierung stattfinden und bestätigt keine Spamqualität. Die öffentliche Availability liefert fünf sichere Statusfelder und führt nur einen Tagesbudget-Lookup aus; umfangreiche Bestandsstatistiken gehören zur Adminabfrage. Vorbereitete Fokusdaten bleiben bei Budget-/Providerstörungen nutzbar.

Geprüft am 2026-10-06: Adminservice-Test mit echten PGlite-CAS/Jobs/Budget/Ergebnissen, Routetests mit echten Admin-/Originhelpers, bestehende Secrets-Store/-API- und Settings-ENV-UI-Tests, Decision-Harness/Policy-Tests sowie scoped ESLint und globale Typeprüfung bestanden. Reale Jev-Anfragen und Browserabnahme bleiben offen. Branch-Scopeprüfung erfolgt vor dem Phasencommit.

## Phase 4: Ergebnisse

Der ausdrücklich gestartete Host-Runtime synchronisiert Metadaten unabhängig vom KI-Schalter. Discovery ist auf mindestens 60 Sekunden begrenzt; Inhaltsabruf, Modellaufruf und Ergebnisübernahme verwenden aktuelle Actor-/Owner-/Source-/Policy-Prüfungen. Persistente Sync-Leases und globale Jobslots/Tageslimits verhindern Doppelarbeit. Claim-Zeitpunkte verteilen Arbeit auch bei Parallelität eins zwischen Postfächern. Wiederholungen sind begrenzt; Rate-Limit/Timeout, Abbruch und Provider-Circuit-Breaker bleiben außerhalb des normalen Mailabrufs.

Echte paginierte Inboxscans speichern einen Generationstand. Nur ein bestätigter vollständiger Scan entfernt extern archivierte Nachrichten aus der Inbox-Projektion; begrenzte oder unbestätigte Scans bleiben ausdrücklich teilweise abgedeckt. Historienauswahl zählt verschiedene Referenzen und bleibt nach Änderungen reiner Laufzeitlimits wieder einreihbar. Ein echter Server-/Account-/Providerwechsel entfernt alte Metadaten und deren Referenzen, damit wiederverwendete IMAP-IDs keine alten Korrekturen erben. Reine Binding-/Policyänderungen behalten gültige Inhalte und manuelle Korrekturen.

Der Gesamtfeed verwendet die ganze autorisierte Inbox-Union für SQL-Ranking und Zähler. SQL-Projektion und deterministische TypeScript-Policy sind durch Oraclefälle miteinander verglichen. Actorgebundene kurze Snapshots frieren Reihenfolge und kompakte Zeilendaten ein; neue Ratings erzeugen `hasUpdates`, ohne laufende Pagination umzubauen. Rechteentzug, Archivieren und Quellenwechsel wirken trotzdem vor jeder Ausgabe. Detail-/Korrektur-/persönliche-Fokus-Routen verwenden aktuelle Berechtigungen und Versionsprüfungen. Persönliches Erledigen schließt keinen Workspace-Case.

Alle lokalen/verwalteten List-/Such-/Detailzweige ergänzen Bewertungen nach dem Cache mit einem Batch-Join. Registrierung und Indexwrites laufen nach der Antwort, ohne Modellaufruf im Lesepfad. Lifecycle-Hooks folgen erfolgreichen Provideraktionen; eine gestörte Klassifizierungsdatenbank spielt Versand oder Mailaktionen nicht erneut ab. Unbekannte Antwortflags überschreiben keinen belegten Antwortstatus, und ein unbekannter Ordner ist kein Inboxnachweis.

Geprüft am 2026-10-06: Index-, Worker-, Feed-/State-/Routen-, Enrichment-, Lifecycle- und Rebindtests mit PGlite bestanden; zusätzlich bestehende Mailbox-/Actor-/Tool-/Attachmentregressionen. Native PostgreSQL 18 mit getrennten Sessions bestätigt globale Parallelität eins bei freiem Tagesbudget sowie exklusive Sync-Leases. Globale Typeprüfung, scoped ESLint, Serversyntax sowie Startup-Ownership, Memory-Scheduling und Session-Cleanup bestanden. Die isolierte Startupfixture benötigte drei fehlende Mock-/Globalzeilen für bereits im Ausgangsstand vorhandene Abhängigkeiten; Assertions und Produktstartup blieben unverändert. Alle laufenden Host-/UI-Abnahmen, Mailpit und echte Modellrequests bleiben offen. GitNexus und staged Diffcheck werden vor dem Phasencommit ausgeführt.
