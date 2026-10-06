# E-Mail-Klassifizierung und Fokus: Umsetzungsnachweis

Branch: `codex/email-classification-plan`. Grundlage: `email-classification-harness-plan.md`.
Der Nutzer hat Umsetzung und Playwright freigegeben und Mailpit für lokale Mailtests vorgegeben. Container werden nur bei gesondertem ausdrücklichem Auftrag gebaut.

## Sequenzielle Phasen

- [x] 1. Decision-Vertrag, Providerfähigkeiten, Vier-Felder-Schema, deterministische Policy und versionierte synthetische Evaluation.
- [x] 2. PostgreSQL-Persistenz, Settingsrevision, lokale/verwaltete Mailboxidentität, unabhängiger Metadatenindex, Jobs/Leases, Korrekturen und persönlicher Fokuszustand.
- [x] 3. Zentrale System-Credentials, Admin-Settings/Availability, Provider-Vertragsabnahme und Limits/Abbruch.
- [x] 4. Hintergrund-Synchronisation/Klassifizierung, vollständiger autorisierter Gesamtfeed, Paging/Ranking, Cache-Anreicherung und Lifecycleinvalidierung.
- [x] 5. Adminoberfläche und sichere Secrets-Anbindung.
- [x] 6. Fokus/Klassisch, Alle/Einzel/Persönlich/Arbeit, Progressive Disclosure, Herkunft bei Mailaktionen und persönliche Erledigung.
- [x] 7. Qualitäts-/Recovery-Dokumentation, relevante Regressionsprüfungen, Typecheck/Lint/Build und abschließende E2E-/UI-Abnahme.

## Abschlussanforderungen

| Anforderung | Autoritativer Nachweis | Status |
| --- | --- | --- |
| Austauschbare Decision-Provider ohne Mail-/DB-Wissen | `npm run test:decision-models`; TypeSafe und kompatibler Adapter, unabhängige Registry | Phase 1 geprüft |
| Vier Felder und echte Wahrscheinlichkeiten, unbekannt ungleich null Prozent | `npm run test:email:classification:policy`; Choice-Verteilungen getrennt von Provider-Confidence | Phase 1 geprüft |
| Zentraler Adminschalter, standardmäßig aus, keine persönlichen AI-Schalter | Admin-/Availability-/Worker-Tests und Browser | API, Worker und Admin-UI geprüft |
| System-Secrets ohne Prozess-/Userfallback | Credential-/Route-Tests, Secrets-UI | System-API, sicherer UI-Status und Secrets-Link geprüft |
| Sichere dauerhafte Persistenz, Leases/Revisionen/Toggle-Rennen | PGlite mit echter Startupmigration und zusätzliche PostgreSQL-18-Prüfung über unabhängige Sessions in eigenem temporärem Schema | Persistenz, APIs und aktuelle UI-Anbindung geprüft |
| Persönliche/Workspace-Rechte samt Senderpolicy auch bei Cachetreffer | Feed-/Boundary-/Revocation-Tests | Backend-/UI-Verträge und reale Readonly-Abnahme bestanden |
| Lokale und verwaltete persönliche, vorhandene gemeinsame Postfächer | Registry-/Service-/Feedtests | Registry-/Serviceverträge geprüft; reale lokale SMTP/IMAP-Abnahme bestanden; verwalteter externer Dienst nicht live geprüft |
| Metadatensync unabhängig von AI; Verarbeitung bei geschlossenem Browser | Scheduler-/Worker-/Restarttests | Worker/Runtime und echter Host mit sieben Jev-Testmails geprüft |
| Batch-Anreicherung ohne AI im Read-Pfad und ohne verlorene Korrekturen | Cache-/Enrichmenttests | Backend geprüft |
| Globales Ranking über synchronisierten Bestand, stabile Cursor und ehrliche Coverage | Mehrseitige Feedtests | Backend und UI-Hook geprüft; echter Fokusfeed sichtbar |
| Fokus/Klassisch und alle Postfachscopes, gespeicherte Moduswahl | Browser-E2E samt Reload und zentralem Toggle | Reale E2E mit Scopes, Reload, gespeichertem Modus und zentralem Toggle bestanden |
| Mailaktionen/Anhänge/Absender verwenden Herkunft der gewählten Mail | Browser-/Route-Tests mit gleichen IDs in verschiedenen Postfächern | Reale kollidierende UIDs, Arbeits-Anhang und festgehaltener Reply-Absender bestanden |
| Unbewertete/unsichere/gestörte Quellen sichtbar, Prozentdetails bei Bedarf | UI-/Hook-Tests und responsive reale Browserabnahme | Sichere Fehler-/Unknown-Verträge geprüft; reale Review-/Detailsansicht und internes Scrollen bestanden |
| Persönliches Erledigen/Undo schließt keinen Team-Case | Store-/Policy-/Browserprüfungen | Readonly-Done/Undo, getrennte Administratoransicht und verweigerte Korrektur bestanden |
| Compose/Review, Sendefehler und unklarer Versandstatus bleiben erhalten | Bestehende und neue Mail-/Reviewregressionen | Source-/Dialog-/Reviewregressionen und echter Reply-Versand bestanden |
| Keine springende Liste oder verlorenen Entwürfe bei Scope-/Moduswechsel | Hook-/Composerregression und Browser-E2E | Snapshot-/Paging-/Sessionrennen geprüft; minimierter tatsächlicher Reply-Entwurf erhalten |
| Typecheck, relevante Lints, Produktionsbuild | Aktuelle Command-Ergebnisse | Bestanden; Produktionsbuild meldet 47 dynamische Dateipfad-/Tracingwarnungen |
| Abschließender E2E-Test mit visueller Prüfung Desktop/Mobile | Aktueller Playwright-Report und Screenshots | Drei reale Fälle gegen finalen Produktionsbuild, 54,1 Sekunden; Screenshots geprüft |
| Lokale echte Mailtests mit Mailpit | SMTP-Eingang, Notebook-Abruf/Klassifizierung und Antwort an Mailpit | CA-geprüftes STARTTLS, echter Eingang/IMAP, Anhang-Download und Reply-Inhalt bestanden |
| Reale Jev-Anbindung | Synthetischer Providerrequest mit zentral konfiguriertem User-Key | System-Key importiert; API-/UI-Probe und sieben echte lokale Mailbewertungen erfolgreich |

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

Live-Nachprüfung mit Mailpit/GreenMail: Der persönliche Metadatenscan verwendete zunächst die engeren KI-Leseregeln und meldete dadurch einen leeren, vollständigen Index. Der Scan folgt jetzt der menschlichen Sichtbarkeit; Workspace-Senderregeln und KI-Sender-/Body-Prüfungen bleiben erhalten. Der Regressionstest ruft die tatsächlichen List-/Read-Adapter auf und bestätigt sichtbare unbewertete persönliche Mails ohne Body-/Modellaufruf. Nach Host-Neustart wurden alle sieben synthetischen Testmails aus drei Quellen bei geschlossenem Browser mit dem echten Jev bewertet; drei Quellen vollständig erfasst, null ausstehende/fehlgeschlagene Aufträge. Worker-Test, scoped ESLint und globale Typeprüfung bestanden. Ein realer Request ist weiterhin keine statistische Kalibrierung.

## Phase 5: Ergebnisse

Die Karte im bestehenden E-Mail-Einstellungstab ist ausschließlich für Instanzadministratoren eingebunden. Der zentrale Schalter steht außerhalb der eingeklappten Anbieter-/Konfigurationsfelder; Limits, Kontext/Kriterien, Schwellen und Laufzeitstatistik sind weitere Details. Der Status benennt Aktivierung und gestörte Verarbeitung getrennt. Credentialwerte werden nie geladen oder angezeigt; Schlüsselname, Systemstatus und Link zur bestehenden Secrets-Verwaltung reichen aus. Die feste Beispielmail darf bei deaktivierter Verarbeitung und mit ungespeichertem Entwurf getestet werden.

Settings-CAS hält fremde Änderungen und lokale Entwürfe getrennt. Ein später Secrets-Refresh ersetzt keine Eingabe; Konflikte verlangen bewusstes Neuladen. Fehlermeldungen sind sichere deutsche/englische Texte. Das erfolgreiche Save-Event enthält nur enabled/revision. Eine kostenlose Kalibrierungsfreigabe wird nicht angeboten.

Geprüft am 2026-10-06: `npm run test:email:classification:settings-ui`, scoped ESLint und globale Typeprüfung bestanden. Echter Browser mit Bootstrapadmin: Karte, eingeklappte Details, System-Key-Status, Jev-Beispielrequest und zentrales Speichern bestanden; Screenshots Desktop hell/dunkel und Mobile visuell geprüft, 390px ohne horizontalen Überlauf und ohne Pageerrors. Normaler bestehender Testnutzer sieht die Karte nicht und erhält auf der Adminroute 403. Lokale native Mailpit-/GreenMail-Kette verwendet CA-geprüftes STARTTLS und IMAP; kein neuer Container wurde gebaut. Der zentrale KI-Schalter wurde nach diesem Prüfschritt wieder deaktiviert; Ratings bleiben gespeichert. Fokus-UX, echter Antwortversand und abschließende E2E-Abnahme bleiben offen.


## Phase 6: Ergebnisse

Der zentrale Schalter aktiviert standardmäßig Fokus; die persönliche Moduswahl speichert ausschließlich Fokus/Klassisch. Alle, Persönlich, Arbeit und einzelne aktuelle Postfächer verwenden einen autorisierten Quellkatalog. Fokus zeigt wichtige bzw. beantwortungsbedürftige Nachrichten zuerst; Noch prüfen und Noch nicht vorbereitet bleiben direkt erreichbar, alle Nachrichten und weitere Kategorien sind bewusst zugänglich. Suchumfang und Indexabdeckung werden ehrlich benannt. Einzel-Klassisch erhält die vollständige bestehende Ordner-/Anbietersuche. Der alte Layout-Fokus heißt jetzt Ablenkungsfrei.

Die gemeinsame Liste nutzt unverwechselbare Mailbox-/Nachrichtenreferenzen. Öffnen aktiviert die tatsächliche Quelle für Body, Anhänge und Aktionen; schnelle Auswahl, verspätetes Mark-read, Rechteentzug und Quellenwechsel sind abgegrenzt. Die explizite Detailauswahl wird nicht durch eine unabhängige Hintergrundmutation verworfen. Tool-Suchintents wechseln in das passende einzelne klassische Postfach und erhalten ihren Zielordner. Gleichbleibende Snapshots verhindern springende Reihenfolgen; neue Ratings verlangen eine bewusst angewendete Aktualisierung.

Die Bewertung steht kompakt über der Nachricht. Wahrscheinlichkeiten, Verteilungen und Korrekturen werden erst aufgeklappt; fehlende Werte bleiben unbekannt. Persönliches Erledigen/Undo ist von Mail-Read/Answered und Workspace-Cases getrennt. Korrekturen prüfen aktuelle Schreibrechte und Versionen. Entwürfe pinnen Absender und Attachment-Workspace, lassen sich minimieren und wieder öffnen und bleiben auch bei letzter entfernter Quelle zugänglich; Versand/AI sind dann gesperrt. Unklarer Versandstatus öffnet ohne belegte Draft-ID nur die vorhandene Reviewübersicht.

Geprüft am 2026-10-06: Experience-/Preferences-/Katalogtest, Focus-Hook-/DOM-Test, Composer-Source-/Dialogtests, Feedtests und aktualisierter Context-Intent-Test bestanden. Die bestehende Playwright-Such-/Layoutserie bestand mit sieben Fällen; deren kontrollierte Legacy-Fixture ist vom aktuellen zentralen KI-Status unabhängig. Echter Jev-Feed zeigt sieben lokale synthetische E-Mails aus drei Quellen, zwei im Fokus und eine unter Noch prüfen. Arbeitsmail und persönliche Mail mit kollidierenden IMAP-IDs öffnen die jeweilige echte Quelle. Ratings aufklappbar, Desktop hell/dunkel sowie Mobile 390px visuell geprüft, kein horizontaler Überlauf und keine Pageerrors.

Die letzte Read-only-Prüfung fand und schloss sechs konkrete Übergangsfehler (Sourcewechsel, spät geladene Ordner, Detail-Mutation-Fence, entfernte Composerrechte, ignorierte Tool-Suche, unerreichbarer Entwurf ohne Konten). Reale Antwort, Anhang-Download, Readonly-Done, zentraler Toggle/Reload, vollständiger Build und abschließende E2E bleiben Phase 7.


## Phase 7: Abschluss

Deutsch/englische Nutzer- und Adminanleitungen beschreiben Fokus/Klassisch, Bereiche, progressive Details, unbekannte Prozentwerte, persönliche Erledigung, System-Secrets und festgehaltene Entwürfe. Die Betriebs-/Recovery-Dokumentation trennt Metadatenabdeckung von historischen KI-Limits, Providervertrag von Qualitätsmessung sowie Raw-Wiederverwendung von fachlicher Neuklassifizierung. Die technischen Kalibrierungsfelder sind kein Nachweis; automatische Spam-Ausblendung bleibt ohne geprüften Bericht gesperrt.

Die reale Versandprüfung deckte einen fehlenden Antwort-Lifecycle auf. Bestätigter Reply/Reply-all erfasst jetzt die ursprüngliche aktuelle Quelle, verwendet einen passenden eingefrorenen IMAP-Verbindungsstand und schreibt einen revisionsgebundenen lokalen Beleg für die indexierte Originalnachricht. Nachgelagerte Flag-/DB-Fehler verwandeln eine bestätigte Zustellung nicht in einen Wiederholungsfehler. Weiterleitungen, Entwürfe, Fehlschläge und unklare Zustellungen erzeugen keinen Beleg. Additive `accepted_reply_at`-Persistenz übersteht widersprechende Providerflags ohne unnötige Indexrevisionen; explizites Clear-answered setzt sie zurück. Rebind, Binding/Policywechsel und Rechteentzug sind gesondert geprüft.

Die letzte visuelle Prüfung fand einen überfüllten Reader bei erweiterten Bewertungen. Der Bewertungsbereich ist nun separat scrollbar und auf höchstens die halbe Readerhöhe begrenzt; der E-Mail-Text bleibt darunter sichtbar. Der finale reale E2E prüft diese Geometrie auf Desktop und Mobile, erreicht den Readonly-Hinweis durch tatsächliches internes Scrollen und benutzt Done ohne erzwungenen Klick.

Aktuelle Prüfungen am 2026-10-06: globaler Typecheck, relevante ESLints, neuer Accepted-Reply-Test, bestehende Store-/Cache-/IMAPreferenz-, Review-/Mailbox-/Actor-/Tool-/Attachment-, Inbox-Flow-, Focus-UI- und Context-Intent-Prüfungen bestanden. Die Legacy-Such-/Layoutserie bestand mit sieben Playwrightfällen. Vollständiges `npm run build` mit `NODE_ENV=production` bestand einschließlich Lizenzgate und TypeScript; 47 Warnungen zu dynamischen Dateipfaden/Tracing verbleiben. Frühere ungültige ENV-/Typversuche zählen nicht als erfolgreiche Builds.

Abschließender Lauf: `E2E_EXTERNAL_SERVER=1 CANVAS_EMAIL_CLASSIFICATION_FIXTURE_FILE=<privater Fixturepfad> npx playwright test tests/email-classification-local.spec.ts --workers=1 --reporter=line` gegen den finalen lokalen Produktionsbuild: **3 bestanden, 54,1 Sekunden**. Keine Core-Mail-/Klassifizierungs-/Settings-/Preferences-Interceptions. Nachgewiesen: alle und einzelne persönliche/Arbeitsbereiche, gespeicherter Modus, zentral aus/ein mit gleichen Ratings, gleiche IMAP-UIDs in zwei echten Quellen, tatsächlicher Arbeits-Anhang-Download, minimierter Reply-Entwurf mit festem Absender, expliziter Versand mit From/To/Inhalt in Mailpit, tatsächlich gesetztes IMAP-Answered, Readonly-Done/Undo ohne Änderung des Administratorzustands und Korrektur-403. Desktop hell/dunkel und Mobile hell/dunkel sind visuell geprüft.

Lokale eigene Testressourcen anschließend entfernt: zwei persönliche Testaccounts, ein Arbeits-Testaccount, sein Workspace und ausschließlich dessen Nur-Lese-Mitgliedschaft. Vorhandene persönliche und Arbeitsaccounts bleiben bestehen. KI-Schalter wieder deaktiviert, ursprüngliche persönliche Moduswahl zurückgesetzt; der autorisiert importierte Jev-Schlüssel bleibt als konfiguriertes System-Secret erhalten. Eigener Notebook-Testserver und native Mailpit-/GreenMail-Prozesse beendet, getestete Ports frei; vorhandener Control-Plane-/PostgreSQL-Stack und anderer SMTP-Prozess unberührt. Nachweise und Screenshots liegen privat unter `~/.local/state/canvas-local-team-seat/email-classification-test/final-e2e/`, Build-/Cleanupnachweis im übergeordneten Testverzeichnis.

Keine Container gebaut, kein Push/PR/Release und keine Produktionsbereitstellung. Reale Jev-Funktionalität sowie lokales SMTP/IMAP sind geprüft; ein echtes alternatives Open-Source-Modell und ein verwalteter externer Maildienst wurden nicht live getestet. Die synthetischen Mails sind weiterhin kein Spam-Kalibrierungsnachweis.
