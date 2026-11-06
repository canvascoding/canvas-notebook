import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { authenticateManagedTestPage, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import type { CurrentFile } from '../app/lib/files/types';
import type { WorkspacePathOperationPublic } from '../app/lib/files/workspace-path-operation-public';

const contactText = '# Contact\n\n**Studio <alex@example.test>**\n';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test.describe('Physical deletion with an unrelated native email autolink', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1' || process.env.E2E_EXTERNAL_SERVER !== '1',
    'Requires the managed compiled application and an owned workspace fixture.');
  test.setTimeout(150_000);

  for (const mobile of [false, true]) test(`${mobile ? 'mobile' : 'desktop'}: delete one image and preserve the plain-text email source`, async ({ browser }, info) => {
    const origin = new URL(process.env.BASE_URL!);
    expect(['127.0.0.1', 'localhost']).toContain(origin.hostname);
    const context = await browser.newContext({ baseURL: origin.origin, locale: 'en-US',
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
      isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    let signedIn = false, primary: unknown;
    try {
      await authenticateManagedTestPage(page); signedIn = true;
      const settings = await context.request.get('/api/server-settings');
      expect(settings.status()).toBe(200);
      expect((await settings.json()).data.documentReviewEnabled).toBe(false);
      const nonce = randomUUID();
      const created = await context.request.post('/api/workspaces', { headers: { Origin: origin.origin },
        data: { type: 'personal', name: `Email-source delete ${nonce}` } });
      expect(created.status()).toBe(201);
      const workspaceId: string = (await created.json()).workspace.id;
      const headers = { 'x-canvas-workspace-id': workspaceId };
      const contactPath = `contact-${nonce}.md`, imagePath = `asset-${nonce}.png`;
      await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath: contactPath, content: contactText });
      const uploaded = await context.request.post('/api/files/upload', { headers, multipart: {
        path: '.', files: { name: imagePath, mimeType: 'image/png', buffer: image },
      } });
      expect(uploaded.status()).toBe(200);
      expect(await uploaded.json()).toMatchObject({ success: true, count: 1, files: [imagePath] });
      const downloaded = await context.request.get('/api/files/download?path=' + encodeURIComponent(imagePath), { headers });
      expect(downloaded.status()).toBe(200); expect(await downloaded.body()).toEqual(image);
      const file = await context.request.get('/api/files/read?path=' + encodeURIComponent(contactPath), { headers });
      expect(file.status()).toBe(200);
      const original = (await file.json()).data as CurrentFile;
      expect(original.content).toBe(contactText);
      const documentId = original.collaboration?.document?.id; expect(documentId).toEqual(expect.any(String));
      const readContact = async () => {
        const response = await context.request.post('/api/documents/read', { headers,
          data: { apiVersion: 1, workspaceId, documentId, format: 'text', maxBytes: 1024 } });
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.complete).toBe(true); expect(body.fragment).toBe(contactText);
        expect(body.document).toMatchObject({ documentId, path: contactPath, representation: 'plain_text' });
        return body.document.version as string;
      };
      const originalVersion = await readContact();
      await context.addInitScript(id => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspaceId);
      const requests: Array<{ dryRun: boolean; paths: string[] }> = [], reviewRequests: string[] = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/files/operation-reviews')) reviewRequests.push(url.pathname);
        if (url.pathname === '/api/files/delete' && request.method() === 'DELETE') {
          const body = request.postDataJSON(); requests.push({ dryRun: body.dryRun === true, paths: body.path });
        }
      });
      // Open only the starter document. Opening the contact would automatically
      // migrate it to Rich and no longer exercise the original plain-text gap.
      await page.goto(`/en/notebook?workspaceId=${workspaceId}&path=Erste%20Schritte.md`);
      const revealFiles = async () => {
        const row = page.locator(`[data-file-path="${imagePath}"]`).first();
        if (mobile && !await row.isVisible()) await page.getByRole('button', { name: 'Open file explorer', exact: true }).click();
        if (!mobile) {
          const toggle = page.getByRole('button', { name: 'Show sidebar', exact: true });
          if (await toggle.isVisible()) await toggle.click();
        }
        return row;
      };
      const row = await revealFiles(); await expect(row).toBeVisible({ timeout: 45_000 });
      expect(await readContact()).toBe(originalVersion);
      await row.hover(); await row.getByRole('button', { name: /^More actions for /u }).click();
      await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
      const dialog = page.getByRole('alertdialog'); await expect(dialog).toContainText(imagePath);
      const button = dialog.getByRole('button', { name: 'Delete', exact: true });
      await expect(button).toBeEnabled({ timeout: 60_000 });
      const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/files/delete'
        && reply.request().method() === 'DELETE' && reply.request().postDataJSON().dryRun !== true, { timeout: 90_000 });
      await button.click(); const deletion = await response; expect(deletion.ok()).toBe(true);
      const result = await deletion.json(); expect(result.reviewRequired).toBeUndefined();
      const operation = result.operation as WorkspacePathOperationPublic; expect(operation.batchId).toEqual(expect.any(String));
      await expect.poll(async () => {
        const status = await context.request.get(`/api/files/operations/batches/${operation.batchId}`, { headers });
        expect(status.status()).toBe(200); const current = (await status.json()).operation as WorkspacePathOperationPublic;
        expect(current.workspaceId).toBe(workspaceId); expect(current.planId).toBe(operation.planId);
        if (current.status === 'applied') {
          expect(current.phase).toBe('complete'); expect(current.completedActions).toBe(current.totalActions);
        }
        return current.status;
      }, { timeout: 90_000 }).toBe('applied');
      await expect(dialog).toBeHidden(); await expect(row).toHaveCount(0);
      const absent = await context.request.get('/api/files/download?path=' + encodeURIComponent(imagePath), { headers });
      expect(absent.status()).toBe(404); expect(await readContact()).toBe(originalVersion);
      expect(reviewRequests).toEqual([]);
      expect(requests.filter(value => !value.dryRun)).toEqual([{ dryRun: false, paths: [imagePath] }]);
      await page.reload();
      if (mobile) await page.getByRole('button', { name: 'Open file explorer', exact: true }).click();
      await expect(page.locator(`[data-file-path="${imagePath}"]`)).toHaveCount(0);
      await expect(page.locator(`[data-file-path="${contactPath}"]`).first()).toBeVisible({ timeout: 30_000 });
      expect(await readContact()).toBe(originalVersion);
      expect(requests.filter(value => !value.dryRun)).toHaveLength(1);
      await page.screenshot({ path: info.outputPath('deleted-image-email-source-preserved.png'), animations: 'disabled' });
    } catch (error) { primary = error; throw error; }
    finally {
      try {
        if (signedIn) expect((await context.request.post('/api/auth/sign-out', { headers: { Origin: origin.origin }, data: {} })).status()).toBe(200);
      } catch (error) {
        throw new AggregateError(primary ? [primary, error] : [error], 'Owned image-delete session did not close cleanly.');
      } finally { await context.close(); }
    }
  });
});
