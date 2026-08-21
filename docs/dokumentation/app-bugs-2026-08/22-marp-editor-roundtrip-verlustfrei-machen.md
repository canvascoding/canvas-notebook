---
title: 'Ticket 22: MARP-YAML und Formatierung beim Editorwechsel erhalten'
status: open
priority: high
depends_on: ['21-marp-mobile-rendering-korrigieren']
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

## Tests und Abschluss

- Bestehende MARP-Preview-/Editor-, Front-Matter-Export- und TipTap-Roundtrip-
  Tests mit realistischen Fixtures erweitern.
- `npm run build` und manuelle Moduswechsel-Abnahme; Browser-/E2E-Test nur nach
  expliziter Freigabe.
- Eigener Commit, danach Status im [Index](./README.md) aktualisieren.
