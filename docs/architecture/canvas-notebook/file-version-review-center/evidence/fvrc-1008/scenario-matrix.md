# FVRC-1008 scenario/evidence matrix

Stand: 26 September 2026. This is a source-checked inventory, not an FVRC-1008
acceptance report. The requirements come from `proposal-graph-scenarios.md`
(PG-S/PG-U), `merge-reliability-plan.md` (MR), and the 13 CR IDs assigned to
FVRC-1008 in `todo.json`. Test names below were checked in their source files;
similar wording alone is not counted as a pass.

## Evidence key

- **U** — unit/contract/evaluator test; **C** — component/DOM test.
- **PGlite** — isolated in-process PostgreSQL-compatible database, not real PostgreSQL.
- **PG** — real PostgreSQL with separate backend connections.
- **B** — real browser against the app and APIs.
- **Covered** means the source and available evidence support the stated oracle.
  **Partial** means a related, narrower, or lower-level assertion exists. **Missing**
  means no matching test/evidence was located. A PGlite or refusal-only test is not
  promoted to successful merge evidence.

The 1006 and 1007 browser claims link to their run-specific evidence in
`results.md`; 1008 unit/PG claims link to `hardening-progress.md`. The 1008
progress report explicitly says the full browser matrix and two complete runs
have not yet happened. `proposal-graph-storage-test.ts` is shared by PGlite and
the explicit real-PostgreSQL runner; the two levels are recorded separately.

## PG-S: proposal-graph scenarios

| ID | Required oracle (short form) | Located source/evidence | Status |
|---|---|---|---|
| PG-S01 | P1/Q either order; same final content, two revisions, retain both effects. | U: `proposal-graph-candidate-test.ts` — “disjoint edits preserve manual current content in either independent proposal order”. B: 1006 “C/B”, “all10”, “3+7” cover different fixtures/orders, not P1/Q oracle. | Partial; no exact P1/Q browser pair. |
| PG-S02 | Stale X cannot overwrite P1; same-gap and delete-vs-format conflict. | U: `proposal-graph-candidate-test.ts` — “overlapping replacements, same-gap insertion and changed formats fail closed”; B: 1006 C-first/B-first conflict cases. | Partial; browser covers overlap, not all requested structural subcases. |
| PG-S03 | P2 first includes P1 once; later P1 is included/no-op with one revision. | U: `proposal-graph-candidate-test.ts` — “accepting parent first permits child later…”; B: `file-version-center-graph-flow.spec.ts` — “selected child includes its parent…” and “parent-only acceptance leaves both child alternatives open…”. | Covered for the principal parent/child flows; exact isolated retry count also in action-runtime unit test. |
| PG-S04 | P1, then Q, then P2; only P2 rest-diff and three revisions. | U: `proposal-graph-candidate-test.ts` — “accepted P1=100 then P2=150 forms one net prerequisite…”; B: flow browser checks parent/child rest diff, but not the intervening Q oracle. | Partial. |
| PG-S05 | Rejected parent blocks child; detach creates review-only candidate, no inherited apply. | U: `proposal-action-orchestrator-test.ts` — “branch reject propagates…” and “replace and detach create…”; B: graph-flow reject and `file-version-center-graph-transform.spec.ts` transformation case. | Partial; no direct “reject P1, then P2 detach” browser scenario. |
| PG-S06 | Ordinary siblings remain open/conflict; choice-group sibling becomes alternative-not-selected. | U: `proposal-graph-contract-test.ts` choice/alternative rules; action-runtime “changed choice group…”; B: chosen-child flow closes unchosen alternative. | Partial; ordinary siblings and choice-group contrast are not both browser-tested. |
| PG-S07 | Parent composed once; compatible closure is one batch revision; incompatible siblings block all. | U: `proposal-review-evaluation-test.ts` — “evaluates an exact batch…”; `proposal-action-orchestrator-test.ts` — “accept applies the exact dependency closure once…”; B: 1006 all10 and 3+7 batches. | Partial; no browser three-level/compatible-child batch plus incompatible sibling oracle. |
| PG-S08 | Replacement/alternative keep correct prerequisite; replacement is not made child of old proposal. | U: `proposal-graph-contract-test.ts` — “dependency, replacement and choice are orthogonal…”; `proposal-graph-tools-test.ts` — “replacement and alternative declarations require explicit relationship orchestration”. | Partial; no real-DB/browser replacement-with-alternative graph oracle located. |
| PG-S09 | Rejected replacement does not reopen superseded parent; old child stays blocked. | U: `proposal-graph-tools-test.ts` — rejected/superseded parents cannot be read/extended; orchestrator branch rejection; B: replace and rejected-branch flows. | Partial; no exact R-reject-after-replace lifecycle browser case. |
| PG-S10 | P2 closure chooses P1, closes A branch; P2+A batch rejected before apply. | U: contract alternative rules and action orchestrator closure/choice tests; B: chosen-child flow closes alternative. | Partial; exact mixed P2+A batch no-write oracle is not evidenced in browser. |
| PG-S11 | Historical parent receipt does not prove present prerequisite after removal/revert/restore. | U: contract “historical resolution and currently verified prerequisites remain distinct”; candidate deletion/undo tests; B: no matching live restore/revert sequence located. | Partial; restore/revert browser lifecycle missing. |
| PG-S12 | Proven full effect is metadata-only; foreign equal text is not accepted; net-empty chain stays unaccepted. | U: candidate “independent same effect…” and “empty net chain…”; `proposal-review-evaluation-test.ts` CR-10 proven/foreign identity cases. B: 1006 same-effect case, zero added revision. | Covered for no-op/identity mechanics; no full graph-chain browser oracle. |
| PG-S13 | Child uses identical new block/list IDs after reload/GC; no resurrection or lost marks. | U: candidate “new rich block identities survive restart…” and “stored deltas preserve child anchors across restart…”; collaboration candidate tests use real Yjs. | Partial; no browser reload plus GC/marks proof. |
| PG-S14 | Explicit dependency persists despite disjoint text diff; detach not inferred from non-overlap. | U: dependency/closure tests cover prerequisites; no test title/source located asserting this exact semantic-vs-text distinction. | Missing exact scenario. |
| PG-S15 | Stale preview after direct edit cannot apply unseen rebase; re-preview and click required. | U: fence contract binds current proof; B: 1006 peer sequence and delayed review tests check stale fence/new review. | Covered across contract and real browser, with browser peer edit rather than direct edit. |
| PG-S16 | Concurrent same/different accepts serialize across processes; identical retry receipt, other fence stale; include restore race. | PG: `proposal-graph-storage-concurrency-test.ts` proves separate backend lock timeout, CAS, reservation/restart/idempotency. U: orchestrator retry/fence tests. | Partial; PG test is storage reservation, not concurrent end-to-end review apply/restore. |
| PG-S17 | Accept/reject, replace/accept, child-create/branch-reject have one valid CAS winner. | U: orchestrator branch reject, replace/detach, changed-choice tests; PG: storage CAS/reservation race. | Partial; no real-PG semantic races across these action pairs. |
| PG-S18 | Doubleclick/lost response/reload retries once; changed body with same key fails. | U: `proposal-review-action-runtime-test.ts` exact retry; orchestrator storage idempotency; B: 1006 lost-HTTP-response recovery is one POST/+1 revision. | Covered for accept recovery; changed-body and independent process are lower-level only. |
| PG-S19 | Inject at each live-apply/Yjs/history boundary; restart yields one result/revision, no blind replay. | U: review action runtime recovery and collaboration-agent durability; PG: storage reservation survives backend/service restart. | Partial; no real-PG crash/restart matrix spanning live apply, Yjs persistence, and history finalization. |
| PG-S20 | Delete-only and empty-document deletion recognized despite unchanged state vector; pending delete sets cannot certify. | U: `collaboration-agent-durability-test.ts` — pure deletion/delete ranges, pending deletes, GC/reopen, empty/missing snapshots; candidate proof tests. B: 1006 delete/conflict and empty-effect behavior. | Covered for mechanics/UI, not a single graph-action + real persistent deletion integration case. |
| PG-S21 | Last batch member invalid means no first-member mutation; repeat live preflight. | U: evaluation validates full selection before evidence; action orchestrator apply closure; candidate clone checks. | Partial; no explicit integration test naming final-member failure and proving unchanged live bytes/status. |
| PG-S22 | Review toggle/grant expiry cannot auto-apply open dependency; safe-direct new edit invalidates preview. | U: agent direct grants and policy adapters plus graph tool source gates. | Partial; no end-to-end toggle/expired-grant/open-parent sequence located. |
| PG-S23 | Multi-document change group outcomes separate; graph batch rejects mixed lineages before any mutation. | U: graph tools forged/cross-document scope tests; graph contracts scope guards. | Partial; no two-document Change Group browser/service batch test. |
| PG-S24 | Slow persistence/checkpoint/notification failure remains pending; one eventual receipt/revision; notification retry does not apply. | U/C: 1007 notification-ack component retry; action runtime recovery. B: 1007 Home/Bell reads/ack and 1006 lost-apply recovery. | Partial; no combined slow-persistence + checkpoint-repeat + failed-notification integration oracle. |
| PG-S25 | Closure cannot elevate rights; hidden ancestor data stays undisclosed. | U: runtime/tool tests deny parent/ancestor reads before artifacts; B: 1006 team-permissions and read-loss cases. | Covered for descendant authorization/read hiding; exact replacement/alternative targets not all exercised in browser. |
| PG-S26 | Read/write loss or workspace switch between preview/apply denies and clears stale UI. | U: runtime authorization and client binding; B: 1006 permissions and file/workspace navigation races. | Covered for principal paths; all pagination variants are not combined. |
| PG-S27 | Rename/move keeps lineage; path reuse/copy/workspace cannot inherit graph. | U: scope/lineage identity contracts and query tests; no exact move+path-reuse graph scenario identified in current evidence. | Missing end-to-end identity/reuse test. |
| PG-S28 | Same-generation history restore revalidates; new generation/schema blocks old proposals after reload. | U: contract scope/lifecycle checks; PGlite hardening/query and graph-store migration. | Partial; real browser restore/new-generation/schema transitions not shown. |
| PG-S29 | Required bases pinned during apply; otherwise expired/unavailable, never current fallback. | PGlite: proposal storage retention/pin suite; PG: shared storage suite. U: tools “missing parent… unavailable snapshot never fall back…”. | Partial; real PostgreSQL retention racing a live apply is not evidenced. |
| PG-S30 | Cycles/cross-scope/contradictions/expanded limits reject atomically at and above bounds. | U: contract structural cycles/bounds; PGlite/PG: storage constraints/migration; graph tools cross-scope. | Partial; expanded/decompressed runtime limit and no-partial-node assertion not evidenced at every limit. |
| PG-S31 | Missing/foreign/replaced source proof fails closed; never converted to independent root. | U: graph tools missing parent/CAS/hash/unavailable source; proposal contract legacy roots; candidate proof. | Covered for source/tool guards; no browser source replacement case. |
| PG-S32 | Legacy accept/reject/revert/grant cannot bypass graph; safe independent legacy remains usable; rollback guarded. | U: `file-version-center-hardening-test.ts` / action routes (1006/1007 report); graph orchestrator legacy evaluation binding. | Partial; no full rollback exercise with graph-bound live nodes across every legacy mutation route. |
| PG-S33 | Legacy partial/unproven basis is not promoted to independent root; only safe remainder proved. | U: contract “only fully evidenced untouched legacy…” and “legacy terminal, uncertain…”; graph tools exact source proof. | Partial; no real database migration/browser proof of partial remainder reconstruction. |
| PG-S34 | Markdown structures/Unicode/CRLF/anchors preserved or explicit conflict; no false match/requests. | U: candidate rich marks/frontmatter/Unicode, block move, strict legacy patch tests; markdown adapter tests. | Partial; table/link/CRLF/full-format browser matrix not evidenced. |

## PG-U: UI scenarios

| ID | Required oracle (short form) | Located source/evidence | Status |
|---|---|---|---|
| PG-U01 | Editor/file menu/chat/notification opens same P2 selection with closure and choice visible. | B: 1007 editor/file browser, chat widget, Home/Bell reports; exact successor selection; `file-version-center-graph-flow.spec.ts` child selection. | Partial; common entrypoints tested, not all four with the same P2+alternative fixture. |
| PG-U02 | Keep selected child/focus after parent acceptance and peer edit; stale approval disabled. | C + B: `file-version-center-graph-peer-sequence.spec.ts` — exact P2 selection/focus/rest diff; 1006 browser `u02-r12`. | Covered. |
| PG-U03 | Closure/choice and branch-reject bind displayed descendants; changed set requires reselection. | U: orchestrator branch-reject closure; B: branch-reject flow. | Partial; no browser race where descendant set changes after review selection. |
| PG-U04 | Slow compare, switch proposal/file/workspace; late response/pages cannot cross identity. | U: compare-service page binding; B: graph.spec delayed B→C and navigation spec file/workspace races (1006 results). | Covered for principal proposal and navigation races; second-page race is contract/unit only. |
| PG-U05 | Historical included/rejected/superseded stays exact/read-only; alternatives never silently selected. | B: 1007 replaced link, rejected child, included history; notification/chat entrypoint results. | Covered for named lifecycle cases; missing-content explanatory state not explicitly evidenced. |
| PG-U06 | Lost apply response shows pending/recovery, polls status, no second apply. | U: action-runtime/orchestrator recovery; B: `file-version-center-graph-flow.spec.ts` “lost HTTP response recovers…” one apply. | Covered. |
| PG-U07 | Offline/local edits retained and synchronized; late edit invalidates fence. | B: `file-version-center-graph-peer.spec.ts` exact late offline edit survives reconnect; 1006 `final-r14-late-peer`. | Covered. |
| PG-U08 | Read/compare rights separate from restore; access loss clears cache. | B: permissions spec / 1006 team-permissions browser evidence. | Covered for team review/read-loss path; separate restore=false/review=true control is not clearly named in browser oracle. |
| PG-U09 | 320/390/768/1280 layout, 200% zoom, scrolling/sticky footer no clipping. | B: responsive spec and 1006 natural-flow reports measure bounds/visible area; evidence says viewport/DPR emulation, not native zoom. | Partial; native 200% zoom semantics not established. |
| PG-U10 | Keyboard/AT/light-dark/reduced-motion/touch; labels and focus live updates. | C+B: responsive spec and 1006 reports test DOM semantics, keyboard, touch, focus, Reduced Motion, locales/themes. | Partial; no manual/native screen-reader run (explicitly disclaimed in evidence). |
| PG-U11 | Missing/false/true rollout config across Personal/Team and never-opened doc. | U: rollout tests; B: Personal/Team flows and entries. Production flag remains fail-closed per 1008 progress. | Partial; missing/false/true matrix and never-opened-document case not evidenced together. |
| PG-U12 | Paginated branch with off-page root; exact selection/visible counts; grouped notifications ack only after authorized open. | B: 1006 page26 +27th freeze; 1007 Home/Bell grouped review/ack and branch notification tests; C: timeline/summary pagination. | Partial; no single browser case combines off-page root, replacement/reload, Home/Bell ack, and bounded payload. |

## MR-01..MR-24: merge reliability

| ID | Required oracle (short form) | Located source/evidence | Status |
|---|---|---|---|
| MR-01 | Ten independent proposals, 3 then 7 in multiple orders, identical final outcome. | B: 1006 Personal/Team 3+7 and all10; U: candidate either-order disjoint merge. | Partial; exact ten-item sequence in multiple browser orderings not reported. |
| MR-02 | 10→3 singles→7 batch produces exactly 4 content revisions. | B: 1006 `final-r14-personal` and `final-r9-team`; 1008 `ordinary-r4` additionally creates ten independent roots through real ordinary `read`/`edit_file` tools, then accepts H→C→A plus seven together. Exact A1..J1, +4 revisions, stable closed retry even with graph off, no second write. | Covered; ordinary tool run is Personal/host development, not a production-image gate. |
| MR-03 | Direct batch of all 10 gives one logical revision. | B: 1006 `final-r9-all10`, exact one batch/+1. | Covered. |
| MR-04 | One 10-change proposal applies whole unit; evidenced legacy partial remainder only. | Related U: candidate and agent partial-apply durability tests; no exact ten-part graph proposal/legacy-rest test found. | Missing exact scenario. |
| MR-05 | Moved target and unrelated insert/delete remain anchored. | U: candidate rich block move/text compose; CR-04 identity rebase test. | Partial; no full browser move/insert/delete combined oracle. |
| MR-06 | Disjoint same-block edits compose; true overlap conflicts. | U: candidate rich/text composition and overlap tests; B: A/B/C overlap cases. | Partial; same-block disjoint case not explicitly in browser. |
| MR-07 | Same-gap/moves/parent changes/preconditions have no silent winner. | U: candidate same-gap/delete-vs-format/move; graph relationship and fence tests. | Partial; not real DB/browser concurrency. |
| MR-08 | Delete/recreate equal text cannot revive target. | U: `proposal-review-evaluation-test.ts` CR-05, actual Yjs identities. | Covered at evaluator/unit level only. |
| MR-09 | Parent-first and child-first converge, no parent replay. | B: 1006 parent-first/child-later, selected-child-includes-parent reports; U: candidate and orchestrator closure. | Covered for two supported orders, exact fixture not P1/P2 business text. |
| MR-10 | Reject/replace/restore losing parent effect blocks child. | B: branch reject/replace; U: candidate lost prerequisite and graph lifecycle. | Partial; restore-loss browser case absent. |
| MR-11 | Shared ancestor once, alternatives never in same apply closure. | U: action orchestrator exact closure/choice; B: selected-child closes unchosen alternative. | Partial; no successful multi-child shared-ancestor batch browser oracle. |
| MR-12 | Conflicting full batch no mutation; explicit safe subset needs own preview/fence. | U: batch evaluation and action-fence selection binding; B: conflict “Review all” proves no action/write. | Partial; successful conflict-free subset preview/apply not evidenced; refusal is not merge success. |
| MR-13 | Proven contained/empty effect explicitly resolves with zero content revision. | U: candidate/evaluator satisfied vs foreign identity; B: 1006 same-effect case no added revision. | Covered for satisfied effect; empty-effect browser branch not reported. |
| MR-14 | Legacy basis/artifact missing/metadate-only reports upgrade/unavailable, never fabricated merge. | U: contract legacy-root and tool unavailable source checks; PGlite query/hardening. | Partial; exact missing/different-base review UI/browser case absent. |
| MR-15 | Changed current/graph invalidates old accept; new diff and click required. | U: compare service current/graph binding; B: 1006 peer, delayed-response and navigation cases. | Covered for ordinary current changes; exact graph-only changed fence not browsered. |
| MR-16 | Two tabs/users, payload-bound idempotency, lost response/restart once. | U: action runtime/orchestrator exact retry; PG: storage reservation/CAS restart; B: one lost-response recovery. | Partial; no real-PG two-reviewer apply race or combined restart after live mutation. |
| MR-17 | Rename/move retains lineage, delete/recreate not; exact links stable. | B: 1007 exact historical link/replacement/reject flows; U: scope identity guards. | Partial; rename/move/path reuse browser case not located. |
| MR-18 | Personal/Team/readonly/foreign owner/hidden parent/revoked/cross-workspace rights. | B: 1006 team rights/read-only/loss; U: graph tool/runtime scope/auth tests. | Partial; exact full rights cross-product and hidden-parent browser assertions not evidenced. |
| MR-19 | Multi-page frozen selection excludes later arrival and late responses. | B: 1006 page26 freeze/27th remains open; delayed selection/navigation tests. | Covered for the bounded 26/27 case; combined navigation+multi-page selection is not reported. |
| MR-20 | Diff pages remain bound to exact evaluation and no hidden edits can be approved. | U: `proposal-review-compare-service-test.ts` — “follow-up pages are bound to evaluation, exact selection, current proof and graph revision”; client rejects mismatch. | Partial; browser diff-pagination fence not identified. |
| MR-21 | Distinct diagnostics, redacted copy, no false null-diff/leaks. | U/C: review client redaction, compare/summary route errors; B: 1006 diagnostics and conflict-vs-transport cases. | Partial; matrix of every reason code/hidden-parent rights not fully evidenced in browser. |
| MR-22 | Desktop/mobile/DE/EN/themes/keyboard/AT/all entrypoints coherent. | B: 1006 responsive plus 1007 notification/editor/chat entrypoints. | Partial; no native screen-reader claim; P12 resolution editor excluded. |
| MR-23 | Two complete suites, no 429, separated roles, expired/corrupt auth/provider-offline. | 1006/1007 reports document serialized individual runs and error collector; 1008 says two full runs still required. | Missing FVRC-1008 full-gate run. |
| MR-24 | Toggle on/off preserves opens/default safe_direct and stricter org policy. | U: policy adapter, rollout and agent-grant tests; no corresponding full graph UI+policy transition browser case found. | Partial. |

## FVRC-1008 additional CR scenarios

The IDs below are exactly the 13 CR IDs assigned to FVRC-1008 in `todo.json`;
P12-only CR IDs are not included.

| ID | Required oracle (short form) | Located source/evidence | Status |
|---|---|---|---|
| CR-01 | A=100, B=120, C=130; accept C first; B stays visible conflicted, no refresh loop. | B: 1006 `file-version-center-graph.spec.ts` C-first fixed oracle; `results.md` records concrete unselected B conflict, text 130, +1 revision. | Covered. |
| CR-02 | Same fixture B first; C also concrete conflict; order gives no preference. | B: same spec B-first; `results.md` records text 120, C conflict, +1 revision. | Covered. |
| CR-03 | B/C disjoint edits inside same block both compose when proven independent. | U: `proposal-review-evaluation-test.ts` uses two independent authoritative roots in one Yjs text block; A→B, B→A and batch produce exactly `A=10 B=20`. Each evaluation preserves live bytes; a true overlap conflicts. Passed in `review-projection-r3`. | Covered at evaluator/Yjs level; no separate browser ordering pair. |
| CR-04 | Insert/move a block before target; identity, not stale line number, anchors edit. | U: `proposal-review-evaluation-test.ts` — CR-04 preceding insertion/rebase via Yjs identity; preserved independent content. | Covered at evaluator/unit level, no browser case. |
| CR-05 | Delete target and recreate same text; do not match by text. | U: same evaluator file CR-05; result conflicted/no action. | Covered at evaluator/unit level, no browser case. |
| CR-06 | 10 independent effects, 3 singles +7 batch; exact 4 revisions. | B: 1006 Personal and Team reports; 1008 `ordinary-r4` uses real ordinary tools and no prebuilt proposal nodes, fixed A1..J1 content/+4 receipts and revisions. | Covered; production-image/full-matrix repetition remains part of the open gate. |
| CR-10 | Proven identity containment is “already present”; foreign same-looking text is not approved/replayed. | U: evaluator CR-10 paired Yjs cases; B: 1006 same-effect case proves no extra revision for contained second proposal. | Covered across evaluator/browser, but foreign identity remains unit-only. |
| CR-12 | Batch B+C/exclusive alternatives has no arbitrary winner/partial mutation. | U: action closure/choice/fence tests; B: conflict review-all verifies no action and content stays exact. | Partial; no successful choice/resolution action is in P10; reject-only evidence is not a merge. |
| CR-16 | Doubleclick/timeout/lost response/restart recovers one effect/receipt. | U: action runtime/orchestrator retry/recovery; PG: durable reservation survives service/connection restart; B: 1006 lost response +1 revision and one POST. | Partial; restart evidence is storage-only, not restart after actual live apply. |
| CR-17 | Read-only/access loss/foreign parent/workspace switch never grants write or leaks data. | B: 1006 team permission case + navigation; U: runtime/tool ancestor authorization and cross-scope guards. | Covered for read-only/write-fence/access-loss and cross-scope unit checks; foreign-parent browser disclosure case not explicit. |
| CR-18 | Legacy lacks basis/artifact or has different bases; explain cause, do not claim merge. | U: contract legacy classification and graph-tool unavailable-source tests. C: `file-version-center-graph-review-test.tsx` verifies explicit unavailable-content and unverifiable-basis messages, no accept/diff and redacted details. Fixtures model unproven legacy sources, not provably independent graph bases. | Partial; exact missing/different-base browser case remains open. |
| CR-21 | Multi-page batch freezes shown IDs; later proposal and delayed response cannot change selection. | B: 1006 page26/27 freeze; delayed selection and file/workspace response races. | Covered as separate browser cases; no single combined all-three race. |
| CR-22 | Network error/conflict/missing basis differ; copied diagnostics redacted and no fake zero diff. | C: `file-version-center-graph-review-test.tsx` distinguishes unavailable content, unverifiable source, two-ID batch conflict and transport failure; expands/copies details and proves no accept, legacy fallback, fake zero diff, content/hash/token/raw-error leakage. B: 1006 conflict/transport evidence. | Covered at component/contract level; full CR-22 browser matrix including missing basis remains open. |

## Acceptance gaps that remain material

1. No two complete serial FVRC-1008 browser-suite runs have been recorded; there is
   no full matrix/build/commit/image binding. Current 1006/1007 runs are valuable
   but cannot be renamed as the 1008 gate.
2. The 10→3→7 and all-10 browser successes are real merge evidence, but do not
   cover every semantic variant in PG-S/MR (notably same-block disjoint edits,
   dependency/alternative cross-products, legacy partial remainder, move/path reuse,
   restore/new-generation, and toggle transitions).
3. Real PostgreSQL evidence currently establishes storage migrations, CAS, locks,
   durable reservations, and restart at the storage boundary. It does not establish
   two-process end-to-end review apply races or crash/recovery at each live-apply,
   Yjs-persistence, and history-finalization boundary.
4. PG-U10/MR-22 are automated DOM/keyboard/touch/theme/localization checks, not a
   native/manual screen-reader or native 200%-zoom acceptance run (1006 evidence
   explicitly limits those claims).
5. Refusal coverage is not a substitute for positive multi-merge coverage. In
   particular, conflicted “Review all” no-write behavior supports CR-12 safety but
   does not prove an accepted conflict-free selected subset or manual resolution;
   manual resolution belongs to P12.

These are evidence gaps, not assertions that the corresponding product behavior
is necessarily incorrect. FVRC-1008 remains in progress in `todo.json`.
