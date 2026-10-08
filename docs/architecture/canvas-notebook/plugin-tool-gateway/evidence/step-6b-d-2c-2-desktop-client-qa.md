# Shared Composio desktop client QA inventory

Gate 6b-d-2c-2 exercises the production editor with controlled provider/desktop boundaries. Actual OS browser consent remains gate 6b-d-2c-3. Browser QA uses a fresh built host on loopback 3001 and its own nonce database, DATA and issuer through the fixed managed-stack-aware launcher; it never restarts the other agent's stack.

| User-visible behavior | Functional evidence | Visual state |
| --- | --- | --- |
| Older desktop capability requires an update before connecting | No Start POST and no browser IPC | Update feedback, no pending controls |
| Shared Org/Team app uses the original profile and connection | Actual auth/SQL/SDK gate; browser exact editor and captured context | Correct scope, selected editor |
| No-auth setup reloads its actual connection | Exact noAuth response, zero browser IPC | Pending controls removed after confirmed setup |
| Start acknowledgement can be held or lost | Guard exists before POST; no replay; explicit Cancel by intent | Pending/check/cancel controls stay visible |
| Missing browser acknowledgement remains unconfirmed | No implicit Cancel or second Start; explicit recovery | Unconfirmed feedback, pending controls |
| Cancel is conclusive | Terminal same-flow response/readback; late Start SDK0 | Pending controls removed only after confirmation |
| Completion requires the same original flow | Lost Finalize ACK recovers through GET; verified receipt wins over Cancel | Reloaded connected state only after proof |
| Changing user/session/workspace/reference invalidates late work | React races and Electron sticky cookie/frame A/B/A tests | No stale feedback or mutation in replacement editor |
| MCP behavior remains compatible | Existing personal/shared launcher/client/HTTP regressions | Existing MCP dialog behavior |

Two deliberate off-path checks are missing Start acknowledgement followed by early Cancel, and cookie/frame navigation returning A/B/A while a launch waits. Screenshots contain static editor state and feedback, without provider URLs, raw states, tokens or account identifiers. Test results and acceptance status are appended after the gates complete.

## Focused gates verified before browser acceptance

- Actual native PostgreSQL local and controlled Managed matrices passed with durable early cancellation, terminal state/intent recovery, late cancelled Start after flow retention, exact completed proof and final original-session checks. Two actual migration replays per mode preserved transactions, receipts, cancellations, connections and grants. Both acknowledged fixture databases and DATA/TMP were independently absent after normal DROP.
- Actual Better Auth/Session SQL/CommonStore/SDK HTTP harness passed. Its external seat/license issuance boundary is explicitly isolated. The SDK's known NPM version metadata request is counted and blocked; all other external requests remain forbidden. Start captures one actual identity, callback collects with zero SDK/auth calls, completed recovery reads only the exact account and preserves binding/receipt, and browser start retains its original contract.
- Twenty-four controlled Electron launcher/preload checks passed across MCP personal/shared and Composio adapters. New client and actual React/store/race matrices passed, alongside existing MCP client, HTTP and React regressions. These controlled transports do not prove actual OS browser opening or consent.

## Final acceptance

The final production build and post-build TypeScript passed. Focused source lint passed; the only new fixture lint finding was corrected from a never-reassigned `let` to `const`. Existing Next tracing warnings remain. Both independent peer reviews found no blocking cancellation/API/client mismatch.

The fixed production-host Playwright run passed all three scenarios in 8.8 seconds, one worker and no retries. The actual host used an acknowledged own native database, real bootstrap authentication and real non-billable license issuance/activation, an inert owning-Org Composio key, actual profile/Common connection creation and catalog/editor/status reads. Only exact own Desktop Start/status/Cancel and browser IPC were deliberately controlled. The no-auth toolkit was genuinely no-auth in provider metadata; readiness was reloaded through actual endpoints. Lost Start and opener acknowledgements retained the attempt until explicit Cancel, then actual status and editor reopening stayed truthful. Full connection/default agent snapshots remained unchanged and no PI session was created.

Root inspected the three static screenshots under `/private/tmp/canvas-agent-settings-browser-guZ6Pd/results`. The browser receipt is `verified_closed`, `completedCases=3`, `outstanding=null`, with Start=2, status=1, Cancel=1, bridge=1 and forbidden requests=0. The parent receipt and own license issuer both acknowledged normal cleanup. Independent maintenance readback verified all ten acknowledged own databases across this gate's native and browser runs absent, every native/browser DATA/TMP absent and both browser host/issuer processes absent. Foreign OrbStack listeners on3100/55433/4001/4004 remained unchanged.

Private logs: `/tmp/canvas-composio-desktop-6bd2c2-{native-final-fenced,http-verified,client,react,mcp-http,mcp-client,mcp-react,electron,build-final,postbuild-typecheck}.log`. The original and final focused lint logs are separate; the corrected fixture lint passed. Source/index and staged/compare graph review are recorded with the final commit.

Fresh staged GitNexus review reports31files/333symbols and four expected Start/AuthSecret processes, MEDIUM. Whole-branch comparison against main reports545files/22processes, CRITICAL; Root warned the user before committing. This separate gate commit does not establish whole-branch merge readiness.

Step 6b-d-2c-2 is accepted. Actual Electron/system-browser consent and Organization/Team native acceptance remain the separate next gate, 6b-d-2c-3; live provider, Mobile and production acceptance remain later gates. The gateway stays default-off.
