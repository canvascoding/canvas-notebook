import { expect, request, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile as writeTestFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { JSONContent } from '@tiptap/core';
import enMessages from '../messages/en.json';
import deMessages from '../messages/de.json';

import { createAuthenticatedContext, createCompletedWorkspaceMarkdownFile, enterMarkdownEditMode } from './helpers/managed-test-context';
import { deleteOwnedFixtureFiles } from './helpers/owned-fixture-files';
import { recoveredRoomReadUrls, roomReadConsoleMessage } from './helpers/recovered-room-read.mjs';
import { recoveredRichMigrationErrors } from './helpers/recovered-rich-migration.mjs';
import { waitForOwnedNotificationSummaryBudget } from './helpers/notification-summary-budget';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { aggregateOwnedNativeErrors } from './helpers/owned-native-command';
import { installOwnedCollaborationOutage } from './helpers/owned-collaboration-outage';
import { readNativeRichCandidate } from './helpers/native-rich-candidate';
import { readNativeRichLocalRecovery } from './helpers/native-rich-local-recovery';
import { nativeRichParagraph } from './helpers/native-rich-paragraph';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { ownedCollaborationQaEnabled, requireOwnedCollaborationQaTarget } from '../scripts/lib/owned-collaboration-qa';

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

async function fixtureContext(browser: Browser, secondary = false): Promise<BrowserContext> {
  const { baseURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } = test.info().project.use;
  return createAuthenticatedContext(
    browser,
    { baseURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor },
    { email: secondary ? SECONDARY_EMAIL : ADMIN_EMAIL, password: secondary ? SECONDARY_PASSWORD : ADMIN_PASSWORD },
  );
}

async function login(page: Page, email: string, password: string): Promise<string> {
  expect(Boolean(email && password), 'The managed fixture credentials must be configured.').toBe(true);
  let session = await page.request.get('/api/auth/get-session');
  let sessionPayload = session.ok() ? await session.json() as { user?: { id?: string } } : null;
  if (!sessionPayload?.user?.id) {
    const response = await page.request.post('/api/auth/sign-in/email', {
      headers: { Origin: BASE_URL },
      data: { email, password },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    session = await page.request.get('/api/auth/get-session');
    sessionPayload = session.ok() ? await session.json() as { user?: { id?: string } } : null;
  }
  expect(session.ok()).toBe(true);
  const userId = sessionPayload?.user?.id;
  if (!userId) throw new Error('Authenticated managed fixture session is missing its user ID.');
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
  await enterMarkdownEditMode(page);
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
      const unsupportedViewportHint = page.context().browser()?.browserType().name() === 'webkit'
        && message.text() === 'Viewport argument key "interactive-widget" not recognized and ignored.';
      if (unsupportedViewportHint) {
        console.warn(`[${label}] unsupported browser viewport hint:`, message.text());
        return;
      }
      if (message.type() === 'error') browserErrors.push(`[${label}] console error: ${message.text()} [${message.location().url}]`);
      console.error(`[${label}] console ${message.type()}:`, message.text());
    }
  });
  page.on('websocket', (websocket) => {
    const socketUrl = new URL(websocket.url());
    socketUrl.search = ''; socketUrl.hash = '';
    console.info(`[${label}] websocket opened: ${socketUrl.href}`);
    websocket.on('socketerror', (error) => console.error(`[${label}] websocket error:`, error));
    websocket.on('close', () => console.info(`[${label}] websocket closed: ${socketUrl.href}`));
  });
  page.on('response', (response) => {
    if (response.status() === 404) console.info(`[${label}] 404 response: ${response.url()}`);
    if (response.status() === 429) {
      console.info(`[${label}] 429 response: ${response.request().method()} ${response.url()}`);
    }
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
      // This fixture covers the legacy operation review adapter explicitly.
      // Current graph review is covered by the dedicated graph UI specs.
      env: { ...process.env, CANVAS_PROPOSAL_GRAPH_MODE: 'off' },
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as AgentToolResult;
}

async function deleteFixtureFiles(api: APIRequestContext, workspaceId: string, paths: string[]): Promise<void> {
  await deleteOwnedFixtureFiles(api, workspaceId, paths);
}

async function finishFixture(api: APIRequestContext, actions: Array<() => Promise<unknown>>, failure: unknown): Promise<void> {
  const cleanupErrors: unknown[] = [];
  for (const action of [...actions, () => api.dispose()]) {
    try { await action(); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) {
    if (failure) for (const error of cleanupErrors) console.error('Live collaboration fixture cleanup failed:', error);
    else throw new AggregateError(cleanupErrors, 'Live collaboration fixture cleanup failed.');
  }
}

test.describe('Markdown live collaboration', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the explicit Postgres team E2E profile.');
  test.setTimeout(120_000);

  test.beforeAll(async ({ browser }) => {
    if (!ownedCollaborationQaEnabled()) return;
    test.setTimeout(150_000);
    await requireOwnedCollaborationQaTarget();
    expect(browser.contexts().flatMap((context) => context.pages()),
      'The QA notification quiet window requires all Notebook pages to be closed.').toHaveLength(0);
    const context = await fixtureContext(browser);
    let failure: unknown;
    try {
      await waitForOwnedNotificationSummaryBudget(context.request);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await context.close();
      } catch (cleanupError) {
        throw aggregateOwnedNativeErrors(failure, [cleanupError], 'Notification preflight context cleanup failed.');
      }
    }
  });

  test('closes and switches away while collaboration is still joining', async ({ browser }) => {
    const suffix = randomUUID();
    const joiningPath = `collaboration-joining-${suffix}.md`;
    const readyPath = `collaboration-ready-${suffix}.md`;
    const context = await fixtureContext(browser);
    const cleanupApi = await request.newContext({ baseURL: BASE_URL,
      storageState: await context.storageState(), timeout: 15_000 });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = logBrowserDiagnostics(page, 'joining-navigation');
    const joinReleases: Array<() => void> = [];
    let joinAttempts = 0;
    let workspaceId: string | null = null;
    let failure: unknown;
    const releasePendingJoins = () => joinReleases.splice(0).forEach((release) => release());

    try {
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      workspaceId = await organizationWorkspace(page.request);
      await useWorkspace(context, workspaceId);
      for (const filePath of [joiningPath, readyPath]) {
        await createCompletedWorkspaceMarkdownFile({ request: page.request, workspaceId, filePath });
      }

      await page.route('**/api/files/collaboration/session', async (route) => {
        let body: { path?: string } = {};
        try { body = route.request().postDataJSON() as { path?: string }; }
        catch { /* Let malformed or unrelated requests reach the application. */ }
        if (body.path !== joiningPath) {
          await route.continue();
          return;
        }
        joinAttempts += 1;
        await new Promise<void>((resolve) => joinReleases.push(resolve));
        await route.continue().catch(() => undefined);
      });

      await openCollaborativeMarkdown(page, readyPath);
      const readyTab = page.getByRole('tab', { name: readyPath, exact: true });
      await expect(readyTab).toHaveAttribute('aria-selected', 'true');
      const showSidebar = page.getByRole('button', { name: /^(Show sidebar|Sidebar einblenden)$/u });
      if (await showSidebar.isVisible()) await showSidebar.click();
      const joiningFile = page.locator(`[data-file-path="${joiningPath}"]`).first();
      await expect(joiningFile).toBeVisible();

      await joiningFile.dblclick();
      await expect.poll(() => joinAttempts).toBe(1);
      const firstJoiningTab = page.getByRole('tab', { name: joiningPath, exact: true });
      await expect(firstJoiningTab).toHaveAttribute('aria-selected', 'true');
      await page.getByRole('button', { name: 'Close preview' }).click();
      await expect(firstJoiningTab).toHaveCount(0, { timeout: 3_000 });
      await expect(readyTab).toHaveAttribute('aria-selected', 'true', { timeout: 3_000 });
      joinReleases.shift()?.();

      await joiningFile.dblclick();
      await expect.poll(() => joinAttempts).toBe(2);
      const secondJoiningTab = page.getByRole('tab', { name: joiningPath, exact: true });
      await expect(secondJoiningTab).toHaveAttribute('aria-selected', 'true');
      await readyTab.click();
      await expect(readyTab).toHaveAttribute('aria-selected', 'true', { timeout: 3_000 });
      await expect(secondJoiningTab).toHaveAttribute('aria-selected', 'false');
      joinReleases.shift()?.();
      await page.waitForTimeout(250);
      await expect(readyTab).toHaveAttribute('aria-selected', 'true');
      expect(errors).toEqual([]);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      releasePendingJoins();
      await finishFixture(cleanupApi, [
        () => context.close(),
        async () => { if (workspaceId) await deleteFixtureFiles(cleanupApi, workspaceId, [joiningPath, readyPath]); },
      ], failure);
    }
  });

  test('deletes and moves blocks across peers without save rows or layout shifts', async ({ browser }) => {
    const filePath = `collaboration-quiet-blocks-${randomUUID()}.md`;
    const ownerContext = await fixtureContext(browser);
    const peerContext = await fixtureContext(browser, true);
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
      await enterMarkdownEditMode(owner);
      const diagnostics = owner.getByTestId('markdown-save-state');
      const locale = await owner.locator('html').getAttribute('lang');
      const messages = locale?.startsWith('de') ? deMessages : enMessages;
      await expect(diagnostics).toHaveAttribute('aria-label', messages.notebook.editorModes.diagnostics);
      await expect(diagnostics).toHaveCSS('position', 'absolute');
      await expect(diagnostics.getByRole('alert')).toHaveCount(0);
      await expect.poll(() => tree(editor)).toEqual(moved);
      expect([...errors, ...peerErrors]).toEqual([]);
    } finally {
      await peerContext.close();
      await owner.close();
      if (workspaceId) await deleteOwnedFixtureFiles(ownerContext.request, workspaceId, [filePath]);
      await ownerContext.close();
    }
  });

  test('keeps remote labels inside table and viewport edges after scrolling and resizing', async ({ browser }, testInfo) => {
    const filePath = `collaboration-caret-bounds-${randomUUID()}.md`;
    const ownerContext = await fixtureContext(browser);
    const peerContext = await fixtureContext(browser, true);
    const owner = await ownerContext.newPage();
    const peer = await peerContext.newPage();
    const roomReads: Array<Promise<{ url: string; status: number; code?: string; documentId?: string; at: number }>> = [];
    const consoleErrors: Array<{ client: string; url: string; message: string; value: string }> = [];
    const migrationReads: Array<Promise<Record<string, unknown>>> = [];
    for (const [page, label] of [[owner, 'caret-owner'], [peer, 'caret-peer']] as const) {
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ client: label, url: message.location().url, message: message.text(), value: `[${label}] console error: ${message.text()} [${message.location().url}]` }); });
      page.on('response', response => {
        if (new URL(response.url()).pathname === '/api/files/collaboration/session' && response.request().method() === 'POST') {
          const at = Date.now();
          migrationReads.push((async () => {
            const payload = await response.json().catch(() => null);
            let requestBody;
            try { requestBody = response.request().postDataJSON(); } catch { requestBody = null; }
            return { client: label, url: response.url(), method: response.request().method(), status: response.status(), at,
              path: requestBody?.path, requestRepresentation: requestBody?.representation,
              requestMigration: requestBody?.migration, success: payload?.success, code: payload?.code,
              migration: payload?.migration, documentId: payload?.documentId,
              lifecycleGeneration: payload?.lifecycleGeneration, representation: payload?.representation,
              credentialFieldsPresent: !!payload && ['token', 'ticket', 'sessionToken', 'adoptionTicket'].some(key => Object.hasOwn(payload, key)),
              ticketIssued: typeof payload?.token === 'string' && payload.token.length > 0 };
          })());
        }
        if (new URL(response.url()).pathname !== '/api/files/read') return;
        const at = Date.now();
        roomReads.push((async () => {
          const payload = await response.json().catch(() => null);
          return { url: response.url(), status: response.status(), code: payload?.code, at,
            documentId: payload?.success === true ? payload.data?.collaboration?.document?.id : undefined };
        })());
      });
    }
    const errors = logBrowserDiagnostics(owner, 'caret-owner');
    const peerErrors = logBrowserDiagnostics(peer, 'caret-peer');
    let workspaceId: string | null = null;
    try {
      const ownerId = await login(owner, ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(await login(peer, SECONDARY_EMAIL, SECONDARY_PASSWORD)).not.toBe(ownerId);
      workspaceId = await organizationWorkspace(owner.request);
      await useWorkspace(ownerContext, workspaceId);
      await useWorkspace(peerContext, workspaceId);
      const content = 'Before table\n\n| Header Alpha | Header Beta |\n| --- | --- |\n| One | Two |\n| Three | Four |\n\n'
        + Array.from({ length: 30 }, (_, i) => `Following paragraph ${i}`).join('\n\n');
      const uploaded = await owner.request.post('/api/files/upload', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        multipart: { path: '.', files: { name: filePath, mimeType: 'text/markdown', buffer: Buffer.from(content) } },
      });
      expect(uploaded.ok(), await uploaded.text()).toBe(true);
      await Promise.all([openCollaborativeMarkdown(owner, filePath), openCollaborativeMarkdown(peer, filePath)]);
      const editor = owner.locator('.tiptap-editor-shell .ProseMirror');
      const peerEditor = peer.locator('.tiptap-editor-shell .ProseMirror');
      await peerEditor.getByText('Header Alpha', { exact: true }).click();
      await peer.keyboard.press('Home');
      const caret = editor.locator('th .collaboration-carets__caret');
      await expect(caret).toBeVisible({ timeout: 15_000 });
      const label = caret.locator('.collaboration-carets__label');
      const withinBounds = () => label.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const table = element.closest('.tableWrapper')!.getBoundingClientRect();
        const viewport = element.closest('[data-testid="markdown-scroll-container"]')!.getBoundingClientRect();
        return rect.left >= Math.max(table.left, viewport.left, 0)
          && rect.right <= Math.min(table.right, viewport.right, window.innerWidth)
          && rect.top >= Math.max(table.top, viewport.top, 0)
          && rect.bottom <= Math.min(table.bottom, viewport.bottom, window.innerHeight);
      });
      await expect.poll(withinBounds).toBe(true);
      await caret.hover();
      await expect.poll(() => label.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
      await expect.poll(withinBounds).toBe(true);

      // No pointer interaction after these geometry changes: the view owns updates.
      await owner.mouse.move(1, 1);
      await owner.setViewportSize({ width: 390, height: 544 });
      await expect.poll(withinBounds).toBe(true);
      await editor.locator('.tableWrapper').evaluate((table) => {
        const viewport = table.closest('[data-testid="markdown-scroll-container"]')!;
        viewport.scrollTop += table.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 8;
      });
      await expect.poll(withinBounds).toBe(true);
      const screenshot = testInfo.outputPath('table-caret-bounds.png');
      await owner.screenshot({ path: screenshot });
      await testInfo.attach('table caret after resize and scroll', { path: screenshot, contentType: 'image/png' });
      const before = await editor.evaluate((element) => (element as ObservedEditor).editor.getJSON());
      for (let i = 0; i < 2; i += 1) {
        await owner.getByRole('button', { name: 'Focus document', exact: true }).click();
        await owner.getByRole('button', { name: 'Exit focus', exact: true }).click();
        await expect(editor).toHaveAttribute('contenteditable', 'true');
      }
      await expect.poll(() => editor.evaluate((element) => (element as ObservedEditor).editor.getJSON())).toEqual(before);
      await peerEditor.getByText('Header Alpha', { exact: true }).click();
      await peer.keyboard.insertText(' updated');
      const updated = await peerEditor.evaluate((element) => (element as ObservedEditor).editor.getJSON());
      expect(await collaborativeEditorText(peerEditor)).toContain(' updated');
      await expect.poll(() => editor.evaluate((element) => (element as ObservedEditor).editor.getJSON())).toEqual(updated);
      await expect.poll(withinBounds).toBe(true);
      const recovered = recoveredRoomReadUrls(await Promise.all(roomReads), consoleErrors);
      const recoveredMessages = new Set(consoleErrors.filter(error => recovered.has(error.url)
        && error.message === roomReadConsoleMessage).map(error => error.value));
      const recoveredMigrations = recoveredRichMigrationErrors(await Promise.all(migrationReads), consoleErrors);
      for (const message of recoveredMigrations) recoveredMessages.add(message);
      expect([...errors, ...peerErrors].filter(error => !recoveredMessages.has(error))).toEqual([]);
      if (recoveredMigrations.size) testInfo.annotations.push({ type: 'recovered-rich-migration',
        description: JSON.stringify({ count: recoveredMigrations.size }) });
      if (recovered.size) testInfo.annotations.push({ type: 'recovered-room-read',
        description: JSON.stringify({ count: recovered.size, urls: [...recovered] }) });
    } finally {
      await peerContext.close();
      await owner.close();
      if (workspaceId) await deleteOwnedFixtureFiles(ownerContext.request, workspaceId, [filePath]);
      await ownerContext.close();
    }
  });

  test('converges across clients, exposes presence, reconnects, and checkpoints the file', async ({ browser }, testInfo) => {
    const suffix = `${Date.now()}-${randomUUID()}`;
    const filePath = `collaboration-e2e-${suffix}.md`;
    const adminContext = await fixtureContext(browser);
    const memberContext = await fixtureContext(browser, true);
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

      await createCompletedWorkspaceMarkdownFile({ request: adminPage.request, workspaceId, filePath });

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
        const viewportRect = element.closest('[data-testid="markdown-scroll-container"]')?.getBoundingClientRect();
        return {
          labelLeft: labelRect.left,
          labelRight: labelRect.right,
          labelTop: labelRect.top,
          labelBottom: labelRect.bottom,
          editorLeft: editorRect?.left ?? 0,
          editorRight: editorRect?.right ?? window.innerWidth,
          viewportTop: Math.max(editorRect?.top ?? 0, viewportRect?.top ?? 0, 0),
          viewportBottom: Math.min(viewportRect?.bottom ?? window.innerHeight, window.innerHeight),
        };
      });
      expect(labelBounds.labelLeft).toBeGreaterThanOrEqual(labelBounds.editorLeft);
      expect(labelBounds.labelRight).toBeLessThanOrEqual(labelBounds.editorRight);
      expect(labelBounds.labelTop).toBeGreaterThanOrEqual(labelBounds.viewportTop);
      expect(labelBounds.labelBottom).toBeLessThanOrEqual(labelBounds.viewportBottom);
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

  test('retains inactive live tabs while another fixture user edits their exact Yjs document', async ({ browser }, info) => {
    info.annotations.push({ type: 'scope', description: 'Two actual fixture users; real UI, HTTP and sockets; same Y.Doc/provider through an inactive-tab peer update.' });
    const suffix = randomUUID(), paths = [`live-tab-a-${suffix}.md`, `live-tab-b-${suffix}.md`];
    const text = ['First retained paragraph.', 'Second retained paragraph.'], marker = ` Peer ${suffix}`;
    const ownerContext = await fixtureContext(browser), peerContext = await fixtureContext(browser, true);
    const cleanupApi = await request.newContext({ baseURL: BASE_URL, storageState: await ownerContext.storageState(), timeout: 15_000 });
    const owner = await ownerContext.newPage(), peer = await peerContext.newPage();
    const ownerErrors = logBrowserDiagnostics(owner, 'retained-tab-owner'), peerErrors = logBrowserDiagnostics(peer, 'retained-tab-peer');
    let workspaceId: string | null = null, failure: unknown;
    const observe = (filePath: string, documentId: string) => owner.getByRole('tabpanel', { name: filePath, exact: true })
      .locator('.ProseMirror').evaluate((element, id) => {
        type Doc = { share: Map<string, { toJSON(): unknown }> };
        type Live = { doc: Doc; provider: { isSynced: boolean }; ready: boolean; connection: string; session: { documentId: string } };
        type Fiber = { memoizedProps?: Record<string, unknown>; return?: Fiber };
        const el = element as HTMLElement & { editor?: { extensionManager: { extensions: Array<{ name: string; options: { document?: Doc } }> };
          storage: { canvasBlockTreeCollaboration?: { binding?: { options: { document?: Doc } } } } } };
        const editor = el.editor;
        const doc = editor?.extensionManager.extensions.find(value => value.name === 'collaboration')?.options.document
          ?? editor?.storage.canvasBlockTreeCollaboration?.binding?.options.document;
        if (!doc) return null;
        let live: Live | undefined;
        for (let node: HTMLElement | null = el; node && !live; node = node.parentElement) {
          const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'));
          let fiber = key ? Reflect.get(node, key) as Fiber : undefined;
          for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
            const props = fiber.memoizedProps;
            const value = (props?.collaborationDocument ?? props?.collaboration
              ?? (props?.externalCollaboration as { document?: unknown } | undefined)?.document) as Live | undefined;
            if (value?.doc === doc && value.session.documentId === id) { live = value; break; }
          }
        }
        if (!live?.provider.isSynced || !live.ready || live.connection !== 'live') return null;
        const target = window as typeof window & { __canvasRetainedTabE2E?: Map<string, { doc: Doc; provider: object }> };
        const refs = target.__canvasRetainedTabE2E ??= new Map();
        const previous = refs.get(id); if (!previous) refs.set(id, { doc, provider: live.provider });
        return { sameDoc: !previous || previous.doc === doc, sameProvider: !previous || previous.provider === live.provider };
      }, documentId);
    try {
      const ownerId = await login(owner, ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(await login(peer, SECONDARY_EMAIL, SECONDARY_PASSWORD)).not.toBe(ownerId);
      workspaceId = await organizationWorkspace(owner.request);
      expect(await organizationWorkspace(peer.request)).toBe(workspaceId);
      const headers = { [WORKSPACE_ID_HEADER]: workspaceId };
      await useWorkspace(ownerContext, workspaceId); await useWorkspace(peerContext, workspaceId);
      const documentIds: Record<string, string> = {};
      for (let index = 0; index < paths.length; index++) {
        const uploaded = await owner.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
          name: paths[index], mimeType: 'text/markdown', buffer: Buffer.from(`# Retained ${index}\n\n${text[index]}\n`),
        } } });
        expect(uploaded.ok(), await uploaded.text()).toBe(true);
        const response = await owner.request.get(`/api/files/read?path=${encodeURIComponent(paths[index])}`, { headers });
        expect(response.ok(), await response.text()).toBe(true);
        const payload = await response.json() as { data: { nativeSource: { documentId: string } } };
        documentIds[paths[index]] = payload.data.nativeSource.documentId;
      }
      await ownerContext.addInitScript(({ workspace, paths, documentIds }) => {
        localStorage.setItem('canvas:live-document-tabs', 'on');
        localStorage.setItem(`canvas.notebookDocumentTabs.v1:${workspace}`, JSON.stringify({ version: 1,
          activePath: paths[0], openPaths: paths, documentIds }));
      }, { workspace: workspaceId, paths, documentIds });
      await openCollaborativeMarkdown(owner, paths[0]);
      await expect.poll(() => observe(paths[0], documentIds[paths[0]]), { timeout: 30_000 })
        .toEqual({ sameDoc: true, sameProvider: true });
      await owner.getByRole('tab', { name: paths[1], exact: true }).click(); await enterMarkdownEditMode(owner);
      await expect.poll(() => observe(paths[1], documentIds[paths[1]]), { timeout: 30_000 })
        .toEqual({ sameDoc: true, sameProvider: true });
      await owner.getByRole('tab', { name: paths[0], exact: true }).click();
      await expect(owner.getByRole('tab', { name: paths[0], exact: true })).toHaveAttribute('aria-selected', 'true');
      await openCollaborativeMarkdown(peer, paths[1]);
      const peerEditor = peer.locator('.tiptap-editor-shell .ProseMirror');
      await expect.poll(() => collaborativeEditorText(peerEditor)).toContain(text[1]);
      const caret = await peerEditor.evaluate((element, value) => {
        (element as HTMLElement).focus();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), matches: Node[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent === value) matches.push(node);
        if (matches.length !== 1) return false;
        const node = matches[0], range = document.createRange(); range.setStart(node, value.length); range.collapse(true);
        const selection = window.getSelection(); if (!selection) return false;
        selection.removeAllRanges(); selection.addRange(range);
        return document.activeElement === element && selection.anchorNode === node && selection.anchorOffset === value.length;
      }, text[1]);
      expect(caret, 'The actual peer caret must be at the end of the fixture paragraph.').toBe(true);
      await peer.keyboard.insertText(marker);
      await expect.poll(() => collaborativeEditorText(peerEditor)).toContain(text[1] + marker);
      await expect.poll(() => owner.evaluate(({ id, marker }) => {
        const target = window as typeof window & { __canvasRetainedTabE2E?: Map<string, { doc: { share: Map<string, { toJSON(): unknown }> } }> };
        const doc = target.__canvasRetainedTabE2E?.get(id)?.doc;
        return Boolean(doc && JSON.stringify([...doc.share].map(([name, value]) => [name, value.toJSON()])).includes(marker));
      }, { id: documentIds[paths[1]], marker }), { timeout: 15_000 }).toBe(true);
      await expect(owner.getByRole('tab', { name: paths[0], exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect.poll(async () => {
        const response = await peer.request.get(`/api/files/read?path=${encodeURIComponent(paths[1])}`, { headers });
        const payload = await response.json() as { code?: string; data?: { content?: string; nativeSource?: { documentId: string } } };
        if (response.status() === 503 && payload.code === 'ROOM_OWNER_BUSY') return '';
        expect(response.ok(), JSON.stringify(payload)).toBe(true);
        expect(payload.data?.nativeSource?.documentId).toBe(documentIds[paths[1]]);
        return payload.data?.content ?? '';
      }, { timeout: 20_000 }).toContain(text[1] + marker);
      const reloads: string[] = []; let switching = true, newSockets = 0;
      owner.on('request', value => {
        if (!switching) return;
        const url = new URL(value.url());
        if (url.pathname === '/api/files/read' && url.searchParams.get('path') === paths[1]) reloads.push('file-read');
        if (url.pathname === '/api/files/collaboration/session' && value.postDataJSON()?.path === paths[1]) reloads.push('session');
      });
      owner.on('websocket', value => { if (switching && new URL(value.url()).pathname.includes('/collaboration')) newSockets++; });
      try {
        await owner.getByRole('tab', { name: paths[1], exact: true }).click();
        const editor = owner.getByRole('tabpanel', { name: paths[1], exact: true }).locator('.ProseMirror');
        await expect.poll(() => collaborativeEditorText(editor)).toContain(text[1] + marker);
        await expect.poll(() => editor.evaluate(element => (element as HTMLElement & {
          editor: { state: { doc: { textContent: string } } } }).editor.state.doc.textContent)).toContain(text[1] + marker);
        expect(await observe(paths[1], documentIds[paths[1]])).toEqual({ sameDoc: true, sameProvider: true });
      } finally { switching = false; }
      expect(reloads, 'A retained live tab must show the peer update without file/session reload.').toEqual([]);
      expect(newSockets).toBe(0); expect([...ownerErrors, ...peerErrors]).toEqual([]);
    } catch (error) { failure = error; throw error; }
    finally {
      await finishFixture(cleanupApi, [() => peerContext.close(), () => ownerContext.close(),
        async () => { if (workspaceId) await deleteFixtureFiles(cleanupApi, workspaceId, paths); }], failure);
    }
  });

  test('retains a committed offline edit across inactive tabs, authorized reconnect and reload', async ({ browser }, info) => {
    test.setTimeout(180_000);
    info.annotations.push({ type: 'scope', description: 'Real held tabs, interrupted real sockets and offline browser; committed IndexedDB/native proofs, fresh reconnect authority and reload. No fabricated server responses or persistence acknowledgements.' });
    const suffix = randomUUID(), paths = [`offline-tab-a-${suffix}.md`, `offline-tab-b-${suffix}.md`];
    const texts = ['Offline retained paragraph.', 'Other retained paragraph.'], marker = ` Offline ${suffix}`;
    const context = await fixtureContext(browser), page = await context.newPage();
    const cleanupApi = await request.newContext({ baseURL: BASE_URL, storageState: await context.storageState(), timeout: 15_000 });
    const outage = await installOwnedCollaborationOutage(context);
    const selector = '.tiptap-editor-shell .ProseMirror';
    let workspaceId: string | null = null, failure: unknown;
    const ids: Record<string, string> = {};
    const persisted = async () => {
      expect(workspaceId).toBeTruthy();
      const response = await cleanupApi.post('/api/files/collaboration/session', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId! },
        data: { path: paths[0], representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
      });
      expect(response.status()).toBe(200);
      const value = await response.json() as { documentId: string; lifecycleGeneration: number;
        representation: string; stateProof: string; stateVector: string; degraded: boolean };
      expect(value.documentId).toBe(ids[paths[0]]); expect(value.degraded).toBe(false);
      expect(value.representation).toBe('tiptap_blocks');
      return { documentId: value.documentId, lifecycleGeneration: value.lifecycleGeneration,
        representation: value.representation, stateProof: value.stateProof, stateVector: value.stateVector };
    };
    const snapshot = (candidate: Awaited<ReturnType<typeof readNativeRichCandidate>>) => ({
      document: candidate.document, stateProof: candidate.stateProof, stateVector: candidate.stateVector,
    });
    try {
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      workspaceId = await organizationWorkspace(page.request);
      const headers = { [WORKSPACE_ID_HEADER]: workspaceId };
      await useWorkspace(context, workspaceId);
      for (let index = 0; index < paths.length; index++) {
        await waitForFileCreateBudget();
        const uploaded = await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
          name: paths[index], mimeType: 'text/markdown', buffer: Buffer.from(`${texts[index]}\n`),
        } } });
        expect(uploaded.status()).toBe(200);
        const read = await page.request.get('/api/files/read', { headers, params: { path: paths[index] } });
        expect(read.status()).toBe(200);
        ids[paths[index]] = (await read.json()).data.nativeSource.documentId;
        expect(ids[paths[index]]).toBeTruthy();
      }
      await context.addInitScript(({ workspace, paths, ids }) => {
        localStorage.setItem('canvas:live-document-tabs', 'on');
        localStorage.setItem(`canvas.notebookDocumentTabs.v1:${workspace}`, JSON.stringify({ version: 1,
          activePath: paths[0], openPaths: paths, documentIds: ids }));
      }, { workspace: workspaceId, paths, ids });
      await openCollaborativeMarkdown(page, paths[0]);
      await expect(page.locator(selector)).toHaveText(texts[0]);
      await page.getByRole('tab', { name: paths[1], exact: true }).click(); await enterMarkdownEditMode(page);
      await expect(page.locator(selector)).toHaveText(texts[1]);
      await page.getByRole('tab', { name: paths[0], exact: true }).click();
      await expect(page.locator(selector)).toHaveText(texts[0]);
      const baseline = await readNativeRichCandidate(page, selector);
      await expect.poll(async () => {
        const current = await persisted(); return { stateProof: current.stateProof, stateVector: current.stateVector };
      }, { timeout: 20_000 }).toEqual({ stateProof: baseline.stateProof, stateVector: baseline.stateVector });
      const identity = await persisted();
      await outage.block(); await context.setOffline(true);
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      await (await nativeRichParagraph(page, selector, texts[0])).click();
      await page.keyboard.press('End'); await page.keyboard.insertText(marker);
      await expect(page.locator(selector)).toHaveText(texts[0] + marker);
      const offline = await readNativeRichCandidate(page, selector);
      expect(offline.guid).toBe(baseline.guid); expect(offline.stateProof).not.toBe(baseline.stateProof);
      await expect.poll(() => readNativeRichLocalRecovery(page, identity), { timeout: 20_000 }).toEqual(snapshot(offline));
      expect(await persisted()).toEqual(identity);
      await page.getByRole('tab', { name: paths[1], exact: true }).click();
      await expect(page.getByRole('tab', { name: paths[1], exact: true })).toHaveAttribute('aria-selected', 'true');
      // The local committed log remains the exact dirty candidate while the
      // editor is inactive; server-native bytes must still be the baseline.
      await expect.poll(() => readNativeRichLocalRecovery(page, identity), { timeout: 10_000 }).toEqual(snapshot(offline));
      expect(await persisted()).toEqual(identity);
      let freshSessions = 0;
      page.on('response', value => {
        if (new URL(value.url()).pathname === '/api/files/collaboration/session' && value.status() === 200
          && value.request().postDataJSON()?.path === paths[0]) freshSessions++;
      });
      outage.restore(); await context.setOffline(false);
      await page.getByRole('tab', { name: paths[0], exact: true }).click();
      await expect(page.locator(selector)).toHaveText(texts[0] + marker, { timeout: 30_000 });
      const resumed = await readNativeRichCandidate(page, selector);
      expect(resumed.guid).toBe(offline.guid); expect(snapshot(resumed)).toEqual(snapshot(offline));
      await expect.poll(() => freshSessions, { timeout: 20_000 }).toBeGreaterThan(0);
      await expect.poll(persisted, { timeout: 30_000 })
        .toEqual({ ...identity, stateProof: offline.stateProof, stateVector: offline.stateVector });
      await page.reload({ waitUntil: 'domcontentloaded' }); await enterMarkdownEditMode(page);
      await expect(page.locator(selector)).toHaveText(texts[0] + marker, { timeout: 30_000 });
      expect(snapshot(await readNativeRichCandidate(page, selector))).toEqual(snapshot(offline));
      await page.screenshot({ path: info.outputPath('retained-offline-reconnect.png') });
    } catch (error) { failure = error; throw error; }
    finally {
      await finishFixture(cleanupApi, [() => context.setOffline(false), () => outage.dispose(), () => context.close(),
        async () => { if (workspaceId) await deleteFixtureFiles(cleanupApi, workspaceId, paths); }], failure);
    }
  });

  test('releases evicted document memory without losing persisted content or session isolation', async ({ browser }, info) => {
    test.setTimeout(240_000);
    info.annotations.push({ type: 'scope', description: 'Actual Chromium GC, eighteen native documents, WeakRef observation only, and fresh authorized reopen.' });
    expect(browser.browserType().name(), 'The regular collaboration profile must provide Chromium CDP.').toBe('chromium');
    const suffix = randomUUID(), paths = Array.from({ length: 18 }, (_, index) => `live-tab-gc-${index}-${suffix}.md`);
    const text = paths.map((_, index) => `Retained content ${index} ${suffix}.`);
    const context = await fixtureContext(browser), page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    const cleanupApi = await request.newContext({ baseURL: BASE_URL, storageState: await context.storageState(), timeout: 15_000 });
    let workspaceId: string | null = null, failure: unknown;
    const ids: Record<string, string> = {};
    const observe = (index: number) => page.getByRole('tabpanel', { name: paths[index], exact: true }).locator('.ProseMirror')
      .evaluate((element, id) => {
        type Doc = { isDestroyed: boolean };
        type Live = { doc: Doc; provider?: { isSynced: boolean; configuration: { document: Doc } }; ready: boolean;
          connection: string; session?: { documentId: string } };
        type Fiber = { memoizedProps?: Record<string, unknown>; return?: Fiber };
        const target = window as typeof window & { __canvasEvictionE2E?: Map<string, WeakRef<Doc>> };
        for (let node: HTMLElement | null = element as HTMLElement; node; node = node.parentElement) {
          const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'));
          let fiber = key ? Reflect.get(node, key) as Fiber : undefined;
          for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
            const props = fiber.memoizedProps;
            const live = (props?.collaborationDocument ?? props?.collaboration
              ?? (props?.externalCollaboration as { document?: unknown } | undefined)?.document) as Live | undefined;
            if (live?.session?.documentId !== id || !live.ready || live.connection !== 'live'
              || !live.provider?.isSynced || live.provider.configuration.document !== live.doc) continue;
            const refs = target.__canvasEvictionE2E ??= new Map(), previous = refs.get(id);
            if (!previous) refs.set(id, new WeakRef(live.doc));
            return { ready: true, sameDoc: !previous || previous.deref() === live.doc };
          }
        }
        return null;
      }, ids[paths[index]]);
    const activate = async (index: number) => {
      const tab = page.getByRole('tab', { name: paths[index], exact: true });
      if (await tab.count()) await tab.click();
      else {
        await page.getByTestId('notebook-documents-menu').click();
        await page.getByRole('menuitem').filter({ hasText: paths[index] }).click();
      }
      await expect(page.getByRole('tabpanel', { name: paths[index], exact: true }).locator('.ProseMirror')).toContainText(text[index]);
    };
    try {
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      workspaceId = await organizationWorkspace(page.request);
      const headers = { [WORKSPACE_ID_HEADER]: workspaceId };
      await useWorkspace(context, workspaceId);
      for (let index = 0; index < paths.length; index++) {
        await waitForFileCreateBudget();
        const upload = await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
          name: paths[index], mimeType: 'text/markdown', buffer: Buffer.from(`# Eviction ${index}\n\n${text[index]}\n`),
        } } });
        expect(upload.ok(), await upload.text()).toBe(true);
        const response = await page.request.get(`/api/files/read?path=${encodeURIComponent(paths[index])}`, { headers });
        expect(response.ok(), await response.text()).toBe(true);
        const payload = await response.json() as { data: { content: string; nativeSource: { documentId: string } } };
        expect(payload.data.content).toContain(text[index]);
        ids[paths[index]] = payload.data.nativeSource.documentId;
      }
      await context.addInitScript(({ workspace, paths, ids }) => {
        localStorage.setItem('canvas:live-document-tabs', 'on');
        localStorage.setItem(`canvas.notebookDocumentTabs.v1:${workspace}`, JSON.stringify({ version: 1,
          activePath: paths[0], openPaths: paths, documentIds: ids }));
      }, { workspace: workspaceId, paths, ids });
      await openCollaborativeMarkdown(page, paths[0]);
      for (let index = 0; index < paths.length; index++) {
        if (index) await activate(index);
        await expect.poll(() => observe(index), { timeout: 30_000 }).toEqual({ ready: true, sameDoc: true });
      }
      await expect.poll(() => page.evaluate(() => {
        const refs = (window as typeof window & { __canvasEvictionE2E?: Map<string, WeakRef<{ isDestroyed: boolean }>> }).__canvasEvictionE2E;
        return [...(refs?.values() ?? [])].filter(ref => { const doc = ref.deref(); return doc && !doc.isDestroyed; }).length;
      }), { timeout: 15_000 }).toBeLessThanOrEqual(15);
      await expect.poll(() => page.evaluate(id => {
        const doc = (window as typeof window & { __canvasEvictionE2E?: Map<string, WeakRef<{ isDestroyed: boolean }>> })
          .__canvasEvictionE2E?.get(id)?.deref();
        return !doc || doc.isDestroyed;
      }, ids[paths[0]]), { timeout: 15_000 }).toBe(true);
      const cdp = await context.newCDPSession(page);
      await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(50); await cdp.send('HeapProfiler.collectGarbage');
      expect(await page.evaluate(id => Boolean((window as typeof window & { __canvasEvictionE2E?: Map<string, WeakRef<object>> })
        .__canvasEvictionE2E?.get(id)?.deref()), ids[paths[0]]), 'A disposed document must not be kept alive by a cached session callback.').toBe(false);
      let sessions = 0;
      page.on('request', value => {
        if (new URL(value.url()).pathname === '/api/files/collaboration/session' && value.postDataJSON()?.path === paths[1]) sessions++;
      });
      await activate(1);
      await expect.poll(() => observe(1), { timeout: 30_000 }).toEqual({ ready: true, sameDoc: false });
      expect(sessions, 'Reopening a disposed document requires fresh HTTP authority.').toBeGreaterThan(0);
      const persisted = await page.request.get(`/api/files/read?path=${encodeURIComponent(paths[1])}`, { headers });
      expect(persisted.ok(), await persisted.text()).toBe(true);
      expect((await persisted.json()).data).toMatchObject({ nativeSource: { documentId: ids[paths[1]] } });
    } catch (error) { failure = error; throw error; }
    finally {
      await finishFixture(cleanupApi, [() => context.close(),
        async () => { if (workspaceId) await deleteFixtureFiles(cleanupApi, workspaceId, paths); }], failure);
    }
  });

  test('two fixture users coauthor while real agent tools create, accept and reject exact legacy reviews', { tag: '@experimental-review' }, async ({ browser }, testInfo) => {
    const suffix = `${Date.now()}-${randomUUID()}`;
    const filePath = `collaboration-agent-review-${suffix}.md`;
    const context = await fixtureContext(browser);
    const cleanupApi = await request.newContext({ baseURL: BASE_URL,
      storageState: await context.storageState(), timeout: 15_000 });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const peerContext = await fixtureContext(browser, true);
    const peer = await peerContext.newPage();
    const browserErrors = logBrowserDiagnostics(page, 'agent-review');
    const peerErrors = logBrowserDiagnostics(peer, 'agent-review-peer');
    let workspaceId: string | null = null;
    let storedSessionId: string | null = null;
    let storedAgentId: string | null = null;
    let previousReviewEnabled: boolean | undefined;
    let failure: unknown;

    try {
      const ownerId = await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(await login(peer, SECONDARY_EMAIL, SECONDARY_PASSWORD)).not.toBe(ownerId);
      const workspace = await organizationWorkspaceDetails(page.request);
      workspaceId = workspace.id;
      expect(await organizationWorkspace(peer.request)).toBe(workspaceId);
      await useWorkspace(context, workspaceId);
      await useWorkspace(peerContext, workspaceId);
      const availability = await cleanupApi.get('/api/document-review/availability');
      expect(availability.ok()).toBe(true);
      previousReviewEnabled = (await availability.json()).data.documentReviewEnabled as boolean;
      expect(typeof previousReviewEnabled).toBe('boolean');
      const enabled = await cleanupApi.patch('/api/admin/experimental-settings', {
        headers: { Origin: BASE_URL }, data: { documentReviewEnabled: true },
      });
      expect(enabled.ok(), 'The isolated instance admin must enable document review for this fixture.').toBe(true);
      expect(await enabled.json()).toMatchObject({ success: true, data: { documentReviewEnabled: true } });
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
      const reviewCenter = page.getByTestId('file-version-center');
      const acceptChange = reviewCenter.getByRole('button', {
        name: /^(Accept change|Änderung annehmen)$/u,
      });
      const rejectProposal = reviewCenter.getByRole('button', {
        name: /^(Reject proposal|Vorschlag ablehnen)$/u,
      });
      const agentReviews = reviewCenter.getByRole('region', { name: /Agent reviews|Agenten-Reviews/i });
      const agentProposal = agentReviews.getByRole('button', { name: /Agent proposal|Agentenvorschlag/i }).first();
      await expect(reviewCenter).toBeVisible({ timeout: 20_000 });
      await expect(agentReviews).toContainText('1');
      await agentProposal.click();
      await expect(reviewCenter).toContainText(/Needs review|Review required|Prüfung erforderlich/i);
      await expect(reviewCenter).toContainText('Remove this paragraph');

      const editor = page.locator('.tiptap-editor-shell .ProseMirror');
      await expect(editor.locator('.collaboration-agent-target').first()).toBeVisible();
      const unaffectedParagraph = peerEditor.locator('p').filter({ hasText: 'Keep this paragraph' }).first();
      await unaffectedParagraph.click();
      await peer.keyboard.press('End');
      await peer.keyboard.type(' edited by user');
      await expect.poll(() => collaborativeEditorText(editor)).toContain('Keep this paragraph edited by user');
      const independentEditReview = await page.request.get(operationUrl, { headers: { [WORKSPACE_ID_HEADER]: workspaceId } });
      expect((await independentEditReview.json()).operation.proposalVersion).toBe(initialProposalVersion);
      await expect(reviewCenter).toBeVisible();

      const acceptResponse = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && /\/api\/files\/collaboration\/operations\/[^/]+\/accept$/u.test(response.url())
      ));
      await acceptChange.click();
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
      await expect(acceptChange).toHaveCount(0, { timeout: 20_000 });

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
      await page.keyboard.press('Escape');
      await expect(reviewCenter).toBeHidden();
      await expect(agentActivityButton).toBeVisible({ timeout: 20_000 });
      await agentActivityButton.click();
      await expect(reviewCenter).toBeVisible({ timeout: 20_000 });
      await expect(agentProposal).toBeVisible({ timeout: 20_000 });
      await agentProposal.click();
      await expect(reviewCenter).toContainText('Combined paragraph', { timeout: 20_000 });

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
      const authoritativeSnapshot = async () => {
        const response = await cleanupApi.get('/api/files/read', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId! }, params: { path: filePath },
        });
        expect(response.ok()).toBe(true);
        const data = (await response.json()).data as { content: string; revision: { id: string } | null };
        return { content: data.content, revisionId: data.revision?.id ?? null };
      };
      let checkpointedHumanSnapshot: Awaited<ReturnType<typeof authoritativeSnapshot>> | undefined;
      await expect.poll(async () => {
        const snapshot = await authoritativeSnapshot();
        if (!snapshot.content.includes('Final paragraph updated after preview') || snapshot.revisionId === null) return false;
        checkpointedHumanSnapshot = snapshot;
        return true;
      }, { timeout: 20_000 }).toBe(true);
      const beforeStaleAcceptance = checkpointedHumanSnapshot!;
      expect(beforeStaleAcceptance.revisionId).not.toBeNull();
      expect(beforeStaleAcceptance.content).toContain('Final paragraph updated after preview');
      const staleAcceptance = await page.request.post(`${patchUrl}/accept`, {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { idempotencyKey: `stale-accept-${suffix}`, proposalVersion: staleProposalVersion },
      });
      expect(staleAcceptance.status()).toBe(409);
      expect(await staleAcceptance.json()).toMatchObject({ code: 'AGENT_PROPOSAL_CHANGED' });
      expect(await authoritativeSnapshot()).toEqual(beforeStaleAcceptance);
      expect(await collaborativeEditorText(editor)).toBe(contentAfterHumanEdit);
      await expect(reviewCenter).toBeVisible();
      await expect(acceptChange).toHaveCount(0, { timeout: 20_000 });
      await expect(reviewCenter).toContainText(
        /The proposal changed, became stale|Der Vorschlag wurde geändert, ist veraltet/u,
      );
      await page.keyboard.press('Escape');
      await expect(reviewCenter).toBeHidden();
      await expect(agentActivityButton).toBeVisible({ timeout: 20_000 });
      await agentActivityButton.click();
      await expect(reviewCenter).toBeVisible({ timeout: 20_000 });
      await expect(agentProposal).toBeVisible({ timeout: 20_000 });
      await agentProposal.click();
      await expect(acceptChange).toHaveCount(0, { timeout: 20_000 });

      await expect(rejectProposal).toBeVisible({ timeout: 20_000 });
      await rejectProposal.click();
      await expect.poll(() => collaborativeEditorText(editor)).toContain('Keep this paragraph edited by user');
      await expect.poll(() => collaborativeEditorText(editor)).not.toContain('Combined paragraph');
      await expect(rejectProposal).toHaveCount(0, { timeout: 20_000 });
      expect(await authoritativeSnapshot()).toEqual(beforeStaleAcceptance);

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
      await page.keyboard.press('Escape');
      await expect(reviewCenter).toBeHidden();
      await expect(agentActivityButton).toBeVisible({ timeout: 20_000 });
      await agentActivityButton.click();
      await expect(reviewCenter).toBeVisible({ timeout: 20_000 });
      await expect(agentProposal).toBeVisible({ timeout: 20_000 });
      await agentProposal.click();
      const sourceOnlyAccept = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && /\/api\/files\/collaboration\/operations\/[^/]+\/accept$/u.test(response.url())
      ));
      await expect(acceptChange).toBeVisible({ timeout: 20_000 });
      await acceptChange.click();
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
      const unexpectedBrowserErrors = [...browserErrors, ...peerErrors]
        .filter((message) => !/Failed to load resource:.*409 \(Conflict\)/u.test(message));
      expect(unexpectedBrowserErrors, 'Agent review UI must not emit unexpected browser errors.').toEqual([]);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await finishFixture(cleanupApi, [
        () => peerContext.close(),
        () => context.close(),
        async () => {
          if (previousReviewEnabled !== undefined) {
            const restored = await cleanupApi.patch('/api/admin/experimental-settings', {
              headers: { Origin: BASE_URL }, data: { documentReviewEnabled: previousReviewEnabled },
            });
            expect(restored.ok()).toBe(true);
            expect(await restored.json()).toMatchObject({ success: true,
              data: { documentReviewEnabled: previousReviewEnabled } });
          }
        },
        async () => {
          if (workspaceId && storedSessionId && storedAgentId) {
            const deletedSession = await cleanupApi.delete('/api/sessions', {
              headers: { [WORKSPACE_ID_HEADER]: workspaceId },
              params: { sessionId: storedSessionId, agentId: storedAgentId, workspaceId },
            });
            expect(deletedSession.status(), 'Agent fixture session cleanup').toBe(200);
          }
        },
        async () => { if (workspaceId) await deleteFixtureFiles(cleanupApi, workspaceId, [filePath]); },
      ], failure);
    }
  });
});
