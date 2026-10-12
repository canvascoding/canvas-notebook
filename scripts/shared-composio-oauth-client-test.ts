import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { cancelSharedComposioAuthorization, finalizeSharedComposioAuthorization, readSharedComposioAuthorizationStatus,
  resumeSharedComposioAuthorization, SharedComposioAuthorizationError, isSharedComposioAuthorizationPermanentError,
  startSharedComposioAuthorization, waitForSharedComposioAuthorization,
  type SharedComposioAuthorizationApi, type SharedComposioAuthorizationFlow, type SharedComposioAuthorizationOptions,
  type SharedComposioAuthorizationSummary } from '../app/lib/desktop/shared-composio-oauth-client';

const connectionRef = 'canvas-connection:11111111-2222-4333-8444-555555555555';
const target = { connectionRef, workspaceId: 'exact-composio-workspace' };
const revisions = { expectedMetadataRevision: 1, expectedGrantsRevision: 2, expectedBindingRevision: 3 };
const state = 'A'.repeat(43), authorizationUrl = 'https://provider.example/authorize?fixture=composio';
const expiresAt = new Date(Date.now() + 600_000).toISOString();
const waiting = { connectionRef, state, expiresAt, status: 'waiting', authorizationUrl } as const;
const callback = { connectionRef, state, expiresAt, status: 'callback_received' } as const;
const completed = { connectionRef, state, expiresAt, status: 'completed' } as const;
const cancelled = { connectionRef, state, expiresAt, status: 'cancelled', code: 'CONNECTION_DESKTOP_OAUTH_CANCELLED', error: 'Shared sign-in was cancelled.' } as const;
const starting = { connectionRef, state, expiresAt, status: 'starting', code: 'CONNECTION_DESKTOP_OAUTH_START_UNCONFIRMED',
  error: 'Shared sign-in start is unconfirmed. Reload and check this sign-in.' } as const;

function createSharedComposioClientFixture() {
  const calls: Array<{ url: string; body?: unknown; method?: string }> = [], openings: unknown[] = [];
  const statuses: SharedComposioAuthorizationSummary[] = [];
  let current = true, epoch = 0, started: SharedComposioAuthorizationFlow | null = null;
  let response: (url: string, body?: unknown) => unknown | Promise<unknown> = (_url, body) => {
    const action = (body as { action?: string } | undefined)?.action;
    return action === 'cancel' ? cancelled : action === 'finalize' ? completed : waiting;
  };
  let opener: (request: unknown) => Promise<{ ok: boolean }> = async () => ({ ok: true });
  const api: SharedComposioAuthorizationApi = async (url, body, method) => {
    assert(started, 'The synchronous attempt fence precedes every first POST.'); calls.push({ url, body, method });
    return response(url, body);
  };
  const controller = new AbortController();
  const options: SharedComposioAuthorizationOptions & { onStarted: (flow: SharedComposioAuthorizationFlow) => void } = {
    api, signal: controller.signal, isCurrent: () => current && epoch === 0,
    onStarted: flow => { assert.equal(calls.length, 0); started = flow; }, onStatus: summary => statuses.push(summary),
  };
  const bridge = { sharedComposioOAuthVersion: 1, openSharedComposioOAuth: async (request: unknown) => {
    assert(started); openings.push(request); return opener(request);
  } };
  return { calls, openings, statuses, options, controller, bridge,
    setCurrent: (value: boolean) => { if (current !== value) epoch += 1; current = value; },
    setResponse: (value: typeof response) => { response = value; }, setOpener: (value: typeof opener) => { opener = value; },
    getStarted: () => started };
}

async function expectSharedComposioClientCode(operation: () => Promise<unknown>, code: string, status?: number | null) {
  await assert.rejects(operation, error => {
    assert(error instanceof SharedComposioAuthorizationError); assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /PRIVATE|authSessionId|backend-id|session-token/u); return true;
  });
}

/** Real client/WeakMap and lifetime fences; HTTP and IPC alone are controlled, with no server-authority claim. */
async function main() {
  const globals = globalThis as unknown as { window: unknown; fetch: typeof fetch; sessionStorage: unknown };
  const original = { window: globals.window, fetch: globals.fetch, sessionStorage: globals.sessionStorage };
  let fetches = 0, storage = 0;
  globals.fetch = async () => { fetches += 1; throw new Error('No direct transport permitted'); };
  globals.sessionStorage = { getItem: () => { storage += 1; throw new Error('No shared persistence permitted'); },
    setItem: () => { storage += 1; throw new Error('No shared persistence permitted'); } };
  try {
    for (const bridge of [undefined, {}, { openSharedComposioOAuth: async () => ({ ok: true }) },
      { sharedComposioOAuthVersion: 2, openSharedComposioOAuth: async () => ({ ok: true }) }]) {
      const f = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: bridge };
      await expectSharedComposioClientCode(() => startSharedComposioAuthorization(target, revisions, f.options), 'desktop_update_required');
      assert.equal(f.calls.length, 0); assert.equal(f.getStarted(), null);
    }
    const noAuth = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: noAuth.bridge };
    noAuth.setResponse(() => ({ connectionRef, noAuth: true }));
    assert.deepEqual(await startSharedComposioAuthorization(target, revisions, noAuth.options), { connectionRef, noAuth: true });
    assert.equal(noAuth.calls.length, 1); assert.equal(noAuth.openings.length, 0); assert(noAuth.getStarted());
    const f = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: f.bridge };
    const flow = await startSharedComposioAuthorization(target, revisions, f.options); assert(!('noAuth' in flow));
    assert(Object.isFrozen(flow)); assert.equal(f.getStarted(), flow); assert.match(flow.intent, /^[A-Za-z0-9_-]{43}$/u);
    assert.deepEqual(Object.keys(flow).sort(), ['connectionRef', 'intent', 'workspaceId']);
    assert.deepEqual(f.calls[0], { url: `/api/composio/shared-connections/${encodeURIComponent(connectionRef)}/connect?workspaceId=${target.workspaceId}`,
      body: { ...revisions, desktop: true, intent: flow.intent }, method: 'POST' });
    assert.deepEqual(f.openings, [{ state, authorizationUrl, expiresAt, target: { kind: 'shared', ...target } }]);
    f.setResponse((_url, body) => body ? completed : callback);
    assert.equal((await waitForSharedComposioAuthorization(flow, f.options)).status, 'completed');
    assert.equal(f.calls.filter(call => (call.body as { action?: string } | undefined)?.action === 'finalize').length, 1);
    assert.deepEqual(f.statuses.map(value => value.status), ['waiting', 'callback_received', 'completed']);
    console.log('shared-composio-oauth-client: capability/pre-POST fence, noAuth 0IPC, exact scoped start/IPC/finalize PASS');

    for (const input of [{ ...target, connectionRef: 'by-name' }, { ...target, workspaceId: undefined },
      { ...target, workspaceId: '' }, { ...target, workspaceId: ' wrong ' }, { ...target, backend: 'PRIVATE_backend-id' }]) {
      const invalid = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: invalid.bridge };
      await expectSharedComposioClientCode(() => startSharedComposioAuthorization(input as typeof target, revisions, invalid.options), 'authorization_invalid');
      assert.equal(invalid.calls.length, 0);
    }
    for (const patch of [{ connectionRef: `${connectionRef}x` }, { state: `${'A'.repeat(42)}B` },
      { expiresAt: expiresAt.replace('Z', '+00:00') },
      { authorizationUrl: 'https://user:pass@provider.example' }, { authorizationUrl: 'http://foreign.example' },
      { authorizationUrl: 'https://provider.example/\n' }, { profileId: 'PRIVATE_backend-id' }, { error: 'PRIVATE_error' }]) {
      const invalid = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: invalid.bridge };
      invalid.setResponse(() => ({ ...waiting, ...patch }));
      await expectSharedComposioClientCode(() => startSharedComposioAuthorization(target, revisions, invalid.options), 'authorization_invalid');
      assert.equal(invalid.openings.length, 0); assert(invalid.getStarted(), 'Invalid ACK does not erase the attempted write fence.');
    }
    const mismatch = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: mismatch.bridge };
    const issued = await startSharedComposioAuthorization(target, revisions, mismatch.options); assert(!('noAuth' in issued));
    for (const patch of [{ state: `${'B'.repeat(42)}A` }, { expiresAt: new Date(Date.now() + 900_000).toISOString() },
      { authorizationUrl: `${authorizationUrl}&changed=1` }, { status: 'completed', authorizationUrl }, { status: 'authorized' },
      { code: 'PRIVATE_code' }]) {
      mismatch.setResponse(() => ({ ...waiting, ...patch }));
      await expectSharedComposioClientCode(() => readSharedComposioAuthorizationStatus(issued, mismatch.options), 'authorization_invalid');
    }
    const beforeClone = mismatch.calls.length;
    await expectSharedComposioClientCode(() => cancelSharedComposioAuthorization({ ...issued }, mismatch.options), 'authorization_invalid');
    assert.equal(mismatch.calls.length, beforeClone);
    console.log('shared-composio-oauth-client: strict target/state/ISO/URL/summary and unforgeable issued handle PASS');

    const lost = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: lost.bridge };
    lost.setResponse(() => { throw new Error('PRIVATE_start_ACK_loss'); });
    await expectSharedComposioClientCode(() => startSharedComposioAuthorization(target, revisions, lost.options), 'authorization_unavailable', null);
    const lostFlow = lost.getStarted(); assert(lostFlow); assert.equal(lost.openings.length, 0);
    lost.setResponse(() => { throw Object.assign(new Error('PRIVATE_missing'), { status: 404, code: 'CONNECTION_DESKTOP_OAUTH_STATE_INVALID' }); });
    await expectSharedComposioClientCode(() => readSharedComposioAuthorizationStatus(lostFlow, lost.options), 'CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 404);
    assert(new URL(lost.calls.at(-1)!.url, 'https://canvas.test').searchParams.has('intent'));
    lost.setResponse(() => cancelled);
    assert.equal((await cancelSharedComposioAuthorization(lostFlow, lost.options)).status, 'cancelled');
    assert.deepEqual(lost.calls.at(-1)!.body, { intent: lostFlow.intent, action: 'cancel', ...revisions });
    assert.equal(lost.calls.filter(call => (call.body as { desktop?: boolean } | undefined)?.desktop).length, 1);
    const inProgress = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: inProgress.bridge };
    inProgress.setResponse(() => starting);
    await expectSharedComposioClientCode(() => startSharedComposioAuthorization(target, revisions, inProgress.options), 'authorization_start_unconfirmed');
    assert.equal((await resumeSharedComposioAuthorization(inProgress.getStarted()!, inProgress.options)).status, 'starting');
    assert.equal(inProgress.openings.length, 0); assert.equal(inProgress.calls.filter(call => call.body).length, 1);
    console.log('shared-composio-oauth-client: start ACK loss/early404/starting keep same intent, explicit cancel tombstone request PASS');

    const openerLost = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: openerLost.bridge };
    openerLost.setOpener(async () => { throw new Error('PRIVATE_IPC_ACK_loss'); });
    await expectSharedComposioClientCode(() => startSharedComposioAuthorization(target, revisions, openerLost.options), 'authorization_open_unconfirmed');
    assert.equal(openerLost.calls.length, 1, 'Lost opener ACK must never automatically cancel a possibly opened browser.');
    assert.equal(openerLost.openings.length, 1);
    openerLost.setResponse((_url, body) => body ? completed : callback);
    assert.equal((await resumeSharedComposioAuthorization(openerLost.getStarted()!, openerLost.options)).status, 'completed');
    assert.equal(openerLost.openings.length, 1, 'Callback recovery does not open a second browser.');
    const reopen = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: reopen.bridge };
    reopen.setOpener(async () => ({ ok: false }));
    await expectSharedComposioClientCode(() => startSharedComposioAuthorization(target, revisions, reopen.options), 'authorization_open_unconfirmed');
    reopen.setOpener(async () => ({ ok: true })); let reads = 0;
    reopen.setResponse(() => ++reads === 1 ? waiting : completed);
    assert.equal((await resumeSharedComposioAuthorization(reopen.getStarted()!, reopen.options)).status, 'completed');
    assert.equal(reopen.openings.length, 2); assert.equal(reopen.calls.filter(call => call.body).length, 1);
    console.log('shared-composio-oauth-client: opener ACK loss retained, read-first explicit resume and no implicit cancellation PASS');

    const finalizeLost = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: finalizeLost.bridge };
    const finalizeFlow = await startSharedComposioAuthorization(target, revisions, finalizeLost.options); assert(!('noAuth' in finalizeFlow));
    finalizeLost.setResponse((_url, body) => { if (body) throw new Error('PRIVATE_finalize_ACK_loss'); return callback; });
    await expectSharedComposioClientCode(() => waitForSharedComposioAuthorization(finalizeFlow, finalizeLost.options), 'authorization_unavailable');
    await expectSharedComposioClientCode(() => waitForSharedComposioAuthorization(finalizeFlow, finalizeLost.options), 'authorization_finalize_unconfirmed');
    assert.equal(finalizeLost.calls.filter(call => (call.body as { action?: string } | undefined)?.action === 'finalize').length, 1);
    finalizeLost.setResponse(() => completed);
    assert.equal((await resumeSharedComposioAuthorization(finalizeFlow, finalizeLost.options)).status, 'completed');
    assert.equal(finalizeLost.calls.filter(call => (call.body as { action?: string } | undefined)?.action === 'finalize').length, 1);
    const cancelLost = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: cancelLost.bridge };
    const cancelFlow = await startSharedComposioAuthorization(target, revisions, cancelLost.options); assert(!('noAuth' in cancelFlow));
    cancelLost.setResponse(() => { throw Object.assign(new Error('PRIVATE_cancel_ACK_loss'), { status: 503, code: 'provider_unavailable' }); });
    await expectSharedComposioClientCode(() => cancelSharedComposioAuthorization(cancelFlow, cancelLost.options), 'provider_unavailable', 503);
    cancelLost.setResponse(() => completed);
    assert.equal((await resumeSharedComposioAuthorization(cancelFlow, cancelLost.options)).status, 'completed');
    assert.equal(cancelLost.calls.filter(call => (call.body as { action?: string } | undefined)?.action === 'cancel').length, 1);
    console.log('shared-composio-oauth-client: Finalize/Cancel ACK loss never auto-retries, explicit same-flow completion recovery PASS');

    for (const [code, status, permanent] of [
      ['CONNECTION_BINDING_CHANGED', 409, true], ['CONNECTION_ACCESS_DENIED', 403, true],
      ['auth_required', 409, false], ['outcome_unknown', 409, false], ['CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 404, false],
      ['master_key_missing', 503, false], ['decryption_failed', 503, false], ['invalid_secret_format', 503, false],
      ['mcp_credential_key_missing', 503, false], ['PRIVATE_code', 503, false],
    ] as const) {
      const errorCase = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: errorCase.bridge };
      errorCase.setResponse(() => { throw Object.assign(new Error('PRIVATE_response'), { status, code }); });
      await assert.rejects(() => startSharedComposioAuthorization(target, revisions, errorCase.options), error => {
        assert(error instanceof SharedComposioAuthorizationError); assert.equal(error.code, code === 'PRIVATE_code' ? 'authorization_unavailable' : code);
        assert.equal(error.status, status); assert.equal(isSharedComposioAuthorizationPermanentError(error), permanent);
        assert.doesNotMatch(error.message, /PRIVATE/u); return true;
      });
    }
    console.log('shared-composio-oauth-client: permanent vs unknown409/404/readiness503 bounded classification PASS');

    const late = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: late.bridge };
    let release!: () => void;
    late.setResponse(() => new Promise(resolve => { release = () => resolve(waiting); }));
    const lateStart = startSharedComposioAuthorization(target, revisions, late.options); assert(late.getStarted());
    late.setCurrent(false); late.setCurrent(true); release();
    await expectSharedComposioClientCode(() => lateStart, 'authorization_context_changed'); assert.equal(late.openings.length, 0);
    const lateIpc = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: lateIpc.bridge };
    lateIpc.setOpener(async () => { lateIpc.setCurrent(false); return { ok: false }; });
    await expectSharedComposioClientCode(() => startSharedComposioAuthorization(target, revisions, lateIpc.options), 'authorization_context_changed');
    assert.equal(lateIpc.calls.length, 1, 'A replacement identity never cancels the initiating flow.');
    const aborted = createSharedComposioClientFixture(); globals.window = { crypto: webcrypto, canvasDesktop: aborted.bridge };
    const abortFlow = await startSharedComposioAuthorization({ ...target, workspaceId: null }, revisions, aborted.options); assert(!('noAuth' in abortFlow));
    aborted.controller.abort(); const beforeAbort = aborted.calls.length;
    await expectSharedComposioClientCode(() => finalizeSharedComposioAuthorization(abortFlow, aborted.options), 'authorization_context_changed');
    assert.equal(aborted.calls.length, beforeAbort);
    assert.equal((await cancelSharedComposioAuthorization(abortFlow, { ...aborted.options, signal: new AbortController().signal })).status, 'cancelled');
    assert(!aborted.calls.at(-1)!.url.includes('workspaceId='));
    assert.equal(fetches, 0); assert.equal(storage, 0);
    console.log('shared-composio-oauth-client: immutable lifetime ABA/late IPC/abort, exact null workspace, no direct transport/persistence PASS');
  } finally { Object.assign(globals, original); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
