import { getNotebookQueryClient } from '../app/lib/queries/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { fileVersionTestRouter } from './file-version-test-router';
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
import type { ProposalReviewSummaryResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-summary-v1';
import { observeOpenedDocumentAuth, openedDocumentAuthScope,
  invalidateOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';

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

function legacySummary(body: string | undefined): Response {
  const request = JSON.parse(body ?? '{}') as { operationIds?: string[] };
  return Response.json({
    contractVersion: 1,
    target: { workspaceId: 'workspace-one', lineageId: 'lineage-one', documentId: 'document-one' },
    current: null,
    graphRevision: null,
    items: (request.operationIds ?? []).map((operationId) => ({ mode: 'legacy', operationId })),
    checkedAt: Date.now(),
  });
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
    matchingCurrentRevision,
    reconcileFileVersionTimelineSelection,
  } = await import('../app/lib/file-version-center/timeline-state');
  const { openVersionCenter } = await import('../app/store/file-version-center-store');

  let timelineAttempts = 0;
  let resolveAttempts = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/proposals/summary')) return legacySummary(String(init?.body));
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
    resolveAttempts += 1;
    return Response.json(response([agentEntry, conflictEntry], { hasMore: true, nextCursor: 'cursor-one' }));
  };

  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <AppRouterContext.Provider value={fileVersionTestRouter}><FileVersionCenterHost /></AppRouterContext.Provider>
    </NextIntlClientProvider>,
  ));
  await act(async () => { openVersionCenter(request); });
  await settle();
  await act(async () => {
    observeOpenedDocumentAuth({ data: { user: { id: 'user-one' }, session: { id: 'session-one' } } });
    invalidateOpenedDocumentAuth();
  });
  assert.ok(openedDocumentAuthScope(), 'component fixture has an authenticated review scope');
  await settle();
  const beforeExternalRefresh = resolveAttempts;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  await settle();
  assert.equal(resolveAttempts, beforeExternalRefresh + 1,
    'focus and visibility events coalesce into one authoritative timeline refresh');
  assert.equal(new URL(window.location.href).searchParams.get('fvrcSelectedId'), 'revision-old',
    'background reconciliation preserves the pending review selection');

  const layout = document.querySelector('[data-testid="file-version-center-responsive-layout"]');
  assert.ok(layout?.className.includes('grid-cols-1') && layout.className.includes('md:grid-cols'),
    'the center exposes a mobile single-pane shell and a tablet/desktop master-detail grid');
  assert.equal(layout?.getAttribute('data-mobile-pane'), 'comparison',
    'an explicitly selected deep-link entry opens directly in the mobile comparison pane');
  const timelinePane = document.querySelector('[data-testid="file-version-center-mobile-timeline-pane"]');
  const comparisonPane = document.querySelector('[data-testid="file-version-center-mobile-comparison-pane"]');
  assert.ok(timelinePane?.className.includes('hidden') && timelinePane.className.includes('md:flex'),
    'the timeline is hidden only on mobile while an explicit comparison is open');
  assert.ok(comparisonPane?.className.includes('flex') && comparisonPane.className.includes('md:flex'),
    'the selected comparison owns the mobile viewport and remains visible on desktop');
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const labelledBy = dialog?.getAttribute('aria-labelledby');
  const describedBy = dialog?.getAttribute('aria-describedby');
  assert.ok(labelledBy && document.getElementById(labelledBy), 'the dialog has a screen-reader title');
  assert.ok(describedBy && document.getElementById(describedBy), 'the dialog has a document description');
  assert.ok(document.querySelector('nav[aria-label]'), 'the timeline landmark has an accessible name');
  assert.ok(document.querySelector('nav[aria-label]')?.className.includes('min-h-0'),
    'the mobile timeline fills its pane instead of reserving stacked comparison height');
  assert.equal(document.querySelector('nav[aria-label]')?.className.includes('border-b'), false,
    'the mobile timeline shell has no fixed horizontal divider');
  assert.ok(document.querySelector('nav[aria-label]')?.className.includes('md:border-r'),
    'the desktop master-detail divider remains intact');
  assert.equal(document.querySelectorAll('section[aria-labelledby]').length, 3,
    'review, current and history sections expose named landmarks');
  const historySection = document.querySelector('[data-testid="file-version-history-section"]');
  assert.ok(historySection?.className.includes('border-t')
    && historySection.closest('[data-slot="scroll-area-viewport"]'),
    'the current/history divider lives inside the scrolling timeline content');
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
  assert.match(agentButton?.textContent ?? '', /Needs review/iu, 'explicitly legacy agent status is visible as text, not color alone');
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

  const staleSelectionRequests: Array<{
    selectedEntry?: { kind: string; id: string };
    initialView?: string;
  }> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/proposals/summary')) return legacySummary(String(init?.body));
    if (!String(input).endsWith('/resolve')) {
      return Response.json(response([conflictEntry, currentEntry], { hasMore: false, nextCursor: null }));
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      selectedEntry?: { kind: string; id: string };
      initialView?: string;
    };
    staleSelectionRequests.push(body);
    if (staleSelectionRequests.length === 1) {
      return Response.json({
        contractVersion: 1,
        success: false,
        error: { code: 'FVRC_STALE_SELECTION', message: 'The selected review is already closed.', retryable: false },
      }, { status: 409 });
    }
    return Response.json(response([conflictEntry, currentEntry], { hasMore: false, nextCursor: null }));
  };
  await act(async () => {
    openVersionCenter({
      ...request,
      target: { ...request.target },
      selectedEntry: { kind: 'agent_operation', id: 'already-closed' },
      initialView: 'reviews',
    });
  });
  await settle();
  await settle();
  assert.equal(staleSelectionRequests.length, 1,
    'an unavailable exact link never retries by silently dropping its selection');
  assert.match(document.body.textContent ?? '', /The selected review is already closed/iu);
  assert.equal(document.querySelector('[data-entry-status="semantic_conflict"][aria-pressed="true"]'), null,
    'another proposal cannot take over an unavailable historical link');
  assert.equal(new URL(window.location.href).searchParams.get('fvrcSelectedId'), 'already-closed',
    'the original exact selection remains reload-safe');

  const completed = response([currentEntry], { hasMore: false, nextCursor: null });
  const invalidated = reconcileFileVersionTimelineSelection({
    request,
    timeline: completed,
    selectedKey: 'revision:removed',
  });
  assert.equal(invalidated.state, 'invalidated');
  assert.equal(invalidated.key, 'revision:removed', 'an unavailable selection keeps its exact identity');
  assert.equal(invalidated.entry, null, 'an unavailable version is never replaced with Current');
  const unselectedReviews = { ...request, selectedEntry: undefined, initialView: 'reviews' as const };
  assert.equal(reconcileFileVersionTimelineSelection({ request: unselectedReviews,
    timeline: response([agentEntry, conflictEntry, currentEntry], { hasMore: false, nextCursor: null }),
  }).key, 'current', 'multiple proposals wait for an explicit selection');
  assert.equal(reconcileFileVersionTimelineSelection({ request: unselectedReviews,
    timeline: response([agentEntry, currentEntry], { hasMore: true, nextCursor: 'more' }),
  }).key, 'current', 'a partial page cannot prove that one proposal is the only choice');
  assert.equal(reconcileFileVersionTimelineSelection({ request: unselectedReviews,
    timeline: response([agentEntry, currentEntry], { hasMore: false, nextCursor: null }),
  }).key, `agent_operation:${agentEntry.id}`, 'the sole complete review is still directly reachable');
  assert.throws(() => mergeFileVersionTimelinePage(
    response([agentEntry], { hasMore: true, nextCursor: 'cursor-one' }),
    { ...completed, document: { ...completed.document, lineageId: 'another-lineage' } },
  ), /another document/iu, 'cross-document pages cannot be merged');

  globalThis.fetch = async () => Response.json(response([currentEntry], { hasMore: false, nextCursor: null }, false));
  await act(async () => {
    openVersionCenter({ ...request, selectedEntry: undefined, target: { ...request.target, lineageId: 'read-only' } });
  });
  await settle();
  assert.match(document.body.textContent ?? '', /Review only[\s\S]*restoring is not available/iu,
    'read-only capability is announced with text and an icon');
  assert.match(document.body.textContent ?? '', /No agent changes need review/iu);
  assert.match(document.body.textContent ?? '', /No saved versions yet/iu,
    'empty review and history states remain explicit around Current');

  const disabledTimeline: FileVersionTimelineResponseV1 = {
    ...response([agentEntry, currentEntry, revisionEntry], { hasMore: false, nextCursor: null }),
    capabilities: {
      contractVersion: 1,
      history: false,
      compare: false,
      restore: false,
      agentReviewPolicy: false,
      preview: 'markdown',
      reason: 'rollout_disabled',
    },
  };
  globalThis.fetch = async () => Response.json(disabledTimeline);
  await act(async () => {
    openVersionCenter({ ...request, selectedEntry: undefined, target: { ...request.target, lineageId: 'disabled' } });
  });
  await settle();
  assert.ok(document.querySelector('[data-testid="file-version-center-unavailable"]'));
  assert.match(document.body.textContent ?? '', /Version history unavailable[\s\S]*explicitly disabled/iu,
    'alternate entry points surface an explicit disabled state');
  assert.equal(document.querySelector('nav[aria-label]'), null,
    'a disabled rollout cannot reveal timeline entries through an alternate entry point');
  assert.equal(document.querySelector('[data-testid="file-version-center-responsive-layout"]'), null,
    'a disabled rollout cannot mount the master-detail review UI');

  let raceSummaryReads = 0;
  let raceTimelineReads = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/proposals/summary')) {
      raceSummaryReads += 1;
      return raceSummaryReads === 1
        ? Response.json({ error: { code: 'PROPOSAL_CURRENT_CHANGED' } }, { status: 409 })
        : legacySummary(String(init?.body));
    }
    if (url.endsWith('/resolve')) raceTimelineReads += 1;
    return Response.json(response([agentEntry, conflictEntry, currentEntry], { hasMore: false, nextCursor: null }));
  };
  await act(async () => { openVersionCenter({ ...request, target: { ...request.target },
    selectedEntry: undefined, initialView: 'reviews' }); });
  await settle();
  await settle();
  await settle();
  assert.equal(raceTimelineReads, 2, 'typed current-change summary race triggers exactly one fresh timeline read');
  assert.equal(raceSummaryReads, 2, 'the fresh timeline automatically supplies one new sibling-card summary');
  assert.match(document.querySelector<HTMLButtonElement>('[data-operation-id="operation-one"]')?.textContent ?? '', /Needs review/iu,
    'a sibling card recovers its verified status without a click or tab-focus event');

  raceSummaryReads = 0;
  raceTimelineReads = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/proposals/summary')) {
      raceSummaryReads += 1;
      return Response.json({ error: { code: 'PROPOSAL_GRAPH_CHANGED' } }, { status: 409 });
    }
    if (url.endsWith('/resolve')) raceTimelineReads += 1;
    return Response.json(response([agentEntry, conflictEntry, currentEntry], { hasMore: false, nextCursor: null }));
  };
  await act(async () => { openVersionCenter({ ...request,
    target: { kind: 'document', workspaceId: 'workspace-one', documentId: 'document-one' },
    selectedEntry: undefined, initialView: 'reviews' }); });
  await settle();
  await settle();
  await settle();
  assert.equal(raceTimelineReads, 2, 'a repeated graph-change race has one bounded timeline retry');
  assert.equal(raceSummaryReads, 2, 'a repeated graph-change race does not loop summary reads');
  assert.match(document.querySelector<HTMLButtonElement>('[data-operation-id="operation-one"]')?.textContent ?? '', /Review status unavailable/iu,
    'after the bounded retry, sibling cards fail closed with a manual retry affordance');
  raceSummaryReads = 0;
  raceTimelineReads = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/proposals/summary')) {
      raceSummaryReads += 1;
      return Response.json({ error: { code: 'FVRC_TRANSPORT_ERROR' } }, { status: 429 });
    }
    if (String(input).endsWith('/resolve')) raceTimelineReads += 1;
    return Response.json(response([agentEntry, conflictEntry, currentEntry], { hasMore: false, nextCursor: null }));
  };
  const manualSummaryRetry = document.querySelector<HTMLButtonElement>('nav[aria-label] [role="alert"] button');
  assert.ok(manualSummaryRetry);
  await act(async () => { manualSummaryRetry.click(); });
  await settle();
  assert.equal(raceSummaryReads, 1, 'a rate-limited manual retry never starts automatic summary requests');
  assert.equal(raceTimelineReads, 0, 'a 429 response never triggers an automatic timeline refresh');
  globalThis.fetch = async (input) => String(input).endsWith('/proposals/summary')
    ? Response.json({ error: { code: 'PROPOSAL_ACCESS_DENIED' } }, { status: 403 })
    : Response.json(response([agentEntry, conflictEntry, currentEntry], { hasMore: false, nextCursor: null }));
  const deniedSummaryRetry = document.querySelector<HTMLButtonElement>('nav[aria-label] [role="alert"] button');
  assert.ok(deniedSummaryRetry);
  await act(async () => { deniedSummaryRetry.click(); });
  await settle();
  assert.equal(document.querySelector('[data-testid="file-version-center-responsive-layout"]'), null,
    'summary access revocation purges the cached timeline and selected comparison');
  assert.equal(document.querySelector('[data-operation-id="operation-one"]'), null,
    'a denied summary cannot leave private sibling cards visible');
  assert.doesNotMatch(document.body.textContent ?? '', /Notes\/roadmap\.md/u,
    'the revoked document path is not retained from the old resolution');

  await act(async () => root.unmount());
  const { FileVersionTimeline } = await import('../app/components/file-version-center/FileVersionTimeline');
  const secondReview = { ...agentEntry, id: 'operation-two', operationId: 'operation-two' };
  const selectedReviewTimeline = response([agentEntry, secondReview, currentEntry], { hasMore: false, nextCursor: null });
  const selectedReview = reconcileFileVersionTimelineSelection({
    request: { ...request, selectedEntry: { kind: 'agent_operation', id: agentEntry.id }, initialView: 'reviews' },
    timeline: selectedReviewTimeline,
  });
  const graphProposal = (proposalId: string, operationId: string, relation: 'root' | 'dependency') => ({
    proposalId, operationId, rootProposalId: 'proposal-one',
    parentProposalId: relation === 'root' ? null : 'proposal-one', relation,
    relationships: { dependency: null, replacesProposalId: null, choiceGroupId: null },
    lifecycle: 'open' as const, createdAt: 1, createdByActorId: 'actor-one',
  });
  const summaryItems = [
    { mode: 'graph', operationId: 'operation-one', proposal: graphProposal('proposal-one', 'operation-one', 'root'),
      status: 'clean', reasonCode: null },
    { mode: 'graph', operationId: 'operation-two', proposal: graphProposal('proposal-two', 'operation-two', 'dependency'),
      status: 'conflicted', reasonCode: 'PROPOSAL_BATCH_CONFLICT' },
  ] satisfies ProposalReviewSummaryResponseV1['items'];
  const cardRoot = createRoot(document.getElementById('root')!);
  await act(async () => cardRoot.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <FileVersionTimeline timeline={selectedReviewTimeline} selection={selectedReview}
      evaluatedReview={{ operationId: agentEntry.operationId, status: 'clean', reasonCode: null }}
      reviewSummary={summaryItems}
      onSelect={() => {}} onLoadMore={() => {}} loadingMore={false} loadMoreError={null} />
  </NextIntlClientProvider>));
  const selectedCard = document.querySelector<HTMLButtonElement>('[data-entry-kind="agent_operation"][aria-pressed="true"]');
  const otherCard = document.querySelector<HTMLButtonElement>('[data-operation-id="operation-two"]');
  assert.match(selectedCard?.textContent ?? '', /Root proposal[\s\S]*Ready to apply/iu,
    'the inspected operation card shows its evaluated status');
  assert.match(otherCard?.textContent ?? '', /Dependent proposal[\s\S]*Conflicting changes[\s\S]*overlaps changes in the current document/iu,
    'an uninspected dependent card shows its independently evaluated graph conflict and reason');
  assert.equal(otherCard?.getAttribute('aria-pressed'), 'false', 'the conflicting card is not the inspected selection');
  assert.equal(document.querySelectorAll('[data-testid="file-version-review-branch"]').length, 1,
    'server-projected parent and child appear together in a labelled Review branch');
  await act(async () => { selectedCard?.focus(); });
  assert.equal(document.activeElement, selectedCard);
  const reviewGroupRoots = new Map(summaryItems.map((item) => [item.operationId, item.proposal.rootProposalId]));
  await act(async () => cardRoot.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <FileVersionTimeline timeline={selectedReviewTimeline} selection={selectedReview}
      reviewGroupRoots={reviewGroupRoots}
      reviewSummaryError="Review status unavailable" onRetryReviewSummary={() => {}}
      onSelect={() => {}} onLoadMore={() => {}} loadingMore={false} loadMoreError={null} />
  </NextIntlClientProvider>));
  const unverifiedCard = document.querySelector<HTMLButtonElement>('[data-operation-id="operation-two"]');
  assert.equal(document.querySelector<HTMLButtonElement>('[data-operation-id="operation-one"]'), selectedCard,
    'a same-document refresh keeps the selected review node mounted');
  assert.equal(document.activeElement, selectedCard, 'background refresh does not steal keyboard focus');
  assert.match(unverifiedCard?.textContent ?? '', /Review status unavailable/iu);
  assert.equal(unverifiedCard?.getAttribute('data-entry-status'), null,
    'a failed summary never exposes a stale legacy conflict as an evaluated result');
  assert.doesNotMatch(unverifiedCard?.textContent ?? '', /\+4|Conflicting changes|Needs review/iu);
  assert.equal(selectedCard?.getAttribute('data-entry-status'), null,
    'structural grouping never carries an old ready-to-accept claim through revalidation');
  await act(async () => cardRoot.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <FileVersionTimeline timeline={selectedReviewTimeline} selection={selectedReview}
      reviewSummary={summaryItems} onSelect={() => {}} onLoadMore={() => {}}
      loadingMore={false} loadMoreError={null} />
  </NextIntlClientProvider>));
  assert.equal(document.querySelector<HTMLButtonElement>('[data-operation-id="operation-one"]'), selectedCard,
    'the revalidated review keeps the same focused DOM node');
  assert.equal(document.activeElement, selectedCard);
  assert.equal(selectedCard?.getAttribute('data-entry-status'), 'clean');
  const closedSummaryItems = [
    { mode: 'graph', operationId: 'operation-one',
      proposal: { ...graphProposal('proposal-one', 'operation-one', 'root'), lifecycle: 'included' },
      status: 'blocked_by_parent', reasonCode: 'PROPOSAL_INVALID_TRANSITION' },
    { mode: 'graph', operationId: 'operation-two',
      proposal: { ...graphProposal('proposal-two', 'operation-two', 'dependency'), lifecycle: 'superseded' },
      status: 'conflicted', reasonCode: 'PROPOSAL_INVALID_TRANSITION' },
  ] satisfies ProposalReviewSummaryResponseV1['items'];
  await act(async () => cardRoot.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <FileVersionTimeline timeline={selectedReviewTimeline} selection={selectedReview}
      evaluatedReview={{ operationId: 'operation-one', status: 'blocked_by_parent',
        reasonCode: 'PROPOSAL_INVALID_TRANSITION', lifecycle: 'included' }}
      reviewSummary={closedSummaryItems} onSelect={() => {}} onLoadMore={() => {}}
      loadingMore={false} loadMoreError={null} />
  </NextIntlClientProvider>));
  assert.match(selectedCard?.textContent ?? '', /Included/u);
  assert.equal(selectedCard?.getAttribute('data-entry-status'), 'included');
  assert.doesNotMatch(selectedCard?.textContent ?? '', /Blocked by a dependency|This decision is no longer allowed/u);
  const closedOtherCard = document.querySelector<HTMLButtonElement>('[data-operation-id="operation-two"]');
  assert.match(closedOtherCard?.textContent ?? '', /Superseded/u);
  assert.equal(closedOtherCard?.getAttribute('data-entry-status'), 'superseded');
  assert.doesNotMatch(closedOtherCard?.textContent ?? '', /Conflicting changes|This decision is no longer allowed/u);
  await act(async () => cardRoot.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <FileVersionTimeline timeline={selectedReviewTimeline} selection={selectedReview}
      reviewSummary={[{ mode: 'legacy', operationId: 'operation-one' }, { mode: 'legacy', operationId: 'operation-two' }]}
      onSelect={() => {}} onLoadMore={() => {}} loadingMore={false} loadMoreError={null} />
  </NextIntlClientProvider>));
  assert.match(document.querySelector<HTMLButtonElement>('[data-operation-id="operation-two"]')?.textContent ?? '', /Needs review/iu,
    'the old timeline status appears only after the server explicitly declares legacy mode');
  const savedCurrent = {
    ...revisionEntry,
    id: currentEntry.revisionId,
    revisionId: currentEntry.revisionId,
    revisionNumber: 8,
    content: { ...revisionEntry.content, sha256: currentEntry.sha256, sizeBytes: currentEntry.sizeBytes },
  };
  const matchingTimeline = response([currentEntry, savedCurrent, revisionEntry], { hasMore: false, nextCursor: null });
  assert.equal(matchingCurrentRevision(matchingTimeline.entries)?.revisionNumber, 8,
    'only the captured revision with the current content is folded into Current');
  const currentSelection = reconcileFileVersionTimelineSelection({
    request: { ...request, selectedEntry: undefined }, timeline: matchingTimeline,
  });
  await act(async () => cardRoot.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <FileVersionTimeline timeline={matchingTimeline} selection={currentSelection}
      onSelect={() => {}} onLoadMore={() => {}} loadingMore={false} loadMoreError={null} />
  </NextIntlClientProvider>));
  assert.match(document.querySelector('[data-entry-kind="current"]')?.textContent ?? '', /Current version[\s\S]*Version 8[\s\S]*Frank/u,
    'Current exposes the saved version number and provenance');
  assert.deepEqual([...document.querySelectorAll('[data-entry-kind="revision"]')].map((entry) => entry.textContent?.match(/Version \d+/u)?.[0]),
    ['Version 7'], 'the duplicate current snapshot is omitted while older versions remain');
  assert.match(document.querySelector('[data-testid="file-version-history-section"]')?.textContent ?? '', /Version history\s*1/u);

  const explicitSelection = reconcileFileVersionTimelineSelection({
    request: { ...request, selectedEntry: { kind: 'revision', id: savedCurrent.id } }, timeline: matchingTimeline,
  });
  assert.equal(explicitSelection.key, 'current',
    'a direct link to the byte-identical saved version resolves to the Current card');
  await act(async () => cardRoot.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <FileVersionTimeline timeline={matchingTimeline} selection={explicitSelection}
      onSelect={() => {}} onLoadMore={() => {}} loadingMore={false} loadMoreError={null} />
  </NextIntlClientProvider>));
  assert.ok(document.querySelector('[data-entry-kind="current"][aria-pressed="true"]'),
    'an explicitly linked current snapshot selects Current instead of leaving an orphaned hidden row');
  assert.equal(document.querySelectorAll('[data-entry-kind="revision"]').length, 1,
    'the matching revision remains folded even when it was the requested deep link');

  const mismatchedSnapshot = { ...savedCurrent, content: { ...savedCurrent.content, sha256: 'c'.repeat(64) } };
  const mismatchedTimeline = response([currentEntry, mismatchedSnapshot], { hasMore: false, nextCursor: null });
  assert.equal(matchingCurrentRevision(mismatchedTimeline.entries), null,
    'a matching revision ID never hides a different content hash');
  await act(async () => cardRoot.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <FileVersionTimeline timeline={mismatchedTimeline} selection={currentSelection}
      onSelect={() => {}} onLoadMore={() => {}} loadingMore={false} loadMoreError={null} />
  </NextIntlClientProvider>));
  assert.equal(document.querySelectorAll('[data-entry-kind="revision"]').length, 1);

  await act(async () => cardRoot.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <FileVersionTimeline timeline={response([currentEntry, savedCurrent], { hasMore: true, nextCursor: 'next' })}
      selection={currentSelection} onSelect={() => {}} onLoadMore={() => {}} loadingMore={false} loadMoreError={null} />
  </NextIntlClientProvider>));
  assert.match(document.querySelector('[data-testid="file-version-history-section"]')?.textContent ?? '', /Load older versions to see earlier states/u,
    'pagination does not falsely claim that no older saved versions exist');
  await act(async () => cardRoot.unmount());
  console.log('file-version-center-timeline-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => getNotebookQueryClient().clear());
