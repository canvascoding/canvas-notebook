# Offline rich Markdown projection diagnosis

This reproducer covers synthetic native Yjs data. It does not establish the
cause of `ek-fuchs-transkript.md`: the original complete binary snapshot has
not been inspected. No production document is copied into these fixtures.

Run from the repository root, using dependencies installed in this worktree:

```sh
node_modules/.bin/tsx --conditions react-server scripts/markdown-codec-projection-diagnosis-test.ts
```

The fixtures start from native schema nodes, rather than Markdown import, so
the test input retains the characters whose loss is being diagnosed. Both
`tiptap_xml` and `tiptap_blocks` have valid schema and stable IDs. The block
fixtures also pass the existing native agent admission check.

| Native text in a list paragraph | Reparsed native text | Current export validation |
| --- | --- | --- |
| `A\tB` | `A B` | `roundtrip_unstable` |
| `A\t\nB` | `A \nB` | `roundtrip_unstable` |
| `A\rB` | `A\nB` | `roundtrip_unstable` |
| `A\r\nB` | `A\nB` | `roundtrip_unstable` |
| `A\nB`, `A \nB`, `A  \nB`, boundary spaces, NBSP | Preserved | Valid |

The serializer emits literal interior tabs and carriage returns in these
cases. Marked expands tabs in the first line of a list item and normalizes
carriage returns before tokenization; comparison of native documents then
correctly rejects the lossy projection. A plain paragraph tab is a useful
control: its Marked token retains the tab, whereas the list-item token does
not. Existing numeric whitespace entities show a possible encoding approach;
they do not justify normalizing the authoritative Yjs text or loosening the
roundtrip validator.

Relevant local source:

- `app/lib/markdown/core/inline-mark-whitespace.ts`: current whitespace protection.
- `app/lib/markdown/core/lists-and-tables.ts`: first list paragraph rendering.
- `app/lib/collaboration/markdown-state.ts`: strict schema/ID/serialization/roundtrip validation.
- `node_modules/marked/lib/marked.esm.js.map`, embedded `src/Tokenizer.ts`: list `expandTabs`.
- The same source map, embedded `src/Lexer.ts`: `carriageReturn` normalization.

An explicit private full Yjs update can be inspected offline:

```sh
node_modules/.bin/tsx --conditions react-server scripts/diagnose-rich-markdown-snapshot.ts /absolute/private/update.bin
```

The command accepts binary Yjs update-v1 data, not Markdown, a database row,
JSON, a base64 string, or an update-v2 payload. It reads the file without
writing it, and requires the entire input buffer to be consumed. Its versioned
JSON output contains only a binary digest, size,
representation, phase results, control-character counts, and evidence that
the hydrated state/vector remain unchanged. It excludes document content,
frontmatter, block IDs, private paths, and raw error messages. Missing,
malformed, unsupported-root, and incomplete updates are distinct from a
completed diagnosis. A completed diagnosis exits zero even when export is
unavailable; that exit status does not mean the projection is valid.

Keep snapshots and their identity/scope metadata outside Git, with private
file permissions. The tool does not fetch production state, authorize repair,
establish a database durability proof, or mutate a live room. Its size limit
is a local diagnostic input budget, not an increased runtime file/link-scan
limit. Current safe behavior is to keep native content intact, retain strict
export failure, and let separately authorized native readers/edits use their
structural contract. A codec change needs its own impact review and broader
paragraph/list/table/mark/code/clipboard regression coverage.
