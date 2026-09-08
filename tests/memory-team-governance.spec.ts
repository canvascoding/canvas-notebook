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
type MemoryEntry = { id: string; collectionId: string; status: 'pending' | 'published' | 'archived'; priority: number };
type ApprovalNotification = {
  id: string;
  type: 'memory.approval_required';
  title: string;
  unread: boolean;
  target: { kind: 'memory'; scope: 'workspace'; entryId: string; collectionId: string; workspaceId: string };
};

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
    const proposalContent = `Writer suggestions are reviewed before publication (${Date.now()}).`;
    let writerContext: Awaited<ReturnType<typeof browser.newContext>> | null = null;
    let readerContext: Awaited<ReturnType<typeof browser.newContext>> | null = null;
    let externalContext: Awaited<ReturnType<typeof browser.newContext>> | null = null;

    try {
      await addWorkspaceMember(page, workspaceId!, readerId, { canRead: true, canWrite: false, canManage: false });
      await addWorkspaceMember(page, workspaceId!, writerId, { canRead: true, canWrite: true, canManage: false });

      writerContext = await browser.newContext();
      const writerPage = await writerContext.newPage();
      await login(writerPage, WRITER_EMAIL!, WRITER_PASSWORD!);
      const proposalResponse = await writerPage.request.post('/api/memory', {
        data: { scope: 'workspace', workspaceId, content: proposalContent },
      });
      const proposalPayload = await proposalResponse.json() as { data?: { entry?: MemoryEntry } };
      expect(proposalResponse.ok(), JSON.stringify(proposalPayload)).toBeTruthy();
      expect(proposalPayload.data?.entry?.status).toBe('pending');
      expect(proposalPayload.data?.entry?.priority).toBe(70);
      const entryId = proposalPayload.data?.entry?.id;
      const collectionId = proposalPayload.data?.entry?.collectionId;
      expect(entryId).toBeTruthy();
      expect(collectionId).toBeTruthy();

      await writerPage.goto(`/en/settings?tab=memory&scope=workspace&memoryWorkspaceId=${encodeURIComponent(workspaceId!)}&status=pending&collectionId=${encodeURIComponent(collectionId!)}&entryId=${encodeURIComponent(entryId!)}`);
      await expect(writerPage.getByTestId('workspace-memory-owner-select')).toHaveValue(workspaceId!);
      await expect(writerPage.getByTestId('memory-status-pending')).toBeVisible();
      const writerPendingCard = writerPage.locator(`#memory-entry-${entryId}`);
      await expect(writerPendingCard).toBeVisible();
      await expect(writerPendingCard).toContainText(proposalContent);
      await expect(writerPendingCard).toContainText('Priority 70 · Important');
      await expect(writerPage.getByRole('button', { name: 'Publish' })).toHaveCount(0);

      let releasePublishedRequest = () => {};
      let markPublishedRequestStarted = () => {};
      const publishedRequestGate = new Promise<void>((resolve) => { releasePublishedRequest = resolve; });
      const publishedRequestStarted = new Promise<void>((resolve) => { markPublishedRequestStarted = resolve; });
      const isPublishedEntryRequest = (requestUrl: string) => {
        const url = new URL(requestUrl);
        return url.pathname === '/api/memory'
          && url.searchParams.get('workspaceId') === workspaceId
          && url.searchParams.get('collectionId') === collectionId
          && url.searchParams.get('status') === 'published';
      };
      await writerPage.route('**/api/memory?**', async (route) => {
        if (isPublishedEntryRequest(route.request().url())) {
          markPublishedRequestStarted();
          await publishedRequestGate;
        }
        await route.continue();
      });

      await writerPage.evaluate(() => {
        const url = new URL(window.location.href);
        url.searchParams.set('status', 'published');
        url.searchParams.delete('entryId');
        window.history.pushState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      });
      await publishedRequestStarted;
      await expect(writerPage.getByTestId('memory-status-published')).toBeVisible();
      await expect(writerPendingCard).toHaveCount(0);

      await writerPage.evaluate((targetEntryId) => {
        const url = new URL(window.location.href);
        url.searchParams.set('status', 'pending');
        url.searchParams.set('entryId', targetEntryId);
        window.history.pushState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      }, entryId!);
      await expect(writerPage.getByTestId('memory-status-pending')).toBeVisible();
      await expect(writerPendingCard).toBeVisible();

      const stalePublishedResponse = writerPage.waitForResponse((response) => isPublishedEntryRequest(response.url()));
      releasePublishedRequest();
      await stalePublishedResponse;
      await expect(writerPage.getByTestId('memory-status-pending')).toBeVisible();
      await expect(writerPendingCard).toBeVisible();
      await writerPage.unroute('**/api/memory?**');

      const memorySettingsSection = writerPage.locator('section[aria-labelledby="settings-content-memory"]');
      await writerPage.evaluate(() => {
        const url = new URL(window.location.href);
        url.searchParams.set('tab', 'general');
        window.history.pushState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      });
      await expect(memorySettingsSection).toBeHidden();
      await writerPage.evaluate(() => {
        const url = new URL(window.location.href);
        url.searchParams.set('tab', 'memory');
        window.history.pushState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      });
      await expect(memorySettingsSection).toBeVisible();
      await expect(writerPendingCard).toBeVisible();

      const summaryResponse = await page.request.get('/api/notifications/summary');
      const summaryPayload = await summaryResponse.json() as { data?: { sections?: { notifications?: ApprovalNotification[] } } };
      expect(summaryResponse.ok(), JSON.stringify(summaryPayload)).toBeTruthy();
      const approval = summaryPayload.data?.sections?.notifications?.find((item) => item.type === 'memory.approval_required' && item.target.entryId === entryId);
      expect(approval).toBeTruthy();
      expect(approval?.unread).toBe(true);
      expect(approval?.target.workspaceId).toBe(workspaceId);

      await page.getByTestId('notification-bell').first().click();
      const approvalButton = page.getByRole('button', { name: new RegExp(approval!.title) }).first();
      await expect(approvalButton).toBeVisible();
      await approvalButton.click();
      await page.waitForURL((url) => url.searchParams.get('scope') === 'workspace'
        && url.searchParams.get('workspaceId') === workspaceId
        && url.searchParams.get('status') === 'pending'
        && url.searchParams.get('collectionId') === collectionId
        && url.searchParams.get('entryId') === entryId);
      await expect(page.getByTestId('workspace-memory-owner-select')).toHaveValue(workspaceId!);
      await expect(page.locator(`#memory-entry-${entryId}`)).toBeVisible();
      await expect(page.locator(`#memory-entry-${entryId}`)).toHaveClass(/ring-2/);

      const readSummaryResponse = await page.request.get('/api/notifications/summary');
      const readSummaryPayload = await readSummaryResponse.json() as { data?: { sections?: { notifications?: ApprovalNotification[] } } };
      const readApproval = readSummaryPayload.data?.sections?.notifications?.find((item) => item.id === approval?.id);
      expect(readApproval, 'A read approval remains visible until the proposal is resolved.').toBeTruthy();
      expect(readApproval?.unread).toBe(false);

      const publishResponse = await page.request.patch(`/api/memory/entries/${encodeURIComponent(entryId!)}`, {
        data: { scope: 'workspace', workspaceId, action: 'publish' },
      });
      expect(publishResponse.ok(), await publishResponse.text()).toBeTruthy();

      const resolvedSummaryResponse = await page.request.get('/api/notifications/summary');
      const resolvedSummaryPayload = await resolvedSummaryResponse.json() as { data?: { sections?: { notifications?: ApprovalNotification[] } } };
      expect(resolvedSummaryPayload.data?.sections?.notifications?.some((item) => item.id === approval?.id)).toBe(false);

      const directPublishResponse = await page.request.post('/api/memory', {
        data: { scope: 'workspace', workspaceId, content: `Manager-authored facts publish immediately (${Date.now()}).` },
      });
      const directPublishPayload = await directPublishResponse.json() as { data?: { entry?: MemoryEntry } };
      expect(directPublishResponse.ok(), JSON.stringify(directPublishPayload)).toBeTruthy();
      expect(directPublishPayload.data?.entry?.status).toBe('published');
      expect(directPublishPayload.data?.entry?.priority).toBe(70);

      const archiveResponse = await page.request.delete(`/api/memory/entries/${encodeURIComponent(entryId!)}?scope=workspace&workspaceId=${encodeURIComponent(workspaceId!)}`);
      expect(archiveResponse.ok(), await archiveResponse.text()).toBeTruthy();
      await page.goto(`/en/settings?tab=memory&scope=workspace&memoryWorkspaceId=${encodeURIComponent(workspaceId!)}&status=archived&collectionId=${encodeURIComponent(collectionId!)}&entryId=${encodeURIComponent(entryId!)}`);
      await expect(page.getByTestId('memory-status-archived')).toBeVisible();
      const archivedCard = page.locator(`#memory-entry-${entryId}`);
      await expect(archivedCard).toBeVisible();
      await expect(archivedCard).toHaveAttribute('data-entry-status', 'archived');

      const restoreResponse = await page.request.patch(`/api/memory/entries/${encodeURIComponent(entryId!)}`, {
        data: { scope: 'workspace', workspaceId, action: 'restore' },
      });
      expect(restoreResponse.ok(), await restoreResponse.text()).toBeTruthy();
      const restoredCollectionResponse = await page.request.get(`/api/memory?scope=workspace&workspaceId=${encodeURIComponent(workspaceId!)}&collectionId=${encodeURIComponent(collectionId!)}&status=published`);
      const restoredCollectionPayload = await restoredCollectionResponse.json() as { data?: { entries?: MemoryEntry[] } };
      expect(restoredCollectionResponse.ok(), JSON.stringify(restoredCollectionPayload)).toBeTruthy();
      expect(restoredCollectionPayload.data?.entries?.some((entry) => entry.id === entryId && entry.status === 'published')).toBe(true);

      readerContext = await browser.newContext();
      const readerPage = await readerContext.newPage();
      await login(readerPage, READER_EMAIL!, READER_PASSWORD!);
      await readerPage.goto(`/en/settings?tab=memory&scope=workspace&memoryWorkspaceId=${encodeURIComponent(workspaceId!)}&status=published&collectionId=${encodeURIComponent(collectionId!)}`);
      await expect(readerPage.getByTestId('workspace-memory-owner-select')).toHaveValue(workspaceId!);
      await expect(readerPage.getByText(proposalContent)).toBeVisible();
      await expect(readerPage.getByRole('button', { name: 'Edit' })).toHaveCount(0);
      await expect(readerPage.getByRole('button', { name: 'Archive' })).toHaveCount(0);

      await writerPage.goto(`/en/settings?tab=memory&scope=workspace&memoryWorkspaceId=${encodeURIComponent(workspaceId!)}&status=published&collectionId=${encodeURIComponent(collectionId!)}`);
      await expect(writerPage.getByText(proposalContent)).toBeVisible();

      externalContext = await browser.newContext();
      const externalPage = await externalContext.newPage();
      await login(externalPage, EXTERNAL_EMAIL!, EXTERNAL_PASSWORD!);
      const externalResponse = await externalPage.request.get('/api/memory?scope=organization');
      expect(externalResponse.ok()).toBe(false);
    } finally {
      await Promise.all([readerContext?.close(), writerContext?.close(), externalContext?.close()]);
      await page.request.delete(`/api/workspaces/${encodeURIComponent(workspaceId!)}`);
    }
  });
});
