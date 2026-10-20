import assert from 'node:assert/strict';
import type { SqlConnection } from '../app/lib/db';
import type { ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';

type Fixture = Awaited<ReturnType<typeof createDurableMessageExecutionFixture>>;
type Frame = Awaited<ReturnType<Fixture['createSessionRuntime']>>;
type Row = { client_message_id: string; private_payload: string | null; payload_hash: string;
  execution_phase: string | null; execution_revision: number | null; runtime_token: string;
  queue_lane: string | null; queue_ordinal: number | null; queue_disposition: string | null };

/** Real SQL, admission/queue/execution kernels, Actor/Session/Agent Use and Runtime
 * factory. Historical null/legacy rows are explicit storage fixtures. Only the
 * existing fixture's database transport and local model-catalog HTTP are controlled.
 * Actual authenticated Next route handlers are invoked directly. Resume is
 * exercised while another unpositioned row safely blocks dispatch; no HTTP
 * server, model generation or browser is part of this suite. */
async function main(): Promise<void> {
  const native = process.argv.includes('--native');
  const fixture = await createDurableMessageExecutionFixture({ native, ...(native ? { nativePoolMax: 2 } : {}) });
  const app = fixture.application, runtime = fixture.runtimeApi;
  const sql = async <T>(operation: (database: SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await app.database.openDb();
    try { return await operation(database); } finally { await database.close(); }
  };
  let stage = 'real queue fixture', cases = 0;
  const check = (name: string) => { cases++; console.log(`PASS ${name}`); };
  try {
    const admission = await import('../app/lib/pi/durable-message-admission');
    const execution = await import('../app/lib/pi/durable-message-execution');
    const recovery = await import('../app/lib/pi/queue-recovery');
    const route = await import('../app/api/chat/queue/route');
    const { NextRequest } = await import('next/server');
    const base = await fixture.createSessionRuntime({ userId: 'alice' });
    const frame = (userId: 'alice' | 'bob' = 'alice') => fixture.createSessionRuntime({ userId, agentId: base.agentId });
    const identity = (active: Frame) => ({ userId: active.userId, sessionId: active.sessionId,
      expectedWorkspaceId: active.context.workspaceId });
    const request = (userId: string | null, method: 'GET' | 'POST', query: string, body?: unknown, workspaceId?: string) => {
      const headers = userId ? app.headers(userId) : new Headers({ 'content-type': 'application/json' });
      if (workspaceId !== undefined) headers.set('x-canvas-workspace-id', workspaceId);
      return new NextRequest(`http://localhost:3001/api/chat/queue${query}`, { method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    const admissionIdentity = (active: Frame, clientMessageId: string) => ({ ...identity(active), clientMessageId,
      expectedAgentId: active.agentId });
    const rows = (active: Frame): Promise<Row[]> => sql(database => database.all(`SELECT client_message_id,private_payload,
      payload_hash,execution_phase,execution_revision,runtime_token,queue_lane,queue_ordinal,queue_disposition
      FROM pi_message_delivery_receipts WHERE pi_session_db_id=(SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2)
      ORDER BY client_message_id`, [active.userId, active.sessionId]) as Promise<Row[]>);
    const row = async (active: Frame, id: string) => {
      const current = (await rows(active)).find(value => value.client_message_id === id); assert(current); return current;
    };
    const admit = async (active: Frame, clientMessageId: string) => {
      const content = `Preserved queue intent ${clientMessageId}`;
      const body: ChatBodyV1 = { version: 1, parts: [{ type: 'text', text: content }], bundles: [] };
      const prepared = await admission.prepareChatMessageAdmission({ ...admissionIdentity(active, clientMessageId), body,
        message: { role: 'user', content, timestamp: 123 } });
      assert.equal(prepared.kind, 'prepared');
      if (prepared.kind !== 'prepared') throw new Error('A genuine new admission is required.');
      return admission.commitPreparedChatMessageAdmission(prepared.admission, { lane: 'follow_up' });
    };
    const fresh = async (active: Frame, id: string) => {
      const result = await admission.readOwnedAcceptedChatMessage(admissionIdentity(active, id)); assert(result); return result;
    };
    const unposition = (active: Frame, id: string) => sql(database => database.run(`UPDATE pi_message_delivery_receipts
      SET queue_lane=NULL,queue_ordinal=NULL,queue_disposition=NULL WHERE client_message_id=$1
      AND pi_session_db_id=(SELECT id FROM pi_sessions WHERE user_id=$2 AND session_id=$3)`, [id, active.userId, active.sessionId]));
    const legacy = (active: Frame) => sql(database => database.run(`INSERT INTO pi_message_delivery_receipts
      (pi_session_db_id,client_message_id,payload_hash,runtime_token,state,created_at,updated_at)
      VALUES((SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2),'legacy-blocker','legacy-digest','legacy-owner','accepted',1,1)`,
    [active.userId, active.sessionId]));
    const unchangedIntent = (before: Row, after: Row) => {
      assert.equal(after.private_payload, before.private_payload); assert.equal(after.payload_hash, before.payload_hash);
      assert.equal(after.runtime_token, before.runtime_token);
    };

    stage = 'cold SQL projection retains suspended and unpositioned exact intent';
    await admit(base, 'cancel-cold'); await admit(base, 'suspended');
    const ready = await admit(base, 'ready'); await execution.promoteOwnedQueuedChatMessage(ready);
    await admit(base, 'null-resume'); await unposition(base, 'null-resume');
    await admit(base, 'null-blocker'); await unposition(base, 'null-blocker');
    await runtime.invalidatePiRuntime(base.sessionId, base.userId);
    assert.equal(await runtime.getExistingPiRuntime(base.sessionId, base.userId), null);
    const beforeRead = await rows(base), beforeCounts = fixture.counts();
    const cold = await recovery.getChatQueueRecovery(identity(base));
    assert.equal(cold.sessionId, base.sessionId); assert.equal(cold.items.length, 5);
    for (const id of ['null-resume', 'null-blocker']) {
      assert(cold.blocked.some(blocker => blocker.clientMessageId === id && blocker.reason === 'unknown_queue_position'));
      assert.equal(cold.items.find(item => item.clientMessageId === id)?.queue, null);
    }
    const suspended = cold.items.find(item => item.clientMessageId === 'suspended'); assert(suspended);
    assert(typeof suspended.executionRevision === 'number');
    assert.equal(suspended.queue?.disposition, 'suspended'); assert.equal(suspended.executionRevision, 2);
    assert.deepEqual(suspended.body, { version: 1, parts: [{ type: 'text', text: 'Preserved queue intent suspended' }], bundles: [] });
    assert.equal(suspended.text, 'Preserved queue intent suspended'); assert.equal(suspended.messageTimestamp, 123);
    assert.equal(suspended.attachmentCount, 0);
    assert.doesNotMatch(JSON.stringify(cold), /private_payload|runtime_token|bindingFingerprint|accountSelectionRef|providerRef|workspaceRoot/u);
    assert.deepEqual(await rows(base), beforeRead); assert.deepEqual(fixture.counts(), beforeCounts);
    assert.equal(await runtime.getExistingPiRuntime(base.sessionId, base.userId), null);
    check('cold SQL projection preserves exact paused/null queue metadata and body without Runtime/model/source work');

    stage = 'real authenticated API uses only the owned Session and explicit workspace';
    const query = `?${new URLSearchParams({ sessionId: base.sessionId })}`;
    const response = await route.GET(request('alice', 'GET', query));
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control') ?? '', /private, no-store/u);
    assert.deepEqual((await response.json()).queue, cold);
    assert.equal((await route.GET(request(null, 'GET', query))).status, 401);
    assert.equal((await route.GET(request('bob', 'GET', query))).status, 403);
    assert.equal((await route.GET(request('alice', 'GET', query, undefined, app.actor('bob').workspaceId!))).status, 403);
    assert.equal((await route.GET(request('alice', 'GET', `${query}&userId=bob`))).status, 400);
    assert.equal((await route.GET(request('alice', 'GET', `${query}&sessionId=other`))).status, 400);
    assert.deepEqual(await rows(base), beforeRead);
    assert.equal(await runtime.getExistingPiRuntime(base.sessionId, base.userId), null);
    check('real authenticated GET enforces actor/workspace/strict query and does not initialize Runtime');

    stage = 'strict request, stale revision and foreign identity fences';
    const cancelTarget = cold.items.find(item => item.clientMessageId === 'cancel-cold'); assert(cancelTarget);
    const command = { action: 'cancel' as const, queueItemId: cancelTarget.id, executionRevision: cancelTarget.executionRevision };
    for (const invalid of [{ ...command, action: 'retry' }, { ...command, queueItemId: '' }, { ...command, executionRevision: 0 },
      { ...command, executionRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...command, runtimeToken: 'not-authority' }]) {
      await assert.rejects(recovery.controlChatQueueRecovery(identity(base), invalid as never));
    }
    let getterReads = 0;
    const getter = Object.defineProperty({ ...command }, 'executionRevision', { enumerable: true, get() { getterReads++; return 2; } });
    await assert.rejects(recovery.controlChatQueueRecovery(identity(base), getter)); assert.equal(getterReads, 0);
    await assert.rejects(recovery.controlChatQueueRecovery(identity(base), { ...command, executionRevision: 1 }));
    for (const foreign of [{ ...identity(base), userId: 'bob' }, { ...identity(base), expectedWorkspaceId: app.actor('bob').workspaceId! }]) {
      await assert.rejects(recovery.getChatQueueRecovery(foreign));
      await assert.rejects(recovery.controlChatQueueRecovery(foreign, command));
    }
    assert.deepEqual(await rows(base), beforeRead);
    assert.equal(await runtime.getExistingPiRuntime(base.sessionId, base.userId), null);
    check('malformed/getter/stale and cross-user/workspace operations reject without writes or Runtime creation');

    stage = 'cancel requires current Use and never constructs a Runtime';
    await sql(database => database.run("UPDATE agent_grants SET can_use=0 WHERE agent_id=$1 AND target_id='alice'", [base.agentId]));
    try {
      await assert.rejects(recovery.getChatQueueRecovery(identity(base)));
      await assert.rejects(recovery.controlChatQueueRecovery(identity(base), command));
      assert.deepEqual(await rows(base), beforeRead);
    } finally { await sql(database => database.run("UPDATE agent_grants SET can_use=1 WHERE agent_id=$1 AND target_id='alice'", [base.agentId])); }
    assert.equal((await route.POST(request('alice', 'POST', '', { sessionId: base.sessionId, ...command, userId: 'bob' }))).status, 400);
    assert.deepEqual(await rows(base), beforeRead);
    const cancelledResponse = await route.POST(request('alice', 'POST', '', { sessionId: base.sessionId, ...command }));
    assert.equal(cancelledResponse.status, 200);
    const cancelled = await cancelledResponse.json() as { queue: typeof cold };
    assert(!cancelled.queue.items.some(item => item.id === cancelTarget.id));
    const cancelledRow = await row(base, 'cancel-cold');
    assert.equal(cancelledRow.execution_phase, 'cancelled'); assert.equal(Number(cancelledRow.execution_revision), 3);
    unchangedIntent(beforeRead.find(item => item.client_message_id === 'cancel-cold')!, cancelledRow);
    assert.equal(await runtime.getExistingPiRuntime(base.sessionId, base.userId), null);
    await assert.rejects(recovery.controlChatQueueRecovery(identity(base), command));
    check('Use revocation prevents mutations; exact cancellation commits once without constructing a Runtime');

    stage = 'cancellation does not wait for an unrelated Runtime initializer operation';
    const preparing = await frame(), preparingOwned = await admit(preparing, 'cancel-during-preparation');
    const preparingSnapshot = admission.readOwnedChatMessageExecutionSnapshot(preparingOwned);
    const preparingBefore = await row(preparing, 'cancel-during-preparation');
    await runtime.invalidatePiRuntime(preparing.sessionId, preparing.userId);
    const { withPiSessionOperationLock } = await import('../app/lib/pi/session-operation-lock');
    let releasePreparation!: () => void, enteredPreparation!: () => void, preparationFinished = false;
    const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve; });
    const enteredGate = new Promise<void>(resolve => { enteredPreparation = resolve; });
    const preparation = withPiSessionOperationLock(preparing.sessionId, preparing.userId, async () => {
      enteredPreparation(); await preparationGate; preparationFinished = true;
    });
    await enteredGate;
    const cancelDuringPreparation = recovery.controlChatQueueRecovery(identity(preparing), { action: 'cancel',
      queueItemId: preparingSnapshot.payload.serverMessageId, executionRevision: preparingSnapshot.executionRevision });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([cancelDuringPreparation, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('SQL cancellation waited for the held Runtime operation.')), 5_000);
      })]);
      assert.equal(preparationFinished, false, 'The real Runtime operation gate is still held when SQL cancellation completes.');
      assert.equal(result.queue.items.length, 0);
      const cancelledDuringPreparation = await row(preparing, 'cancel-during-preparation');
      assert.equal(cancelledDuringPreparation.execution_phase, 'cancelled');
      assert.equal(Number(cancelledDuringPreparation.execution_revision), preparingSnapshot.executionRevision + 1);
      unchangedIntent(preparingBefore, cancelledDuringPreparation);
      assert.equal(await runtime.getExistingPiRuntime(preparing.sessionId, preparing.userId), null);
    } finally {
      clearTimeout(deadline); releasePreparation(); await preparation; await cancelDuringPreparation.catch(() => undefined);
    }
    check('SQL cancellation finishes before a genuine held Runtime operation releases, without initializing a Runtime');

    stage = 'explicit safe resume uses the real scheduler while another null row blocks model execution';
    const pausedBefore = await row(base, 'suspended');
    const resumed = await recovery.controlChatQueueRecovery(identity(base), { action: 'resume', queueItemId: suspended.id,
      executionRevision: suspended.executionRevision });
    const resumedItem = resumed.queue.items.find(item => item.id === suspended.id); assert(resumedItem);
    assert.equal(resumedItem.queue?.disposition, 'ready'); assert.equal(resumedItem.queue?.ordinal, suspended.queue?.ordinal);
    assert.equal(resumedItem.executionRevision, suspended.executionRevision + 1);
    unchangedIntent(pausedBefore, await row(base, 'suspended'));
    assert(resumed.queue.blocked.some(blocker => blocker.clientMessageId === 'null-blocker'));
    const readyItem = resumed.queue.items.find(item => item.clientMessageId === 'ready'); assert(readyItem);
    const beforeReadyResume = await rows(base);
    await recovery.controlChatQueueRecovery(identity(base), { action: 'resume', queueItemId: readyItem.id, executionRevision: readyItem.executionRevision });
    assert.deepEqual(await rows(base), beforeReadyResume, 'An already-ready continuation does not rewrite its accepted SQL state.');
    const nullItem = resumed.queue.items.find(item => item.clientMessageId === 'null-resume'); assert(nullItem);
    assert(typeof nullItem.executionRevision === 'number');
    const nullBefore = await row(base, 'null-resume');
    const initialized = await recovery.controlChatQueueRecovery(identity(base), { action: 'resume', queueItemId: nullItem.id, executionRevision: nullItem.executionRevision });
    const initializedItem = initialized.queue.items.find(item => item.id === nullItem.id); assert(initializedItem);
    assert.equal(initializedItem.queue?.disposition, 'ready'); assert.equal(initializedItem.queue?.lane, 'prompt');
    assert.equal(initializedItem.queue?.ordinal, 6, 'Explicit initialization appends after the actual Session ordinal counter.');
    assert.equal(initializedItem.executionRevision, nullItem.executionRevision + 1);
    unchangedIntent(nullBefore, await row(base, 'null-resume'));
    assert(initialized.queue.blocked.some(blocker => blocker.clientMessageId === 'null-blocker' && blocker.reason === 'unknown_queue_position'));
    assert.equal(fixture.counts().forbiddenModelRequests, 0);
    check('paused/null/ready continuations preserve intent and use genuine factory/queue fences without bypassing another null blocker');

    stage = 'legacy acknowledgements remain visible and prevent otherwise valid continuation';
    await legacy(base);
    const legacyQueue = await recovery.getChatQueueRecovery(identity(base));
    assert(legacyQueue.blocked.some(blocker => blocker.clientMessageId === 'legacy-blocker' && blocker.reason === 'legacy'));
    const legacyBefore = await rows(base);
    await assert.rejects(recovery.controlChatQueueRecovery(identity(base), { action: 'resume', queueItemId: resumedItem.id,
      executionRevision: resumedItem.executionRevision }));
    assert.deepEqual(await rows(base), legacyBefore);
    check('a real payloadless accepted legacy row stays visible and cannot be silently resolved by resume');

    stage = 'unknown and foreign in-flight execution are never resumed, cancelled or stolen';
    for (const phase of ['outcome_unknown', 'dispatching'] as const) {
      const active = await frame();
      const activeOwned = await admit(active, phase), owner = await runtime.getRegisteredPiRuntimeExecutionOwner(active.runtime);
      const claim = await execution.claimOwnedChatMessageExecution(activeOwned, owner);
      if (phase === 'outcome_unknown') {
        const running = await execution.startClaimedChatMessageExecution(claim);
        await execution.finishClaimedChatMessageExecution(running.claim, 'outcome_unknown');
      }
      const queued = await admit(active, 'blocked-follower');
      await runtime.invalidatePiRuntime(active.sessionId, active.userId);
      const before = await rows(active), status = await recovery.getChatQueueRecovery(identity(active));
      assert(status.blocked.some(blocker => blocker.clientMessageId === phase
        && blocker.reason === (phase === 'outcome_unknown' ? 'outcome_unknown' : 'execution_in_progress')));
      const snapshot = admission.readOwnedChatMessageExecutionSnapshot(await fresh(active, phase));
      for (const action of ['resume', 'cancel'] as const) await assert.rejects(recovery.controlChatQueueRecovery(identity(active), {
        action, queueItemId: snapshot.payload.serverMessageId, executionRevision: snapshot.executionRevision }));
      const follower = admission.readOwnedChatMessageExecutionSnapshot(queued);
      await assert.rejects(recovery.controlChatQueueRecovery(identity(active), { action: 'resume', queueItemId: follower.payload.serverMessageId,
        executionRevision: follower.executionRevision }));
      assert.deepEqual(await rows(active), before);
      assert.equal(await runtime.getExistingPiRuntime(active.sessionId, active.userId), null);
      if (phase === 'dispatching') await execution.finishClaimedChatMessageExecution(claim, 'cancelled');
    }
    check('unknown or unowned in-flight work blocks continuation without re-execution or mutation of its original receipt');
    stage = 'queued Edit cannot report removal after its exact target starts or finishes';
    for (const phase of ['dispatching', 'running', 'succeeded'] as const) {
      const active = await frame(), accepted = await admit(active, `edit-race-${phase}`);
      const acceptedSnapshot = admission.readOwnedChatMessageExecutionSnapshot(accepted);
      const preview = await active.runtime.refreshOwnedQueue();
      assert(preview.followUpQueue.some(item => item.id === acceptedSnapshot.payload.serverMessageId),
        'The actual queued target was visible before its competing execution transition.');
      const owner = await runtime.getRegisteredPiRuntimeExecutionOwner(active.runtime);
      let claim = await execution.claimOwnedChatMessageExecution(accepted, owner);
      if (phase !== 'dispatching') claim = (await execution.startClaimedChatMessageExecution(claim)).claim;
      if (phase === 'succeeded') await execution.finishClaimedChatMessageExecution(claim, 'succeeded');
      try {
        const refreshed = await active.runtime.refreshOwnedQueue();
        assert(!refreshed.followUpQueue.some(item => item.id === acceptedSnapshot.payload.serverMessageId));
        assert(!refreshed.steeringQueue.some(item => item.id === acceptedSnapshot.payload.serverMessageId));
        const before = await rows(active), counts = fixture.counts();
        assert.equal(before.length, 1); assert.equal(before[0].execution_phase, phase);
        await assert.rejects(active.runtime.removeQueuedMessage(acceptedSnapshot.payload.serverMessageId),
          { code: 'MESSAGE_EXECUTION_CONFLICT', status: 409 });
        assert.deepEqual(await rows(active), before, 'Rejected stale removal must not alter the running or terminal receipt.');
        assert.deepEqual(fixture.counts(), counts, 'Removal cannot initialize or call a model/provider.');
      } finally {
        if (phase !== 'succeeded') await execution.finishClaimedChatMessageExecution(claim, 'cancelled');
      }
    }
    const empty = await frame(), emptyBefore = await rows(empty), emptyCounts = fixture.counts();
    await assert.rejects(empty.runtime.removeQueuedMessage('missing-ram-entry'),
      { code: 'MESSAGE_EXECUTION_CONFLICT', status: 409 });
    assert.deepEqual(await rows(empty), emptyBefore); assert.deepEqual(fixture.counts(), emptyCounts);
    check('exact queued targets that became dispatching/running/terminal and absent RAM IDs conflict instead of falsely confirming cancellation');

    assert.equal(fixture.counts().forbiddenModelRequests, 0); assert.equal(fixture.counts().externalRequests, 0);
    console.log(JSON.stringify({ status: 'PASS', cases, database: native ? 'native PostgreSQL' : 'PGlite',
      modelGeneration: false, authorityMocks: false, httpRoute: true, httpServer: false, browser: false }));
  } catch (error) { console.error(`Queue recovery fixture failed during ${stage}`); throw error; }
  finally { await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
