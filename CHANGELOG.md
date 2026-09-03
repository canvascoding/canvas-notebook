# Changelog

All notable changes to Canvas Notebook are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses calendar-style release versions, currently `YYYY.M.D.N`.

## [Unreleased]

### Added

- Nothing yet.

## [2026.9.3.1] - 2026-09-03

### Added

- Added a Bradley QR-card setup flow for connecting the mobile app.
- Added mobile access to chat context-compaction state and controls.
- Added a complete origami icon family for specialist agents.
- Added selectable workspace colors throughout the workspace APIs and settings.

### Changed

- Refined agent identity rendering and require assignees for agent-created todos.

### Verification

- `npm run verify:release`

## [2026.9.2.3] - 2026-09-02

### Added

- Added PostgreSQL-backed collaboration repositories, lifecycle transactions, lock handling, lineage revisions, and workspace starter documents.
- Added migration, database-isolation, file-lifecycle, rename, and PostgreSQL compatibility coverage.

### Changed

- Made PostgreSQL the production runtime path while keeping production builds database-free and removing the SQLite sidecar from PostgreSQL startup.
- Improved rollback-safe workspace renames, folder path remapping, public-share workspace scoping, and Team Seat retry handling.
- Improved reproducible npm installation and local development runtime behavior.
- Regenerated third-party compliance artifacts from a clean lockfile installation for CI-consistent release verification.

### Verification

- `npm run verify:release`

## [2026.9.2.1] - 2026-09-02

### Added

- Added Hermes-aligned session compaction v2 with pressure policy, coherent selection, deterministic pruning, rolling summaries, recovery artifacts, and rollout evaluation coverage.
- Added mobile account profile and avatar API contracts.

### Changed

- Improved truthful context and compaction status reporting across chat and runtime events.
- Hardened live Markdown collaboration durability, checkpoint reconciliation, persistence recovery, and rich identity preservation.
- Updated Bradley Notebook web branding and clarified the external MCP server description.

### Fixed

- Fixed collaboration checkpoint persistence and confirmation-failure recovery, including indeterminate commit handling.

### Verification

- `CANVAS_DATABASE_PROVIDER=sqlite DATABASE_URL= npm run verify:release` (passed; 16 existing lint warnings)

## [2026.9.1.1] - 2026-09-01

### Added

- Added a responsive email workspace with extracted mailbox, message-reader, composer, and AI-streaming capabilities.
- Added reliable agent-memory ownership, review flows, and usage reporting coverage.

### Changed

- Improved rich-Markdown email round trips and made chat-header workspace navigation progressively disclosed while preserving compact switching.
- Externalized the PDF parser from Next.js bundles and expanded release/runtime regression coverage.

### Fixed

- Fixed email workspace activation, compose regular expressions, draft-sender handling, and mobile chat pagination cursor units.

### Verification

- `CANVAS_DATABASE_PROVIDER=sqlite DATABASE_URL= npm run verify:release` (passed; 16 existing lint warnings)

## [2026.8.31.2] - 2026-08-31

### Added

- Introduced Bradley as the main agent identity across onboarding, prompts, selectors, chat states, glyph assets, themes, and motion.
- Added workspace-scoped email inbox/outbox workflows, attachment selection, draft review, and file-reference support.
- Added secure MCP binary uploads and expanded MCP request-history and workspace-tool coverage.

### Changed

- Improved exact context-compaction cooldown handling and isolated PDF browser profiles.
- Documented the PostgreSQL-only CLI migration and made local Sentry behavior quieter during development.

### Fixed

- Fixed MCP upload completion retries and release-build type errors in email attachment, HTML sanitization, and workspace-mail tests.

### Verification

- `npm run verify:release` (passed; 2 existing lint warnings)

## [2026.8.31.1] - 2026-08-31

### Added

- Added user profile appearance and avatar management across onboarding, settings, and the home header.
- Added native Electron file-drag export and richer file references in agent chat.
- Added Bradley agent identity, terminology, branding guidance, and reference assets.
- Added default workspace access for newly authorized Direct MCP clients.

### Changed

- Improved collaborative rich Markdown preservation, rendering, and editor behavior.
- Enabled all configured MCP tools on activation and strengthened Agent Skills manifest compliance.
- Added concurrent Studio media generation and expanded mobile file-sorting and collaboration coverage.

### Fixed

- Hardened MCP OAuth consent, client permissions, and workspace access initialization.
- Fixed team-memory bootstrap permissions, transparent image-output handling, and workspace image links.

### Verification

- `npm run verify:release`

## [2026.8.30.2] - 2026-08-30

### Changed

- Sorted mixed mobile Inbox items consistently by recency while preserving the dedicated todo ordering for todo-only views.

### Verification

- `npm run verify:release`

## [2026.8.30.1] - 2026-08-30

### Added

- Added persistent workspace-file metadata with API, sorting, rename, mobile-client, and information-dialog support.
- Added public Team invitation activation and stronger local Team-runtime verification coverage.
- Added OrbStack PostgreSQL integration coverage for workspace API routes.

### Changed

- Made PostgreSQL the default database for fresh installations while retaining the documented transition path.
- Hardened Team membership synchronization, runtime database guards, and managed CLI lifecycle handling.

### Fixed

- Fixed cross-database Team Seat retries, license fallback reactivation, mobile chat pagination, pinned file sorting, and custom-server module interoperability.
- Made PostgreSQL reconciliation deadlines monotonic and kept the iOS Inbox widget refreshed.

### Verification

- `npm run verify:release`

## [2026.8.29.5] - 2026-08-29

### Fixed

- Made managed-environment installer permission checks dereference CLI symlinks consistently on Linux and macOS.

### Verification

- `npm run verify:release`

## [2026.8.29.4] - 2026-08-29

### Changed

- Switched the Linux installer and systemd integration to the TypeScript CLI.
- Retired the legacy Linux CLI after the TypeScript CLI migration.
- Documented the successful managed CLI canary and updated installer/rollback guidance.

### Verification

- `npm run verify:release`

## [2026.8.29.3] - 2026-08-29

### Fixed

- Preserve actionable Postgres URL validation errors during environment synchronization.

### Verification

- `npm run verify:release`

## [2026.8.29.2] - 2026-08-29

### Fixed

- Fixed release-time dependency installation for Node.js 22 Linux CLI builders.
- Fixed Postgres URL validation reporting for unsafe encoded passwords.
- Fixed strict TypeScript fixtures and React Compiler memoization validation in the release build.

### Verification

- `npm run verify:release`

## [2026.8.29.1] - 2026-08-29

### Added

- Added persistent memory management with review workflows, settings, migration, and governance coverage.
- Added Direct MCP connection/workspace controls, request history, diagnostics, and authorization hardening.
- Added context-compaction coordination and persistence across chat and automation runtimes.
- Added transactional cross-platform CLI management for Postgres, Linux swap, Caddy, auto-updates, diagnostics, and self-update packaging.

### Changed

- Improved collaboration editing, safe global replacements, rich Markdown handling, delegated-task controls, and Electron workspace-drive planning.
- Added CLI version/capability reporting, environment editing, and managed Postgres preparation improvements.

### Fixed

- Fixed stale notebook tabs after external moves and several collaboration, mailbox, MCP, and compaction edge cases.

### Verification

- `npm run verify:release`

## [2026.8.27.1] - 2026-08-27

### Added

- Added rich-mode collaboration for eligible documents and stabilized collaborative editor synchronization and migration.
- Added an improved email inbox reading flow and automatic email license activation.

### Changed

- Improved system email settings, workspace mailbox configuration and translations, and admin-configurable Email Agent tools.
- Refined Home/Studio prompt styling and development startup behavior.
- Improved streamed MCP registration handling and disabled Sentry session replay.

### Fixed

- Fixed collaboration migration race conditions, duplicate mailbox saves, and markdown source-mode notice behavior.

### Verification

- `npm run verify:release`

## [2026.8.25.2] - 2026-08-25

### Added

- Added robust live-collaboration routing and editor synchronization coverage.

### Changed

- Improved mobile Home page layout and tool navigation.
- Updated third-party compliance metadata for the current dependency set.

### Fixed

- Fixed MCP OAuth dynamic client registration compatibility and request handling.
- Fixed live-collaboration session state resets during representation changes and retries.
- Refreshed third-party compliance artifacts from a clean lockfile installation.

### Verification

- `npm run verify:release`

## [2026.8.24.2] - 2026-08-24

### Fixed

- Fixed the Electron desktop release job by checking out the repository before uploading desktop assets to GitHub Releases.

### Verification

- `npm run verify:release`

## [2026.8.24.1] - 2026-08-24

### Added

- Added stable tool-call ID serialization to the mobile chat contract with dedicated contract coverage.

### Changed

- Improved runtime model catalog compatibility and resolution across supported catalog shapes.
- Kept completed to-dos out of the mobile attention queue and strengthened the related inbox contract tests.

### Verification

- `npm run verify:release`

## [2026.8.23.2] - 2026-08-23

### Fixed

- Fixed Postgres-managed startup by avoiding an unnecessary SQLite bootstrap migration that could prevent the updated container from becoming healthy.

### Verification

- `npm run test:startup-runtime`
- `npm run verify:release`

## [2026.8.23.1] - 2026-08-23

### Added

- Added reliable live-collaboration state for agent file edits, including document initialization and freshness checkpoints.
- Added an attention queue for notifications and email review, plus per-user to-do ownership, reminders, and file links.
- Added support for native managed model providers in agent model selection and runtime configuration.

### Changed

- Improved mobile and terminal to-do read-state handling, ownership filtering, and inbox attention behavior.
- Hardened release artifact provenance checks before Control Plane notification.

### Fixed

- Fixed Direct MCP OAuth dynamic client registration and ChatGPT Team credential consent.
- Corrected notification-review retry behavior and stopped the auto-update service when it is disabled.

### Verification

- `npm run verify:release`

## [2026.8.22.1] - 2026-08-22

### Added

- Added user-facing delegated-task controls with runtime policy enforcement and scoped worker sessions.
- Added per-user to-do read state, mobile inbox categories and badges, and a versioned mobile inbox contract.
- Added Direct MCP OAuth discovery, PKCE, revocation, readiness diagnostics, and protected-resource metadata.

### Changed

- Aligned effective agent prompts with the tools and permissions available in each runtime.
- Improved mobile MARP rendering, lossless Markdown round-trips, and live-collaboration edit feedback.
- Strengthened workspace automation scope handling and personal-provider consent in team workspaces.

### Fixed

- Corrected to-do scope filtering, priority ordering, cursor pagination, and notification inbox visibility.
- Fixed vision-image delivery and safe provider fallback behavior.
- Hardened stale-revision handling for workspace files and uploads.

### Security

- Restricted delegated worker capabilities and interactive credential access.
- Hardened Direct MCP OAuth authorization, client consent, token revocation, and request validation.

### Verification

- `npm run verify:release`

## [2026.8.18.5] - 2026-08-18

### Changed

- Release workflow now creates the GitHub Release and uploads host CLI, portable CLI, and native compliance assets automatically as part of the tag-triggered build. This ensures the Control Plane release notification runs only after all release assets are available.

### Verification

- `npm run build`
- Tag-triggered `Build and Push (Both Arch)` workflow succeeded
- `Notify Control Plane Release` workflow succeeded after CI-created release

## [2026.8.18.4] - 2026-08-18

### Changed

- Release workflow now creates the GitHub Release and uploads host CLI, portable CLI, and native compliance assets automatically as part of the tag-triggered build. This ensures the Control Plane release notification runs only after all release assets are available.

### Verification

- `npm run build`
- Tag-triggered `Build and Push (Both Arch)` workflow succeeded
- `Notify Control Plane Release` workflow succeeded after CI-created release

## [2026.8.18.3] - 2026-08-18

### Fixed

- Fixed Better Auth 1.7 email/password login by adding the required `issuer` column to the `account` table for both SQLite and Postgres. Legacy credential accounts default to `local:credential` so existing users can sign in after the upgrade.

### Verification

- `npm run build`
- `npm run lint`
- `npm run setup` (Postgres)
- `scripts/auth-setup-test.ts`
- `scripts/auth-seat-limit-test.ts`
- `scripts/organization-offboarding-test.ts`
- `scripts/migration-export-policy-test.ts`
- `scripts/mcp-server-oauth-schema-test.ts`
- `scripts/todo-api-test.mjs`

## [2026.8.18.2] - 2026-08-18

### Added

- Added a workspace outbox review queue for email activity.

### Changed

- Run image builds alongside safety tests in the release workflow.

### Fixed

- Corrected historic unread-chat handling in the inbox.
- Fixed the Better Auth JWKS schema migration.

### Verification

- `npm run verify:release`

## [2026.8.18.1] - 2026-08-18

### Added

- Added workspace-scoped mailbox assignment and a unified workspace email tool surface for automations and agents.
- Added managed system email sending, expanded product documentation sources, and macOS desktop auto-updates.

### Changed

- Improved MCP server settings and activation without restart, workspace appearance restoration, mobile session recovery, notifications, and workspace navigation.
- Refined email automation policies, draft review transitions, mailbox loading states, browser-tool placement, and HTML workspace previews.

### Fixed

- Hardened email automation tool boundaries and triage conflict handling, retried transient email event failures, and stabilized collaborative CodeMirror state restoration.
- Fixed notification summaries, file-picker labels, graph document names, provider verification handling, and nested email-preview scrolling.

### Verification

- `npm run verify:release`

## [2026.8.16.1] - 2026-08-16

### Added

- Added workspace-scoped email automations, including mailbox bindings, inbox polling, triage drafts, approval-gated sending, and automation templates.
- Added a built-in email agent profile and scoped workspace email tools for the automation harness.
- Added a reusable Studio prompt handoff and a manual browser desktop architecture plan.

### Changed

- Migrated scheduled heartbeats to workspace automations with unified result policies and clearer human-review controls.
- Updated mobile collaboration capability metadata for the new automation workflow.

### Fixed

- Corrected legacy email-account migration ordering and global chat notification summaries.
- Prevented Composio API-key configuration details from surfacing in automation errors.

### Verification

- `npm run verify:release`

## [2026.8.15.3] - 2026-08-15

### Added

- Added Obsidian-style wiki links to the rich collaborative Markdown editor.
- Added a mobile viewport mode to HTML previews and clearer mobile license status details.

### Changed

- Refreshed mobile and web plugin listings without duplicate installed-plugin entries.
- Sent background refresh pushes to keep mobile widgets current.

### Fixed

- Corrected mobile app badge counts for Inbox activity.
- Fixed the mobile unread-message counter type guard so production builds accept nullable session timestamps.
- Fixed nullable mobile-push test assertions so the release build typechecks cleanly.

### Verification

- `npm run verify:release`

## [2026.8.14.1] - 2026-08-14

### Added

- Added multi-document Notebook tabs, document-aware agent context, and a docked Notebook chat workspace.
- Added mobile support for scoped to-dos, grouped Inbox items, chat attachment batches, and TXT collaboration.
- Added configurable Direct MCP server settings, an expanded workspace-tool surface, and modern MCP OAuth and transport support.

### Changed

- Refined the focused Home workspace, Markdown editor, provider configuration, and email account setup flows.
- Improved rich Markdown authoring and PDF export for callouts, details blocks, tables, and other formatted content.
- Updated the Pi runtime and refreshed the related dependency license inventory.

### Fixed

- Hardened SQLite and Postgres startup failure handling, WebSocket lifecycle behavior, and inline-script rendering during client navigation.
- Stabilized Direct MCP tool isolation, runtime initialization, telemetry startup, and browser and desktop connection handling.
- Preserved Notebook chat visibility and preferences while navigating or opening documents.

### Security

- Hardened Direct MCP origin handling and applied non-breaking dependency audit fixes.

### Verification

- `npm run verify:release`

## [2026.8.12.1] - 2026-08-12

### Fixed

- Keep collaborative rich Markdown blocks schema-valid while their Yjs children are restored, preventing `canvasCallout` `RangeError` crashes when opening Markdown files.

### Verification

- `npm run test:editor:rich-blocks`
- `npm run lint -- app/lib/markdown/canvas-rich-markdown-extensions.ts scripts/markdown-rich-blocks-collaboration-test.ts`
- `npm run verify:release`

## [2026.8.11.4] - 2026-08-11

### Fixed

- Keep document renderer failures inside the Notebook preview instead of replacing the entire route, with a retry action for Markdown, Office, Excalidraw, and other editor surfaces.
- Capture localized and root route errors with structured client context in Sentry, including Markdown editor chunk-load failures.

### Verification

- `npm run lint`
- `npm run verify:release`

## [2026.8.11.3] - 2026-08-11

### Fixed

- Resolve license and Team entitlement checks before reserving database connections, preventing concurrent authenticated requests from exhausting the PostgreSQL pool and stalling Notebook access.
- Produce and verify the release bundle before GitHub Release publication, then notify the Control Plane only after the published artifacts are publicly available.

### Verification

- `npm run verify:release`

## [2026.8.11.1] - 2026-08-11

### Changed

- Hardened release artifact validation and desktop build automation across Linux, Windows, and macOS workers.

### Fixed

- Render PostgreSQL index expressions such as descending columns during startup migrations, preventing the container restart loop caused by a missing index-column name.

### Verification

- `npm run test:mcp:server-schema`
- `npm run verify:release`

## [2026.8.9.1] - 2026-08-09

### Changed

- Reduced Community license certificate database work by avoiding full-table scans and duplicate certificate inserts.
- Added clear, fail-closed license and Team feature availability states in the license and user-management interfaces.

### Fixed

- Deduplicated existing `license_certs` rows and enforced a unique `(instance_id, cert)` index for SQLite and Postgres.
- Added structured, redacted, throttled diagnostics for Control Plane and license-status failures.

### Verification

- `npm run verify:release`
- `npx tsc --noEmit`
- `npm run test:team-seat-health`
- `npm run test:team-seat-rollout`
- `npx tsx scripts/community-license-connection-ui-test.ts`

## [2026.8.2.5] - 2026-08-02

### Fixed

- Cast `next_attempt_at` and `completed_at` retry/failure parameters to `bigint` in Postgres `team_seat_outbox` updates, resolving type-mismatch errors when `CASE` expressions mixed `NULL` with bound numeric values.
- Strip Postgres type casts (`::bigint`) in the SQLite adapter so shared SQL works with both SQLite and Postgres.

### Verification

- `npm run build`
- `npm run test:cli:postgres-recovery`
- `npm run test:cli:operation-lock`

## [2026.8.2.4] - 2026-08-02

### Fixed

- Cast retry timestamp parameters to `bigint` in Postgres `team_seat_outbox` retry/failure updates so the `next_attempt_at` column accepts the value instead of raising a type mismatch.

### Verification

- `npm run build`
- `npm run licenses:refresh-cache`

## [2026.8.2.3] - 2026-08-02

### Added

- Added automatic GitHub Release creation during tag builds so releases no longer need to be created manually before assets are uploaded.

### Changed

- Cleaned up unused Docker images after successful canvas-notebook updates to prevent disk bloat on managed hosts.

### Fixed

- Added the missing `next_attempt_at` column to the Team membership sync state table, ensuring deterministic retry scheduling for membership reconciliation.

### Verification

- `npm run build`
- `npm run licenses:refresh-cache`

## [2026.8.2.2] - 2026-08-02

### Changed

- Disabled autonomous auto-update in Control Plane managed mode so host-managed instances do not self-update outside the Control Plane lifecycle.

### Fixed

- Ensured GitHub Releases for tagged builds automatically receive the portable CLI, host CLI, and native compliance bundle assets instead of leaving releases empty.

### Verification

- `npm run build`
- `npm run licenses:refresh-cache`

## [2026.8.2.1] - 2026-08-02

### Added

- Added optional Community license activation during setup and in Settings while preserving offline-capable local Solo use without a license.
- Added the Community-to-Team Seat flow with account claim, runtime preflight, server-authoritative quotes, explicit approval, idempotent activation, and signed entitlement refresh.
- Added Team membership management for direct adds, invitations, role changes, suspension, removal, deterministic reconciliation, and data-preserving Solo fallback.
- Added a Team Seat owner runbook and a published Notebook/Control Plane compatibility matrix.
- Added a Direct MCP server with OAuth 2.0 authorization-server metadata, resource token verification, conformance tests, HTTP smoke tests, and MCP Inspector validation.
- Added rich Markdown editing: callouts, footnotes, emoji picker, member mentions, document outline, search, and statistics.
- Added a curated mobile plugin marketplace API, installed-plugin details, and secure Composio connected-app flows for mobile automations.
- Added cooperative Browser Lab control and mobile collaboration-session tickets.

### Changed

- Bundled the application fonts locally so production builds and private-network deployments do not depend on Google Fonts availability.
- Optimized Browser Lab controls, layout, and interactions for mobile touch devices.
- Refreshed third-party dependency notices for OAuth-related libraries.

### Security

- Kept Team access fail-closed outside signed capacity and grace, rejected client-supplied quantities and prices, and revoked sessions when memberships lose access.
- Isolated non-billable test certificates from production signing and rejected test certificates in production mode.
- Enforced signed seat limits globally across activation, quote, invitation, and offboarding paths.
- Hardened Team Seat certificate validation, security boundaries, and migration coverage.

### Verification

- `npm run build`
- `tsx scripts/team-seat-release-verification-test.ts`
- `tsx scripts/mcp-server-auth-probe-test.ts`
- `tsx scripts/mcp-server-http-smoke-test.ts`

## [2026.8.1.2] - 2026-08-01

### Added

- Added cooperative control support for shared Browser Lab sessions and mobile Notebook collaboration tickets.

### Changed

- Optimized Browser Lab controls, layout, and interactions for mobile touch devices.

### Fixed

- Hardened Browser Lab session targeting and ticket-based file-view flows for reliable interactive use.

### Verification

- `npm run licenses:refresh-cache`
- `npm run verify:release`

## [2026.8.1.1] - 2026-08-01

### Added

- Added aggregate mobile Inbox sources and notification preferences for tasks, chats, and workspace activity.
- Added authenticated mobile Notebook collaboration-session tickets and compatibility capabilities.
- Added secure, ticket-based mobile HTML previews for workspace files.

### Changed

- Updated iOS push-device handling so badge-count changes wake registered devices.

### Security

- Restricted mobile HTML preview delivery to short-lived authenticated tickets and documented the internal security review.

### Verification

- `npm run licenses:refresh-cache`
- `npm run verify:release`

## [2026.7.31.1] - 2026-07-31

### Added

- Added a deterministic Notebook workbench with accessible layouts, contextual tools, and integrated PDF conversion, rendering, and page operations.
- Added shared live-browser session state, on-demand runtime context, embedded Notebook controls, a mobile browser contract, and an optional agent activity view beside the browser.
- Added safe binary file writes for agents and versioned mobile browser-view tickets.

### Changed

- Unified legacy and newly created chats in the Notebook route while preserving browser and agent session state across tab changes.
- Reused Docker build cache during setup and unified the Studio workspace switcher.

### Fixed

- Reconnected embedded browser views after tab switches, prevented duplicate agent sessions, and corrected scoped Studio aspect-ratio updates.

### Security

- Enforced upload and terminal ownership, restricted Studio reference reads, sanitized Excalidraw SVG assets, and forced active uploads to safe downloads.
- Removed runtime root escalation and rejected unsafe production authentication secrets.

### Verification

- `npm run licenses:refresh-cache`
- `npm run verify:release`

## [2026.7.30.1] - 2026-07-30

### Added

- Added authenticated mobile onboarding APIs for status discovery, profile-session recovery, and profile skipping, with matching compatibility and bootstrap capabilities.
- Expanded mobile account preferences, Inbox and To-do data, Studio output reframing, and push-notification support.

### Changed

- Made onboarding profile provisioning recoverable across interrupted sessions and improved waiting-state actions and localized guidance.
- Unified onboarding tour controls across the launcher, getting-started card, help menu, and contextual hints.
- Persisted onboarding hint completion more reliably across devices and concurrent updates.

### Fixed

- Restored license and profile recovery paths when onboarding cannot complete normally.

### Security

- Removed activated license keys from browser history and onboarding URLs.

### Verification

- `npm run licenses:refresh-cache`
- `npm run verify:release`

## [2026.7.27.1] - 2026-07-27

### Added

- Added native monthly automation schedules across the scheduler, automation UI, heartbeat descriptions, and agent create/update tools.
- Added day-of-month validation, time-zone-aware execution, and last-calendar-day handling for shorter months.
- Added an authenticated mobile app-badge count endpoint and included unread chat counts in attention push notifications.
- Advertised the new `push.app_badge` capability through the mobile compatibility and bootstrap APIs.

### Changed

- Added localized monthly cadence controls and schedule summaries in English and German.

### Verification

- `npm run licenses:refresh-cache`
- `npm run test:automation:schedule`
- `npm run test:pi:tools`
- `npm run test:mobile:compatibility`
- `npm run test:mobile:bootstrap`
- `npm run test:mobile:inbox`
- `npm run test:mobile:push`
- `npm run verify:release`

## [2026.7.26.2] - 2026-07-26

### Added

- Added authenticated mobile workspace brand profile and logo APIs, with matching bootstrap and compatibility capabilities.
- Added mobile chat session detail and runtime-selection APIs, including idle-only model changes and audit logging.

### Changed

- Ran database migrations before application startup so container and direct server launches reach readiness on the current schema.
- Advanced chat read cursors atomically to the latest message timestamp, avoiding false unread state from clock skew or select/update races.

### Security

- Updated direct and transitive dependencies to resolve security advisories and refreshed the matching third-party compliance artifacts.

### Verification

- `npm run licenses:refresh-cache`
- `npm run test:sessions:read-state`
- `npm run test:mobile:compatibility`
- `npm run test:mobile:bootstrap`
- `npm run test:mobile:brand`
- `npm run test:mobile:chat`
- `npm run verify:release`

## [2026.7.26.1] - 2026-07-26

### Added

- Added embedded agent chat, navigation history, reload, and clipboard controls to Browser Lab, with a more stable address input.
- Added authenticated mobile file-kind discovery and Excalidraw read/write APIs for native canvas editing.
- Added private mobile previews for agent chat and Studio output notifications, plus delivery for completed scheduled automations.
- Exposed Composio connection profiles to mobile automations and made mobile To-do links workspace-aware.

### Fixed

- Kept nested PostgreSQL backup and database command output out of CLI JSON responses.
- Corrected To-do due-date filtering and nullable Studio preview filenames.

### Verification

- `npm run licenses:refresh-cache`
- `npm run verify:release`

## [2026.7.25.1] - 2026-07-25

### Fixed

- Fixed mobile workspace startup behind HTTPS reverse proxies by resolving the license-gate status check against the configured public server URL instead of an incorrect internal HTTP origin.

### Security

- Stopped deriving the internal license-status request target solely from the incoming host and now prefer the trusted Better Auth or Canvas base URL configuration.

### Verification

- `npm run licenses:refresh-cache`
- `npm run test:mobile:license`
- `npm run test:mobile:bootstrap`
- `npm run verify:release`

## [2026.7.24.1] - 2026-07-24

### Added

- Added authenticated mobile APIs for agent files and extension skill and plugin discovery, installation, enablement, and disablement, with matching bootstrap and compatibility capabilities.
- Exposed structured mobile tool-call inputs and mobile Studio preview URLs for richer native client experiences.

### Changed

- Enabled collaborative mobile Markdown saves and improved Mermaid styling in PDF exports.

### Fixed

- Handled mobile chat runtime policy errors consistently and hardened unread mobile push delivery.

### Verification

- `npm run licenses:refresh-cache`
- `npm run verify:release`

## [2026.7.23.1] - 2026-07-23

### Added

- Added mobile license status, community registration, and key activation endpoints, advertised through the compatibility and bootstrap APIs.
- Exposed mobile automation job, run-control, run-history, heartbeat, webhook, and Composio-trigger capabilities in authenticated bootstrap responses.

### Changed

- Consolidated control-plane license registration and activation so web and mobile flows share consistent error handling and certificate activation.

### Fixed

- Restored access to mobile license recovery before a Notebook instance is activated and hid community registration after activation.

### Verification

- `npm run licenses:refresh-cache`
- `npm run verify:release`
- `npm run test:mobile:compatibility`
- `npm run test:mobile:bootstrap`
- `npm run test:mobile:license`

## [2026.7.21.1] - 2026-07-21

### Added

- Added a versioned mobile API for compatibility and bootstrap discovery, workspaces, real-time chat, Notebook files, Inbox and To-dos, Studio, automations, and push-device delivery.
- Added the interactive Browser Lab with secure live-browser chat integration, recovery controls, file transfers, and an admin home entry point.
- Added comprehensive agent profile management for models, tools, capabilities, managed files, access grants, and safe deletion.
- Added resource-specific skill documentation, positioned mobile Studio crops, and Canvas Notebook promotion on public file shares.

### Changed

- Made chat, notification, automation, To-do, email, and WebSocket session links workspace-aware across Notebook and docked-chat surfaces.
- Improved Composio profile scoping and deterministic toolkit discovery, Markdown preview continuity, branded page margins, and Markdown export spacing.
- Added unread-aware push delivery for successful web automations while preserving silent delivery and no-op heartbeat behavior.

### Fixed

- Fixed Browser Lab WebSocket close codes, frame recovery, transfer security boundaries, and invalid navigation fallbacks.
- Fixed PostgreSQL Composio profiles, no-auth connection handling, lazy file thumbnails, and Markdown preview stability.
- Prevented no-op heartbeats and already-read agent responses from producing duplicate notifications or persisted response noise.

### Security

- Hardened Browser Lab URL policy, ticketing, resource budgets, file access, and trusted-origin enforcement.
- Kept mobile workspace, file, Studio, chat, and automation actions behind authenticated workspace-aware permission checks.

### Verification

- `npm run verify:release`
- `npm run test:mobile:compatibility`
- `npm run test:mobile:bootstrap`
- `npm run test:mobile:studio`
- `npm run test:mobile:automations`
- `npm run test:automation:runner`
- `npm run test:chat:navigation`

## [2026.7.17.7] - 2026-07-17

### Added

- Added workspace-specific Composio connection profiles with trigger binding, profile controls, and automation usage visibility.
- Added model-change history in chats, Markdown heading-anchor navigation, and effective skill-package browsing for agents.

### Changed

- Reworked the self-hosting README and improved branded PDF output by showing the workspace brand name beside its logo.
- Completed the strict third-party license release gate and aligned the release workflows with the generated compliance bundle.

### Fixed

- Fixed Composio profile creation on PostgreSQL by quoting the reserved `user` table name.
- Fixed scoped skill browsing so agents can read the files exposed by enabled skill packages.
- Fixed PostgreSQL organization-policy target queries used by capability controls.

### Verification

- `npm run verify:release`

## [2026.7.17.5] - 2026-07-17

### Added

- Added Canvas-native Excalidraw live collaboration with multi-user presence, durable scene and asset persistence, reconnect/resync handling, and agent patch review after user intervention.
- Added resilient chunked workspace uploads, workspace document previews and relations, searchable organization policy targets, and grouped chat tool batches.
- Added a complete third-party license inventory, authenticated Legal downloads, exact native source evidence, and release-bound amd64/arm64 compliance artifacts.

### Changed

- Rebuilt both shipped Sharp versions against a replaceable shared libvips built from an exact source archive, and excluded all prebuilt `@img/sharp-*` payloads from Docker releases.
- Pinned Debian, PostgreSQL and Python runtime inputs to immutable snapshots, versions and hashes, with schema-4 runtime inventories and a pre-manifest multi-architecture evidence gate.
- Improved workspace-aware agent access, Markdown document references, chat presentation, plugin policy targeting, and upload progress handling.

### Fixed

- Fixed workspace upload retries and finalization, repeated bulk folder moves, knowledge-graph document search, Markdown editor state alignment, and Marp export memory handling.
- Synchronized all transitive peer and optional dependencies in `package-lock.json` and added a clean-install dry-run to the permanent release gate.
- Bootstrapped CA certificates from the same signed Debian snapshot before switching APT to HTTPS, and replaced the redundant Debian libvips binary with explicit runtime dependencies for the source-built shared libvips.
- Kept the complete libvips development-header set in the isolated dependency stage so both Sharp versions compile against that shared library without adding development packages to the runtime image.
- Restricted Python PEP 639 license discovery to `.dist-info/licenses`, preventing architecture-specific bytecode in packages named `licenses` from creating false multi-architecture compliance drift.

### Verification

- `npm run verify:release`
- `npm run test:licenses`
- `npx tsc --noEmit --pretty false`
- pip hash-resolution dry-runs for CPython 3.11 on linux/amd64 and linux/arm64
- direct SHA-256 verification of all pinned PGDG binary and source artifacts

## [2026.7.16.2] - 2026-07-16

### Added

- Completed the agent live-collaboration review flow with exact text patches, operation tracking, and focused integration coverage.

### Changed

- Improved live-collaboration cursors, Markdown properties spacing, and desktop chat-header layout.

### Fixed

- Handled aborted collaboration action requests consistently across accept, cancel, reject, and revert operations.

### Verification

- `npm run build`

## [2026.7.16.1] - 2026-07-16

### Added

- Added workspace and organization brand-logo display across Canvas and its public entry pages.
- Remembered the last open Notebook file separately for each workspace and added a clear unavailable-file notice.

### Changed

- Improved workspace branding controls, shared appearance presets, responsive Markdown properties, and semantic control radius support.
- Scoped Markdown metadata controls to Notebook and omitted frontmatter from Markdown PDF exports.

### Fixed

- Hardened collaboration polling recovery and isolated agent and workspace chat sessions correctly.

### Verification

- `npm run test:file-watcher`
- `npm run lint`
- `npm run build`

## [2026.7.15.4] - 2026-07-15

### Added

- Added workspace descriptions to agent context and workspace setup flows.
- Added workspace appearance profiles, branding controls, and branded interface theming.

### Changed

- Refined organization and workspace branding settings and applied workspace radius preferences across the editor interface.

### Fixed

- Preserved automation edits after moving an automation between workspaces and invalidated stale workspace appearance caches after updates.

### Verification

- `npm run build`

## [2026.7.15.3] - 2026-07-15

### Added

- Added drag-and-drop and shared workflows for moving files within a workspace.
- Added workspace-aware export controls and Obsidian-compatible workspace links in the Markdown editor.
- Added direct opening of newly created files and folders from the explorer.

### Changed

- Refined knowledge-graph workspace navigation, automation placement, and document-graph copy.

### Fixed

- Prevented accidental mobile editor-toolbar actions and mobile workspace action overflow.
- Preserved the required final full-access workspace member and cleared stale explorer selections.
- Restored in-place loading of the latest chat session.

### Verification

- `npm run build`

## [2026.7.15.2] - 2026-07-15

### Fixed

- Declared the Hocuspocus Transformer runtime dependency required by clean container builds.

### Verification

- `npm run build`

## [2026.7.15.1] - 2026-07-15

### Added

- Added live document collaboration with presence indicators, checkpoints, agent-operation review, and resilient reconnect handling.
- Added organization agent provisioning, scoped management tools, member grants, and organization-wide skill and plugin policies.
- Added workspace-aware Studio navigation, access controls, knowledge-graph refinements, and richer Markdown editing and navigation.

### Changed

- Improved managed agent-runtime startup, session continuity, configuration persistence, and responsive chat, editor, and settings experiences.
- Expanded agent capability package handling with transactional imports, personal skill forks, package verification, and Markdown skill previews.

### Fixed

- Fixed archived collaboration-store race conditions and SQLite-compatible Studio workspace migrations.
- Improved workspace localization for editing actions.

### Verification

- `npm run build`

## [2026.7.14.7] - 2026-07-14

### Added

- Added an interactive workspace knowledge graph with accessible document navigation and background layout calculation.
- Added Canvas Markdown math rendering, Obsidian-compatible embeds, callouts, footnotes, wiki links, and workspace link indexing.
- Added workspace and organization brand profiles, logo controls, branded agent context, and branded Markdown/PDF exports.
- Added workspace-scoped Studio storage and media foundations with workspace-aware routing.
- Added AI-generated session titles and automation workspace move and run-preview support.

### Changed

- Expanded workspace switching, file and editor interactions, automation UI, chat context handling, and document-link resolution for multi-workspace use.
- Added workspace-aware Studio APIs and migration and cleanup paths across generation, catalog, media, and exports.
- Improved knowledge graph loading and filtering and moved graph layout off the UI thread.
- Added PostgreSQL offboarding and permission support and plugin release-version compatibility.

### Fixed

- Fixed public Markdown export access checks, mobile workspace-sheet actions, workspace icon persistence, todo deep links, and automation workspace validation.
- Fixed knowledge graph construction typing for clean production builds.
- Bounded composed agent prompts and persisted system-prompt snapshots to protect context budgets.
- Fixed session history and title bootstrapping and workspace-scoped asset and file operations.

### Verification

- `npm run build`

## [2026.7.13.11] - 2026-07-13

### Added

- Added editable agent profiles and workspace icons with workspace creation and editing flows.
- Added safe ZIP extraction for workspace files, including path validation and focused extraction tests.

### Changed

- Expanded workspace access management, workspace switching, file previews, and agent selection flows.
- Improved workspace persistence and database-provider handling across SQLite and Postgres, with updated English and German translations.

### Fixed

- Fixed workspace API validation, workspace member handling, file operation behavior, and related UI state synchronization.

### Verification

- `npm run build`

## [2026.7.13.10] - 2026-07-13

### Added

- Added desktop marquee and same-level range selection to the file explorer.
- Added clearer workspace names in the switcher and expanded access management for available users.

### Changed

- Simplified personal runtime onboarding and completed the VM migration settings split.
- Improved narrow-screen chat and settings layouts, file-upload refresh behavior, bulk file moves, and empty-workspace interactions.

### Fixed

- Preserved file revision lineage across rename, copy, delete, and trash-restore flows.
- Fixed nested agent icon-picker dialogs, personal onboarding tour behavior, and a Turbopack file trace warning.
- Restored workspace member type declarations, organization validation, and workspace update handling so production builds type-check cleanly.

### Security

- Hardened CLI security handling, OAuth and Studio import path scoping, and outbound external requests.

### Verification

- `npm run build`

## [2026.7.13.9] - 2026-07-13

### Added

- Added personal workspace switching and self-service account credential management.
- Added public Markdown asset delivery, Marp preview routes, system SMTP notifications, and Studio media usage reporting.
- Added trash undo support and sortable file-list metadata.

### Changed

- Redesigned the chat model selector and usage analytics dashboard, and clarified runtime and provider configuration flows.
- Improved file explorer search, selection, mobile toolbar behavior, keyboard accessibility, and operation feedback.
- Expanded collaboration, browser-lab, email-management, and agent coauthoring architecture documentation.
- Updated compatible npm dependencies.

### Fixed

- Fixed mobile agent template picking, public short-link previews, Marp preview themes, managed-mode email routing, and rapid editor autosaves.
- Fixed trash-delete result propagation and workspace-switcher fixture behavior.
- Declared `react-is` as an explicit production dependency so clean container installs resolve Recharts' peer import.
- Regenerated the lockfile's nested peer and optional package entries so clean `npm ci` installs remain reproducible.

### Verification

- `npm run build`

## [2026.7.13.6] - 2026-07-13

### Added

- Added durable operation locks, checkpoints, and recovery handling for managed Canvas Notebook updates.
- Added CLI coverage for database reconciliation, backup, rollback, cross-platform host commands, and control-plane release payloads.

### Changed

- Reworked managed updates to stage release-pinned payloads atomically while coordinating CLI self-updates, database setup, and systemd lifecycle handoffs.
- Updated the multi-architecture build workflow to package managed release payloads for Control Plane consumption.

### Fixed

- Restored safe automatic-update defaults, Postgres credential reconciliation and redaction, and host CLI ownership after merging the managed-update workflow.
- Made managed-install verification portable across filesystems while still proving atomic configuration replacement.
- Restored the host CLI packaging command required by the tagged release workflow.

### Verification

- `npm run build`
- `npm run test:cli:operation-lock`
- `npm run test:cli:postgres-recovery`
- `npm run test:cli:postgres-reconcile`
- `npm run test:cli:database`
- `npm run test:cli:database-provider`
- `npm run test:cli:admin`
- `npm run test:cli:backup`
- `npm run test:install:managed-env`

## [2026.7.12.1] - 2026-07-12

### Added

- Added a catalog-backed AI runtime system with agent-scoped runtime policy, provider credentials, verification, and live runtime resolution.
- Added dedicated runtime support for chat sessions, channels, automations, delegated agents, todo follow-ups, and email AI workflows.
- Added per-user onboarding runtime profiles and provider-management flows alongside the settings navigation redesign.

### Changed

- Migrated managed and legacy agent configuration to scoped runtimes, then retired the legacy configuration, resolver, and model-probe paths.
- Reworked settings into a sidebar-based experience and separated runtime onboarding from ongoing settings management.

### Fixed

- Made managed control-plane swap reconciliation crash-safe and pinned session, onboarding, and follow-up execution to their selected runtimes.

### Verification

- `npm run build`
- GitHub Actions `Build and Push (Both Arch)` on `main`: `29208146665` built and pushed both architectures and merged the image manifest successfully before release prep.

## [2026.7.11.1] - 2026-07-11

### Added

- Added progressive agent tool gateways and modularized the tool registry so core, file, Studio, email, and web capabilities load with clearer runtime boundaries.
- Added transactional agent plugin management tools, including safe local package validation, registry updates, prompt refreshes, and MCP reconnection after configuration changes.
- Added separate instance and personal onboarding flows with resumable per-user initialization and provider verification.
- Added accessible keyboard and pointer resizing across notebook, chat, email, and todo panels, including nested layouts that adapt to the available space.

### Changed

- Scoped MCP runtimes, OAuth credentials, file references, open-file state, file watchers, and workspace searches to the active user and workspace.
- Improved agent context budgeting, compaction, summaries, heartbeat context, provider switching, and request payload limits.
- Unified chat file references and optimized file-tree rendering, search, synchronization, and reload behavior.

### Fixed

- Serialized WebSocket session actions and fixed promoted follow-ups so queued agent work is not drained or reordered by Steer requests.
- Fixed file explorer open races, workspace watcher isolation, stale reference reloads, and user-scoped Codex OAuth resolution.
- Filtered image attachments for non-vision models and constrained agent image context paths.

### Security

- Hardened WebSocket origin validation, application rate-limit identities, Mermaid rendering, PDF export, and MCP management authorization.
- Rejected symlinks and unsafe local paths in plugin packages, skill drafts, plugin storage, and MCP configuration.
- Required MCP OAuth during plugin preflight and made plugin registry mutations transactional and concurrency-safe.

### Verification

- `npm run build`
- GitHub Actions `Build and Push (Both Arch)` on `main`: `29146604729` built and pushed both architectures and merged the image manifest successfully before release prep.

## [2026.7.9.3] - 2026-07-09

### Changed

- Refreshed the managed Linux CLI before Notebook update, start, and restart flows so host operations use the current command implementation.
- Refreshed the portable macOS and Windows CLI before Notebook update flows so cross-platform updates run with the latest CLI behavior.

### Verification

- `npm run build`
- `npm run test:cli:update`
- `npm run test:cli:portable-update`
- GitHub Actions `Build and Push (Both Arch)` on `main`: `29039406731` built and pushed both architectures and merged the image manifest successfully before release prep.

## [2026.7.9.2] - 2026-07-09

### Changed

- Added shared browser export job limiting for markdown, HTML, Marp, and public export routes so PDF/image generation runs through a bounded queue.
- Enabled skill tools by default in agent runtime configuration while keeping explicit overrides supported.
- Reworked automation skill selection to use the native selector and keep the composer open after directory picks.

### Fixed

- Ran Postgres migrations before server startup and fixed automation transaction handling across database providers.
- Hardened markdown editor guard logic against runaway slash insertion and improved mobile markdown toolbar taps.
- Fixed mobile layout and input behavior in automations, todos, and Studio so fields avoid zoom, overflow, and cramped edit prompts.
- Stabilized markdown PDF export button loading layout and updated Studio image list queries to use Drizzle `inArray`.

### Verification

- `npm run build`
- GitHub Actions `Build and Push (Both Arch)` on `main`: `29025334082` built and pushed both architectures and merged the image manifest successfully before release prep.

## [2026.7.9.1] - 2026-07-09

### Added

- Agent skill workspace tools, core-skill protections, Canvas YAML skill version support, and agent runtime temp directory management.
- CLI flows for latest full backup retrieval, explicit database provider setup, and Postgres prepare reconciliation.
- Chat message copy actions, prompt drag-and-drop uploads, and persistent composer reference picker selection.

### Changed

- Expanded Postgres backup/restore and data backup planning, including full backup dump hardening and runtime temp cleanup determinism.
- Refined chat history overlay controls and agent temp cleanup so active temp directories are preserved.

### Fixed

- Fixed chat code block file-link rendering and chat file-link validation.
- Fixed workspace delete permission scoping and propagation.
- Stabilized PDF renderer restarts and markdown/html PDF export browser behavior.
- Fixed Docker image builds with npm 11 by allowing the pinned SheetJS tarball and approving required native install scripts.

### Verification

- `npm ci --legacy-peer-deps --dry-run --loglevel=warn`
- `npm run build`
- GitHub Actions `Build and Push (Both Arch)` on `main`: `29005715612` built and pushed both architectures and merged the image manifest successfully before release prep.

## [2026.7.8.1] - 2026-07-08

### Added

- Project workspace management, including member administration, project workspace member controls, workspace type changes, and a gated rollout path.
- User permission management and workspace offboarding safeguards for team deployments.
- Project todo assignee candidates and organization workspace defaults.
- Copyable chat code blocks and remote desktop installer assets.

### Changed

- Improved workspace, organization, and permission data access across SQLite and Postgres deployments.
- Updated Pi dependencies to `0.80.3` and switched Codex device flow to the Pi OAuth provider API.
- Made chat agent and workspace selectors more compact in team mode on desktop.
- Improved editor revision conflict handling, PDF Chromium/table export behavior, and portable CLI migration documentation.

### Fixed

- Fixed project workspace sharing scope, public share management, and project-manager share revocation.
- Fixed expired session cleanup and usage summary day grouping for Postgres.
- Fixed corrupt SQLite database error handling and SQLite deployment-mode auto-downgrade behavior.
- Fixed stale WebSocket recovery, agent browser workspace isolation, active-chat notification docking, notification markdown preview headings, markdown table scrolling, and chat history unread badge clipping.

### Verification

- `npm run build`
- GitHub Actions `Build and Push (Both Arch)` on `main`: `28927822450` built and pushed the image successfully before release prep.

## [2026.7.3.2] - 2026-07-03

### Added

- Persistent onboarding preference diagnostics so language and time zone save issues are easier to trace.

### Changed

- SQLite migration restores are now validated so pending migrations are confirmed to restore correctly before being applied.

### Fixed

- Clarified managed email upstream failure messages so SMTP/send errors are surfaced more clearly.
- Fixed iOS markdown toolbar keyboard offset so the toolbar stays positioned correctly when the on-screen keyboard appears.
- Fixed mobile agent selector popover so the selector opens and closes reliably on mobile devices.

### Verification

- `npm run build`
- GitHub Actions `Build and Push (Both Arch)` on `main`: `28655504086` built and pushed the image successfully before release prep.

## [2026.7.3.1] - 2026-07-03

### Added

- Streaming AI drafts for email compose, reply preview, and message summary with live status events (`reading_context`, `writing`, `ready`) surfaced in the compose dialog and message viewer for both quick and workspace-agent modes.
- Live draft delta rendering so AI-generated email text appears incrementally while it is being written.

### Changed

- Multi-account email flows now support switching between accounts without losing per-account folder and message state.
- Workspace file tree loading is faster.

### Fixed

- Kept the mobile markdown toolbar viewport fixed so the toolbar stays visible during mobile editing.

### Verification

- `npm run build`
- `npm run lint`
- GitHub Actions `Build and Push (Both Arch)` on `main`: `28624308344` built and pushed the image successfully before release prep.

## [2026.7.2.4] - 2026-07-02

### Fixed

- Sanitized upload filenames instead of rejecting uploads with names containing unusual characters, so legitimate files are no longer blocked.
- Scoped image viewer URLs with the active workspace id so preview URLs resolve to the correct workspace and do not leak across scopes.
- Fixed onboarding preference save logging so language/time zone save diagnostics are recorded correctly.

### Verification

- `npm run build`
- GitHub Actions `Build and Push (Both Arch)` on `main`: `28617193473` built and pushed the image successfully before release prep.

## [2026.7.2.3] - 2026-07-02

### Fixed

- Fixed mobile markdown toolbar reactivation so the toolbar resumes correctly after interactions on mobile devices.
- Fixed scoped office file downloads so Office, PowerPoint, and spreadsheet editors download files scoped to the correct workspace instead of leaking across scopes.

### Verification

- `npm run build`
- GitHub Actions `Build and Push (Both Arch)` on `main`: `28597545484` built and pushed the image successfully before release prep.

## [2026.7.2.2] - 2026-07-02

### Fixed

- Fixed `413 Request body is too large` error when the agent reads multiple images via the `read` tool. Images are now compacted to WebP (max 2048px, quality 82) before being sent through the Control Plane chat proxy.
- Added detailed server- and client-side logging for onboarding language/time zone save to help diagnose the "Sprache und Zeitzone konnten nicht gespeichert werden" error.

### Verification

- `npm run build`
- GitHub Actions `Build and Push (Both Arch)` on `main`: `28583495649` built and pushed the image successfully before release prep.

## [2026.7.2.1] - 2026-07-02

### Added

- Added Postgres runtime support, including database provider abstraction and routing core workspaces through Postgres.
- Added SQLite-to-Postgres migration CLI command (`canvas-notebook database migrate`) and bootstrap service.
- Added a portable cross-platform server CLI (`canvas-notebook-server`) with macOS and Windows installer support.
- Added runtime capability profile and license-based runtime entitlement enforcement.
- Added authenticated user context to agent prompts and scoped PI OAuth credentials per user.
- Added `compose.coolify.yaml` for Postgres deployments on managed platforms.
- Added managed team install environment persistence.
- Added GitHub Actions workflow for packaging portable CLI artifacts.

### Changed

- Replaced separate per-architecture build workflows with a single combined `build-both.yml` workflow that builds amd64 and arm64 images and merges multi-arch manifests.
- Improved plugin/MCP connector setup states and template generation.
- Optimized file browser rendering and simplified file operation flows.
- Made time zone a server-wide admin-only setting and hardened onboarding timezone save permissions.
- Updated the cross-platform installer CLI and runtime provider decoupling plans.

### Fixed

- Fixed Postgres 18+ volume mount paths in compose templates.
- Fixed file explorer shift selection and nested file copy handling across workspaces.
- Fixed duplicate React keys in Markdown toolbar dialogs and task list checkbox layout.
- Fixed markdown block drag-and-drop insertion behavior.
- Fixed Composio trigger apps loading loop in automations and scoped managed Composio/email requests by user.
- Fixed internationalization formatting error for Markdown-to-PDF attachments.
- Fixed version indicator for four-part calendar versions.
- Fixed agent runtime test PI AI compatibility mock.

### Verification

- `npm run build`
- GitHub Actions `Build and Push (Both Arch)` on `main`: `28576672244` built and pushed the image successfully before release prep.

## [2026.6.30.2] - 2026-06-30

### Added

- Added unified plugin and MCP connector setup UI in Integrations settings.
- Added skill package imports (`.canvas-skill` / archive upload) in the Skills panel.

### Changed

- Made time zone a server-wide admin-only setting.
- Reorganized Docker compose files: moved `compose.yaml` to `dev/`, added `compose.ghcr.yaml`, and moved `compose.hub.yaml` to `install/`.
- Simplified `.env.docker.example` for personal single-user setup.

### Fixed

- Fixed chat websocket initialization timeout.
- Fixed dev `compose.yaml` relative paths and the `--progress` flag.
- Hardened mobile markdown overlays and preserved markdown toolbar selection.
- Aligned markdown task checkboxes.

### Verification

- `npm run build`
- GitHub Actions `Build and Push` on `main` before tagging.
- GitHub Actions `Build and Push` on tag `v2026.6.30.2`.

## [2026.6.30.1] - 2026-06-30

### Added

- Added centralized browser runtime policy and status handling for agent, export, and sharing flows.
- Added a dedicated Browser settings tab for managing browser runtime availability.

### Changed

- Moved Studio inspiration below generated outputs to improve the create workflow.
- Moved browser runtime controls out of agent settings and into the settings navigation.
- Updated non-breaking npm dependencies, including Better Auth, Electron, Lucide, Nodemailer, and Tailwind CSS.

### Fixed

- Fixed mobile Markdown toolbar activation and touch behavior.
- Fixed browser runtime policy propagation for Markdown PDF, Marp, and HTML PDF routes.

### Verification

- `npm audit`
- `npm run build`
- GitHub Actions `Build and Push` on `main`: `28447771083` built and pushed the image successfully before release prep.

## [2026.6.29.1] - 2026-06-29

### Added

- Added a mobile Markdown editor formatting toolbar with localized labels and compact touch controls.

### Changed

- Improved editor file-loading feedback and markdown toolbar state sharing.
- Hardened mobile Markdown editor controls and toolbar spacing.
- Updated the release publisher and Greptile workflow guidance for the current release process.
- Normalized the Control Plane release webhook URL/path handling in the image build workflow.

### Fixed

- Shipped the Node 24 Next.js startup fix by ensuring `globalThis.AsyncLocalStorage` is available before importing Next.
- Fixed duplicate Canvas Agent Chat user messages.
- Fixed CodeQL-reported security issues in Studio image imports, email HTML conversion, link previews, plugin/skill manifest loading, browser runtime access, and safe path handling.
- Fixed Marp workspace-aware export and preview requests.
- Kept release webhook notification failures from failing otherwise successful image builds.

### Security

- Hardened external fetch, safe-path, and manifest handling paths covered by CodeQL.

### Verification

- `npm run test:startup-runtime`
- `npm run build`
- GitHub Actions `Build and Push` on `main`: `28403214482` built and pushed the image successfully.

## [2026.6.28.1] - 2026-06-28

### Changed

- Updated maintenance dependencies across the agent runtime, editor, browser automation, Studio, telemetry, desktop, and test toolchain.
- Kept ESLint on the latest compatible 9.x release because the current React ESLint plugin stack does not support ESLint 10 yet.
- Improved mobile automation composition layout and hid personal/team workspace switchers when only personal mode is available.

### Fixed

- Fixed legacy automation migration ordering for existing installations.
- Fixed dependency security advisories reported by GitHub Dependabot.
- Adapted PDF.js, Puppeteer, and PI runtime integration code to their updated APIs.
- Excluded the new `data/workspaces/**` runtime workspace tree from linting.

### Security

- Updated vulnerable direct and transitive npm dependencies until `npm audit --audit-level=moderate` reported zero vulnerabilities.

### Verification

- `npm audit --audit-level=moderate`
- `npm run lint`
- `npm run build`
- Greptile review for PR #47: `5/5`
- GitHub Actions `Build and Push` on `main`: `28329774666` built and pushed the image successfully, then failed only at the known Control Plane webhook step.

## [2026.6.26.1] - 2026-06-26

### Added

- Added the organization, owner, permission, and workspace context foundations for personal and team workspaces.
- Added global workspace switching, workspace copy actions, workspace-aware agent sessions, and user-scoped agent storage.
- Added organization-scoped todos, workspace-scoped automations, organization Studio assets, workspace public links, audit trails, retention/trash handling, and granular migration import/export policy.
- Added database provider abstraction, installer database provider selection, local Postgres compose setup, provider-aware backup/migration manifests, and Postgres-gated advanced knowledge settings.
- Added collaboration lock policy and shared workspace revision guards.

### Changed

- Routed file APIs, search/retrieval, usage jobs, automations, public shares, Studio references, chat history, markdown PDF sharing, and secrets through workspace/user scope.
- Hardened workspace path normalization, filesystem write policy, agent file mutation auditing, and agent bash tool execution.
- Improved mobile workspace navigation, sticky suite navigation, Studio workspace destination/source pickers, email chat context, email attachment handling, markdown block drag behavior, and upload progress feedback.
- Migrated legacy `/data/workspace` contents into the owner personal workspace and legacy single-user secrets into owner scope.

### Fixed

- Fixed migration ordering for legacy owner user indexes.
- Fixed notebook preview state after workspace switches.
- Fixed duplicate chat workspace badges.
- Fixed Studio workspace picker interactions and workspace source selection for image references.
- Fixed repeated email attachment uploads and email body scrolling.

### Verification

- `npm run build`
- GitHub Actions `Build and Push` on `main`: `28247521717` built and pushed the image successfully, then failed only at the known Control Plane webhook DNS step for the old `api.canvas.holdings` domain.

## [2026.6.19.1] - 2026-06-19

### Fixed

- Fixed production container runtime source contents so Canvas Agent Chat status checks can resolve root app modules such as `@/i18n/routing` when loaded through `tsx server.js`.
- Prevented the missing runtime module failure from surfacing as WebSocket request timeouts in Canvas Agent Chat.

### Verification

- `npm run build`
- GitHub Actions `Build and Push` on `main`: `27831720600`

## [2026.6.18.1] - 2026-06-18

### Added

- Added configurable user time zone support across onboarding, settings, automation scheduling, and agent prompt context.
- Added home agent selector preferences for chat prompts.
- Added plugin detail, plugin skill health repair, persisted skills settings tabs, and legacy folder hiding in the skills tree.
- Added Telegram user binding management and multi-user Telegram channel sessions.
- Added Docling ingestion planning and team-workspace architecture plans for audit retention, workspace switching, filesystem policy, user-scoped secrets, setup migration, agent tool execution, automation execution, retrieval, job backpressure, public links, backup/restore, offboarding, Postgres provider requirements, and collaboration conflict policy.

### Changed

- Improved Markdown editing with rich-mode defaults, rendered block controls, task list styling, link previews, range guards, hidden chat-reference extensions, renamed mode actions, and explicit-save reset protection.
- Improved automation picker behavior, workspace directory picker closing, disconnected channel visibility, and editor surface backgrounds.
- Refined control-plane migration and policy contracts, installer migration planning, and collaboration policy documentation.
- Polished Studio inspiration selection behavior.

### Fixed

- Fixed onboarding profile skip handling.
- Fixed agent prompt time zone context.
- Fixed Markdown slash suggestion range crashes.
- Fixed automation workspace picker closing behavior.
- Fixed Studio inspiration selection state.

### Security

- Improved security share filters.
- Documented public links, Studio asset policy, unencrypted workspace file handling for v1, user-scoped secrets, offboarding recovery, backup/restore, and Postgres provider requirements.

### Verification

- `npm run build`

## [2026.6.17.1] - 2026-06-17

### Added

- Added Canvas plugin runtime management, plugin references in chat, skill metadata, and icon fallback handling.
- Added Studio route navigation, Veo image reference controls, persistent generation controls, and improved Studio image sharing.
- Added email attachments, managed attachment forwarding, an HTML composer, recipient chips, inline email images, and workspace agent draft mode.
- Added Markdown editor slash commands, inline color swatches, image upload/import, link previews, table tools, and Tiptap markdown roundtrip coverage.
- Added Canvas plugin and skill store flows, including plugin store preflight, connector recommendations, standalone skill materialization, and skill deletion.
- Added clean-room document seed skills and migration upload chunk sizing coverage.
- Added Marp slides, document-suite seed plugins, and team workspace planning artifacts.

### Changed

- Refactored Canvas agent chat into focused runtime, session, composer, history, message, and tool rendering modules.
- Refactored file browser path, tree, API, create, and operation helpers to reduce repeated logic.
- Made Studio home the create workspace and compacted the composer/control layout.
- Made plugins the primary settings view and seeded missing Canvas skills on startup.
- Updated managed service control-plane domains and refreshed npm lockfile dependencies, including Google GenAI SDK, Nodemailer, and Sharp.
- Shared secure remote image fetching across Markdown and email image import flows.

### Fixed

- Fixed onboarding profile completion races and managed model test timeout diagnostics.
- Fixed Studio chat dock state, composer overlay state, models mobile layout, prompt/reference deduplication, video reference budgets, and aspect-ratio outpaint masking.
- Fixed email HTML preview rendering, touch row actions, compose reference picker, AI summary rendering/streaming, attachment workspace metadata, and inline image attachment pruning.
- Fixed automation markdown preview height and automation run OOM behavior on detail refresh.
- Fixed usage filter responsive overflow, skills browser scrolling, markdown block insert behavior, and migration upload chunk sizing.

### Security

- Hardened license JWT validation for issuer, audience, active status, expiration, future issue time, and trusted public-key fingerprints.
- Added license entitlement guard helpers for feature, plan, and quota enforcement.
- Blocked private, localhost, and unresolved hosts for server-side remote image imports, including redirect targets.

### Verification

- `npm run build`
- `npm run test:email:attachments`
- `npm run test:email:html-content`
- `npm run test:license`
- GitHub Actions `Build and Push` on `main`: `27694619880`, `27696295464`

## [2026.6.11.1] - 2026-06-11

### Added

- Persist unsent composer drafts per session in localStorage.
- Interactive error card with prompt recovery in Studio: failed generation cards are clickable to show original prompt, copy, and remix.
- Edit follow-up queue messages via context menu.

### Changed

- Translate Studio image resolution labels and remove deprecated models.
- Render tool I/O as structured key/value lists in compact chat mode.
- Remove `public_share_file` from default disabled tools.
- Simplify compact session history.
- Make Studio Preview load references/presets on mount and persist preset name.

### Fixed

- Fix redirect loop between login and setup on initial setup.
- Fix garbled AI responses: activate thinking filter, improve onboarding prompt.
- Fix markdown save response reliability.
- Handle malformed upload form data.
- Fix lazy file tree expansion.
- Fix inconsistent file reference rendering in chat.
- Fix automation timeout, stale-cleanup on startup & execute-ready, global stale-run recovery.
- Fix chat scroll jumping when images load asynchronously.
- Fix studio preview popup jumping during image navigation.
- Fix studio generation error handling: propagate errors to AI agent with supported ratios list.
- Fix robuster und schnellerer Bild-Upload in Studio Models.

### Verification

- `npm run build`

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
