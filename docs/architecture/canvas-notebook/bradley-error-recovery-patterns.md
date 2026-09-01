---
title: Canvas Notebook — Bradley Fehler- und Recovery-Muster
status: decided
todo_id: BRADLEY-021
decision_date: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - brand
  - copy
  - errors
  - recovery
---

# Canvas Notebook — Bradley Fehler- und Recovery-Muster

## Ziel

Dieses Dokument definiert, wie Canvas Notebook Fehler im Bradley-Kontext
erklärt und eine sichere nächste Handlung anbietet. Jede sichtbare
Fehlermeldung kann damit vier Fragen beantworten:

1. **Was ist fehlgeschlagen?**
2. **Warum ist es fehlgeschlagen?**
3. **Was ist davon betroffen?**
4. **Was kann die nutzende Person jetzt tun?**

Die festen Primärtexte stammen aus der
[Bradley Zustands-Copy-Matrix](./bradley-state-copy-matrix.md). Dieses Dokument
ergänzt Aufbau, Recovery-Aktionen, Retry-Regeln, Sicherheitsgrenzen und
zweisprachige Beispiele.

## Verbindlicher Vier-Zeilen-Aufbau

| Ebene | Zweck | Deutsch | English |
| --- | --- | --- | --- |
| 1. Status | fehlgeschlagenen Schritt benennen | `Bradley konnte diesen Schritt nicht abschließen.` | `Bradley could not complete this step.` |
| 2. Ursache | bekannte, nutzergerechte Ursache | `{cause}` | `{cause}` |
| 3. Auswirkung | erhaltene und nicht ausgeführte Ergebnisse abgrenzen | `{impact}` | `{impact}` |
| 4. Recovery | genau nächste sichere Handlung | `{nextAction}` | `{nextAction}` |

In einer kompakten Oberfläche dürfen Ursache und Auswirkung visuell in einer
Zeile stehen. Semantisch bleiben es getrennte Felder. Eine Meldung darf nie nur
aus „Fehler“, einem Code oder einer Bradley-Animation bestehen.

## Datenvertrag für die UI

Jeder darstellbare Fehler benötigt folgende normalisierte Informationen:

| Feld | Pflicht | Regel |
| --- | --- | --- |
| `errorCode` | ja | stabiler, nicht lokalisierter Diagnosecode; nicht als alleinige Nutzermeldung verwenden |
| `actorKind` | ja | `bradley`, `named_agent`, `automation`, `tool` oder `system` |
| `actorName` | bedingt | sichtbarer Name bei `named_agent` oder benanntem Tool; nie automatisch auf Bradley setzen |
| `operationLabel` | ja | konkrete, lokalisierbare Aktion oder betroffene Einheit |
| `causeKey` | ja | bekannte Ursachenklasse oder `unknown`; keine rohe Providerantwort |
| `impactKey` | ja | beschreibt gespeicherte, teilweise gespeicherte oder nicht ausgeführte Wirkung |
| `recoveryKind` | ja | eine der freigegebenen Recovery-Aktionen |
| `retryAt` | bedingt | erforderlich bei zeitgesteuertem Retry oder Rate Limit |
| `isRetrySafe` | ja | nur `true`, wenn Wiederholung keine doppelten fachlichen Effekte erzeugt |
| `supportReference` | optional | kurze Referenz für Support; keine interne ID mit Personen- oder Secretbezug |

`causeKey`, `impactKey` und `recoveryKind` werden lokalisiert. Stacktrace,
Fehlerobjekt und technische Metadaten bleiben davon getrennt in einer
geschützten Diagnoseansicht oder in redigierten Logs.

## Auswahl der Statuszeile

| Tatsächliche Quelle | Status DE | Status EN |
| --- | --- | --- |
| Bradley führte den Schritt aus | **Bradley konnte diesen Schritt nicht abschließen.** | **Bradley could not complete this step.** |
| benannter Spezialagent | **{agent} konnte die Aufgabe nicht abschließen.** | **{agent} could not complete the task.** |
| Automation | **Die Automation konnte diesen Lauf nicht abschließen.** | **The automation could not complete this run.** |
| Tool oder Integration | **{tool} konnte die Aktion nicht ausführen.** | **{tool} could not complete the action.** |
| Runtime, Queue oder unbekannte Quelle | **Dieser Schritt konnte nicht abgeschlossen werden.** | **This step could not be completed.** |

Bradley übernimmt nicht sprachlich die Schuld für eine fehlende Berechtigung,
eine abgelaufene Verbindung oder einen Provider-Ausfall. Bradley darf als
Akteur der Statuszeile erscheinen, die Ursachenzeile nennt aber weiterhin die
tatsächliche technische Ursache.

## Ursachenklassen

| Ursache | Deutsch | English |
| --- | --- | --- |
| unbekannt | **Die Ursache konnte nicht ermittelt werden.** | **The cause could not be determined.** |
| Netzwerk | **Die Netzwerkverbindung ist fehlgeschlagen.** | **The network connection failed.** |
| Provider nicht verfügbar | **{tool} ist derzeit nicht erreichbar.** | **{tool} is currently unavailable.** |
| Verbindung abgelaufen | **Die Verbindung zu {tool} ist abgelaufen.** | **The connection to {tool} has expired.** |
| Autorisierung abgelehnt | **{tool} konnte nicht autorisiert werden.** | **{tool} could not be authorized.** |
| Berechtigung fehlt | **Für {item} fehlt die erforderliche Berechtigung.** | **The required permission for {item} is missing.** |
| Freigabe fehlt | **Dieser Schritt wurde noch nicht freigegeben.** | **This step has not been approved yet.** |
| Eingabe fehlt | **Die erforderliche Eingabe fehlt.** | **The required input is missing.** |
| Datei fehlt | **{item} wurde nicht gefunden.** | **{item} was not found.** |
| Nutzungslimit | **Das Nutzungslimit von {tool} wurde erreicht.** | **The {tool} usage limit was reached.** |
| Zeitüberschreitung | **Der Schritt hat das Zeitlimit überschritten.** | **The step exceeded its time limit.** |
| Dateikonflikt | **{item} wurde zwischenzeitlich geändert.** | **{item} changed while this step was running.** |
| Speicherfehler | **{item} konnte nicht gespeichert werden.** | **{item} could not be saved.** |
| ungültige Eingabe | **{item} hat nicht das erwartete Format.** | **{item} is not in the expected format.** |
| Sicherheitsregel | **Eine Sicherheitsregel blockiert diesen Schritt.** | **A security rule is blocking this step.** |
| Abbruch | **Die Ausführung wurde gestoppt.** | **The run was stopped.** |

„Unbekannt“ ist ein zulässiger, ehrlicher Zustand. Eine vermutete Ursache wird
nicht als Tatsache formuliert. Falls eine begründete Vermutung hilfreich ist,
wird sie ausdrücklich als solche gekennzeichnet: „Möglicherweise …“ / “This
may be because …”.

## Auswirkungsklassen

| Auswirkung | Deutsch | English |
| --- | --- | --- |
| nichts geändert | **Es wurden keine Änderungen gespeichert.** | **No changes were saved.** |
| vorhandener Stand erhalten | **Dein bisheriger Stand bleibt erhalten.** | **Your existing work is unchanged.** |
| Ergebnis nicht erstellt | **{item} wurde nicht erstellt.** | **{item} was not created.** |
| Ergebnis nicht gespeichert | **Die neuen Änderungen an {item} wurden nicht gespeichert.** | **The new changes to {item} were not saved.** |
| Teilergebnis vorhanden | **{count} Schritte wurden abgeschlossen; die übrigen Änderungen wurden nicht ausgeführt.** | **{count} steps completed; the remaining changes did not run.** |
| Entwurf erhalten | **Der Entwurf bleibt gespeichert und wurde nicht gesendet.** | **The draft remains saved and was not sent.** |
| Nachricht möglicherweise gesendet | **Der Sendestatus ist noch unklar. Sende nicht erneut, bevor du den Postausgang geprüft hast.** | **The delivery status is still unknown. Do not send again until you check the outbox.** |
| Automation pausiert | **Weitere Läufe bleiben pausiert, bis die Verbindung wiederhergestellt ist.** | **Future runs remain paused until the connection is restored.** |
| nur aktueller Lauf betroffen | **Nur dieser Lauf ist betroffen; die Automation bleibt aktiv.** | **Only this run is affected; the automation remains active.** |
| Delegation ohne Ergebnis | **Es wurde kein Ergebnis von {agent} übernommen.** | **No result from {agent} was added.** |
| Lesen möglich, Schreiben blockiert | **Du kannst weiter lesen; Änderungen sind vorübergehend blockiert.** | **You can keep reading; changes are temporarily blocked.** |

Die Auswirkungszeile behauptet nur Persistenz, Versand oder Rollback, wenn die
Runtime diesen Zustand belegen kann. Bei einem unbekannten Seiteneffekt wird
die Unsicherheit ausdrücklich benannt und ein blindes Retry verhindert.

## Freigegebene Recovery-Aktionen

| `recoveryKind` | Button oder Link DE | Button or link EN | Wann zulässig |
| --- | --- | --- | --- |
| `retry_now` | **Erneut versuchen** | **Try again** | Operation ist idempotent oder nachweislich ohne Seiteneffekt fehlgeschlagen |
| `retry_later` | **Später erneut versuchen** | **Try again later** | externer Dienst ist temporär nicht verfügbar; kein enger Retry-Loop |
| `reconnect` | **{tool} verbinden** | **Connect {tool}** | Verbindung fehlt oder ist abgelaufen |
| `check_integration` | **Integration prüfen** | **Check integration** | Konfiguration oder Providerstatus muss geprüft werden |
| `request_approval` | **Freigabe öffnen** | **Open approval** | menschliche Freigabe ist fachlich erforderlich |
| `request_access` | **Zugriff anfordern** | **Request access** | Berechtigung kann von einer zuständigen Person erteilt werden |
| `choose_input` | **Eingabe ergänzen** | **Add input** | Datei, Auswahl oder Pflichtwert fehlt |
| `review_conflict` | **Konflikt prüfen** | **Review conflict** | konkurrierende Änderung muss bewusst aufgelöst werden |
| `open_outbox` | **Postausgang prüfen** | **Check outbox** | Versandstatus ist unbekannt oder Zustellung steht aus |
| `open_result` | **Teilergebnis öffnen** | **Open partial result** | verwertbares Teilergebnis ist sicher gespeichert |
| `resume` | **Fortsetzen** | **Resume** | ein pausierter, persistierter Lauf kann sicher fortgesetzt werden |
| `contact_admin` | **Administration kontaktieren** | **Contact administrator** | Instanzregel oder nicht selbst änderbare Berechtigung blockiert |
| `copy_reference` | **Referenz kopieren** | **Copy reference** | Support-Referenz ist redigiert und für die nutzende Person bestimmt |
| `dismiss` | **Schließen** | **Close** | keine Aktion erforderlich oder Zustand bereits terminal |

Pro Meldung gibt es höchstens eine primäre Recovery-Aktion. Eine sekundäre
Aktion darf Details, Integrationseinstellungen oder Support öffnen. „Erneut
versuchen“ und „Fortsetzen“ sind keine Default-Aktionen für Schreib-, Versand-,
Zahlungs- oder andere potenziell doppelte Seiteneffekte.

## Retry- und Idempotenzregeln

1. Ein automatischer Retry ist nur erlaubt, wenn `isRetrySafe=true` aus der
   Fachlogik stammt; die UI leitet dies nicht aus einem HTTP-Status ab.
2. Netzwerkabbruch bedeutet nicht automatisch, dass der Server nichts
   ausgeführt hat. Bei unklarem Commit- oder Sendestatus wird zuerst der
   Zielzustand geprüft.
3. Rate Limits und geplante Wiederholungen zeigen `retryAt` als lokalisierte
   Zeit. Die UI erzeugt keinen aggressiven Countdown und keinen manuellen
   Doppelklick-Loop.
4. Ein Retry verwendet denselben fachlichen Idempotenzschlüssel, sofern das
   Ausführungsmodell einen solchen besitzt.
5. Nach mehreren automatischen Fehlversuchen wird die Wiederholung sichtbar
   eskaliert oder pausiert. Bradley behauptet nicht dauerhaft, noch zu arbeiten.
6. Ein Nutzerabbruch wird als „gestoppt“ und nicht als technischer Fehler
   dargestellt, solange der Abbruch selbst erfolgreich war.

## Vollständige DE-/EN-Beispiele

### Netzwerkfehler bei sicherem Lesevorgang

| Ebene | Deutsch | English |
| --- | --- | --- |
| Status | Bradley konnte diesen Schritt nicht abschließen. | Bradley could not complete this step. |
| Ursache | Die Netzwerkverbindung ist fehlgeschlagen. | The network connection failed. |
| Auswirkung | Es wurden keine Änderungen gespeichert. | No changes were saved. |
| Aktion | **Erneut versuchen** | **Try again** |

### Abgelaufene Integration

| Ebene | Deutsch | English |
| --- | --- | --- |
| Status | Figma konnte die Aktion nicht ausführen. | Figma could not complete the action. |
| Ursache | Die Verbindung zu Figma ist abgelaufen. | The connection to Figma has expired. |
| Auswirkung | Der Export wurde nicht erstellt. | The export was not created. |
| Aktion | **Figma verbinden** | **Connect Figma** |

### Fehlende Dateiberechtigung

| Ebene | Deutsch | English |
| --- | --- | --- |
| Status | Bradley konnte diesen Schritt nicht abschließen. | Bradley could not complete this step. |
| Ursache | Für `release-notes.md` fehlt die erforderliche Berechtigung. | The required permission for `release-notes.md` is missing. |
| Auswirkung | Dein bisheriger Stand bleibt erhalten. | Your existing work is unchanged. |
| Aktion | **Zugriff anfordern** | **Request access** |

### Menschliche Freigabe

Eine fehlende Freigabe ist zunächst ein Wartezustand, kein Fehler:

| Ebene | Deutsch | English |
| --- | --- | --- |
| Status | Deine Freigabe ist erforderlich. | Your approval is required. |
| Ursache | Dieser Schritt wurde noch nicht freigegeben. | This step has not been approved yet. |
| Auswirkung | Es wurden keine Änderungen ausgeführt. | No changes were made. |
| Aktion | **Freigabe öffnen** | **Open approval** |

### Nutzungslimit mit geplantem Retry

| Ebene | Deutsch | English |
| --- | --- | --- |
| Status | Die Automation konnte diesen Lauf nicht abschließen. | The automation could not complete this run. |
| Ursache | Das Nutzungslimit von Anthropic wurde erreicht. | The Anthropic usage limit was reached. |
| Auswirkung | Nur dieser Lauf ist betroffen; die Automation bleibt aktiv. | Only this run is affected; the automation remains active. |
| Aktion | **Neuer Versuch geplant: {time}** | **Retry scheduled: {time}** |

### Dateikonflikt

| Ebene | Deutsch | English |
| --- | --- | --- |
| Status | Bradley konnte diesen Schritt nicht abschließen. | Bradley could not complete this step. |
| Ursache | `plan.md` wurde zwischenzeitlich geändert. | `plan.md` changed while this step was running. |
| Auswirkung | Die neuen Änderungen wurden nicht gespeichert. | The new changes were not saved. |
| Aktion | **Konflikt prüfen** | **Review conflict** |

### Unklarer E-Mail-Sendestatus

| Ebene | Deutsch | English |
| --- | --- | --- |
| Status | Dieser Schritt konnte nicht abgeschlossen werden. | This step could not be completed. |
| Ursache | Die Verbindung wurde während des Sendens unterbrochen. | The connection was interrupted while sending. |
| Auswirkung | Der Sendestatus ist noch unklar. Sende nicht erneut, bevor du den Postausgang geprüft hast. | The delivery status is still unknown. Do not send again until you check the outbox. |
| Aktion | **Postausgang prüfen** | **Check outbox** |

### Teilergebnis einer Delegation

| Ebene | Deutsch | English |
| --- | --- | --- |
| Status | Research Agent konnte die Aufgabe nicht abschließen. | Research Agent could not complete the task. |
| Ursache | Eine Quelle war nicht erreichbar. | One source was unavailable. |
| Auswirkung | 3 Quellen wurden ausgewertet; die übrige Analyse wurde nicht ausgeführt. | 3 sources were reviewed; the remaining analysis did not run. |
| Aktion | **Teilergebnis öffnen** | **Open partial result** |

## Darstellung und Barrierefreiheit

- Status, Ursache und Auswirkung sind normaler Text; Recovery ist ein klar
  beschrifteter Button oder Link.
- Die Statuszeile ist die zugängliche Bezeichnung. Bradley-Illustration und
  Fehlericon sind dekorativ, wenn sie keine zusätzliche Information tragen.
- Neue Fehler werden einmal über eine passende Live-Region angekündigt. Eine
  wiederkehrende Retry-Anzeige darf Screenreader nicht bei jedem Tick stören.
- Fokus springt nur bei blockierenden Dialogen in die Meldung. Inline- und
  Hintergrundfehler stehlen nicht ungefragt den Fokus.
- Farbe unterscheidet Schweregrade nicht allein. Text und Aktion bleiben bei
  High Contrast und ohne Animation vollständig nutzbar.
- Reduced Motion deaktiviert dekorative Zustandsbewegung; Recovery und
  Fortschrittsinformation bleiben unverändert.

## Sicherheits- und Datenschutzgrenzen

Sichtbare Fehler enthalten niemals:

- API-Keys, OAuth-Tokens, Cookies oder Authorization-Header;
- vollständige Stacktraces oder rohe Providerantworten;
- lokale absolute Pfade, wenn ein kurzer Dateiname ausreicht;
- interne Nutzer-, Workspace-, Session- oder Datenbank-IDs;
- Inhalte anderer Workspaces oder nicht berechtigter Ressourcen;
- die Behauptung, Daten seien sicher gespeichert, gelöscht oder nicht gesendet,
  wenn dieser Zustand technisch nicht bestätigt ist.

Eine Support-Referenz ist zufällig, kurzlebig oder nicht sensibel und führt nur
in berechtigten Diagnoseoberflächen zu weiteren Details.

## Review-Checkliste

Eine Fehlerdarstellung ist freigegeben, wenn:

- Status, Ursache, Auswirkung und nächste Aktion vorhanden oder mit einem
  ehrlichen Fallback abgedeckt sind;
- der tatsächliche Akteur genannt wird und Bradley keine fremde Schuld übernimmt;
- der Retry nachweislich sicher ist oder bewusst nicht angeboten wird;
- Teilresultate, gespeicherter Stand und unklare Seiteneffekte präzise
  voneinander getrennt sind;
- genau eine primäre Recovery-Aktion sichtbar ist;
- keine Secrets, fremden Daten oder ungefilterten technischen Details erscheinen;
- die Meldung in Deutsch und Englisch ohne Icon oder Animation verständlich ist;
- Fokus, Live-Region, High Contrast und Reduced Motion berücksichtigt sind.

## Abschluss BRADLEY-021

Mit dem Vier-Zeilen-Aufbau, dem normalisierten Fehlervertrag, den freigegebenen
Recovery-Aktionen und den Retry-, Sicherheits- und Accessibility-Regeln kann
jede Fehlermeldung Ursache, Auswirkung und nächste Handlung sachlich anzeigen.
