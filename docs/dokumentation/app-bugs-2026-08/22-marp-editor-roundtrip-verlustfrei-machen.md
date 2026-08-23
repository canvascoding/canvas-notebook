---
title: 'Ticket 22: MARP-YAML und Formatierung beim Editorwechsel erhalten'
status: in_progress
priority: high
depends_on: []
platforms: [web]
tags: [type/bug, topic/marp, topic/editor, topic/frontmatter]
---

# Ticket 22: MARP-YAML und Formatierung beim Editorwechsel erhalten

## Problem

Die MARP-Vorschau der Next.js-App rendert grundsaetzlich korrekt. Beim Wechsel
zum TipTap-Editor gehen jedoch Teile des YAML Front Matter verloren; beim
weiteren Wechsel zur Source-Ansicht koennen zusaetzliche Markdown-
Formatierungen veraendert werden. Der Editorwechsel ist damit nicht verlustfrei.

## Zielzustand

- Wechsel zwischen Preview, TipTap und Source veraendert eine Datei ohne
  Nutzeredit weder semantisch noch byteweise ausserhalb dokumentierter,
  akzeptierter Normalisierung.
- Vollstaendiges YAML Front Matter einschliesslich unbekannter MARP-Felder,
  Reihenfolge, Arrays und mehrzeiliger Werte bleibt erhalten.
- Nicht verlustfrei darstellbare Markdown-/MARP-Konstrukte werden nicht still
  umgeschrieben; die UI warnt oder verwendet einen sicheren Source-Modus.
- Speichern ist atomar und erlaubt bei Konflikten keine stille Ueberschreibung.

## Umsetzung

Der codebestandsnahe, strikt sequenzielle Plan liegt in
[22-marp-editor-roundtrip-umsetzungsplan.md](./22-marp-editor-roundtrip-umsetzungsplan.md).

## Aktueller Umsetzungsstand (2026-08-21)

Die Preservation-, Revision- und atomaren Write-Aenderungen sind in `main`
integriert. Die im Plan geforderte manuelle Moduswechsel-Abnahme sowie das
abschliessende Build-Gate sind noch als Abnahme nachzuholen; deshalb ist das
Ticket in Abnahme und nicht erledigt.

## Reproduzierter Abnahmefehler (2026-08-23)

Der Roundtrip ist weiterhin nicht verlustfrei: Beim Wechsel zwischen
Markdown-/Source- und MARP-/Rich-Ansicht wird das YAML Front Matter veraendert.
Zusaetzlich besteht der konkrete Verdacht, dass beim Moduswechsel nicht der
aktuellste Datei- bzw. Revisionsstand verwendet wird, sondern ein aelterer
Source-, Draft-, Collaboration- oder Revision-Guard-Snapshot zurueckgeschrieben
wird. Das Ticket ist daher wieder in Umsetzung. Die Ursache muss mit
Datei-SHA, Revision, Moduswechselreihenfolge, Dirty-State und gespeicherten
Snapshots eindeutig reproduziert werden; keine Normalisierung oder Migration
darf diesen Befund verdecken.

- Roundtrip-Fixtures fuer MARP-Front-Matter, Kommentare, unbekannte Felder,
  Direktiven, Folientrenner, HTML, Code, Tabellen und Whitespace erstellen.
- Datenfluss in `MarkdownEditor`, Markdown-/TipTap-Serialisierung,
  Obsidian-Metadaten und MARP-Erkennung bis zum Speichern inventarisieren.
- Front Matter als verlustfrei erhaltenen Dokumentbereich vom Rich-Text-Body
  trennen oder einen Parser/Serializer mit Preservation-Semantik verwenden.
- Vor Moduswechsel Dirty-State und nicht unterstuetzte Nodes erkennen; niemals
  allein durch Ansichtwechsel speichern oder normalisieren.
- Revision/Dateikonflikt, Undo und Wiederherstellung nach fehlgeschlagener
  Konvertierung absichern.

## Abnahmekriterien

- Preview -> TipTap -> Source -> Preview ohne Bearbeitung ergibt fuer alle
  Referenzdateien keinen unerwarteten Diff.
- Alle YAML-Felder und MARP-Direktiven bleiben nach erlaubten Body-Aenderungen
  erhalten.
- Unsupported Content erzeugt eine klare Warnung und bleibt im Source erhalten.
- Wiederholtes Umschalten akkumuliert keine Formatierungs- oder Whitespace-
  Aenderungen.
- Ein Moduswechsel verwendet immer die aktuellste autoritative Datei-/Draft-
  Revision; kein aelterer Source-, Collaboration- oder Autosave-Snapshot darf
  Front Matter oder Body zuruecksetzen.

## Tests und Abschluss

- Bestehende MARP-Preview-/Editor-, Front-Matter-Export- und TipTap-Roundtrip-
  Tests mit realistischen Fixtures erweitern.
- `npm run build` und manuelle Moduswechsel-Abnahme; Browser-/E2E-Test nur nach
  expliziter Freigabe.
- Eigener Commit, danach Status im [Index](./README.md) aktualisieren.
