# Shared Composio desktop return

Implementation step 6b-d-2c proceeds sequentially: server contract and provider regression (2c-1), authenticated API/client/Electron wiring (2c-2), then actual system-browser/Organization/Team acceptance (2c-3). The gateway stays default-off. Completion of one gate is required before starting the next.

## Provider contract

Composio owns the external OAuth exchange. Canvas starts an exact profile/toolkit account link and receives its pending account ID. The desktop callback records only return or a static error; it cannot publish an account. Finalization reads that exact pending account through the real SDK or managed proxy and requires ACTIVE, enabled and matching toolkit. No account-list default or another ACTIVE account can substitute for the started account.

Existing browser OAuth retains its flow table and callback. A dedicated desktop namespace uses two additive SQL tables: an encrypted transaction and its same-flow publication receipt. The existing central integrations encryption envelope is reused with a Composio-specific purpose and exact shared ownership/reference AAD. Missing encryption keys fail closed with the established Secrets readiness error; there is no plaintext or auth-secret encryption fallback.

## Original human authority

The server captures the human actor and original BetterAuth session separately from PI agent session fields. Every authenticated status/finalize/cancel operation requires that original user, session, workspace and reference, plus current Manage authority. Management can succeed without Use permission. The private snapshot pins actual ownership, all three connection revisions, authorization revision, profile revision and entity, provider mode, credential revision, and the exact pending account.

Lock order is CommonStore resource/authority, original web session, exact profile, then flow row. Public collection locks only the flow row and performs no SDK call or publication. The original session is held against deletion and its expiry is rechecked after provider awaits and immediately before publication. Current SQL authority is held through publication.

## Start, uncertainty and atomic completion

A canonical client intent identifies one immutable start for one actor/session/reference. A domain-separated HMAC derives the opaque flow; only its hash is stored. An encrypted starting transaction must commit before the first account-link mutation. A repeated intent observes that transaction and cannot create another link. An unacknowledged provider result leaves the start unconfirmed; neither automatic relinking nor guessed account recovery is permitted.

After the exact link result, the sealed snapshot stores pending account and authorization URL. Public summaries expose only reference, opaque state, status, deadline and static feedback, with the URL available only while waiting. The anonymous collector never supplies private profile/account/session identifiers. It accepts a return once, ignores late/replayed returns and cannot revive a cancelled or expired flow.

Finalization publishes the exact account, writes a private receipt, and marks completed in the same held SQL transaction. The response is issued only after the outer COMMIT acknowledgement. An ambiguous COMMIT can be recovered only by rechecking the exact same-flow receipt, original current session/Manage authority, snapshot, post-publication revisions and still-bound exact account. A generic connected status or binding revision increment is insufficient. Cancel fences local publication; it does not claim deletion of the provider-owned pending account.

## Required server gate

Use an isolated native PostgreSQL database and actual Composio SDK against a controlled HTTP provider. Cover Organization/Team profiles with the same toolkit, multiple accounts, Manage-only original actor, wrong user/session/reference/workspace, public callback with zero SDK calls, exact account publication/replay, cancellation/late return/expiry, current CAS/profile/credential/session changes, real SQL publication rollback and same-flow recovery. Run existing shared browser/provider regressions. Controlled managed-proxy tests use real router/SDK code but isolate Control Plane database/token/secret authority; they do not prove live Control Plane authentication.

The server gate alone does not establish desktop UI, Electron OS browser, a paid external provider or production acceptance. Those remain the explicitly later gates.
