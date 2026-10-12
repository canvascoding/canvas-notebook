import assert from 'node:assert/strict';
import { cancelSharedMcpAuthorization, finalizeSharedMcpAuthorization, readSharedMcpAuthorizationStatus,
  SharedMcpAuthorizationError, startSharedMcpAuthorization, waitForSharedMcpAuthorization,
  type SharedMcpAuthorizationApi, type SharedMcpAuthorizationFlow, type SharedMcpAuthorizationOptions,
  type SharedMcpAuthorizationSummary } from '../app/lib/desktop/shared-mcp-oauth-client';

const connectionRef = 'canvas-connection:11111111-2222-4333-8444-555555555555';
const target = { connectionRef, workspaceId: 'exact-team-workspace' };
const revisions = { expectedMetadataRevision: 1, expectedGrantsRevision: 2, expectedBindingRevision: 3 };
const state = `desktop_${'x'.repeat(32)}`;
const authorizationUrl = 'https://provider.example/authorize?fixture=shared';
const expiresAt = new Date(Date.now() + 600_000).toISOString();

function fixture() {
  const calls: Array<{ url: string; body?: unknown; method?: string }> = [];
  const openings: unknown[] = [], statuses: SharedMcpAuthorizationSummary[] = [];
  let current = true, started: SharedMcpAuthorizationFlow | null = null, writes = 0;
  let response: (url: string, body?: unknown) => unknown | Promise<unknown> = (_url, body) => {
    const action = (body as { action?: string } | undefined)?.action;
    return body && !action ? { connectionRef, desktop: true, state, expiresAt, authorizationUrl }
      : { connectionRef, state, expiresAt, status: action === 'cancel' ? 'cancelled' : action === 'finalize' ? 'completed' : 'waiting',
        ...(!action ? { authorizationUrl } : {}) };
  };
  let opener: (request: unknown) => Promise<{ ok: boolean }> = async () => ({ ok: true });
  const api: SharedMcpAuthorizationApi = async (url, body, method) => {
    calls.push({ url, body, method }); if (body !== undefined) writes++;
    try { return await response(url, body); } finally { if (body !== undefined) writes--; }
  };
  const controller = new AbortController();
  const options: SharedMcpAuthorizationOptions & { onStarted: (flow: SharedMcpAuthorizationFlow) => void } = {
    api, signal: controller.signal, isCurrent: () => current,
    onStarted: flow => { assert.equal(writes, 0, 'API ACK settled before installing the synchronous flow fence'); started = flow; },
    onStatus: summary => statuses.push(summary),
  };
  const bridge = { sharedMcpOAuthVersion: 1, openMcpOAuth: async (request: unknown) => {
    assert(started, 'onStarted runs synchronously before IPC'); openings.push(request); return opener(request);
  } };
  return { calls, openings, statuses, options, controller, bridge,
    setCurrent: (value: boolean) => { current = value; },
    setResponse: (value: typeof response) => { response = value; },
    setOpener: (value: typeof opener) => { opener = value; },
    getStarted: () => started, getWrites: () => writes };
}

async function expectCode(operation: () => Promise<unknown>, code: string, status?: number | null) {
  await assert.rejects(operation, error => {
    assert(error instanceof SharedMcpAuthorizationError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /PRIVATE|session-token|backend-id/u);
    return true;
  });
}

async function main() {
  const globals = globalThis as unknown as { window: unknown; fetch: typeof fetch; sessionStorage: unknown };
  const original = { window: globals.window, fetch: globals.fetch, sessionStorage: globals.sessionStorage };
  let fetches = 0, storage = 0;
  globals.fetch = async () => { fetches++; throw new Error('No direct transport permitted'); };
  globals.sessionStorage = { getItem: () => { storage++; throw new Error('No shared persistence permitted'); },
    setItem: () => { storage++; throw new Error('No shared persistence permitted'); } };
  try {
    for (const bridge of [undefined, {}, { openMcpOAuth: async () => ({ ok: true }) },
      { sharedMcpOAuthVersion: 2, openMcpOAuth: async () => ({ ok: true }) }]) {
      const f = fixture(); globals.window = { canvasDesktop: bridge };
      await expectCode(() => startSharedMcpAuthorization(target, revisions, f.options), 'desktop_update_required');
      assert.equal(f.calls.length, 0); assert.equal(f.getStarted(), null);
    }
    const f = fixture(); globals.window = { canvasDesktop: f.bridge };
    const flow = await startSharedMcpAuthorization(target, revisions, { ...f.options, returnLocale: 'de' });
    assert(Object.isFrozen(flow)); assert.equal(f.getStarted(), flow);
    assert.deepEqual(flow, { ...target, state, expiresAt: Date.parse(expiresAt) });
    assert.deepEqual(f.openings, [{ state, authorizationUrl, target: { kind: 'shared', ...target } }]);
    assert.deepEqual(f.calls[0], { url: `/api/mcp/shared-connections/${encodeURIComponent(connectionRef)}/oauth?workspaceId=exact-team-workspace`,
      body: { ...revisions, desktop: true, returnLocale: 'de' }, method: 'POST' });
    f.setResponse((_url, body) => ({ connectionRef, state, expiresAt, status: body ? 'completed' : 'callback_received' }));
    const completed = await waitForSharedMcpAuthorization(flow, f.options);
    assert.equal(completed.status, 'completed');
    assert.equal(f.calls.filter(call => (call.body as { action?: string } | undefined)?.action === 'finalize').length, 1);
    assert.deepEqual(f.statuses.map(summary => summary.status), ['callback_received', 'completed']);
    assert(f.calls.every(call => call.url.includes(encodeURIComponent(connectionRef)) && !call.url.includes('integrations/mcp-status')));
    console.log('shared-mcp-oauth-client: exact scoped start/IPC/owner finalization, capability gate and no persistence PASS');

    for (const input of [{ ...target, connectionRef: 'by-name' }, { ...target, workspaceId: undefined },
      { ...target, workspaceId: '' }, { ...target, workspaceId: ' wrong ' }, { ...target, backend: 'backend-id' }]) {
      const invalid = fixture(); globals.window = { canvasDesktop: invalid.bridge };
      await expectCode(() => startSharedMcpAuthorization(input as typeof target, revisions, invalid.options), 'authorization_invalid');
      assert.equal(invalid.calls.length, 0);
    }
    for (const patch of [{ connectionRef: `${connectionRef}x` }, { desktop: false }, { state: 'browser-state' },
      { expiresAt: 'invalid' }, { expiresAt: new Date(0).toISOString() }, { authorizationUrl: 'https://user:pass@provider.example' },
      { authorizationUrl: 'http://foreign.example' }, { authorizationUrl: 'https://provider.example/\n' }]) {
      const invalid = fixture(); globals.window = { canvasDesktop: invalid.bridge };
      invalid.setResponse(() => ({ connectionRef, desktop: true, state, authorizationUrl, expiresAt, ...patch }));
      await expectCode(() => startSharedMcpAuthorization(target, revisions, invalid.options), 'authorization_invalid');
      assert.equal(invalid.openings.length, 0); assert.equal(invalid.getStarted(), null);
    }
    const mismatch = fixture(); globals.window = { canvasDesktop: mismatch.bridge };
    const mismatchFlow = await startSharedMcpAuthorization(target, revisions, mismatch.options);
    for (const patch of [{ connectionRef: `${connectionRef}x` }, { state: `desktop_${'z'.repeat(32)}` },
      { expiresAt: new Date(Date.now() + 900_000).toISOString() }, { authorizationUrl: `${authorizationUrl}&changed=1` },
      { status: 'completed', authorizationUrl }, { status: 'authorized' }, { code: 'PRIVATE_BACKEND_DETAIL' }]) {
      mismatch.setResponse(() => ({ connectionRef, state, expiresAt, status: 'waiting', authorizationUrl, ...patch }));
      await expectCode(() => readSharedMcpAuthorizationStatus(mismatchFlow, mismatch.options), 'authorization_invalid');
    }
    const beforeClone = mismatch.calls.length;
    await expectCode(() => cancelSharedMcpAuthorization({ ...mismatchFlow }, mismatch.options), 'authorization_context_changed');
    assert.equal(mismatch.calls.length, beforeClone);
    console.log('shared-mcp-oauth-client: strict target/ACK/status identity, expiry, URL and issued-flow validation PASS');

    for (const outcome of ['cancelled', 'completed'] as const) {
      const failed = fixture(); globals.window = { canvasDesktop: failed.bridge };
      failed.setOpener(async () => ({ ok: false }));
      failed.setResponse((_url, body) => (body as { action?: string })?.action === 'cancel'
        ? { connectionRef, state, expiresAt, status: outcome }
        : { connectionRef, desktop: true, state, expiresAt, authorizationUrl });
      await expectCode(() => startSharedMcpAuthorization(target, revisions, failed.options), 'external_browser_failed');
      assert.equal(failed.calls.length, 2); assert.equal(failed.statuses[0].status, outcome);
    }
    const unconfirmed = fixture(); globals.window = { canvasDesktop: unconfirmed.bridge };
    unconfirmed.setOpener(async () => { throw new Error('PRIVATE_OPENER_FAILURE'); });
    unconfirmed.setResponse((_url, body) => {
      if ((body as { action?: string })?.action === 'cancel') throw Object.assign(new Error('PRIVATE_RESPONSE'), { status: 503, code: 'provider_unavailable' });
      return { connectionRef, desktop: true, state, expiresAt, authorizationUrl };
    });
    await expectCode(() => startSharedMcpAuthorization(target, revisions, unconfirmed.options), 'authorization_cancel_unconfirmed', 503);
    assert(unconfirmed.getStarted(), 'unconfirmed cancellation retains an issued flow for visible manual recovery');
    assert.equal(unconfirmed.statuses.length, 0);
    const resumeFlow = unconfirmed.getStarted()!;
    unconfirmed.setResponse(() => ({ connectionRef, state, expiresAt, status: 'failed', code: 'CONNECTION_DESKTOP_OAUTH_FAILED' }));
    assert.equal((await readSharedMcpAuthorizationStatus(resumeFlow, unconfirmed.options)).status, 'failed');
    console.log('shared-mcp-oauth-client: opener failure cancellation ACK vs uncertain ACK and explicit status recovery PASS');

    for (const codeStatus of [['CONNECTION_BINDING_CHANGED', 409], ['CONNECTION_ACCESS_DENIED', 403],
      ['provider_unavailable', 503], ['PRIVATE_UNSAFE_CODE', 503]] as const) {
      const denied = fixture(); globals.window = { canvasDesktop: denied.bridge };
      const deniedFlow = await startSharedMcpAuthorization(target, revisions, denied.options);
      denied.setResponse(() => { throw Object.assign(new Error('PRIVATE_BACKEND_MESSAGE'), { status: codeStatus[1], code: codeStatus[0] }); });
      await expectCode(() => finalizeSharedMcpAuthorization(deniedFlow, denied.options),
        codeStatus[0] === 'PRIVATE_UNSAFE_CODE' ? 'authorization_unavailable' : codeStatus[0], codeStatus[1]);
      assert.equal(denied.statuses.length, 0); assert.equal(denied.calls.length, 2);
    }
    const ackLost = fixture(); globals.window = { canvasDesktop: ackLost.bridge };
    const ackFlow = await startSharedMcpAuthorization(target, revisions, ackLost.options);
    ackLost.setResponse((_url, body) => {
      if (body) throw new Error('PRIVATE_ACK_LOST');
      return { connectionRef, state, expiresAt, status: 'callback_received' };
    });
    await expectCode(() => waitForSharedMcpAuthorization(ackFlow, ackLost.options), 'authorization_unavailable', null);
    assert.equal(ackLost.calls.filter(call => (call.body as { action?: string } | undefined)?.action === 'finalize').length, 1);
    ackLost.setResponse(() => ({ connectionRef, state, expiresAt, status: 'completed' }));
    assert.equal((await readSharedMcpAuthorizationStatus(ackFlow, ackLost.options)).status, 'completed');
    console.log('shared-mcp-oauth-client: bounded permanent/status error classification, no ACK-loss retry, explicit resume PASS');

    const lateStart = fixture(); globals.window = { canvasDesktop: lateStart.bridge };
    let releaseStart!: () => void;
    lateStart.setResponse(() => new Promise(resolve => { releaseStart = () => resolve({ connectionRef, desktop: true, state, expiresAt, authorizationUrl }); }));
    const late = startSharedMcpAuthorization(target, revisions, lateStart.options);
    assert.equal(lateStart.calls.length, 1); lateStart.setCurrent(false); releaseStart();
    await expectCode(() => late, 'authorization_context_changed');
    assert.equal(lateStart.getStarted(), null); assert.equal(lateStart.openings.length, 0); assert.equal(lateStart.calls.length, 1);
    const lateBridge = fixture(); globals.window = { canvasDesktop: lateBridge.bridge };
    lateBridge.setOpener(async () => { lateBridge.setCurrent(false); return { ok: false }; });
    await expectCode(() => startSharedMcpAuthorization(target, revisions, lateBridge.options), 'authorization_context_changed');
    assert.equal(lateBridge.calls.length, 1, 'replacement session never cancels the original flow');
    const lateStatus = fixture(); globals.window = { canvasDesktop: lateStatus.bridge };
    const lateFlow = await startSharedMcpAuthorization(target, revisions, lateStatus.options);
    let releaseStatus!: () => void;
    lateStatus.setResponse(() => new Promise(resolve => { releaseStatus = () => resolve({ connectionRef, state, expiresAt, status: 'callback_received' }); }));
    const pending = waitForSharedMcpAuthorization(lateFlow, lateStatus.options);
    lateStatus.setCurrent(false); releaseStatus();
    await expectCode(() => pending, 'authorization_context_changed');
    assert.equal(lateStatus.calls.length, 2); assert.equal(lateStatus.statuses.length, 0);
    const aborted = fixture(); globals.window = { canvasDesktop: aborted.bridge };
    const abortFlow = await startSharedMcpAuthorization({ ...target, workspaceId: null }, revisions, aborted.options);
    aborted.controller.abort();
    const beforeAbort = aborted.calls.length;
    await expectCode(() => waitForSharedMcpAuthorization(abortFlow, aborted.options), 'authorization_context_changed');
    assert.equal(aborted.calls.length, beforeAbort);
    const cancelOptions = { ...aborted.options, signal: new AbortController().signal };
    assert.equal((await cancelSharedMcpAuthorization(abortFlow, cancelOptions)).status, 'cancelled');
    assert(!aborted.calls.at(-1)!.url.includes('workspaceId='), 'explicit null workspace never inherits a team');
    assert.equal(fetches, 0); assert.equal(storage, 0);
    console.log('shared-mcp-oauth-client: late identity/abort/bridge/poll fences, fresh explicit cancel and no direct transport PASS');
  } finally { Object.assign(globals, original); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
