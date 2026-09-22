# Notebook: gemeinsame Queries und stabile Ladezustände

Stand: 2026-09-22. Status: Vier Umsetzungsschritte abgeschlossen;
Regressionstests und Produktionsbuild erfolgreich, Browserabnahme ausstehend.

## Ziel

Navigation von der Startseite zu Chats, Dokumenten und Reviews soll unmittelbar
das angeforderte Ziel zeigen. Bestehende Inhalte bleiben bei Aktualisierungen
sichtbar. Verspätete Antworten dürfen weder eine andere Session/einen anderen
Workspace verändern noch neuere Live-Nachrichten oder lokale Dokumentänderungen
überschreiben.

## Verantwortlichkeiten

- TanStack Query v5 verwaltet gelesene Serverdaten, gemeinsame laufende Abfragen,
  Abbruchsignale, Cache und gezielte Invalidierungen.
- Zustand und lokale React-Zustände verwalten Auswahl, Layout und Entwürfe.
- Die bestehende Collaboration-Schicht bleibt für editierbare Live-Dokumente
  maßgeblich. Query-Aktualisierungen ersetzen keinen ungespeicherten Editorinhalt.
- Explizite Navigationsziele haben Vorrang vor gespeicherten Auswahlen.
- Query-Schlüssel enthalten den authentifizierten Benutzerkontext, Workspace
  und die vollständige Ressourcenidentität. Cache beim Kontowechsel verwerfen.
- Mutationen benötigen eigene Idempotenz und Versionsprüfungen; Query-Caching
  allein stellt diese Garantien nicht her.

## Abfragen und Einstieg

| Einstieg | Notwendige Daten | Nachgelagerte Daten |
| --- | --- | --- |
| Bestehender Chat | Workspace, Zielsession, erste Nachrichtenseite | Sessionliste, ausgeblendete Dokumente |
| Neuer Chat | Workspace, Agent und Runtime | Sessionliste; keine Nachrichtenabfrage |
| Dokument | Dokumentidentität, Inhalt, Editorinitialisierung | Ordnerpfad, ausgeblendeter Chat |
| Review | Dokumentauflösung, Timeline, ausgewählter Vergleich | Weitere Timeline-/Diff-Seiten |
| Notebook ohne Ziel | Gespeicherte Auswahl auflösen | Abfragen der daraus benötigten Bereiche |

Gemeinsame Module: `workspace-queries`, `chat-queries`, `document-queries`,
`review-queries`, `notebook-entry` und `chat-reconciliation`. Konkrete Pfade
werden bei der Integration an vorhandene fachliche Client-Module angepasst.
Ein gezielter Session-Bootstrap liefert Metadaten und die erste Nachrichtenseite,
ohne zuvor sämtliche Sessions abzufragen. Dashboard-Zusammenfassungen sind keine
vollständigen Session- oder Nachrichten-Snapshots.

Cache-Fristen und Refresh-Auslöser werden pro Ressource festgelegt. Kein
pauschales Reload bei jedem Mount/Fensterfokus. Berechtigungsfehler, nicht
vorhandene Ressourcen und Versionskonflikte werden nicht blind wiederholt.
Live-Ereignisse aktualisieren oder invalidieren ausschließlich betroffene Keys.

## Ladefolge nach der Umstellung

Die Reihenfolge folgt Datenabhängigkeiten, keinem pauschalen „erst Editor,
dann Baum, dann Chat“. Der Notebook-Routenfallback deckt das Laden des
Server-/Routeneinstiegs ab. Danach wartet die Shell auf Workspace und Layout,
löst das explizite Ziel vor der gespeicherten Auswahl auf und zeigt dessen
Skeleton. Unsichtbare Chat-/Editorflächen werden erst bei ihrer ersten
Anzeige gemountet; danach bleiben sie innerhalb desselben Workspaces erhalten.

- **Chat-Link:** Zielsession-Bootstrap einschließlich erster Nachrichtenseite;
  anschließend Nachrichtenansicht. WebSocket-Abonnement/Status und die
  notwendigen Agent-/Runtime-Reads können parallel laufen. Die History-Liste
  ist keine Voraussetzung. Bestehende lokale Nachrichten bleiben beim
  Abgleich stehen.
- **Neuer Chat:** Composer und Runtime-Auswahl; noch keine Session-Erstellung oder
  Nachrichtenabfrage. Erst Senden erstellt genau eine Session, dann folgen
  Abonnement und Versand des zuvor eingefrorenen Auftrags.
- **Dokument-Link:** Dateiidentität/Inhalt werden geladen; der sichtbare
  Dateibaum und das Aufklappen des Pfads laufen unabhängig davon. Das
  Dokument-Skeleton bleibt bis zur Editorinitialisierung konsistent.
- **Review:** Dokumentauflösung liefert die erste Timeline, danach wird der
  ausgewählte Vergleich geladen. Weitere Timeline-/Diff-Seiten erst bei
  Bedarf, gebunden an dieselbe Dokument- und Vorschlagsversion.

Das beschreibt den implementierten Abhängigkeitsgraphen. Reale Netzwerkzeiten
und visuelle Übergänge wurden noch nicht in einer freigegebenen Browsersitzung
vermessen.

## Bestehende Chats

- Nachrichtenseiten und Live-/optimistische Nachrichten über stabile IDs und
  Sequenzen zusammenführen. Ein 50-Nachrichten-Refresh kürzt keinen längeren
  geladenen Verlauf.
- Antworten, Pagination und Runtime-Status bleiben an ihren ursprünglichen
  Workspace, Agenten und die Session gebunden.
- Neue Live-Nachrichten dürfen nicht von älteren HTTP-Snapshots überschrieben
  werden. Mehrere Refresh-Ereignisse werden zusammengefasst.
- Scrollposition erhalten; nur beim ersten Öffnen beziehungsweise bestehender
  Bindung ans Ende automatisch scrollen.
- Sessionliste unterscheidet ungeladen, erfolgreich leer und fehlgeschlagen.
- Bootstrap endet unabhängig von den Zustandsänderungen, die er selbst auslöst.

## Neue Chats

`Entwurf → Session-Erstellung → Versand → laufender Chat`.

Ein neuer Chat wird sofort als leerer Composer angezeigt und erst beim ersten
Senden serverseitig erstellt. Ein Entwurf besitzt eine eindeutige Identität;
parallele Erstellungsversuche teilen denselben Vorgang. Wiederholungen von
Erstellung und Versand verwenden stabile, serverseitig geprüfte Idempotenzkeys.
Workspace, Agent, Text, Anhänge und aufgelöster Dokumentkontext werden am
Sendebeginn eingefroren. Eine spätere Navigation darf den Auftrag nicht umleiten
oder eine verspätete Antwort zur aktiven Ansicht machen.

Startseiten-Prompts verwenden denselben Ablauf mit eindeutiger Übergabe-ID und
interner Navigation. Übergabe erst nach bestätigtem Versand verbrauchen;
Fehler bleiben wiederholbar. Erstellungsantworten befüllen direkt den Cache.

## Dokumente und Reviews

Dateiinhalt und Aufklappen des Ordnerpfads bleiben parallel. Vorhandene
Explorer-Snapshots bleiben bei Wiederherstellung sichtbar. Der initiale
Dokument-Ladezustand umfasst auch die Editorinitialisierung.

Reviews sind immutable Vergleiche aus Dokumentidentität, aktuellem Versionszaun
(Revision/Hash), Kandidat und Vorschlagsversion. Pagination bleibt an denselben
Vergleich gebunden. Ändert sich die Basis, bleibt der angezeigte Vergleich
lesbar, wird als veraltet markiert und darf nicht mehr übernommen werden, bis
eine erneute Prüfung erfolgt ist. Bestehende serverseitige Versionskontrollen,
Aktions-Idempotenz und begrenzte Persistenz-Retries bleiben erhalten.

Nach Übernehmen/Ablehnen/Wiederherstellen werden betroffene Timeline,
Operationsdaten, Benachrichtigungen und Dokumentmetadaten aktualisiert. Offene
Editoren erhalten Änderungen über ihre Collaboration-/Konfliktlogik.

## Darstellung

| Zustand | UI |
| --- | --- |
| Noch nicht benötigt | Keine Abfrage |
| Erstladen ohne Daten | Zielgerechtes Skeleton |
| Hintergrundaktualisierung | Inhalt bleibt sichtbar, kleiner Status |
| Erfolgreich leer | Leerzustand |
| Hintergrundfehler | Inhalt behalten, Wiederholen anbieten |
| Veralteter Review | Vergleich behalten, Prüfung erneut anfordern |
| Mutation läuft | Betroffene Aktion sperren, übrige UI bedienbar |

## Umsetzung und Abnahme

- [x] Plan dokumentieren.
- [x] 1. Gemeinsame Query-Grundlage und eindeutige Notebook-Navigation.
- [x] 2. Bestehende Chats, Bootstrap, Nachrichtenabgleich und Pagination.
- [x] 3. Neue Chats, Startseiten-Übergabe und Idempotenz.
- [x] 4. Dokumente, Reviews und durchgängige Skeletons.
- [x] Abschließende Integration und Produktionsbuild.
- [ ] Browser-/E2E-Abnahme nach ausdrücklicher Freigabe.

Jeder abgeschlossene Schritt wird separat geprüft und committed. Subagenten
übernehmen abgegrenzte Arbeiten innerhalb des aktiven Schritts oder vorbereitende
Analysen. Vor Symboländerungen GitNexus-Impact, vor Commits `detect-changes`.

Gezielte Regressionen mit vertauschter Antwortreihenfolge: Chat A → B;
Workspacewechsel; Doppelsenden; langsame Session-Erstellung; HTTP-Antwort nach
Live-Nachricht; Pagination nach Navigation; leere History; Dokumentwechsel;
Dokumentänderung und Kandidatenwechsel während Review/Pagination; Retry nach
ungewissem Mutationsergebnis. Bestehende Collaboration- und Review-Garantien
müssen erhalten bleiben. UI-Prüfungen benötigen laut Repository-Regel explizite
Freigabe; Container werden nur bei ausdrücklichem Auftrag gebaut.

## Validierungsprotokoll

Schritt 1: TanStack Query installiert; Benutzer-/Session-Partitionierung,
geteilte Reads mit getrennten Verbraucher-Abbrüchen, Agenten/Präferenz/Runtime-
Queries integriert. Notebook wartet auf Layout und Zielworkspace; explizite
Navigation verdrängt gespeicherte Dokumentwiederherstellung. Einstiegsskeleton.
Prüfungen: `notebook-query-client-test`, `workspace-query-test`,
`notebook-layout-state-test`, `chat-navigation-intent-test`,
`notebook-chat-context-test`, `tsc --noEmit`, gezieltes ESLint und
`git diff --check` erfolgreich. Browserfreigabe noch ausstehend.

Schritt 2: Gezielter autorisierter Session-Bootstrap mit erster Nachrichtenseite;
gemeinsame Listen-, Such- und Nachrichtenqueries. Erhalten geladener Seiten und
Live-Änderungen, zusammengefasste Refreshs, Navigations-/Workspace-Prüfungen auch
bei Pagination. Getrennte Skeleton-, Leer- und Fehlerzustände mit Retry.
Prüfungen: `chat-query-test`, `chat-reconciliation-test`,
`chat-message-request-race-test`, `chat-bootstrap-history-races-test`,
`chat-session-bootstrap-test` (PGlite), bestehende Render-Key-, Scroll-, History-
und Workspace-Regressionen, `tsc --noEmit --incremental false`, gezieltes ESLint
und `git diff --check` erfolgreich. Browserfreigabe noch ausstehend.

Schritt 3: Gemeinsame Erstellung je Entwurf, feste Erstellungs-/Nachrichten-IDs,
eingefrorener Kontext, expliziter Retry und Navigationsschutz implementiert.
Startseite navigiert intern mit authentifizierter Workspace-/Handoff-Identität;
Bestätigung verbraucht ausschließlich den passenden gespeicherten Auftrag.
Entwurfstimer sind an den ursprünglichen Chat gebunden; neue Entwurfseinträge
werden nach Benutzer und Workspace getrennt. Alte unzugeordnete lokale Einträge
werden nicht automatisch einem Benutzer/Workspace zugewiesen.

Session-Replay verwendet den gespeicherten Runtime-Snapshot. Die additive
Tabelle `pi_message_delivery_receipts` wird über die vorhandene Schema-Migration
angelegt. Nach Runtimeverlust ohne belegte Verlaufspersistenz liefert ein Retry
`MESSAGE_DELIVERY_UNCERTAIN`: keine automatische Zweitausführung, aber auch
keine unbelegte Erfolgsbestätigung. Dies ist keine dauerhafte Queue-Wiederaufnahme.

Prüfungen: `chat-session-create-idempotency-test` und
`pi-message-delivery-receipt-test` (PGlite), `chat-send-transaction-test`,
`chat-prompt-handoff-test`, `chat-draft-scope-test`, `chat-created-query-test`,
erweiterte Bootstrap-Races, Home-Komponenten- und Workspace-Lifecycle-Tests,
vollständiger Typecheck, gezieltes ESLint und Diff-Prüfung erfolgreich.

Schritt 4: Gemeinsame Datei-/Baum-Reads, versionsgebundene Review-Queries und
gezielte Invalidierung integriert. Explorer und Review behalten vorhandene
Inhalte bei Hintergrundabfragen; veraltete Vergleiche bleiben lesbar, Aktionen
bis zur erneuten Prüfung gesperrt. Route, Dokument und Review besitzen
einheitliche initiale Skeletons. Verborgene Chat-/Editorflächen mounten erst
bei Bedarf. Initiale Auth-Auflösung startet Reviews in der korrekten Partition
neu; Antworten aus alten Partitionen werden verworfen.

Der lokale Chat-Verlauf ist ebenfalls an Benutzer und Sitzung gebunden.
Ein clientseitiger monotoner Zeitstempel verhindert, dass ein älterer geteilter
HTTP-Read einen neueren lokalen Verlauf ersetzt, auch innerhalb derselben
Millisekunde. Dokumentabfragen verändern keine Collaboration-Snapshots.

Prüfungen: `document-query-test`, `review-query-consistency-test`,
`notebook-surface-mount-test`, `notebook-loading-surfaces-test`,
`file-version-comparison-races-test`, `chat-session-cache-scope-test`, erweiterte
Nachrichten-Races, bestehende Review-/Editor-/Dateiöffnungs-/Collaboration-Tests,
vollständiger Typecheck, gezieltes ESLint und Diff-Prüfung erfolgreich.
Komponententests laufen mit JSDOM; eine echte Browserprüfung bleibt offen.

Abschließende Änderungsprüfung: GitNexus nach Neuindexierung gegen `main`
ausgeführt; 88 betroffene Dateien und 17 erkannte Abläufe. Die Gesamtreichweite
wird wegen der zentral genutzten Client-/Session-Funktionen als kritisch
eingestuft. Der Scope umfasst die geplanten Navigation-, Query-, Chat-,
Datei- und Review-Änderungen samt Tests und Dokumentation.

Die Lizenzinventur wurde für `@tanstack/query-core` und `@tanstack/react-query`
aktualisiert; Compliance-Test und Release-Gate sind erfolgreich. Keine
Container gebaut und kein Deployment durchgeführt.

`npm run build` erfolgreich (Exit 0), einschließlich Lizenzprüfung, Turbopack-
Kompilierung, TypeScript und Routengenerierung. Ohne lokale Runtime-Env meldet
der Build fehlende Auth-/Direct-MCP-Basis-URLs sowie Yjs-/Node-Warnungen; diese
haben den Build nicht abgebrochen. Eine laufende App mit Login und echte
Browser-Netzwerksequenzen wurden damit nicht geprüft.
