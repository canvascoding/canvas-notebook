# Bradley Starter-/Empty-State

Status: implementiert und validiert  
Stand: 31. August 2026  
Umsetzung: BRADLEY-043

## Ergebnis

Der normale leere Hauptagent-Chat zeigt einen ruhigen, statischen Bradley-
Starter-State. Das freigestellte Character-Master steht oberhalb einer knappen
Rollenzeile und der Frage „Wobei soll Bradley dir helfen?“ / „What should
Bradley help you with?“.

Die bestehende Composer-Fläche, der Hinweis zum Loslegen und die Aktion zum
Öffnen der letzten Session bleiben unverändert verfügbar. Bradley ist kein
Button, öffnet keine Sprechblase und überlagert keine Inhalte.

## Kontextgrenzen

| Kontext | Starter-Darstellung |
| --- | --- |
| Hauptagent `canvas-agent` im normalen Chat | statischer Bradley-Character, Rolle und Bradley-Titel |
| Spezialagent | kein Bradley-Asset; vollständiger Spezialagentenname im Titel |
| Canvas Studio | bestehender Studio-Titel, kein Bradley-Character |
| vorhandene Session oder Nachrichten | Starter-State wird nicht gerendert |

Damit existiert genau ein operativer P3-Orientierungszustand. Alle übrigen
Bradley-Vorkommen bleiben kompakte P1-/P2-Glyphs.

## Asset

Quelle:
`docs/architecture/canvas-notebook/assets/bradley/references/character/bradley-character-master.png`

Runtime-Kopie:
`public/images/bradley/bradley-character-starter.png`

Die Datei besitzt einen echten Alphakanal; die vier Bildecken sind vollständig
transparent. Eine weitere Hintergrundentfernung ist nicht erforderlich. Die
Runtime-Kopie ist bytegleich mit dem validierten Master und wird über Next
Image größenangepasst ausgeliefert.

## Barrierefreiheit und Motion

- Das Bild ist dekorativ (`alt=""`, `aria-hidden="true"`), weil Name und Rolle
  direkt als Text folgen.
- Der Starter-State ist vollständig statisch und respektiert damit Reduced
  Motion ohne Sonderfall.
- Der Spezialagenten-Titel verwendet dessen tatsächlichen Namen.
- Text und letzte-Session-Aktion bleiben die semantisch führenden Elemente.

## Regressionstest

```bash
npm run test:agent:bradley-starter
```

Der Test rendert Hauptagent, Spezialagent und Studio-Kontext serverseitig und
prüft Assetgrenzen, sichtbare Copy, dekorative Bildsemantik und das Fehlen einer
Animation.

Die visuelle Prüfung von Zuschnitt, Themes, Mobile und 200-Prozent-Zoom erfolgt
in BRADLEY-044 nach ausdrücklicher Browserfreigabe.
