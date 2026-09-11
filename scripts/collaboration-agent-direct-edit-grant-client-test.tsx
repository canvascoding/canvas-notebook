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
import type * as GrantUi from '../app/components/editor/CollaborationAgentDirectEditGrant';
import type * as PanelUi from '../app/components/editor/CollaborationAgentOperations';

type Grant = { id: string; expiresAt: number; active: boolean; revokedAt: number | null };
type Status = { success: true; canGrant: boolean; grant: Grant | null };
const operation = (extra: Partial<client.CollaborationAgentOperation> = {}): client.CollaborationAgentOperation => ({
  operationId: 'operation/one', operationStatus: 'needs_review', status: 'needs_review', durability: 'needs_review',
  actorId: 'agent', actionsAllowed: true, initiatedByCurrentUser: true,
  proposalVersion: `v1.${'a'.repeat(64)}`, appliedTargetIds: [], conflicts: [], targetAnchors: [],
  reviewTargets: [{ targetId: 'target', groupId: 'group', currentText: 'Current', proposedReplacement: 'Proposal', previewFormat: 'text' }], ...extra,
});
const grant = (extra: Partial<Grant> = {}): Grant => ({ id: 'grant', expiresAt: Date.now() + 1_800_000, active: true, revokedAt: null, ...extra });

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file); const load = createRequire(filename); const exports = {};
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', source)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports);
  return exports as T;
}

async function harness(initial = operation(), initialStatus: Status = { success: true, canGrant: true, grant: null }) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test' });
  const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const priorGlobals = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const timers = new Map<number, () => void>(); let timerId = 0;
  Object.defineProperty(dom.window, 'setTimeout', { value: (callback: () => void) => { timers.set(++timerId, callback); return timerId; } });
  Object.defineProperty(dom.window, 'clearTimeout', { value: (id: number) => timers.delete(id) });
  const requests: Array<{ url: string; method: string; body?: { action: string; idempotencyKey: string } }> = [];
  const controls = {
    status: initialStatus,
    setOpen: (_open: boolean) => {},
    grantGet: async (): Promise<Response> => Response.json(controls.status),
    grantPost: async (body: { action: string; idempotencyKey: string }): Promise<Response> => {
      controls.status = { ...controls.status, grant: body.action === 'grant' ? grant()
        : controls.status.grant ? { ...controls.status.grant, active: false, revokedAt: Date.now() } : null };
      return Response.json({ success: true, grant: controls.status.grant });
    },
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input); const method = init?.method ?? 'GET';
    assert.equal(new Headers(init?.headers).get('x-workspace-id'), 'workspace');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, ...(body ? { body } : {}) });
    if (url.endsWith('/direct-edit-grant')) return method === 'POST' ? controls.grantPost(body) : controls.grantGet();
    assert.equal(method, 'GET', 'direct editing never accepts or mutates the source proposal');
    return Response.json({ operations: [initial] });
  };
  const container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const translate = (key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${JSON.stringify(values)}` : ''}`;
  const mocks: Record<string, unknown> = {
    'next-intl': { useTranslations: () => translate },
    sonner: { toast: { success() {}, error() {}, message() {} } },
    '@/app/lib/collaboration/agent-operations-client': client,
    '@/app/lib/files/client': { workspaceHeaders: () => ({ 'x-workspace-id': 'workspace' }) },
    '@/components/ui/button': { Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> },
    '@/components/ui/popover': {
      Popover: ({ children, onOpenChange }: { children?: React.ReactNode; onOpenChange: (open: boolean) => void }) => {
        controls.setOpen = onOpenChange; return <div>{children}</div>;
      }, PopoverContent: container, PopoverTrigger: container,
    },
    '@/components/ui/scroll-area': { ScrollArea: container },
    '@/components/ui/tabs': { Tabs: container, TabsContent: container, TabsList: container, TabsTrigger: container },
    '@/lib/utils': { cn: (...values: unknown[]) => values.filter(Boolean).join(' ') },
  };
  mocks['./CollaborationAgentDirectEditGrant'] = await compile<typeof GrantUi>('app/components/editor/CollaborationAgentDirectEditGrant.tsx', mocks);
  const ui = await compile<typeof PanelUi>('app/components/editor/CollaborationAgentOperations.tsx', mocks);
  const root = createRoot(document.getElementById('root')!);
  const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); }); };
  await act(async () => root.render(<ui.CollaborationAgentOperations documentId="document" />)); await flush();
  const button = (label: string) => [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  const click = async (label: string) => {
    const target = button(label); assert.ok(target, `${label} is available`);
    await act(async () => target.click()); await flush();
  };
  const open = async (value = true) => { await act(async () => controls.setOpen(value)); await flush(); };
  const poll = async () => {
    for (const [id, callback] of [...timers]) { timers.delete(id); await act(async () => callback()); }
    await flush();
  };
  return { controls, requests, button, click, open, poll, flush,
    posts: () => requests.filter((entry) => entry.method === 'POST'),
    grantGets: () => requests.filter((entry) => entry.method === 'GET' && entry.url.endsWith('/direct-edit-grant')),
    close: async () => {
      await act(async () => root.unmount()); assert.equal(timers.size, 0);
      globalThis.fetch = oldFetch; dom.window.close();
      globals.forEach((name, index) => {
        const descriptor = priorGlobals[index];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      });
    } };
}

test('only opening the panel reads grant status; a separate explicit action grants the exact scoped permission', async () => {
  const h = await harness();
  try {
    assert.equal(h.grantGets().length, 0); assert.equal(h.posts().length, 0);
    await h.open(); assert.equal(h.grantGets().length, 1); assert.equal(h.posts().length, 0);
    assert.ok(h.button('agentAccept'), 'current proposal acceptance remains separate');
    await h.click('agentDirectEditGrant');
    assert.equal(h.posts().length, 1);
    const post = h.posts()[0];
    assert.equal(post.url, '/api/files/collaboration/operations/operation%2Fone/direct-edit-grant');
    assert.deepEqual(Object.keys(post.body!).sort(), ['action', 'idempotencyKey']);
    assert.equal(post.body!.action, 'grant'); assert.ok(post.body!.idempotencyKey);
    assert.ok(h.button('agentAccept')); assert.ok(h.button('agentDirectEditRevoke'));
    assert.equal(h.button('agentDirectEditGrant'), undefined);
    assert.match(document.body.textContent ?? '', /agentDirectEditActiveUntil/u);
    const expiresAt = h.controls.status.grant!.expiresAt;
    await h.open(false); const before = h.grantGets().length; await h.poll();
    assert.equal(h.grantGets().length, before, 'a closed popover does not poll permission status');
    await h.open(); await h.poll();
    assert.equal(h.posts().length, 1); assert.equal(h.controls.status.grant!.expiresAt, expiresAt);
  } finally { await h.close(); }
});

test('other users and a workspace manager cannot grant another chat permission', async () => {
  for (const ownership of [false, undefined]) {
    const h = await harness(operation({ initiatedByCurrentUser: ownership, actionsAllowed: true }));
    try {
      await h.open(); await h.poll();
      assert.equal(h.grantGets().length, 0); assert.equal(h.posts().length, 0);
      assert.equal(h.button('agentDirectEditGrant'), undefined);
    } finally { await h.close(); }
  }
});

test('the server must explicitly allow a grant even for the current user', async () => {
  const h = await harness(operation(), { success: true, canGrant: false, grant: null });
  try { await h.open(); assert.equal(h.button('agentDirectEditGrant'), undefined); assert.equal(h.posts().length, 0); }
  finally { await h.close(); }
});

test('an existing own grant can still be revoked after write permission is withdrawn, including in history', async () => {
  const h = await harness(operation({ operationStatus: 'persisted_yjs', actionsAllowed: false }),
    { success: true, canGrant: false, grant: grant({ active: false }) });
  try {
    await h.open(); assert.equal(h.button('agentDirectEditGrant'), undefined);
    await h.click('agentDirectEditRevoke');
    assert.deepEqual(Object.keys(h.posts()[0].body!).sort(), ['action', 'idempotencyKey']);
    assert.equal(h.posts()[0].body!.action, 'revoke');
    assert.equal(h.button('agentDirectEditRevoke'), undefined);
    assert.match(document.body.textContent ?? '', /agentDirectEditRevoked/u);
  } finally { await h.close(); }
});

test('an uncertain grant response retries with the same key and original expiry, without accepting the proposal', async () => {
  const h = await harness();
  try {
    const stored = grant(); let attempts = 0;
    h.controls.grantPost = async () => {
      if (++attempts === 1) throw new Error('Connection lost after commit');
      h.controls.status = { ...h.controls.status, grant: stored };
      return Response.json({ success: true, grant: stored });
    };
    await h.open(); await h.click('agentDirectEditGrant'); await h.click('agentDirectEditGrant');
    assert.deepEqual(h.posts()[0].body, h.posts()[1].body);
    assert.equal(h.controls.status.grant!.expiresAt, stored.expiresAt);
    assert.equal(h.button('agentDirectEditGrant'), undefined);
    assert.ok(h.button('agentAccept'));
  } finally { await h.close(); }
});

test('an expired grant requires a new explicit action and its own retry key', async () => {
  const h = await harness();
  try {
    await h.open(); await h.click('agentDirectEditGrant');
    h.controls.status = { ...h.controls.status, grant: grant({ id: 'grant', expiresAt: Date.now() - 1, active: false }) };
    await h.poll(); assert.equal(h.posts().length, 1);
    await h.click('agentDirectEditGrant');
    assert.notEqual(h.posts()[0].body!.idempotencyKey, h.posts()[1].body!.idempotencyKey);
  } finally { await h.close(); }
});

test('malformed grant status and denied reads never enable permission changes', async () => {
  for (const value of [null, [], { success: true, canGrant: true }, { success: true, canGrant: 'true', grant: null },
    { success: true, canGrant: true, grant: { id: 'grant', active: true, expiresAt: 'tomorrow', revokedAt: null } }]) {
    const h = await harness();
    try {
      h.controls.grantGet = async () => Response.json(value);
      await h.open(); assert.equal(h.button('agentDirectEditGrant'), undefined); assert.equal(h.posts().length, 0);
      assert.ok(h.button('agentDirectEditRefresh'));
    } finally { await h.close(); }
  }
  const h = await harness();
  try {
    h.controls.grantGet = async () => Response.json({ error: 'denied' }, { status: 403 });
    await h.open(); assert.equal(h.button('agentDirectEditGrant'), undefined); assert.equal(h.posts().length, 0);
  } finally { await h.close(); }
});

test('a stale status response cannot overwrite an explicitly confirmed revocation', async () => {
  const h = await harness(operation(), { success: true, canGrant: true, grant: grant() });
  try {
    await h.open();
    let release!: (response: Response) => void;
    const older = h.controls.status;
    h.controls.grantGet = () => new Promise<Response>((resolve) => { release = resolve; });
    await h.poll(); await h.click('agentDirectEditRevoke');
    release(Response.json(older)); await h.flush();
    assert.equal(h.button('agentDirectEditRevoke'), undefined);
    assert.ok(h.button('agentDirectEditGrant'));
    assert.equal(h.posts().length, 1);
  } finally { await h.close(); }
});

test('a successful HTTP response without the requested permission result cannot confirm a grant or revocation', async () => {
  for (const action of ['grant', 'revoke'] as const) {
    const h = await harness(operation(), { success: true, canGrant: true, grant: action === 'revoke' ? grant() : null });
    try {
      h.controls.grantPost = async () => Response.json({ success: true, grant: action === 'revoke' ? grant() : null });
      await h.open(); await h.click(action === 'grant' ? 'agentDirectEditGrant' : 'agentDirectEditRevoke');
      assert.match(document.body.textContent ?? '', /agentDirectEditFailed/u);
      assert.doesNotMatch(document.body.textContent ?? '', /agentDirectEditGranted|agentDirectEditRevoked/u);
      assert.equal(h.posts().length, 1);
    } finally { await h.close(); }
  }
});

test('a status refresh replaces a previous grant confirmation when permission was revoked elsewhere', async () => {
  const h = await harness();
  try {
    await h.open(); await h.click('agentDirectEditGrant');
    assert.match(document.body.textContent ?? '', /agentDirectEditGranted/u);
    h.controls.status = { ...h.controls.status, grant: grant({ active: false, revokedAt: Date.now() }) };
    await h.poll();
    assert.doesNotMatch(document.body.textContent ?? '', /agentDirectEditGranted/u);
    assert.match(document.body.textContent ?? '', /agentDirectEditInactive/u);
    assert.equal(h.posts().length, 1);
  } finally { await h.close(); }
});
