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
    // Keep known anonymous-page diagnostics observable separately from the
    // authenticated Plugins flow, without suppressing any Plugins API error.
    if (anonymousActivity && /^Failed to load resource:.*status of 401/.test(message.text())
      && ['/api/instance/human-activity', '/api/public/brand/logo'].some(apiPath => resourceUrl === `${process.env.BASE_URL}${apiPath}`)) {
      if (!anonymousIssuesReported.has(resourceUrl)) test.info().annotations.push({
        type: 'known-login-diagnostic', description: `${new URL(resourceUrl).pathname} returns 401 before login; see browser acceptance report`,
      });
      anonymousIssuesReported.add(resourceUrl);
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
