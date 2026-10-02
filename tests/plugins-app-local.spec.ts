import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import appPackage from '../package.json';
import de from '../messages/de.json';
import en from '../messages/en.json';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import type { NotificationSummary } from '../app/components/notifications/notification-summary';

// QA inventory: real login and return destination; Home and first launcher page;
// desktop quick actions/mobile sheet; explicit plugin and skill views, history,
// reload and legacy Settings links; lazy skills; delayed/failed catalogs and
// retry; readable readiness and Setup detail; genuine member permissions.
// Each viewport gets screenshots and region/overflow checks. No external account
// is connected and no package or secret is installed or changed.
async function createAcceptancePage(context: BrowserContext) {
  // The unrelated global update check is independent of Plugins and may be
  // rate limited by GitHub. Pin its response to the running app version.
  await context.route('https://api.github.com/repos/canvascoding/canvas-notebook/releases/latest', route => (
    route.fulfill({ json: { tag_name: `v${appPackage.version}`, body: '', assets: [] } })
  ));
  // Repeated route/reload checks exceed the independent notification widget's
  // 60-per-minute quota. Keep its valid empty response fixed for this suite.
  const notificationSummary: NotificationSummary = {
    unreadCount: 0,
    counts: { unread: 0, chat: 0, todos: 0, todoAttention: 0, emailAttention: 0, studio: 0, automation: 0, memoryApprovals: 0 },
    items: [], sections: { notifications: [], todos: [], todoAttention: [], emailAttention: [] },
  };
  await context.route('**/api/notifications/summary?*', route => (
    route.fulfill({ json: { success: true, data: notificationSummary } })
  ));
  return context.newPage();
}

function collectRuntimeErrors(page: Page, expectedUnavailablePaths: string[] = [], anonymousActivity = false) {
  const errors: string[] = [];
  let activityIssueReported = false;
  const anonymousIssuesReported = new Set<string>();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const resourceUrl = message.location().url;
    let resource: URL | null = null;
    try { resource = new URL(resourceUrl); } catch { /* Console messages can omit their source URL. */ }
    // Keep known anonymous-page diagnostics observable separately from the
    // authenticated Plugins flow, without suppressing any Plugins API error.
    if (anonymousActivity && /^Failed to load resource:.*status of 401/.test(message.text())
      && resource?.origin === new URL(process.env.BASE_URL!).origin
      && ['/api/instance/human-activity', '/api/public/brand/logo'].includes(resource.pathname)) {
      if (!anonymousIssuesReported.has(resource.pathname)) test.info().annotations.push({
        type: 'known-login-diagnostic', description: `${resource.pathname} returns 401 before login; see browser acceptance report`,
      });
      anonymousIssuesReported.add(resource.pathname);
      return;
    }
    // Existing global telemetry rejects the mapped local port. Keep this
    // observable as a test annotation; do not hide errors from Plugins APIs.
    if (/^Failed to load resource:.*status of 403/.test(message.text())
      && resourceUrl === `${process.env.BASE_URL}/api/instance/human-activity`) {
      if (!activityIssueReported) test.info().annotations.push({
        type: 'known-global-issue', description: 'human-activity returns 403 on the mapped local port; see browser acceptance report',
      });
      activityIssueReported = true;
      return;
    }
    // The two service-failure cases deliberately return HTTP 503.
    if (/^Failed to load resource:.*status of 503/.test(message.text())
      && expectedUnavailablePaths.some(apiPath => resourceUrl.startsWith(`${process.env.BASE_URL}${apiPath}`))) return;
    errors.push(`${message.text()} (${resourceUrl})`);
  });
  return errors;
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), scale: 'css', animations: 'disabled' });
}

async function expectFit(page: Page) {
  const bounds = await page.evaluate(() => {
    const regions = [...document.querySelectorAll('h1, [role="tablist"]')]
      .filter(element => (element as HTMLElement).offsetParent !== null)
      .map(element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, regions };
  });
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1);
  for (const region of bounds.regions) {
    expect(region.left).toBeGreaterThanOrEqual(-1);
    expect(region.right).toBeLessThanOrEqual(bounds.width + 1);
  }
}

async function stageSharedWorkspace(page: Page) {
  const response = await page.request.get('/api/workspaces');
  expect(response.ok()).toBe(true);
  const { workspaces } = await response.json();
  const shared = workspaces.find((workspace: { id: string; name: string }) => workspace.name === 'Shared Test Workspace');
  expect(shared?.id).toBeTruthy();
  await page.context().addInitScript(id => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.skills.panelTab', 'skills');
    localStorage.setItem('canvas.skills.pluginStoreTab', 'advanced');
  }, shared.id);
}

test('login restores the requested Plugins view', async ({ browser }, info) => {
  const context = await browser.newContext({ baseURL: process.env.BASE_URL });
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page, [], true);
  try {
    await page.goto('/en/plugins?view=installed');
    await expect(page).toHaveURL(/\/login\?/);
    expect(process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD).toBeTruthy();
    await page.locator('#email').fill(process.env.BOOTSTRAP_ADMIN_EMAIL!);
    await page.locator('#password').fill(process.env.BOOTSTRAP_ADMIN_PASSWORD!);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/en\/plugins\?view=installed$/);
    await expect(page.getByRole('tab', { name: en.skills.plugins.storeTabs.installed, exact: true })).toHaveAttribute('aria-selected', 'true');
    await capture(page, info, 'authenticated-installed');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

for (const locale of ['de', 'en'] as const) for (const mobile of [false, true]) {
  test(`${locale} ${mobile ? 'mobile' : 'desktop'}: Home, launcher, views, history and legacy links`, async ({ browser }, info) => {
    const messages = locale === 'de' ? de : en;
    const context = await createAuthenticatedContext(browser, {
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile, hasTouch: mobile,
    });
    const page = await createAcceptancePage(context);
    const errors = collectRuntimeErrors(page);
    try {
      await stageSharedWorkspace(page);
      await page.goto(`/${locale}`);
      await page.waitForLoadState('networkidle');
      if (mobile) {
        await page.getByRole('button', { name: messages.home.pages.toWorkspace, exact: true }).click();
      } else {
        await page.getByRole('navigation', { name: messages.home.pages.navigation, exact: true })
          .getByRole('button', { name: messages.home.pages.workspace, exact: true }).click();
      }
      const homeEntry = page.getByRole('link', { name: messages.home.apps.plugins.title, exact: true });
      await expect(homeEntry).toHaveAttribute('href', `/${locale}/plugins`);
      await homeEntry.scrollIntoViewIfNeeded();
      await capture(page, info, 'home-entry');
      await homeEntry.click();
      await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: messages.skills.plugins.storeTabs.discover, exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[role="tabpanel"][data-state="active"] [data-slot="skeleton"]')).toHaveCount(0);
      await capture(page, info, 'discover');
      await expectFit(page);

      // Launch from Home to verify a real route change, then wait for the new
      // page header before opening its launcher quick actions.
      await page.goto(`/${locale}`);
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: messages.navigation.openAppLauncher, exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'Plugins', exact: true })).toHaveAttribute('href', `/${locale}/plugins`);
      await expect(page.getByRole('menuitem', { name: 'Notebook', exact: true })).toBeVisible();
      await capture(page, info, 'launcher');
      await page.getByRole('menuitem', { name: 'Plugins', exact: true }).click();
      await expect(page).toHaveURL(url => url.pathname === `/${locale}/plugins`);
      await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: messages.skills.plugins.reload, exact: true })).toBeEnabled();
      await expect(page.getByRole('menu')).toHaveCount(0);
      await page.getByRole('button', { name: messages.navigation.openAppLauncher, exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'Plugins', exact: true })).toBeVisible();
      await page.getByLabel(messages.navigation.openAppActions.replace('{app}', 'Plugins'), { exact: true }).click();
      const actions = mobile ? page.getByRole('dialog') : page.getByRole('menu');
      await capture(page, info, 'quick-actions');
      await actions.getByRole(mobile ? 'link' : 'menuitem', { name: messages.skills.plugins.storeTabs.installed, exact: true }).click();
      await expect(page).toHaveURL(/view=installed/);
      await expect(page.getByRole('tab', { name: messages.skills.plugins.storeTabs.installed, exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[role="tabpanel"][data-state="active"] [data-slot="skeleton"]')).toHaveCount(0);
      await capture(page, info, 'installed');
      await expectFit(page);

      await page.getByRole('tab', { name: messages.skills.plugins.storeTabs.advanced, exact: true }).click();
      await expect(page).toHaveURL(/view=advanced/);
      await capture(page, info, 'advanced');
      await page.goBack();
      await expect(page.getByRole('tab', { name: messages.skills.plugins.storeTabs.installed, exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.goForward();
      await expect(page.getByRole('tab', { name: messages.skills.plugins.storeTabs.advanced, exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.reload();
      await expect(page.getByRole('tab', { name: messages.skills.plugins.storeTabs.advanced, exact: true })).toHaveAttribute('aria-selected', 'true');

      await page.getByRole('tab', { name: 'Skills', exact: true }).click();
      await expect(page).toHaveURL(/area=skills/);
      await expect(page.getByRole('tab', { name: messages.skills.skillLibrary.tabs.installed, exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText(messages.skills.loading.pending, { exact: true })).toHaveCount(0);
      await capture(page, info, 'skills');
      await expectFit(page);
      await page.getByRole('tab', { name: messages.skills.skillLibrary.tabs.library, exact: true }).click();
      await expect(page).toHaveURL(/view=library/);
      await capture(page, info, 'skill-library');

      await page.goto(`/${locale}/settings?tab=plugins&view=installed`);
      await expect(page).toHaveURL(new RegExp(`/${locale}/plugins\\?view=installed$`));
      await expect(page.getByRole('tab', { name: messages.skills.plugins.storeTabs.installed, exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.goto(`/${locale}/settings?tab=skills&view=library`);
      await expect(page).toHaveURL(url => url.pathname === `/${locale}/plugins`
        && url.searchParams.get('area') === 'skills' && url.searchParams.get('view') === 'library');
      await expect(page.getByRole('tab', { name: messages.skills.skillLibrary.tabs.library, exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.reload();
      await expect(page.getByRole('tab', { name: messages.skills.skillLibrary.tabs.library, exact: true })).toHaveAttribute('aria-selected', 'true');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}

test('a delayed or failed marketplace keeps installed packages usable and skills lazy', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const skillRequests: string[] = [];
  page.on('request', request => { if (/\/api\/skills(?:\?|\/tree|\/status)/.test(request.url())) skillRequests.push(request.url()); });
  const errors = collectRuntimeErrors(page, ['/api/plugins/store?']);
  try {
    await page.route('**/api/plugins?*', route => route.fulfill({ json: { success: true, plugins: [{
      name: 'qa-personal-connection', description: 'Readiness fixture', version: '1.0.0', enabled: true,
      scopeType: 'user', readiness: 'personal-connection-required', skills: [],
    }] } }));
    await page.route('**/api/plugins/store?*', async route => {
      await pending;
      await route.fulfill({ status: 503, json: { success: false, error: 'QA catalog unavailable' } });
    });
    await page.goto('/en/plugins?view=installed');
    await expect(page.getByText(en.skills.plugins.readiness['personal-connection-required'], { exact: true })).toBeVisible();
    expect(skillRequests).toEqual([]);
    await capture(page, info, 'installed-catalog-pending');
    await page.getByRole('button', { name: en.skills.plugins.preflight.setup, exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capture(page, info, 'setup-detail');
    await page.keyboard.press('Escape');
    release();
    await expect(page.getByText('QA catalog unavailable', { exact: true })).toBeVisible();
    await expect(page.getByText('/qa-personal-connection', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: /^Updates/ }).click();
    await expect(page.getByText('QA catalog unavailable', { exact: true })).toBeVisible();
    await expect(page.getByText(en.skills.plugins.noUpdates, { exact: true })).toHaveCount(0);
    await capture(page, info, 'catalog-error');
    await page.unroute('**/api/plugins/store?*');
    await page.getByRole('button', { name: en.skills.plugins.reload, exact: true }).click();
    await expect(page.getByText('QA catalog unavailable', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { release(); await context.close(); }
});

test('skills expose service failures and retry without false empty/update states', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page, ['/api/skills?', '/api/skills/store?']);
  try {
    await page.route('**/api/skills?*', route => route.fulfill({ status: 503, json: { success: false, error: 'QA skills unavailable' } }));
    await page.goto('/en/plugins?area=skills');
    await expect(page.getByText('QA skills unavailable', { exact: true })).toBeVisible();
    await capture(page, info, 'skills-error');
    await page.unroute('**/api/skills?*');
    await page.getByRole('button', { name: en.skills.loading.retry, exact: true }).click();
    await expect(page.getByText('QA skills unavailable', { exact: true })).toHaveCount(0);
    await page.route('**/api/skills/store?*', route => route.fulfill({ status: 503, json: { success: false, error: 'QA skill catalog unavailable' } }));
    await page.getByRole('tab', { name: /^Updates/ }).click();
    await expect(page.getByText('QA skill catalog unavailable', { exact: true })).toBeVisible();
    await expect(page.getByText(en.skills.skillLibrary.noUpdates, { exact: true })).toHaveCount(0);
    await expect(page.getByText(en.skills.skillLibrary.emptyStore, { exact: true })).toHaveCount(0);
    await capture(page, info, 'skill-catalog-error');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('a member cannot gain organization management through a direct URL', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser, {}, {
    email: process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL, password: process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD,
  });
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  const organizationRequests: string[] = [];
  page.on('request', request => { if (/\/api\/(plugins|skills).*scope=organization/.test(request.url())) organizationRequests.push(request.url()); });
  try {
    const permission = await (await page.request.get('/api/skills')).json();
    expect(permission.canManageOrganizationCapabilities).toBe(false);
    await page.goto('/en/plugins?scope=organization&view=installed');
    await expect(page.getByText(en.skills.scope.organizationDenied, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: en.skills.scope.organization, exact: true })).toHaveCount(0);
    expect(organizationRequests).toEqual([]);
    expect((await page.request.post('/api/plugins/install', {
      headers: { Origin: process.env.BASE_URL! }, data: { scope: 'organization' },
    })).status()).toBe(403);
    await capture(page, info, 'member-scope-boundary');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('admin scope history, workspace switch, Settings shortcut and narrow dark keyboard navigation', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser, { colorScheme: 'dark' });
  await context.addInitScript(() => localStorage.setItem('theme', 'dark'));
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  const organizationRequests: string[] = [];
  page.on('request', request => {
    if (/\/api\/plugins\?scope=organization/.test(request.url())) organizationRequests.push(request.url());
  });
  try {
    expect((await (await page.request.get('/api/skills')).json()).canManageOrganizationCapabilities).toBe(true);
    await stageSharedWorkspace(page);
    await page.goto('/en/plugins?view=installed');
    const search = page.getByPlaceholder(en.skills.plugins.searchPlaceholder, { exact: true });
    await expect(search).toBeVisible();
    const switcher = page.getByTestId('workspace-switcher');
    await expect(switcher).toHaveAttribute('data-active-workspace-id', /\S+/);
    const sharedId = await switcher.getAttribute('data-active-workspace-id');
    const { workspaces } = await (await page.request.get('/api/workspaces')).json();
    const alternate = workspaces.find((workspace: { id: string; status: string; permissions: { canRead: boolean } }) => (
      workspace.id !== sharedId && workspace.status === 'active' && workspace.permissions.canRead
    ));
    expect(alternate?.id).toBeTruthy();
    await switcher.click();
    await page.getByTestId(`workspace-option-${alternate.id}`).click();
    await expect(switcher).toHaveAttribute('data-active-workspace-id', alternate.id);
    await expect(page).toHaveURL(/\/en\/plugins\?view=installed$/);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    await switcher.click();
    await page.getByTestId(`workspace-option-${sharedId}`).click();
    await expect(switcher).toHaveAttribute('data-active-workspace-id', sharedId!);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    await search.fill('qa-scope-reset');
    await page.getByRole('button', { name: en.skills.scope.organization, exact: true }).click();
    await expect(page).toHaveURL(/scope=organization/);
    await expect(page.getByText(en.skills.scope.organizationHint, { exact: true })).toBeVisible();
    await expect(search).toHaveValue('');
    await expect.poll(() => organizationRequests.length).toBeGreaterThan(0);
    await capture(page, info, 'organization-scope');
    await page.goBack();
    await expect(page.getByText(en.skills.scope.personalHint, { exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.getByText(en.skills.scope.organizationHint, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: en.skills.scope.personal, exact: true }).click();

    await page.goto('/en/settings');
    await page.getByRole('navigation', { name: en.settings.navigation.ariaLabel, exact: true })
      .getByRole('button', { name: /^Plugins/ }).click();
    const shortcut = page.getByRole('link', { name: en.home.apps.plugins.open, exact: true });
    await expect(shortcut).toHaveAttribute('href', '/en/plugins');
    await shortcut.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/en\/plugins$/);
    await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: en.skills.plugins.reload, exact: true })).toBeEnabled();

    await page.setViewportSize({ width: 320, height: 760 });
    await expect(page.locator('html')).toHaveClass(/dark/);
    const installed = page.getByRole('tab', { name: en.skills.plugins.storeTabs.installed, exact: true });
    await installed.focus();
    await expect(installed).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/view=installed/);
    await expect(installed).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="tabpanel"][data-state="active"] [data-slot="skeleton"]')).toHaveCount(0);
    await expectFit(page);
    await capture(page, info, 'narrow-dark-installed');
    await page.getByRole('button', { name: en.navigation.openAppLauncher, exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByLabel(en.navigation.openAppActions.replace('{app}', 'Plugins'), { exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capture(page, info, 'narrow-dark-actions');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

// Connection fixtures exercise the real app navigation, dialog, workspace and
// browser popup lifecycle. Provider authentication and package writes are
// intercepted; no external account or secret is changed by these cases.
function connectorFixture(kind: 'email' | 'composio', installed = true, required = true) {
  const name = `qa-${kind}-roundtrip`;
  const connectors = kind === 'email'
    ? { email: [{ kind: 'mailbox', label: 'QA mailbox', required, providers: ['gmail'] }] }
    : { composio: [{ toolkit: 'gmail', label: 'QA Gmail', required }] };
  const plugin = {
    name, resourceId: `user:plugin:${name}`, scopeType: 'user', sourceType: 'standalone',
    description: 'Connection round-trip browser fixture', version: '1.0.0', enabled: true,
    readiness: 'personal-connection-required', connectors, skills: [],
    interface: { displayName: `QA ${kind} round trip`, shortDescription: 'Browser fixture' },
  };
  const entry = {
    name, displayName: plugin.interface.displayName, description: plugin.description,
    category: 'Productivity', latestVersion: '1.1.0', connectors, skills: [],
    installed: {
      installed, enabled: installed, version: installed ? plugin.version : undefined,
      installedPlugin: installed ? plugin : undefined, updateAvailable: installed,
      skills: [], skillSummary: { total: 0, installed: 0, missing: 0, updateAvailable: 0, modified: 0, repairable: 0 },
    },
  };
  return { name, kind, installed, required, plugin, entry };
}

async function mockConnectorFixture(page: Page, fixture: ReturnType<typeof connectorFixture>, outsideVisiblePage = false) {
  let ready = false;
  const readinessByWorkspace = new Map<string, boolean>();
  let installed = fixture.installed;
  let installs = 0;
  const preflightRequests: Array<{ body: Record<string, unknown>; workspace: string | undefined }> = [];
  const listRequests: URL[] = [];
  const readyForWorkspace = (workspaceId: string | undefined) => readinessByWorkspace.get(workspaceId || '') ?? ready;
  const connectionItem = (connected = ready) => ({
    type: fixture.kind, key: fixture.kind === 'email' ? 'QA mailbox' : 'gmail',
    label: fixture.kind === 'email' ? 'QA mailbox' : 'QA Gmail', required: fixture.required, ready: connected,
    available: true, configured: true, connected,
    action: fixture.kind === 'email' ? 'configure-email' : connected ? 'none' : 'connect-composio',
  });
  const readiness = (connected = ready) => ({
    ready: !fixture.required || connected, items: [connectionItem(connected)],
    summary: { total: 1, ready: connected ? 1 : 0, requiredMissing: fixture.required && !connected ? 1 : 0,
      recommendedMissing: !fixture.required && !connected ? 1 : 0 },
  });
  await page.route('**/api/plugins?*', route => {
    listRequests.push(new URL(route.request().url()));
    const connected = readyForWorkspace(route.request().headers()['x-canvas-workspace-id']);
    return route.fulfill({ json: {
      success: true,
      plugins: installed ? [{ ...fixture.plugin,
        readiness: !fixture.required || connected ? 'available' : 'personal-connection-required', connectionReadiness: readiness(connected),
      }] : [],
    } });
  });
  await page.route(`**/api/plugins/${fixture.name}?*`, route => route.fulfill({ json: {
    success: true, plugin: { ...fixture.plugin, connectionReadiness: readiness() },
  } }));
  await page.route('**/api/plugins/store?*', route => {
    const exactName = new URL(route.request().url()).searchParams.get('name');
    return route.fulfill({ json: {
      success: true, registry: { id: 'qa', name: 'QA catalog', updatedAt: '2026-10-02T00:00:00.000Z' },
      plugins: outsideVisiblePage && !exactName ? [] : [{ ...fixture.entry,
        installed: { ...fixture.entry.installed, installed, enabled: installed,
          installedPlugin: installed ? fixture.plugin : undefined, updateAvailable: installed && installs === 0 } }],
      pagination: { page: 1, pageSize: 24, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
      stats: { total: 1, installed: installed ? 1 : 0, available: installed ? 0 : 1,
        updates: installed && installs === 0 ? 1 : 0, filteredTotal: 1 },
    } });
  });
  await page.route('**/api/plugins/store/preflight', route => {
    const workspace = route.request().headers()['x-canvas-workspace-id'];
    const connected = readyForWorkspace(workspace);
    preflightRequests.push({ body: route.request().postDataJSON(), workspace });
    return route.fulfill({ json: { success: true, preflight: {
      pluginName: fixture.name, version: fixture.entry.latestVersion, ...readiness(connected),
      hasRequiredMissing: fixture.required && !connected, hasSkillIssues: false, skills: [], skillSummary: fixture.entry.installed.skillSummary,
    } } });
  });
  await page.route('**/api/plugins/store/install', route => {
    installs += 1;
    installed = true;
    return route.fulfill({ json: { success: true, plugin: fixture.plugin } });
  });
  await page.route('**/api/composio/status', route => {
    const connected = readyForWorkspace(route.request().headers()['x-canvas-workspace-id']);
    return route.fulfill({ json: {
      configured: true, apiKeyValid: true, apiKeyState: 'valid', providerHealthy: true,
      connectedAccounts: connected ? [{ toolkit: { slug: 'gmail' }, status: 'ACTIVE' }] : [],
    } });
  });
  await page.route('**/api/composio/toolkits?*', route => {
    const connected = readyForWorkspace(route.request().headers()['x-canvas-workspace-id']);
    return route.fulfill({ json: {
      toolkits: [{ slug: 'gmail', name: 'QA Gmail', connected, connectedAccountStatus: connected ? 'ACTIVE' : undefined, toolsCount: 1 }],
    } });
  });
  return {
    setReady: (value: boolean) => { ready = value; },
    setReadyForWorkspace: (value: boolean, workspaceId: string) => { readinessByWorkspace.set(workspaceId, value); },
    preflightRequests, listRequests, installs: () => installs,
  };
}

test('installed plugin detail keeps its resource identity through reload and history', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    await stageSharedWorkspace(page);
    const fixture = connectorFixture('email');
    await mockConnectorFixture(page, fixture);
    await page.goto('/en/plugins?view=installed');
    await page.getByRole('heading', { name: fixture.entry.displayName, exact: true }).click();
    await expect(page).toHaveURL(url => url.searchParams.get('plugin') === fixture.name
      && url.searchParams.get('source') === 'installed' && url.searchParams.get('resourceId') === fixture.plugin.resourceId);
    const workspaceId = new URL(page.url()).searchParams.get('workspaceId');
    expect(workspaceId).toBeTruthy();
    await expect(page.getByRole('dialog').getByRole('heading', { name: fixture.entry.displayName, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('dialog').getByRole('heading', { name: fixture.entry.displayName, exact: true })).toBeVisible();
    await expect(page).toHaveURL(url => url.searchParams.get('resourceId') === fixture.plugin.resourceId
      && url.searchParams.get('workspaceId') === workspaceId);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(url => !url.searchParams.has('plugin'));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole('dialog').getByRole('heading', { name: fixture.entry.displayName, exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await capture(page, info, 'detail-history');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('required email Settings returns to the same plugin and refreshes readiness', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    await stageSharedWorkspace(page);
    const fixture = connectorFixture('email');
    const state = await mockConnectorFixture(page, fixture);
    await page.goto('/en/plugins?view=installed');
    await page.getByRole('button', { name: en.skills.plugins.preflight.setup, exact: true }).click();
    const origin = new URL(page.url());
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(en.skills.plugins.preflight.needsSetup, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.update, exact: true })).toBeDisabled();
    const setup = dialog.getByRole('link', { name: en.skills.plugins.connectors.openEmail, exact: true });
    const setupHref = await setup.getAttribute('href');
    expect(setupHref).toBeTruthy();
    const destination = new URL(setupHref!, page.url());
    const returnPath = destination.searchParams.get('returnTo');
    expect(returnPath).toBeTruthy();
    const restored = new URL(returnPath!, page.url());
    for (const key of ['plugin', 'source', 'resourceId', 'workspaceId', 'view']) {
      expect(restored.searchParams.get(key)).toBe(origin.searchParams.get(key));
    }
    await setup.click();
    await expect(page).toHaveURL(url => url.pathname === '/en/settings' && url.searchParams.get('returnTo') === returnPath);
    const back = page.getByRole('link', { name: 'Back to plugin', exact: true });
    await expect(back).toBeVisible();
    state.setReady(true);
    await back.click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: fixture.entry.displayName, exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText(en.skills.plugins.preflight.ready, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(url => url.searchParams.get('workspaceId') === origin.searchParams.get('workspaceId')
      && url.searchParams.get('resourceId') === fixture.plugin.resourceId && url.searchParams.get('view') === 'installed');
    expect(state.installs()).toBe(0);
    await capture(page, info, 'email-settings-return');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('Plugins Settings rejects external return destinations', async ({ browser }) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  try {
    for (const destination of ['https://example.org/plugins', '//example.org/plugins', '/en/settings']) {
      await page.goto(`/en/settings?tab=integrations&returnTo=${encodeURIComponent(destination)}`);
      await expect(page.getByRole('link', { name: 'Back to plugin', exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(url => url.origin === process.env.BASE_URL && url.pathname === '/en/settings');
    }
  } finally { await context.close(); }
});

test('Composio popup blocking retains the plugin and makes no connection request', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  await context.addInitScript(() => { window.open = () => null; });
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  const connects: string[] = [];
  try {
    await stageSharedWorkspace(page);
    const fixture = connectorFixture('composio', false);
    const state = await mockConnectorFixture(page, fixture);
    await page.route('**/api/composio/connect/gmail', route => {
      connects.push(route.request().url());
      return route.fulfill({ json: { noAuth: true } });
    });
    await page.goto('/en/plugins');
    await page.getByRole('heading', { name: fixture.entry.displayName, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: en.skills.plugins.connectors.connect, exact: true }).click();
    await expect(page.getByText(en.skills.plugins.connectors.popupBlocked, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: fixture.entry.displayName, exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true })).toBeDisabled();
    expect(connects).toEqual([]);
    expect(state.installs()).toBe(0);
    await capture(page, info, 'popup-blocked');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('Composio connection refreshes required readiness before enabling installation', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  const requests: Array<{ body: Record<string, unknown>; workspace: string | undefined }> = [];
  try {
    await stageSharedWorkspace(page);
    const fixture = connectorFixture('composio', false);
    const state = await mockConnectorFixture(page, fixture);
    await page.route('**/api/composio/connect/gmail', route => {
      requests.push({ body: route.request().postDataJSON() || {}, workspace: route.request().headers()['x-canvas-workspace-id'] });
      state.setReady(true);
      return route.fulfill({ json: { noAuth: true, redirectUrl: null } });
    });
    await page.goto('/en/plugins');
    await page.getByRole('heading', { name: fixture.entry.displayName, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true })).toBeDisabled();
    const startingUrl = new URL(page.url());
    await dialog.getByRole('button', { name: en.skills.plugins.connectors.connect, exact: true }).click();
    await expect(dialog.getByText(en.skills.plugins.preflight.ready, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true })).toBeEnabled();
    expect(requests).toHaveLength(1);
    expect(requests[0].workspace).toBe(startingUrl.searchParams.get('workspaceId'));
    expect(requests[0].body.returnPath).toBeTruthy();
    const returnUrl = new URL(String(requests[0].body.returnPath), page.url());
    expect(returnUrl.pathname).toMatch(/\/plugins$/);
    expect(returnUrl.searchParams.get('plugin')).toBe(fixture.name);
    expect(returnUrl.searchParams.get('source')).toBe('store');
    expect(returnUrl.searchParams.get('workspaceId')).toBe(startingUrl.searchParams.get('workspaceId'));
    await dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true }).click();
    await expect.poll(() => state.installs()).toBe(1);
    await expect(dialog.getByText(en.skills.plugins.installed, { exact: true }).first()).toBeVisible();
    await capture(page, info, 'required-connection-ready');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('closing an unfinished OAuth popup preserves missing readiness and allows retry', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    await stageSharedWorkspace(page);
    const fixture = connectorFixture('composio', false);
    const state = await mockConnectorFixture(page, fixture);
    await context.route('**/qa-plugins-oauth', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>QA provider</title><p>Authentication fixture</p>',
    }));
    await page.route('**/api/composio/connect/gmail', route => route.fulfill({ json: {
      redirectUrl: `${process.env.BASE_URL}/qa-plugins-oauth`,
    } }));
    await page.goto('/en/plugins');
    await page.getByRole('heading', { name: fixture.entry.displayName, exact: true }).click();
    const dialog = page.getByRole('dialog');
    const popupPromise = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: en.skills.plugins.connectors.connect, exact: true }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/qa-plugins-oauth$/);
    await popup.close();
    await expect(page.getByText('Connection cancelled. You can try again.', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.connectors.connect, exact: true })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true })).toBeDisabled();
    await expect(dialog.getByText(en.skills.plugins.preflight.needsSetup, { exact: true })).toBeVisible();
    expect(state.installs()).toBe(0);
    await capture(page, info, 'oauth-cancelled');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('an optional disconnected connector leaves installation available', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    const fixture = connectorFixture('email', false, false);
    const state = await mockConnectorFixture(page, fixture);
    await page.goto('/en/plugins');
    await page.getByRole('heading', { name: fixture.entry.displayName, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(en.skills.plugins.connectors.notConnected, { exact: true })).toBeVisible();
    await expect(dialog.getByText(en.skills.plugins.preflight.ready, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true }).click();
    await expect.poll(() => state.installs()).toBe(1);
    await expect(dialog.getByText(en.skills.plugins.connectors.notConnected, { exact: true })).toBeVisible();
    await capture(page, info, 'optional-connection-installed');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('a delayed required check prevents installation before its result is known', async ({ browser }) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    const fixture = connectorFixture('email', false);
    const state = await mockConnectorFixture(page, fixture);
    await page.route('**/api/plugins/store/preflight', async route => {
      await pending;
      await route.fulfill({ json: { success: true, preflight: {
        pluginName: fixture.name, version: fixture.entry.latestVersion, ready: true, hasRequiredMissing: false,
        items: [{ type: 'email', key: 'QA mailbox', label: 'QA mailbox', required: true, ready: true,
          configured: true, connected: true, action: 'configure-email' }],
        summary: { total: 1, ready: 1, requiredMissing: 0, recommendedMissing: 0 }, skills: [],
        skillSummary: fixture.entry.installed.skillSummary,
      } } });
    });
    await page.goto('/en/plugins');
    await page.getByRole('heading', { name: fixture.entry.displayName, exact: true }).click();
    const install = page.getByRole('dialog').getByRole('button', { name: en.skills.plugins.addPlugin, exact: true });
    await expect(install).toBeDisabled();
    expect(state.installs()).toBe(0);
    release();
    await expect(install).toBeEnabled();
    expect(state.installs()).toBe(0);
    expect(errors).toEqual([]);
  } finally { release(); await context.close(); }
});

test('OAuth completion from an earlier workspace cannot make the new workspace ready', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    await stageSharedWorkspace(page);
    const fixture = connectorFixture('composio', false);
    const state = await mockConnectorFixture(page, fixture);
    await context.route('**/qa-plugins-oauth', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>QA provider</title><p>Authentication fixture</p>',
    }));
    await page.route('**/api/composio/connect/gmail', route => route.fulfill({ json: {
      redirectUrl: `${process.env.BASE_URL}/qa-plugins-oauth`,
    } }));
    await page.goto('/en/plugins');
    await page.getByRole('heading', { name: fixture.entry.displayName, exact: true }).click();
    const originalWorkspace = new URL(page.url()).searchParams.get('workspaceId');
    expect(originalWorkspace).toBeTruthy();
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('dialog').getByRole('button', { name: en.skills.plugins.connectors.connect, exact: true }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/qa-plugins-oauth$/);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const { workspaces } = await (await page.request.get('/api/workspaces')).json();
    const alternate = workspaces.find((workspace: { id: string; status: string; permissions: { canRead: boolean } }) => (
      workspace.id !== originalWorkspace && workspace.status === 'active' && workspace.permissions.canRead
    ));
    expect(alternate?.id).toBeTruthy();
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId(`workspace-option-${alternate.id}`).click();
    await expect(page.getByTestId('workspace-switcher')).toHaveAttribute('data-active-workspace-id', alternate.id);
    state.setReadyForWorkspace(true, originalWorkspace!);
    await popup.close();
    await page.getByRole('heading', { name: fixture.entry.displayName, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(page).toHaveURL(url => url.searchParams.get('workspaceId') === alternate.id);
    await expect(dialog.getByText(en.skills.plugins.preflight.needsSetup, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true })).toBeDisabled();
    expect(state.preflightRequests.some(request => request.workspace === alternate.id)).toBe(true);
    expect(state.installs()).toBe(0);
    await capture(page, info, 'oauth-workspace-isolation');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('a direct store detail resolves independently of the visible catalog page', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  const exactRequests: URL[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/plugins/store' && url.searchParams.has('name')) exactRequests.push(url);
  });
  try {
    const fixture = connectorFixture('email', false);
    const state = await mockConnectorFixture(page, fixture, true);
    await page.goto(`/en/plugins?view=discover&plugin=${fixture.name}&source=store`);
    await expect(page.getByRole('dialog').getByRole('heading', { name: fixture.entry.displayName, exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText(en.skills.plugins.preflight.needsSetup, { exact: true })).toBeVisible();
    expect(exactRequests.some(url => url.searchParams.get('name') === fixture.name)).toBe(true);
    await page.reload();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: fixture.entry.displayName, exact: true })).toBeVisible();
    state.setReady(true);
    await dialog.getByRole('button', { name: en.skills.plugins.details.refreshCheck, exact: true }).click();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true }).click();
    await expect.poll(() => state.installs()).toBe(1);
    await expect(dialog.getByText(en.skills.plugins.installed, { exact: true }).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.installed, exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true })).toHaveCount(0);
    await page.reload();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.installed, exact: true })).toBeDisabled();
    expect(state.installs()).toBe(1);
    await capture(page, info, 'store-detail-independent-page');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('same-name personal and assigned plugins keep separate ownership and controls', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    await stageSharedWorkspace(page);
    const fixture = connectorFixture('email');
    const state = await mockConnectorFixture(page, fixture);
    const assigned = {
      ...fixture.plugin, resourceId: `organization:plugin:${fixture.name}`, scopeType: 'organization',
      effectivePolicy: 'required', readiness: 'available',
      interface: { ...fixture.plugin.interface, displayName: 'QA assigned mailbox' },
    };
    await page.route('**/api/plugins?*', route => route.fulfill({ json: {
      success: true, plugins: [fixture.plugin, assigned],
    } }));
    await page.goto('/en/plugins?view=installed');
    await page.getByRole('heading', { name: 'QA assigned mailbox', exact: true }).click();
    await expect(page).toHaveURL(url => url.searchParams.get('resourceId') === assigned.resourceId);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', fixture.name), exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.delete, exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: en.skills.plugins.update, exact: true })).toHaveCount(0);
    expect(state.preflightRequests).toEqual([]);
    await page.reload();
    await expect(page).toHaveURL(url => url.searchParams.get('resourceId') === assigned.resourceId);
    await expect(dialog.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', fixture.name), exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: fixture.entry.displayName, exact: true }).click();
    await expect(page).toHaveURL(url => url.searchParams.get('resourceId') === fixture.plugin.resourceId);
    await expect(dialog.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', fixture.name), exact: true })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.delete, exact: true })).toBeVisible();
    await capture(page, info, 'same-name-ownership');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('an expired connection keeps the package installed and blocks its update', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    const fixture = connectorFixture('composio');
    const state = await mockConnectorFixture(page, fixture);
    state.setReady(true);
    await page.goto('/en/plugins?view=installed');
    await page.getByRole('heading', { name: fixture.entry.displayName, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(en.skills.plugins.preflight.ready, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.update, exact: true })).toBeEnabled();
    state.setReady(false);
    await dialog.getByRole('button', { name: en.skills.plugins.details.refreshCheck, exact: true }).click();
    await expect(dialog.getByText(en.skills.plugins.preflight.needsSetup, { exact: true })).toBeVisible();
    await expect(dialog.getByText(en.skills.plugins.connectors.notConnected, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.update, exact: true })).toBeDisabled();
    await expect(dialog.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', fixture.name), exact: true })).toBeVisible();
    expect(state.installs()).toBe(0);
    await capture(page, info, 'expired-connection-installed');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('a denied OAuth callback restores the plugin with a localized cancellation message', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    await stageSharedWorkspace(page);
    const fixture = connectorFixture('composio', false);
    const state = await mockConnectorFixture(page, fixture);
    await page.goto(`/en/plugins?plugin=${fixture.name}&source=store&composioError=cancelled`);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: fixture.entry.displayName, exact: true })).toBeVisible();
    await expect(dialog.getByText('Connection cancelled. You can try again.', { exact: true })).toBeVisible();
    await expect(dialog.getByText(en.skills.plugins.preflight.needsSetup, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true })).toBeDisabled();
    expect(state.installs()).toBe(0);
    await capture(page, info, 'denied-oauth-return');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('assigned MCP setup uses the exact organization resource rather than a same-name personal template', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  const templateRequests: Array<{ body: Record<string, unknown>; workspace: string | undefined }> = [];
  let configurationWrites = 0;
  try {
    await stageSharedWorkspace(page);
    const name = 'qa-same-name-mcp';
    const connectorName = 'qa-assigned-server';
    const personalConnector = { name: connectorName, label: 'QA server', required: true, configPath: 'personal.json' };
    const assignedConnector = { ...personalConnector, configPath: 'organization.json' };
    const connectionReadiness = {
      ready: false,
      items: [{ type: 'mcp', key: connectorName, label: 'QA server', required: true, ready: false,
        configured: false, connected: false, action: 'configure-mcp' }],
      summary: { total: 1, ready: 0, requiredMissing: 1, recommendedMissing: 0 },
    };
    const personal = {
      name, resourceId: `user:plugin:${name}`, scopeType: 'user', sourceType: 'standalone',
      description: 'Personal MCP browser fixture', version: '1.0.0', enabled: true,
      readiness: 'personal-connection-required', effectivePolicy: 'optional', connectionReadiness,
      connectors: { mcp: [personalConnector] }, skills: [], interface: { displayName: 'QA personal MCP' },
    };
    const assigned = {
      ...personal, resourceId: `organization:plugin:${name}`, scopeType: 'organization', effectivePolicy: 'required',
      description: 'Assigned organization MCP browser fixture', connectors: { mcp: [assignedConnector] },
      interface: { displayName: 'QA assigned MCP' },
    };
    await page.route('**/api/plugins?*', route => route.fulfill({ json: { success: true, plugins: [personal, assigned] } }));
    await page.route('**/api/plugins/store?*', route => route.fulfill({ json: {
      success: true, registry: { id: 'qa', name: 'QA catalog', updatedAt: '2026-10-02T00:00:00.000Z' },
      plugins: [{ name, displayName: 'QA catalog MCP', description: 'Same-name catalog browser fixture',
        latestVersion: '1.1.0', skills: [], connectors: personal.connectors,
        installed: { installed: true, enabled: true, updateAvailable: true, installedPlugin: personal } }],
      pagination: { page: 1, pageSize: 12, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
      stats: { total: 1, installed: 1, available: 0, updates: 1, filteredTotal: 1 },
    } }));
    await page.route('**/api/integrations/mcp-config', route => {
      if (route.request().method() !== 'GET') configurationWrites += 1;
      return route.fulfill({ json: { success: true, data: { rawContent: '{"mcpServers":{}}' } } });
    });
    await page.route('**/api/plugins/mcp-template', route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      templateRequests.push({ body, workspace: route.request().headers()['x-canvas-workspace-id'] });
      if (body.scope !== 'organization' || body.resourceId !== assigned.resourceId) {
        return route.fulfill({ status: 404, json: { success: false, error: 'Wrong fixture ownership' } });
      }
      return route.fulfill({ json: { success: true, template: {
        pluginName: name, version: assigned.version, resourceId: assigned.resourceId,
        connector: assignedConnector,
        config: { mcpServers: { [connectorName]: { url: 'https://organization-mcp.example.invalid/mcp' } } },
      } } });
    });
    await page.goto('/en/plugins?view=installed');
    await page.getByRole('heading', { name: assigned.interface.displayName, exact: true }).click();
    await expect(page).toHaveURL(url => url.searchParams.get('resourceId') === assigned.resourceId);
    const workspaceId = new URL(page.url()).searchParams.get('workspaceId');
    expect(workspaceId).toBeTruthy();
    const detail = page.getByRole('dialog');
    await expect(detail.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', name), exact: true })).toBeDisabled();
    await detail.getByRole('button', { name: en.skills.plugins.preflight.setup, exact: true }).click();
    const setup = page.getByRole('dialog', { name: en.settings.mcpConfig.addServer, exact: true });
    await expect(setup.locator('#mcp-url')).toHaveValue('https://organization-mcp.example.invalid/mcp');
    expect(templateRequests).toHaveLength(1);
    expect(templateRequests[0].body).toMatchObject({
      source: 'installed', name, connector: connectorName, resourceId: assigned.resourceId,
      scope: 'organization', workspaceId,
    });
    expect(templateRequests[0].workspace).toBe(workspaceId);
    expect(configurationWrites).toBe(0);
    await capture(page, info, 'assigned-mcp-template-identity');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

for (const marker of ['cancelled', 'failed'] as const) {
  test(`email callback ${marker} returns to the selected plugin with localized feedback`, async ({ browser }, info) => {
    const context = await createAuthenticatedContext(browser);
    const page = await createAcceptancePage(context);
    const errors = collectRuntimeErrors(page);
    try {
      await stageSharedWorkspace(page);
      const fixture = connectorFixture('email');
      const state = await mockConnectorFixture(page, fixture);
      const markers = marker === 'failed' ? ['failed', 'provider private diagnostic should not be shown'] : ['cancelled'];
      for (const returnedMarker of markers) {
        const query = new URLSearchParams({
          view: 'installed', plugin: fixture.name, source: 'installed',
          resourceId: fixture.plugin.resourceId, emailOAuthError: returnedMarker,
        });
        await page.goto(`/en/plugins?${query}`);
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByRole('heading', { name: fixture.entry.displayName, exact: true })).toBeVisible();
        await expect(dialog.getByText(marker === 'cancelled'
          ? en.skills.plugins.connectors.connectionCancelled : en.skills.plugins.connectors.connectionFailed,
        { exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: en.skills.plugins.update, exact: true })).toBeDisabled();
        await expect(dialog.getByText(en.skills.plugins.preflight.needsSetup, { exact: true })).toBeVisible();
        if (returnedMarker !== marker) await expect(page.getByText(returnedMarker, { exact: true })).toHaveCount(0);
        await expect(page).toHaveURL(url => url.searchParams.get('resourceId') === fixture.plugin.resourceId);
      }
      expect(state.installs()).toBe(0);
      await capture(page, info, `email-callback-${marker}`);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}
