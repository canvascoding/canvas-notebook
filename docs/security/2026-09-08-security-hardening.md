# Security hardening — 8 September 2026

Baseline: `c9635796` (2026.9.8.1). This record covers the September review and its implementation. The [July remediation record](2026-07-29-security-review.md) remains historical evidence for its own findings; closed July items are not automatically open again.

## Scope and status

Priority is abuse without an account. External document content remains untrusted even when an authenticated user opens it in good faith. HTML preview and PDF must preserve public external images, fonts, CSS, scripts, modules and relative resources. Terminal and agent Bash are explicitly deferred by the owner; the baseline already includes the newer terminal-disable changes.

| Package | Finding / work | Implementation status | Production status |
| --- | --- | --- | --- |
| 1 | S5: unverified cookie rate-limit identity; public abuse limits and negative access checks; HTTP disconnect crash | Implemented and locally verified (`f90801dd`) | Not deployed or verified |
| 2 | S2: PDF cookies sent to external resources; browser job isolation | Implemented and locally verified (`0db1aabe`) | Not deployed |
| 3 | S2/S3: isolated HTML documents, restricted/revocable preview tickets, renderer network boundary | Implemented and locally verified | Not deployed |
| 4 | S4: personal default workspace and owner-only legacy migration | Implemented and locally verified | Not deployed |
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

## Package 3: isolated HTML documents and renderer network boundary

Each PDF job owns a forward proxy as well as its browser context. HTTP and HTTPS connections resolve through the existing public-address validator; the proxy dials the validated numeric address, preserving the HTTP Host and HTTPS TLS/SNI handshake. Every new connection, including a redirect destination, is checked. Only standard HTTP(S) ports are eligible. Private, loopback, link-local, metadata, multicast, documentation and IPv6 translation/tunnel destinations are rejected. IPv6 is restricted to ordinary global unicast, closing NAT64/6to4/Teredo bypasses in the shared validator.

The context applies its proxy to page, frame, worker and HTTPS/WebSocket network activity. Chromium's implicit local-address proxy bypass is explicitly removed with `<-loopback>`; QUIC is disabled and WebRTC is configured to disable unproxied UDP. Chromium hostname resolution is disabled so the proxy owns public DNS decisions. The browser's unused default context has a nonfunctional proxy instead of direct network access. Proxy sockets are bounded, time out, and close with the job. The transitional cookie-bearing fetch from package 2 has now been removed. A job-scoped virtual document origin is served directly by the ticket provider through this same proxy, including requests from local workers. It cannot issue arbitrary internal HTTP requests.

Verification:

- `npm run test:security:pdf-network`: 14 private/special address cases, four CONNECT rejection cases, mixed public/private DNS answers, an actual pinned public HTTP connection under a simulated second-lookup rebinding result, and real Chromium image/frame/fetch/Blob-worker/WebSocket probes including a redirect to a private target. The private recording server receives zero requests. A public HTTPS image with redirect and HTML-based PDF export remain functional.
- The network regression disables only Chromium's independent Local Network Access prompt in its test process, ensuring requests exercise the production proxy. It preserves the proxy policy and production proxy flags. The older credential suite separately replaces its test browser's proxy settings to retain controlled loopback recording servers; it does not serve as evidence of network isolation.
- Existing safe-external-fetch, browser-export queue and PDF credential regression tests passed. Production build, TypeScript and changed-file lint passed.
- The rebuilt native app passed the same authorized HTML share-dialog/download UI check with the network boundary enabled and normal production flags. Public image, local SVG, relative module and JSON text are present; both downloaded PDF pages remain pixel-identical to the preceding UI reference. As before, the resource guard rejected an attempt during high machine load and the successful run used unchanged limits.

This is an application renderer network boundary, not an operating-system sandbox or a claim about the separate interactive agent browser/Marp subprocess. The separate interactive agent browser and private Marp CLI subprocess are outside this renderer boundary.

Implementation references: [Chromium proxy bypass rules](https://chromium.googlesource.com/chromium/src/+/main/net/docs/proxy.md#implicit-bypass-rules), [Puppeteer context options](https://pptr.dev/api/puppeteer.browsercontextoptions).

### HTML origin and file authority

Authenticated workspace and Studio HTML preview routes now issue a short-lived opaque ticket and redirect to a dedicated hostname. The existing mobile ticket URL contract redirects to that same delivery service. The preview host exposes only GET/HEAD on `/__preview/:ticket/*`; app APIs, WebSocket upgrades, authorization headers and cookies are rejected or stripped. App requests originating from preview documents are denied at the HTTP boundary. The main app allows its configured preview origin in `frame-src`; documents retain scripts and same-origin access within their isolated origin so modules and workers continue to work.

HTTPS authentication uses the host-only `__Host-better-auth.session_token` cookie. The explicit custom name is configured without Better Auth's automatic second prefix; other OAuth cookie names retain their existing convention. This prevents a sibling preview hostname from replacing the app session with a domain cookie. Existing HTTPS sessions require one new login after deployment. HTTP local development retains the existing cookie name.

Tickets contain no app session cookie or bearer token. The process stores only a SHA-256 token key, session/user/workspace IDs, document kind, expiry and a finite allowed file set. Each read checks the real current session, account ban/seat state and read access to the persisted workspace; Studio files also retain their media access and real-path checks. Expiry is at most 30 minutes and never exceeds the originating session. Signing out or disabling the workspace revokes access on the next request. Export tickets are revoked in `finally`. Stores are bounded to 16 tickets per session and 1,024 globally; they are process-local, so deployments with multiple app workers need affinity (a different worker fails closed).

The allowed set is the document's declared local dependency graph: HTML attributes, CSS imports/URLs and JavaScript string references, recursively parsed without execution. Relative and root-relative resources are retained. Dynamic references may expand a specifically named document subdirectory into a finite set, with file/source/depth bounds. Unknown runtime paths and whole-workspace expansion receive no authority. A declared JSON/text dependency is intentionally accessible to the document; this is not a claim that a document cannot name another known file as a dependency. This boundary limits ambient app/workspace authority while preserving explicitly referenced document assets. Fully dynamic filenames at the document/workspace root must also appear as declared dependencies; there is no fallback granting every file.

### Deployment contract

Before rollout, provision DNS and TLS for `preview.<app hostname>` pointing to the same ingress. An existing different hostname can instead be configured with `CANVAS_HTML_PREVIEW_ORIGIN=https://documents.example.net` in the deployment environment and managed CLI configuration. A different port on the same hostname does not qualify. IP-addressed deployments require an explicit preview hostname. The portable and legacy Caddy templates generate the restricted preview vhost and remove credential/Set-Cookie headers. Custom proxies must implement the equivalent vhost restrictions. Do not deploy until that hostname is reachable; failure is closed and there is no same-origin HTML fallback.

No DNS records, production servers or containers were changed. Local verification used temporary self-signed certificates (not installed in the OS trust store), local Caddy on port 3443 and the native app against the existing managed PostgreSQL fixture.

### Full document verification

- `npm run test:security:html-preview` passes: declared dependency graph, dynamic directory bounds, root-relative rewriting, origin validation, actual HTTP vhost/credential boundaries, HTTPS cookie naming, real SQLite session expiry/revocation and disabled workspace checks.
- Updated PDF credential tests pass with the ticket-provider interface. The independent network suite still records zero private HTTP/worker/WebSocket requests while public HTTPS resources load. Caddy tests cover the default and custom preview hostname and invalid same-host/insecure choices; both generated TypeScript and legacy shell configurations pass actual `caddy adapt`.
- The production build contains `/__preview/[ticket]/[...path]`. TypeScript and changed-file ESLint pass. Auth identity and public routing regressions pass.
- Authorized Playwright verification on two HTTPS hostnames passes with the managed PostgreSQL fixture: login, HTML viewer/share dialog, public image and redirect, local SVG, root-relative ES module/JSON, classic worker plus `importScripts`, mobile redirect and PDF download. Actual browser request headers contain no app session on the preview origin. Parent DOM access, credentialed app API access, session-cookie replacement and unlisted file reads are denied. Web/mobile tickets return 404 after sign-out.
- The two exported PDF pages contain the external image and dynamically populated content and remain pixel-identical to the preceding renderer reference. Both the PDF raster and share-dialog screenshot were inspected visually. Only the newly created QA files were removed.
- The older `mobile-files-test.ts` has a pre-existing SQLite/Excalidraw failure (`no such function: hashtext` in the collaboration transaction helper). The same failure was reproduced using its pre-change version from `dd3da799`; it is not reported as a passing suite. Its obsolete preview assertions were updated, and the new standalone preview suite supplies executable coverage for those boundaries.


## Package 4: personal defaults and legacy recovery

Requests without a workspace ID now resolve the authenticated user's persisted personal workspace through the ordinary SQLite/PostgreSQL records and permissions. They no longer manufacture a personal context for the shared `DATA/workspace` directory. Explicit workspace selection retains the existing access checks.

An explicit `legacy-personal-workspace` request can return only a read-only recovery context to the current primary organization's persisted, non-banned owner. A claimed admin role or bootstrap email is insufficient. Recovery denies writes, deletion, public links and agent execution in the old root. Existing owner agent sessions carrying that legacy ID resolve to their persisted personal workspace instead; other accounts are rejected before receiving a filesystem context. Terminal and Bash implementations are unchanged.

PostgreSQL now performs the same source-preserving owner import already used by SQLite. The import checks owner identity and the target personal workspace, retains the old directory, preserves current destination files, and stores name conflicts under the existing timestamped `_legacy-workspace-import` directory. The existing migration marker prevents duplicate imports. Unimported residual files remain available through the owner's read-only recovery context. The database connection is released before the separate recovery check, avoiding pool starvation. If a stored owner row is missing, organization bootstrap fails instead of substituting the requesting account.

Verification:

- `npm run test:security:workspaces` passes against disposable SQLite storage. With `TEST_DATABASE_URL` pointing to a local PostgreSQL server, the same command creates and drops a separate test database and passes the same account isolation/recovery assertions. Two ordinary account IDs get separate default roots and files; forged admin claims, cross-account workspace IDs and explicit legacy agent IDs do not grant access. Owner files, source files and conflicting versions remain readable. SQLite additionally simulates a corrupt imported database with a missing owner and verifies rejection.
- The complete existing PostgreSQL workspace API suite passes, including personal/team reads, downloads, permissions and membership changes. Its stale file-count assertion was corrected to include the already-existing `Erste Schritte.md` starter document in a new team workspace. Authentication setup, workspace foundation and Notebook workspace-state tests pass.
- The standalone preview-ticket regression still passes. The older agent session/file-operation suite reaches the same pre-existing SQLite `hashtext` collaboration failure as the pre-change resolver from `357ffe18`; no changes were made to that unrelated transaction code.
- Production build and changed-file lint pass. The authorized HTTPS browser check confirms file creation/read without an explicit workspace header, owner-only read-only legacy recovery, HTML preview with external image/local module/worker, mobile redirect and ticket revocation. Its repeated PDF request correctly received the existing high-load 503 while the host was heavily loaded; the preceding package 3 PDF render remains the successful image/layout reference, and final export verification follows dependency work. Before the native check, the local legacy fixture was inventoried (9 files, 64 bytes); migration retains those source files.
