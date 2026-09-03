# Editor stability implementation

Implementation branch: `codex/editor-stability`, server base `32238cfc`, mobile base `00e6c91`.

## Sequential milestones

- [x] A: Empty quotes and complete original EOF suffix; Markdown, Yjs, edit/undo/reopen regression coverage in both clients.
- [ ] B: Versioned shared parser rules and fixture parity; syntax-aware table/list normalization and structural validation.
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
