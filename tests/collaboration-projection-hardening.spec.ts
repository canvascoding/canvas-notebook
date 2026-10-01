import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { COLLABORATION_CLIENT_CAPABILITIES, type CollaborationSessionResponse } from '../app/lib/collaboration/types';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const selector = '.tiptap-editor-shell .ProseMirror';
type Workspace = { id: string; rootRelativePath: string; name: string; permissions: { canWrite: boolean } };

async function login(browser: Browser, secondary = false) {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 900 } });
  const email = secondary ? process.env.TEST_SECONDARY_EMAIL : process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = secondary ? process.env.TEST_SECONDARY_PASSWORD : process.env.BOOTSTRAP_ADMIN_PASSWORD;
  expect(Boolean(email && password)).toBe(true);
  const response = await context.request.post('/api/auth/sign-in/email', {
    headers: { Origin: BASE_URL }, data: { email, password },
  });
  expect(response.status(), 'Managed fixture login').toBe(200);
  const workspaces = await context.request.get('/api/workspaces');
  expect(workspaces.ok()).toBe(true);
  const workspace = ((await workspaces.json()).workspaces as Workspace[])
    .find((candidate) => candidate.name === 'Shared Test Workspace' && candidate.permissions.canWrite);
  expect(workspace).toBeTruthy();
  await context.addInitScript((id) => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace!.id);
  return { context, workspace: workspace! };
}

async function open(page: Page, filePath: string, writable = true) {
  await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
  if (writable) await page.getByRole('group', { name: /Document view|Dokumentansicht/u })
    .getByRole('button', { name: /^(Edit|Bearbeiten)$/u }).click();
  else {
    await expect(page.locator('body')).toContainText(filePath, { timeout: 30_000 });
    await page.screenshot({ path: '/tmp/canvas-yjs-426b-quarantine-open.png' });
  }
  await expect(page.locator(selector)).toHaveAttribute('contenteditable', String(writable), { timeout: 30_000 });
}

async function tree(page: Page): Promise<JSONContent> {
  return page.locator(selector).evaluate((element) =>
    (element as HTMLElement & { editor: { getJSON(): JSONContent } }).editor.getJSON());
}

async function selectFirstParagraph(page: Page) {
  const paragraph = page.locator(selector).locator('p').first();
  await paragraph.click();
  await paragraph.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  });
  await expect(page.getByTestId('markdown-selection-menu')).toBeVisible();
}

test.describe('collaboration projection hardening', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the authorized managed local PostgreSQL stack.');
  test.setTimeout(180_000);

  test('offline Code/Bold conflicts converge, project, reopen and preserve quarantine across reconnect', async ({ browser }, info) => {
    const url = new URL(process.env.DATABASE_URL!);
    expect(['localhost', '127.0.0.1']).toContain(url.hostname);
    expect(url.port).toBe('55433');
    expect(url.pathname).toBe('/canvas_notebook');
    expect(['localhost', '127.0.0.1']).toContain(new URL(BASE_URL).hostname);
    expect(['3000', '3100']).toContain(new URL(BASE_URL).port);
    const pool = new Pool({ connectionString: url.href, max: 1 });
    const owner = await login(browser);
    const peer = await login(browser, true);
    const contexts: BrowserContext[] = [owner.context, peer.context];
    expect(peer.workspace.id).toBe(owner.workspace.id);
    const headers = { 'x-canvas-workspace-id': owner.workspace.id };
    const filePath = `collaboration-hardening-${randomUUID()}.md`;
    const page = await owner.context.newPage();
    const peerPage = await peer.context.newPage();
    const errors: string[] = [];
    for (const target of [page, peerPage]) {
      target.on('pageerror', (error) => errors.push(error.name));
      target.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    }
    let identity: CollaborationSessionResponse | undefined;
    let quarantinedBinary: Buffer | undefined;
    try {
      const upload = await page.request.post('/api/files/upload', { headers, multipart: {
        path: '.', files: { name: filePath, mimeType: 'text/markdown', buffer: Buffer.from('Conflict\n\nUnchanged text\n') },
      } });
      expect(upload.ok()).toBe(true);
      await open(page, filePath); await open(peerPage, filePath);
      await expect.poll(() => tree(peerPage)).toEqual(await tree(page));
      const original = await tree(page);
      const session = await page.request.post('/api/files/collaboration/session', {
        headers, data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
      });
      expect(session.ok()).toBe(true);
      identity = await session.json() as CollaborationSessionResponse;
      const row = async () => (await pool.query(`SELECT y.document_sequence, y.checkpoint_sequence, y.yjs_state,
        y.degraded, y.projection_error_code, y.projection_error_permanent, p.finalized
        FROM collaboration_yjs_states y LEFT JOIN collaboration_file_projections p ON p.document_id = y.document_id
        WHERE y.document_id = $1 AND y.workspace_id = $2 AND y.path = $3`,
      [identity!.documentId, owner.workspace.id, filePath])).rows[0];
      await owner.context.setOffline(true); await peer.context.setOffline(true);
      await selectFirstParagraph(page);
      await page.getByTestId('markdown-selection-menu').getByRole('button', { name: /^(Inline code|Inline-Code)$/u }).click();
      await selectFirstParagraph(peerPage);
      await peerPage.getByTestId('markdown-selection-menu').getByRole('button', { name: /^(Bold|Fett)$/u }).click();
      await expect(page.locator(selector).locator('code')).toHaveText('Conflict');
      await expect(peerPage.locator(selector).locator('strong')).toHaveText('Conflict');
      await owner.context.setOffline(false); await peer.context.setOffline(false);
      await expect.poll(async () => (await tree(page)).content?.[0].content?.[0].marks,
        { timeout: 30_000 }).toEqual([{ type: 'code' }]);
      await expect.poll(() => tree(peerPage), { timeout: 30_000 }).toEqual(await tree(page));
      const converged = await tree(page);
      expect(converged.content?.map((block) => block.attrs?.id)).toEqual(original.content?.map((block) => block.attrs?.id));
      expect(converged.content?.[1]).toEqual(original.content?.[1]);
      await expect.poll(async () => {
        const state = await row();
        return Boolean(state && Number(state.document_sequence) === Number(state.checkpoint_sequence)
          && Number(state.finalized) === 1 && Number(state.degraded) === 0 && !state.projection_error_code);
      }, { timeout: 30_000 }).toBe(true);
      expect(path.isAbsolute(owner.workspace.rootRelativePath)).toBe(false);
      expect(owner.workspace.rootRelativePath.split(/[\\/]/u)).not.toContain('..');
      const projectedPath = path.join(process.env.DATA!, owner.workspace.rootRelativePath, filePath);
      const markdown = await readFile(projectedPath, 'utf8');
      expect(markdown).toBe('`Conflict`\n\nUnchanged text\n');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      await expect.poll(() => tree(page)).toEqual(converged);
      await page.screenshot({ path: info.outputPath('code-wins-reopened.png') });

      const currentSession = await page.request.post('/api/files/collaboration/session', {
        headers, data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
      });
      expect(currentSession.ok()).toBe(true);
      identity = await currentSession.json() as CollaborationSessionResponse;

      await page.close(); await peer.context.close();
      const before = await row();
      quarantinedBinary = before.yjs_state;
      const quarantined = await pool.query(`UPDATE collaboration_yjs_states SET degraded = 1,
        projection_error_code = 'COLLABORATION_SCHEMA_INVALID', projection_error_phase = 'snapshot_validate',
        projection_error_cause = 'schema_invalid', projection_error_sequence = document_sequence,
        projection_error_generation = lifecycle_generation, projection_error_permanent = 1
        WHERE document_id = $1 AND workspace_id = $2 AND path = $3 RETURNING document_id`,
      [identity.documentId, owner.workspace.id, filePath]);
      expect(quarantined.rowCount).toBe(1);
      const reconnect = await login(browser); contexts.push(reconnect.context);
      const reopened = await reconnect.context.newPage();
      reopened.on('pageerror', (error) => errors.push(error.name));
      reopened.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      await open(reopened, filePath, false);
      await expect(reopened.getByTestId('markdown-save-state').getByRole('alert')).toBeVisible();
      await expect.poll(() => tree(reopened)).toEqual(converged);
      const denied = await owner.context.request.post('/api/files/collaboration/checkpoint', {
        headers, data: { token: identity.token, stateVector: identity.stateVector, stateProof: identity.stateProof },
      });
      expect(denied.status()).toBe(409);
      expect((await denied.json()).code).toBe('COLLABORATION_QUARANTINED');
      await reopened.reload({ waitUntil: 'domcontentloaded' });
      await expect(reopened.locator(selector)).toHaveAttribute('contenteditable', 'false', { timeout: 30_000 });
      await expect(reopened.getByTestId('markdown-save-state').getByRole('alert')).toBeVisible();
      await expect.poll(() => tree(reopened)).toEqual(converged);
      await reopened.screenshot({ path: info.outputPath('quarantine-reconnected.png') });
      await reopened.setViewportSize({ width: 390, height: 844 });
      const panel = reopened.getByTestId('markdown-save-state');
      await expect(panel.getByRole('alert')).toBeVisible();
      const bounds = await panel.boundingBox();
      expect(bounds).toBeTruthy();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      await reopened.screenshot({ path: info.outputPath('quarantine-mobile.png') });
      const after = await row();
      expect(after.yjs_state).toEqual(before.yjs_state);
      expect(after.projection_error_code).toBe('COLLABORATION_SCHEMA_INVALID');
      expect(Number(after.projection_error_permanent)).toBe(1);
      expect(Number(after.degraded)).toBe(1);
      expect(await readFile(projectedPath, 'utf8')).toBe(markdown);
      expect(errors).toEqual([]);
    } finally {
      await owner.context.setOffline(false);
      if (identity && quarantinedBinary) await pool.query(`UPDATE collaboration_yjs_states SET degraded = 0,
        projection_error_code = NULL, projection_error_phase = NULL, projection_error_cause = NULL,
        projection_error_sequence = NULL, projection_error_generation = NULL, projection_error_permanent = 0
        WHERE document_id = $1 AND workspace_id = $2 AND path = $3 AND yjs_state = $4
          AND projection_error_code = 'COLLABORATION_SCHEMA_INVALID' AND projection_error_permanent = 1`,
      [identity.documentId, owner.workspace.id, filePath, quarantinedBinary]);
      await owner.context.request.delete('/api/files/delete', { headers, data: { path: filePath } }).catch(() => undefined);
      for (const context of contexts) await context.close().catch(() => undefined);
      await pool.end();
    }
  });
});
