---
title: Canvas Notebook — Bradley UI-Präsenz-, Anti-Clippy- und Motion-Regeln
status: decided
todo_id: BRADLEY-023
decision_date: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - accessibility
  - motion
  - ui
  - review
---

# Canvas Notebook — Bradley UI-Präsenz-, Anti-Clippy- und Motion-Regeln

## Ziel

Bradley soll eine warme, erkennbare Identität geben, ohne Aufmerksamkeit zu
beanspruchen, Arbeit zu verdecken oder den Eindruck einer ständig
beobachtenden Figur zu erzeugen. Dieses Dokument überführt die Anti-Clippy-
Prinzipien und die freigegebene
[Motion-Spezifikation](./assets/bradley/MOTION-SPEC.md) in verbindliche Regeln
für Produktoberflächen und Reviews.

Die Regeln gelten nur auf Flächen, auf denen Bradley gemäß der
[Agenten- und Oberflächenkontextmatrix](./bradley-agent-context-matrix.md)
tatsächlich der sichtbare Akteur ist.

## Anti-Clippy bedeutet für Canvas Notebook

Bradley darf:

- den ausgewählten Hauptagenten eindeutig kennzeichnen;
- einen echten Laufzustand dezent anzeigen;
- bei Onboarding und einem gezielten Empty State Orientierung geben;
- auf erforderliche Eingabe oder Freigabe mit sachlichem Status hinweisen;
- einen abgeschlossenen Schritt kurz und ruhig bestätigen.

Bradley darf nicht:

- ohne Nutzeraktion aus einer Ecke erscheinen;
- durch Winken, Springen, Blinzeln oder Blickbewegungen Aufmerksamkeit suchen;
- im Idle-Zustand atmen, schweben, pulsieren oder periodisch aufleuchten;
- Inhalte, Eingabefelder, Fehler, Freigaben oder Navigation überdecken;
- ungefragt Tipps, Sprechblasen oder wiederkehrende Erinnerungen öffnen;
- auf Hover eine Charakteranimation starten, die keinen Funktionszustand zeigt;
- einen Spezialagenten, ein Tool, eine Automation oder einen Systemzustand
  visuell vereinnahmen;
- Traurigkeit, Unsicherheit, Müdigkeit, Ungeduld oder Triumph simulieren;
- durch Animation behaupten, noch zu arbeiten, wenn der Lauf beendet,
  blockiert oder getrennt ist.

## Präsenzstufen

| Stufe | Verwendung | Erlaubte Darstellung | Bewegung |
| --- | --- | --- | --- |
| P0 — keine Bradley-Präsenz | System-, Tool-, E-Mail-, Automations- oder Spezialagentenfläche ohne Bradley-Beteiligung | funktionsbezogenes Icon | keine Bradley-Bewegung |
| P1 — Identitätszeichen | Agent-Selector, Chat-Header, Nachricht, kompakte Attribution | kleiner statischer Glyph | keine |
| P2 — Statuszeichen | Bradley arbeitet, wartet oder ist fertig | kleiner Glyph mit sachlichem Badge | nur bei echtem laufendem Bradley-Zustand |
| P3 — Orientierung | Bradley-Onboarding oder freigegebener Empty State | größere statische Figur plus kurze Erklärung | optional einmaliger Eintritt, standardmäßig statisch |
| P4 — Kampagne | Marketing außerhalb operativer Produktzustände | freigegebenes Character-Asset | eigene Creative-Freigabe; keine Übertragung auf Runtime |

Die Produktoberfläche bleibt normalerweise auf P0 bis P2. P3 wird nur auf
wenigen, bewusst ausgewählten Flächen eingesetzt. P4 ist kein UI-Muster.

## Zustands- und Motion-Matrix

| UI-Zustand | Bradley-Darstellung | Start | Stop | Wiederholung |
| --- | --- | --- | --- | --- |
| Idle / bereit | statischer Bradley-Glyph | beim Rendern statisch | beim Kontextwechsel | keine |
| Antwort wird vorbereitet | Arbeitsglyph mit Körper-/Faltbewegung und Aktivitätsbalken | nach bestätigtem Start des Bradley-Laufs | bei erstem Antwortinhalt, Blockade, Fehler, Abbruch oder Abschluss | nur solange Zustand aktiv; Zyklus 2,4 s |
| Tool wird durch Bradley ausgeführt | Bradley bleibt als Akteur statisch; Toolzeile zeigt eigenen laufenden Status | beim Tool-Start | beim Tool-Ende | keine zusätzliche Bradley-Animation, wenn Toolstatus bereits bewegt ist |
| Dateien werden geprüft | Arbeitsglyph, sofern dies der primäre sichtbare Bradley-Status ist | bei bestätigter Dateioperation | bei Statuswechsel | wie Antwortvorbereitung |
| wartet auf Eingabe | statischer Waiting-Glyph mit Pause-Badge | sobald Nutzeraktion erforderlich ist | nach Eingabe oder Abbruch | keine |
| wartet auf Freigabe | statischer Waiting-Glyph plus Text „Deine Freigabe ist erforderlich.“ | sobald Freigabestatus feststeht | nach Entscheidung oder Abbruch | keine |
| Queue | statischer Queue-/Wartezustand; keine Arbeitsbewegung | beim Einreihen | beim Start oder Entfernen | keine |
| Ergebnis wird gestreamt | statischer Bradley-Glyph; Textstream selbst zeigt Aktivität | mit erstem sichtbaren Inhalt | mit Ende des Streams | keine Character-Animation |
| erfolgreich abgeschlossen | Done-Glyph mit Check-Badge | nach bestätigtem Erfolg | nach kurzer Statusphase oder Navigation | keine; kein Konfetti als Default |
| teilweise abgeschlossen | neutraler statischer Status plus Text | nach bestätigtem Teilergebnis | nach Nutzeraktion | keine |
| Fehler | statischer Bradley- oder Einheiten-Glyph plus Fehlericon | nach terminalem Fehler | nach Recovery oder Schließen | keine |
| Abbruch wird verarbeitet | neutrales Stop-/Progress-Icon | nach Abbruchanforderung | nach terminalem Stopp | keine Bradley-Körperschleife |
| offline / reconnect | neutrales Verbindungsicon | bei Verbindungsverlust | nach Wiederverbindung | keine Bradley-Animation |

Es ist höchstens **eine** sichtbare Bradley-Animation pro View erlaubt. Läuft
bereits eine animierte Tool- oder Fortschrittsanzeige direkt neben Bradley,
bleibt Bradley statisch, um konkurrierende Bewegung zu vermeiden.

## Start-, Stop- und Unterbrechungsregeln

### Start

Eine Bradley-Animation startet nur, wenn alle Bedingungen erfüllt sind:

1. Der aktuelle Akteur ist Bradley.
2. Die Runtime hat einen realen aktiven Zustand bestätigt.
3. Die Animation ist auf dieser Oberfläche laut Kontextmatrix vorgesehen.
4. Es gibt in derselben visuellen Gruppe keine deutlichere laufende Animation.
5. `prefers-reduced-motion` erlaubt die Bewegung.

Optimistische UI darf einen statischen Vorbereitungsstatus sofort zeigen. Die
Körperschleife beginnt erst, wenn der Lauf tatsächlich angenommen wurde.

### Stop

Animation stoppt unmittelbar bei:

- erstem sichtbaren Antwortinhalt, wenn der Stream selbst Fortschritt zeigt;
- Wechsel zu Nutzerfreigabe, Nutzereingabe oder Queue;
- Tool-Übergabe, wenn die Toolzeile den laufenden Zustand übernimmt;
- erfolgreichem, teilweisem oder fehlgeschlagenem Abschluss;
- Nutzerabbruch;
- Verlust der Laufzuordnung oder Verbindung;
- Navigation aus dem aktiven Kontext;
- Wechsel zu einem anderen Agenten;
- Unsichtbarkeit der Komponente.

„Unmittelbar“ bedeutet: keine Abschiedschoreografie und kein Warten auf das
Ende des 2,4-Sekunden-Zyklus. Die Komponente wechselt in den korrekten
statischen Zielzustand.

### Unterbrechung und Wiederaufnahme

- Ein unterbrochener Lauf zeigt den sachlichen neuen Zustand, nicht die letzte
  Animationspose.
- Bei Wiederaufnahme beginnt die Bewegung in ihrer neutralen Ausgangsform; sie
  setzt nicht an einer gespeicherten Zwischenpose fort.
- Tabwechsel oder Hintergrundbetrieb pausiert nicht den fachlichen Lauf, darf
  aber die nicht sichtbare Animation vollständig aushängen.
- Nach Rückkehr wird nur animiert, wenn der Lauf weiterhin aktiv ist.
- Ein verspätetes Event darf einen bereits terminalen Done-, Fehler- oder
  Stoppzustand nicht zurück in „arbeitet“ versetzen.
- Mehrere parallele Bradley-Läufe werden nicht alle im globalen Header animiert.
  Nur der aktuell sichtbare, eindeutig zugeordnete Lauf darf Bewegung zeigen.

## Idle-Regel

Idle ist vollständig statisch. Insbesondere verboten sind:

- periodisches Atmen oder Skalieren;
- zufälliges Blinzeln;
- schwebende Körperbewegung;
- wandernde Augenpunkte;
- wiederkehrender Lichtscan;
- zeitgesteuertes Winken;
- automatische Sprechblasen;
- Bewegungsstart allein durch Hover oder langen Seitenaufenthalt.

Hover und Fokus dürfen einen normalen UI-Hintergrund, Fokusrahmen oder Tooltip
zeigen. Der Bradley-Körper und die Augen bleiben unverändert. Diese Regel gilt
auch dann, wenn eine Animation technisch kostengünstig wäre.

## Reduced Motion

Bei `prefers-reduced-motion: reduce`:

- Körper-, Falt-, Scan- und Balkenanimationen sind deaktiviert;
- der Arbeitszustand bleibt durch drei statische Aktivitätsbalken erkennbar;
- Waiting und Done bleiben statische Badges;
- kein automatischer Crossfade, Zoom, Bounce oder Pfadzeicheneffekt wird als
  Ersatz hinzugefügt;
- Statuscopy, `aria-live`-Semantik und Fortschrittswerte bleiben identisch;
- ein späterer nutzerseitiger Motion-Schalter darf die Systemeinstellung nur
  weiter reduzieren, niemals ungefragt überschreiben.

Die bewegungsarme Fassung ist ein gleichwertiger Produktzustand und kein
Fallback mit weniger Information.

## Accessibility

### Semantik

- Der sichtbare Status stammt aus der
  [Zustands-Copy-Matrix](./bradley-state-copy-matrix.md).
- Der Bradley-Glyph ist dekorativ (`aria-hidden="true"`), wenn Name und Status
  direkt daneben stehen.
- Steht das Icon allein, braucht die umgebende Komponente ein zugängliches Label
  wie „Bradley · arbeitet“ / “Bradley · working”.
- Animation besitzt keine eigene Live-Region. Nur der fachliche Status wird
  angekündigt.
- Wiederholte Animationszyklen erzeugen keine wiederholten Screenreader-Events.

### Fokus und Bedienung

- Bradley bewegt den Fokus nie selbstständig.
- Statuswechsel öffnen keine Sprechblase und kein Dialogfenster, außer ein
  fachlich blockierender Freigabe- oder Sicherheitsdialog ist erforderlich.
- Der Character ist kein Button, solange keine klar benannte Aktion existiert.
- Ist Bradley anklickbar, erhält die Steuerung einen Aktionsnamen wie
  „Bradley-Details öffnen“, nicht nur „Bradley“.
- Pausieren oder Stoppen eines Laufs erfolgt über eine sichtbare, normale
  Steuerung und nicht durch Anklicken der Figur.

### Visuell

- Motion darf nie die einzige Zustandsunterscheidung sein.
- High Contrast verwendet die systemfarbige Bradley-Variante und textuelle
  Statusangabe.
- Badge, Glyph und Status dürfen bei 200 % Zoom nicht überlappen oder
  abgeschnitten werden.
- Farbe, Opazität und leichte Bewegung ersetzen keine Fehlermeldung, Freigabe
  oder Fortschrittsangabe.

## Technischer Einbettungsvertrag

Für die spätere UI-Integration in BRADLEY-042 gilt:

- Inline-SVG beziehungsweise eine React-Komponente ist die bevorzugte Form,
  weil Laufzustand, Stop und Reduced Motion kontrolliert werden müssen.
- Die freigegebene Geometrie und das 64-×-64-`viewBox` bleiben unverändert.
- Animation beschränkt sich auf `transform` und `opacity`; keine Filter,
  Schatten, Pfadmorphs oder layoutauslösenden Attribute.
- `transform-origin` wird explizit gesetzt.
- Die animierte Komponente wird nur während eines sichtbaren aktiven Zustands
  gemountet und bei Stop ausgehängt.
- Ein `<img>` mit selbstlaufender SVG ist nur zulässig, wenn Mount und Unmount
  den realen Zustand sicher abbilden und die Reduced-Motion-Regel im Asset
  greift.
- GIF wird nicht für die Produktoberfläche verwendet, weil Zustand, Theme,
  Auflösung und Reduced Motion nicht ausreichend steuerbar sind.
- Offscreen- und inaktive Instanzen dürfen keine endlosen Animationen weiter
  berechnen.

## Benachrichtigungs- und Häufigkeitsgrenzen

- Bradley erscheint nicht zusätzlich als Toast, wenn derselbe Status bereits
  direkt im aktiven Chat sichtbar ist.
- Erfolgstoasts verwenden ein normales Erfolgsicon; der Bradley-Glyph erscheint
  nur bei notwendiger Herkunftsattribution.
- Wiederholte Hintergrundfehler einer Automation werden gebündelt oder gemäß
  Notification-Policy behandelt, nicht durch wiederkehrende Bradley-Auftritte.
- Empty-State-Hinweise erscheinen an ihrem festen Ort und werden nach
  Nutzerinteraktion nicht als schwebender Tipp wiederholt.
- Eine erledigte Aktion löst standardmäßig weder Konfetti noch Sound noch
  Character-Choreografie aus.

## Review-Szenarien

| Szenario | Erwartung |
| --- | --- |
| Bradley-Chat ist idle | statischer Glyph, kein Lichtscan, kein Blinzeln |
| Nutzer sendet Nachricht, Lauf wird angenommen | Arbeitsanimation startet nach bestätigtem Lauf |
| erster Antworttoken erscheint | Character-Animation stoppt, Stream zeigt Fortschritt |
| Bradley startet ein Tool | Toolstatus übernimmt Bewegung; Bradley bleibt statisch |
| Freigabe wird erforderlich | Waiting-Glyph statisch, klare Freigabe-Copy, Fokus nur bei fachlich notwendigem Dialog |
| Lauf kommt in Queue | keine Arbeitsanimation; Queue-Text sichtbar |
| Nutzer stoppt den Lauf | Animation stoppt sofort; neutraler Stopstatus bis terminal |
| Netzwerk bricht ab | Animation stoppt; Verbindungsstatus und Recovery erscheinen |
| späteres Running-Event nach Done | terminaler Zustand bleibt erhalten |
| Tab wird unsichtbar | Animation wird ausgehängt; Lauf bleibt fachlich aktiv |
| Reduced Motion aktiv | identische Information, vollständig statische Zustandszeichen |
| Spezialagent arbeitet | kein Bradley-Glyph; Identität und Status des Spezialagenten |
| Automation läuft im Hintergrund | Automation-Icon primär; Bradley nur als textlich/sekundär attribuierter Akteur |
| High Contrast | systemfarbiger Glyph, Textstatus und Badge bleiben erkennbar |
| Screenreader | genau ein sinnvoller Statuswechsel, keine Meldung pro Zyklus |

## Verbindliche Review-Checkliste

### Unterbrechungen

- [ ] Stoppt die Animation bei Antwortbeginn, Tool-Übergabe, Warten, Queue,
      Erfolg, Fehler, Abbruch, Disconnect und Navigation?
- [ ] Kann ein verspätetes Event keinen terminalen Zustand reaktivieren?
- [ ] Wird nach Wiederaufnahme nur bei weiterhin aktivem Lauf animiert?
- [ ] Bleibt maximal eine Bradley-Animation pro View sichtbar?

### Idle und Anti-Clippy

- [ ] Ist Idle vollständig statisch, einschließlich Augen, Scan und Hover?
- [ ] Erscheint Bradley nie ungefragt als Overlay, Tipp oder Sprechblase?
- [ ] Verdeckt oder verschiebt Bradley keine primären Inhalte und Aktionen?
- [ ] Verzichtet die Oberfläche auf menschliche Emotionen und Comic-Mimik?

### Reduced Motion

- [ ] Deaktiviert `prefers-reduced-motion` jede dekorative Bewegung?
- [ ] Bleibt der Arbeitszustand durch statische Balken und Text erkennbar?
- [ ] Werden keine neuen Crossfades, Zooms oder Pulse als Ersatz gestartet?
- [ ] Liefert die reduzierte Fassung dieselbe Statusinformation?

### Barrierefreiheit

- [ ] Ist der Zustand als Text vorhanden und nicht nur über Bewegung/Farbe?
- [ ] Erzeugt ein Animationszyklus keine wiederholten Live-Region-Meldungen?
- [ ] Bleibt der Fokus stabil und sind echte Aktionen korrekt benannt?
- [ ] Funktionieren High Contrast, 200 % Zoom und Screenreader-Semantik?

### Performance und Identität

- [ ] Animiert die SVG nur `transform` und `opacity`?
- [ ] Werden inaktive oder unsichtbare Instanzen ausgehängt?
- [ ] Ist der tatsächliche Akteur Bradley und nicht Spezialagent, Tool,
      Automation oder Canvas Host Agent?
- [ ] Bleiben Geometrie, Theme-Variante und Zustandsbadges im freigegebenen
      Asset-Vertrag?

## Abschluss BRADLEY-023

Unterbrechungen, Idle-Verhalten, Reduced Motion, Accessibility, Performance,
Häufigkeit und Kontextgrenzen sind als überprüfbare UI-Regeln festgelegt.
Bradley signalisiert damit echte Zustände, ohne zu einem aufdringlichen
Assistenten oder einer dauernd animierten Figur zu werden.
