import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import type {
  FileVersionTimelineEntryV1,
  FileVersionTimelineResponseV1,
} from '../app/lib/file-version-center/contracts/v1';

const dom = new JSDOM('<!doctype html><html><body><button id="origin">Open</button><div id="root"></div></body></html>', {
  url: 'https://canvas.test/en/notebook?workspaceId=workspace-one&panel=files#active-file',
});
for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver',
  'CustomEvent', 'Event', 'KeyboardEvent', 'DOMException', 'HTMLButtonElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'SVGElement', 'NodeFilter', 'getComputedStyle', 'ResizeObserver',
] as const) {
  const value = key === 'window' ? dom.window : key === 'getComputedStyle'
    ? dom.window.getComputedStyle.bind(dom.window) : key === 'ResizeObserver'
      ? class { observe() {} unobserve() {} disconnect() {} }
      : dom.window[key];
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
  selectedEntry: { kind: 'revision' as const, id: 'revision-old' },
  initialView: 'history' as const,
  source: 'editor' as const,
};

const capabilities = {
  contractVersion: 1 as const,
  history: true,
  compare: true,
  restore: true,
  agentReviewPolicy: true,
  preview: 'markdown' as const,
};

const agentEntry = {
  kind: 'agent_operation' as const,
  id: 'operation-one',
  operationId: 'operation-one',
  createdAt: '2026-09-14T08:00:00.000Z',
  actor: { type: 'agent' as const, displayName: 'Canvas Agent' },
  status: 'needs_review' as const,
  proposalVersion: 'proposal-one',
  additions: 4,
  deletions: 1,
  actionsAllowed: true,
};

const conflictEntry = {
  ...agentEntry,
  id: 'operation-conflict',
  operationId: 'operation-conflict',
  status: 'semantic_conflict' as const,
  additions: 2,
  deletions: 3,
};

const currentEntry = {
  kind: 'current' as const,
  id: 'current' as const,
  observedAt: '2026-09-14T09:00:00.000Z',
  revisionId: 'revision-current',
  sha256: 'a'.repeat(64),
  sizeBytes: 320,
};

const revisionEntry = {
  kind: 'revision' as const,
  id: 'revision-old',
  revisionId: 'revision-old',
  revisionNumber: 7,
  createdAt: '2026-09-13T08:00:00.000Z',
  source: 'manual' as const,
  actor: { type: 'user' as const, displayName: 'Frank' },
  content: {
    availability: 'available' as const,
    format: 'markdown' as const,
    sha256: 'b'.repeat(64),
    sizeBytes: 290,
  },
  restorable: true,
};

function response(
  entries: FileVersionTimelineEntryV1[],
  page: { hasMore: boolean; nextCursor: string | null },
  restore = true,
): FileVersionTimelineResponseV1 {
  return {
    contractVersion: 1 as const,
    document: {
      workspaceId: 'workspace-one',
      lineageId: 'lineage-one',
      documentId: 'document-one',
      path: 'Notes/roadmap.md',
    },
    capabilities: { ...capabilities, restore, ...(restore ? {} : { reason: 'read_only' as const }) },
    entries,
    page,
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

function button(label: RegExp): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => label.test(candidate.textContent ?? ''));
  assert.ok(result, `button ${label} exists`);
  return result;
}

async function main() {
  const { FileVersionCenterHost } = await import('../app/components/file-version-center/FileVersionCenterHost');
  const {
    mergeFileVersionTimelinePage,
    reconcileFileVersionTimelineSelection,
  } = await import('../app/lib/file-version-center/timeline-state');
  const { openVersionCenter } = await import('../app/store/file-version-center-store');

  let timelineAttempts = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/timeline')) {
      timelineAttempts += 1;
      if (timelineAttempts === 1) {
        return Response.json({
          contractVersion: 1,
          success: false,
          error: { code: 'FVRC_PERSISTENCE_UNAVAILABLE', message: 'History is temporarily unavailable.', retryable: true },
        }, { status: 503 });
      }
      return Response.json(response([currentEntry, revisionEntry], { hasMore: false, nextCursor: null }));
    }
    return Response.json(response([agentEntry, conflictEntry], { hasMore: true, nextCursor: 'cursor-one' }));
  };

  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <FileVersionCenterHost />
    </NextIntlClientProvider>,
  ));
  await act(async () => { openVersionCenter(request); });
  await settle();

  const layout = document.querySelector('[data-testid="file-version-center-responsive-layout"]');
  assert.ok(layout?.className.includes('grid-cols-1') && layout.className.includes('md:grid-cols'),
    'the center exposes mobile stacking and a tablet/desktop master-detail grid');
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const labelledBy = dialog?.getAttribute('aria-labelledby');
  const describedBy = dialog?.getAttribute('aria-describedby');
  assert.ok(labelledBy && document.getElementById(labelledBy), 'the dialog has a screen-reader title');
  assert.ok(describedBy && document.getElementById(describedBy), 'the dialog has a document description');
  assert.ok(document.querySelector('nav[aria-label]'), 'the timeline landmark has an accessible name');
  assert.ok(document.querySelector('nav[aria-label]')?.className.includes('min-h-[18rem]'),
    'the stacked mobile timeline keeps enough intrinsic height for its scroll viewport');
  assert.equal(document.querySelectorAll('section[aria-labelledby]').length, 3,
    'review, current and history sections expose named landmarks');
  const animated = [...document.querySelectorAll('[class*="animate-spin"]')];
  assert.ok(animated.length > 0 && animated.every((element) => (
    element.getAttribute('class')?.includes('motion-reduce:animate-none')
  )),
    'every active progress animation honors reduced-motion preferences');
  assert.match(document.body.textContent ?? '', /Agent reviews[\s\S]*Agent proposal[\s\S]*Current[\s\S]*Version history/u,
    'review, current and history groups remain in the required order');
  assert.match(document.body.textContent ?? '', /selected version is in an older page/iu,
    'an unloaded deep-link selection remains explicit and stable');
  const agentButton = document.querySelector<HTMLButtonElement>('[data-entry-kind="agent_operation"]');
  assert.equal(agentButton?.getAttribute('aria-pressed'), 'false');
  await act(async () => { agentButton?.focus(); });
  assert.equal(document.activeElement, agentButton, 'timeline choices are reachable by keyboard focus');
  assert.ok(agentButton?.className.includes('violet'), 'agent rows use the violet design-system accent');
  assert.ok(agentButton?.className.includes('focus-visible:ring-inset')
    && !agentButton?.className.includes('focus-visible:ring-offset'),
  'keyboard focus stays visible without growing beyond the timeline card gutter');
  assert.ok(agentButton?.querySelector('[class*="dark:text-violet"]'), 'agent accents define a dark-theme token');
  assert.match(agentButton?.textContent ?? '', /Needs review/iu, 'agent status is visible as text, not color alone');
  const conflictButton = document.querySelector<HTMLButtonElement>('[data-entry-status="semantic_conflict"]');
  assert.ok(conflictButton?.className.includes('amber') && /Conflict/iu.test(conflictButton.textContent ?? ''),
    'conflicts combine an amber accent with an icon and visible status');

  await act(async () => { button(/Load older versions/iu).click(); });
  await settle();
  assert.match(document.body.textContent ?? '', /History is temporarily unavailable/iu,
    'pagination failures are announced inline without discarding the timeline');
  assert.match(document.body.textContent ?? '', /selected version is in an older page/iu,
    'the pending selection survives a failed page load');

  await act(async () => { button(/Retry loading older versions/iu).click(); });
  await settle();
  const body = document.body.textContent ?? '';
  assert.ok(body.indexOf('Agent proposal') < body.indexOf('Current version')
    && body.indexOf('Current version') < body.indexOf('Version 7'),
  'pagination merges into review → current → history order');
  const selectedRevision = document.querySelector<HTMLButtonElement>('[data-entry-kind="revision"]');
  assert.equal(selectedRevision?.getAttribute('aria-pressed'), 'true',
    'the requested revision becomes selected when its page arrives');
  assert.ok(selectedRevision?.className.includes('ring-inset')
    && !selectedRevision?.className.includes('ring-offset'),
  'selected cards keep their highlight inside the shared card edge');
  const timelineContent = document.querySelector('nav[aria-label] [class*="space-y-6"]');
  assert.ok(timelineContent?.className.includes('w-full')
    && timelineContent.className.includes('p-4') && !timelineContent.className.includes('p-3'),
    'all viewport widths keep a 16px horizontal timeline gutter');
  const timelineScrollArea = document.querySelector('nav[aria-label] [data-slot="scroll-area"]');
  assert.ok(timelineScrollArea?.className.includes('scroll-area-viewport]>div]:!block')
    && timelineScrollArea.className.includes('scroll-area-viewport]>div]:!w-full'),
  'the Radix viewport wrapper cannot expand cards into the right-hand gutter');
  assert.equal(new URL(window.location.href).searchParams.get('fvrcSelectedId'), 'revision-old');

  await act(async () => { document.querySelector<HTMLButtonElement>('[data-entry-kind="current"]')?.click(); });
  assert.equal(document.querySelector('[data-entry-kind="current"]')?.getAttribute('aria-pressed'), 'true');
  assert.equal(new URL(window.location.href).searchParams.get('fvrcSelectedId'), null,
    'selecting Current keeps a reload-safe URL without inventing a non-contract selection');
  assert.equal(new URL(window.location.href).searchParams.get('panel'), 'files');
  assert.equal(new URL(window.location.href).hash, '#active-file');

  const completed = response([currentEntry], { hasMore: false, nextCursor: null });
  const invalidated = reconcileFileVersionTimelineSelection({
    request,
    timeline: completed,
    selectedKey: 'revision:removed',
  });
  assert.equal(invalidated.state, 'invalidated');
  assert.equal(invalidated.key, 'current', 'a missing selection falls back only after pagination is complete');
  assert.throws(() => mergeFileVersionTimelinePage(
    response([agentEntry], { hasMore: true, nextCursor: 'cursor-one' }),
    { ...completed, document: { ...completed.document, lineageId: 'another-lineage' } },
  ), /another document/iu, 'cross-document pages cannot be merged');

  await act(async () => {
    openVersionCenter({ ...request, selectedEntry: undefined, target: { ...request.target, lineageId: 'read-only' } });
  });
  globalThis.fetch = async () => Response.json(response([currentEntry], { hasMore: false, nextCursor: null }, false));
  await settle();
  assert.match(document.body.textContent ?? '', /Review only[\s\S]*restoring is not available/iu,
    'read-only capability is announced with text and an icon');
  assert.match(document.body.textContent ?? '', /No agent changes need review/iu);
  assert.match(document.body.textContent ?? '', /No saved versions yet/iu,
    'empty review and history states remain explicit around Current');

  await act(async () => root.unmount());
  console.log('file-version-center-timeline-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
