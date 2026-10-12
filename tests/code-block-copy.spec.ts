import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createAuthenticatedContext, enterMarkdownEditMode, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { withOwnedTestCleanup } from './helpers/owned-test-cleanup';

const CODE = 'First line\nSecond line\n\nOne empty line\n\n\n\nThree empty lines\n  Indented <tag> & text\n- literal bullet\n1. literal number';
const MARKDOWN = `\`\`\`text\n${CODE}\n\`\`\`\n`;

test.use({ actionTimeout: 15_000 });

async function readClipboard(page: Page) {
  return page.evaluate(async () => {
    const item = (await navigator.clipboard.read())[0];
    return {
      text: await (await item.getType('text/plain')).text(),
      html: item.types.includes('text/html') ? await (await item.getType('text/html')).text() : null,
    };
  });
}

async function pasteIntoOrdinaryEditor(page: Page, text: string, formatted: boolean, screenshotPath?: string) {
  // Stage a normal rich-text paste target. Copy and paste themselves use real
  // controls and keyboard input, including the browser's clipboard transport.
  await page.evaluate(() => {
    document.getElementById('clipboard-paste-target')?.remove();
    const target = document.createElement('div');
    target.id = 'clipboard-paste-target';
    target.contentEditable = 'true';
    target.setAttribute('aria-label', 'Clipboard paste target');
    target.style.cssText = 'position:fixed;inset:10px;z-index:99999;overflow:auto;background:white;color:black;padding:20px;font:18px/1.5 sans-serif;white-space:pre-wrap;';
    document.body.append(target);
  });
  const target = page.locator('#clipboard-paste-target');
  await target.click();
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(() => target.innerText()).toBe(text);
  if (formatted) {
    await expect(target.locator('pre, code, ul, ol')).toHaveCount(0);
    // Browsers may flatten the pasted HTML or discard redundant inherited
    // styles. Check the visible text's font rather than an implementation tag.
    const fonts = await target.evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const values = [];
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.trim()) continue;
        const style = getComputedStyle(walker.currentNode.parentElement!);
        values.push({ size: style.fontSize, family: style.fontFamily });
      }
      return values;
    });
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      expect(font.size).toBe('18px');
      expect(font.family).toContain('sans-serif');
    }
  }
  if (screenshotPath) await page.screenshot({ path: screenshotPath, animations: 'disabled' });
  await target.evaluate(element => element.remove());
}

async function checkCodeBlockCopy(page: Page, control: Locator) {
  await control.hover();
  const primary = control.locator('[data-testid$="-primary"]');
  await primary.click();
  await expect(primary).toHaveAttribute('aria-label', 'Copied');
  const rich = await readClipboard(page);
  expect(rich.text).toBe(CODE);
  expect(rich.html).toContain('<br><br><br><br>');
  expect(rich.html).not.toMatch(/<(?:pre|code|ul|ol)\b/);
  await pasteIntoOrdinaryEditor(page, CODE, true);

  await expect(primary).toHaveAttribute('aria-label', 'Copy formatted');
  await control.locator('[data-testid$="-options"]').click();
  await page.getByRole('menuitem', { name: 'Copy formatted', exact: true }).click();
  await expect(primary).toHaveAttribute('aria-label', 'Copied');
  expect((await readClipboard(page)).text).toBe(CODE);

  await expect(primary).toHaveAttribute('aria-label', 'Copy formatted');
  await control.locator('[data-testid$="-options"]').click();
  await page.getByRole('menuitem', { name: 'Copy as plain text', exact: true }).click();
  await expect(primary).toHaveAttribute('aria-label', 'Copied');
  expect(await readClipboard(page)).toEqual({ text: CODE, html: null });
  await pasteIntoOrdinaryEditor(page, CODE, false);
}

async function mockCodeConversation(page: Page, fixture: {
  workspaceId: string; workspaceName: string; userId: string; sessionId: string;
}) {
  const timestamp = Date.now();
  const session = {
    id: 1, sessionId: fixture.sessionId, title: 'Code clipboard acceptance', agentId: 'canvas-agent',
    engine: 'pi', model: 'mock-model', provider: 'mock', createdAt: new Date(timestamp).toISOString(),
    lastMessageAt: new Date(timestamp).toISOString(), hasUnread: false,
    workspace: { workspaceId: fixture.workspaceId, workspaceType: 'personal', workspaceName: fixture.workspaceName },
  };
  const history = { success: true, engine: 'pi', hasMoreBefore: false, messages: [
    { id: 1, role: 'user', timestamp, content: [{ type: 'text', text: 'Show the literal post.' }] },
    { id: 2, role: 'assistant', timestamp: timestamp + 1, content: [{ type: 'text', text: MARKDOWN }],
      api: 'mock', provider: 'mock', model: 'mock-model', stopReason: 'stop', usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      } },
  ] };
  await page.route('**/api/sessions**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/sessions' && route.request().method() === 'GET') {
      await route.fulfill({ json: { success: true, sessions: [session] } });
    } else if (url.pathname === `/api/sessions/${fixture.sessionId}/bootstrap`) {
      await route.fulfill({ json: { success: true, session, messages: history } });
    } else if (url.pathname === '/api/sessions/messages' && url.searchParams.get('sessionId') === fixture.sessionId) {
      await route.fulfill({ json: history });
    } else if (url.pathname === '/api/sessions' && route.request().method() === 'PATCH') {
      await route.fulfill({ json: { success: true, session } });
    } else await route.fallback();
  });
  await page.route('**/api/delegations**', route => route.fulfill({ json: { success: true, delegations: [] } }));
  await page.routeWebSocket('**/ws/chat', socket => {
    socket.send(JSON.stringify({ type: 'auth_success', userId: fixture.userId }));
    socket.onMessage(raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'subscribe_session') socket.send(JSON.stringify({
        type: 'subscribe_result', requestId: message.requestId, success: true, sessionId: fixture.sessionId,
      }));
      if (message.type === 'get_status') socket.send(JSON.stringify({
        type: 'status_result', requestId: message.requestId, success: true, status: {
          sessionId: fixture.sessionId, revision: 0, phase: 'idle', activeTool: null, pendingToolCalls: 0,
          followUpQueue: [], steeringQueue: [], canAbort: false, contextWindow: 128_000,
          estimatedHistoryTokens: 0, availableHistoryTokens: 100_000, contextUsagePercent: 0,
          includedSummary: false, omittedMessageCount: 0, summaryUpdatedAt: null, lastCompactionAt: null,
          lastCompactionKind: null, lastCompactionOmittedCount: 0,
          compactionStatus: { state: 'idle', attemptId: null, trigger: null, reasonCode: null, retryAfter: null, omittedMessageCount: 0 },
        },
      }));
    });
  });
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 960 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`literal clipboard layout in notebook and chat on ${viewport.name}`, async ({ browser }, info) => {
    test.setTimeout(180_000);
    const context = await createAuthenticatedContext(browser, { viewport });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    const filePath = `code-clipboard-${randomUUID()}.md`;
    const workspaceName = `Clipboard QA ${randomUUID()}`;
    let workspaceId: string | undefined;
    let userId: string | undefined;
    await withOwnedTestCleanup(async () => {
      const auth = await context.request.get('/api/auth/get-session');
      expect(auth.status()).toBe(200);
      userId = (await auth.json()).user.id;
      const response = await context.request.post('/api/workspaces', { data: { type: 'personal', name: workspaceName } });
      const workspace = (await response.json()).workspace;
      workspaceId = workspace.id;
      expect(response.status()).toBe(201);
      expect(workspace).toMatchObject({ name: workspaceName, ownerUserId: userId, type: 'personal' });
      await context.addInitScript(id => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspace.id);
      await uploadWorkspaceTextFile({ request: context.request, workspaceId: workspace.id, filePath, content: MARKDOWN });
      await page.goto(`/en/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Read', exact: true }).click();
      await checkCodeBlockCopy(page, page.getByTestId('markdown-code-block-copy'));
      await enterMarkdownEditMode(page);
      await checkCodeBlockCopy(page, page.getByTestId('markdown-editor-code-block-copy'));
      await page.screenshot({ path: info.outputPath(`code-block-editor-${viewport.name}.png`), animations: 'disabled' });
      const persisted = await context.request.get('/api/files/read', { headers: { 'x-canvas-workspace-id': workspace.id }, params: { path: filePath } });
      expect((await persisted.json()).data.content).toBe(MARKDOWN);

      const sessionId = `sess-code-clipboard-${randomUUID()}`;
      await context.addInitScript(() => {
        localStorage.setItem('canvas.notebook.chatVisible', 'true');
        localStorage.removeItem('canvas.chat.lastSessionId.v1');
        localStorage.removeItem('canvas.chat.sessionMessages.v1');
      });
      await mockCodeConversation(page, { workspaceId: workspace.id, workspaceName: workspace.name, userId: userId!, sessionId });
      await page.goto(`/en/notebook?workspaceId=${workspace.id}&chat=open&session=${sessionId}`, { waitUntil: 'domcontentloaded' });
      const assistant = page.getByTestId('chat-message-assistant');
      await expect(assistant).toHaveCount(1, { timeout: 30_000 });
      await checkCodeBlockCopy(page, assistant.getByTestId('chat-code-block-copy'));
      await assistant.hover();
      const messageCopy = page.getByTestId('chat-message-actions-assistant').getByRole('button', { name: 'Copy formatted', exact: true });
      await messageCopy.click();
      await expect(page.getByTestId('chat-message-actions-assistant').getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
      const wholeMessage = await readClipboard(page);
      expect(wholeMessage.html).toContain('<br><br><br><br>');
      expect(wholeMessage.html).not.toMatch(/<(?:pre|code)\b/);
      await pasteIntoOrdinaryEditor(page, CODE, true, info.outputPath(`code-block-pasted-${viewport.name}.png`));
      await page.screenshot({ path: info.outputPath(`code-block-chat-${viewport.name}.png`), animations: 'disabled' });
    }, [
      { label: 'close clipboard page', run: () => page.close() },
      { label: 'remove owned clipboard workspace', run: async () => {
        if (!workspaceId) return;
        const auth = await context.request.get('/api/auth/get-session');
        expect((await auth.json()).user.id).toBe(userId);
        const listing = await context.request.get('/api/workspaces');
        const owned = (await listing.json()).workspaces.find((entry: { id: string }) => entry.id === workspaceId);
        expect(owned).toMatchObject({ id: workspaceId, name: workspaceName, ownerUserId: userId, type: 'personal' });
        const deleted = await context.request.delete(`/api/workspaces/${workspaceId}`, { timeout: 30_000 });
        expect(deleted.status(), 'The test must remove its own fixture').toBe(200);
      } },
      { label: 'close clipboard context', run: () => context.close() },
    ]);
  });
}
