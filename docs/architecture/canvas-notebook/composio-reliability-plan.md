# Composio Reliability Plan

Date: 2026-09-21

## Goal

Make direct and managed Composio calls predictable during provider outages, rate limits, slow responses, scoped-key failures, and toolkit updates. Existing Notebook, mobile, automation, and Control Plane clients must remain compatible during a staged rollout.

## Working branches

| Repository | Worktree | Branch | Base |
| --- | --- | --- | --- |
| Canvas Notebook | `/Users/frankalexanderweber/.codex/worktrees/composio-reliability/notebook` | `codex/composio-reliability-notebook` | `main` at `54e4d408` |
| Canvas Control Plane | `/Users/frankalexanderweber/.codex/worktrees/composio-reliability/control-plane` | `codex/composio-reliability-control-plane` | `main` at `6464c77` |

The existing Notebook worktree at `d65f` is not used for implementation because it contains unrelated changes to `AGENTS.md` and `CLAUDE.md`.

## Confirmed problems

1. Notebook uses `@composio/core` 0.13.1 and Control Plane uses 0.10.0. Both predate the TypeScript SDK 0.14.0 change that stopped automatic retries for non-idempotent tool executions.
2. Current Composio SDK release 0.18.1 requires Node.js 22.22.3 or newer. Both container bases use Node.js 24, but the Notebook package engine still permits Node.js 22.19.0.
3. `verifyApiKey` and the managed status route turn every exception into `apiKeyValid: false`. Timeouts, 429 responses, upstream 5xx failures, and insufficient scoped-key permissions therefore look like an invalid key.
4. Notebook-to-Control-Plane requests and direct webhook-subscription requests have no abort timeout.
5. Tool execution uses `dangerouslySkipVersionCheck: true`, without retaining the version fetched with the tool schema.
6. Managed tool execution creates a Notebook OAuth flow state before every call, including successful calls that do not need authentication.
7. HTTP status, retry delay, Composio request ID, and ambiguous-write state are discarded before reaching logs and user-facing errors.
8. The discovery test contains a stale assertion against removed system-prompt wording.

## Risk boundary

GitNexus reports the following upstream impact before implementation:

| Symbol | Impact | Risk |
| --- | ---: | --- |
| Notebook `managedRequest` | 48 symbols across 10 modules | Critical |
| Notebook `getGatewayStatus` | 21 symbols across 5 modules | Critical |
| Notebook `verifyApiKey` | 22 symbols across 5 modules | Critical |
| Notebook `executeGatewayTool` | 1 direct caller | Low |
| Control Plane `getManagedComposio` | 3 direct callers | Low |
| Control Plane `requestManagedComposioWebhookSubscription` | 2 upstream symbols | Low |

The critical Notebook functions keep their existing signatures during the first extraction. New status fields are additive, and the existing `configured`, `apiKeyValid`, `mode`, and `connectedAccounts` fields remain present.

## Target contract

Control Plane failures keep the required `{ error: string }` shape and add optional diagnostic fields:

```ts
type ComposioFailurePayload = {
  error: string;
  code?:
    | "COMPOSIO_AUTH_REQUIRED"
    | "COMPOSIO_CREDENTIALS_OR_SCOPE"
    | "COMPOSIO_RATE_LIMITED"
    | "COMPOSIO_TIMEOUT"
    | "COMPOSIO_UNAVAILABLE"
    | "COMPOSIO_BAD_RESPONSE"
    | "COMPOSIO_UPSTREAM_ERROR"
    | "COMPOSIO_OUTCOME_UNKNOWN";
  retryable?: boolean;
  outcomeUnknown?: boolean;
  upstreamStatus?: number;
  providerRequestId?: string;
  retryAfterMs?: number;
};
```

The status response becomes:

```ts
type ComposioStatusResult = {
  configured: boolean;
  apiKeyValid: boolean;
  apiKeyState: "missing" | "valid" | "invalid_or_insufficient_scope" | "unknown";
  providerHealthy: boolean;
  mode: "local" | "managed" | "disabled";
  retryable?: boolean;
  errorCode?: ComposioFailurePayload["code"];
  providerRequestId?: string;
  retryAfterMs?: number;
  connectedAccounts: ComposioConnectedAccount[];
};
```

Compatibility semantics:

- Missing configuration: `configured: false`, `apiKeyValid: false`, `apiKeyState: "missing"`.
- Successful provider probe: `apiKeyValid: true`, `apiKeyState: "valid"`, `providerHealthy: true`.
- Provider 401/403: `apiKeyValid: false`, `apiKeyState: "invalid_or_insufficient_scope"`, `providerHealthy: true`. The UI tells the user that the key may be invalid or missing required scopes.
- Network failure, timeout, 429, or provider 5xx: `apiKeyValid: true`, `apiKeyState: "unknown"`, `providerHealthy: false`. Existing clients do not prompt users to replace a key during a provider incident.

## Request policy

| Operation class | Timeout | Automatic retry |
| --- | ---: | --- |
| Status, account lists, toolkit catalog, search, schemas, trigger lists | 15 seconds | At most one retry for network errors and 502/503/504. A 429 is retried only when `Retry-After` is 3 seconds or less; otherwise it is surfaced. |
| Connection authorization, disconnect, trigger create/update/delete, webhook subscription | 30 seconds | Never |
| Tool execution | 120 seconds | Never |

Retry decisions are based on the named operation, not the HTTP method, because search and schema lookup are read-only POST requests. A timeout after a mutation or tool execution returns `COMPOSIO_OUTCOME_UNKNOWN` with `outcomeUnknown: true`; agents and routes must not retry it automatically.

## Phase 1: Control Plane compatibility layer

Work only in the Control Plane worktree.

1. Re-index the worktree with GitNexus and run symbol impact checks again against the branch before each edit.
2. Pin `@composio/core` to exactly `0.18.1` in `apps/api/package.json` and the lockfile. Add a Node engine floor of `>=22.22.3`; the current Node 24 image already satisfies it.
3. Add `apps/api/src/services/managedComposioProvider.ts` and move provider mechanics out of `managedServices.ts`:
   - client and session caches;
   - connected-account pagination;
   - per-call abort signals;
   - provider error normalization;
   - read retry policy;
   - tool-version cache;
   - status probe;
   - tool execution.
4. Keep authorization, entitlement checks, request validation, HTTP response decisions, and usage-event writes in `managedServices.ts`.
5. Replace one route at a time, beginning with `/managed/composio/status`, then schemas/search, then execute, then connections and triggers. Run the targeted test after each replacement.
6. Preserve `{ error: string }` and add the diagnostic fields from the target contract. Forward `Retry-After` when present.
7. Extend the status route without removing existing fields. Classify 401/403 separately from transient failures.
8. Warm a 30-minute in-memory tool-version cache when search or schema lookup returns a tool. On execution, use that dated version. On a cold cache, fetch the tool once, retain its version, and pass `version` to `tools.execute`. Remove `dangerouslySkipVersionCheck`.
9. Apply abort signals to all SDK methods. Do not retry execute, connect, disconnect, trigger mutations, or webhook-subscription creation.
10. Update `requestManagedComposioWebhookSubscription` to use the 30-second mutation timeout and the common failure classifier. Remove unredacted upstream body previews from logs and return values.
11. Add `providerRequestId`, `upstreamStatus`, `errorCode`, `outcomeUnknown`, and `attemptCount` to `managedUsageEvents.metadata`. No database migration is needed because metadata is JSON.
12. Keep the current auth-required 409 response. Continue accepting an old Notebook's `returnUrl` so either deployment order works.

Planned Control Plane commits:

1. `Upgrade and isolate the managed Composio client`
2. `Classify managed Composio health failures`
3. `Harden Composio execution and trigger requests`

## Phase 2: Notebook transport and status

Start only after Phase 1 passes its checks.

1. Re-index the Notebook worktree with GitNexus and repeat impact checks for `managedRequest`, `getGatewayStatus`, `verifyApiKey`, and every UI symbol changed.
2. Pin `@composio/core` to exactly `0.18.1`, update the lockfile, and raise the package engine floor to `>=22.22.3`. The current Node 24 image already satisfies it.
3. Add `app/lib/composio/composio-provider-error.ts` with the shared codes, safe message extraction, request-ID extraction, and retry metadata.
4. Add `app/lib/composio/managed-composio-client.ts` for Notebook-to-Control-Plane HTTP calls. It owns authorization headers, abort signals, response parsing, retry policy, and backward-compatible parsing of both old and new Control Plane responses.
5. Keep the existing `managedRequest(path, options, context)` signature while delegating its implementation to the new client. This limits the critical blast radius during extraction.
6. Change `verifyApiKey` from `boolean` to an internal structured probe result. `getGatewayStatus` translates it to the additive public status contract.
7. Update `app/api/composio/status/route.ts` so expected provider degradation returns a normal status payload. Internal application errors remain 500 responses and preserve the actual Composio mode.
8. Update these consumers to distinguish degraded provider state from invalid credentials:
   - `app/components/settings/ConnectedAppsPanel.tsx`;
   - `app/components/settings/SkillsPanel.tsx`;
   - `app/apps/automations/components/AutomationsClient.tsx`;
   - `app/lib/mobile/composio.ts`;
   - `app/lib/agents/capability-options.ts`;
   - `app/lib/automations/workspace-change.ts`;
   - `app/lib/plugins/plugin-connection-readiness.ts`.
9. Show a retryable provider-unavailable or rate-limit message for degraded state. Show the integration-settings link only for missing credentials or missing scopes.

Planned Notebook commits:

1. `Upgrade Composio and bound managed requests`
2. `Report degraded Composio health accurately`

## Phase 3: Notebook execution consistency

Start only after the status changes pass.

1. Add the same 30-minute tool-version cache for local mode. Warm it from tool search and schema retrieval; use the retained version for execution and remove `dangerouslySkipVersionCheck`.
2. Pass abort signals to direct SDK reads and writes using the request-policy timeouts.
3. Stop creating `createComposioOAuthFlowState` before every managed execution.
4. Execute first. If the Control Plane returns `auth_required`, call the existing connection flow once, create the Notebook OAuth state at that point, and merge its redirect URL into the response.
5. Return structured `outcome_unknown` data to the agent for ambiguous tool timeouts. Update the tool description so the agent checks provider state before considering a manual retry.
6. Do not log tool arguments, OAuth state, API keys, response bodies, or full query text. Log operation, mode, toolkit/action slug, latency, status, retry count, and provider request ID.

Planned Notebook commit:

1. `Pin Composio tool executions and defer OAuth state`

## Phase 4: Verification

### Control Plane

Add `apps/api/tests/managedComposioReliability.test.ts` with injected provider/fetch doubles covering:

- 401/403 classified as invalid credentials or insufficient scope;
- 429 preserving `Retry-After` and avoiding mutation retries;
- one retry for safe reads on network and 502/503/504 failures;
- no retry for execute, connect, disconnect, trigger mutations, or webhook subscription;
- mutation timeout classified as outcome unknown;
- provider request ID retained;
- schema lookup warming the version cache and execute passing that exact version;
- old `{ error: string }` compatibility;
- no secret, argument, or upstream-body leakage.

Run:

```bash
npm run test:managed-composio-tool-discovery
npm run test:managed-composio-identity
npm run test:managed-composio-triggers
npm run test:managed-composio-reliability -w apps/api
npm run typecheck
npm run build:api
```

### Notebook

Add `scripts/composio-reliability-test.ts` and update the stale discovery assertion. Cover:

- transient status failures keep `apiKeyValid` from becoming false;
- missing scope and invalid-key responses use the precise combined state;
- managed requests time out and retain status/request IDs;
- safe reads retry once and writes never retry;
- a normal managed execution creates no OAuth flow state;
- an auth-required execution creates exactly one flow state and returns a redirect;
- local and managed execution pass a dated toolkit version;
- ambiguous tool timeouts are not marked retryable;
- desktop and mobile serializers preserve old fields and expose provider health.

Run:

```bash
npm run test:composio:user-scope
npx tsx scripts/composio-toolkit-access-test.ts
npx tsx scripts/composio-tool-discovery-test.ts
npx tsx scripts/composio-profile-ui-test.ts
npx tsx scripts/composio-reliability-test.ts
npm run lint
npm run build
```

Before each commit, run GitNexus `detect_changes({ scope: "compare", base_ref: "main" })` and verify that only Composio, its status consumers, and the intended tests are affected.

No container is built for this work unless explicitly requested. Playwright is also deferred until explicitly authorized; status rendering is covered by the existing source-level UI contract tests in this change set.

## Rollout

1. Deploy the Control Plane changes first. Its responses remain compatible with the current Notebook.
2. Verify managed status, tool discovery, one read-only connected-account call, logs, and usage-event metadata.
3. Deploy the Notebook changes. The Notebook parser accepts both the old and new Control Plane error shapes.
4. Verify local-key mode and managed mode separately.
5. Watch timeout, rate-limit, authentication, and outcome-unknown counts. Do not automatically replay outcome-unknown operations.

The rollout has no database migration. Each repository can be rolled back independently. The Control Plane continues accepting the old `returnUrl`, and the Notebook continues accepting old Control Plane responses.

## Completion criteria

- A Composio outage or 429 is shown as degraded service, not as an invalid key.
- Every Composio network call has a bounded timeout.
- No tool execution or mutation is automatically retried.
- Ambiguous writes carry an explicit outcome-unknown state and request ID when available.
- Schema lookup and execution use the same retained toolkit version.
- Successful managed executions no longer create unused OAuth flow rows.
- Both repositories compile and all targeted tests pass.
- GitNexus change detection reports only the expected Composio and status-consumer scope.
