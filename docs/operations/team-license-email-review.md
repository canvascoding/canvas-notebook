# Team license email delivery review

An email job enters `manual_review` when the SMTP outcome is unknown, including a lost response after `DATA` or an expired sending lease after a worker interruption. The worker never retries this state automatically. License changes continue independently of email delivery.

The active organization owner opens the Team license health panel. Its **Uncertain email delivery** section lists each unresolved job with a masked recipient, event kind, attempt count, review time and job ID. The panel is owner-only; other members cannot call the review API. The email provider's delivery logs should be checked against the job time and recipient before a decision. If provider evidence is inconclusive, leave the job in `manual_review` and seek provider support; do not guess.

- **Confirm delivered**: Provider evidence proves the message was accepted or delivered. The job becomes `delivered`; the worker does not send it again.
- **Not delivered – queue retry**: Provider evidence proves the message was not accepted. The job becomes `pending` and re-enters the normal worker's retry process. Confirm that the warning still applies before selecting this action.
- **Do not send**: The message is obsolete or should be suppressed after review. The job becomes `skipped`.

Each decision requires a confirmation in the owner UI and writes an audit event with the actor, job ID, event kind, prior attempt count and decision. A second or concurrent decision for the same job is rejected; reload the panel. The UI never sends email directly. No Stripe or license state is changed by these actions.
