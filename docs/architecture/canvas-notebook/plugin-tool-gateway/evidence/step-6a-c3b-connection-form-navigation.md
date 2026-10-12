# Step 6a-c-3b — connection form navigation

This gate completes the SharedConnectionForms dirty-state and local dialog-navigation checks deferred by 3a. It covers web forms and their existing global guard; OAuth return behavior and native clients remain separate.

## Source contract

`SharedConnectionCreateForm` registers scope/provider/mode, name, endpoint, hidden token, OAuth choice, app and profile inputs as unsaved state. `SharedConnectionEditor` registers current metadata, responsibility, access/tool limits, grants and staged target/right/tool choices, selected account and repair configuration/secret inputs. Both use `pending:false`: a form's general busy state also includes reads and intentional authorization navigation.

`SharedConnectionsSection` retains the actual API-mutation counter as pending authority. User Escape/X cannot close a dialog during an outstanding write; otherwise closing requires the existing discard confirmation. Manual section/editor Reload also confirms before resetting or reading. Programmatic successful Save closes and refreshes directly. A 409 retains the local form and disables Save until explicit Reload; no compensating write is issued.

## Focused React checks

`scripts/shared-connection-navigation-ui-test.tsx` mounts the real Parent, Forms, Intl, Radix dialogs and PluginNavigationGuard with controlled safe HTTP DTOs. Its default run passed dirty hidden/staged inputs, cancelled Escape/X/Reload, scope/history fences, the actual Parent pending counter with one held PATCH, successful programmatic close, retained 409 and German labels. It does not exercise server authorization or provider behavior.

The background header/scope harness callbacks are invoked directly while Radix hides the modal background. They test guard consumers, **not** a user clicking behind an actual modal. Native browser Back is covered separately below. Four unsupported test-only `exact` locator options were removed without changing the string-name expectations; the final default run and focused ESLint passed.

Root's eight workspace UI gates passed. Final sequential whole-tree TypeScript and focused ESLint exited **0**. The final production build passed: `/tmp/canvas-plugin-ui-6ac3b-final-build.log`.

## Actual production browser

`tests/plugin-connection-form-navigation-local.spec.ts` passed **2/2**, EN and DE, using one Chromium worker and no retries in **15.3 seconds**. Log: `/tmp/canvas-plugin-ui-6ac3b-browser-final.log`.

Root verified the own host PID/command/CWD, numeric loopback port **3001** and health **200** before the run. The fixture used real authenticated HTTP responses, no API route mocks and no synthetic application data. Request observation confirmed no connection, profile, environment or workspace mutations. Unsaved connection inputs survived cancelled local close and native browser Back; accepted discard cleared them.

Eight EN/DE PNGs covered **1280/390**, light/dark. Field fit and focus were asserted; Root inspected four representative images. This does not establish native/Mobile behavior or live external-account connectivity.

## Open OAuth boundary and final bookkeeping

The separate command `node --import tsx scripts/shared-connection-navigation-ui-test.tsx --oauth-pending-regression` remains **RED**, with its `expected false` assertion unchanged. Log: `/tmp/canvas-shared-connection-oauth-pending-regression.log`.

It injects synchronous `beforeunload` at the actual clean `location.assign` call. The existing Parent counter's pending state has not yet reached its React layout update, so the injected event is prevented. That counter/redirect ordering predates 3b. **Native browser navigation timing is unknown**; neither an actual OAuth failure nor OAuth acceptance is claimed. This remains a required open 6b regression, not a passing 3b assertion.

The final full GitNexus index passed in **177.4 seconds**: **62,906 nodes, 169,950 edges, 2,756 clusters and 300 flows**, after the test-only type fix and final build redo.

- Final staged projection: **67 symbols in nine files, LOW, zero additional affected flows**. Cumulative comparison with `main`: **4,623 symbols in 446 files, 16 earlier flows, CRITICAL**; the branch-wide warning was reported and the expected current source/fixture scope reviewed.
- Root stopped the own primary test host after checking its PID/command/CWD and numeric loopback listener. Its session exited on SIGTERM; the foreign managed stack remained untouched. Only generated GitNexus documentation blocks were restored.

No containers or foreign stack were changed by this gate. Step 6b Planning/Mobile/OAuth and step 7 live external-account rollout remain pending. The integration gateway flag remains default off; no live Canva or deployment acceptance is claimed.
