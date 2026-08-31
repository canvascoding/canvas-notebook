---
title: Canvas Notebook — Bradley Agenten- und Oberflächenkontextmatrix
status: decided
todo_id: BRADLEY-022
decision_date: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - brand
  - identity
  - icons
  - ui
---

# Canvas Notebook — Bradley Agenten- und Oberflächenkontextmatrix

## Ziel

Diese Matrix legt für jede relevante Oberfläche fest, welcher sichtbare Name
und welches Icon erscheinen. Sie verhindert, dass Bradley pauschal für
Spezialagenten, E-Mail-Funktionen, Automationen, Tools oder den Canvas Host
Agent verwendet wird.

Die Matrix ist ein Design- und Attribution-Vertrag. Interne IDs, Datenmodelle
und Pfade werden dadurch nicht umbenannt.

## Grundprinzip: Quelle vor Marke

Eine Oberfläche zeigt zuerst die Identität der Einheit, deren Zustand oder
Ergebnis sie darstellt:

- ein Bradley-Chat zeigt Bradley;
- eine delegierte Aufgabe zeigt den tatsächlich ausführenden Spezialagenten;
- eine Automation zeigt zuerst die Automation und zusätzlich ihren
  konfigurierten Agenten;
- eine E-Mail-Oberfläche zeigt Postfach, Nachricht oder E-Mail-Agent;
- ein Tool-Schritt zeigt das Tool;
- eine Host- oder VM-Oberfläche zeigt den Canvas Host Agent;
- ein neutraler Systemzustand zeigt Canvas Notebook oder ein Funktionsicon.

Der Bradley-Glyph ist damit ein Herkunftszeichen für den Hauptagenten und kein
allgemeines Symbol für AI, Aktivität oder Erfolg.

## Identitäten und visuelle Zeichen

| Einheit | Sichtbarer Name DE | Visible name EN | Primäres Icon | Verbotener Fallback |
| --- | --- | --- | --- | --- |
| Hauptagent, interne ID `canvas-agent` | **Bradley** | **Bradley** | Bradley-Glyph passend zu Theme und Kontrast | `Canvas Agent`, Initiale B, generisches Bot-Icon |
| benannter Spezialagent | konfigurierter vollständiger Name | configured full name | konfiguriertes Avatar/Icon, sonst neutrales Agenten-Icon mit zugänglichem Namen | Bradley-Glyph |
| unbenannter technischer Spezialagent | **Agent** plus Funktionsbezeichnung | **Agent** plus function label | neutrales Agenten- oder Funktionsicon | erfundener Personenname, Bradley-Glyph |
| E-Mail-Agent mit Profilname | konfigurierter Profilname | configured profile name | Profilavatar mit kleinem E-Mail-Badge oder E-Mail-Icon | Bradley-Glyph |
| E-Mail-Agent ohne Profilname | **E-Mail-Agent** | **Email Agent** | E-Mail-/Umschlag-Icon | Bradley, `canvas-agent` |
| Automation | konfigurierter Automationsname | configured automation name | Automation-/Wiederholungsicon | Bradley-Glyph als primäres Icon |
| Tool oder Integration | sichtbarer Toolname | visible tool name | offizielles Toolicon, sonst neutrales Werkzeug-/Integrationsicon | Bradley-Glyph |
| Canvas Notebook System | **Canvas Notebook** | **Canvas Notebook** | App- oder neutrales Systemicon | Bradley für systemweite Zustände |
| technischer Host-Dienst | **Canvas Host Agent** | **Canvas Host Agent** | neutrales Server-/Host-Icon | Bradley-Glyph, „Canvas Agent“ |
| Canvas Control Plane | **Canvas Control Plane** | **Canvas Control Plane** | Plattform-/Control-Plane-Icon | Bradley-Glyph |
| Nutzer | Profilname | profile name | Nutzeravatar oder Initialen-Fallback | Agentenicon |

## Icon-Hierarchie und Fallbacks

1. Eine explizit konfigurierte Identität gewinnt vor einem generischen
   Fallback.
2. Bradley verwendet immer den freigegebenen Bradley-Glyph; für kleine Größen
   gelten [Glyph-QA](./assets/bradley/GLYPH-QA.md) und
   [High-Contrast-QA](./assets/bradley/GLYPH-CONTRAST-QA.md).
3. Ein Spezialagent ohne eigenes Bild erhält ein neutrales Agenten- oder
   Funktionsicon. Seine Initialen sind nur zulässig, wenn ein sichtbarer Name
   vorhanden ist und die Initialen eindeutig erzeugt werden können.
4. Der E-Mail-Agent behält eine erkennbare E-Mail-Codierung. Ein Profilavatar
   darf das Hauptbild sein, erhält aber ein kleines Mail-Badge, wenn sonst eine
   Verwechslung mit einem normalen Chat-Agenten wahrscheinlich ist.
5. Eine Automation verwendet primär ihr Automation-Icon. Der ausführende Agent
   erscheint als beschriftete sekundäre Attribution, nicht als Ersatz für die
   Automation.
6. Tool-, Datei-, Freigabe-, Warn- und Fehlericons beschreiben die Funktion
   oder den Zustand. Sie werden nicht durch Bradley ersetzt.
7. Icons erhalten keinen redundanten Alternativtext, wenn Name und Status
   direkt daneben stehen. Ohne sichtbaren Namen braucht das zugängliche Label
   die tatsächliche Identität.

## Hauptnavigation und Agentenauswahl

| Oberfläche | Primärer Name | Primäres Icon | Sekundäre Attribution | Regel |
| --- | --- | --- | --- | --- |
| Hauptagent im Agent-Selector | Bradley | Bradley-Glyph | optional „Hauptagent“ / “Main agent” | interne ID nicht im normalen Selector zeigen |
| Spezialagent im Agent-Selector | Agentenname | Agentenavatar oder Fallback | Funktionsbeschreibung | nie zu Bradley umbenennen |
| E-Mail-Agent im Agent-Selector | Profilname oder E-Mail-Agent | Profilavatar mit Mail-Badge oder E-Mail-Icon | „E-Mail“ / “Email” | nur zeigen, wenn als wählbarer Agent verfügbar |
| Agent erstellen | „Neuer Agent“ / “New agent” | neutrales Plus-/Agentenicon | keine | Bradley-Glyph nicht als Default-Vorlage verwenden |
| zuletzt verwendeter Agent | tatsächlicher Agentenname | tatsächliches Agentenicon | letzter Kontext optional | gespeicherte Auswahl respektieren |
| technisches Agentenprofil | sichtbarer Name | tatsächliches Icon | interne ID nur in Details | Bradley und `canvas-agent` klar trennen |

## Chat und Laufzeit

| Oberfläche | Primärer Name | Primäres Icon | Sekundäre Attribution | Regel |
| --- | --- | --- | --- | --- |
| Bradley-Chat-Header | Bradley | Bradley-Glyph | optional Modell/Workspace in Details | Hauptagent eindeutig sichtbar |
| Spezialagent-Chat-Header | Agentenname | Agentenavatar oder Fallback | Agentenrolle | Bradley nicht als Dachmarke daneben setzen |
| E-Mail-Agent-Chat-Header | Profilname oder E-Mail-Agent | Profilavatar mit Mail-Badge oder E-Mail-Icon | Postfach/Workspace, sofern relevant | nicht wie normalen Bradley-Chat aussehen lassen |
| Assistant-Nachricht | tatsächlicher Autor | Autor-Icon | Zeit/Modell optional | historische Nachricht behält ursprüngliche Attribution |
| laufender Antwortstatus | tatsächlich aktiver Agent | Zustandsvariante seines Icons | konkrete Aktion | Bradley-Arbeitsglyph nur bei Bradley-Lauf |
| Tool-Zeile im Chat | Toolname oder Aktion | Tool-/Funktionsicon | „Ausgeführt von {agent}“ bei Bedarf | Toolstatus ist kein Bradley-Avatar |
| Dateioperation | Dateiname oder Aktion | Datei-/Operation-Icon | ausführender Agent optional | Dateityp bleibt erkennbar |
| Stop-/Cancel-Zustand | betroffener Lauf | neutrales Stop-Icon oder Agentenicon plus Badge | tatsächlicher Agent | nicht als Bradley-Emotion darstellen |
| Fehlerkarte | fehlgeschlagene Einheit | Fehler-/Einheitenicon | tatsächlicher Agent, falls relevant | folgt Recovery-Vertrag, keine Maskottchen-Schuldzuweisung |
| Starter-/Empty-State | aktuell ausgewählter Agent | dessen Character/Icon | Rolle und mögliche Aktionen | Bradley-Character nur im Bradley-Kontext |

Eine Session, die historisch mit einem anderen Agenten erzeugt wurde, wird beim
Öffnen nicht nachträglich auf Bradley umetikettiert. Eine spätere
Display-Name-Migration darf nur den tatsächlichen Standard-Hauptagenten
betreffen.

## Delegation und Agentenzusammenarbeit

| Oberfläche | Primärer Name | Primäres Icon | Sekundäre Attribution | Regel |
| --- | --- | --- | --- | --- |
| Delegation wird erstellt | Zielagent | Zielagentenicon | „Übergeben von Bradley“, wenn Bradley delegiert | Ziel ist visuell dominant |
| Delegation läuft | Zielagent | Zielagentenicon mit neutralem Arbeitsbadge | Aufgabe/Status | Bradley-Arbeitsglyph nicht übernehmen |
| Delegation wartet | Zielagent | Zielagentenicon mit Wartebadge | benötigte Person/Aktion | keine unsichere Bradley-Pose |
| Delegation abgeschlossen | Zielagent | Zielagentenicon mit Done-Badge | Ergebnis wird an Ursprung übernommen | Erfolg bleibt dem Zielagenten zugeordnet |
| Ergebnis im Bradley-Chat | Zielagent in Quellenzeile | kleines Zielagentenicon | „Von {agent}“ / “From {agent}” | Bradley darf das Ergebnis zusammenfassen, Herkunft bleibt sichtbar |
| Delegationsübersicht | tatsächliche Agenten | jeweilige Icons | Anzahl und Status | Sammelname „Subagenten“ nur als Bereichslabel |
| unbenannte technische Delegation | Funktionsbezeichnung | neutrales Funktionsicon | technische Rolle | keinen neuen Personennamen erfinden |

## E-Mail-Oberflächen

| Oberfläche | Primärer Name | Primäres Icon | Sekundäre Attribution | Regel |
| --- | --- | --- | --- | --- |
| Posteingangsliste | Absender | Absenderavatar oder Initialen | Postfach/Datum | kein Agentenbranding |
| geöffnete empfangene E-Mail | Absender | Absenderavatar | Empfänger/Postfach | Bradley nicht als Leser darstellen |
| E-Mail-App-Empty-State | „E-Mail“ / “Email” | E-Mail-Icon | Verbindung oder nächste Aktion | Bradley nur bei expliziter Bradley-Hilfe ergänzen |
| vom E-Mail-Agent erzeugter Entwurf | Profilname oder E-Mail-Agent | Profilavatar mit Mail-Badge oder E-Mail-Icon | „Entwurf“ / “Draft” | tatsächliche Entwurfsquelle zeigen |
| von Bradley erzeugter E-Mail-Entwurf | Bradley | Bradley-Glyph plus kleines Mail-Funktionsbadge | „Entwurf“ / “Draft” | nur wenn Bradley tatsächlich Autor des Entwurfs ist |
| manueller Nutzerentwurf | Nutzername oder kein Autorlabel | Nutzeravatar oder E-Mail-Icon | „Entwurf“ / “Draft” | keinem Agenten zuschreiben |
| Review- und Freigabeschritt | Entwurf/Empfänger | E-Mail-/Freigabeicon | erstellender Akteur | menschliche Freigabe visuell dominant |
| Postausgang | Empfänger oder Betreff | E-Mail-/Outbox-Icon | Ersteller und Sendestatus | unklaren Versandstatus nicht Bradley zuschreiben |
| E-Mail-Automation | Automationsname | Automation-Icon | Postfach und ausführender Agent | Automation bleibt primäre Einheit |

Der E-Mail-Agent ist eine eigene Identität. Ein konfigurierter Profilname ersetzt
den generischen Namen „E-Mail-Agent“, nicht aber die erkennbare E-Mail-Funktion.

## Automationen und Hintergrundläufe

| Oberfläche | Primärer Name | Primäres Icon | Sekundäre Attribution | Regel |
| --- | --- | --- | --- | --- |
| Automationsübersicht | Automationsname | Automation-Icon | Status und nächster Lauf | Bradley nicht als Listenicon verwenden |
| Automationsdetail | Automationsname | Automation-Icon | „Agent: {agent}“ | ausgewählten Agenten immer sichtbar machen |
| aktiver Hintergrundlauf | Automationsname | Automation-Icon mit Arbeitsbadge | „Ausgeführt von {agent}“ | Arbeit der Automation und Akteur trennen |
| Laufhistorie | Automationsname oder Laufnummer | Automation-/History-Icon | Agent, Trigger, Zeit, Status | historische Konfiguration erhalten |
| Run-Chat | tatsächlich ausführender Agent | Agentenicon | Automationsname als Kontext | im Chat ist der Autor primär |
| Automation wartet auf Freigabe | Automationsname | Automation- plus Freigabeicon | angeforderte Aktion und Agent | keine fortlaufende Bradley-Animation |
| Automation fehlgeschlagen | Automationsname | Automation- plus Fehlericon | Agent und Ursache | Recovery-Vertrag verwenden |
| Automation pausiert | Automationsname | statisches Automation-/Pause-Icon | Pausengrund | Bradley nicht als wartend darstellen |
| Ergebnisbenachrichtigung | Automationsname | Automation-Icon | Ergebnisquelle `{agent}` | Bradley nur nennen, wenn konfigurierter Akteur |

Die Automation ist ein Auftrag mit eigener Identität, kein weiterer Charakter.
Sie erhält keinen Personennamen, keine Augen und keine Bradley-Silhouette.

## Benachrichtigungen, To-dos und Freigaben

| Oberfläche | Primärer Name | Primäres Icon | Sekundäre Attribution | Regel |
| --- | --- | --- | --- | --- |
| Bradley-Ergebnis | Bradley | Bradley-Glyph | konkrete Aufgabe | nur bei tatsächlichem Bradley-Ergebnis |
| Spezialagent-Ergebnis | Agentenname | Agentenicon | Ursprungssession/Automation | tatsächliche Quelle zeigen |
| Automationsergebnis | Automationsname | Automation-Icon | ausführender Agent | Automation primär |
| E-Mail-Entwurf zur Prüfung | Betreff oder E-Mail-Agent | E-Mail-/Review-Icon | Ersteller und Postfach | Freigabehandlung klar benennen |
| allgemeines System-To-do | Aufgabenname | Kategorie-/To-do-Icon | Canvas Notebook nur bei Bedarf | kein Bradley-Glyph als generischer Marker |
| Tool-Autorisierung | Toolname | Toolicon | anfordernder Agent optional | Tool und Nutzeraktion primär |
| Berechtigungsfreigabe | Ressource/Aktion | Schloss-/Freigabeicon | anfordernder Akteur | Sicherheit vor Charakterbranding |
| Push-/E-Mail-Benachrichtigung | tatsächliche Quelle im Absender-/Titeltext | Quellenicon, soweit Kanal unterstützt | Workspace/Automation | kein pauschales „Bradley meldet“ |

## Einstellungen, Betrieb und Diagnose

| Oberfläche | Primärer Name | Primäres Icon | Sekundäre Attribution | Regel |
| --- | --- | --- | --- | --- |
| Bradley-Einstellungen | Bradley | Bradley-Glyph | „Hauptagent“ | persönliche Präferenzen klar von Produktidentität trennen |
| Spezialagent-Einstellungen | Agentenname | Agentenicon | Agententyp | eigene Dateien und Identität behalten |
| Integrationen | Tool-/Integrationsname | Toolicon | Verbindungsstatus | kein Agentenicon als Providerzeichen |
| Runtime-/Systemstatus | Canvas Notebook | Systemicon | betroffene Komponente | neutral bleiben |
| Control-Plane-VM-Ansicht | Canvas Host Agent | Server-/Host-Icon | VM und letzter Kontakt | niemals Bradley-Glyph |
| Host-Metriken | VM oder Canvas Host Agent | Infrastrukturicon | Messzeitpunkt | keine Character-Animation |
| Audit-Log | tatsächlicher Akteur | kleines Akteurs-/Systemicon | Aktion, Ziel, Zeit | interne ID zusätzlich nur bei berechtigtem Detailbedarf |
| technische Diagnose | sichtbarer Name plus technische ID | neutrales Diagnoseicon | Rolle und Komponente | sichtbaren Namen und Literalwerte nicht vermischen |

## Kombinationen und visuelle Priorität

Wenn mehrere Einheiten beteiligt sind, gilt folgende Darstellung:

```text
Primär: Gegenstand der aktuellen Oberfläche
Sekundär: tatsächlich ausführender oder auslösender Akteur
Tertiär: Workspace, Tool, Trigger oder technischer Kontext
```

Beispiele:

| Kontext | Primär | Sekundär | Tertiär |
| --- | --- | --- | --- |
| Automationskarte | „Täglicher Markt-Check“ + Automation-Icon | „Agent: Bradley“ + kleiner Bradley-Glyph | „Morgen, 09:00“ |
| delegierte Recherche | „Research Agent“ + Agentenicon | „Übergeben von Bradley“ | „3 Quellen“ |
| E-Mail-Entwurf aus Automation | Betreff + E-Mail-Icon | „E-Mail-Agent · Automation Kundenanfragen“ | Postfachname |
| Host-Neustart | „Canvas Host Agent“ + Server-Icon | „Neustart abgeschlossen“ | VM-Name |

Es werden höchstens zwei Identitätsicons gleichzeitig gezeigt. Weitere
Kontexte erscheinen als Text, damit keine Reihe konkurrierender Avatare
entsteht.

## Accessibility- und Testvertrag

- Name und Rolle müssen als Text verfügbar sein; das Icon allein reicht nicht.
- Der zugängliche Name eines Icons entspricht der tatsächlichen Einheit und
  nicht der generischen Kategorie „Agent“.
- Statusbadges besitzen einen Textstatus aus der
  [Zustands-Copy-Matrix](./bradley-state-copy-matrix.md).
- High Contrast verwendet die passenden Bradley-Varianten nur für Bradley;
  andere Icons brauchen eigene systemfarbige Varianten.
- Reduced Motion ändert weder Name noch Attribution. Nur das Bewegungsverhalten
  des aktiven Icons wird reduziert.
- Ein späterer UI-Test muss Hauptagent, Spezialagent, E-Mail-Agent, Automation,
  Tool und Canvas Host Agent gezielt gegeneinander prüfen.
- Historische Nachrichten und Runs müssen ihre bei Ausführung gültige Quelle
  behalten oder einen klaren Migrationsfallback zeigen.

## Review-Checkliste

Eine Oberfläche ist kontextuell freigegeben, wenn:

- die primäre Einheit der Oberfläche korrekt benannt ist;
- Bradley nur für den Hauptagenten `canvas-agent` erscheint;
- Spezialagent und E-Mail-Agent ihre eigene Identität behalten;
- eine Automation ihren Namen und ihr Automation-Icon behält und den
  ausführenden Agenten zusätzlich nennt;
- Tool-, Datei-, Freigabe- und Fehlericons ihre Funktion zeigen;
- Canvas Host Agent und Control Plane nie den Bradley-Glyph verwenden;
- Fallbacks keine erfundenen Personen oder falschen Quellen erzeugen;
- Name, Status und Attribution ohne Farbe, Animation oder Icon verständlich sind.

## Abschluss BRADLEY-022

Für Hauptnavigation, Chat, Delegation, E-Mail, Automationen,
Benachrichtigungen, Einstellungen, Betrieb und Diagnose sind primärer Name,
Icon, sekundäre Attribution und Fallback verbindlich festgelegt. Damit bleibt
Bradley klar als Hauptagent erkennbar, ohne andere Akteure zu überschreiben.
