# Bradley-Glyph als Hauptagent-Avatar

Status: implementiert und validiert  
Stand: 31. August 2026  
Umsetzung: BRADLEY-041

## Ergebnis

Der validierte Bradley-Glyph ist als inline SVG im Home- und Chat-Selector
integriert. Er wird ausschließlich gerendert, wenn die interne Agenten-ID
`canvas-agent` lautet. Spezialagenten behalten ihr jeweils konfiguriertes
Lucide-Icon.

## Technische Ausführung

- `viewBox="0 0 64 64"` ermöglicht verlustfreie Skalierung.
- Die Augen sind für die kleinen Selector-Größen bewusst groß ausgeführt.
- Feste Markenfarben sorgen in Light und Dark Mode für dieselbe Identität.
- `forced-color-adjust: auto` erlaubt dem Browser eine systemgerechte
  High-Contrast-Anpassung.
- Der aktive Selector rendert den Glyph bei 14 Pixeln; die Auswahlliste nutzt
  16 Pixel innerhalb eines 36-Pixel-Avatars.
- Der sichtbare Agentenname liefert bereits die zugängliche Beschriftung. Der
  darin eingebettete Glyph ist deshalb dekorativ und für Screenreader verborgen.
- Bei eigenständiger Nutzung unterstützt `BradleyGlyph` optional einen
  zugänglichen Titel und `role="img"`.

## Risikobegrenzung

Der globale `AgentIcon`-Baustein bleibt unverändert. Die Bradley-Verzweigung
liegt in `AgentIdentityIcon` und wird nur vom Agenten-Selector verwendet. So
bleiben Automationen, Einstellungen, Spezialagenten und alle übrigen globalen
Icon-Aufrufer unberührt.

## Regressionstest

```bash
npm run test:agent:bradley-glyph
```

Der Test rendert die Komponenten serverseitig und prüft:

- skalierbaren 64er-ViewBox und beide Augen;
- dekorative und zugänglich benannte Nutzung;
- Bradley-Glyph für `canvas-agent`;
- unverändertes Search-Icon für einen Spezialagenten;
- 14- und 20-Pixel-Klassen als repräsentative kleine UI-Größen.

Die visuelle Prüfung von Pixelwirkung, Themes und erzwungenem Kontrast erfolgt
gebündelt in BRADLEY-044 nach ausdrücklicher Browserfreigabe.
