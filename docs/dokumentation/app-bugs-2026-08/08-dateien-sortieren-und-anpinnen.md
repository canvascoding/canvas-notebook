---
title: 'Ticket 08: Dateien nach Nutzung sortieren und anpinnen'
status: open
priority: low
depends_on: ['07-session-liste-typografie']
platforms: [mobile, web, server]
tags: [type/feature, topic/files, topic/mobile-app]
---

# Ticket 08: Dateien nach Nutzung sortieren und anpinnen

## Problem

Im Files-Tab gibt es keine auf den Nutzer zugeschnittene Sortierung nach
zuletzt geoeffneten Dateien und keine Pins fuer haeufig verwendete Dateien oder
Ordner. Gerade mobil sind relevante Inhalte dadurch langsamer auffindbar.

## Zielzustand

- Nutzer koennen Dateien nach „zuletzt geoeffnet“ sortieren.
- Dateien und Ordner lassen sich pro Nutzer und Workspace anpinnen.
- Angepinnte Eintraege erscheinen in einer festen, klaren Sektion.
- Pins und die gewaehlte Sortierung sind bei Produktentscheidung
geraeteuebergreifend synchronisiert.

## Umsetzung

- UX fuer Pins, Reihenfolge, Entpinnen, Zugriffsverlust, geloeschte Dateien,
  leere Sektionen und mobile/desktop Platzierung festlegen.
- Datenmodell fuer nutzer- und workspacegebundene Pins sowie zuletzt-geoeffnet-
  Metadaten entwerfen. Dateipfad allein ist kein ausreichender Trust-Anker;
  Workspace-Scope und Zugriff sind bei jedem Lesen erneut zu pruefen.
- Oeffnungsereignisse datensparsam und idempotent erfassen; nur tatsaechliches
  Oeffnen, nicht blosse Listenanzeige, darf „zuletzt geoeffnet“ veraendern.
- API fuer Pins, Sortierpraeferenzen und sortierte Listen mit Paginations- und
  Berechtigungsvertrag umsetzen.
- Web- und Expo-UI mit Pin-Aktion, „Angepinnt“-Sektion und Sortierauswahl
  bauen; bei fehlenden/entzogenen Dateien einen sicheren, erklaerenden Zustand
  anzeigen.

## Abnahmekriterien

- Pins eines Nutzers erscheinen weder bei anderen Nutzern noch in anderen
  Workspaces.
- „Zuletzt geoeffnet“ spiegelt reale Oeffnungen in stabiler Reihenfolge wider.
- Angepinnte Eintraege bleiben sichtbar und bedienbar, ohne die normale
  Verzeichnisnavigation zu verfalschen.
- Geloeschte oder nicht mehr berechtigte Eintraege liefern keine Metadaten oder
  Inhalte ueber den aktuellen Zugriff hinaus und werden aus Pins bereinigt oder
  sicher markiert.

## Tests und Abschluss

- Datenmodell-, API-, Ownership-, Workspace- und Sortier-Tests.
- `npm run build` fuer Server-/Web-Aenderungen sowie Mobile-Abnahme im Expo-
  Repository.
- Manuelle Pruefung von Pin, Entpinnen, Sortieren und Berechtigungsentzug.
- Eigener Commit je Repository; danach Status im [Index](./README.md) aktualisieren.
