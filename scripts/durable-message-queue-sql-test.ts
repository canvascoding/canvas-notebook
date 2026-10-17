import assert from 'node:assert/strict';
import type { SqlConnection } from '../app/lib/db';
import type { OwnedAcceptedChatMessage, ChatMessageQueueLane } from '../app/lib/pi/durable-message-admission';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';

type Frame = Awaited<ReturnType<Awaited<ReturnType<typeof createDurableMessageExecutionFixture>>['createSessionRuntime']>>;
type QueueRow = { client_message_id: string; execution_phase: string; execution_revision: number;
  runtime_token: string; payload_hash: string; private_payload: string;
  queue_lane: ChatMessageQueueLane | null; queue_ordinal: number | null; queue_disposition: 'ready' | 'suspended' | null };

/** Actual SQL, admission, Actor Use and Runtime factory. Queue controls do not
 * receive a Runtime owner. Only SQL transport faults are injected, always after
 * delegating the mutation when claiming a real SQL write/COMMIT. */
async function main(): Promise<void> {
  const native = process.argv.includes('--native');
  const fixture = await createDurableMessageExecutionFixture({ native, ...(native ? { nativePoolMax: 2 } : {}) });
  const app = fixture.application;
  const sql = async <T>(operation: (database: SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await app.database.openDb();
    try { return await operation(database); } finally { await database.close(); }
  };
  let stage = 'actual queued admissions';
  try {
    const admission = await import('../app/lib/pi/durable-message-admission');
    const execution = await import('../app/lib/pi/durable-message-execution');
    const runtime = fixture.runtimeApi;
    const frame = await fixture.createSessionRuntime({ userId: 'alice' });
    const newFrame = (userId: 'alice' | 'bob' = 'alice') => fixture.createSessionRuntime({ userId, agentId: frame.agentId });
    const identity = (active: Frame, clientMessageId: string) => ({ userId: active.userId, sessionId: active.sessionId, clientMessageId,
      expectedAgentId: active.agentId, expectedWorkspaceId: active.context.workspaceId });
    const prepare = (id: string, active: Frame, mode: 'message' | 'steer' = 'message') => admission.prepareChatMessageAdmission({
      ...identity(active, id), mode, message: { role: 'user', content: `Actual immutable queue intent ${id}.`, timestamp: 100 } });
    const admit = async (id: string, active: Frame, options: { mode?: 'message' | 'steer'; lane?: ChatMessageQueueLane } = {}) => {
      const prepared = await prepare(id, active, options.mode);
      assert.equal(prepared.kind, 'prepared'); if (prepared.kind !== 'prepared') throw new Error('Expected actual new admission.');
      return admission.commitPreparedChatMessageAdmission(prepared.admission, options.lane ? { lane: options.lane } : {});
    };
    const fresh = async (id: string, active: Frame) => {
      const value = await admission.readOwnedAcceptedChatMessage(identity(active, id)); assert(value); return value;
    };
    const rows = (active: Frame) => sql(database => database.all(`SELECT client_message_id,execution_phase,execution_revision,
      runtime_token,payload_hash,private_payload,queue_lane,queue_ordinal,queue_disposition
      FROM pi_message_delivery_receipts WHERE pi_session_db_id=(SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2)
      ORDER BY client_message_id`, [active.userId, active.sessionId])) as Promise<QueueRow[]>;
    const row = async (id: string, active: Frame) => { const value = (await rows(active)).find(value => value.client_message_id === id); assert(value); return value; };
    const state = async (id: string, active: Frame, phase: string, revision: number,
      queue: { lane: ChatMessageQueueLane; ordinal: number; disposition: 'ready' | 'suspended' } | null) => {
      const actual = await row(id, active); assert.equal(actual.execution_phase, phase); assert.equal(actual.execution_revision, revision);
      assert.deepEqual([actual.queue_lane, actual.queue_ordinal, actual.queue_disposition], queue ? [queue.lane, queue.ordinal, queue.disposition] : [null, null, null]);
      return actual;
    };
    const unchangedIntent = (before: QueueRow, after: QueueRow) => {
      assert.equal(after.private_payload, before.private_payload); assert.equal(after.payload_hash, before.payload_hash);
      assert.equal(after.runtime_token, before.runtime_token);
    };
    const conflict = { code: 'MESSAGE_EXECUTION_CONFLICT', status: 409 };
    const denied = { code: 'AGENT_MESSAGE_EXECUTION_DENIED', status: 403 };
    const owner = await runtime.getRegisteredPiRuntimeExecutionOwner(frame.runtime);

    const prompt = await admit('prompt', frame);
    const steer = await admit('steer', frame, { mode: 'steer' });
    const followUp = await admit('follow-up', frame, { lane: 'follow_up' });
    await state('prompt', frame, 'queued', 1, { lane: 'prompt', ordinal: 1, disposition: 'ready' });
    await state('steer', frame, 'queued', 1, { lane: 'steer', ordinal: 2, disposition: 'ready' });
    await state('follow-up', frame, 'queued', 1, { lane: 'follow_up', ordinal: 3, disposition: 'ready' });
    await assert.rejects(execution.claimOwnedChatMessageExecution(steer, owner), conflict);
    await assert.rejects(execution.claimOwnedChatMessageExecution(followUp, owner), conflict);
    const firstClaim = await execution.claimOwnedChatMessageExecution(prompt, owner);
    await execution.finishClaimedChatMessageExecution(firstClaim, 'cancelled');

    stage = 'promotion suspends older ready rows without rewriting admitted intent';
    const beforePromotion = await rows(frame);
    const promoted = await execution.promoteOwnedQueuedChatMessage(followUp);
    assert(Object.isFrozen(promoted)); assert(Object.isFrozen(promoted.message)); assert(Object.isFrozen(promoted.suspended));
    assert.deepEqual(Object.keys(promoted.message).sort(), ['clientMessageId', 'executionRevision', 'phase', 'queue', 'serverMessageId'].sort());
    await assert.rejects(execution.claimOwnedChatMessageExecution(promoted.message as unknown as OwnedAcceptedChatMessage, owner), denied);
    await assert.rejects(execution.cancelOwnedQueuedChatMessages([promoted.message as unknown as OwnedAcceptedChatMessage]), denied);
    assert.equal(promoted.message.clientMessageId, 'follow-up'); assert.equal(promoted.message.executionRevision, 2);
    assert.deepEqual(promoted.suspended.map(value => value.clientMessageId), ['steer']);
    await state('follow-up', frame, 'queued', 2, { lane: 'steer', ordinal: 3, disposition: 'ready' });
    await state('steer', frame, 'queued', 2, { lane: 'steer', ordinal: 2, disposition: 'suspended' });
    for (const before of beforePromotion) unchangedIntent(before, await row(before.client_message_id, frame));
    assert.equal(JSON.parse((await row('follow-up', frame)).private_payload).mode, 'message');
    for (const old of [steer, followUp]) {
      await assert.rejects(execution.promoteOwnedQueuedChatMessage(old), conflict);
      await assert.rejects(execution.cancelOwnedQueuedChatMessages([old]), conflict);
      await assert.rejects(execution.resumeOwnedQueuedChatMessages([old]), conflict);
    }
    await assert.rejects(execution.claimOwnedChatMessageExecution(await fresh('steer', frame), owner), conflict);
    const promotedClaim = await execution.claimOwnedChatMessageExecution(await fresh('follow-up', frame), owner);
    const promotedRunning = await execution.startClaimedChatMessageExecution(promotedClaim);
    await execution.finishClaimedChatMessageExecution(promotedRunning.claim, 'succeeded');
    const resumed = await execution.resumeOwnedQueuedChatMessages([await fresh('steer', frame)]);
    assert(Object.isFrozen(resumed)); assert(Object.isFrozen(resumed[0])); assert.equal(resumed[0]?.executionRevision, 3);
    await state('steer', frame, 'queued', 3, { lane: 'steer', ordinal: 2, disposition: 'ready' });
    const resumedClaim = await execution.claimOwnedChatMessageExecution(await fresh('steer', frame), owner);
    await execution.finishClaimedChatMessageExecution(resumedClaim, 'cancelled');
    await state('steer', frame, 'cancelled', 5, { lane: 'steer', ordinal: 2, disposition: 'ready' });

    stage = 'queue controls use real owned SQL rows without runtime registration';
    const controls = await newFrame(), foreign = await newFrame('bob');
    const controlA = await admit('a', controls), controlB = await admit('b', controls), controlC = await admit('c', controls, { mode: 'steer' });
    const foreignOwned = await admit('foreign', foreign);
    await runtime.invalidatePiRuntime(controls.sessionId, controls.userId);
    assert.equal(await runtime.getExistingPiRuntime(controls.sessionId, controls.userId), null);
    for (const copied of [{ kind: 'owned_accepted_chat_message' }, { ...controlA }, structuredClone(controlA)]) {
      await assert.rejects(execution.promoteOwnedQueuedChatMessage(copied as OwnedAcceptedChatMessage), denied);
      await assert.rejects(execution.cancelOwnedQueuedChatMessages([controlB, copied as OwnedAcceptedChatMessage]), denied);
      await assert.rejects(execution.resumeOwnedQueuedChatMessages([copied as OwnedAcceptedChatMessage]), denied);
    }
    const beforeForeign = await rows(controls), beforeForeignActor = await rows(foreign);
    await assert.rejects(execution.cancelOwnedQueuedChatMessages([controlA, foreignOwned]), denied);
    await assert.rejects(execution.resumeOwnedQueuedChatMessages([controlA, foreignOwned]), denied);
    assert.deepEqual(await rows(controls), beforeForeign); assert.deepEqual(await rows(foreign), beforeForeignActor);
    await execution.promoteOwnedQueuedChatMessage(controlC);
    const beforeStale = await rows(controls);
    await assert.rejects(execution.cancelOwnedQueuedChatMessages([await fresh('c', controls), controlA]), conflict);
    await assert.rejects(execution.resumeOwnedQueuedChatMessages([await fresh('a', controls), controlB]), conflict);
    assert.deepEqual(await rows(controls), beforeStale);
    const cancelled = await execution.cancelOwnedQueuedChatMessages([await fresh('a', controls), await fresh('b', controls)]);
    assert(Object.isFrozen(cancelled)); assert(cancelled.every(Object.isFrozen));
    assert.deepEqual(cancelled.map(value => value.clientMessageId).sort(), ['a', 'b']);
    for (const id of ['a', 'b']) await state(id, controls, 'cancelled', 3, { lane: 'prompt', ordinal: id === 'a' ? 1 : 2, disposition: 'suspended' });
    assert.equal(await runtime.getExistingPiRuntime(controls.sessionId, controls.userId), null);
    await execution.cancelOwnedQueuedChatMessages([await fresh('c', controls)]);

    stage = 'current Actor Use is required for every queue mutation';
    const useFrame = await newFrame();
    await admit('a', useFrame); const useB = await admit('b', useFrame);
    await execution.promoteOwnedQueuedChatMessage(useB);
    const useA = await fresh('a', useFrame), useReady = await fresh('b', useFrame), useBefore = await rows(useFrame);
    await sql(database => database.run('UPDATE "user" SET banned=1 WHERE id=$1', [useFrame.userId]));
    try {
      await assert.rejects(execution.promoteOwnedQueuedChatMessage(useReady), denied);
      await assert.rejects(execution.cancelOwnedQueuedChatMessages([useA, useReady]), denied);
      await assert.rejects(execution.resumeOwnedQueuedChatMessages([useA]), denied);
    } finally { await sql(database => database.run('UPDATE "user" SET banned=0 WHERE id=$1', [useFrame.userId])); }
    assert.deepEqual(await rows(useFrame), useBefore);
    const management = await import('../app/lib/agents/management-actions');
    const actor = { ...app.owner, source: 'api' as const };
    const inspected = await management.inspectManagedAgent(actor, frame.agentId);
    const removed = await management.removeManagedAgentGrant({ actor, agentId: frame.agentId, expectedRevision: inspected.agent.revision,
      targetType: 'user', targetId: useFrame.userId });
    try {
      await assert.rejects(execution.promoteOwnedQueuedChatMessage(useReady), denied);
      await assert.rejects(execution.cancelOwnedQueuedChatMessages([useA, useReady]), denied);
      await assert.rejects(execution.resumeOwnedQueuedChatMessages([useA]), denied);
    } finally { await management.setManagedAgentGrant({ actor, agentId: frame.agentId, expectedRevision: removed.agent.revision,
      targetType: 'user', targetId: useFrame.userId, canUse: true, canEdit: false, canManage: false }); }
    assert.deepEqual(await rows(useFrame), useBefore);

    stage = 'old durable queue-null rows require explicit initialization';
    const legacy = await newFrame(), legacyOwner = await runtime.getRegisteredPiRuntimeExecutionOwner(legacy.runtime);
    await admit('old-v1', legacy); const newMessage = await admit('new', legacy);
    await sql(database => database.run(`UPDATE pi_message_delivery_receipts SET queue_lane=NULL,queue_ordinal=NULL,queue_disposition=NULL
      WHERE client_message_id='old-v1' AND pi_session_db_id=(SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2)`, [legacy.userId, legacy.sessionId]));
    const oldUnpositioned = await fresh('old-v1', legacy);
    assert.equal(admission.readOwnedChatMessageExecutionSnapshot(oldUnpositioned).queue, null);
    await assert.rejects(execution.claimOwnedChatMessageExecution(newMessage, legacyOwner), conflict);
    await assert.rejects(execution.promoteOwnedQueuedChatMessage(oldUnpositioned), conflict);
    await execution.resumeOwnedQueuedChatMessages([oldUnpositioned]);
    await state('old-v1', legacy, 'queued', 2, { lane: 'prompt', ordinal: 3, disposition: 'ready' });
    const newClaim = await execution.claimOwnedChatMessageExecution(await fresh('new', legacy), legacyOwner);
    await execution.finishClaimedChatMessageExecution(newClaim, 'cancelled');
    const oldClaim = await execution.claimOwnedChatMessageExecution(await fresh('old-v1', legacy), legacyOwner);
    await execution.finishClaimedChatMessageExecution(oldClaim, 'cancelled');

    stage = 'an accepted legacy acknowledgement is not proof of completed execution';
    const legacyAck = await newFrame(), legacyAckOwner = await runtime.getRegisteredPiRuntimeExecutionOwner(legacyAck.runtime);
    await sql(database => database.run(`INSERT INTO pi_message_delivery_receipts
      (pi_session_db_id,client_message_id,payload_hash,runtime_token,state,created_at,updated_at)
      VALUES ((SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2),'old-accepted','legacy-intent-digest','legacy-runtime','accepted',$3,$3)`,
    [legacyAck.userId, legacyAck.sessionId, Date.now() - 1]));
    const afterLegacy = await admit('after-legacy', legacyAck);
    await assert.rejects(execution.claimOwnedChatMessageExecution(afterLegacy, legacyAckOwner), conflict);
    await state('after-legacy', legacyAck, 'queued', 1, { lane: 'prompt', ordinal: 1, disposition: 'ready' });

    stage = 'uncertain execution blocks the entire session after promotion';
    const unknown = await newFrame(), unknownOwner = await runtime.getRegisteredPiRuntimeExecutionOwner(unknown.runtime);
    const unknownRunning = await execution.startClaimedChatMessageExecution(await execution.claimOwnedChatMessageExecution(await admit('unknown', unknown), unknownOwner));
    await execution.finishClaimedChatMessageExecution(unknownRunning.claim, 'outcome_unknown');
    const blocked = await admit('blocked', unknown);
    await assert.rejects(execution.claimOwnedChatMessageExecution(blocked, unknownOwner), conflict);
    await execution.promoteOwnedQueuedChatMessage(blocked);
    await assert.rejects(execution.claimOwnedChatMessageExecution(await fresh('blocked', unknown), unknownOwner), conflict);
    await assert.rejects(execution.cancelOwnedQueuedChatMessages([await fresh('unknown', unknown)]), conflict);
    await state('unknown', unknown, 'outcome_unknown', 4, { lane: 'prompt', ordinal: 1, disposition: 'ready' });

    stage = 'queue metadata changes are strict state changes and invalid metadata is checked by SQL';
    const drift = await newFrame(); const driftOwned = await admit('drift', drift);
    await sql(database => database.run(`UPDATE pi_message_delivery_receipts SET queue_disposition='suspended'
      WHERE client_message_id='drift' AND pi_session_db_id=(SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2)`, [drift.userId, drift.sessionId]));
    await assert.rejects(execution.cancelOwnedQueuedChatMessages([driftOwned]), conflict);
    for (const assignment of ["queue_lane='invalid'", 'queue_ordinal=0', 'queue_ordinal=9007199254740992', 'queue_disposition=NULL']) {
      await assert.rejects(sql(database => database.run(`UPDATE pi_message_delivery_receipts SET ${assignment}
        WHERE client_message_id='drift' AND pi_session_db_id=(SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2)`, [drift.userId, drift.sessionId])), { code: '23514' });
    }
    await execution.resumeOwnedQueuedChatMessages([await fresh('drift', drift)]);

    stage = 'persistent session counter never reuses ordinals after receipt deletion';
    const counter = await newFrame(); await admit('deleted', counter);
    await execution.cancelOwnedQueuedChatMessages([await fresh('deleted', counter)]);
    await sql(database => database.run(`DELETE FROM pi_message_delivery_receipts
      WHERE client_message_id='deleted' AND pi_session_db_id=(SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2)`, [counter.userId, counter.sessionId]));
    await admit('after-deletion', counter);
    await state('after-deletion', counter, 'queued', 1, { lane: 'prompt', ordinal: 2, disposition: 'ready' });

    stage = 'exhausted safe ordinal range rejects admission and resume atomically';
    const exhausted = await newFrame(); await admit('unpositioned', exhausted);
    await sql(async database => {
      await database.run(`UPDATE pi_message_delivery_receipts SET queue_lane=NULL,queue_ordinal=NULL,queue_disposition=NULL
        WHERE client_message_id='unpositioned' AND pi_session_db_id=(SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2)`, [exhausted.userId, exhausted.sessionId]);
      await database.run('UPDATE pi_sessions SET message_queue_ordinal=9007199254740991 WHERE user_id=$1 AND session_id=$2', [exhausted.userId, exhausted.sessionId]);
    });
    const beforeExhausted = await rows(exhausted);
    await assert.rejects(execution.resumeOwnedQueuedChatMessages([await fresh('unpositioned', exhausted)]), conflict);
    const newPrepared = await prepare('cannot-allocate', exhausted); assert.equal(newPrepared.kind, 'prepared');
    if (newPrepared.kind !== 'prepared') throw new Error('Expected actual new admission at the counter limit.');
    await assert.rejects(admission.commitPreparedChatMessageAdmission(newPrepared.admission), { status: 409 });
    assert.deepEqual(await rows(exhausted), beforeExhausted);

    stage = 'delegated SQL mutation failure rolls back the entire queue batch';
    const atomic = await newFrame(); const atomicA = await admit('a', atomic), atomicB = await admit('b', atomic);
    const beforeAtomic = await rows(atomic), originalOpen = app.database.openDb;
    const mutationFault = new Error('Actual first queue CAS response lost before the batch completes.');
    let mutated = false;
    app.database.openDb = async () => {
      const actual = await originalOpen();
      return { ...actual, get: async (query, params = []) => {
        const value = await actual.get(query, params);
        if (!mutated && /UPDATE\s+pi_message_delivery_receipts/iu.test(query) && params.includes('a')) { mutated = true; throw mutationFault; }
        return value;
      } };
    };
    try { await assert.rejects(execution.cancelOwnedQueuedChatMessages([atomicA, atomicB]), error => error === mutationFault); }
    finally { app.database.openDb = originalOpen; }
    assert(mutated); assert.deepEqual(await rows(atomic), beforeAtomic);

    stage = 'actual queue COMMIT response loss confirms exact metadata without repeating mutation';
    for (const operation of ['promote', 'resume', 'cancel'] as const) {
      const active = await newFrame(); await admit('a', active); await admit('b', active);
      if (operation === 'resume') await execution.promoteOwnedQueuedChatMessage(await fresh('b', active));
      const selected = operation === 'promote' ? [await fresh('b', active)] : operation === 'resume' ? [await fresh('a', active)]
        : [await fresh('a', active), await fresh('b', active)];
      const before = await rows(active), acknowledgementLost = new Error(`Actual queue ${operation} COMMIT reply lost.`);
      let committed = false, discarded = 0, updates = 0;
      app.database.openDb = async () => {
        const actual = await originalOpen(); let wrote = false;
        return { ...actual, get: async (query, params = []) => {
          const value = await actual.get(query, params);
          if (/UPDATE\s+pi_message_delivery_receipts/iu.test(query)) { wrote = true; updates++; }
          return value;
        }, run: async (query, params = []) => {
          const value = await actual.run(query, params);
          if (!committed && wrote && query.trim() === 'COMMIT') { committed = true; throw acknowledgementLost; }
          return value;
        }, close: error => { if (error) discarded++; return actual.close(error); } };
      };
      try {
        if (operation === 'promote') await execution.promoteOwnedQueuedChatMessage(selected[0]);
        else if (operation === 'resume') await execution.resumeOwnedQueuedChatMessages(selected);
        else await execution.cancelOwnedQueuedChatMessages(selected);
      } finally { app.database.openDb = originalOpen; }
      assert(committed && updates > 0); assert.equal(discarded, 1);
      for (const beforeRow of before) unchangedIntent(beforeRow, await row(beforeRow.client_message_id, active));
      if (operation === 'promote') {
        await state('a', active, 'queued', 2, { lane: 'prompt', ordinal: 1, disposition: 'suspended' });
        await state('b', active, 'queued', 2, { lane: 'steer', ordinal: 2, disposition: 'ready' });
      } else if (operation === 'resume') await state('a', active, 'queued', 3, { lane: 'prompt', ordinal: 1, disposition: 'ready' });
      else for (const id of ['a', 'b']) await state(id, active, 'cancelled', 2, { lane: 'prompt', ordinal: id === 'a' ? 1 : 2, disposition: 'ready' });
      await assert.rejects(execution.cancelOwnedQueuedChatMessages([selected[0]]), conflict);
    }

    stage = 'lost promotion ACK cannot confirm only the target when a suspended sibling changed';
    const vector = await newFrame(); await admit('a', vector); const vectorTarget = await admit('b', vector);
    const vectorAcknowledgementLost = new Error('Actual promotion COMMIT reply lost after a sibling was publicly resumed.');
    let promotionCommitted = false, siblingResumed = false, vectorDiscarded = 0;
    app.database.openDb = async () => {
      const actual = await originalOpen(); let wrote = false;
      return { ...actual, get: async (query, params = []) => {
        const value = await actual.get(query, params);
        if (/UPDATE\s+pi_message_delivery_receipts/iu.test(query)) wrote = true;
        return value;
      }, run: async (query, params = []) => {
        const value = await actual.run(query, params);
        if (!promotionCommitted && wrote && query.trim() === 'COMMIT') {
          promotionCommitted = true;
          await execution.resumeOwnedQueuedChatMessages([await fresh('a', vector)]); siblingResumed = true;
          throw vectorAcknowledgementLost;
        }
        return value;
      }, close: error => { if (error) vectorDiscarded++; return actual.close(error); } };
    };
    try { await assert.rejects(execution.promoteOwnedQueuedChatMessage(vectorTarget), { code: 'MESSAGE_EXECUTION_UNCERTAIN', status: 409 }); }
    finally { app.database.openDb = originalOpen; }
    assert(promotionCommitted && siblingResumed); assert.equal(vectorDiscarded, 1);
    await state('a', vector, 'queued', 3, { lane: 'prompt', ordinal: 1, disposition: 'ready' });
    await state('b', vector, 'queued', 2, { lane: 'steer', ordinal: 2, disposition: 'ready' });

    if (native) {
      stage = 'native claim versus cancel has exactly one real SQL winner';
      const claimRace = await newFrame(), claimRaceOwner = await runtime.getRegisteredPiRuntimeExecutionOwner(claimRace.runtime);
      const claimRaceMessage = await admit('a', claimRace);
      const claimResults = await Promise.allSettled([
        execution.claimOwnedChatMessageExecution(claimRaceMessage, claimRaceOwner),
        execution.cancelOwnedQueuedChatMessages([claimRaceMessage]),
      ]);
      assert.equal(claimResults.filter(result => result.status === 'fulfilled').length, 1);
      for (const result of claimResults) if (result.status === 'rejected') {
        assert.equal(result.reason?.code, conflict.code); assert.equal(result.reason?.status, conflict.status);
      }
      if (claimResults[0].status === 'fulfilled') {
        await state('a', claimRace, 'dispatching', 2, { lane: 'prompt', ordinal: 1, disposition: 'ready' });
        await execution.finishClaimedChatMessageExecution(claimResults[0].value, 'cancelled');
      } else await state('a', claimRace, 'cancelled', 2, { lane: 'prompt', ordinal: 1, disposition: 'ready' });

      stage = 'native cancel batch versus resume cannot leave a partial batch';
      const batchRace = await newFrame(); await admit('b', batchRace); const later = await admit('c', batchRace);
      await execution.promoteOwnedQueuedChatMessage(later);
      await execution.cancelOwnedQueuedChatMessages([await fresh('c', batchRace)]);
      const batchA = await admit('a', batchRace), batchB = await fresh('b', batchRace), beforeBatchRace = await rows(batchRace);
      await state('a', batchRace, 'queued', 1, { lane: 'prompt', ordinal: 3, disposition: 'ready' });
      await state('b', batchRace, 'queued', 2, { lane: 'prompt', ordinal: 1, disposition: 'suspended' });
      const batchResults = await Promise.allSettled([
        execution.cancelOwnedQueuedChatMessages([batchA, batchB]), execution.resumeOwnedQueuedChatMessages([batchB]),
      ]);
      assert.equal(batchResults.filter(result => result.status === 'fulfilled').length, 1);
      for (const result of batchResults) if (result.status === 'rejected') {
        assert.equal(result.reason?.code, conflict.code); assert.equal(result.reason?.status, conflict.status);
      }
      if (batchResults[0].status === 'fulfilled') {
        await state('a', batchRace, 'cancelled', 2, { lane: 'prompt', ordinal: 3, disposition: 'ready' });
        await state('b', batchRace, 'cancelled', 3, { lane: 'prompt', ordinal: 1, disposition: 'suspended' });
      } else {
        await state('a', batchRace, 'queued', 1, { lane: 'prompt', ordinal: 3, disposition: 'ready' });
        await state('b', batchRace, 'queued', 3, { lane: 'prompt', ordinal: 1, disposition: 'ready' });
      }
      for (const before of beforeBatchRace) unchangedIntent(before, await row(before.client_message_id, batchRace));

      stage = 'failed native queue rollback discards the actual SQL lease without replay';
      const active = await newFrame(); const a = await admit('a', active), b = await admit('b', active), before = await rows(active);
      const updateFault = new Error('Actual native queue CAS response lost.'), rollbackFault = new Error('Queue ROLLBACK failed before delegation.');
      let updated = false, rollbackFailed = false, discardedPid = 0, discardError: Error | undefined, readsAfterRollback = 0;
      app.database.openDb = async () => {
        const actual = await originalOpen(); let wrote = false;
        return { ...actual, get: async (query, params = []) => {
          if (rollbackFailed) readsAfterRollback++;
          const value = await actual.get(query, params);
          if (!updated && /UPDATE\s+pi_message_delivery_receipts/iu.test(query)) {
            wrote = true; updated = true; discardedPid = Number((await actual.get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid); throw updateFault;
          }
          return value;
        }, run: async (query, params = []) => {
          if (wrote && query.trim() === 'ROLLBACK') { rollbackFailed = true; throw rollbackFault; }
          return actual.run(query, params);
        }, close: error => { if (wrote) discardError = error; return actual.close(error); } };
      };
      try { await assert.rejects(execution.cancelOwnedQueuedChatMessages([a, b]), error => {
        assert(error instanceof AggregateError && error.errors.includes(updateFault) && error.errors.includes(rollbackFault)); return true;
      }); } finally { app.database.openDb = originalOpen; }
      assert(updated && rollbackFailed && discardedPid > 0 && discardError); assert.equal(discardError.cause, rollbackFault); assert.equal(readsAfterRollback, 0);
      await sql(async database => {
        const current = await database.get('SELECT pg_backend_pid() AS pid,txid_current_if_assigned()::text AS tx') as { pid: number; tx: string | null };
        assert.notEqual(current.pid, discardedPid); assert.equal(current.tx, null);
      });
      assert.deepEqual(await rows(active), before);
    }
    assert.equal(fixture.counts().forbiddenModelRequests, 0); assert.equal(fixture.counts().externalRequests, 0);
    assert.equal(Number((await sql(database => database.get('SELECT COUNT(*) AS count FROM pi_messages')) as { count: number }).count), 0);
    assert.equal(Number((await sql(database => database.get('SELECT COUNT(*) AS count FROM file_agent_turns')) as { count: number }).count), 0);
    console.log(`PASS durable message queue SQL (${native ? 'actual PostgreSQL pool2' : 'actual PGlite'}): three lanes, global FIFO, promotion/suspension, explicit resume, queue-null/unknown blockers, atomic strict batches, current Use, immutable intent, exact COMMIT-loss recovery; no model/business execution or automatic replay.`);
  } catch (error) { console.error(`Durable queue SQL stage: ${stage}`); throw error; }
  finally { await fixture.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
