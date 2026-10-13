# Excalidraw Scene-Service: acceptance evidence

## Scope and implementation

The Scene-Service shares Canvas authentication, workspace identity, lifecycle,
file lineage and revisions. Markdown continues to use Tiptap/Yjs. The existing
experimental `documentReviewEnabled` setting defaults to false; ordinary
Create/Get/Edit works without accepting proposals. Conflicts remain unapplied.

Implementation commits:

| Commit | Completed scope |
| --- | --- |
| `d960ee6ce` | Authoritative headless service, atomic operations, create journal, checkpoints and notifications |
| `ba3b49ca2` | Internal tools, authenticated REST, OAuth MCP contracts and explicit tool selection |
| `5f521bf02` | Managed file protection, personal/mobile clients, lifecycle, history/restore and experimental review gating |
| `6985948ed` | Read-time checkpoint conflict detection and current authority after lock waits |
| `b36ccd9fd` | Seed `document-suite` 1.4.0 workflow and read-only validation |

Marketplace commit `8d2907e` prepares the immutable 1.4.0 package separately.
The active registry and existing versions are unchanged. Its preparation receipt
binds the required backend commit to `b36ccd9fd14d41be46f87152b35da88f95d8cb20`.
`minCanvasVersion` remains null until the release guard verifies a real published
backend release containing that commit. Initial implementation was completed
without a release, registry activation, push or container build. Publishing
these source commits on `main` does not activate the prepared Marketplace entry.

## Native persistence and transport evidence

Tests used this worktree, isolated filesystem fixtures and disposable databases
on the existing managed PostgreSQL server. The licensed browser fixture copied
the managed database/data and verified its own database OID and paths; it is not
production restore evidence. No second container stack or synthetic license was
created. Native scripts with schema guards do not migrate shared schemas.

| Verification | Evidence |
| --- | --- |
| Headless scene service | Personal/team Create/Get/Edit, parallel creation, idempotency conflicts, exact version bytes, assets, missing checkpoints, owned-inode recovery and old-path reuse |
| Agent and adapter contracts | Registered tools execute in all four workspace types; unauthorized context changes fail; element conflicts preserve the scene and report their actual status |
| Checkpoint durability | Actual child-process exits between fsync and SQL commit, recovery, notifications, external conflicts and lifecycle fences |
| Read inspection | Exact invalid-UTF8 foreign bytes retained once in history, no file publication on Get, bounded reads, FIFO rejection, restore inode proof, and authority revocation during scene/document/lineage/version-storage lock waits |
| Existing clients | Mobile snapshots become element changes, lifecycle-bound legacy hashes, controlled uploads, authoritative reads and checkpoint pagination |
| Historical restore | Exact bytes/assets, large portable revisions, atomic lifecycle advancement, replay and checkpoint failure/recovery |
| File protection | Actual macOS sandbox attempts: 72 Python/Node and four shell writes denied; controlled copy/move retains the required identities and preserves foreign collisions |
| REST HTTP | Real cookies plus raw/signed session-bearer tokens across all three routes; invalid, revoked and unauthorized access rejected |
| WebSocket delivery | Real authenticated fixture users and workspace-grant APIs; revoked sessions/permissions receive no stale scene frames, writes or acknowledgements after lock waits |
| Skill packaging | Actual Canvas manifest/checksum validation, Seed/Marketplace workflow/helper parity, preserved other skills, read-only stdin regression cases and 22 releaseguard cases |

Representative reproducible commands, with the guarded private environment
loaded by the local fixture wrapper:

```sh
node --import tsx --conditions react-server scripts/excalidraw-scene-service-test.ts
node --import tsx --conditions react-server scripts/excalidraw-checkpoint-durability-test.ts --skip-migrations
node --import tsx --conditions react-server scripts/excalidraw-checkpoint-inspection-test.ts
node --import tsx --conditions react-server scripts/excalidraw-agent-tools-test.ts
node --import tsx --conditions react-server scripts/excalidraw-adapters-test.ts
node --import tsx --conditions react-server scripts/excalidraw-existing-clients-test.ts
node --import tsx --conditions react-server scripts/excalidraw-skill-packaging-test.ts --marketplace-root /path/to/marketplace
```

REST-handler adapter suites replace identity I/O while retaining native
persistence. They do not replace the separately executed authenticated HTTP or
OAuth/browser checks. macOS sandbox results do not prove Linux kernel behavior
or native iOS/WebView acceptance.

## Final browser and build checks

The final OAuth run used public client registration, actual browser consent,
authorization-code PKCE and the real `/mcp` transport. All checks passed with
the Review Center disabled: Create/Get/Edit, idempotency and conflicts,
read-only scopes, disabled tools, workspace and client grants, revoked workspace
membership and revoked OAuth connections. Actual Settings UI required explicit
selection of the three new tools and preserved that selection across server
reactivation. Original settings were restored; owned sessions were signed out,
owned OAuth connections revoked, and the owned diagram/workspace removed.
Anonymous public-client metadata remains as inactive audit history under the
existing OAuth provider's lifecycle; the test does not claim client-row deletion.

The final Playwright run passed **4/4** cases, with no skips or retries, in
107 seconds on the current worktree:

| Browser case | Verified behavior |
| --- | --- |
| Two-user collaboration | Live drawing/moving, registered agent tools, conflict review, intervening change before Accept, fresh target checks, Accept/Reject and reload |
| Review default disabled | Actual Settings default off, ordinary edits applied, conflict unchanged, Accept rejected, no review overlay and Cancel available |
| Personal workspace | Headless Create/Get/Edit, idempotency, concurrent independent targets, authenticated REST, editor open, authoritative download and historical restore through the UI |
| Team workspace | The same closed-editor, REST, download and restore workflow in a shared workspace |

```sh
node --import tsx scripts/excalidraw-mcp-oauth-e2e.ts /path/to/private-fixture/metadata.json
npx playwright test tests/excalidraw-live-collaboration.spec.ts \
  tests/excalidraw-review-disabled.spec.ts tests/excalidraw-scene-service.spec.ts \
  --workers=1 --reporter=line,json
```

Full `npm run lint` completed with zero errors and 532 existing warnings.
Scoped lint also passed for the final OAuth harness and shared test helper.
The production TypeScript check passed with `tsconfig.release.json`; the final
two OAuth test files also passed a separate check extending that configuration.
Final `npm run build` completed with exit 0, including decision-model/tool-app
prebuilds, license/dictation checks, production TypeScript and all 381 static
pages. Turbopack reported 12 broad-file-pattern and 48 dynamic-filesystem-tracing
warnings; these remain visible in the build evidence.

GitNexus was freshly indexed before the final scope review. Both the requested
comparison against `main` and a comparison against the original worktree commit
were reviewed. The overall auth/file/editor integration is classified critical
by the graph; its affected flows are covered by the persistence, revocation,
adapter and browser checks above. `main` advanced independently while this
worktree was being implemented, so its additional differences are not part of
these implementation commits. These initial results apply to the original
worktree. The subsequent integration checks below cover the merged source;
neither set of checks is remote CI or production deployment evidence.

## Main integration verification, 2026-10-13

The original implementation was merged with Notebook `origin/main`
`8d6401a08261ca4efe6063fed4001be024fdfb8d`, retaining its commit identities and
the Marketplace receipt's required backend ancestor. The automatic merge was
conflict-free. Shared changes were limited to translations and the page/API
proxy; the upstream 404, chat export and personal To-do changes were retained.

The updated page-auth regression now checks delegation to the actual page guard
instead of the old blanket proxy redirect. Tool metadata also states that
Excalidraw conflicts remain unapplied and that human Accept/Reject requires the
experimental, default-disabled Review Center.

Post-merge results:

- All four Excalidraw browser cases passed again in 99 seconds, without skips or
  retries, on the existing isolated PostgreSQL/browser fixture.
- The complete actual OAuth/PKCE/MCP run passed all nine phases and its required
  cleanup, with original settings restored.
- Actual HTTP Create/Get/Edit passed for cookies, raw session-bearer and signed
  session-bearer credentials; invalid and revoked sessions remained rejected.
- Real anonymous Chromium requests received the German/English HTTP-404 UI.
  An invalid bearer and spoofed return header could not bypass the protected
  Plugins page's login guard or control its return target.
- Native 404/page guards, Excalidraw and Mobile bearer-proxy boundaries, public
  invitations and Studio Bulk policy tests passed.
- Full lint passed with zero errors and 532 warnings; scoped lint passed for the
  integration corrections.
- The integrated production `npm run build` passed with exit 0, including the
  prebuild checks, production TypeScript and static-page generation. Existing
  Turbopack file-pattern/filesystem-tracing warnings remained.
