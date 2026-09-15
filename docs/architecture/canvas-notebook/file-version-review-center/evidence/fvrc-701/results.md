# FVRC-701 UI/E2E acceptance results

Date: 2026-09-15

## Environment

- Managed Canvas local Team Seat production stack, bound only to loopback.
- Notebook: `http://127.0.0.1:3100`; Control Plane API/UI and PostgreSQL remained in the single existing managed stack.
- Test document: `fvrc-701-review-center-20260915-renamed.md` in `Shared Test Workspace` after the tested rename lifecycle.
- Browser: persistent Chromium sessions using normal pointer, keyboard and contenteditable interactions. Credentials came from the private local bootstrap configuration and were not recorded.
- Desktop: 1600 x 900, light. Narrow: 760 x 900, light. Mobile: 390 x 844, dark, `prefers-reduced-motion: reduce`.

## Acceptance summary

| Area | Result | Evidence |
| --- | --- | --- |
| Login/workspace and Markdown editor entry | Passed | `01-login-workspace-desktop.png`, `02-editor-entry-desktop-light.png` |
| Review → Current → History ordering and color-independent labels | Passed | `03-timeline-desktop-light.png` |
| Changes, inert Preview, Source and Details | Passed | `04-diff-desktop-light.png`, `05-preview-desktop-light.png`, `06-details-desktop-light.png` |
| File-browser entry resolves the same lineage | Passed | `07-file-browser-entry.png` |
| Review-required/safe-direct toggle | Passed | `08-review-toggle-safe-direct.png` |
| Chat change widget opens the global center | Passed | `09-chat-widget-review.png` |
| Review, Accept and Reject | Passed after receipt-shape fix | `10-review-before-accept.png`, `13-reject-fixed-success.png`, `14-accept-fixed-success.png` |
| Safe direct agent edit | Passed | `15-direct-safe-apply.png` |
| Restore confirmation and restore-as-new-version | Passed | `16-restore-confirmation.png`, `17-restore-success.png` |
| Stale agent proposal after a second-user target edit | Passed, fail-closed at authoritative preflight | `24-stale-agent-proposal-conflict.png` |
| Concurrent stale restore fails closed and remains visible | Passed after refresh-lifecycle fix | `18-stale-restore-visible.png` |
| Deep-link reload and selected lineage/revision | Passed | The desktop center was reloaded from its full `fvrc*` query and reopened Version 6 for the same lineage; the mobile context reused that deep link. |
| Rename lifecycle through an old lineage deep link | Passed | `21-rename-lineage.png` |
| Keyboard/focus | Passed | Tab focus remained inside the modal, comparison tabs supported keyboard navigation, Escape closed the center, and editor-trigger focus was restored. |
| Narrow light viewport | Passed | `22-narrow-760-light.png` |
| Isolated second user and shared Markdown write | Passed | `23-secondary-user-shared-write.png` |
| Mobile, dark and reduced motion | Passed after stacked-layout fix | `19-mobile-dark-reduced.png` records the discovered overlap; `20-mobile-dark-reduced-fixed.png` is the final accepted state. |
| Consistent Timeline gutter and inset selected/focus states | Passed after visual alignment fix. Empty, Current and History measured on one edge with 16 px horizontal gutters (17 px on the desktop trailing edge including border rounding); keyboard focus rendered as a 2 px inset ring. | `25-timeline-gutter-desktop.png`, `26-timeline-gutter-narrow.png`, `27-timeline-gutter-mobile.png` |
| Unsupported/missing target, network retry and dense history | Passed | Binary action omitted Version History; missing-path deep link stayed explicit; one-shot comparison 503 recovered through Retry; 16 revisions scrolled internally. |

## Real workflow steps

1. Sign in through the Notebook login form and select `Shared Test Workspace`.
2. Create/open the Markdown test document and use the editor `Versionshistorie` button.
3. Inspect the grouped timeline and each comparison tab. The Preview contained no active unsafe elements or external requests.
4. Close the center, open the file row menu and choose `Versionen & Änderungen`; verify the same path and lineage.
5. Switch the per-document policy between review-required and safe-direct.
6. With review required, ask the configured agent for an edit, open the chat file-change widget, and Accept it. Repeat with another edit and Reject it.
7. Enable safe-direct and request an independent safe edit; verify the document changes without an approval click and a new version is captured.
8. Select Version 6, inspect the current revision/SHA fence in the confirmation, and restore it as a new version.
9. Open the Version 6 restore confirmation again. In a second authenticated page, append a new line through the editor and wait for persistence. Confirm the stale restore in the first page.
10. Create a new review fixture for that line, open its proposal comparison, replace the same target from the isolated second-user context, then attempt the stale Accept action and verify the proposal is not applied.
11. Rename the Markdown file through its file-browser action menu, then open the old saved lineage deep link and verify it resolves the renamed path.
12. Reload the saved deep link at 760 x 900 in light mode and at 390 x 844 in dark/reduced-motion mode; verify modal, stack, scrolling, controls and keyboard focus.
13. Upload a PNG through the file-browser upload UI, verify its action menu has no Version History action, and remove the fixture. Open a nonexistent path deep link, inject one comparison 503 and recover through Retry, then wheel-scroll the 16-revision Timeline.

## Network and observation evidence

- First pre-fix Accept: the Accept POST returned HTTP 200. The structured, content-free container observation was `component=file_version_center`, `version=1`, `operation=accept`, `outcome=success`, `durationMs=382`. The following timeline resolve also succeeded in 49 ms with six items. The client rejected only the intentionally sparse mutation receipt.
- Reproduced pre-fix Reject: GET operation 200 → POST reject 200. The structured observation was `operation=reject`, `outcome=success`, `durationMs=44`; no client resolve followed because the sparse receipt was rejected.
- Post-fix Reject and Accept: GET operation 200 → POST action 200 → authoritative GET operation 200 → resolve 200. The pending review count changed from one to zero and the resulting history entry was present.
- Stale restore: POST restore 409 → resolve 200 → compare 200. The selected Version 6 remained selected, the intervening edit remained current, no restore was applied, and the specific current-changed alert stayed visible.
- Stale proposal: after the proposal was displayed, the isolated collaborator replaced its exact target through the editor. The authoritative operation projection changed `proposalVersion` to null. Clicking Accept performed GET operation 200 only, deliberately sent no stale POST, kept the collaborator's text unchanged and displayed both `Dieser Vergleich ist nicht mehr aktuell` and `Der Agentenvorschlag wurde geändert`. Cleanup Reject returned 200.
- Network retry: a one-shot comparison response was replaced with HTTP 503. The selected revision stayed scoped to the same document, `Erneut versuchen` remained visible, and the retry returned the Version 6 comparison successfully.
- Logs and evidence contain no document bodies, credentials, tokens, raw request payloads or unrestricted identifiers.

## Defects found and fixed in FVRC-701

1. Accept/Reject mutation routes correctly returned a compact durable receipt, while the client required the full GET projection. The action controller now validates the receipt and then reloads the authoritative, permission-aware operation before deriving the outcome. Regression coverage uses the real sparse receipt shape.
2. A stale-action refresh replaced the complete center subtree, so its useful 409 explanation disappeared. Initial/deep-link loads still use the full loading state; invalidation refreshes preserve the current timeline/action subtree until the authoritative response arrives. The selected comparison identity is stable across current-fence refreshes.
3. At 390 px the grid compressed the Timeline navigation below the 18-rem minimum of its internal scroll viewport, causing content to overlap the Comparison. The Timeline now owns that mobile minimum and returns to `min-height: 0` at the desktop breakpoint.
4. Timeline cards used 12 px padding below `sm`, while outer selected/focus ring offsets made emphasized cards appear wider and too close to the pane edge. All widths now use a 16 px section gutter, the Radix viewport wrapper is constrained to the pane width, and selected/focus rings render inset. Empty, Current and History cards share the same left and right edges.

## Verification

- `npm run test:file-version-center:hardening` — passed, including action, comparison and timeline regressions.
- `npm run test:collaboration:agent-approval` — passed (approval, direct grant, Markdown adapter, route and client suites).
- Production host build — compilation, post-compile hook and TypeScript passed. A plain build without the managed environment reaches the known baseline failure at `/en/sign-up` because Postgres mode lacks `DATABASE_URL`.
- Managed production build — all 344 pages built, Docker image built and Notebook container recreated. Final image: `sha256:adeaabe0b2343641bd28c480a7d1181924ecae910e625819412b2e4f1c783348`.
- `status-local.sh` — Notebook, Control Plane API/UI and PostgreSQL healthy; all health endpoints passed; PostgreSQL 18.4 with pgvector 0.8.3.
- The final fixture phase retried the configured Ollama provider and received external HTTP 502 `MODEL_TEST_FAILED`. The persisted provider had already completed the real review-required and safe-direct agent runs in this acceptance session; the 502 did not affect the final image, container health, stored fixtures or non-model race/viewport checks.

## Scope notes

- Notification-center review entries remain deferred to FVRC-P08.
- Additional code/text adapters remain deferred to FVRC-P09.
- FVRC-702 rollout/rollback work was not started.
