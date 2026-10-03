import { expect, test as base, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import appPackage from '../package.json';
import de from '../messages/de.json';
import en from '../messages/en.json';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import type { NotificationSummary } from '../app/components/notifications/notification-summary';
import { ownedCollaborationQaEnabled } from '../scripts/lib/owned-collaboration-qa';
import { waitForOwnedSuiteRequestBudget } from './helpers/owned-suite-request-budget';

let ownedPluginCases = 0;
const test = base.extend<{ ownedPluginBudget: void }>({
  ownedPluginBudget: [async ({ browser }, use, info) => {
    if (ownedCollaborationQaEnabled()) {
      if (info.config.workers !== 1) throw new Error('Owned plugin QA requires one sequential worker.');
      // The measured 12-case sections use 50, 27 and 23 session reads.
      // Keep later sections independent of the preceding IP/path request chain.
      if (ownedPluginCases > 0 && ownedPluginCases % 12 === 0) {
        await waitForOwnedSuiteRequestBudget(browser);
      }
      ownedPluginCases += 1;
    }
    await use();
  }, { auto: true, timeout: 150_000 }],
});

test.beforeAll(async ({ browser }) => {
  if (!ownedCollaborationQaEnabled()) return;
  test.setTimeout(150_000);
  await waitForOwnedSuiteRequestBudget(browser);
});

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

async function openScopeHelp(page: Page, summary: string) {
  const help = page.locator('details').filter({ has: page.getByText(summary, { exact: true }) });
  if (await help.getAttribute('open') === null) await help.locator('summary').click();
  await expect(help).toHaveAttribute('open', '');
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
    const installedCard = page.getByRole('button').filter({
      has: page.getByRole('heading', { name: 'qa-personal-connection', exact: true }),
    });
    await expect(installedCard.getByText(en.skills.plugins.readiness['personal-connection-required'], { exact: true })).toBeVisible();
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
    const alternateInstalled = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/api/plugins'
        && url.searchParams.get('scope') === 'user' && url.searchParams.get('workspaceId') === alternate.id
        && response.request().headers()['x-canvas-workspace-id'] === alternate.id;
    });
    await page.getByTestId(`workspace-option-${alternate.id}`).click();
    await expect(switcher).toHaveAttribute('data-active-workspace-id', alternate.id);
    await expect(page).toHaveURL(/\/en\/plugins\?view=installed$/);
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect((await alternateInstalled).status()).toBe(200);
    await expect(page.getByRole('tab', { name: en.skills.plugins.storeTabs.installed, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="tabpanel"][data-state="active"] [data-slot="skeleton"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: en.skills.plugins.reload, exact: true })).toBeEnabled();
    await switcher.click();
    const sharedInstalled = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/api/plugins'
        && url.searchParams.get('scope') === 'user' && url.searchParams.get('workspaceId') === sharedId
        && response.request().headers()['x-canvas-workspace-id'] === sharedId;
    });
    await page.getByTestId(`workspace-option-${sharedId}`).click();
    await expect(switcher).toHaveAttribute('data-active-workspace-id', sharedId!);
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect((await sharedInstalled).status()).toBe(200);
    await expect(page.getByRole('tab', { name: en.skills.plugins.storeTabs.installed, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="tabpanel"][data-state="active"] [data-slot="skeleton"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: en.skills.plugins.reload, exact: true })).toBeEnabled();
    await search.fill('qa-scope-reset');
    await page.getByRole('button', { name: en.skills.scope.organization, exact: true }).click();
    await expect(page).toHaveURL(/scope=organization/);
    await openScopeHelp(page, en.skills.scope.helpSummary);
    await expect(page.getByText(en.skills.scope.organizationHint, { exact: true })).toBeVisible();
    await expect(search).toHaveValue('');
    await expect.poll(() => organizationRequests.length).toBeGreaterThan(0);
    await capture(page, info, 'organization-scope');
    await page.goBack();
    await openScopeHelp(page, en.skills.scope.helpSummary);
    await expect(page.getByText(en.skills.scope.personalHint, { exact: true })).toBeVisible();
    await page.goForward();
    await openScopeHelp(page, en.skills.scope.helpSummary);
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
    const personalScope = page.getByRole('button', { name: en.skills.scope.personal, exact: true });
    const organizationScope = page.getByRole('button', { name: en.skills.scope.organization, exact: true });
    await expect(personalScope).toHaveAttribute('aria-pressed', 'true');
    await expect(organizationScope).toHaveAttribute('aria-pressed', 'false');
    await organizationScope.focus();
    await page.keyboard.press('Enter');
    await expect(organizationScope).toHaveAttribute('aria-pressed', 'true');
    await expect(personalScope).toHaveAttribute('aria-pressed', 'false');
    await personalScope.focus();
    await page.keyboard.press('Enter');
    await expect(personalScope).toHaveAttribute('aria-pressed', 'true');
    for (const name of [en.skills.plugins.filters.category, en.skills.plugins.filters.connection]) {
      const control = page.getByRole('combobox', { name, exact: true });
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      expect(box!.width).toBeGreaterThanOrEqual(110);
      expect(box!.height).toBeGreaterThanOrEqual(32);
      expect(await control.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
    }
    const scopeHelp = page.locator('details').filter({ has: page.getByText(en.skills.scope.helpSummary, { exact: true }) });
    await expect(scopeHelp).not.toHaveAttribute('open');
    await scopeHelp.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(scopeHelp).toHaveAttribute('open', '');
    await expect(scopeHelp.getByText(en.skills.scope.description, { exact: true })).toBeVisible();
    await expect(scopeHelp.getByText(en.skills.scope.personalHint, { exact: true })).toBeVisible();
    await expectFit(page);
    await page.keyboard.press('Space');
    await expect(scopeHelp).not.toHaveAttribute('open');
    await expect(scopeHelp.getByText(en.skills.scope.personalHint, { exact: true })).toBeHidden();
    const aboutPlugins = page.locator('details').filter({ has: page.getByText(en.skills.plugins.aboutSummary, { exact: true }) });
    await aboutPlugins.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(aboutPlugins.getByText(en.skills.plugins.description, { exact: true })).toBeVisible();
    await expectFit(page);
    await page.keyboard.press('Enter');
    await expect(aboutPlugins).not.toHaveAttribute('open');
    await capture(page, info, 'narrow-dark-filters');
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
    // Hold only the decoded status body: the HTTP response has already arrived
    // and the poll's pre-JSON workspace guard has already been evaluated.
    await page.evaluate(workspaceId => {
      const originalFetch = window.fetch.bind(window);
      let armed = true;
      let held = false;
      let release!: () => void;
      const pendingBody = new Promise<void>(resolve => { release = resolve; });
      window.addEventListener('qa-release-composio-body', () => { armed = false; release(); }, { once: true });
      window.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        const requestHeaders = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        if (url.pathname === '/api/composio/status' && requestHeaders.get('X-Canvas-Workspace-Id') === workspaceId) {
          const readBody = response.json.bind(response);
          response.json = async () => {
            const body = await readBody();
            if (!armed || held) return body;
            held = true;
            document.documentElement.dataset.qaComposioBody = 'waiting';
            await pendingBody;
            document.documentElement.dataset.qaComposioBody = 'released';
            // The obsolete poll's synchronous post-JSON workspace guard runs
            // in its await continuation before the next browser timer task.
            window.setTimeout(() => { document.documentElement.dataset.qaComposioBodySettled = 'true'; }, 0);
            return { ...body, connectedAccounts: [{ toolkit: { slug: 'gmail' }, status: 'ACTIVE' }] };
          };
        }
        return response;
      };
    }, originalWorkspace!);
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('dialog').getByRole('button', { name: en.skills.plugins.connectors.connect, exact: true }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/qa-plugins-oauth$/);
    await expect(page.locator('html')).toHaveAttribute('data-qa-composio-body', 'waiting');
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
    const originalPreflightCount = state.preflightRequests.filter(request => request.workspace === originalWorkspace).length;
    await page.evaluate(() => window.dispatchEvent(new Event('qa-release-composio-body')));
    await expect(page.locator('html')).toHaveAttribute('data-qa-composio-body', 'released');
    await expect(page.locator('html')).toHaveAttribute('data-qa-composio-body-settled', 'true');
    expect(state.preflightRequests.filter(request => request.workspace === originalWorkspace)).toHaveLength(originalPreflightCount);
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

test('a same-name organization namespace hides personal activation until the organization package is removed', async ({ browser }, info) => {
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
    // The real registry/GET regression tests cover projection. This browser
    // boundary reflects the effective response, including a stored personal
    // package that becomes visible only when the organization record is removed.
    let organizationPresent = true;
    await page.route('**/api/plugins?*', route => {
      const plugins = [organizationPresent ? assigned : fixture.plugin];
      return route.fulfill({ json: { success: true, plugins,
        stats: { total: 1, enabled: plugins.filter(plugin => plugin.enabled).length, disabled: plugins.filter(plugin => !plugin.enabled).length },
      } });
    });
    await page.goto('/en/plugins?view=installed');
    await expect(page.getByRole('heading', { name: fixture.entry.displayName, exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'QA assigned mailbox', exact: true })).toHaveCount(1);
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
    assigned.enabled = false;
    assigned.effectivePolicy = 'blocked';
    assigned.readiness = 'blocked';
    await page.reload();
    await expect(dialog.getByText(en.skills.plugins.permissions.blocked, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', fixture.name), exact: true })).toBeDisabled();
    await expect(dialog.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', fixture.name), exact: true })).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: fixture.entry.displayName, exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'QA assigned mailbox', exact: true })).toHaveCount(1);
    expect(state.installs()).toBe(0);
    organizationPresent = false;
    await page.getByRole('button', { name: en.skills.plugins.reload, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'QA assigned mailbox', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: fixture.entry.displayName, exact: true })).toHaveCount(1);
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
    await page.route('**/api/plugins?*', route => route.fulfill({ json: { success: true, plugins: [assigned], stats: { total: 1, enabled: 1, disabled: 0 } } }));
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

async function mockFilteredCatalog(page: Page) {
  const installed = [
    { name: 'qa-ready-active', displayName: 'QA ready active', readiness: 'available', enabled: true },
    { name: 'qa-required-active', displayName: 'QA required active', readiness: 'personal-connection-required', enabled: true },
    { name: 'qa-required-disabled', displayName: 'QA required disabled', readiness: 'personal-connection-required', enabled: false },
    { name: 'qa-ready-disabled', displayName: 'QA ready disabled', readiness: 'disabled', enabled: false },
    ...Array.from({ length: 12 }, (_, index) => ({
      name: `qa-installed-filler-${index}`, displayName: `QA installed filler ${index}`, readiness: 'available', enabled: true,
    })),
  ].map(plugin => ({
    ...plugin, resourceId: `user:plugin:${plugin.name}`, scopeType: 'user', version: '1.0.0',
    description: 'Installed filtering browser fixture', interface: { displayName: plugin.displayName }, skills: [],
  }));
  // Keep the update target beyond the first installed catalog page. Its card can
  // only get update metadata from the independent installedPlugins response.
  const metadata = [...installed.slice(4), ...installed.slice(0, 4)].map(plugin => ({
    name: plugin.name, displayName: plugin.displayName, description: plugin.description,
    latestVersion: plugin.name === 'qa-ready-active' ? '1.1.0' : '1.0.0', skills: [],
    installed: { installed: true, enabled: plugin.enabled, version: plugin.version, installedPlugin: plugin,
      updateAvailable: plugin.name === 'qa-ready-active', skills: [],
      skillSummary: { total: 0, installed: 0, missing: 0, updateAvailable: 0, modified: 0, repairable: 0 } },
  }));
  const catalog = Array.from({ length: 96 }, (_, index) => ({
    name: `qa-mail-${index}`, displayName: `QA Mail ${index}`, description: 'Global catalog filtering browser fixture',
    category: index % 2 === 0 ? 'Productivity' : 'Design', latestVersion: '1.0.0', skills: [],
    connectors: index % 3 === 0 ? { email: [{ label: 'Mailbox', recommended: true }] }
      : index % 3 === 1 ? { mcp: [{ name: 'qa-mcp', recommended: true }] }
        : { composio: [{ toolkit: 'gmail', recommended: true }] },
    installed: { installed: false, enabled: false, updateAvailable: false },
  }));
  const storeRequests: URL[] = [];
  const storePages: Array<{ state: string | null; page: number; names: string[] }> = [];
  const installedRequests: URL[] = [];
  let unavailable = false;
  await page.route('**/api/plugins?*', route => {
    installedRequests.push(new URL(route.request().url()));
    return route.fulfill({ json: { success: true, plugins: installed } });
  });
  await page.route('**/api/plugins/store?*', route => {
    const url = new URL(route.request().url());
    storeRequests.push(url);
    if (unavailable) return route.fulfill({ status: 503, json: { success: false, error: 'QA filtered catalog unavailable' } });
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    const category = url.searchParams.get('category');
    const connection = url.searchParams.get('connection');
    const exactName = url.searchParams.get('name');
    const state = url.searchParams.get('state');
    const candidates = exactName ? metadata.filter(plugin => plugin.name === exactName)
      : state === 'updates' ? metadata.filter(plugin => plugin.installed.updateAvailable)
        : state === 'installed' ? metadata : [...catalog, ...metadata];
    const filtered = candidates.filter(plugin => {
      if (!`${plugin.name} ${plugin.displayName} ${plugin.description}`.toLowerCase().includes(query)) return false;
      if (category && (!('category' in plugin) || plugin.category !== category)) return false;
      const type = !('connectors' in plugin) ? 'none'
        : 'email' in plugin.connectors ? 'email' : 'mcp' in plugin.connectors ? 'mcp' : 'composio';
      if (connection && connection !== type) return false;
      return true;
    });
    const pageSize = Number(url.searchParams.get('pageSize') || 12);
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const currentPage = Math.min(Math.max(1, Number(url.searchParams.get('page') || 1)), totalPages);
    const pagePlugins = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    storePages.push({ state, page: currentPage, names: pagePlugins.map(plugin => plugin.name) });
    return route.fulfill({ json: {
      success: true, registry: { id: 'qa', name: 'QA catalog', updatedAt: '2026-10-02T00:00:00.000Z' },
      plugins: pagePlugins, installedPlugins: metadata,
      facets: { categories: ['Design', 'Productivity'], connectionTypes: ['composio', 'email', 'mcp', 'none'] },
      pagination: { page: currentPage, pageSize, totalItems: filtered.length, totalPages,
        hasNextPage: currentPage < totalPages, hasPreviousPage: currentPage > 1 },
      stats: { total: catalog.length + metadata.length, installed: installed.length, available: catalog.length, updates: 1, filteredTotal: filtered.length },
    } });
  });
  return { installed, metadata, storeRequests, storePages, installedRequests, setUnavailable: (value: boolean) => { unavailable = value; } };
}

test('combined catalog filters restore query and page through Back and reload without rechecking installed connections', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    const state = await mockFilteredCatalog(page);
    await page.goto('/en/plugins?q=QA%20Mail&category=Productivity&connection=email&page=2');
    const search = page.getByPlaceholder(en.skills.plugins.searchPlaceholder, { exact: true });
    const category = page.getByRole('combobox', { name: en.skills.plugins.filters.category, exact: true });
    const connection = page.getByRole('combobox', { name: en.skills.plugins.filters.connection, exact: true });
    await expect(search).toHaveValue('QA Mail');
    await expect(category).toHaveValue('Productivity');
    await expect(connection).toHaveValue('email');
    await expect(page.getByRole('heading', { name: 'QA Mail 72', exact: true })).toBeVisible();
    await expect(page.getByText('Page 2 of 2 · 16 plugins', { exact: true })).toBeVisible();
    const switcher = page.getByTestId('workspace-switcher');
    await expect(switcher).toHaveAttribute('data-active-workspace-id', /\S+/);
    const activeWorkspaceId = await switcher.getAttribute('data-active-workspace-id');
    await expect.poll(() => state.installedRequests.some(url =>
      url.searchParams.get('workspaceId') === activeWorkspaceId && url.searchParams.get('fresh') === '1')).toBe(true);
    const installedRequestCount = state.installedRequests.length;
    const freshRequestCount = state.installedRequests.filter(url => url.searchParams.get('fresh') === '1').length;
    await category.selectOption('Design');
    await expect(page).toHaveURL(url => url.searchParams.get('category') === 'Design'
      && (!url.searchParams.has('page') || url.searchParams.get('page') === '1'));
    await expect(page.getByRole('heading', { name: 'QA Mail 3', exact: true })).toBeVisible();
    await page.goBack();
    await expect(category).toHaveValue('Productivity');
    await expect(page.getByRole('heading', { name: 'QA Mail 72', exact: true })).toBeVisible();
    await expect(page).toHaveURL(url => url.searchParams.get('page') === '2' && url.searchParams.get('connection') === 'email');
    await page.getByRole('button', { name: en.skills.plugins.pagination.previous, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'QA Mail 0', exact: true })).toBeVisible();
    await page.getByRole('button', { name: en.skills.plugins.pagination.next, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'QA Mail 72', exact: true })).toBeVisible();
    await connection.selectOption('mcp');
    await expect(page).toHaveURL(url => url.searchParams.get('connection') === 'mcp'
      && (!url.searchParams.has('page') || url.searchParams.get('page') === '1'));
    await expect(page.getByRole('heading', { name: 'QA Mail 4', exact: true })).toBeVisible();
    await page.goBack();
    await expect(connection).toHaveValue('email');
    await expect(page.getByRole('heading', { name: 'QA Mail 72', exact: true })).toBeVisible();
    await search.fill('QA Mail 90');
    await expect(page).toHaveURL(url => url.searchParams.get('q') === 'QA Mail 90'
      && (!url.searchParams.has('page') || url.searchParams.get('page') === '1'));
    await expect(page.getByText('Page 1 of 1 · 1 plugins', { exact: true })).toBeVisible();
    expect(state.installedRequests).toHaveLength(installedRequestCount);
    expect(state.installedRequests.filter(url => url.searchParams.get('fresh') === '1')).toHaveLength(freshRequestCount);
    await page.reload();
    await expect(search).toHaveValue('QA Mail 90');
    await expect(category).toHaveValue('Productivity');
    await expect(connection).toHaveValue('email');
    await expect(page.getByRole('heading', { name: 'QA Mail 90', exact: true })).toBeVisible();
    expect(state.storeRequests.some(url => url.searchParams.get('q') === 'QA Mail'
      && url.searchParams.get('category') === 'Productivity' && url.searchParams.get('connection') === 'email'
      && url.searchParams.get('page') === '2')).toBe(true);
    await page.goto('/en/plugins?q=QA%20Mail&category=Productivity&connection=email&page=99');
    await expect(page.getByText('Page 2 of 2 · 16 plugins', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'QA Mail 72', exact: true })).toBeVisible();
    expect(state.storeRequests.some(url => url.searchParams.get('page') === '99')).toBe(true);
    const previousRequests = state.storeRequests.filter(url => url.searchParams.get('page') === '1').length;
    await page.getByRole('button', { name: en.skills.plugins.pagination.previous, exact: true }).click();
    await expect(page).toHaveURL(url => !url.searchParams.has('page') || url.searchParams.get('page') === '1');
    await expect(page.getByText('Page 1 of 2 · 16 plugins', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'QA Mail 0', exact: true })).toBeVisible();
    expect(state.storeRequests.filter(url => url.searchParams.get('page') === '1').length).toBeGreaterThan(previousRequests);
    expect(state.storeRequests.some(url => url.searchParams.get('page') === '98')).toBe(false);
    await capture(page, info, 'combined-catalog-filters');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('installed readiness and activation filters intersect and off-page update metadata stays visible', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    const state = await mockFilteredCatalog(page);
    await page.goto('/en/plugins?view=installed');
    const readyCard = page.getByRole('heading', { name: 'QA ready active', exact: true }).locator('xpath=ancestor::*[@role="button"][1]');
    await expect(readyCard.getByText(en.skills.plugins.updateAvailable, { exact: true })).toBeVisible();
    await expect(readyCard.getByRole('button', { name: en.skills.plugins.update, exact: true })).toBeVisible();
    expect(state.storePages.some(response => response.state === 'installed' && response.page === 1
      && !response.names.includes('qa-ready-active'))).toBe(true);
    const readiness = page.getByRole('combobox', { name: en.skills.plugins.filters.readiness, exact: true });
    const enabled = page.getByRole('combobox', { name: en.skills.plugins.filters.enabled, exact: true });
    await readiness.selectOption('personal-connection-required');
    await enabled.selectOption('disabled');
    await expect(page).toHaveURL(url => url.searchParams.get('readiness') === 'personal-connection-required'
      && url.searchParams.get('enabled') === 'disabled');
    await expect(page.getByRole('heading', { name: 'QA required disabled', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'QA required active', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'QA ready active', exact: true })).toHaveCount(0);
    await page.goBack();
    await expect(readiness).toHaveValue('personal-connection-required');
    await expect(page.getByRole('heading', { name: 'QA required active', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'QA required disabled', exact: true })).toBeVisible();
    await page.goForward();
    await page.reload();
    await expect(enabled).toHaveValue('disabled');
    await expect(readiness).toHaveValue('personal-connection-required');
    await expect(page.getByRole('heading', { name: 'QA required disabled', exact: true })).toBeVisible();
    expect(state.metadata.find(plugin => plugin.name === 'qa-ready-active')?.installed.updateAvailable).toBe(true);
    await capture(page, info, 'installed-filter-intersection');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('an unavailable filtered catalog keeps installed packages and filter navigation usable', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page, ['/api/plugins/store?']);
  try {
    const state = await mockFilteredCatalog(page);
    state.setUnavailable(true);
    await page.goto('/en/plugins?view=installed');
    await expect(page.getByText('QA filtered catalog unavailable', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'QA ready active', exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', 'qa-ready-active'), exact: true })).toBeEnabled();
    const search = page.getByPlaceholder(en.skills.plugins.searchPlaceholder, { exact: true });
    await search.fill('QA required');
    await expect(page.getByRole('heading', { name: 'QA ready active', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'QA required active', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: en.skills.plugins.filters.enabled, exact: true }).selectOption('disabled');
    await expect(page.getByRole('heading', { name: 'QA required disabled', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'QA required active', exact: true })).toHaveCount(0);
    state.setUnavailable(false);
    await page.getByRole('button', { name: en.skills.plugins.reload, exact: true }).click();
    await expect(page.getByText('QA filtered catalog unavailable', { exact: true })).toHaveCount(0);
    await capture(page, info, 'filtered-catalog-unavailable');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

// Real member permissions and workspace access remain unmocked. Package data,
// preference writes and image bytes are deterministic browser boundaries.
async function mockOwnershipCatalog(page: Page, sameName = true) {
  const personalName = sameName ? 'qa-shared-owner' : 'qa-personal-owner';
  const personal = {
    name: personalName, resourceId: `user:plugin:${personalName}`, scopeType: 'user', sourceType: 'standalone',
    version: '1.0.0', description: 'QA personal package description', enabled: true, readiness: 'available',
    installedBy: 'qa-personal-installer@example.invalid', skills: [],
    interface: { displayName: 'QA personal package', icon: 'assets/personal.svg' },
  };
  const optional = {
    ...personal, name: 'qa-shared-owner', resourceId: 'organization:plugin:qa-shared-owner', scopeType: 'organization', effectivePolicy: 'optional',
    description: 'QA organization package description', installedBy: 'qa-organization-installer@example.invalid',
    interface: { displayName: 'QA optional organization package', icon: 'assets/organization.svg' },
  };
  const required = {
    name: 'qa-required-owner', resourceId: 'organization:plugin:qa-required-owner', scopeType: 'organization',
    sourceType: 'standalone', version: '1.0.0', description: 'QA legacy installation without installer metadata',
    enabled: true, readiness: 'available', effectivePolicy: 'required', skills: [],
    interface: { displayName: 'QA required organization package' },
  };
  const blocked = {
    ...required, name: 'qa-blocked-owner', resourceId: 'organization:plugin:qa-blocked-owner',
    description: 'QA organization package blocked by policy', enabled: false, readiness: 'blocked', effectivePolicy: 'blocked',
    interface: { displayName: 'QA blocked organization package' },
  };
  const installed = [...(sameName ? [] : [personal]), optional, required, blocked];
  const catalog = [
    { name: personal.name, displayName: 'QA same-name catalog package', description: 'QA catalog package description',
      latestVersion: '1.1.0', skills: [], interface: { icon: 'assets/catalog.svg' },
      installed: { installed: true, enabled: personal.enabled, version: personal.version, updateAvailable: true, installedPlugin: personal } },
    ...[required, blocked].map(plugin => ({ name: plugin.name, displayName: plugin.interface.displayName,
      description: plugin.description, latestVersion: '1.0.0', skills: [],
      installed: { installed: false, enabled: false, updateAvailable: false } })),
    { name: 'qa-member-available', displayName: 'QA member available package', description: 'QA uninstalled package',
      latestVersion: '1.0.0', skills: [], installed: { installed: false, enabled: false, updateAvailable: false } },
  ];
  const packageWrites: Array<{ path: string; method: string }> = [];
  const preferences: Array<{ resourceId: string; enabled: boolean }> = [];
  const icons: URL[] = [];
  await page.route('**/api/plugins/**', route => {
    const request = route.request();
    if (request.method() === 'GET') return route.continue();
    packageWrites.push({ path: new URL(request.url()).pathname, method: request.method() });
    return route.fulfill({ status: 403, json: { success: false, error: 'QA package mutation must stay disabled for members' } });
  });
  await page.route('**/api/plugins?*', route => route.fulfill({ json: { success: true, plugins: installed,
    stats: { total: installed.length, enabled: installed.filter(plugin => plugin.enabled).length, disabled: installed.filter(plugin => !plugin.enabled).length },
  } }));
  await page.route('**/api/plugins/store?*', route => {
    const url = new URL(route.request().url());
    const exactName = url.searchParams.get('name');
    const state = url.searchParams.get('state');
    const entries = exactName ? catalog.filter(plugin => plugin.name === exactName)
      : state === 'installed' ? catalog.filter(plugin => plugin.installed.installed)
        : state === 'updates' ? catalog.filter(plugin => plugin.installed.updateAvailable) : catalog;
    return route.fulfill({ json: {
      success: true, registry: { id: 'qa', name: 'QA catalog', updatedAt: '2026-10-02T00:00:00.000Z' },
      plugins: entries, installedPlugins: catalog.filter(plugin => plugin.installed.installed),
      facets: { categories: [], connectionTypes: ['none'] },
      pagination: { page: 1, pageSize: 12, totalItems: entries.length, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
      stats: { total: catalog.length, installed: 1, available: catalog.length - 1, updates: 1, filteredTotal: entries.length },
    } });
  });
  await page.route('**/api/plugins/store/preflight', route => {
    const body = route.request().postDataJSON() as { name: string; version: string };
    return route.fulfill({ json: { success: true, preflight: {
      pluginName: body.name, version: body.version, ready: true, items: [],
      summary: { total: 0, ready: 0, requiredMissing: 0, recommendedMissing: 0 },
      skills: [], skillSummary: { total: 0, installed: 0, missing: 0, updateAvailable: 0, modified: 0, repairable: 0 },
    } } });
  });
  await page.route('**/api/skills/preferences', route => {
    const body = route.request().postDataJSON() as { resourceId: string; enabled: boolean };
    preferences.push(body);
    const plugin = installed.find(candidate => candidate.resourceId === body.resourceId);
    if (route.request().method() !== 'PUT' || plugin !== optional) {
      return route.fulfill({ status: 403, json: { success: false, error: 'QA only the optional organization preference may change' } });
    }
    plugin.enabled = body.enabled;
    plugin.readiness = body.enabled ? 'available' : 'disabled';
    return route.fulfill({ json: { success: true, resourceId: body.resourceId, preference: { ...body, revision: preferences.length } } });
  });
  await page.route('**/api/plugins/asset?*', route => {
    icons.push(new URL(route.request().url()));
    return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#2463eb"/></svg>' });
  });
  return { personal, optional, required, blocked, packageWrites, preferences, icons };
}

test('a genuine member sees package actions read-only with administrator guidance and sends no package writes', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser, {}, {
    email: process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL, password: process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD,
  });
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    expect((await (await page.request.get('/api/skills')).json()).canManageOrganizationCapabilities).toBe(false);
    await stageSharedWorkspace(page);
    const state = await mockOwnershipCatalog(page, false);
    await page.goto('/en/plugins?view=installed');
    const card = page.getByRole('button').filter({ has: page.getByRole('heading', { name: state.personal.interface.displayName, exact: true }) });
    await expect(card.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', state.personal.name), exact: true })).toBeDisabled();
    await expect(card.getByRole('button', { name: en.skills.plugins.update, exact: true })).toBeDisabled();
    await expect(card.getByRole('button', { name: en.skills.plugins.delete, exact: true })).toBeDisabled();
    await expect(card.getByText(en.skills.plugins.permissions.askAdmin, { exact: true })).toBeVisible();
    await card.getByRole('heading', { name: state.personal.interface.displayName, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', state.personal.name), exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.update, exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.delete, exact: true })).toBeDisabled();
    await expect(dialog.getByText(en.skills.plugins.permissions.askAdmin, { exact: true })).toBeVisible();
    await expect(dialog.getByText(state.personal.installedBy, { exact: true })).toBeVisible();
    await capture(page, info, 'member-package-readonly');
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: en.skills.plugins.storeTabs.discover, exact: true }).click();
    const available = page.getByRole('button').filter({ has: page.getByRole('heading', { name: 'QA member available package', exact: true }) });
    await expect(available.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true })).toBeDisabled();
    await available.getByRole('heading', { name: 'QA member available package', exact: true }).click();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.addPlugin, exact: true })).toBeDisabled();
    await expect(dialog.getByText(en.skills.plugins.permissions.askAdmin, { exact: true })).toBeVisible();
    expect(state.packageWrites).toEqual([]);
    expect(state.preferences).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

for (const locale of ['de', 'en'] as const) {
  test(`${locale} mobile density keeps the first real catalog card and primary action within the initial viewport`, async ({ browser }, info) => {
    const messages = locale === 'de' ? de : en;
    const context = await createAuthenticatedContext(browser, {
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    });
    const page = await createAcceptancePage(context);
    const errors = collectRuntimeErrors(page);
    try {
      await stageSharedWorkspace(page);
      await page.goto(`/${locale}/plugins`);
      await expect(page.getByRole('tab', { name: messages.skills.plugins.storeTabs.discover, exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('button', { name: messages.skills.scope.personal, exact: true })).toHaveAttribute('aria-pressed', 'true');
      const scopeHelp = page.locator('details').filter({ has: page.getByText(messages.skills.scope.helpSummary, { exact: true }) });
      const aboutPlugins = page.locator('details').filter({ has: page.getByText(messages.skills.plugins.aboutSummary, { exact: true }) });
      await expect(scopeHelp).not.toHaveAttribute('open');
      await expect(aboutPlugins).not.toHaveAttribute('open');
      await expect(page.getByRole('combobox', { name: messages.skills.plugins.filters.category, exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: messages.skills.plugins.filters.connection, exact: true })).toBeVisible();
      // This intentionally selects the first rendered real catalog card. Do not
      // scroll it into view before measuring the initial mobile layout.
      const card = page.locator('div[role="button"]:visible').filter({ has: page.locator('h3') }).first();
      await expect(card).toBeVisible();
      await expect(page.locator('[role="tabpanel"][data-state="active"] [data-slot="skeleton"]')).toHaveCount(0);
      await page.waitForLoadState('networkidle');
      const primaryAction = card.locator('button');
      await expect(primaryAction).toHaveCount(1);
      const cardBox = await card.boundingBox();
      const actionBox = await primaryAction.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(actionBox).not.toBeNull();
      const measurement = {
        locale, viewport: { width: 390, height: 844 },
        card: await card.getByRole('heading', { level: 3 }).innerText(),
        cardTop: cardBox!.y, cardHeight: cardBox!.height,
        primaryAction: await primaryAction.innerText(), primaryActionBottom: actionBox!.y + actionBox!.height,
      };
      info.annotations.push({ type: 'mobile-density', description: JSON.stringify(measurement) });
      await info.attach('mobile-density.json', { body: JSON.stringify(measurement, null, 2), contentType: 'application/json' });
      console.info(`[plugins-mobile-density] ${JSON.stringify(measurement)}`);
      await capture(page, info, `mobile-density-${locale}`);
      expect(measurement.cardTop).toBeGreaterThanOrEqual(0);
      expect(measurement.cardTop).toBeLessThanOrEqual(600);
      expect(measurement.primaryActionBottom).toBeLessThanOrEqual(844);
      await expectFit(page);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}

test('assigned optional activation writes its exact preference while required and blocked policies stay locked', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser, {}, {
    email: process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL, password: process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD,
  });
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    expect((await (await page.request.get('/api/skills')).json()).canManageOrganizationCapabilities).toBe(false);
    await stageSharedWorkspace(page);
    const state = await mockOwnershipCatalog(page);
    await page.goto('/en/plugins?view=installed');
    const optionalCard = page.getByRole('button').filter({ has: page.getByRole('heading', { name: state.optional.interface.displayName, exact: true }) });
    await expect(page.getByRole('heading', { name: state.personal.interface.displayName, exact: true })).toHaveCount(0);
    await expect(optionalCard.getByText(en.skills.plugins.permissions.personalActivation, { exact: true })).toBeVisible();
    await optionalCard.getByRole('heading', { name: state.optional.interface.displayName, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(page).toHaveURL(url => url.searchParams.get('resourceId') === state.optional.resourceId);
    const toggle = dialog.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', state.optional.name), exact: true });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toBeChecked();
    await expect(dialog.getByText(en.skills.plugins.permissions.personalActivation, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: en.skills.plugins.update, exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: en.skills.plugins.delete, exact: true })).toHaveCount(0);
    await toggle.click();
    await expect.poll(() => state.preferences).toEqual([{ resourceId: state.optional.resourceId, enabled: false }]);
    await expect(toggle).not.toBeChecked();
    await capture(page, info, 'assigned-personal-activation');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: state.personal.interface.displayName, exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: state.optional.interface.displayName, exact: true })).toHaveCount(1);
    for (const [plugin, guidance] of [[state.required, en.skills.plugins.permissions.required], [state.blocked, en.skills.plugins.permissions.blocked]] as const) {
      const card = page.getByRole('button').filter({ has: page.getByRole('heading', { name: plugin.interface.displayName, exact: true }) });
      await expect(card.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', plugin.name), exact: true })).toBeDisabled();
      await expect(card.getByText(guidance, { exact: true })).toBeVisible();
      await card.getByRole('heading', { name: plugin.interface.displayName, exact: true }).click();
      await expect(dialog.getByRole('switch', { name: en.skills.plugins.toggle.replace('{name}', plugin.name), exact: true })).toBeDisabled();
      await expect(dialog.getByText(guidance, { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: en.skills.plugins.update, exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: en.skills.plugins.delete, exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
    expect(state.preferences).toEqual([{ resourceId: state.optional.resourceId, enabled: false }]);
    expect(state.packageWrites).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('organization details retain the installed identity, installer and workspace while icons use the exact resource scope', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser, {}, {
    email: process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL, password: process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD,
  });
  const page = await createAcceptancePage(context);
  const errors = collectRuntimeErrors(page);
  try {
    expect((await (await page.request.get('/api/skills')).json()).canManageOrganizationCapabilities).toBe(false);
    await stageSharedWorkspace(page);
    const state = await mockOwnershipCatalog(page);
    await page.goto('/en/plugins?view=installed');
    const switcher = page.getByTestId('workspace-switcher');
    await expect(switcher).toHaveAttribute('data-active-workspace-id', /\S+/);
    const workspaceId = await switcher.getAttribute('data-active-workspace-id');
    await page.getByRole('heading', { name: state.optional.interface.displayName, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: state.optional.interface.displayName, exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'QA same-name catalog package', exact: true })).toHaveCount(0);
    await expect(dialog.getByText(state.optional.description, { exact: true })).toBeVisible();
    const owner = dialog.getByText(en.skills.plugins.details.ownership, { exact: true }).locator('..');
    await expect(owner.getByText(en.skills.plugins.organizationScope, { exact: true })).toBeVisible();
    await expect(dialog.getByText(en.skills.plugins.details.installedBy, { exact: true })).toBeVisible();
    await expect(dialog.getByText(state.optional.installedBy, { exact: true })).toBeVisible();
    await expect(dialog.getByText(state.personal.installedBy, { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(en.skills.plugins.connectors.activeWorkspace.replace('{name}', 'Shared Test Workspace'), { exact: true })).toBeVisible();
    await expect(dialog.getByText(workspaceId!, { exact: true })).toHaveCount(0);
    const organizationIcon = dialog.locator('img[src*="organization.svg"]');
    await expect(organizationIcon).toHaveAttribute('src', /scope=organization/);
    const iconUrl = new URL((await organizationIcon.getAttribute('src'))!, process.env.BASE_URL!);
    expect(iconUrl.searchParams.get('resourceId')).toBe(state.optional.resourceId);
    expect(iconUrl.searchParams.get('workspaceId')).toBe(workspaceId);
    await expect.poll(() => state.icons.some(url => url.searchParams.get('path') === 'assets/organization.svg'
      && url.searchParams.get('resourceId') === state.optional.resourceId && url.searchParams.get('scope') === 'organization'
      && url.searchParams.get('workspaceId') === workspaceId)).toBe(true);
    expect(state.icons.filter(url => url.searchParams.get('path') === 'assets/organization.svg')
      .every(url => url.searchParams.get('scope') === 'organization' && url.searchParams.get('resourceId') === state.optional.resourceId)).toBe(true);
    await page.reload();
    await expect(dialog.getByRole('heading', { name: state.optional.interface.displayName, exact: true })).toBeVisible();
    await expect(page).toHaveURL(url => url.searchParams.get('resourceId') === state.optional.resourceId
      && url.searchParams.get('workspaceId') === workspaceId);
    await expect(dialog.getByText(state.optional.installedBy, { exact: true })).toBeVisible();
    await capture(page, info, 'organization-ownership-metadata');
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: state.required.interface.displayName, exact: true }).click();
    await expect(dialog.getByText(en.skills.plugins.details.installedByUnknown, { exact: true })).toBeVisible();
    await expect(dialog.getByText(state.optional.installedBy, { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: state.personal.interface.displayName, exact: true })).toHaveCount(0);
    expect(state.packageWrites).toEqual([]);
    expect(state.preferences).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
