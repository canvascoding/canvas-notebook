# Plugins optimization acceptance

## QA inventory

The implementation preserves existing installation, organization-policy and central-secret APIs. Each claim below requires a functional check; the mobile checks also require visual inspection.

| User-facing claim | Acceptance check |
| --- | --- |
| Plugin details survive reload and history | Exact installed resource identity and independent store-detail lookup |
| Setup returns to the originating plugin | Settings return link and validated OAuth destination preserve view, scope and workspace |
| Connection state is current | Fresh installed readiness and store preflight after setup, required-check action gating |
| Failed or cancelled setup is recoverable | Blocked popup, closed window, delayed checks and missing optional connection |
| Workspace changes cannot accept old setup results | Switch workspace with an outstanding authentication request and verify request/result identity |
| Catalog filters cover the complete catalog | Server-side combined filters and global counts before pagination |
| Navigation restores filters | Search, category, connection, readiness, enabled state and page in URL/history |
| Installed updates survive catalog pagination | Installed metadata independent from current discovery page |
| Policy controls explain ownership | Personal/organization ownership, required/blocked controls and member boundaries |
| Mobile entry is compact | First card/action position at 390px; readable wrapped controls at 320px in dark mode |

## Results

All four implementation stages passed the production build and 33 Playwright cases on 2026-10-02. TypeScript, focused ESLint, all twelve Plugins app checks, the real package lifecycle and the agent workspace regression passed.

The managed local stack supplies PostgreSQL, Control Plane, real login, organization membership and workspaces. The current Notebook source is built with `npm run build` and served in production mode by the managed host launcher. The Notebook container stays stopped while this host process runs; there is only one Notebook test runtime.

Focused checks include the Plugins app suite, the actual plugin registry/archive/filesystem lifecycle, agent workspace integration, TypeScript and ESLint. Provenance checks cover first installation, updates and legacy adoption: updates retain the original installer, and unknown legacy provenance remains unknown.

Scope tests exercise the actual MCP-template and image routes with deterministic authentication/storage fixtures. They cover exact personal and organization resource IDs, legacy synthesized identities, the existing system-registry fallback, foreign ownership, membership, workspace and assignment denial, plus real image-file and symlink boundaries.

The installed-list regression executes the actual historical registry deduplicator and reproduces the loss of a same-name organization resource. The app explicitly requests `identity=resource`; the existing Chat and mobile default remains name-based. Regression checks cover both contracts, exact organization detail resolution, counts and fresh workspace readiness.

Connection-race checks execute the actual panel callbacks with controlled asynchronous responses. They cover a late status JSON body, obsolete refresh completion, saved callbacks and A to B to A. Current authentication completion still refreshes readiness. The browser workspace test also releases an old ACTIVE status body after switching workspaces and checks that no old preflight starts.

## Mobile measurements and visual inspection

At 390×844, with no introductory scrolling:

| Locale | First real card | Card top | Primary action bottom |
| --- | --- | --- | --- |
| German | Canvas Basics | 545px | 785px |
| English | Canvas Basics | 545px | 785px |

The previous layout placed the first card around 825px. The new layout moves the repeated introduction and scope explanations into native disclosure controls. At 320px in dark mode, tests verify selected-scope semantics, filter width/font size, keyboard expansion/collapse and absence of horizontal document overflow.

The German mobile, narrow dark-mode and organization-detail screenshots were inspected visually. They show readable controls, the visible primary action and separate ownership, installer and workspace information.

- [German mobile](plugins-app/screenshots/optimization-mobile-de.png)
- [English mobile](plugins-app/screenshots/optimization-mobile-en.png)
- [320px dark mode](plugins-app/screenshots/optimization-narrow-dark.png)
- [Organization details](plugins-app/screenshots/optimization-organization-details.png)

## Boundaries

- Browser login, navigation, history, workspace changes and the member's management denial use the real local application. The member's direct installation request returns a real `403`.
- External OAuth providers, catalog failures, package writes, preference writes and selected icon bytes are deterministic browser fixtures. Live provider completion and production deployment are not part of this acceptance.
- Package installation, update, adoption and removal also run against real temporary registry and package files. Composio dependencies are isolated in this filesystem test; its background auth/database refresh warnings do not establish database integration coverage.
- Screenshots are captured after authentication without login fields, secrets, traces or videos.
