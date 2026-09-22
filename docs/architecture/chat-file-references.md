# Structured file references in chat

Status: implementation planned, 2026-09-22.

## Problem and intended behavior

Chat currently extracts file paths from completed assistant prose and renders an unbounded list. Speculative paths trigger existence requests and repeated negative retries. Internal image/path projection notices can appear as ordinary chat text. Saved-message refreshes can replace newer state with an older response from the same session.

The answer should stay readable. A stable, compact file section below each response should show confirmed tool outputs and distinguish created/changed files, changes awaiting review, and documents read. Reading a document does not establish that it supports an answer; these items are labelled as read documents, not citations.

## Design

- Normalize references from completed tool results using a shared, versioned contract. Include workspace identity, stable resource identity/path, tool call identity, operation and outcome. Never infer success from tool arguments alone, arbitrary tool text, or a filename mentioned in prose.
- Preserve normalized metadata in persisted tool messages and live events before generic path/image redaction. Keep authorization at file open and retain safe workspace-relative paths rather than host paths. Historical tool metadata can be adapted where sufficient information exists.
- Aggregate and deduplicate within an answer run. Prefer result files over read references to the same resource. Exclude search listings, failed operations and unrelated runs. Keep references available for interrupted runs too.
- Retain explicit Markdown file links as intentional links; remove automatic bare-path discovery from the result list. For historical answers without usable tool metadata, support explicit links conservatively.
- Display up to three result files, with an accessible expand/collapse control for the remainder. Read documents start collapsed. Large lists have a bounded, searchable view. Preserve ordering and disclosure state across refreshes.
- Keep internal persistence/transport notices out of ordinary message text. Show an appropriate attachment state only when useful. Do not remove path redaction or persist binary image payloads.
- Fence saved-history refreshes against session/workspace changes, newer requests and live updates. Share in-flight existence checks for explicit links, distinguish unavailable validation from missing files, and avoid repeated automatic missing-file polling.

## Ordered implementation

1. Save this design and review existing contracts, documentation and regression coverage.
2. Implement and verify the structured reference contract, persistence/live projection parity and display handling of internal notices.
3. Implement and verify saved-message refresh ordering and reference-validation stability.
4. Integrate run-level aggregation and compact file UI, and update the product guide and realtime contract.
5. Run focused regression tests, lint/type checks and a production build. Perform authorized Playwright checks against the current implementation. Record results and limitations here.

Each step is completed before proceeding to the next. Independent parts within a step may be delegated. Commit completed steps separately. Container builds require a separate explicit user request; use the managed local development workflow if a server is needed.

## Acceptance criteria

- Live and reloaded histories show the same confirmed references with stable keys.
- Repeated tools referencing one file produce one entry; failed tools, code examples, directory listings and other turns do not produce result cards.
- Read, created, changed and review-required outcomes remain distinct.
- Explicit links continue to work; missing or unavailable resources do not cause repeated loading cycles or misleading success states.
- No internal “omitted from … history/live event” notices leak into regular answer/tool previews.
- Delayed history responses cannot overwrite newer live messages or a different workspace/session, and loaded older history is preserved.
- Many references remain compact, keyboard accessible and usable on narrow screens.
- Existing file-change review widgets and attachment previews remain functional.

## Verification log

Pending implementation. Browser testing was explicitly authorized by the user on 2026-09-22.
