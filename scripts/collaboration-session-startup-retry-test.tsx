import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import * as Y from 'yjs';
import type * as Client from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { WORKSPACE_ID_HEADER } from '../app/lib/workspaces/constants';
import { captureAgentStateSnapshot } from '../app/lib/collaboration/agent-durability';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { hasCurrentOpenedDocumentSessionAuthorization, invalidateOpenedDocumentAuth,
  invalidateOpenedLiveDocument, isLocalOpenedDocumentSession, observeOpenedDocumentAuth,
  openedDocumentAuthScope, rememberOpenedLiveDocument, validateOpenedLiveDocumentSession,
} from '../app/lib/collaboration/opened-document-registry';

type Input = Parameters<typeof Client.useTextCollaborationSession>[0];
type Call = { input: string; body: string; headers: Headers; signal: AbortSignal; time: number };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const busy = (code = 'PRINCIPAL_BUSY') => Response.json({ success: false, error: code, code, retryable: true }, { status: 409 });
const session: CollaborationSessionResponse = { success: true, documentId: 'startup-doc', documentName: 'startup-doc',
  provider: 'yjs', representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3,
  permission: 'write', token: 'unit-ticket', expiresAt: '2099-01-01T00:00:00.000Z', websocketUrl: '/ws/collaboration',
  user: { id: 'startup-user', name: 'Unit user', color: '#112233', colorLight: '#ddeeff' } };

async function main() {
  const filename = path.resolve('app/lib/collaboration/client.ts');
  const load = createRequire(filename);
  // Exercise real registry auth observations below, without starting the app's
  // separate BetterAuth browser-atom listener/network lifecycle in this unit host.
  load('../auth-client');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test/en/notebook' });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true,
    value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key] });
  const source = await fs.readFile(process.env.COLLABORATION_CLIENT_TEST_SOURCE || filename, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } });
  const exported = {} as typeof Client;
  // The production registry, auth, revision and workspace headers stay real.
  // This session-resolution hook must never load transport/storage constructors.
  let forbiddenLoads = 0;
  const requireActual = (name: string) => {
    if (name === '@hocuspocus/provider' || name === 'y-indexeddb') {
      forbiddenLoads++; throw new Error('Session resolution must not load transport/storage.');
    }
    return load(name);
  };
  new Function('require', 'module', 'exports', compiled.outputText)(requireActual, { exports: exported }, exported);
  let resolution: Client.TextCollaborationSessionResolution | undefined;
  const getResolution = (): Client.TextCollaborationSessionResolution | undefined => resolution;
  function Probe({ input }: { input: Input }) {
    resolution = exported.useTextCollaborationSession(input);
    return <output>{resolution.loading ? 'loading' : resolution.error || resolution.session?.documentId}</output>;
  }
  const root = createRoot(document.getElementById('root')!);
  const originalFetch = globalThis.fetch;
  const failures: string[] = [];
  let passed = 0;
  let calls: Call[] = [];
  let respond: (call: Call) => Promise<Response> = async () => Response.json(session);
  globalThis.fetch = async (input, init) => {
    const call = { input: String(input), body: String(init?.body), headers: new Headers(init?.headers),
      signal: init?.signal as AbortSignal, time: performance.now() };
    calls.push(call);
    assert.equal(call.input, '/api/files/collaboration/session');
    assert.equal(init?.method, 'POST');
    assert.equal(call.signal instanceof AbortSignal, true);
    return respond(call);
  };
  const render = (input: Input) => act(async () => { root.render(<Probe input={input} />); });
  const until = async (condition: () => boolean) => {
    const deadline = performance.now() + 1800;
    while (!condition() && performance.now() < deadline) await act(async () => { await wait(10); });
    assert.equal(condition(), true, 'Hook did not reach the expected observable state.');
  };
  const settle = () => until(() => resolution?.loading === false);
  const input: Input = { enabled: true, workspaceId: 'startup-workspace', path: 'Original note.md', expectedDocumentId: session.documentId };
  const seedLocal = () => {
    const doc = new Y.Doc(); doc.getText('content').insert(0, 'Unit receipt');
    const authorized = { ...session };
    const stateProof = collaborationStateProof(doc, Y); const snapshot = captureAgentStateSnapshot(doc, Y);
    assert(stateProof && snapshot, 'The actual Yjs document supplies a complete local receipt.');
    assert.equal(validateOpenedLiveDocumentSession(input.workspaceId!, input.path!, authorized), true);
    rememberOpenedLiveDocument({ scope: openedDocumentAuthScope(), workspaceId: input.workspaceId!, path: input.path!,
      session: authorized, stateProof, snapshot,
      file: { path: input.path!, content: '', collaboration: { path: input.path!, strategy: 'crdt_text', crdtCapable: true,
        sceneCapable: false, lockRequired: false, requiresRevisionCheck: false, latestRevision: null, activeLock: null,
        document: { id: session.documentId, provider: 'yjs', status: 'active', stateVersion: 1, snapshotRevisionId: null } } } });
    doc.destroy();
  };
  const run = async (name: string, test: () => Promise<void>) => {
    await act(async () => { root.render(null); });
    observeOpenedDocumentAuth(null);
    observeOpenedDocumentAuth({ data: { user: { id: session.user.id }, session: { id: name } } });
    calls = []; resolution = undefined;
    try { await test(); passed++; console.log(`PASS ${name}`); }
    catch (error) {
      failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : 'unknown failure'}`);
      const observed = getResolution();
      console.error(JSON.stringify({ requests: calls.length, loading: observed?.loading, error: observed?.error,
        hasSession: Boolean(observed?.session) }));
    }
  };
  try {
    await run('initial marked busy then success', async () => {
      respond = async () => calls.length === 1 ? busy() : Response.json(session);
      await render(input); await settle();
      assert.equal(resolution?.session?.documentId, session.documentId);
      assert.equal(resolution?.error, null);
      assert.equal(calls.length, 2);
      assert.equal(JSON.parse(calls[0].body).path, input.path);
      assert.equal(JSON.parse(calls[0].body).representation, 'auto');
      assert.equal(calls[1].body, calls[0].body);
      assert.deepEqual([...calls[1].headers], [...calls[0].headers]);
      assert.equal(calls[1].headers.get(WORKSPACE_ID_HEADER), input.workspaceId);
      assert.equal(calls[1].time - calls[0].time >= 140, true, 'First backoff must wait 150 ms.');
      assert.equal(hasCurrentOpenedDocumentSessionAuthorization(input.workspaceId!, input.path!, resolution!.session!), true);
    });
    await run('two marked busy responses then success', async () => {
      respond = async () => calls.length < 3 ? busy() : Response.json(session);
      await render(input); await settle();
      assert.equal(resolution?.session?.documentId, session.documentId);
      assert.equal(calls.length, 3);
      assert.equal(calls[2].time - calls[1].time >= 290, true, 'Second backoff must wait 300 ms.');
      for (const call of calls.slice(1)) {
        assert.equal(call.body, calls[0].body); assert.deepEqual([...call.headers], [...calls[0].headers]);
        assert.equal(call.signal === calls[0].signal, true, 'Retries retain the original cancellation lifetime.');
      }
    });
    await run('three marked busy responses terminate without local fallback', async () => {
      seedLocal(); respond = async () => busy();
      await render(input); await settle(); await act(async () => { await wait(350); });
      assert.equal(calls.length, 3); assert.equal(resolution?.session, null);
      assert.equal(resolution?.error, 'PRINCIPAL_BUSY');
    });
    await run('marked native reader code uses the same finite startup budget (wire adapter only)', async () => {
      respond = async () => calls.length < 3 ? busy('NATIVE_SESSION_BUSY') : Response.json(session);
      await render(input); await settle();
      assert.equal(calls.length, 3); assert.equal(resolution?.session?.documentId, session.documentId);
      assert.equal(calls[1].time - calls[0].time >= 140, true);
      assert.equal(calls[2].time - calls[1].time >= 290, true);
    });
    await run('exhausted native reader marker cannot poll or use a local fallback', async () => {
      seedLocal(); respond = async () => busy('NATIVE_SESSION_BUSY');
      await render(input); await settle(); await act(async () => { await wait(350); });
      assert.equal(calls.length, 3); assert.equal(resolution?.session, null);
      assert.equal(resolution?.error, 'NATIVE_SESSION_BUSY');
    });
    const failuresWithoutRetry: Array<[string, number, Record<string, unknown> | string]> = [
      ['unmarked 409', 409, { error: 'PRINCIPAL_BUSY', code: 'PRINCIPAL_BUSY' }],
      ['unmarked native reader 409', 409, { code: 'NATIVE_SESSION_BUSY' }],
      ['native marker on generic 503', 503, { success: false, code: 'NATIVE_SESSION_BUSY', retryable: true }],
      ['contradictory successful native payload', 409, { success: true, code: 'NATIVE_SESSION_BUSY', retryable: true }],
      ['fake code', 409, { error: 'PRINCIPAL_BUSY', code: 'OTHER_BUSY', retryable: true }],
      ['string true', 409, { code: 'PRINCIPAL_BUSY', retryable: 'true' }],
      ['explicit false', 409, { code: 'PRINCIPAL_BUSY', retryable: false }],
      ['401 even if marked', 401, { code: 'PRINCIPAL_BUSY', retryable: true }],
      ['403 even if marked', 403, { code: 'PRINCIPAL_BUSY', retryable: true }],
      ['500 even if marked', 500, { code: 'PRINCIPAL_BUSY', retryable: true }],
      ['successful HTTP with failed payload', 200, { success: false, code: 'PRINCIPAL_BUSY', retryable: true }],
      ['malformed JSON', 409, '{'],
    ];
    for (const [name, status, payload] of failuresWithoutRetry) await run(name, async () => {
      seedLocal();
      respond = async () => typeof payload === 'string' ? new Response(payload, { status }) : Response.json(payload, { status });
      await render(input); await settle(); await act(async () => { await wait(500); });
      assert.equal(calls.length, 1); assert.equal(resolution?.session, null);
      assert.equal(typeof resolution?.error, 'string', 'HTTP/parser failures must not use a cached local receipt.');
    });
    for (const cached of [false, true]) await run(`network rejection cached=${cached}`, async () => {
      if (cached) seedLocal();
      respond = async () => { throw new TypeError('Offline unit adapter'); };
      await render(input); await settle(); await act(async () => { await wait(500); });
      assert.equal(calls.length, 1);
      assert.equal(Boolean(resolution?.session), cached);
      if (cached) { assert.equal(isLocalOpenedDocumentSession(resolution!.session!), true); assert.equal(resolution?.error, null); }
      else assert.equal(resolution?.error, 'The document connection is unavailable.');
    });
    await run('ordinary exception cannot use local network fallback', async () => {
      seedLocal(); respond = async () => { throw new Error('Unit adapter failure'); };
      await render(input); await settle(); await act(async () => { await wait(500); });
      assert.equal(calls.length, 1); assert.equal(resolution?.session, null);
      assert.equal(resolution?.error, 'Unit adapter failure');
    });
    for (const change of ['auth', 'same-user epoch', 'revision', 'path', 'workspace', 'unmount'] as const) {
      await run(`backoff interrupted by ${change}`, async () => {
        respond = async () => calls.length === 1 ? busy() : Response.json(session);
        await render(input); await until(() => calls.length === 1);
        await act(async () => { await wait(40); });
        assert.equal(resolution?.loading, true, 'Marked busy remains pending during backoff.');
        if (change === 'auth') observeOpenedDocumentAuth({ data: { user: { id: 'different-user' }, session: { id: 'different-session' } } });
        else if (change === 'same-user epoch') invalidateOpenedDocumentAuth();
        else if (change === 'revision') invalidateOpenedLiveDocument(input.workspaceId!, { path: input.path! });
        else if (change === 'path') await render({ ...input, path: 'Different note.md' });
        else if (change === 'workspace') await render({ ...input, workspaceId: 'different-workspace' });
        else await act(async () => { root.render(null); });
        await act(async () => { await wait(550); });
        if (change === 'path' || change === 'workspace') {
          assert.equal(calls.length, 2, 'Only the new hook lifetime starts a new request.');
          assert.equal(calls[0].signal.aborted, true);
          assert.equal(JSON.parse(calls[1].body).path, change === 'path' ? 'Different note.md' : input.path);
          assert.equal(calls[1].headers.get(WORKSPACE_ID_HEADER), change === 'workspace' ? 'different-workspace' : input.workspaceId);
          assert.equal(resolution?.session?.documentId, session.documentId);
        } else {
          assert.equal(calls.length, 1, 'An obsolete authorization/revision/lifetime cannot issue a retry.');
          if (change === 'unmount') assert.equal(calls[0].signal.aborted, true);
          else { assert.equal(resolution?.session, null); assert.equal(typeof resolution?.error, 'string'); }
        }
      });
    }
    await run('late success for another document is rejected', async () => {
      respond = async () => calls.length === 1 ? busy() : Response.json({ ...session, documentId: 'replacement-doc' });
      await render(input); await settle();
      assert.equal(calls.length, 2); assert.equal(resolution?.session, null);
      assert.match(resolution?.error || '', /another document/u);
    });
    for (const invalid of ['schema', 'user'] as const) await run(`success retains ${invalid} validation`, async () => {
      const payload = invalid === 'schema' ? { ...session, schemaVersion: 999 }
        : { ...session, user: { ...session.user, id: 'another-user' } };
      respond = async () => calls.length === 1 ? busy() : Response.json(payload);
      await render(input); await settle();
      assert.equal(calls.length, 2); assert.equal(resolution?.session, null);
      assert.match(resolution?.error || '', invalid === 'schema' ? /representation/u : /signed-in user/u);
    });
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    observeOpenedDocumentAuth(null);
    dom.window.close();
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
  assert.equal(forbiddenLoads, 0, 'Provider and IndexedDB must remain unstarted.');
  console.log(`Session startup retry: ${passed}/${passed + failures.length} cases passed.`);
  if (failures.length) throw new Error(`${failures.length} session startup retry case(s) failed.`);
}

main().catch(error => { console.error(`${error instanceof Error ? error.name : 'Error'}: ${error instanceof Error ? error.message : 'Unknown failure'}`); process.exitCode = 1; });
