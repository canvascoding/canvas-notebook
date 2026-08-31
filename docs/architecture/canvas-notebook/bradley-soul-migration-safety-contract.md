---
title: Canvas Notebook — Bradley SOUL.md-Migrationsschutz
status: accepted
todo_id: BRADLEY-032
decision_date: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - bradley
  - migration
  - preferences
  - soul
---

# Canvas Notebook — Bradley `SOUL.md`-Migrationsschutz

## Ergebnis

Bestehende persönliche `SOUL.md`-Dateien werden nicht pauschal auf eine neue
Bradley-Vorlage gesetzt. Bradleys feste Identität liegt bereits im
produktseitigen Systemblock und benötigt deshalb keine destruktive Migration
persönlicher Präferenzen.

Eine automatische Änderung ist nur für eine bytegenau bekannte, unveränderte
Canvas-Seed-Version zulässig. Dabei darf ausschließlich die alte
Identitätszeile entfernt werden; alle Kommunikations- und
Zusammenarbeitspräferenzen bleiben in derselben Reihenfolge erhalten. Jede
andere vorhandene Datei bleibt bytegenau unverändert, bis der Nutzer selbst
eine Änderung bestätigt.

## Geltungsbereich

Der Vertrag gilt für die persönliche Hauptagent-Datei:

```text
/data/users/<userId>/agents/canvas-agent/SOUL.md
```

Er gilt nicht für:

- `USER.md`, `MEMORY.md`, `AGENTS.md` oder `TOOLS.md`;
- Spezialagenten und den E-Mail-Agenten;
- Workspace Brand Profiles;
- sichtbare Agent-Datensätze und Display-Namen aus BRADLEY-033;
- allgemeine UI-Fallbacks aus BRADLEY-034.

## Beobachteter Runtime-Stand

- `ensureAgentManagedFilesExist()` erstellt Seeds ausschließlich für fehlende
  Dateien.
- Eine vorhandene leere Datei ist ausdrücklich eine bewusste Nutzerentscheidung
  und wird nicht erneut befüllt.
- `writeManagedAgentFile()` schreibt atomar, ersetzt den übergebenen Inhalt
  jedoch vollständig.
- Das persönliche Onboarding darf derzeit nur im ausstehenden Profilschritt
  abschließen und schreibt dann die vom Nutzer erarbeiteten Inhalte.
- Der feste Bradley Identity Block hat höhere Prompt-Priorität als `SOUL.md`.
  Eine alte Identitätszeile kann Bradley daher nicht wirksam umbenennen.

Aus diesen Eigenschaften folgt: Eine breit ausgeführte inhaltliche Migration
ist weder erforderlich noch zulässig.

## Klassifikation vor jeder Migration

| Zustand | Erkennung | Automatische Aktion |
| --- | --- | --- |
| Datei fehlt | kein Pfad vorhanden | aktuellen Bradley-neutralen Seed anlegen |
| Datei ist leer | exakt 0 Byte oder vorhandener leerer Inhalt | unverändert lassen |
| bekannter unveränderter Alt-Seed | SHA-256 stimmt bytegenau mit Allowlist überein | nur alte Identitätszeile entfernen |
| persönlicher Inhalt | nicht leer und kein Allowlist-Hash | bytegenau unverändert lassen |
| nicht lesbar oder ungültig | Lese-, Größen- oder Encoding-Fehler | keine Änderung; als Fehler melden |
| bereits migriert | Versionsmarker plus erwarteter Ergebnis-Hash | keine Änderung |

Ein Textvergleich einzelner Zeilen reicht nicht zur Einstufung als Alt-Seed.
Insbesondere macht die Zeichenkette `Canvas Agent` oder `canvas-agent` eine
Datei nicht automatisch migrationsfähig.

## Allowlist der bekannten Seeds

| Version | SHA-256 | Merkmale |
| --- | --- | --- |
| ursprünglicher Seed | `8e28ff43fc6bb1c1e59ffce21a7146197d231f3f8e4ab4de4a12b976ff5cfdef` | Überschrift `# SOUL`, ohne abschließenden Zeilenumbruch |
| letzter Legacy-Seed vor Bradley | `8d8b51cc83a605bf17c4bafc7074a740d16a7daf5ae8c91402e6e03666ba5f2e` | vier Präferenzzeilen, mit abschließendem Zeilenumbruch |

Die Hashes klassifizieren nur unveränderte Projekt-Seeds. Neue Seed-Versionen
dürfen erst nach Review und Dokumentation in diese Allowlist aufgenommen
werden.

Der seit BRADLEY-035 ausgelieferte Bradley-neutrale Seed besitzt den Hash
`337ffcb2862634208b92b2e8f4a943f34326425680056ba6f350fcc2feda144d`
und enthält keine Identitätszeile. Er ist kein Migrationsziel, sondern der
Sollzustand für künftig fehlende Dateien.

## Zulässige Transformation

Bei einem Allowlist-Treffer darf genau die folgende Legacy-Zeile entfernt
werden:

```text
- Your name is canvas-agent
```

Alle übrigen Bytes werden bis auf den dadurch entfallenden Zeilenbereich
erhalten. Die Migration darf insbesondere nicht:

- Ton, Emoji-Präferenz, Interaktivität oder Reverse-Prompting neu formulieren;
- Überschriften ergänzen oder entfernen;
- Groß-/Kleinschreibung, Interpunktion oder Zeilenreihenfolge normalisieren;
- Bradley als neue Identitätszeile in `SOUL.md` eintragen;
- eine leere Datei mit Standardwerten füllen;
- Inhalte aus einer gemeinsamen Legacy-Datei ungeprüft mehreren Nutzern
  zuordnen.

## Nutzerautorisierte Änderungen

Eine persönliche, nicht allowgelistete Datei darf nur ersetzt oder
zusammengeführt werden, wenn der Nutzer die konkrete Änderung auslöst. Die
spätere Implementierung muss dabei mit dem zuvor gelesenen Inhalts-Hash
arbeiten:

1. aktuellen Inhalt und SHA-256 lesen;
2. geplante Änderung als Vorschau oder klaren Konflikt anzeigen;
3. erwarteten Hash beim Speichern mitsenden;
4. bei zwischenzeitlicher Änderung mit Konflikt abbrechen;
5. erst nach bestätigter Entscheidung atomar schreiben.

Ein allgemeiner Klick auf „Onboarding fortsetzen“, ein Login, ein App-Update
oder ein Bradley-Rollout gilt nicht als Zustimmung zum Überschreiben einer
vorhandenen persönlichen Datei.

## Recoverability und Idempotenz

Vor der ersten automatischen Seed-Bereinigung muss eine benutzergebundene,
nicht öffentlich lesbare Sicherung mit ursprünglichem SHA-256 erzeugt werden.
Ein versionierter Migrationsnachweis enthält mindestens:

- Migration `bradley-soul-v1`;
- Nutzer-ID und Agent-ID;
- Quell- und Ergebnis-Hash;
- Klassifikation;
- Zeitstempel;
- Ergebnis `changed`, `preserved`, `skipped` oder `error`.

Ein erneuter Lauf mit demselben Ergebnis-Hash ist ein No-op. Fehler dürfen
weder eine Teil-Datei noch einen fälschlich abgeschlossenen Marker
hinterlassen.

## Testmatrix für eine spätere Implementierung

| Fall | Erwartung |
| --- | --- |
| fehlende Datei | Bradley-neutraler aktueller Seed wird einmalig angelegt |
| leere Datei | bleibt leer |
| beide bekannten Alt-Seeds | nur Identitätszeile entfällt; Präferenzen bleiben |
| eine abweichende Zeile | gesamte Datei bleibt bytegenau erhalten |
| persönliche Bradley-, Canvas- oder andere Namenszeile | keine automatische Änderung |
| wiederholter Lauf | identischer Hash und kein zweites Backup |
| parallele Nutzeränderung | Konflikt, kein Schreibvorgang |
| Schreibfehler | Original und Recoverability bleiben erhalten |
| Spezial- oder E-Mail-Agent | nicht im Migrationsumfang |

## Abgrenzung der Folgearbeiten

- BRADLEY-033 migriert ausschließlich sichtbare Hauptagent-Datensätze gemäß
  [Bradley Display-Name-Migration](./bradley-display-name-migration.md) und
  verändert keine `SOUL.md`.
- BRADLEY-034 bereinigt UI-Fallbacks und Registry-Defaults.
- BRADLEY-035 hat sichtbare Alttexte inventarisiert und den Seed für künftig
  fehlende Dateien aktualisiert; vorhandene persönliche Dateien folgen
  weiterhin diesem Schutzvertrag. Nachweis:
  [Bradley sichtbare Copy](./bradley-visible-copy-inventory.md).
- BRADLEY-036 prüft Pfad-, Session-, API- und Idempotenzinvarianten.

## Abschluss BRADLEY-032

Die Migrationsgrenze ist festgelegt: Persönliche Präferenzen werden standardmäßig
bytegenau bewahrt. Nur zwei nachgewiesene, unveränderte Projekt-Seeds dürfen
automatisch und ausschließlich um die obsolete Identitätszeile bereinigt
werden. Alle anderen Änderungen benötigen eine explizite Nutzerentscheidung
mit Konfliktschutz und Recoverability.
