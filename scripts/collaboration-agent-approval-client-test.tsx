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

const version = (character: string) => `v1.${character.repeat(64)}`;
const operation = (proposalVersion: string | null = version('a')): client.CollaborationAgentOperation => ({
  operationId: 'operation/one', operationStatus: 'needs_review', status: 'needs_review', durability: 'needs_review',
  actorId: 'agent', actionsAllowed: true, proposalVersion, appliedTargetIds: [], conflicts: [], targetAnchors: [],
  reviewTargets: [{ targetId: 'target', groupId: 'group', currentText: 'Current content', proposedReplacement: `Proposal ${proposalVersion}`, previewFormat: 'text' }],
});
const accepted = () => ({ operationStatus: 'persisted_yjs', status: 'applied_to_ydoc', durability: 'persisted_yjs', conflicts: [] });

test('the exact displayed version determines both the approval body and retry key', () => {
  const keys = new Map<string, string>(); let number = 0; const createKey = () => `key-${++number}`;
  const a = operation(); const b = operation(version('b'));
  const first = client.prepareCollaborationAgentAction(a, 'accept', keys, createKey)!;
  assert.deepEqual(first.body, { idempotencyKey: 'key-1', proposalVersion: version('a') });
  assert.deepEqual(client.prepareCollaborationAgentAction(a, 'accept', keys, createKey), first);
  const changed = client.prepareCollaborationAgentAction(b, 'accept', keys, createKey)!;
  assert.notEqual(changed.key, first.key); assert.deepEqual(changed.body, { idempotencyKey: 'key-2', proposalVersion: version('b') });
  const reject = client.prepareCollaborationAgentAction(b, 'reject', keys, createKey)!;
  assert.deepEqual(reject.body, { idempotencyKey: 'key-3' });
  assert.equal(client.prepareCollaborationAgentAction(operation(null), 'accept', keys, createKey), null);
  assert.equal(client.prepareCollaborationAgentAction(operation('malformed'), 'accept', keys, createKey), null);
  assert.equal(client.prepareCollaborationAgentAction({ ...a, actionsAllowed: false }, 'accept', keys, createKey), null);
});

test('only a conflict-free durable terminal acceptance is classified as successful', () => {
  assert.equal(client.collaborationAgentAcceptanceOutcome(accepted()), 'accepted');
  assert.equal(client.collaborationAgentAcceptanceOutcome({ ...accepted(), operationStatus: 'checkpointed_file', durability: 'checkpointed_file' }), 'accepted');
  for (const status of ['needs_review', 'partially_applied', 'semantic_conflict']) {
    assert.equal(client.collaborationAgentAcceptanceOutcome({ ...accepted(), operationStatus: status }), 'review');
    assert.equal(client.collaborationAgentAcceptanceOutcome({ ...accepted(), status }), 'review');
  }
  assert.equal(client.collaborationAgentAcceptanceOutcome({ ...accepted(), conflicts: [{ code: 'target_changed' }] }), 'review');
  assert.equal(client.collaborationAgentAcceptanceOutcome({ ...accepted(), operationStatus: 'applied_to_ydoc', durability: 'applied_to_ydoc' }), 'pending');
  for (const value of [null, [], {}, { ...accepted(), conflicts: undefined }, { ...accepted(), durability: 'pending' }, { ...accepted(), operationStatus: 'failed' }]) {
    assert.equal(client.collaborationAgentAcceptanceOutcome(value), 'failed');
  }
});

async function compileUi(opened: unknown[]) {
  const filename = path.resolve('app/components/editor/CollaborationAgentOperations.tsx');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {} as typeof Ui;
  const mocks: Record<string, unknown> = {
    'next-intl': { useTranslations: () => (key: string) => key },
    '@/app/lib/collaboration/agent-operations-client': client,
    '@/app/lib/file-version-center/contracts/v1': { FILE_VERSION_CENTER_CONTRACT_VERSION: 1 },
    '@/app/lib/files/client': { workspaceHeaders: () => ({ 'x-workspace-id': 'workspace' }) },
    '@/app/store/file-version-center-store': { openVersionCenter: (request: unknown) => { opened.push(request); } },
    '@/components/ui/button': { Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> },
    '@/lib/utils': { cn: (...values: unknown[]) => values.filter(Boolean).join(' ') },
  };
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name),
    { exports }, exports,
  );
  return exports;
}

test('the editor entry opens the latest review in the global center and never posts an approval itself', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test' });
  const prior = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const timers = new Map<number, () => void>(); let timerId = 0;
  Object.defineProperty(dom.window, 'setTimeout', { value: (callback: () => void) => { timers.set(++timerId, callback); return timerId; } });
  Object.defineProperty(dom.window, 'clearTimeout', { value: (id: number) => timers.delete(id) });
  const fetches: Array<{ url: string; method: string }> = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetches.push({ url: String(input), method: init?.method ?? 'GET' });
    return Response.json({ operations: [operation(), { ...operation(version('b')), operationId: 'older-review' }] });
  };
  const opened: unknown[] = [];
  const ui = await compileUi(opened);
  const root = createRoot(document.getElementById('root')!);
  const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); }); };
  try {
    await act(async () => root.render(<ui.CollaborationAgentOperations documentId="document" workspaceId="workspace" />));
    await flush();
    const button = document.querySelector<HTMLButtonElement>('button');
    assert.ok(button);
    await act(async () => button.click());
    assert.deepEqual(opened, [{
      contractVersion: 1,
      target: { kind: 'document', workspaceId: 'workspace', documentId: 'document' },
      selectedEntry: { kind: 'agent_operation', id: 'operation/one' },
      initialView: 'reviews',
      source: 'editor',
    }]);
    assert.deepEqual(fetches.map((entry) => entry.method), ['GET']);
    assert.equal(document.body.textContent?.includes('agentAccept'), false,
      'approval controls exist only in the global center');
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = priorFetch;
    dom.window.close();
    ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].forEach((name, index) => {
      const descriptor = prior[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
