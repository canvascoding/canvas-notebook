# Notebook: gemeinsame Queries und stabile Ladezustände

Stand: 2026-09-22. Status: Umsetzung begonnen.

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
- [ ] 1. Gemeinsame Query-Grundlage und eindeutige Notebook-Navigation.
- [ ] 2. Bestehende Chats, Bootstrap, Nachrichtenabgleich und Pagination.
- [ ] 3. Neue Chats, Startseiten-Übergabe und Idempotenz.
- [ ] 4. Dokumente, Reviews und durchgängige Skeletons.
- [ ] Abschließende Integration, Build und zulässige UI-Prüfung.

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

Wird mit den tatsächlichen Änderungen und Prüfergebnissen ergänzt.
