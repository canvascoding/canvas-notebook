# Provider setup and recovery validation

Date: 2026-10-16. Worktree baseline: `a9b89776a`. Branch: `codex/provider-setup-recovery`.

## Confirmed VM failure chain

Read-only Control Plane MCP inspection of Canvas Holdings (`2026.10.15.2`, Pi `1.0.4`) showed:

1. Catalog update succeeded at revision 21.
2. The `openai-codex` probe for `gpt-6-luna` failed with `Codex error: Unsupported parameter: temperature`.
3. That probe stored degraded readiness and advanced the catalog to revision 22.
4. Eight following catalog updates were rejected with `CATALOG_REVISION_CONFLICT`.

The settings save path previously reloaded the catalog only after successful verification. A failed verification therefore left the form at the previous revision. No remote provider, credential, deployment, or container was changed during this inspection.

## Resulting behavior

- Reload the catalog after both successful and failed provider verification.
- Removal reads the current catalog and reapplies only the confirmed removal. Concurrent changes to other providers/defaults survive. A target configuration change requires review and another confirmation. An already removed target is idempotent. Revision retries are limited to one; authentication errors are not retried.
- New API-key provider setup checks credential availability in allowed scopes and reuses a complete existing scope, preferring the original selected scope if it is already configured. A manually selected scope is not subsequently replaced by a repeated discovery request.
- Availability discovery uses authenticated, uncached metadata without secret values or ENV content. Keyed credential reads use the same integration/agent precedence as the runtime resolver. Forbidden scopes remain inaccessible.
- Existing readable credentials are clearly marked. Unchanged credentials are not rewritten. Failed or unreadable credential loads block saving and provide retry and Secrets navigation.
- The central request boundary removes explicit temperature for the Codex Responses API. Verification and runtime requests share this boundary.

## QA inventory and evidence

| Claim / control | Functional check | Visual state / evidence | Result |
| --- | --- | --- | --- |
| Existing key is reusable | OpenAI/user, Anthropic/organization, Gemini/system, OpenRouter/user; save without editing a key | Connection step at 1280 and 390 px, existing-credential notice | 8 Playwright cases passed |
| Failed verification does not trap removal | Save and fail verification, remove, reload, check default retained | Failure and removed states at 1280 and 390 px | 2 Playwright cases passed |
| Real local persistence | Seed one temporary personal OpenAI key through the real API, add an inactive provider through UI, reload, remove through UI | `test-results/provider-live-local-recognized.png` | Passed; temporary key/provider removed |
| Conflict boundaries | Changed target, unrelated changes, already removed target, bounded races, permission error, removed default | `scripts/provider-catalog-removal-test.ts` | Passed |
| Scope lookup boundaries | Forbidden scope, missing required key, unreadable key, network error, cancellation | `scripts/provider-credential-presence-test.ts` | Passed |
| Key-load failures | Permission, network and decryption failures do not become missing-key prompts; save is blocked | `scripts/provider-existing-secrets-test.tsx` | Passed |
| Metadata does not disclose values | Real ENV route/store with integration-owned key, no raw content, no cache, session/admin boundaries | `scripts/unified-secrets-api-test.ts` | Passed |
| Personal provider lifecycle | Existing connection recovery, quota/retry, consent, dismissal, complete callback, desktop/mobile | `tests/personal-provider-recovery.spec.ts` | 6 Playwright cases passed; controlled provider responses |
| Real SDK OAuth contracts | Callback/state/client ID, background process, refresh and owner isolation | `npm run test:pi:chatgpt-oauth` | Passed with controlled token transport |
| Real SDK Codex request | GPT-6 Luna/Sol payload construction, explicit temperature input, no temperature output | `npm run test:agent:temperature` | Passed; no network dispatch |
| Credential/runtime regressions | Secrets UI, resolver, cascade, provider config/grants, OAuth scopes, personal provider store/runtime | Focused npm scripts below | Passed |
| Live OpenAI sign-in | Canvas UI opened the actual OpenAI authorization page | Headed Chromium, `auth.openai.com` | Waiting for the account owner's sign-in |
| Live model response / token refresh | Login, model verification, real chat reply, reload and second reply | Must use the resulting OAuth connection | Pending successful live sign-in |
| Production build | `NODE_OPTIONS=--max-old-space-size=8192 npm run build` | `/tmp/canvas-provider-e695-build.log` | Passed, exit 0; compilation, release TypeScript, static generation and CLI version injection |

Screenshots from the controlled provider UI suite are under the ignored `test-results/provider-setup-recovery-*` directories. The suite uses the real app UI and local login; catalog/provider responses are controlled. They do not prove OpenAI account acceptance.

## Reproduce focused checks

```sh
npm run test:agent:provider-setup
npm run test:agent:temperature
npm run test:agent:provider-verification
npm run test:agent:runtime-settings-ui
npm run test:secrets:api
npm run test:secrets:ui
npm run test:secrets:pi
npm run test:secrets:cascade
npm run test:secrets:provider-config
npm run test:pi:provider-contract
npm run test:pi:chatgpt-oauth
npm run test:pi:oauth-scope
npm run test:agent:personal-provider
E2E_EXTERNAL_SERVER=1 npx playwright test tests/provider-setup-recovery.spec.ts tests/personal-provider-recovery.spec.ts --workers=1
```

Use bootstrap credentials from the private managed local environment for browser tests. The local host dev process uses the existing managed PostgreSQL/Control Plane services; no additional test container was built or started. Other running environments were left untouched.

The release TypeScript configuration and focused ESLint checks passed. The broad `tsconfig.json` check also includes unrelated existing test fixtures and reports errors there (for example Excalidraw fixtures and Testing Library `exact` options); none was reported in the changed provider files. GitNexus impact and change detection against baseline `a9b89776a` were LOW for indexed symbols. Comparison against local `main` reports HIGH because that branch predates other work already contained in this worktree's baseline; these unrelated changes were inspected separately and were not introduced here. The ENV API handler is absent from this index, so its permissions and projection were verified from source and API tests rather than inferred from graph coverage.

Implementation commits: `ab333c855` (catalog/removal recovery), `4c7c306df` (existing scoped Secrets), `df60c83ba` (Codex temperature). No push, release, or remote deployment was performed. The headed Chromium login and the worktree dev server on `127.0.0.1:3005` remain available for the pending interactive acceptance step.
