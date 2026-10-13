# 404 acceptance inventory

Target: the current worktree's dev server at `http://127.0.0.1:3000`.

| User-visible behavior | Functional check | Visual evidence |
| --- | --- | --- |
| Branded guest 404 with Bradley and working login action | Unknown DE/EN URLs return 404; logo/artwork/product links target the product site; sign-in opens the local login | Guest desktop light screenshots |
| Responsive light/dark layout | Heading and recovery controls fit at 1440×900 and 390×844 without horizontal overflow | Guest desktop dark and mobile light/dark screenshots |
| Signed-in recovery without promotion | Actual bootstrap UI login, then 404, home click and history back | Signed-in desktop and mobile screenshots |
| Neutral checking/failure states | Delay/fail only the session request; promotion stays absent | Session-unavailable screenshot |
| Existing authentication remains enforced | Protected settings opens login with the original query retained | Login form and URL assertions |
| Back has a direct-entry fallback | History back returns to login; a fresh tab falls back through home to login | Actual button interactions |
| Public `notFound()` uses shared view | Invalid public share returns 404 with the recovery view | Public-share browser assertion |
| Localized `notFound()` uses the shared view | Signed-in visit to `/en/browser/live` without a view identifier | Signed-in localized fallback screenshot |
| Expired session and nested missing route recover | Invalid cookie resolves as guest; nested unknown page returns 404 | Guest dark screenshots |

Exploratory cases: filenames containing dots, an unsupported locale, a missing localized browser view, keyboard focus, and a narrow 320px viewport. HTTP checks and source audits cover API authentication, onboarding and all 27 guarded pages separately.

Browser traces, videos and saved authentication state are disabled. Credentials come from the private local environment. These checks do not establish production or physical-device acceptance.

## Verification

- `npm run test:not-found`: passed; anonymous routing, API denial, spoofed/unsafe return paths, expired cookie, setup/onboarding and all 27 protected pages.
- Mobile-bearer, invitation-public-route and Studio Bulk policy regression scripts: passed.
- Full `npm run build`, including the production TypeScript check and required prebuild checks: passed. Targeted ESLint checks and `git diff --check`: passed.
- `npm run test:not-found:e2e`: all 9 cases passed against the dev server. The signed-in case was then extended to cover localized `notFound()` and passed again.
- Visual review: guest and signed-in, desktop/mobile, light/dark screenshots; no clipped controls or horizontal overflow. At 320px, the page scrolls vertically while keeping the recovery actions visible.
- Exploratory browser checks: dotted filenames retain English; unsupported locale falls back to German; a fresh tab's Back action reaches home/login instead of `about:blank`.
- Keyboard Tab navigation reaches the recovery controls with a visible focus ring; recorded in `guest-de-keyboard-focus.png`. The dev server was restarted after the build and the final guest preview returned 404 again.

The build reports broad file-tracing warnings in unrelated runtime modules (for example `app/lib/dictation/runtime-install.ts`); these files were not changed by this task.

The global fallback uses Next.js's experimental `globalNotFound` option because the app has multiple root layouts. Unmatched URLs returned HTTP 404; a matched page's late `notFound()` can retain HTTP 200 once Next.js has started streaming.
