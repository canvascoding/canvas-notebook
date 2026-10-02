# Public documentation review ledger

Notebook source commit: `428abc24b9669ba9b17bf96136baba469e5276ac` (release `2026.10.1.2`).
Control Plane worktree: `/Users/frankalexanderweber/.codex/worktrees/docs-usability/canvas-control-plane` at `9ced80737cc5bc41004b517ea09888d3698e3ed7`.
Notebook runtime: managed local stack, rebuilt from the Notebook worktree on 2026-10-02; health OK; PostgreSQL 18.4. Browser: Google Chrome. Notebook production build/login and Control Plane `docs:generate`, markdown/search tests, typecheck, and production docs E2E passed. The Control Plane Docker image was not replaced; E2E used the successful host production build on port 4005 to avoid disturbing the shared stack while other agents ran tests.

Current coverage: 9 of 120 pages reviewed; 111 pages remain pending. Three pages were changed in the quickstart/navigation commit; six Core Features overviews were checked against implementation and left unchanged. A pending page has not been certified.

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
| `docs/product/en/agents/browser-access.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/chat-attachments.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/chat-file-references.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/create-specialized-agent.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/delegation.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/doctor.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/instructions-and-profiles.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/managed-prompt-files.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/members-permissions.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/memory.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/models-and-providers.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/overview.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/plan-mode.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/sessions-history.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/tool-activity.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/tools.mdx` | pending | Not reviewed yet. |
| `docs/product/en/agents/workspace-project-access.mdx` | pending | Not reviewed yet. |
| `docs/product/en/automations/delivery.mdx` | pending | Not reviewed yet. |
| `docs/product/en/automations/heartbeat-config.mdx` | pending | Not reviewed yet. |
| `docs/product/en/automations/heartbeat-vs-automation.mdx` | pending | Not reviewed yet. |
| `docs/product/en/automations/manual-runs.mdx` | pending | Not reviewed yet. |
| `docs/product/en/automations/overview.mdx` | pending | Not reviewed yet. |
| `docs/product/en/automations/prompts.mdx` | pending | Not reviewed yet. |
| `docs/product/en/automations/run-history.mdx` | pending | Not reviewed yet. |
| `docs/product/en/automations/scheduled.mdx` | pending | Not reviewed yet. |
| `docs/product/en/automations/troubleshooting.mdx` | pending | Not reviewed yet. |
| `docs/product/en/automations/webhooks.mdx` | pending | Not reviewed yet. |
| `docs/product/en/automations/workspace-output.mdx` | pending | Not reviewed yet. |
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
| `docs/product/en/features/ai-agent.mdx` | reviewed | No copy change: overview remains consistent with `app/components/canvas-agent-chat/ChatModelSelector.tsx`, `app/components/settings/AgentSettingsPanel.tsx`, and agent access APIs. Notebook 2026.10.1.2 UI evidence: Agent Settings showed Main/Fixed, while readiness reported No valid runtime available. A real agent conversation and specialized-agent workflow remain unverified. |
| `docs/product/en/features/automations.mdx` | reviewed | No copy change: schedules and webhook types are implemented in `app/lib/automations/schedule.ts`; run-now rejects an in-flight job in `app/api/automations/jobs/[jobId]/run-now/route.ts`. Automations list UI loaded, but New automation returned Something went wrong, so creating, manually running, scheduling, output, and delivery remain unverified in UI. |
| `docs/product/en/features/email.mdx` | reviewed | No copy change: email account/message/send flows are implemented under `app/apps/email` and `app/api/email`; Settings > Email visibly separates Connect an account and System email. Inbox access, draft review, attachments, policy behavior, and sending remain unverified; no account was connected and no mail was sent. |
| `docs/product/en/features/knowledge-base.mdx` | reviewed | No copy change: file and Markdown capabilities are present in `app/components/file-browser`, `app/components/editor`, and `app/lib/markdown`; the file-create dialog was verified in Notebook UI. The test workspace showed live updates disconnected, so saved edits, backlinks, graph, preview, and sharing workflows remain unverified. |
| `docs/product/en/features/skills.mdx` | reviewed | No copy change: skill UI is implemented in `app/components/settings/SkillsPanel.tsx`, with protected env access through `/api/integrations/env`; Studio's Open central credentials entry point was visible. Installing/enabling a skill or plugin and invoking it remain unverified in UI. |
| `docs/product/en/features/studio.mdx` | reviewed | No copy change: generation controls and output handling are implemented under `app/apps/studio`; provider credential UI is in `app/components/settings/StudioMediaCredentialsPanel.tsx`. Studio UI showed GEMINI_API_KEY is missing and Open central credentials. No generation, provider cost, or output save was attempted; those behaviors remain unverified. |
| `docs/product/en/index.mdx` | changed | Reviewed and expanded orientation. UI evidence: app switcher lists Quick access (Notebook, Automations, To-dos, Email, Studio) and More apps; settings navigation verified in Chrome. Notebook 2026.10.1.2, source 428abc24b9669ba9b17bf96136baba469e5276ac. Generated successfully; docs E2E verified all page routes, links, and anchors in the imported Control Plane production build. |
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
| `docs/product/en/notebook/backlinks.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/code-files.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/document-graph.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/embeds.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/excalidraw.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/exports.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/file-explorer.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/file-operations.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/file-previews.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/markdown-editor.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/markdown-formatting.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/marp.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/overview.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/properties.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/public-share-management.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/public-sharing.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/uploads-downloads.mdx` | pending | Not reviewed yet. |
| `docs/product/en/notebook/wiki-links.mdx` | pending | Not reviewed yet. |
| `docs/product/en/quickstart.mdx` | changed | Substantially rewritten; screenshot placeholders replaced by five current cropped app screenshots. Chrome 1440x900, light, Notebook 2026.10.1.2 from source commit 428abc24b9669ba9b17bf96136baba469e5276ac. UI evidence: Bradley is Main/Fixed and Agent Settings reports No valid runtime available; Settings > AI Providers & Models has model readiness controls; Files > Create > New file opens a dialog with filename and destination and appends .md by default; Studio shows missing GEMINI_API_KEY with Open central credentials; Settings > Email separates Connect an account from System email. Automations list loads but New automation opens Something went wrong. Workspace/editor save and agent run, automation create/run, Studio generation, and email send remain unverified; no messages sent or external generation invoked. |
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
- Control Plane host production build passed and generated the same 120 local pages. Its Docker image build stalled while the OrbStack Docker Engine stopped responding to `docker info`; it was interrupted before container replacement. To avoid changing the shared stack while other agents run tests, the current CP production build was served on free host port 4005.
- Docs Playwright E2E passed 12/12 checks against that production build: 120 pages, 516 TOC targets, desktop/mobile, light/dark, search, navigation, Markdown copy, raw source, and no browser runtime errors. Screenshots/report are in `/tmp/canvas-docs-e2e-2026-10-02`. The shared CP container on port 4004 remains the prior build and returns 404 for `/docs/interface-guide`; no container replacement was needed for this verified docs package.
