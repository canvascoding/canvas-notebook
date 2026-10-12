# Step 6a-c-3a — package click acceptance and sharing guard

This gate covers the complete web package workflow, the ResourceManagement navigation guard and receipt-bound test cleanup. SharedConnectionForms dirty-state and local dialog-close behavior remain the separate, open 6a-c-3b gate.

## Source contract

`ResourceManagementSection` registers unsaved metadata, responsible-person, access-mode, grants and staged recipient/right choices with the existing global dirty/pending guard. Header Reload, scope/task changes and browser history cannot silently discard these inputs or bypass a pending Save. Its own conflict Reload also requires confirmation. A 409 retains the local form until that explicit reload; no compensating write is issued. Save sends only changed metadata fields, so a grants-only mutation does not unnecessarily change the metadata revision.

The Store wizard retains the selected exact source and reviewed metadata/grants/package-head/local-checksum vector. Local changes require explicit replacement confirmation; a stale vector produces 409 and disables Apply until a manual fresh review. Canonical inspected resource references bind atomic updates even when the selected URL retains a legacy alias. Package/account grants remain separate.

## Actual browser workflow

`tests/plugin-workspace-fullclick-local.spec.ts` passed **1/1** on the final production host: **56.6 seconds** for the case, **1.5 minutes** overall. It used existing authenticated admin/member identities, one explicitly owned nonce organization package and the actual configured HTTPS Store/ZIP, HTTP actions, filesystem and PostgreSQL persistence.

The confirmed sequence was:

1. Store preview, explicit organization target, restricted member Use-only grant and responsible-person selection; actual atomic installation and exact Installed/Shared references.
2. Member read-only sharing/content behavior; private creator draft, actual README and manifest saves, full validation and immutable local publication.
3. Dirty and pending editor/sharing Reload, scope and browser Back fences; unsaved title changes were reverted without a metadata write.
4. Legacy-alias update of the exact instance, declaration comparison and local-change confirmation. A second admin page changed only the member grant while the first page held its previous review; stale Apply returned **409**, preserving the local publication.
5. Explicit fresh review and Apply produced the new Store publication. Immutable versions **1.0.0, 1.1.0 and 3.0.0** remained readable, including the original local README bytes. Ownership, responsibility, grants and package default activation were preserved by the update.
6. Actual Sharing UI removed the member grant. Final metadata/grant revisions were **m1/g3**; the member's exact Resource/Presentation reads returned **404**, the reference disappeared from Shared, and no additional member package Tree/File reads occurred.

Two deterministic pending checks delayed delivery of the **original actual HTTP response** for the own README PUT and grants PATCH. `route.fetch()` performed the real write, its result was privately receipted before release, and `route.fulfill({response: actual})` delivered that unchanged response. No DTO, authorization result or publication success was fabricated. This does not measure internal filesystem I/O or prove native client/provider behavior.

Intermediate failures are retained in the earlier logs: the first used an unsupported assumption about the effective Disabled label; the second exposed redundant unchanged metadata in a grants-only Save before response forwarding. The fixture label assertion and changed-field emission were corrected, and the final production build/browser run passed.

## Cleanup and focused gates

- Cleanup retains metadata-1, exact source grant revisions, nonce names, allowed actors and current authority checks. SQL resources/drafts and complete immutable history must match the acknowledged receipt vector.
- Every filesystem version UUID, marker checksum and manifest version must match an exact publication receipt for that resource. Extra orphan, missing or duplicate versions stop deletion. The Fullclick source proof binds its canonical configured intake parent, device/inode, mode **0700** and original complete checksum; existing inventory verification remains mandatory.
- Plugin and skill registry locks remain held through the SQL operation, confirmed commit and all final filesystem rechecks/removals. An unknown commit outcome enters no finalizer and preserves the private recovery receipt.
- The new actual private-filesystem receipt regression passed replacement-inode, symlink, wrong-parent/mode/checksum, orphan/missing/duplicate and post-commit-change denial. The existing real dual-lock/private-receipt regression also passed. These guard fixtures used only their own temporary filesystem, no application DB or managed DATA.
- The seven workspace UI scripts, existing editor/drafts gates and focused ESLint passed. Their React/JSDOM HTTP transport is controlled; they supplement rather than replace the production browser result. The final production build and whole-tree TypeScript check passed.
- Root independently confirmed **zero owned resources, drafts, versions, preferences and intake directories** after the browser's successful guarded `afterAll` cleanup.
- Root inspected four final PNGs covering desktop **1280/light**, member **390/dark**, read-only/revoked states and version history. Visible controls fit without overflow. The own host was stopped only after PID/command/CWD verification; the foreign stack remained unchanged.

Logs use prefix `/tmp/canvas-plugin-ui-6ac3`: `-browser-accepted.log`, `-accepted-build.log`, `-accepted-workspace.log`, `-accepted-lint.log`, `-accepted-readback.log`, `-sharing-guard.log`, `-editor-ui.log`, `-cleanup-receipt.log` and `-cleanup-guards.log`.

The final full GitNexus rebuild passed in **72.2 seconds**: **62,829 nodes, 169,805 edges, 2,750 clusters and 300 flows**, after an incremental invalid-UTF-8 failure. Final staged projection including this evidence: **118 symbols/11 files, LOW, zero affected flows**. Cumulative comparison with `main` before adding this evidence: **4,556 symbols/441 files and 16 earlier flows, CRITICAL**; the warning was reported to the user. The cumulative result includes preceding steps, and an empty staged flow list is not proof of no runtime/UI effect.

This narrow web acceptance does not complete SharedConnectionForms 3b, native/Mobile clients, progressive Planning or OAuth return behavior in 6b, or live external-account rollout in step 7. The integration gateway flag remains default off. No live Canva, deployment or container acceptance is claimed.
