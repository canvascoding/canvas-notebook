# Licensing and Team Seats

This guide describes the supported licensing behavior for self-hosted Canvas
Notebook instances and the operational contract between Canvas Notebook and the
Canvas Control Plane.

## Choose when to activate

License activation is voluntary for local Solo use. During setup, an owner can
skip the Community license screen and continue to the application. The same free
Community license can be activated later from **Settings → License**.

Without a license, the instance remains usable on localhost or in a private
network without internet access. Files, workspaces, the editor, terminal, local
authentication, agents, and locally configured integrations remain local core
features. Solo mode permits one active owner and does not expose Team membership
or collaboration capabilities.

Activating a Community license sends the instance identifier and the account
email entered for activation to the Canvas license service. Workspace contents,
prompts, local provider credentials, and integration secrets are not included.

## When an account and internet connection are required

A Canvas Control Plane account is not required to run an unlicensed Notebook in
Solo mode. It is required when the owner:

- claims a Community license in order to upgrade it to Team;
- starts or manages a commercial Team Seat subscription;
- approves a billable seat increase; or
- reconnects a revoked or expired instance token.

The Notebook must reach the Control Plane for claim, preflight, quote, approval,
execute, refresh, and reconciliation operations. Ordinary local application use
does not continuously depend on that connection. The instance token is scoped to
the claimed instance and the required Team Seat operations; it is not a user
session or a workspace-data credential.

## Understand Team Seat costs

The Control Plane is authoritative for seat quantity, price, currency, billing
interval, taxes handled by the payment provider, and the amount due immediately.
Before a billable activation, the UI displays:

- current, requested, and resulting seat quantity;
- price per seat and recurring total;
- amount due immediately, currency, and billing interval;
- whether the operation is billable or non-billable; and
- quote expiration.

The owner must explicitly approve the current quote. The browser never supplies
an authoritative quantity, unit price, total, or quote hash. An expired or stale
quote is prepared again and requires a new approval. `requires_action` and
payment failures leave the membership in a non-active state and do not grant
productive access.

Invitations can reserve or preauthorize a seat, but an invited,
`approval_required`, or `billing_pending` membership is not an active user.
Test and manual grants are labeled **Non-billable** and never create a Stripe
checkout or charge.

## Offline operation and grace

The signed local certificate is the access authority. If the Control Plane is
temporarily unavailable, the Notebook keeps the last valid certificate, retries
with bounded exponential backoff, and permits Team access only while the signed
certificate and its grace window allow it.

The Control Plane is required again before any billable membership mutation.
The Notebook never buys additional seats automatically because local user count
increased or a reconciliation snapshot drifted.

After certificate or grace expiry, revocation, unsupported protocol, or another
terminal entitlement failure, the Notebook fails closed for Team features and
falls back deterministically to Solo access:

1. the designated owner remains active;
2. additional Team memberships are suspended;
3. their active sessions are revoked; and
4. license-only user bans can be reversed after a valid Team reactivation.

This process does not delete user identities, memberships, database rows,
workspaces, files, chats, or settings.

## Downgrade, cancellation, and nonpayment

An explicit Team-to-Solo downgrade uses the same data-preserving fallback.
Cancellation or nonpayment first requires a signed license refresh; the locally
verified certificate determines the effective access state. Quantity drift can
temporarily restrict access to signed capacity, but it cannot trigger a purchase.
A stale or contradictory Control Plane snapshot is reported as
`support_required` instead of being guessed locally.

Reactivating Team reuses the existing instance, license, memberships, identities,
and workspace data. The owner does not need to migrate to another Notebook.

## Recovery runbook

1. Open **Settings → License** and inspect certificate, grace, connection, and
   reconciliation status.
2. Restore DNS/routing to the configured Control Plane endpoint if the status is
   `backoff` or `temporary_unavailable`; the Notebook retries automatically.
3. Select **Reconnect** when the instance token is expired or revoked, then
   approve the device claim with the owning Control Plane account.
4. Select **Refresh license** after resolving nonpayment, cancellation, or
   entitlement changes.
5. Resolve local database/runtime blockers shown by Team preflight before
   starting checkout.
6. Contact support with the instance ID, operation ID, and reconciliation reason
   for `support_required`. Do not send workspace data or secrets.

Back up `/data` before manual database repair. Do not delete the local license,
membership, or outbox state to force recovery; operation IDs and outbox records
are required for idempotent reconciliation.

## Compatibility matrix

| Component | First supported version | Required contract |
|---|---:|---|
| Canvas Notebook | `2026.8.1.2` | `canvas-team-seat-protocol-v1` |
| Canvas Control Plane API | `1.0.53` | `canvas-team-seat-protocol-v1` |
| Canvas mobile client | Notebook-mediated | Uses the Notebook API; no direct Control Plane license token |

The supported production pair is Notebook `2026.8.1.2` or newer with Control
Plane API `1.0.53` or newer, provided both advertise
`canvas-team-seat-protocol-v1`. The Control Plane may publish a newer minimum
Notebook version during preflight. If the local version is below that minimum,
checkout and Team mutations remain blocked until the Notebook is updated.

Protocol mismatches fail closed for Team operations without blocking unlicensed
local Solo use. A future protocol version must be added explicitly to both
repositories and their shared fixtures; it is not assumed to be backward
compatible.

## Release verification

Before publishing a compatible pair:

1. run `npm run build`;
2. run `tsx scripts/team-seat-release-verification-test.ts`;
3. verify the same protocol fixtures in the Control Plane repository;
4. verify a production certificate and a separately signed test certificate;
5. confirm that test certificates are rejected in production mode; and
6. perform the visual Team quote and downgrade checks only with explicit browser
   test authorization.
