import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import { requireOwnedYjsQaTarget } from '../scripts/lib/owned-yjs-authority-qa';
import { authenticateManagedTestPage, uploadWorkspaceTextFile } from './helpers/managed-test-context';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3100';
type Share = { id: string; workspaceId: string; workspacePath: string; status: string; policyRevision: number;
  securityMode: 'strict' | 'interactive'; expiresAt: string | null; publicPath: string; shortCode: string | null };

function shareResponse(response: Response, method: string, pathname: string): boolean {
  const url = new URL(response.url());
  return response.request().method() === method && url.origin === new URL(BASE_URL).origin && url.pathname === pathname;
}

async function openPublicDialog(page: Page, workspaceId: string, filePath: string) {
  await page.goto('/notebook', { waitUntil: 'domcontentloaded' });
  const file = page.locator(`[data-file-path=${JSON.stringify(filePath)}][data-file-type="file"]`);
  await expect(file).toBeVisible();
  await file.click({ button: 'right' });
  const info = page.waitForResponse(response => shareResponse(response, 'GET', '/api/files/info')
    && new URL(response.url()).searchParams.get('path') === filePath);
  await page.getByRole('menuitem', { name: /^(Share|Teilen)$/u }).click();
  const response = await info;
  expect(response.status()).toBe(200);
  expect((await response.json()).data.metadataTarget).toMatchObject({ version: 1, kind: 'filesystem',
    workspaceId, path: filePath, entryType: 'file' });
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: /^(Read link|Leselink)$/u }) });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: /^(Read link|Leselink)$/u }).click();
  return dialog;
}

test('owned physical HTML public policy persists through the UI and revokes anonymous access', async ({ page, browser }, info) => {
  test.skip(process.env.CANVAS_YJS_AUTHORITY_E2E !== '1', 'Requires the supervisor-owned production build and isolated Team fixture.');
  test.setTimeout(180_000);
  const owned = await requireOwnedYjsQaTarget();
  expect(owned.activeSpec).toBe('tests/public-share-policy-owned.spec.ts');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await authenticateManagedTestPage(page);
  const disabled = await page.request.patch('/api/admin/experimental-settings', {
    headers: { Origin: BASE_URL }, data: { documentReviewEnabled: false },
  });
  expect(disabled.status()).toBe(200);
  expect(await disabled.json()).toMatchObject({ success: true, data: { documentReviewEnabled: false } });
  const settings = await page.request.get('/api/server-settings');
  expect(settings.status()).toBe(200);
  expect((await settings.json()).data.documentReviewEnabled).toBe(false);
  const spaces = await page.request.get('/api/workspaces');
  expect(spaces.status()).toBe(200);
  const workspace = ((await spaces.json()).workspaces as Array<{ id: string; name: string;
    permissions: { canWrite: boolean; canDelete: boolean; canCreatePublicLinks: boolean } }> )
    .find(candidate => candidate.name === 'Shared Test Workspace');
  expect(workspace?.permissions).toMatchObject({ canWrite: true, canDelete: true, canCreatePublicLinks: true });
  const workspaceId = workspace!.id, headers = { 'x-canvas-workspace-id': workspaceId, Origin: BASE_URL };
  await page.context().addInitScript(id => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
    localStorage.setItem('canvas.notebookLayout.v2', JSON.stringify({ version: 2, explorerOpen: true,
      explorerWidth: 240, chatDocked: true, chatWidth: 360, terminalOpen: false }));
  }, workspaceId);
  const filePath = `qa-public-policy-${randomUUID()}.html`;
  expect(filePath).toMatch(/^qa-public-policy-[a-f0-9-]+\.html$/u);
  let fileAttempted = false, anonymous: BrowserContext | undefined, failed = false, primary: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    fileAttempted = true;
    await uploadWorkspaceTextFile({ request: page.request, workspaceId, filePath, mimeType: 'text/html',
      content: '<!doctype html><html><head><title>Owned public policy</title></head><body><p>Owned physical public policy fixture.</p></body></html>' });
    let dialog = await openPublicDialog(page, workspaceId, filePath);
    const posting = page.waitForResponse(response => shareResponse(response, 'POST', '/api/security/public-shares'));
    await dialog.getByRole('button', { name: /^(Create read link|Leselink erstellen)$/u }).click();
    const createdResponse = await posting;
    expect(createdResponse.status()).toBe(200);
    expect(createdResponse.request().postDataJSON()).toMatchObject({ paths: [filePath], securityMode: 'strict' });
    const createdBody = await createdResponse.json() as { shares: Share[]; skipped: unknown[] };
    expect(createdBody.skipped).toEqual([]);
    expect(createdBody.shares).toHaveLength(1);
    const created = createdBody.shares[0];
    expect(created).toMatchObject({ workspaceId, workspacePath: filePath, status: 'active', policyRevision: 1, securityMode: 'strict' });
    const publicUrl = new URL(created.publicPath, BASE_URL);
    expect(publicUrl.origin).toBe(new URL(BASE_URL).origin);
    expect(publicUrl.pathname.startsWith('/public/files/')).toBe(true);
    expect(decodeURIComponent(publicUrl.pathname.split('/').at(-1)!)).toBe(filePath);
    const card = dialog.locator('article');
    await expect(card).toHaveCount(1);
    await expect(card.getByText(filePath, { exact: true })).toBeVisible();
    anonymous = await browser.newContext({ baseURL: BASE_URL });
    expect(await anonymous.cookies()).toEqual([]);
    expect((await anonymous.request.head(publicUrl.href)).status()).toBe(200);

    const expiry = await page.evaluate(() => {
      const value = new Date(Date.now() + 7 * 86_400_000); value.setSeconds(0, 0);
      const part = (number: number) => String(number).padStart(2, '0');
      return { iso: value.toISOString(), local: `${value.getFullYear()}-${part(value.getMonth() + 1)}-${part(value.getDate())}T${part(value.getHours())}:${part(value.getMinutes())}` };
    });
    await card.getByRole('switch', { name: /^(Allow interactive HTML|Interaktives HTML erlauben)$/u }).check();
    await card.getByLabel(/^(Expiry date|Ablaufdatum)$/u).fill(expiry.local);
    const endpoint = `/api/security/public-shares/${encodeURIComponent(created.id)}`;
    const patching = page.waitForResponse(response => shareResponse(response, 'PATCH', endpoint));
    await card.getByRole('button', { name: /^(Save changes|Änderungen speichern)$/u }).click();
    const patchedResponse = await patching;
    expect(patchedResponse.status()).toBe(200);
    expect(patchedResponse.request().postDataJSON()).toMatchObject({ policyRevision: 1, securityMode: 'interactive', expiresAt: expiry.iso });
    const patched = (await patchedResponse.json()).share as Share;
    expect(patched).toMatchObject({ id: created.id, workspaceId, workspacePath: filePath, status: 'active', policyRevision: 2,
      securityMode: 'interactive', expiresAt: expiry.iso, publicPath: created.publicPath, shortCode: created.shortCode });
    await expect(card.getByRole('button', { name: /^(Save changes|Änderungen speichern)$/u })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    dialog = await openPublicDialog(page, workspaceId, filePath);
    const persisted = dialog.locator('article');
    await expect(persisted).toHaveCount(1);
    await expect(persisted.getByRole('switch', { name: /^(Allow interactive HTML|Interaktives HTML erlauben)$/u })).toBeChecked();
    await expect(persisted.getByLabel(/^(Expiry date|Ablaufdatum)$/u)).toHaveValue(expiry.local);
    await expect(persisted.getByRole('button', { name: /^(Save changes|Änderungen speichern)$/u })).toBeDisabled();
    await info.attach('public-policy-persisted-settings', { body: await dialog.screenshot(), contentType: 'image/png' });
    expect((await anonymous.request.head(publicUrl.href)).status()).toBe(200);

    const deleting = page.waitForResponse(response => shareResponse(response, 'DELETE', endpoint));
    await persisted.getByRole('button', { name: /^(Revoke|Widerrufen)$/u }).click();
    const revokedResponse = await deleting;
    expect(revokedResponse.status()).toBe(200);
    expect(revokedResponse.request().postDataJSON()).toMatchObject({ policyRevision: 2 });
    expect((await revokedResponse.json()).share).toMatchObject({ id: created.id, status: 'revoked', policyRevision: 3,
      securityMode: 'interactive', expiresAt: expiry.iso, publicPath: created.publicPath, shortCode: created.shortCode });
    await expect(dialog.locator('article')).toHaveCount(0);
    const denied = await anonymous.request.get(publicUrl.href, { maxRedirects: 0 });
    expect(denied.status()).toBe(410);
    expect((await denied.json()).success).toBe(false);
    expect(denied.headers()['cache-control']).toContain('no-store');
    expect((await (await page.request.get('/api/server-settings')).json()).data.documentReviewEnabled).toBe(false);
  } catch (error) {
    failed = true; primary = error;
    try { await info.attach('public-policy-failure-ui', { body: await page.screenshot(), contentType: 'image/png' }); }
    catch (attachmentError) { cleanupErrors.push(attachmentError); }
  } finally {
    const cleanup = async (operation: () => Promise<void>) => { try { await operation(); } catch (error) { cleanupErrors.push(error); } };
    if (fileAttempted) {
      await cleanup(async () => {
        // Fresh actual state avoids replaying a DELETE whose outcome was unknown.
        const response = await page.request.get(`/api/security/public-shares?${new URLSearchParams({ path: filePath, status: 'all' })}`, { headers });
        expect(response.status()).toBe(200);
        const shares = (await response.json()).shares as Share[];
        expect(Array.isArray(shares)).toBe(true);
        for (const share of shares) {
          expect(share.workspacePath).toBe(filePath); expect(share.workspaceId).toBe(workspaceId);
          if (share.status === 'revoked') continue;
          const revoked = await page.request.delete(`/api/security/public-shares/${encodeURIComponent(share.id)}`, { headers });
          expect(revoked.status()).toBe(200);
          expect((await revoked.json()).share).toMatchObject({ id: share.id, status: 'revoked' });
        }
      });
      await cleanup(async () => {
        const response = await page.request.delete('/api/files/delete', { headers, data: { path: filePath, idempotencyKey: randomUUID() } });
        expect(response.status()).toBe(200);
        expect((await response.json()).success).toBe(true);
        expect((await page.request.get(`/api/files/info?${new URLSearchParams({ path: filePath })}`, { headers })).status()).toBe(404);
      });
    }
    if (anonymous) await cleanup(() => anonymous!.close());
  }
  if (cleanupErrors.length) throw new AggregateError(failed ? [primary, ...cleanupErrors] : cleanupErrors, 'Owned public policy UI cleanup failed.');
  if (failed) throw primary;
});
