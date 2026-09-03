# Editor stability implementation

Implementation branch: `codex/editor-stability`, server base `32238cfc`, mobile base `00e6c91`.

## Sequential milestones

- [x] A: Empty quotes and complete original EOF suffix; Markdown, Yjs, edit/undo/reopen regression coverage in both clients.
- [x] B: Versioned shared parser rules and fixture parity; syntax-aware table/list normalization and structural validation.
- [x] C: Read/edit/source modes backed by the current live document; distinct connection, durability and file-checkpoint status; safe recovery actions.
- [x] D1: Contextual selection formatting.
- [x] D2: Contextual table operations.
- [x] D3: Portable image sizing/alignment with resize controls and renderer parity.
- [x] D4: Link/preview/embed paste choices using existing provider support.
- [x] D5: Document width and focus behavior where missing.

Each milestone is verified and committed before the next. Production deployment is a separate manual action. Private production notes are never test fixtures in this public repository.

## A: compatibility and acceptance

`bodyFinalLineEnding` retains its existing Y.Text key and now stores the complete original newline suffix. Existing empty or single-newline values remain valid. Roll out the server and web codec together; older server binaries would truncate a multi-newline suffix and must not concurrently materialize these documents. Opening a file does not rewrite it or migrate an active plain-text session.

The blockquote retains its existing node name, attributes, commands and Markdown syntax. Empty input gains only the schema-required empty paragraph, without placeholder content in Markdown.

Acceptance inventory: slash quote insertion and checkpoint while empty; typing/deletion; undo/redo; reload; nested quote and quote between siblings; exact LF/CRLF/absent/multiple EOF suffix; Yjs binary reopen; agent-style replacement; existing blank-table/callout regressions. Browser evidence records the empty saved and reopened states. Device gestures and native builds are tracked separately from browser or DOM tests.

Validation: server TypeScript and focused ESLint; rich-block, preservation and collaboration-hardening suites; Chromium slash/empty checkpoint/typing/deletion/undo/redo/reload against the managed PostgreSQL stack. Mobile `npm run verify` passed, including editor DOM tests, Expo Doctor and exports for iOS, Android and Web. No new native binary or real-device gesture signoff in this milestone.

## B: shared conversion contract

The server owns `app/lib/markdown/core`; mobile ships its generated, versioned copy with hash and parser-version checks. Both use TipTap 3.31.0 and the exact Marked 18.0.3 alias; unrelated mobile Markdown rendering retains its existing Marked dependency. Lists use GFM indentation while existing alphabetic lists remain supported. Tables preserve escaped pipes, code spacing, alignment, empty cells, hard breaks and separate paragraphs. Entity decoding is confined to prose. Validation now checks schema and document structure as well as stable IDs and serialization stability.

Empty headings, list items, quotes, tasks, code, callouts, details and footnotes retain their structure. Empty list paragraphs use the same portable `&nbsp;` whitespace convention as blank paragraphs, without placeholder words; callouts and footnotes no longer acquire invented titles/content during parsing. Ten empty states, thirteen shared source fixtures and six negative semantic-change cases cover both clients. Existing notes are not rewritten or migrated on opening.

Server validation: TypeScript, focused ESLint, rich-block/preservation/hardening suites, PostgreSQL agent-operation integration, and Chromium mobile-API → web edit → file checkpoint → reopen. The slash quote browser regression also passes. New attributes that cannot roundtrip remain rejected. Deploy the matching codec in server/web/mobile together; older clients must not edit newly introduced structural encodings until upgraded.

Mobile B validation: full `npm run verify` passed, including both shared fixture/empty-state DOM checks, existing editor commands, license inventory, Expo Doctor and iOS/Android/Web exports. Automatic footnote cleanup now preserves pre-existing orphan definitions and authoritative imports. No native build or real-device signoff is implied by these checks.

## C: views, durability and migration

Web offers Read, Edit and Source. Read observes the live Y.Doc directly; source-only notes are formatted without rewriting their Markdown. Rich live source is deliberately read-only and uses an unbound source viewer; edits stay in the existing rich document. Plain-text live source remains collaboratively editable. Migration is now an explicit, write-authorized request with a lifecycle generation, confirmed checkpoint and an empty room. Simply opening or reading does not migrate existing notes. The room inspector and pending admissions now share a process registry across Next's route bundle and the custom WebSocket server. A resident room counts as occupied until its pending storage/unload completes, preventing a new client from joining the previous representation.

Connection and durability have separate labels. Validation failures keep the editor protected until an exact successful checkpoint confirms recovery; reconnecting alone cannot clear them. Error UI offers Markdown and full Yjs recovery downloads plus selectable technical details. Retry is reserved for recoverable checkpoint failures. A two-browser test proves live reading, preservation on opening, blocked concurrent migration, successful quiescent migration, readable rich source, and backup/reading after an injected validation failure. Server type/lint, lifecycle reducer, hardening and PostgreSQL agent-operation integration checks pass.

Mobile retains its editor and live connection while switching to Read or a read-only rich Source view. Plain-text live notes default to formatted reading, with source editing available. The same current content drives reading, copying and sharing. A degraded native editor stays protected until a confirmed checkpoint; offline labels no longer claim unverified device persistence. Mobile exposes clear error text, Markdown copy and safe diagnostic copying. Full `npm run verify` passes. Simulator interaction and device limitations are recorded at milestone acceptance.

Mobile C acceptance: full `npm run verify` passes. Maestro on the existing iOS 26.3 development simulator confirms the saved empty quote, Read/Edit/read-only rich Source transitions, outline navigation and plain-text live reading/source editing. The hidden live WebView retains layout so its bootstrap handshake runs while reading. Server vector coverage distinguishes durable Yjs state from a file checkpoint and never clears a degraded state merely on acknowledgement. Actual iOS/Android devices were unavailable; no new native binary was built. The reader still displays a literal escaped pipe inside a table code span; include this discovered renderer-parity case in D3.

D1 acceptance: contextual selection toolbar reuses the existing bold/italic/strike/highlight/code commands and link dialog. Alt+F10, arrow navigation, Escape, pointer and touch interaction preserve the ProseMirror selection. The floating menu stays above workspace panes and within the viewport, is absent in Read mode, and produces the expected file checkpoint. Chromium mouse/keyboard/link-dialog/read-mode and 390px touch checks, TypeScript and focused ESLint pass. Native selection gestures remain covered by the existing native toolbar, with real-device acceptance outstanding.

D2 acceptance: table tools now follow the current cell and offer row/column insertion, deletion and movement plus column alignment. Header rows stay in place during moves; explicit row edits promote or create the single Markdown header and carry column alignment to inserted rows. Unrepresentable header/merge toggles are not offered. Shared command fixtures cover seven edit/undo/redo/reload cases in server and mobile. Browser tests confirm row/column moves, alignment, empty-row checkpoint, reload and header deletion, plus the selection-menu regression. Maestro on the iOS development simulator confirms column alignment and inserted rows reach File saved. Full mobile verification, server TypeScript, focused ESLint and core regressions pass. Floating tools are constrained to the document pane. No schema or storage-format change is introduced by these commands.


D3 acceptance: image width and alignment use a strict portable `<img>` subset, while ordinary images retain `![alt](src)` syntax. Shared contract v2 preserves numeric dimensions and whitelisted alignment styles; unsupported attributes/styles are not admitted by the reader plugin. No general raw-HTML renderer is enabled. The web image node provides a resize handle, keyboard width control, alignment and reset. Dragging previews locally and commits once on release; Escape cancels, and concurrent node replacement invalidates a stale resize. Web reading, PDF HTML output, mobile rich editing and native reading preserve the layout and existing authenticated workspace-image fetching. The native reader's MD4C adapter removes the GFM pipe escape only in complete code spans inside recognized table rows, leaving stored source and other code unchanged.

Validation: seventeen shared source fixtures, ten empty states, table command regressions and image edit/undo/redo/reload checks pass. Dedicated tests verify strict parsing and web/PDF image output. Chromium verifies persisted sizing/alignment, one final drag update, undo/redo, Escape cancellation, reopen and narrow reading. Maestro on the iOS development simulator verifies image Read/Edit transitions; visual inspection confirms the same 240px centered image and corrected table code. Full mobile verification including all exports, server TypeScript and focused ESLint pass. No new native binary or physical-device signoff.

Compatibility: D3 adds the nullable image `align` attribute and contract v2. Roll out the matching server/web and native bundle together; older rich clients must not concurrently edit documents that use the new image layout until upgraded. An older plain Markdown reader can display the standard HTML image without Canvas. Existing documents are not rewritten on opening. Production rollout and public-share/PDF infrastructure deployment remain separate manual actions.

D4 acceptance: pasting a single HTTP(S) URL opens the existing link dialog. Plain Link is the default; a preview is fetched only after the user selects Preview. Images/files, multiple URLs and code paste keep their existing paths. Workspace Notebook URLs offer the existing document embed format `![[target]]`; unsupported external embeds are not offered. Preview insertion no longer adds a lossy trailing paragraph space, and editing recognizes a following preview block. The dialog maps a selection bookmark through document transactions and restores focus explicitly. A shared DOM-selection helper reconciles a visible text caret before editing input, while web guards retain image and table-cell selections and IME ownership. Mobile imports the same unchanged helper through its existing entry point.

Validation: real Chromium clipboard actions cover selected-text links, cancel, explicit preview/checkpoint, preserved surrounding text, document embed/reopen/reading and literal code paste. Selection-menu, image and table browser regressions pass. Rich-block/core regressions, server types/lint and full mobile verification including IME/selection tests and platform exports pass. No new schema or representation is introduced by D4.


D5 acceptance: Read and Edit offer a page-width/full-width toggle. Desktop document focus hides explorer, chat and terminal without changing saved panel preferences, remounting the editor or discarding panel state. Escape closes a visible popup first, then exits focus; ProseMirror's unconditional browser-default suppression is handled explicitly. Reading tables retain column alignment and scroll in a keyboard-focusable region without widening the page. Native rich tables use 144px minimum cells and avoid unnecessary trailing paragraph space.

Validation: Chromium verifies the same editor/terminal DOM instances, no new collaboration socket, undo/redo, retained unsent chat input and panel preferences, selection-menu Escape precedence, column alignment and narrow-screen table scrolling. Seven existing browser regressions (empty quote, shared Markdown structures, live source/migration/recovery, selection, table, image and URL paste) pass; the final focus/width case passes after correcting the test's double-click coordinates to select actual text. TypeScript, focused ESLint, rich-block/core/preservation/hardening tests and full mobile verification pass. Maestro and screenshots on the existing iOS development simulator confirm horizontal navigation to the last column in Read and Edit, including the wider cells. No physical-device or new native-binary signoff is implied.


## Final integration acceptance

All implementation milestones A–D5 are complete on `codex/editor-stability` in both repositories. Final server `npm run build` passes, including license checks; the pinned Marked 18.0.3 parser is included in the regenerated third-party inventory/notices. Eight browser scenarios pass (seven in the combined run and the corrected focus-selection scenario in its final run). Server types/lint, rich-block/core/preservation and collaboration-hardening suites pass. Mobile full `npm run verify` passes with iOS/Android/Web exports and the existing iOS development simulator checks above. These results do not replace physical iOS/Android interaction checks or a new binary/store build.

Twelve known, neutral test files were removed from the local Shared Test Workspace and unrelated files were verified unchanged. The task's native app and Metro session were stopped. Original working copies, the managed test stack and production were left unchanged. The isolated host development server is stopped after final verification; it can be restarted from this worktree with the managed host environment.

Release boundary: no production deployment, OTA update or native binary was performed. Deploy compatible server/web/mobile codecs together as described above. Before repairing any existing production note, back up its current Yjs state and file checkpoint, validate with the corrected codec and use the normal lifecycle/checkpoint path. No production note was rewritten by this task.


Final GitNexus comparison against `main`: server reports medium aggregate risk; mobile reports critical aggregate risk across the shared Markdown reader, eligibility and document paths. Changed-file review matches the planned scope. The mobile graph also associates eligibility with unrelated route/locale flows, so those counts are not treated as exact runtime reachability. Full mobile verification includes chat-Markdown and the other app domains; physical-device acceptance remains open for release.


## Review follow-up: table delimiter escaping

Table output now counts the existing backslash run before each pipe in one pass. Inline prose has already escaped its backslashes; escaping all backslashes again would corrupt ordinary text. The table layer adds only the delimiter protection needed to prevent a cell's contents from becoming extra columns, including inside code spans.

Eighteen shared rich-edit cases cover zero through four backslashes, trailing backslashes, literal entities, consecutive pipes and both header/body cells. Server tests independently parse the output with remark-gfm and verify that the neighboring cell survives, then exercise the actual Yjs checkpoint validator. Mobile runs the same corpus through its editor and structural guard.

GFM limitation: a code span containing an odd number of literal backslashes immediately before a pipe cannot roundtrip losslessly with ordinary backtick syntax. Such edits still fail the unchanged structural checkpoint guard and retain their original rich state for recovery; the escaping fix does not claim to make them saveable or silently drop a backslash. Supporting those values would require a separate, explicit representation decision across all readers. See the [GFM table and code-span rules](https://github.github.com/gfm/#tables-extension-).
