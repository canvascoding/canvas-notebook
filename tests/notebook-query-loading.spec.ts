import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';

test.setTimeout(60_000);

test('cold document entry with a hidden chat makes no chat queries', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((value: { type: string }) => value.type === 'personal');
  const filePath = `query-loading-${randomUUID()}.md`;
  await uploadWorkspaceTextFile({ request: page.request, workspaceId: workspace.id, filePath, content: '# Document loading QA\n\nIndependent document surface.\n' });
  try {
    await page.addInitScript(id => {
      localStorage.setItem('canvas.activeWorkspaceId', id);
      localStorage.setItem('canvas.notebookLayout.v2', JSON.stringify({ version: 2, chatDocked: false }));
    }, workspace.id);
    const chatReads: string[] = [];
    page.on('request', request => {
      if (/\/api\/(?:sessions|agent-runtime)(?:\/|\?|$)/.test(new URL(request.url()).pathname)) chatReads.push(request.url());
    });
    await page.goto(`/de/notebook?workspaceId=${workspace.id}&path=${encodeURIComponent(filePath)}`);
    await expect(page.getByRole('button', { name: 'Bearbeiten', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('chat-input')).toHaveCount(0);
    await expect(page.getByText('Independent document surface.', { exact: true })).toBeVisible();
    expect(chatReads).toEqual([]);
    await page.screenshot({ path: info.outputPath('document-without-chat.png') });
  } finally {
    const deleted = await page.request.delete('/api/files/delete', {
      headers: { 'x-canvas-workspace-id': workspace.id }, data: { path: filePath },
    });
    expect(deleted.ok()).toBeTruthy();
    await context.close();
  }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(page: Page) {
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((value: { type: string }) => value.type === 'personal');
  const sessions: Array<{ sessionId: string; agentId: string; title: string }> = [];
  for (const suffix of ['A', 'B']) {
    const response = await page.request.post('/api/sessions', {
      headers: { 'x-canvas-workspace-id': workspace.id },
      data: { workspaceId: workspace.id, agentId: 'bradley', title: `Loading QA ${suffix} ${randomUUID()}` },
    });
    expect(response.ok()).toBeTruthy();
    sessions.push((await response.json()).session);
  }
  await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  const marker = (id: string) => `Visible history ${id}`;
  const messages = (id: string) => ({ success: true, engine: 'pi', hasMoreBefore: false,
    messages: [{ id: 1, sequence: 1, role: 'user', content: marker(id), timestamp: Date.now() }] });
  return {
    sessions, marker, messages,
    url: (id: string) => `/de/notebook?workspaceId=${workspace.id}&session=${id}&chat=open`,
    bootstrap: async (id: string) => {
      const response = await page.request.get(`/api/sessions/${id}/bootstrap?workspaceId=${workspace.id}`);
      expect(response.ok()).toBeTruthy();
      return { ...await response.json(), messages: messages(id) };
    },
    cleanup: async () => {
      for (const session of sessions) {
        const deleted = await page.request.delete('/api/sessions', {
          params: { sessionId: session.sessionId, agentId: session.agentId },
        });
        expect(deleted.ok()).toBeTruthy();
      }
    },
  };
}

test('targeted bootstrap shows skeleton and does not wait for session history', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await context.newPage();
  const data = await fixture(page);
  const held = gate();
  try {
    const session = data.sessions[0];
    const payload = await data.bootstrap(session.sessionId);
    let bootstraps = 0;
    let historyReads = 0;
    let messageReads = 0;
    await page.route('**/api/sessions/**/bootstrap?*', async route => {
      bootstraps += 1;
      await held.promise;
      await route.fulfill({ json: payload });
    });
    await page.route(/\/api\/sessions\?/, async route => {
      historyReads += 1;
      await route.fulfill({ status: 503, json: { success: false } });
    });
    page.on('request', request => { if (request.url().includes('/api/sessions/messages?')) messageReads += 1; });
    await page.goto(data.url(session.sessionId));
    await expect.poll(() => bootstraps).toBe(1);
    await expect(page.getByTestId('chat-messages-skeleton')).toBeVisible();
    await page.screenshot({ path: info.outputPath('bootstrap-skeleton.png') });
    expect(historyReads).toBe(0);
    held.release();
    await expect(page.getByTestId('chat-message-user')).toContainText(data.marker(session.sessionId));
    await expect(page.getByTestId('chat-messages-skeleton')).toHaveCount(0);
    expect(messageReads).toBe(0);
    await page.screenshot({ path: info.outputPath('bootstrap-loaded.png') });
  } finally { held.release(); await data.cleanup(); await context.close(); }
});

test('warm history stays mounted and late A response cannot replace B', async ({ browser }, info) => {
  const context = await createAuthenticatedContext(browser);
  const page = await context.newPage();
  const data = await fixture(page);
  const held = gate();
  try {
    const [a, b] = data.sessions;
    const payload = await data.bootstrap(a.sessionId);
    let heldReads = 0;
    let posts = 0;
    await page.route('**/api/sessions/**/bootstrap?*', route => route.fulfill({ json: payload }));
    await page.route(/\/api\/sessions\?/, route => route.fulfill({ json: { success: true, sessions: data.sessions } }));
    await page.route('**/api/sessions/messages?*', async route => {
      const id = new URL(route.request().url()).searchParams.get('sessionId')!;
      if (id === a.sessionId) { heldReads += 1; await held.promise; }
      await route.fulfill({ json: data.messages(id) });
    });
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions') posts += 1; });
    await page.goto(data.url(a.sessionId));
    await expect(page.getByTestId('chat-message-user')).toContainText(data.marker(a.sessionId));
    await page.getByRole('button', { name: 'Neuer Chat', exact: true }).click();
    await expect(page.getByTestId('chat-message-user')).toHaveCount(0);
    expect(posts).toBe(0);
    await page.getByTestId('chat-history-toggle').click();
    await page.getByRole('button', { name: new RegExp(`^${a.title}`) }).click();
    await expect.poll(() => heldReads).toBe(1);
    await expect(page.getByTestId('chat-message-user')).toContainText(data.marker(a.sessionId));
    await expect(page.getByTestId('chat-messages-skeleton')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('warm-refresh.png') });
    await page.getByRole('button', { name: new RegExp(`^${b.title}`) }).click();
    await expect(page.getByTestId('chat-message-user')).toContainText(data.marker(b.sessionId));
    const response = page.waitForResponse(value => value.url().includes('/api/sessions/messages?') && value.url().includes(a.sessionId));
    held.release();
    await response;
    await expect(page.getByTestId('chat-message-user')).toContainText(data.marker(b.sessionId));
    await expect(page.getByTestId('chat-message-user')).not.toContainText(data.marker(a.sessionId));
    expect(posts).toBe(0);
  } finally { held.release(); await data.cleanup(); await context.close(); }
});

test('failed bootstrap can be retried without creating a session', async ({ browser }) => {
  const context = await createAuthenticatedContext(browser);
  const page = await context.newPage();
  const data = await fixture(page);
  try {
    const session = data.sessions[0];
    const payload = await data.bootstrap(session.sessionId);
    let reads = 0;
    await page.route('**/api/sessions/**/bootstrap?*', async route => {
      reads += 1;
      await route.fulfill(reads === 1 ? { status: 503, json: { success: false, error: 'Delayed backend unavailable' } } : { json: payload });
    });
    await page.goto(data.url(session.sessionId));
    await expect(page.getByText('Delayed backend unavailable')).toBeVisible();
    await page.getByRole('button', { name: /Erneut versuchen|Wiederholen/ }).click();
    await expect(page.getByTestId('chat-message-user')).toContainText(data.marker(session.sessionId));
    expect(reads).toBe(2);
  } finally { await data.cleanup(); await context.close(); }
});
