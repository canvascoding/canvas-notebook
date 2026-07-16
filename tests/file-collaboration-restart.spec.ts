import { readFile, unlink, writeFile } from 'node:fs/promises';

import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const PHASE = process.env.COLLABORATION_RESTART_PHASE;
const STATE_FILE = process.env.COLLABORATION_RESTART_STATE || '/tmp/canvas-collaboration-restart-e2e.json';
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';

type RestartState = {
  filePath: string;
  content: string;
  workspaceId: string;
};

async function login(page: Page): Promise<void> {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: BASE_URL },
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function organizationWorkspace(page: Page): Promise<string> {
  let response = await page.request.get('/api/workspaces');
  let payload = await response.json() as {
    workspaces?: Array<{ id: string; type: string; permissions: { canWrite: boolean } }>;
  };
  let workspace = payload.workspaces?.find((candidate) => (
    candidate.type === 'organization' && candidate.permissions.canWrite
  ));
  if (!workspace) {
    const createResponse = await page.request.post('/api/workspaces', {
      data: {
        type: 'organization',
        name: 'Collaboration Restart Organization',
      },
    });
    expect(
      createResponse.ok() || createResponse.status() === 409,
      await createResponse.text(),
    ).toBeTruthy();
    response = await page.request.get('/api/workspaces');
    payload = await response.json() as {
      workspaces?: Array<{ id: string; type: string; permissions: { canWrite: boolean } }>;
    };
    workspace = payload.workspaces?.find((candidate) => (
      candidate.type === 'organization' && candidate.permissions.canWrite
    ));
  }
  expect(workspace, 'A writable organization workspace is required').toBeTruthy();
  return workspace!.id;
}

async function useWorkspace(context: BrowserContext, workspaceId: string): Promise<void> {
  await context.addInitScript((id) => {
    window.localStorage.setItem('canvas.activeWorkspaceId', id);
    window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspaceId);
}

async function openEditor(page: Page, filePath: string): Promise<Locator> {
  await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
  const editor = page.locator('.tiptap-editor-shell .ProseMirror');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('status').filter({
    hasText: /Live collaboration|Live-Bearbeitung aktiv/i,
  })).toBeVisible({ timeout: 30_000 });
  return editor;
}

async function editorText(editor: Locator): Promise<string> {
  return editor.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.collaboration-carets__label').forEach((label) => label.remove());
    return clone.textContent || '';
  });
}

test.describe('collaboration process restart durability', () => {
  test.skip(
    process.env.COLLABORATION_E2E !== '1' || (PHASE !== 'prepare' && PHASE !== 'verify'),
    'Requires the explicit two-phase Postgres restart E2E profile.',
  );
  test.setTimeout(90_000);

  test('survives a complete application process restart', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page);

    if (PHASE === 'prepare') {
      const workspaceId = await organizationWorkspace(page);
      const filePath = `collaboration-restart-${Date.now()}.md`;
      const content = `Persisted across process restart ${Date.now()}`;
      await useWorkspace(context, workspaceId);
      const createResponse = await page.request.post('/api/files/create', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { path: filePath, type: 'file' },
      });
      expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
      const editor = await openEditor(page, filePath);
      await editor.click();
      await page.keyboard.insertText(content);
      await expect.poll(async () => {
        const response = await page.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        });
        const payload = await response.json() as { data?: { content?: string } };
        return payload.data?.content || '';
      }, { timeout: 20_000 }).toContain(content);
      await writeFile(STATE_FILE, JSON.stringify({ filePath, content, workspaceId } satisfies RestartState));
      await context.close();
      return;
    }

    const state = JSON.parse(await readFile(STATE_FILE, 'utf8')) as RestartState;
    try {
      await useWorkspace(context, state.workspaceId);
      const editor = await openEditor(page, state.filePath);
      await expect.poll(() => editorText(editor), { timeout: 30_000 }).toBe(state.content);
    } finally {
      await page.request.delete('/api/files/delete', {
        headers: { [WORKSPACE_ID_HEADER]: state.workspaceId },
        data: { path: state.filePath },
      }).catch(() => undefined);
      await unlink(STATE_FILE).catch(() => undefined);
      await context.close();
    }
  });
});
