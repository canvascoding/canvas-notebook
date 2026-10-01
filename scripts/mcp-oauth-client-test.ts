import assert from 'node:assert/strict';
import { startMcpAuthorization, waitForMcpAuthorization, readPendingMcpAuthorizations, cancelMcpAuthorization } from '../app/lib/desktop/mcp-oauth-client';

async function main() {
  const values = new Map<string, string>();
  const globals = globalThis as unknown as { window: unknown; sessionStorage: unknown; fetch: typeof fetch };
  const original = { window: globals.window, sessionStorage: globals.sessionStorage, fetch: globals.fetch };
  let opens = 0;
  let requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const state = 's'.repeat(32);
  const authorizationUrl = 'https://provider.example/authorize';
  const popup = { opener: {}, location: { href: '' }, closed: false, close() { this.closed = true; } };
  const open = () => { opens++; return popup; };
  const setFetch = (handler: (url: string, body: Record<string, unknown>) => unknown) => {
    globals.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ url, body });
      return Response.json(handler(url, body));
    }) as typeof fetch;
  };
  try {
    globals.sessionStorage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value) };
    globals.window = { open: () => null };
    await assert.rejects(() => startMcpAuthorization('remote'), { code: 'popup_blocked' });
    assert.equal(requests.length, 0, 'blocked browser popup never starts a provider transaction');

    globals.window = { open };
    setFetch(() => ({ success: true, data: { state, authorizationUrl } }));
    const normal = await startMcpAuthorization('remote');
    assert.equal(normal.desktop, false);
    assert.equal(popup.location.href, authorizationUrl);
    assert.equal(popup.opener, null);
    assert.deepEqual(readPendingMcpAuthorizations(), [normal], 'pending state survives a settings remount');
    popup.closed = true;
    setFetch(() => ({ success: true, data: { oauth: [{ serverName: 'remote', authorized: true, lastCompletedState: 'old-state' }] } }));
    await assert.rejects(() => waitForMcpAuthorization(normal, new AbortController().signal, () => undefined), { code: 'authorization_cancelled' });
    assert.equal(readPendingMcpAuthorizations().length, 0, 'an old token cannot make a cancelled new login succeed');

    globals.window = { open, canvasDesktop: {} };
    const previousOpens = opens;
    await assert.rejects(() => startMcpAuthorization('remote'), { code: 'desktop_update_required' });
    assert.equal(opens, previousOpens, 'old Electron bridges never try blocked about:blank popups');

    let opened: unknown;
    globals.window = { open, canvasDesktop: { openMcpOAuth: async (input: unknown) => { opened = input; return { ok: true }; } } };
    const desktopState = `desktop_${state}`;
    setFetch(() => ({ success: true, data: { state: desktopState, authorizationUrl, expiresAt: new Date(Date.now() + 600_000).toISOString() } }));
    const desktop = await startMcpAuthorization('remote');
    assert.equal(opens, previousOpens);
    assert.deepEqual(opened, { state: desktopState, authorizationUrl });
    assert.equal(requests.at(-1)?.body.desktop, true);
    requests = [];
    setFetch((url, body) => url.startsWith('/api/mcp/oauth/desktop?')
      ? { success: true, data: { status: 'callback_received' } }
      : body.action === 'finalize' ? { success: true, data: { status: 'completed' } }
        : { success: true, data: { oauth: [{ serverName: 'remote', authorized: true, lastCompletedState: desktopState }] } });
    await waitForMcpAuthorization(desktop, new AbortController().signal, () => undefined);
    assert.equal(requests[1].body.action, 'finalize', 'only authenticated app finalizes a desktop callback');
    assert.equal(readPendingMcpAuthorizations().length, 0);
    const controller = new AbortController(); controller.abort();
    const beforePause = requests.length;
    await waitForMcpAuthorization(desktop, controller.signal, () => undefined);
    assert.equal(requests.length, beforePause, 'leaving settings stops polling');
    await cancelMcpAuthorization(desktop);
    assert.equal(requests.at(-1)?.body.action, 'cancel');
    console.log('mcp-oauth-client-test: PASS (popup blocking, Electron bridge, reload persistence, owner finalization, cancellation, stale tokens and polling cleanup)');
  } finally { Object.assign(globals, original); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
