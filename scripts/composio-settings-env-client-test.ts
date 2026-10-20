import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { patchPersonalIntegrationEnv, patchScopedIntegrationEnv } from '../app/components/settings/mcp-setup-client';
import { McpAuthorizationError } from '../app/lib/desktop/mcp-oauth-client';
import { WORKSPACE_ID_HEADER } from '../app/lib/workspaces/constants';

type Patch = { key: string; value: string | null };
type Write = { url: string; init: RequestInit; body: { scope: string; secretScope: string; patches: Patch[] } };
const composioPatch = [{ key: 'COMPOSIO_API_KEY', value: 'fixture-composio-api-key' }];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function main() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: dom.window.CustomEvent });
  const events: unknown[] = [];
  dom.window.addEventListener('canvas_secrets_updated', event => events.push((event as CustomEvent).detail));
  const writes: Write[] = [];
  let respond = async (): Promise<Response> => Response.json({ success: true });
  globalThis.fetch = async (input, init = {}) => {
    const body = JSON.parse(String(init.body)) as Write['body'];
    writes.push({ url: String(input), init, body });
    assert.equal(init.method, 'PATCH', 'provider writes never GET all secrets or replace the ENV file with PUT');
    assert.equal(init.credentials, 'include');
    return respond();
  };
  try {
    const controller = new AbortController();
    await patchScopedIntegrationEnv(composioPatch, 'Cannot save provider key.', {
      secretScope: 'system', workspaceId: 'workspace-current', signal: controller.signal, isCurrent: () => true,
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, '/api/integrations/env?scope=integrations');
    assert.deepEqual(writes[0].body, { scope: 'integrations', secretScope: 'system', patches: composioPatch });
    assert.equal(writes[0].init.signal, controller.signal);
    const headers = new Headers(writes[0].init.headers);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.get(WORKSPACE_ID_HEADER), 'workspace-current');
    assert.deepEqual(events, [{ secretScope: 'system' }]);

    await patchPersonalIntegrationEnv([{ key: 'MCP_FIXTURE_TOKEN', value: 'fixture-token' }], 'Cannot save personal key.');
    assert.deepEqual(writes[1].body, { scope: 'integrations', secretScope: 'user', patches: [{ key: 'MCP_FIXTURE_TOKEN', value: 'fixture-token' }] });
    assert.equal(new Headers(writes[1].init.headers).has(WORKSPACE_ID_HEADER), false);
    assert.deepEqual(events, [{ secretScope: 'system' }, { secretScope: 'user' }]);

    const successfulEvents = events.length;
    const initialWrites = writes.length;
    await assert.rejects(() => patchScopedIntegrationEnv(composioPatch, 'Cannot save.', {
      secretScope: 'system', isCurrent: () => false,
    }), isAbort);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(() => patchScopedIntegrationEnv(composioPatch, 'Cannot save.', {
      secretScope: 'system', signal: alreadyAborted.signal,
    }), isAbort);
    assert.equal(writes.length, initialWrites, 'obsolete or aborted contexts cause no credential write');

    // Ignore transport cancellation deliberately: the helper must also fence a
    // completed response after the caller leaves and returns to the workspace.
    for (const invalidation of ['workspace-generation', 'abort'] as const) {
      const response = deferred<Response>();
      respond = () => response.promise;
      let generation = 1;
      const observedGeneration = generation;
      const pendingController = new AbortController();
      const pending = patchScopedIntegrationEnv(composioPatch, 'Cannot save.', {
        secretScope: 'system', workspaceId: 'workspace-current', signal: pendingController.signal,
        isCurrent: () => generation === observedGeneration,
      });
      const rejected = assert.rejects(pending, isAbort);
      if (invalidation === 'abort') pendingController.abort();
      else generation += 2;
      response.resolve(Response.json({ success: true }));
      await rejected;
      assert.equal(events.length, successfulEvents, 'old completed writes never broadcast canvas_secrets_updated');
    }

    // A response can already have arrived while its JSON body is still pending.
    // Invalidate at that boundary to exercise the guard after response.json().
    let jsonCurrent = true;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    respond = async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } });
    const readingJson = patchScopedIntegrationEnv(composioPatch, 'Cannot save.', { secretScope: 'system', isCurrent: () => jsonCurrent });
    const rejectedJson = assert.rejects(readingJson, isAbort);
    await new Promise<void>(resolve => setImmediate(resolve));
    jsonCurrent = false;
    streamController.enqueue(new TextEncoder().encode('{"success":true}'));
    streamController.close();
    await rejectedJson;
    assert.equal(events.length, successfulEvents);

    for (const response of [
      Response.json({ success: false, code: 'ADMIN_REQUIRED', error: 'Instance admin permission required.' }, { status: 403 }),
      Response.json({ success: false }, { status: 503 }),
    ]) {
      respond = async () => response;
      await assert.rejects(() => patchScopedIntegrationEnv(composioPatch, 'Cannot save provider key.', { secretScope: 'system' }), error =>
        error instanceof McpAuthorizationError && (error.code === 'ADMIN_REQUIRED' || error.code === 'request_failed'));
      assert.equal(events.length, successfulEvents, 'denied or unsuccessful writes do not signal success');
    }
    respond = async () => new Response('not-json', { status: 503 });
    await assert.rejects(() => patchScopedIntegrationEnv(composioPatch, 'Cannot save.', { secretScope: 'system' }), SyntaxError);
    assert.equal(events.length, successfulEvents);
    assert.ok(writes.every(write => write.init.method === 'PATCH'));
    console.log('composio-settings-env-client-test: PASS exact system/personal PATCH, workspace/signal, pre-write and post-response/JSON stale guards, no stale success event.');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', originalCustomEvent);
    else Reflect.deleteProperty(globalThis, 'CustomEvent');
    dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
