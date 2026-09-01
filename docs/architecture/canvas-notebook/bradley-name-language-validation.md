---
title: Canvas Notebook — Bradley Sprach- und Namensvalidierung
status: decided
todo_id: BRADLEY-002
last_updated: 2026-08-31
decision_date: 2026-08-31
supersedes: MO-002
owners:
  - Canvas Notebook
tags:
  - agent
  - brand
  - naming
  - localization
---

# Canvas Notebook — Bradley Sprach- und Namensvalidierung

## Ergebnis

**Bradley** ist als vollständiger Name des Hauptagenten für deutsche und
englische Produkttexte geeignet. Der Name wirkt persönlicher als eine
Funktionsbezeichnung, bleibt aber ausreichend professionell für einen
Self-Hosted AI Workspace.

Der Product Owner hat Bradley am 31. August 2026 verbindlich ausgewählt.
Kurzformen sind ausdrücklich nicht Teil der Marke. Eine größere
Zielnutzer-Stichprobe bleibt Bestandteil des späteren UI-Piloten
BRADLEY-045, blockiert die Konzeptarbeit aber nicht.

## Aussprache und Schreibweise

| Sprache | Empfohlene Aussprache | Orientierung |
| --- | --- | --- |
| Deutsch | ungefähr `/ˈbrɛtli/` bis `/ˈbrædli/` | zwei Silben; die etablierte englische Aussprache muss im UI nicht erklärt werden |
| Englisch (UK/US) | `/ˈbrædli/` | zwei Silben, Betonung auf der ersten Silbe |

Für sichtbare Produkttexte gilt immer `Bradley`. `Brad` wird auch dann nicht
verwendet, wenn englischsprachige Nutzer die Kurzform spontan bilden. Die
Vollform ist Teil der bewussten, ruhigen und professionellen Wirkung.

## Kontextprüfung

Die endgültigen Formulierungs-, Anrede-, Pronomen- und Zeichensetzungsregeln
sind im
[Bradley DE-/EN-Sprachleitfaden](./bradley-de-en-language-style-guide.md)
festgelegt. Die folgende frühe Kontextprüfung bleibt als Nachweis der
Namensentscheidung erhalten.

| Oberfläche | Deutsch | Englisch | Einschätzung |
| --- | --- | --- | --- |
| Agent-Auswahl | `Bradley` | `Bradley` | Eigenname ist mit Glyph und Rollenbezeichnung eindeutig. |
| Onboarding | `Das ist Bradley, dein Hauptagent in Canvas Notebook.` | `Meet Bradley, your main agent in Canvas Notebook.` | Rolle und Produktbezug sind bei der ersten Nennung klar. |
| Eingabeaufforderung | `Mit Bradley arbeiten` | `Work with Bradley` | Natürlich und handlungsorientiert. |
| Antwortstart | `Bradley bereitet die Antwort vor …` | `Bradley is preparing the answer …` | Warm, ohne den Systemzustand zu verschleiern. |
| Dateioperation | `Bradley prüft die Dateien …` | `Bradley is checking the files …` | Name und tatsächliche Aktion bleiben klar. |
| Warten auf Freigabe | `Deine Freigabe ist erforderlich.` | `Your approval is required.` | Eigenname ist unnötig; sachlicher Status hat Vorrang. |
| Fehler | `Bradley konnte diesen Schritt nicht abschließen.` | `Bradley couldn't complete this step.` | Professionell, sofern Ursache und nächste Aktion folgen. |

## Bewertung

| Kriterium | Bewertung | Begründung |
| --- | --- | --- |
| Aussprechbarkeit DE | gut | Die englische Herkunft ist erkennbar; zwei kurze Silben sind leicht reproduzierbar. |
| Aussprechbarkeit EN | sehr gut | Bradley ist ein geläufiger englischer Vor- und Familienname. |
| Merkbarkeit | gut | Menschlicher Name plus unverwechselbare gefaltete Figur. |
| Wärme | sehr gut | Nahbar, ohne eine verniedlichende Maskottchenbezeichnung zu sein. |
| Professionalität | gut bis sehr gut | Vollform wirkt gesetzter als eine Kurzform. |
| Internationale Schreibbarkeit | gut | Lateinische Standardschreibweise ohne Sonderzeichen. |
| Verwechslungsrisiko in UI | niedrig | Kein übliches deutsches oder englisches Funktionswort und keine Wochentagsabkürzung. |
| Sprachsteuerung | noch ungeprüft | Voice ist derzeit kein primärer Anwendungsfall und wird im Pilot separat betrachtet. |

## Pilot für BRADLEY-045

Die spätere Stichprobe prüft den Namen gemeinsam mit Glyph, Motion und realer
Oberfläche:

- mindestens sechs Personen aus der Zielgruppe eines Self-Hosted AI Workspace;
- mindestens drei primär deutschsprachige und drei primär englischsprachige
  Personen;
- mindestens zwei Personen ohne vorherige Canvas-Notebook-Kenntnis;
- Ergebnisse anonym als `P01` bis `P06` dokumentieren.

### Ablauf pro Person

1. Agent-Auswahl mit Bradley-Glyph und Label `Bradley` ohne Erklärung zeigen.
2. Person den Namen laut aussprechen lassen.
3. Fragen: „Was ist Bradley vermutlich?“ und „Welche Wirkung hat der Name?“
4. Onboarding- und Statusbeispiele aus der Kontextprüfung zeigen.
5. Wärme, Professionalität und kindliche Wirkung jeweils von 1 bis 5 bewerten.
6. Nach fünf Minuten ungestützt nach dem Namen des Hauptagenten fragen.
7. Prüfen, ob Personen Bradley spontan zu Brad verkürzen oder mit einer
   bestehenden Softwarefigur verwechseln.

### Abnahmekriterien

Die Namenswirkung gilt im Pilot als bestätigt, wenn:

- mindestens fünf von sechs Personen den Namen verständlich aussprechen;
- mindestens fünf von sechs Personen Bradley korrekt als Agent oder digitalen
  Arbeitspartner einordnen;
- der Median für Wärme und Professionalität jeweils mindestens 4 von 5 ist;
- der Median für „wirkt kindlich“ höchstens 2 von 5 ist;
- mindestens fünf von sechs Personen den Namen nach fünf Minuten erinnern;
- keine wiederkehrende Verwechslung Bedienung oder Markenverständnis stört.

## Ergebnisprotokoll

| Person | Sprache | Aussprache verständlich | Rolle erkannt | Wärme 1–5 | Professionell 1–5 | Kindlich 1–5 | Nach 5 Min. erinnert | Verwechslung/Kommentar |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P01 |  |  |  |  |  |  |  |  |
| P02 |  |  |  |  |  |  |  |  |
| P03 |  |  |  |  |  |  |  |  |
| P04 |  |  |  |  |  |  |  |  |
| P05 |  |  |  |  |  |  |  |  |
| P06 |  |  |  |  |  |  |  |  |

## Abschluss BRADLEY-002

BRADLEY-002 ist mit der Desk-Validierung und Product-Owner-Entscheidung
abgeschlossen. Ein auffälliges Ergebnis in BRADLEY-045 öffnet BRADLEY-001 und
BRADLEY-002 mit dokumentierter Begründung erneut; es führt nicht zu einer
stillen Kurzform oder Umbenennung.
