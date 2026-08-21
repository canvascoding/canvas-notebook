---
title: 'Ticket 19: Bedarfsevidenz fuer Word- und Excel-Werkzeuge'
status: insufficient_evidence
date: 2026-08-21
platforms: [server, agent-runtime]
tags: [type/evaluation-evidence, topic/documents, topic/spreadsheets, topic/privacy]
---

# Bedarfsevidenz: Word- und Excel-Werkzeuge

## Ergebnis

Das Bedarfsgate aus dem [Evaluationsplan](./19-word-und-excel-werkzeuge-evaluationsplan.md)
ist fuer DOCX und XLSX nicht nachweisbar erfuellt. Der aktuelle Entscheid ist
deshalb **insufficient evidence / No-Go fuer weitere Produkt- oder PoC-Phasen**.
Es werden keine Office-Parser, Fixtures, Toolsets, Telemetrie oder
Produktionsabhaengigkeiten umgesetzt, bis die unten beschriebene,
datenschutzrechtlich freigegebene Aggregatauswertung vorliegt.

Dies ist keine Aussage, dass kein Bedarf existiert. Es ist die belastbare
Feststellung, dass der Repository-Bestand die im Plan festgelegte
Nutzungsschwelle nicht belegen kann, ohne Dateinamen, Pfade oder Inhalte aus
Auditdaten auszuwerten.

## Gepruefte, zulaessige Quellen

Die Pruefung war rein statisch und hat weder Produktionsdatenbanken noch
Workspace-Dateien, Supportfaelle oder Dokumentinhalte gelesen.

| Quelle | Beobachtung | Eignung fuer das Bedarfsgate |
| --- | --- | --- |
| `pi_usage_events` in `app/lib/db/schema.ts` und `app/lib/pi/usage-events.ts` | Erfasst Modell-, Token-, Kosten-, Session- und Workspace-Kontext, aber keinen Dateityp, keine Dateierweiterung und keinen Office-Job. | Nicht geeignet |
| `audit_events` in `app/lib/db/schema.ts` | Allgemeine Audit-Huelle; ihre Struktur garantiert keine datensparsame Dateityp-Aggregation. | Nur nach separater, freigegebener Auswertung |
| Upload-Audits in `app/api/files/upload/route.ts` und `app/api/files/uploads/[id]/complete/route.ts` | Enthalten `file.upload`, MIME-Type und Groesse, aber auch `entityId`, `summary`, `targetPath` beziehungsweise `uploadedPaths` mit Rohpfaden/Dateinamen. | Nicht direkt verwenden |
| Repository-Dateien und Tests | Enthalten keine versionierte 90-Tage-Aggregation, keine Supportfall-Klassifikation und keine Interviewdaten. | Nicht geeignet |

Die Auswertung der Upload-Audits direkt aus der Datenbank waere zwar technisch
moeglich, aber nicht mit dem Plan vereinbar: Sie wuerde Rohpfade und
Dateinamen verarbeiten. Sie wird daher nicht als stillschweigende
Produktdatenanalyse durchgefuehrt.

## Gate-Bewertung

| Kriterium aus dem Plan | DOCX | XLSX | Ergebnis |
| --- | --- | --- | --- |
| Mindestens 5 % aktive Workspaces an mindestens drei Tagen im 30-Tage-Fenster | Nicht messbar | Nicht messbar | Nicht erfuellt |
| Zehn verschiedene Support-/Featurefaelle aus mindestens fuenf Tenants | Keine freigegebene Quelle im Repository | Keine freigegebene Quelle im Repository | Nicht erfuellt |
| Fuenf freiwillige Interviews mit mindestens woechentlichem, ungedecktem Job | Keine Evidenz im Repository | Keine Evidenz im Repository | Nicht erfuellt |
| Zwei haeufigste Jobs decken 80 % der Anfragen ab | Nicht klassifizierbar | Nicht klassifizierbar | Nicht erfuellt |

Weder DOCX noch XLSX erreichen damit zwei von drei Evidenzarten. Das im Plan
vorgesehene Product-Go ist nicht gegeben. Nach Phase 1 endet die technische
Evaluation vor Phase 2; insbesondere ist ein isolierter Parser-PoC ohne
vorherige Bedarfsevidenz nicht autorisiert.

## Minimaler, datensparsamer Weg zur Neubewertung

Eine Neubewertung darf erst beginnen, wenn Produkt, Datenschutz und Security
einen Auswertungsauftrag mit folgenden Grenzen freigeben:

- ein festes 90-Tage-Fenster und eine dokumentierte Definition von "aktivem
  Workspace";
- serverseitige Aggregation ausschliesslich nach Formatgruppe `docx`/`xlsx`,
  Tag und pseudonymisiertem Workspace-/Tenant-Zaehler;
- keine Ausgabe oder Persistenz von Dateinamen, Pfaden, Dokumentinhalten,
  Zellwerten, Formeln, Relationship-Zielen oder Sessiontiteln;
- getrennte, freiwillige Supportfall- und Interviewklassifikation nur nach
  Jobtyp, ohne Anhange oder Originaldokumente;
- festgelegte Retention, Zugriffskreis und Loeschtermin fuer die Aggregation.

Danach wird ausschliesslich die Gate-Tabelle dieses Dokuments mit den
aggregierten Ergebnissen aktualisiert. Erst wenn das Bedarfsgate fuer ein
Format bestanden ist, darf die naechste sequenzielle Phase beginnen:
synthetische Fixture- und Sicherheitskorpus-Erstellung. Eine neue
Produkttelemetrie, ein Office-Toolset oder ein Parser bleiben bis dahin
ausgeschlossen.

## Nachweis der Ausfuehrung

- Kein Produktions- oder Workspace-Inhalt wurde gelesen oder gespeichert.
- Es wurden keine Server, Container, Browser- oder End-to-End-Tests gestartet.
- Es wurden keine Produktpfade, Datenbankschemata, Telemetrie oder
  Runtime-Abhaengigkeiten veraendert.
- Die Entscheidung basiert auf den in der Tabelle genannten,
  codebestandsnahen Quellen und dem verbindlichen Bedarfsgate des Plans.
