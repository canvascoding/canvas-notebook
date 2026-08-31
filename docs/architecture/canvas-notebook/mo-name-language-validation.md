---
title: Canvas Notebook — Mo Sprach- und Namensvalidierung
status: decided
todo_id: MO-002
last_updated: 2026-08-31
decision_date: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - brand
  - naming
  - localization
---

# Canvas Notebook — Mo Sprach- und Namensvalidierung

## Ziel

MO-002 prüft, ob **Mo** im Deutschen und Englischen eindeutig aussprechbar,
verständlich, merkbar sowie warm und professionell genug für den
Canvas-Notebook-Hauptagenten ist.

Die dokumentierte Desk-Validierung ist abgeschlossen und wurde am 31. August
2026 vom Product Owner freigegeben. MO-002 ist damit abgeschlossen. Eine
größere mehrsprachige Stichprobe bleibt sinnvoll, wird aber als Teil der
Pilot-Auswertung MO-045 durchgeführt und blockiert die folgenden Konzeptphasen
nicht.

## Vorgesehene Aussprache

| Sprache | Produktaussprache | Erklärung für Tests |
| --- | --- | --- |
| Deutsch | `/moː/` | eine Silbe, langes „o“, ungefähr wie „Mohn“ ohne `n` |
| Englisch (UK) | `/məʊ/` | eine Silbe, Reim auf „go“ in britischer Aussprache |
| Englisch (US) | `/moʊ/` | eine Silbe, Reim auf „go“ in amerikanischer Aussprache |

Die Aussprache wird im normalen UI nicht phonetisch erklärt. Das Onboarding
kann sie nur dann beiläufig aufgreifen, wenn die Nutzerprüfung wiederkehrende
Unsicherheit zeigt.

## Sprachliche Nebenbedeutungen

### Deutsch

Der Duden führt `Mo.` als Abkürzung für Montag. Dadurch kann ein isoliertes
`Mo` in Kalendern oder Wochentagslisten zunächst wie eine Tagesabkürzung
wirken. In Agent-Auswahl, Chat-Header oder vollständigen Statussätzen ist der
Kontext ausreichend verschieden.

Quelle: [Duden — Montag](https://www.duden.de/rechtschreibung/Montag)

### Englisch

Oxford führt `mo` im britischen informellen Englisch als Kurzform von
`moment`, typischerweise in Konstruktionen wie `in a mo`. Als großgeschriebener
Eigenname in `Ask Mo` oder `Mo is preparing the answer` ist die grammatische
Rolle klar anders. Die englische Produktaussprache folgt dem langen
`o`-Laut, den Cambridge für den Anfang von `moment` als UK `/məʊ/` und US
`/moʊ/` dokumentiert.

Quellen:

- [Oxford Learner's Dictionaries — mo](https://www.oxfordlearnersdictionaries.com/us/definition/english/mo_1)
- [Cambridge Dictionary — pronunciation of moment](https://dictionary.cambridge.org/pronunciation/english/moment)

### Abgrenzung zu MO-003

Generische Verwendung, Suchmaschinen-Eindeutigkeit, Domains und mögliche
Markenrechte sind keine sprachlichen Abnahmekriterien. Diese Risiken werden
separat in MO-003 geprüft.

## Kontextprüfung

| Oberfläche | Deutsch | Englisch | Einschätzung |
| --- | --- | --- | --- |
| Agent-Auswahl | `Mo` | `Mo` | Mit Glyph und Rollenbezeichnung eindeutig. |
| Onboarding | `Das ist Mo, dein Hauptagent in Canvas Notebook.` | `Meet Mo, your main agent in Canvas Notebook.` | Rolle wird bei der ersten Nennung explizit. |
| Eingabeaufforderung | `Mit Mo arbeiten` | `Work with Mo` | Kurz und handlungsorientiert. |
| Antwortstart | `Mo bereitet die Antwort vor …` | `Mo is preparing the answer …` | Natürlich; keine problematische Nebenbedeutung. |
| Dateioperation | `Mo prüft die Dateien …` | `Mo is checking the files …` | Name und tatsächliche Aktion bleiben klar. |
| Warten auf Freigabe | `Deine Freigabe ist erforderlich.` | `Your approval is required.` | Eigenname ist unnötig; sachlicher Status hat Vorrang. |
| Fehler | `Mo konnte diesen Schritt nicht abschließen.` | `Mo couldn't complete this step.` | Professionell, sofern Ursache und nächste Aktion folgen. |
| Kalenderansicht | nicht isoliert als einziges Label verwenden | keine besondere Einschränkung | Deutsch benötigt Agent-Glyph oder Rollenbezug, um `Mo` von Montag zu trennen. |

## Bewertung

| Kriterium | Bewertung | Begründung |
| --- | --- | --- |
| Aussprechbarkeit DE | gut | Eine Silbe und im Deutschen problemlos artikulierbar. |
| Aussprechbarkeit EN | gut | Regulärer englischer Lang-o-Laut; Schreibweise `Moe` wäre phonetisch expliziter, widerspricht aber dem beschlossenen Namen. |
| Merkbarkeit | sehr gut | Zwei Buchstaben und starke Verbindung zum Glyph. |
| Wärme | gut | Wirkt eher wie ein kurzer Name als wie eine technische Funktionsbezeichnung. |
| Professionalität | gut mit Copy-Regeln | Die Kürze kann informell wirken; sachliche Status- und Fehlersprache stabilisiert den Ton. |
| DE-Verwechslung | niedrig bis mittel | `Mo.` bedeutet Montag, vor allem in kalendernahen Oberflächen. |
| EN-Verwechslung | niedrig | Britisch `mo` = Moment tritt üblicherweise mit Artikel oder Präposition auf. |
| Sprachsteuerung | noch ungeprüft | Kurze Namen können akustisch leichter falsch erkannt werden; Voice ist derzeit kein primärer Anwendungsfall. |

### Entscheidung

Aus sprachlicher Sicht gibt es keinen Grund, den Namensvertrag zu öffnen. Die
Empfehlung bleibt **Mo**.

Der Product Owner hat die dokumentierte Aussprache, Kontextprüfung,
Nebenbedeutungen und Risikoeinschätzung am 31. August 2026 mit „Ja, das ist
gut“ freigegeben. Diese Freigabe ist die verbindliche MO-002-Entscheidung.

## Pilot-Zielnutzer-Test für MO-045

Die folgende größere Stichprobe bleibt als Produktvalidierung erhalten. Sie
prüft die Namenswirkung gemeinsam mit Glyph, Motion und realer Oberfläche im
UI-Pilot, statt die weitere Konzeptarbeit vorab zu blockieren.

### Stichprobe

- mindestens sechs Personen aus der Zielgruppe eines self-hosted AI Workspace;
- mindestens drei primär deutschsprachige und drei primär englischsprachige
  Personen;
- mindestens zwei Personen, die Canvas Notebook vorher nicht kennen;
- Ergebnisse anonym als `P01` bis `P06` dokumentieren.

Die Product-Owner-Freigabe ist bereits dokumentiert. Die Pilot-Stichprobe soll
darüber hinaus unabhängige Reaktionen aus der Zielgruppe erfassen.

### Ablauf pro Person

1. Ohne Erklärung Agent-Auswahl mit Mo-Glyph und dem Label `Mo` zeigen.
2. Person den Namen laut aussprechen lassen.
3. Fragen: „Was ist Mo vermutlich?“ und „Welche Wirkung hat der Name?“
4. Onboarding- und Statusbeispiele aus der Kontextprüfung zeigen.
5. Wärme, Professionalität und kindliche Wirkung jeweils von 1 bis 5 bewerten
   lassen.
6. Nach fünf Minuten ungestützt nach dem Namen des Hauptagenten fragen.
7. Offene Verwechslungen mit Montag, Moment, `no`, `more` oder anderen Namen
   protokollieren.

### Pilot-Auswertungskriterien

Die Namenswirkung gilt im Rahmen von MO-045 als bestätigt, wenn:

- mindestens fünf von sechs Personen den Namen ohne Korrektur als eine Silbe
  mit langem `o` aussprechen;
- mindestens fünf von sechs Personen Mo korrekt als Agent oder digitalen
  Arbeitspartner einordnen;
- der Median für Wärme und Professionalität jeweils mindestens 4 von 5 ist;
- der Median für „wirkt kindlich“ höchstens 2 von 5 ist;
- mindestens fünf von sechs Personen den Namen nach fünf Minuten erinnern;
- keine wiederkehrende Verwechslung die Bedienung oder das Markenverständnis
  beeinträchtigt.

## Pilot-Ergebnisprotokoll

| Person | Sprache | Aussprache korrekt | Rolle erkannt | Wärme 1–5 | Professionell 1–5 | Kindlich 1–5 | Nach 5 Min. erinnert | Verwechslung/Kommentar |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P01 |  |  |  |  |  |  |  |  |
| P02 |  |  |  |  |  |  |  |  |
| P03 |  |  |  |  |  |  |  |  |
| P04 |  |  |  |  |  |  |  |  |
| P05 |  |  |  |  |  |  |  |  |
| P06 |  |  |  |  |  |  |  |  |

## MO-002-Abschluss und Pilot-Follow-up

MO-002 ist mit der dokumentierten Desk-Validierung und Product-Owner-Freigabe
abgeschlossen. Nach dem späteren Eintragen der sechs Pilot-Ergebnisse werden
Kennzahlen und Freitextbefunde in MO-045 zusammengefasst. Bei bestandenen
Kriterien bleibt der Namensvertrag unverändert. Bei einem auffälligen Ergebnis
wird nicht direkt umbenannt, sondern MO-001 und MO-002 mit dokumentierter
Begründung erneut geöffnet.
