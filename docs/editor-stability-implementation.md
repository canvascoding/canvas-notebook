# Editor stability implementation

Implementation branch: `codex/editor-stability`, server base `32238cfc`, mobile base `00e6c91`.

## Sequential milestones

- [x] A: Empty quotes and complete original EOF suffix; Markdown, Yjs, edit/undo/reopen regression coverage in both clients.
- [x] B: Versioned shared parser rules and fixture parity; syntax-aware table/list normalization and structural validation.
- [ ] C: Read/edit/source modes backed by the current live document; distinct connection, durability and file-checkpoint status; safe recovery actions.
- [ ] D1: Contextual selection formatting.
- [ ] D2: Contextual table operations.
- [ ] D3: Portable image sizing/alignment with resize controls and renderer parity.
- [ ] D4: Link/preview/embed paste choices using existing provider support.
- [ ] D5: Document width and focus behavior where missing.

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
