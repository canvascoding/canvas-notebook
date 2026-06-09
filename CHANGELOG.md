# Changelog

All notable changes to Canvas Notebook are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses calendar-style release versions, currently `YYYY.M.D.N`.

## [Unreleased]

### Added

- Nothing yet.

### Changed

- Nothing yet.

### Fixed

- Nothing yet.

## [2026.6.9.1] - 2026-06-09

### Added

- Added public Markdown export sharing, including public Markdown and PDF export routes.
- Added the chat dock to the email route.
- Added read image previews in agent chat.
- Added public preview app icons.

### Changed

- Render public shares on short URLs through the shared public preview renderer.
- Use managed email OAuth credentials when available.
- Removed agent session counts from chat history.
- Bumped Canvas Notebook and CLI version to `2026.6.9.1`.

### Fixed

- Fixed public share dialog refresh behavior.
- Avoided full page refreshes when saving email policies.

### Verification

- `npm run build`

## [2026.6.8.1] - 2026-06-08

### Added

- Added full email client: SMTP and IMAP account support, read-only mailbox, compose/reply/draft actions, AI reply and summary, message search, remote image preferences, and permanent delete.
- Added interactive public HTML sharing and public file previews with SSR-safe Excalidraw rendering.
- Added agent profile onboarding and transient admin bootstrap flow.
- Added create-agent shortcut to chat selector.
- Added usage analytics user filter.
- Added read image previews in the chat read tool.
- Marked Kimi K2.6 as vision capable.
- Added todo email reply watcher for bidirectional task tracking.

### Changed

- Improved email client responsiveness, preview layout, folder sidebar, and account editing UX.
- Improved vision model capability handling and automation agent prompt editing.
- Improved chat composer keyboard controls and image preview lightbox.
- Improved Studio prompt handoff and gallery original prompt display.
- Moved global agent settings to centralized storage with scoped runtime data paths.
- Localized todo notification emails.
- Updated README with installation docs, product positioning, and star history.

### Fixed

- Fixed public Excalidraw preview SSR, HTML preview asset loading, and file preview non-JSON responses.
- Fixed email account preview preference reload, message action requests, and OAuth redirect handling.
- Fixed stopped queue steer and chat markdown image refresh flicker.
- Fixed agent file reset seed handling and local Google email OAuth redirect.
- Fixed automation run error persistence.

### Verification

- `npm run build`


### Added

- Added attachment preview lightbox support for agent chat and home prompts.
- Added runtime continuation guard coverage for PI live runs.

### Changed

- Improved Marp preview and PDF export, including mobile slide scaling.
- Improved Studio preview loading states and media thumbnails.
- Reduced file tree refresh churn after file writes.
- Clarified created-file tool display names.
- Defaulted todos to the open filter.
- Updated Pi runtime packages and lodash audit override handling.
- Bumped Canvas Notebook and CLI version to `2026.6.7.1`.

### Fixed

- Prevented chat sends while uploads are still finishing.
- Fixed mobile todo detail display.
- Fixed public Excalidraw redirect origin handling.
- Fixed todo email send policy handling.
- Hardened vision attachment handling.

### Verification

- `npm run build`

## [2026.6.6.2] - 2026-06-06

### Added

- Added admin user management settings with localized UI, table support, bootstrap updates, and smoke coverage.
- Added PDF preview share download action.
- Added project changelog and release publisher workflow.
- Added todo email notifications for newly created agent todos.

### Changed

- Improved user management provisioning hardening.
- Optimized chat image previews with shared media preview utilities and file preview routing.
- Formatted automation run prompts as Markdown.
- Linked automation-created todos to their run sessions.
- Reduced license status log noise.
- Bumped Canvas Notebook and CLI version to `2026.6.6.2`.

### Fixed

- Hardened MCP OAuth redirects to use the public origin.
- Moved the MCP server editor into a modal and improved its mobile layout.
- Limited agent websocket memory growth through PI message normalization and projection updates.
- Added browser automation resource usage warnings.

### Verification

- `npm run build`

## [2026.6.6.1] - 2026-06-06

### Added

- Added first-run owner setup and the initial owner setup API.
- Added account password change settings.
- Added CLI admin password recovery.
- Added Telegram media attachment delivery and inbound typing feedback.
- Added voice transcription integration for channels and PI tools.
- Added Marp slide preview and image export.
- Added in-app PDF viewer support.
- Added public Excalidraw previews, local edits in public previews, and related Excalidraw/public sharing polish.
- Added MCP registry link in integrations settings.
- Added studio provider key warnings.
- Added `pptxgenjs` for PPTX skills.

### Changed

- Deferred startup maintenance until the app is ready.
- Increased startup health timeout.
- Made Electron workflow manual-only.
- Grouped explorer create actions and refined file actions.
- Rewrote Telegram tables as bullet lists for more reliable chat delivery.
- Isolated browser tool sessions and persisted browser profiles across sessions.
- Hardened browser evaluate handling.
- Improved notebook panel resizing and chat history responsive layout.
- Stopped creating legacy AI session tables.
- Projected large PI messages on load.
- Stabilized PI message ordering and aligned session activity timestamps.
- Tracked PI summary progress by sequence.
- Normalized primary channel links.
- Clarified automated heartbeat context.
- Updated bootstrap admin migration behavior.
- Removed obsolete transcribe seed skill.
- Bumped Canvas Notebook and CLI version to `2026.6.6.1`.

### Fixed

- Fixed Caddy sync behavior when Caddy is unavailable.
- Fixed PDF reads in the agent tool, including image rendering from PDF pages.
- Fixed bash tool handling for safe null redirects.
- Preferred the read tool for PDF text extraction.
- Stopped repeated tool failure loops.
- Fixed MCP OAuth authorization flow.
- Preserved onboarding license activation keys.
- Added tests for initial owner setup.

### Verification

- `npm run build`

## [2026.6.1.3] - 2026-06-01

### Fixed

- Fixed mobile agent settings controls.
- Fixed automation prompt persistence.

### Changed

- Bumped Canvas Notebook and CLI version to `2026.6.1.3`.

## [2026.6.1.2] - 2026-06-01

### Added

- Added Excalidraw file editor, Excalidraw diagram seed skill, Mermaid import, public file sharing, public share revoke flow, short URLs for public file shares, public share tool icon, and browser evaluate action.
- Added heartbeat working-hours defaults.
- Added security tile to home settings.

### Changed

- Replaced the Brave seed skill with native web search.
- Deferred channel runtime import during WebSocket startup.
- Improved public sharing responsive layout and mobile public shares security page.
- Improved Todo mobile filters.
- Improved chat context status labels.
- Synced Excalidraw on external file changes and reduced reload flashes.

### Fixed

- Fixed Composio connection filtering by active status.
- Fixed notebook preview from chat file links.
- Fixed Studio prompt handoff to create view.
- Fixed German umlauts in settings UI.
- Fixed mobile notification chat deep links.
- Fixed duplicate image preview navigation.

## [2026.6.1.1] - 2026-06-01

### Added

- Added Human Todo workspace: persistence, API routes, workspace app, agent tool, notification bell, localized default categories, and completion follow-up flow.
- Added custom webhook automations.
- Added personalized agent creation dialog, agent avatars, agent icon metadata, connection logos, capability overrides, model overrides, and safe agent file edit/path operation tools.
- Added VM migration import and restore flow with centralized migration component path mapping.
- Added managed browser gateway, browser runtime resolver, and split browser gateway services.
- Added settings tile to home and usage summary layout improvements.
- Added Telegram channel prompt guidance.

### Changed

- Moved heartbeat controls into agent settings.
- Refactored chat history rows and dock shell.
- Lazy-loaded settings tabs and optimized settings, chat, license, and toast layouts on mobile.
- Froze PI session system prompts and separated base prompts from overlays.
- Listed specialized agent tools in prompts.
- Used Turbopack for the dev server.
- Migrated PI packages to the `@earendil-works/*` scope.
- Updated non-major npm dependencies.
- Silenced Node 26 module registration warnings.
- Prepared release `2026.6.1.1`.

### Fixed

- Fixed first send in new chat.
- Fixed interval heartbeat rescheduling.
- Fixed chat context window meter.
- Fixed final chat persistence errors and Todo follow-up races.
- Fixed container chat WebSocket startup.
- Fixed chat session persistence, hidden notebook chat behavior on file selection, and busy follow-up queue rendering.
- Fixed agent startup package resolution and dynamic PI package exports.
- Fixed canvas agent chat lint warnings.

## [2026.5.30.2] - 2026-05-30

### Added

- Added composer queue controls and busy chat queue controls.
- Enabled Electron builds on branch pushes.

### Changed

- Updated single reference picker selection icon.

### Fixed

- Fixed email subject MIME encoding.
- Fixed automation Studio tool user context.
- Fixed notebook restore races.
- Fixed chat stop button color.
- Fixed email OAuth disconnect state.

## [2026.5.30.1] - 2026-05-30

### Added

- Added HTML email draft option.
- Added file actions to editor preview.
- Added reference picker loading skeletons, preview skeletons, carousel previews, model creation links, and chat/file reference thumbnails.
- Added aspect ratio lock toggle.
- Added bare image and video file reference detection.

### Changed

- Cached chat session messages.
- Improved Studio reference picker layout, thumbnails, mobile aspect ratio editor layout, and notebook initial chat layout.
- Lazy-loaded Studio model references.
- Hardened OpenAI-compatible bridge models.
- Clarified generated image output paths.
- Disabled Studio presets for sound generation.

### Fixed

- Fixed live file tree watcher refresh.
- Fixed Studio workspace image references.
- Fixed managed email disconnect headers.
- Fixed mobile notebook chat toggle and mobile chat layout jitter.
- Fixed chat attachment reference display and generated image chat URLs.
- Guarded disabled Telegram delivery.
- Paused automations with unavailable channels.
- Fixed managed provider chat compatibility.
- Fixed Studio URL reference selection and reference picker grid.
- Fixed settings tab overflow.

## [2026.5.29.1] - 2026-05-29

### Added

- Added aspect ratio editing improvements: edge snap, persisted edits, preview download, centered canvas image, and fuller reference previews.
- Added MCP default enablement and bearer token storage in integrations env.
- Added agent/runtime/tools/settings accordions.
- Added control plane image publish notification.

### Changed

- Updated Gemini image model IDs.
- Refined managed provider settings, login help, prompt hints, and Studio create transition.
- Used thumbnail previews for Studio references.
- Required explicit agent model selection.

### Fixed

- Fixed email account refresh after OAuth.
- Marked email tool content as untrusted and clarified allowlist input.
- Allowed unauthenticated HTTP MCP servers.
- Fixed folder selector overflow.
- Fixed managed license onboarding flow and license gate priming.
- Fixed managed agent model selection and initial prompt model resolution.
- Fixed Composio tools dialog backdrop close.
- Fixed macOS Electron signing workflow.
- Fixed Studio image reference uploads.
- Fixed settings tab hydration and onboarding lint errors.

## [2026.5.28.6] - 2026-05-28

### Fixed

- Addressed CodeQL security findings.
- Used full build version for desktop artifacts.

## [2026.5.28.5] - 2026-05-28

### Added

- Added Electron desktop client shell, weekly desktop builds, and native Electron chat notifications.
- Added security policy.

### Changed

- Persisted settings tab selection.
- Reworked Studio add-reference dialog.
- Clarified managed license activation copy.
- Prepared `2026.5.28.5` release.

### Fixed

- Fixed legacy agent ID migrations.
- Fetched managed license certificates automatically.
- Fixed Studio output downloads.
- Fixed mobile reference preview dialog.
- Primed license gate cookie on page requests.
- Fixed CI patch install failures and Windows CLI version injection.
- Handled stale server action posts.
- Fixed SheetJS ReDoS and PostCSS advisories.
- Fixed email OAuth settings lint.

## [2026.5.28.4] - 2026-05-28

### Added

- Added local email OAuth service.
- Added Electron desktop client plan.

### Changed

- Updated Composio SDK.
- Hid local email OAuth fields in managed mode.

## [2026.5.28.3] - 2026-05-28

### Added

- Added DOCX editor peer dependencies.

### Changed

- Bumped Canvas Notebook version to `2026.5.28.3`.

## [2026.5.28.2] - 2026-05-28

### Added

- Added agent memory storage plan, persistent agent memory tool, session search agent tool, and delegate task agent tool.

### Changed

- Persisted notebook explorer visibility.
- Clarified automation delivery controls.
- Used web fallback for automation delivery.
- Hardened PI context compaction.
- Made delegate task spawn ephemeral workers.

### Fixed

- Fixed automation external channel delivery.
- Fixed heartbeat toggle when Telegram is disabled.

## [2026.5.28.1] - 2026-05-28

### Added

- Added agent-scoped runtime storage, registry, prompt inheritance, settings APIs, and chat/session scoping.
- Added automation delivery target model, agent delivery controls, delivery session resolution, and delivery result dispatch.
- Added channel architecture tests and channel database tests.
- Added chat input history navigation.
- Added license public key fallback and richer license activation copy.
- Added agent selector to settings and chat, plus agent-specific runtime overrides.
- Added email OAuth credential setup fields and MCP server examples link.

### Changed

- Split channel overview/settings cards and agent settings cards.
- Made chat sessions agent-aware and scoped session operations by agent.
- Scoped PI session store and active channel sessions by agent.
- Centralized PI session deletion cleanup.
- Refined agent settings inheritance UI.
- Updated root npm dependencies, seed skill dependencies, and DOCX editor.
- Used agent defaults for new chat sessions.

### Fixed

- Fixed migration order for indexes on altered table columns.
- Fixed duplicate heartbeat automation runs.
- Fixed startup health checks.
- Fixed chat bottom scroll behavior and scroll button threshold.
- Fixed agent runtime config preservation.
- Fixed lint warnings.

## [2026.5.27.1] - 2026-05-27

### Added

- Added multi-channel agent architecture plan and multi-channel session foundation.
- Routed web and Telegram through channel adapters.
- Added managed email gateway and tools.

### Changed

- Improved channel settings overview.
- Clarified and enforced notebook license activation.
- Kept compact tool pills after runs.
- Sped up chat session loading.

### Fixed

- Fixed notebook lint issues.
- Fixed streaming scroll unlock.
- Fixed license enforcement regressions.

## [2026.5.21.3] - 2026-05-21

### Added

- Added automation run database-only storage.
- Added automation overview/detail split.
- Added Composio trigger context in automation prompts.

### Changed

- Restored notebook file state intentionally.
- Improved chat table scrolling and smooth chat session startup.
- Preserved automation edits during refresh.
- Reduced assistant labels around tool calls and showed assistant activity while sending.
- Set notebook file browser minimum width.

### Fixed

- Fixed integration trigger tab loading.
- Fixed agent HTML file references.
- Corrected version typo from `2926.5.21.2` back to `2026.5.21.3`.

## [2926.5.21.2] - 2026-05-21

### Added

- Added Veo video extension flow.
- Added managed pricing for PI usage costs.
- Added notebook preview close action.

### Changed

- Reused existing Composio webhook subscription.
- Refined chat model controls and compact chat model menu.
- Grouped completed chat run steps.
- Moved chat settings control.

### Fixed

- Corrected Veo extension capabilities.
- Fixed chat file link validation, file browser refresh, noisy missing file validation, and dashboard chat effect lint.
- Restored tool inputs in chat history.

### Known Issue

- This tag used the accidental `2926` year prefix; the following release corrected the series.

## [2026.5.21.1] - 2026-05-20

### Added

- Added Seedance multimodal references.
- Lazy-loaded Composio trigger events.

### Changed

- Updated packages and cache behavior.

## [2026.5.20.2] - 2026-05-20

### Added

- Added Composio trigger automation composer.
- Added Gemini sound generation to Studio with managed fallback.
- Added custom Studio aspect ratio handoff and Studio create initial image loader.
- Added URL-change detection for local Composio webhook subscriptions.

### Changed

- Improved automation scheduling and skill selection.
- Updated CLI version stamp.
- Made Studio edit markup translucent.
- Opened Studio dashboard previews in create view.
- Replaced square loading spinners.
- Added markdown formatting to Studio prompt display.

### Fixed

- Fixed lint issues and markdown image lint warning.

## [2026.5.20.1] - 2026-05-20

### Added

- Added Studio-facing improvements across prompts, media generation, models, and automation integration.

### Changed

- Continued Studio UI and generation workflow refinements.
- Prepared `2026.5.20.1` release.

## [2026.5.15.1] - 2026-05-15

### Added

- Added additional Studio, media, and automation capabilities from the May release cycle.

### Changed

- Continued dependency, runtime, and UI refinements.

## [2026.5.13.2] - 2026-05-13

### Changed

- Bumped Canvas Notebook version to `2026.5.13.2`.

## [2026.5.13.1] - 2026-05-13

### Added

- Added May Studio and notebook feature work leading into the `2026.5.13` release.

### Changed

- Continued stabilization of Studio generation, file handling, and chat workflows.

## [2026.5.3.2] - 2026-05-03

### Added

- Added tool search/group filter.

### Changed

- Cleaned up old sessions.

## [2026.5.3.1] - 2026-05-03

### Changed

- Bumped Canvas Notebook version to `2026.5.3.1`.

## [2026.5.2.2] - 2026-05-02

### Fixed

- Fixed CSP behavior.
- Fixed TooltipProvider behavior.

## [2026.5.2.1] - 2026-05-02

### Changed

- Bumped Canvas Notebook version to `2026.5.2.1`.

## [2026.4.28.1] - 2026-04-27

### Added

- Added reference path architecture documentation.
- Added comprehensive generation logging.

### Fixed

- Fixed workspace file references in Studio generation.

## [2026.4.28] - 2026-04-26

### Changed

- Bumped Canvas Notebook version to `2026.4.28`.

## [2026.4.27] - 2026-04-25

### Fixed

- Hardened PPTX preview background rendering.

## [2026.4.26] - 2026-04-25

### Added

- Added seven new Studio presets.

### Changed

- Replaced preview images with AI-generated photos.

## [2026.4.25] - 2026-04-25

### Added

- Added Studio database schema, product/persona/style services, APIs, dashboard, create flow, preset APIs, generation flows, bulk generation, edit tools, output actions, and E2E coverage.
- Added full file browser grid/list/tree experience, image preview, contextual onboarding hints, Mermaid rendering, color swatches, HEIC/HEIF preprocessing, and workspace layout refinements.

### Changed

- Unified the file browser around the grid/list implementation.
- Reworked workspace, sidebar, mobile file browser, chat visibility, and dashboard layouts.
- Hardened Studio boundaries and moved Studio outputs under `/data/studio/outputs`.

### Fixed

- Fixed file explorer lazy loading, refresh, collision handling, empty-folder expansion, scrollability, and mobile session restore races.
- Fixed Mermaid rendering in Markdown, PDF export, and popup zoom.
- Fixed Studio thumbnail, routing, asset, lint, and missing-file crashes.
- Fixed memory leaks and chat message persistence issues.

## [2026.4.24.2] - 2026-04-25

### Fixed

- Follow-up fix for the `2026.4.24` release line.

## [2026.4.24.1] - 2026-04-25

### Fixed

- Fixed settings error after the `2026.4.24` release.

## [2026.4.24] - 2026-04-25

### Added

- Added OpenAI image generation provider.
- Added Mermaid diagram rendering in chat, Markdown preview, and PDF export.
- Added file explorer optimizations, batch delete, breadcrumb navigation, context menus, grid/list view, preview dialogs, and keyboard toggles.
- Added image conversion/preprocessing, HEIC/HEIF support, and upload conversion flow.
- Added contextual onboarding hints.
- Added chat history pagination and read-state actions.

### Changed

- Removed `preferredSkill` from automations and cleaned legacy skill references.
- Removed redundant image/video generation skills that were superseded by PI tools.
- Redesigned prompt-first homepage and mobile file browser header.
- Improved runtime polling, mobile chat restore, context bar updates, and file reference cards.

### Fixed

- Fixed automation tool errors and foreign-key failures.
- Fixed mobile chat session restoration, duplicate messages, file reference clicks, and setState-during-render errors.
- Fixed crash on non-JSON subdirectory API errors.
- Fixed memory leaks in persistence queues and heartbeat intervals.

## [2026.4.23] - 2026-04-18

### Fixed

- Fixed `broadcastToUser` losing user connections on session switch.
- Added debug logging for connection loss investigation.

## [2026.4.22] - 2026-04-18

### Changed

- Bumped Canvas Notebook version to `2026.4.22`.

## [2026.4.21] - 2026-04-17

### Fixed

- Fixed WebSocket auth errors.
- Fixed hydration mismatch on login page.
- Fixed mobile editor overflow caused by long filenames.

## [2026.4.20] - 2026-04-17

### Changed

- Updated seed prompts.
- Improved mobile editor padding and mobile development test coverage.

## [2026.4.19] - 2026-04-17

### Added

- Added Planning Mode to Canvas Agent Chat.
- Added language step to onboarding and language picker in general settings.

### Changed

- Updated license and README content.
- Fixed theme behavior.

### Fixed

- Fixed corrupt ZIP downloads.
- Fixed folder upload and drag-and-drop directory preservation.
- Fixed React script tag warning.

## [2026.4.18] - 2026-04-16

### Added

- Added Tool Configuration UI in Agent Settings.
- Added workspace settings tab with ZIP download and stats.

### Changed

- Removed workflow automation skill and API routes in favor of direct PI tools.
- Replaced browser `prompt`/`confirm` dialogs with custom dialogs.
- Optimized chat streaming performance.
- Stabilized WebSocket toast previews.

### Fixed

- Fixed chat title corruption, database performance, instant titles, and WebSocket notification bugs.
- Fixed file browser sidebar action wrapping.

## [2026.4.17] - 2026-04-16

### Changed

- Removed Sentry from the app.

## [2026.4.17-no-v-prefix] - 2026-04-16

### Changed

- Follow-up package and Sentry updates on the historical non-`v` tag `2026.4.17`.

## [2026.4.16] - 2026-04-16

### Fixed

- Fixed chat issues.
- Bumped Canvas Notebook version to `2026.4.16`.

## [2026.4.14] - 2026-04-15

### Fixed

- Used `127.0.0.1` with retry for WebSocket bridge HTTP calls.

## [2026.4.13] - 2026-04-15

### Changed

- Updated GitHub Actions to Node.js 24-compatible versions.

### Fixed

- Removed HTTP localhost requests from the WebSocket runtime bridge.

## [2026.4.12] - 2026-04-12

### Added

- Added unified file upload handling with category-based storage.
- Added automation execution context.
- Added `web_fetch` agent tool and browser-priority guidance.
- Added lazy-loaded version update indicator using GitHub API.
- Added centralized logging with `LOG_LEVEL` and `LOG_TO_STDOUT`.
- Added unread AI response indicators, unread counters, multi-tab toast notifications, and WebSocket chat migration.
- Added file-tree multi-select and bulk actions.
- Added chat route sidebar and responsive chat improvements.
- Added file move conflict handling with i18n.

### Changed

- Removed vision model filtering so all models can receive images.
- Moved automation run metadata into the database.
- Switched to WebSocket-only architecture with SSE as explicit fallback.
- Simplified chat toast behavior.
- Improved upload dropdowns, header width, mobile chat sheet copy, and session title handling.

### Fixed

- Fixed API file references in message normalization.
- Fixed server-only imports, circular dependencies, bridge integration, active file/timezone context, duplicate chat messages, duplicate events, and WebSocket auth issues.
- Fixed file upload in `HomeChatPrompt`.
- Fixed SSR and i18n errors.
- Fixed missing chat translation keys.
- Fixed global chat notifications and lint issues.

## [2026.1.17] - 2026-04-05

### Added

- Reimplemented chat flows.
- Added slash skill references, notebook chat split button, HTML file preview, persistent context-compaction markers, and multi-file chat attachments.
- Added automation run chat session improvements.
- Added Docker build progress bar in setup.

### Changed

- Upgraded `pi-agent-core` and `pi-ai` to `0.65.0`.
- Hid JSON metadata files in selected Studio output folders.
- Applied security fixes and dependency upgrades.
- Optimized Docker entrypoint behavior.

### Fixed

- Fixed route-aware session navigation, Markdown share/export issues, PDF popup bugs, emoji fonts, and dev-mode ESM package startup crashes.
- Fixed automation scheduler ESM crash.

## [2026.1.16] - 2026-03-28

### Added

- Replaced skill dispatcher with manifest runtime.
- Made skill wrappers runtime-portable.

### Fixed

- Fixed new chat title fallback.
- Fixed PDF/PPTX preview and lint warnings.
- Fixed skills runtime copy in runner image.
- Fixed browser-start container runtime.
- Fixed browser tools dynamic skill inputs.

### Changed

- Quieted skills startup wrapper logs.
- Bumped Canvas Notebook version to `2026.1.16`.

## [2026.1.15] - 2026-03-25

### Added

- Integrated PI skills: Brave Search, transcribe, YouTube transcript, browser tools, Google Calendar CLI, Gmail CLI, and Google Drive CLI.
- Made QMD optional and added `rg` search tool.

### Changed

- Disabled QMD by default.
- Removed `CHANGELOG.md` at the time because GitHub Releases were treated as source of truth.

### Security

- Applied security optimization work.

## [2026.1.14] - 2026-03-25

### Changed

- Switched versioning from semver (`1.0.x`) to calendar-style versioning (`2026.1.x`).
- Updated README with OpenClaw-style header and badges.
- Changed license to MIT at that time.

### Fixed

- Resolved `react-hooks/exhaustive-deps` lint warnings.
- Applied security audit fixes and upgraded Next.js to `16.2.1`.
- Improved QMD entrypoint failure logging.

## [1.0.13] - 2026-03-24

### Added

- Added full internationalization across the app.
- Added language switcher in header and onboarding wizard.
- Added German translations.

### Fixed

- Fixed locale-aware auth redirects and routing.
- Fixed German umlaut rendering in translations.

## [1.0.12] - 2026-03-23

### Added

- Passed active editor file into the AI agent system prompt.

### Changed

- Improved image upload error handling and paste behavior.
- Improved mobile chat sheet controls.

### Fixed

- Fixed AI Chat title vertical alignment on mobile.

## [1.0.11] - 2026-03-23

### Added

- Added Markdown PDF share, inline image handling, direct download, and mobile UI.

### Changed

- Markdown editor now defaults to preview mode.
- Mobile home prompt opens chat automatically.

### Fixed

- Fixed PDF print dialog behavior.
- Fixed `html2pdf.js` `oklch` color parsing errors.

## [1.0.10] - 2026-03-22

### Fixed

- General bug fixes and stability improvements.

## [1.0.9] - 2026-03-20

### Added

- Added `MarkdownEditor` to Agent Managed Files settings.

### Changed

- Improved file browser behavior.
- Prioritized filename matches in chat file references.

## [1.0.8] - 2026-03-20

### Added

- Added timezone context to PI agent system prompt.
- Integrated `seed_sys_prompts` for agent file initialization.

### Changed

- Allowed PI agent read tool to access `/data/canvas-agent`.
- Tuned system prompt behavior.

## [1.0.7] - 2026-03-19

### Added

- Exposed direct PI media tool inputs.

### Changed

- Optimized system prompt behavior.

## [1.0.6] - 2026-03-19

### Added

- Added desktop notebook panel toggles for chat, terminal, and explorer.
- Added inline image Markdown guidance in chat.

### Changed

- Improved mobile homepage, notebook, and onboarding layouts.
- Added auto-growing chat composer with bounded max height.
- Set default theme to light.

## [1.0.5] - 2026-03-18

### Changed

- Switched `compose.yaml` to local build for ARM64 compatibility.

### Fixed

- Fixed PI OAuth completion flow.

## [1.0.4] - 2026-03-18

### Changed

- Removed `/ollama` Docker volume because models run externally.
- Kept settings under `/home/node`.

## [1.0.3] - 2026-03-18

### Added

- Added `/home/node` and `/ollama` to Dockerfile `VOLUME` declarations.

## [1.0.2] - 2026-03-18

### Fixed

- Fixed `fatal_startup` being called before definition in `docker-entrypoint.sh`.
- Sanitized committed test credentials.
- Limited CI build/deploy to release tags.

## [1.0.1] - 2026-03-18

### Changed

- Merged GHCR and Docker Hub into a single build workflow.
- Documented default login credentials and bootstrap sync behavior.

### Fixed

- Fixed production bootstrap admin startup.

## [1.0.0] - 2026-03-18

### Added

- Added file browser and CodeMirror-based code editor.
- Added terminal emulator via xterm.js and node-pty over WebSocket.
- Added spreadsheet viewer.
- Added AI agent chat powered by the PI framework.
- Added support for Anthropic, OpenRouter, Google Gemini, and Ollama.
- Added SQLite database via Drizzle ORM.
- Added better-auth authentication with bootstrap admin.
- Added Docker Compose deployment.
