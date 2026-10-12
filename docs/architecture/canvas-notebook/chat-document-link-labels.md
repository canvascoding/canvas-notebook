# Document links in assistant replies

Markdown filename/path labels now display the document basename without `.md`, `.markdown` or `.mdx`, with its initial letter capitalized. Inline code and simple formatting around filenames produce the same normal text link. Link destinations and file contents are preserved; explicit Markdown labels and Wiki aliases keep their original text. User/tool messages and embedded document contents retain their previous rendering.

## Validation

- Rendering/helper regression tests, existing chat-file-link and Obsidian Markdown tests, focused ESLint, and host/Docker production builds including TypeScript passed.
- Managed local stack: `canvas-local-team-seat-dev`, external PostgreSQL 18 with pgvector, Notebook at loopback port 3100. The three changed rendering/helper sources were checked byte-for-byte against image `sha256:3591880341d81c5a5d9c6a70eedb530a5167ee6888f05f9a20042105956936f4`. Subsequent Main integration added only QA screenshots; application sources were unchanged.
- Playwright: **2 passed, 0 failed, 0 skipped**, Desktop 1440×960 and mobile viewport 390×844; final run 44.4 seconds. Agent history/transport is deterministic test data; authentication, workspace/file APIs and document opening use the real server.
- Both cases check filename/path/code/format labels, custom labels, Wiki aliases, external/non-Markdown links, unchanged user rendering, and resolved Unicode Wiki links. A real click opens `test.md`; all seven fixture paths/content strings are checked before and after navigation.
- Each UUID workspace was deleted through the App API with owning actor, exact workspace identity, deletion receipt and subsequent listing absence verified. Browser contexts were closed.
- Local screenshots and reports: `test-results/chat-document-link-labels/attempt-3/`; earlier failures remain separately under `attempt-1/` and `attempt-2/`. A fresh Notebook recreation precedes each run. PostgreSQL/Control Plane and private environment/mounts were retained; no seat or license fixtures were changed.

## Existing path limitation

A real `überblick.md` is readable through the file API and its Wiki link resolves. The standard Markdown URI `%C3%BCberblick.md` remains unavailable because chat file-path normalization/validation does not decode the URI. These navigation functions were unchanged by this display change. The browser case records the current missing state while checking the friendly label, rather than claiming successful URI navigation. Multipart uploads also normalize non-ASCII filenames; the Unicode fixture therefore uses JSON file creation and verifies its exact path before rendering.
