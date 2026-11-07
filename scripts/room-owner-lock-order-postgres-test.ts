import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

await withNativeCopyMetadataOwnerFixture(async function roomOwnerLockOrderRegression(h) {
  const { createCollaborationRoomOwnerSession, CollaborationRoomOwnerError } = await import('../app/lib/collaboration/room-owner');
  const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
  const documents: Array<{ documentId: string; lifecycleGeneration: number; filePath: string }> = [];
  for (const name of ['holder', 'waiter', 'protected']) {
    const filePath = `owner-lock-order/${name}.md`;
    const uploaded = await h.upload(filePath, Buffer.from(`${name}: original content.\n`));
    documents.push({ ...uploaded, filePath });
  }
  const scope = async (index: number) => {
    const row = (await h.admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1',
      [documents[index].documentId])).rows[0];
    assert.equal(row.workspace_id, h.source.workspaceId);
    return { documentId: row.document_id, workspaceId: row.workspace_id, organizationId: row.organization_id,
      path: row.path, representation: row.representation,
      lifecycleGeneration: Number(row.lifecycle_generation), schemaVersion: Number(row.schema_version) };
  };
  const [holderScope, waiterScope] = await Promise.all([scope(0), scope(1)]);
  const protectedSnapshot = async () => ({
    native: (await h.admin.query('SELECT *,xmin::text AS row_xmin FROM collaboration_yjs_states WHERE document_id=$1',
      [documents[2].documentId])).rows,
    bytes: await readFile(path.join(h.source.rootPath, documents[2].filePath)),
  });
  const before = await protectedSnapshot();
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    application_name: `${h.applicationName}-lock-order`, connectionTimeoutMillis: 5_000,
    options: `-c search_path=${h.schema},pg_catalog -c statement_timeout=5000 -c lock_timeout=4000` });
  await client.connect();
  const owner = await createCollaborationRoomOwnerSession(client);
  const held = Promise.withResolvers<void>();
  const continueHolder = Promise.withResolvers<void>();
  type Fence = Awaited<ReturnType<typeof owner.acquire>>;
  let holderClaim: Promise<Fence> | undefined;
  let waiterClaim: Promise<Fence> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const holder = withWorkspaceMutationLock(h.source.workspaceId, async () => {
      held.resolve();
      await continueHolder.promise;
      holderClaim = owner.acquire(holderScope);
      return Promise.race([holderClaim, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Owner queue waited for a workspace lock held by its own next caller.')), 1_500);
      })]);
    });
    // This branch is outside the holder's AsyncLocalStorage context. Its
    // acquire is submitted first and must wait for the real workspace lock.
    await held.promise;
    waiterClaim = owner.acquire(waiterScope);
    void waiterClaim.catch(() => undefined);
    continueHolder.resolve();
    const holderFence = await holder;
    if (timeout) clearTimeout(timeout);
    owner.assertActive(holderFence);
    const waiterFence = await waiterClaim;
    owner.assertActive(waiterFence);
    assert.notEqual(holderFence.token, waiterFence.token);
    assert.deepEqual(await protectedSnapshot(), before);
    const capacityHeld = Promise.withResolvers<void>();
    const releaseCapacity = Promise.withResolvers<void>();
    const probeEntered = Promise.withResolvers<void>();
    const releaseProbe = Promise.withResolvers<void>();
    const originalQuery = client.query;
    let pauseFirstProbe = true;
    Object.defineProperty(client, 'query', { configurable: true, value: function (...args: unknown[]) {
      const result = Reflect.apply(originalQuery, this, args);
      if (args[0] !== 'SELECT 1' || !pauseFirstProbe) return result;
      pauseFirstProbe = false;
      // Observe and pause the actual successful PG query, never its result.
      return Promise.resolve(result).then(async answer => {
        probeEntered.resolve();
        await releaseProbe.promise;
        return answer;
      });
    } });
    const capacityHolder = withWorkspaceMutationLock(h.source.workspaceId, async () => {
      capacityHeld.resolve();
      await releaseCapacity.promise;
    });
    await Promise.race([capacityHeld.promise, capacityHolder]);
    const firstProbe = owner.probe();
    void firstProbe.catch(() => undefined);
    const queuedProbes = [firstProbe];
    let waitingClaims: Promise<Fence>[] = [];
    const isBusy = (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY';
    try {
      timeout = setTimeout(() => probeEntered.reject(new Error('The real owner probe did not reach its barrier.')), 1_500);
      await probeEntered.promise;
      clearTimeout(timeout);
      queuedProbes.push(...Array.from({ length: 191 }, () => owner.probe()));
      for (const probe of queuedProbes) void probe.catch(() => undefined);
      waitingClaims = Array.from({ length: 64 }, () => owner.acquire(waiterScope));
      for (const claim of waitingClaims) void claim.catch(() => undefined);
      await assert.rejects(owner.acquire(holderScope), isBusy, 'Pending claims count against the256-command bound.');
      await assert.rejects(owner.release(holderFence), isBusy, 'Capacity denial must retain the original fence.');
      owner.assertActive(holderFence);
      await assert.rejects(owner.probe(), isBusy, 'Probes share the same bounded command capacity.');
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseProbe.resolve();
      releaseCapacity.resolve();
      await capacityHolder;
      const probes = await Promise.allSettled(queuedProbes);
      const outcomes = await Promise.allSettled(waitingClaims);
      Object.defineProperty(client, 'query', { configurable: true, value: originalQuery });
      assert(probes.every(probe => probe.status === 'fulfilled'), 'All original probe commands must complete.');
      assert(outcomes.every(outcome => outcome.status === 'rejected' && isBusy(outcome.reason)),
        'Each original waiter must observe its already-owned document without a new claim.');
    }
    await owner.probe();
    assert.deepEqual(await protectedSnapshot(), before);
    console.log(JSON.stringify({ suite: 'room-owner-lock-order', passed: true,
      groups: 2, pendingWorkspaceClaims: 64, combinedCommandCapacity: 256, capacityReclaimed: true,
      actualPostgres: true, actualWorkspaceKernelLock: true, independentAsyncContexts: true,
      lockHolderClaimsBeforeBlockedWaiter: true, protectedNativeXminAndBytesUnchanged: true }));
  } finally {
    if (timeout) clearTimeout(timeout);
    continueHolder.resolve();
    // Even the red test releases its outer kernel lock on timeout. Await both
    // original claims and release their exact fences; never replay acquisition.
    const claims = await Promise.allSettled([holderClaim, waiterClaim].filter(
      (claim): claim is Promise<Fence> => Boolean(claim)));
    try {
      for (const claim of claims) if (claim.status === 'fulfilled') await owner.release(claim.value);
    } finally { await owner.close(); }
  }
});
completed = true;
