import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import { requireOwnedYjsQaTarget } from '../scripts/lib/owned-yjs-authority-qa';
import { authenticateManagedTestPage, uploadWorkspaceTextFile } from './helpers/managed-test-context';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3100';
type Share = { id: string; workspaceId: string; workspacePath: string; status: string; policyRevision: number;
  securityMode: 'strict' | 'interactive'; publicPath: string; shortCode: string | null; sizeKind?: 'file' | 'native-state' };

function shareResponse(response: Response, method: string, pathname: string): boolean {
  const url = new URL(response.url());
  return response.request().method() === method && url.origin === new URL(BASE_URL).origin && url.pathname === pathname;
}

async function openNativePublicDialog(page: Page, workspaceId: string, filePath: string, documentId: string) {
  await page.goto('/notebook', { waitUntil: 'domcontentloaded' });
  const file = page.locator(`[data-file-path=${JSON.stringify(filePath)}][data-file-type="file"]`);
  await expect(file).toBeVisible(); await file.click({ button: 'right' });
  const info = page.waitForResponse(response => shareResponse(response, 'GET', '/api/files/info')
    && new URL(response.url()).searchParams.get('path') === filePath);
  await page.getByRole('menuitem', { name: /^(Share|Teilen)$/u }).click();
  const response = await info; expect(response.status()).toBe(200);
  const target = (await response.json()).data.metadataTarget;
  expect(target).toMatchObject({ version: 1, kind: 'native_file', workspaceId, path: filePath, documentId });
  expect(target.lifecycleGeneration).toBeGreaterThan(0);
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: /^(Read link|Leselink)$/u }) });
  await expect(dialog).toBeVisible(); await dialog.getByRole('tab', { name: /^(Read link|Leselink)$/u }).click();
  return dialog;
}

test('owned imported native Markdown shares actual rich content and images anonymously and revokes through the UI', async ({ page, browser }, info) => {
  test.skip(process.env.CANVAS_YJS_AUTHORITY_E2E !== '1', 'Requires the supervisor-owned production build and isolated Team fixture.');
  test.setTimeout(180_000);
  const owned = await requireOwnedYjsQaTarget(); expect(owned.activeSpec).toBe('tests/public-share-native-owned.spec.ts');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await authenticateManagedTestPage(page);
  const disabled = await page.request.patch('/api/admin/experimental-settings', {
    headers: { Origin: BASE_URL }, data: { documentReviewEnabled: false },
  });
  expect(disabled.status()).toBe(200);
  expect(await disabled.json()).toMatchObject({ success: true, data: { documentReviewEnabled: false } });
  const settings = await page.request.get('/api/server-settings'); expect(settings.status()).toBe(200);
  expect((await settings.json()).data.documentReviewEnabled).toBe(false);
  const spaces = await page.request.get('/api/workspaces'); expect(spaces.status()).toBe(200);
  const workspace = ((await spaces.json()).workspaces as Array<{ id: string; name: string;
    permissions: { canWrite: boolean; canDelete: boolean; canCreatePublicLinks: boolean } }> )
    .find(candidate => candidate.name === 'Shared Test Workspace');
  expect(workspace?.permissions).toMatchObject({ canWrite: true, canDelete: true, canCreatePublicLinks: true });
  const workspaceId = workspace!.id, headers = { 'x-canvas-workspace-id': workspaceId, Origin: BASE_URL };
  await page.context().addInitScript(id => {
    localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false');
    localStorage.setItem('canvas.notebookLayout.v2', JSON.stringify({ version: 2, explorerOpen: true,
      explorerWidth: 240, chatDocked: true, chatWidth: 360, terminalOpen: false }));
  }, workspaceId);
  const nonce = randomUUID(), filePath = `qa-public-native-${nonce}.md`, imagePath = `qa-public-native-image-${nonce}.png`;
  expect(filePath).toMatch(/^qa-public-native-[a-f0-9-]+\.md$/u); expect(imagePath).toMatch(/^qa-public-native-image-[a-f0-9-]+\.png$/u);
  const heading = 'Owned native publication', paragraph = 'A real native paragraph with Ä and ß.';
  const markdown = `# ${heading}\n\n${paragraph}\n\n![Owned native image](${imagePath})\n`;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  let attempted = false, anonymous: BrowserContext | undefined, failed = false, primary: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    attempted = true;
    const uploadedImage = await page.request.post('/api/files/upload', { headers, multipart: { path: '.',
      files: { name: imagePath, mimeType: 'image/png', buffer: image } } });
    expect(uploadedImage.status()).toBe(200);
    // The ordinary upload/import path creates the native note. No raw Markdown
    // writes, database seeds or private editor handles establish this fixture.
    await uploadWorkspaceTextFile({ request: page.request, workspaceId, filePath, content: markdown });
    const openingSession = page.waitForResponse(response => shareResponse(response, 'POST', '/api/files/collaboration/session')
      && response.request().headers()['x-canvas-workspace-id'] === workspaceId && response.request().postDataJSON()?.path === filePath);
    await page.goto(`/notebook?${new URLSearchParams({ path: filePath, workspaceId })}`, { waitUntil: 'domcontentloaded' });
    const sessionResponse = await openingSession; expect(sessionResponse.status()).toBe(200);
    const session = await sessionResponse.json();
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
    await expect(editor.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(editor).toContainText(paragraph);
    expect(session).toMatchObject({ success: true, provider: 'yjs', permission: 'write', degraded: false });
    expect(typeof session.documentId).toBe('string'); expect(session.documentId.length).toBeGreaterThan(0);
    expect(session.lifecycleGeneration).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: /^(Read|Lesen|Edit|Bearbeiten)$/u })).toHaveCount(0);

    const dialog = await openNativePublicDialog(page, workspaceId, filePath, session.documentId);
    const posting = page.waitForResponse(response => shareResponse(response, 'POST', '/api/security/public-shares'));
    await dialog.getByRole('button', { name: /^(Create read link|Leselink erstellen)$/u }).click();
    const createdResponse = await posting; expect(createdResponse.status()).toBe(200);
    expect(createdResponse.request().postDataJSON()).toMatchObject({ paths: [filePath], securityMode: 'strict' });
    const createdBody = await createdResponse.json() as { shares: Share[]; skipped: unknown[] };
    expect(createdBody.skipped).toEqual([]); expect(createdBody.shares).toHaveLength(1);
    const created = createdBody.shares[0];
    expect(created).toMatchObject({ workspaceId, workspacePath: filePath, status: 'active', policyRevision: 1,
      securityMode: 'strict', sizeKind: 'native-state' });
    expect(typeof created.shortCode).toBe('string'); expect(created.shortCode!.length).toBe(6);
    const publicUrl = new URL(created.publicPath, BASE_URL);
    expect(publicUrl.origin).toBe(new URL(BASE_URL).origin); expect(publicUrl.pathname.startsWith('/public/files/')).toBe(true);
    expect(decodeURIComponent(publicUrl.pathname.split('/').at(-1)!)).toBe(filePath);
    const downloadUrl = new URL(publicUrl); downloadUrl.searchParams.set('download', '1');
    const token = decodeURIComponent(publicUrl.pathname.split('/')[3]); expect(token.length).toBeGreaterThan(20);
    anonymous = await browser.newContext({ baseURL: BASE_URL }); expect(await anonymous.cookies()).toEqual([]);
    const reader = await anonymous.newPage();
    const preview = await reader.goto(`/p/${encodeURIComponent(created.shortCode!)}`, { waitUntil: 'domcontentloaded' });
    expect(preview?.status()).toBe(200);
    const nativePreview = reader.locator('[data-public-native-document="true"]'); await expect(nativePreview).toBeVisible();
    const nativeEditor = nativePreview.locator('[data-public-native-rich="true"] .ProseMirror');
    await expect(nativeEditor).toHaveAttribute('contenteditable', 'false');
    await expect(nativeEditor.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(nativeEditor).toContainText(paragraph);
    await expect(reader.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(reader.getByRole('button', { name: /^(Read|Lesen|Edit|Bearbeiten)$/u })).toHaveCount(0);
    const renderedImage = nativeEditor.getByRole('img', { name: 'Owned native image', exact: true }); await expect(renderedImage).toBeVisible();
    const imageUrl = `/public/markdown-assets/${encodeURIComponent(token)}/${encodeURIComponent(imagePath)}`;
    await expect(renderedImage).toHaveAttribute('src', imageUrl);
    await expect.poll(() => renderedImage.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
    const imageResponse = await anonymous.request.get(imageUrl);
    expect(imageResponse.status()).toBe(200); expect(imageResponse.headers()['content-type']).toBe('image/png');
    expect(await imageResponse.body()).toEqual(image);
    await info.attach('public-native-anonymous-preview', { body: await reader.screenshot(), contentType: 'image/png' });

    const downloadLink = reader.getByRole('link', { name: 'Download', exact: true }); await expect(downloadLink).toBeVisible();
    expect(new URL((await downloadLink.getAttribute('href'))!, BASE_URL).href).toBe(downloadUrl.href);
    const downloading = reader.waitForEvent('download'); await downloadLink.click(); const download = await downloading;
    expect(download.suggestedFilename()).toBe(filePath); expect(await download.failure()).toBeNull();
    const downloadedPath = await download.path(); expect(downloadedPath).not.toBeNull();
    const expectedBytes = Buffer.from(markdown, 'utf8'); expect(await readFile(downloadedPath!)).toEqual(expectedBytes);
    const head = await anonymous.request.head(downloadUrl.href); expect(head.status()).toBe(200);
    expect(head.headers()['content-type']).toBe('text/markdown; charset=utf-8'); expect(Number(head.headers()['content-length'])).toBe(expectedBytes.length);
    expect((await head.body()).length).toBe(0);
    const range = await anonymous.request.get(downloadUrl.href, { headers: { Range: 'bytes=2-18' } }); expect(range.status()).toBe(206);
    expect(range.headers()['content-range']).toBe(`bytes 2-18/${expectedBytes.length}`); expect(await range.body()).toEqual(expectedBytes.subarray(2, 19));
    expect(await anonymous.cookies()).toEqual([]);

    const endpoint = `/api/security/public-shares/${encodeURIComponent(created.id)}`;
    const deleting = page.waitForResponse(response => shareResponse(response, 'DELETE', endpoint));
    await dialog.locator('article').getByRole('button', { name: /^(Revoke|Widerrufen)$/u }).click();
    const revokedResponse = await deleting; expect(revokedResponse.status()).toBe(200);
    expect((await revokedResponse.json()).share).toMatchObject({ id: created.id, status: 'revoked', policyRevision: 2 });
    await expect(dialog.locator('article')).toHaveCount(0);
    const denied = await anonymous.request.get(downloadUrl.href, { maxRedirects: 0 }); expect(denied.status()).toBe(410);
    expect((await denied.json()).success).toBe(false); expect(denied.headers()['cache-control']).toContain('no-store');
    expect((await anonymous.request.get(imageUrl)).status()).toBe(404);
    expect((await (await page.request.get('/api/server-settings')).json()).data.documentReviewEnabled).toBe(false);
  } catch (error) {
    failed = true; primary = error;
    try { await info.attach('public-native-failure-ui', { body: await page.screenshot(), contentType: 'image/png' }); }
    catch (attachmentError) { cleanupErrors.push(attachmentError); }
  } finally {
    const cleanup = async (operation: () => Promise<void>) => { try { await operation(); } catch (error) { cleanupErrors.push(error); } };
    // Close any owner editor transport before the ordinary lifecycle DELETE.
    // The original failure was captured above before this cleanup navigation.
    await cleanup(async () => { await page.goto('about:blank'); });
    if (attempted) {
      await cleanup(async () => {
        const response = await page.request.get(`/api/security/public-shares?${new URLSearchParams({ path: filePath, status: 'all' })}`, { headers });
        expect(response.status()).toBe(200); const shares = (await response.json()).shares as Share[]; expect(Array.isArray(shares)).toBe(true);
        for (const share of shares) {
          expect(share.workspacePath).toBe(filePath); expect(share.workspaceId).toBe(workspaceId);
          if (share.status === 'revoked') continue;
          const revoked = await page.request.delete(`/api/security/public-shares/${encodeURIComponent(share.id)}`, { headers });
          expect(revoked.status()).toBe(200); expect((await revoked.json()).share).toMatchObject({ id: share.id, status: 'revoked' });
        }
      });
      for (const ownedPath of [filePath, imagePath]) await cleanup(async () => {
        const before = await page.request.get(`/api/files/info?${new URLSearchParams({ path: ownedPath })}`, { headers });
        expect([200, 404]).toContain(before.status()); if (before.status() === 404) return;
        const response = await page.request.delete('/api/files/delete', { headers, data: { path: ownedPath, idempotencyKey: randomUUID() } });
        expect(response.status()).toBe(200); expect((await response.json()).success).toBe(true);
        expect((await page.request.get(`/api/files/info?${new URLSearchParams({ path: ownedPath })}`, { headers })).status()).toBe(404);
      });
    }
    if (anonymous) await cleanup(() => anonymous!.close());
  }
  if (cleanupErrors.length) throw new AggregateError(failed ? [primary, ...cleanupErrors] : cleanupErrors, 'Owned native public preview UI cleanup failed.');
  if (failed) throw primary;
});
