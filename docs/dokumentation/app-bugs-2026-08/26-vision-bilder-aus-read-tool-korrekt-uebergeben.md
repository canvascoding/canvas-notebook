---
title: 'Ticket 26: Vision-Faehigkeiten fuer Bilder aus dem Read-Tool aktivieren'
status: done
priority: high
depends_on: []
platforms: [server, agent-runtime, providers]
tags: [type/bug, topic/agents, topic/vision, topic/images, topic/tools, topic/providers]
---

# Ticket 26: Vision-Faehigkeiten fuer Bilder aus dem Read-Tool aktivieren

## Aktueller Umsetzungsstand (2026-08-22)

Die Korrektur fuer die Bildweitergabe und den optimistischen Provider-Fallback
ist in `main` integriert. Die neuen multimodalen Delivery- und
Vision-Fallback-Tests liegen ebenfalls vor. Die manuelle Abnahme mit einem
visionfaehigen Modell und einem kontrollierten Testbild steht noch aus; das
Ticket ist deshalb in Abnahme und nicht erledigt.

## Produktionsabnahme (2026-08-23)

Die erneute Pruefung am korrekt produktiven Stand ist erfolgreich: Ein
visionfaehiges Modell kann Bilder aus dem `read`-Tool verwenden. Ticket 26 ist
damit erledigt.

## Problem

Ein tatsaechlich visionfaehiges KI-Modell kann seine Vision-Capability im
aktuellen Runtime-Turn nicht zuverlaessig ausnutzen, wenn es ein Bild ueber das
`read`-Tool aus einem Workspace liest. Das Problem ist damit nicht bloss ein
fehlender Bildanhang: Das effektive Modell wird als visionfaehig behandelt oder
erkannt, bekommt die Bildinformation aber nicht in einer fuer seine
Vision-Inferenz nutzbaren Form. Die Capability-Erkennung und die Weitergabe des
Image-Contents vom Toolresultat ueber Nachrichten-Normalisierung und
Provider-Adapter bis zum Modell muessen als ein durchgaengiger Vertrag
funktionieren.

## Zielzustand

- Ein tatsaechlich visionfaehiger Modellturn kann ein via `read` gelesenes,
  berechtigtes Bild erfolgreich als visuellen Input verwenden und dessen Inhalt
  beantworten; ein erkannter Vision-Support bleibt nicht ungenutzt.
- Die Vision-Entscheidung wird aus dem effektiven Provider-/Modellprofil und
  dem konkreten Turn abgeleitet, nicht aus einem statischen Modellnamen, einer
  UI-Annahme oder einer blossen Toolfreigabe.
- Nicht visionfaehige Modelle erhalten einen klaren, sicheren Textfallback
  oder einen stabilen Hinweis, ohne Binaerdaten, falsche Erfolgsmeldungen oder
  einen unerklaerten Verlust des Bildes.
- Direkte Bilder und durch `read` angeforderte PDF-Seitenbilder folgen
  derselben Berechtigungs-, Groessen-, MIME-, Normalisierungs- und
  Fehlersemantik.
- Workspace-Grenzen, Dateigroessenlimits und Geheimnisschutz bleiben bei der
  Bildweitergabe erhalten; Bildbytes, Data-URLs und Provider-Credentials
  gelangen nicht in Logs, Audits oder unberechtigte Sessions.

## Umsetzung

- Den gesamten Datenfluss inventarisieren: effektive Modell-/Providerauswahl,
  `modelSupportsImageInput`, `read`-Resultat, `imageContentForBuffer`,
  Nachrichtenpersistenz, `normalizePiMessagesForLlm`, Provider-Adapter und
  Fehlerbehandlung nach dem Modellaufruf.
- Einen kanonischen, testbaren Capability-Vertrag fuer Text-, Bild- und
  gegebenenfalls PDF-Seitenbild-Eingaben festlegen. Provider- oder
  Modellwechsel, Runtime-Reload, Delegation und Automation duerfen keinen
  alten Vision-Status weiterverwenden.
- Sicherstellen, dass ein erfolgreiches `read`-Bild als typisiertes,
  fuer den gewaehlten Vision-Provider nutzbares multimodales Content-Element
  den naechsten Modellturn erreicht. Es darf nicht durch Normalisierung,
  Groessenbudget, Serialisierung oder Adapterkonvertierung in Text,
  `undefined`, eine leere Nachricht oder einen fuer Vision wirkungslosen
  Anhang zerfallen.
- Fuer nicht unterstuetzte MIME-Typen, zu grosse Bilder, nicht visionfaehige
  Modelle und providerseitig abgewiesene Bildinputs klare, maschinenlesbare
  Fehler-/Fallback-Codes definieren. Kein stilles Entfernen und kein erneutes
  Senden derselben Bildbytes in einer unkontrollierten Retry-Schleife.
- Direkte Bilddateien und gerenderte PDF-Seiten gegen dieselben Limits,
  Berechtigungs- und Providerregeln pruefen. Animationen, Vektorgrafiken oder
  unbekannte Formate nur nach explizit sicherer Konvertierung akzeptieren.
- Runtime-/UI-Status so darstellen, dass Nutzer erkennen koennen, ob ein Bild
  dem Modell uebergeben wurde, aus welchem Grund ein Fallback erfolgte oder ob
  erneutes Lesen nach einer Modell- bzw. Provideraenderung erforderlich ist.
  Es duerfen dabei keine Bildinhalte oder sensiblen Pfade offengelegt werden.
- Mit Ticket 18 bei der effektiven Runtime-Capability und mit Ticket 24 bei
  strukturierten Toolresultaten koordinieren; beide Tickets sind keine harte
  fachliche Abhaengigkeit.

## Abnahmekriterien

- Ein berechtigter Agent liest eine PNG- oder JPEG-Datei im Workspace mit einem
  tatsaechlich visionfaehigen Modell und beantwortet eine kontrollierte,
  nur visuell loesbare Bildfrage anhand des Bildinhalts. Der Test belegt, dass
  die Vision-Inferenz verwendet wurde, ohne Bildbytes zu protokollieren.
- Derselbe Lauf mit einem nicht visionfaehigen Modell liefert einen eindeutigen
  Fallback-/Fehlercode und behauptet nicht, das Bild gesehen zu haben.
- Ein Modell- oder Providerwechsel sowie ein Runtime-Reload aendern die
  effektive Vision-Entscheidung im naechsten Turn korrekt.
- PDF-Seitenbilder verhalten sich konsistent zu direkten Bildern; Groessen- und
  Seitenlimits greifen vor einer Provideranfrage.
- Nicht erlaubte Workspace-Pfade, fremde Sessions und ungueltige bzw. zu grosse
  Bilddaten werden vor der Modelluebergabe abgewiesen.
- Nachrichtenpersistenz, Logs, Fehlertexte und Analytik enthalten weder rohe
  Bildbytes noch Data-URLs oder Provider-Credentials.

## Tests und Abschluss

- Unit- und Contract-Tests fuer Capability-Aufloesung, Content-Normalisierung,
  MIME-/Groessenlimits und die strukturierte Fehlersemantik.
- Provider-Adapter-Tests mit einer kontrollierten Vision- und einer
  Text-only-Modellkonfiguration; direkte Bild- und PDF-Seitenbild-Matrix
  einschliessen.
- Runtime-/Reload-/Delegations-/Automations-Tests gegen stale Capabilities und
  unberechtigte Bilduebergaben.
- `npm run build` nach Server-/Runtime-Aenderungen; manuelle Abnahme mit einem
  Testbild. Browser-/Playwright-E2E nur nach expliziter Freigabe.
- Eigener fokussierter Commit, danach Status im [Index](./README.md)
  aktualisieren.
