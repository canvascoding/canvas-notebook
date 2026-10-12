import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Page, type Response } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import type { CapabilityPackagePresentation } from '../app/lib/capabilities/packages/presentation-contracts';
import type { CapabilityPackageStoreSelection } from '../app/lib/capabilities/packages/store-contracts';
import type { PluginWorkspaceCatalogResponse } from '../app/lib/plugins/plugin-workspace-catalog-contracts';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';
import de from '../messages/de.json';

type Locale = 'en' | 'de';
type Fixture = { nonce: string; name: string; sources: CapabilityPackageStoreSelection[] };
const artifacts = '/tmp/canvas-plugin-ui-6ac2-browser';
const ownedNonce = '3454322acc';
const unreadableRef = 'canvas-resource:00000000-0000-4000-8000-000000000000';
let context: BrowserContext, workspaceId = '', fixture: Fixture;
const messages = { en, de };
const scopedMutations: string[] = [];

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

async function data<T>(response: APIResponse | Response, phase: string): Promise<T> {
  if (response.status() !== 200) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  const envelope = await response.json() as { success: boolean; data?: T };
  if (envelope.success !== true || envelope.data === undefined) throw new Error(`${phase} returned an invalid public envelope.`);
  return envelope.data;
}
function href(locale: Locale, selection: Record<string, string>) {
  return `/${locale}/plugins?${new URLSearchParams({ view: 'installed', scope: 'user', workspaceId, ...selection })}`;
}
function waitForApi(page: Page, pathname: string, query: Record<string, string> = {}, method = 'GET') {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === pathname && response.request().method() === method
      && url.searchParams.get('workspaceId') === workspaceId && Object.entries(query).every(([key, value]) => url.searchParams.get(key) === value);
  });
}
async function readyList(page: Page, locale: Locale) {
  const root = page.getByTestId('plugin-workspace');
  await expect(root.getByRole('heading', { name: messages[locale].skills.workspace.shell.title, exact: true })).toBeVisible();
  await expect(root.getByTestId('plugin-workspace-lists')).toBeVisible();
  await expect(root.getByRole('status').filter({ hasText: messages[locale].skills.workspace.shell.loading })).toHaveCount(0);
  await expect(root.locator('.animate-pulse')).toHaveCount(0);
  const selection = new URL(page.url()).searchParams;
  if (selection.get('scope') === 'team' && !selection.get('teamId')) {
    await expect(root.getByRole('status').filter({ hasText: messages[locale].skills.workspace.lists.selectionRequired })).toBeVisible();
  }
}
async function scopedCatalog(page: Page, action: () => Promise<unknown>, query: Record<string, string>): Promise<PluginWorkspaceCatalogResponse> {
  const response = waitForApi(page, '/api/plugins/catalog', query);
  await action(); return data<PluginWorkspaceCatalogResponse>(await response, 'Current scoped catalog');
}
async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function captureLists(page: Page, locale: Locale, view: 'installed' | 'store', scope: 'all' | 'user') {
  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']] as const) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(value => localStorage.setItem('theme', value), theme);
    const response = waitForApi(page, '/api/plugins/catalog', { scope });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const catalog = await data<PluginWorkspaceCatalogResponse>(await response, 'Reloaded current list scope');
    expect(catalog.selection.scope).toBe(scope); await readyList(page, locale);
    await expect(page.getByTestId(`plugin-workspace-view-${view}`)).toHaveAttribute('data-state', 'active');
    if (scope === 'all') await expect(page.getByRole('combobox', { name: messages[locale].skills.workspace.shell.moreScopes, exact: true })).toHaveValue('all');
    else await expect(page.getByTestId('plugin-workspace-scope-user')).toHaveAttribute('aria-pressed', 'true');
    if (view === 'installed') {
      expect(catalog.items.length, 'Installed row visuals require an actual readable package.').toBeGreaterThan(0);
      await expect(page.getByTestId('plugin-workspace-resources')).toBeVisible();
    } else await expect(page.getByTestId('plugin-workspace-offering').getByRole('button', { name: messages[locale].skills.workspace.lists.openOffering.replace('{name}', fixture.name), exact: true })).toBeVisible();
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/u);
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/u);
    await assertNoOverflow(page);
    await page.screenshot({ path: path.join(artifacts, `${locale}-${view}-list-${width}-${theme}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
  }
}
async function capturePreview(page: Page, locale: Locale) {
  const labels = messages[locale].skills.workspace.storeWizard;
  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => localStorage.setItem('theme', value), theme);
    const response = waitForApi(page, '/api/capabilities/packages/store/preview', {}, 'POST');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const preview = (await data<{ presentation: CapabilityPackagePresentation }>(await response, 'Reloaded exact Store preview')).presentation;
    expect(preview.name).toBe(fixture.name);
    const wizard = page.getByTestId('store-package-wizard');
    await expect(wizard).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByTestId('plugin-workspace').locator(':scope > header').getByRole('button', {
      name: messages[locale].skills.workspace.shell.refresh, exact: true,
    })).toBeEnabled();
    await expect(wizard.getByRole('heading', { name: preview.title, exact: true })).toBeVisible();
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/u);
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/u);
    await wizard.getByText(labels.packageDetails, { exact: true }).click();
    await expect(wizard.getByTestId('store-wizard-package-details')).toHaveAttribute('open', '');
    const child = preview.children.find(value => value.name === `${fixture.name}-context`);
    if (!child) throw new Error('The owned preview is missing its declared child skill.');
    await expect(wizard.getByTestId('store-wizard-package-details').getByText(child.title, { exact: true })).toBeVisible();
    const target = wizard.getByTestId('store-wizard-target');
    await expect(target).toHaveValue('user');
    const confirm = wizard.getByRole('button', { name: labels.confirmTarget, exact: true });
    await confirm.scrollIntoViewIfNeeded(); await expect(confirm).toBeVisible(); await expect(confirm).toBeEnabled();
    await assertNoOverflow(page);
    const box = await confirm.boundingBox(); expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: path.join(artifacts, `${locale}-store-preview-${width}-${theme}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
  }
}
async function openOffering(page: Page, locale: Locale) {
  await readyList(page, locale);
  const labels = messages[locale].skills.workspace;
  const offer = page.getByTestId('plugin-workspace-offering').getByRole('button', { name: labels.lists.openOffering.replace('{name}', fixture.name), exact: true });
  await expect(offer).toBeVisible();
  const response = waitForApi(page, '/api/capabilities/packages/store/preview', {}, 'POST');
  await offer.click();
  const selected = (await data<{ presentation: CapabilityPackagePresentation }>(await response, 'Visible Store offering preview')).presentation;
  expect(selected.name).toBe(fixture.name); expect(selected.origin).toBe('store'); expect(selected.sourceStampCurrent).toBe(true);
  expect(selected.children.some(child => child.name === `${fixture.name}-context`)).toBe(true);
  const exact = fixture.sources.find(source => source.version === selected.version);
  if (!exact || !selected.source) throw new Error('The preview did not match the owned configured offering.');
  expect(selected.source.kind).toBe(exact.kind); expect(selected.source.registryId).toBe(exact.registryId);
  expect(selected.source.entryKey).toBe(exact.entryKey); expect(selected.source.checksum).toBe(exact.checksum);
  const url = new URL(page.url());
  expect(url.searchParams.get('storeVersion')).toBe(exact.version); expect(url.searchParams.get('storeChecksum')).toBe(exact.checksum);
  await expect(page.getByTestId('store-package-wizard')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByTestId('store-wizard-target')).toHaveValue('user');
}

test.beforeAll(async ({ browser }) => {
  const file = process.env.CAPABILITY_STORE_E2E_FIXTURE;
  if (!file || !path.isAbsolute(file)) throw new Error('An owned private Store fixture is required.');
  const privateFixture = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture;
  if (privateFixture.nonce !== ownedNonce || privateFixture.name !== `package-editor-qa-${ownedNonce}` || !Array.isArray(privateFixture.sources)) {
    throw new Error('The configured Store fixture is not the owned read-only acceptance fixture.');
  }
  // Only the public selection fields enter browser setup; private fixture/configuration fields never enter output.
  fixture = { nonce: privateFixture.nonce, name: privateFixture.name, sources: privateFixture.sources.map(value => ({
    kind: value.kind, registryId: value.registryId, entryKey: value.entryKey, version: value.version, checksum: value.checksum })) };
  context = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } });
  await runManagedTestPreflight(context, { baseURL: process.env.BASE_URL });
  const session = await (await requestManagedTestSession(context.request)).json() as { user?: { id?: string } };
  if (!session.user?.id) throw new Error('An authenticated existing test actor is required.');
  const response = await context.request.get('/api/workspaces');
  if (!response.ok()) throw new Error(`Read-only workspace selection returned HTTP ${response.status()}.`);
  const workspaces = await response.json() as { workspaces: ClientWorkspaceSummary[] };
  const personal = workspaces.workspaces.find(value => value.type === 'personal' && value.status === 'active' && value.ownerUserId === session.user!.id);
  if (!personal) throw new Error('The existing actor has no active personal browsing workspace.');
  workspaceId = personal.id;
  await context.addInitScript(value => { localStorage.setItem('canvas.activeWorkspaceId', value); }, workspaceId);
  context.on('request', request => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
    const route = new URL(request.url()).pathname;
    const protectedDomain = /^\/api\/(?:capabilities\/|plugins(?:\/|$)|skills(?:\/|$)|composio(?:\/|$)|integrations(?:\/|$)|workspaces(?:\/|$))/u.test(route);
    const permittedRead = request.method() === 'POST' && (route === '/api/capabilities/packages/store/preview' || route === '/api/capabilities/packages/store/install-options');
    if (protectedDomain && !permittedRead) scopedMutations.push(`${request.method()} ${route}`);
  });
  await fs.mkdir(artifacts, { recursive: true });
});
test.afterEach(() => { expect(scopedMutations, 'The browser performs only read operations in package/connection/workspace domains.').toEqual([]); });
test.afterAll(async () => { if (context) await context.close(); });

test('English ownership navigation, exact visible Store preview and read-only target wizard', async () => {
  const page = await context.newPage(); const labels = en.skills.workspace;
  try {
    let catalog = await scopedCatalog(page, () => page.goto(href('en', {}), { waitUntil: 'domcontentloaded' }), { scope: 'user', audience: 'own' });
    expect(catalog.selection.scope).toBe('user'); expect(catalog.selection.audience).toBe('own'); await readyList(page, 'en');
    catalog = await scopedCatalog(page, () => page.getByRole('button', { name: labels.shell.audience_shared, exact: true }).click(), { scope: 'user', audience: 'shared' });
    expect(catalog.selection.audience).toBe('shared'); await readyList(page, 'en');
    catalog = await scopedCatalog(page, () => page.getByTestId('plugin-workspace-scope-organization').click(), { scope: 'organization' });
    expect(catalog.selection.scope).toBe('organization'); await readyList(page, 'en');
    const teamChoices = catalog.scopes.teams;
    await scopedCatalog(page, () => catalog.scopes.choices.includes('team') ? page.getByTestId('plugin-workspace-scope-team').click()
      : page.goto(href('en', { scope: 'team' }), { waitUntil: 'domcontentloaded' }), { scope: 'team' });
    await readyList(page, 'en'); await expect(page.getByText(labels.lists.selectionRequired, { exact: true })).toBeVisible();
    await expect(page.getByTestId('plugin-workspace-resource')).toHaveCount(0);
    const teamPicker = page.getByTestId('plugin-workspace-team-picker'); await expect(teamPicker).toBeVisible();
    if (teamChoices.length) {
      await teamPicker.click();
      const popup = page.locator('[data-slot="popover-content"][data-state="open"]');
      await popup.getByRole('combobox', { name: labels.shell.searchTeams, exact: true }).fill(teamChoices[0].label);
      const selected = await scopedCatalog(page, () => popup.getByTestId(`plugin-workspace-team-picker-option-${teamChoices[0].teamId}`).click(), { scope: 'team', teamId: teamChoices[0].teamId });
      expect(selected.selection.teamId).toBe(teamChoices[0].teamId); await readyList(page, 'en');
    } else { await teamPicker.click(); await expect(page.getByText(labels.shell.noTeams, { exact: true })).toBeVisible(); await page.keyboard.press('Escape'); }
    await scopedCatalog(page, () => page.getByTestId('plugin-workspace-scope-user').click(), { scope: 'user', audience: 'own' }); await readyList(page, 'en');
    await scopedCatalog(page, () => page.getByRole('combobox', { name: labels.shell.moreScopes, exact: true }).selectOption('all'), { scope: 'all' });
    await captureLists(page, 'en', 'installed', 'all');
    await scopedCatalog(page, () => page.getByTestId('plugin-workspace-scope-user').click(), { scope: 'user', audience: 'own' }); await readyList(page, 'en');
    const search = page.getByRole('searchbox', { name: labels.shell.search, exact: true }); await search.fill(fixture.name);
    await scopedCatalog(page, () => search.press('Enter'), { scope: 'user', audience: 'own', q: fixture.name }); await readyList(page, 'en');
    const updates = waitForApi(page, '/api/capabilities/packages/store', { scope: 'user', installedState: 'updates' });
    await page.getByTestId('plugin-workspace-view-updates').click(); await data<unknown>(await updates, 'Current scoped update metadata'); await readyList(page, 'en');
    const drafts = waitForApi(page, '/api/capabilities/packages/drafts'); await page.getByTestId('plugin-workspace-view-drafts').click(); await data<unknown>(await drafts, 'Creator-private draft metadata');
    await expect(page.getByTestId('package-drafts-section')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: labels.shell.advanced, exact: true }).click();
    await expect(page.getByRole('heading', { name: labels.shell.advanced, exact: true })).toBeVisible(); await expect(page.getByText(labels.shell.connectionHint, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: labels.shell.manageMcp, exact: true })).toHaveAttribute('href', /\/settings\?tab=mcp$/u);
    await expect(page.getByRole('link', { name: labels.shell.manageIntegrations, exact: true })).toHaveAttribute('href', /\/settings\?tab=integrations$/u);
    await page.getByRole('button', { name: labels.shell.back, exact: true }).click(); await readyList(page, 'en');
    await page.goto(href('en', { view: 'discover', kind: 'plugin', q: fixture.name }), { waitUntil: 'domcontentloaded' }); await openOffering(page, 'en');
    await page.goBack({ waitUntil: 'domcontentloaded' }); await readyList(page, 'en'); await expect(page.getByTestId('store-package-wizard')).toHaveCount(0);
    await openOffering(page, 'en'); await capturePreview(page, 'en');
    const wizard = page.getByTestId('store-package-wizard');
    const options = waitForApi(page, '/api/capabilities/packages/store/install-options', {}, 'POST');
    await wizard.getByRole('button', { name: labels.storeWizard.confirmTarget, exact: true }).click(); await data<unknown>(await options, 'Read-only target authority and directory');
    await expect(page.getByTestId('store-wizard-sharing')).toBeVisible(); await expect(page.getByTestId('store-wizard-responsible')).toBeVisible();
    await expect(page.getByText(labels.storeWizard.disabledRestricted, { exact: true })).toBeVisible();
    await expect(page.getByTestId('store-wizard-grant')).toHaveCount(0);
    await wizard.getByRole('button', { name: labels.storeWizard.back, exact: true }).click(); await expect(page.getByTestId('store-wizard-target')).toHaveValue('user');
    await wizard.getByRole('button', { name: labels.storeWizard.cancel, exact: true }).click(); await readyList(page, 'en');
  } finally { await page.close(); }
});

test('German exact Store preview is stable at desktop/mobile light and dark without installing', async () => {
  const page = await context.newPage();
  try {
    await page.goto(href('de', { view: 'discover', kind: 'plugin', q: fixture.name }), { waitUntil: 'domcontentloaded' });
    await readyList(page, 'de'); await captureLists(page, 'de', 'store', 'user');
    await openOffering(page, 'de'); await capturePreview(page, 'de');
    await page.getByTestId('store-package-wizard').getByRole('button', { name: de.skills.workspace.storeWizard.cancel, exact: true }).click(); await readyList(page, 'de');
  } finally { await page.close(); }
});

test('missing team and unreadable exact resource deep links stay closed and never fall back to personal content', async () => {
  const page = await context.newPage();
  try {
    const catalog = await scopedCatalog(page, () => page.goto(href('en', { scope: 'team' }), { waitUntil: 'domcontentloaded' }), { scope: 'team' });
    expect(catalog.selection.scope).toBe('team'); expect(catalog.selection.teamId).toBeNull(); expect(catalog.selection.selectionRequired).toBe('team');
    expect(catalog.items).toEqual([]); await readyList(page, 'en');
    await expect(page.getByText(en.skills.workspace.lists.selectionRequired, { exact: true })).toBeVisible();
    await expect(page.getByTestId('plugin-workspace-scope-team')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('plugin-workspace-resource')).toHaveCount(0); await assertNoOverflow(page);
    await page.screenshot({ path: path.join(artifacts, 'missing-team-read-only.png'), fullPage: true, animations: 'disabled' });
    const response = await context.request.get(`/api/capabilities/resources/${encodeURIComponent(unreadableRef)}?workspaceId=${encodeURIComponent(workspaceId)}`);
    expect(response.status()).toBe(404);
    await page.goto(href('de', { resourceRef: unreadableRef, task: 'overview' }), { waitUntil: 'domcontentloaded' });
    const detail = page.getByTestId('package-detail-workspace');
    await expect(detail.getByText(de.skills.workspace.detail.accessError, { exact: true })).toBeVisible();
    await expect(detail.getByRole('status')).toHaveCount(0); await expect(page.getByTestId('package-detail-tab-content')).toHaveCount(0);
    await expect(page.getByTestId('store-package-wizard')).toHaveCount(0); await expect(detail.getByText(fixture.name, { exact: true })).toHaveCount(0);
    await assertNoOverflow(page); await page.screenshot({ path: path.join(artifacts, 'unreadable-exact-resource-read-only.png'), fullPage: true, animations: 'disabled' });
    await page.getByTestId('package-detail-back').click(); await readyList(page, 'de');
  } finally { await page.close(); }
});
