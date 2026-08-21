---
title: 'Ticket 04: Mobile Chat und Browser-Use stabilisieren'
status: open
priority: high
depends_on: ['03-mobile-inbox-tabs-und-badges']
platforms: [mobile, server]
tags: [type/bug, topic/mobile-app, topic/chat, topic/browser-use]
---

# Ticket 04: Mobile Chat und Browser-Use stabilisieren

## Problem

Das Expo-Chat-Fenster zeigt zeitweise UI-Fehler, Streaming-Komponenten kommen
nicht immer in deterministischer Reihenfolge an, und Browser-Use hat noch keine
zuverlaessige mobile Bedienung sowie Fehlerbehandlung.

## Zielzustand

- Der Chat bleibt bei Streaming, Keyboard-Wechsel, Rotation und langen
  Unterhaltungen bedienbar.
- Streaming-Events werden genau einmal und in kausaler Reihenfolge gerendert.
- Browser-Use bietet mobile Lade-, Fehler-, Berechtigungs- und
  Viewport-Zustaende sowie touch-taugliche Steuerung.

## Umsetzung

- Reproduzierbare Fehlerfaelle und Telemetrie ohne Inhalte, Credentials oder
  Tickets definieren (App-Lifecycle, Socket-Reconnect, Eventsequenz, Renderer).
- Chat-Layout, Keyboard-Avoidance, Scroll-Anker und Virtualisierung pruefen und
  die fehlerhafte State-/Queue-Logik korrigieren.
- Streaming-Protokoll auf monotone Event-IDs bzw. Sequenzen, Duplikatschutz und
  kontrolliertes Reconnect/Replay pruefen; bei Bedarf Server- und Clientvertrag
  anpassen.
- Browser-Use als mobilen Zustandsautomaten ausarbeiten: Laden, bereit,
  Fehler, erneuter Versuch, kein Zugriff und Hintergrund/Rueckkehr.
- Touch-Gesten, Viewport, externe Navigation und Ressourcenfehler klar
  behandeln; sensible Browserdaten nicht in Logs oder Push-Payloads ausgeben.

## Abnahmekriterien

- Ein unterbrochener und wiederhergestellter Stream rendert keine Duplikate und
  keine Komponenten ausser Reihenfolge.
- Composer, Scrollen und Keyboard bleiben bei langen Streams nutzbar.
- Browser-Use hat fuer Ladefehler, keine Verbindung und unzulaessige Inhalte
  nachvollziehbare, wiederholbare UI-Zustaende.
- Tests decken Lifecycle-, Reconnect- und Eventreihenfolgen ab.

## Tests und Abschluss

- Protokoll-/Unit-Tests im Server-Repository; Komponenten- und Device-Tests im
  Expo-Repository.
- Explizite mobile Testmatrix fuer iOS und Android dokumentieren.
- `npm run build` fuer betroffene Server-/Web-Anteile.
- Eigener Commit je Repository; danach Status im [Index](./README.md) setzen.
