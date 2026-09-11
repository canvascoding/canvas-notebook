import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile as writeTestFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { JSONContent } from '@tiptap/core';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const SECONDARY_EMAIL = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL || '';
const SECONDARY_PASSWORD = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD || '';
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';

type WorkspacePayload = {
  workspaces?: WorkspaceSummary[];
  error?: string;
};

type WorkspaceSummary = {
  id: string;
  type: 'personal' | 'organization' | 'team' | 'project';
  name: string;
  rootRelativePath?: string;
  organizationId?: string | null;
  customerId?: string | null;
  projectId?: string | null;
  legacy?: boolean;
  permissions: {
    canWrite: boolean;
    canDelete?: boolean;
    canCreatePublicLinks?: boolean;
  };
};

type AgentToolResult = {
  content?: Array<{ type: string; text?: string }>;
  details?: Record<string, unknown>;
};

type LayoutSample = { viewportTop: number; editorOffset: number; savePanelVisible: boolean };
type ObservedEditor = HTMLElement & {
  editor: { getJSON(): JSONContent };
  layoutProbe?: { observer: MutationObserver; samples: LayoutSample[] };
};

const execFileAsync = promisify(execFile);

async function fixtureContext(browser: Browser): Promise<BrowserContext> {
  const { baseURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } = test.info().project.use;
  return browser.newContext({ baseURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor });
}

async function login(page: Page, email: string, password: string): Promise<string> {
  expect(Boolean(email && password), 'The managed fixture credentials must be configured.').toBe(true);
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: BASE_URL },
    data: { email, password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const session = await page.request.get('/api/auth/get-session');
  expect(session.ok()).toBe(true);
  const userId = (await session.json()).user?.id;
  expect(typeof userId).toBe('string');
  return userId;
}

async function organizationWorkspace(request: APIRequestContext): Promise<string> {
  return (await organizationWorkspaceDetails(request)).id;
}

async function organizationWorkspaceDetails(request: APIRequestContext): Promise<WorkspaceSummary> {
  const response = await request.get('/api/workspaces');
  const payload = await response.json() as WorkspacePayload;
  expect(response.ok(), payload.error || 'Could not list team workspaces').toBeTruthy();
  const workspace = payload.workspaces?.find((candidate) => (
    candidate.name === 'Shared Test Workspace' && candidate.permissions.canWrite
  ));
  expect(workspace, 'The managed Shared Test Workspace fixture must be writable.').toBeTruthy();
  return workspace!;
}

async function useWorkspace(context: BrowserContext, workspaceId: string): Promise<void> {
  await context.addInitScript((id) => {
    window.localStorage.setItem('canvas.activeWorkspaceId', id);
    window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspaceId);
}

async function openCollaborativeMarkdown(page: Page, filePath: string): Promise<void> {
  await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
  await expect(page.getByLabel(/Live text-ready|Live-Text vorbereitet/i)).toHaveCount(0);
}

function logBrowserDiagnostics(page: Page, label: string): string[] {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => {
    browserErrors.push(`[${label}] page error: ${error.message}`);
    console.error(`[${label}] page error:`, error);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      if (message.type() === 'error') browserErrors.push(`[${label}] console error: ${message.text()}`);
      console.error(`[${label}] console ${message.type()}:`, message.text());
    }
  });
  page.on('websocket', (websocket) => {
    console.info(`[${label}] websocket opened: ${websocket.url()}`);
    websocket.on('socketerror', (error) => console.error(`[${label}] websocket error:`, error));
    websocket.on('close', () => console.info(`[${label}] websocket closed: ${websocket.url()}`));
  });
  return browserErrors;
}

async function collaborativeEditorText(editor: Locator): Promise<string> {
  return editor.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.collaboration-carets__label').forEach((label) => label.remove());
    return clone.textContent || '';
  });
}

async function runAgentTool(input: {
  toolName: 'read' | 'edit_file' | 'apply_patch';
  toolCallId: string;
  params: Record<string, unknown>;
  context: Record<string, unknown>;
}): Promise<AgentToolResult> {
  const encoded = Buffer.from(JSON.stringify(input)).toString('base64url');
  const executable = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const { stdout } = await execFileAsync(
    executable,
    ['--conditions', 'react-server', 'scripts/collaboration-agent-tool-driver.ts', encoded],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as AgentToolResult;
}

test.describe('Markdown live collaboration', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the explicit Postgres team E2E profile.');
  test.setTimeout(120_000);

  test('deletes and moves blocks across peers without save rows or layout shifts', async ({ browser }) => {
    const filePath = `collaboration-quiet-blocks-${randomUUID()}.md`;
    const ownerContext = await fixtureContext(browser);
    const peerContext = await fixtureContext(browser);
    const owner = await ownerContext.newPage();
    const peer = await peerContext.newPage();
    const errors = logBrowserDiagnostics(owner, 'quiet-owner');
    const peerErrors = logBrowserDiagnostics(peer, 'quiet-peer');
    let workspaceId: string | null = null;
    try {
      const ownerId = await login(owner, ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(await login(peer, SECONDARY_EMAIL, SECONDARY_PASSWORD)).not.toBe(ownerId);
      workspaceId = await organizationWorkspace(owner.request);
      expect(await organizationWorkspace(peer.request)).toBe(workspaceId);
      await useWorkspace(ownerContext, workspaceId);
      await useWorkspace(peerContext, workspaceId);
      const headers = { [WORKSPACE_ID_HEADER]: workspaceId };
      const uploaded = await owner.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
        name: filePath, mimeType: 'text/markdown', buffer: Buffer.from('Alpha\n\nRemove block\n\nCharlie\n\nDelta'),
      } } });
      expect(uploaded.ok(), await uploaded.text()).toBe(true);
      await Promise.all([openCollaborativeMarkdown(owner, filePath), openCollaborativeMarkdown(peer, filePath)]);
      const editor = owner.locator('.tiptap-editor-shell .ProseMirror');
      const peerEditor = peer.locator('.tiptap-editor-shell .ProseMirror');
      const tree = (target: Locator) => target.evaluate((element) => (element as ObservedEditor).editor.getJSON());
      await expect.poll(() => collaborativeEditorText(peerEditor)).toBe('AlphaRemove blockCharlieDelta');
      const initial = (await tree(editor)).content!;
      const ids = initial.map((block) => block.attrs?.id);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
      await editor.getByText('Alpha', { exact: true }).click();
      await owner.keyboard.press('End');
      await editor.evaluate((element) => {
        const target = element as ObservedEditor;
        const viewport = element.closest('[data-testid="markdown-scroll-container"]')!;
        const samples: LayoutSample[] = [];
        const sample = () => samples.push({ viewportTop: viewport.getBoundingClientRect().top,
          // Keyboard/click navigation legitimately scrolls the document.
          editorOffset: element.getBoundingClientRect().top + viewport.scrollTop,
          savePanelVisible: Boolean(document.querySelector('[data-testid="markdown-save-state"]')) });
        const observer = new MutationObserver(sample);
        observer.observe(document.body, { attributes: true, childList: true, subtree: true, characterData: true });
        sample(); target.layoutProbe = { observer, samples };
      });
      await owner.keyboard.insertText(' updated');
      await expect.poll(() => collaborativeEditorText(peerEditor)).toContain('Alpha updated');
      await peerEditor.getByText('Charlie', { exact: true }).click();
      await peer.keyboard.press('End');
      await peer.keyboard.insertText(' remotely');
      await expect.poll(() => collaborativeEditorText(editor)).toContain('Charlie remotely');

      const removedParagraph = editor.getByText('Remove block', { exact: true });
      await removedParagraph.click();
      await removedParagraph.evaluate((element) => {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      });
      await expect.poll(() => owner.evaluate(() => getSelection()?.toString())).toBe('Remove block');
      await owner.keyboard.press('Backspace');
      await owner.keyboard.press('Backspace');
      await expect.poll(async () => (await tree(editor)).content!.map((block) => block.attrs?.id)).toEqual([ids[0], ids[2], ids[3]]);
      await editor.getByText('Delta', { exact: true }).click();
      await owner.keyboard.press('Alt+Shift+ArrowUp');
      await expect.poll(async () => (await tree(editor)).content!.map((block) => block.attrs?.id)).toEqual([ids[0], ids[3], ids[2]]);
      const moved = await tree(editor);
      await expect.poll(() => tree(peerEditor)).toEqual(moved);
      await expect.poll(() => collaborativeEditorText(peerEditor)).toBe('Alpha updatedDeltaCharlie remotely');
      await expect.poll(async () => {
        const response = await owner.request.get('/api/files/read', { headers, params: { path: filePath } });
        return (await response.json()).data?.content?.trim();
      }, { timeout: 20_000 }).toBe('Alpha updated\n\nDelta\n\nCharlie remotely');
      const samples = await editor.evaluate((element) => {
        const probe = (element as ObservedEditor).layoutProbe!;
        probe.observer.disconnect(); return probe.samples;
      });
      expect(samples.length).toBeGreaterThan(1);
      expect(samples.every((sample) => !sample.savePanelVisible)).toBe(true);
      expect(Math.max(...samples.map((sample) => Math.abs(sample.viewportTop - samples[0].viewportTop)))).toBeLessThanOrEqual(1);
      expect(Math.max(...samples.map((sample) => Math.abs(sample.editorOffset - samples[0].editorOffset)))).toBeLessThanOrEqual(1);
      await owner.reload({ waitUntil: 'domcontentloaded' });
      await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      await expect.poll(() => tree(editor)).toEqual(moved);
      await expect(owner.getByTestId('markdown-save-state')).toHaveCount(0);
      await owner.goto(`/notebook?path=${encodeURIComponent(filePath)}&collaborationDebug=1`, { waitUntil: 'domcontentloaded' });
      const diagnostics = owner.getByTestId('markdown-save-state');
      await expect(diagnostics).toHaveAttribute('aria-label', /Developer diagnostics|Entwicklerdiagnose/i);
      await expect(diagnostics).toHaveCSS('position', 'absolute');
      await expect(diagnostics.getByRole('alert')).toHaveCount(0);
      await expect.poll(() => tree(editor)).toEqual(moved);
      expect([...errors, ...peerErrors]).toEqual([]);
    } finally {
      await peerContext.close();
      if (workspaceId) await owner.request.delete('/api/files/delete', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
      }).catch(() => undefined);
      await ownerContext.close();
    }
  });

  test('converges across clients, exposes presence, reconnects, and checkpoints the file', async ({ browser }, testInfo) => {
    const suffix = `${Date.now()}-${randomUUID()}`;
    const filePath = `collaboration-e2e-${suffix}.md`;
    const adminContext = await fixtureContext(browser);
    const memberContext = await fixtureContext(browser);
    const adminPage = await adminContext.newPage();
    const memberPage = await memberContext.newPage();
    const adminBrowserErrors = logBrowserDiagnostics(adminPage, 'admin');
    const memberBrowserErrors = logBrowserDiagnostics(memberPage, 'member');
    let duplicateBrowserErrors: string[] = [];
    let adminWorkspaceId: string | null = null;

    try {
      const adminId = await login(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(await login(memberPage, SECONDARY_EMAIL, SECONDARY_PASSWORD)).not.toBe(adminId);
      const workspaceId = await organizationWorkspace(adminPage.request);
      adminWorkspaceId = workspaceId;
      const memberWorkspaceId = await organizationWorkspace(memberPage.request);
      expect(memberWorkspaceId).toBe(workspaceId);
      await useWorkspace(adminContext, workspaceId);
      await useWorkspace(memberContext, memberWorkspaceId);

      const createFileResponse = await adminPage.request.post('/api/files/create', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { path: filePath, type: 'file' },
      });
      expect(createFileResponse.ok(), await createFileResponse.text()).toBeTruthy();

      await Promise.all([
        openCollaborativeMarkdown(adminPage, filePath),
        openCollaborativeMarkdown(memberPage, filePath),
      ]);

      const adminEditor = adminPage.locator('.tiptap-editor-shell .ProseMirror');
      const memberEditor = memberPage.locator('.tiptap-editor-shell .ProseMirror');
      await adminEditor.click();
      await adminEditor.pressSequentially('Alice writes live', { delay: 20 });
      await expect.poll(() => collaborativeEditorText(memberEditor), { timeout: 15_000 })
        .toBe('Alice writes live');

      const adminCaretOnMember = memberEditor.locator('.collaboration-carets__caret').first();
      await expect(adminCaretOnMember).toBeVisible({ timeout: 15_000 });
      await expect(adminCaretOnMember).toHaveAttribute(
        'aria-label',
        /is editing here|bearbeitet hier/i,
      );
      await adminCaretOnMember.hover();
      await expect.poll(
        () => adminCaretOnMember.locator('.collaboration-carets__label').evaluate(
          (element) => getComputedStyle(element).opacity,
        ),
        { timeout: 5_000 },
      ).toBe('1');
      const caretVisual = await adminCaretOnMember.locator('.collaboration-carets__needle').evaluate((element) => {
        const caret = getComputedStyle(element);
        return {
          animationName: caret.animationName,
          reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          width: caret.width,
        };
      });
      if (caretVisual.reducedMotion) {
        expect(caretVisual.animationName).toBe('none');
      } else {
        expect(caretVisual.animationName).toContain('collaboration-caret-blink');
      }
      expect(caretVisual.width).toBe('2px');

      await memberEditor.click();
      await memberPage.keyboard.press('ControlOrMeta+A');
      const memberSelectionOnAdmin = adminEditor.locator('.collaboration-carets__selection').first();
      await expect(memberSelectionOnAdmin).toBeVisible({ timeout: 15_000 });
      const selectionVisual = await memberSelectionOnAdmin.evaluate((element) => ({
        background: getComputedStyle(element).backgroundImage,
        borderBottomWidth: getComputedStyle(element).borderBottomWidth,
      }));
      expect(selectionVisual.background).toContain('linear-gradient');
      expect(selectionVisual.borderBottomWidth).toBe('1px');
      await memberPage.keyboard.insertText('Alice writes live and Bob replies');
      await expect.poll(() => collaborativeEditorText(adminEditor), { timeout: 15_000 })
        .toBe('Alice writes live and Bob replies');

      const fileRow = adminPage.locator(`[data-file-path="${filePath}"]`).first();
      const presence = fileRow.locator('[aria-label^="Active collaborators:"]');
      await expect(presence).toBeVisible({ timeout: 15_000 });
      await expect(presence).toHaveAttribute('aria-label', /: editing/i);

      const duplicateAdminPage = await adminContext.newPage();
      duplicateBrowserErrors = logBrowserDiagnostics(duplicateAdminPage, 'admin-second-tab');
      await openCollaborativeMarkdown(duplicateAdminPage, filePath);
      await expect.poll(async () => {
        const response = await adminPage.request.get(
          `/api/files/presence?workspaceId=${encodeURIComponent(workspaceId)}`,
        );
        const payload = await response.json() as {
          entries?: Array<{ path: string; actorType: string; userId: string }>;
        };
        const fileUsers = (payload.entries || []).filter((entry) => (
          entry.path === filePath && entry.actorType === 'user'
        ));
        return {
          entries: fileUsers.length,
          uniqueUsers: new Set(fileUsers.map((entry) => entry.userId)).size,
        };
      }, { timeout: 15_000 }).toEqual({ entries: 2, uniqueUsers: 2 });
      await duplicateAdminPage.close();
      await expect.poll(async () => {
        const response = await adminPage.request.get(
          `/api/files/presence?workspaceId=${encodeURIComponent(workspaceId)}`,
        );
        const payload = await response.json() as {
          entries?: Array<{ path: string; actorType: string; userId: string }>;
        };
        return (payload.entries || []).filter((entry) => (
          entry.path === filePath && entry.actorType === 'user'
        )).length;
      }, { timeout: 15_000 }).toBe(2);

      const viewportFit = await adminPage.evaluate(() => {
        const editorViewport = document.querySelector('[data-testid="markdown-scroll-container"]');
        const modeBar = document.querySelector('.markdown-mode-bar');
        const requiredRegions = [editorViewport, modeBar].map((element) => element?.getBoundingClientRect());
        return {
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          requiredRegions: requiredRegions.map((rect) => rect ? ({
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          }) : null),
          requiredRegionsFit: requiredRegions.every((rect) => (
            rect && rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight
          )),
        };
      });
      const memberCaretOnAdmin = adminEditor.locator('.collaboration-carets__caret').first();
      await expect(memberCaretOnAdmin).toBeVisible({ timeout: 15_000 });
      await memberCaretOnAdmin.hover();
      await expect(memberCaretOnAdmin).toHaveAttribute('data-label-side', /^(left|right)$/);
      const labelBounds = await memberCaretOnAdmin.locator('.collaboration-carets__label').evaluate((element) => {
        const labelRect = element.getBoundingClientRect();
        const editorRect = element.closest('.tiptap-editor-shell')?.getBoundingClientRect();
        return {
          labelLeft: labelRect.left,
          labelRight: labelRect.right,
          editorLeft: editorRect?.left ?? 0,
          editorRight: editorRect?.right ?? window.innerWidth,
        };
      });
      expect(labelBounds.labelLeft).toBeGreaterThanOrEqual(labelBounds.editorLeft);
      expect(labelBounds.labelRight).toBeLessThanOrEqual(labelBounds.editorRight);
      await expect.poll(
        () => memberCaretOnAdmin.locator('.collaboration-carets__label').evaluate(
          (element) => getComputedStyle(element).opacity,
        ),
        { timeout: 5_000 },
      ).toBe('1');
      const liveStateScreenshot = testInfo.outputPath('live-collaboration.png');
      await adminPage.screenshot({ path: liveStateScreenshot, type: 'png' });
      await testInfo.attach('live collaboration UI', { path: liveStateScreenshot, contentType: 'image/png' });
      expect(viewportFit.horizontalOverflow).toBe(false);
      expect(viewportFit.requiredRegionsFit, JSON.stringify(viewportFit)).toBe(true);

      await memberPage.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(
        () => collaborativeEditorText(memberPage.locator('.tiptap-editor-shell .ProseMirror')),
        { timeout: 30_000 },
      ).toBe('Alice writes live and Bob replies');
      await expect(memberPage.locator('.tiptap-editor-shell .ProseMirror')).toHaveAttribute('contenteditable', 'true');
      await expect(memberPage.getByTestId('markdown-save-state')).toHaveCount(0);

      await expect.poll(async () => {
        const response = await adminPage.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        });
        if (!response.ok()) return '';
        const payload = await response.json() as { data?: { content?: string; stats?: { sha256?: string } } };
        return payload.data?.content || '';
      }, { timeout: 20_000 }).toContain('Alice writes live and Bob replies');

      const readResponse = await adminPage.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
      });
      const readPayload = await readResponse.json() as { data?: { stats?: { sha256?: string } } };
      const blockedWrite = await adminPage.request.post('/api/files/write', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: {
          path: filePath,
          content: 'This whole-file write must not replace the CRDT document.',
          expectedSha256: readPayload.data?.stats?.sha256,
        },
      });
      const blockedPayload = await blockedWrite.json() as { code?: string };
      expect(blockedWrite.status()).toBe(409);
      expect(blockedPayload.code).toBe('COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED');

      expect(
        [...adminBrowserErrors, ...memberBrowserErrors, ...duplicateBrowserErrors],
        'Collaboration UI must not emit browser errors.',
      ).toEqual([]);

      await memberContext.close();
      await expect.poll(async () => {
        const response = await adminPage.request.get(`/api/files/presence?workspaceId=${encodeURIComponent(workspaceId)}`);
        const payload = await response.json() as { entries?: Array<{ path: string; actorType: string; userId: string }> };
        return (payload.entries || []).filter((entry) => entry.path === filePath && entry.actorType === 'user').map((entry) => entry.userId);
      }, { timeout: 15_000 }).toEqual([adminId]);
    } finally {
      if (adminWorkspaceId && !adminPage.isClosed()) {
        await adminPage.request.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: adminWorkspaceId },
          data: { path: filePath },
        }).catch(() => undefined);
      }
      await memberContext.close().catch(() => undefined);
      await adminContext.close();
    }
  });

  test('two fixture users coauthor while real agent tools create, accept and reject exact reviews', async ({ browser }, testInfo) => {
    const suffix = `${Date.now()}-${randomUUID()}`;
    const filePath = `collaboration-agent-review-${suffix}.md`;
    const context = await fixtureContext(browser);
    const page = await context.newPage();
    const peerContext = await fixtureContext(browser);
    const peer = await peerContext.newPage();
    const browserErrors = logBrowserDiagnostics(page, 'agent-review');
    const peerErrors = logBrowserDiagnostics(peer, 'agent-review-peer');
    let workspaceId: string | null = null;
    let storedSessionId: string | null = null;
    let storedAgentId: string | null = null;

    try {
      const ownerId = await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(await login(peer, SECONDARY_EMAIL, SECONDARY_PASSWORD)).not.toBe(ownerId);
      const workspace = await organizationWorkspaceDetails(page.request);
      workspaceId = workspace.id;
      expect(await organizationWorkspace(peer.request)).toBe(workspaceId);
      await useWorkspace(context, workspaceId);
      await useWorkspace(peerContext, workspaceId);
      const emptyRejectResponse = await page.request.post(
        '/api/files/collaboration/operations/missing-operation/reject',
        { headers: { [WORKSPACE_ID_HEADER]: workspaceId } },
      );
      expect(emptyRejectResponse.status()).toBe(400);
      await expect(emptyRejectResponse.json()).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/valid JSON body/i),
      });

      const initialContent = '# Agent review\n\nRemove this paragraph\n\nKeep this paragraph\n\nFinal paragraph';
      expect(workspace.rootRelativePath).toBeTruthy();
      const workspaceRoot = path.resolve(process.env.DATA || 'data', workspace.rootRelativePath!);
      await writeTestFile(path.join(workspaceRoot, filePath), initialContent, 'utf8');

      await openCollaborativeMarkdown(page, filePath);
      await openCollaborativeMarkdown(peer, filePath);
      const peerEditor = peer.locator('.tiptap-editor-shell .ProseMirror');
      const sessionResponse = await page.request.get('/api/auth/get-session');
      const sessionPayload = await sessionResponse.json() as { user?: { id?: string } };
      expect(sessionPayload.user?.id).toBeTruthy();
      const createdSession = await page.request.post('/api/sessions', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { agentId: 'canvas-agent', workspaceId, title: 'Collaboration browser acceptance' },
      });
      expect(createdSession.ok(), 'The agent session must be created through the real runtime API.').toBe(true);
      const storedSession = (await createdSession.json()).session;
      storedSessionId = storedSession?.sessionId as string;
      storedAgentId = storedSession?.agentId as string;
      expect(storedSessionId).toBeTruthy();
      expect(storedAgentId).toBeTruthy();
      const agentContext = {
        userId: sessionPayload.user!.id!,
        sessionId: storedSessionId,
        agentId: storedAgentId,
        workspaceId,
        workspaceType: workspace.type,
        workspaceName: workspace.name,
        organizationId: workspace.organizationId || null,
        customerId: workspace.customerId || null,
        projectId: workspace.projectId || null,
        workspaceRoot,
        workspaceRootRelativePath: workspace.rootRelativePath || null,
        canWrite: true,
        canDelete: workspace.permissions.canDelete !== false,
        canShare: workspace.permissions.canCreatePublicLinks !== false,
        legacy: Boolean(workspace.legacy),
      };

      const readResult = await runAgentTool({
        toolName: 'read',
        toolCallId: `read-live-${suffix}`,
        params: { path: filePath },
        context: agentContext,
      });
      const liveSha256 = String((readResult.details as { sha256?: string } | undefined)?.sha256 || '');
      expect(liveSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(readResult.content?.[0]?.text).toContain('Source: live Yjs collaboration state');

      const editResult = await runAgentTool({
        toolName: 'edit_file',
        toolCallId: `edit-structural-${suffix}`,
        params: {
          path: filePath,
          expectedSha256: liveSha256,
          oldText: '# Agent review\n\nRemove this paragraph\n\n',
          newText: '',
        },
        context: agentContext,
      });
      const editDetails = editResult.details as {
        collaboration?: { operationId?: string; reviewRequired?: boolean; operationStatus?: string };
      };
      expect(editDetails.collaboration?.reviewRequired).toBe(true);
      expect(editDetails.collaboration?.operationStatus).toBe('needs_review');
      expect(readResult.content?.[0]?.text).toContain(initialContent);
      expect(editResult.content?.[0]?.text).toContain('Review ready');
      const operationUrl = `/api/files/collaboration/operations/${editDetails.collaboration!.operationId}`;
      const initialReview = await page.request.get(operationUrl, { headers: { [WORKSPACE_ID_HEADER]: workspaceId } });
      expect(initialReview.ok()).toBe(true);
      const initialProposalVersion = (await initialReview.json()).operation.proposalVersion as string;
      expect(initialProposalVersion).toMatch(/^v1\.[a-f0-9]{64}$/u);

      const agentActivityButton = page.getByRole('button', { name: /Agent changes|Agentenänderungen/i });
      await expect(agentActivityButton).toBeVisible({ timeout: 20_000 });
      await agentActivityButton.click();
      const reviewRegion = page.getByRole('region', { name: /Agent changes|Agentenänderungen/i });
      await expect(reviewRegion).toBeVisible({ timeout: 20_000 });
      await expect(reviewRegion).toContainText(/Review required|Prüfung erforderlich/i);
      await expect(reviewRegion).toContainText('Remove this paragraph');

      const editor = page.locator('.tiptap-editor-shell .ProseMirror');
      await expect(editor.locator('.collaboration-agent-target').first()).toBeVisible();
      const unaffectedParagraph = peerEditor.locator('p').filter({ hasText: 'Keep this paragraph' }).first();
      await unaffectedParagraph.click();
      await peer.keyboard.press('End');
      await peer.keyboard.type(' edited by user');
      await expect.poll(() => collaborativeEditorText(editor)).toContain('Keep this paragraph edited by user');
      const independentEditReview = await page.request.get(operationUrl, { headers: { [WORKSPACE_ID_HEADER]: workspaceId } });
      expect((await independentEditReview.json()).operation.proposalVersion).toBe(initialProposalVersion);
      await expect(reviewRegion).toBeVisible();

      const acceptResponse = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && /\/api\/files\/collaboration\/operations\/[^/]+\/accept$/u.test(response.url())
      ));
      await reviewRegion.getByRole('button', { name: /Accept|Annehmen/i }).click();
      const acceptedOperationResponse = await acceptResponse;
      expect(acceptedOperationResponse.request().postDataJSON()).toMatchObject({ proposalVersion: initialProposalVersion });
      expect(acceptedOperationResponse.ok(), await acceptedOperationResponse.text()).toBeTruthy();
      const acceptedOperationPayload = await acceptedOperationResponse.json();
      expect(acceptedOperationPayload).toMatchObject({
        success: true,
        operation: {
          operationStatus: expect.stringMatching(/^(persisted_yjs|checkpointed_file)$/u),
          durability: expect.stringMatching(/^(persisted_yjs|checkpointed_file)$/u),
          conflicts: [],
        },
      });
      await expect.poll(() => collaborativeEditorText(editor), { timeout: 20_000 }).not.toContain('Remove this paragraph');
      await expect.poll(() => collaborativeEditorText(editor)).toContain('Keep this paragraph edited by user');
      await expect.poll(() => collaborativeEditorText(peerEditor)).toBe(await collaborativeEditorText(editor));
      await expect(editor.locator('.collaboration-agent-target')).toHaveCount(0, { timeout: 20_000 });
      await expect(reviewRegion.getByRole('button', { name: /Accept|Annehmen/i })).toHaveCount(0, { timeout: 20_000 });

      const acceptedRead = await runAgentTool({
        toolName: 'read',
        toolCallId: `read-after-accept-${suffix}`,
        params: { path: filePath },
        context: agentContext,
      });
      const acceptedSha256 = String((acceptedRead.details as { sha256?: string } | undefined)?.sha256 || '');
      const patchResult = await runAgentTool({
        toolName: 'apply_patch',
        toolCallId: `patch-structural-${suffix}`,
        params: {
          files: [{
            path: filePath,
            expectedSha256: acceptedSha256,
            edits: [{
              oldText: 'Keep this paragraph edited by user\n\nFinal paragraph',
              newText: 'Combined paragraph',
            }],
          }],
        },
        context: agentContext,
      });
      const patchDetails = patchResult.details as {
        results?: Array<{ collaboration?: { operationId?: string; reviewRequired?: boolean; operationStatus?: string } }>;
      };
      expect(patchDetails.results?.[0]?.collaboration?.reviewRequired).toBe(true);
      expect(patchDetails.results?.[0]?.collaboration?.operationStatus).toBe('needs_review');
      expect(patchResult.content?.[0]?.text).toContain('Review ready');
      await expect(reviewRegion).toContainText('Combined paragraph', { timeout: 20_000 });

      const screenshotPath = testInfo.outputPath('agent-review.png');
      await page.screenshot({ path: screenshotPath, type: 'png' });
      await testInfo.attach('agent review UI', { path: screenshotPath, contentType: 'image/png' });

      const patchUrl = `/api/files/collaboration/operations/${patchDetails.results![0].collaboration!.operationId}`;
      const patchReview = await page.request.get(patchUrl, { headers: { [WORKSPACE_ID_HEADER]: workspaceId } });
      expect(patchReview.ok()).toBe(true);
      const staleProposalVersion = (await patchReview.json()).operation.proposalVersion as string;
      expect(staleProposalVersion).toMatch(/^v1\.[a-f0-9]{64}$/u);
      await peerEditor.locator('p').filter({ hasText: /^Final paragraph$/u }).click();
      await peer.keyboard.press('End');
      await peer.keyboard.insertText(' updated after preview');
      await expect.poll(() => collaborativeEditorText(editor)).toContain('Final paragraph updated after preview');
      const contentAfterHumanEdit = await collaborativeEditorText(editor);
      await expect.poll(async () => {
        const changedReview = await page.request.get(patchUrl, { headers: { [WORKSPACE_ID_HEADER]: workspaceId! } });
        expect(changedReview.ok()).toBe(true);
        return (await changedReview.json()).operation.proposalVersion;
      }, { timeout: 20_000 }).toBeNull();
      const staleAcceptance = await page.request.post(`${patchUrl}/accept`, {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { idempotencyKey: `stale-accept-${suffix}`, proposalVersion: staleProposalVersion },
      });
      expect(staleAcceptance.status()).toBe(409);
      expect(await staleAcceptance.json()).toMatchObject({ code: 'AGENT_PROPOSAL_CHANGED' });
      expect(await collaborativeEditorText(editor)).toBe(contentAfterHumanEdit);
      await expect(reviewRegion).toBeVisible();
      await expect(reviewRegion.getByRole('button', { name: /Accept|Annehmen/i })).toHaveCount(0, { timeout: 20_000 });

      await reviewRegion.getByRole('button', { name: /Reject|Ablehnen/i }).click();
      await expect.poll(() => collaborativeEditorText(editor)).toContain('Keep this paragraph edited by user');
      await expect.poll(() => collaborativeEditorText(editor)).not.toContain('Combined paragraph');
      await expect(reviewRegion.getByRole('button', { name: /Reject|Ablehnen/i }))
        .toHaveCount(0, { timeout: 20_000 });

      // A rich Y.Doc can validly retain Markdown that the conservative source
      // codec classifies as source-only. This models an agent review that adds
      // an Obsidian comment after the document already has a rich Yjs identity.
      const sourceOnlyRead = await runAgentTool({
        toolName: 'read',
        toolCallId: `read-source-only-${suffix}`,
        params: { path: filePath },
        context: agentContext,
      });
      const sourceOnlySha256 = String((sourceOnlyRead.details as { sha256?: string } | undefined)?.sha256 || '');
      const sourceOnlyPatch = await runAgentTool({
        toolName: 'apply_patch',
        toolCallId: `patch-source-only-${suffix}`,
        params: {
          files: [{
            path: filePath,
            expectedSha256: sourceOnlySha256,
            edits: [{
              oldText: 'Keep this paragraph edited by user\n\nFinal paragraph updated after preview',
              newText: 'Keep this paragraph edited by user\n\nFinal paragraph updated after preview\n\n%% agent-generated note %%',
            }],
          }],
        },
        context: agentContext,
      });
      const sourceOnlyDetails = sourceOnlyPatch.details as {
        results?: Array<{ collaboration?: { operationStatus?: string } }>;
      };
      expect(sourceOnlyDetails.results?.[0]?.collaboration?.operationStatus).toBe('needs_review');
      const sourceOnlyAccept = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && /\/api\/files\/collaboration\/operations\/[^/]+\/accept$/u.test(response.url())
      ));
      await reviewRegion.getByRole('button', { name: /Accept|Annehmen/i }).click();
      expect((await sourceOnlyAccept).ok()).toBeTruthy();
      await expect.poll(() => collaborativeEditorText(editor), { timeout: 20_000 })
        .toContain('agent-generated note');

      // Opening a new editor is the regression boundary: it must resolve the
      // existing rich Yjs representation instead of selecting CodeMirror from
      // the source-only checkpoint text.
      await openCollaborativeMarkdown(page, filePath);
      const reopenedEditor = page.locator('.tiptap-editor-shell .ProseMirror');
      await expect.poll(() => collaborativeEditorText(reopenedEditor), { timeout: 20_000 })
        .toContain('agent-generated note');
      const reopenedDocument = await reopenedEditor.evaluate((element) => (element as ObservedEditor).editor.getJSON());
      await peer.reload({ waitUntil: 'domcontentloaded' });
      await peer.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(peerEditor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      await expect.poll(() => peerEditor.evaluate((element) => (element as ObservedEditor).editor.getJSON()), { timeout: 20_000 })
        .toEqual(reopenedDocument);
      await expect.poll(() => collaborativeEditorText(peerEditor), { timeout: 20_000 })
        .toBe(await collaborativeEditorText(reopenedEditor));
      expect([...browserErrors, ...peerErrors], 'Agent review UI must not emit browser errors.').toEqual([]);
    } finally {
      await peerContext.close();
      await page.close().catch(() => undefined);
      if (workspaceId) {
        if (storedSessionId && storedAgentId) await context.request.delete('/api/sessions', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId },
          params: { sessionId: storedSessionId, agentId: storedAgentId, workspaceId },
        });
        await context.request.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId },
          data: { path: filePath },
        }).catch(() => undefined);
      }
      await context.close();
    }
  });
});
