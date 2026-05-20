# Studio Aspect Ratio Editor Plan

## Ziel

In `/studio` soll eine neue Route entstehen, mit der Nutzer das Seitenverhaeltnis eines bestehenden Bildes visuell anpassen koennen. Die Bearbeitung soll zwei Wege unterstuetzen:

- **Crop-only:** Wenn der neue Zielbereich vollstaendig innerhalb des Ausgangsbildes liegt, wird das Ergebnis lokal per Code zugeschnitten.
- **AI Extend:** Wenn der Zielbereich ueber das Ausgangsbild hinausgeht, werden nur die fehlenden Aussenbereiche per Bildmodell erweitert.

Die Funktion soll den bestehenden Image Picker aus `/studio/create` wiederverwenden und zunaechst genau ein Bild auswaehlbar machen.

## Route und Einstieg

- Neue Route: `/studio/aspect-ratio`
- Die Route soll als weiterer Eintrag im Studio-Bereich sichtbar sein.
- Die Bildauswahl nutzt denselben Image Picker wie `/studio/create`.
- Der Picker laeuft in einem Single-Select-Modus, vergleichbar mit der Video-Frame-Auswahl.

## Editor-Erlebnis

Nach der Bildauswahl wird ein visueller Editor angezeigt:

- Das Bild liegt in der Mitte auf einer Arbeitsflaeche.
- Die Arbeitsflaeche ist zoombar und pannbar.
- Ueber dem Bild liegt ein Ziel-Frame.
- Der Ziel-Frame kann als Ganzes verschoben werden.
- Die Ecken des Frames koennen gezogen werden, um Groesse und Seitenverhaeltnis zu veraendern.
- Wenn der Nutzer beim Ziehen `Shift` gedrueckt haelt, bleibt das aktuelle Seitenverhaeltnis erhalten und der Frame wird nur groesser oder kleiner.
- Der aktuelle Bearbeitungsmodus wird live angezeigt:
  - `Crop`, wenn der Ziel-Frame innerhalb des Bildes liegt.
  - `AI Extend`, wenn der Ziel-Frame ueber das Bild hinausgeht.

## Aspect-Ratio-Presets

Die UI soll gaengige Presets anbieten:

- `1:1`
- `4:5`
- `3:4`
- `4:3`
- `16:9`
- `9:16`
- `3:2`
- `2:3`
- `Freeform`

`Freeform` ist nur fuer Crop-only erlaubt. Sobald fuer das Ergebnis KI-Erweiterung noetig waere, muss ein vom gewaehlten Provider und Modell unterstuetztes Format genutzt werden.

## Provider- und Modelllogik

Aktuell relevante Provider:

- OpenAI
- Gemini

Bei Crop-only ist kein Provider noetig.

Bei AI Extend gilt:

1. Nutzer waehlt Provider und Modell.
2. Die UI zeigt nur die Aspect Ratios und Ausgabeformate, die dieses Modell unterstuetzt.
3. Die Aspect-Ratio-Einstellung des Modells selbst ist nicht frei waehlbar, sondern wird aus dem Ziel-Frame bzw. Preset uebernommen.
4. Weitere Modellparameter koennen vom Nutzer eingestellt werden, soweit sie fuer das jeweilige Modell verfuegbar sind.

Die unterstuetzten Formate sollten zentral beschrieben werden, damit UI und API dieselbe Quelle nutzen.

## Ausgabeformate

Presets sollten nicht nur ein Verhaeltnis beschreiben, sondern auch eine Standard-Ausgabegroesse. Beispiele:

- `1:1` -> `1024x1024` oder providerabhaengiges Aequivalent
- `4:5` -> `1080x1350`
- `9:16` -> `1080x1920`
- `16:9` -> `1920x1080`

Bei lokaler Crop-Bearbeitung kann die App die Zielgroesse direkt rendern. Bei AI Extend muss die finale Groesse an die vom gewaehlten Provider/Modell erlaubten Werte angepasst werden.

## Crop-only Verarbeitung

Wenn der Ziel-Frame vollstaendig innerhalb des Ausgangsbildes liegt:

1. Die App berechnet den Ausschnitt anhand von Bildposition, Skalierung und Frame-Koordinaten.
2. Das Backend rendert den Ausschnitt lokal in die Zielgroesse.
3. Das Ergebnis wird als neues Asset in `/data/studio/edits` gespeichert.
4. Das Ergebnis wird als Preview angezeigt.

## AI-Extend Verarbeitung

Wenn der Ziel-Frame ueber das Ausgangsbild hinausgeht:

1. Das Backend rendert ein Ziel-Canvas in der finalen Ausgabeaufloesung.
2. Das Originalbild wird exakt an der vom Nutzer gesetzten Position platziert.
3. Alle leeren Aussenbereiche werden als zu generierende Bereiche markiert.
4. Wenn der Provider Masken oder Outpainting unterstuetzt, wird Bild plus Maske gesendet.
5. Wenn ein Provider keine Masken unterstuetzt, kann ein gerendertes Referenzbild mit klar markierten Bereichen plus eindeutiger Prompt als Fallback genutzt werden.

Der Prompt muss klarstellen:

- Das Originalbild darf nicht neu interpretiert oder veraendert werden.
- Nur die markierten Aussenbereiche sollen natuerlich erweitert werden.
- Bildstil, Licht, Perspektive, Farben, Materialitaet und Motivlogik sollen konsistent fortgefuehrt werden.

## Speicherung

Alle fertig gerenderten Aspect-Ratio-Bearbeitungen werden zuerst in `/data/studio/edits` gespeichert. Dieser Ordner ist der zentrale Zwischen- und Ergebnisort fuer die Funktion.

Nach der Preview kann der Nutzer weitere Aktionen ausfuehren:

- Ergebnis in `/data/studio/edits` behalten.
- Original ueberschreiben, nur nach Sicherheitsdialog.
- Ergebnis zusaetzlich in einen Workspace-Ordner kopieren.

`/data/studio/edits` soll im Image Picker sichtbar sein, damit bearbeitete Bilder direkt weiterverwendet werden koennen.

## Save- und Copy-Dialoge

Beim Speichern oder Kopieren in den Workspace:

- Es soll ein Ordner-Picker verwendet werden.
- Vorhandene File-Tree- oder File-Browser-Komponenten sollen wiederverwendet werden.
- Der Nutzer soll im Dialog den Dateinamen anpassen koennen.
- Frei eingegebene absolute Pfade sollten vermieden werden, wenn ein Picker verfuegbar ist.

Beim Ueberschreiben des Originals:

- Es muss einen Sicherheitsdialog geben.
- Der Dialog muss klar anzeigen, welches Original ersetzt wird.
- Die Aktion darf nicht versehentlich durch den normalen Preview-Save passieren.

## Empfohlene API-Struktur

Die konkrete Struktur haengt von vorhandenen Studio- und Image-APIs ab. Wahrscheinliche Endpunkte:

### `GET /api/studio/aspect-ratio/models`

Liefert Provider, Modelle, unterstuetzte Aspect Ratios, Ausgabeformate und Modellparameter fuer OpenAI und Gemini.

### `POST /api/studio/aspect-ratio/preview`

Erstellt ein Preview-Ergebnis:

- Crop-only lokal per Code.
- AI Extend ueber Provider/Modell.
- Speichert das Ergebnis immer zuerst in `/data/studio/edits`.

### `POST /api/studio/aspect-ratio/save`

Fuehrt eine Aktion auf Basis des fertigen Preview-Assets aus:

- In `/data/studio/edits` behalten.
- In Workspace-Ordner kopieren.
- Original nach bestaetigtem Sicherheitsdialog ueberschreiben.

## Job-Datenmodell

Ein Bearbeitungsjob sollte ungefaehr diese Informationen enthalten:

```ts
{
  sourceImageId: string;
  sourcePath: string;
  target: {
    aspectRatio: "1:1" | "4:5" | "3:4" | "4:3" | "16:9" | "9:16" | "3:2" | "2:3" | "freeform";
    width: number;
    height: number;
  };
  placement: {
    imageX: number;
    imageY: number;
    imageWidth: number;
    imageHeight: number;
    frameX: number;
    frameY: number;
    frameWidth: number;
    frameHeight: number;
  };
  mode: "crop" | "ai_extend";
  provider?: "openai" | "gemini";
  model?: string;
  modelParams?: Record<string, unknown>;
}
```

## Offene Code-Pruefpunkte vor Implementierung

Vor der Umsetzung muss im bestehenden Code geprueft werden:

1. Wo der Image Picker aus `/studio/create` sitzt und wie Single-Select sauber aktiviert wird.
2. Wie die Video-Frame-Auswahl Single-Image-Selection technisch loest.
3. Wie Assets und `/data/studio` aktuell indexiert werden.
4. Ob `/data/studio/edits` bereits existiert oder durch API/Startlogik angelegt werden muss.
5. Welche OpenAI- und Gemini-Bildfunktionen schon vorhanden sind.
6. Ob bestehende Provider-Konfigurationen bereits Modellparameter und Formate abbilden.
7. Welche File-Tree-Komponenten sich fuer Ordner-Picker plus Dateinamensfeld eignen.
8. Wie gespeicherte Studio-Ergebnisse im Image Picker sichtbar gemacht werden.

## Umsetzungsreihenfolge

Die Arbeiten sollen sequenziell erfolgen. Kein naechstes Todo starten, bevor das vorherige fertig ist.

1. Bestehende `/studio/create` Image-Picker-Logik, Video-Frame-Auswahl, Asset-APIs und Provider-APIs analysieren.
2. UI- und Datenfluss-Spezifikation anhand vorhandener Komponenten finalisieren.
3. Route `/studio/aspect-ratio` und Studio-Navigation ergaenzen.
4. Image Picker im Single-Select-Modus integrieren.
5. Canvas-Editor mit Zoom, Pan, verschiebbarem Frame, Eck-Handles und Shift-Resize bauen.
6. Preset-Logik und Crop-vs-AI-Extend-Erkennung implementieren.
7. Lokale Crop-Pipeline implementieren und Ergebnisse nach `/data/studio/edits` schreiben.
8. Preview-Anzeige einbauen.
9. Provider-/Modell-Auswahl fuer OpenAI und Gemini anbinden.
10. AI-Extend-Pipeline mit Maske oder Fallback-Referenzbild implementieren.
11. Save-/Copy-/Overwrite-Dialoge mit Sicherheitsdialog und Ordner-Picker einbauen.
12. `/data/studio/edits` im Image Picker verfuegbar machen.
13. UI manuell pruefen.
14. Playwright- oder Chrome-DevTools-Pruefung nur nach expliziter Freigabe.
15. `npm run build` ausfuehren.
16. Fertige Teilschritte sauber committen, aber nicht pushen.

## Testnotizen

- Fuer reine Dokumentationsaenderungen ist kein Build erforderlich.
- Fuer die spaetere Implementierung muss vor Container-Builds immer `npm run build` erfolgreich laufen.
- Es duerfen keine parallelen Test-Container laufen.
- Falls Test-Container genutzt werden, muessen sie fuer neue Testlaeufe neu erstellt oder rebuilt werden.
- Der Dev-Server darf ausschliesslich auf `localhost:3000` laufen.
- Falls bereits ein Dev-Server auf `3000` laeuft, darf kein weiterer gestartet werden.
