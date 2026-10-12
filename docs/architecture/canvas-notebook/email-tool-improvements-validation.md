# E-Mail-Verbesserungen: Implementierungsvalidierung

Stand: 9. Oktober 2026. Lokale Implementierung, Datenbank-/Browserprüfungen und
Produktionsabnahme werden getrennt dokumentiert.

## Schritt 1: Unicode-Erfassung

Die Normalisierung repariert beschädigten Unicode, entfernt Nullzeichen und hält
die bisherigen Feldgrenzen ein, ohne vollständige Zeichenpaare zu zertrennen.
Abgedeckt sind Absender, Betreff, Datum, Vorschau, To/Cc und Thread-ID.
Die ursprünglichen Provider-Metadaten werden dabei nicht verändert.

Bestandene Prüfungen:

- Store-Suite mit PGlite und gemeinsamer Matrix: 13 Fälle für alle sieben
  Textpfade, tatsächliche JSONB-Speicherung, optionaler/null Thread-Zustand,
  Empfängergrenze, idempotente Wiederholung und anschließender Folgeeintrag.
- Native PostgreSQL-18-Suite gegen ein eigenes temporäres Schema im vorhandenen
  verwalteten Testdienst; das Schema wird nach der Prüfung entfernt.
- Worker-Suite mit tatsächlichem JSONB-Fehler mitten in einer Seite: gespeicherter
  Cursor und letzter erfolgreicher Scan bleiben erhalten, der Cooldown wird
  eingehalten, Wiederholung erfasst schließlich 125 eindeutige Nachrichten.
  Modell-, Inhalt- und Credential-Aufrufe bleiben in dieser deaktivierten
  Vorbereitung bei null.
- Fokussiertes ESLint für die geänderten Store-/Testdateien.
- TypeScript-Prüfung des Gesamtprojekts.

Der GitNexus-Index wurde nach einem gescheiterten inkrementellen Lauf vollständig
neu aufgebaut. Die erneute Analyse des Worker-Testaufrufers ist LOW; der Store-
Speicherpfad ist MEDIUM. Das ist keine Produktions- oder Liveprovider-Abnahme.

Die zuvor in Produktionslogs beobachtete Störung bleibt bis zum Rollout und
einer erfolgreichen Erfassung der betroffenen Postfächer produktiv offen.

## Schritt 2: Sichere, getrennte Fehlerdiagnose

Postfacherfassung speichert ausschließlich sechs erlaubte Fehlercodes. Die
additive Migration begrenzt sie auch auf Datenbankebene. Erfolgreiche Erfassung
sowie Quellen-/Rechteänderungen löschen den alten Grund; letzte erfolgreiche
Erfassung und Wiederaufnahmecursor bleiben bei Fehlern erhalten. Die Feed-Coverage
liefert Namen und Diagnosen nur für aktuell freigegebene Quellen. KI-Bewertungen
behalten eigene pending/failed/stale-Zähler.

Native PostgreSQL-18-Prüfung bestanden: alle sechs Codes, Ablehnung eines freien
Fehlertextes, Schema-Upgrade zweimal, veraltete Quellenrevision, fremde Lease,
gültige Lease, erfolgreicher Wiederholungslauf und Löschen des Fehlergrunds.
Das eigene temporäre Schema wurde entfernt. Gesamt-TypeScript und fokussiertes
ESLint für diese PostgreSQL-Prüfung sind bestanden.

`auth_required` bedeutet Zugang/Verbindung prüfen. Es kann auch einen
Managed-Zugang betreffen und behauptet deshalb keine bestimmte OAuth-Ursache.

Store-, Worker- und Feed-Suites sowie fokussiertes ESLint sind bestanden. Die
Feed-Prüfung deckt leere fehlerhafte Quellen, Berechtigungsentzug während eines
Requests und Aktualisierungshinweise bei geändertem Erfassungsgrund sowie
`pending` -> `failed` eines aktuellen KI-Jobs ab. Snapshot-Reihenfolge bleibt bis
zum bewussten Neuladen stabil. Frische unabhängige Quellprüfung ohne Blocker.

## Schritt 3: Postfachbezogene Warnungen und Aktionen

Eine aufklappbare Zusammenfassung nennt betroffene Postfächer, ihren sicheren
Erfassungsgrund und letzte bestätigte Erfassung. Ausstehende, fehlgeschlagene und
veraltete KI-Bewertungen stehen getrennt daneben. Die aktuelle Quellenliste
entfernt Angaben zu entzogenen Postfächern und begrenzt Verwaltungsaktionen.

Klassisch öffnet das ausgewählte persönliche oder Arbeitspostfach in INBOX;
alte Suche, Filter und Seiten werden zurückgesetzt, laufende Requests beendet
und ein vorhandener Entwurf minimiert. Quellen ohne aktuellen Kontoeintrag
führen zur erneuten Zugriffsprüfung. Neuladen lädt ausschließlich die Ansicht.

Focus-UI-/Experience-Suites, Gesamt-TypeScript und fokussiertes ESLint bestanden.
Frische unabhängige Prüfung ohne verbleibenden Funktions-/Zugriffsbefund.
GitNexus meldet HIGH für Navigation/Client wegen der Einbindung in E-Mail-Seite
und DashboardShell; diese Reichweite wurde vor der Änderung angekündigt.

Browser-Komponentenabnahme: 40 Zustandsfälle in EN/DE, Desktop 1280/Mobil 390,
hell/dunkel bestanden. Ein echter Schnitt bei 400 Pixeln Pane-Höhe wurde behoben;
drei gezielte Nachprüfungen mit neuem Bundle/CSS sind bestanden. Neuladen ist
innerhalb der Pane erreichbar; die verbleibende Nachrichtenfläche ist 58 Pixel
hoch und eine Zeile wurde mit normalem Mausklick geöffnet. Der Browser wurde
geschlossen. Tatsächliche Komponenten, NextIntl und App-CSS mit isolierten
synthetischen Daten; Aktionen führen zu Fixture-Callbacks. Das belegt keine
Voll-App-, Login-, Provider- oder Produktionsjourney.

- [Persönlich/Arbeit, DE/Mobil/dunkel](email-tool-improvements/evidence/postfix-de-mobile-dark-auth-personal-work.png)
- [Erfassung bestätigt, KI fehlgeschlagen](email-tool-improvements/evidence/postfix-de-desktop-light-complete-failed-ai.png)
- [Kurze Pane nach Layoutkorrektur](email-tool-improvements/evidence/postfix-en-mobile-light-short-pane-400.png)

## Schritt 4: Einrichtung und Aktivierung

Die Admin-Karte zeigt vier sichtbare Schritte: Bereitstellung, Modell/Zugang,
ausdrücklicher synthetischer Test, Aktivierung/Speichern. Direktbetrieb nennt den
tatsächlichen Schlüsselnamen und System-Secrets; verwalteter Betrieb verweist für
Zugang, Modellfreigabe, zentrale Credentials, Preise und Budget auf den Control
Plane. Jev wird als bestehender API-Bewertungsdienst erklärt. Ein bestandener
Beispieltest bestätigt Verbindung/Antwortvertrag, keine Sortierqualität.

Gespeicherte Aktivierung, ungeprüfter Entwurf und Verarbeitungsbereitschaft sind
getrennt. Budgetpause bleibt eine Pause, obwohl Focus mit vorhandenen Ergebnissen
verfügbar ist. Ein neuer Modellentwurf erbt keine Störung des alten Modells.
Secrets-Änderung entfernt einen alten Testbeleg; späte Antworten eines zuvor
gestarteten Tests können ihn nicht wiederherstellen. Konfigurationsänderung und
Speichern starten keinen Beispieltest.

Die öffentliche Availability-Route liefert `canConfigure` nach derselben
serverseitigen Adminprüfung wie Settings, einschließlich Bootstrap-Admins.
Organisationsbesitz oder Query-Hinweise verleihen keine Instanzrechte.
Der Einrichtungslink ist auch bei deaktiviertem Focus erreichbar. Normale Nutzer
erhalten bei relevanter Verarbeitungsstörung einen Adminhinweis.

Bestanden: Routes-/Focus-UI-/Admin-Service-Suites, Gesamt-TypeScript und
fokussiertes ESLint für die Root-Änderungen. Die Admin-Service-Suite prüft weiterhin
System-Credentials, CAS und synthetische Tests ohne Mailzugriff.

Settings-UI-Suite und ESLint des Einrichtungspatches bestanden; unabhängige
Quellprüfung ohne offene Befunde. Browser-Komponentenabnahme: 21 Fallgruppen in
DE 390 hell/dunkel und EN 1280 hell, sechs visuell geprüfte Screenshots, keine
Layout-/Runtimefehler. Je Viewport exakt zwei GETs, zwei Saves und ein ausdrücklich
angestoßener synthetischer Probe-POST, keine unerwarteten Requests. Budgetpause
trotz `available=true` und Secrets-Ereignis ohne Ersatztest zusätzlich geprüft.
Browser geschlossen; reine synthetische Fixture, keine echten Provideraufrufe,
keine Voll-App-/Produktionsabnahme.

- [Normalnutzer bei Bewertungsstörung](email-tool-improvements/evidence/de-390-dark-member-outage.png)
- [Zentrale Managed-Zugangsdaten](email-tool-improvements/evidence/de-390-light-managed-credentials.png)
- [Aussage des synthetischen Tests](email-tool-improvements/evidence/en-1280-light-explicit-synthetic-probe.png)

## Schritt 5: Zahlen, Suchbestand und vollständige Postfächer

Die Zahl heißt „Erfasste Inbox-Mails“ und nennt gewählten Bereich sowie aktive
Such-/Kategoriefilter. Erfassung und KI-Bewertung bleiben getrennt: ausstehende
Bewertungen allein markieren die Erfassung nicht als unvollständig. Ohne
bestätigte scoped Quellenabdeckung erscheint „—“; das gilt auch für Kategorien.
Eine tatsächlich leere berechtigte Quelle darf null zeigen. Entzogene Quellen
verlieren ihre Nachrichtenzeilen, verbleibende Quellen bleiben bedienbar.

Suche benennt den erfassten Inbox-Bestand. „Vollständiges Postfach öffnen“ wählt
in der aggregierten Ansicht ausdrücklich ein lesbares persönliches oder
Arbeitspostfach und öffnet dessen Klassisch-Ansicht mit Ordnern/Anbietersuche.
Der aktuell ausgewählte lesbare Ref lässt sich direkt öffnen. Fehlender oder
unbestätigter Katalog deaktiviert die Aktion; ein entfallener ausgewählter Ref
darf ausschließlich zur Auswahl anderer bestätigter Quellen führen.

Bewertungsauswahl wird getrennt und standardmäßig eingeklappt erklärt: ungelesene
Inbox-Mails unabhängig vom Alter sowie weitere Inbox-Mails im konfigurierten
Rückblick kommen infrage. Es gibt keine Zusage unbegrenzter späterer Verarbeitung.
Klassisch zeigt diese KI-Erklärung nicht.

Bestanden: DE/EN Focus-UI-Suite, Gesamt-TypeScript, fokussiertes ESLint und
unabhängige Quellprüfung. Browser-Komponentenprüfung in vier EN/DE-/Viewport-/
Theme-Kombinationen, plus 320px Pane in DE hell/dunkel. Ein Layoutblocker bei
geöffnetem Bewertungsumfang wurde korrigiert: Nachrichten behalten mindestens
96px; normale Sender- und Row-Center-Mausklicks funktionieren bei gleichzeitig
geöffneten Details. Vier finale Screenshots visuell geprüft, Browser geschlossen.
Keine Appserver-, Container- oder Provideraufrufe; keine Voll-App-Abnahme.

- [2283 als erfasster Bestand](email-tool-improvements/evidence/en-1280-light-captured-inbox-2283.png)
- [Postfachwahl mit langen Bezeichnungen](email-tool-improvements/evidence/de-390-dark-long-mailbox-chooser.png)
- [Kurze Ansicht mit offenem Bewertungsumfang](email-tool-improvements/evidence/de-390-light-short-pane-400-capture-incomplete.png)

## Schritt 6: Abschließende Regressionen und Freigabegrenzen

Am finalen Implementierungsstand `aa4e074bb` sind bestanden:

- `npm run build`, einschließlich Prebuild-Gates und TypeScript.
- Native PostgreSQL-18-Suite mit temporärem Schema und anschließendem Entfernen:
  Unicode-Speicherung, additive Diagnosespalte, Wiederaufnahme, Tagesgrenzen,
  konkurrierende Zugriffe, Leases und veraltete Aktivierungszustände.
- Acht Backend-Suites: Store, Worker, Feed, Routes, Admin, Managed, Index und
  Lifecycle. Diese nutzen isolierte lokale Daten beziehungsweise Provider-Mocks.
- Settings-UI und Focus-UI in DE/EN sowie Gesamt-TypeScript und fokussiertes
  ESLint. Die Browser-Komponentenprüfungen stehen mit ihrem jeweiligen Umfang
  in den Abschnitten oben.
- Frische unabhängige Quellprüfung der gesamten Änderung gegenüber dem
  gemeinsamen Ausgangsstand und dem aktuellen `origin/main`: kein neuer
  konkreter Fehler gefunden.

Die drei bestehenden Voll-App-E2E-Tests wurden an ausgeblendete Modusbuttons und
die neue Bestandsbeschriftung angepasst. ESLint und Playwright-Testauflistung
sind bestanden; die Auflistung ist keine ausgeführte E2E-Abnahme.

Für vollständige Login-/Admin-/Member-Journeys muss ausschließlich der bestehende
Notebook-Testcontainer auf Port 3100 aus diesem Checkout neu gebaut und ersetzt
werden. Der Produktionsbuild als Voraussetzung ist erfüllt. Die ausdrückliche
Containerfreigabe aus `AGENTS.md` steht noch aus; der ältere laufende Container
wird nicht als Nachweis des neuen Quellstands verwendet. PostgreSQL und Control
Plane sollen dabei erhalten bleiben. Ausschließlich eigene synthetische Mails
und ein lokaler Modellstub sind für diese Abnahme vorgesehen.

Produktionsveröffentlichung, Rollout des gemergten Control-Plane-Codes, echte
Providerkonfiguration und tatsächliche zentrale Aktivierung sind nicht erfolgt.
Die produktiv beobachtete Erfassungsstörung bleibt bis zum dortigen erfolgreichen
Wiederholungslauf offen.

Separater bestehender Befund: Scheitert eine Scan-Seite nach bereits gespeicherten
Bewertungsjobs, kann `historicalQueued` beim Wiederholungslauf zu niedrig bleiben.
Dieses Verhalten ist gegenüber dem Ausgangsstand unverändert. Die atomar
gespeicherte Tagesgrenze gilt weiterhin; eine strenge Garantie für den historischen
Batchzähler benötigt eine eigene Korrektur und Abnahme.
