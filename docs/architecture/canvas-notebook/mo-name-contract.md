---
title: Canvas Notebook — Mo Namensvertrag
status: decided
decision_id: MO-001
decision_date: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - brand
  - naming
---

# Canvas Notebook — Mo Namensvertrag

## Verbindliche Entscheidung

Der sichtbare Produktname des Canvas-Notebook-Hauptagenten ist **Mo**.

**Mosaic** beschreibt ausschließlich die Herkunft des Namens und darf in einer
einmaligen Markengeschichte erläutert werden. Mosaic ist kein alternativer
Produkt-, Agenten- oder UI-Name. **Mosa** wird nicht verwendet.

Diese Entscheidung gilt für neue Texte und Implementierungen in UI,
Onboarding, Produktdokumentation und Marketing. Bereits vorhandene technische
Bezeichner werden dadurch nicht umbenannt.

## Vertrag pro Oberfläche

| Oberfläche | Verbindliche Bezeichnung | Regel |
| --- | --- | --- |
| Agent-Auswahl und Chat-Header | `Mo` | Nur der Hauptagent erhält diesen sichtbaren Namen. |
| Onboarding | `Mo` | Erste Nennung: „Mo, der Hauptagent von Canvas Notebook“. Die Herkunft aus Mosaic darf einmalig erklärt werden. |
| Produktdokumentation | `Mo` | In technischen Texten bei der ersten Nennung: „Mo (Display-Name des Hauptagenten `canvas-agent`)“. |
| Marketing und Website | `Mo` | Mo ist der sichtbare Name. Mosaic darf nur als Herkunftsgeschichte und nicht als gleichwertige Marke erscheinen. |
| Status- und Fehlermeldungen | `Mo` oder kein Eigenname | Der Name wird nur verwendet, wenn tatsächlich der Hauptagent gemeint ist. |
| Eigene und spezialisierte Agenten | jeweiliger eigener Name | Keine Umbenennung zu Mo. |
| Canvas Control Plane Agent | technische Bezeichnung | Keine Bezeichnung als Mo. Die endgültige sichtbare Terminologie folgt in MO-006. |

## Technische Grenzen

Die Namensentscheidung ändert ausschließlich den sichtbaren Display- und
Identitätsvertrag. Folgende Werte bleiben stabil:

- interne Agent-ID `canvas-agent`;
- Datenbankbeziehungen und Session-Zuordnungen;
- API-Parameter und Automationsreferenzen;
- Speicherpfade wie `/data/agents/canvas-agent`;
- Namen eigener, spezialisierter und technischer Agenten.

Eine technische Umbenennung von `canvas-agent` ist nicht Bestandteil dieses
Vorhabens.

## Schreibweise

- korrekt: `Mo`;
- nicht korrekt: `MO`, `mo`, `Mosa`, `Mosaic Agent`;
- Zusammensetzungen möglichst vermeiden; falls technisch nötig, mit
  Bindestrich schreiben, zum Beispiel `Mo-Glyph` oder `Mo-Asset`;
- „Mosaic“ niemals ohne erklärenden Herkunftskontext als sichtbaren Namen
  verwenden.

## Abgeschlossene Validierung und Grenzen

Der Namensvertrag wurde durch die folgenden Prüfungen ergänzt:

- [MO-002](./mo-name-language-validation.md) bestätigt Aussprache, Verständnis
  und Namenswirkung auf Deutsch und Englisch;
- [MO-003](./mo-name-availability-assessment.md) dokumentiert Produkt-, Domain-
  und Markenrisiken.

Mo bleibt deshalb der Display-Name innerhalb von Canvas Notebook, wird aber
nicht als eigenständige Software-, Firmen- oder Service-Marke positioniert.
Die erste externe Nennung enthält immer den Canvas-Notebook-Absender. Mosaic
bleibt ausschließlich Herkunftsgeschichte.

Die Verfügbarkeitsprüfung ersetzt keine Rechtsberatung. Vor einer
Markenanmeldung oder einem eigenständigen Mo-Launch ist eine professionelle
Ähnlichkeitsrecherche erforderlich. Ein späterer auffälliger Befund ändert den
Namen nicht still. Stattdessen werden MO-001 und MO-003 mit dokumentierter
Begründung wieder geöffnet und eine neue Namensentscheidung versioniert.

## Abnahme

MO-001 ist abgeschlossen, weil mit **Mo** genau ein sichtbarer Name für UI,
Onboarding, Dokumentation und Marketing festgelegt ist und die Abgrenzung zu
Mosaic sowie zur technischen ID `canvas-agent` dokumentiert wurde.
