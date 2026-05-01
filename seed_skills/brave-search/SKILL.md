---
name: brave-search
description: "Web search and page content extraction via Brave Search API. Use for searching documentation, facts, current events, code examples, or any web content. Lightweight, no browser required. Triggers: web search, search the internet, look up, find online, Google it, research, what is the latest, news, documentation lookup. Requires BRAVE_API_KEY in Canvas Integrations settings."
compatibility: Requires BRAVE_API_KEY in /data/secrets/Canvas-Integrations.env
allowed-tools: Bash(brave-search:*) Bash(brave-content:*)
metadata:
  version: "1.0"
  author: canvas-studios
---

# Brave Search

Web search and content extraction using the official Brave Search API. No browser required.

## When to Use

- Searching for documentation or API references
- Looking up facts or current information
- Fetching content from specific URLs
- Any task requiring web search without interactive browsing

## Commands

**Search the web:**
```bash
brave-search "query"                                       # 5 results (default)
brave-search "query" -n 10                                 # More results (max 20)
brave-search "query" --content                             # Include page content as markdown
brave-search "query" --freshness pw                        # Results from last week
brave-search "query" --freshness 2024-01-01to2024-06-30   # Date range
brave-search "query" --country DE                          # Results from Germany
brave-search "query" -n 3 --content                        # Combined options
```

**Extract page content:**
```bash
brave-content https://example.com/article
```
Fetches a URL and returns the readable content as markdown.

## Options

- `-n <num>` — Number of results (default: 5, max: 20)
- `--content` — Fetch and include page content as markdown
- `--country <code>` — Two-letter country code (default: US)
- `--freshness <period>` — Filter by time: `pd` (day), `pw` (week), `pm` (month), `py` (year), or `YYYY-MM-DDtoYYYY-MM-DD`

## Output Format

```
--- Result 1 ---
Title: Page Title
Link: https://example.com/page
Age: 2 days ago
Snippet: Description from search results
Content: (if --content flag used)
  Markdown content extracted from the page...

--- Result 2 ---
...
```

## Requirements

- `BRAVE_API_KEY` must be set in Canvas Notebook under Settings → Integrations
- Canvas stores that key centrally in `/data/secrets/Canvas-Integrations.env`
- New skills that need API keys must also use `/data/secrets/Canvas-Integrations.env` rather than ad-hoc config files
- Get a free API key at https://api-dashboard.search.brave.com/ (free tier available, credit card required for signup)
