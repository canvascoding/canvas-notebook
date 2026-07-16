import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';

type WorkspacePayload = {
  workspaces?: Array<{
    id: string;
    type: string;
    permissions: { canWrite: boolean };
  }>;
  error?: string;
};

async function login(page: Page): Promise<void> {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: BASE_URL },
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function writableWorkspace(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/workspaces');
  const payload = await response.json() as WorkspacePayload;
  expect(response.ok(), payload.error || 'Could not list workspaces').toBeTruthy();
  const workspace = payload.workspaces?.find((candidate) => (
    candidate.type === 'personal' && candidate.permissions.canWrite
  )) || payload.workspaces?.find((candidate) => candidate.permissions.canWrite);
  expect(workspace, 'A writable workspace is required').toBeTruthy();
  return workspace!.id;
}

async function useWorkspace(context: BrowserContext, workspaceId: string): Promise<void> {
  await context.addInitScript((id) => {
    window.localStorage.setItem('canvas.activeWorkspaceId', id);
    window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspaceId);
}

test.describe('Markdown properties layout', () => {
  test('separates properties from content and suppresses block controls during property editing', async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const filePath = `properties-layout-${Date.now()}.md`;
    let workspaceId: string | null = null;

    try {
      await login(page);
      workspaceId = await writableWorkspace(page.request);
      await useWorkspace(context, workspaceId);

      const createResponse = await page.request.post('/api/files/create', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { path: filePath, type: 'file' },
      });
      expect(createResponse.ok(), await createResponse.text()).toBeTruthy();

      const readResponse = await page.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
      });
      const readPayload = await readResponse.json() as { data?: { stats?: { sha256?: string } } };
      expect(readResponse.ok(), JSON.stringify(readPayload)).toBeTruthy();

      const writeResponse = await page.request.post('/api/files/write', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: {
          path: filePath,
          content: '# Properties layout test\n\nFirst editable paragraph\n\nSecond editable paragraph',
          expectedSha256: readPayload.data?.stats?.sha256,
        },
      });
      expect(writeResponse.ok(), await writeResponse.text()).toBeTruthy();

      await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      const editor = page.locator('.tiptap-editor-shell .ProseMirror');
      const panel = page.getByTestId('markdown-properties-panel');
      const controls = page.locator('.tiptap-block-controls');
      await expect(editor).toBeVisible({ timeout: 30_000 });
      await expect(panel).toBeVisible();
      const chatWrapper = page.locator('[data-chat-mode]').first();
      if (await chatWrapper.evaluate((element) => (
        getComputedStyle(element).opacity !== '0' && element.getBoundingClientRect().width > 1
      ))) {
        await page.getByRole('button', { name: /AI Chat|KI-Chat/i }).first().click();
        await expect.poll(
          () => chatWrapper.evaluate((element) => element.getBoundingClientRect().width),
        ).toBeLessThan(2);
      }

      const firstParagraph = editor.locator('p').first();
      await firstParagraph.click();
      await expect(controls).toBeVisible();

      const collapsedGap = await page.evaluate(() => {
        const properties = document.querySelector('[data-markdown-properties-panel]');
        const addButton = properties?.querySelector('button');
        const editorShell = document.querySelector('.tiptap-editor-shell');
        if (!addButton || !editorShell) return -1;
        return editorShell.getBoundingClientRect().top - addButton.getBoundingClientRect().bottom;
      });
      expect(collapsedGap).toBeGreaterThanOrEqual(16);

      await panel.hover();
      await expect(controls).toBeHidden();
      const collapsedScreenshotPath = testInfo.outputPath('markdown-properties-panel-collapsed.png');
      await page.screenshot({ path: collapsedScreenshotPath, type: 'png' });
      await testInfo.attach('markdown properties collapsed layout', {
        path: collapsedScreenshotPath,
        contentType: 'image/png',
      });

      await panel.getByRole('button', { name: /Add properties|Eigenschaften hinzufügen/i }).click();
      await expect(panel.getByLabel(/Title|Titel/i)).toBeVisible();
      await expect(controls).toBeHidden();

      const expandedGap = await page.evaluate(() => {
        const properties = document.querySelector('[data-markdown-properties-panel]');
        const editorShell = document.querySelector('.tiptap-editor-shell');
        if (!properties || !editorShell) return -1;
        return editorShell.getBoundingClientRect().top - properties.getBoundingClientRect().bottom;
      });
      expect(expandedGap).toBeGreaterThanOrEqual(16);

      await panel.getByLabel(/Title|Titel/i).focus();
      await expect(controls).toBeHidden();

      await firstParagraph.scrollIntoViewIfNeeded();
      await firstParagraph.click();
      await expect(controls).toBeVisible();

      await panel.getByLabel(/Title|Titel/i).focus();
      await expect(controls).toBeHidden();
      const desktopScreenshotPath = testInfo.outputPath('markdown-properties-panel-desktop.png');
      await page.screenshot({ path: desktopScreenshotPath, type: 'png' });
      await testInfo.attach('markdown properties desktop layout', {
        path: desktopScreenshotPath,
        contentType: 'image/png',
      });

      await page.setViewportSize({ width: 1100, height: 800 });
      await panel.scrollIntoViewIfNeeded();
      await expect(panel).toBeVisible();
      const viewportFit = await page.evaluate(() => {
        const scrollContainer = document.querySelector('[data-testid="markdown-scroll-container"]');
        const panelElement = document.querySelector('[data-markdown-properties-panel]');
        const panelRect = panelElement?.getBoundingClientRect();
        return {
          documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          scrollContainerOverflow: scrollContainer
            ? scrollContainer.scrollWidth > scrollContainer.clientWidth
            : true,
          panelFits: Boolean(panelRect && panelRect.left >= 0 && panelRect.right <= window.innerWidth),
        };
      });
      expect(viewportFit).toEqual({
        documentOverflow: false,
        scrollContainerOverflow: false,
        panelFits: true,
      });

      const screenshotPath = testInfo.outputPath('markdown-properties-panel-compact-desktop.png');
      await page.screenshot({ path: screenshotPath, type: 'png' });
      await testInfo.attach('markdown properties compact desktop layout', {
        path: screenshotPath,
        contentType: 'image/png',
      });
    } finally {
      await page.close().catch(() => undefined);
      if (workspaceId) {
        await context.request.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId },
          data: { path: filePath },
        }).catch(() => undefined);
      }
      await context.close();
    }
  });
});
