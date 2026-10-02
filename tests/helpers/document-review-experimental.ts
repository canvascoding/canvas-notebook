import { expect, request as requestFactory, test as base, type APIRequestContext, type Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';

import { ownedCollaborationQaEnabled, requireOwnedCollaborationQaTarget } from '../../scripts/lib/owned-collaboration-qa';
import { createAuthenticatedContext } from './managed-test-context';
import { prepareOwnedReviewCooldown } from './owned-review-cooldown';

export type ExperimentalState = {
  documentReviewEnabled: boolean;
  updatedAt: string | null;
  studioBulkEnabled: boolean;
  studioBulkUpdatedAt: string | null;
};

export async function readExperimentalState(request: APIRequestContext): Promise<ExperimentalState> {
  const review = await request.get('/api/document-review/availability');
  const bulk = await request.get('/api/studio/bulk/availability');
  expect(review.status(), 'Read Document Review availability.').toBe(200);
  expect(bulk.status(), 'Read Studio Bulk availability.').toBe(200);
  const reviewPayload = await review.json();
  const bulkPayload = await bulk.json();
  expect(reviewPayload.success).toBe(true);
  expect(bulkPayload.success).toBe(true);
  expect(typeof reviewPayload.data?.documentReviewEnabled).toBe('boolean');
  expect(typeof bulkPayload.data?.studioBulkEnabled).toBe('boolean');
  for (const timestamp of [reviewPayload.data?.updatedAt, bulkPayload.data?.updatedAt]) {
    expect(timestamp === null || typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)),
      'Experimental audit timestamp must be null or a valid date string.').toBe(true);
  }
  return { documentReviewEnabled: reviewPayload.data.documentReviewEnabled, updatedAt: reviewPayload.data.updatedAt,
    studioBulkEnabled: bulkPayload.data.studioBulkEnabled, studioBulkUpdatedAt: bulkPayload.data.updatedAt };
}

export async function setScopedDocumentReview(request: APIRequestContext, enabled: boolean): Promise<ExperimentalState> {
  // The real API has no CAS contract. Never manufacture a revision or send other settings.
  const response = await request.patch('/api/admin/experimental-settings', {
    headers: { Origin: process.env.BASE_URL! }, data: { documentReviewEnabled: enabled },
  });
  expect(response.status(), 'Admin updates only the owned QA Document Review flag.').toBe(200);
  const payload = await response.json();
  expect(payload.success).toBe(true);
  expect(payload.data?.documentReviewEnabled).toBe(enabled);
  expect(typeof payload.data?.updatedAt).toBe('string');
  expect(Number.isFinite(Date.parse(payload.data.updatedAt))).toBe(true);
  return payload.data as ExperimentalState;
}

/** Existing enabled stacks are read-only. Enabling/restoring is confined to the verified private QA clone. */
export async function withDocumentReviewEnabled<T>(browser: Browser, run: () => Promise<T>): Promise<T> {
  const baselineContexts = new Set(browser.contexts());
  let cleanup: APIRequestContext | undefined;
  let initial: ExperimentalState | undefined;
  let owned: ExperimentalState | undefined;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let lockPath: string | undefined;
  let cooldown: Awaited<ReturnType<typeof prepareOwnedReviewCooldown>> | undefined;
  let patchAttempted = false;
  let primaryFailed = false;
  let primaryError: unknown;
  let result!: T;
  try {
    const context = await createAuthenticatedContext(browser);
    cleanup = await requestFactory.newContext({ baseURL: process.env.BASE_URL,
      storageState: await context.storageState(), timeout: 15_000 });
    if (ownedCollaborationQaEnabled()) {
      const target = await requireOwnedCollaborationQaTarget();
      const session = await cleanup.get('/api/auth/get-session');
      expect(session.status(), 'Review fixture requires an authenticated instance admin.').toBe(200);
      const identity = await session.json();
      expect(identity.user?.role).toBe('admin');
      expect(identity.user?.email).toBe(process.env.BOOTSTRAP_ADMIN_EMAIL);
      lockPath = path.join(path.dirname(target.dataRoot), 'document-review-fixture.lock');
      // Never steal a stale/unacknowledged owner; retain it for diagnosis instead.
      lock = await open(lockPath, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID(), bindingHash: target.bindingHash }));
      await lock.sync();
      const socketPath = process.env.CANVAS_LOCAL_AGENT_TOOL_SOCKET;
      expect(socketPath, 'QA review isolation requires the attested live Source tool socket.').toBeTruthy();
      cooldown = await prepareOwnedReviewCooldown({ directory: path.dirname(target.dataRoot), bindingHash: target.bindingHash,
        socketPath: socketPath!, leasePath: lockPath, lease: lock });
    }
    initial = await readExperimentalState(cleanup);
    if (!initial.documentReviewEnabled) {
      expect(lock, 'Enabling reviews requires an exclusively owned and verified QA fixture.').toBeTruthy();
      expect(await readExperimentalState(cleanup), 'Review setting changed before fixture acquisition.').toEqual(initial);
      patchAttempted = true;
      owned = await setScopedDocumentReview(cleanup, true);
      expect(owned.studioBulkEnabled).toBe(initial.studioBulkEnabled);
      expect(owned.studioBulkUpdatedAt).toBe(initial.studioBulkUpdatedAt);
      expect(await readExperimentalState(cleanup)).toEqual(owned);
    }
    result = await run();
  } catch (error) { primaryFailed = true; primaryError = error; }
  const cleanupErrors: unknown[] = [];
  let restoreVerified = !patchAttempted;
  try {
    if (initial && owned && cleanup) {
      expect(await readExperimentalState(cleanup), 'Review fixture ownership changed; retain state.').toEqual(owned);
      const restored = await setScopedDocumentReview(cleanup, initial.documentReviewEnabled);
      expect(restored.studioBulkEnabled).toBe(initial.studioBulkEnabled);
      expect(restored.studioBulkUpdatedAt).toBe(initial.studioBulkUpdatedAt);
      expect(Date.parse(restored.updatedAt!)).toBeGreaterThan(Date.parse(owned.updatedAt!));
      expect(await readExperimentalState(cleanup)).toEqual(restored);
      restoreVerified = true;
    } else if (patchAttempted) {
      throw new Error('Review enable acknowledgment is unverified; retain the QA scope for inspection.');
    } else if (initial && lock && cleanup) {
      restoreVerified = false;
      expect(await readExperimentalState(cleanup), 'Review setting changed while the QA fixture held its lease.').toEqual(initial);
      restoreVerified = true;
    }
  } catch (error) { cleanupErrors.push(error); }
  for (const context of browser.contexts().filter(context => !baselineContexts.has(context))) {
    try { await context.close(); } catch (error) { cleanupErrors.push(error); }
  }
  try {
    expect(browser.contexts().filter(context => !baselineContexts.has(context)),
      'Every context created by this review fixture must be closed before publishing quiescence.').toEqual([]);
  } catch (error) { cleanupErrors.push(error); }
  try { await cleanup?.dispose(); } catch (error) { cleanupErrors.push(error); }
  if (lockPath && lock && restoreVerified && cleanupErrors.length === 0) {
    try { await cooldown?.markQuiescent(); } catch (error) { cleanupErrors.push(error); }
  }
  if (lockPath && lock && restoreVerified && cleanupErrors.length === 0) {
    try {
      const held = await lock.stat();
      const current = await lstat(lockPath);
      expect(current.isFile() && !current.isSymbolicLink() && current.dev === held.dev && current.ino === held.ino,
        'Do not unlink an unowned replacement fixture lease.').toBe(true);
      await unlink(lockPath);
    } catch (error) { cleanupErrors.push(error); }
  }
  try { await lock?.close(); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(primaryFailed ? [primaryError, ...cleanupErrors] : cleanupErrors,
    'Document Review fixture cleanup failed.');
  if (primaryFailed) throw primaryError;
  return result;
}

export const test = base.extend<{ documentReviewFlag: void }>({
  documentReviewFlag: [async ({ browser }, runFixture) => {
    if (process.env.COLLABORATION_E2E !== '1') return runFixture();
    await withDocumentReviewEnabled(browser, runFixture);
  }, { auto: true, timeout: 150_000 }],
});
