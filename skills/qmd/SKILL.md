---
name: qmd
description: Searches markdown notes and documents in the workspace using qmd. Automatically indexes all .md files in /data/workspace. Use when user asks for "search my notes", "find related documents", "search in my workspace". Prefer qmd search (fast keyword search) over vsearch (semantic, slower).
---

# Markdown Search (qmd)

Local hybrid search for markdown notes and documents in the Canvas Notebook Workspace. Index once, search fast.

## When to Use

Use this skill when the user requests:
- "Search my notes"
- "Find related documents"
- "Search my markdown files"
- "Search for ... in my workspace"

## Default Behavior

- Prefer `qmd search` (BM25) - typically available immediately
- Use `qmd vsearch` only if keyword search fails and semantic similarity is needed (can be very slow on cold start)
- Avoid `qmd query` unless user explicitly wants best hybrid quality and can tolerate long runtimes

## Parameters

- **query** (required): Search query
- **mode**: Search mode (search, vsearch, query). Default: search
- **collection**: Collection to search. Default: workspace
- **limit**: Maximum number of results. Default: 10

## Search Modes

- `qmd search` (default): Fast keyword search (BM25)
- `qmd vsearch` (last resort): Semantic similarity (vector). Often slow due to local LLM before lookup.
- `qmd query` (mostly skip): Hybrid search + LLM reranking. Often slower than vsearch.

## Examples

Standard search:
```
qmd search "my search term"
```

Specific collection:
```
qmd search "search term" -c workspace
```

More results:
```
qmd search "search term" -n 10
```

JSON output for agents:
```
qmd search "search term" --json
```

Semantic search (slower):
```
qmd vsearch "conceptually similar content"
```

## Requirements

- Bun >= 1.0.0 (automatically installed)
- SQLite3 (available in container)
