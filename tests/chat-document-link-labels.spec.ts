import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { withOwnedTestCleanup } from './helpers/owned-test-cleanup';

const ASSISTANT_MARKDOWN = [
  'Plain: [test.md](test.md)',
  'Path: [notes/path.md](notes/path.md)',
  'Inline: [`test.md`](test.md)',
  'Formatted: [**test.md**](test.md)',
  'Unicode: [überblick.md](überblick.md)',
  'Markdown: [guide.markdown](guide.markdown)',
  'MDX: [example.mdx](example.mdx)',
  'Uppercase: [README.MD](README.MD)',
  'Custom: [Projektplan](test.md)',
  'Filename alias: [choices.md](test.md)',
  'Wiki: [[notes/path.md]]',
  'Wiki Unicode: [[überblick.md]]',
  'Wiki alias: [[test.md|test.md]]',
  'External: [test.md](https://example.com/test.md)',
  'Other file: [data.csv](data.csv)',
  '```md\n[test.md](test.md)\n[[notes/path.md]]\n```',
].join('\n\n');

const EMPTY_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Only the deterministic agent history/transport is mocked; file lookup, preview and opening use the server. */
async function mockDocumentLinkConversation(page: Page, fixture: {
  sessionId: string; workspaceId: string; workspaceName: string; userId: string;
}): Promise<void> {
  const now = Date.now();
  const session = {
    id: 1, sessionId: fixture.sessionId, title: 'Document link display acceptance', agentId: 'canvas-agent',
    model: 'kimi-k2.6:cloud', provider: 'ollama', engine: 'pi', createdAt: new Date(now).toISOString(),
    lastMessageAt: new Date(now).toISOString(), lastViewedAt: new Date(now).toISOString(), hasUnread: false,
    workspace: { workspaceId: fixture.workspaceId, workspaceType: 'personal', workspaceName: fixture.workspaceName },
  };
  const history = {
    success: true, engine: 'pi', hasMoreBefore: false,
    messages: [
      { id: 1, role: 'user', timestamp: now, content: [{ type: 'text', text: 'User filename: [test.md](test.md)\n\nUser path: [notes/path.md](notes/path.md)' }] },
      { id: 2, role: 'assistant', timestamp: now + 1, content: [{ type: 'text', text: ASSISTANT_MARKDOWN }],
        api: 'mock', provider: 'mock', model: 'mock-model', usage: EMPTY_USAGE, stopReason: 'stop' },
    ],
  };
  await page.route('**/api/sessions**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/api/sessions' && method === 'GET') {
      await route.fulfill({ json: { success: true, sessions: [session] } });
    } else if (url.pathname === `/api/sessions/${fixture.sessionId}/bootstrap` && method === 'GET') {
      expect(url.searchParams.get('workspaceId')).toBe(fixture.workspaceId);
      await route.fulfill({ json: { success: true, session, messages: history } });
    } else if (url.pathname === '/api/sessions/messages' && url.searchParams.get('sessionId') === fixture.sessionId && method === 'GET') {
      await route.fulfill({ json: history });
    } else if (url.pathname === '/api/sessions' && method === 'PATCH') {
      expect(route.request().postDataJSON().sessionId).toBe(fixture.sessionId);
      await route.fulfill({ json: { success: true, session } });
    } else {
      await route.fallback();
    }
  });
  await page.route((url) => url.pathname === '/api/delegations' && url.searchParams.get('sourceSessionId') === fixture.sessionId, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: { success: true, delegations: [] } });
  });
  await page.routeWebSocket('**/ws/chat', (socket) => {
    socket.send(JSON.stringify({ type: 'auth_success', userId: fixture.userId }));
    socket.onMessage((rawMessage) => {
      const message = JSON.parse(rawMessage.toString()) as { type: string; requestId?: string };
      if (message.type === 'subscribe_session') {
        socket.send(JSON.stringify({ type: 'subscribe_result', requestId: message.requestId, success: true, sessionId: fixture.sessionId }));
      } else if (message.type === 'get_status') {
        socket.send(JSON.stringify({ type: 'status_result', requestId: message.requestId, success: true, status: {
          sessionId: fixture.sessionId, revision: 0, phase: 'idle', activeTool: null, pendingToolCalls: 0,
          followUpQueue: [], steeringQueue: [], canAbort: false, contextWindow: 128_000,
          estimatedHistoryTokens: 0, availableHistoryTokens: 100_000, contextUsagePercent: 0,
          includedSummary: false, omittedMessageCount: 0, summaryUpdatedAt: null, lastCompactionAt: null,
          lastCompactionKind: null, lastCompactionOmittedCount: 0,
          compactionStatus: { state: 'idle', attemptId: null, trigger: null, reasonCode: null, retryAfter: null, omittedMessageCount: 0 },
        } }));
      }
    });
  });
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 960 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`assistant document labels stay readable and open the real document on ${viewport.name}`, async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const context = await createAuthenticatedContext(browser, { viewport: { width: viewport.width, height: viewport.height } });
    const workspaceName = `E2E chat document labels ${randomUUID()}`;
    let workspaceId: string | undefined;
    let userId: string | undefined;
    let page: Page | undefined;
    const documents = new Map([
      ['test.md', '# Test\n\nReal document opened from the assistant link.\n'],
      ['notes/path.md', '# Nested document\n'],
      ['überblick.md', ''],
      ['guide.markdown', '# Guide\n'],
      ['example.mdx', '# Example\n'],
      ['README.MD', '# Readme\n'],
      ['data.csv', 'key,value\nfixture,owned\n'],
    ]);
    await withOwnedTestCleanup(async () => {
      const auth = await context.request.get('/api/auth/get-session');
      expect(auth.status()).toBe(200);
      userId = (await auth.json()).user.id;
      expect(userId).toEqual(expect.any(String));
      const created = await context.request.post('/api/workspaces', { data: { type: 'personal', name: workspaceName }, timeout: 15_000 });
      const workspace = (await created.json()).workspace;
      if (typeof workspace?.id === 'string' && workspace.id) workspaceId = workspace.id;
      expect(created.status()).toBe(201);
      expect(workspace).toMatchObject({ id: workspaceId, name: workspaceName, ownerUserId: userId, type: 'personal' });
      expect(workspaceId).toEqual(expect.any(String));
      for (const [filePath, content] of documents) {
        if (filePath === 'überblick.md') {
          // Multipart upload normalizes non-ASCII filenames. JSON creation
          // preserves this real Unicode path and its empty-byte baseline.
          const createdFile = await context.request.post('/api/files/create', {
            headers: { 'x-canvas-workspace-id': workspaceId! }, data: { path: filePath, type: 'file' }, timeout: 15_000,
          });
          expect(createdFile.status()).toBe(200);
          expect(await createdFile.json()).toEqual({ success: true });
          continue;
        }
        await uploadWorkspaceTextFile({ request: context.request, workspaceId: workspaceId!, filePath, content,
          mimeType: filePath.endsWith('.csv') ? 'text/csv' : 'text/markdown' });
      }
      for (const [filePath, content] of documents) {
        const read = await context.request.get('/api/files/read', {
          headers: { 'x-canvas-workspace-id': workspaceId! }, params: { path: filePath }, timeout: 15_000,
        });
        expect(read.status(), `Fixture exists at the exact path ${filePath}`).toBe(200);
        expect((await read.json()).data.content).toBe(content);
      }
      await context.addInitScript((id) => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'true');
        localStorage.removeItem('canvas.chat.lastSessionId.v1');
        localStorage.removeItem('canvas.chat.sessionMessages.v1');
      }, workspaceId!);
      page = await context.newPage();
      const sessionId = `sess-document-link-labels-${randomUUID()}`;
      await mockDocumentLinkConversation(page, { sessionId, workspaceId: workspaceId!, workspaceName, userId: userId! });
      await page.goto(`/en/notebook?workspaceId=${workspaceId}&chat=open&session=${sessionId}`, { waitUntil: 'domcontentloaded' });
      const assistant = page.getByTestId('chat-message-assistant');
      await expect(assistant).toHaveCount(1, { timeout: 30_000 });
      const reference = (prefix: string) => assistant.locator('p').filter({ hasText: new RegExp(`^${prefix}:`) }).locator('[data-chat-file-reference]');
      for (const [prefix, label, target] of [
        ['Plain', 'Test', 'test.md'], ['Path', 'Path', 'notes/path.md'],
        ['Inline', 'Test', 'test.md'], ['Formatted', 'Test', 'test.md'],
        ['Markdown', 'Guide', 'guide.markdown'],
        ['MDX', 'Example', 'example.mdx'], ['Uppercase', 'README', 'README.MD'],
        ['Custom', 'Projektplan', 'test.md'], ['Filename alias', 'choices.md', 'test.md'],
        ['Other file', 'data.csv', 'data.csv'],
      ]) {
        await expect(reference(prefix)).toHaveText(label, { timeout: 30_000 });
        await expect(reference(prefix)).toHaveAttribute('title', `Open ${target}`);
      }
      // URI-encoded Unicode href validation predates this display change. Its
      // label is checked independently; the real Test button proves opening.
      const unicodeReference = assistant.locator('p').filter({ hasText: /^Unicode:/ });
      await expect(unicodeReference).toHaveText('Unicode: Überblick');
      await expect(unicodeReference.locator('span[title]')).toHaveAttribute('title', 'File not found: %C3%BCberblick.md');
      await expect(unicodeReference.locator('[data-chat-file-reference]')).toHaveCount(0);
      await expect(reference('Inline').locator('code')).toHaveCount(0);
      expect(await reference('Inline').evaluate(element => getComputedStyle(element).fontFamily))
        .toBe(await reference('Plain').evaluate(element => getComputedStyle(element).fontFamily));
      const wiki = assistant.locator('p').filter({ hasText: /^Wiki:/ }).locator('[data-canvas-wiki-status]');
      await expect(wiki).toHaveText('Path');
      await expect(wiki).toHaveAttribute('data-canvas-wiki-status', 'resolved', { timeout: 30_000 });
      const unicodeWiki = assistant.locator('p').filter({ hasText: /^Wiki Unicode:/ }).locator('[data-canvas-wiki-status]');
      await expect(unicodeWiki).toHaveText('Überblick');
      await expect(unicodeWiki).toHaveAttribute('data-canvas-wiki-status', 'resolved', { timeout: 30_000 });
      await expect(assistant.locator('p').filter({ hasText: /^Wiki alias:/ }).locator('[data-canvas-wiki-status]')).toHaveText('test.md');
      await expect(assistant.getByRole('link', { name: 'test.md', exact: true })).toHaveAttribute('href', 'https://example.com/test.md');
      await expect(assistant.locator('pre code')).toHaveText('[test.md](test.md)\n[[notes/path.md]]');
      const user = page.getByTestId('chat-message-user');
      await expect(user.locator('p').filter({ hasText: /^User filename:/ }).locator('[data-chat-file-reference]')).toHaveText('test');
      await expect(user.locator('p').filter({ hasText: /^User path:/ }).locator('[data-chat-file-reference]')).toHaveText('notes/path');
      await reference('Plain').scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`chat-document-labels-${viewport.name}.png`) });
      await reference('Plain').click();
      const documentContent = page.locator('[data-testid="markdown-scroll-container"], .markdown-read-viewport');
      await expect(documentContent).toContainText('Real document opened from the assistant link.', { timeout: 30_000 });
      await expect(documentContent).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`chat-document-opened-${viewport.name}.png`) });
      for (const [filePath, content] of documents) {
        const read = await context.request.get('/api/files/read', {
          headers: { 'x-canvas-workspace-id': workspaceId! }, params: { path: filePath }, timeout: 15_000,
        });
        expect(read.status(), `Display changes preserve ${filePath}`).toBe(200);
        expect((await read.json()).data.content).toBe(content);
      }
    }, [
      { label: 'document page', run: async () => { await page?.close(); } },
      { label: 'owned workspace', run: async () => {
        if (!workspaceId) return;
        expect(userId, 'Cleanup requires the verified owning actor').toBeTruthy();
        const auth = await context.request.get('/api/auth/get-session');
        expect(auth.status()).toBe(200);
        expect((await auth.json()).user.id).toBe(userId);
        const listing = await context.request.get('/api/workspaces');
        expect(listing.status()).toBe(200);
        const workspace = (await listing.json()).workspaces.find((item: { id: string }) => item.id === workspaceId);
        expect(workspace).toMatchObject({ id: workspaceId, name: workspaceName, ownerUserId: userId, type: 'personal', status: 'active' });
        const deleted = await context.request.delete(`/api/workspaces/${workspaceId}`, { timeout: 15_000 });
        expect(deleted.status()).toBe(200);
        expect(await deleted.json()).toEqual({ success: true });
        const after = await context.request.get('/api/workspaces');
        expect(after.status()).toBe(200);
        expect((await after.json()).workspaces.some((item: { id: string }) => item.id === workspaceId)).toBe(false);
      } },
      { label: 'authenticated context', run: () => context.close() },
    ]);
  });
}
