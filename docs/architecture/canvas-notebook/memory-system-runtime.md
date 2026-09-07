# Memory-System: Runtime, Kategorien und Betrieb

Stand: 2026-09-07

## Begriffe

- Eine **Collection** ist ein technischer Kategorien-Container, kein Projekt und
  kein einzelnes Memory.
- Ein **Entry** ist der eigentliche gespeicherte Memory-Inhalt.
- Der sichtbare Kategoriename (zum Beispiel `Service Provider` oder
  `Brand Structure`) steht deshalb als Kartenueberschrift. Die Zahl darunter
  zaehlt alle fuer den User sichtbaren aktiven, ausstehenden und archivierten
  Entries dieser Kategorie; sie ist keine Anzahl von Projekten.
- Die Settings-Oberflaeche zeigt nur Collections, die fuer den aktuellen User
  mindestens einen sichtbaren Entry enthalten. Leere Collections werden in der
  Wartung nach einer Sicherheitsfrist von einer Stunde entfernt, damit eine
  gerade erzeugte Collection nicht mit dem anschliessenden Entry-Write kollidiert.
- Freie Modellkategorien werden vor dem Schreiben in eine kleine stabile
  Taxonomie ueberfuehrt. Beispiele: `service-provider` und
  `business-structure` werden im gemeinsamen Scope zu `profile`, waehrend
  `brand-structure` zu `brand` wird.

## Scopes und Auswahl

`My memory`, `Agent memory`, `Workspace` und `Organization` sind getrennte
Scopes. Agent Memory verlangt die explizite Auswahl eines Agents. Workspace
Memory verlangt analog die explizite Auswahl eines zugreifbaren Workspaces.
Die Workspace-Auswahl aendert nicht den global aktiven Workspace der App und
wird als `workspaceId` in der Settings-URL erhalten. Dadurch kann ein direkter
Link immer denselben Workspace und dieselbe Kategorie oeffnen.

Innerhalb einer Kategorie trennt die UI `Published`, `Pending` und `Archived`.
Der Status ist damit keine versteckte Eigenschaft einer Karte. Kategorien, die
nur archivierte Entries enthalten, bleiben auffindbar, solange der aktuelle
User sie wiederherstellen darf.

## Gemeinsame Memories und Freigabe

Fuer Workspace- und Organization-Memory gilt:

- ein Manager mit Publish-Recht veroeffentlicht einen manuell angelegten Entry
  sofort;
- ein Contributor mit Schreib-, aber ohne Publish-Recht erzeugt einen
  `pending`-Vorschlag;
- automatisch extrahierte gemeinsame Memories starten ebenfalls als
  `pending` und werden nie still veroeffentlicht;
- ein Contributor kann den eigenen Vorschlag im Pending-Tab sehen, waehrend
  Manager alle fuer sie freizugebenden Vorschlaege sehen;
- Reader sehen ausschliesslich veroeffentlichte Entries.

Jeder aktuell berechtigte Approver erhaelt fuer jeden ausstehenden Entry einen
Hinweis in der Notification Central. Die Benachrichtigung wird zur Laufzeit aus
dem aktuellen Pending-Status und den aktuellen Berechtigungen abgeleitet:
Neue Manager sehen bestehende Vorschlaege, entfernte Manager verlieren den
Hinweis, und nach Publish oder Archivierung verschwindet er automatisch. Ein
Klick markiert den Hinweis fuer diesen User als gelesen und fuehrt direkt zum
richtigen Scope, Workspace, Pending-Tab, Kategorie und Entry. Gelesen bedeutet
nur zur Kenntnis genommen; solange die Freigabe offen ist, bleibt der Hinweis
sichtbar. Titel und Metadaten sind lokalisiert, der Memory-Inhalt wird nicht als
Benachrichtigungsvorschau kopiert.

Beim Archivieren merkt sich ein Entry seinen vorherigen Status. Restore setzt
ihn deshalb wieder auf `pending` oder `published` zurueck. Fuer historische
Daten ohne diese Information wird konservativ der sichere Status gewaehlt.

## Prioritaet

Die Prioritaet ist eine Ganzzahl von 0 bis 100 und steuert die Reihenfolge bei
der Anzeige und bei knappem Prompt-Budget. Die UI erklaert die Skala in fuenf
Baendern:

- 0-24: niedrig;
- 25-49: Hintergrund;
- 50-69: normal;
- 70-89: wichtig;
- 90-100: essenziell.

Manuell gespeicherte Entries starten bei 70, weil ein User sie bewusst als
dauerhaftes Wissen eintraegt. Automatisch extrahierte Entries starten ohne
abweichende Modellbewertung bei 50. Der Reviewer-Prompt fordert eine bewusste
Einordnung anhand der dauerhaften Relevanz und warnt ausdruecklich davor, alles
auf 50 zu setzen. Bestehende Daten mit Prioritaet 50 bleiben als neutraler
Bestand unveraendert. Gepinnte Eintraege haben bei der Prompt-Projektion immer
Vorrang vor der numerischen Prioritaet.

## Wann der Reviewer Modell-Tokens verbraucht

Ein Review-Job wird nur nach einer gespeicherten Assistant-Antwort geplant,
wenn seit dem letzten abgeschlossenen Review mindestens eine neue User-Nachricht
existiert. Zehn neue User-Turns planen den Job sofort; weniger Turns planen
einen 15-Minuten-Idle-Flush. Ohne neue User-Nachrichten wird kein Job angelegt.

Der Worker darf beim Serverstart und fuer Wartung die Queue in der Datenbank
pruefen. Eine leere Queue verursacht keinen Modellaufruf. Ein Modellaufruf ist
nur nach erfolgreichem Claim eines faelligen Jobs erlaubt.

## Reviewer ein- und ausschalten

Die automatische Pruefung ist eine persistente Einstellung pro User. Neue
Accounts starten mit ausgeschaltetem Reviewer; bei der einmaligen Migration
bleiben bestehende Accounts aktiviert, damit ein Update ihr bisheriges
Verhalten nicht still veraendert. `automatic_memory_enabled_at`,
`automatic_memory_disabled_at` und `settings_revision` machen jeden Wechsel
nachvollziehbar und ueber Prozessneustarts hinweg eindeutig.

Der Schalter in den Memory Settings speichert sofort. Beim Ausschalten werden
wartende, geparkte und laufende Jobs des Users terminal als abgebrochen
markiert. Ein gerade laufender Modellstream erhaelt zusaetzlich ein
Abort-Signal. Vor jedem teuren oder schreibenden Worker-Schritt wird die
persistierte Einstellung samt Revision erneut geprueft; dadurch kann ein alter
Claim nach dem Ausschalten weder erneut versuchen noch Memories schreiben.

Beim erneuten Einschalten werden Nachrichten aus dem ausgeschalteten Zeitraum
nicht nachtraeglich abgearbeitet. Nur User-Nachrichten ab dem neuen
Aktivierungszeitpunkt koennen einen Job erzeugen. Bereits gespeicherte Memories
und alle manuellen Import-, Export-, Erstell- und Verwaltungsfunktionen bleiben
waehrenddessen verfuegbar.

Die UI folgt Progressive Disclosure: Im ausgeschalteten Zustand bleiben nur
Reviewer-Status und Schalter sichtbar. Provider, Modell, Prompt-Budget und
Queue erscheinen erst nach dem Einschalten. Die Memory-Kategorien und ihre
Eintraege sind davon unabhaengig. Beim Scope-Wechsel wird der vorherige Inhalt
sofort entfernt, bis die Daten des neuen Scopes geladen sind.

Als serverweiter Kill Switch steht
`CANVAS_MEMORY_REVIEW_WORKER_ENABLED=false` zur Verfuegung. Er stoppt den
Worker unabhaengig von der gespeicherten User-Praeferenz, veraendert diese aber
nicht. Settings und Agent-Karte zeigen diesen Betriebszustand als serverweit
deaktiviert statt als fehlende Modellkonfiguration an.

Bei jedem Worker-Zyklus gleicht ein rein datenbankbasierter Backstop Sessions
mit beantworteten, aber noch nicht eingeplanten User-Turns ab. Damit wird auch
die schmale Absturz-Luecke zwischen Job-Completion und Planung des Folgejobs
geschlossen. Der Backstop betrachtet nur Sessions mit bereits vorhandener
terminaler Review-Historie; historische Chats ohne Memory-Job werden beim
ersten Start daher nicht nachtraeglich und kostenpflichtig abgearbeitet.
Fehlgeschlagene, endgueltig ausgeschoepfte Bereiche gelten als abgearbeitet;
nur spaetere Nachrichten koennen einen neuen Job erzeugen.

Schutzgrenzen:

- maximal drei Ausfuehrungsversuche pro Job;
- maximal 1.200 Output-Tokens pro Review-Aufruf;
- ungueltiges strukturiertes Modell-JSON ist ein permanenter Fehler und wird
  nicht erneut an das Modell geschickt;
- geparkte alte Jobs mit bereits erreichtem Versuchslimit werden beim naechsten
  Worker-Zyklus als `failed` geschlossen und nicht durch eine neue
  Runtime-Konfiguration reaktiviert.

## Neustart und Checkpoint

Nach einer validen Modellantwort speichert der Worker zuerst die bereinigten
Kandidaten in `memory_review_jobs.response_json`, zusammen mit SHA-256-Hash und
Zeitstempel. Erst danach werden die Kandidaten auf Collections und Entries
angewendet. Schlaegt das Anwenden fehl oder startet der Prozess neu, verwendet
der naechste Versuch den Checkpoint und ruft das Modell nicht erneut auf. Vor
der Wiederverwendung wird der Hash geprueft. Auch die Usage-Persistenz erfolgt
erst nach diesem Checkpoint; ein isolierter Fehler in der Usage-Protokollierung
wird geloggt, loest aber keinen zweiten Modellaufruf aus.

`nextMemoryReviewDueAt()` beachtet sowohl `scheduled_for` als auch
`running.lease_until`. Ein Neustart waehrend eines laufenden Leases weckt den
Worker deshalb zum Lease-Ablauf. Abgelaufene Leases werden kontrolliert auf
`retry_wait` gesetzt.

## Sprache

Der automatische Reviewer liest die Kontosprache aus den User Preferences.
Memory-Inhalte werden fuer `de` auf Deutsch und fuer `en` auf Englisch erzeugt;
Eigennamen und etablierte technische Begriffe bleiben erhalten. Die
Kategorieschluessel sind sprachneutral. Die UI uebersetzt deren sichtbare Namen
und Beschreibungen zur Laufzeit.

Das direkte `memory`-Tool weist den aktiven Agenten ebenfalls an, neue oder
geaenderte Inhalte in der konfigurierten Kontosprache zu schreiben. Beim
asynchronen Runtime-Aufbau wird die konkrete Sprache (`German (Deutsch)` oder
`English`) sowohl in die Tool-Beschreibung als auch in die Beschreibung des
`content`-Parameters eingesetzt. Dafuer ist kein eigener Modellaufruf noetig.

## Markdown-Inhalte

Memory-Entries werden als Text in der Datenbank gespeichert und duerfen eine
kompakte, sichere Markdown-Teilmenge enthalten: Absaetze, Hervorhebungen,
Inline-Code, Listen, Zitate und Links. Ueberschriften, Raw HTML, Bilder sowie
Wiki- oder Workspace-Embeds sind fuer Memory-Inhalte nicht vorgesehen.

Der Memory-Service vereinheitlicht Windows-Zeilenenden zu `\n` und entfernt
nur aeusseren Whitespace. Interne Zeilenumbrueche bleiben erhalten. Fuer
Deduplizierung und Secret-Pruefung wird weiterhin eine separate, auf einzelne
Leerzeichen reduzierte Vergleichsform verwendet. So bleiben Markdown-Struktur
und bisherige Duplikaterkennung gleichzeitig erhalten.

Die Settings-Oberflaeche rendert gespeicherte Inhalte mit einem dedizierten,
restriktiven Memory-Renderer. Er kann keine Bilder laden und keine
Workspace-Inhalte einbetten. Im Bearbeitungsmodus bleibt das originale
Markdown im Textfeld sichtbar. Die Prompt-Projektion fuer Agenten wird dagegen
weiterhin auf eine einzelne Faktenzeile reduziert, damit ein mehrzeiliger
Entry die Struktur des Systemprompts nicht veraendern kann.

## Logging

Strukturierte `[MemoryManager]`-Logs existieren fuer Scheduling, Claim,
Checkpoint, Wiederaufnahme, Apply-Ergebnis, Completion, Retry, permanentes
Fehlschlagen, Lease-Recovery, Collection-Erzeugung, Wartung, Migration,
User-Schalter, Job-Abbruch und den serverweiten Kill Switch. Geloggt werden nur
technische IDs, Kategorien, Zaehler, Status, Zeitpunkte, Revisionen,
Hash-Praefixe und Fehlercodes. Chattexte, Memory-Inhalte, Provider-Secrets und
Modellantworten duerfen nicht in Logs geschrieben werden.

Direkte Add-, Update-, Publish-, Archive- und Restore-Schreibvorgaenge erzeugen
zusaetzlich ein
`[Memory] Entry stored.`-Log mit Operation, Scope, Entry-/Collection-ID,
Status, Prioritaet sowie Zeichen- und Zeilenanzahl. Notification-Read-State-
Aenderungen loggen nur User-, Entry- und Scope-IDs beziehungsweise Zaehler. Der
Inhalt selbst wird nicht geloggt.

## Relevante Tests

- `npm run test:memory:contract`
- `npm run test:memory:schema`
- `npm run test:memory:service`
- `npm run test:memory:markdown-renderer`
- `npm run test:memory:review-runtime`
- `npm run build`

Der Service-Test deckt insbesondere Retry-Limit, Checkpoint-Persistenz,
Lease-Recovery nach Neustart, Schliessen historisch erschoepfter Jobs,
Folgejob-Reconciliation, nicht blockierende unkonfigurierte Mandanten,
idempotente Updates, das dauerhafte Opt-out, Abbruch laufender Jobs,
unterdrueckte Backlogs nach erneutem Einschalten, Kategorien-Normalisierung und
das Verhindern leerer Collections ab. Zusaetzlich prueft er Sichtbarkeit und
Restore fuer Pending/Published/Archived, manuelles Direct Publish, die
Prioritaetsskala sowie dynamische Approval-Benachrichtigungen inklusive
Read-State und Berechtigungswechsel. Ein prozessnaher Worker-Zyklus prueft ausserdem, dass ein
abgelaufener `running`-Job nach einem Neustart aus seinem validierten Checkpoint
fertiggestellt wird; die Modellstream-Funktionen werfen im Test absichtlich,
falls der Worker sie dabei doch aufrufen sollte.

Der UI-Akzeptanztest `tests/memory-personal-ui.spec.ts` prueft die sofortige
Speicherung des Schalters, Progressive Disclosure, lokalisierte deutsche
Kategorien, leere Scopes ohne `0 Eintraege`-Karten, Desktop/Mobile-Layout und
in zwei getrennten Serverprozessen die Persistenz von Opt-out und Memories.
`tests/memory-team-governance.spec.ts` prueft Workspace-Auswahl, Vorschlag,
Notification-Central-Deep-Link, Read-State, Freigabe, Rollen-Sichtbarkeit,
Archivierung und Wiederherstellung.
