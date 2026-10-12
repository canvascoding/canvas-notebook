import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Dialog, type Locator, type Page, type Response } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import type { IntegrationConnectionScopeChoice } from '../app/lib/integration-tools/connections/contracts';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';
import de from '../messages/de.json';

type Locale = 'en' | 'de';
const messages = { en, de };
const nonce = randomBytes(5).toString('hex');
const mutationRequests: string[] = [];
let context: BrowserContext, workspaceId = '', artifacts = '';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

async function data<T>(response: APIResponse | Response, phase: string): Promise<T> {
  if (response.status() !== 200) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  const value = await response.json() as { success?: boolean; data?: T };
  if (value.success !== true || value.data === undefined) throw new Error(`${phase} returned an invalid public envelope.`);
  return value.data;
}
function href(locale: Locale) {
  return `/${locale}/plugins?${new URLSearchParams({ workspaceId, view: 'installed', scope: 'organization' })}`;
}
async function readyShared(page: Page, locale: Locale) {
  const root = page.getByTestId('plugin-workspace'), section = page.getByTestId('shared-connections');
  await expect(root.getByRole('heading', { name: messages[locale].skills.workspace.shell.advanced, exact: true })).toBeVisible();
  await expect(root.locator(':scope > header').getByRole('button', { name: messages[locale].skills.workspace.shell.refresh, exact: true })).toBeEnabled();
  await expect(section.getByText(messages[locale].sharedConnections.loading, { exact: true })).toHaveCount(0);
  await expect(section.getByTestId('shared-connection-create')).toBeEnabled();
  await expect(root.getByTestId('plugin-workspace-scope-organization')).toHaveAttribute('aria-pressed', 'true');
}
async function advanced(page: Page, locale: Locale, width: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(href(locale), { waitUntil: 'domcontentloaded' });
  await page.evaluate(value => localStorage.setItem('theme', value), theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const root = page.getByTestId('plugin-workspace');
  await expect(root.getByTestId('plugin-workspace-lists')).toBeVisible();
  await expect(root.locator(':scope > header').getByRole('button', { name: messages[locale].skills.workspace.shell.refresh, exact: true })).toBeEnabled();
  const setup = page.waitForResponse(response => new URL(response.url()).pathname === '/api/integrations/shared-connections/setup' && response.request().method() === 'GET');
  await root.getByRole('button', { name: messages[locale].skills.workspace.shell.advanced, exact: true }).click();
  const choices = await data<{ scopes: IntegrationConnectionScopeChoice[] }>(await setup, 'Actual authorized shared connection setup');
  expect(choices.scopes.some(scope => scope.ownership.type === 'organization')).toBe(true);
  await readyShared(page, locale);
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/u);
  else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/u);
}
async function openCreate(page: Page, locale: Locale) {
  await page.getByTestId('shared-connections').getByTestId('shared-connection-create').click();
  const dialog = page.getByTestId('shared-connection-create-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: messages[locale].sharedConnections.createTitle, exact: true })).toBeVisible();
  await expect(dialog.getByTestId('shared-connection-create-form').locator('#shared-source')).toHaveValue('mcp');
  return dialog;
}
async function screenshot(page: Page, dialog: Locator, inputs: readonly string[], name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const box = await dialog.boundingBox(); expect(box).not.toBeNull();
  const viewport = page.viewportSize()!; expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  for (const selector of inputs) {
    const input = dialog.locator(selector); await input.scrollIntoViewIfNeeded(); await expect(input).toBeVisible();
    const bounds = await input.boundingBox(); expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  }
  const focused = dialog.locator(inputs[0]); await focused.focus(); await expect(focused).toBeFocused();
  const file = path.join(artifacts, `${name}.png`); await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
}

test.beforeAll(async ({ browser }) => {
  context = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } });
  await runManagedTestPreflight(context, { baseURL: process.env.BASE_URL });
  const session = await (await requestManagedTestSession(context.request)).json() as { user?: { id?: string; role?: string } };
  if (!session.user?.id || session.user.role !== 'admin') throw new Error('The existing authenticated bootstrap administrator is required.');
  const response = await context.request.get('/api/workspaces'); if (!response.ok()) throw new Error('Current actor workspaces are unavailable.');
  const workspaces = await response.json() as { workspaces: ClientWorkspaceSummary[] };
  const personal = workspaces.workspaces.find(value => value.status === 'active' && value.type === 'personal' && value.ownerUserId === session.user!.id);
  if (!personal) throw new Error('The existing actor has no active personal browsing workspace.'); workspaceId = personal.id;
  await context.addInitScript(value => {
    localStorage.setItem('canvas.activeWorkspaceId', value);
    Reflect.set(window, '__connectionFormHistoryEvents', 0);
    window.addEventListener('popstate', () => Reflect.set(window, '__connectionFormHistoryEvents', Number(Reflect.get(window, '__connectionFormHistoryEvents')) + 1), true);
  }, workspaceId);
  context.on('request', request => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
    const route = new URL(request.url()).pathname;
    if (/^\/api\/(?:composio|mcp|integrations|workspaces)(?:\/|$)/u.test(route)) mutationRequests.push(`${request.method()} ${route}`);
  });
  artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-connection-form-browser-')); await fs.chmod(artifacts, 0o700);
});
test.afterEach(() => { expect(mutationRequests, 'Connection, profile, Secrets and workspace writes must remain absent.').toEqual([]); });
test.afterAll(async () => { if (context) await context.close(); });

for (const locale of ['en', 'de'] as const) {
  test(`${locale} shared connection unsaved fields survive cancelled close/history and clear after accepted discard`, async () => {
    const page = await context.newPage();
    const labels = messages[locale], layouts = locale === 'en' ? [[1280, 'light'], [390, 'dark']] as const : [[390, 'light'], [1280, 'dark']] as const;
    const confirmations: Array<{ type: string; message: string }> = []; let decision: 'accept' | 'dismiss' = 'dismiss';
    const handler = async (dialog: Dialog) => { confirmations.push({ type: dialog.type(), message: dialog.message() }); await dialog[decision](); };
    page.on('dialog', handler);
    try {
      for (const [width, theme] of layouts) {
        await advanced(page, locale, width, theme); const advancedHref = page.url();
        let dialog = await openCreate(page, locale), form = dialog.getByTestId('shared-connection-create-form');
        const name = `Connection form QA ${nonce}`, endpoint = `https://example.invalid/${nonce}`;
        await form.locator('#shared-name').fill(name); await form.locator('#shared-url').fill(endpoint);
        await expect(form.getByRole('button', { name: labels.sharedConnections.create, exact: true })).toBeEnabled();
        await screenshot(page, dialog, ['#shared-url', '#shared-name'], `${locale}-${width}-${theme}-mcp-unsaved`);
        let count = confirmations.length;
        await page.keyboard.press('Escape'); await expect.poll(() => confirmations.length).toBe(++count);
        await expect(dialog).toBeVisible(); await expect(form.locator('#shared-name')).toHaveValue(name); await expect(form.locator('#shared-url')).toHaveValue(endpoint);
        await dialog.locator('[data-slot="dialog-close"]').click(); await expect.poll(() => confirmations.length).toBe(++count);
        await expect(dialog).toBeVisible(); await expect(form.locator('#shared-url')).toHaveValue(endpoint);
        const before = await page.evaluate(() => Number(Reflect.get(window, '__connectionFormHistoryEvents')));
        await page.goBack({ waitUntil: 'domcontentloaded' }); await expect.poll(() => confirmations.length).toBe(++count);
        await expect.poll(() => page.evaluate(() => Number(Reflect.get(window, '__connectionFormHistoryEvents')))).toBeGreaterThanOrEqual(before + 2);
        await expect(page).toHaveURL(advancedHref); await expect(dialog).toBeVisible(); await expect(form.locator('#shared-name')).toHaveValue(name); await expect(form.locator('#shared-url')).toHaveValue(endpoint);
        decision = 'accept'; await dialog.locator('[data-slot="dialog-close"]').click(); await expect.poll(() => confirmations.length).toBe(++count); await expect(dialog).toHaveCount(0);
        decision = 'dismiss'; dialog = await openCreate(page, locale); form = dialog.getByTestId('shared-connection-create-form');
        await expect(form.locator('#shared-name')).toHaveValue(''); await expect(form.locator('#shared-url')).toHaveValue(''); await expect(form.locator('#shared-token')).toHaveValue('');
        await dialog.locator('[data-slot="dialog-close"]').click(); await expect(dialog).toHaveCount(0); expect(confirmations.length).toBe(count);
        await page.getByTestId('plugin-workspace-scope-user').click(); await expect(page.getByTestId('plugin-workspace-scope-user')).toHaveAttribute('aria-pressed', 'true'); expect(confirmations.length).toBe(count);
        const header = page.locator('header').filter({ has: page.getByRole('button', { name: labels.common.openNavigationMenu, exact: true }) });
        await header.getByRole('button', { name: labels.common.back, exact: true }).click(); await expect(page).toHaveURL(advancedHref); await readyShared(page, locale); expect(confirmations.length).toBe(count);

        dialog = await openCreate(page, locale); form = dialog.getByTestId('shared-connection-create-form');
        const profiles = page.waitForResponse(response => new URL(response.url()).pathname === '/api/composio/shared-profiles' && response.request().method() === 'GET');
        await form.locator('#shared-source').selectOption('composio'); await data<{ profiles: unknown[] }>(await profiles, 'Actual scope-bound shared profile directory');
        await expect(form.locator('#shared-profile')).toBeEnabled();
        await form.getByText(labels.sharedConnections.newProfile, { exact: true }).click();
        const profileName = `Profile form QA ${nonce}`, app = `qa_${nonce}`;
        await form.locator('#shared-profile-name').fill(profileName); await form.locator('#shared-app').fill(app);
        await expect(form.getByRole('button', { name: labels.sharedConnections.createProfile, exact: true })).toBeEnabled();
        await expect(form.getByRole('button', { name: labels.sharedConnections.create, exact: true })).toBeDisabled();
        await screenshot(page, dialog, ['#shared-profile-name', '#shared-app'], `${locale}-${width}-${theme}-composio-unsaved`);
        await page.keyboard.press('Escape'); await expect.poll(() => confirmations.length).toBe(++count); await expect(dialog).toBeVisible();
        await expect(form.locator('#shared-profile-name')).toHaveValue(profileName); await expect(form.locator('#shared-app')).toHaveValue(app);
        decision = 'accept'; await page.keyboard.press('Escape'); await expect.poll(() => confirmations.length).toBe(++count); await expect(dialog).toHaveCount(0); decision = 'dismiss';
        await page.getByTestId('plugin-workspace-scope-user').click(); await expect(page.getByTestId('plugin-workspace-scope-user')).toHaveAttribute('aria-pressed', 'true'); expect(confirmations.length).toBe(count);
        expect(confirmations.every(value => value.type === 'confirm' && value.message === labels.skills.drafts.unsavedNavigation)).toBe(true);
      }
    } finally { page.off('dialog', handler); await page.close(); }
  });
}
