import { expect, test, type Page } from '@playwright/test';

const OWNER_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
const OWNER_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
const READER_EMAIL = process.env.E2E_TEAM_MEMORY_READER_EMAIL;
const READER_PASSWORD = process.env.E2E_TEAM_MEMORY_READER_PASSWORD;
const WRITER_EMAIL = process.env.E2E_TEAM_MEMORY_WRITER_EMAIL;
const WRITER_PASSWORD = process.env.E2E_TEAM_MEMORY_WRITER_PASSWORD;
const EXTERNAL_EMAIL = process.env.E2E_TEAM_MEMORY_EXTERNAL_EMAIL;
const EXTERNAL_PASSWORD = process.env.E2E_TEAM_MEMORY_EXTERNAL_PASSWORD;

const enabled = process.env.E2E_TEAM_MEMORY === '1'
  && Boolean(OWNER_EMAIL && OWNER_PASSWORD && READER_EMAIL && READER_PASSWORD && WRITER_EMAIL && WRITER_PASSWORD && EXTERNAL_EMAIL && EXTERNAL_PASSWORD);

type Workspace = { id: string };
async function login(page: Page, email: string, password: string) {
  await page.goto('/en/login');
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
}

async function currentUserId(page: Page): Promise<string> {
  const response = await page.request.get('/api/auth/get-session');
  const payload = await response.json() as { user?: { id?: string } };
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  expect(payload.user?.id).toBeTruthy();
  return payload.user!.id!;
}

async function addWorkspaceMember(page: Page, workspaceId: string, userId: string, access: { canRead: boolean; canWrite: boolean; canManage: boolean }) {
  const response = await page.request.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`, {
    data: { userId, role: access.canManage ? 'manager' : access.canWrite ? 'member' : 'viewer', ...access },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.describe('Memory team governance', () => {
  test.skip(!enabled, 'Requires a licensed Postgres team instance and pre-provisioned reader, writer, and external test accounts.');
  test.setTimeout(120_000);

  test('enforces reader, writer, manager, and external memory roles in the UI and API', async ({ browser, page }) => {
    await login(page, OWNER_EMAIL!, OWNER_PASSWORD!);
    const [readerId, writerId] = await Promise.all([
      (async () => { const context = await browser.newContext(); const memberPage = await context.newPage(); await login(memberPage, READER_EMAIL!, READER_PASSWORD!); const id = await currentUserId(memberPage); await context.close(); return id; })(),
      (async () => { const context = await browser.newContext(); const memberPage = await context.newPage(); await login(memberPage, WRITER_EMAIL!, WRITER_PASSWORD!); const id = await currentUserId(memberPage); await context.close(); return id; })(),
    ]);
    const workspaceResponse = await page.request.post('/api/workspaces', {
      data: { type: 'team', name: `Memory governance ${Date.now()}`, description: 'Isolated Playwright memory governance test.' },
    });
    const workspacePayload = await workspaceResponse.json() as { workspace?: Workspace };
    expect(workspaceResponse.ok(), JSON.stringify(workspacePayload)).toBeTruthy();
    const workspaceId = workspacePayload.workspace?.id;
    expect(workspaceId).toBeTruthy();

    try {
      await addWorkspaceMember(page, workspaceId!, readerId, { canRead: true, canWrite: false, canManage: false });
      await addWorkspaceMember(page, workspaceId!, writerId, { canRead: true, canWrite: true, canManage: false });

      const proposalResponse = await page.request.post('/api/memory', {
        data: { scope: 'workspace', workspaceId, content: 'The team uses approved terminology in customer-facing material.' },
      });
      const proposalPayload = await proposalResponse.json() as { data?: { entry?: { id?: string; status?: string } } };
      expect(proposalResponse.ok(), JSON.stringify(proposalPayload)).toBeTruthy();
      expect(proposalPayload.data?.entry?.status).toBe('pending');
      const entryId = proposalPayload.data?.entry?.id;
      expect(entryId).toBeTruthy();

      const publishResponse = await page.request.patch(`/api/memory/entries/${encodeURIComponent(entryId!)}`, {
        data: { scope: 'workspace', workspaceId, action: 'publish' },
      });
      expect(publishResponse.ok(), await publishResponse.text()).toBeTruthy();

      const readerContext = await browser.newContext();
      const readerPage = await readerContext.newPage();
      await login(readerPage, READER_EMAIL!, READER_PASSWORD!);
      await readerPage.goto(`/en/settings?tab=memory&scope=workspace&workspaceId=${encodeURIComponent(workspaceId!)}`);
      await expect(readerPage.getByText('The team uses approved terminology in customer-facing material.')).toBeVisible();
      await expect(readerPage.getByRole('button', { name: 'Edit' })).toHaveCount(0);
      await expect(readerPage.getByRole('button', { name: 'Archive' })).toHaveCount(0);
      await readerContext.close();

      const writerContext = await browser.newContext();
      const writerPage = await writerContext.newPage();
      await login(writerPage, WRITER_EMAIL!, WRITER_PASSWORD!);
      await writerPage.goto(`/en/settings?tab=memory&scope=workspace&workspaceId=${encodeURIComponent(workspaceId!)}`);
      await expect(writerPage.getByText('The team uses approved terminology in customer-facing material.')).toBeVisible();
      await writerPage.getByPlaceholder('e.g. Prefers short, decisive weekly updates.').fill('Writer suggestions are reviewed before publication.');
      await writerPage.getByRole('button', { name: 'Suggest memory' }).click();
      await expect(writerPage.getByText('Memory suggestion created for review.')).toBeVisible();
      await expect(writerPage.getByRole('button', { name: 'Publish' })).toHaveCount(0);
      await writerContext.close();

      const externalContext = await browser.newContext();
      const externalPage = await externalContext.newPage();
      await login(externalPage, EXTERNAL_EMAIL!, EXTERNAL_PASSWORD!);
      const externalResponse = await externalPage.request.get('/api/memory?scope=organization');
      expect(externalResponse.ok()).toBe(false);
      await externalContext.close();
    } finally {
      await page.request.delete(`/api/workspaces/${encodeURIComponent(workspaceId!)}`);
    }
  });
});
