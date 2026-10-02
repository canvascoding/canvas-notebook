import { expect, request, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ownedCollaborationQaEnabled, requireOwnedCollaborationQaTarget } from '../scripts/lib/owned-collaboration-qa';
import { authenticateManagedTestPage } from './helpers/managed-test-context';
import { aggregateOwnedNativeErrors, runOwnedNativeCommand } from './helpers/owned-native-command';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const SECONDARY_EMAIL = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL || '';
const SECONDARY_PASSWORD = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD || '';
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';

type WorkspaceSummary = {
  id: string;
  type: 'personal' | 'organization' | 'team' | 'project';
  name: string;
  rootRelativePath?: string;
  organizationId?: string | null;
  customerId?: string | null;
  projectId?: string | null;
  legacy?: boolean;
  permissions: { canWrite: boolean; canDelete?: boolean; canCreatePublicLinks?: boolean };
};

type LiveScene = {
  documentId: string;
  sceneSequence: number;
  elements: Array<Record<string, unknown> & { id: string; version: number; versionNonce: number; isDeleted: boolean; x?: number }>;
};

async function login(page: Page, email: string, password: string): Promise<string> {
  expect(Boolean(email && password), 'The managed team fixture credentials must be configured.').toBe(true);
  await authenticateManagedTestPage(page, { email, password });
  const response = await page.request.get('/api/auth/get-session');
  expect(response.status(), 'The fixture must retain its actual authenticated session.').toBe(200);
  const payload = await response.json() as { user?: { id?: string; email?: string } };
  expect(payload.user?.email).toBe(email);
  expect(payload.user?.id).toBeTruthy();
  return payload.user!.id!;
}

async function organizationWorkspace(request: APIRequestContext): Promise<WorkspaceSummary> {
  const response = await request.get('/api/workspaces');
  const payload = await response.json() as { workspaces?: WorkspaceSummary[]; error?: string };
  expect(response.ok(), payload.error || 'Could not list workspaces').toBeTruthy();
  const workspace = payload.workspaces?.find((candidate) => candidate.name === 'Shared Test Workspace' && candidate.permissions.canWrite);
  expect(workspace, 'The existing shared managed fixture must be writable for both team users.').toBeTruthy();
  return workspace!;
}

async function useWorkspace(context: BrowserContext, workspaceId: string): Promise<void> {
  await context.addInitScript((id) => {
    window.localStorage.setItem('canvas.activeWorkspaceId', id);
    window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspaceId);
}

async function openDrawing(page: Page, filePath: string): Promise<void> {
  await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.excalidraw canvas.excalidraw__canvas.interactive')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel(/Live collaboration|Live-Bearbeitung aktiv/i)).toBeVisible({ timeout: 30_000 });
}

async function runAgentTool(input: {
  toolName: 'read' | 'edit_excalidraw_scene';
  toolCallId: string;
  params: Record<string, unknown>;
  context: Record<string, unknown>;
}): Promise<{ content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }> {
  const encoded = Buffer.from(JSON.stringify(input)).toString('base64url');
  await test.info().attach('native-scene-tool-phase', { contentType: 'application/json',
    body: JSON.stringify({ phase: 'started', toolName: input.toolName, toolCallId: input.toolCallId }) });
  try {
    const result = await runOwnedNativeCommand(
      ['--import', 'tsx', '--conditions', 'react-server', 'scripts/collaboration-agent-tool-driver.ts', encoded],
      { label: 'scene-tool' });
    await test.info().attach('native-scene-tool-phase', { contentType: 'application/json',
      body: JSON.stringify({ phase: 'exited', toolName: input.toolName, toolCallId: input.toolCallId, child: result.receipt }) });
    return JSON.parse(result.stdout) as { content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown> };
  } catch (error) {
    try {
      await test.info().attach('native-scene-tool-phase', { contentType: 'application/json',
        body: JSON.stringify({ phase: 'failed', toolName: input.toolName, toolCallId: input.toolCallId,
          child: (error as { ownedChildReceipt?: unknown }).ownedChildReceipt ?? null }) });
    } catch (attachmentError) {
      throw aggregateOwnedNativeErrors(error, [attachmentError], 'Native scene command and failure attachment both failed.');
    }
    throw error;
  }
}

function sceneFromRead(result: { content?: Array<{ text?: string }> }): LiveScene {
  const text = result.content?.[0]?.text || '';
  const jsonStart = text.indexOf('\n\n');
  expect(jsonStart).toBeGreaterThan(0);
  return JSON.parse(text.slice(jsonStart + 2)) as LiveScene;
}

test.describe('Excalidraw live collaboration', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the explicit native Postgres team E2E profile.');
  test.setTimeout(150_000);

  test('converges across users and exposes a safe agent review UI', async ({ browser }, testInfo) => {
    if (ownedCollaborationQaEnabled()) await requireOwnedCollaborationQaTarget();
    const suffix = `${Date.now()}-${randomUUID()}`;
    const filePath = `excalidraw-e2e-${suffix}.excalidraw`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 720 } });
    const memberContext = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 720 } });
    const adminPage = await adminContext.newPage();
    const memberPage = await memberContext.newPage();
    const browserErrors: string[] = [];
    for (const [label, page] of [['admin', adminPage], ['member', memberPage]] as const) {
      page.on('pageerror', (error) => browserErrors.push(`[${label}] ${error.message}`));
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        // Excalidraw supplies its CDN font URL as a fallback after the local
        // /excalidraw font URL. Our CSP intentionally blocks that fallback;
        // the bundled local fonts remain the active source.
        if (/Loading the font 'https:\/\/esm\.sh\/@excalidraw\/excalidraw@.*font-src/u.test(text)) return;
        browserErrors.push(`[${label}] ${text}`);
      });
    }
    let workspaceId: string | null = null;
    let cleanupApi: APIRequestContext | undefined;
    let fileCreated = false;
    let storedSessionId: string | undefined;
    let storedAgentId: string | undefined;
    let failure: unknown;
    let currentPhase = 'setup';
    const phase = async (name: string) => {
      currentPhase = name;
      await testInfo.attach('excalidraw-phase', { contentType: 'application/json', body: JSON.stringify({ phase: name, filePath }) });
    };

    try {
      const ownerUserId = await login(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
      cleanupApi = await request.newContext({ baseURL: BASE_URL,
        storageState: await adminContext.storageState(), timeout: 15_000 });
      expect(await login(memberPage, SECONDARY_EMAIL, SECONDARY_PASSWORD), 'Two distinct actual team users must coauthor.').not.toBe(ownerUserId);
      const workspace = await organizationWorkspace(adminPage.request);
      workspaceId = workspace.id;
      const memberWorkspace = await organizationWorkspace(memberPage.request);
      expect(memberWorkspace.id).toBe(workspaceId);
      await useWorkspace(adminContext, workspaceId);
      await useWorkspace(memberContext, workspaceId);

      const createdFile = await adminPage.request.post('/api/files/create', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { path: filePath, type: 'file' },
      });
      fileCreated = createdFile.ok();
      expect(createdFile.ok(), await createdFile.text()).toBeTruthy();

      const createdSession = await adminPage.request.post('/api/sessions', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { agentId: 'canvas-agent', workspaceId, title: `Excalidraw collaboration ${suffix}` },
      });
      expect(createdSession.status(), 'The tool fixture needs an actual API-owned runtime session.').toBe(200);
      const createdPayload = await createdSession.json() as { success?: boolean; created?: boolean;
        session?: { sessionId?: string; agentId?: string; engine?: string; workspace?: { workspaceId?: string } } };
      const storedSession = createdPayload.session;
      expect(createdPayload).toMatchObject({ success: true, created: true });
      expect(storedSession?.sessionId).toBeTruthy();
      expect(storedSession?.agentId).toBeTruthy();
      expect(storedSession?.engine).toBe('pi');
      expect(storedSession?.workspace?.workspaceId).toBe(workspaceId);
      // Cleanup is allowed only after the complete creation and scope receipt is verified.
      storedSessionId = storedSession!.sessionId;
      storedAgentId = storedSession!.agentId;
      await testInfo.attach('owned-excalidraw-fixture', { contentType: 'application/json',
        body: JSON.stringify({ workspaceId, filePath, sessionId: storedSessionId, agentId: storedAgentId, fileCreated }) });
      await phase('join-both-actual-users');
      await Promise.all([openDrawing(adminPage, filePath), openDrawing(memberPage, filePath)]);
      await expect(adminPage.getByTestId('excalidraw-collaboration-status')).toHaveAttribute('data-collaborator-count', '1', { timeout: 15_000 });

      const session = await adminPage.request.get('/api/auth/get-session');
      const sessionPayload = await session.json() as { user?: { id?: string } };
      expect(sessionPayload.user?.id).toBe(ownerUserId);
      expect(workspace.rootRelativePath).toBeTruthy();
      const agentContext = {
        userId: sessionPayload.user!.id!,
        sessionId: storedSessionId!,
        agentId: storedAgentId!,
        workspaceId,
        workspaceType: workspace.type,
        workspaceName: workspace.name,
        organizationId: workspace.organizationId || null,
        customerId: workspace.customerId || null,
        projectId: workspace.projectId || null,
        workspaceRoot: path.resolve(process.env.DATA || 'data', workspace.rootRelativePath!),
        workspaceRootRelativePath: workspace.rootRelativePath,
        canWrite: true,
        canDelete: workspace.permissions.canDelete !== false,
        canShare: workspace.permissions.canCreatePublicLinks !== false,
        legacy: Boolean(workspace.legacy),
      };

      const adminCanvas = adminPage.locator('.excalidraw canvas.excalidraw__canvas.interactive');
      await phase('draw-and-read-authoritative-scene');
      // Excalidraw's toolbar sits underneath the resizable notebook sidebar at
      // narrow editor widths. Focus the unobscured canvas and use Excalidraw's
      // documented shortcut just like a keyboard user would.
      await expect(adminCanvas).toBeVisible({ timeout: 30_000 });
      await adminCanvas.click();
      await adminPage.keyboard.press('r');
      await expect(adminPage.getByRole('radio', { name: /Rectangle|Rechteck/i })).toBeChecked();
      const canvasBox = await adminCanvas.boundingBox();
      expect(canvasBox).toBeTruthy();
      await adminPage.mouse.move(canvasBox!.x + canvasBox!.width * 0.12, canvasBox!.y + canvasBox!.height * 0.68);
      await adminPage.mouse.down();
      await adminPage.mouse.move(canvasBox!.x + canvasBox!.width * 0.45, canvasBox!.y + canvasBox!.height * 0.84, { steps: 8 });
      await adminPage.mouse.up();

      let initialScene: LiveScene | null = null;
      await expect.poll(async () => {
        const result = await runAgentTool({ toolName: 'read', toolCallId: `read-created-${suffix}`, params: { path: filePath }, context: agentContext });
        initialScene = sceneFromRead(result);
        return initialScene.elements.filter((element) => !element.isDeleted).length;
      }, { timeout: 20_000 }).toBe(1);
      const initialElement = initialScene!.elements.find((element) => !element.isDeleted)!;

      const memberCanvas = memberPage.locator('.excalidraw canvas.excalidraw__canvas.interactive');
      await phase('member-edit-and-authoritative-read');
      await memberCanvas.click();
      await memberPage.keyboard.press('ControlOrMeta+A');
      await memberPage.keyboard.press('ArrowRight');
      let movedScene: LiveScene | null = null;
      await expect.poll(async () => {
        const result = await runAgentTool({ toolName: 'read', toolCallId: `read-moved-${suffix}`, params: { path: filePath }, context: agentContext });
        movedScene = sceneFromRead(result);
        return movedScene.elements.find((element) => element.id === initialElement.id)?.version;
      }, { timeout: 20_000 }).toBeGreaterThan(initialElement.version);

      const checkpointRead = await adminPage.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
      });
      expect(checkpointRead.ok(), await checkpointRead.text()).toBeTruthy();
      const checkpointPayload = await checkpointRead.json() as { data?: { stats?: { sha256?: string } } };
      const blockedWrite = await adminPage.request.post('/api/files/write', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: {
          path: filePath,
          content: '{"elements":[]}',
          expectedSha256: checkpointPayload.data?.stats?.sha256,
        },
      });
      expect(blockedWrite.status()).toBe(409);
      await expect(blockedWrite.json()).resolves.toMatchObject({ code: 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED' });

      const currentElement = movedScene!.elements.find((element) => element.id === initialElement.id)!;
      await phase('stale-version-creates-human-review');
      const reviewResult = await runAgentTool({
        toolName: 'edit_excalidraw_scene',
        toolCallId: `review-${suffix}`,
        params: {
          path: filePath,
          observedSceneSequence: initialScene!.sceneSequence,
          actions: [{
            type: 'update',
            elementId: initialElement.id,
            expectedVersion: initialElement.version,
            expectedVersionNonce: initialElement.versionNonce,
            element: { ...currentElement, x: Number(currentElement.x || 0) + 80 },
          }],
        },
        context: agentContext,
      });
      expect((reviewResult.details as { status?: string }).status).toBe('needs_review');
      const pendingResponse = await adminPage.request.get(
        `/api/files/excalidraw-collaboration/operations?documentId=${encodeURIComponent(initialScene!.documentId)}&pending=1`,
        { headers: { [WORKSPACE_ID_HEADER]: workspaceId } },
      );
      expect(pendingResponse.ok(), await pendingResponse.text()).toBeTruthy();
      const pendingPayload = await pendingResponse.json() as { operations?: Array<{ operationId: string }> };
      expect(pendingPayload.operations?.length).toBe(1);
      await adminPage.bringToFront();
      // Playwright contexts do not always emit the tab focus event when
      // bringToFront() crosses isolated contexts. Dispatch the same event the
      // browser sends when the reviewer returns to this tab.
      await adminPage.evaluate(() => window.dispatchEvent(new Event('focus')));
      const review = adminPage.getByTestId('excalidraw-agent-review');
      await expect(review).toBeVisible({ timeout: 20_000 });
      await expect(review).toContainText(/Agent changes|Agentenänderungen/i);

      await memberPage.keyboard.press('ArrowRight');
      await phase('actual-accept-conflict-and-rebase');
      await review.getByRole('button', { name: /Accept|Annehmen/i }).click();
      await expect(review).toBeVisible({ timeout: 20_000 });
      await review.getByRole('button', { name: /Accept|Annehmen/i }).click();
      await expect(review).toBeHidden({ timeout: 20_000 });

      const afterAccept = sceneFromRead(await runAgentTool({
        toolName: 'read',
        toolCallId: `read-accepted-${suffix}`,
        params: { path: filePath },
        context: agentContext,
      }));
      expect(afterAccept.elements.find((element) => element.id === initialElement.id)?.x).toBe(Number(currentElement.x || 0) + 80);

      const rejectResult = await runAgentTool({
        toolName: 'edit_excalidraw_scene',
        toolCallId: `reject-${suffix}`,
        params: {
          path: filePath,
          observedSceneSequence: initialScene!.sceneSequence,
          actions: [{
            type: 'delete',
            elementId: initialElement.id,
            expectedVersion: initialElement.version,
            expectedVersionNonce: initialElement.versionNonce,
          }],
        },
        context: agentContext,
      });
      expect((rejectResult.details as { status?: string }).status).toBe('needs_review');
      await phase('actual-reject-and-responsive-review');
      await expect(review).toBeVisible({ timeout: 20_000 });

      await adminPage.setViewportSize({ width: 900, height: 650 });
      const reviewBounds = await review.boundingBox();
      expect(reviewBounds).toBeTruthy();
      expect(reviewBounds!.x).toBeGreaterThanOrEqual(0);
      expect(reviewBounds!.y).toBeGreaterThanOrEqual(0);
      expect(reviewBounds!.x + reviewBounds!.width).toBeLessThanOrEqual(900);
      expect(reviewBounds!.y + reviewBounds!.height).toBeLessThanOrEqual(650);
      const screenshotPath = testInfo.outputPath('excalidraw-live-agent-review.png');
      await adminPage.screenshot({ path: screenshotPath, type: 'png' });
      await testInfo.attach('Excalidraw live collaboration and agent review UI', { path: screenshotPath, contentType: 'image/png' });
      await review.getByRole('button', { name: /Reject|Ablehnen/i }).click();
      await expect(review).toBeHidden({ timeout: 20_000 });

      await memberPage.reload({ waitUntil: 'domcontentloaded' });
      await phase('reload-member-and-confirm-live-scene');
      const reloadedMemberCanvas = memberPage.locator('.excalidraw canvas.excalidraw__canvas.interactive');
      await expect(reloadedMemberCanvas).toBeVisible({ timeout: 30_000 });
      await reloadedMemberCanvas.click();
      await memberPage.keyboard.press('ControlOrMeta+A');
      await memberPage.keyboard.press('ArrowRight');
      await expect.poll(async () => {
        const result = await runAgentTool({ toolName: 'read', toolCallId: `read-reloaded-${suffix}`, params: { path: filePath }, context: agentContext });
        return sceneFromRead(result).sceneSequence;
      }, { timeout: 20_000 }).toBeGreaterThan(afterAccept.sceneSequence);

      const fit = await adminPage.evaluate(() => ({
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        canvas: (() => {
          const rect = document.querySelector('.excalidraw')?.getBoundingClientRect();
          return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
        })(),
      }));
      expect(fit.horizontalOverflow).toBe(false);
      expect(fit.canvas).toBeTruthy();
      expect(fit.canvas!.left).toBeGreaterThanOrEqual(0);
      expect(fit.canvas!.right).toBeLessThanOrEqual(900);
      expect(browserErrors, 'Excalidraw collaboration must not emit browser errors.').toEqual([]);
    } catch (error) {
      failure = error;
      try {
        await testInfo.attach('excalidraw-failure-phase', { contentType: 'application/json',
          body: JSON.stringify({ phase: currentPhase, filePath, sessionId: storedSessionId }) });
      } catch (attachmentError) {
        failure = aggregateOwnedNativeErrors(error, [attachmentError], 'Excalidraw action and failure attachment both failed.');
        throw failure;
      }
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      const clean = async (action: () => Promise<unknown>) => {
        try { await action(); } catch (error) { cleanupErrors.push(error); }
      };
      await clean(() => memberContext.close());
      await clean(() => adminContext.close());
      const exitUnconfirmed = (failure as { ownedChildReceipt?: { exitVerified?: boolean } } | undefined)?.ownedChildReceipt?.exitVerified === false;
      if (exitUnconfirmed) cleanupErrors.push(new Error('Native child exit is unconfirmed; retain the owned drawing and session.'));
      if (!exitUnconfirmed && cleanupApi && workspaceId && storedSessionId && storedAgentId) await clean(async () => {
        const deleted = await cleanupApi!.delete('/api/sessions', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId! },
          params: { sessionId: storedSessionId!, agentId: storedAgentId!, workspaceId: workspaceId! },
        });
        expect(deleted.status(), 'Only the API-receipted fixture session is deleted.').toBe(200);
        expect(await deleted.json()).toMatchObject({ success: true, deleted: storedSessionId });
      });
      if (!exitUnconfirmed && cleanupApi && workspaceId && fileCreated) await clean(async () => {
        const deleted = await cleanupApi!.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId! }, data: { path: filePath },
        });
        expect(deleted.status(), 'Only the UUID-owned drawing is deleted.').toBe(200);
        expect(await deleted.json()).toMatchObject({ success: true, deleted: [filePath], failed: [] });
      });
      if (cleanupApi) await clean(() => cleanupApi!.dispose());
      await clean(() => testInfo.attach('owned-excalidraw-cleanup', { contentType: 'application/json',
        body: JSON.stringify({ workspaceId, filePath, sessionId: storedSessionId, agentId: storedAgentId,
          fileCreated, verified: cleanupErrors.length === 0, cleanupFailureCount: cleanupErrors.length }) }));
      if (cleanupErrors.length) throw aggregateOwnedNativeErrors(failure, cleanupErrors,
        'Excalidraw fixture cleanup failed; exact owned session and file identities were retained.');
    }
  });
});
