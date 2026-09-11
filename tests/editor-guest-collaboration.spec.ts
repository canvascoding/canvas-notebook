import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import * as Y from 'yjs';

type Invitation = { id: string; policyRevision: number; email: string; url: string };
type EditorElement = HTMLElement & { editor: { isEditable: boolean; isDestroyed: boolean; state: { doc: { content: { size: number } } };
  commands: { insertContentAt: (position: number, text: string) => boolean } } };
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3100';
const execFileAsync = promisify(execFile);

async function fixtureContext(browser: Browser): Promise<BrowserContext> {
  const { baseURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } = test.info().project.use;
  return browser.newContext({ baseURL: baseURL || BASE_URL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor });
}

async function paragraphSelection(paragraph: Locator, caretAtEnd = false): Promise<void> {
  await paragraph.click();
  if (caretAtEnd) { await paragraph.press('End'); return; }
  const bounds = await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
  const page = paragraph.page();
  await page.mouse.move(bounds.left, bounds.y);
  await page.mouse.down();
  await page.mouse.move(bounds.right, bounds.y, { steps: 8 });
  await page.mouse.up();
}

async function text(editor: Locator) {
  return editor.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.collaboration-carets__label').forEach((label) => label.remove());
    return clone.textContent || '';
  });
}

async function verifyGuest(page: Page, invitation: Invitation, workspaceId: string, filePath: string, displayName: string) {
  let deliveredCode: string | undefined;
  // Replace only outbound mail transport. The actual service persists a random challenge/hash,
  // and the real browser verify route consumes it and issues the ordinary HttpOnly guest cookie.
  await page.route(`**/api/guest/files/${invitation.id}/challenge`, async (route) => {
    try {
      const encoded = Buffer.from(JSON.stringify({ invitationId: invitation.id, workspaceId, path: filePath, email: invitation.email })).toString('base64url');
      const { stdout } = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'),
        ['--conditions', 'react-server', 'scripts/collaboration-guest-challenge-driver.ts', encoded],
        { env: process.env, maxBuffer: 64 * 1024 });
      const result = stdout.split('\n').find(line => line.startsWith('CANVAS_GUEST_CHALLENGE_RESULT='));
      if (!result) throw new Error('Challenge driver returned no result.');
      deliveredCode = (JSON.parse(result.slice('CANVAS_GUEST_CHALLENGE_RESULT='.length)) as { code: string }).code;
      expect(deliveredCode).toMatch(/^\d{6}$/u);
      await route.fulfill({ status: 200, json: { success: true, message: 'Der Code wurde an die eingeladene E-Mail-Adresse gesendet.' } });
    } catch (error) {
      const diagnostics = (error as { stderr?: string }).stderr || (error instanceof Error ? error.name : 'Unknown error');
      await test.info().attach('private challenge driver diagnostics', { body: Buffer.from(diagnostics), contentType: 'text/plain' });
      await route.fulfill({ status: 500, json: { success: false, error: 'Fixture email delivery failed.' } });
    }
  });
  await page.goto(invitation.url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Code per E-Mail anfordern' }).click();
  await expect(page.getByLabel('Sechsstelliger Code')).toBeVisible({ timeout: 30_000 });
  expect(Boolean(deliveredCode), 'The real service must deliver the fixture challenge.').toBe(true);
  await page.getByLabel('Dein Anzeigename').fill(displayName);
  await page.getByLabel('Sechsstelliger Code').fill(deliveredCode!);
  const verified = page.waitForResponse((response) => response.url().endsWith(`/api/guest/files/${invitation.id}/verify`));
  await page.getByRole('button', { name: 'Datei öffnen' }).click();
  expect((await verified).ok()).toBe(true);
  const editor = page.locator('.tiptap-editor-shell .ProseMirror');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  return editor;
}

test.describe('real file guest collaboration', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed Team fixture and isolated email transport.');
  test.setTimeout(180_000);
  test('offers the shared editing controls, enforces read-only and revokes an already open writer', async ({ browser }, testInfo) => {
    expect(new URL(BASE_URL).origin).toBe('http://127.0.0.1:3100');
    const ownerContext = await fixtureContext(browser);
    const writerContext = await fixtureContext(browser);
    const readerContext = await fixtureContext(browser);
    const owner = await ownerContext.newPage();
    const writer = await writerContext.newPage();
    const reader = await readerContext.newPage();
    const filePath = `guest-collab-${randomUUID()}.md`;
    const invitations: Invitation[] = [];
    let workspaceId = '';
    try {
      const login = await owner.request.post('/api/auth/sign-in/email', { headers: { Origin: BASE_URL },
        data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD } });
      expect(login.ok()).toBe(true);
      const workspaces = (await (await owner.request.get('/api/workspaces')).json()).workspaces as Array<{
        id: string; name: string; permissions: { canWrite: boolean; canCreatePublicLinks: boolean } }>;
      const workspace = workspaces.find((candidate) => candidate.name === 'Shared Test Workspace');
      expect(workspace?.permissions).toMatchObject({ canWrite: true, canCreatePublicLinks: true });
      workspaceId = workspace!.id;
      const headers = { 'x-canvas-workspace-id': workspaceId, Origin: BASE_URL };
      const uploaded = await owner.request.post('/api/files/upload', { headers, multipart: { path: '.',
        files: { name: filePath, mimeType: 'text/markdown', buffer: Buffer.from('Guest paragraph\n\nOwner paragraph\n') } } });
      expect(uploaded.ok()).toBe(true);
      for (const permission of ['write', 'read']) {
        const invitation = await owner.request.post('/api/security/file-guests', { headers,
          data: { path: filePath, email: `guest-${randomUUID()}@example.invalid`, permission } });
        expect(invitation.ok(), 'Normal invitation creation, including the real Team entitlement, must succeed.').toBe(true);
        invitations.push((await invitation.json()).invitation);
      }
      await ownerContext.addInitScript((id) => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspaceId);
      await owner.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      const ownerEditor = owner.locator('.tiptap-editor-shell .ProseMirror');
      await owner.getByRole('group', { name: /Document view|Dokumentansicht/u })
        .getByRole('button', { name: /^(Edit|Bearbeiten)$/u }).click();
      await expect(ownerEditor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      const guestEditor = await verifyGuest(writer, invitations[0], workspaceId, filePath, 'Fixture Guest Writer');
      await expect(guestEditor).toHaveAttribute('contenteditable', 'true');
      await expect(writer.getByTestId('markdown-save-state')).toHaveCount(0);
      const guestParagraph = guestEditor.locator('p').filter({ hasText: 'Guest paragraph' });
      await paragraphSelection(guestParagraph, true);
      await writer.keyboard.insertText(' edited by guest');
      await expect.poll(() => text(ownerEditor)).toContain('Guest paragraph edited by guest');
      await paragraphSelection(guestParagraph);
      await expect.poll(() => writer.evaluate(() => getSelection()?.toString())).toBe('Guest paragraph edited by guest');
      const guestMenu = writer.getByTestId('markdown-selection-menu');
      await expect(guestMenu).toBeVisible();
      await guestMenu.getByRole('button', { name: /^(Bold|Fett)$/u }).click();
      await expect(ownerEditor.locator('strong')).toHaveText('Guest paragraph edited by guest');
      const ownerParagraph = ownerEditor.locator('p').filter({ hasText: 'Owner paragraph' });
      await paragraphSelection(ownerParagraph, true);
      await owner.keyboard.insertText(' edited by owner');
      await expect.poll(() => text(guestEditor)).toContain('Owner paragraph edited by owner');
      await paragraphSelection(ownerParagraph);
      await expect.poll(() => owner.evaluate(() => getSelection()?.toString())).toBe('Owner paragraph edited by owner');
      const ownerMenu = owner.getByTestId('markdown-selection-menu');
      await expect(ownerMenu).toBeVisible();
      for (const label of [/^(Bold|Fett)$/u, /^(Italic|Kursiv)$/u, /^(Strikethrough|Durchgestrichen)$/u,
        /^(Highlight|Hervorheben)$/u, /^(Inline code|Inline-Code)$/u, /^Link$/u]) {
        await expect(guestMenu.getByRole('button', { name: label })).toHaveCount(1);
        await expect(ownerMenu.getByRole('button', { name: label })).toHaveCount(1);
      }
      const readerEditor = await verifyGuest(reader, invitations[1], workspaceId, filePath, 'Fixture Guest Reader');
      await expect(readerEditor).toHaveAttribute('contenteditable', 'false');
      await expect.poll(() => text(readerEditor)).toBe(await text(ownerEditor));
      await readerEditor.click();
      await reader.keyboard.type('Reader must not write');
      expect(await text(readerEditor)).not.toContain('Reader must not write');
      await expect(reader.getByTestId('markdown-selection-menu')).not.toBeVisible();
      const readerSession = await reader.request.post(`/api/guest/files/${invitations[1].id}/session`, { headers: { Origin: BASE_URL }, data: {} });
      expect(readerSession.ok()).toBe(true);
      expect((await readerSession.json()).permission).toBe('read');
      const beforeRevoke = await text(ownerEditor);
      const revoked = await owner.request.delete(`/api/security/file-guests/${invitations[0].id}`, { headers,
        data: { policyRevision: invitations[0].policyRevision } });
      expect(revoked.ok()).toBe(true);
      // Exercise a real stale editor transaction after revocation; server checks must reject its update.
      const attempted = await guestEditor.evaluate((element) => {
        const editor = (element as EditorElement).editor;
        const wasEditable = editor.isEditable;
        const wasDestroyed = editor.isDestroyed;
        const applied = !wasDestroyed && editor.commands.insertContentAt(editor.state.doc.content.size - 1, 'REVOKED_GUEST_UPDATE');
        return { applied, wasEditable, wasDestroyed, localMutation: element.textContent?.includes('REVOKED_GUEST_UPDATE') };
      });
      expect(attempted, 'This scenario must actually attempt a stale local mutation; an already destroyed editor needs a separate fixture.').toMatchObject({
        applied: true, wasDestroyed: false, localMutation: true,
      });
      await expect(guestEditor).toHaveAttribute('contenteditable', 'false', { timeout: 25_000 });
      await expect(writer.getByTestId('markdown-save-state')).toBeVisible();
      const deniedSession = await writer.request.post(`/api/guest/files/${invitations[0].id}/session`, { headers: { Origin: BASE_URL }, data: {} });
      expect([403, 410]).toContain(deniedSession.status());
      expect(await text(ownerEditor)).toBe(beforeRevoke);
      await expect.poll(async () => {
        const response = await owner.request.get('/api/files/read', { headers, params: { path: filePath } });
        return (await response.json()).data.content as string;
      }, { timeout: 20_000 }).toContain('edited by owner');
      const stored = (await (await owner.request.get('/api/files/read', { headers, params: { path: filePath } })).json()).data.content as string;
      expect(stored).not.toContain('REVOKED_GUEST_UPDATE');
      expect(stored).not.toContain('Reader must not write');
      const download = writer.waitForEvent('download');
      await writer.getByTestId('markdown-save-state').getByRole('button', { name: /Back up complete document|Vollständigen Dokumentstand sichern/u }).click();
      const backup = await download;
      expect(backup.suggestedFilename()).toBe('canvas-recovery.yjs');
      const bytes = await readFile((await backup.path())!);
      const recovery = new Y.Doc();
      try { Y.applyUpdate(recovery, bytes); expect(recovery.store.clients.size).toBeGreaterThan(0); }
      finally { recovery.destroy(); }
      await testInfo.attach('guest editor after revocation', { body: await writer.screenshot(), contentType: 'image/png' });
    } finally {
      if (workspaceId) {
        const headers = { 'x-canvas-workspace-id': workspaceId, Origin: BASE_URL };
        for (const invitation of invitations) await owner.request.delete(`/api/security/file-guests/${invitation.id}`, {
          headers, data: { policyRevision: invitation.policyRevision },
        }).catch(() => undefined);
        await owner.request.delete('/api/files/delete', { headers, data: { path: filePath } }).catch(() => undefined);
      }
      await Promise.all([ownerContext.close(), writerContext.close(), readerContext.close()]);
    }
  });
});
