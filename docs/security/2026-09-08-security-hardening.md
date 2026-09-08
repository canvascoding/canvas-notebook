# Security hardening — 8 September 2026

Baseline: `c9635796` (2026.9.8.1). This record covers the September review and its implementation. The [July remediation record](2026-07-29-security-review.md) remains historical evidence for its own findings; closed July items are not automatically open again.

## Scope and status

Priority is abuse without an account. External document content remains untrusted even when an authenticated user opens it in good faith. HTML preview and PDF must preserve public external images, fonts, CSS, scripts, modules and relative resources. Terminal and agent Bash are explicitly deferred by the owner; the baseline already includes the newer terminal-disable changes.

| Package | Finding / work | Implementation status | Production status |
| --- | --- | --- | --- |
| 1 | S5: unverified cookie rate-limit identity; public abuse limits and negative access checks; HTTP disconnect crash | Implemented and locally verified (`f90801dd`) | Not deployed or verified |
| 2 | S2: PDF cookies sent to external resources; browser job isolation | Implemented and locally verified | Not deployed |
| 3 | S2/S3: isolated HTML documents, restricted/revocable preview tickets, renderer network boundary | Pending | Not deployed |
| 4 | S4: personal default workspace and owner-only legacy migration | Pending | Not deployed |
| 5 | Dependency advisories, targeted updates | Pending | Not deployed |

## Package 1: public limits and request boundaries

The old limiter trusted the raw session cookie. A different invented cookie produced a new bucket. The replacement uses a user ID only after Better Auth and the seat guard have verified the session. Otherwise it uses the socket address or a cryptographically attested address from the managed proxy. Ordinary Cookie, Authorization, X-Forwarded-For, X-Real-IP and X-Canvas-Proxy-* input cannot manufacture a new identity. Private route counters remain process-local, bounded to 20,000 active buckets; shared public counters use atomic SQL on both SQLite and PostgreSQL.

Public setup, invitation, render, webhook and OAuth registration operations have endpoint-wide and per-client budgets. Invitation/share/webhook targets have an additional hashed resource budget. Shared counters fail closed if the database is unavailable. Setup checks whether an owner exists before validating/hashing credentials and retains the transactional creation check. Setup/invitation JSON is capped at 16 KiB while streaming; these exact routes bypass Next's middleware body clone so the cap runs before large upload buffering. Adjacent routes retain the middleware guard.

Concurrent identical public Markdown PDF requests share an in-flight job, after each request's share and limit checks. No completed output is cached. Existing renderer concurrency, queue and timeout limits remain active.

A real HTTP regression test additionally reproduced a process exit when a client cancelled a rejected POST response. Next's middleware body clone replaces the request event table; a later socket abort could become an unhandled error. The custom HTTP boundary catches rejected route promises and restores request error handling at response completion/close. Unexpected global errors still terminate the process; disconnect handling is limited to the request.

### Ingress rollout

`server.js` is the supported app entry point; it establishes request-local identity before routing. Managed Caddy templates overwrite client identity headers and supply a purpose-specific HMAC derived from `CANVAS_INTERNAL_API_KEY`; the root internal API key itself is never placed in proxy headers. The app strips the attestation header before invoking route code. The public address uses Caddy's direct remote peer (`{remote_host}`), not an untrusted forwarded header. With an additional CDN/load balancer in front of Caddy, clients currently share that upstream's transport address until that ingress is explicitly configured and verified.

Portable Linux CLI install/update synchronizes recognized Canvas Caddy sites using the existing validate/apply/rollback implementation. Non-Linux and separately managed Caddy configurations are preserved. Custom ingress and legacy shell deployments must apply the updated template (`canvas-notebook caddy-reload`, or the legacy Caddy sync command) and verify distinct clients as part of deployment. Absent a valid attestation, the app uses its actual socket peer, which is safe against header forgery but can share limits behind an old proxy. This work has not modified a production host or built a container.

### Access matrix reviewed

This is an explicit inventory of the reviewed public boundaries, not a claim that every repository route was penetration-tested.

| Surface | Intended authority | Reviewed rejection boundary |
| --- | --- | --- |
| Login/setup pages, health, mobile compatibility, OAuth discovery | Anonymous public metadata | No user/workspace content; setup mutation additionally requires empty instance state |
| Better Auth endpoints | Endpoint-specific credentials/session/OAuth | Better Auth validation and its own limiter; trusted transport address replaces arbitrary forwarded input |
| Invitation preview/activate/accept | Valid invitation token plus endpoint-specific activation/session/origin checks | Client/global limit before expensive work; bounded body; hashed token quota |
| `/p/*`, `/public/files/*`, `/public/view/*`, Markdown assets/export/PDF and Marp preview | Active public share token | Share validation before file/render work; PDF/Marp additionally limited |
| Mobile HTML preview | Short-lived opaque preview ticket | Invalid token rejected; broader ticket scope/revocation addressed in package 3 |
| `/api/automations/webhooks/:id` | Trigger's bearer secret | Secret verification before execution; ID rotation cannot renew client/global quota |
| `/api/automations/execute`, scheduler queue/execute | Canvas internal token | Secret validation before dispatch/queue work |
| File, integration, admin, agent configuration, license mutation | Session and endpoint-specific workspace/admin entitlement | Missing/invented credentials rejected before operational work |
| Direct MCP and OAuth registration | OAuth access token / public registration contract | Existing OAuth guard; registration gains shared public abuse limits |

### Verification evidence

- `npm run test:security:public`: forged cookies/forwarded headers, separate clients, canonical IPv4/IPv6, verified users, real Better Auth cookie/bearer sessions, expired/revoked sessions, one-time setup, streamed body cap, coalescing, middleware body boundary and HTTP abort regression.
- `npm run test:security:public:postgres`: uses `TEST_DATABASE_URL` for an explicitly configured local test database. Four independent OS processes race 80 requests against a budget of 25; exactly 25 succeed. SQLite runs the same test in an isolated temporary database.
- `npm run test:security:public:http`: localhost-only test against the built custom server. 48 protected requests with absent/fake cookie/fake bearer credentials are rejected, invalid share/preview tokens return 404, 12 setup attempts with forged identities admit at most 5 and block at least 7. With the local fixture login, a second valid session retains the same exhausted user budget. Cancelled response bodies no longer stop the process. Web file routes intentionally retain their existing cookie-only proxy policy; real bearer identity is tested directly through Better Auth.
- Existing Caddy portable tests and actual `caddy adapt` accept the generated header configuration. Cross-platform CLI tests verify proxy synchronization before update success and rollback on synchronization failure. Authentication setup/seat and invitation route regression tests passed.
- Production `npm run build`, TypeScript, changed-file ESLint and diff checks passed. Playwright UI checks confirmed anonymous redirect to login, successful login into the Notebook workspace, and an unclipped mobile login at 390 × 844. Desktop and mobile screenshots were visually inspected; the temporary browser sessions were signed out and closed.
- GitNexus impact/diff analysis reports critical breadth for the shared limiter (246 direct users in the initial index). The reviewed changes match the intended auth, public limit, request boundary, ingress, test and documentation scope. No terminal/agent-Bash symbols were edited.
- PostgreSQL/HTTP tests used the existing managed local stack and private fixture environment. Credentials are not stored in this record or test source.

No production ingress test or public-host penetration test was performed. Global limits bound expensive admitted public work; they do not promise immunity to volumetric network attacks.


## Package 2: PDF credentials and browser contexts

The URL renderer no longer uses global `setExtraHTTPHeaders`. An internal preview request is eligible only for GET/HEAD, the fixed loopback app port from `PORT`, the recognized workspace/Studio preview prefix, the verified workspace ID and normalized path segments. Conflicting workspace query parameters, other APIs, encoded traversal and external origins never receive the session. The incoming request Host/port no longer selects the internal render port.

For eligible requests a server-side intermediary retrieves the preview with the session and workspace header, with redirects disabled. It supplies the response body to Chromium and removes `Set-Cookie` and transport headers. This also closes the session-refresh edge case: passing a Cookie only via per-request CDP headers was insufficient when a preview response set an HttpOnly session cookie in Chromium. Redirect destinations are reevaluated as new requests and never inherit the server fetch credentials. Pending internal fetches have a timeout and are cancelled when the export ends. The intermediary is transitional; package 3 replaces its session authority with a restricted preview ticket.

Every URL and HTML PDF job creates its own browser context and closes it in `finally`. Timeout cleanup still disposes the stalled browser. Cookies/cache/storage are not shared with another job. Page size, margins, print CSS, emoji fallback and asset wait conditions are unchanged. Context isolation alone does not implement a network sandbox; renderer egress and full document isolation remain package 3.

Verification:

- `npm run test:security:pdf` starts controlled internal and external HTTP servers with dummy credentials, including a session-refresh `Set-Cookie`, redirect, external SVG/CSS/webfont/background, relative image, ES module and JSON data. The baseline reproduced both credential leakage and persistent localStorage. The fixed renderer denies credentials to external resources and unrelated app APIs and leaves no context/cookies behind after consecutive jobs and a failed navigation.
- `TEST_PDF_TIMEOUT=1 npm run test:security:pdf` additionally exercises an unresponsive script and verifies context cleanup after timeout.
- Because the two controlled servers are loopback endpoints, the credential test disables Chromium's separate Local Network Access prompt only in its own temporary test process. Production launch flags receive no relaxation. This is a credential regression test, not an SSRF test. Public Internet compatibility is also checked separately in the app UI with normal production browser flags.
- The two-page reference PDF includes all images, external font, dynamic module/JSON text, emoji and a print page break. Both rendered pages remained pixel-identical to the baseline. This was checked using Poppler output, text extraction and visual inspection.
- Existing browser-export queue tests and the rich Markdown PDF export (callout, details, table, formula and footnote) passed. Production build, TypeScript and changed-file lint passed.
- The built app's actual HTML viewer/share dialog and PDF download passed an authorized Playwright check with normal production Chromium flags. A public HTTPS image (including its redirect), a relative SVG, an ES module and relative JSON all loaded. The downloaded PDF contains both expected print pages, the public image and dynamically populated text; its rasterized pages and the dialog screenshot were visually checked. Only the four newly created QA files were removed afterwards. An earlier attempt correctly received the existing high-load rejection; no resource limits were relaxed for the successful run.
