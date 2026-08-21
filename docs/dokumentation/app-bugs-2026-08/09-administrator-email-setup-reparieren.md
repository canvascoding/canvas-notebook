---
title: 'Ticket 09: Administrator-E-Mail-Setup reparieren'
status: open
priority: high
depends_on: []
platforms: [web, server]
tags: [type/bug, topic/email, topic/settings, topic/admin]
---

# Ticket 09: Administrator-E-Mail-Setup reparieren

## Problem

Das Administrator-Setup fuer die System-E-Mail in den Einstellungen arbeitet
nicht zuverlaessig. Speichern, Testen, Fehlermeldungen und der Unterschied
zwischen systemweiter Absenderkonfiguration und Workspace-Postfaechern sind
dadurch nicht eindeutig oder fehlerhaft.

## Zielzustand

- Berechtigte Administratoren koennen die System-E-Mail konfigurieren, sicher
  testen und den aktuellen Zustand nachvollziehen.
- System-E-Mail und Workspace-Postfaecher sind in UI, API und Persistenz klar
  getrennt.
- Secrets werden nie an den Client zurueckgegeben und nur ueber die zentrale
  Integrations-/Secret-Verwaltung gespeichert.
- Fehlende Variablen verweisen auf `/settings?tab=integrations`.

## Umsetzung

- `SystemEmailSettingsPanel`, Admin-Routen, SMTP-Konfiguration und
  Notification-Delivery gemeinsam inventarisieren; den Fehler reproduzierbar
  dokumentieren.
- Lade-, Speicher-, Test-, Erfolg- und Fehlerzustaende der Einstellungen
  korrigieren; vorhandene Secrets nur als gesetzt/nicht gesetzt darstellen.
- Adminberechtigung serverseitig an jedem Endpunkt pruefen und eine klare
  Abgrenzung zu `WorkspaceMailboxesSettingsPanel` erzwingen.
- Validierung, TLS-/Port-Semantik, Timeout und providerneutrale Fehlercodes
  vereinheitlichen, ohne Credentials zu protokollieren.
- Migration und Rueckwaertskompatibilitaet vorhandener Konfigurationen pruefen.

## Abnahmekriterien

- Ein Admin kann eine gueltige Konfiguration speichern und eine Testnachricht
  versenden; ein Nicht-Admin wird serverseitig abgewiesen.
- Ungueltige oder unvollstaendige Angaben erzeugen eine konkrete, sichere
  Fehlermeldung und verlieren keine zuvor gueltige Konfiguration.
- Reload zeigt den korrekten Status, aber niemals Passwort oder Token.
- System-E-Mail-Aenderungen veraendern kein Workspace-Postfach und umgekehrt.

## Tests und Abschluss

- API-/Service-Tests fuer Rechte, Redaction, Validierung, Speichern und Testlauf.
- `npm run build` und manuelle Abnahme der Settings-UI; Browser-/E2E-Test nur
  nach expliziter Freigabe.
- Eigener Commit, danach Status im [Index](./README.md) aktualisieren.
