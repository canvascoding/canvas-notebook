import { expect, test, type APIResponse, type Page } from '@playwright/test';
import type { AiAppRuntimeCatalog, AiCatalogProviderUpdate } from '../app/lib/agent-runtime-policy/types';
import { requireOwnedYjsQaTarget } from '../scripts/lib/owned-yjs-authority-qa';
import { startOwnedAgentToolModel } from './helpers/owned-agent-tool-model';
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
    const editor = page.getByRole('tabpanel', { name: filePath, exact: true }).locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(page.getByTestId('chat-inline-editor')).toHaveCount(0);
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

/** The same owned loopback provider used by the sandbox acceptance, without
 * an agent, socket or model turn. Real Session POST/bootstrap stay untouched. */
async function configureRuntimeFixture(page: Page) {
  await requireOwnedYjsQaTarget();
  const model = await startOwnedAgentToolModel(`owned-sandbox-${randomUUID().replaceAll('-', '').slice(0, 16)}`);
  expect(new URL(model.origin).hostname).toBe('127.0.0.1');
  const providers = (catalog: AiAppRuntimeCatalog): AiCatalogProviderUpdate[] => catalog.providers.map(value => ({
    providerInstallationId: value.installationId, providerId: value.providerId, enabled: value.enabled,
    credentialScope: value.credentialScope, config: value.config,
    modelIds: value.models.filter(item => item.enabled).map(item => item.id),
    defaultModelId: value.models.find(item => item.isProviderDefault)?.id ?? '',
  }));
  const json = async <T,>(response: APIResponse): Promise<T> => {
    try { expect(response.ok(), `Owned runtime fixture returned HTTP ${response.status()}.`).toBe(true);
      const bytes = await response.body(); expect(bytes.length).toBeLessThanOrEqual(4 * 1024 * 1024);
      const body = JSON.parse(bytes.toString()); expect(body.success).toBe(true); return body as T;
    } finally { await response.dispose(); }
  };
  const catalog = async () => (await json<{ data: { catalog: AiAppRuntimeCatalog } }>(
    await page.request.get('/api/admin/agent-runtime/catalog', { timeout: 30_000, maxRedirects: 0 }))).data.catalog;
  let original: AiAppRuntimeCatalog | undefined, owned: AiAppRuntimeCatalog | undefined, pendingMutation = false;
  const replace = async (data: unknown) => {
    pendingMutation = true;
    const body = await json<{ data: { catalog: AiAppRuntimeCatalog } }>(await page.request.put('/api/admin/agent-runtime/catalog', {
      data, timeout: 30_000, maxRedirects: 0 }));
    owned = body.data.catalog; pendingMutation = false; return owned;
  };
  const close = async () => {
    const errors: unknown[] = [];
    try {
      expect(pendingMutation, 'Unconfirmed catalog mutation must preserve the owned fixture.').toBe(false);
      if (owned) {
        const current = await catalog(); expect(current.revision).toBe(owned.revision);
        expect(providers(current)).toEqual(providers(owned)); expect(current.defaultSelection).toEqual(owned.defaultSelection);
        const restored = await replace({ expectedRevision: current.revision, providers: providers(original!), defaultSelection: original!.defaultSelection });
        expect(providers(restored)).toEqual(providers(original!)); expect(restored.defaultSelection).toEqual(original!.defaultSelection);
      }
      const evidence = model.evidence(); expect(evidence.failures).toEqual([]);
      expect(evidence.active).toBeNull(); expect(evidence.outcomes).toEqual([]);
    } catch (error) { errors.push(error); }
    try { await model.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Owned runtime fixture restore or local server close failed.');
  };
  try {
    original = await catalog();
    const configured = await replace({ expectedRevision: original.revision,
      providers: [...providers(original).filter(value => !(value.providerId === 'ollama' && value.credentialScope === 'system')),
        { providerId: 'ollama', enabled: true, credentialScope: 'system', modelIds: [model.model], defaultModelId: model.model,
          config: { ollamaMode: 'local', ollamaHost: model.origin, ollamaModelSource: 'custom', ollamaCustomModel: model.model } }],
      defaultSelection: null });
    const installation = configured.providers.find(value => value.providerId === 'ollama' && value.credentialScope === 'system');
    expect(installation?.config.ollamaHost).toBe(model.origin); expect(installation).toBeTruthy();
    pendingMutation = true;
    const verified = await json<{ data: { success: boolean; status: string } }>(await page.request.post(
      `/api/admin/agent-runtime/providers/${encodeURIComponent(installation!.installationId)}/verify`, { timeout: 30_000, maxRedirects: 0 }));
    pendingMutation = false; owned = await catalog();
    expect(verified.data.success).toBe(true); expect(verified.data.status).toBe('ready');
    expect(owned.providers.find(value => value.installationId === installation!.installationId)?.status).toBe('ready');
    const selection = { providerInstallationId: installation!.installationId, providerId: 'ollama', modelId: model.model, thinkingLevel: 'off' };
    const ready = await replace({ expectedRevision: owned.revision, providers: providers(owned), defaultSelection: selection });
    expect(ready.defaultSelection).toEqual(selection); expect(model.evidence().verificationProbes).toBeGreaterThan(0);
    return { close };
  } catch (cause) {
    try { await close(); } catch (cleanup) { throw new AggregateError([cause, cleanup], 'Owned runtime setup and cleanup failed.'); }
    throw cause;
  }
}

async function fixture(page: Page) {
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((value: { type: string }) => value.type === 'personal');
  const sessions: Array<{ sessionId: string; agentId: string; title: string }> = [];
  let runtime: Awaited<ReturnType<typeof configureRuntimeFixture>> | undefined;
  const cleanup = async () => {
    const errors: unknown[] = [];
    for (const session of sessions) {
      try { const deleted = await page.request.delete('/api/sessions', {
        params: { sessionId: session.sessionId, agentId: session.agentId },
      }); expect(deleted.ok()).toBeTruthy(); } catch (error) { errors.push(error); }
    }
    try { await runtime?.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Query loading session/runtime cleanup failed.');
  };
  try {
    runtime = await configureRuntimeFixture(page);
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
      cleanup,
    };
  } catch (cause) {
    const errors: unknown[] = [cause];
    try { await cleanup(); } catch (error) { errors.push(error); }
    try { await page.context().close(); } catch (error) { errors.push(error); }
    throw errors.length === 1 ? cause : new AggregateError(errors, 'Query loading setup and cleanup failed.');
  }
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
