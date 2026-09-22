import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function main() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent });
  const client = await import('../app/lib/email/review-client');
  const store = await import('../app/store/email-review-store');
  type Draft = import('../app/lib/email/review-client').EmailReviewEntry;
  const make = (id: string, version = 1): Draft => ({
    id, accountId: 'account', senderAddress: 'sender@example.test', subject: id, status: 'awaiting_review', version,
    updatedAt: '2026-01-01T00:00:00Z', body: '<p>Hello <strong>world</strong></p>', to: ['to@example.test'], cc: [], bcc: ['hidden@example.test'],
    isHtml: true, scope: 'personal', canWrite: true,
  });
  let drafts: Record<string, Draft> = {};
  let sendFailure = false;
  let lostSendResponse = false;
  let conflict = false;
  let unauthorized = false;
  let workspaceFailure = false;
  let readFailure = false;
  let releaseSend: (() => void) | null = null;
  let sendGate: Promise<void> | null = null;
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  let deferredRead: { id: string; promise: Promise<Response> } | null = null;
  const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (unauthorized) return response({ success: false, error: 'Session expired' }, 401);
    if (url === '/api/workspaces') return response({ success: true, workspaces: [{ id: 'readonly', name: 'Read only', permissions: { canRead: true, canWrite: false } }] });
    if (url === '/api/workspaces/readonly/email/outbox') return workspaceFailure
      ? response({ success: false, error: 'Workspace offline' }, 503)
      : response({ success: true, data: [make('workspace-draft')] });
    if (url === '/api/email/outbox') return response({ success: true, data: Object.values(drafts) });
    const match = url.match(/\/outbox\/([^/]+)(?:\/(send|reject))?$/u);
    assert.ok(match, `Unexpected request ${url}`);
    const [, id, action] = match;
    if (method === 'GET' && deferredRead?.id === id) return deferredRead.promise;
    const current = drafts[id] || make(id);
    if (method === 'GET' && readFailure) throw new TypeError('Reload unavailable');
    if (method === 'GET') return response({ success: true, data: current });
    if (action === 'send' && sendGate) await sendGate;
    if (conflict || body?.expectedVersion !== current.version) return response({ success: false, error: 'Version conflict' }, 409);
    if (method === 'PATCH') {
      drafts[id] = { ...current, ...body, version: current.version + 1, status: 'editing' };
      return response({ success: true, data: { ...drafts[id], senderAddress: null } });
    }
    if (action === 'send' && sendFailure) {
      drafts[id] = { ...current, version: current.version + 2, status: 'send_failed', errorCode: 'SEND_POLICY_BLOCKED', errorMessage: 'Recipient blocked' };
      return response({ success: false, code: 'SEND_POLICY_BLOCKED', error: 'Recipient blocked', data: drafts[id] }, 422);
    }
    drafts[id] = { ...current, version: current.version + 2, status: action === 'reject' ? 'discarded' : 'sent' };
    if (action === 'send' && lostSendResponse) throw new TypeError('Network response lost');
    return response({ success: true, data: drafts[id] });
  };
  function reset() {
    store.useEmailReviewStore.setState({ dirty: false, busy: false }); store.closeEmailReview();
    drafts = { first: make('first'), second: make('second') };
    sendFailure = false; lostSendResponse = false; conflict = false; unauthorized = false; workspaceFailure = false; readFailure = false; sendGate = null; releaseSend = null; deferredRead = null; requests.length = 0;
  }
  const target = (draftId: string) => ({ scope: 'personal' as const, draftId });
  reset();
  await store.openEmailReview(target('first'));
  assert.equal(store.useEmailReviewStore.getState().queue.length, 3);
  assert.equal(store.useEmailReviewStore.getState().queue.find((entry) => entry.id === 'workspace-draft')?.canWrite, false);
  store.updateEmailReviewForm({ subject: 'Edited', bodyHtml: '<p>Safe</p><script>alert(1)</script>' });
  assert.equal(await store.selectEmailReview(target('second')), false);
  assert.equal(store.useEmailReviewStore.getState().activeEntry?.id, 'first');
  assert.ok(store.useEmailReviewStore.getState().pendingNavigation);
  store.cancelEmailReviewNavigation();
  await assert.rejects(() => store.rejectEmailReviewTarget(target('first')), /unsaved/u);
  assert.equal(await store.saveActiveEmailReview(), true);
  assert.equal(store.useEmailReviewStore.getState().activeEntry?.version, 2);
  assert.equal(store.useEmailReviewStore.getState().activeEntry?.senderAddress, 'sender@example.test');
  const patch = requests.find((item) => item.method === 'PATCH');
  assert.deepEqual(patch?.body?.bcc, ['hidden@example.test']);
  assert.equal(patch?.body?.body, '<p>Safe</p>');

  reset(); await store.openEmailReview(target('first'));
  store.updateEmailReviewForm({ subject: 'Send edited text' });
  sendFailure = true;
  assert.equal(await store.sendActiveEmailReview(), false);
  assert.equal(store.useEmailReviewStore.getState().activeEntry?.version, 4);
  assert.equal(store.useEmailReviewStore.getState().activeEntry?.status, 'send_failed');
  assert.equal(requests.find((item) => item.url.endsWith('/send'))?.body?.expectedVersion, 2);
  sendFailure = false;
  assert.equal(await store.sendActiveEmailReview(), true);
  assert.equal(requests.filter((item) => item.url.endsWith('/send')).at(-1)?.body?.expectedVersion, 4);
  assert.notEqual(store.useEmailReviewStore.getState().activeEntry?.id, 'first');

  reset(); await store.openEmailReview(target('first'));
  lostSendResponse = true;
  assert.equal(await store.sendActiveEmailReview(), true);
  assert.equal(store.useEmailReviewStore.getState().queue.some((entry) => entry.id === 'first'), false);
  assert.equal(requests.filter((item) => item.url.endsWith('/send')).length, 1);

  reset(); await store.openEmailReview(target('first'));
  sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const inFlightSend = store.sendActiveEmailReview();
  assert.equal(await store.sendActiveEmailReview(), false);
  assert.equal(store.closeEmailReview(), false);
  releaseSend!(); await inFlightSend;
  assert.equal(requests.filter((item) => item.url.endsWith('/send')).length, 1);

  reset(); await store.openEmailReview(target('first'));
  lostSendResponse = true; readFailure = true;
  assert.equal(await store.sendActiveEmailReview(), false);
  assert.equal(store.useEmailReviewStore.getState().needsReload, true);
  assert.equal(await store.sendActiveEmailReview(), false);
  assert.equal(requests.filter((item) => item.url.endsWith('/send')).length, 1);

  reset(); await store.openEmailReview(target('first'));
  conflict = true; drafts.first.version = 7;
  assert.equal(await store.sendActiveEmailReview(), false);
  assert.equal(store.useEmailReviewStore.getState().activeEntry?.version, 1);
  assert.equal(store.useEmailReviewStore.getState().dirty, true);

  reset(); await store.openEmailReview(target('first'));
  store.updateEmailReviewForm({ subject: 'Keep my edits' }); conflict = true;
  assert.equal(await store.saveActiveEmailReview(), false);
  assert.equal(store.useEmailReviewStore.getState().activeEntry?.version, 1);
  assert.equal(store.useEmailReviewStore.getState().form.subject, 'Keep my edits');
  assert.equal(store.useEmailReviewStore.getState().dirty, true);
  assert.equal(await store.refreshEmailReview(), false);
  conflict = false; drafts.first = { ...drafts.first, version: 5, subject: 'Server changed' };
  await store.confirmDiscardEmailReviewNavigation();
  assert.equal(store.useEmailReviewStore.getState().activeEntry?.version, 5);
  assert.equal(store.useEmailReviewStore.getState().form.subject, 'Server changed');

  reset(); await store.openEmailReview(target('first'));
  let resolveRead!: (response: Response) => void;
  deferredRead = { id: 'second', promise: new Promise((resolve) => { resolveRead = resolve; }) };
  const oldLoad = store.selectEmailReview(target('second'));
  await store.selectEmailReview(target('first'));
  resolveRead(response({ success: true, data: make('second') })); await oldLoad;
  assert.equal(store.useEmailReviewStore.getState().activeEntry?.id, 'first');

  reset(); workspaceFailure = true; await store.openEmailReview();
  assert.equal(store.useEmailReviewStore.getState().loadingWarnings.length, 1);
  assert.equal(store.useEmailReviewStore.getState().queue.length, 2);
  assert.equal(store.useEmailReviewStore.getState().completed, false);
  unauthorized = true; await store.refreshEmailReview();
  assert.equal(store.useEmailReviewStore.getState().queue.length, 0);
  assert.equal(store.useEmailReviewStore.getState().activeEntry, null);
  assert.equal(store.useEmailReviewStore.getState().form.subject, '');

  assert.deepEqual(client.parseEmailReviewRecipients('Person <TO@example.test>, hidden@example.test'), ['to@example.test', 'hidden@example.test']);
  assert.throws(() => client.parseEmailReviewRecipients('To <to@example.test> injected@example.test'), /valid/u);
  reset(); await store.openEmailReview(target('first'));
  store.updateEmailReviewForm({ subject: 'Unsaved closing' });
  assert.equal(store.closeEmailReview(), false);
  await store.confirmDiscardEmailReviewNavigation();
  assert.equal(store.useEmailReviewStore.getState().open, false);
  dom.window.close();
  console.log('email-review-store-test: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
