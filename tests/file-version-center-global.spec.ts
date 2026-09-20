import { expect, test, type APIRequestContext, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createAuthenticatedContext,
  enterMarkdownEditMode,
  uploadWorkspaceTextFile,
} from './helpers/managed-test-context';

const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const execFileAsync = promisify(execFile);

type Workspace = {
  id: string;
  name: string;
  type: string;
  rootRelativePath: string;
  organizationId?: string | null;
  customerId?: string | null;
  projectId?: string | null;
  legacy?: boolean;
  permissions: { canWrite: boolean };
};

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  details?: {
    sha256?: string;
    collaboration?: { operationId?: string; reviewRequired?: boolean };
  };
};

type Timeline = {
  capabilities: {
    history: boolean;
    compare: boolean;
    restore: boolean;
    agentReviewPolicy: boolean;
  };
  policy?: { effectiveMode?: string };
  entries: Array<{ kind: string }>;
};

async function workspaces(request: APIRequestContext): Promise<Workspace[]> {
  const response = await request.get('/api/workspaces');
  const payload = await response.json() as { workspaces?: Workspace[]; error?: string };
  expect(response.ok(), payload.error || 'Could not load workspaces').toBeTruthy();
  return payload.workspaces ?? [];
}

async function useWorkspace(context: BrowserContext, workspaceId: string): Promise<void> {
  await context.addInitScript((id) => {
    window.localStorage.setItem('canvas.activeWorkspaceId', id);
    window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspaceId);
}

async function createVersionedMarkdown(input: {
  request: APIRequestContext;
  workspaceId: string;
  filePath: string;
}): Promise<void> {
  await uploadWorkspaceTextFile({
    request: input.request,
    workspaceId: input.workspaceId,
    filePath: input.filePath,
    content: '# Version history fixture\n\nRevision marker 1\n',
  });
}

async function runAgentTool(input: {
  toolName: 'read' | 'edit_file';
  params: Record<string, unknown>;
  context: Record<string, unknown>;
}): Promise<ToolResult> {
  const encoded = Buffer.from(JSON.stringify({
    toolName: input.toolName,
    toolCallId: `version-center-browser-${randomUUID()}`,
    params: input.params,
    context: input.context,
  })).toString('base64url');
  const result = await execFileAsync(
    path.join(process.cwd(), 'node_modules/.bin/tsx'),
    ['--conditions', 'react-server', 'scripts/collaboration-agent-tool-driver.ts', encoded],
    { cwd: process.cwd(), env: process.env, maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
  );
  for (const line of result.stdout.trim().split('\n').reverse()) {
    try {
      return JSON.parse(line) as ToolResult;
    } catch {}
  }
  throw new Error(`Agent tool driver returned no JSON receipt: ${result.stdout.slice(-500)}`);
}

async function seedAgentRevisions(input: {
  request: APIRequestContext;
  workspace: Workspace;
  filePath: string;
  revisions: number;
}): Promise<void> {
  const sessionResponse = await input.request.get('/api/auth/get-session');
  const auth = await sessionResponse.json() as { user?: { id?: string } } | null;
  expect(sessionResponse.ok()).toBeTruthy();
  expect(auth?.user?.id).toBeTruthy();
  const created = await input.request.post('/api/sessions', {
    headers: { [WORKSPACE_ID_HEADER]: input.workspace.id },
    data: {
      agentId: 'canvas-agent',
      workspaceId: input.workspace.id,
      title: 'File version center browser fixture',
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const stored = (await created.json()).session as { sessionId: string; agentId: string };
  const context = {
    userId: auth!.user!.id!,
    sessionId: stored.sessionId,
    agentId: stored.agentId,
    workspaceId: input.workspace.id,
    workspaceType: input.workspace.type,
    workspaceName: input.workspace.name,
    organizationId: input.workspace.organizationId ?? null,
    customerId: input.workspace.customerId ?? null,
    projectId: input.workspace.projectId ?? null,
    workspaceRoot: path.resolve(process.env.DATA || 'data', input.workspace.rootRelativePath),
    workspaceRootRelativePath: input.workspace.rootRelativePath,
    canWrite: true,
    canDelete: false,
    canShare: false,
    legacy: Boolean(input.workspace.legacy),
  };
  try {
    for (let version = 2; version <= input.revisions; version += 1) {
      const read = await runAgentTool({ toolName: 'read', params: { path: input.filePath }, context });
      expect(read.details?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const edited = await runAgentTool({
        toolName: 'edit_file',
        params: {
          path: input.filePath,
          expectedSha256: read.details!.sha256,
          oldText: `Revision marker ${version - 1}`,
          newText: `Revision marker ${version}`,
        },
        context,
      });
      const collaboration = edited.details?.collaboration;
      expect(collaboration?.operationId).toBeTruthy();
      if (collaboration?.reviewRequired) {
        const operationResponse = await input.request.get(
          `/api/files/collaboration/operations/${collaboration.operationId}`,
          { headers: { [WORKSPACE_ID_HEADER]: input.workspace.id } },
        );
        const operationPayload = await operationResponse.json() as {
          operation?: { proposalVersion?: string | null };
        };
        expect(operationResponse.ok()).toBeTruthy();
        expect(operationPayload.operation?.proposalVersion).toMatch(/^v1\.[a-f0-9]{64}$/u);
        const accepted = await input.request.post(
          `/api/files/collaboration/operations/${collaboration.operationId}/accept`,
          {
            headers: { [WORKSPACE_ID_HEADER]: input.workspace.id },
            data: {
              idempotencyKey: `version-center-accept-${randomUUID()}`,
              proposalVersion: operationPayload.operation!.proposalVersion,
            },
          },
        );
        expect(accepted.ok(), await accepted.text()).toBeTruthy();
      }
    }
  } finally {
    const deleted = await input.request.delete('/api/sessions', {
      params: { sessionId: stored.sessionId, agentId: stored.agentId },
    });
    expect(deleted.ok(), 'The synthetic fixture session must be cleaned up').toBeTruthy();
  }
}

async function resolveTimeline(
  request: APIRequestContext,
  workspaceId: string,
  filePath: string,
): Promise<Timeline> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await request.post('/api/files/version-center/v1/resolve', {
      headers: { [WORKSPACE_ID_HEADER]: workspaceId },
      data: {
        contractVersion: 1,
        target: { kind: 'path', workspaceId, pathHint: filePath },
        initialView: 'history',
        source: 'file_browser',
      },
    });
    const payload = await response.json() as Timeline & {
      error?: { code?: string; message?: string };
    };
    if (response.ok()) return payload;
    if (payload.error?.code !== 'FVRC_PERSISTENCE_UNAVAILABLE' || attempt === 5) {
      expect(
        response.ok(),
        `${filePath}: ${payload.error?.message || 'Could not resolve file timeline'}`,
      ).toBeTruthy();
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error('Could not resolve file timeline');
}

async function removeFile(request: APIRequestContext, workspaceId: string, filePath: string): Promise<void> {
  const response = await request.delete('/api/files/delete', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
    data: { path: filePath },
  });
  expect(response.ok(), `Could not delete ${filePath}: ${await response.text()}`).toBeTruthy();
}

async function openEditorHistory(page: Page): Promise<void> {
  const historyButton = page.getByRole('button', {
    name: /^(?:Version history|Versionshistorie)(?: \(view only\)| \(nur ansehen\))?$/iu,
  });
  await expect(historyButton).toBeEnabled({ timeout: 30_000 });
  await historyButton.click();
  await expect(page.getByTestId('file-version-center')).toBeVisible();
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshotPath, type: 'png' });
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
}

test.describe('Global file version center', () => {
  test.setTimeout(180_000);

  test('keeps personal and team capabilities aligned and exposes every document entry point', async ({ browser }, testInfo) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    const suffix = randomUUID();
    const personalPath = `version-center-personal-${suffix}.md`;
    const teamPath = `version-center-team-${suffix}.md`;
    let personalWorkspaceId: string | null = null;
    let teamWorkspaceId: string | null = null;
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      const available = await workspaces(page.request);
      const personal = available.find((workspace) => workspace.type === 'personal' && workspace.permissions.canWrite);
      const team = available.find((workspace) => workspace.name === 'Shared Test Workspace' && workspace.permissions.canWrite);
      expect(personal, 'A writable personal workspace is required').toBeTruthy();
      expect(team, 'The writable managed Team workspace is required').toBeTruthy();
      personalWorkspaceId = personal!.id;
      teamWorkspaceId = team!.id;

      await createVersionedMarkdown({
        request: page.request,
        workspaceId: personalWorkspaceId,
        filePath: personalPath,
      });
      await createVersionedMarkdown({
        request: page.request,
        workspaceId: teamWorkspaceId,
        filePath: teamPath,
      });
      await seedAgentRevisions({ request: page.request, workspace: team!, filePath: teamPath, revisions: 9 });

      const personalTimeline = await resolveTimeline(page.request, personalWorkspaceId, personalPath);
      const teamTimeline = await resolveTimeline(page.request, teamWorkspaceId, teamPath);
      expect(personalTimeline.capabilities).toMatchObject({
        history: true,
        compare: true,
        restore: true,
        agentReviewPolicy: true,
      });
      for (const capability of ['history', 'compare', 'restore', 'agentReviewPolicy'] as const) {
        expect(teamTimeline.capabilities[capability]).toBe(personalTimeline.capabilities[capability]);
      }
      expect(personalTimeline.policy?.effectiveMode).toBe('safe_direct');
      expect(teamTimeline.policy?.effectiveMode).toBe('safe_direct');

      await useWorkspace(context, teamWorkspaceId);
      await page.goto(`/notebook?path=${encodeURIComponent(teamPath)}`, { waitUntil: 'domcontentloaded' });
      await enterMarkdownEditMode(page);
      await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toBeVisible({ timeout: 30_000 });

      const policyControl = page.locator('[data-file-review-policy]');
      const reviewSwitch = policyControl.getByRole('switch');
      await expect(policyControl).toHaveAttribute('data-file-review-policy', 'safe_direct', { timeout: 30_000 });
      await expect(reviewSwitch).not.toBeChecked();
      await reviewSwitch.click();
      await expect(policyControl).toHaveAttribute('data-file-review-policy', 'review_required');
      await expect(reviewSwitch).toBeChecked();
      await reviewSwitch.click();
      await expect(policyControl).toHaveAttribute('data-file-review-policy', 'safe_direct');
      await expect(reviewSwitch).not.toBeChecked();

      await openEditorHistory(page);
      const center = page.getByTestId('file-version-center');
      const revisions = center.locator('[data-entry-kind="revision"]');
      await expect.poll(() => revisions.count()).toBeGreaterThanOrEqual(9);
      const modelRequests: string[] = [];
      const recordModelRequest = (request: { url(): string }) => {
        if (/\/api\/(?:agent-runtime|chat)(?:\/|$)/u.test(new URL(request.url()).pathname)) {
          modelRequests.push(request.url());
        }
      };
      page.on('request', recordModelRequest);
      await revisions.last().click();
      await expect(center.getByRole('tab', { name: /^(?:Changes|Änderungen)$/iu })).toBeVisible({ timeout: 20_000 });
      await expect(center).toContainText(/Compared with the current authoritative document|Mit dem aktuellen autoritativen Dokument verglichen/iu);
      page.off('request', recordModelRequest);
      expect(modelRequests, 'Historical comparison must not call an AI runtime').toEqual([]);
      await attachScreenshot(page, testInfo, 'file-version-center-desktop');

      await page.keyboard.press('Escape');
      await expect(center).toBeHidden();

      const browserRow = page.locator(`[data-file-path="${teamPath}"]`).first();
      await expect(browserRow).toBeVisible();
      await browserRow.click({ button: 'right' });
      const browserMenuItem = page.locator('[role="menu"]:visible').last().getByTestId('file-version-menu-item');
      await expect(browserMenuItem).toHaveAttribute('data-file-version-capability', 'full', { timeout: 30_000 });
      await browserMenuItem.click();
      await expect(center).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(center).toBeHidden();
      await page.getByRole('button', { name: /^(?:File actions|Dateiaktionen)$/iu }).click();
      const editorMenuItem = page.locator('[role="menu"]:visible').last().getByTestId('file-version-menu-item');
      await expect(editorMenuItem).toHaveAttribute('data-file-version-capability', 'full', { timeout: 30_000 });
      await editorMenuItem.click();
      await expect(center).toBeVisible();

      await page.setViewportSize({ width: 760, height: 900 });
      const narrowFit = await center.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          viewportWidth: window.innerWidth,
        };
      });
      expect(narrowFit.left).toBeGreaterThanOrEqual(0);
      expect(narrowFit.right).toBeLessThanOrEqual(narrowFit.viewportWidth);
      expect(narrowFit.scrollWidth).toBeLessThanOrEqual(narrowFit.clientWidth);
      await attachScreenshot(page, testInfo, 'file-version-center-narrow');
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close().catch(() => undefined);
      if (teamWorkspaceId) await removeFile(context.request, teamWorkspaceId, teamPath).catch(() => undefined);
      if (personalWorkspaceId) await removeFile(context.request, personalWorkspaceId, personalPath).catch(() => undefined);
      await context.close();
    }
  });

  test('keeps card gutters and the current/history divider inside the mobile scroll area', async ({ browser }, testInfo) => {
    const context = await createAuthenticatedContext(browser, {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const filePath = `version-center-mobile-${randomUUID()}.md`;
    let workspaceId: string | null = null;

    try {
      const available = await workspaces(page.request);
      const team = available.find((workspace) => workspace.name === 'Shared Test Workspace' && workspace.permissions.canWrite);
      expect(team, 'The writable managed Team workspace is required').toBeTruthy();
      workspaceId = team!.id;
      await createVersionedMarkdown({
        request: page.request,
        workspaceId,
        filePath,
      });
      await seedAgentRevisions({ request: page.request, workspace: team!, filePath, revisions: 10 });
      await useWorkspace(context, workspaceId);
      await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      await openEditorHistory(page);

      const center = page.getByTestId('file-version-center');
      const timeline = center.getByRole('navigation');
      const viewport = timeline.locator('[data-slot="scroll-area-viewport"]');
      const historySection = center.getByTestId('file-version-history-section');
      await expect.poll(() => center.locator('[data-entry-kind="revision"]').count()).toBeGreaterThanOrEqual(10);
      await expect(historySection).toHaveCSS('border-top-style', 'solid');

      const fit = await center.evaluate((element) => ({
        centerScrollWidth: element.scrollWidth,
        centerClientWidth: element.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        documentClientWidth: document.documentElement.clientWidth,
      }));
      expect(fit.centerScrollWidth).toBeLessThanOrEqual(fit.centerClientWidth);
      expect(fit.documentScrollWidth).toBeLessThanOrEqual(fit.documentClientWidth);

      const navBox = await timeline.boundingBox();
      const firstCardBox = await center.locator('[data-entry-kind="current"]').boundingBox();
      expect(navBox).toBeTruthy();
      expect(firstCardBox).toBeTruthy();
      const leftGutter = firstCardBox!.x - navBox!.x;
      const rightGutter = navBox!.x + navBox!.width - (firstCardBox!.x + firstCardBox!.width);
      expect(leftGutter).toBeGreaterThanOrEqual(15);
      expect(leftGutter).toBeLessThanOrEqual(17);
      expect(Math.abs(leftGutter - rightGutter)).toBeLessThanOrEqual(1);

      const beforeTop = (await historySection.boundingBox())!.y;
      const scrollState = await viewport.evaluate((element) => {
        const target = element as HTMLElement;
        const canScroll = target.scrollHeight > target.clientHeight;
        target.scrollTop = Math.min(160, target.scrollHeight - target.clientHeight);
        target.dispatchEvent(new Event('scroll'));
        return { canScroll, scrollTop: target.scrollTop };
      });
      expect(scrollState.canScroll).toBe(true);
      expect(scrollState.scrollTop).toBeGreaterThan(0);
      const afterTop = (await historySection.boundingBox())!.y;
      expect(afterTop).toBeLessThan(beforeTop - 40);
      await attachScreenshot(page, testInfo, 'file-version-center-mobile-dark');
    } finally {
      await page.close().catch(() => undefined);
      if (workspaceId) await removeFile(context.request, workspaceId, filePath).catch(() => undefined);
      await context.close();
    }
  });
});
