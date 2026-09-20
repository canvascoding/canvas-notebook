import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

type Operation = { operationId: string; operationStatus: string; durability: string; sessionId?: string; proposalVersion?: string };
type RuntimeEvent = { type: string; success?: boolean; error?: string; event?: { type?: string; toolName?: string; isError?: boolean } };

test('a normal chat agent edits the live document after its owner grants permission', async ({ browser }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1' || process.env.COLLABORATION_AGENT_RUNTIME_E2E !== '1',
    'Requires the managed stack and explicit use of its configured agent runtime.');
  test.setTimeout(360_000);
  const base = process.env.BASE_URL!;
  const mobileReview = Boolean(process.env.MOBILE_AGENT_PREVIEW_HTML);
  const operationBase = mobileReview ? '/api/mobile/v1/notebook/collaboration/operations' : '/api/files/collaboration/operations';
  const { baseURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } = info.project.use;
  const contextOptions = { baseURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor };
  const owner = await browser.newContext(contextOptions);
  const collaborator = await browser.newContext(contextOptions);
  const page = await owner.newPage();
  const peer = await collaborator.newPage();
  const errors: string[] = [];
  for (const target of [page, peer]) target.on('pageerror', error => errors.push(error.message));
  const login = async (target: Page, email: string, password: string) => {
    const response = await target.request.post('/api/auth/sign-in/email', { headers: { Origin: base }, data: { email, password } });
    expect(response.ok()).toBe(true);
    return (await response.json()).user.id as string;
  };
  const ownerEmail = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
  const ownerPassword = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
  expect(Boolean(ownerEmail && ownerPassword), 'Managed fixture credentials are required.').toBe(true);
  const ownerId = await login(page, ownerEmail!, ownerPassword!);
  const peerId = await login(peer, ownerEmail!, ownerPassword!);
  expect(peerId).toBe(ownerId);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((item: { name: string }) => item.name === 'Shared Test Workspace');
  expect(workspace?.permissions.canWrite).toBe(true);
  const headers = { 'x-canvas-workspace-id': workspace.id as string };
  const filePath = `live-runtime-${randomUUID()}.md`;
  let sessionId: string | undefined;
  let socket: WebSocket | undefined;
  let grantedOperationId: string | undefined;
  const events: RuntimeEvent[] = [];
  const editor = page.locator('.tiptap-editor-shell .ProseMirror');
  const peerEditor = peer.locator('.tiptap-editor-shell .ProseMirror');
  try {
    const upload = await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
      name: filePath, mimeType: 'text/markdown', buffer: Buffer.from('Agent original\n\nHuman paragraph'),
    } } });
    expect(upload.ok()).toBe(true);
    for (const context of [owner, collaborator]) await context.addInitScript(id => {
      localStorage.setItem('canvas.activeWorkspaceId', id);
      localStorage.setItem('canvas.notebook.chatVisible', 'false');
    }, workspace.id);
    for (const target of [page, peer]) {
      await target.goto(`/notebook?path=${encodeURIComponent(filePath)}`);
      await target.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(target.locator('.tiptap-editor-shell .ProseMirror')).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
    }
    const reviewPolicy = page.getByRole('switch', {
      name: /Require review for agent changes|Review für Agentenänderungen erforderlich|Edit directly when safe|Direkt bearbeiten, wenn sicher/u,
    });
    await expect(reviewPolicy).not.toBeChecked({ timeout: 30_000 });
    await reviewPolicy.click();
    await expect(reviewPolicy).toBeChecked();
    const read = await page.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers });
    const documentId = (await read.json()).data.collaboration.document.id as string;
    const operations = async (): Promise<Operation[]> => {
      const response = await page.request.get(operationBase, { headers, params: { documentId } });
      expect(response.ok()).toBe(true);
      return (await response.json()).operations;
    };
    const created = await page.request.post('/api/sessions', { headers,
      data: { agentId: 'canvas-agent', workspaceId: workspace.id, title: 'Live agent acceptance' } });
    expect(created.ok()).toBe(true);
    sessionId = (await created.json()).session.sessionId;
    expect(sessionId).toBeTruthy();
    const cookies = (await owner.cookies(base)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    socket = new WebSocket(`${base.replace(/^http/u, 'ws')}/ws/chat`, 'canvas-chat-v1', { headers: { Cookie: cookies, Origin: base } });
    socket.on('message', data => events.push(JSON.parse(data.toString()) as RuntimeEvent));
    socket.on('error', error => errors.push(error.message));
    await expect.poll(() => events.some(event => event.type === 'auth_success'), { timeout: 20_000 }).toBe(true);
    const send = (before: string, after: string) => {
      socket!.send(JSON.stringify({ type: 'send_message', requestId: randomUUID(), clientMessageId: randomUUID(),
        sessionId, agentId: 'canvas-agent',
        message: { role: 'user', timestamp: Date.now(), content:
          `Edit only the existing document ${filePath} in this workspace. First use the read tool to read its current live contents. `
          + `Then use edit_file to replace the exact paragraph "${before}" with "${after}". Preserve the human paragraph and all other content. `
          + 'Use only read and edit_file for this task; do not use shell, write, or other file tools. Execute the tool even if it produces a proposal for my approval. Then stop.' },
        context: { channelId: 'app', currentPage: '/notebook', activeFilePath: filePath,
          workspace: { workspaceId: workspace.id, workspaceType: workspace.type, workspaceName: workspace.name,
            organizationId: workspace.organizationId, canWrite: true, canDelete: true, canShare: true } },
      }));
    };
    send('Agent original', 'Agent reviewed');
    await expect.poll(async () => (await operations()).filter(operation => operation.operationStatus === 'needs_review').length,
      { timeout: 120_000, intervals: [1_000, 2_000] }).toBe(1);
    await expect.poll(() => events.filter(event => event.type === 'agent_event' && event.event?.type === 'message_saved').length,
      { timeout: 60_000 }).toBe(1);
    const proposal = (await operations()).find(operation => operation.operationStatus === 'needs_review')!;
    await expect(editor.locator('p').first()).toHaveText('Agent original');
    if (mobileReview) {
      const preview = await owner.newPage();
      await preview.addInitScript(operation => {
        const messages: unknown[] = [];
        Object.assign(window, { previewMessages: messages, ReactNativeWebView: {
          injectedObjectJson: () => JSON.stringify({ operation, theme: 'light', labels: {
            before: 'Current version', after: 'Proposed version', change: 'Change', exactText: 'Exact Markdown',
            block: 'Block', edited: 'Edited', moved: 'Moved', document: 'Document', atEnd: 'at the end', beforePosition: 'before',
          } }), postMessage: (raw: string) => messages.push(JSON.parse(raw)),
        } });
      }, proposal);
      const remoteRequests: string[] = [];
      preview.on('request', request => { if (!request.url().startsWith(base)) remoteRequests.push(request.url()); });
      await preview.route('**/__expo-agent-preview', route => route.fulfill({ contentType: 'text/html', body: readFileSync(process.env.MOBILE_AGENT_PREVIEW_HTML!, 'utf8') }));
      await preview.goto('/__expo-agent-preview');
      await expect(preview.locator('body')).toContainText('Agent original');
      await expect(preview.locator('body')).toContainText('Agent reviewed');
      const ready = await preview.evaluate(() => (window as unknown as { previewMessages: { valid: boolean; proposalVersion: string }[] }).previewMessages.at(-1));
      expect(ready).toMatchObject({ valid: true, proposalVersion: proposal.proposalVersion });
      expect(remoteRequests).toEqual([]);
      await preview.screenshot({ path: info.outputPath('expo-agent-preview.png') });
      await preview.close();
      const changed = await page.request.post(`${operationBase}/${proposal.operationId}/accept`, { headers,
        data: { idempotencyKey: randomUUID(), proposalVersion: `v1.${'0'.repeat(64)}` } });
      expect(changed.status()).toBe(409);
      expect((await changed.json()).code).toBe('AGENT_PROPOSAL_CHANGED');
      await expect(editor.locator('p').first()).toHaveText('Agent original');
      const grantReply = await page.request.post(`${operationBase}/${proposal.operationId}/direct-edit-grant`, { headers,
        data: { action: 'grant', idempotencyKey: randomUUID() } });
      expect(grantReply.ok()).toBe(true); grantedOperationId = proposal.operationId;
      const acceptance = { idempotencyKey: randomUUID(), proposalVersion: proposal.proposalVersion };
      for (let attempt = 0; attempt < 2; attempt++) {
        const accepted = await page.request.post(`${operationBase}/${proposal.operationId}/accept`, { headers, data: acceptance });
        expect(accepted.ok()).toBe(true);
      }
      await expect(peerEditor.locator('p').first()).toHaveText('Agent reviewed');
    } else {
      await page.getByRole('button', { name: /Open agent changes|Offene Agentenänderungen/u }).click();
      const center = page.getByTestId('file-version-center');
      await expect(center).toBeVisible();
      await expect(center).toContainText('Agent reviewed');
      const grantReply = await page.request.post(`${operationBase}/${proposal.operationId}/direct-edit-grant`, { headers,
        data: { action: 'grant', idempotencyKey: randomUUID() } });
      expect(grantReply.ok()).toBe(true);
      grantedOperationId = proposal.operationId;
      await expect(editor.locator('p').first()).toHaveText('Agent original');
      const accept = center.getByRole('button', { name: /^(Accept change|Änderung annehmen)$/u });
      const retry = center.getByRole('button', { name: /^(Refresh timeline|Timeline neu laden)$/u });
      await expect(accept.or(retry)).toBeVisible({ timeout: 30_000 });
      if (await retry.isVisible()) {
        await retry.click();
        await expect(accept).toBeVisible({ timeout: 30_000 });
      }
      const acceptReply = page.waitForResponse(response => response.url().endsWith(`/operations/${proposal.operationId}/accept`) && response.request().method() === 'POST');
      await accept.click();
      expect((await acceptReply).ok()).toBe(true);
      await expect(peerEditor.locator('p').first()).toHaveText('Agent reviewed');
      await page.keyboard.press('Escape');
      await expect(center).toBeHidden();
    }
    await reviewPolicy.click();
    await expect(reviewPolicy).not.toBeChecked();
    const previousIds = new Set((await operations()).map(operation => operation.operationId));
    send('Agent reviewed', 'Agent direct');
    const human = peerEditor.locator('p').filter({ hasText: /^Human paragraph$/u });
    await human.click();
    await peer.keyboard.press('End');
    await peer.keyboard.insertText(' edited concurrently by another user');
    await expect(editor.locator('p').first()).toHaveText('Agent direct', { timeout: 120_000 });
    await expect(peerEditor.locator('p').first()).toHaveText('Agent direct');
    await expect.poll(() => editor.locator('p').last().evaluate((element) => {
      const content = element.cloneNode(true) as HTMLElement;
      content.querySelectorAll('.collaboration-carets__label').forEach(label => label.remove());
      return content.textContent;
    })).toBe('Human paragraph edited concurrently by another user');
    await expect.poll(async () => (await operations()).filter(operation => !previousIds.has(operation.operationId))
      .map(operation => operation.operationStatus), { timeout: 30_000 }).toEqual([expect.stringMatching(/^(persisted_yjs|checkpointed_file)$/u)]);
    await expect.poll(() => events.filter(event => event.type === 'agent_event' && event.event?.type === 'message_saved').length,
      { timeout: 60_000 }).toBe(2);
    expect(events.filter(event => event.type === 'send_message_result' && event.success === false)).toEqual([]);
    expect(events.filter(event => event.type === 'agent_event' && event.event?.type === 'tool_execution_end' && event.event.isError)).toEqual([]);
    for (const target of [page, peer]) await expect(target.getByTestId('markdown-save-state')).toHaveCount(0);
    if (mobileReview) {
      const direct = (await operations()).find(operation => !previousIds.has(operation.operationId))!;
      const result = await page.request.post(`${operationBase}/${direct.operationId}/revert`, { headers, data: { idempotencyKey: randomUUID() } });
      expect(result.ok()).toBe(true);
      await expect(editor.locator('p').first()).toHaveText('Agent reviewed');
      await expect(peerEditor.locator('p').last()).toContainText('Human paragraph edited concurrently by another user');
    }
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('agent-and-two-users.png') });
    await info.attach('real runtime evidence', { body: Buffer.from(JSON.stringify({
      independentBrowserSessions: true, distinctUsers: ownerId !== peerId, operations: await operations(),
      tools: events.filter(event => event.event?.type === 'tool_execution_end').map(event => event.event?.toolName),
    })), contentType: 'application/json' });
  } finally {
    if (grantedOperationId) await page.request.post(`${operationBase}/${grantedOperationId}/direct-edit-grant`,
      { headers, data: { action: 'revoke', idempotencyKey: randomUUID() } });
    if (socket?.readyState === WebSocket.OPEN && sessionId) socket.send(JSON.stringify({ type: 'control', sessionId, action: 'abort' }));
    socket?.close();
    if (sessionId) await page.request.delete('/api/sessions', { params: { sessionId, agentId: 'canvas-agent' } });
    await page.goto('about:blank');
    await peer.goto('about:blank');
    await page.request.delete('/api/files/delete', { headers, data: { path: filePath } });
    await owner.close();
    await collaborator.close();
  }
});
