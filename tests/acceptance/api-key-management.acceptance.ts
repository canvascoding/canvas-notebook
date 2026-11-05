import { test, expect, request as apiRequest, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { authenticateManagedTestPage } from '../helpers/managed-test-context';

const origin = 'http://127.0.0.1:3100', base = '/api/api-access/integrations';
const configuredWorkspaceName = process.env.CANVAS_ACCEPTANCE_WORKSPACE_NAME;
if (process.env.CANVAS_COMPILED_API_BROWSER_RUN !== '1' || process.env.E2E_EXTERNAL_SERVER !== '1'
  || process.env.BASE_URL !== origin || !configuredWorkspaceName) throw new Error('Use the guarded compiled API-key browser runner.');
const workspaceName = configuredWorkspaceName;
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

type Integration = { id: string; revision: number; creationRequestId: string };
type Credential = { id: string; revokedAt: number | null };

async function openSettings(context: BrowserContext, width = 1280) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await authenticateManagedTestPage(page);
  const reviewAvailability = await page.request.get('/api/document-review/availability');
  expect(reviewAvailability.status()).toBe(200);
  expect((await reviewAvailability.json()).data.documentReviewEnabled).toBe(false);
  const workspaces = await page.request.get('/api/workspaces'); expect(workspaces.status()).toBe(200);
  const shared = (await workspaces.json()).workspaces.find((workspace: { name: string }) => workspace.name === workspaceName);
  expect(Boolean(shared?.permissions.canWrite)).toBe(true);
  await page.goto('/en/settings?tab=api-access', { waitUntil: 'domcontentloaded' });
  const panel = page.getByTestId('api-access-settings');
  await expect(panel.getByRole('button', { name: 'Create key', exact: true })).toBeEnabled({ timeout: 30_000 });
  return { page, panel, sharedId: shared.id as string };
}

async function beginCreate(page: Page, name: string) {
  await page.getByTestId('api-access-settings').getByRole('button', { name: 'Create key', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Application name').fill(name);
  await dialog.getByLabel(workspaceName, { exact: true }).check();
  await expect(dialog.getByLabel('Read and search', { exact: true })).toBeChecked();
  await expect(dialog.getByLabel('Edit', { exact: true })).not.toBeChecked();
  return dialog;
}

async function closeSecret(page: Page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Your new API key' })).toBeVisible();
  await expect(dialog.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'password');
  const key = await dialog.getByLabel('API key', { exact: true }).inputValue();
  expect(/^cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/u.test(key)).toBe(true);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await dialog.getByRole('button', { name: 'Copy key', exact: true }).click();
  expect(await page.evaluate(async secret => (await navigator.clipboard.readText()) === secret, key)).toBe(true);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(page.locator('#api-access-issued')).toHaveCount(0);
  expect(await page.evaluate(secret => document.body.textContent?.includes(secret) === true, key)).toBe(false);
  expect(await page.evaluate(secret => Object.values(localStorage).some(value => value.includes(secret)), key)).toBe(false);
  return key;
}

async function findIntegration(page: Page, name: string) {
  const panel = page.getByTestId('api-access-settings');
  const card = panel.getByRole('region', { name, exact: true });
  for (let count = 0; count < 40 && !await card.isVisible(); count++) {
    const more = panel.getByRole('button', { name: 'Load more', exact: true });
    await expect(more).toBeVisible();
    await more.click();
    await expect(panel.getByRole('button', { name: 'Create key', exact: true })).toBeEnabled();
  }
  await expect(card).toBeVisible();
  return card;
}

async function cleanup(context: BrowserContext, requestIds: Set<string>) {
  for (const requestId of requestIds) {
    const response = await context.request.get(`${base}?creationRequestId=${requestId}`);
    expect(response.status()).toBe(200);
    for (const integration of (await response.json()).data.integrations as Integration[]) {
      const history = await context.request.get(`${base}/${integration.id}/credentials`); expect(history.status()).toBe(200);
      const body = (await history.json()).data;
      let revision = body.integration.revision;
      for (const key of body.credentials as Credential[]) if (key.revokedAt == null) {
        const revoked = await context.request.delete(`${base}/${integration.id}/credentials`, {
          headers: { Origin: origin }, data: { expectedRevision: revision, credentialId: key.id } });
        expect(revoked.status()).toBe(200); revision = (await revoked.json()).data.integration.revision;
      }
    }
  }
}

for (const width of [1280, 390]) test(`compiled API access lifecycle at ${width}px`, async ({ browser }, info) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 900 } });
  const requests = new Set<string>(), apiContexts: APIRequestContext[] = [];
  const keyed = async (key: string) => {
    const api = await apiRequest.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] },
      extraHTTPHeaders: { 'X-Canvas-API-Key': key } }); apiContexts.push(api); return api;
  };
  let page: Page | undefined;
  try {
    const opened = await openSettings(context, width); page = opened.page;
    page.on('request', request => { if (new URL(request.url()).pathname === base && request.method() === 'POST') requests.add(request.postDataJSON().requestId); });
    const name = `API access browser ${width} ${randomUUID().slice(0, 8)}`;
    const dialog = await beginCreate(page, name);
    const issued = page.waitForResponse(response => new URL(response.url()).pathname === base && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
    const issuedResponse = await issued; expect(issuedResponse.status()).toBe(200);
    const data = (await issuedResponse.json()).data;
    expect(data.integration.workspaceIds).toEqual([opened.sharedId]); expect(data.integration.actions).toEqual(['read']);
    const first = await closeSecret(page), firstApi = await keyed(first);
    const visibleWorkspaces = await firstApi.get('/api/workspaces'); expect(visibleWorkspaces.status()).toBe(200);
    expect((await visibleWorkspaces.json()).workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([opened.sharedId]);
    expect((await firstApi.get('/api/api-access/integrations')).status()).toBe(401);
    const card = opened.panel.getByRole('region', { name });
    await expect(card).toBeVisible();
    const metadata = await context.request.get(`${base}?creationRequestId=${data.integration.creationRequestId}`);
    expect(metadata.status()).toBe(200);
    const metadataText = await metadata.text();
    expect(metadataText.includes(first)).toBe(false); expect(metadataText.includes('secret_hash')).toBe(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('api-access-settings').getByRole('button', { name: 'Create key', exact: true })).toBeEnabled();
    await expect(page.locator('#api-access-issued')).toHaveCount(0);
    const current = await findIntegration(page, name);
    await current.getByRole('button', { name: 'Edit access' }).click();
    const edit = page.getByRole('dialog'); await edit.getByLabel('Edit', { exact: true }).check();
    const updated = page.waitForResponse(response => new URL(response.url()).pathname === `${base}/${data.integration.id}` && response.request().method() === 'PATCH');
    await edit.getByRole('button', { name: 'Save access' }).click(); expect((await updated).status()).toBe(200);
    await expect(current.getByRole('button', { name: 'Rotate key', exact: true })).toBeEnabled();
    await current.getByRole('button', { name: 'Rotate key', exact: true }).click();
    const rotated = page.waitForResponse(response => new URL(response.url()).pathname === `${base}/${data.integration.id}/credentials` && response.request().method() === 'POST');
    await page.getByRole('dialog').getByRole('button', { name: 'Rotate key', exact: true }).click();
    const rotatedResponse = await rotated; expect(rotatedResponse.status()).toBe(200);
    const rotation = (await rotatedResponse.json()).data; expect(rotation.integration.id).toBe(data.integration.id);
    const second = await closeSecret(page); expect(second === first).toBe(false);
    expect((await firstApi.get('/api/workspaces')).status()).toBe(401);
    const secondApi = await keyed(second); expect((await secondApi.get('/api/workspaces')).status()).toBe(200);
    const history = await context.request.get(`${base}/${data.integration.id}/credentials`); expect(history.status()).toBe(200);
    const keys = (await history.json()).data.credentials as Credential[];
    expect(keys.length).toBe(2); expect(keys.find(key => key.id === data.credential.id)?.revokedAt != null).toBe(true);
    const keyManagementDenied = await page.evaluate(async key => {
      try { return (await fetch('/api/api-access/integrations', { headers: { 'X-Canvas-API-Key': key }, credentials: 'same-origin' })).status; }
      catch { return null; }
    }, second);
    expect(keyManagementDenied).toBe(401);
    await expect(current.getByRole('button', { name: 'Revoke', exact: true })).toBeEnabled();
    await current.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(current.getByText('Revoked', { exact: true })).toBeVisible();
    expect((await secondApi.get('/api/workspaces')).status()).toBe(401);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`api-access-${width}.png`), fullPage: true });
  } finally {
    try { await cleanup(context, requests); } finally {
      const failures: unknown[] = [];
      for (const api of apiContexts) try { await api.dispose(); } catch (error) { failures.push(error); }
      try { await context.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Owned browser/API contexts did not all close.');
    }
  }
});

for (const phase of ['after-commit', 'before-send']) test(`compiled UI reconciles issuance failure ${phase}`, async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 } });
  const requestIds = new Set<string>(), attempts: string[] = [];
  try {
    const { page, panel } = await openSettings(context);
    let lose = true;
    await page.route(`**${base}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const requestId = route.request().postDataJSON().requestId;
      requestIds.add(requestId); attempts.push(requestId);
      if (!lose) return route.continue();
      lose = false;
      if (phase === 'after-commit') { const response = await route.fetch(); expect(response.status()).toBe(200); }
      await route.abort('failed');
    });
    const dialog = await beginCreate(page, `API access lost ${phase} ${randomUUID().slice(0, 8)}`);
    await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'Issuance not yet confirmed' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Create key', exact: true })).toBeDisabled(); expect(attempts.length).toBe(1);
    await panel.getByRole('button', { name: 'Inspect metadata' }).click();
    if (phase === 'after-commit') {
      await panel.getByRole('button', { name: 'Revoke unknown key' }).click();
      await expect(panel.getByRole('button', { name: 'Create key', exact: true })).toBeEnabled();
      expect(attempts.length).toBe(1);
    } else {
      await panel.getByRole('button', { name: 'Resend the same request' }).click();
      await closeSecret(page); expect(attempts.length).toBe(2); expect(attempts[0]).toBe(attempts[1]);
    }
  } finally { try { await cleanup(context, requestIds); } finally { await context.close(); } }
});
