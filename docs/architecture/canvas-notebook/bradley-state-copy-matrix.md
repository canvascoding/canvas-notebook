---
title: Canvas Notebook — Bradley Zustands-Copy-Matrix
status: decided
todo_id: BRADLEY-020
decision_date: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - brand
  - copy
  - i18n
  - status
---

# Canvas Notebook — Bradley Zustands-Copy-Matrix

## Zweck und Geltungsbereich

Diese Matrix ist der verbindliche DE-/EN-Copy-Vertrag für sichtbare Zustände
von Bradley und den angrenzenden Agentenfunktionen. Sie deckt Runtime, Tools,
Dateioperationen, Queue, Delegation, Automationen, Wartezustände, Erfolge und
Fehler ab.

Die Matrix legt die sichtbare Sprache fest, nicht die internen Statusnamen.
Bestehende technische Werte wie `pending`, `running`, `success`, `failed` oder
`retry_scheduled` dürfen stabil bleiben und werden in der UI auf die hier
definierten Texte abgebildet.

## Verbindliche Regeln

1. **Zustand zuerst:** Die erste sichtbare Zeile muss auch ohne Bradley-Glyph
   verständlich sein.
2. **Tatsächlicher Akteur:** `Bradley` erscheint nur, wenn der Hauptagent den
   Schritt ausführt. Spezialagenten behalten ihren Namen; neutrale System-,
   Queue- und Automationszustände nennen keinen erfundenen Akteur.
3. **Stabile Formulierungen:** Für denselben Zustand wird nicht zufällig
   zwischen Varianten gewechselt.
4. **Konkretes Verb:** `{action}` beschreibt eine beobachtbare Tätigkeit wie
   „Dateien prüfen“ oder „Bericht exportieren“, keinen inneren menschlichen
   Zustand.
5. **Fortschritt:** Laufende Sätze enden auf Deutsch mit ` …` und auf Englisch
   mit `…`. Statische Labels, Erfolge, Wartezustände und Fehler erhalten keine
   Auslassungspunkte.
6. **Ergebnis statt Selbstdarstellung:** Nach einem Erfolg folgt auf „Fertig“
   eine konkrete Ergebniszeile.
7. **Keine Schuldfigur:** Provider-, Netzwerk-, Berechtigungs- und
   Integrationsfehler werden ihrer tatsächlichen Ursache zugeordnet.
8. **Keine Metapher als Status:** Canvas- und Faltmetaphern dürfen begleitend
   im Onboarding vorkommen, ersetzen aber nie einen technischen Zustand.
9. **Keine Pronomenpflicht:** Wiederholungen des Namens sind Pronomen wie
   „er/he“ vorzuziehen.
10. **Barrierefreiheit:** Ein Icon oder eine Animation darf den Text ergänzen,
    aber nicht ersetzen. Dynamische Meldungen verwenden eine angemessene
    Live-Region; Fehler und erforderliche Freigaben dürfen nicht allein über
    Farbe vermittelt werden.

## Platzhaltervertrag

| Platzhalter | Bedeutung | Beispiel DE | Example EN |
| --- | --- | --- | --- |
| `{agent}` | sichtbarer Name des tatsächlich ausführenden Agenten | `E-Mail-Agent` | `Email Agent` |
| `{action}` | kurze Tätigkeit als Verbgruppe | `die Dateien prüfen` | `checking the files` |
| `{tool}` | sichtbarer Tool- oder Integrationsname | `Figma` | `Figma` |
| `{item}` | konkrete Datei, Quelle oder Einheit | `release-notes.md` | `release-notes.md` |
| `{result}` | konkretes Resultat in einem Satz | `3 Aufgaben wurden erstellt.` | `3 tasks were created.` |
| `{position}` | positive Queue-Position | `2` | `2` |
| `{count}` | Anzahl betroffener Einheiten | `3` | `3` |
| `{time}` | lokalisierte Zeit oder relative Dauer | `morgen, 09:00` | `tomorrow, 9:00 AM` |
| `{cause}` | bekannte, nutzergerechte Ursache ohne Secret-Details | `Die Verbindung ist abgelaufen.` | `The connection has expired.` |
| `{nextAction}` | konkrete nächste Nutzeraktion | `Verbinde Figma erneut.` | `Reconnect Figma.` |

Platzhalter werden nicht leer ausgegeben. Ist etwa keine Queue-Position
bekannt, wird die Variante ohne `{position}` verwendet. Dateipfade, Fehlertexte
und Providerantworten werden nicht ungefiltert in sichtbare Meldungen eingesetzt.

## Runtime und Antwort

| Zustand | Deutsch | English |
| --- | --- | --- |
| bereit / idle | **Bereit** | **Ready** |
| Lauf wird vorbereitet | **Bradley bereitet den Schritt vor …** | **Bradley is preparing the next step…** |
| Antwort wird vorbereitet | **Bradley bereitet die Antwort vor …** | **Bradley is preparing the response…** |
| Antwort wird ausgegeben | **Bradley antwortet …** | **Bradley is responding…** |
| Kontext wird komprimiert | **Kontext wird zusammengefasst …** | **Summarizing context…** |
| Kontext zu groß | **Der Kontext ist zu groß für diesen Lauf.** | **The context is too large for this run.** |
| Stoppen läuft | **Ausführung wird gestoppt …** | **Stopping the run…** |
| gestoppt | **Ausführung gestoppt** | **Run stopped** |
| Verbindung wird wiederhergestellt | **Verbindung wird wiederhergestellt …** | **Reconnecting…** |
| offline | **Keine Verbindung** | **Offline** |

Wenn ein Spezialagent antwortet, wird in den laufenden Akteursmeldungen
`Bradley` durch `{agent}` ersetzt. Reine Runtime-Funktionen wie
Kontextkomprimierung oder Verbindungsaufbau bleiben neutral.

## Tools und Dateioperationen

### Generische Tool-Zustände

| Zustand | Deutsch | English |
| --- | --- | --- |
| Tool wartet auf Ausführung | **Tool wartet auf Ausführung** | **Tool is waiting to run** |
| Tool wird ausgeführt | **Bradley führt {action} aus …** | **Bradley is {action}…** |
| benannter Agent führt Tool aus | **{agent} führt {action} aus …** | **{agent} is {action}…** |
| Tool abgeschlossen | **Tool abgeschlossen** | **Tool completed** |
| Tool fehlgeschlagen | **Tool konnte nicht ausgeführt werden.** | **The tool could not run.** |
| Tool wird gestoppt | **Tool wird gestoppt …** | **Stopping the tool…** |
| Tool gestoppt | **Tool gestoppt** | **Tool stopped** |
| Autorisierung erforderlich | **{tool} muss verbunden werden.** | **{tool} needs to be connected.** |
| Tool-Freigabe erforderlich | **Deine Freigabe für {tool} ist erforderlich.** | **Your approval for {tool} is required.** |

Für die englische laufende Form muss `{action}` grammatisch als
`-ing`-Verbgruppe geliefert werden, zum Beispiel `checking the files`. Für
Deutsch enthält `{action}` eine Infinitivgruppe, zum Beispiel
`die Dateien prüfen`.

### Datei- und Quellenaktionen

| Zustand | Deutsch | English |
| --- | --- | --- |
| Dateien prüfen | **Bradley prüft die Dateien …** | **Bradley is checking the files…** |
| Datei lesen | **Bradley liest {item} …** | **Bradley is reading {item}…** |
| Dateien durchsuchen | **Bradley durchsucht die Dateien …** | **Bradley is searching the files…** |
| Quellen prüfen | **Bradley prüft die verfügbaren Quellen …** | **Bradley is checking the available sources…** |
| Datei schreiben | **Bradley schreibt {item} …** | **Bradley is writing {item}…** |
| Datei speichern | **{item} wird gespeichert …** | **Saving {item}…** |
| Export erstellen | **Export wird erstellt …** | **Creating the export…** |
| Upload läuft | **{item} wird hochgeladen …** | **Uploading {item}…** |
| Download läuft | **{item} wird heruntergeladen …** | **Downloading {item}…** |

## Queue

| Zustand | Deutsch | English |
| --- | --- | --- |
| eingereiht, Position unbekannt | **In der Queue · wird danach ausgeführt** | **Queued · runs next** |
| eingereiht, Position bekannt | **In der Queue · Position {position}** | **Queued · position {position}** |
| wartet auf freien Platz | **In der Queue · wartet auf einen freien Platz** | **Queued · waiting for capacity** |
| als Nächstes | **Als Nächstes in der Queue** | **Next in the queue** |
| aus Queue gestartet | **Ausführung gestartet** | **Run started** |
| aus Queue entfernt | **Aus der Queue entfernt** | **Removed from the queue** |
| Queue pausiert | **Queue pausiert** | **Queue paused** |
| Queue wird fortgesetzt | **Queue wird fortgesetzt …** | **Resuming the queue…** |

„Wird danach ausgeführt“ wird nur gezeigt, wenn bereits ein anderer Lauf aktiv
ist. Ohne diese Gewissheit ist „In der Queue“ die korrekte Kurzform.

## Delegation und Spezialagenten

| Zustand | Deutsch | English |
| --- | --- | --- |
| Delegation angelegt | **Aufgabe an {agent} übergeben** | **Task assigned to {agent}** |
| eingereiht | **{agent} wartet auf Ausführung.** | **{agent} is waiting to run.** |
| läuft | **{agent} bearbeitet die Aufgabe …** | **{agent} is working on the task…** |
| wartet auf Nutzereingabe | **{agent} benötigt deine Eingabe.** | **{agent} needs your input.** |
| benötigt Aufmerksamkeit | **{agent} benötigt deine Aufmerksamkeit.** | **{agent} needs your attention.** |
| abgeschlossen | **{agent} hat die Aufgabe abgeschlossen.** | **{agent} completed the task.** |
| Ergebnis wird zugestellt | **Ergebnis von {agent} wird übernommen …** | **Adding {agent}’s result…** |
| Zustellung ausstehend | **Das Ergebnis von {agent} wird erneut zugestellt.** | **Delivery of {agent}’s result will be retried.** |
| fehlgeschlagen | **{agent} konnte die Aufgabe nicht abschließen.** | **{agent} could not complete the task.** |
| wird gestoppt | **{agent} wird gestoppt …** | **Stopping {agent}…** |
| gestoppt | **{agent} wurde gestoppt.** | **{agent} was stopped.** |

Bradley darf nicht als Ausführender einer delegierten Aufgabe erscheinen, wenn
ein benannter Spezialagent tatsächlich arbeitet. „Subagent“ bleibt eine
technische Sammelbezeichnung in Diagnose- oder Verwaltungsoberflächen, nicht
der sichtbare Name einer Personalisierung.

## Automationen und Hintergrundläufe

| Zustand | Deutsch | English |
| --- | --- | --- |
| Automation aktiv | **Aktiv** | **Active** |
| Automation pausiert | **Pausiert** | **Paused** |
| Automation deaktiviert | **Deaktiviert** | **Disabled** |
| nächster Lauf | **Nächster Lauf: {time}** | **Next run: {time}** |
| noch nicht geplant | **Noch nicht geplant** | **Not scheduled yet** |
| Lauf eingeplant | **Lauf eingeplant** | **Run queued** |
| Lauf ausstehend | **Ausstehend** | **Pending** |
| läuft im Hintergrund | **Automation läuft im Hintergrund …** | **Automation is running in the background…** |
| benannter Agent führt Lauf aus | **{agent} führt die Automation aus …** | **{agent} is running the automation…** |
| wartet auf Freigabe | **Die Automation benötigt deine Freigabe.** | **The automation needs your approval.** |
| wartet auf Eingabe | **Die Automation benötigt deine Eingabe.** | **The automation needs your input.** |
| wartet auf Integration | **Die Automation wartet auf {tool}.** | **The automation is waiting for {tool}.** |
| erfolgreich | **Erfolgreich** | **Successful** |
| teilweise abgeschlossen | **Teilweise abgeschlossen** | **Partially completed** |
| fehlgeschlagen | **Fehlgeschlagen** | **Failed** |
| Wiederholung geplant | **Neuer Versuch geplant: {time}** | **Retry scheduled: {time}** |
| wird gestoppt | **Automation wird gestoppt …** | **Stopping the automation…** |
| gestoppt | **Automation gestoppt** | **Automation stopped** |

Bradley wird in einem Automationslauf nur genannt, wenn Bradley als
ausführender Agent konfiguriert ist. Der Status der Automation selbst bleibt
neutral. Eine schlafende, pausierte oder lediglich geplante Automation wird
nicht als arbeitender Bradley dargestellt.

## Warte- und Freigabezustände

| Zustand | Deutsch | English |
| --- | --- | --- |
| Nutzereingabe erforderlich | **Deine Eingabe ist erforderlich.** | **Your input is required.** |
| Freigabe erforderlich | **Deine Freigabe ist erforderlich.** | **Your approval is required.** |
| Auswahl erforderlich | **Bitte wähle eine Option aus.** | **Choose an option to continue.** |
| Bestätigung erforderlich | **Bitte bestätige diesen Schritt.** | **Confirm this step to continue.** |
| Datei erforderlich | **Bitte füge {item} hinzu.** | **Add {item} to continue.** |
| Verbindung erforderlich | **Verbinde {tool}, um fortzufahren.** | **Connect {tool} to continue.** |
| Berechtigung erforderlich | **Berechtigung für {item} erforderlich.** | **Permission for {item} is required.** |
| externer Dienst ausstehend | **Warten auf {tool} …** | **Waiting for {tool}…** |
| Wiederholung läuft | **Erneuter Versuch …** | **Retrying…** |
| Wiederholung in Kürze | **Neuer Versuch in {time}** | **Retrying in {time}** |

Wartezustände nennen, wer handeln muss. „Warten“ allein ist nur für einen klar
benannten externen Dienst zulässig. Bradley wird nicht als unsicher, gelangweilt
oder ungeduldig beschrieben.

## Erfolgszustände

Erfolg verwendet ein kurzes Primärlabel und, sobald verfügbar, eine konkrete
Ergebniszeile.

| Zustand | Deutsch | English |
| --- | --- | --- |
| generisch abgeschlossen | **Fertig** | **Done** |
| konkretes Ergebnis | **{result}** | **{result}** |
| gespeichert | **{item} wurde gespeichert.** | **{item} was saved.** |
| erstellt | **{item} wurde erstellt.** | **{item} was created.** |
| aktualisiert | **{item} wurde aktualisiert.** | **{item} was updated.** |
| exportiert | **{item} wurde exportiert.** | **{item} was exported.** |
| hochgeladen | **{item} wurde hochgeladen.** | **{item} was uploaded.** |
| gesendet | **{item} wurde gesendet.** | **{item} was sent.** |
| keine Änderung erforderlich | **Keine Änderungen erforderlich.** | **No changes were needed.** |
| Teilerfolg | **{count} Schritte abgeschlossen. Weitere Schritte benötigen Aufmerksamkeit.** | **{count} steps completed. More steps need attention.** |

Nicht verwenden: „Ich habe das großartig erledigt“, „Bradley war erfolgreich“
oder eine Erfolgsanimation ohne konkrete Ergebnisinformation.

## Fehlerzustände

Die folgende Matrix definiert die stabilen Primär- und Ursachenzeilen. Der
vollständige Aufbau aus Ursache, Auswirkung und nächster Aktion ist in den
[Bradley Fehler- und Recovery-Mustern](./bradley-error-recovery-patterns.md)
spezifiziert.

| Zustand | Deutsch | English |
| --- | --- | --- |
| unbekannter Schrittfehler | **Bradley konnte diesen Schritt nicht abschließen.** | **Bradley could not complete this step.** |
| neutraler Laufzeitfehler | **Dieser Schritt konnte nicht abgeschlossen werden.** | **This step could not be completed.** |
| Netzwerkfehler | **Die Netzwerkverbindung ist fehlgeschlagen.** | **The network connection failed.** |
| Provider nicht erreichbar | **{tool} ist derzeit nicht erreichbar.** | **{tool} is currently unavailable.** |
| Verbindung abgelaufen | **Die Verbindung zu {tool} ist abgelaufen.** | **The connection to {tool} has expired.** |
| Autorisierung fehlgeschlagen | **{tool} konnte nicht autorisiert werden.** | **{tool} could not be authorized.** |
| Berechtigung fehlt | **Für {item} fehlt die erforderliche Berechtigung.** | **The required permission for {item} is missing.** |
| Eingabe fehlt | **Die erforderliche Eingabe fehlt.** | **The required input is missing.** |
| Datei fehlt | **{item} wurde nicht gefunden.** | **{item} was not found.** |
| Rate Limit | **Das Nutzungslimit von {tool} wurde erreicht.** | **The {tool} usage limit was reached.** |
| Zeitüberschreitung | **Der Schritt hat zu lange gedauert und wurde beendet.** | **The step took too long and was stopped.** |
| Konflikt | **{item} wurde zwischenzeitlich geändert.** | **{item} changed while this step was running.** |
| Speicherfehler | **{item} konnte nicht gespeichert werden.** | **{item} could not be saved.** |
| Tool-Fehler | **{tool} konnte die Aktion nicht ausführen.** | **{tool} could not complete the action.** |
| Delegation fehlgeschlagen | **{agent} konnte die Aufgabe nicht abschließen.** | **{agent} could not complete the task.** |
| Automation fehlgeschlagen | **Die Automation konnte diesen Lauf nicht abschließen.** | **The automation could not complete this run.** |
| Teilergebnis | **Der Schritt wurde nur teilweise abgeschlossen.** | **The step was only partially completed.** |
| Ergebniszustellung fehlgeschlagen | **Das Ergebnis konnte noch nicht zugestellt werden.** | **The result could not be delivered yet.** |
| Fehlerdetails nicht verfügbar | **Weitere Fehlerdetails sind nicht verfügbar.** | **No additional error details are available.** |

Wenn Bradley den fehlerhaften Schritt nicht selbst ausgeführt hat, wird die
neutrale Laufzeitmeldung verwendet. Interne Stacktraces, Token, API-Keys,
Authorization-Header und rohe Providerantworten gehören ausschließlich in
geschützte Diagnoseansichten.

## Zuordnung zu bestehenden UI-Begriffen

Die heute vorhandenen Übersetzungsfamilien können ohne Änderung interner
Statuswerte auf diesen Vertrag abgebildet werden:

| Bestehende Familie | Ziel in dieser Matrix |
| --- | --- |
| `chat.toolStatus*` und Tool-Batches | Tools und Dateioperationen |
| `chat.compactionStatus*` | Runtime und Antwort |
| `chat.delegationStatus*` | Delegation und Spezialagenten |
| `automationen.jobStatus.*` | Automation aktiv, pausiert oder deaktiviert |
| `automationen.runStatus.*` | ausstehend, laufend, erfolgreich, fehlgeschlagen, Wiederholung geplant |
| Studio-Generierungsstatus | Queue, laufende Tool-Aktion, Erfolg oder Fehler |
| OAuth-/Integrationsstatus | Warte-, Autorisierungs- und Verbindungsfehler |

Die eigentliche Migration der sichtbaren Strings ist nicht Teil von
BRADLEY-020. Sie erfolgt oberflächenbezogen im Runtime-, UI- und erweiterten
Rollout, damit bestehende Spezialagenten und technische Verwaltungsansichten
nicht pauschal zu Bradley umbenannt werden.

## Abnahmecheckliste

BRADLEY-020 ist erfüllt, wenn eine Implementierung für jeden sichtbaren Zustand
folgende Fragen beantworten kann:

- Ist der Zustand einer der Kategorien Runtime, Tool/Datei, Queue, Delegation,
  Automation, Warten, Erfolg oder Fehler zugeordnet?
- Gibt es einen festen deutschen und englischen Text?
- Ist der tatsächliche Akteur korrekt benannt oder bewusst neutral?
- Sind erforderliche Platzhalter vorhanden und lokalisiert?
- Bleibt der Text ohne Icon, Farbe, Animation und Metapher verständlich?
- Vermeidet der Text menschliche Gefühle, falsche Schuldzuweisung und
  ungesicherte Versprechen?

## Abschluss BRADLEY-020

Runtime-, Tool-, Datei-, Queue-, Delegations-, Automation-, Warte-, Erfolgs-
und Fehlerzustände besitzen mit dieser Matrix verbindliche DE-/EN-Texte und
einen stabilen Platzhaltervertrag. Die Detailstruktur für Recovery-Aktionen
ist im Vertrag zu BRADLEY-021 festgelegt.
