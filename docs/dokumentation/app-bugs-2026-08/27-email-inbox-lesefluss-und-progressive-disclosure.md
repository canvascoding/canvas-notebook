---
title: 'Ticket 27: E-Mail-Inbox-Lesefluss und Progressive Disclosure verbessern'
status: open
priority: high
depends_on: []
platforms: [web, server]
tags: [type/bug, topic/email, topic/inbox, topic/user-interface, topic/progressive-disclosure]
---

# Ticket 27: E-Mail-Inbox-Lesefluss und Progressive Disclosure verbessern

## Problem

Auf der E-Mail-Route aktualisiert sich die Inbox waehrend des Lesens teilweise
automatisch. Wird eine E-Mail geoeffnet und der Nutzer scrollt im Inhalt, kann
ein Hintergrund-Refresh die Auswahl, den Inhaltszustand oder die Scrollposition
zuruecksetzen. Der Lesefluss wird unterbrochen und die gerade geoeffnete E-Mail
kann nicht verlaesslich weitergelesen werden.

Gleichzeitig nehmen Outbox und „Replies for Review“ dauerhaft viel Platz ein
und sind nicht einklappbar. Dadurch bleibt fuer die normale Inbox- und
Nachrichtenansicht zu wenig Breite und Hoehe. Die E-Mail-Oberflaeche muss die
primaere Aufgabe – E-Mails wie in einem herkoemmlichen Mailclient lesen und
pruefen – priorisieren und sekundaere Arbeitsbereiche nach dem Prinzip des
Progressive Disclosure erst bei Bedarf zeigen.

## Zielzustand

- Hintergrund-Synchronisierung aktualisiert Inbox-Daten, ohne eine aktiv
  gelesene Nachricht, ihre Scrollposition, Auswahl, Lade- oder Entwurfszustand
  unnoetig zu verlieren.
- Neue, geloeschte oder geaenderte Nachrichten werden nachvollziehbar und
  konfliktfrei behandelt; ist die aktuell geoeffnete Nachricht nicht mehr
  verfuegbar, zeigt die UI einen klaren, stabilen Zustand statt eines stillen
  Resets.
- Outbox und „Replies for Review“ sind als einklappbare, zugängliche
  Sekundaerbereiche umgesetzt. Ihr Zustand bleibt mindestens innerhalb der
  Session stabil und ist auf kleinen sowie grossen Bildschirmen sinnvoll.
- Die reguläre Inbox-/Leseflaeche bekommt sichtbar Vorrang bei Breite, Hoehe
  und Fokus. Die Navigation bleibt fuer Tastatur und Screenreader bedienbar.
- Polling, manuelles Refresh, Push-/Realtime-Updates und Mutationen folgen
  einer einheitlichen Zustands- und Fehlersemantik ohne unkontrollierte
  Reload-Schleifen.

## Umsetzung

- Den Daten- und UI-Fluss der E-Mail-Route inventarisieren: Inbox-Abfrage,
  Polling/Refresh, Caches, Auswahlzustand, Message-Detail-Laden, virtuelle
  Listen, Scrollcontainer, Outbox, Review-Queue und zustandsausloesende
  Mutationen.
- Ursache des Leseresets mit einer reproduzierbaren Sequenz festlegen:
  Nachricht oeffnen, im Inhalt scrollen, automatischen oder manuellen Refresh
  ausloesen, neue/veraenderte/geloeschte Nachricht verarbeiten. Zwischen
  Listenreload, Detailreload, Komponent-Remount und bewusstem Auswahlwechsel
  unterscheiden.
- Einen kanonischen Refresh-Vertrag definieren: Daten im Hintergrund
  revalidieren, aktive Nachricht anhand stabiler Identitaet erhalten,
  Scrollposition nur beim expliziten Nachrichtenwechsel oder nachvollziehbaren
  Content-Revision-Wechsel behandeln und parallele Refreshes deduplizieren.
- Outbox und „Replies for Review“ als progressive, einklappbare Bereiche planen:
  klare Default-Sichtbarkeit, erreichbare Toggle-Controls, persistierter
  Sessionzustand, sinnvolle Mobile-/Desktop-Layouts und keine Verdeckung der
  Inbox-/Leseflaeche.
- Lade-, Fehler-, leere und nicht mehr vorhandene Zustände fuer Liste und
  Detailansicht spezifizieren. Ein Hintergrundfehler darf bereits gelesenen
  Inhalt nicht ohne klare Kennzeichnung entfernen.
- Berechtigungs-, Workspace- und Mailbox-Scope serverseitig unveraendert
  erhalten. Cache- oder UI-Schluessel duerfen keine Nachrichten zwischen
  Mailboxen, Accounts oder Workspaces vermischen.
- Mit Ticket 09 bei gemeinsamen E-Mail-Settings abstimmen; es besteht keine
  harte Abhaengigkeit.

## Abnahmekriterien

- Bei wiederholtem Hintergrund-Refresh bleibt eine geoeffnete, unveraenderte
  E-Mail ausgewaehlt und an derselben Leseposition, waehrend der Nutzer im
  Inhalt scrollt.
- Eine neue Nachricht aktualisiert die Inbox, ohne die aktive Detailansicht zu
  schliessen oder den Lesefokus zu stehlen.
- Eine geaenderte oder geloeschte aktive Nachricht erzeugt einen klaren,
  bedienbaren Aktualisierungs- bzw. Nicht-mehr-verfuegbar-Zustand.
- Outbox und „Replies for Review“ lassen sich unabhaengig einklappen; die
  Inbox-/Leseflaeche gewinnt den frei gewordenen Raum und bleibt auf Desktop
  sowie Mobile gut nutzbar.
- Keyboard-Fokus, Screenreader-Namen und `aria-expanded`-Zustand der
  Sekundaerbereiche sind korrekt; der Inhaltsbereich bleibt erreichbar.
- Ein Mailbox-, Nutzer- oder Workspace-Wechsel zeigt niemals Inhalte oder
  Auswahlzustand eines vorherigen Scopes.

## Tests und Abschluss

- Komponenten-/Store-Tests fuer Auswahl- und Scroll-Erhalt, Refresh-Dedupe,
  Content-Revisionen, Message-Loeschung und Scopewechsel.
- Route-/Daten-Tests fuer Inbox-, Outbox- und Review-Abfragen sowie
  Workspace-/Mailbox-Isolation.
- UI-Tests fuer einklappbare Bereiche, responsive Layouts, Tastatur und
  Accessibility-Zustaende.
- `npm run build` nach Web-/Server-Aenderungen; manuelle Abnahme mit einer
  langen E-Mail, laufendem Hintergrund-Refresh und kleinen/grossen Viewports.
  Browser-/Playwright-E2E nur nach expliziter Freigabe.
- Eigener fokussierter Commit, danach Status im [Index](./README.md)
  aktualisieren.
