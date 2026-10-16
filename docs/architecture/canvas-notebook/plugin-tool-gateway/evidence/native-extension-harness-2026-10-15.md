# Native extension acceptance harness — 15 October 2026

This document records the prepared acceptance boundary. It does **not** claim a completed iOS or Android run. The existing Web/Kimi acceptance remains separate.

## Exact entry points

From the isolated Mobile checkout, capture the native module source hash immediately before each official native build wrapper starts, and again after its successful build:

```sh
node scripts/chat-extension-native-e2e.mjs --native-source-hash
```

The command reads source files only. Both hashes must match. Preserve that build-time hash in the private device configuration. Build/install and owned Metro/device preparation are explicit prerequisites; the acceptance driver does not create devices or build binaries.

From the Notebook feature checkout, after source review and build/install:

```sh
CANVAS_NATIVE_EXTENSION_DEVICE_CONFIG=/absolute/private-device-config.json \
  node scripts/run-plugin-extension-e2e.mjs --chat-native
```

The device file must be an owned regular file, mode `0600`. Its shape is:

```json
{
  "version": 1,
  "mobileRepo": "/absolute/isolated/canvas-notebook-mobile",
  "applicationId": "app.canvasnotebook.mobile.dev",
  "scheme": "canvasnotebook-dev",
  "deviceOwnershipPath": "/absolute/private/canvas-chat-native-devices-OWNED/owned-devices.json",
  "metro": { "port": 8089, "pid": 12345 },
  "ios": {
    "udid": "EXACT-OWNED-SIMULATOR-UUID",
    "name": "Canvas Chat Extensions Acceptance",
    "expectedVersion": "0.1.4",
    "expectedBuild": "ACTUAL-BUILD",
    "nativeSourceSha256": "BUILD-TIME-SHA256"
  },
  "android": {
    "serial": "emulator-5588",
    "avdName": "canvas_chat_extension_acceptance",
    "adbServerPort": 5038,
    "expectedVersion": "0.1.4",
    "expectedBuild": "ACTUAL-BUILD",
    "nativeSourceSha256": "BUILD-TIME-SHA256"
  }
}
```

Values above are schema examples, not an existing device or build receipt. iOS device names must identify an owned Canvas Extensions simulator; Android AVD names must identify an owned `canvas_...extension...` emulator. The driver verifies installed version/build, exact device identity, the owned Metro listener PID/cwd, native source provenance, and frozen feature hashes before and after each phase. Android reverse mappings are created and removed only for the selected owned emulator; existing mappings are never replaced.

## What must actually pass

The fixed Notebook mode owns one nonce PostgreSQL database, private DATA root, fresh production build/host, license fixture, OAuth consent fixtures and controlled SDK model transport. Preparation uses normal package import/publication, MCP configuration, Composio profile/OAuth, and session APIs. iOS and Android run sequentially.

Actual Maestro UI interactions must demonstrate unified `/` search/filter for all four kinds; exact package pin and MCP dependency mapping; explicit Composio profile/account choice; native text deletion and operating-system Undo; process-restarted public drafts; send/history retention; and ordinary retyped captions without authority. Agent phases must demonstrate Create, Skill Edit, package connection-policy authoring and own per-user connection choice through the real native screens.

The parent verifier independently reads the owned SQL namespace and genuine `readOwnedAcceptedChatMessage` handles. It checks original CIDs exactly once, full public bodies, immutable pins, required mapping/supporting-selection equality, exact personal account bindings, stored history, execution success and model usage. It also checks the actual SDK request’s public package and exact provider-route metadata, plus native-created agent configuration and own preferences. JUnit, native screenshots and accessibility hierarchies are required; receipt flags alone are insufficient.

Controlled SDK transport proves UI → WebSocket → durable execution → SDK context delivery. It does not prove external LLM reasoning, provider business operations, physical-device behavior or production rollout. Passive logo loading and fallback must be assessed from actual native artifacts; provider reachability is not inferred from a binding.

## Safe own connection labels

The shared workflow descriptor previously returned the generic `Personal Composio connection` / `Personal MCP connection` after a successful choice. The metadata projection now uses an already verified own target. MCP shows its saved display name. Composio shows the toolkit, current owned profile name and `Account <10 hex characters of SHA-256(accountId)>`. A full account ID is not promoted to the primary label.

Friendly provider account names are not persisted locally, and the existing metadata cache explicitly excludes accounts. The label therefore does not pretend to retain a friendly provider account name and does not fetch accounts merely for presentation. Names are bounded and control/format characters removed. Existing foreign-owner rejection, current actor/workspace verification, inactive-profile handling and unknown provider readiness remain in force. The exact account remains part of the actual selected private binding and its public selection identity.

## Code/API verification recorded before device acceptance

`NODE_ENV=test node --import tsx scripts/agent-workflow-own-connection-label-test.ts` passed with PGlite. The same script with `--native` passed against its guarded nonce PostgreSQL fixture (`CANVAS_SHARED_CONNECTION_POSTGRES_TEST=1` and the managed local maintenance URL passed privately in the environment). Both exercise the actual Agent writers, own preference, scoped authenticated Mobile workflow reader, ownership isolation, rename/sanitization/archive behavior, forged-proof rejection and saved MCP name. Provider metadata is permitted only at the controlled selection transport; subsequent presentation reads must make zero metadata requests. Full account IDs remain valid technical selection identity and are not used as the primary label.

Focused TypeScript checking of the harness, regression and actual transitive product graph and focused ESLint passed. These checks are separate from a full-repository TypeScript gate and from real native UI completion. The full repository emitted diagnostics in other script files; they have not been established as a clean-HEAD baseline here.

The prepared native phase order is Chat → Agent Create → standalone Skill Edit → Plugin package policy → My Connection on iOS, followed by the same sequence on Android. Package policy adds only the published `composio:canva` alternative, keeps the exact original MCP target and tool cap as the explicit default, preserves required child/declaration identity, and checks a canva-only personal rule without capturing an account in the central policy. The independent proof requires all ten real phase receipts.

## Canonical overlap boundary retained

The public body codec deliberately rejects conflicting complete entries for the same exact selection identity. A required MCP supporting a Plugin and an independently optional mention of the identical MCP would conflict. The native four-kind acceptance therefore creates **two genuine separately configured/OAuth-authorized MCP connections**: one required package mapping and one standalone reference. The parent verifies both current configurations and their separate completed, currently bound OAuth lifecycles, without a provider probe. This demonstrates the valid distinct-connection path; it is not acceptance of every overlapping-reference UX. No codec rule is relaxed for this fixture.

The source-only native hash CLI was also checked in an owned temporary source fixture: generated build outputs leave the hash unchanged, a real Kotlin source edit changes it, and a foreign source symlink is rejected. This check uses no simulator, emulator or server.

## Fresh first login and retained restart state

Before Maestro starts, the driver also requires `deviceOwnershipPath`: an owned `0600` regular JSON file in an owned `0700` `canvas-chat-native-devices-*` directory. Its `version:1` receipt must match the configured iOS UDID/name and Android serial/AVD name/ADB port exactly. A device-name pattern alone is insufficient. The parent verifier repeats these checks.

Only the first Chat phase clears the fixed development app’s state to prevent a previous nonce session at the same loopback server from contaminating login. On the explicitly owned synthetic iOS simulator, that first phase also clears the **device-wide** keychain; Maestro2.8.0 exposes no app-scoped keychain reset. This scope is explicitly authorized for that owned simulator. Android does not clear a device keychain. Later Agent phases and `reopen-chat.yaml` do not clear state or keychain, preserving the actual draft/history restart proof. Installed Maestro YAML command contracts and `check-syntax` are checked before execution.

Feature manifests also cover `src/i18n/copy.ts`, `src/generated/open-source-notices.ts`, `package.json` and `app.config.ts`, in addition to the feature directories, generated public codec, native module sources, runner and flows. Native generated build directories are excluded from every hash layer.

## First complete-run preparation failure

The first actual run (`/private/tmp/canvas-plugin-extension-e2e-pZvAH0`) completed its fresh production build and TypeScript checks, then stopped during normal Plugin import with HTTP400. No Native phase had started. The host's real child-skill parser rejected `workflow.integrationCapabilities.0.application`: the fixture used the display label `Native MCP`, while the canonical contract requires a lowercase application slug. Cleanup recorded `failed_cleaned`, `databaseDropped:true` and `uncertain:false`.

The preparation now uses `createNativeExtensionWorkflow` with `application:'native_mcp'` and canonical validation before writing the declaration. `node --import tsx scripts/chat-extension-native-fixture-test.ts` passed through the real Plugin manifest, child-skill and YAML parsers. It checks both exact alternatives and their required tools, missing-connector rejection, and continued rejection of the old display label. Focused ESLint and transitive TypeScript checks passed. The parent SQL/context/Native-artifact requirements and product validation were not relaxed. This correction requires a new owned acceptance run; it is not Native completion evidence.

## Second preparation failure and focused real API gate

The second complete run (`/private/tmp/canvas-plugin-extension-e2e-Slk0av`) also completed its build and stopped before Native UI. Normal Plugin import/publication succeeded; immutable standalone Skill publication returned HTTP400 because the fixture omitted `metadata.version`. Cleanup again recorded `failed_cleaned`, `databaseDropped:true` and `uncertain:false`. The shared standalone fixture now declares version1.0.0.

`scripts/chat-extension-native-preparation-test.ts` exercises the actual authenticated import/publication routes and SQL with PGlite and guarded nonce PostgreSQL, without a production build. Both passed: normal Plugin/Skill imports, both immutable publications, continued rejection of the old unversioned Skill, two real owned MCP OAuth callbacks, actual profile/two Composio connection callbacks, the legacy Agent writer with the stored model selection, all four search kinds, exact Chat/Agent package and standalone/account choices, and real Session201. The Composio consent completion in this focused API test is controlled preparation; real Native/browser consent and Native UI remain separate acceptance requirements. Model and provider business execution stay zero.

The gate also caught two additional preparation assumptions before another full build: legacy child-skill readiness needs the exact declared connector name, and the central Agent package chooser needs a real approved MCP definition. Preparation now stores the original package MCP under that connector name, associates its actual organization when it is first created, publishes the exact definition through the normal admin API, and assigns its genuine definition ID before OAuth. The separate standalone MCP remains a separate configuration and OAuth lifecycle. Required declarations, tool restrictions, immutable pins and exact personal mappings remain unchanged.

Unexpected preparation responses now produce a bounded owned0600 diagnostic containing only phase/path/status/public error code, byte count and SHA256. Raw response bodies, messages, tokens, accounts and OAuth queries are not written. The parser regression verifies that private response values do not enter this diagnostic. A temporary PG-monitoring alarm was an exit/log-read ordering error: a sequential read confirmed the full PASS sentinel; no SQL or early-exit defect was established.

## Existing-session deep link and explicit Android transport

The third complete run (`/private/tmp/canvas-plugin-extension-e2e-jI2YLw`) passed preparation and reached actual iOS interaction. It stopped at the first Plugin search result. Its Chat link omitted the existing-session `agentId` hint that the app's normal session navigation supplies. The current Chat screen consequently displayed Bradley and sent that mismatching expected target to the scoped picker. `NEW THREAD` itself is the normal empty-session label. Cleanup recorded `failed_cleaned`, `databaseDropped:true` and `uncertain:false`; no retrospective SQL result is claimed after that cleanup.

The real Runner now includes the exact Agent and Workspace in its encoded Chat URL. It asserts `Session201.agentId` and independently checks the owned stored Session/User/Agent/Workspace before Native launch. The Session201 public contract does not contain a Workspace field, so the Workspace assertion reads the real persisted row. The focused guarded PostgreSQL gate passed with this added check; server target fences remain authoritative.

Android Maestro `test` and `hierarchy` use the official explicit loopback host and direct device adbd port. For `emulator-5554` this is `--host127.0.0.1 --port5555 --device127.0.0.1:5555` (with normal argument separation). Ownership, reverse mappings, installed build checks and screenshots still use the actual emulator serial through the existing owned adb server. Receipts record the Maestro endpoint separately and the parent verifies the distinction. iOS receives no Android host/port flags. The pure Runner helper regression passed without touching devices, and the native module source hash remains unchanged. Actual transport/device results are recorded separately by the owned run controller.

The controller's actual transport probes subsequently passed: iOS `hierarchy` returned valid JSON/exit0 with the owned Android emulator booted on Console5554/adbd5555; Android's explicit direct endpoint launched only the owned development app with `clearState:false` and captured a screenshot (JUnit1pass,4seconds,exit0). The Android hierarchy probe was still pending at this addendum. These checks do not supply authentication, preferences, API responses or message bodies, and do not establish extension-feature acceptance. The existing default adb5037 listener was verified as pre-existing and left unchanged; no global Maestro patch, adb-server reset or path sanitization was added.

## Actual picker visibility diagnosis

The fourth run (`/private/tmp/canvas-plugin-extension-e2e-IB853l`) passed the stored Session identity gate and reached actual iOS Plugin/connection selection. It stopped with the Review control visible but disabled. The saved Native hierarchy establishes the harness cause: the visible ScrollView ended at y840points, while the enabled MCP row occupied y866–914 (its center was also below the874point screen). Maestro's previous tap therefore did not select that offscreen row; the chooser remained open. Cleanup completed as `failed_cleaned`, `databaseDropped:true`, `uncertain:false`.

The controller's separate five-second local UI diagnosis explicitly scrolled the same row into view and tapped it. Actual screenshots then showed the chosen connection in its slot, the chooser removed and Review enabled. That diagnosis used the retained owned iOS UI after fixture teardown, with no server, preview or send; it is not full feature acceptance. The harness now centers the exact connection/profile/account rows at100percent visibility before tapping in Chat and the corresponding Agent package/My Connection flows. Optional mapping confirmation occurs after that scroll. Product code and all original parent acceptance conditions remain unchanged. All ten flow files are checked with the installed Maestro parser before another owned run.

## Actual native caret and Undo diagnosis

The fifth run (`/private/tmp/canvas-plugin-extension-e2e-tvdO3d`) passed actual iOS Plugin review and all three initial reference selections. It stopped before Undo: after a new midpoint tap on the multiline composer and Backspace, the harness expected the standalone MCP to disappear, but the screenshots instead show the Plugin removed and MCP retained. Before that tap, the three-reference screenshot already showed Plugin, MCP, Skill order and the caret at the MCP end. The helper's repeated midpoint composer taps had also repositioned subsequent insertion points. Cleanup completed as `failed_cleaned`, `databaseDropped:true`, `uncertain:false`. This is a harness caret assumption, not an established atomic-delete or Undo defect.

The controller's separate seven-second retained-UI diagnosis then invoked the real native long-press Undo action. It passed and the actual screenshot showed the original Plugin, MCP and Skill with original icon attributes restored. Its private artifacts are under `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-native-undo-local-z38qnes3`. This diagnosis performed no launch, reset, server request or send; it does not replace the complete owned acceptance run.

The Chat flow now types a real space and `/` after its initial marker to exercise the slash parser. Later openings use the existing normal slash button, which preserves the application's selected insertion point (and uses the text end after a fresh mount). The extra midpoint tap before Backspace is removed. The actual hook sets a collapsed selection immediately after each applied caption; native selection mapping and decoration preserve that selection. Apply does not explicitly focus the editor in source, so the observed open keyboard and caret are device evidence rather than a universal focus guarantee. The real deletion, operating-system Undo, process-restarted draft, four-type selection, exact account and independent SQL/context requirements remain unchanged. All ten Maestro flows passed the installed parser's syntax check after this correction; no product or parent-verifier rules change.

## In-run native deletion and Undo passed

The sixth run (`/private/tmp/canvas-plugin-extension-e2e-4fEbxN`) passed actual iOS Plugin/Skill/MCP selection, both later slash-button openings, native Backspace removing the final MCP reference, and the real native Undo action restoring it. The `native-attributed-undo-restored` screenshot shows all three original references restored. This is actual in-run interaction evidence for that path; the complete Chat phase and independent final context proof remain incomplete.

The run stopped next at the harness-only `hideKeyboard` command before the draft screenshot. Maestro could not dismiss this custom multiline input through its generic keyboard action. Cleanup completed as `failed_cleaned`, `databaseDropped:true`, `uncertain:false`. The unnecessary command is removed: the flow still captures the current draft and immediately stops/reopens the real application to test persisted draft restoration. Keyboard dismissal is not an acceptance criterion. All deletion, Undo, restart, history, account and parent proof conditions remain unchanged; all ten flow files passed the installed Maestro parser's syntax check again after this correction.

## Restarted draft caption and exact plain retype

The seventh run (`/private/tmp/canvas-plugin-extension-e2e-iEmSbr`) again passed actual iOS deletion and native Undo, then stopped/reopened the app without clearing its state. The saved before/after screenshots show all three structured references restored in order. The harness assertion failed because it expected the search slug `native-skill-<nonce>` while the actual visible caption is `Native Skill <nonce>`. Cleanup completed as `failed_cleaned`, `databaseDropped:true`, `uncertain:false`. This assertion does not establish draft loss. The restarted references showed initials instead of the earlier transient icons; that separate presentation finding is not counted as logo acceptance.

Preparation now reads the real versioned `package_version` metadata for the exact published Skill pin and selected relative root, using the same child title/name/package display-name precedence as the picker. It transports this caption separately from the search slug. Both the restarted-draft assertion and real plain-text retyping use the actual caption. The independent parent reads that exact scoped published metadata again, checks the accepted inline caption against it, and requires the plain message to equal `PLAIN-<marker> <actual caption>` while still requiring no extension selection or reference bundles. Exact pin, account, execution, central-Agent snapshot and all other existing proof conditions remain in force.

The focused real SKILL.md parser regression confirms that this fixture's slug and visible title differ, rejects a wrong pin/root or ambiguous child, and rejects using the search slug or extra text as a substitute for the visible retyped caption. The actual authenticated PGlite preparation regression passed both immutable publications and the real Mobile package-version response with that differing caption; model/provider business execution remained zero. Focused transitive TypeScript, Notebook/Mobile ESLint, the pure Native harness regression and all ten installed Maestro syntax checks passed after this correction. The focused TypeScript check used an8GiB heap and is distinct from the earlier full-repository run that exhausted its default4GiB heap. These checks do not replace the remaining complete Native acceptance run.

## Plain message rendering and matching boundary

The eighth run (`/private/tmp/canvas-plugin-extension-e2e-D1jIbW`) passed actual iOS deletion, Undo, draft restart, four-type selection, the first inline send and its history restart. Its final screenshot also shows the second plain message and the controlled assistant response, with an empty composer and disabled Send. The terminal harness assertion nevertheless failed: the saved Native accessibility hierarchy exposes the plain message container but none of that rendered Markdown's visible text. The assistant response remains accessible. Thus a global plain-text match cannot establish this step on that tree; the screenshot does not establish full screen-reader support. Cleanup recorded `failed_cleaned`, `databaseDropped:true`, `uncertain:false`; no Agent or Android phase completed.

The focused matching correction asserts the exact marker plus visible Skill caption inside the actual native composer before sending. After the real Send tap it waits for that text to leave the composer, requires disabled Send and a visible message-content container, and captures an actual screenshot for visual review. It does not hardcode a message sequence ID. The independent parent must still prove exactly two original CIDs, successful execution/model callbacks, exact saved plain caption and no extension selection or reference bundles; a screenshot or cleared composer cannot replace that proof. These UI observations are a bounded submission/rendering check, not a complete screen-reader check. All ten flows passed the installed Maestro parser's syntax check again after the YAML-only correction.

The controller also identified a source-provenance limit in this run: the long-running CI/no-watch Metro process predated the newer icon-rehydration JavaScript edits. Run8 therefore does not count as acceptance of those newer presentation changes. The controller owns the fresh Metro restart before another run; this harness correction changes no product or native binary source.

## First complete iOS Chat phase and Agent keyboard occlusion

The ninth run (`/private/tmp/canvas-plugin-extension-e2e-euHlkC`) used the controller's fresh watch-enabled Metro process; the controller independently matched the launched bundle's source-map contents to the current frozen source. The actual iOS Chat phase passed in315seconds (JUnit1test,0failures; real phase receipt exit0, no timeout, before/after feature hashes equal). This includes native Delete/Undo, draft restart, all four source selections, explicit Composio account choice, inline send/history restart and the revised plain composer/submission/screenshot checks. It remains separate from final independent SQL/SDK proof, Android acceptance and visual logo assessment.

The run then stopped in the first Agent Create phase before its picker opened. Its saved screenshot and accessibility hierarchy show `agent-add-extension` enabled at y623–667points while the open software keyboard starts at y539. The previous visibility-only scroll left the button behind the keyboard and its tap did not open the picker. Cleanup completed as `failed_cleaned`, `databaseDropped:true`, `uncertain:false`; the iOS Chat phase's own completed receipt remains valid, but no complete Agent/Android or parent proof is claimed.

Existing Agent Create/Edit/package-policy button and disclosure scrolls now explicitly request100percent visibility and centering, matching the already centered My Connection/profile/account flow. The Agent Edit reopen checks also use the already supplied actual Skill caption: the real Agent row, like the Chat picker, prefers the published child title over its technical name. The technical slug remains the search query. These are harness scroll/matching corrections; they introduce no keyboard-dismiss shortcut or product change. All ten flows passed the installed Maestro parser's syntax check after the final correction. A separate real API presentation-metadata investigation is owned independently; these corrections do not claim logo acceptance.

## Bounded Agent form navigation through the real outer margin

The tenth run (`/private/tmp/canvas-plugin-extension-e2e-MDCKjn`) again completed the actual iOS Chat phase (JUnit1test,0failures,296seconds). Agent Create then passed Add/personal-rule selection but stopped scrolling toward the Create button. Its saved tree still places the outer form at42percent, with the large ROLE input at x15–387/y450–678points on a402point screen; the button remains outside the visible tree. The log records seven default center swipes before the bounded timeout. This supports the nested-input scroll interception diagnosis; no successful Agent creation is claimed. Cleanup completed as `failed_cleaned`, `databaseDropped:true`, `uncertain:false`.

The targeted harness now performs at most12 real vertical swipes in the documented free outer margin, only while each chosen form target is not visible. x98percent is approximately394points, outside the saved input's x387 boundary and within the outer form. Swipes stay between y20 and55percent (approximately175–481points), also above the keyboard's previously observed y539 boundary. Target-specific visibility, full centering, enabled-state waits and actual taps still follow; these are not coordinate taps on hidden controls. Name navigation goes explicitly upward and form saves go downward. After Create, the flow checks the actual name field/name before separately scrolling to the saved Agent's Save button. Skill Edit reuses the same scroll-aware Review/Apply helper as Chat. The still-unobserved personal-policy Switch is left unchanged pending a genuine tree for that phase.

These changes affect only Agent YAML navigation and matching; exact selections, writes and independent final proof remain required. All ten flows passed the installed Maestro parser, and the pure Native harness helper regression passed after the correction. No UI, API, build or process-management action was performed for these checks.

The separately owned actual PGlite presentation/byte probe passed all three owner/workspace-scoped Plugin/MCP image GETs: HTTP200, image/svg+xml, exact expected source bytes/hashes, no redirects, private/no-store, correct Vary and nosniff. Three other-actor requests were rejected, and a mismatched MCP binding returned409 before fetching. Account enumeration and model/provider business execution remained zero. This establishes the actual API byte path and its scope checks; it does not establish native SVG rendering, operating-system HTTPS trust or physical-device behavior. That probe's final private source/check receipt is `/private/tmp/canvas-native-icon-bytes-source-freeze-20261015.json`.

## Actual image-load readiness and independent keyboard failure

The eleventh run (`/private/tmp/canvas-plugin-extension-e2e-9jA6AC`) completed native editing/Undo, draft restart, the first inline send and history restart, but stopped at the second Send. The real failure tree places Send at y766–810 while the OS keyboard starts at y539. Maestro's logged tap at361/788 therefore lands on Return, and the actual composer retains the plain message plus a newly appended newline. The disabled-Send check correctly prevents a false success. The preserved provider proof contains one SDK completion; after normal `failed_cleaned`/databaseDropped:true/uncertain:false cleanup there is no retrospective SQL delivery-count claim. Keyboard layout is investigated and fixed independently; the harness does not dismiss the keyboard to bypass it.

The controller's later passive screenshot of that same owned screen shows the published Plugin SVG and standalone MCP logo rendered in restarted history. Earlier screenshots preceded metadata/image hydration. This distinguishes actual available logo rendering from timing; it does not establish external HTTPS reachability or every provider's logo behavior.

The existing History root Text now exposes one constant, content-free readiness identifier only after actual Expo Image `onLoad` callbacks confirm at least two distinct currently displayed source URLs from the versioned Mobile icon route. Public HTTPS provider logos retain normal rendering but cannot substitute for either of the two required Mobile images. The image mount/readiness resets on URL, prepared auth-header, instance, user/session and workspace changes; errors restore the existing initials fallback. Old load/error callbacks, including an exact A-B-A return, cannot affect the current image. Flow10 waits boundedly for this aggregate readiness on the existing root Text after restart before normal Plain composer focus/typing; metadata receipt alone is insufficient. The marker contains no resource, account, source URL or caption. It changes no selection authority or visible UX.

The mounted renderer regression exercises those real component callbacks through the native image boundary: wrong source, two confirmed images, ordinary rerenders, auth/header/workspace/URL changes, exact A-B-A, error and unmount. This is local callback/state evidence; the next real Native run must establish the new marker on actual loaded images. The separate keyboard fix and the strict final SQL/CID/model proof remain required.


## Existing-root accessibility readiness before the next Native run

The saved Run11 accessibility tree groups the inline history content into aggregate Text nodes and exposes no inline image/view children. The installed React Native0.86 implementation explains this boundary: iOS Text is accessible by default; the paragraph accessibility provider creates the complete Text element and additional semantic link/button elements. Two nested image identifiers therefore had no actual XCTest discoverability proof. The readiness identifier now belongs to the existing root Text; no accessible flag, label, role, text, visible component or layout is changed. Its actual Native discoverability remains to be verified in the next owned run.

Readiness counts distinct source URLs, not image occurrences. Each current Mobile image must emit its own matching-source onLoad; two references to the same loaded URL, any number of loaded public HTTPS logos, and metadata alone cannot satisfy the gate. Source/header/instance/user/session/workspace or displayed-reference changes fence the aggregate state and remount native requests with private random generation keys. An error, removal or stale callback cannot preserve or restore prior readiness. Ordinary text edits retain the current mounted images and confirmed readiness. The marker itself contains no URL, account, caption, resource or scope value.

The focused mounted regression checks the actual renderer callbacks and existing root placement, including two distinct loads, single/duplicate/public-source rejection, image-error/removal revocation and every scope field plus exact A-B-A/unmount races. These are local component/state checks; the genuine Native run, loaded-logo screenshots and independent exact body/CID/SDK/Agent-state proof remain mandatory. The independently owned keyboard fix and its focus-only device geometry are documented separately in the Mobile keyboard evidence; this readiness patch changes no keyboard or native binary source.


After the final aggregate patch, complete Mobile app and script TypeScript, focused ESLint, the complete extension suite (including actual mounted image callbacks, Send cases and keyboard-area regression), the pure Native harness regression, all ten installed Maestro syntax checks and the scoped whitespace check passed. The source-only native hash remains `fe27948fcd5d1431e93335167322c52be7e7d6f77b235afa86fdb774982199d0`; no native rebuild is required by this JavaScript-only patch. The separate focused device check places Send bottom at509points against keyboard top539points,30points clear; that check entered no text and performed no Send/API action. These focused results are not a replacement for the next complete Native run.


## Unchanged startup retry and actual root readiness

The twelfth run (`/private/tmp/canvas-plugin-extension-e2e-QeNVnF`) stopped before Chat at the initial normal-login/deep-link boundary. Its actual Native tree contains the existing root `(app)` navigation warning that a screen was removed natively but retained in JavaScript state, followed by blank screen views. The generic warning mentions a possible beforeRemove listener; it does not identify a concrete blocking listener. The inspected startup/root-layout/notification-gate sources are unchanged from MobileHEAD3ba1eb9, and the Chat feature was not reached. Cleanup was `failed_cleaned`, `databaseDropped:true`, `uncertain:false`. No startup product fix or assertion workaround was introduced.

The thirteenth run (`/private/tmp/canvas-plugin-extension-e2e-wNtArz`) repeated the identical fresh normal login and all existing gates. The startup issue did not recur. Its actual iOS Chat phase completed with JUnit1test/0failures (292.743seconds), phase receipt exit0/no timeout and equal before/after feature hashes. After genuine editing/Undo/draft restart/four-type selection/inline Send/history restart, XCTest found the existing root Text readiness identifier at06:09:08 local log time. The real Plain Send then succeeded above the keyboard, followed by disabled Send, a visible message container and its screenshot. This supplies actual root-marker discoverability and completed Chat-phase evidence; it does not replace final independent SQL/SDK proof or the remaining Agent/Android phases.

## Exact translated Agent action selectors

Run13 next stopped in Agent Create. Unlike the earlier nested-editor scroll failure, its actual saved tree proves the outer form reached100percent and the enabled Create button was fully visible at[14,450]–[171,485], above keyboard top539. Its exact German label is `Agenten erstellen`; the harness incorrectly searched for `Agent erstellen`. The current product dictionary maps `Create agent` to `Agenten erstellen` and `Save agent` to `Agenten speichern`. The same singular error affected Save selectors in flows30/31/32. Only those three files' exact German action alternatives are corrected; English alternatives, all scroll interactions, bindings, state checks and independent proof criteria remain unchanged. Other involved literal action selectors were checked against the actual current English/German copy. Cleanup remained `failed_cleaned`, `databaseDropped:true`, `uncertain:false`; no Agent completion or Android/final proof is claimed.

## Actual missing character and native write ownership

The fourteenth run (`/private/tmp/canvas-plugin-extension-e2e-bfiTdC`, controller log `/private/tmp/canvas-chat-inline-native-e2e-fourteenth-20261015.log`) stopped in the real iOS Chat flow while checking the second plain message in the composer. The evaluated Maestro text contained73characters; the actual native accessibility value contained72. Exactly one ASCII `4` was missing. The strict composer assertion rejected the mismatch before the second Send. Cleanup completed as `failed_cleaned`, `databaseDropped:true`, `uncertain:false`. The Chat phase did not complete; no Agent or Android phase started, and no complete independent SQL/SDK proof is claimed.

Three focused regressions against the actual installed PasteTextInput TSX and the real composer then failed on the earlier implementation. They reproduce an older custom native document being returned as changed React children under a newer RN event count, an old same-scope payload replacing an explicit draft write, and a presentation change rebuilding a stale attributed tree. These are mounted host-boundary reproductions. They establish those source defects; they do not establish the exact UIKit/Fabric scheduling that lost the character in Run14.

The bridge-v2 implementation gives the existing uncontrolled RN/Paste input native text ownership and explicit compare-and-swap writes. Each immutable command captures its base native revision once, carries a scoped canonical ordinal ID, and receives an actual applied/conflict result. Native edits and Undo advance the document revision; duplicate or stale commands cannot reapply. Ordinary React children/value/defaultValue no longer echo native text. Reference presentation cannot create private identity, and rejected intent remains separately available for a fresh explicit choice. The actual mounted Paste/composer gate now passes all7cases, including the three original failures; the focused Send suite passes23cases. These are local contract/state results, not native OS completion.

The prebuild source receipt `/private/tmp/canvas-native-cas-v2-prebuild-source-20261015.json` records native source hash `bbb68c0373ffde904f91dfff182e3f901e7f128997a00b76f76f71c527295af7`. The controller's official iOS development wrapper completed with exit0 for build61, installed and launched the development app, and reported0errors/6warnings in `/private/tmp/canvas-chat-inline-ios-build61-20261015.log`. The controller measured the identical native hash again after that terminal result. This establishes build/install provenance for iOS61, not feature acceptance. Android24 remains the older installed binary at this addendum; matching current native builds and all ten completed phase receipts remain open.

## Source-reviewed iOS token-boundary risk remains open

The independent read-only review found a separate iOS inheritance path. The installed RN0.86 `RCTTextInputComponentView.mm:506–515,799–810` copies every attribute of the character immediately before a user-moved caret into `typingAttributes`. The current native painter stamps the full reference-caption range (`CanvasChatKeyboardView.swift:266`) and resets typing attributes only at the end of painting (`:276`). After moving the cursor away and then directly back to a token's end, later plain input can therefore inherit the private stamp. The existing invalid-range cleanup (`:141–152`) would then treat the expanded caption as an edited reference and delete the token and newly typed text together.

This is a source-supported risk and independently confirmed source chain; the cursor-away/back UIKit reproduction and post-fix native acceptance are still open. Direct typing immediately after picker Apply does not cover that cursor-movement case. The iOS native owner is implementing a scoped correction, which will change the native source hash and require new wrapper-built binaries before acceptance. Future build numbers are plans until the controller records their successful terminal results. The Android source uses `SPAN_EXCLUSIVE_EXCLUSIVE` for its private stamps and retained Undo snapshots; no analogous edge-inheritance defect was established by that read-only review. No device result is inferred from those span flags.

## Current full-verification boundary

The current Mobile `verify` attempt stops at stale generated Notebook assets. Regeneration is being handled by the UI owner. Expo Doctor was **not reached**, so this attempt supplies no Doctor result and is not a completed full-verification gate. The focused mounted, Send, pure-native contract and build results above remain distinct from that incomplete gate, the pending iOS correction, current Android rebuild, all-ten-phase native acceptance, physical-device checks and production rollout.

## Final native boundary correction before renewed acceptance

The iOS correction is implemented and independently source-reviewed. A synchronous main-thread
`NSTextStorage.willProcessEditingNotification` observer uses the previous genuine private ranges and the actual
UTF-16 edit range/delta. It removes only inherited owned stamps/attachments and their font/color from newly
inserted characters outside the atom, including both boundaries. It preserves text, selection, marked-text and
foreign attributes, original delegates, guarded writes and genuine Undo/Redo. Interior token edits retain the
atomic cleanup path. No caption search creates identity. The production helper passes Foundation and actual
AppKit storage/UndoManager regressions; the portable source gate now checks14 assertions.

The controller also compiled that exact production helper with the prepared UIKit storage probe and ran it
with exit0 on the explicitly owned iOS simulator. This establishes actual UIKit text-storage notification,
attribute and UndoManager behavior. The RN sampling rule in that probe is reconstructed from the installed RN
source; actual RN/Fabric, cursor movement and keyboard interaction remain separate. The private receipt is
`/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-inline-uikit-storage-probe-594s9oya/root-ui-kit-proof.json`.

The new frozen module hash is `a690254dc5e2ecf09ff049f233f85724db48f8a1c977b259a5e0ed94cee0741b`.
`/private/tmp/canvas-native-boundary-final-prebuild-20261015.json` independently matches all8 current iOS,
all5 Android and all18 JS-owner files. The iOS development62 wrapper has started; its successful terminal
result and the subsequent matching Android binary are still required. Flow10 now proves a genuine caret move
to the beginning by inserting/checking/removing a plain prefix, then moves back to the end and checks exact
ordinary text after the final reference before continuing its existing delete/Undo/restart/send gates.

The second full Mobile verification passed every gate before Expo Doctor, including the regenerated Notebook
asset checks. Doctor reports19/20 with13 existing Expo SDK patch-version mismatches; no dependency, exclusion
or bypass was introduced. The two new dictionary entries also require ordinary regeneration of ignored
Notebook and Excalidraw assets: removing exactly those entries from each regenerated HTML reproduces its
previous bytes. Audit and export remain separate gates until their current terminal results are recorded.

The final separate production-runtime audit and all-platform export both completed with exit0 after that
ordinary ignored-asset regeneration. Their private logs are
`/private/tmp/canvas-native-cas-v2-audit-second-final-20261015.log` and
`/private/tmp/canvas-native-cas-v2-export-second-final-20261015.log`; the final22-file validation receipt is
`/private/tmp/canvas-native-cas-v2-final-validation-source-freeze-20261015.json`. The continuous verify result
remains exit1 at the documented Doctor version check; successful rest gates do not relabel it as exit0.

The iOS62 wrapper subsequently completed with exit0,0errors and4warnings. The controller verified the owned
simulator's actual installed version0.1.4/build62 and the exact same `a690254d…741b` module hash after build.
`/private/tmp/canvas-native-ios-build62-verified-20261015.json` records its before/after source provenance and
wrapper-log hash. Android25 is building sequentially. Neither result yet establishes the full native workflow.

The Android25 wrapper reached the actual Expo-dependent Kotlin compiler and failed on two event declarations:
the default dispatcher expects `Map<String,Any>`, while a document contains a genuine nullable applied-write ID.
The installed Expo API already provides `EventDispatcher<T>()`. Both declarations now use the explicit
`Map<String,Any?>` generic. The payload, revision and reference graph are unchanged. The installed conversion
chain handles null with `putNull`; there is no cast, sentinel, dropped field or string replacement.
Pure Kotlin51 and the portable source checks pass. The focused correction is recorded in
`/private/tmp/canvas-native-android-nullable-event-source-freeze-20261015.json`.

The final combined module hash is now `d0bf60ba8e55ce5a9bb81ee3882c8405f359f779eee03369f58721e68cb7389d`.
The controller independently matched the overlapping owner freezes and recorded it in
`/private/tmp/canvas-native-nullable-final-prebuild-20261015.json` before building Android26. That official
wrapper completed successfully, and the actual owned emulator reports version0.1.4/build26. Source provenance
still matches after build, as recorded in `/private/tmp/canvas-native-android-build26-verified-20261015.json`.
iOS63 is now building sequentially against that same combined module manifest; Swift content is unchanged
from62. Full native acceptance remains pending until the final matching iOS install and all ten real phases.

## Run15: genuine first-mount Undo registration crash

iOS63 subsequently built and installed successfully with0errors/4warnings, matching Android26's exact
`d0bf60ba…7389d` module hash. The controller independently checked all148 frozen files and the actual installed
versions before starting `/private/tmp/canvas-plugin-extension-e2e-qfmGWu`. Its fresh Notebook build and
TypeScript gate passed, followed by normal API preparation. The iOS Chat phase failed after84.167seconds at
the first composer visibility check. Cleanup was `failed_cleaned`, `databaseDropped:true`, `uncertain:false`.

The actual screenshot and AX show SpringBoard. Unlike Run12, there is no running white application with a
navigation-warning overlay. The same run's Metro log records `NSInternalInconsistencyException` at
05:38:38.969UTC,836ms after the chat deep link: `enableUndoRegistration` has no matching disabled state, with
`processInlineWrite → updateInlineProps` on the native stack. No reference selection was reached; no complete
message/SDK/Agent/Android proof is established by this run.

A first candidate captured one exact UndoManager instance across each operation. Foundation guard tests
passed, but the controller's actual standalone UIKit probe still crashed with that candidate and explicitly
reported `sameInstance=true`. Capturing identity is therefore insufficient and is not recorded as a fix. The
controller stopped the owned iOS64 build during prebuild; counter64 remains consumed and no64 install or
successful compilation is claimed. The private stop receipt is
`/private/tmp/canvas-native-ios-build64-stopped-20261015.json`.

The next actual UIKit matrix isolates the cause: text/attributed-text setters, direct text-storage character
writes and a combined paint sequence re-enable the same manager during mutation, so the later paired enable
aborts. Attribute-only edits, selection and typing-attribute updates preserve the disable depth. Real owned
snapshot Undo and Redo pass without a disable/enable pair around the character write. These are actual UIKit
storage/UndoManager results, not the completed RN/Fabric client flow. The Foundation SDK also documents that
`removeAllActions` re-enables registration. The matrix and failed candidate are preserved privately under
`canvas-inline-uikit-undo-mutation-matrix-whwv7y76/root-matrix-proof.json` and
`canvas-inline-uikit-undo-probe-34oo2k4o/root-capture-only-failure-proof.json`. The next correction must respect
that UIKit lifecycle and still prove private reference restoration and actual native UI completion.

## Proof-backed UIKit lifecycle correction

The follow-up actual UIKit proof passes both direct text-storage and attributed-text setter modes without
registration suppression. It restores private fixture stamps and attachments through real Undo, metadata
repaint, Redo and another Undo; metadata updates preserve the existing inverse stack. A real nested
willProcessEditing callback invokes the production range helper, preserving marked attributes and exact new
text while stripping inherited private identity. Rebuilding the complete owned history then retains genuine
Undo/Redo. These are actual UIKit storage tests; the fixture stamp is not the private Canvas class, and the
test is separate from RN/Fabric composer acceptance.

All six native mutation paths now leave registration to UIKit while retaining their existing decorating,
restoring, IME, CAS and complete-snapshot history logic. The failed generic registration guard and its
Foundation-only assurance tests were removed. The durable UIKit fixture is
`scripts/native-chat-inline-uikit-test.swift`, with a separate manual owned-simulator command; the normal
portable/host-native CI gates acquire no simulator requirement. The portable source gate checks17 assertions,
including the absence of the known unsafe suppression pattern.

The controller recompiled and executed that durable source against the final production helpers: both modes
exit0, with proof `/private/tmp/canvas-native-final-uikit-undo-mqmaktbs/proof.json`. Foundation/AppKit, Swift
syntax, source checks and focused lint also pass. The final module hash is
`9e6849eb105826413cd4553a0a531844df0a04734f6640933a1ef81440647a2a`, independently recorded with the overlapping
owner freezes and UIKit proof in `/private/tmp/canvas-native-undo-lifecycle-final-prebuild-20261015.json`.
iOS65 is building; matching successful binaries and the complete native phase sequence remain required.

The iOS65 official wrapper completed with exit0,0errors/4warnings. The controller verified the actual owned
simulator install as0.1.4/build65 and the unchanged final native module hash, recorded in
`/private/tmp/canvas-native-ios-build65-verified-20261015.json`. Android27 is building sequentially. Fresh
normal Metro manifests, bundles and source maps match all11 current runtime sources on both platforms;
`/private/tmp/canvas-native-cas-v2-metro-5dhhqlj5/proof.json` records that byte comparison. These remain build
and source-provenance checks; the complete real native workflow has not yet passed.

## Run16: real mount and three references; caret-driving assertion fails

The official iOS65/Android27 wrappers both completed with exit0. The controller independently verified their
actual owned installs, unchanged final module hash, all37 overlapping owner files, preserved production/
preview counters, owned Metro listener and the free Notebook test port. The private paired proof is
`/private/tmp/canvas-native-final-devices-before-sixteenth-20261015.json`. Separate before-run manifests
cover132 Mobile and18 Notebook files, including the four deliberately ignored regenerated editor assets.

The fresh full run `/private/tmp/canvas-plugin-extension-e2e-YKKH1a` passed its Notebook production build,
TypeScript and ordinary API preparation. Actual RN first mount succeeds, unlike Run15. Its captured initial
empty composer already shows a write-conflict banner; source inspection identifies competing initial/hydrated
writes as a possible path, but this screenshot alone does not prove their native event order. All three
Plugin/Skill/MCP references are subsequently selected and visibly inline, with no selected-resource rail.

The iOS Chat phase fails after213seconds at the new caret-prefix assertion. Actual AX contains the complete
marker and all three references followed by the probe `0`; it does not show a missing typed character.
The screenshot shows a40pt-high input scrolled to its lower lines. A tap at2%,2% did not establish the true
start-of-document caret, so this is a failed test-driving assertion, not evidence of text loss. The ordinary
post-reference append, Undo/restart/history and later nine phases are not established by this run.

Normal cleanup is `failed_cleaned`, `databaseDropped:true`, `uncertain:false`. The controller re-read every
frozen file after termination: all132+18 bytes match. A targeted post-run owned-simulator gesture probe is
separate from the full fixture and cannot count as all-ten-phase acceptance. The initial-write path needs a
mounted delayed-ACK regression before a product correction is claimed.

The separate post-run real iOS gesture probe succeeds: tap8%,20% inserts a probe at the visible boundary
between the exact marker and first reference; its AX assertion proves movement away from the old tail. After
erasing it, tap95%,75% followed by ` 12345` appends the exact suffix without deleting the MCP reference;
erasing six characters restores the exact tail. The saved screenshot shows ordinary suffix text in the
normal style beside the blue/bold reference. Its actual JUnit is
`/private/tmp/canvas-native-caret-tail-probe-20261015.xml` (exit0,7seconds). This owned post-cleanup interaction
does not send messages or call the stopped API and is not the complete fixture. The full flow retains an
exact prefix assertion at the reachable boundary and all existing Undo/body/SDK criteria.

## Initial hydration ordering: actual Screen/Paste regressions

A new mode mounts the actual ChatDetail screen, ChatComposerInput and installed PasteTextInput, while the
native transport remains a controlled host boundary. The pre-fix tests strictly fail for empty hydration,
nonempty hydration and genuine early input because a first empty command is issued before the held draft
read finishes. This proves a concrete JS scheduling defect, not the exact device event order behind Run16's
banner. Real conflict recovery and stale-scope rejection already pass.

The narrow correction keeps the rich editor uncontrolled while withholding inputWrite until the scoped draft
read finishes. If actual user edits win that read, the first immutable write captures the current body, never
the unused constructor snapshot. No request already issued to native is retried or rebased. Independent review
then identifies the initial native revision-zero/no-applied-write seed overwriting a nonempty E-mail return;
actual Screen/Paste tests also reproduce that, early hardware submission and spurious initial selection.
Explicit lifecycle guards preserve that intended draft while continuing to observe genuine later revisions.

After the final patch all23 existing Send cases plus9 actual Screen/Paste startup cases pass, as do App/Scripts
TypeScript, focused lint, canonical source comparison and official generator checks. A narrow independent
recheck finds no further concrete defect in that changed startup path. These are controlled-boundary mounted
regressions; full real iOS/Android acceptance is still required. The complete verify invocation is running on
this final JS source; no new native binary or package/dependency change is needed for this correction.

The final complete verify invocation ends with exit1 solely at the same Expo Doctor19/20 report of13 existing
SDK patch-version recommendations. All34 preceding top-level gates pass, including the full Chat and i18n
suites. Separate audit:production and export:check (all three platforms) both exit0. No dependency, lockfile,
exclusion, Native module or generator output was changed for this startup fix. The reviewed four-file source
freeze is `/private/tmp/canvas-native-hydration-final-source-freeze-20261015.json`; all hashes remain exact.
Fresh default Metro manifests/bundles/maps match all11 current runtime files on both platforms in
`/private/tmp/canvas-native-cas-v2-metro-xkxehw33/proof.json`. The unchanged installed65/27 binaries retain
module hash `9e6849eb105826413cd4553a0a531844df0a04734f6640933a1ef81440647a2a`. Run17 is the next complete
real native attempt; no all-ten-phase result is claimed by these code/export/provenance checks.

## Run17: initial hydration and real caret pass; native style/menu defects

The fresh full attempt `/private/tmp/canvas-plugin-extension-e2e-e8MMAr` passes its current production build,
TypeScript and normal API setup. Actual iOS65 first mount has no conflict or Restore button. The three
references are visibly inline, with the Plugin/MCP logos and Skill initials, and Send remains above the keyboard.
The corrected touch probe proves movement before the Plugin, then return to the tail. Exact ` 12345` append,
six-character erase and the subsequent atomic MCP deletion all pass without text/reference loss.

Actual iOS Chat then fails after234.506seconds at the long-press Undo visibility check. The captured menu contains
Select/Select All/AutoFill, with no Undo/Redo. Independent PNG review also catches a style defect: newly inserted
12345 is blue/bold like the preceding reference. The earlier separate post-run gesture probe had appended after
an already plain0, so its black suffix did not establish the directly-adjacent-reference case. No draft/history,
Agent or Android acceptance follows from Run17. Normal cleanup is failed_cleaned/droptrue/uncertainfalse; the
controller verifies every133 Mobile and18 Notebook frozen file unchanged after termination.

The production boundary helper neutralized font/color only where the inherited private stamp survived. Real
AppKit storage and both actual UIKit modes strictly fail the new stamp-free style assertion before the fix.
The narrow correction applies normal font/color to the entire already validated newly inserted plain range;
owned stamp/attachment removal remains selective. Text, marked/native attributes, genuine private ranges and
Undo/Redo remain independently checked. Both UIKit modes now exit0 with exact final helper hashes in
`/private/tmp/canvas-native-uikit-style-green-tw6ac_nk/proof.json`; the strict red baseline is preserved in
`/private/tmp/canvas-native-uikit-style-red-dlh_jubw/proof.json`. This is actual UIKit storage, not RN keyboard UI.

A second post-cleanup real Canvas65 long press at the input tail still lacks Undo, so the failure is not just
the center coordinate. The extra UIEditMenuInteraction/recognizer is a competing presenter; its exact timing
relative to UIKit is not proven. A separate owned UIKit GUI app establishes a supported alternative: a wrapper
UIView buildMenu override adds Probe Undo to the existing system context menu. Actual three-second Maestro
long press shows it alongside Select/Select All/AutoFill; a real tap restores the exact original text through
UndoManager. JUnit passes in8seconds, and the controller inspects both screenshots. No extra edit interaction,
gesture recognizer or delegate replacement is present. The fixture proof is
`canvas-inline-uikit-menu-chain-probe-_0glqsgo/root-actual-menu-proof.json`; the exact owned fixture app was
uninstalled afterward, retaining the Canvas development app. This proves UIKit wrapper participation, not the
actual Expo/RN composer. The native wrapper correction now uses that public context builder and preserves
UIKit's standard actions; matching rebuilt binaries and the full native sequence remain required.

The final menu/style source freeze is `/private/tmp/canvas-native-ios-menu-style-source-freeze-20261015.json`.
Foundation/AppKit, bounded Swift HTTP and Kotlin51 pass; syntax/lint/diff pass, and the portable gate retains
its17 checks plus2 meaningful menu constraints (19 total). Independent review finds no concrete changed defect.
The controller matches all41 overlapping final files before wrapper builds and records the combined module hash
`3e6a876d8a17b8313042acdfd910e8956bee39a6b2a85734005a5ca2dedbfdd8` in
`/private/tmp/canvas-native-menu-style-final-prebuild-20261015.json`. The official iOS66 wrapper uses the explicit
owned UUID, completes with exit0/0errors/3warnings, and the actual0.1.4/build66 install and post-build source
match are independently recorded in `/private/tmp/canvas-native-ios-build66-verified-20261015.json`. The official
Android28 wrapper also completes successfully after84seconds. Matching actual installs and full native
acceptance remain separately required; these builds alone do not establish the RN menu or final workflows.

## Run18: development-launcher startup failure before Chat

The owned iOS66/Android28 installs and final module hash are independently confirmed, with all41 frozen source
files exact. Whole-run manifests cover134 Mobile and18 Notebook files. The fresh full attempt
`/private/tmp/canvas-plugin-extension-e2e-S6mHLr` passes production build, TypeScript and ordinary API setup,
but iOS Chat fails after46.598seconds before its server URL input. The actual screenshot shows Expo's project
loading error for a remembered LAN host on8081, with Canvas Welcome visible underneath. No Chat/NativeInput,
style, Undo, history or Agent result is established. Normal cleanup is failed_cleaned/droptrue/uncertainfalse;
all134+18 frozen files are unchanged.

The installed Expo controller explicitly handles --initialUrl before recent/default bundle fallback. Its
URL flag named disableAutoLaunch controls the dev-menu display, not that startup selection. Installed Maestro's
iOS argument converter preserves string keys beginning with a dash. The test runner now passes its verified
owned Metro URL as MAESTRO_METRO_URL; first iOS launch uses --initialUrl and stays in the same process when
opening the existing dev-client URL. Android retains its original stop/open order. Only test startup changed;
Native module and product JS remain unchanged, so66/28 require no rebuild.

A separate actual owned-iOS startup probe passes in20seconds: clear state/keychain, explicit8097 launch, normal
Welcome and the real server-url-input visible without Expo's loading-error overlay. The controller inspects the
screenshot. It sends no credentials or server URL and is not the full fixture. The JUnit is
`/private/tmp/canvas-native-explicit-metro-startup-20261015.xml`. Driver syntax, existing pure harness helpers
and Maestro flow syntax pass. The full native sequence remains the next required result.

## Run19: three iOS phases pass; terminal-row test and restored placeholder

The frozen full attempt `/private/tmp/canvas-plugin-extension-e2e-uwWsaY` passes the fresh Notebook build,
TypeScript and ordinary API setup. Actual iOS66 Chat passes301.834seconds, AgentCreate97.228seconds and
AgentEdit101.982seconds. Real screenshot review confirms normal black plain text immediately after the
reference, actual native Undo restoring the MCP reference, exact sent/history highlighting and loaded Plugin/MCP
logos after history hydration. Initial mount has neither an Expo8081 error nor a spurious write-conflict banner.

AgentPackagePolicy then fails after75.076seconds in scrollUntilVisible with100% visibility and centering. The
exact expected personal MCP row is fully visible in the failure screenshot and present/enabled in AX at
[31,703][371,751], within its modal viewport [0,127][402,840]. No filter/slot defect is established. The test keeps
its100% visibility requirement but no longer demands centering this final row at the content boundary; the next
real run must establish whether that test-driving correction succeeds. No remaining iOS phases or Android
acceptance is claimed. Cleanup is failed_cleaned/droptrue/uncertainfalse. All134 Mobile and18 Notebook files
match their pre-run manifests in `/private/tmp/canvas-native-run19-terminal-source-proof-20261015.json`.

The actual first draft-restore screenshot also exposes a product defect: the gray placeholder overlaps restored
text. Later screenshots after another real edit are clean, which does not prove spontaneous recovery. Installed
RCTUITextView explicitly updates placeholder visibility in its attributedText setter; direct textStorage mutation
in the native CAS write bypasses it. The narrow correction uses that existing setter inside the same transaction,
retaining scope/revision/IME checks, exact selection and private provenance, original RN delegate and final ACK.
The real Undo restore already uses this setter. Independent source review finds no concrete changed defect.

The portable extension suite (including23 Send cases,9 initial-hydration cases and7 installed-Paste protocol
regressions) and the separate compiled Swift/AppKit/bounded-HTTP/Kotlin51 gate pass. Both actual UIKit storage
and setter modes also pass, recorded in `/private/tmp/canvas-native-placeholder-uikit-iuzfa9eu/proof.json`.
These fixtures use UITextView rather than RCTUITextView; only rebuilt app binaries and an actual RN restore
screenshot can establish the placeholder correction. The full ten-phase acceptance remains open.

## Run20: placeholder fixed in real RN; disclosure-selector mismatch

Official wrappers build and install iOS67/Android29 successfully from42 frozen source files with native module
hash `12de4586f546f1965809a8c20e75c5608eeca9d76939a8e4324aafccfdf1f1af`. Build/install/source proofs are
`/private/tmp/canvas-native-ios-build67-verified-20261015.json` and
`/private/tmp/canvas-native-android-build29-verified-20261015.json`. The v2 module README is now accurate.
The complete attempt `/private/tmp/canvas-plugin-extension-e2e-ulrXoz` again passes fresh production build,
TypeScript and ordinary API setup. Actual iOS Chat passes329.028seconds, AgentCreate about101seconds and
AgentEdit about108seconds. The first restored-draft screenshot is taken at07:49:37.384UTC after reopening and
draft assertions, before any subsequent typing/picker action. It has no gray placeholder over restored text.
Root and independent reviewer inspect that actual PNG. Normal plain style, genuine reference Undo, inline
sent/history highlighting and actual Plugin/MCP logos are independently seen again.

The previous fully-visible MCP row now passes without centering and the package choice reaches Review/Apply.
AgentPackagePolicy fails later after117.916seconds: its anchored disclosure selector excludes the actual iOS
AX suffix `, go down`. Both the correct Plugin disclosure and the earlier Skill disclosure are visible; the
Plugin-relative geometry is valid. The test now permits the observed icon suffix while retaining the exact
leading label and below-Plugin selector. No package/slot product failure follows from this artifact. Normal
cleanup is failed_cleaned/droptrue/uncertainfalse; all134 Mobile and18 Notebook source files remain exact in
`/private/tmp/canvas-native-run20-terminal-source-proof-20261015.json`.

A read-only audit of the remaining package/personal flows identifies two additional test-driving assumptions:
the personal-account Text and Switch share a label, and Flow40 waits for rows to be visible before attempting
to scroll to them. The Switch receives an exact test ID; all7 corresponding YAML selectors retain their checked
and enabled assertions against that control. Flow40 scrolls to each exact row first, checks enabled, and still
asserts no account before the profile is explicitly chosen. Both flows retain100% visibility but do not require
centering terminal rows. Package save/reopen now cold-restarts via the existing real chat-reopen flow before
loading the Agent form, so disclosure state and the verified configuration come from a fresh app instance.
None of these changes select via API or replace the independent persisted-policy/context verification.

Only the Switch test ID changes product JS; TypeScript and focused lint pass. Fresh real Metro manifests,
bundles and source maps match12 current runtime sources on both platforms, including that component, in
`/private/tmp/canvas-native-agent-switch-metro-r_coijt1/proof.json`. Native source hash and installed67/29 remain
unchanged. The next full attempt runs Android first; all original ten phases and source/SQL/SDK/identity gates
remain mandatory. Neither Run20 nor this harness audit establishes Android or full-native completion.

## Run21: Android login requires ordinary form scrolling

The fresh full attempt `/private/tmp/canvas-plugin-extension-e2e-1WKmYg` runs Android first with unchanged
native67/29 and verified current sources. Production build, TypeScript and normal API setup pass. Android
reaches the verified-server sign-in form, then fails after55.832seconds before entering its password. Actual
PNG/AX show the focused E-mail field at the bottom of the visible viewport, the soft keyboard below it, and no
visible password control. No loading error, crash or reference-composer result is established. The old shared
login flow tapped the next field without scrolling. It now scrolls to the exact password and sign-in IDs with
100% visibility before tapping, retaining real UI login and credential entry. Maestro syntax passes. There is
no app/native behavior change. Normal cleanup is failed_cleaned/droptrue/uncertainfalse; every134 Mobile and
18 Notebook file is unchanged in `/private/tmp/canvas-native-run21-terminal-source-proof-20261015.json`.
The complete native acceptance remains open.

## Run22: Android renders references; real cursor probe uses different line geometry

The fresh attempt `/private/tmp/canvas-plugin-extension-e2e-y8nLxb` passes production build, TypeScript and
ordinary API setup. Android now completes real login with the explicit form scrolling and reaches the normal
RN chat without initial conflict. Actual three-reference PNG shows the Plugin SVG, Skill initials and MCP
logo inline, with Send above the keyboard and no selected-resource rail.

Chat fails after about251seconds at its exact cursor-probe prefix assertion. The real8%,20% tap inserts0 at
index2 (`NA0TIVE…`) in Android's visible marker line; the assertion expected the iOS lower-line boundary after
the marker. Both actual PNG and AX retain the full marker remainder and all3 exact references through the MCP
suffix. This is a test-coordinate expectation mismatch, not a demonstrated text-loss defect. Cleanup is
failed_cleaned/droptrue/uncertainfalse, with all134 Mobile and18 Notebook files unchanged in
`/private/tmp/canvas-native-run22-terminal-source-proof-20261015.json`.

After normal fixture shutdown, a separate explicitly owned Android real-UI diagnostic operates on the existing
synthetic editor only. It erases that0, proves the original body, uses the existing95%,75% tail tap, appends and
erases exactly6 characters, deletes the whole MCP atom with one Backspace and invokes actual menu Undo.
The exact MCP and green logo return. Actual screenshots show normal black plain text beside the blue reference.
Maestro passes18seconds, with source/artifact/device proof at
`/private/tmp/canvas-native-android-cursor-undo-probe-proof-20261015.json`. The backend is already offline;
this is native edit/menu evidence, not a new send/history/SDK or complete-fixture result.

The shared acceptance flow now asserts an exact platform-specific prefix supplied by the existing test driver:
Android index2 and the already proven iOS boundary. Genuine tap/type/erase and tail/atomic-delete/Undo steps are
unchanged. No arbitrary-body match, native text injection or product change is introduced. Driver syntax,
existing harness helpers and flow syntax pass. Native67/29 and module hash remain unchanged. All original10
phases and independent persisted context/policy/source verification remain required in the next full attempt.

## Run23: developer reload after lost input focus, before the picker

The fresh attempt `/private/tmp/canvas-plugin-extension-e2e-I3FArv` passes production build, TypeScript and
normal API setup. Android reaches a real chat, but fails91.759seconds later because the unified-search field
is absent. Actual failure PNG/AX show the chat/session-list tab with the existing conversation row, rather than
an open chat or picker. Source review finds no slash/picker route-pop path: slash only opens local picker state,
modal dismissal closes that state, and the native bridge intercepts only Ctrl/Meta Z/Y. No auth/workspace
redirect is actually observed. Cleanup is failed_cleaned/droptrue/uncertainfalse; all134 Mobile and18 Notebook
files remain exact in `/private/tmp/canvas-native-run23-terminal-source-proof-20261015.json`.

The connected-chat screenshot contains a development LogBox notification overlapping the lower composer edge.
Its preserved stack points to Expo Router's installed `useLinking.native.js` initial-URL promise updating before
mount. The actual input tap bounds are[50,2097][485,2193], with center2145 next to the toast starting about2146;
tap interception is plausible but not directly instrumented. The app reports an inactive InputConnection at
08:27:39.304UTC, before marker typing starts39.343. At44.514–44.535 the driver sends the marker'sr key; actual
device-logcat records ReactHost's full reload beginning44.536, followed by surface/context destruction and
Metro reload. Installed Expo DevMenu reloads on an unmodified singleR only when the Activity is not accepting
text. This timing and source explain the eventual default-list remount, although that handler was not
instrumented. It does not establish a feature navigation defect or prove the original focus-loss cause.

The flow now taps the actual input near its upper interior and requires `focused:true` before typing. It also
asserts the exact marker and subsequent space inside that same focused field before invoking slash. The marker
is unchanged; no developer shortcut is disabled and no warning is globally suppressed. Maestro syntax passes.
A separate offline cold-start inspection had no8097 reverse mapping after normal fixture cleanup and therefore
showed a development-launcher connection error; it is explicitly not application/feature acceptance. The next
normal driver recreates its own scoped mappings as before. Native67/29 and product JS remain unchanged, and
all original ten phases plus independent SQL/runtime/source verification remain required.

## Run24: real focus/typed slash pass; developer inspector blocks Apply

The fresh attempt `/private/tmp/canvas-plugin-extension-e2e-sLKeyl` passes production build, TypeScript and
normal API setup. Android's actual focus/marker/space guards and typed-slash search now pass despite the
visible startup notification. Plugin metadata, exact MCP choice and preview are reached. Chat then fails after
182.578seconds at the next picker-open control. The actual failure image is the full LogBox inspector for the
same initial-URL-before-mount error, with ContextNavigator/ExpoRoot stack; the known overlay is now open over
the application. No missing picker, reference insertion, text loss or provider-filter defect is established.
Normal cleanup is failed_cleaned/droptrue/uncertainfalse, with all134 Mobile and18 Notebook files unchanged in
`/private/tmp/canvas-native-run24-terminal-source-proof-20261015.json`.

A separate owned-device UI inspection minimizes this recorded inspector and captures its real notification AX.
Its message is visible and tappable, but its nativeID is not exposed as a resource-id. A second real UI procedure
opens that exact message, requires Console Error and ExpoRoot.js, records it, taps visible Dismiss and proves the
message absent. Those steps complete. Its extra final assertion expected a Composer, but the actual underlying
view is still the existing Plugin preview with Apply pending; that assertion fails and the diagnostic is not
reported as a full pass. The returned view is directly inspected. This also means the first Plugin had not yet
been applied when the full run was obstructed. The diagnostic artifacts are
`/private/tmp/canvas-native-android-known-logbox-dismiss-artifacts-20261015`.

The normal login and cold-reopen flows now use a narrow test-only helper before linking to Chat. Only the full
known state-update-before-mount notification is matched; its visible inspector must identify ExpoRoot.js. The
helper records notification and stack screenshots, taps Dismiss with retry disabled, and requires that message
to disappear. It installs no LogBox filter, does not change the marker or developer shortcuts, and does not
match unrelated errors. This is documented developer-overlay handling, not a fix for the installed Expo Router
startup issue. All three relevant flow syntax checks pass. Product JS, native67/29 and module hash are unchanged;
the next full attempt must still pass all10 native phases and the independent SQL/runtime/source gates.


### Narrow source guard before Run25

Independent review correctly finds that ExpoRoot.js in a component stack alone is insufficient to identify the
known startup warning. The helper now requires the actual call-stack location `useLinking.native.js:127`
(with optional column), expanding collapsed stack frames through the installed RN inspector UI when necessary.
It records the visible location before dismissing the selected log and fails if that exact call site is absent.
No global warning filter or developer-shortcut override is introduced. All three YAML documents parse.

A separate offline cold-start inspection with an explicitly owned8097 reverse mapping does not reproduce the
warning within30seconds and fails its warning-visible assertion. It provides no new feature acceptance. That
temporary mapping is then removed, with the original8081 mapping retained exactly; its cleanup receipt is
`/private/tmp/canvas-native-android-router-source-probe-mapping-20261015.json`. The next full run must verify
the source guard in a normal fresh fixture if the warning appears, and must still pass all original10 phases.


## Run25: standalone MCP preview still pending at the short scroll deadline

The fresh fixture `/private/tmp/canvas-plugin-extension-e2e-VDXLKZ` passes production build, TypeScript and
normal API setup. Android authenticates, opens the typed-slash picker, applies Plugin and Skill, and selects the
actual standalone MCP connection. The Apply helper fails after251seconds total at its15second scroll deadline.
Actual failure PNG/AX shows the selected MCP detail and ActivityIndicator; there is no LogBox overlay or error
message. The known-warning helper is not exercised because that warning does not appear at startup.
The host records both real MCP transports connected before normal shutdown; these are separate from metadata preview. No preview failure response,
text loss or missing-reference defect is proved. The Apply control is rendered only after asynchronous preview
validation; the normal Mobile API request deadline is20seconds, exceeding the15second test wait.

Normal cleanup is failed_cleaned/droptrue/uncertainfalse. All135 Mobile and18 Notebook files remain exact in
`/private/tmp/canvas-native-run25-terminal-source-proof-20261015.json`. The shared Apply helper now allows up to
60seconds to find the actual validated control, retaining its enabled assertion, real tap and all subsequent
context checks. This changes only a bounded readiness deadline; it neither injects a candidate nor bypasses
verification. Product JS, native module hash and installed67/29 builds remain unchanged. All10 phases and the
independent persisted/runtime/source proof remain required.


## Run26: Android Chat passes; Agent-create keyboard/scroll reachability

The fresh fixture `/private/tmp/canvas-plugin-extension-e2e-MtC2zl` passes production build, TypeScript and
normal API setup. Android Chat passes435.052seconds with its actual native phase receipt: typed-slash Plugin,
Skill, standalone MCP and exact Composio account; real cursor/plain text/atomic delete/native Undo; draft cold
restore; send; highlighted history and two loaded private logos after restart; and plain-caption send without
hidden selection. Root and an independent reviewer inspect the actual images. The first restored draft uses
initials while images load and has no placeholder overlap; the later history image proves the two actual logos.
This is1/10 phases, not the complete parent SDK/SQL/source proof.

The next Agent-create phase fails78.781seconds at `agent-add-extension`. Actual PNG shows the persistent-context
editor, Extensions section heading at the keyboard edge and the Android soft keyboard covering the lower form.
There is no LogBox or product error. Normal cleanup is failed_cleaned/droptrue/uncertainfalse; all135 Mobile and
18 Notebook files are exact in `/private/tmp/canvas-native-run26-terminal-source-proof-20261015.json`.

The flow now closes the Android soft keyboard through the normal OS action after typing the Agent name, then
retains its actual gutter scroll, full visibility and real button tap. Agent-create/edit use centerElement:false
so terminal controls need not be artificially centered. No input injection, direct API save or selector assertion
is removed. A separate owned-device UI probe checks this keyboard/scroll transition against the still-visible
form without a backend; its result is recorded separately below. All original10 phases remain required.

The Apply readiness comment above is corrected to the actual20second Mobile client request window. Source
review confirms Chat preview cumulatively validates existing Plugin/Skill/new connection metadata, exact package
contents/checksums and current rights. It does not initialize MCP, list tools or make a provider business call;
the unrelated Connected host logs do not establish preview completion. Run26's genuine successful Chat phase
provides the eventual-outcome evidence missing in Run25. Installed67/29/module hash remain unchanged.

The separate real Android UI probe passes11seconds after normal keyboard dismissal: the same form's actual
`agent-add-extension` button is fully visible and enabled. It uses no backend, candidates or direct save; it is
reachability evidence only. The screenshot/JUnit are under
`/private/tmp/canvas-native-android-agent-keyboard-probe-artifacts-20261015` and
`/private/tmp/canvas-native-android-agent-keyboard-probe-20261015.xml`. Relevant YAML documents parse.


## Run27: Android Chat repeats successfully; returned picker keyboard covers Create

The fresh fixture `/private/tmp/canvas-plugin-extension-e2e-lHIPqy` passes build, TypeScript and normal API setup.
Android Chat passes again (542.788seconds). Agent-create reaches and taps the formerly covered Add Extension button after
closing the name keyboard, then correctly selects the per-user Canva connection rule. Its next Create-button
scroll fails (126.433seconds phase total). Actual PNG shows that selected rule and the Android keyboard reopened/retained
after the picker; Create remains below it. No policy/preview error or LogBox is visible. Normal cleanup is
failed_cleaned/droptrue/uncertainfalse; all135 Mobile+18 Notebook hashes are unchanged in
`/private/tmp/canvas-native-run27-terminal-source-proof-20261015.json`.

A separate offline UI probe confirms the first normal hideKeyboard preserves the form; deliberately calling it
again without a keyboard navigates back and fails its form-preserved assertion. This diagnostic is a failed
probe, not acceptance. The normal flows therefore use a guarded shared helper: only on Android and only when
actual Gboard key nodes from the owned AVD's recorded AX are visible, hide the keyboard and require those nodes
to disappear. Without those keys it sends no Back action. This helper is called after name entry and after the
Agent picker returns in Create/Edit/Plugin-authoring; iOS is unaffected. Form/choice/Save assertions remain.
Product JS, installed67/29 and module hash remain unchanged; all10 phases and independent parent proof stay open.

The guarded helper's separate actual UI probe passes15seconds: it focuses the real existing Chat input, confirms
Gboard keys, closes them once, then calls the helper again and verifies the same Chat remains with no keyboard.
No input or message/API action is injected. The evidence is
`/private/tmp/canvas-native-android-agent-guarded-keyboard-probe-20261015.xml` and its sibling artifact directory.
All native-extension YAML documents parse. This validates the guard only, not Agent creation or full acceptance.


## Run28: native Chat/Create UI pass; independent Agent lookup blocks acceptance

The fresh fixture `/private/tmp/canvas-plugin-extension-e2e-LE9XCL` passes build, TypeScript and normal API setup.
Android Chat passes6m23s and Agent-create passes92.159seconds through real creation into the Edit view. The
name-entry and post-picker keyboard guards complete. Independent actual PNG review confirms the New→Edit
header transition and retained Canva per-user rule, with no visible error/LogBox. However, the parent immediately
queries the actual `/api/agents?workspaceId=...` Use listing and finds zero rows with the expected exact name.
It stops before Agent-edit. Two native UI receipts are therefore NOT a confirmed parent/save/complete proof.
Normal cleanup is failed_cleaned/droptrue/uncertainfalse; all136 Mobile+18 Notebook hashes are exact in
`/private/tmp/canvas-native-run28-terminal-source-proof-20261015.json`.

The created Agent's files exist under the exact expected normalized ID and correct fixture actor's user path.
A separate real-device offline probe scrolls the existing Edit view and asserts the Agent-name input's exact
full value, passing11seconds. Thus a merely partial-name UI match is not the observed discrepancy. Source review
finds no name/displayName adapter, Profile cache or normalizing transform beyond trim. The Use listing reads
fresh SQL and filters access.canUse; missing personal account/model readiness alone does not explain it.
Changing only the lookup to Configure or blindly retrying would not establish the cause.

The parent test now preserves a mismatch-only private diagnostic before its existing exact assertion: it
revalidates the nonce database/owner/session boundary, then records actual Actor ID, original Use listing,
Configure status/list, and bounded Agent/actor-membership SQL metadata. It writes no account tokens, cookies,
ENV, provider payload or file contents, and changes no product function or assertion. GitNexus cannot locate
this new test file (UNKNOWN); manual scope is one native acceptance test. Native67/29, module hash and Mobile
product JS remain unchanged. A future full run must still supply all10 native phases and independent proof.

The diagnostic also records the bounded organization-setting, selected-workspace and actual actor membership
metadata needed to explain the access-context guard. A standalone nonincremental full-project TypeScript
invocation aborts on Node heap exhaustion before reporting a code error; the next normal production build must
complete its normal TypeScript check on this diagnostic change. No typecheck success is inferred from that abort.


## Run29: actual mismatch is Android name capitalization, not identity/access

The fresh fixture `/private/tmp/canvas-plugin-extension-e2e-Dji487` passes normal production build/TypeScript,
then Android Chat6m33s and Create1m31s. The unchanged exact parent-name assertion fails again, and its new
private diagnostic completes before normal cleanup. Actual Use and Configure lists both contain the newly
created personal Agent, with the exact fixture Actor/Owner, expected organization and full Use/Edit/Manage.
SQL agrees. Parentworkspace is active and owned by the same Actor. The actual difference is one character:
expected `Native UI android 21c3158adb`, stored `Native UI Android 21c3158adb` (offset10,a→A). Independent review
confirms no other whitespace/name discrepancy. The native name field deliberately uses word capitalization;
the earlier offline editor input assertion represented current local draft, not independent stored SQL truth.
No account, Workspace, scope, API-purpose, model-readiness or cache defect is established here.

Normal cleanup is failed_cleaned/droptrue/uncertainfalse. All136 Mobile+18 Notebook hashes are exact in
`/private/tmp/canvas-native-run29-terminal-source-proof-20261015.json`. Test names now explicitly use proper
platform display spelling Android/iOS. The actual marker remains byte-for-byte unchanged. Native Create/Edit/
Plugin-authoring name assertions now require the exact Agent-name input and anchored full text; the parent's
case-sensitive lookup and all remaining metadata/SQL/SDK checks are retained. Product fields and keyboard
behavior are unchanged. GitNexus still has no indexed symbol for this new test; manual scope is test data only.
All flow YAML must parse; native67/29/module hash remain exact and all10 phases still require a fresh full run.


## Run30: deliberately stopped owned build before native launch to align final SQL expectation

During final read-only consistency review of the fresh attempt
`/private/tmp/canvas-plugin-extension-e2e-sTg5CZ`, the final independent SQL verifier is found still expecting
lowercase platform names. Before any native phase, Root terminates only its verified owned build process group
1613 (correct parent/cwd), leaving the runner to execute normal failure cleanup. The runner exits1 with
failed_cleaned/droptrue/uncertainfalse; all136 Mobile+18 Notebook hashes are exact in
`/private/tmp/canvas-native-run30-terminal-source-proof-20261015.json`. This is an intentionally aborted build,
not a compile/feature pass or a native failure. No shared process, device, ADB or listener is stopped.

The final SQL name expectation is aligned with the same explicit Android/iOS display spelling as the UI input
and exact API lookup. It remains a case-sensitive exact assertion; all owner/context/capability/SDK gates are
unchanged. GitNexus cannot index the new verifyRun helper (UNKNOWN); manual scope is the fixture verifier's
single call path, with no product caller. A fresh full native run is still required on this complete test data.


## Run31: exact Agent lookup passes; reopened Plugin controls are below the viewport

The fresh fixture `/private/tmp/canvas-plugin-extension-e2e-mLiLkT` passes build/TypeScript, Android Chat6m51s,
Create1m30s and Edit1m39s; the parent exact-name API lookup now passes unchanged. The Plugin-policy phase
correctly selects package/MCP, authors per-user mode, an explicit MCP default and personal Canva alternative,
saves, cold-restarts and reopens the actual Agent. It then fails232.270seconds at the immediate per-user-mode
assertion following expansion of the terminal capability header. Actual failure PNG/AX place that header at
[105,2198][975,2337], exactly the viewport end; its children are below the visible region. No further scroll was
issued. Independent review confirms no visible wrong policy value or error. The before-Save screenshot proves
the expected authored values, but the failed screenshot alone does not prove restored values.

Normal cleanup is failed_cleaned/droptrue/uncertainfalse, with136 Mobile+18 Notebook files exact in
`/private/tmp/canvas-native-run31-terminal-source-proof-20261015.json`. A separate actual-device offline UI probe
then scrolls that already cold-restored form and confirms per-user mode, Remove default and personal Canva
checked:true, passing14seconds. It changes no policy or backend state; it is restored UI evidence, not a full
phase or independent SQL/SDK pass. Artifacts:
`/private/tmp/canvas-native-android-package-reopened-scroll-probe-artifacts-20261015`.

The normal flow now explicitly gutter-scrolls below that expanded terminal header before requiring the same
exact fully visible policy value. All default/checked/Save/reopen and parent proofs remain unchanged. Product
JS, installed67/29 and module hash are unchanged; all10 phases and independent final proof remain required.


## Run32: all Android phases pass; iOS AX focus differs from actual keyboard focus

The fresh fixture `/private/tmp/canvas-plugin-extension-e2e-gZ1EU1` passes build/TypeScript and all five Android
phases: Chat384.460s, Create92.044s, Edit98.085s, Package-policy234.006s and My-connection36.054s. Independent
actual PNG/JUnit review confirms editing/Undo, restored drafts without placeholder overlap, loaded Plugin/MCP
history images, plain captions without references, reopened package defaults/personal Canva and the exact
saved/reopened account label. The direct parent before/after central-Agent snapshot also passes. The possible
Flow40 viewport gaps do not occur in this actual device layout; both slot cards fit the viewport. These five
receipts do not replace the final all-ten-phase SQL/runtime proof.

iOS stops at the new initial `focused:true` assertion after tapping the real editor. The actual failure PNG shows
a blue caret and open iOS keyboard; the same AX snapshot reports `focused:false` for the editor and all keyboard
nodes. No marker has yet been typed and no reference/send failure is established. Normal cleanup is
failed_cleaned/droptrue/uncertainfalse; all136 Mobile+18 Notebook files remain exact in
`/private/tmp/canvas-native-run32-terminal-source-proof-20261015.json`.

A separate actual iOS UI-only probe then passes8seconds: the real `UIKeyboardLayoutStar Preview` is visible,
actual typing produces the exact marker and trailing space in the actual Chat input, and the keyboard remains
visible. It sends no message, changes no policy and uses no live backend. Evidence:
`/private/tmp/canvas-native-ios-focus-field-probe-20261015.xml` and its sibling artifact directory. The normal
flow retains all Android `focused:true` checks, while iOS requires its observed actual keyboard and exact typed
marker/space values before the common real typed-slash trigger. The marker, send/reference assertions, native
sources and binaries67/29 are unchanged. Full native acceptance remains pending.

Two separate read-only review observations remain outside this feature acceptance: Mobile HEAD already
rejected a history page containing a text above200000characters although previous plain sends had no such
limit; and a server-generated personal-choice preview warning is rendered in English in the otherwise German
Agent form. The former is a pre-existing length-contract defect; the latter is a localization follow-up with no
observed incorrect policy or saved value. Neither is concealed as a full verification/provider/device pass.


## Run33: both Chat phases pass; iOS Agent Add is covered by the keyboard

The fresh fixture `/private/tmp/canvas-plugin-extension-e2e-n6BQim` passes build/TypeScript, all five Android
phases (Chat416.475s, Create96.815s, Edit106.003s, Package254.216s, My-connection36.260s), and iOS Chat388.236s.
Independent actual PNG/JUnit review confirms both platforms' native editing/Undo, preserved drafts, four inline
sent references, loaded Plugin/MCP history images and plain captions without minted authority. Android's exact
policy/account review and parent central-Agent before/after equality pass again. This run also exercises the
narrow known-warning helper: Android's actual startup stack shows `useLinking.native.js:127:47`; subsequent
feature pictures are free of the warning. The warning was not globally suppressed or removed from the product.

iOS Create fails45.825s before opening the picker. Actual AX places Add at[14,629]–[388,673] and the keyboard at
[0,583]–[402,816]; the otherwise fully on-screen button is entirely behind the OS keyboard. The tap reaches a
keyboard key instead, and no picker/save occurs. Normal cleanup is failed_cleaned/droptrue/uncertainfalse;
all136 Mobile+18 Notebook hashes are exact in
`/private/tmp/canvas-native-run33-terminal-source-proof-20261015.json`. There are six successful phase receipts,
not a complete native/independent-parent acceptance.

The guarded form helper now also handles the actual iOS keyboard container. Maestro's generic hideKeyboard
attempt fails explicitly; a separate interactive-drag probe closes the keyboard but encounters an XCTest
control-flow-interruption/transport failure. A subsequent probe correctly fails its keyboard-present
precondition because the preceding drag had already closed it. None is recorded as a pass. The final separate
actual probe first refocuses the real Agent-name field, confirms the keyboard, uses the form's existing
keyboardDismissMode=interactive outer-gutter drag, invokes the same guard again with no keyboard, and confirms
the Add button fully visible/enabled in the same form. It passes19seconds without saving, sending, modifying
policy or using a live backend. Evidence:
`/private/tmp/canvas-native-ios-agent-keyboard-probe-fourth-20261015.xml` and its sibling artifacts. Android's
existing guarded normal hideKeyboard remains unchanged.

The next full run exercises iOS first, then still requires every Android phase and the unchanged independent
parent proof. GitNexus cannot locate this new test file (UNKNOWN); manual impact is only its single native
acceptance entry path, with no product caller. The order change does not relax any receipt, equality, SQL,
metadata, SDK, marker or source-hash assertion. Product JS, native hash and installed67/29 remain unchanged.

The iOS restored-draft/Undo PNGs show a limited, internally scrolled text viewport, sometimes clipping a partial
line. They are not claimed to show all selected references simultaneously. The final sent/history text is
complete. Read-only review confirms unchanged min40/max128 input styles and actual Originaldelegate→Fabric
state/measurement updates; it does not establish a newly introduced autoheight defect, absent delegate or data
loss. Exact loaded TextView bounds/contentSize remain a separate layout follow-up; no speculative value/text
echo or UI change is introduced from these pictures alone.


## Run34: iOS Create reaches the real button; no completed creation is established

The fresh fixture `/private/tmp/canvas-plugin-extension-e2e-6sh7hR` passes build/TypeScript and iOS Chat315.158s.
The new actual-keyboard guard succeeds in the normal iOS Create flow: Add opens the real picker and the
per-user Canva rule is selected. Create then fails128.811s at the later Save-button lookup. Actual PNG/AX and
XCTest touch logs place the enabled Create button at[14,734]–[171,769] and the real single tap at(92,751), with
no keyboard, modal or error overlay. The next upward gesture begins about1.16seconds after tap completion.
The later exact name assertion passes, but the final screen remains New Agent/Create enabled, not Edit/Save.
There is no evidence here of a geometrically missed button or successful creation.

No expected Agent files exist in either possible scope after the run. Host logs have no Agent HTTP access
records, so they establish neither a POST attempt nor its absence; simulator trustd OCSP timeouts are unrelated
system messages. Read-only source review finds no specific Save-guard/API defect. The existing iOS
handled/interactive ScrollView and native SwiftUI Save button were already present in Mobile HEAD. RN can
consume a tap during momentum; its keyboard-dismiss path additionally requires live keyboard metrics, so
remaining input focus alone is insufficient. Neither condition is claimed to explain this actual tap without
further evidence.

Normal cleanup is failed_cleaned/droptrue/uncertainfalse. All136 Mobile+18 Notebook files are exact in
`/private/tmp/canvas-native-run34-terminal-source-proof-20261015.json`. One successful phase receipt is not
complete native acceptance. A separate actual idle-form probe, with port3001 confirmed unused and the fixture
database already dropped, waits for animation then taps Create once. The actual form displays its normal
save-failed error, passing4seconds. Evidence:
`/private/tmp/canvas-native-ios-agent-idle-create-probe-20261015.xml` and its sibling artifacts. This proves the
handler can be reached in the idle form; the generic UI error alone is not proof that an HTTP POST was sent.
No successful write or Agent state is manufactured by this probe.

The next test flow adds bounded waitForAnimationToEnd before each single Create/Save tap. After Create it must
observe the actual Edit route header before issuing further form gestures. There is no automatic retry of a
mutating tap, and the exact API/SQL/name/receipt checks remain. The missing HTTP evidence is addressed with a
native-fixture-only private metadata observer; its separate validation is recorded below. Product code, native
hash and installed67/29 remain unchanged. All ten phases and the independent parent proof still remain open.


The native-only runner now generates a private Node HTTP diagnostics-channel preload for its owned host. It
observes only exact Agent-configuration POST/PATCH requests on port3001, recording request ID, timestamp,
start/finish phase, method, fixed pathname and response status. It reads/logs no headers, query, body, actor,
tokens or credentials and does not consume or alter requests/responses. Root/nonce/UID/dev/inode/mode checks,
exclusive0600O_APPEND/O_NOFOLLOW trace creation and64request/128event/64KiB bounds keep it fixture-scoped.
The existing model observer and production application sources are unchanged. Append problems stop only this
diagnostic, with a fixed marker; they do not change request handling.

The actual isolated Node --import/ephemeral HTTP unit passes, including unchanged body delivery, POST201/PATCH409,
GET/otherpath/query/otherport exclusions, zero sensitivity markers, scope rejection and event/byte limits.
Log: `/private/tmp/canvas-native-agent-request-observer-unit-20261015.log`. Independent inspection confirms128
actual newline-delimited records,22786bytes and the exact SIX metadata fields listed above (the unit's human
summary says seven in error). Runner syntax and Mobile flow YAML parse checks pass. GitNexus cannot locate
runFixture (UNKNOWN); manual impact remains only the owned native test-host launcher. No product function,
provider call, device or existing service is replaced by this observer. The following full run remains required.


## Run35: Create does not navigate; request-observer liveness still needs an actual-host control

The fresh fixture `/private/tmp/canvas-plugin-extension-e2e-vfISoc` passes build/TypeScript and iOS Chat318.543s.
Create fails94.177s at the stronger actual-Edit-header wait after its single Create tap and animation wait.
The real failure PNG still shows New Agent/Create enabled with the selected personal Canva rule and no error
or keyboard overlay. No successful navigation/save is established. The native HTTP trace exists but has zero
events. The isolated observer unit alone does not prove it observes this actual Next host; therefore zero is
not yet interpreted as proof that no client/API attempt occurred.

Normal cleanup is failed_cleaned/droptrue/uncertainfalse; all136 Mobile+18 Notebook hashes remain exact in
`/private/tmp/canvas-native-run35-terminal-source-proof-20261015.json`. One successful phase receipt is not a
complete acceptance. Source inspection confirms the Mobile authenticated/workspace client uses the exact
configuration path without query selectors, and the host uses node:http.createServer. These sources narrow
possible filtering gaps but do not substitute for a positive actual-host observation.

The next native fixture first verifies host CWD and sole listener PID, then issues one deliberately rejected
PATCH control against that owned endpoint, without cookie/authorization and with only an empty JSON object and
a dummy Workspace selector. It must receive401/403. The status-only private response record is preserved before
assertion; after consuming the response, exactly matching start/finish metadata with one request ID and the
same status must exist. Only then may the browser/device phases run. A private control proof records nonce,
fixed method/path, rejection status, request ID and trace checksum. Scoped-route source and independent review
confirm it cannot authorize a write. No authenticated business mutation, automatic tap retry, product or native
source change is added. Runner syntax passes. GitNexus runFixture remains UNKNOWN/unindexed; manual impact is
only the owned native fixture launcher. All ten phases and parent proof remain required.


### Lauf 36: iOS-Chat bestanden; Create bleibt vor einer beobachteten Mutation offen

Der vollständige native Lauf `YQ0UQD` ist terminal `failed_cleaned`, `databaseDropped:true`, `uncertain:false`. Ein tatsächliches iOS-Chat-Receipt besteht mit Entwicklungsbuild `0.1.4/67` und dem nativen Quellenhash `12de4586f546f1965809a8c20e75c5608eeca9d76939a8e4324aafccfdf1f1af`. Die vollständige Agent-/Android-Abnahme und der unabhängige Parentabschluss sind nicht erreicht. Alle 136 erfassten Mobile- und 18 Notebook-Dateien sind gegenüber dem eingefrorenen Stand unverändert; der terminale Nachweis liegt unter `/private/tmp/canvas-native-run36-terminal-source-proof-20261015.json` (SHA-256 `2e1eac37f74b3139bd48cc0a1663d2784de31953bbe4c2c627357c67ff0f7d9e`).

Der neue Beobachter ist diesmal auch am tatsächlich gestarteten, über CWD und Listener-PID geprüften Next-Host positiv nachgewiesen. Der native-only Kontrollaufruf sendet vor jeder Geräteinteraktion einmal `PATCH /api/mobile/v1/agents/configuration` ohne Cookie oder Authorization und mit ungültigem Mutationsinhalt `{}`. Der Host lehnt ihn mit HTTP 401 ab. Das private Trace enthält genau dessen zusammengehörige Start-/Finish-Ereignisse um `12:24:13.308Z` und `12:24:13.314Z`. Statusbeleg und Controlproof liegen im eigenen Fixtureverzeichnis `/private/tmp/canvas-plugin-extension-e2e-YQ0UQD`; der SHA-256 des Trace ist weiterhin `17211513a33a5ae34c9a50b038b876ea35c14feb22dbac5cc12ef3e8b597fcb3`. Der Beobachter protokolliert sechs Metadatenfelder und keine Header, Queries, Bodies, Accounts oder Tokens.

Die Create-Phase findet die aktivierte Schaltfläche nach der Wartezeit auf das Animationsende. Maestro führt einen einzelnen Tap bei `(92,751)` aus; der zugehörige tatsächliche Tap ist mit `12:31:31.128Z` korreliert. Die anschließende verbindliche Warteprüfung auf den Edit-Header `^Agent$` scheitert. Es folgen keine weiteren passenden HTTP-Ereignisse im geprüften Hosttrace; im Hostlog gibt es auch keinen Stopmarker des Beobachters. Das belegt die fehlende zusätzliche Beobachtung am exakt überwachten Listener/Methoden-/URL-Pfad. Es beweist allein weder eine Touchzustellung an den React-Handler noch, ob ein clientseitiger Versuch vorher abgebrochen wurde.

Eine anschließend rein lesende Auswertung des eigenen Hermes-Laufzeitzustands findet die aktuelle `AgentEditorForm` gemountet (`mountedRef:true`). Deren Mutation bleibt `status:"idle"`, `submittedAt:0`, `failureCount:0`, `isPaused:false`; native `onButtonPress`-Callbacks sind als vorhanden ausgewiesen. Die erfasste ScrollView ist weder animierend noch berührt; Tastaturmetrik und -höhe fehlen. Der korrigierte Beleg liegt unter `/private/tmp/canvas-native-ios-agent-runtime-after-run36-clock-20261015.json` (SHA-256 `c12f626a5a013ff1c68b702b7995963554ed04d03fee60ab89da2564d6f8a53a`). Diese Werte sind eine Zustandsaufnahme und kein Beleg, dass der native Tap einen Callback erreicht hat.

Nach der bestätigten Bereinigung folgt eine separate Einzel-Tap-Probe am erhaltenen iOS-Formular mit inzwischen beendetem Fixturehost. Mehrere Minuten nach dem Gesamtlauftap wird dieselbe sichtbare Schaltfläche an derselben Koordinate einmal betätigt. Die erwartete sichtbare Save-Fehlermeldung erscheint innerhalb der Prüfzeit nicht; auch diese Probe ist fehlgeschlagen und keine Create-Abnahme. Die anschließende rein lesende Laufzeitaufnahme zeigt erneut dieselben gemounteten/idle/submittedAt-0-Werte. Artefakte: `/private/tmp/canvas-native-ios-agent-idle-create-probe-run36-artifacts-20261015`; Laufzeitbeleg: `/private/tmp/canvas-native-ios-agent-runtime-after-idle-probe-run36-20261015.json` (SHA-256 `29c2c65e03ab8b7b312ebc0b4c818bbfbb6e8ff5eec1efd497e06f72b39602c9`). Die Probe ist vom vollständigen Harness getrennt; sie ersetzt weder dessen lebenden Host noch eine erfolgreiche Mutation.

Die erste CDP-Verbindung zur eigenen App wurde wegen fehlendem Origin mit 401 abgewiesen. Danach erfolgte die zulässige Verbindung mit passendem Origin; es wurden Laufzeitzustände gelesen und keine Ereignisse, Formularzustände oder Mutationsergebnisse erzeugt. Ein erster privater Zeitvergleich mit `Date.now` wurde durch eine explizite zusätzliche monotone Aufzeichnung berichtigt; die korrigierten Belege führen Wallclock und monotone Zeit getrennt. Das ändert keine Produktsemantik und wird nicht als Produktkorrektur gewertet.

Damit ist die zuvor offene Nachweisgrenze des Beobachters am tatsächlichen Host geschlossen. Die Ursache zwischen nativem Touch-/Hit-Test-Pfad und dem aktuellen Mutationseinstieg bleibt offen. Ein API-, Autorisierungs-, Preview- oder Zuordnungsfehler wird aus diesen Belegen nicht behauptet. Quell- und Nativebuildstände, Geschäftsaktionszähler sowie die zehn verbindlichen Abnahmekriterien bleiben unverändert; physische Geräte, IME, aktive Screenreader, externe Provider und Main/Produktion sind weiterhin eigene Nachweisgrenzen.


### Actual iOS native hit region and the scoped Host correction

Read-only LLDB inspection attaches only to the verified owned simulator app PID36011, reads UIKit geometry, and detaches. The first three attempted geometry expressions fail to compile with the installed SDK; their raw logs are preserved and establish no geometry. The fourth uses a typed UIKit NSInvocation to read `hitTest:withEvent:` at the actual tap point92,751, without synthesizing any event. It returns the form background `RCTViewComponentView`, not the SwiftUI action. The successful result and `DETACH success` are in `/private/tmp/canvas-native-ios-agent-native-hit-chain-fourth-run36-20261015.log`.

A subsequent successful read-only Host traversal establishes the discrepancy: the Save/Create Expo Host and inner UIHostingView both have window rect x14,y751.6667,width157,height34.3333, while the actual AX Button rect used by the test is x14,y734,width157,height35. The outer Host reports zero safe-area insets; its inner SwiftUI UIHostingView reports bottom34. The tap at y751 is therefore above the real Host boundary even though it is at the center of the rendered/AX Button. These exact native results are retained in `/private/tmp/canvas-native-ios-agent-native-hosts-run36-20261015.log` and `/private/tmp/canvas-native-ios-agent-native-host-insets-run36-20261015.log`. The app stays resumed after the bounded debugger attachment.

GitNexus cannot resolve the newly extracted AgentEditorForm, so its risk remains UNKNOWN rather than false-safe. The existing AgentEditorScreen entry resolves LOW with the NewAgentRoute and EditAgentRoute as two direct callers. Manual source review bounds the change to this form's action Host. The exact [Expo SDK57 Host documentation](https://docs.expo.dev/versions/v57.0.0/sdk/ui/swift-ui/host/) and installed SwiftUI Host/HostingView source confirm the supported safe-area control. The RN form already owns SafeAreaView and automaticallyAdjustKeyboardInsets. The minimal product correction adds `ignoreSafeArea="all"` only on iOS for this Host, with no Android value, no mutation/API/validation change and no dependency or native binary change. The native source hash and installed67/29 remain unchanged.

After Metro Fast Refresh preserves the real existing form, the same separate one-tap offline probe now passes with JUnit1test/0failures in3.932s (`/private/tmp/canvas-native-ios-agent-host-fix-probe-20261015.xml`). Its actual screenshot shows the ordinary visible save error. Read-only Hermes now finds the real current MutationObserver in error with submittedAt1792068239426 and failureCount1, rather than idle/submittedAt0 (`/private/tmp/canvas-native-ios-agent-runtime-after-host-fix-probe-20261015.json`). This is evidence that the real tap reaches the mutation after the scoped Host correction. It is deliberately not a successful API/Agent write because the fixture server is offline. No handler is called through the debugger, no state/result is fabricated, and no retry is added to the actual acceptance flow.

Fresh app/scripts TypeScript and focused Agent-editor ESLint checks pass. The full native ten-phase run, independent persisted-context proof and final verification remain required on this corrected source. Long restored drafts remain internally scrollable; these diagnostics do not establish simultaneous visibility of all reference captions or automatic composer height acceptance.


## Run37: reference removed before restart; exact caret preservation gates

Run37 (`/private/tmp/canvas-plugin-extension-e2e-rQIYAQ`) passes build/TypeScript/normal setup and the actual-host observer401 control. Its iOS Chat phase fails after4m22s at the restored-draft three-caption assertion, before any Send or Agent phase. Terminal cleanup is failed_cleaned/droptrue/uncertainfalse. `/private/tmp/canvas-native-run37-terminal-source-proof-20261015.json` confirms all136 Mobile/18 Notebook files unchanged during the run; there are zero phase receipts and no final parent proof.

The actual failure AX contains the original marker, Skill and MCP but no Plugin. The earlier `native-three-inline-references` PNG does show all three references, while its40pt internally scrolled viewport leaves the plain marker above the visible area. The first cursor probe then taps at48,460, on the visible Plugin line, types0 and erases one character. Its old regex requires only marker+0 and the MCP tail, so it does not establish Plugin preservation. The subsequent plain-tail and before-restart PNGs already lack the Plugin. This is not loss first introduced by draft loading. An interior edit invokes the existing atomic-removal policy; without the intermediate value immediately after0, replacement versus insertion/erase is not fully distinguished. No new native boundary defect is asserted.

A separate bounded actual-device probe pans the existing UITextView DOWN, verifies the real marker screenshot, taps the plain beginning and types0 before the original marker, then erases exactly that0. The exact original marker and both remaining genuine references survive; JUnit1test/0failures,12s (`/private/tmp/canvas-native-ios-caret-plain-start-probe-20261015.xml`). This probe uses the retained offline draft with the already missing Plugin, so it is not three-reference/full-run acceptance. Actual screenshots were reviewed, including the visible plain marker and caret before it. Native source/builds and original marker identity are unchanged.

The iOS harness now reveals the plain beginning through that genuine DOWN pan, uses the observed leading caret position, and requires every original caption immediately after0 and after erase1. It also requires all original references through the later tail typing/deletion and Undo steps. Android's existing cursor position is unchanged. These are stronger preservation assertions, not relaxed body/selection requirements.

An additional tail-pan probe is retained as FAILED (`/private/tmp/canvas-native-ios-caret-tail-pan-probe-20261015.xml`). Its actual PNG shows the Expo Refreshing banner: the controller mistakenly ran it concurrently with the broader Mobile verification whose generators trigger Metro Fast Refresh. It is not a valid stable-app product diagnosis. No further device probe is run until that verification and any generators finish. This failed experiment does not change any acceptance condition or justify a product edit.

## Current-last-user SDK proof tightening

Read-only review finds the older native SDK check matched `some` completion carrying a platform marker anywhere in history. The actual two Run36 completions separately contain2pins/3routes on the inline turn and0pins/0routes on the plain turn, but their retained projections do not carry a current-user digest. They cannot be retroactively promoted to exact CID correlation. The SDK serializer does not transmit the original CID.

The test-only projection now reads the actual LAST user turn, derives its complete public-text SHA256 and UTF16 length, and matches them one-to-one to the independently SQL-validated original CIDs. Only the exact known appended runtime-context envelope may be separated; no caption, whitespace, FFFC or Unicode normalization is permitted. The parent requires exactly four distinct SDK completions with the two immutable pins/three exact routes on each original inline turn and zero explicit turn pins/routes on each later plain turn. Fixed relevant Skill context may legitimately remain. Pure regression coverage includes the old later-turn masquerade, duplicated/missing/extra calls, digest/source/account/pin mismatch and legitimate fixed-Skill context on the plain turn. New actual SDK correlation remains pending in the next full run; no old proof is rewritten as passed.


## Stable actual caret and final pre-run verification

The attempted native-Undo recovery after Fast Refresh fails because Undo is not enabled (`/private/tmp/canvas-native-ios-caret-tail-stable-position-20261015.xml`). No lost Plugin/MCP context is manufactured. A subsequent stable real UP pan and trailing-padding tap completes normally. The current owned app PID60656 is independently reverified from the exact owned simulator executable path before read-only LLDB inspection. The actual editable, first-responder UITextView reports selectedRange74,0 with textStorage.length74, contentOffset0,18, contentSize364,58 and bounds364,40. This establishes the actual collapsed caret at the existing document end, not a coordinate assumption (`/private/tmp/canvas-native-ios-tail-current-selected-range-20261015.log`, successful result and detach).

From that actual position, a separate real edit probe erases the existing six plain characters, verifies the genuine remaining Skill, appends the six plain characters again and erases them again without losing the Skill. JUnit1test/0failures,8.136s (`/private/tmp/canvas-native-ios-caret-tail-stable-edit-20261015.xml`). It is a targeted retained-draft probe with one remaining genuine reference, not the three-reference/full-run acceptance. The iOS full harness now pans back UP and taps the observed trailing padding before its tail edit. Android's proven tail action stays unchanged. Full strict Plugin/Skill/MCP preservation gates remain mandatory throughout the next fresh run; no controlled selection or artificial state is added.

Fresh Mobile `npm run verify` completes every preceding gate and exits1 only at Expo Doctor19/20 with13 SDK patch recommendations (`/private/tmp/canvas-chat-inline-final-verify-20261015.log`). The separately run production-runtime audit, all-platform Expo export and canonical server-source check all exit0 (`/private/tmp/canvas-chat-inline-final-production-audit-20261015.log`, `/private/tmp/canvas-chat-inline-final-export-20261015.log`, `/private/tmp/canvas-chat-inline-final-source-check-20261015.log`). The canonical shared contract remains351777bytes; dependency specifications and build counters are not changed for these checks. Passing the runtime audit is not a claim that every development/build dependency is advisory-free.

A broad Notebook `tsc --noEmit` attempt exhausts its default4GiB heap; its8GiB retry reports errors across unrelated test files and two owned assert.throws signatures. Those two owned signatures are corrected without changing test semantics and both pure suites pass again (47 SDK cases;12 rejected central-Agent changes). The broad all-scripts project is not claimed green. The actual configured `tsconfig.release.json` check exits0. The new isolated pure SDK helper/test profile also exits0 when supplied the repository's explicit Node types. Initial private combined-profile type-resolution failures are preserved separately; they are not hidden by ignoring diagnostics. The final actual production build and strict native SDK context run remain required on the final frozen source.

The final combined strict profile extends the actual release configuration and explicitly includes all14 owned TypeScript files. With the repository's canonical Node/React type roots it exits0 (`/private/tmp/canvas-native-final-owned-typecheck-explicit-types-20261015.log`). The new pure SDK profile with explicit canonical Node types also exits0. This does not claim the unrelated broad all-scripts configuration is green. Fresh iOS/Android Metro bundles/maps match all13 selected runtime source files exactly at `/private/tmp/canvas-native-caret-final-metro-gwzkr7zp/proof.json`. No source generators remain active before the next native run.


## Run38: iOS Chat/Create/Edit pass; Plugin phase blocked by clipped target

Run38 (`/private/tmp/canvas-plugin-extension-e2e-iN2t8Y`) passes the fresh production build, configured TypeScript and actual-host observer control. Actual iOS Maestro receipts pass Chat (322.334s), Agent Create (81.25s) and Skill Edit (96.511s). Independent actual PNG/AX/JUnit review confirms all three references survive the stronger caret/erase/Undo/draft gates, sent inline icons and history remain highlighted, and plain-caption text stays unhighlighted. Create now enters the real mutation and navigates to the saved Edit view; Edit preserves the exact Skill and per-user Canva rule across reopen. This closes those phase-level checks only. The complete ten-phase/Android/parent milestone remains open.

The actual SDK proof endpoint reports two distinct current-user digests: iOS inline has exactly2pins/3routes; later plain has0pins/0routes while retaining permissible fixed context. These are actual SDK projections, not yet final original-CID/SQL correlation. No provider completion is promoted to a final parent pass.

The iOS Package Policy phase fails before selecting any Plugin. The Add control exists and is enabled in AX at `[14,856][388,900]`, below the actual outer form viewport ending at840. The conditional free-gutter swipe is SKIPPED because the visibility predicate already sees that offscreen AX node. Default centered scrolling repeatedly uses x201,y437→87 and does not reveal the target; the actual failure PNG shows only the extension heading/description at the bottom. There is no missing Add control, picker failure or saved-policy failure established by this result.

A separate real single free-gutter swipe `(98%,55%)→(98%,20%)`, followed by animation completion, reveals the genuine Add control in the retained form. The targeted probe passes JUnit1test/0failures in5s; the actual screenshot `/private/tmp/canvas-native-ios-agent-outer-scroll-probe-20261015.png` shows the fully visible control, preserved Skill/Canva cards and native Save button. The package flow now performs that one unconditional iOS outer-form pan after the exact name check, before its unchanged strict100%-visibility gate and single picker tap. Android and product code remain unchanged; the installed Maestro syntax checker passes.

Terminal cleanup is `failed_cleaned`, `databaseDropped:true`, `uncertain:false`. `/private/tmp/canvas-native-run38-terminal-source-proof-20261015.json` confirms all136 Mobile/20 Notebook files unchanged during the complete run, exactly3phase receipts and no final parent proof. The next full run must still pass all ten phases, independent source/SQL/SDK/Agent checks, actual PNG review and normal cleanup on a newly frozen source.


## Run39: all ten actual UI phases pass; parent usage gate remains open

Run39 (`/private/tmp/canvas-plugin-extension-e2e-vkE4TY`) passes all ten genuine Maestro phases on the unchanged development binaries iOS67/Android29 and native-source hash12de4586f546f1965809a8c20e75c5608eeca9d76939a8e4324aafccfdf1f1af. Actual phase durations are iOS Chat325.830s/Create83s/Edit96s/Package252.332s/MyConnection42.923s and Android Chat429.441s/Create94.687s/Edit99.143s/Package253.630s/MyConnection35.914s. All ten JUnits are successful; independent actual PNG/AX review covers all phases, including cold reopening of saved package rules and the exact personal account value. The second suspected iOS Name→Plugin scroll boundary does not occur in the actual run; no speculative additional pan is added.

This is not a complete parent acceptance. The live independent parent verifies the frozen native artifacts and reaches its SQL session/history/receipt checks, then fails at `verifyRun`151 on `COUNT(usage)>=2 && SUM(total_tokens)>0`. It produces no `chat-extension-native-verified.json` and no pass marker. The later independent package/source/account/current-SDK/Agent assertions have not all run. The exact failed COUNT/SUM values were not preserved; the normally dropped database is not reconstructed and no values are invented.

The actual provider proof does contain exactly four distinct current-user SDK fingerprints: iOS inline2pins/3routes, iOS plain0/0, Android inline2/3, Android plain0/0. That is separately observed actual SDK evidence, not the missing final original-CID/SQL correlation. The host has no persisted-message errors; its provider-token measurements remain null. Source inspection identifies a concrete test-provider protocol defect: the nonstreaming fixture response sends usage1/1/2, but the actual streaming branch sends content, stop and DONE with no usage chunk. The installed actual SDK uses streaming and initializes usage to zero until real provider usage arrives. The productive usage writer correctly omits all-zero rows. This justifies a scoped test-provider SSE correction and a real installed-SDK loopback regression, rather than product accounting changes or weakening the SQL gate.

Normal terminal cleanup is `failed_cleaned`, `databaseDropped:true`, `uncertain:false`. Exactly ten phase receipts remain, with no parent proof. Terminal source report `/private/tmp/canvas-native-run39-terminal-source-proof-20261015.json` (SHA256 `8703ee6a880d05631dfe483aacb715f6ed84fd304d913b2d868a2b8fac8ca0a0`) confirms all136 Mobile and20 Notebook files and both HEADs unchanged during the entire run. A fresh complete run and actual independent parent pass remain necessary after the test-only correction.

Actual UI review records separate visible limits: the long iOS restored draft remains flat and internally scrollable; Android shows all three reference captions across three input lines. Both platforms show a very long profile row beyond the inner chooser-card edge while both actual account targets remain accessible. The Android package cold-start diagnostics retain a React-State-before-mount toast and LogBox stack at `useLinking.native.js:127:47`; the normal test flow closes the diagnostic and the actual feature after-save/reopen images are clear. This is not a claim of a completely overlay-free run or a diagnosed navigation root cause. The server-generated personal-connection explanatory warning remains English in the German form. These limits do not become physical-device, real-IME, hardware-keyboard, active-screenreader, live-provider or production evidence.


### Controlled streaming provider correction and actual SDK regression

`writeChatInlineModelResponse` is the single actual fixture response writer used by both the normal owned provider handler and the focused unit HTTP boundary. Its JSON response remains1input/1output/2total; SSE now adds one standard usage-only chunk with `choices:[]` before `[DONE]`. Content, stop reason, fixture counters, ownership guards, productive sources and the independent SQL usage gate are unchanged. GitNexus cannot resolve the unindexed fixture/new-test symbols (UNKNOWN); manual caller review confines them to the controlled test runner and the new unit CLI.

`./node_modules/.bin/tsx scripts/chat-inline-model-stream-usage-test.ts` passes through the actual installed `@earendil-works/pi-ai`1.0.4 adapter export `api/openai-completions`, with the same ollama/openai-completions model shape and three requests to an owned ephemeral127.0.0.1HTTP server. The negative boundary removes precisely the new usage chunk from the actual writer and reproduces0parsedtokens; the normal writer yields1input+1output=2tokens. The regression also checks real SDK text/stop/done, the final empty-choices usage event, nonstream JSON parity, exact request count and normal server/connection cleanup. It writes no usage rows and contacts no database, app listener3001, external provider or device.

The first attempted unit import fails before HTTP because the SDK API export is ESM-only; the corrected test uses the actual dynamic export. The first combined15-file TypeScript check then reports only a missing SDK TranscriptContext brand in the new test. The test is corrected with the installed public `normalizeContext` producer, without a cast or fabricated brand; the real SDK regression passes again. These failed attempts are not productive defects or successful validations. The final strict profile extending the real release configuration with all15ownedTypeScriptfiles exits0 (`/private/tmp/canvas-native-final-owned-typecheck-15-final-20261015.log`); the earlier failed log remains preserved. An independent read-only review finds no actionable findings in the two-file correction.

The final writer SHA256 is1673bfc3feb77c965a9f35136043824af39e5da43fff4d9d1e372a20a8761784; the corrected regression SHA256 isc8a62034ff97ac00ab7fa5a7e2a6907987f419473d17bff0cf03e9e41f353271. Mobile product/native sources, development builds67/29 and the13-runtime-source actual Metro proof are unchanged from Run39. A fresh complete source-frozen run is required to close the still-open parent acceptance; the existing all-ten UI receipts are not rewritten as a full pass.


## Run40: complete native acceptance and independent parent PASS

The fresh production build, configured TypeScript, all ten actual Maestro UI phases and the unchanged independent parent verifier pass in `/private/tmp/canvas-plugin-extension-e2e-3hZqJB`. The runner exits0 and emits `PLUGIN_EXTENSION_E2E_PASS`. The parent proof `chat-extension-native-verified.json` has SHA256 `b063bf7ae95377c2b874fabd2972c6af8185f71bf58f395bfd36b2c4a48559d2`. Its live SQL usage-event/token gate now passes through the normal productive writer; no usage rows are manufactured and no assertion is weakened.

| Actual phase | JUnit suite seconds | Result |
| --- | ---: | --- |
| android-agent-create | 96.039 | PASS |
| android-agent-edit | 97.714 | PASS |
| android-agent-package-policy | 241.963 | PASS |
| android-chat | 402.623 | PASS |
| android-my-connection | 34.822 | PASS |
| ios-agent-create | 88.228 | PASS |
| ios-agent-edit | 96.038 | PASS |
| ios-agent-package-policy | 245.712 | PASS |
| ios-chat | 344.47 | PASS |
| ios-my-connection | 40.195 | PASS |

The independent parent validates the original two persisted user CIDs per platform, receipt intent/private payload hashes, succeeded execution snapshots, exact public inline bodies, two immutable package/Skill pins, three exact personal routes and correct distinct supporting/standalone MCP connections. The actual four SDK completions are matched one-to-one to those original SQL-validated CIDs by complete last-user text SHA256 and UTF16 length: inline2pins/3routes, later plain0/0, fixed relevant Skills permitted. All four original CID/digest pairs are distinct. Central Agent before/after snapshots including bindings/revisions are identical through personal account choice; the actual saved package policy and separate own-account preference are independently inspected on both platforms. Provider-forbidden, connector-business, MCP-tool and blocked-redirect counters remain0. This is controlled native SDK transport evidence, not a new external LLM or provider business action.

The terminal source report `/private/tmp/canvas-native-run40-terminal-source-proof-20261015.json` confirms all136 Mobile/21 Notebook captured files and both HEADs unchanged throughout the run. Mobile combined source SHA256 is27629718cba085d9a7f14523a7ce43721317c4ea9d6d14f3c60d558da8c61cea; Notebook combined source SHA256 isb2dcb7fcd2551dd0c23bd91d7fe74194e8e07e2d504d448ed978586f781349dc. Every phase has identical frozen Mobile feature sources; installed development builds67/29 match native hash12de4586f546f1965809a8c20e75c5608eeca9d76939a8e4324aafccfdf1f1af. The13-runtime-source Metro proof remains exact and unchanged.

Independent actual PNG/AX/JUnit review covers all ten phases. Inline references, native edits/Undo, drafts, sent/reloaded history logos and plain-caption styling are confirmed. iOS shows its known flat internally scrollable composer, while Android shows three draft lines. Android Edit-Reopen's key image shows the Skill at the viewport edge rather than every card fully visible. The early Android own-account Reopen image still shows loading; the later normal `native-android-my-connection-artifacts/native-final.png` and final AX show the fully loaded exact account c6b59f87d6 plus required MCP with its checkmark. Root also inspects that actual final image. Current Android Chat warning branches42/152/191 are SKIPPED; no new actual Chat warning is inferred from a command heading. Historical Run39 warnings remain historical. Long profile-row overflow and the English server explanation remain explicit UI follow-ups.

Normal runner recovery is `cleaned`, databaseDropped:true, uncertain:false. After rechecking ownership, the owned Metro87432 and QEMU84984 are stopped and only iOS simulatorDFD2D10C-F8A3-45BC-8582-8584E0A4A180 is shut down. `/private/tmp/canvas-native-run40-owned-device-cleanup-20261015.json` confirms other simulator states and shared ADB60563/88697 preserved, ports3001/8097 free, driver-owned reverse mappings removed and the original8081mapping preserved until owned-device shutdown. No storage or evidence is deleted.

After this actual pass, reviewed completion patches update the three Mobile documents and four Notebook plan/journal documents; this evidence journal is the eighth documentation delta. The post-doc source report `/private/tmp/canvas-native-run40-post-docs-source-proof-20261015.json` checks those exact eight paths and unchanged bytes for every other captured source. The latest15-file/release type profiles, actual streaming SDK regression and prior Mobile verification/export/runtime-audit/source-check limits remain explicit. Expo Doctor19/20, the broad Notebook Scripts typecheck, physical devices, real IME, hardware keyboards, active accessibility, live external providers, Main and production are not promoted to passed by this local milestone.
