import assert from 'node:assert/strict';
import test from 'node:test';
import type { TodoItem } from '../app/lib/todos/client-types';
import { closeTodoDetail, discardTodoDraft, mutateTodoDetail, openTodoDetail, useTodoDetailStore } from '../app/store/todo-detail-store';

class FocusTarget { isConnected = true; focused = 0; focus() { this.focused += 1; } }
const originalGlobals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, fetch: globalThis.fetch };
let requests: Array<{ url: string; init?: RequestInit; finish: (response: Response) => void }> = [];
let browserUrl = new URL('https://canvas.invalid/de');
const focusTarget = new FocusTarget();
const eventTarget = new EventTarget();
Object.assign(globalThis, {
  HTMLElement: FocusTarget,
  document: { activeElement: focusTarget },
  window: {
    location: { get href() { return browserUrl.href; } },
    history: { state: null, replaceState(_state: unknown, _unused: string, next: string) { browserUrl = new URL(next, browserUrl); } },
    requestAnimationFrame(callback: () => void) { callback(); },
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
  },
  fetch: (input: string | URL | Request, init?: RequestInit) => new Promise<Response>((finish) => { requests.push({ url: String(input), init, finish }); }),
});
function todo(id: string, overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id, canWrite: true, title: id, status: 'open', readState: 'read', updatedAt: '2026-09-30T08:00:00Z',
    createdByUserId: 'owner', assigneeUserId: null, organizationId: null, workspaceId: null,
    workspaceType: 'personal', scopeKind: 'user', workspace: null, description: null, priority: 'normal', iconKey: null,
    sourceType: 'user', sourceSessionId: null, dueAt: null, remindAt: null, seenAt: null, readAt: null,
    completedAt: null, completionComment: null, followUpSentAt: null, followUpError: null,
    emailNotificationSentAt: null, emailNotificationError: null, archivedAt: null,
    createdAt: '2026-09-30T08:00:00Z', category: null, fileLinks: [], createdBy: null, assignee: null, ...overrides,
  };
}
function respond(index: number, item: TodoItem, status = 200) {
  requests[index].finish(Response.json(status === 200 ? { success: true, data: item } : { success: false, error: 'Changed remotely' }, { status }));
}
function reset() { closeTodoDetail(true); requests = []; browserUrl = new URL('https://canvas.invalid/de'); }
async function flush() { await new Promise<void>((resolve) => setImmediate(resolve)); }

async function main() {
try {
  await test('switching todos ignores an older fetch even when transport ignores abort', async () => {
    reset();
    const first = openTodoDetail('first');
    const second = openTodoDetail('second');
    assert.equal(requests[0].init?.signal?.aborted, true);
    respond(1, todo('second'));
    await second;
    respond(0, todo('first'));
    await first;
    assert.equal(useTodoDetailStore.getState().todo?.id, 'second');
  });

  await test('switching away from a deep-linked todo removes its popup query while preserving the current page', async () => {
    reset();
    browserUrl = new URL('https://canvas.invalid/de/notebook?todo=first&path=%2Fnotes%2Ftest.md');
    const first = openTodoDetail('first');
    respond(0, todo('first'));
    await first;
    const second = openTodoDetail('second');
    respond(1, todo('second'));
    await second;
    closeTodoDetail();
    assert.equal(browserUrl.searchParams.has('todo'), false);
    assert.equal(browserUrl.searchParams.get('path'), '/notes/test.md');
    assert.equal(browserUrl.pathname, '/de/notebook');
  });

  await test('switching a dirty todo waits for explicit discard before loading the next item', async () => {
    reset();
    const first = openTodoDetail('first');
    respond(0, todo('first'));
    await first;
    useTodoDetailStore.setState({ dirty: true });
    await openTodoDetail('second');
    assert.equal(requests.length, 1);
    assert.equal(useTodoDetailStore.getState().todoId, 'first');
    assert.deepEqual(useTodoDetailStore.getState().pendingAction, { kind: 'open', todoId: 'second' });
    const discarding = discardTodoDraft();
    assert.equal(requests.length, 2);
    respond(1, todo('second'));
    await discarding;
    assert.equal(useTodoDetailStore.getState().todoId, 'second');
    assert.equal(useTodoDetailStore.getState().dirty, false);
  });

  await test('read-on-open finishes before writes can start, preventing late read snapshots overwriting saves', async () => {
    reset();
    const opening = openTodoDetail('unread');
    respond(0, todo('unread', { readState: 'unread' }));
    await flush();
    assert.equal(requests[1].init?.method, 'PATCH');
    assert.equal(useTodoDetailStore.getState().loading, true);
    assert.equal(await mutateTodoDetail({ title: 'New title' }), null);
    assert.equal(requests.length, 2);
    respond(1, todo('unread'));
    await opening;
    assert.equal(useTodoDetailStore.getState().loading, false);
    const saving = mutateTodoDetail({ title: 'New title' });
    respond(2, todo('unread', { title: 'New title' }));
    await saving;
    assert.equal(useTodoDetailStore.getState().todo?.title, 'New title');
  });

  await test('closing while loading rejects a late response and restores opener focus', async () => {
    reset();
    const opening = openTodoDetail('late');
    const before = focusTarget.focused;
    closeTodoDetail();
    respond(0, todo('late'));
    await opening;
    assert.equal(useTodoDetailStore.getState().open, false);
    assert.equal(useTodoDetailStore.getState().todo, null);
    assert.equal(focusTarget.focused, before + 1);
  });

  await test('read-only access blocks edits but permits marking the to-do read', async () => {
    reset();
    const opening = openTodoDetail('readonly');
    respond(0, todo('readonly', { canWrite: false }));
    await opening;
    assert.equal(await mutateTodoDetail({ status: 'done' }), null);
    assert.equal(requests.length, 1);
    const marking = mutateTodoDetail({ markSeen: true });
    assert.equal(requests.length, 2);
    respond(1, todo('readonly', { canWrite: false }));
    await marking;
  });

  await test('concurrent writes are blocked and a conflict preserves the dirty draft', async () => {
    reset();
    const opening = openTodoDetail('conflict');
    respond(0, todo('conflict'));
    await opening;
    useTodoDetailStore.setState({ dirty: true });
    const saving = mutateTodoDetail({ title: 'Draft title' });
    assert.equal(await mutateTodoDetail({ status: 'done' }), null);
    assert.equal(requests.length, 2);
    assert.equal(JSON.parse(String(requests[1].init?.body)).expectedUpdatedAt, '2026-09-30T08:00:00Z');
    respond(1, todo('conflict'), 409);
    assert.equal(await saving, null);
    assert.equal(useTodoDetailStore.getState().dirty, true);
    assert.equal(useTodoDetailStore.getState().errorStatus, 409);
    closeTodoDetail();
    assert.equal(useTodoDetailStore.getState().open, true);
    assert.deepEqual(useTodoDetailStore.getState().pendingAction, { kind: 'close' });
  });
} finally {
  closeTodoDetail(true);
  Object.assign(globalThis, originalGlobals);
}
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
