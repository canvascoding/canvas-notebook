---
title: 'Ticket 25: Heartbeat-Automationen, Notifications und Tokenverbrauch kontrollieren'
status: open
priority: high
depends_on: ['10-automationen-ui-und-workspace-zuordnung-pruefen']
platforms: [web, server, agent-runtime, mobile-api]
tags: [type/bug, topic/automations, topic/heartbeat, topic/notifications, topic/usage]
---

# Ticket 25: Heartbeat-Automationen, Notifications und Tokenverbrauch kontrollieren

## Problem

Heartbeat-artige Automationen muessen regelmaessig pruefen koennen, ob etwas
Aufmerksamkeit braucht, ohne Nutzer bei einem unauffaelligen Lauf zu
benachrichtigen. Gleichzeitig koennen zu haeufige, zu breite oder ineffiziente
Heartbeat-Agenten unbemerkt sehr viele Tokens verbrauchen. Auf der
Automationsseite sind solche Jobs, ihre Frequenz, ihr No-Action-Verhalten und
ihr Verbrauch noch nicht schnell genug erkennbar und administrierbar.

Die aktuelle Runtime kennt `deliver_relevant_only` und unterdrueckt eine exakt
mit `NO_ACTION` beantwortete Ausfuehrung. Legacy-Heartbeat-Routen und
`HEARTBEAT.md`-Jobs werden jedoch zu Workspace-Automationen migriert, waehrend
Teile der Produktdokumentation noch ein separates Heartbeat-Modell beschreiben.
Ausfuehrung, Migration, Benennung, Notification-Semantik und UI muessen daher
als ein konsistenter Vertrag geprueft werden.

## Zielzustand

- Heartbeat-artige Jobs sind normale, eindeutig gekennzeichnete und
  workspacegebundene Automationen mit Owner, Agent, Zeitplan, Result Policy und
  klarer administrativer Verantwortung.
- Ein erfolgreicher Lauf ohne neue oder handlungsrelevante Erkenntnis wird als
  `no_action` gespeichert und erzeugt keine Web-, Desktop-, Mobile-Push-, Chat-,
  E-Mail-, Telegram- oder sonstige Nutzer-Notification.
- Relevante Ergebnisse und echte Fehler werden gemaess konfigurierter Delivery-
  Policy zugestellt; „keine Aktion“ und „fehlgeschlagen“ sind niemals dasselbe.
- Die Automationsseite zeigt Heartbeat-/Monitoring-Jobs, Frequenz,
  letzten/naechsten Lauf, letzten relevanten Fund, No-Action-Quote, Fehlerstatus,
  Tokenverbrauch und Kostenrisiko auf einen Blick.
- Berechtigte Nutzer koennen auffaellige Jobs schnell pausieren, Zeitplan,
  Scope und Budget korrigieren und den verursachenden Agenten erkennen.

## Umsetzung

- Den kanonischen Produktvertrag festlegen: Legacy-Heartbeat-Konfiguration,
  Migration zu Workspace-Automationen, `deliver_relevant_only`, `NO_ACTION`,
  Scheduler, Run-Historie und Dokumentation muessen dieselben Begriffe und
  Zustaende verwenden. Veraltete Routen und Anleitungen eindeutig migrieren
  oder als retired kennzeichnen.
- Alle Terminalpfade einer Ausfuehrung inventarisieren: Ergebnisclassification,
  Session-Persistenz, Notification Summary, WebSocket-/Desktop-Hinweis,
  Mobile Push, Kanal-Delivery, E-Mail/Telegram, Fehler-Notification und Retry.
  Fuer `no_action` muss jeder Nutzerkanal nachweislich unterdrueckt werden.
- Das reine Parsen eines magischen Freitext-Tokens gegen einen strukturierten
  Runtime-Ausgang bewerten, zum Beispiel `outcome: no_action | relevant |
  failed`. Rueckwaertskompatibilitaet fuer exakt `NO_ACTION` erhalten, ohne
  relevante Meldungen versehentlich zu verschlucken.
- Token- und Kostenmetadaten pro Run eindeutig mit Job, Agent, Owner, Workspace,
  Modell, Trigger und Zeitplan verknuepfen. Keine Prompt- oder Ergebnisinhalte
  fuer die Verbrauchsauswertung duplizieren.
- Rollierende Kennzahlen pro Automation bereitstellen: Runs, No-Action-Quote,
  Input-/Output-/Cache-/Gesamttokens, Kosten soweit verfuegbar, durchschnittliche
  Laufzeit, Fehler und letzte relevante Meldung fuer 24 Stunden, 7 und 30 Tage.
- Serverseitige Schutzmechanismen planen und nach Produktentscheidung umsetzen:
  Mindestintervall bzw. Warnung bei hoher Frequenz, Max-Tokens pro Run,
  rollierendes Jobbudget, Cooldown, Warnschwellen und optionales automatisches
  Pausieren nach klarer, auditierter Policy. Limits duerfen nicht allein im
  Client erzwungen werden.
- Automationsseite auf Basis von Ticket 10 erweitern:
  - sichtbares Heartbeat-/Monitoring-Badge und Filter;
  - Sortierung nach Tokenverbrauch, Frequenz, Kostenrisiko und Fehlern;
  - Owner, Agent, Workspace, Result Policy und Delivery direkt erkennbar;
  - Warnzustand fuer hohe No-Action-Kosten, sehr kurze Intervalle oder
    wiederholte Fehler;
  - schnelle Pause-/Resume-Aktion mit Berechtigungspruefung und Bestaetigung;
  - Detailansicht mit Verbrauchstrend, Run-Ergebnissen und begruendeter
    Notification-Unterdrueckung.
- Standardvorlage und Prompt so eng formulieren, dass nur neue oder erneut
  handlungsrelevante Fakten gemeldet werden. Wiederholte identische Befunde
  erhalten eine definierte Dedup-/Cooldown-Semantik.

## Abnahmekriterien

- Ein `deliver_relevant_only`-Lauf ohne Befund endet als erfolgreicher
  `no_action`-Run und erzeugt in keinem konfigurierten oder impliziten Kanal eine
  Nutzer-Notification oder neue sichtbare Chataktivitaet.
- Ein relevanter Befund wird genau einmal ueber die konfigurierte Delivery-
  Route zugestellt. Ein Fehler erscheint als Fehler und wird nicht als
  `no_action` unterdrueckt.
- Nach Reload sind Owner, Agent, Workspace, Zeitplan, Result Policy,
  letzter/naechster Lauf, No-Action-Quote und Tokenverbrauch korrekt sichtbar.
- Ein Admin oder berechtigter Owner findet ueber Filter/Sortierung innerhalb
  weniger Schritte die teuersten und haeufigsten Heartbeat-Jobs und kann sie
  sicher pausieren.
- Ein unberechtigter Nutzer kann fremde Jobs, Verbrauchswerte oder
  Run-Metadaten weder sehen noch aendern.
- Token-/Budgetwarnungen sind reproduzierbar, auditierbar und verwenden
  serverseitig berechnete Daten. Ein Grenzwert kann nicht durch Clientpayloads
  umgangen werden.
- Legacy-migrierte Heartbeats und neu angelegte Monitoring-Automationen folgen
  nach Migration demselben Ausfuehrungs-, Notification- und UI-Vertrag.

## Tests und Abschluss

- Result-Policy- und Runner-Matrixtests fuer `no_action`, relevante Meldung,
  leere/ungueltige Antwort, Fehler, Retry und jeden Delivery-/Push-Pfad.
- Scheduler-, Migration-, Workspace-/Owner-, Rechte-, Dedup-, Cooldown- und
  Budgettests mit kontrollierter Zeit und reproduzierbaren Usage-Events.
- UI-Komponenten-Tests fuer Badge, Filter, Verbrauchssortierung, Warnungen,
  Run-Details und Pause/Resume; sensible Inhalte duerfen nicht in Analytics
  oder Notifications erscheinen.
- `npm run build` nach Server-/Web-Aenderungen.
- Manuelle Abnahme mit einem guenstigen No-Action- und einem absichtlich
  ineffizienten Testjob; Browser-/Playwright-E2E nur nach expliziter Freigabe.
- Eigener fokussierter Commit, danach Status im [Index](./README.md)
  aktualisieren.
