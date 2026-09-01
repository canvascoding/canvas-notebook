---
title: Canvas Notebook — Bradley Pilot-Auswertung
status: in_progress
todo_id: BRADLEY-045
last_updated: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - brand
  - pilot
  - validation
---

# Canvas Notebook — Bradley Pilot-Auswertung

## Zwischenentscheidung

Der technische UI-Pilot ist bestanden. Bradley ist im Produkt eindeutig dem
Hauptagenten zugeordnet, bleibt von Spezialagenten getrennt, funktioniert in
Desktop und Mobile sowie Light, Dark und Reduced Motion und verändert keine
internen Agentenverträge.

Die qualitative Zielgruppenvalidierung ist noch nicht belegt. Insbesondere
Wärme, Professionalität, kindliche Wirkung, Vertrauen, Störwirkung,
ungestützte Erinnerung und Aussprache lassen sich nicht aus Code, Screenshots
oder einer AI-Einschätzung ableiten. Die verbindlich definierte Stichprobe aus
sechs realen Personen darf deshalb nicht mit erfundenen Ergebnissen gefüllt
werden.

## Evidenz gegen die Pilotkriterien

| Kriterium | Autoritative Evidenz | Ergebnis |
| --- | --- | --- |
| Bradley ist als Hauptagent sichtbar | Selector, Starter und Rolle „Bradley · Main agent“ in der [UI-Abnahme](./bradley-ui-validation-matrix.md) | technisch bestanden; spontane Nutzererkennung noch offen |
| Bradley bleibt von Spezialagenten getrennt | Wechsel zu Email Agent behält eigenen Namen und eigenes `24 × 24`-Icon; Bradley-Starter verschwindet | technisch bestanden; Nutzerverständnis noch offen |
| Status bleibt verständlich | echter Antwortstart, sichtbarer Textstatus, `role="status"`, `aria-live="polite"`, korrigierter Frühabbruch | technisch und semantisch bestanden |
| Warm und professionell, nicht kindlich oder aufdringlich | Product-Owner-Namensentscheidung und Brand-Vertrag; keine unabhängigen Bewertungen | Zielgruppenbeleg fehlt |
| Glyph funktioniert klein | [Glyph-QA](./assets/bradley/GLYPH-QA.md) und UI-Selector-Abnahme | bestanden |
| Dark, High Contrast, Screenreader und Reduced Motion | Theme-Screenshots, Kontrast-QA, Live-Status und Browseremulation | bestanden |
| IDs, Sessions, Automationen und Prompt-Dateien bleiben stabil | [Runtime-Stabilitätsregression](./bradley-runtime-stability-regression.md) und Migrationsverträge | bestanden |
| Internationale Namenswirkung | [Sprach- und Namensvalidierung](./bradley-name-language-validation.md) als Desk-Analyse | DE-/EN-Desk-Check bestanden; reale Stichprobe fehlt |
| Markenrahmen bleibt vertretbar | [Namens- und Verfügbarkeitsprüfung](./bradley-name-availability-assessment.md) | eingebettete Nutzung freigegeben; keine isolierte „Bradley AI“-Marke |
| Marketingaussagen bleiben technisch korrekt | Kontext-, Terminologie- und Sprachverträge liegen vor | Phase F muss die konkrete Launch-Copy noch prüfen |

## Verbindliche Namensstichprobe

Die Stichprobe folgt dem in `BRADLEY-002` beschlossenen Verfahren:

- sechs Personen aus der Zielgruppe eines Self-Hosted AI Workspace;
- mindestens drei primär deutschsprachige und drei primär englischsprachige
  Personen;
- mindestens zwei Personen ohne vorherige Canvas-Notebook-Kenntnis;
- anonyme Kennung `P01` bis `P06`;
- Bradley-Selector und Starter zunächst ohne Erklärung zeigen;
- Aussprache, Rollenerkennung und freie Wirkung abfragen;
- Wärme, Professionalität und kindliche Wirkung jeweils von 1 bis 5 bewerten;
- nach fünf Minuten ungestützt nach dem Namen fragen;
- spontane Kurzform oder Verwechslung dokumentieren.

### Ergebnisprotokoll

| Person | Primärsprache | Canvas vorher bekannt | Aussprache verständlich | Rolle erkannt | Wärme 1–5 | Professionell 1–5 | Kindlich 1–5 | Nach 5 Min. erinnert | Störwirkung/Verwechslung |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P01 |  |  |  |  |  |  |  |  |  |
| P02 |  |  |  |  |  |  |  |  |  |
| P03 |  |  |  |  |  |  |  |  |  |
| P04 |  |  |  |  |  |  |  |  |  |
| P05 |  |  |  |  |  |  |  |  |  |
| P06 |  |  |  |  |  |  |  |  |  |

### Auswertung

| Kennzahl | Ziel | Ist | Status |
| --- | --- | --- | --- |
| Aussprache verständlich | mindestens 5 von 6 | ausstehend | offen |
| Rolle als Agent/Arbeitspartner erkannt | mindestens 5 von 6 | ausstehend | offen |
| Median Wärme | mindestens 4 von 5 | ausstehend | offen |
| Median Professionalität | mindestens 4 von 5 | ausstehend | offen |
| Median kindliche Wirkung | höchstens 2 von 5 | ausstehend | offen |
| Nach fünf Minuten erinnert | mindestens 5 von 6 | ausstehend | offen |
| Wiederkehrende störende Verwechslung | keine | ausstehend | offen |

## Zulässige Abschlusswege

`BRADLEY-045` kann auf genau einem der folgenden Wege abgeschlossen werden:

1. Die sechs realen Ergebnisse werden eingetragen und erfüllen die
   Abnahmekriterien.
2. Der Product Owner verwirft oder überarbeitet Bradley anhand auffälliger
   Ergebnisse und lässt die betroffenen früheren Todos erneut prüfen.
3. Der Product Owner hebt die Sechs-Personen-Stichprobe ausdrücklich auf und
   akzeptiert dokumentiert das qualitative Restrisiko bis spätestens vor einer
   großen öffentlichen Kampagne. Das ist eine bewusste Pilot-Gate-Änderung und
   darf nicht stillschweigend aus der bisherigen Namensentscheidung abgeleitet
   werden.

Bis einer dieser Wege belegt ist, bleibt `BRADLEY-045` in Arbeit und Phase F
beginnt gemäß der festgelegten Reihenfolge noch nicht.
