# Central email review and recoverable delivery

## Intended journey

Agent-created email proposals remain persisted until a person sends or rejects them. Home, notification center, agent links, and the email application open one review host mounted at the application root. Selecting a proposal opens its formatted, editable body and complete addressing inside the same queue dialog. The sender mailbox is explicit. Users can save, postpone, reject, or approve and send; successful decisions advance to the next proposal.

## Delivery policy and recovery

- Enforce the current mailbox `sendTo` allowlist for agent/automation outbox proposals, including To, Cc, and Bcc, even when a person confirms delivery. The repository currently has allowlists, not a separate denylist. Preserve manual-compose policy semantics.
- Record blocked recipients and an actionable error on the persisted proposal. Link to the existing email settings. A policy change or corrected recipient can then be followed by an explicit retry against the current policy and draft version.
- Keep failed messages in the application's Outbox / Failed view. This is a durable application queue, not a provider-specific IMAP move.
- Distinguish failed delivery from an uncertain result after dispatch; do not offer blind retries where delivery may already have occurred.
- Enforce optimistic concurrency, prevent editing or rejection while sending, preserve Bcc and attachments, and refresh every entry point after changes.

## Ordered implementation milestones

1. Delivery backend: durable error metadata and migration, policy enforcement, safe state transitions, detail and rejection APIs, and isolated regression tests.
2. Shared review client/store and global host: full queue, selected draft, formatted editing, explicit sender, unsaved-change protection, recoverable errors and failure filter.
3. Connect email application, notification center, home, and agent/deep links to the host. Compact actions open or reject proposals and share refresh events.
4. Validate functional tests, production build, and browser journeys on desktop and narrow viewports. Browser automation was explicitly authorized. No real mail should be sent during verification.

Each milestone is completed and checked before proceeding to the next. Commit completed milestones separately. No container build or external delivery is part of this implementation.

## Acceptance checks

- Personal and workspace drafts open from every entry point with the intended draft selected.
- Formatting, sender, To/Cc/Bcc, subject, and attachments survive save/reopen.
- Rejection is versioned and removes the proposal from actionable queues without sending.
- Blocked To/Cc/Bcc recipients result in a persistent, informative Outbox failure, with settings navigation and correction/retry.
- A failed send refreshes the version; simultaneous decisions and sending locks do not duplicate delivery.
- Post-delivery finalization failures are not presented as safe-to-retry failures.
- The complete queue is independent of notification preview limits.
- Unsaved edits are protected when selecting another draft, closing, or navigating away.
- Successful decisions advance the queue and synchronize notification/home/email counts.

## Verification completed

- Backend delivery/policy, PostgreSQL migration, and shared review-store regression suites passed.
- Existing email context-intent, reading-flow, and notification regression checks passed.
- Six Playwright journeys passed against the current host development server: desktop editing/rejection, policy correction/retry, workspace delivery, mobile uncertain delivery, email-app deep links, and Home/notification actions. Email writes were mocked; no real mail was sent.
- Targeted ESLint and the production build, including TypeScript, passed. The build reports environment-dependent direct-MCP OAuth configuration warnings because no base URL is supplied to the build process.
- The email-app entry remains available when no mailbox is connected. Failed proposals therefore remain accessible during account repair.
- Implementation and final integration were independently reviewed by sub-agents. No container was built or deployed.
