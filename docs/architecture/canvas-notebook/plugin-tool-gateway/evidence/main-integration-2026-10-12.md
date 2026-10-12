# Notebook main integration — 2026-10-12

The publication candidate merges Notebook feature `d40c9fa68` with current `origin/main` `c21824b06927ff4a2e39d40afc62d50d909ab44c`. The feature had 88 commits and main had 103 since their common base; 25 files overlapped. Nine conflicts were resolved by preserving both contracts, including the stricter filtered gateway operation ceiling, mailbox-bound recipient operations, personal MCP/plugin capabilities, Dictation and conditional rich-document migration. Translation keys from both parents were retained without duplicate keys. Compliance artifacts were regenerated from the merged lockfile: approved, zero license release blockers. No release version or tag was created.

## Fresh validation

- `npm ci --no-audit --no-fund`: PASS with actual PI Agent/AI SDK `1.0.4`; no old dependency/build reuse.
- `npm run build`: final PASS on the combined source. The first attempt compiled successfully but lacked the adjacent Control Plane source needed by native test typechecking in this new checkout. A local reference to the existing paired source was configured; the complete second production build, including TypeScript and prebuild checks, exited0. `BUILD_ID` is the project's existing fixed `build-TfctsWXpff2fKS` and is not treated as a unique source proof. The accepted combined source tree before evidence additions is `39c83ac2b5007a8c7cfc705b570c4887b0888bb7`.
- Focused ESLint over380 affected product files and resolved Mobile tests: PASS, zero warnings. Diff checks PASS.
- Complete `test:integrations:gateway`: PASS, including real PostgreSQL context/authority, MCP HTTP/STDIO and local Composio SDK transport, dispatcher, uncertainty, delegation, registry and shared connection contracts. The separate `test:integrations:gateway:managed` with the actual paired Control Plane root also PASS, removing the first suite's explicit Managed skip.
- `test:pi:progressive-gateway`, `test:pi:effective-tools`, `test:pi:tools`, actual email-recipient Agent tools, `test:pi:sdk-contract` (17/17), and `test:pi:metadata-contract`: PASS.
- `test:plugins:catalog`, `test:plugins:provenance`, `test:plugins:workspace-ui`, `test:skills:scripts`, `test:agents:workflow:integration`, `test:agents:workflow:packages`, and `test:files:lifecycle`: PASS.
- `test:mobile:bootstrap` plus the compatibility model/route tests: PASS. The full compatibility npm chain stops later in the pre-existing `mobile-app-promotion-test.ts` because its standalone invocation requires `DATABASE_URL`; that promotion test is not accepted by this run. No managed production data was substituted for it.

Some CommonJS synthetic test loaders log the SDK's import-only `compat` export as unavailable while forwarding unbridged `require`; correct production imports remain ESM. The real SDK contract and the fresh production model/UI run below cover actual imports and execution; no SDK downgrade or product import rewrite was made from that diagnostic.

## Complete production model/UI run

Original command: `node scripts/agent-settings-tools-browser-runner.cjs run-workflow-natural-model /absolute/owned/normal-model-input.json`. The original launcher exited0; one serial Playwright case, one worker, no retries: 1/1 PASS in6.8minutes. Input remained private. Own root `/private/tmp/canvas-agent-settings-browser-U1RpSC`, nonce `5f091a7eaa8b650243824cd168d5acb5`.

The actual `ollama/kimi-k2.6:cloud` model, thinking off, executed each ordinary Use-only user's published V2 skill/script once. The production UI exercised owner publication/configuration and resource sharing. Both users retained current package responsibility metadata, exact package bytes and fixed Team MCP/Organization Composio bindings. There were four successful exact-bound provider effects and four correlated actual audits, with current schemas described before execution. Model responses/tool calls were not injected. Root inspected both result screenshots.

These providers are controlled local MCP/Composio SDK fixtures. This is a fresh merged-runtime regression, not a repeat of the genuine Canva API test. The separate 11October live four-read Composio/Canva acceptance in `step-7-live-composio-model-acceptance.md` remains its own external-service evidence.

Worker `verified_closed`, outstanding null, normal auth/context closure true. Parent `cleaned`, uncertainfalse, provider closed, both owned databases and DATA/TMP removed. Root independently checked original Parent67680/Host73825/Issuer71686/Browser78613 and three detached groups absent, both own databases and sessions absent, owned DATA/TMP absent; listeners3001/53185 absent. Existing managed services and foreign workspace changes were preserved, and the coordinated PostgreSQL window was released.

## Evidence and publication boundaries

- [main-integration-natural-root-proof.json](main-integration-natural-root-proof.json): SHA256 `3b304529a9d0c52f8ef8f06e510299e0c960d105923edb502f2b31f8d5429da3`
- [main-integration-natural-audit-proof.json](main-integration-natural-audit-proof.json): SHA256 `f8a404f51c0c153f6fd73a9efd8f57fbf35a242330a767770d72f999e70c110b`
- [main-integration-natural-user-1.png](main-integration-natural-user-1.png): SHA256 `b432ba7be2f4297bb8e5e454dee0aca1feeae98896d73597c2b0b2df60889fd6`
- [main-integration-natural-user-2.png](main-integration-natural-user-2.png): SHA256 `9fd2e6b505b4318a0e9dae1751a5c4af0c4a5126265bcad51ff46a931ea80949`

GitNexus compared/staged review remains CRITICAL because this integration spans Agent authority, database and runtime surfaces. Direct source reviews verified the overlapping migrations, source ceilings, mailbox binding, capability grants, file lifecycle fencing, native contracts and proxy guards; the original foreign AGENTS.md/CLAUDE.md edits are excluded.

No repository-owned PR/push-to-branch build/test workflow or required status-check rule is configured; main rules prohibit deletion/non-fast-forward updates. GitHub default CodeQL scans run after publication and their results are separate from the local tests. The normal fast-forward push of `46066cc3e4d637f6b3d5e13c068a470825e9c243` was verified against the actual remote main ref. Existing Dependabot alerts predate this push (1critical/7high/2moderate/1low); publication does not resolve those dependency findings. Step7 remains in progress, the global gateway default stays off, and no deployment/container build/release or default activation is claimed. Genuine external MCP acceptance, broader rollout/default/telemetry comparison and product documentation remain separate. Strict Mobile production audit remains23HIGH/0CRITICAL. The paired Mobile feature branch has not been published by this Notebook acceptance.
