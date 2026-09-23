# Structured file references in chat

Status: implemented and verified, 2026-09-22.

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

Browser testing was explicitly authorized by the user on 2026-09-22.

- Steps 1–3 completed in separate commits. Structured receipts survive a 35-file large-output roundtrip; projection, metadata-only hydration and internal-notice tests pass.
- Delayed history requests, coalesced refresh notifications, same-tick live updates, workspace/session changes, older-history retention and unmount cancellation are covered by deterministic hook tests. During integration with current `main`, its newer snapshot-aware `reconcileChatMessages` and pagination handling were retained, including auth-scoped cache invalidation and the separate loading state. The redundant merge helper was removed; reference metadata remains part of message equivalence so metadata-only hydration is preserved.
- File validation shares slow in-flight requests, keeps errors distinct from missing files and revalidates on file events instead of timers. Existing watcher, reveal and file-open tests pass.
- Step 4 uses the existing user-message segment boundary rather than adding a new runtime `runId` or database table. Receipts are durable in tool messages; the list is a deterministic display projection. Opening files still goes through the existing authorized workspace flow.
- The bounded searchable view is inline. Disclosure/search state lives above message wrappers, scoped by workspace/session and the run's last tool call, so persisted message IDs and loading older history do not reset it. Search includes result files beyond the collapsed preview. Historical proposals are labelled “Change proposed”; the existing review widget remains authoritative for current review status.
- Reference metadata is capped at 500 entries per tool (2,048 characters per path), with an explicit omitted count. Studio files outside the workspace retain their media previews. Historical relative tool paths are adapted conservatively; unsupported or lost old metadata is not guessed.
- After rebasing onto `main` at `ed60b12d8`, `npm run test:chat:file-references` passes all ten scripts covering contract, projection, validation, reconciliation, bootstrap, cache scope, hook races, aggregation and components. Scoped ESLint passes. Metadata-only receipt hydration is explicitly tested through the retained main history hook.
- Four authorized Playwright cases pass on the managed host development server: desktop/mobile compact lists with search, disclosure, live-to-saved hydration and full page reload; existing file-write Markdown/diff widgets; existing grouped clickable image-read previews. Screenshots were visually reviewed. Runtime events/history were deterministic fixtures; this does not claim a live model/provider integration test.
- All four browser cases pass again on the integrated revision, with fixtures covering the new session bootstrap endpoint used by current `main` for reloading history.
- Desktop/mobile checks also verify actual wheel scrolling reaches the last read document above the floating composer, with hit testing proving the row is unobscured. The browser's native `scrollIntoView` alone does not account for that overlay.
- Initial browser testing reproduced a race involving a pending loading placeholder and deferred no-op updates. Current `main` supersedes that implementation with separate loading state and snapshot reconciliation; the integrated tests check its externally visible guarantees rather than restoring the obsolete placeholder workaround.
- `npm run build` passes again after integration, including license checks, optimized compilation, TypeScript and page generation. The build has the local base URL configured; remaining warnings concern Node's experimental localStorage. The authenticated browser tests use the managed runtime environment. No container was built or deployment performed.
