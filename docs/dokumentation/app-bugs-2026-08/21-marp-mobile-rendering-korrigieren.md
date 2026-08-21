---
title: 'Ticket 21: MARP-Praesentationen auf Mobile korrekt rendern'
status: open
priority: medium
depends_on: []
platforms: [mobile, server, mobile-api]
repositories: [canvasstudios-notebook, expo-mobile-app]
tags: [type/bug, topic/marp, topic/mobile-app, topic/rendering]
---

# Ticket 21: MARP-Praesentationen auf Mobile korrekt rendern

## Problem

MARP-Praesentationen werden in der Expo-App nicht korrekt oder nicht stabil
gerendert. Layout, Seitenverhaeltnis, Navigation, Assets und Fehlerzustaende
muessen gegen denselben Inhalt wie in der Next.js-App abgeglichen werden.

## Zielzustand

- Gueltige MARP-Dateien werden auf iOS und Android mit korrektem
  Seitenverhaeltnis, Foliengrenzen, Text, Bildern und Themes dargestellt.
- Navigation, Zoom/Anpassung, Rotation, Laden und Fehlerzustand sind
  touch-tauglich und zugaenglich.
- Mobile und Web verwenden einen klar versionierten Render-/Asset-Vertrag und
  respektieren Workspace- und Dateiberechtigungen.
- Nicht unterstuetzte MARP-Funktionen werden sichtbar und sicher behandelt.

## Umsetzung

- Reproduktions-Fixtures fuer Front Matter, Themes, lokale/remote Assets,
  Codebloecke, lange Folien und unterschiedliche Seitenformate festlegen.
- Web-Renderer unter `app/lib/marp/`, Preview-Routen und Mobile-Dateivertrag
  inventarisieren; Server-Render gegen sicheren Client-Render bewerten.
- Asset-URLs, Auth, Basis-Pfade, CSP/Netzwerkregeln und Offline-/Cache-Verhalten
  fuer Mobile korrigieren.
- Responsive Folienbuehne mit stabiler Seitennavigation, Safe Areas, Rotation
  und verstaendlichen Lade-/Fehlerzustaenden implementieren.
- Darstellung anhand identischer Fixtures zwischen Web, iOS und Android
  visuell vergleichen.

## Abnahmekriterien

- Die Referenzpraesentationen zeigen auf Mobile dieselbe Folienzahl, Inhalte,
  Assets und wesentliche Gestaltung wie die Webvorschau.
- Kein Inhalt laeuft unkontrolliert aus dem Viewport; Rotation und Navigation
  verlieren weder Position noch Folie.
- Fremde Workspace-Assets und nicht erlaubte externe Ressourcen werden nicht
  geladen.
- Fehlerhafte Dateien crashen die App nicht und bieten eine klare Alternative.

## Tests und Abschluss

- Server-Render-/Asset-/Scope-Tests sowie Komponenten-, Snapshot- und reale
  Device-Tests im Expo-Repository mit versionierten Fixtures.
- `npm run build` fuer Server-/Web-Anteile; manuelle iOS-/Android-Abnahme.
- Eigener Commit je Repository, danach Status im [Index](./README.md) setzen.
