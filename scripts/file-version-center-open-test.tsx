import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body><button id="origin">Open</button><div id="root"></div></body></html>', {
  url: 'https://canvas.test/en/notebook?workspaceId=workspace-one&chat=open#document-heading',
});
for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver',
  'CustomEvent', 'Event', 'KeyboardEvent', 'DOMException', 'HTMLButtonElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'SVGElement', 'NodeFilter', 'getComputedStyle',
] as const) {
  const value = key === 'window' ? dom.window : key === 'getComputedStyle'
    ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key];
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(dom.window.HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false });
Object.defineProperty(dom.window.HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: () => {} });
Object.defineProperty(dom.window.HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: () => {} });
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });

const request = {
  contractVersion: 1 as const,
  target: { kind: 'lineage' as const, workspaceId: 'workspace-one', lineageId: 'lineage-one' },
  selectedEntry: { kind: 'revision' as const, id: 'revision-one' },
  initialView: 'history' as const,
  source: 'editor' as const,
};

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
}

async function main() {
  const { FileVersionCenterHost } = await import('../app/components/file-version-center/FileVersionCenterHost');
  const {
    closeVersionCenter,
    openVersionCenter,
    syncVersionCenterFromLocation,
    useFileVersionCenterStore,
  } = await import('../app/store/file-version-center-store');
  const responses = new Map<string, () => void>();
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as typeof request;
    if (body.target.workspaceId === 'workspace-delayed') {
      await new Promise<void>((resolve) => responses.set('delayed', resolve));
    }
    if (body.target.workspaceId === 'workspace-denied') {
      return Response.json({ contractVersion: 1, success: false, error: {
        code: 'FVRC_ACCESS_DENIED', message: 'Access was removed.', retryable: false,
      } }, { status: 403 });
    }
    return Response.json({
      contractVersion: 1,
      document: { workspaceId: body.target.workspaceId, lineageId: 'lineage-one', documentId: 'document-one', path: 'Notes/current.md' },
      capabilities: { contractVersion: 1, history: true, compare: true, restore: true, agentReviewPolicy: true, preview: 'markdown' },
      policy: { contractVersion: 1, requestedMode: 'review_required', effectiveMode: 'review_required', revision: 0, locked: false, reason: 'default_review_required' },
      entries: [{ kind: 'current', id: 'current', observedAt: new Date(0).toISOString(), revisionId: null, sha256: 'a'.repeat(64), sizeBytes: 10 }],
      page: { hasMore: false, nextCursor: null },
    });
  };

  const origin = document.getElementById('origin') as HTMLButtonElement;
  origin.focus();
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <FileVersionCenterHost />
    </NextIntlClientProvider>,
  ));

  await act(async () => { openVersionCenter(request); });
  await settle();
  assert.ok(document.querySelector('[role="dialog"]'), 'one global host opens from the shared store');
  assert.match(document.body.textContent ?? '', /Notes\/current\.md/u);
  assert.equal(new URL(window.location.href).searchParams.get('chat'), 'open');
  assert.equal(new URL(window.location.href).hash, '#document-heading');
  assert.equal(new URL(window.location.href).searchParams.get('fvrcRef'), 'lineage-one');
  assert.deepEqual(JSON.parse(JSON.stringify(useFileVersionCenterStore.getState().request)), request,
    'open state remains serializable and contains no fetched document content');

  await act(async () => { closeVersionCenter(); });
  await settle();
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, origin, 'programmatic close restores the invoking focus');
  assert.equal(new URL(window.location.href).searchParams.get('chat'), 'open');
  assert.equal(new URL(window.location.href).searchParams.get('fvrc'), null);
  assert.equal(new URL(window.location.href).hash, '#document-heading');

  window.history.replaceState(window.history.state, '', '/en/notebook?foreign=yes&fvrc=1&fvrcTarget=lineage&fvrcWorkspace=workspace-one&fvrcRef=lineage-one&fvrcView=reviews#kept');
  await act(async () => {
    assert.equal(syncVersionCenterFromLocation(window.location.search)?.source, 'deep_link');
  });
  await settle();
  assert.ok(document.querySelector('[role="dialog"]'), 'reload intent rehydrates the same host');

  await act(async () => {
    openVersionCenter({ ...request, target: { ...request.target, workspaceId: 'workspace-delayed' } });
    openVersionCenter({ ...request, target: { ...request.target, workspaceId: 'workspace-one' } });
  });
  await settle();
  await act(async () => { responses.get('delayed')?.(); });
  await settle();
  assert.match(document.body.textContent ?? '', /Notes\/current\.md/u,
    'a late response from another workspace cannot replace the active document');

  await act(async () => {
    openVersionCenter({ ...request, target: { ...request.target, workspaceId: 'workspace-denied' } });
  });
  await settle();
  assert.ok(document.querySelector('[role="alert"]'));
  assert.match(document.body.textContent ?? '', /Access was removed/u);

  await act(async () => root.unmount());
  assert.equal(document.querySelector('[role="dialog"]'), null, 'the host unmount removes its portal');
  console.log('file-version-center-open-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
