# Responsive Notebook surface lifecycle

Source base: `7e26a6e3c0eaf5ed9e74a30c9c79c97fc93d7058`.

The actual V7 browser run on `d6bc8b78027ebacef31062b2f7dbf1f1a8886435` passed all six Create/Paste/Import cases. Its original Focus/Width case failed at line 122: after switching from 1440 to 390 pixels and entering mobile focus, the editor differed from the saved original DOM element. Links and restart suites were not started. V7 does not constitute a complete acceptance pass.

The retained focus screenshot predates the mobile resize. The error-context file contains assertion/test source only, with no post-resize DOM snapshot. A late host `ROOM_OWNER_BUSY` read warning has no recorded HTTP status or path correlation and is not assigned as the cause of this UI assertion. The failed run was closed with its own host/issuer/supervisor absent, its loopback port and lock released, and both preserved private databases at zero sessions. Its source/build proof and full `.next` directory were preserved before creating this branch.

## Change

`DashboardShell` now renders one stable workpane/AppLayout/SurfaceLayer hierarchy. Document, chat, email and browser instances retain their React parents across responsive changes. Breakpoint-specific panel IDs and ARIA references remain consistent; there is one chat/activity subtree. The desktop explorer exists only on desktop, while the separately controlled mobile explorer sheet only opens on mobile.

`AppLayout` derives visible fullscreen from fullscreen intent, terminal availability/visibility and the hidden state. A hidden terminal cannot cover the document, lock body scrolling or emit an active fullscreen UI event. Focus hides the existing open terminal without remounting it. The existing reducer deliberately closes the terminal on entering mobile; that policy is unchanged.

## Evidence and limits

`npm run test:notebook:responsive-lifecycle` renders the actual DashboardShell, AppLayout and real viewport controller/reducer in React StrictMode. Its unchanged pre-fix layout failed immediately after the real resize event, before mobile focus entry, on the same-editor DOM assertion. After the fix it verifies:

- Single retained document/chat/email/browser instances over desktop → mobile → desktop and focus changes.
- Stand-in DOM identity, local DOM draft/selection state, consistent panel ARIA references and unique IDs.
- Open terminal identity during focus, fullscreen body-lock release/resume, and the existing mobile-close/reopen behavior.

The resource/editor children are stand-ins. This local test proves reconciliation and DOM presentation contracts; it does not prove native Tiptap selection/history, collaboration sockets, persistence or mobile devices. Those claims require the unchanged original browser suites on a separately frozen, genuinely built and independently sealed integrated source.

Additional gates passed: Notebook location/URL lifecycle, layout/chat controls, browser lifecycle, surface mounting, the existing local real MarkdownEditor lifecycle, full TypeScript (`8 GiB`, no emit/incremental), and scoped ESLint. The existing local MarkdownEditor suite emitted its known Node localStorage and styled-JSX DOM warnings while passing.

All four original browser suites, including Focus/Width's original assertions, seeds and 90-second timeout, and `notebookLayoutReducer` remain unchanged. No application host, issuer, browser runtime, container or production service was started for this source fix. New browser acceptance remains pending integration, a fresh production build/seal and a coordinated START.

The subsequently authorized V8 browser run used exactly integrated commit `3f0ea1dfb81be2c1178c3733ef513782205ca303`, independently verified source digest `eca8f679829afb3d75120ddf231024a3106cc448729fefbd129dd226a87a9c98` and build digest `a82378acd189dbdf6ce11ebba5356cc21909b70b85f8ce989ba5733f113edae6`. All six original Create/Paste/Import cases passed. The original same-editor assertion at Focus line 122 now passed, as did the first mobile focus entry, safe-area assertions, exit-button action and restored header/toolbar. After the second mobile header focus click, Escape failed to restore the original “Focus document” button at line 128. This was a 30-second expectation failure within the unchanged 90-second test budget; no postfailure mobile DOM or event state was retained, so its exact cause remains open. Links and both restart cases did not start. The own runtime was closed and Root independently verified absent original processes, free own port, absent lock, preserved DATA ownership, exact database ownership markers and zero sessions. V8 confirms the earlier resize regression is closed; it does not certify complete Focus or full-suite acceptance.
