import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import { FileVersionComparison } from '../app/components/file-version-center/FileVersionComparison';
import type { FileVersionCompareRequestV1, FileVersionTimelineEntryV1, FileVersionTimelineResponseV1 } from '../app/lib/file-version-center/contracts/v1';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test/en/notebook' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'DOMException', 'HTMLButtonElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'SVGElement', 'NodeFilter', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window
    : key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(callback, 0) });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: clearTimeout });
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const current = { kind: 'current' as const, id: 'current' as const, observedAt: '2026-09-14T09:00:00.000Z',
  revisionId: 'current-one', sha256: 'a'.repeat(64), sizeBytes: 20 };
const revision = { kind: 'revision' as const, id: 'revision-one', revisionId: 'revision-one', revisionNumber: 1,
  createdAt: '2026-09-13T08:00:00.000Z', source: 'manual' as const, actor: { type: 'user' as const, displayName: 'Author' },
  content: { availability: 'available' as const, format: 'markdown' as const, sha256: 'b'.repeat(64), sizeBytes: 20 }, restorable: true };
const timeline: FileVersionTimelineResponseV1 = { contractVersion: 1,
  document: { workspaceId: 'w1', lineageId: 'l1', documentId: 'd1', path: 'one.md' },
  capabilities: { contractVersion: 1, history: true, compare: true, restore: true, agentReviewPolicy: true, preview: 'markdown' },
  entries: [current, revision], page: { hasMore: false, nextCursor: null } };
function payload(request: FileVersionCompareRequestV1, content: string, more = false) {
  return { actionFence: { proposalVersion: null }, response: { contractVersion: 1,
    current: { fence: request.expectedCurrent, observedAt: current.observedAt },
    candidate: { selection: request.candidate, stale: false, contentAvailable: true },
    summary: { additions: 1, deletions: 0, unchanged: 0 },
    hunks: [{ id: content, oldStart: 1, oldLines: 0, newStart: 1, newLines: 1,
      lines: [{ kind: 'addition', oldLineNumber: null, newLineNumber: 1, text: content }] }],
    page: { hasMore: more, nextCursor: more ? 'v1.1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : null }, truncated: false },
    preview: { format: 'markdown', current: 'old', candidate: content, externalRequestsAllowed: false,
      blockedExternalReferences: 0, blocks: { current: 1, candidate: 1, unchanged: 0, changed: 1 } } };
}
const root = createRoot(document.getElementById('root')!);
async function render(value: FileVersionTimelineResponseV1, selected: Extract<FileVersionTimelineEntryV1, { kind: 'revision' | 'agent_operation' }> = revision) {
  await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <FileVersionComparison request={{ contractVersion: 1, target: { kind: 'lineage', workspaceId: value.document.workspaceId,
      lineageId: value.document.lineageId }, source: 'editor', initialView: 'history' }} timeline={value}
      selection={{ state: 'selected', key: `${selected.kind}:${selected.id}`, entry: selected }}
      onTimelineInvalidate={async () => {}} onContinue={() => {}} />
  </NextIntlClientProvider>));
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
function button(text: string) { const value = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text); assert.ok(value, text); return value; }
async function main() {
  const oldPage = deferred<Response>();
  const nextComparison = deferred<Response>();
  let pageRequest!: FileVersionCompareRequestV1;
  let nextRequest!: FileVersionCompareRequestV1;
  let phase = 'initial';
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as FileVersionCompareRequestV1;
    if (request.cursor) { pageRequest = request; return oldPage.promise; }
    if (phase === 'pending') { nextRequest = request; return nextComparison.promise; }
    return Response.json(payload(request, phase === 'initial' ? 'OLD-SNAPSHOT' : 'FRESH-SNAPSHOT', phase === 'initial'));
  };
  await render(timeline); await settle();
  await act(async () => button('Load more changes').click());
  phase = 'pending';
  const changed = { ...timeline, entries: [{ ...current, revisionId: 'current-two', sha256: 'c'.repeat(64) }, revision] };
  await render(changed); await settle();
  assert.match(document.body.textContent ?? '', /OLD-SNAPSHOT/);
  assert.equal(button('Restore version').disabled, true, 'old snapshot cannot be applied against a newer fence');
  await act(async () => { oldPage.resolve(Response.json(payload(pageRequest, 'WRONG-OLD-PAGE'))); });
  await settle();
  assert.doesNotMatch(document.body.textContent ?? '', /WRONG-OLD-PAGE/);
  await act(async () => { nextComparison.resolve(Response.json({ contractVersion: 1, success: false,
    error: { code: 'FVRC_PERSISTENCE_UNAVAILABLE', message: 'Temporary comparison failure', retryable: true } }, { status: 503 })); });
  await settle();
  assert.match(document.body.textContent ?? '', /OLD-SNAPSHOT/);
  assert.match(document.body.textContent ?? '', /Temporary comparison failure/);
  assert.equal(button('Restore version').disabled, true);
  phase = 'ready';
  await act(async () => button('Refresh timeline').click());
  await settle();
  assert.equal(nextRequest.expectedCurrent.sha256, 'c'.repeat(64));
  assert.match(document.body.textContent ?? '', /FRESH-SNAPSHOT/);
  assert.equal(button('Restore version').disabled, false);

  const proposalOne = `v1.${'d'.repeat(64)}`;
  const proposalTwo = `v1.${'e'.repeat(64)}`;
  const agent = { kind: 'agent_operation' as const, id: 'operation-one', operationId: 'operation-one',
    createdAt: current.observedAt, actor: { type: 'agent' as const, displayName: 'Assistant' },
    status: 'ready' as const, actionsAllowed: true, proposalVersion: proposalOne };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as FileVersionCompareRequestV1;
    return Response.json({ ...payload(request, 'PROPOSAL-ONE'), actionFence: { proposalVersion: proposalOne } });
  };
  await render({ ...changed, entries: [changed.entries[0], agent] }, agent); await settle();
  assert.equal(button('Accept change').disabled, false);
  const proposalResponse = deferred<Response>();
  let proposalRequest!: FileVersionCompareRequestV1;
  globalThis.fetch = async (_url, init) => { proposalRequest = JSON.parse(String(init?.body)); return proposalResponse.promise; };
  const updatedAgent = { ...agent, proposalVersion: proposalTwo };
  await render({ ...changed, entries: [changed.entries[0], updatedAgent] }, updatedAgent); await settle();
  assert.match(document.body.textContent ?? '', /PROPOSAL-ONE/);
  assert.equal(button('Accept change').disabled, true, 'an updated proposal cannot reuse the previously reviewed action fence');
  await act(async () => { proposalResponse.resolve(Response.json({ ...payload(proposalRequest, 'PROPOSAL-TWO'),
    actionFence: { proposalVersion: proposalTwo } })); });
  await settle();
  assert.equal(button('Accept change').disabled, false);
  assert.match(document.body.textContent ?? '', /PROPOSAL-TWO/);

  const foreign = deferred<Response>();
  let foreignRequest!: FileVersionCompareRequestV1;
  globalThis.fetch = async (_url, init) => { foreignRequest = JSON.parse(String(init?.body)); return foreign.promise; };
  await render({ ...changed, document: { ...timeline.document, workspaceId: 'w2', lineageId: 'l2', documentId: 'd2' } });
  assert.doesNotMatch(document.body.textContent ?? '', /PROPOSAL-TWO/,
    'another document with the same candidate ID never paints the old preview');
  assert.ok(document.querySelector('[data-testid="file-version-loading-skeleton"]'));
  await act(async () => { foreign.resolve(Response.json(payload(foreignRequest, 'FOREIGN-SNAPSHOT'))); });
  await settle();
  console.log('file version comparison race tests passed');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await act(async () => root.unmount()); getNotebookQueryClient().clear(); dom.window.close();
});
