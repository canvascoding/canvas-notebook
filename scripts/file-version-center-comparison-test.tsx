import { getNotebookQueryClient } from '../app/lib/queries/client';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import type { AgentReviewTarget } from '../app/lib/collaboration/agent-proposal-display';
import type {
  FileVersionCenterRequestV1,
  FileVersionTimelineResponseV1,
} from '../app/lib/file-version-center/contracts/v1';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://canvas.test/en/notebook',
});
for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'DOMException', 'HTMLButtonElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'SVGElement', 'NodeFilter', 'getComputedStyle', 'ResizeObserver',
] as const) {
  const value = key === 'window' ? dom.window : key === 'getComputedStyle'
    ? dom.window.getComputedStyle.bind(dom.window) : key === 'ResizeObserver'
      ? class { observe() {} unobserve() {} disconnect() {} }
      : dom.window[key];
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(callback, 0) });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => clearTimeout(id) });
Object.defineProperty(dom.window.HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false });
Object.defineProperty(dom.window.HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: () => {} });
Object.defineProperty(dom.window.HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: () => {} });
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });

const request: FileVersionCenterRequestV1 = {
  contractVersion: 1,
  target: { kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-one' },
  selectedEntry: { kind: 'revision', id: 'revision-seven' },
  initialView: 'history',
  source: 'editor',
};

const currentEntry = {
  kind: 'current' as const,
  id: 'current' as const,
  observedAt: '2026-09-14T09:00:00.000Z',
  revisionId: 'revision-current',
  sha256: 'a'.repeat(64),
  sizeBytes: 640,
};
const revisionEntry = {
  kind: 'revision' as const,
  id: 'revision-seven',
  revisionId: 'revision-seven',
  revisionNumber: 7,
  createdAt: '2026-09-13T08:00:00.000Z',
  source: 'manual' as const,
  actor: { type: 'user' as const, displayName: 'Frank' },
  content: { availability: 'available' as const, format: 'markdown' as const, sha256: 'b'.repeat(64), sizeBytes: 620 },
  restorable: true,
};
const metadataRevisionEntry = {
  ...revisionEntry,
  id: 'revision-metadata-only',
  revisionId: 'revision-metadata-only',
  revisionNumber: 1,
  content: { ...revisionEntry.content, availability: 'metadata_only' as const },
  restorable: false,
};
const timeline: FileVersionTimelineResponseV1 = {
  contractVersion: 1,
  document: { workspaceId: 'workspace-one', lineageId: 'lineage-one', documentId: 'document-one', path: 'Notes/roadmap.md' },
  capabilities: { contractVersion: 1, history: true, compare: true, restore: true, agentReviewPolicy: true, preview: 'markdown' },
  entries: [currentEntry, revisionEntry],
  page: { hasMore: false, nextCursor: null },
};

const largeTail = `COMPLETE-CANDIDATE-TAIL-${'x'.repeat(120_000)}`;
const unsafeCandidate = `# Result\n\n[External](https://tracking.test/link)\n\n![Pixel](https://tracking.test/pixel.png)\n\n<iframe src="https://tracking.test/frame"></iframe>\n\n${largeTail}`;

const firstHunk = {
  id: 'hunk-one', oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
  lines: [
    { kind: 'context' as const, oldLineNumber: 1, newLineNumber: 1, text: '# Roadmap' },
    { kind: 'deletion' as const, oldLineNumber: 2, newLineNumber: null, text: 'Old milestone' },
    { kind: 'addition' as const, oldLineNumber: null, newLineNumber: 2, text: 'New milestone' },
  ],
};
const secondHunk = {
  id: 'hunk-two', oldStart: 20, oldLines: 1, newStart: 20, newLines: 2,
  lines: [
    { kind: 'context' as const, oldLineNumber: 20, newLineNumber: 20, text: 'End' },
    { kind: 'addition' as const, oldLineNumber: null, newLineNumber: 21, text: 'Complete tail' },
  ],
};

function comparison(hunks: Array<typeof firstHunk | typeof secondHunk>, hasMore: boolean, stale = false) {
  return {
    actionFence: { proposalVersion: null as string | null },
    response: {
      contractVersion: 1,
      current: { fence: { revisionId: 'revision-current', sha256: 'a'.repeat(64) }, observedAt: currentEntry.observedAt },
      candidate: { selection: { kind: stale ? 'agent_operation' : 'revision', id: stale ? 'operation-stale' : 'revision-seven' }, stale, contentAvailable: !stale },
      summary: { additions: 2, deletions: 1, unchanged: 5 },
      hunks,
      page: { hasMore, nextCursor: hasMore ? 'v1.1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : null },
      truncated: false,
    },
    preview: {
      format: 'markdown',
      current: '# Roadmap\n\nOld milestone\n\nCURRENT-SOURCE-TAIL',
      candidate: stale ? null : unsafeCandidate,
      externalRequestsAllowed: false,
      blockedExternalReferences: stale ? 0 : 3,
      blocks: { current: 2, candidate: stale ? 0 : 5, unchanged: 1, changed: stale ? 2 : 5 },
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

function tab(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((candidate) => candidate.textContent === label);
  assert.ok(result, `${label} tab exists`);
  return result;
}

async function selectTab(label: string): Promise<void> {
  await act(async () => {
    const trigger = tab(label);
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    trigger.click();
  });
  await settle();
}

async function main() {
  const { FileVersionComparison } = await import('../app/components/file-version-center/FileVersionComparison');
  const { CollaborationAgentProposalPreview } = await import('../app/components/editor/CollaborationAgentProposalPreview');
  const { mergeFileVersionComparePayload } = await import('../app/lib/file-version-center/compare-client');
  let hunkAttempts = 0;
  let staleCurrentAttempts = 0;
  const requestedCursors: Array<string | undefined> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { cursor?: string; candidate: { kind: string; id?: string } };
    requestedCursors.push(body.cursor);
    if (body.candidate.id === 'operation-stale-current') {
      staleCurrentAttempts += 1;
      if (staleCurrentAttempts === 1) return Response.json({
        contractVersion: 1,
        success: false,
        error: {
          code: 'FVRC_STALE_CURRENT',
          message: 'The current document changed. Reload its timeline before comparing.',
          retryable: false,
        },
      }, { status: 409 });
      const ready = comparison([firstHunk], false);
      ready.actionFence.proposalVersion = `v1.${'d'.repeat(64)}`;
      ready.response.candidate.selection = { kind: 'agent_operation', id: 'operation-stale-current' };
      return Response.json(ready);
    }
    if (body.candidate.kind === 'agent_operation') return Response.json(comparison([], false, true));
    if (body.cursor) {
      hunkAttempts += 1;
      if (hunkAttempts === 1) {
        return Response.json({ contractVersion: 1, success: false, error: {
          code: 'FVRC_PERSISTENCE_UNAVAILABLE', message: 'More diff data is temporarily unavailable.', retryable: true,
        } }, { status: 503 });
      }
      return Response.json(comparison([secondHunk], false));
    }
    return Response.json(comparison([firstHunk], true));
  };

  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <FileVersionComparison
        request={request}
        timeline={timeline}
        selection={{ key: 'revision:revision-seven', entry: revisionEntry, state: 'selected' }}
        onTimelineInvalidate={() => {}}
        onContinue={() => {}}
      />
    </NextIntlClientProvider>,
  ));
  await settle();

  assert.equal(document.querySelectorAll('[role="tab"]').length, 4, 'all comparison views are keyboard-reachable tabs');
  assert.match(document.body.textContent ?? '', /Old milestone[\s\S]*New milestone/u);
  const panes = [...document.querySelectorAll<HTMLElement>('[data-synchronized-scroll="true"] [role="region"]')];
  assert.equal(panes.length, 2);
  Object.defineProperties(panes[0], { scrollHeight: { value: 300 }, clientHeight: { value: 100 } });
  Object.defineProperties(panes[1], { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
  panes[0].scrollTop = 50;
  await act(async () => { panes[0].dispatchEvent(new Event('scroll', { bubbles: true })); });
  assert.equal(panes[1].scrollTop, 100, 'paired diff panes synchronize their relative scroll positions');

  const loadButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => /Load more changes/u.test(candidate.textContent ?? ''))!;
  await act(async () => { loadButton.click(); });
  await settle();
  assert.match(document.body.textContent ?? '', /temporarily unavailable/u);
  const retryButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => /Retry loading changes/u.test(candidate.textContent ?? ''))!;
  await act(async () => { retryButton.click(); });
  await settle();
  assert.match(document.body.textContent ?? '', /Complete tail/u, 'later hunks append without replacing earlier ones');
  assert.deepEqual(requestedCursors, [undefined, 'v1.1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'v1.1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);

  await selectTab('Preview');
  const preview = document.querySelector('[data-external-requests="blocked"]')!;
  assert.ok(preview.textContent?.includes('COMPLETE-CANDIDATE-TAIL-'));
  assert.ok(preview.textContent?.endsWith('x'.repeat(100)), 'the full admitted candidate reaches the preview tail');
  assert.equal(preview.querySelectorAll('a, img, iframe, script, [href], [src]').length, 0,
    'preview markdown cannot create active links, request-bearing images, frames or scripts');
  await act(async () => { tab('Preview').focus(); });
  assert.equal(document.activeElement, tab('Preview'), 'a comparison tab accepts explicit keyboard focus');

  await act(async () => {
    tab('Preview').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await settle();
  assert.equal(document.activeElement, tab('Source'), 'arrow-key navigation moves focus to the next comparison view');
  assert.match(document.body.textContent ?? '', /CURRENT-SOURCE-TAIL/u);
  assert.match(document.body.textContent ?? '', /COMPLETE-CANDIDATE-TAIL-/u, 'source view exposes both complete sides');
  await selectTab('Details');
  assert.match(document.body.textContent ?? '', /revision-seven/u);
  assert.match(document.body.textContent ?? '', new RegExp('a{64}', 'u'));

  const refreshedCurrent = {
    ...currentEntry,
    revisionId: 'revision-current-refreshed',
    sha256: 'c'.repeat(64),
  };
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <FileVersionComparison
        request={request}
        timeline={{ ...timeline, entries: [refreshedCurrent, revisionEntry] }}
        selection={{ key: 'revision:revision-seven', entry: revisionEntry, state: 'selected' }}
        onTimelineInvalidate={() => {}}
        onContinue={() => {}}
      />
    </NextIntlClientProvider>,
  ));
  await settle();
  assert.equal(tab('Details').getAttribute('aria-selected'), 'true',
    'an authoritative current refresh keeps the selected comparison mounted so action feedback remains visible');

  const requestsBeforeMetadata = requestedCursors.length;
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <FileVersionComparison
        request={{ ...request, selectedEntry: { kind: 'revision', id: metadataRevisionEntry.id } }}
        timeline={{ ...timeline, entries: [currentEntry, metadataRevisionEntry] }}
        selection={{ key: `revision:${metadataRevisionEntry.id}`, entry: metadataRevisionEntry, state: 'selected' }}
        onTimelineInvalidate={() => {}}
        onContinue={() => {}}
      />
    </NextIntlClientProvider>,
  ));
  await settle();
  assert.ok(document.querySelector('[data-testid="file-version-metadata-only"]'));
  assert.match(document.body.textContent ?? '', /content was not archived[\s\S]*cannot be compared or restored/iu,
    'legacy metadata-only revisions explain exactly why comparison and restore are unavailable');
  assert.equal(requestedCursors.length, requestsBeforeMetadata,
    'metadata-only revisions never make a comparison request that cannot succeed');
  assert.equal(document.querySelectorAll('[role="tab"]').length, 0,
    'metadata-only revisions do not expose empty comparison views');
  assert.equal([...document.querySelectorAll('button')].some((candidate) => /Restore version/u.test(candidate.textContent ?? '')), false,
    'metadata-only revisions never expose a restore action');
  assert.equal([...document.querySelectorAll('button')].some((candidate) => /Refresh timeline|Retry/iu.test(candidate.textContent ?? '')), false,
    'metadata-only revisions do not enter the stale-refresh error path');
  assert.ok([...document.querySelectorAll('button')].some((candidate) => /Continue editing/u.test(candidate.textContent ?? '')),
    'the safe route back to the document remains available');

  assert.throws(() => mergeFileVersionComparePayload(
    comparison([firstHunk], true) as never,
    { ...comparison([secondHunk], false), response: {
      ...comparison([secondHunk], false).response,
      current: { ...comparison([secondHunk], false).response.current,
        fence: { revisionId: 'revision-current', sha256: 'c'.repeat(64) } },
    } } as never,
  ), /another document state/iu, 'hunk pages cannot cross an authoritative current fence');

  const staleCurrentEntry = {
    kind: 'agent_operation' as const,
    id: 'operation-stale-current', operationId: 'operation-stale-current', createdAt: '2026-09-14T09:30:00.000Z',
    actor: { type: 'agent' as const }, status: 'needs_review' as const, actionsAllowed: true,
  };
  let staleCurrentRefreshes = 0;
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <FileVersionComparison
        request={{ ...request, selectedEntry: { kind: 'agent_operation', id: staleCurrentEntry.id }, initialView: 'reviews' }}
        timeline={{ ...timeline, entries: [staleCurrentEntry, currentEntry, revisionEntry] }}
        selection={{ key: `agent_operation:${staleCurrentEntry.id}`, entry: staleCurrentEntry, state: 'selected' }}
        onTimelineInvalidate={() => { staleCurrentRefreshes += 1; }}
        onContinue={() => {}}
      />
    </NextIntlClientProvider>,
  ));
  await settle();
  assert.match(document.body.textContent ?? '', /current document changed/iu);
  const staleCurrentRefresh = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => /Refresh timeline/u.test(candidate.textContent ?? ''))!;
  await act(async () => { staleCurrentRefresh.click(); });
  await settle();
  assert.equal(staleCurrentRefreshes, 1,
    'a stale-current comparison reloads the authoritative timeline instead of repeating the same fenced request');
  assert.equal(staleCurrentAttempts, 2,
    'the refreshed current fence starts one new comparison after the authoritative timeline reload');

  const staleRequest: FileVersionCenterRequestV1 = {
    ...request,
    selectedEntry: { kind: 'agent_operation', id: 'operation-stale' },
    initialView: 'reviews',
  };
  const staleEntry = {
    kind: 'agent_operation' as const,
    id: 'operation-stale', operationId: 'operation-stale', createdAt: '2026-09-14T10:00:00.000Z',
    actor: { type: 'agent' as const }, status: 'needs_review' as const, actionsAllowed: true,
  };
  let refreshCalls = 0;
  let releaseRefresh!: () => void;
  const pendingRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <FileVersionComparison
        request={staleRequest}
        timeline={{ ...timeline, entries: [staleEntry, currentEntry, revisionEntry] }}
        selection={{ key: 'agent_operation:operation-stale', entry: staleEntry, state: 'selected' }}
        onTimelineInvalidate={() => {
          refreshCalls += 1;
          return pendingRefresh;
        }}
        onContinue={() => {}}
      />
    </NextIntlClientProvider>,
  ));
  await settle();
  assert.match(document.body.textContent ?? '', /comparison is no longer current/iu,
    'stale or conflicted candidates receive a visible non-color-only warning');
  assert.equal([...document.querySelectorAll('button')].some((candidate) => /Accept change/u.test(candidate.textContent ?? '')), false,
    'stale candidates never expose the accepting mutation');
  assert.ok([...document.querySelectorAll('button')].some((candidate) => /Reject proposal/u.test(candidate.textContent ?? '')),
    'the safe discard decision remains explicit');
  const refreshTimeline = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => /Refresh timeline/u.test(candidate.textContent ?? ''))!;
  await act(async () => {
    refreshTimeline.click();
    refreshTimeline.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.equal(refreshCalls, 1, 'the timeline refresh remains single-flight under a same-frame double click');
  assert.equal(refreshTimeline.disabled, true);
  assert.match(refreshTimeline.textContent ?? '', /Refreshing timeline/u);
  await act(async () => {
    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  assert.match(document.body.textContent ?? '', /timeline is current[\s\S]*cannot be compared safely/iu,
    'a still-stale proposal gets a clear post-refresh decision state');
  assert.ok([...document.querySelectorAll('button')].some((candidate) => /Refresh timeline/u.test(candidate.textContent ?? '')),
    'the authoritative refresh remains available for another explicit check');

  await act(async () => root.unmount());
  const compatibilityRoot = createRoot(document.getElementById('root')!);
  const markdownTarget: AgentReviewTarget = {
    targetId: 'target-one', groupId: 'group-one', previewFormat: 'markdown',
    currentText: '# Before', proposedReplacement: unsafeCandidate,
  };
  const ready: boolean[] = [];
  const translate = ((key: string) => key) as Parameters<typeof CollaborationAgentProposalPreview>[0]['t'];
  await act(async () => compatibilityRoot.render(
    <CollaborationAgentProposalPreview
      target={markdownTarget}
      index={0}
      t={translate}
      onReady={(_target, value) => ready.push(value)}
    />,
  ));
  assert.equal(ready.at(-1), true);
  assert.equal(document.querySelectorAll('a, img, iframe, script, [href], [src]').length, 0,
    'the existing collaboration markdown preview remains inert after renderer extraction');
  assert.match(document.body.textContent ?? '', /agentPreviewExactText/u,
    'the existing exact-source review remains present');
  await act(async () => compatibilityRoot.unmount());
  console.log('file-version-center-comparison-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => getNotebookQueryClient().clear());
