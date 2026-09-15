# FVRC-701 QA inventory

This inventory was frozen before browser execution. Actual outcomes and final evidence filenames are recorded in `results.md`.

## Environment and sign-off claims

- Target: production-built Canvas Notebook at `http://127.0.0.1:3100`, backed by the managed PostgreSQL Team Seat stack.
- Test document: a Markdown file in `Shared Test Workspace`, exercised through the real authenticated UI.
- Claim: Editor, file-browser action menu and chat change widget open the same global Version & Changes center for the same document lineage and intended selection.
- Claim: Reviews appear before the lightly highlighted current version, followed by history; status remains understandable without color.
- Claim: Comparison always uses the authoritative current version and exposes Changes, Preview, Source and Details in the larger global dialog.
- Claim: Review-required changes can be accepted or rejected; a historical version can be restored as a new version; safe-direct mode applies only a new safe edit.
- Claim: stale proposals and restore races fail closed with a visible, recoverable conflict state.
- Claim: the center remains usable and visually coherent on desktop, narrow desktop and mobile, in light/dark themes and with reduced motion.
- Claim: dialog names, landmarks, keyboard focus, tab navigation, Escape close and focus return are accessible.

## Functional and visual checks

| ID | Requirement / control-state pair | Functional check using normal input | Visual state to inspect | Evidence |
| --- | --- | --- | --- | --- |
| F01 | Authenticated production stack | Sign in with the private bootstrap account through the login form and open `Shared Test Workspace`. | Notebook shell after login; workspace identity visible. | `01-login-workspace-desktop.png` |
| F02 | Markdown editor entry | Open the test Markdown file and activate the header button named `Versionshistorie`. | Editor header, Review toggle and global center title/path. | `02-editor-entry-desktop-light.png` |
| F03 | Timeline order and independent status | Verify DOM order is Reviews, Current, History; select each populated row by its button. | Violet review, restrained emerald current, neutral history, each with icon/text/badge. | `03-timeline-desktop-light.png` |
| F04 | Comparison views | Select a proposal or revision and activate Changes, Preview, Source and Details via the tab controls. | Split diff, inert Markdown preview, paired source, metadata details. | `04-diff-desktop-light.png`, `05-preview-desktop-light.png`, `06-details-desktop-light.png` |
| F05 | File-browser entry | Close the center, open the file row context/action menu and choose `Versionen & Änderungen`. | Same center, same lineage/path and selected/current state. | `07-file-browser-entry.png` |
| F06 | Review toggle full cycle | In editor: observe review-required, switch to safe-direct, verify saved state, then return to review-required. | Toggle, tooltip/status semantics for both modes. | `08-review-toggle-safe-direct.png` |
| F07 | Review and Accept | With review required, ask the local agent to edit the document, open the resulting chat file-change widget, inspect the matching proposal, then accept it. | Chat widget; review row above Current; accepting busy/success and refreshed timeline. | `09-chat-widget-review.png`, `10-review-before-accept.png`, `11-after-accept.png` |
| F08 | Review and Reject | Create a second review-required agent change, inspect it, reject it and verify it no longer remains actionable. | Reject control and refreshed non-actionable state. | `12-review-before-reject.png`, `13-after-reject.png` |
| F09 | Safe direct apply | Disable review, ask the same authenticated user's agent for a new independent safe text edit, and verify the document changes without an approval click while history captures it. | Editor policy in safe-direct mode and resulting version/history. | `14-safe-direct-result.png` |
| F10 | Restore | Select an older revision, activate Restore, inspect the confirmation including current fence, confirm and verify a new current/history state. | Restore confirmation and refreshed timeline. | `15-restore-confirmation.png`, `16-after-restore.png` |
| F11 | Conflict / stale proposal | Open a proposal comparison, mutate the same document in another authenticated context, then try the stale action. | `Document changed` or equivalent fail-closed message; no silent apply. | `17-stale-proposal-conflict.png` |
| F12 | Restore race | Open restore confirmation, change the current document in the second context, then confirm the stale restore. | Visible current-changed conflict with retry/refresh path; intervening edit preserved. | `18-restore-race-conflict.png` |
| F13 | Deep link and reload | Copy the center query URL, reload/navigate directly, and verify the same authorized document/selection reopens; close removes only FVRC query state. | Rehydrated dialog and stable URL behavior. | `19-deep-link-reload.png` |
| F14 | Rename lifecycle | Close center, rename/move the test file via normal UI, reopen the saved deep link/lineage entry and verify the current path resolves. | Center description shows renamed path, not a replacement lineage. | `20-rename-lineage.png` |
| F15 | Keyboard/focus | Open center with keyboard, traverse timeline and tabs, use arrow keys between tabs, close with Escape and verify focus returns to trigger. | Visible focus rings; no focus loss behind modal. | `21-keyboard-focus.png` |
| F16 | Dark mode | Switch app theme to dark and repeat center open, populated timeline and comparison. | Contrast, badges, diff additions/deletions, overlays and borders in dark theme. | `22-desktop-dark.png` |
| F17 | Reduced motion | Create a browser context with `reducedMotion: reduce`, open/reload center and inspect loading/busy affordances. | No required meaning depends on animation; spinners use reduced-motion fallback. | `23-reduced-motion.png` |
| F18 | Narrow viewport | At 760 x 900, open a populated center and exercise timeline-to-comparison navigation and primary actions. | Stacked single-column dialog; controls remain reachable without horizontal clipping. | `24-narrow-light.png` |
| F19 | Mobile viewport/touch | At 390 x 844 with touch, open from editor/file action, select a row, switch comparison tab and close. | Mobile stacking, tap targets, action layout and viewport fit. | `25-mobile-light.png`, `26-mobile-comparison.png` |
| F20 | Second isolated user | Sign in as the fixture collaborator in a separate context, open and edit the shared Markdown document. | Shared workspace access without leaking the first user's session. | `27-secondary-user-shared-write.png` |

## Exploratory and off-happy-path checks

1. Unsupported file: open the action menu for a non-text file and confirm the version entry is absent or explicitly unavailable; the prior Markdown target must not leak into the dialog.
2. Missing/replaced target: retain a deep link, delete or replace the file at that path, then open the link and confirm a clear missing/archived response rather than another file's history.
3. Network retry: abort or fail one comparison request, activate the visible retry control, and verify recovery keeps the same document scope and selection.
4. Dense history: create enough revisions to exercise internal scrolling; ensure header, timeline groups and action footer are not clipped at desktop, narrow or mobile sizes.

## Viewport, focus and visual defect checks

- Desktop explicit viewport: 1600 x 900; narrow viewport: 760 x 900; mobile: 390 x 844 with touch.
- Inspect region bounds for dialog header, timeline, comparison tabs/content and action footer; required regions must fit or use their intended internal scroll areas.
- Check document-level horizontal overflow plus each fixed/scrolling pane's bounds.
- Confirm screen-reader names for dialog, timeline nav, tabs, diff/source regions, Review switch, history/menu triggers and mutation buttons.
- Confirm no clipped controls, obscured overlays, awkward wrapping, illegible text, weak contrast, broken layering or accidental external loads from Markdown preview.
- Run a final 30-90 second unscripted pass through the densest available state.

## Intentional exclusions

- Notification-center entry is deferred to FVRC-P08 and is not part of FVRC-701.
- Code/text adapter expansion beyond the v1 Markdown/text core is deferred to FVRC-P09.
