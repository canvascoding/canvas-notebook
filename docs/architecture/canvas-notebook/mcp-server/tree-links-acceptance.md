# Workspace tree continuation and direct file links

The local `ls` tree mode and MCP `list_knowledge_tree` share a bounded reader.
The automatically refreshed prompt uses its visible-directory reader while
retaining the existing fair allocation, recency ordering and 8 KiB prompt budget.
`max_depth=0` lists direct children. Descendants are explored relative to any
returned directory, so the per-request depth bound does not limit navigation.
`next_cursor` continues the same workspace/path/depth query. Directory states
distinguish complete, pending, depth-limited and unavailable content. Cursor
frames contain only indices and listing signatures, with at most seven frames.
A changed retained directory requires restarting the request.

MCP file results include absolute `document_url`, nullable `document_id` and
nullable `lineage_id`. Excalidraw also retains its established `documentUrl`.
Existing IDs are read without creating records during listing/search. Untracked
files have path links; their links cannot promise identity across a later move.
Creation, import, editing, completed upload, reads and discovery return links in
both structured results and text. Pending uploads have no saved-file link.
Review links continue to identify the exact proposal separately.

Notebook links accept document and lineage identity together with a path hint.
The authenticated location API resolves the active identity under the workspace
mutation lock for text, Excalidraw and binary files. The loaded file must still
match the resolved identity. A stale path never replaces an unavailable identity.
Normal login preserves the URL parameters, and closing the document or switching
workspaces clears the associated navigation parameters.

## Acceptance inventory

| Claim | Check | Evidence |
| --- | --- | --- |
| All siblings remain reachable | 601 files paged through real OAuth/MCP; unique entries | E2E step and focused reader tests |
| Relative expansion reaches deep files | Follow an 18-level tree with shallow requests | E2E step and reader tests |
| Empty differs from unloaded | `complete` versus `depth_limited`/`pending` | E2E and reader tests |
| Continuations remain scoped | Changed listing, changed path/workspace/depth and revoked OAuth | E2E plus reader tests |
| Local agents can fetch the preview | Execute the real native `ls` with an agent context | Native tool test |
| File tools return exact links | Create/read/edit/search/tree/import/upload/asset/Excalidraw receipts | Real OAuth/MCP E2E |
| Existing login opens the intended file | Navigate the returned URL without selecting a workspace | Desktop screenshot and editor assertion |
| Logged-out login retains the intended file | Follow returned URL, submit bootstrap login, inspect actual editor | Login screenshot and URL/editor assertions |
| Mobile views fit | Document editor, image and Excalidraw at 390 by 844 | Screenshots and viewport checks |
| Renames retain identity | Rename through file API, create replacement at old path, follow old link | API, editor and screenshot |
| Deletion never opens a replacement | Trash original, create replacement, follow old identity link | API 404 and browser screenshot |
| Existing navigation remains stable | Tabs, close-all, workspace isolation, load races and location lifecycle | Focused regression suites |

The E2E runner uses the current production build on one owned host port and a
disposable database on the existing managed PostgreSQL server. Bootstrap login,
OAuth consent, PKCE, MCP calls and the UI are real. Existing applications and
containers are preserved. The test neither builds nor reuses a Notebook test
container. The isolated host, database and data directory are removed afterward.
The immutable official MCP README exercises the HTTPS import adapter; external
ChatGPT/Codex attachment mediation is outside this test.

Run with a free host port:

```sh
npm run build
CANVAS_MCP_E2E_PORT=3007 npm run test:mcp:tree-links:e2e
```

Private, redacted run reports and screenshots are written under
`artifacts/mcp-file-ingest-e2e/<run-id>/`.

## Verified 2026-10-16

- Production `npm run build`, release TypeScript check and focused ESLint passed.
- Tree reader/native `ls`, prompt refresh/budget, file-link contracts, MCP edit
  checkpoints and import boundaries passed their focused tests. Notebook load
  races, workspace isolation, tabs, close-all, entry surface and location
  lifecycle regressions passed.
- Final OAuth/MCP/browser run `0b2744a0-fb50-410e-a71f-2538b1820115` passed all
  14 steps. It also verified a URL containing only IDs and the actual document
  content immediately after login, before any subsequent reload.
- Seven screenshots cover desktop, login return, mobile document/image/edited
  Excalidraw, renamed identity and deleted identity. Viewport checks and visual
  inspection confirmed the file targets. Capture waits for the deleted-file
  message to settle inside the viewport.
- Before rename/delete the runner closes its editors and waits for the normal
  saved connection release required by the existing lifecycle guard.
- Final cleanup was verified: owned port 3007 is free, all five run databases
  are absent, and the owned data directories were removed. The four managed
  application/database containers remained healthy.
