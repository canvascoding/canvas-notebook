# Personal OAuth provider verification

Personal OAuth account connection, workspace/agent consent, and successful model verification are separate states. Stored refresh credentials establish account connection; they do not prove that a model request works.

`POST /api/agent-runtime/personal-provider-verify` accepts `workspaceId`, `agentId`, `providerInstallationId`, and an optional catalog `modelId`. The authenticated session determines the credential owner. The route requires workspace read/run access and agent use access. Team/organization workspaces also require an active interactive credential grant. User IDs, execution modes, credentials, and arbitrary endpoints cannot be supplied by the caller.

The route reuses the provider probe, including its 30-second budget, cancellation, catalog fences, scoped credentials, and supported request options. Workspace/model policy and consent are checked before and after authentication and again before saving the result. A cancelled check does not persist a failure.

Results live in `ai_user_provider_verifications`, keyed by organization, user, and provider installation. The existing PostgreSQL startup schema migration creates this additive table. Results bind to the connection ID and a fingerprint of the executable provider/model configuration. Concurrent results use revision checks. A personal result never changes the shared catalog revision or installation status.

Token refresh preserves a connection ID, including legacy credentials. Login/reconnect creates a new connection ID; logout removes it. Reconnect, logout, provider disable, model/config changes, and owner/grant changes cannot reuse a stale successful check. The resolver and final runtime request checks use the same personal verification state. System, managed, and organization installations continue using their existing readiness rules.

Existing personal OAuth accounts need one owner-specific check. Shared historical verification is not copied to other users. The chat dialog offers this check without requiring another login, displays bounded failure messages, and selects only the fresh server-confirmed provider after success. Closing the dialog or changing workspace, account, agent, or session cancels the pending UI action. A completed login or consent action automatically checks the account once prerequisites are present.

Validation: `npm run test:agent:personal-provider` exercises the real PostgreSQL schema/store, public route, probe, resolver and runtime with isolated credentials and simulated provider transport. `tests/personal-provider-recovery.spec.ts` covers desktop/mobile recovery, quota failure/retry, consent, and dismissal using real app rendering with controlled provider responses. Live OAuth, token refresh against OpenAI, and live model acceptance remain separate from these checks.
