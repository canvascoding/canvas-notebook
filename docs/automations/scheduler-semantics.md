# Automation scheduler semantics

PostgreSQL bigint timestamps are Unix epoch milliseconds. A startup reader
never guesses whether an ambiguous number is seconds or milliseconds: values
such as `5_000_000_000` are valid early-1970 milliseconds as well as plausible
modern seconds. To backfill a database known in its entirety to use legacy
seconds, an operator temporarily sets `CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT=seconds`.
The transactional migration takes an advisory lock and writes an auditable
completion marker, so it runs once only. Without that explicit source-unit
declaration, stored values are preserved unchanged.

Scheduled automations are intentionally **skip-on-misfire**. The scheduler
allows a 90-second dispatch grace period for ordinary timer jitter. After a
longer interruption, it creates no run for the missed occurrence and moves an
active job directly to its next regular timestamp strictly in the future.
This applies only to clock-driven `scheduled` runs; manual, webhook, and event
runs remain eligible after downtime.

Pausing a job is a transactional queue barrier: all pending or retry-scheduled
runs for that job are terminally neutralized before the pause commits. The run
claim operation locks and rereads its job immediately before changing a run to
`running`, so queued runs cannot start after a pause, deletion, quarantine, or
other non-executable state change. Retry transitions make the same check.

Already-running runs are not force-cancelled because an agent request may be in
the middle of an external operation. A pause keeps their record and permits
their normal terminal transition, but no subsequent queued run or retry may
begin after the job becomes non-executable. A deletion removes its job and run
records immediately; an already-started worker may finish its external work,
but its terminal write is fenced out because its record no longer exists. This
avoids attempting an unsafe in-process cancellation while maintaining a strict
no-new-execution boundary.
