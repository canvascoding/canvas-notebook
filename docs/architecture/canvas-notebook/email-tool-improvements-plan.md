# Verbesserungsplan für das E-Mail-Tool

Stand: 9. Oktober 2026. Die Schritte werden einzeln abgeschlossen und geprüft,
bevor der nächste beginnt. Der lokale Umsetzungsstand wird hier fortgeschrieben;
Produktionsabnahme ist davon getrennt.

| Schritt | Stand |
| --- | --- |
| Inaktive Focus-Auswahl ausblenden | Implementiert und lokal geprüft |
| 1. Unicode-Erfassung | Implementiert; PGlite, PostgreSQL 18 und Worker-Wiederaufnahme geprüft |
| 2. Getrennte Fehlerdiagnose | Implementiert; Migration, Rechte, Wiederaufnahme und Aktualisierung geprüft |
| 3. Konkrete Postfachwarnungen | Implementiert; Rechte, Quellenwechsel und Browsergeometrie geprüft |
| 4. Verständliche Einrichtung | Implementiert; Rollen, Einrichtung, Testaufrufe und Browserlayout geprüft |
| 5. Zahlen und Suchumfang | Implementiert; vollständiger Suchweg, ehrliche Abdeckung und kurze Browseransichten geprüft |
| 6. Gesamtprüfung und Rollout | Ausstehend |

Prüfbelege: [Implementierungsvalidierung](email-tool-improvements-validation.md).

## Ausgangslage und bereits abgeschlossener Auftrag

- [Control-Plane-PR #18](https://github.com/canvascoding/canvas-control-plane/pull/18)
  ist mit der ausdrücklich freigegebenen Ausnahme zum fehlenden Greptile-Score
  gemergt. Merge-Commit: `19315a04a35537b7a4c7c034b5699d7285ad3808`.
- Bei zentral deaktivierter E-Mail-Vorbereitung werden Focus/Klassisch-Umschaltung
  und Deaktivierungshinweis ausgeblendet. Bei aktiver Funktion bleibt die
  Umschaltung auch während einer Verarbeitungsstörung verfügbar.
  [Prüfbericht und Screenshots](email-focus-visibility/validation.md).
- Jev ist bereits als TypeSafe-API-Anbieter eingebunden. Kategorisierung ist
  unabhängig von den Chatmodellen eingerichtet: direkt mit einem System-Secret
  oder über einen freigegebenen Managed-Decision-Katalog.
- Produktionslogs vom 9. Oktober zeigen beim Speichern erfasster Nachrichten
  wiederholt `invalid input syntax for type json` mit dem Detail
  `Unicode low surrogate must follow a high surrogate`. Die UTF-16-Kürzung in
  `normalizeList` kann diesen Fehler nachweislich erzeugen. Die konkrete
  Nachricht beziehungsweise das Feld wurde nicht bestimmt.
- Der Worker setzt nach einer fehlgeschlagenen Erfassung das Postfach auf
  `coverage: failed`. Die Oberfläche zeigt bislang eine pauschale orange Warnung
  ohne betroffenes Postfach oder konkreten Fehlergrund.

Der Merge ist kein Produktionsrollout und aktiviert die Vorbereitung nicht.
Veröffentlichung, zentrale Providerkonfiguration und tatsächliche Aktivierung
bleiben getrennte Schritte.

## 1. Unicode-Fehler bei der Erfassung beheben — höchste Priorität

**Änderung:** Alle gespeicherten Listenfelder an ihrer Speichergrenze auf gültigen
Unicode normalisieren und kürzen, ohne ein Zeichenpaar zu zertrennen. Bereits
beschädigte Zeichenfolgen und Nullzeichen ebenfalls behandeln. Betreff, Absender,
Empfänger, Vorschau und Thread-ID müssen gemeinsam abgedeckt sein. Originalmails
beim Anbieter bleiben erhalten. Anschließend kann die bisher fehlgeschlagene
Erfassung ihren bestehenden Cursor kontrolliert fortsetzen.

**Betroffene Quellen:** `app/lib/email/classification/store.ts` (`normalizeList`,
`upsertMessageMetadata`), bestehende Store-/PostgreSQL-Prüfungen und
`app/lib/email/classification/worker.ts` für die Wiederaufnahme.

**Abnahme:** Mit echtem PostgreSQL lassen sich normale Texte, Emoji direkt an
allen Feldgrenzen, alleinstehende hohe/niedrige Surrogate, Nullzeichen und lange
gemischte Texte speichern. Ein Scan mit der problematischen Nachricht setzt
seine Erfassung fort; die Unicode-Fehler treten dabei nicht erneut auf.

**Abhängigkeit:** Keine weitere Produktänderung nötig. Lokal abgeschlossen;
die Wirkung auf die zuvor betroffenen Produktionspostfächer wird nach dem
separat freigegebenen Rollout geprüft.

## 2. Erfassung und KI-Bewertung getrennt diagnostizieren

**Änderung:** Beim fehlgeschlagenen Postfachscan einen begrenzten, sicheren
Fehlercode speichern, beispielsweise Verbindung abgelaufen, Anbieter temporär
nicht erreichbar oder Nachrichteninhalt nicht verarbeitbar. Bei erfolgreicher
Erfassung den Fehler zurücksetzen. `lastSyncAt` beschreibt bereits den letzten
nicht fehlgeschlagenen Lauf und bleibt davon getrennt. Diesen Zustand über die
berechtigungsgeprüfte Feed-Coverage liefern; keine Mailinhalte, Schlüssel oder
rohen Providerfehlermeldungen im öffentlichen Ergebnis.

**Betroffene Quellen:** `worker.ts`, `store.ts`, `store-types.ts`,
`postgres-migration.ts`, `feed-types.ts`, `feed-service.ts` unter
`app/lib/email/classification/`. Neue Spalten benötigen eine additive Migration.

**Abnahme:** Ein Erfassungsfehler und ein Fehler bei der Modellbewertung sind
unterscheidbar. Nach einer erfolgreichen Wiederholung verschwindet der alte
Erfassungsfehler. Nutzer erhalten ausschließlich Zustände ihrer berechtigten
Postfächer; das gilt auch bei zwischenzeitlichem Rechteentzug.

**Abhängigkeit:** Schritt 1 vollständig abgeschlossen.

## 3. Postfachwarnungen mit konkreten Aktionen versehen

**Änderung:** Die pauschale Warnung durch eine kurze Zusammenfassung mit
aufklappbaren betroffenen Postfächern ersetzen. Je Postfach Name, letzte
erfolgreiche Erfassung, Zustand und nächster Schritt anzeigen. Direkt anbieten:
„Postfach in Klassisch öffnen“ beziehungsweise bei Zugangsproblemen
„Verbindung prüfen“. Nicht vorbereitete Nachrichten, Erfassungsfehler und
gescheiterte KI-Bewertungen getrennt benennen.

„Aktualisieren“ muss erkennbar den angezeigten Stand neu laden. Falls zusätzlich
„Erfassung erneut anfordern“ angeboten wird, benötigt diese Aktion eine eigene
berechtigungsgeprüfte API mit aktuellem Postfachzugriff, Lease und Cooldown;
erneutes Laden der Liste darf nicht als erneuter Scan ausgegeben werden.

**Betroffene Quellen:** `app/apps/email/components/EmailFocusNavigation.tsx`,
`EmailClient.tsx`, Feed-Verträge aus Schritt 2 sowie `messages/de.json` und
`messages/en.json`. Vorhandene Scope-/Moduswechsel wiederverwenden.

**Abnahme:** Bei einer defekten Quelle erkennt der Nutzer das betroffene Postfach
und gelangt mit einer Aktion zu dessen vollständiger klassischer Ansicht.
Funktionierende Quellen bleiben verwendbar. Eine Quelle ohne bestätigten Stand
wird nicht als leer oder vollständig dargestellt.

**Abhängigkeit:** Schritt 2 liefert die notwendigen sicheren Zustände.

## 4. Kategorisierung als verständliche Einrichtung darstellen

**Änderung:** Die vorhandene Admin-Karte als kurze Reihenfolge präsentieren:
Bereitstellung wählen -> Modell/Zugang prüfen -> synthetischen Test durchführen
-> zentral aktivieren und speichern. Jev wird als Bewertungsdienst erklärt,
ohne eine Installation in der Chat-Modellliste zu suggerieren.

- Direktbetrieb: System-Secrets und den konkret benötigten Schlüsselnamen
  anzeigen, für TypeSafe standardmäßig `TYPESAFE_API_KEY`.
- Canvas-verwaltet: Verbindung, freigegebenes Entscheidungsmodell, zentralen
  Zugang und Budget prüfen; kein lokaler Provider-Schlüssel nötig.
- Fehlende Verbindung, Modellfreigabe, Zugangsdaten oder Budget bekommen jeweils
  einen passenden nächsten Schritt. „Test bestanden“ bedeutet Verbindung und
  Antwortvertrag geprüft; es behauptet keine Sortiergenauigkeit.
- Instanzadmins erreichen die Einrichtung über eine klar bezeichnete Aktion im
  E-Mail-Menü. Nichtadmins erhalten bei einer relevanten Störung einen passenden
  Adminhinweis. Die inaktive Focus-Auswahl bleibt ausgeblendet.

**Betroffene Quellen:** `app/components/settings/EmailClassificationSettingsCard.tsx`,
`app/components/settings/IntegrationsSettingsClient.tsx`, `admin-service.ts`,
`execution-service.ts`, `credential-service.ts`, `EmailFocusHeader.tsx` und DE/EN.

**Abnahme:** Ein Admin erkennt den konkret fehlenden Einrichtungsschritt.
Gespeicherte Aktivierung und aktuelle Verarbeitungsbereitschaft werden getrennt
angezeigt. Ein temporärer Providerfehler erhält vorhandene Bewertungen. Eine
Konfigurationsänderung startet nicht stillschweigend einen kostenpflichtigen Test.

**Abhängigkeit:** Schritt 3 abgeschlossen. Für die tatsächliche Managed-Abnahme
muss die gemergte Control-Plane-Version mit Migrationen 0105/0106 und
Decision-Scopes veröffentlicht und mit Profilen, zentralen Secrets und Tarifen
konfiguriert sein; siehe die Control-Plane-Dokumentation `docs/managed-decision-models.md`.

## 5. Zahlen und Suchumfang eindeutig beschriften

**Änderung:** In der aggregierten Ansicht die Zahl als erfasste Inbox-Mails im
gewählten Bereich erklären. „Alle E-Mails“ darf keine vollständige Provideransicht
suggerieren. Unvollständige Erfassung unmittelbar bei der Zahl kennzeichnen.
Erfassten Suchbestand und Bewertungszeitraum getrennt erklären: Vorbereitung
umfasst alle ungelesenen Inbox-Mails sowie weitere Inbox-Mails im konfigurierten
Rückblick. Für alle Ordner und vollständige Providersuche einen direkten Weg zum
einzelnen Postfach anbieten.

**Betroffene Quellen:** `EmailFocusNavigation.tsx`, `EmailFocusHeader.tsx`,
`EmailClient.tsx`, `messages/de.json`, `messages/en.json` sowie Produktdokumentation.

**Abnahme:** Bei einer Zahl wie 2283 ist direkt erkennbar, was gezählt wird und ob
die Erfassung vollständig ist. Die vollständige Postfachsuche ist erreichbar.
Lange DE/EN-Beschriftungen passen auch bei 390 Pixeln Breite.

**Abhängigkeit:** Schritt 4 abgeschlossen; die Abdeckung aus Schritt 2 wird genutzt.

## 6. Gesamtprüfung und kontrollierter Rollout

Jeder Schritt erhält seinen eigenen Commit und passende bestehende Prüfungen.
Vor Abschluss: Produktionsbuild, Store-/Worker-/Feed-/Settings-Regressionen und
PostgreSQL-Nachweis für Schritt 1. Anschließend Browserjourneys für Instanzadmin
und normalen Nutzer, persönliche und Arbeitspostfächer, DE/EN und Mobil/Desktop:
deaktiviert, eingerichtet, fehlender Zugang, Budgetpause und eine defekte Quelle.

Nach separat freigegebener Veröffentlichung und Aktivierung mit echten
Postfächern prüfen: Erfassung setzt fort, ein freigegebenes reales Modell antwortet,
bestehende Bewertungen bleiben bei temporärer Störung sichtbar und Statusmeldungen
führen zur passenden Aktion. Lokale Tests, synthetische Providerprüfungen und
Produktionsbelege werden getrennt dokumentiert.

**Abnahme:** Jeder oben genannte Nutzerzustand hat einen dokumentierten Prüfbeleg.
Die zuvor produktiv beobachtete Unicode-Störung ist nach dem Rollout beseitigt.
Bis dahin bleibt sie ein offener Fehler.

**Abhängigkeit:** Schritte 1–5 abgeschlossen. Browserautomation und Containerbetrieb
folgen den Repositoryregeln; für lokale Stacks wird `canvas-local-team-seat-dev`
verwendet. Dieser Plan startet keine Umgebung, Provideranfrage oder Aktivierung.
