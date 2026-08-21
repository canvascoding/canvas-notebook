---
title: 'Ticket 06: Mobile Notizen von WebView zu nativ migrieren'
status: open
priority: medium
depends_on: ['05-files-tab-automatisch-aktualisieren']
platforms: [mobile, server]
tags: [type/feature, topic/mobile-app, topic/notes]
---

# Ticket 06: Mobile Notizen von WebView zu nativ migrieren

## Problem

Die Notizfunktion der Expo-App wird als WebView ausgeliefert. Das begrenzt
Performance, native Eingabe, Offline-Faehigkeit und OS-Integration.

## Zielzustand

Notizen werden in der Expo-App nativ gerendert und bearbeitet. Synchronisation,
Konfliktverhalten, Offline-Nutzung und Dateianhaenge sind bewusst definierte
Produktfunktionen, keine impliziten Nebenwirkungen der WebView.

## Umsetzung

- Anforderungen fuer Lesen, Editieren, Markdown/Rich-Text, Suche, Anhaenge,
  Offline-Cache, Konflikte, Share-Sheet, Keyboard und Accessibility festlegen.
- Architekturentscheidung nachvollziehbar treffen: React-Native-Komponenten,
  Expo-kompatibler Editor oder begruendetes natives Modul. Abhaengigkeiten,
  Plattformparitaet, Sicherheits- und Wartungskosten bewerten.
- API- und Synchronisationsvertrag fuer Versionen, Offline-Mutationen,
  Konflikte und Berechtigungen festlegen. Server bleibt fuer Ownership und
  Workspace-Scope autoritativ.
- Einen nativen Proof of Concept fuer die kritischen Editier- und Sync-Flows
  bauen, messen und gegen die WebView vergleichen.
- Erst nach positiver Entscheidung eine schrittweise Migration mit
  Feature-Flag, Datenmigration/Rollback und Entfernung der WebView planen und
  umsetzen.

## Abnahmekriterien

- Es gibt eine dokumentierte Architekturentscheidung und eine akzeptierte
  Migrations-/Rollback-Strategie.
- Der PoC deckt Editieren, Speichern, Sync, Offline-Rueckkehr und mindestens
  einen OS-Integrationsfall nativ ab.
- Keine Notiz eines fremden Nutzers oder Workspaces ist offline oder online
  abrufbar bzw. mutierbar.
- Performance- und UX-Vergleich gegen die bisherige WebView ist dokumentiert.

## Tests und Abschluss

- API-/Scope-Tests im Server-Repository; Offline-/Sync-/Geraetetests im
  Expo-Repository.
- `npm run build` fuer betroffene Server-/Web-Anteile.
- Eigener Commit je Repository; dann Status im [Index](./README.md) aktualisieren.
