---
title: 'Ticket 07: Session-Liste typografisch korrigieren'
status: open
priority: low
depends_on: ['06-mobile-notizen-native-migration']
platforms: [web, mobile]
tags: [type/bug, topic/ui-design, topic/sessions]
---

# Ticket 07: Session-Liste typografisch korrigieren

## Problem

Session-Titel werden in der Liste zu gross dargestellt. Lange Texte werden
abgeschnitten oder sind schlecht lesbar; Titel, Metadaten und Vorschau haben
keine ausgewogene Hierarchie.

## Zielzustand

Die Session-Liste nutzt eine kompakte, konsistente Typografie. Lange Titel sind
ohne Layoutbruch verstaendlich und der Umgang mit Trunkierung ist fuer Desktop
und Mobile einheitlich definiert.

## Umsetzung

- Betroffene Web- und Mobile-Komponenten sowie vorhandene Designtokens
  inventarisieren.
- Titel auf eine Listen-geeignete Schriftgroesse und Zeilenhoehe umstellen;
  Metadaten und Vorschau visuell klar nachordnen.
- Entscheidung fuer begrenzten Mehrzeilenumbruch oder Ellipse treffen;
  vollstaendigen Titel bei Trunkierung ueber eine zugaengliche Alternative
  bereitstellen (z. B. Tooltip, Detailansicht oder Accessibility-Label).
- Responsive Breiten, Lokalisierung, sehr lange Woerter und unterschiedliche
  Schriftgroessen pruefen.

## Abnahmekriterien

- Kurze und lange Titel passen ohne Ueberlauf in die Listenkarte.
- Der vollstaendige Titel bleibt bei Trunkierung erreichbar.
- Titel, Datum/Status und Vorschau folgen einer konsistenten Hierarchie auf
  Mobile und Desktop.
- Tastatur- und Screenreader-Nutzung verlieren keine Titelinformation.

## Tests und Abschluss

- Komponenten-/Snapshot-Tests, soweit im jeweiligen Repository vorhanden.
- `npm run build` fuer Web-Aenderungen.
- Manuelle responsive Abnahme; Browser-/E2E-Test nur nach expliziter Freigabe.
- Eigener Commit, dann Status im [Index](./README.md) aktualisieren.
