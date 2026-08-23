---
title: 'Ticket 29: Notification-Zentrum als Attention- und E-Mail-Review-Queue ausbauen'
status: planned
priority: high
depends_on: ['02-notification-und-todo-status-vereinheitlichen', '03-mobile-inbox-tabs-und-badges', '14-todo-sichtbarkeit-filter-und-priorisierung']
platforms: [web, server, mobile-api]
tags: [type/feature, topic/notifications, topic/todos, topic/email, topic/workspaces]
---

# Ticket 29: Notification-Zentrum als Attention- und E-Mail-Review-Queue ausbauen

> Verbindlicher Gesamtplan und zentrale Referenz:
> [29-notification-zentrum-attention-todos-email-review-umsetzungsplan.md](./29-notification-zentrum-attention-todos-email-review-umsetzungsplan.md)

## Problem

Das Web-Notification-Zentrum leitet seine To-do-Sektion noch aus dem breiten
Mobile-/Aggregate-Inbox-Feed ab. Es kann dadurch eine zweite To-do-Liste
werden: auch gelesene und erledigte Eintraege werden geladen, die
Relevanzregel ist nicht explizit, und der Glocken-Zaehler kommt aus einem
gemischten Feed. Persistierte E-Mail-Faelle und von Agenten vorbereitete
Outbox-Entwuerfe werden dort noch nicht als menschliche Review-Queue gezeigt.

## Zielzustand

- Das Zentrum ist eine kleine Attention-Projektion, keine zweite To-do-App und
  kein voller E-Mail-Client.
- Es trennt Ereignisbenachrichtigungen, relevante offene To-dos und
  E-Mail-Reviews.
- Die Glocke zaehlt ausschliesslich ungelesene Ereignisse. To-dos und E-Mails
  haben getrennte Attention-Counts.
- To-dos werden serverseitig ausgewählt; `done` und `archived` erscheinen nie.
- Entwuerfe bleiben human-in-the-loop: Pruefen und nach ausdruecklicher
  Bestaetigung ueber den vorhandenen Outbox-Pfad senden, niemals ueber einen
  neuen Notification-Sendepfad.

## Abgrenzung und Abhaengigkeiten

- **02 erledigt:** kanonischer To-do-Read-State, keine zweite Persistenz.
- **03 in Abnahme:** Mobile-Kategorien, E-Mail-Attention und Inbox-Scopes;
  gemeinsame Inbox-Dateien erst danach integrieren.
- **14 in Abnahme:** Scope, Filter, Prioritaet und `done => read`; dieses
  Ticket ersetzt nicht die vollstaendige To-do-Liste.
- **20 offen:** erweitert danach Agenten- und Push-Ereignisse auf Basis dieses
  Attention-Vertrags.
- **27 offen:** bleibt der vollstaendige E-Mail-Lesefluss; dieses Ticket nutzt
  ausschliesslich persistierte Faelle und Entwuerfe, keine Provider-Inbox.

## Abnahmekriterien

- Offene oder ungelesene To-dos sowie E-Mail-Reviews erhoehen den Glocken-
  Badge nicht.
- Maximal sechs relevante offene To-dos mit Relevanzgrund und Link zur To-do-
  App; terminale To-dos fehlen vollstaendig.
- Ein Fall mit wartendem Agentenentwurf erscheint genau einmal.
- Senden setzt frische Detailpruefung, explizite Bestaetigung, Schreibrecht,
  Versionscheck und die bestehende Audit-/Reservierungslogik voraus.
- Workspace-Ausschluesse, Berechtigungen und Scopes gelten identisch fuer alle
  Sektionen.
