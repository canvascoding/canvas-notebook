# Personal To-do widget scope — 2026-10-13

## Cause and correction

Personal workspace To-dos intentionally store `organizationId: null` in `resolveTodoScope`. A personal chat workspace can nevertheless carry an organization association. The widget access check and the Agent's inspect/update check previously compared both organization IDs for every workspace-scoped To-do, returning 404 despite a matching workspace and valid owner access.

`todoMatchesWorkspaceScope` now supplies the same scope comparison to both consumers. Personal workspace To-dos require the matching workspace ID/type; shared workspace To-dos additionally require the matching organization. User-scoped personal To-dos remain available across personal workspaces. The predicate supplements the existing owner/member authorization in `getTodo`; it does not replace it. Chat ownership, stored tool-result binding, seat access and frame session checks remain in their existing callers.

No data migration or integration feature-flag change is required.

## Validation

- The new personal-workspace regression failed with the original code (404) and passes with the correction.
- `npm run test:tool-apps`: PASS on the final product/test changes, including actual render/refresh route handlers, ticket issuance and frame delivery with controlled authentication/storage dependencies. Matching personal, team, organization and project scopes pass. Foreign workspace/organization/type checks still deny access; denied updates never reach the mutation store. Already issued frames recheck current scope.
- The existing frame-access fixture lacked the now-required persisted auth-session expiry. It failed identically in the unchanged canonical checkout. The fixture now supplies a future expiry and explicitly verifies rejection of an expired session; product authentication is unchanged.
- Focused ESLint over the three product files and two changed test scripts: PASS. `git diff --check`: PASS.
- `npm run build`: PASS with the normal application TypeScript check (`tsconfig.release.json`), prebuild widget/license checks and one build worker. `CANVAS_RELEASE_BUILD_SKIP_TYPECHECK` was not enabled. Existing broad dynamic-file tracing warnings remain.
- Whole-repository `tsc --noEmit --incremental false` with an 8 GiB heap: one remaining error, the unchanged `scripts/transcription-route-test.ts:163` TS7022 on `before`. The same line is present in base commit `84f12e4ea7b541fc53d535fb0e0f857597c02e23`; that file is outside this change. A whole-tree TypeScript pass is not claimed.
- GitNexus impact: the shared predicate has two direct consumers and HIGH transitive impact through widget routes/tickets and Agent execution. Full diff and both consumers reviewed; precommit change detection identifies the expected five code/test files. Its empty process list is not evidence that the separate upstream impact is absent.

Per the user's explicit selection, validation is limited to code/API tests. No browser acceptance, container build or production deployment is claimed. The integration gateway rollout remains a separate task.
