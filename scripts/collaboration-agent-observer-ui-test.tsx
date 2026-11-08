import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

import * as client from '../app/lib/collaboration/agent-operations-client';
import type * as Ui from '../app/components/editor/CollaborationAgentOperations';

// Mounted UI contract only. Actual authorization and network acceptance are separate.
const Availability = React.createContext(false);

async function compileObserver(): Promise<typeof Ui> {
  const filename = path.resolve('app/components/editor/CollaborationAgentOperations.tsx');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {} as typeof Ui;
  const dependencies: Record<string, unknown> = {
    '@/app/components/file-version-center/DocumentReviewAvailabilityProvider': {
      useDocumentReviewAvailability: () => ({ documentReviewEnabled: React.useContext(Availability) }),
    },
    '@/app/lib/collaboration/agent-operations-client': client,
    '@/app/lib/file-version-center/contracts/v1': { FILE_VERSION_CENTER_CONTRACT_VERSION: 1 },
    '@/app/lib/files/client': { workspaceHeaders: () => ({ 'x-canvas-workspace-id': 'unit-workspace' }) },
  };
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : load(name),
    { exports }, exports,
  );
  return exports;
}

const operation = (operationId: string): client.CollaborationAgentOperation => ({
  operationId, operationStatus: 'persisted_yjs', status: 'applied_to_ydoc', durability: 'persisted_yjs',
  actorId: 'unit-agent', actionsAllowed: false, appliedTargetIds: [], conflicts: [], targetAnchors: [],
});

test('disabled review observer does no polling; disable aborts and discards stale replies; enable reads fresh', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const names = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const timers = new Map<number, () => void>(); let nextTimer = 0;
  Object.defineProperty(dom.window, 'setTimeout', { value: (callback: () => void) => {
    const id = ++nextTimer; timers.set(id, callback); return id;
  } });
  Object.defineProperty(dom.window, 'clearTimeout', { value: (id: number) => timers.delete(id) });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; signal: AbortSignal; resolve: (value: Response) => void }> = [];
  globalThis.fetch = (input, init) => new Promise<Response>(resolve => {
    assert(init?.signal);
    requests.push({ url: String(input), signal: init.signal, resolve });
  });
  const ui = await compileObserver(), root = createRoot(document.getElementById('root')!);
  const observed: client.CollaborationAgentOperation[][] = [];
  const onOperationsChange = (values: client.CollaborationAgentOperation[]) => observed.push(values);
  const render = (enabled: boolean, documentId = 'unit-doc') => act(async () => root.render(
    <Availability.Provider value={enabled}>
      <ui.CollaborationAgentOperations documentId={documentId} workspaceId="unit-workspace"
        onOperationsChange={onOperationsChange} />
    </Availability.Provider>,
  ));
  const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); }); };
  try {
    await render(false);
    await render(false, 'another-disabled-document');
    await flush();
    assert.equal(requests.length, 0, 'disabled mounts and document switches make no operation request');
    assert.equal(timers.size, 0, 'disabled observers schedule no background timer');
    assert.deepEqual(observed.at(-1), []);

    await render(true);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /documentId=unit-doc/u);
    await render(false);
    assert.equal(requests[0].signal.aborted, true, 'turning off aborts in-flight IO');
    await act(async () => requests[0].resolve(Response.json({ operations: [operation('stale')] })));
    await flush();
    assert.equal(timers.size, 0);
    assert(!observed.some(values => values.some(value => value.operationId === 'stale')),
      'a late disabled response must not repopulate editor state');

    await render(true);
    assert.equal(requests.length, 2, 'reenabling starts a fresh request');
    await act(async () => requests[1].resolve(Response.json({ operations: [operation('fresh')] })));
    await flush();
    assert.equal(observed.at(-1)?.[0]?.operationId, 'fresh');
    assert.equal(timers.size, 1, 'an enabled observer retains its existing periodic refresh');
    const [timerId, callback] = [...timers][0]; timers.delete(timerId);
    await act(async () => callback());
    assert.equal(requests.length, 3);
    await render(false);
    assert.equal(requests[2].signal.aborted, true);
    await act(async () => requests[2].resolve(Response.json({ operations: [operation('late-poll')] })));
    await flush();
    assert.equal(timers.size, 0);
    assert.deepEqual(observed.at(-1), []);
    assert(!observed.some(values => values.some(value => value.operationId === 'late-poll')));
    assert.equal(document.querySelector('button'), null);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (let i = 0; i < names.length; i++) {
      const descriptor = previous[i];
      if (descriptor) Object.defineProperty(globalThis, names[i], descriptor);
      else Reflect.deleteProperty(globalThis, names[i]);
    }
  }
});
