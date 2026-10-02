# Plugins app: next improvements

## First delivery

Plugins have a dedicated `/plugins` app with the existing package and connector management. The first launcher page and the Home workspace section link directly to it. Settings retain an app shortcut, and legacy `tab=plugins` / `tab=skills` links resolve to the corresponding app area. Explicit URL views take precedence over obsolete saved tab preferences.

Installed plugins load independently of the marketplace, and skills load when their area is opened. Loading failures have explicit error states; a failed catalog cannot report that all updates are installed. Connection requirements, package conflicts and blocked/required policies have localized labels and hints. Management scope is stored in the URL, checked against the user's organization permission and resets local panel state when changed through navigation or history.

Keep package APIs, storage scopes, central secret management and organization capability policies as the source of truth. Moving the UI must not introduce a separate installation implementation.

## Implementation status

All four stages are implemented and locally accepted on 2026-10-02. Plugins is accessible from Home and the app launcher; Settings retains its shortcut. The final production build, twelve focused app checks and 33 Playwright cases passed.

The follow-up review also found and fixed two integration gaps: the app now requests complete resource identities without changing name-based Chat/mobile behavior, and old connection/preflight callbacks are rejected after workspace changes, including A to B to A.

At 390×844, the first real catalog card starts at 545px and its primary action ends at 785px in both locales. The 320px dark-mode layout retains visible scope, readable controls and keyboard-accessible help.

[Final acceptance, boundaries and screenshots](plugins-app-optimization-acceptance.md).

## Completed work, in order

### 1. Finish the complete connection round trip

The plugin detail view already checks connector prerequisites and can configure MCP connections or initiate Composio authentication. Some actions still leave the detail view for integration or email settings.

- Give plugin detail views a URL containing the installation resource identity and source, so reload and Back restore the selected plugin.
- Preserve the originating plugin, area, view and active workspace across Settings and OAuth callbacks. Validate return destinations as internal app paths.
- Refresh readiness after authentication and keep installation/update actions disabled while required checks are pending.
- Show a successful installation separately from a usable connection; optional requirements must stay optional.

Acceptance: starting in a plugin detail view, completing a required connection and returning restores the same plugin and scope with fresh readiness. Cover popup blocking, authentication cancellation, expired connections and a workspace switch during setup.

### 2. Improve discovery and installed-package filtering

Search and Discover / Installed / Updates already exist. Add category and connection-type filters to discovery, and readiness / enabled-state filters to the installed list.

- Apply marketplace filters on the server before pagination, using catalog metadata instead of filtering only the currently loaded page.
- Store filters, search and pagination in the URL and reset pagination when a filter changes.
- Distinguish an empty installation, a search with no matches and an unavailable catalog; each state gets an appropriate action.
- Verify update information for installed plugins beyond the first marketplace page.

Acceptance: combined filters return the correct global counts, Back restores the previous filter and page, and catalog failure keeps installed packages usable.

### 3. Make scope and policy decisions easier to understand

The personal and organization management scopes already exist, including assigned organization plugins and locked policies.

- Explain who installed a package, who can update or remove it, and whether activation is personal or required by the organization.
- Keep the active workspace visible where it affects connection readiness; workspace selection and package ownership are different concepts.
- Explain locked controls beside the action, with a useful next step rather than a technical policy value.

Acceptance: a member can manage personal activation where permitted, sees why required/blocked packages are locked, and cannot acquire organization management rights through a URL or hidden control.

### 4. Reduce the mobile introduction and scope height

The browser acceptance at 390×844 shows that repeated introduction, scope and package-description text pushes the first catalog card close to the bottom of the initial viewport.

- Shorten repeated explanations and offer longer scope guidance on demand.
- Keep the selected scope, area and primary catalog controls visible.
- Preserve readable labels and wrapped tabs at 320px, including dark mode.

Acceptance: the first catalog card and its primary action are reachable with less introductory scrolling, while scope ownership stays clear.

## Validation

Run `npm run test:plugins:app`, focused package/connector regression tests, lint for changed files, and `npm run build`. Browser acceptance requires the explicit authorization specified in `AGENTS.md`; use the managed local stack and rebuild it from the current worktree before testing.

Browser acceptance covers launcher entry and quick actions, Home entry, old Settings links, direct plugin/skill views, Back/Forward and reload, both locales, desktop and narrow layouts, delayed/failed data sources, organization permission boundaries, and connection setup. Verify visible errors and console errors.

The initial launcher delivery passed nine browser cases: [initial acceptance](plugins-app-browser-acceptance.md). The completed optimization passed 33 cases: [final acceptance](plugins-app-optimization-acceptance.md). External OAuth completion and production acceptance remain separate.
