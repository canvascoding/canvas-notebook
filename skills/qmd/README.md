# Markdown Search Skill (qmd)

Lokale hybride Suche für Markdown-Notizen und Dokumente im Canvas Notebook Workspace. Indexiere einmal, suche schnell.

## Wann zu verwenden (Trigger-Phrasen)

- "suche in meinen Notizen / Dokumenten"
- "finde verwandte Notizen"
- "durchsuche meine Markdown-Dateien"
- "suche nach ... in meinem Workspace"

## Standard-Verhalten (wichtig)

- Bevorzuge `qmd search` (BM25) - ist typischerweise sofort verfügbar
- Nutze `qmd vsearch` nur wenn die Keyword-Suche fehlschlägt und semantische Ähnlichkeit benötigt wird (kann bei kaltem Start sehr langsam sein)
- Vermeide `qmd query` außer der User will explizit die beste hybride Qualität und kann lange Laufzeiten tolerieren

## Voraussetzungen

- Bun >= 1.0.0 (wird automatisch installiert)
- SQLite3 (im Container verfügbar)

## Collection

Der Workspace `/data/workspace` ist automatisch als Collection "workspace" eingerichtet:

```bash
qmd collection add /data/workspace --name workspace --mask "**/*.md"
qmd context add qmd://workspace "Canvas Notebook Workspace - alle Markdown-Dateien"
qmd embed  # Einmalig für Vektor-Suche
```

## Such-Modi

- `qmd search` (Standard): Schnelle Keyword-Suche (BM25)
- `qmd vsearch` (letzter Ausweg): Semantische Ähnlichkeit (Vektor). Oft langsam wegen lokalem LLM vor dem Lookup.
- `qmd query` (meist überspringen): Hybride Suche + LLM Reranking. Oft langsamer als `vsearch`.

## Performance-Hinweise

- `qmd search` ist typischerweise sofort verfügbar
- `qmd vsearch` kann ~1 Minute dauern weil Query-Expansion ein lokales Modell laden kann
- `qmd query` fügt LLM Reranking hinzu, daher noch langsamer

## Verwendung

```bash
# Standard-Suche
qmd search "mein Suchbegriff"

# Spezifische Collection
qmd search "Suchbegriff" -c workspace

# Mehr Ergebnisse
qmd search "Suchbegriff" -n 10

# JSON Output für Agenten
qmd search "Suchbegriff" --json

# Alle Treffer über Threshold
qmd search "Suchbegriff" --all --min-score 0.3

# Semantische Suche (langsamer)
qmd vsearch "konzeptionell ähnliche Inhalte"

# Dokument abrufen
qmd get "pfad/zur/datei.md"
qmd get "#docid"  # Aus Suchergebnissen

# Mehrere Dokumente
qmd multi-get "datei1.md, datei2.md" --json
```

## Wartung

```bash
qmd status              # Index-Status
qmd update              # Re-index geänderter Dateien
qmd embed               # Embeddings aktualisieren
```

## Index aktuell halten

Für Keyword-Suche (`qmd search`) reicht `qmd update` (schnell).
Für semantische Suche auch `qmd embed` ausführen (langsamer).

## Modelle und Cache

- Nutzt lokale GGUF Modelle; wird beim ersten Run automatisch heruntergeladen
- Standard-Cache: `~/.cache/qmd/models/`

## Unterschied zu Agent Memory

- `qmd` durchsucht **deine lokalen Dateien** (Notizen/Dokumente) die du explizit indexierst
- Agent Memory (`memory_search`) durchsucht **gespeicherte Fakten/Kontext** aus vorherigen Interaktionen
- Beides nutzen: `memory_search` für "was haben wir vorher besprochen?", `qmd` für "was steht in meinen Notizen?"

## Weitere Informationen

- Homepage: https://github.com/tobi/qmd
- Collection: `workspace` (pflegt `/data/workspace/**/*.md`)
