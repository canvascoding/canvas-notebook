---
title: Canvas Notebook — Bradley Onboarding-Implementierung
status: implemented
todo_id: BRADLEY-031
decision_date: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - bradley
  - onboarding
  - identity
  - preferences
---

# Canvas Notebook — Bradley Onboarding-Implementierung

## Ergebnis

Das persönliche Onboarding stellt Bradley auf Deutsch und Englisch als festen
Hauptagenten von Canvas Notebook vor. Der Nutzer konfiguriert dabei nicht
Bradleys Namen oder Rolle, sondern die persönliche Zusammenarbeit: Anrede,
Formalität, Detailgrad, technisches Niveau, Initiative, Rückfragen, Ton und
dauerhafte Grenzen.

Diese Trennung gilt auch beim Überspringen: Der Nutzer verschiebt nur seine
persönlichen Präferenzen. Bradley bleibt unabhängig davon die sichtbare
Produktidentität des Hauptagenten.

## Onboarding-Ablauf

1. Nach dem persönlichen Workspace führt die Oberfläche mit „Weiter zu
   Bradley“ beziehungsweise „Continue to Bradley“ in den Profilschritt.
2. Bradley stellt sich mit festem Namen und fester Hauptagentenrolle vor.
3. Bradley erklärt, welche Aspekte der Zusammenarbeit anpassbar sind.
4. Mindestens eine echte Nutzerantwort ist erforderlich, bevor das Profil-Tool
   ausgeführt werden darf.
5. `USER.md` speichert dauerhafte Fakten, Ziele und wiederkehrenden Kontext.
6. `SOUL.md` speichert ausschließlich Kommunikations- und
   Zusammenarbeitspräferenzen.
7. Der Nutzer kann die Präferenzen auf später verschieben, ohne Bradleys
   Identität zu verändern.

## Feste und persönliche Ebene

| Fest durch Canvas Notebook | Persönlich konfigurierbar |
| --- | --- |
| Name `Bradley` | Anrede und Formalität |
| Rolle als Hauptagent | Antwortlänge und technisches Niveau |
| korrekte Akteursattribution | proaktives Handeln oder mehr Rückfragen |
| Sicherheits- und Freigabegrenzen | Review-Gewohnheiten |
| sachliche Fehlerkommunikation | Ton, Humor und Emojis |
| keine Behauptung menschlichen Bewusstseins | zusätzliche persönliche Grenzen |

`SOUL.md` darf deshalb weder Bradleys Identität definieren noch einen
alternativen Agentennamen speichern. Der feste Identity Block aus
BRADLEY-030 hat unabhängig davon höhere Prompt-Priorität.

## Implementierte Bausteine

| Datei | Verantwortung |
| --- | --- |
| `messages/de.json` | deutsche Bradley-Einführung, Präferenz- und Tourtexte |
| `messages/en.json` | englische Bradley-Einführung, Präferenz- und Tourtexte |
| `app/lib/onboarding/profile.ts` | fester Sessiontitel und zweisprachige Bradley-Begrüßung |
| `seed_sys_prompts/BOOTSTRAP.md` | Fragenkatalog und klare Trennung zwischen Nutzerkontext und Zusammenarbeit |
| `app/lib/pi/scoped-tools.ts` | Tool-Vertrag für `USER.md` und identitätsfreie `SOUL.md`-Präferenzen |
| `scripts/onboarding-profile-test.ts` | Regressionstest für Name, Rolle, Sprache und gespeicherte Präferenzen |

## Schutz und Abgrenzung

- Das Onboarding überschreibt keine bestehenden Profile außerhalb des
  bestehenden Erststart-Ablaufs.
- Bestehende persönliche `SOUL.md`-Inhalte werden in BRADLEY-031 weder
  migriert noch neu geschrieben.
- Der Schutz und die Migrationsregel für vorhandene `SOUL.md`-Dateien ist
  ausschließlich Gegenstand von BRADLEY-032.
- Die interne ID `canvas-agent`, Speicherpfade, Session-Zuordnung und APIs
  bleiben unverändert.
- Spezialagenten und E-Mail-Agenten werden nicht als Bradley vorgestellt.

## Verifikation

Der automatisierte Onboarding-Test prüft:

- den Sessiontitel `Bradley Onboarding`;
- die deutsche Vorstellung als `Hauptagent`;
- die englische Vorstellung als `main agent`;
- den Hinweis, dass Name und Rolle fest bleiben;
- Bradley im tatsächlich gespeicherten Begrüßungstext;
- getrennte Speicherung von Nutzerfakten und Zusammenarbeit;
- dass die Test-`SOUL.md` keine alte `Canvas Agent`-Identität enthält;
- das unveränderte Überspringen und die Nutzertrennung.

Eine visuelle Browserprüfung bleibt gemäß Repository-Regel bis zu einer
ausdrücklichen Playwright-/Browser-Freigabe ausstehend und gehört zur
gebündelten UI-Abnahme BRADLEY-044.

## Abschluss BRADLEY-031

Neue Nutzer lernen Bradley als feste Produktidentität kennen und können die
persönliche Zusammenarbeit konfigurieren oder auf später verschieben. Das
Onboarding schreibt keine alternative Agentenidentität in `SOUL.md` und greift
der Bestandsmigration aus BRADLEY-032 nicht vor.
