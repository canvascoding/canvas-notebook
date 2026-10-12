# Step 6b-e-4 — Isolated Mobile render API diagnostic

The third isolated API diagnostic completed normally on 10 October 2026. All eight exact shared-source Render requests returned HTTP200 before and after eleven minutes without MCP traffic. The earlier 44.5-second request and the Run9 render timeout were **not reproduced**; their underlying cause remains unproved. This is an API/fixture diagnostic, not a native acceptance or a product-fix claim. **6b-e-4 remains in progress; 6b-f and Plan7 remain pending.**

## Scope and source

The explicit `run-workflow-mobile-render-repro` mode uses one new owned PostgreSQL/DATA fixture, a local Notebook host built for production, a controlled real HTTP MCP/SDK provider and the existing controlled Team issuer. Ordinary Owner and Manager sign-in, Organization/Team connection APIs and actual gateway `app_view` dispatch create four real persisted tool-result sources. Render requests keep the exact saved descriptors, actors, scopes and Team workspace header. No browser, device, OAuth callback, external provider account or agent/model turn is exercised.

Only new API diagnostic fixtures have a fixed **30-minute** budget, set once before their setup. Original diagnostic deadlines are unchanged. The native Worker180/Parent190-minute budgets and product 20-second MCP timeouts are unchanged; the diagnostic HTTP observer may wait at most 60 seconds per request. No existing fixture is resumed or adopted.

Default-off instrumentation records only fixed phase/subphase names, numerical request/span/parent-span values, elapsed time, finite outcomes/error classes and an explicit row-limit marker in its privately owned sink. Separate diagnostic ALS spans observe each existing operation once, including both repeated dispatch guards; they do not alter authority, cache, signals, retries or SDK operations. Finishing a ticket disables inherited background diagnostics. Private runtime paths have tracing annotations; no claim connects those annotations to build duration.

## Earlier attempts remain retained

| Attempt | Actual result | Evidence boundary |
| --- | --- | --- |
| Repro1 | Parent exit1, preserved; Worker failed at Session setup with no observations or trace | The new worker incorrectly expected a Web-style `data` envelope from Mobile Session POST. Its later source correction reads the actual top-level `session` and records the returned ID before further checks. The original failed attempt is unchanged. |
| Repro2 | Parent exit1, preserved; four warm Render200/CSP/source checks, no idle phase | Warm elapsed44,513/12,061/5,789/4,285ms. The first ticket trace recorded initial-source13,416ms, resource-read23,494ms, final-source6,978ms and host-bundle3ms. The original20-minute budget could not retain the required eleven-minute idle plus cleanup reserve. That budget failure is not an idle/reconnect failure. |
| Repro3 | Whole launcher exit0, Parent cleaned; eight Render200/CSP/source checks and normal cleanup | New fixed30-minute fixture, with bounded subphase instrumentation. Details below. |

The expired Run9 native fixture, its failed/partial cases, the original Run9 source/render diagnostic and both earlier API diagnostic attempts remain separate historical evidence. None is replaced by Repro3.

## Repro3 measured API results

| Actor | Exact connection scope | Warm Render | Cold Render after idle |
| --- | --- | --- | --- |
| Owner | Organization | HTTP200 / 4,154ms | HTTP200 / 3,647ms |
| Owner | Team | HTTP200 / 4,681ms | HTTP200 / 3,786ms |
| Manager | Organization | HTTP200 / 3,274ms | HTTP200 / 3,353ms |
| Manager | Team | HTTP200 / 4,989ms | HTTP200 / 2,979ms |

Every observation has Source GET200, unchanged exact saved-source/current-connection evidence and a verified host CSP. The idle interval measured **660,022ms**. The provider's MCP request counter stayed **40 before and after** that interval; source calls4, actions0, model calls0, resource reads4 and verification probes1 also stayed equal. The idle check performs only the separate control-state read, with no MCP RPC or user probe during idle.

Final controlled-provider totals were **52 requests, four source `app_view` calls, zero `app_action` calls, zero `model_only` calls, eight resource reads and one separate model-verification probe**. That verification probe is not an agent/model turn or external provider acceptance.

The shared-access spans in the complete warm traces were approximately 500–1,100ms and repeated four times per render. This identifies repeated authorization work but does not establish the earlier 44.5-second latency cause or justify a resolver/cache/timeout change.

## Trace limits

The unchanged trace limit is 32 requests, 512 rows and 512KiB. Each warm render produced 87 rows; complete ticket records exist for requests1–5. Row512 marks `rowLimitReached:true` during request6/final-source/source-saved-receipt. Later cold subphase traces are incomplete. A missing completion after this explicit cap is **not hang evidence**. All four cold HTTP/CSP/source observations remain independently verified by the worker.

## Normal closure and gates

The worker ended `diagnosed_closed` with verified domain cleanup, ordinary sign-out/session-null, closed contexts and closed seeders. Its acknowledged sessions and sources were deleted. Parent ended `cleaned`, with `databaseDropped:true`, `dataRemoved:true`, `mobileRenderReproClosed:true`, `mcpAppProviderClosed:true` and `uncertain:false`. Root independently verified absence of all seven owned process IDs and the owned3001 listener. These are this new diagnostic's closure results; they do not alter the failed Run9 native closure.

The exact frozen source passed 23 focused trace/privacy cases, full TypeScript with an 8GiB heap, eight-file zero-warning ESLint, the Mobile contracts/host/shared MCP matrices, runner syntax and diff checks. Independent source review found no remaining concrete blocker.

The production build exited0. Its Turbopack cache-persistence compression warning remains recorded; successful exit0 does not erase that warning. Source/build checks do not establish native, external-provider, production-deployment or overall acceptance. The strict Mobile audit remains unchanged **RED:23 HIGH / zero CRITICAL**.

## Retained provenance

Root's private controller retains the original recovery/worker/trace artifacts and append-only frozen-source/gate/build/final records. The final record was checked at **2026-10-10T17:28:43.658Z**. Its source hashes match the frozen build and gate records; no credential body, raw ticket, OAuth state, connection reference or private auth-session identifier is copied into this document.

| Artifact | SHA256 |
| --- | --- |
| `render-repro-third-attempt-final-1.json` | `b99f64b7dd2a54666e39a7166c0fa6d041a1e2b4c4c86a09bffec332d7ac8ed5` |
| Production build log recorded by `subphase-build-result-1.json` | `db392cd0d774ed38b9c4ff74ed8e0b3d994e655b286ff2156cc35ef62d1090cc` |

The final record explicitly keeps `earlier44513msLatencyReproduced:false`, `idleReconnectFailureReproduced:false`, `underlyingEarlierLatencyCauseProven:false`, `nativeAcceptance:false` and `seal:false`. A fresh complete native16-case acknowledgement, natural-model6b-f and controlled rollout7 remain outstanding.
