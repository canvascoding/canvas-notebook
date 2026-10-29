# Editor peer status: one current authorization phase

The authenticated editor peer previously ran a complete `canRead` phase followed
by a complete `canWrite` phase for each healthy writer status check. This repeated
original-header authentication, license/seat/workspace reads, schema validation,
policy locks, owner checks and transaction completion without an intervening
consumer or mutation.

Status now uses the fixed, callback-free owned observation. Its genuine
Principal holds the policy rows through the initial/final Current and COMMIT.
The peer checks the freshly resolved workspace write permission and the actual
immutable original transport permission ceiling. Quarantine still permits
read-only diagnosis. A copied read transport cannot become a writer through
ticket claims. The separate fresh `authorizeWrite` phase immediately before
live apply remains unchanged, including its canWrite Principal and completion.
No permission result is retained for a subsequent check or mutation.

## PostgreSQL verification

Actual Cookie and Bearer status checks each use **47 SQL statements / 9 pool
checkouts**, compared with **94 / 18** before this change. Initial/final Current
still run; the duplicate Principal phase is removed. The qualified previous
implementation fails the new phase-count assertion with four Current calls
instead of two.

The owned-peer suite passes 31 cases, including original permission ceilings,
revoked write permission, quarantine diagnosis, read tickets, real conflicting
row locks, token rotation, owner/realm drift, final authorization and disposal.
The existing native transport suite passes 35 cases, retaining its SQL budgets,
same-connection self-revocation, native lifetime and final-owner checks.

Two old owned-peer test hooks required correction: compatible SHARE readers
were incorrectly expected to conflict, and a broad catalog-query match fired
before the intended closed-Principal window. An archived `e6cae33c97` product
and original test reproduce the first failure. Adding a genuine competing
FOR UPDATE row lock and matching the actual final binding observation makes
all 25 original cases pass on that unchanged product. Denial and recovery
assertions remain in place. The transport result comparison also checks the
new inert original-permission field explicitly.

Release TypeScript, expanded TypeScript (3619 roots / 8858 sources, zero
diagnostics) and ESLint pass.

## Complete editor measurement

Sequential real HTTP/WebSocket/Yjs runs use the same existing measurement
windows and ten ordinarily uploaded source documents. The baseline is archived
`e6cae33c97`, with its own compiled native addon and decision models. No other
test or build runs during these measurements.

| Runtime window | SQL before → after | Checkouts before → after | Wall time ms before → after |
| --- | ---: | ---: | ---: |
| Cold session, socket and initial projection | 760 → 697 | 110 → 98 | 960.67 → 886.27 |
| Held owner, 6100 ms after opening | 1220 → 782 | 233 → 151 | 6101.99 → 6100.35 |
| Warm save through physical checkpoint 1 | 594 → 401 | 114 → 73 | 2729.08 → 2684.34 |
| Warm save through physical checkpoint 2 | 585 → 462 | 112 → 89 | 2751.21 → 2652.68 |
| Warm session and second real peer | 829 → 739 | 122 → 102 | 815.55 → 802.71 |

These broad runtime windows include concurrent background work. The held-owner
window is not a steady-state idle-load claim, and its duration is fixed by the
test. This pair demonstrates lower observed SQL and checkout counts; it does
not establish production latency percentiles. Both runs verify native identity,
durability and physical file contents and finish without failed SQL statements.

The read/create budgets, 10/200-document final matrix, real latency/concurrency
acceptance and the other performance-plan packages remain open. Current-source
host/Linux startup, UI, `test:all`, CI/review, production backup/restore and release
acceptance are still required. Review Center and Undo development remain excluded.
