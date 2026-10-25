import { createHash, randomUUID } from 'node:crypto';
import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { Client } from 'pg';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { readNativeRichCandidate } from './helpers/native-rich-candidate';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';

const selector = '.tiptap-editor-shell .ProseMirror[contenteditable="true"]';
const sentence = 'Ja. Ein synthetischer Beispielsatz.';
test.skip(!process.env.TEST_WORKSPACE_NAME || !process.env.DATABASE_URL,
  'An explicit managed workspace and its PostgreSQL connection are required for native preservation evidence.');
test.setTimeout(180_000);

async function context(browser: Browser, mobile: boolean, workspaceId: string): Promise<BrowserContext> {
  const result = await createAuthenticatedContext(browser, {
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: mobile, hasTouch: mobile,
  });
  await result.addInitScript(id => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
    localStorage.setItem('canvas-browser-mode', 'list');
  }, workspaceId);
  return result;
}

async function native(database: Client, documentId: string, workspaceId: string) {
  const { rows } = await database.query(
    'SELECT yjs_state,state_vector,status FROM collaboration_yjs_states WHERE document_id=$1 AND workspace_id=$2',
    [documentId, workspaceId]);
  expect(rows).toHaveLength(1);
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  return { binary: hash(rows[0].yjs_state), vector: hash(rows[0].state_vector), status: rows[0].status };
}

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'}: literal paragraph survives native save, reload and folder Trash`, async ({ browser }, info) => {
    const database = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
    await database.connect();
    await database.query('SET default_transaction_read_only=on');
    const contexts: BrowserContext[] = [];
    try {
      const discovery = await createAuthenticatedContext(browser);
      contexts.push(discovery);
      const listingResponse = await discovery.request.get('/api/workspaces');
      expect(listingResponse.ok()).toBe(true);
      const listing = await listingResponse.json() as { workspaces: Array<{ id: string; name: string; status: string }> };
      const workspaces = listing.workspaces.filter(workspace => workspace.name === process.env.TEST_WORKSPACE_NAME && workspace.status === 'active');
      expect(workspaces).toHaveLength(1);
      const workspaceId = workspaces[0].id;
      const folder = `release-recovery-${randomUUID()}`, filePath = `${folder}/native-paragraph.md`;
      const headers = { 'x-canvas-workspace-id': workspaceId };
      const initial = await context(browser, mobile, workspaceId);
      contexts.push(initial);
      const created = await initial.request.post('/api/files/create', { headers, data: { path: folder, type: 'directory' } });
      expect(created.status()).toBe(200);
      await uploadWorkspaceTextFile({ request: initial.request, workspaceId, filePath, content: `A ${sentence}\n` });
      const url = `/en/files?workspaceId=${workspaceId}&path=${encodeURIComponent(filePath)}`;
      const page = await initial.newPage();
      await page.goto(url);
      const editor = page.locator(selector);
      await expect(editor).toHaveText(`A ${sentence}`, { timeout: 60_000 });
      const before = await readNativeRichCandidate(page, selector);
      const blockId = before.document.content?.[0].attrs?.id;
      expect(blockId).toBeTruthy();
      // Collapse an actual browser selection to the beginning on macOS/Linux.
      await editor.click();
      await editor.press('ControlOrMeta+A');
      await editor.press('ArrowLeft');
      await editor.press('Delete');
      await editor.press('Delete');
      await expect(editor).toHaveText(sentence);
      const candidate = await readNativeRichCandidate(page, selector);
      expect(candidate.document.content?.[0]).toMatchObject({ type: 'paragraph', attrs: { id: blockId } });
      let documentId = '';
      await expect.poll(async () => {
        const response = await initial.request.post('/api/files/collaboration/session', {
          headers, data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
        });
        expect(response.status()).toBe(200);
        const body = await response.json();
        documentId = body.documentId;
        return { proof: body.stateProof, vector: body.stateVector };
      }, { timeout: 45_000 }).toEqual({ proof: candidate.stateProof, vector: candidate.stateVector });
      await expect.poll(async () => {
        const response = await initial.request.get('/api/files/download', { headers, params: { path: filePath } });
        return response.ok() ? (await response.text()).trim() : `HTTP ${response.status()}`;
      }, { timeout: 45_000 }).toBe('Ja\\. Ein synthetischer Beispielsatz.');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await initial.close();

      const fresh = await context(browser, mobile, workspaceId);
      contexts.push(fresh);
      const reloaded = await fresh.newPage();
      await reloaded.goto(url);
      await expect(reloaded.locator(selector)).toHaveText(sentence, { timeout: 60_000 });
      const persisted = await readNativeRichCandidate(reloaded, selector);
      expect(persisted.document.content?.[0]).toMatchObject({ type: 'paragraph', attrs: { id: blockId } });
      await reloaded.screenshot({ path: info.outputPath('native-saved-reloaded.png') });
      await reloaded.getByRole('button', { name: 'Close', exact: true }).click();
      await fresh.close();
      const stored = await native(database, documentId, workspaceId);

      const cleanup = await context(browser, mobile, workspaceId);
      contexts.push(cleanup);
      const files = await cleanup.newPage();
      await files.goto(`/en/files?workspaceId=${workspaceId}`);
      if (mobile) {
        const open = files.getByRole('button', { name: 'Open file explorer', exact: true });
        if (await open.isVisible()) await open.click();
      }
      const row = files.locator(`[data-file-path="${folder}"]`).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.hover();
      await row.getByRole('button', { name: /^More actions for / }).click();
      await files.getByRole('menuitem', { name: 'Delete', exact: true }).click();
      const dialog = files.getByRole('alertdialog');
      await expect(dialog).toContainText(folder);
      const deletion = files.waitForResponse(response => new URL(response.url()).pathname === '/api/files/delete'
        && response.request().method() === 'DELETE' && response.request().postDataJSON()?.dryRun !== true, { timeout: 90_000 });
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      expect((await deletion).ok()).toBe(true);
      await expect(row).toHaveCount(0, { timeout: 90_000 });
      await expect.poll(async () => {
        const current = await native(database, documentId, workspaceId);
        expect(current.binary).toBe(stored.binary);
        expect(current.vector).toBe(stored.vector);
        return current.status;
      }, { timeout: 45_000 }).toBe('archived');
      await files.screenshot({ path: info.outputPath('folder-trash-complete.png') });
    } finally {
      for (const current of contexts) await current.close().catch(() => {});
      await database.end();
    }
  });
}
