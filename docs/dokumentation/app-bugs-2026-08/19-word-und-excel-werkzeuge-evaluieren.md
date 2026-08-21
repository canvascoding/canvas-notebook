---
title: 'Ticket 19: Word- und Excel-Werkzeuge evaluieren'
status: open
priority: low
depends_on: []
platforms: [server, agent-runtime]
tags: [type/feature, topic/documents, topic/spreadsheets, topic/tools]
---

# Ticket 19: Word- und Excel-Werkzeuge evaluieren

## Problem

PDF-Dateien besitzen bereits spezialisierte Verarbeitungswege. Fuer Word- und
Excel-Dateien ist noch nicht entschieden, ob haeufige Nutzung eigene Agent-
Tools fuer Lesen, Erstellen und kontrolliertes Bearbeiten rechtfertigt.

## Zielzustand

- Nutzung, konkrete Jobs und Sicherheitsrisiken sind vor einer Implementierung
  belegt und priorisiert.
- Es gibt eine Entscheidung zwischen spezialisierten Tools, Skills oder
  bestehenden Datei-/Exportpfaden.
- Falls umgesetzt, arbeiten DOCX-/XLSX-Operationen workspacegebunden,
  nachvollziehbar und mit verlustarmer Validierung sowie sicherem Rollback.
- Das Toolset bleibt klein und wird nur Agenten mit echtem Bedarf angeboten.

## Umsetzung

Die codebestandsnahe Evaluations-, Sicherheits-, PoC-, Roundtrip- und
Abnahmeplanung liegt im
[Evaluationsplan zu Ticket 19](./19-word-und-excel-werkzeuge-evaluationsplan.md).
Bis zu einer dort dokumentierten Go-Entscheidung werden keine produktiven
Office-Tools oder In-place-Bearbeitungen umgesetzt.

### Ausfuehrungsstand

Phase 1 hat keine datensparsame, bereits freigegebene Quelle erreicht, mit der
das Bedarfsgate fuer DOCX oder XLSX nachweisbar erfuellt werden kann. Die
[Bedarfsevidenz und Gate-Entscheidung](./19-office-usage-evidence.md) lautet
deshalb `insufficient_evidence`: Die Evaluation stoppt vor Fixtures und
Parser-PoC; eine Neubewertung benoetigt erst einen freigegebenen,
aggregierten Auswertungsauftrag.

- Telemetrie bzw. Supportfaelle datensparsam auswerten und Kern-Use-Cases fuer
  DOCX und XLSX festlegen; keine Dokumentinhalte erheben.
- Bestehende PDF-, Export-, Upload-, Preview- und abgeleitete DOCX-Pfade sowie
  verfuegbare Skills/Bibliotheken vergleichen.
- Sicherheitsmodell fuer Makros, externe Links, Formeln, eingebettete Objekte,
  Zip-Bombs, Dateigroessen und Ressourcenlimits entwerfen.
- Einen read-only Proof of Concept und optional kontrollierte Kopie-statt-
  In-place-Bearbeitung mit Render-/Roundtrip-Pruefung bewerten.
- Entscheidung, API-/Tool-Schemas, Feature-Flag und Abnahmematrix dokumentieren.

## Abnahmekriterien

- Eine belastbare Go/No-Go-Entscheidung mit Nutzungsschwelle, Aufwand und
  Risiken liegt vor.
- Ein PoC veraendert keine Originaldatei und respektiert Nutzer-/Workspace-
  Rechte sowie Ressourcenlimits.
- Nicht unterstuetzte Inhalte werden sicher abgelehnt oder klar als potenziell
  verlustbehaftet markiert.
- Neue Tools erscheinen nur im effektiven Prompt berechtigter Agenten.

## Tests und Abschluss

- Bei Umsetzung: Parser-, Roundtrip-, Berechtigungs-, Malware-/Limit- und
  visuelle Render-Tests mit kleinen, versionierten Fixtures.
- `npm run build` fuer Runtime-/Web-Aenderungen.
- Eigener Commit fuer die Entscheidung und spaeter getrennte Implementierungs-
  commits; Status im [Index](./README.md) aktualisieren.
