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

Im Agenten-Tab der Mobile-App ist ausserdem der Plus-Button derzeit nicht
zuverlaessig nutzbar: Ein neuer Chat kann nicht mehr aktiviert oder gestartet
werden. Das blockiert den zentralen mobilen Chat-Workflow und wird in diesem
Ticket gemeinsam mit Navigation, Chat-State und Lifecycle behandelt.

Auch im Kontextmenue „Verwalten“ sind die Eintraege
„Automationseinstellungen“, „Neue Automation“ und „Heartbeat“ nicht anwaehlbar.
Diese Aktionen muessen im selben mobilen Navigations-/Berechtigungsfluss
untersucht werden; eine sichtbare, aber wirkungslose Aktion ist kein
zulaessiger Zustand.

## Zielzustand

- Der Chat bleibt bei Streaming, Keyboard-Wechsel, Rotation und langen
  Unterhaltungen bedienbar.
- Der Plus-Button im Agenten-Tab erstellt bzw. aktiviert einen neuen Chat
  verlaesslich, auch nach App-Hintergrundwechsel, Workspace-Wechsel und einer
  zuvor geoeffneten Session.
- Die drei Automationseintraege im Kontextmenue „Verwalten“ sind im jeweils
  zulaessigen Workspace anwaehlbar und navigieren bzw. starten die erwartete
  Aktion; bei fehlender Berechtigung erklaert die UI den Grund.
- Streaming-Events werden genau einmal und in kausaler Reihenfolge gerendert.
- Browser-Use bietet mobile Lade-, Fehler-, Berechtigungs- und
  Viewport-Zustaende sowie touch-taugliche Steuerung.

## Umsetzung

- Reproduzierbare Fehlerfaelle und Telemetrie ohne Inhalte, Credentials oder
  Tickets definieren (App-Lifecycle, Socket-Reconnect, Eventsequenz, Renderer).
- Chat-Layout, Keyboard-Avoidance, Scroll-Anker und Virtualisierung pruefen und
  die fehlerhafte State-/Queue-Logik korrigieren.
- New-Chat-Action vom mobilen Plus-Button ueber Navigation, Session-Erzeugung,
  Workspace-Scope, optimistic UI und Fehler-/Retry-Zustand inventarisieren;
  Doppelklicks duerfen keine doppelten Sessions anlegen und ein Fehler darf den
  vorhandenen Chat nicht unbrauchbar machen.
- Kontextmenue, Feature-Flags, Workspace-/Rollenpruefung und Navigation der
  Automationseinstellungen, neuen Automation und des Heartbeats inventarisieren.
  Disabled-Zustaende duerfen nur bei einem konkreten, sichtbaren
  Berechtigungs- oder Verfuegbarkeitsgrund entstehen.
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
- Der Plus-Button erzeugt oder aktiviert genau einen neuen, dem aktiven
  Workspace zugeordneten Chat und zeigt bei einem Fehler eine bedienbare
  Rueckmeldung statt einer wirkungslosen Aktion.
- Die drei genannten Kontextmenueaktionen sind im berechtigten Team- und
  Personal-Workspace bedienbar; unberechtigte Nutzer erhalten einen eindeutigen
  Disabled-/Fehlerzustand statt einer still wirkungslosen Auswahl.
- Browser-Use hat fuer Ladefehler, keine Verbindung und unzulaessige Inhalte
  nachvollziehbare, wiederholbare UI-Zustaende.
- Tests decken Lifecycle-, Reconnect- und Eventreihenfolgen ab.

## Tests und Abschluss

- Protokoll-/Unit-Tests im Server-Repository; Komponenten- und Device-Tests im
  Expo-Repository.
- Explizite mobile Testmatrix fuer iOS und Android dokumentieren.
- `npm run build` fuer betroffene Server-/Web-Anteile.
- Eigener Commit je Repository; danach Status im [Index](./README.md) setzen.
