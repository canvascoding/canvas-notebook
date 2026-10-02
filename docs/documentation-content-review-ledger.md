# Public documentation review ledger

Notebook source commit: `428abc24b9669ba9b17bf96136baba469e5276ac` (release `2026.10.1.2`).
Control Plane worktree: `/Users/frankalexanderweber/.codex/worktrees/docs-usability/canvas-control-plane` at `9ced80737cc5bc41004b517ea09888d3698e3ed7`.
Notebook runtime: managed local stack, rebuilt from the Notebook worktree on 2026-10-02; health OK; PostgreSQL 18.4. Browser: Google Chrome. Notebook production build/login and Control Plane `docs:generate`, markdown/search tests, typecheck, and production docs E2E passed. The Control Plane Docker image was not replaced; E2E used the successful host production build on port 4005 to avoid disturbing the shared stack while other agents ran tests.

Current coverage: 55 of 120 pages reviewed; 65 pages remain pending. Eleven pages have content changes across the quickstart/navigation, retired-Heartbeat, and automation-run corrections; 44 pages across Core Features, Notebook/Knowledge, and agent/automation guides were checked against implementation and left unchanged. A pending page has not been certified.

Runtime limitations observed: Bradley reports `No valid runtime available`; Studio reports `GEMINI_API_KEY is missing`; clicking `New automation` reaches `Something went wrong`; Notebook reports live updates disconnected in the test workspace. The secondary fixture account did not authenticate with the expected fallback password, so the existing local bootstrap administrator was used. The full quickstart path could not be completed. Email inbox/send and external Studio generation were not tested.

| Page | Status | Evidence, issues, changes, verification |
|---|---|---|
| `docs/product/en/admin/account-instance-settings.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/ai-providers.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/backups.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/data-migration.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/install-linux.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/install-macos.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/install-windows.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/license.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/public-sharing-security.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/security-data.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/self-hosting.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/system-email.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/troubleshooting.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/updates-rollback.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/users-permissions.mdx` | pending | Not reviewed yet. |
| `docs/product/en/admin/vm-cli.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/browser-access.mdx` | reviewed | No copy change: browser controls are in `app/components/settings/BrowserSettingsPanel.tsx` and `app/components/settings/AgentBrowserCard.tsx`; managed Chromium behavior is under `app/lib/pi/browser`. Runtime/tool/export availability are separate settings. Actual browser-tool run and network-block behavior were not exercised. |
| `docs/product/en/agents/chat-attachments.mdx` | reviewed | No copy change: chat attachment intake is implemented in `app/components/canvas-agent-chat/useChatFileDrop.ts` and `app/api/upload/attachment/route.ts`; API enforces a size limit. No file was uploaded; model-specific image/document handling remains unverified in UI. |
| `docs/product/en/agents/chat-file-references.mdx` | reviewed | No copy change: reference parsing/cap is in `app/lib/chat/tool-file-references.ts`; display and file-section grouping are in `app/components/canvas-agent-chat/RunFileReferenceCard.tsx` and `ChatMessageList.tsx`. `@` selection and historical result rendering were not exercised in UI. |
| `docs/product/en/agents/create-specialized-agent.mdx` | reviewed | No copy change: the seven named templates and scope controls are defined in `app/components/settings/CreateAgentDialog.tsx`; access follows `app/lib/agents/access.ts`. UI showed Agent Settings but no agent was created because runtime readiness was unavailable. |
| `docs/product/en/agents/delegation.mdx` | reviewed | No copy change: delegated task records, dispatch, cancellation, and delivery are implemented under `app/lib/pi/delegation-store.ts`, `delegate-task-tool.ts`, and `delegation-dispatcher.ts`. No worker was dispatched. |
| `docs/product/en/agents/doctor.mdx` | reviewed | No copy change: the diagnostic endpoint is `app/api/agents/doctor/route.ts`; implementation checks runtime, managed prompt composition, and knowledge indexing. The UI showed a missing runtime, but a complete Doctor report was not captured. |
| `docs/product/en/agents/instructions-and-profiles.mdx` | reviewed | No copy change: managed profile editing is in `app/components/agents/EditAgentProfileDialog.tsx`; Bradley's fixed identity priority is in `app/lib/agents/bradley-identity.ts`. Profile mutation and clean-session behavior were not tested. |
| `docs/product/en/agents/managed-prompt-files.mdx` | changed | Corrected obsolete claim that six files are active editable prompts. `AGENTS.md`, `SOUL.md`, and `TOOLS.md` contribute to normal session context; `USER.md`/`MEMORY.md` are legacy import/export, and `HEARTBEAT.md` is retired. Verified against `app/lib/agents/storage.ts`, `app/lib/agents/bradley-identity.ts`, `app/lib/agents/memory-store.ts`, and the retired Heartbeat API. UI editing was not exercised. |
| `docs/product/en/agents/members-permissions.mdx` | reviewed | No copy change: use/edit/manage checks and organization grants are enforced in `app/lib/agents/access.ts`; the member UI is `app/components/agents/AgentMembersEditor.tsx`. No permission was changed or cross-user access tested. |
| `docs/product/en/agents/memory.mdx` | reviewed | No copy change: durable memory CRUD and scope are implemented in `app/lib/memory/service.ts` and injected through `app/lib/memory/prompt-projection.ts`; legacy-file import is in `app/lib/memory/legacy-migration.ts`. No memory entry was created or removed. |
| `docs/product/en/agents/models-and-providers.mdx` | reviewed | No copy change: effective options/readiness are exposed by `app/components/canvas-agent-chat/ChatModelSelector.tsx` and runtime catalog APIs. Agent Settings showed Bradley Main/Fixed and No valid runtime available; provider setup and model execution remain unverified. |
| `docs/product/en/agents/overview.mdx` | reviewed | No copy change: chat composer, session context, tools, and agent selection are implemented in `app/components/canvas-agent-chat/ChatComposer.tsx`, `ChatHeader.tsx`, and session hooks. No agent turn was run because no valid runtime was available. |
| `docs/product/en/agents/plan-mode.mdx` | reviewed | No copy change: Planning Mode is toggled with `Shift+Tab` in `app/components/canvas-agent-chat/PlanModeToggle.tsx`; its explicit read-only tool whitelist is `app/lib/pi/planning-mode.ts`. A planning session was not run. |
| `docs/product/en/agents/sessions-history.mdx` | reviewed | No copy change: session history selection and bootstrap are implemented in `app/components/canvas-agent-chat/useChatSessionHistory.ts` and `useChatSessionBootstrap.ts`. No new or existing session was altered; account retention behavior remains policy-dependent as documented. |
| `docs/product/en/agents/tool-activity.mdx` | reviewed | No copy change: tool events and status rendering are handled in `app/components/canvas-agent-chat/useChatRuntimeEvents.ts` and `ChatToolRunMessages.tsx`. No live run was available to inspect. |
| `docs/product/en/agents/tools.mdx` | reviewed | No copy change: tool selection is managed by `app/components/settings/AgentToolsCard.tsx`; Planning Mode uses the whitelist in `app/lib/pi/planning-mode.ts`; post-edit link diagnostics are attached in `app/lib/pi/agent-file-link-diagnostics.ts`. A tool was not invoked in this runtime. |
| `docs/product/en/agents/workspace-project-access.mdx` | reviewed | No copy change: current workspace binding is represented in workspace/chat state; specialized-agent grants are enforced in `app/lib/agents/access.ts`. UI confirmed an active workspace selector exists, but no workspace/agent grant was changed or cross-scope read tested. |
| `docs/product/en/automations/delivery.mdx` | reviewed | No copy change: channel/session fallback and workspace ownership checks are implemented in `app/lib/automations/delivery.ts` and `app/lib/automations/chat-targets.ts`. Delivery UI, channel delivery, and failure pause behavior were not exercised. |
| `docs/product/en/automations/heartbeat-config.mdx` | changed | Replaced retired Agent Settings instructions with migration guidance. Source route `app/api/automations/heartbeat/route.ts` returns 410 `HEARTBEAT_RETIRED`; unauthenticated runtime GET was intercepted with 401, so the handler response was verified from source. `app/lib/automations/store.ts` migrates legacy jobs to workspace schedules, retaining schedule, delivery target, and run history and moving instructions into the prompt. Migration/review UI not exercised. |
| `docs/product/en/automations/heartbeat-vs-automation.mdx` | changed | Reframed as scheduled versus webhook-triggered workspace automations; explains that the separate Heartbeat workflow is retired and legacy jobs migrate. Verified against `app/lib/automations/types.ts`, `app/lib/automations/store.ts`, and the 410 legacy settings route. Webhook and schedule UI runs remain unverified. |
| `docs/product/en/automations/manual-runs.mdx` | changed | Corrected invalid instruction to run a paused job. `app/api/automations/jobs/[jobId]/run-now/route.ts` queues the run, while `scheduleAutomationJobRun` in `app/lib/automations/store.ts` rejects inactive/paused jobs and prevents a second in-flight run. Manual UI test remains blocked by New automation opening Something went wrong. |
| `docs/product/en/automations/overview.mdx` | changed | Added monthly schedules and corrected manual-test timing. Schedule kinds match `app/lib/automations/types.ts` and `app/lib/automations/schedule.ts`; job execution requires active status in `app/lib/automations/store.ts`. Automation UI creation remains unavailable in this runtime. |
| `docs/product/en/automations/prompts.mdx` | reviewed | No copy change: prompts, context paths, output targets, and untrusted webhook event fields are assembled by `app/lib/automations/prompt.ts` and `runner.ts`. No automation prompt was run. |
| `docs/product/en/automations/run-history.mdx` | reviewed | No copy change: `AutomationRunStatus` states and trigger types match `app/lib/automations/types.ts`; retries are bounded to three attempts in `app/lib/automations/runner.ts`. No run record was available to inspect in the test workspace. |
| `docs/product/en/automations/scheduled.mdx` | changed | Added monthly schedule and corrected paused/manual test sequence. Monthly day/time controls are in `app/apps/automations/components/AutomationsClient.tsx`; schedule normalization is in `app/lib/automations/schedule.ts`; run-now rejects inactive jobs. UI creation and schedule save remain unverified. |
| `docs/product/en/automations/troubleshooting.mdx` | reviewed | No copy change: timezone/working-hour calculations are in `app/lib/automations/schedule.ts`; runner deadline is ten minutes and retries are bounded in `app/lib/automations/runner.ts`; webhook jobs have no next scheduled time in store logic. No failure record was available for UI comparison. |
| `docs/product/en/automations/webhooks.mdx` | reviewed | No copy change: custom secrets use the `whsec_` prefix in `app/lib/automations/webhook-secret.ts`; the endpoint requires a Bearer secret in `app/api/automations/webhooks/[webhookId]/route.ts`; payloads are marked untrusted in `app/lib/automations/prompt.ts`. No webhook or connected-app trigger was created. |
| `docs/product/en/automations/workspace-output.mdx` | reviewed | No copy change: authorized workspace selection and move previews are enforced in `app/lib/automations/workspace-change.ts`; output path handling is in `app/lib/automations/paths.ts` and runner prompt context. No workspace move or file output was executed. |
| `docs/product/en/collaboration/agent-human-tasks.mdx` | pending | Not reviewed yet. |
| `docs/product/en/collaboration/agent-workspace-access.mdx` | pending | Not reviewed yet. |
| `docs/product/en/collaboration/brand-profiles.mdx` | pending | Not reviewed yet. |
| `docs/product/en/collaboration/live-documents.mdx` | pending | Not reviewed yet. |
| `docs/product/en/collaboration/notifications.mdx` | pending | Not reviewed yet. |
| `docs/product/en/collaboration/switching-workspaces.mdx` | pending | Not reviewed yet. |
| `docs/product/en/collaboration/todos-approvals.mdx` | pending | Not reviewed yet. |
| `docs/product/en/collaboration/usage-costs.mdx` | pending | Not reviewed yet. |
| `docs/product/en/collaboration/workspace-members.mdx` | pending | Not reviewed yet. |
| `docs/product/en/collaboration/workspace-types.mdx` | pending | Not reviewed yet. |
| `docs/product/en/collaboration/workspaces-overview.mdx` | pending | Not reviewed yet. |
| `docs/product/en/email/ai-workflows.mdx` | pending | Not reviewed yet. |
| `docs/product/en/email/attachments.mdx` | pending | Not reviewed yet. |
| `docs/product/en/email/connect.mdx` | pending | Not reviewed yet. |
| `docs/product/en/email/draft-reply.mdx` | pending | Not reviewed yet. |
| `docs/product/en/email/gmail-smtp-imap.mdx` | pending | Not reviewed yet. |
| `docs/product/en/email/main-system-email.mdx` | pending | Not reviewed yet. |
| `docs/product/en/email/multiple-inboxes.mdx` | pending | Not reviewed yet. |
| `docs/product/en/email/overview.mdx` | pending | Not reviewed yet. |
| `docs/product/en/email/policies.mdx` | pending | Not reviewed yet. |
| `docs/product/en/email/read-organize.mdx` | pending | Not reviewed yet. |
| `docs/product/en/email/troubleshooting.mdx` | pending | Not reviewed yet. |
| `docs/product/en/features/ai-agent.mdx` | changed | Removed obsolete dedicated-heartbeat capability and clarified supported work triggers. Remaining runtime/model/access claims match `app/components/canvas-agent-chat/ChatModelSelector.tsx`, `app/components/settings/AgentSettingsPanel.tsx`, and agent APIs. UI showed Main/Fixed and No valid runtime available; real agent execution remains unverified. |
| `docs/product/en/features/automations.mdx` | changed | Removed dedicated Heartbeat claims, added monthly schedules, and corrected manual-test order for active jobs. Schedule/webhook types are implemented in `app/lib/automations/schedule.ts`; run-now rejects inactive jobs and duplicate in-flight runs. New automation UI returned Something went wrong; create/run/delivery remain unverified. |
| `docs/product/en/features/email.mdx` | reviewed | No copy change: email account/message/send flows are implemented under `app/apps/email` and `app/api/email`; Settings > Email visibly separates Connect an account and System email. Inbox access, draft review, attachments, policy behavior, and sending remain unverified; no account was connected and no mail was sent. |
| `docs/product/en/features/knowledge-base.mdx` | reviewed | No copy change: file and Markdown capabilities are present in `app/components/file-browser`, `app/components/editor`, and `app/lib/markdown`; the file-create dialog was verified in Notebook UI. The test workspace showed live updates disconnected, so saved edits, backlinks, graph, preview, and sharing workflows remain unverified. |
| `docs/product/en/features/skills.mdx` | reviewed | No copy change: skill UI is implemented in `app/components/settings/SkillsPanel.tsx`, with protected env access through `/api/integrations/env`; Studio's Open central credentials entry point was visible. Installing/enabling a skill or plugin and invoking it remain unverified in UI. |
| `docs/product/en/features/studio.mdx` | reviewed | No copy change: generation controls and output handling are implemented under `app/apps/studio`; provider credential UI is in `app/components/settings/StudioMediaCredentialsPanel.tsx`. Studio UI showed GEMINI_API_KEY is missing and Open central credentials. No generation, provider cost, or output save was attempted; those behaviors remain unverified. |
| `docs/product/en/index.mdx` | changed | Expanded orientation and removed the obsolete Heartbeat workflow claim. UI evidence: app switcher lists Quick access (Notebook, Automations, To-dos, Email, Studio) and More apps; settings navigation verified in Chrome. Notebook 2026.10.1.2, runtime source 428abc24b9669ba9b17bf96136baba469e5276ac. Latest docs E2E verified page routes, links, anchors, raw Markdown, search, and llms outputs after the correction. |
| `docs/product/en/integrations/browser-runtime.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/build-skill.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/channel-delivery.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/connected-apps.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/enable-skills.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/environment-variables.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/install-skill.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/manage-plugins.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/mcp.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/plugins-overview.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/secrets.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/skill-md.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/skills-overview.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/telegram.mdx` | pending | Not reviewed yet. |
| `docs/product/en/integrations/upload-skill.mdx` | pending | Not reviewed yet. |
| `docs/product/en/interface-guide.mdx` | changed | New orientation guide based on observed app-switcher labels and Settings groups in Notebook 2026.10.1.2. Chrome 1440x900, light. Local docs generation, markdown checks, search checks, and production docs E2E pass; shared CP container remains on its prior image. |
| `docs/product/en/notebook/backlinks.mdx` | reviewed | No copy change: backlink relations are derived in `app/lib/markdown/workspace-document-relations.ts` and shown by `app/components/editor/MarkdownBacklinksPanel.tsx`. Related Markdown relation claims match implementation; editor panel remains unverified because live updates were disconnected in the test workspace. |
| `docs/product/en/notebook/code-files.mdx` | reviewed | No copy change: code/text editor and preview handling are implemented in `app/components/editor/CodeEditor.tsx` and `app/components/files/FilePreviewDialog.tsx`. Editing or running a code file was not attempted in the shared test workspace. |
| `docs/product/en/notebook/document-graph.mdx` | reviewed | No copy change: graph nodes and unresolved targets are modeled in `app/apps/knowledge-graph/lib/knowledge-graph-model.ts`; the graph UI is under `app/apps/knowledge-graph/components`. Graph interaction was not exercised in UI. |
| `docs/product/en/notebook/embeds.mdx` | reviewed | No copy change: Markdown workspace embeds are implemented in `app/components/shared/WorkspaceMarkdownEmbed.tsx` and `app/lib/markdown/obsidian-embed.ts`. Embedded content exposure warning retained; embed rendering was not exercised in the disconnected test workspace. |
| `docs/product/en/notebook/excalidraw.mdx` | reviewed | No copy change: scene editor and agent operations exist in `app/components/editor/ExcalidrawEditor.tsx` and `ExcalidrawAgentOperations.tsx`; public view is read-only in `app/components/public-sharing/PublicExcalidrawViewer.tsx`. Scene editing/sharing were not run. |
| `docs/product/en/notebook/exports.mdx` | reviewed | No copy change: Markdown/PDF export is implemented under `app/lib/pdf` and `app/public/markdown-pdf`; Marp export uses `app/components/file-browser/MarpExportDialog.tsx`. Page correctly states PDF capability can be unavailable; exports were not generated. |
| `docs/product/en/notebook/file-explorer.mdx` | reviewed | No copy change: workspace tree and active-workspace file selection are implemented in `app/components/file-browser/FileBrowser.tsx` and `app/store/file-store.ts`. Notebook UI confirmed the Create > New file dialog; folder navigation/opening was not tested here. |
| `docs/product/en/notebook/file-operations.mdx` | reviewed | No copy change: file creation API is `app/api/files/create/route.ts`; workspace operation link review is implemented in `app/lib/markdown/workspace-file-operation-planner.ts`; public shares track source identity under `app/api/security/public-shares`. Rename/move/delete were not performed. |
| `docs/product/en/notebook/file-previews.mdx` | reviewed | No copy change: format-specific preview entry point is `app/components/files/FilePreviewDialog.tsx`; HTML preview consent is in `app/components/editor/HtmlPreviewConsent.tsx`. Supported previews remain conditional as documented; those formats were not opened during this review. |
| `docs/product/en/notebook/markdown-editor.mdx` | reviewed | No copy change: rich/source mode is implemented in `app/components/editor/MarkdownEditorClient.tsx` and `MarkdownDocumentModes.tsx`; persisted file writes use `app/store/file-store.ts`. The test workspace reported disconnected live updates, so editing/autosave was not verified. |
| `docs/product/en/notebook/markdown-formatting.mdx` | reviewed | No copy change: Markdown extensions are implemented in `app/lib/markdown/canvas-markdown.ts`, `canvas-rich-markdown-extensions.ts`, and the shared core fixtures. Examples use standard Markdown plus documented Canvas wiki/frontmatter extensions; rendering was not exercised in the test workspace. |
| `docs/product/en/notebook/marp.mdx` | reviewed | No copy change: Marp file detection/render/export are implemented under `app/lib/marp` and `app/components/editor/MarpPreview.tsx`. PDF/PNG/JPEG output is capability-dependent as documented; no deck was rendered or exported. |
| `docs/product/en/notebook/overview.mdx` | reviewed | No copy change: Notebook shell, file browser, editor, agent chat, and terminal integrations are present in `app/components/file-browser`, `app/components/editor`, `app/components/canvas-agent-chat`, and `app/components/terminal`. Actual terminal execution and agent work remain unverified because no runtime was ready. |
| `docs/product/en/notebook/properties.mdx` | reviewed | No copy change: frontmatter normalization and aliases/tags handling are in `app/lib/markdown/obsidian-metadata.ts`; editor UI is `app/components/editor/MarkdownPropertiesPanel.tsx`. Property editing was not exercised because live updates were disconnected. |
| `docs/product/en/notebook/public-share-management.mdx` | reviewed | No copy change: share listing/actions use `app/[locale]/(routes)/security/public-shares/PublicSharesClient.tsx` and `app/api/security/public-shares`; missing/stale states are represented in the public-share service. No shares were created, copied, or revoked. |
| `docs/product/en/notebook/public-sharing.mdx` | reviewed | No copy change: public file preview is read-only in `app/components/public-sharing/PublicFilePreview.tsx`; HTML preview response/security boundaries are implemented in `app/lib/html-preview-response.ts` and share APIs. The signed-out public flow was not opened. |
| `docs/product/en/notebook/uploads-downloads.mdx` | reviewed | No copy change: upload/download endpoints are under `app/api/files` and downloads are assembled in `app/api/files/download/route.ts`. No user files were uploaded or downloaded during review. |
| `docs/product/en/notebook/wiki-links.mdx` | reviewed | No copy change: `[[wiki links]]` and path/heading resolution are implemented in `app/lib/markdown/obsidian-link-resolver.ts` and editor extensions; the index and backlink model live in `workspace-link-index-core.ts` and `workspace-document-relations.ts`. UI link navigation was not exercised. |
| `docs/product/en/quickstart.mdx` | changed | Substantially rewritten; screenshot placeholders replaced by five current cropped app screenshots. Chrome 1440x900, light, Notebook 2026.10.1.2 from runtime source commit 428abc24b9669ba9b17bf96136baba469e5276ac. UI evidence: Bradley is Main/Fixed and Agent Settings reports No valid runtime available; AI provider readiness controls, file-create dialog, missing Studio credential prompt, and separate user/system email areas verified. Automations list loads but New automation opens Something went wrong. Removed obsolete Heartbeat guidance and corrected Run Now sequence: paused jobs must be activated, with a future scheduled time, before manual testing. Editor save, agent execution, automation run, Studio generation, and email send remain unverified; no messages sent or external generation invoked. Latest docs E2E passed. |
| `docs/product/en/studio/aspect-ratio.mdx` | pending | Not reviewed yet. |
| `docs/product/en/studio/bulk-generation.mdx` | pending | Not reviewed yet. |
| `docs/product/en/studio/edit-images.mdx` | pending | Not reviewed yet. |
| `docs/product/en/studio/generate-images.mdx` | pending | Not reviewed yet. |
| `docs/product/en/studio/generate-videos.mdx` | pending | Not reviewed yet. |
| `docs/product/en/studio/models.mdx` | pending | Not reviewed yet. |
| `docs/product/en/studio/outputs.mdx` | pending | Not reviewed yet. |
| `docs/product/en/studio/overview.mdx` | pending | Not reviewed yet. |
| `docs/product/en/studio/presets.mdx` | pending | Not reviewed yet. |
| `docs/product/en/studio/provider-credentials.mdx` | pending | Not reviewed yet. |
| `docs/product/en/studio/reference-images.mdx` | pending | Not reviewed yet. |
| `docs/product/en/studio/save-to-workspace.mdx` | pending | Not reviewed yet. |

## Screenshot assets

Quickstart references five real Chrome screenshots in `docs/product/en/assets/quickstart-*.png`, captured from the rebuilt local app using the controlled local workspace. Email screenshot shows settings without credentials or account addresses. Screens demonstrate current UI state, including unmet model/provider prerequisites; they do not imply that generation or delivery was tested.

## Validation status — 2026-10-02

- Notebook production build and rebuilt local Notebook container passed; Notebook health and bootstrap login passed.
- Control Plane `docs:generate` against this Notebook worktree generated 120 pages. `test:docs-markdown` passed 5/5, `test:docs-search` passed 8/8, and workspace typecheck passed.
- Control Plane host production build passed and generated the same 120 local pages. Its Docker image build stalled while the OrbStack Docker Engine stopped responding to `docker info`; it was interrupted before container replacement. To avoid changing the shared stack while other agents run tests, the CP production build was served on free host port 4005.
- Docs Playwright E2E passed 12/12 checks against the latest production build, including the retired-Heartbeat and automation-run corrections: 120 pages, 516 TOC targets, desktop/mobile, light/dark, search, navigation, Markdown copy, raw source, and no browser runtime errors. Screenshots/report are in `/tmp/canvas-docs-e2e-automation-fixes-2026-10-02`. The shared CP container on port 4004 remains the prior build and returns 404 for `/docs/interface-guide`; no container replacement was needed for this verified docs package.
