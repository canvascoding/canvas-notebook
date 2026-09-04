# Memory-System: Runtime, Kategorien und Betrieb

Stand: 2026-09-04

## Begriffe

- Eine **Collection** ist ein technischer Kategorien-Container, kein Projekt und
  kein einzelnes Memory.
- Ein **Entry** ist der eigentliche gespeicherte Memory-Inhalt.
- Die Settings-Oberflaeche zeigt nur Collections, die fuer den aktuellen User
  mindestens einen sichtbaren Entry enthalten. Leere Collections werden in der
  Wartung nach einer Sicherheitsfrist von einer Stunde entfernt, damit eine
  gerade erzeugte Collection nicht mit dem anschliessenden Entry-Write kollidiert.
- Freie Modellkategorien werden vor dem Schreiben in eine kleine stabile
  Taxonomie ueberfuehrt. Beispiele: `service-provider` und
  `business-structure` werden im gemeinsamen Scope zu `profile`, waehrend
  `brand-structure` zu `brand` wird.

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

## Logging

Strukturierte `[MemoryManager]`-Logs existieren fuer Scheduling, Claim,
Checkpoint, Wiederaufnahme, Apply-Ergebnis, Completion, Retry, permanentes
Fehlschlagen, Lease-Recovery, Collection-Erzeugung, Wartung, Migration,
User-Schalter, Job-Abbruch und den serverweiten Kill Switch. Geloggt werden nur
technische IDs, Kategorien, Zaehler, Status, Zeitpunkte, Revisionen,
Hash-Praefixe und Fehlercodes. Chattexte, Memory-Inhalte, Provider-Secrets und
Modellantworten duerfen nicht in Logs geschrieben werden.

## Relevante Tests

- `npm run test:memory:contract`
- `npm run test:memory:schema`
- `npm run test:memory:service`
- `npm run test:memory:review-runtime`
- `npm run build`

Der Service-Test deckt insbesondere Retry-Limit, Checkpoint-Persistenz,
Lease-Recovery nach Neustart, Schliessen historisch erschoepfter Jobs,
Folgejob-Reconciliation, nicht blockierende unkonfigurierte Mandanten,
idempotente Updates, das dauerhafte Opt-out, Abbruch laufender Jobs,
unterdrueckte Backlogs nach erneutem Einschalten, Kategorien-Normalisierung und
das Verhindern leerer Collections ab. Ein prozessnaher Worker-Zyklus prueft ausserdem, dass ein
abgelaufener `running`-Job nach einem Neustart aus seinem validierten Checkpoint
fertiggestellt wird; die Modellstream-Funktionen werfen im Test absichtlich,
falls der Worker sie dabei doch aufrufen sollte.

Der UI-Akzeptanztest `tests/memory-personal-ui.spec.ts` prueft die sofortige
Speicherung des Schalters, Progressive Disclosure, lokalisierte deutsche
Kategorien, leere Scopes ohne `0 Eintraege`-Karten, Desktop/Mobile-Layout und
in zwei getrennten Serverprozessen die Persistenz von Opt-out und Memories.
