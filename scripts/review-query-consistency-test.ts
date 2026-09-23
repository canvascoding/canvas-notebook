import assert from 'node:assert/strict';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { getNotebookQueryClient, notebookQueryKey } from '../app/lib/queries/client';
import { invalidateReviewQueries, reviewComparisonResource } from '../app/lib/queries/review-queries';
import { FileVersionCenterClientError, resolveFileVersionCenterWhenReady } from '../app/lib/file-version-center/client';
import { compareFileVersion, mergeFileVersionComparePayload } from '../app/lib/file-version-center/compare-client';
import { loadFileVersionTimelinePage } from '../app/lib/file-version-center/timeline-client';
import { FileVersionActionController } from '../app/lib/file-version-center/action-client';
import type { FileVersionCompareRequestV1, FileVersionCenterRequestV1 } from '../app/lib/file-version-center/contracts/v1';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  observeOpenedDocumentAuth({ data: { user: { id: 'review-user' }, session: { id: 'review-auth' } } });
  const client = getNotebookQueryClient();
  const request: FileVersionCenterRequestV1 = {
    contractVersion: 1, target: { kind: 'lineage', workspaceId: 'workspace', lineageId: 'lineage' },
    initialView: 'reviews', source: 'editor',
  };
  const timeline = {
    contractVersion: 1,
    document: { workspaceId: 'workspace', lineageId: 'lineage', documentId: 'document', path: 'file.md' },
    capabilities: { contractVersion: 1, history: true, compare: true, restore: true, agentReviewPolicy: true, preview: 'markdown' },
    entries: [], page: { hasMore: false, nextCursor: null },
  };
  const blocked = deferred<Response>();
  let requests = 0;
  globalThis.fetch = async () => { requests++; return blocked.promise; };
  const cancelled = new AbortController();
  const first = resolveFileVersionCenterWhenReady(request, cancelled.signal);
  const second = resolveFileVersionCenterWhenReady(request);
  const cancelledResult = assert.rejects(first, error => error instanceof DOMException && error.name === 'AbortError');
  cancelled.abort();
  await cancelledResult;
  blocked.resolve(Response.json(timeline));
  assert.deepEqual(await second, timeline);
  assert.equal(requests, 1, 'closing one panel must not abort a shared resolve');
  globalThis.fetch = async () => { requests++; return Response.json(timeline); };
  await resolveFileVersionCenterWhenReady(request);
  assert.equal(requests, 2, 'resolved live timelines must not be reused as fresh');

  client.clear();
  let retries = 0;
  globalThis.fetch = async () => {
    retries++;
    return retries === 1
      ? Response.json({ contractVersion: 1, success: false, error: { code: 'FVRC_PERSISTENCE_UNAVAILABLE', message: 'Saving', retryable: true } }, { status: 409 })
      : Response.json(timeline);
  };
  await Promise.all([
    resolveFileVersionCenterWhenReady(request, undefined, { retryDelaysMs: [1] }),
    resolveFileVersionCenterWhenReady(request, undefined, { retryDelaysMs: [1] }),
  ]);
  assert.equal(retries, 2, 'the bounded persistence retry belongs to the shared query');
  const pageRequest = { contractVersion: 1 as const, target: request.target, limit: 20 };
  const pageBlocked = deferred<Response>();
  let pages = 0;
  globalThis.fetch = async () => { pages++; return pageBlocked.promise; };
  const pageOne = loadFileVersionTimelinePage(pageRequest);
  const pageTwo = loadFileVersionTimelinePage(pageRequest);
  pageBlocked.resolve(Response.json(timeline));
  await Promise.all([pageOne, pageTwo]);
  assert.equal(pages, 1);
  globalThis.fetch = async () => { pages++; return Response.json(timeline); };
  await loadFileVersionTimelinePage(pageRequest);
  assert.equal(pages, 2);

  const comparison: FileVersionCompareRequestV1 = {
    contractVersion: 1, target: request.target, candidate: { kind: 'agent_operation', id: 'operation' },
    expectedCurrent: { revisionId: 'current-revision', sha256: 'a'.repeat(64) }, limit: 20,
  };
  const versionA = `v1.${'a'.repeat(64)}`;
  const versionB = `v1.${'b'.repeat(64)}`;
  let responseVersion = versionA;
  let wrongCurrent = false;
  let comparisons = 0;
  globalThis.fetch = async (_url, init) => {
    comparisons++;
    const body = JSON.parse(String(init?.body)) as FileVersionCompareRequestV1;
    return Response.json({
      response: {
        contractVersion: 1, current: { fence: wrongCurrent ? { ...body.expectedCurrent, sha256: 'f'.repeat(64) } : body.expectedCurrent, observedAt: '2026-09-22T12:00:00Z' },
        candidate: { selection: body.candidate, stale: false, contentAvailable: true },
        summary: { additions: 1, deletions: 0, unchanged: 1 }, hunks: [], page: { hasMore: false, nextCursor: null }, truncated: false,
      },
      preview: { format: 'markdown', current: 'before', candidate: 'after', externalRequestsAllowed: false, blockedExternalReferences: 0, blocks: { current: 1, candidate: 1, unchanged: 0, changed: 1 } },
      actionFence: { proposalVersion: responseVersion },
    });
  };
  const options = { proposalVersion: versionA, lineageId: 'lineage' };
  const original = await compareFileVersion(comparison, undefined, options);
  await compareFileVersion(comparison, undefined, options);
  assert.equal(comparisons, 1, 'the complete immutable comparison identity can be reused');
  await compareFileVersion(comparison, undefined, { ...options, force: true });
  assert.equal(comparisons, 2);
  await compareFileVersion({ ...comparison, expectedCurrent: { ...comparison.expectedCurrent, stateVectorHash: 'c'.repeat(64) } }, undefined, options);
  assert.equal(comparisons, 3, 'collaboration state vector is part of the query identity');
  await compareFileVersion({ ...comparison, cursor: 'v1.1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, undefined, options);
  assert.equal(comparisons, 4);
  responseVersion = versionB;
  await compareFileVersion(comparison, undefined, { ...options, proposalVersion: versionB });
  assert.equal(comparisons, 5);
  await assert.rejects(compareFileVersion(comparison, undefined, { ...options, force: true }), error => error instanceof FileVersionCenterClientError && error.code === 'FVRC_STALE_SELECTION');
  wrongCurrent = true;
  await assert.rejects(compareFileVersion(comparison, undefined, { ...options, proposalVersion: versionB, force: true }), error => error instanceof FileVersionCenterClientError && error.code === 'FVRC_STALE_CURRENT');
  wrongCurrent = false;
  await compareFileVersion(comparison);
  await compareFileVersion(comparison);
  assert.equal(comparisons, 9, 'an unversioned mutable proposal is always refreshed');
  assert.throws(() => mergeFileVersionComparePayload(original, { ...original, actionFence: { proposalVersion: versionB } }), /another document state/);

  // A valid mutation receipt invalidates old comparisons before its follow-up GET.
  responseVersion = versionA;
  const key = notebookQueryKey('workspace', ...reviewComparisonResource(comparison, options));
  client.setQueryData(key, original);
  let operationReads = 0;
  const actionController = new FileVersionActionController((async (_url, init) => {
    if (init?.method === 'GET') {
      if (++operationReads === 2) {
        assert.equal(client.getQueryState(key)?.isInvalidated, true);
        return Response.json({ error: 'Read failed' }, { status: 503 });
      }
      return Response.json({ operation: {
        operationId: 'operation', operationStatus: 'needs_review', status: 'needs_review', durability: 'needs_review',
        actionsAllowed: true, proposalVersion: versionA, appliedTargetIds: [], conflicts: [], targetAnchors: [],
      } });
    }
    return Response.json({ success: true, operation: {
      operationId: 'operation', operationStatus: 'persisted_yjs', status: 'applied_to_ydoc', durability: 'persisted_yjs', appliedTargetIds: [], conflicts: [],
    } });
  }) as typeof fetch, () => 'review-action-key-123');
  await assert.rejects(actionController.accept({ operationId: 'operation', workspaceId: 'workspace', reviewedProposalVersion: versionA }));
  assert.equal(client.getQueryState(key)?.isInvalidated, true);

  const oldScope = notebookQueryKey('workspace')[1];
  observeOpenedDocumentAuth({ data: { user: { id: 'other-user' }, session: { id: 'other-auth' } } });
  const newClient = getNotebookQueryClient();
  const newKey = notebookQueryKey('workspace', ...reviewComparisonResource(comparison, options));
  newClient.setQueryData(newKey, original);
  await invalidateReviewQueries('workspace', oldScope);
  assert.equal(newClient.getQueryState(newKey)?.isInvalidated, false, 'a late action must not invalidate another account');
  await invalidateReviewQueries('workspace');
  assert.equal(newClient.getQueryState(newKey)?.isInvalidated, true);
  newClient.clear();
  console.log('Review queries: shared reads/retries, immutable fences, pagination, mutation invalidation and auth isolation passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
