import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import {
  FileVersionActionController,
  FileVersionActionError,
  buildContinueFileVersionHref,
} from '../app/lib/file-version-center/action-client';
import type { CollaborationAgentOperation } from '../app/lib/collaboration/agent-operations-client';
import type {
  FileVersionCenterErrorCode,
  FileVersionTimelineEntryV1,
} from '../app/lib/file-version-center/contracts/v1';

const proposalVersion = `v1.${'a'.repeat(64)}`;

function operation(overrides: Partial<CollaborationAgentOperation> = {}): CollaborationAgentOperation {
  return {
    operationId: 'operation-one',
    operationStatus: 'needs_review',
    status: 'needs_review',
    durability: 'needs_review',
    actorId: 'agent-one',
    actionsAllowed: true,
    proposalVersion,
    appliedTargetIds: [],
    conflicts: [],
    targetAnchors: [],
    ...overrides,
  };
}

function acceptedOperation(): CollaborationAgentOperation {
  return operation({
    operationStatus: 'persisted_yjs',
    status: 'applied_to_ydoc',
    durability: 'persisted_yjs',
    actionsAllowed: false,
  });
}

function fvrcFailure(code: FileVersionCenterErrorCode, message: string, retryable: boolean, status: number): Response {
  return Response.json({ contractVersion: 1, success: false, error: { code, message, retryable } }, { status });
}

async function controllerCases(): Promise<void> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let releaseAccept!: (value: Response) => void;
  let acceptCompleted = false;
  const acceptResponse = new Promise<Response>((resolve) => { releaseAccept = resolve; });
  const acceptController = new FileVersionActionController((async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (init?.method === 'GET') {
      return Response.json({ success: true, operation: acceptCompleted ? acceptedOperation() : operation() });
    }
    return acceptResponse;
  }) as typeof fetch, () => 'accept-key-000001');
  const acceptInput = { operationId: 'operation-one', workspaceId: 'workspace-one', reviewedProposalVersion: proposalVersion };
  const firstAccept = acceptController.accept(acceptInput);
  const secondAccept = acceptController.accept(acceptInput);
  assert.equal(firstAccept, secondAccept, 'a double click shares exactly one in-flight action promise');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 2, 'a double click issues only one authorization reload and one mutation');
  const approval = JSON.parse(String(calls[1]!.init?.body)) as { idempotencyKey: string; proposalVersion: string };
  assert.deepEqual(approval, { idempotencyKey: 'accept-key-000001', proposalVersion });
  acceptCompleted = true;
  releaseAccept(Response.json({
    success: true,
    operation: {
      operationId: 'operation-one',
      operationStatus: 'persisted_yjs',
      status: 'applied_to_ydoc',
      durability: 'persisted_yjs',
      appliedTargetIds: ['target-one'],
      conflicts: [],
    },
  }));
  assert.equal((await firstAccept).outcome, 'accepted');
  assert.equal(calls.length, 3, 'a successful sparse action receipt is followed by one authoritative operation reload');

  let changedCalls = 0;
  const changedController = new FileVersionActionController((async () => {
    changedCalls += 1;
    return Response.json({ success: true, operation: operation({ proposalVersion: `v1.${'b'.repeat(64)}` }) });
  }) as typeof fetch);
  await assert.rejects(
    changedController.accept(acceptInput),
    (error: unknown) => error instanceof FileVersionActionError && error.code === 'AGENT_PROPOSAL_CHANGED',
  );
  assert.equal(changedCalls, 1, 'a changed candidate is rejected before the accept mutation');

  const deniedController = new FileVersionActionController((async () => (
    Response.json({ success: false, error: 'Forbidden' }, { status: 403 })
  )) as typeof fetch);
  await assert.rejects(
    deniedController.reject({ operationId: 'operation-one', workspaceId: 'workspace-one' }),
    (error: unknown) => error instanceof FileVersionActionError && error.code === 'FVRC_ACCESS_DENIED',
  );

  const restoreBodies: Array<{ idempotencyKey: string }> = [];
  let restoreAttempt = 0;
  const restoreController = new FileVersionActionController((async (_input, init) => {
    restoreBodies.push(JSON.parse(String(init?.body)) as { idempotencyKey: string });
    restoreAttempt += 1;
    if (restoreAttempt === 1) {
      return fvrcFailure('FVRC_PERSISTENCE_UNAVAILABLE', 'Temporarily unavailable.', true, 503);
    }
    return Response.json({
      contractVersion: 1,
      outcome: 'already_restored',
      priorRevisionId: 'revision-current',
      restoredRevisionId: 'revision-restored',
      current: { revisionId: 'revision-restored', sha256: 'b'.repeat(64) },
    });
  }) as typeof fetch, () => 'restore-key-00001');
  const restoreInput = {
    target: { kind: 'lineage' as const, workspaceId: 'workspace-one', lineageId: 'lineage-one' },
    revisionId: 'revision-seven',
    expectedCurrent: { revisionId: 'revision-current', sha256: 'a'.repeat(64) },
  };
  await assert.rejects(
    restoreController.restore(restoreInput),
    (error: unknown) => error instanceof FileVersionActionError && error.retryable,
  );
  assert.equal((await restoreController.restore(restoreInput)).outcome, 'already_restored');
  assert.deepEqual(
    restoreBodies.map((body) => body.idempotencyKey),
    ['restore-key-00001', 'restore-key-00001'],
    'network retries reuse the exact restore receipt key',
  );

  const conflictController = new FileVersionActionController((async () => (
    fvrcFailure('FVRC_STALE_CURRENT', 'Current changed.', false, 409)
  )) as typeof fetch, () => 'restore-key-00002');
  await assert.rejects(
    conflictController.restore(restoreInput),
    (error: unknown) => error instanceof FileVersionActionError
      && error.code === 'FVRC_STALE_CURRENT' && error.status === 409,
  );

  const continueHref = buildContinueFileVersionHref({
    workspaceId: 'workspace & one', path: 'Notes/Q3 plan.md', locale: 'en',
  });
  const continueUrl = new URL(continueHref, 'https://canvas.test');
  assert.equal(continueUrl.pathname, '/en/notebook');
  assert.equal(continueUrl.searchParams.get('workspaceId'), 'workspace & one');
  assert.equal(continueUrl.searchParams.get('path'), 'Notes/Q3 plan.md');
  assert.equal(continueUrl.searchParams.get('chat'), 'open');
}

async function componentCase(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://canvas.test/en/notebook',
  });
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver',
    'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'DOMException', 'HTMLButtonElement',
    'HTMLInputElement', 'HTMLTextAreaElement', 'SVGElement', 'NodeFilter', 'getComputedStyle', 'ResizeObserver',
  ] as const) {
    const value = key === 'window' ? dom.window : key === 'getComputedStyle'
      ? dom.window.getComputedStyle.bind(dom.window) : key === 'ResizeObserver'
        ? class { observe() {} unobserve() {} disconnect() {} }
        : dom.window[key];
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true,
    value: (callback: FrameRequestCallback) => setTimeout(callback, 0) });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true,
    value: (id: number) => clearTimeout(id) });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: () => {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: () => {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });

  const { FileVersionActions } = await import('../app/components/file-version-center/FileVersionActions');
  const request = {
    contractVersion: 1 as const,
    target: { kind: 'lineage' as const, workspaceId: 'workspace-one', lineageId: 'lineage-one' },
    initialView: 'reviews' as const,
    source: 'editor' as const,
  };
  const current = {
    kind: 'current' as const, id: 'current' as const, revisionId: 'revision-current',
    observedAt: '2026-09-14T09:00:00.000Z', sha256: 'a'.repeat(64), sizeBytes: 42,
  };
  const agentEntry = {
    kind: 'agent_operation' as const, id: 'operation-one', operationId: 'operation-one',
    createdAt: '2026-09-14T08:00:00.000Z', actor: { type: 'agent' as const },
    status: 'needs_review' as const, actionsAllowed: true,
  };
  const mount = async (
    controller: FileVersionActionController,
    invalidations: Array<string | undefined>,
    entry: Extract<FileVersionTimelineEntryV1, { kind: 'agent_operation' | 'revision' }> = agentEntry,
  ) => {
    const container = document.getElementById('root')!;
    const root = createRoot(container);
    await act(async () => root.render(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <FileVersionActions
          request={request}
          current={current}
          entry={entry}
          reviewedProposalVersion={proposalVersion}
          candidateAvailable
          restoreAllowed
          onTimelineInvalidate={(action) => { invalidations.push(action); }}
          onContinue={() => {}}
          controller={controller}
        />
      </NextIntlClientProvider>,
    ));
    return root;
  };
  const button = (label: RegExp) => {
    const result = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => label.test(candidate.textContent ?? ''));
    assert.ok(result, `button ${label} exists`);
    return result;
  };

  let release!: (value: Response) => void;
  const deferred = new Promise<Response>((resolve) => { release = resolve; });
  let postCount = 0;
  const controller = new FileVersionActionController((async (_input, init) => {
    if (init?.method === 'GET') return Response.json({ success: true, operation: operation() });
    postCount += 1;
    return deferred;
  }) as typeof fetch, () => 'component-key-001');
  const invalidations: Array<string | undefined> = [];
  let root = await mount(controller, invalidations);
  const accept = button(/Accept change/u);
  await act(async () => { accept.click(); accept.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(postCount, 1, 'the rendered action remains single-flight under a same-frame double click');
  assert.equal(accept.disabled, true);
  assert.match(document.body.textContent ?? '', /Accepting the reviewed proposal/u);
  await act(async () => {
    release(Response.json({ success: true, operation: acceptedOperation() }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(invalidations, ['accept'], 'a completed mutation invalidates the shared timeline exactly once');
  await act(async () => root.unmount());

  const changedInvalidations: Array<string | undefined> = [];
  const changedController = new FileVersionActionController((async () => Response.json({
    success: true,
    operation: operation({ proposalVersion: `v1.${'b'.repeat(64)}` }),
  })) as typeof fetch);
  root = await mount(changedController, changedInvalidations);
  await act(async () => { button(/Accept change/u).click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(document.body.textContent ?? '', /proposal changed/iu,
    'a changed reviewed fence has a visible non-color-only state');
  assert.deepEqual(changedInvalidations, [undefined], 'changed proposals refresh the timeline without claiming a mutation');
  await act(async () => root.unmount());

  const accessInvalidations: Array<string | undefined> = [];
  const accessController = new FileVersionActionController((async () => (
    Response.json({ success: false, error: 'Forbidden' }, { status: 403 })
  )) as typeof fetch);
  root = await mount(accessController, accessInvalidations);
  await act(async () => { button(/^Reject proposal$/u).click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(document.body.textContent ?? '', /Write access is no longer available/u,
    'permission loss is visible and keeps mutation controls fail-closed');
  assert.deepEqual(accessInvalidations, [undefined]);
  await act(async () => root.unmount());

  root = await mount(new FileVersionActionController(), [], {
    ...agentEntry,
    id: 'operation-direct-failed',
    operationId: 'operation-direct-failed',
    status: 'failed',
    actionsAllowed: false,
  });
  assert.equal([...document.querySelectorAll('button')].some((candidate) => /Accept change|^Reject proposal$/u.test(candidate.textContent ?? '')), false,
    'a failed direct application is inspectable without accept/reject proposal actions');
  assert.ok(button(/Continue editing/u));
  await act(async () => root.unmount());

  let retryAttempt = 0;
  const rejectBodies: Array<{ idempotencyKey: string }> = [];
  const retryController = new FileVersionActionController((async (_input, init) => {
    if (init?.method === 'GET') return Response.json({ success: true, operation: operation() });
    rejectBodies.push(JSON.parse(String(init?.body)) as { idempotencyKey: string });
    retryAttempt += 1;
    if (retryAttempt === 1) return Response.json({ success: false, error: 'Temporary failure.' }, { status: 503 });
    return Response.json({ success: true, operation: operation({ operationStatus: 'rejected', actionsAllowed: false }) });
  }) as typeof fetch, () => 'reject-key-000001');
  const retryInvalidations: Array<string | undefined> = [];
  root = await mount(retryController, retryInvalidations);
  await act(async () => { button(/^Reject proposal$/u).click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(document.body.textContent ?? '', /Retry action/u, 'retryable action failures expose an explicit retry control');
  await act(async () => { button(/Retry action/u).click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(rejectBodies, [{ idempotencyKey: 'reject-key-000001' }, { idempotencyKey: 'reject-key-000001' }]);
  assert.deepEqual(retryInvalidations, ['reject']);
  await act(async () => root.unmount());

  const revisionEntry = {
    kind: 'revision' as const,
    id: 'revision-seven',
    revisionId: 'revision-seven',
    revisionNumber: 7,
    createdAt: '2026-09-13T08:00:00.000Z',
    source: 'manual' as const,
    actor: { type: 'user' as const },
    content: { availability: 'available' as const, format: 'markdown' as const, sha256: 'b'.repeat(64), sizeBytes: 38 },
    restorable: true,
  };
  root = await mount(new FileVersionActionController(), [], revisionEntry);
  await act(async () => { button(/Restore version/u).click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(document.body.textContent ?? '', /Restore version 7/iu);
  assert.match(document.body.textContent ?? '', /revision-current/u);
  assert.match(document.body.textContent ?? '', /aaaaaaaaaaaa/u,
    'restore confirmation shows the authoritative current SHA fence before mutation');
  await act(async () => root.unmount());

  const { FileVersionCenterHost } = await import('../app/components/file-version-center/FileVersionCenterHost');
  const { openVersionCenter, closeVersionCenter } = await import('../app/store/file-version-center-store');
  let mutated = false;
  let resolveCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/resolve')) {
      resolveCount += 1;
      return Response.json({
        contractVersion: 1,
        document: { workspaceId: 'workspace-one', lineageId: 'lineage-one', documentId: 'document-one', path: 'Notes/roadmap.md' },
        capabilities: { contractVersion: 1, history: true, compare: true, restore: true, agentReviewPolicy: true, preview: 'markdown' },
        entries: mutated ? [current] : [agentEntry, current],
        page: { hasMore: false, nextCursor: null },
      });
    }
    if (url.endsWith('/compare')) {
      return Response.json({
        actionFence: { proposalVersion },
        response: {
          contractVersion: 1,
          current: { fence: { revisionId: current.revisionId, sha256: current.sha256 }, observedAt: current.observedAt },
          candidate: { selection: { kind: 'agent_operation', id: 'operation-one' }, stale: false, contentAvailable: true },
          summary: { additions: 1, deletions: 0, unchanged: 1 },
          hunks: [], page: { hasMore: false, nextCursor: null }, truncated: false,
        },
        preview: {
          format: 'markdown', current: '# Before', candidate: '# After', externalRequestsAllowed: false,
          blockedExternalReferences: 0, blocks: { current: 1, candidate: 1, unchanged: 0, changed: 2 },
        },
      });
    }
    if (url.endsWith('/operation-one') && init?.method === 'GET') {
      return Response.json({ success: true, operation: operation() });
    }
    if (url.endsWith('/operation-one/reject')) {
      mutated = true;
      return Response.json({ success: true, operation: operation({ operationStatus: 'rejected', actionsAllowed: false }) });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <FileVersionCenterHost />
    </NextIntlClientProvider>,
  ));
  await act(async () => {
    openVersionCenter({
      ...request,
      selectedEntry: { kind: 'agent_operation', id: 'operation-one' },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  await act(async () => { button(/^Reject proposal$/u).click(); await new Promise((resolve) => setTimeout(resolve, 50)); });
  assert.equal(resolveCount, 2, 'the global host resolves a fresh authoritative timeline after mutation');
  assert.equal(new URL(window.location.href).searchParams.get('fvrcSelectedId'), null,
    'a completed mutation clears the obsolete selected action from its reload URL');
  assert.equal(document.querySelector('[data-entry-kind="current"]')?.getAttribute('aria-pressed'), 'true');
  await act(async () => { closeVersionCenter(); root.unmount(); });

  let activeCurrent = current;
  let releaseInitialResolve!: (value: Response) => void;
  let releaseRefreshResolve!: (value: Response) => void;
  const initialResolve = new Promise<Response>((resolve) => { releaseInitialResolve = resolve; });
  const refreshResolve = new Promise<Response>((resolve) => { releaseRefreshResolve = resolve; });
  let restoreResolveCount = 0;
  const timelineResponse = () => Response.json({
    contractVersion: 1,
    document: { workspaceId: 'workspace-one', lineageId: 'lineage-one', documentId: 'document-one', path: 'Notes/roadmap.md' },
    capabilities: { contractVersion: 1, history: true, compare: true, restore: true, agentReviewPolicy: true, preview: 'markdown' },
    entries: [activeCurrent, revisionEntry],
    page: { hasMore: false, nextCursor: null },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/resolve')) {
      restoreResolveCount += 1;
      return restoreResolveCount === 1 ? initialResolve : refreshResolve;
    }
    if (url.endsWith('/compare')) {
      return Response.json({
        actionFence: { proposalVersion: null },
        response: {
          contractVersion: 1,
          current: { fence: { revisionId: activeCurrent.revisionId, sha256: activeCurrent.sha256 }, observedAt: activeCurrent.observedAt },
          candidate: { selection: { kind: 'revision', id: 'revision-seven' }, stale: false, contentAvailable: true },
          summary: { additions: 0, deletions: 1, unchanged: 1 },
          hunks: [], page: { hasMore: false, nextCursor: null }, truncated: false,
        },
        preview: {
          format: 'markdown', current: '# Current', candidate: '# Revision', externalRequestsAllowed: false,
          blockedExternalReferences: 0, blocks: { current: 1, candidate: 1, unchanged: 0, changed: 2 },
        },
      });
    }
    if (url.endsWith('/restore')) {
      return fvrcFailure('FVRC_STALE_CURRENT', 'Current changed.', false, 409);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <FileVersionCenterHost />
    </NextIntlClientProvider>,
  ));
  await act(async () => {
    openVersionCenter({
      ...request,
      initialView: 'history',
      selectedEntry: { kind: 'revision', id: 'revision-seven' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /Loading document history/iu,
    'the initial load still replaces the empty host with its progress state');
  assert.equal(document.querySelector('[data-testid="file-version-center-responsive-layout"]'), null);
  await act(async () => {
    releaseInitialResolve(timelineResponse());
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  await act(async () => { button(/Restore version/u).click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { button(/Restore as new version/u).click(); await new Promise((resolve) => setTimeout(resolve, 30)); });
  assert.equal(restoreResolveCount, 2, 'a stale restore starts one authoritative background refresh');
  assert.ok(document.querySelector('[data-testid="file-version-center-responsive-layout"]'),
    'a background refresh preserves the timeline and action subtree');
  assert.match(document.querySelector('[data-testid="file-version-action-error"]')?.textContent ?? '', /current document changed/iu,
    'the stale-current explanation stays visible while the authoritative refresh is pending');
  activeCurrent = {
    ...current,
    revisionId: 'revision-current-refreshed',
    sha256: 'c'.repeat(64),
    observedAt: '2026-09-14T10:00:00.000Z',
  };
  await act(async () => {
    releaseRefreshResolve(timelineResponse());
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  assert.ok(document.querySelector('[data-testid="file-version-center-responsive-layout"]'));
  assert.match(document.querySelector('[data-testid="file-version-action-error"]')?.textContent ?? '', /current document changed/iu,
    'the stale-current explanation survives the refreshed current fence');
  await act(async () => { closeVersionCenter(); root.unmount(); });
}

async function main(): Promise<void> {
  await controllerCases();
  await componentCase();
  console.log('file-version-center-actions-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
