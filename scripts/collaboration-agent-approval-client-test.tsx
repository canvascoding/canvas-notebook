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

async function harness(initial = operation()) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test' });
  const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const priorGlobals = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const timers = new Map<number, () => void>(); let timerId = 0;
  Object.defineProperty(dom.window, 'setTimeout', { value: (callback: () => void) => { timers.set(++timerId, callback); return timerId; } });
  Object.defineProperty(dom.window, 'clearTimeout', { value: (id: number) => timers.delete(id) });
  const toasts: Array<{ type: string; message: string }> = [];
  const posts: Array<{ url: string; body: { idempotencyKey: string; proposalVersion?: string } }> = [];
  const controls = {
    operations: [initial], getCount: 0,
    nextGet: null as Promise<Response> | null,
    post: async () => Response.json({ success: true, operation: accepted() }),
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(new Headers(init?.headers).get('x-workspace-id'), 'workspace');
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return controls.post();
    }
    controls.getCount++;
    if (controls.nextGet) { const delayed = controls.nextGet; controls.nextGet = null; return delayed; }
    return Response.json({ operations: controls.operations });
  };
  const container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const translate = (key: string) => key;
  const mocks: Record<string, unknown> = {
    'next-intl': { useTranslations: () => translate },
    sonner: { toast: Object.fromEntries(['success', 'error', 'message'].map((type) => [type, (message: string) => toasts.push({ type, message })])) },
    '@/app/lib/collaboration/agent-operations-client': client,
    '@/app/lib/files/client': { workspaceHeaders: () => ({ 'x-workspace-id': 'workspace' }) },
    '@/components/ui/button': { Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> },
    '@/components/ui/popover': { Popover: container, PopoverContent: container, PopoverTrigger: container },
    '@/components/ui/scroll-area': { ScrollArea: container },
    '@/components/ui/tabs': { Tabs: container, TabsContent: container, TabsList: container, TabsTrigger: container },
    '@/lib/utils': { cn: (...values: unknown[]) => values.filter(Boolean).join(' ') },
  };
  const filename = path.resolve('app/components/editor/CollaborationAgentOperations.tsx'); const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const ui = {} as typeof Ui;
  new Function('require', 'module', 'exports', source)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports: ui }, ui);
  const root = createRoot(document.getElementById('root')!);
  const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); }); };
  await act(async () => root.render(<ui.CollaborationAgentOperations documentId="document" />));
  await flush();
  const button = (label = 'agentAccept') => [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  const click = async (label = 'agentAccept') => {
    const target = button(label); assert.ok(target, `${label} is available`);
    await act(async () => { target.click(); }); await flush();
  };
  const poll = async () => {
    const next = timers.entries().next().value; assert.ok(next, 'a poll is scheduled');
    timers.delete(next[0]); await act(async () => next[1]()); await flush();
  };
  return { controls, toasts, posts, click, button, poll, flush,
    close: async () => {
      await act(async () => root.unmount());
      assert.equal(timers.size, 0);
      globalThis.fetch = oldFetch; dom.window.close();
      globals.forEach((name, index) => {
        const descriptor = priorGlobals[index];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      });
    } };
}

test('the rendered panel sends the displayed token, retries it consistently, then renews the key for a changed preview', async () => {
  const h = await harness();
  try {
    h.controls.post = async () => Response.json({ error: 'Temporary failure' }, { status: 503 });
    await h.click(); await h.click();
    assert.equal(h.posts[0].url, '/api/files/collaboration/operations/operation%2Fone/accept');
    assert.equal(h.posts[0].body.proposalVersion, version('a'));
    assert.deepEqual(h.posts[1].body, h.posts[0].body);
    h.controls.operations = [operation(version('b'))];
    h.controls.post = async () => Response.json({ success: false, code: 'AGENT_PROPOSAL_CHANGED' }, { status: 409 });
    await h.click();
    assert.ok(h.toasts.some((entry) => entry.type === 'message' && entry.message === 'agentProposalChanged'));
    assert.equal(h.toasts.filter((entry) => entry.type === 'success').length, 0);
    assert.match(document.body.textContent ?? '', /Proposal v1\.b/u);
    h.controls.post = async () => Response.json({ success: true, operation: accepted() });
    await h.click();
    assert.equal(h.posts[3].body.proposalVersion, version('b'));
    assert.notEqual(h.posts[3].body.idempotencyKey, h.posts[0].body.idempotencyKey);
    assert.equal(h.toasts.filter((entry) => entry.message === 'agentAction_accept' && entry.type === 'success').length, 1);
  } finally { await h.close(); }
});

for (const [label, result, message] of [
  ['review', { ...accepted(), operationStatus: 'needs_review' }, 'agentActionNeedsReview'],
  ['partial', { ...accepted(), operationStatus: 'partially_applied' }, 'agentActionNeedsReview'],
  ['conflict', { ...accepted(), conflicts: [{ code: 'target_changed' }] }, 'agentActionNeedsReview'],
  ['pending', { ...accepted(), operationStatus: 'applied_to_ydoc', durability: 'applied_to_ydoc' }, 'agentActionPending'],
  ['missing result', undefined, 'agentActionFailed'],
] as const) test(`an HTTP 200 ${label} response cannot show an acceptance success`, async () => {
  const h = await harness();
  try {
    h.controls.post = async () => Response.json({ success: true, operation: result });
    h.controls.operations = [operation(version('b'))];
    const before = h.controls.getCount; await h.click();
    assert.equal(h.toasts.filter((entry) => entry.type === 'success').length, 0);
    assert.ok(h.toasts.some((entry) => entry.message === message));
    assert.ok(h.controls.getCount > before, 'the current preview is reloaded');
  } finally { await h.close(); }
});

test('missing proposal versions and unauthorized actors cannot issue acceptance requests', async () => {
  for (const initial of [operation(null), { ...operation(), proposalVersion: undefined }, { ...operation(), actionsAllowed: false }]) {
    const h = await harness(initial);
    try { assert.equal(h.button(), undefined); assert.equal(h.posts.length, 0); }
    finally { await h.close(); }
  }
});

test('a stale pre-action polling response cannot replace the refreshed proposal', async () => {
  const h = await harness();
  try {
    let release!: (value: Response) => void;
    h.controls.nextGet = new Promise<Response>((resolve) => { release = resolve; });
    await h.poll();
    h.controls.operations = [operation(version('b'))];
    h.controls.post = async () => Response.json({ success: false, code: 'AGENT_PROPOSAL_CHANGED' }, { status: 409 });
    await h.click();
    release(Response.json({ operations: [operation(version('a'))] })); await h.flush();
    assert.match(document.body.textContent ?? '', /Proposal v1\.b/u);
    assert.doesNotMatch(document.body.textContent ?? '', /Proposal v1\.a/u);
    h.controls.post = async () => Response.json({ success: true, operation: accepted() });
    await h.click(); assert.equal(h.posts.at(-1)?.body.proposalVersion, version('b'));
  } finally { await h.close(); }
});

test('ordinary durability and checkpoint progress never emits a toast', async () => {
  const h = await harness();
  try {
    for (const status of ['applied_to_ydoc', 'persisted_yjs', 'checkpointed_file'] as const) {
      h.controls.operations = [{ ...operation(), operationStatus: status }];
      await h.poll();
    }
    assert.deepEqual(h.toasts, []);
  } finally { await h.close(); }
});

test('an incomplete preview cannot be accepted even with a valid server token', async () => {
  const h = await harness({ ...operation(), reviewTargets: [{ targetId: 'internal-target', groupId: 'internal-group',
    currentText: '[{"id":"internal-block"}]', proposedReplacement: 'Unknown representation' }] });
  try { assert.equal(h.button(), undefined); assert.equal(h.posts.length, 0); }
  finally { await h.close(); }
});
