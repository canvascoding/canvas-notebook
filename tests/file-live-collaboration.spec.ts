import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';

type WorkspacePayload = {
  workspaces?: Array<{ id: string; type: string; permissions: { canWrite: boolean } }>;
  error?: string;
};

async function login(page: Page, email: string, password: string): Promise<void> {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: BASE_URL },
    data: { email, password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function organizationWorkspace(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/workspaces');
  const payload = await response.json() as WorkspacePayload;
  expect(response.ok(), payload.error || 'Could not list team workspaces').toBeTruthy();
  const workspace = payload.workspaces?.find((candidate) => (
    candidate.type === 'organization' && candidate.permissions.canWrite
  ));
  expect(workspace, 'A writable organization workspace is required').toBeTruthy();
  return workspace!.id;
}

async function useWorkspace(context: BrowserContext, workspaceId: string): Promise<void> {
  await context.addInitScript((id) => {
    window.localStorage.setItem('canvas.activeWorkspaceId', id);
    window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspaceId);
}

async function openCollaborativeMarkdown(page: Page, filePath: string): Promise<void> {
  await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('status').filter({ hasText: /Live collaboration|Live-Bearbeitung aktiv/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel(/Live text-ready|Live-Text vorbereitet/i)).toBeVisible();
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

test.describe('Markdown live collaboration', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the explicit Postgres team E2E profile.');
  test.setTimeout(120_000);

  test('converges across users, exposes presence, reconnects, and checkpoints the file', async ({ browser }, testInfo) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const memberEmail = 'collaboration-member@example.test';
    const memberPassword = 'Collaboration-E2E-Password-1!';
    const filePath = `collaboration-e2e-${suffix}.md`;
    const adminContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const memberPage = await memberContext.newPage();
    const adminBrowserErrors = logBrowserDiagnostics(adminPage, 'admin');
    const memberBrowserErrors = logBrowserDiagnostics(memberPage, 'member');
    let duplicateBrowserErrors: string[] = [];
    let adminWorkspaceId: string | null = null;

    try {
      await login(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
      const existingMemberResponse = await adminPage.request.get(
        `/api/auth/admin/list-users?searchValue=${encodeURIComponent(memberEmail)}&searchField=email&filterField=email&filterValue=${encodeURIComponent(memberEmail)}&filterOperator=eq&limit=1`,
      );
      const existingMemberPayload = await existingMemberResponse.json() as { users?: Array<{ id: string }> };
      expect(existingMemberResponse.ok(), JSON.stringify(existingMemberPayload)).toBeTruthy();
      if (!existingMemberPayload.users?.length) {
        const createMemberResponse = await adminPage.request.post('/api/auth/admin/create-user', {
          headers: { Origin: BASE_URL },
          data: {
            name: 'Collaboration Member',
            email: memberEmail,
            password: memberPassword,
            role: 'user',
          },
        });
        expect(createMemberResponse.ok(), await createMemberResponse.text()).toBeTruthy();
      }

      await login(memberPage, memberEmail, memberPassword);
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

      await memberEditor.click();
      await memberPage.keyboard.press('ControlOrMeta+A');
      await memberPage.keyboard.insertText('Alice writes live and Bob replies');
      await expect.poll(() => collaborativeEditorText(adminEditor), { timeout: 15_000 })
        .toBe('Alice writes live and Bob replies');

      const fileRow = adminPage.locator(`[data-file-path="${filePath}"]`).first();
      const presence = fileRow.locator('[aria-label^="Active collaborators:"]');
      await expect(presence).toBeVisible({ timeout: 15_000 });
      await expect(presence).toHaveAttribute('aria-label', /Collaboration Member: editing/i);

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
        const status = editorViewport?.querySelector('[role="status"]');
        const requiredRegions = [editorViewport, status].map((element) => element?.getBoundingClientRect());
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
      await expect(
        memberPage.getByRole('status').filter({ hasText: /Live collaboration|Live-Bearbeitung aktiv/i }),
      ).toBeVisible({ timeout: 30_000 });

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
      await expect(presence).not.toHaveAttribute('aria-label', /Collaboration Member/i, { timeout: 15_000 });
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

  test('shows an accessible agent review and submits the explicit accept action', async ({ browser }, testInfo) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `collaboration-agent-review-${suffix}.md`;
    const context = await browser.newContext();
    const page = await context.newPage();
    const browserErrors = logBrowserDiagnostics(page, 'agent-review');
    let workspaceId: string | null = null;
    let accepted = false;

    try {
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      workspaceId = await organizationWorkspace(page.request);
      await useWorkspace(context, workspaceId);
      const createFileResponse = await page.request.post('/api/files/create', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { path: filePath, type: 'file' },
      });
      expect(createFileResponse.ok(), await createFileResponse.text()).toBeTruthy();

      await page.route(/\/api\/files\/collaboration\/operations\?.+/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            operations: accepted ? [] : [{
              operationId: 'operation-review-e2e',
              operationStatus: 'needs_review',
              status: 'needs_review',
              durability: 'needs_review',
              actorId: 'canvas-agent',
              appliedTargetIds: [],
              conflicts: [],
              reviewTargets: [{
                targetId: 'target-review-e2e',
                groupId: 'paragraph',
                currentText: 'User-authored paragraph',
                proposedReplacement: 'Agent-proposed paragraph',
              }],
            }],
          }),
        });
      });
      await page.route(/\/api\/files\/collaboration\/operations\/operation-review-e2e\/accept$/, async (route) => {
        expect(route.request().method()).toBe('POST');
        const body = route.request().postDataJSON() as { idempotencyKey?: string };
        expect(body.idempotencyKey).toBeTruthy();
        accepted = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      });

      await openCollaborativeMarkdown(page, filePath);
      const reviewRegion = page.getByRole('region', { name: /Agent changes|Agentenänderungen/i });
      await expect(reviewRegion).toBeVisible({ timeout: 15_000 });
      await expect(reviewRegion).toContainText(/Review required|Prüfung erforderlich/i);
      await reviewRegion.getByText(/Compare current and proposed text|Aktuellen und vorgeschlagenen Text vergleichen/i).click();
      await expect(reviewRegion).toContainText('User-authored paragraph');
      await expect(reviewRegion).toContainText('Agent-proposed paragraph');

      const screenshotPath = testInfo.outputPath('agent-review.png');
      await page.screenshot({ path: screenshotPath, type: 'png' });
      await testInfo.attach('agent review UI', { path: screenshotPath, contentType: 'image/png' });

      await reviewRegion.getByRole('button', { name: /Accept|Annehmen/i }).click();
      await expect.poll(() => accepted).toBe(true);
      await expect(reviewRegion).toBeHidden();
      expect(browserErrors, 'Agent review UI must not emit browser errors.').toEqual([]);
    } finally {
      if (workspaceId && !page.isClosed()) {
        await page.request.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId },
          data: { path: filePath },
        }).catch(() => undefined);
      }
      await context.close();
    }
  });
});
