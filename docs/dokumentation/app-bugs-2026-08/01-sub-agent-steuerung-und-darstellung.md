---
title: 'Ticket 01: Sub-Agent-Steuerung und Darstellung'
status: open
priority: high
depends_on: []
platforms: [web, server]
tags: [type/bug, topic/canvas-agent, topic/sub-agents]
---

# Ticket 01: Sub-Agent-Steuerung und Darstellung

## Problem

Sub-Agent-Sessions erscheinen wie normale Sessions in der Historie. Ihre
vollstaendigen Antworten werden in den Parent-Chat eingespielt. Beim Start ist
kein konkreter Agent waehbar; zudem muss Rekursion technisch ausgeschlossen
sein.

## Zielzustand

- Der Parent kann einen zugelassenen Agenten gezielt als Sub-Agent auswaehlen.
- Die fuer den Sub-Agenten verfuegbaren Tools sind pro Start explizit und
  serverseitig begrenzt konfigurierbar.
- Eine Sub-Agent-Ausfuehrung darf niemals selbst einen weiteren Sub-Agenten
  starten (maximale Tiefe: 1).
- Sub-Agent-Sessions werden in der allgemeinen Session-Historie nicht wie
  eigenstaendige Parent-Sessions angezeigt; sie sind dem Parent zugeordnet und
  bei Bedarf ueber dessen Detailansicht erreichbar.
- Im Parent-Chat erscheint eine kompakte, einklappbare Ergebnis-Karte statt der
  vollstaendigen Sub-Agent-Transkription.

## Umsetzung

- Datenmodell und Runtime-Kontext um `parentSessionId`, `delegationDepth`,
  ausfuehrenden Agenten sowie effektives Tool-Set erweitern.
- Serverseitig eine Allowlist der delegierbaren Agenten und Tools anhand von
  Workspace-, Nutzer- und Agentenrechten aufloesen. Client-Payloads duerfen
  keine Rechte erweitern.
- Das Spawn-Tool bei `delegationDepth >= 1` sowohl im Tool-Schema als auch in
  der Runtime sperren; den Versuch nachvollziehbar ablehnen.
- Startdialog und Tool-Aufruf um Agentenwahl, begrenzte Tool-Konfiguration und
  erklaerende Fehlermeldungen ergaenzen.
- Session-Abfragen nach Parent- und Sub-Agent-Sessions trennen. Eine
  Parent-Session liefert eine zusammengefasste Delegationsreferenz, die
  Detaildaten nur auf ausdrueckliche Nutzeraktion laedt.
- Eine wiederverwendbare kompakte Ergebnis-Karte mit Status, Agent, Dauer,
  Kurzfassung und aufklappbarem Volltext bauen.

## Abnahmekriterien

- Ein berechtigter Nutzer kann genau einen verfuegbaren Sub-Agenten auswaehlen;
  nicht berechtigte Agenten oder Tools sind nicht waehbar und serverseitig
  abgewiesen.
- Ein Sub-Agent-Spawn aus einer Sub-Agent-Session wird sicher abgelehnt.
- Die normale Session-Liste zeigt keine Sub-Agent-Sessions als gleichrangige
  Eintraege.
- Der Parent-Chat bleibt bei langem Sub-Agent-Ergebnis kompakt; Volltext ist
  nur nach explizitem Aufklappen sichtbar.
- Ownership-, Tool-Allowlist-, Tiefenlimit- und Listenfilter-Tests bestehen.

## Tests und Abschluss

- Unit-/Integrationstests fuer Delegationstiefe, Rechte, Tool-Konfiguration,
  Parent-Zuordnung und History-Filter.
- `npm run build` nach Server-/Web-Aenderungen.
- Manuelle Abnahme des Dialogs und der Ergebnis-Karte; Browser-/E2E-Test nur
  nach expliziter Freigabe.
- Eigener Commit, danach Status im [Index](./README.md) auf `erledigt` setzen.
