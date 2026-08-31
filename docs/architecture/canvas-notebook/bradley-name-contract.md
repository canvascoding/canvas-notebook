---
title: Canvas Notebook — Bradley Namensvertrag
status: decided
decision_id: BRADLEY-001
decision_date: 2026-08-31
supersedes: MO-001
owners:
  - Canvas Notebook
tags:
  - agent
  - brand
  - naming
---

# Canvas Notebook — Bradley Namensvertrag

## Verbindliche Entscheidung

Der sichtbare Produktname des Canvas-Notebook-Hauptagenten und der zugehörigen
Maskottchenfigur ist **Bradley**.

Der Name wird immer vollständig ausgeschrieben. **Brad**, **Mo**, **Mosa** und
**Mosaic Agent** sind weder Kurzformen noch alternative Produkt-, Agenten- oder
UI-Namen. Die frühere Arbeitsbezeichnung Mo ist durch diese Entscheidung
abgelöst.

Diese Regel gilt für neue Texte und Implementierungen in UI, Onboarding,
Produktdokumentation, Assets und Marketing. Bereits vorhandene technische
Bezeichner werden dadurch nicht umbenannt.

## Vertrag pro Oberfläche

| Oberfläche | Verbindliche Bezeichnung | Regel |
| --- | --- | --- |
| Agent-Auswahl und Chat-Header | `Bradley` | Nur der Hauptagent erhält diesen sichtbaren Namen. |
| Onboarding | `Bradley` | Erste Nennung: „Bradley, der Hauptagent von Canvas Notebook“. |
| Produktdokumentation | `Bradley` | In technischen Texten bei der ersten Nennung: „Bradley (Display-Name des Hauptagenten `canvas-agent`)“. |
| Marketing und Website | `Bradley` | Der Name erscheint mit einem klaren Canvas-Notebook-Absender, nicht als zweite eigenständige Produktmarke. |
| Status- und Fehlermeldungen | `Bradley` oder kein Eigenname | Der Name wird nur verwendet, wenn tatsächlich der Hauptagent gemeint ist. |
| Eigene und spezialisierte Agenten | jeweiliger eigener Name | Keine Umbenennung zu Bradley. |
| Canvas Host Agent | technische Bezeichnung | Keine Bezeichnung als Bradley; die Abgrenzung steht im [Terminologievertrag](./bradley-agent-terminology-contract.md). |

## Technische Grenzen

Die Namensentscheidung ändert ausschließlich den sichtbaren Display- und
Identitätsvertrag sowie die noch nicht produktiv integrierten Brand-Assets.
Folgende Werte bleiben stabil:

- interne Agent-ID `canvas-agent`;
- Datenbankbeziehungen und Session-Zuordnungen;
- API-Parameter und Automationsreferenzen;
- Speicherpfade wie `/data/agents/canvas-agent`;
- Namen eigener, spezialisierter und technischer Agenten.

Eine technische Umbenennung von `canvas-agent` ist nicht Bestandteil dieses
Vorhabens.

## Schreibweise

- öffentlich korrekt: `Bradley`;
- öffentlich nicht korrekt: `Brad`, `Bradly`, `BRADLEY`, `bradley`, `Mo`,
  `Mosa`, `Mosaic Agent`;
- keine Abkürzung und kein Spitzname;
- in technischen Dateinamen, CSS-Klassen und Asset-Pfaden wird die
  kleingeschriebene Form `bradley` verwendet;
- Zusammensetzungen möglichst vermeiden; falls technisch nötig, mit
  Bindestrich schreiben, zum Beispiel `Bradley-Glyph` oder `Bradley-Asset`.

## Positionierung und Schutzrahmen

Bradley ist eine Figur und die sichtbare Identität des Hauptagenten innerhalb
von **Canvas Notebook**, keine zweite eigenständige Software- oder Firmenmarke.
Die erste externe Nennung enthält deshalb immer den Canvas-Notebook-Absender.

- [BRADLEY-002](./bradley-name-language-validation.md) dokumentiert
  Aussprache, Schreibweise und Namenswirkung auf Deutsch und Englisch.
- [BRADLEY-003](./bradley-name-availability-assessment.md) dokumentiert den
  vorläufigen Markt- und Markenrisikorahmen.

Diese Vorprüfungen ersetzen keine Rechtsberatung. Vor einer eigenständigen
Bradley-Produktlinie, einer Markenanmeldung oder einer großen internationalen
Kampagne ist eine professionelle Identitäts- und Ähnlichkeitsrecherche
erforderlich. Ein späterer auffälliger Befund ändert den Namen nicht still;
BRADLEY-001 und BRADLEY-003 werden dann mit Begründung erneut geöffnet.

## Abnahme

BRADLEY-001 ist abgeschlossen: **Bradley** ist als einziger öffentlicher Name
für UI, Onboarding, Dokumentation, Assets und Marketing festgelegt, ohne
Kurzform und klar getrennt von der technischen ID `canvas-agent`.
