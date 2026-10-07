# Managed email decision models

Implementation spans Notebook branch `codex/email-classification-plan` and Control Plane branch `codex/managed-email-decisions-plan`. Deployment and external-provider acceptance remain separate from implementation.

Notebook owns email authorization, the questions, historical selection, overrides, focus policy and the persistent result cache. Control Plane owns the approved decision model profiles, encrypted provider credentials, entitlement, pricing, credits and dispatch limits. It receives bounded state and questions, never mailbox credentials or an instruction to send or move email.

The canonical first-party harness is `packages/decision-models`. Run `node scripts/sync-decision-models-package.mjs --target /absolute/control-plane/worktree` when changing it; `--check` validates the source manifest and generated Control Plane copy. Both builds compile the package. Typesafe/Jev, SystemOne-compatible endpoints and OpenAI Decisions use their native protocols and retain their probability semantics.

Control Plane publishes `/v1/managed/decisions/models` and accepts `/v1/managed/decisions/evaluate` with contract version 1, model reference, inference revision, schema version, state, questions and a persisted operation ID. `decisions:read` and `decisions:evaluate` are added through the existing token reconciliation without losing earlier scopes or replacing a valid token. A license API URL alone is insufficient: Notebook needs its managed instance token and a permitted Control Plane origin.

Profiles need an explicit active USD decision tariff and any required central credential. Limits are enforced in PostgreSQL per VM (4 concurrent, 60/minute), organization (16 concurrent, 240/minute) and provider (the strictest active profile limits). A separate ingress limit protects authentication. Prices, credentials and display metadata do not change inference revisions. Model, endpoint, adapter, capabilities and explicit model revision do.

Credit reservation happens before dispatch. Unknown token counts remain unknown. Interrupted or uncertain calls are held for administrative review for up to seven days; confirmed usage can be settled or the reservation released. Stored outcomes are encrypted and retained for 24 hours. Completed/failed operation tombstones remain for 30 days. The payload checksum prevents changed requests from reusing an operation ID. This provides controlled retries and local settlement recovery, not a provider-level exactly-once guarantee.

Existing stored configurations migrate to direct execution. Fresh managed instances offer the Control Plane default without enabling email preparation. Worker and synthetic provider test share `execution-service.ts`. Temporary catalog failures preserve the last confirmed model identity and all local ratings. A confirmed inference change advances the settings revision and clears spam validation before eligible messages are reassessed.

Eligibility stays unchanged for personal and business inboxes: every unread Inbox message regardless of age, plus all other Inbox messages from the last 30 days. The archive is not backfilled. Managed worker operation IDs are persisted independently from job claims; network retries keep the ID, while confirmed budget/auth/rate rejection can receive a new persisted ID.

Focused checks: `npm run test:decision-models`, `npm run test:email:classification:managed`, and the existing classification worker/admin/store/selection checks. Paired production builds, the single managed local stack and browser acceptance must pass before this feature is declared ready. Roll out Control Plane before Notebook so the versioned capability is present.
