import assert from 'node:assert/strict';
import type { SqlConnection } from '../app/lib/db';
import type { OwnedAcceptedChatMessage } from '../app/lib/pi/durable-message-admission';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';

type Execution = typeof import('../app/lib/pi/durable-message-execution');
type Claim = Awaited<ReturnType<Execution['claimOwnedChatMessageExecution']>>;
type Frame = Awaited<ReturnType<Awaited<ReturnType<typeof createDurableMessageExecutionFixture>>['createSessionRuntime']>>;
type Receipt = { execution_phase: string; execution_revision: number; runtime_token: string; payload_hash: string; private_payload: string };

/** Actual runtime registry, SQL admission/CAS and current Use. Only delegated
 * SQL transport faults and owned metadata HTTP are controlled. No model turn,
 * execution-owner issuer, source verdict or execution service is replaced. */
async function main(): Promise<void> {
  const native = process.argv.includes('--native');
  const fixture = await createDurableMessageExecutionFixture({ native, ...(native ? { nativePoolMax: 2 } : {}) });
  const app = fixture.application;
  const sql = async <T>(operation: (database: SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await app.database.openDb();
    try { return await operation(database); } finally { await database.close(); }
  };
  let stage = 'actual runtime and admitted messages';
  try {
    const admission = await import('../app/lib/pi/durable-message-admission');
    const execution = await import('../app/lib/pi/durable-message-execution');
    const runtime = fixture.runtimeApi;
    const frame = await fixture.createSessionRuntime({ userId: 'alice' });
    const peer = await fixture.createSessionRuntime({ userId: 'alice', agentId: frame.agentId });
    const foreign = await fixture.createSessionRuntime({ userId: 'bob', agentId: frame.agentId });
    const owner = await runtime.getRegisteredPiRuntimeExecutionOwner(frame.runtime);
    const peerOwner = await runtime.getRegisteredPiRuntimeExecutionOwner(peer.runtime);
    const foreignOwner = await runtime.getRegisteredPiRuntimeExecutionOwner(foreign.runtime);
    const ownerData = await runtime.readRegisteredPiRuntimeExecutionOwner(owner);
    assert.equal(await runtime.getRegisteredPiRuntimeExecutionOwner(frame.runtime), owner);
    assert.deepEqual({ userId: ownerData.userId, sessionId: ownerData.sessionId, agentId: ownerData.agentId, workspaceId: ownerData.workspaceId },
      { userId: frame.userId, sessionId: frame.sessionId, agentId: frame.agentId, workspaceId: frame.context.workspaceId });
    const identity = (active: Frame, clientMessageId: string) => ({ userId: active.userId, sessionId: active.sessionId, clientMessageId,
      expectedAgentId: active.agentId, expectedWorkspaceId: active.context.workspaceId });
    const admit = async (clientMessageId: string, active = frame) => {
      const result = await admission.prepareChatMessageAdmission({ ...identity(active, clientMessageId),
        message: { role: 'user', content: `Actual durable execution ${clientMessageId}.`, timestamp: 100 } });
      assert.equal(result.kind, 'prepared');
      if (result.kind !== 'prepared') throw new Error('Expected actual new SQL admission.');
      return admission.commitPreparedChatMessageAdmission(result.admission);
    };
    const fresh = async (clientMessageId: string, active = frame) => {
      const value = await admission.readOwnedAcceptedChatMessage(identity(active, clientMessageId)); assert(value); return value;
    };
    const row = async (clientMessageId: string, active = frame) => {
      const value = await sql(database => database.get(`SELECT execution_phase,execution_revision,runtime_token,payload_hash,private_payload
        FROM pi_message_delivery_receipts WHERE client_message_id=$1 AND pi_session_db_id=(SELECT id FROM pi_sessions WHERE user_id=$2 AND session_id=$3)`,
      [clientMessageId, active.userId, active.sessionId])) as Receipt | undefined;
      assert(value); return value;
    };
    const phase = async (id: string, expected: string, revision: number, active = frame) => {
      const actual = await row(id, active); assert.equal(actual.execution_phase, expected); assert.equal(actual.execution_revision, revision); return actual;
    };
    const conflict = { code: 'MESSAGE_EXECUTION_CONFLICT', status: 409 };
    const denied = { code: 'AGENT_MESSAGE_EXECUTION_DENIED', status: 403 };
    const ownerChanged = { code: 'AGENT_MESSAGE_EXECUTION_OWNER_CHANGED', status: 409 };

    stage = 'genuine ownership and clone rejection';
    const first = await admit('first'), second = await admit('second');
    for (const copied of [{ kind: 'registered_pi_runtime_execution_owner' }, { ...owner }, structuredClone(owner)]) {
      await assert.rejects(runtime.readRegisteredPiRuntimeExecutionOwner(copied as typeof owner), ownerChanged);
      await assert.rejects(execution.claimOwnedChatMessageExecution(first, copied as typeof owner), denied);
    }
    for (const copied of [{ kind: 'owned_accepted_chat_message' }, { ...first }, structuredClone(first)]) {
      await assert.rejects(execution.claimOwnedChatMessageExecution(copied as OwnedAcceptedChatMessage, owner), denied);
    }
    await assert.rejects(execution.claimOwnedChatMessageExecution(first, peerOwner), denied);
    await assert.rejects(execution.claimOwnedChatMessageExecution(first, foreignOwner), denied);
    await phase('first', 'queued', 1); await phase('second', 'queued', 1);

    stage = 'one-shot phase transitions and session exclusivity';
    const claimed = await execution.claimOwnedChatMessageExecution(first, owner);
    const dispatching = await phase('first', 'dispatching', 2);
    const dispatchingMessage = await fresh('first');
    assert(dispatching.runtime_token !== ownerData.token && dispatching.runtime_token !== 'unclaimed',
      'SQL records a distinct attempt identity, not the runtime registration token.');
    await assert.rejects(execution.claimOwnedChatMessageExecution(first, owner), conflict);
    await assert.rejects(execution.claimOwnedChatMessageExecution(await fresh('first'), owner), conflict);
    await assert.rejects(execution.claimOwnedChatMessageExecution(second, owner), conflict);
    await phase('second', 'queued', 1);
    for (const copied of [{ kind: 'chat_message_execution_claim' }, { ...claimed }, structuredClone(claimed)]) {
      await assert.rejects(execution.startClaimedChatMessageExecution(copied as Claim), denied);
      await assert.rejects(execution.finishClaimedChatMessageExecution(copied as Claim, 'cancelled'), denied);
    }
    await assert.rejects(execution.finishClaimedChatMessageExecution(claimed, 'succeeded'), conflict);
    await assert.rejects(execution.finishClaimedChatMessageExecution(claimed, 'outcome_unknown'), conflict);
    const peerMessage = await admit('independent-session', peer);
    const peerClaim = await execution.claimOwnedChatMessageExecution(peerMessage, peerOwner);
    await execution.finishClaimedChatMessageExecution(peerClaim, 'cancelled');
    await phase('independent-session', 'cancelled', 3, peer);
    const started = await execution.startClaimedChatMessageExecution(claimed);
    await phase('first', 'running', 3);
    const runningData = admission.readOwnedAcceptedChatMessageData(started.message, frame.context);
    assert.equal(runningData.phase, 'running'); assert.equal(runningData.executionRevision, 3);
    stage = 'genuine running-Owned handoff to current extension source reissue';
    const turnContext = { ...frame.context, agentTurnId: runningData.payload.serverMessageId };
    const packages = await import('../app/lib/capabilities/packages/runtime-bindings');
    const turn = await import('../app/lib/capabilities/extensions/turn-runtime');
    const packageSelection = await packages.getAuthorizedAgentWorkflowPackageSelections(turnContext);
    assert.equal(await turn.reissueOwnedChatMessageRuntimeSelection(turnContext, started.message, { packageSelection }), null,
      'The actual running SQL Owned handle reaches the genuine source reissuer for a fixed-empty Agent without extra turn selections.');
    for (const stale of [first, dispatchingMessage]) {
      await assert.rejects(turn.reissueOwnedChatMessageRuntimeSelection(turnContext, stale, { packageSelection }),
        { code: 'AGENT_EXTENSION_CONTEXT_DENIED', status: 403 });
    }
    await phase('first', 'running', 3);
    stage = 'one-shot phase transitions and session exclusivity';
    await assert.rejects(execution.startClaimedChatMessageExecution(claimed), conflict);
    await assert.rejects(execution.startClaimedChatMessageExecution(started.claim), conflict);
    const settled = await execution.finishClaimedChatMessageExecution(started.claim, 'succeeded');
    assert(Object.isFrozen(settled)); assert.equal(settled.kind, 'chat_message_execution_settlement');
    assert.equal(settled.phase, 'succeeded'); assert.equal(settled.executionRevision, 4);
    assert.deepEqual(await execution.finishClaimedChatMessageExecution(started.claim, 'succeeded'), settled);
    await phase('first', 'succeeded', 4);
    await assert.rejects(execution.finishClaimedChatMessageExecution(started.claim, 'failed'), conflict);
    await assert.rejects(execution.claimOwnedChatMessageExecution(await fresh('first'), owner), conflict);
    const secondClaim = await execution.claimOwnedChatMessageExecution(await fresh('second'), owner);
    await execution.finishClaimedChatMessageExecution(secondClaim, 'failed'); await phase('second', 'failed', 3);
    for (const outcome of ['failed', 'cancelled', 'outcome_unknown'] as const) {
      const id = `terminal-${outcome}`;
      const activeFrame = outcome === 'outcome_unknown'
        ? await fixture.createSessionRuntime({ userId: 'alice', agentId: frame.agentId }) : frame;
      const activeOwner = outcome === 'outcome_unknown' ? await runtime.getRegisteredPiRuntimeExecutionOwner(activeFrame.runtime) : owner;
      const current = await execution.claimOwnedChatMessageExecution(await admit(id, activeFrame), activeOwner);
      const running = await execution.startClaimedChatMessageExecution(current);
      await execution.finishClaimedChatMessageExecution(running.claim, outcome);
      await phase(id, outcome, 4, activeFrame);
    }

    stage = 'fresh Use on claim/start and genuine terminal bookkeeping after revocation';
    const claimDeniedMessage = await admit('claim-denied');
    await sql(database => database.run('UPDATE "user" SET banned=1 WHERE id=$1', [frame.userId]));
    try { await assert.rejects(execution.claimOwnedChatMessageExecution(claimDeniedMessage, owner), denied); }
    finally { await sql(database => database.run('UPDATE "user" SET banned=0 WHERE id=$1', [frame.userId])); }
    await phase('claim-denied', 'queued', 1);
    await execution.cancelOwnedQueuedChatMessages([await fresh('claim-denied')]);
    const startDenied = await execution.claimOwnedChatMessageExecution(await admit('start-denied'), owner);
    await sql(database => database.run("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [frame.context.workspaceId]));
    try {
      await assert.rejects(execution.startClaimedChatMessageExecution(startDenied), denied);
      await execution.finishClaimedChatMessageExecution(startDenied, 'cancelled');
      await phase('start-denied', 'cancelled', 3);
    } finally { await sql(database => database.run("UPDATE canvas_workspaces SET status='active' WHERE id=$1", [frame.context.workspaceId])); }
    const revokedFrame = await fixture.createSessionRuntime({ userId: 'alice', agentId: frame.agentId });
    const revokedOwner = await runtime.getRegisteredPiRuntimeExecutionOwner(revokedFrame.runtime);
    const revoked = await execution.startClaimedChatMessageExecution(await execution.claimOwnedChatMessageExecution(await admit('finish-revoked', revokedFrame), revokedOwner));
    const management = await import('../app/lib/agents/management-actions');
    const actor = { ...app.owner, source: 'api' as const };
    const inspected = await management.inspectManagedAgent(actor, frame.agentId);
    const removed = await management.removeManagedAgentGrant({ actor, agentId: frame.agentId, expectedRevision: inspected.agent.revision,
      targetType: 'user', targetId: frame.userId });
    try {
      await execution.finishClaimedChatMessageExecution(revoked.claim, 'outcome_unknown');
      await phase('finish-revoked', 'outcome_unknown', 4, revokedFrame);
    } finally { await management.setManagedAgentGrant({ actor, agentId: frame.agentId, expectedRevision: removed.agent.revision,
      targetType: 'user', targetId: frame.userId, canUse: true, canEdit: false, canManage: false }); }

    stage = 'disposed and replaced actual runtime registrations';
    const staleClaim = await execution.claimOwnedChatMessageExecution(await admit('old-owner-claimed'), owner);
    const staleMessage = await admit('old-owner');
    await runtime.invalidatePiRuntime(frame.sessionId, frame.userId);
    await assert.rejects(runtime.readRegisteredPiRuntimeExecutionOwner(owner), ownerChanged);
    await assert.rejects(execution.claimOwnedChatMessageExecution(staleMessage, owner), denied);
    await assert.rejects(execution.startClaimedChatMessageExecution(staleClaim), denied);
    await execution.finishClaimedChatMessageExecution(staleClaim, 'cancelled');
    await phase('old-owner-claimed', 'cancelled', 3);
    const replacement = await fixture.createSessionRuntime({ userId: frame.userId, sessionId: frame.sessionId, agentId: frame.agentId });
    assert.notEqual(replacement.runtime, frame.runtime);
    const replacementOwner = await runtime.getRegisteredPiRuntimeExecutionOwner(replacement.runtime);
    assert((await runtime.readRegisteredPiRuntimeExecutionOwner(replacementOwner)).token !== ownerData.token);
    const replacementClaim = await execution.claimOwnedChatMessageExecution(await fresh('old-owner'), replacementOwner);
    await execution.finishClaimedChatMessageExecution(replacementClaim, 'cancelled');

    stage = 'owner/Use loss after actual COMMIT and before acknowledgement';
    for (const operation of ['claim', 'start'] as const) for (const loss of ['owner', 'grant'] as const) for (const loseAcknowledgement of [false, true]) {
      const activeFrame = await fixture.createSessionRuntime({ userId: 'alice', agentId: frame.agentId });
      const activeOwner = await runtime.getRegisteredPiRuntimeExecutionOwner(activeFrame.runtime);
      const id = `late-${operation}-${loss}-${loseAcknowledgement ? 'lost' : 'ack'}`;
      const admitted = await admit(id, activeFrame);
      const beforeStart = operation === 'start' ? await execution.claimOwnedChatMessageExecution(admitted, activeOwner) : undefined;
      const originalOpen = app.database.openDb;
      let revokedAtCommit = false;
      let discarded = 0;
      const acknowledgementLost = new Error(`Actual ${operation} COMMIT acknowledgement lost after ${loss} loss.`);
      let removedGrant: Awaited<ReturnType<typeof management.removeManagedAgentGrant>> | undefined;
      app.database.openDb = async () => {
        const actual = await originalOpen(); let mutated = false;
        return { ...actual,
          get: async (query, params = []) => {
            const value = await actual.get(query, params);
            if (/UPDATE\s+pi_message_delivery_receipts/iu.test(query) && params.includes(id)) mutated = true;
            return value;
          },
          close: error => { if (error) discarded++; return actual.close(error); },
          run: async (query, params = []) => {
            const value = await actual.run(query, params);
            if (revokedAtCommit || !mutated || query.trim() !== 'COMMIT') return value;
            revokedAtCommit = true;
            if (loss === 'owner') await runtime.invalidatePiRuntime(activeFrame.sessionId, activeFrame.userId);
            else {
              const current = await management.inspectManagedAgent(actor, activeFrame.agentId);
              removedGrant = await management.removeManagedAgentGrant({ actor, agentId: activeFrame.agentId,
                expectedRevision: current.agent.revision, targetType: 'user', targetId: activeFrame.userId });
            }
            if (loseAcknowledgement) throw acknowledgementLost;
            return value;
          },
        };
      };
      try {
        await assert.rejects(operation === 'claim' ? execution.claimOwnedChatMessageExecution(admitted, activeOwner)
          : execution.startClaimedChatMessageExecution(beforeStart!), denied);
      } finally {
        app.database.openDb = originalOpen;
        if (removedGrant) await management.setManagedAgentGrant({ actor, agentId: activeFrame.agentId, expectedRevision: removedGrant.agent.revision,
          targetType: 'user', targetId: activeFrame.userId, canUse: true, canEdit: false, canManage: false });
      }
      assert(revokedAtCommit, 'The real COMMIT completed before owner/Use was revoked during its acknowledgement await.');
      assert.equal(discarded, loseAcknowledgement ? 1 : 0);
      await phase(id, 'cancelled', operation === 'claim' ? 3 : 4, activeFrame);
    }

    stage = 'actual COMMIT acknowledgement loss and exact target confirmation';
    for (const operation of ['claim', 'start', 'finish'] as const) {
      const id = `commit-lost-${operation}`;
      const initial = await admit(id, peer);
      let active: Claim | undefined;
      if (operation !== 'claim') active = await execution.claimOwnedChatMessageExecution(initial, peerOwner);
      if (operation === 'finish') active = (await execution.startClaimedChatMessageExecution(active!)).claim;
      const originalOpen = app.database.openDb;
      const acknowledgementLost = new Error(`Actual ${operation} COMMIT acknowledgement lost.`);
      let committed = false, mutations = 0, discarded = 0;
      app.database.openDb = async () => {
        const actual = await originalOpen(); let mutated = false;
        const observe = (query: string, params: readonly unknown[]) => {
          if (/UPDATE\s+pi_message_delivery_receipts/iu.test(query) && params.includes(id)) { mutated = true; mutations++; }
        };
        return { ...actual,
          get: async (query, params = []) => { const value = await actual.get(query, params); observe(query, params); return value; },
          run: async (query, params = []) => {
            const value = await actual.run(query, params); observe(query, params);
            if (!committed && mutated && query.trim() === 'COMMIT') { committed = true; throw acknowledgementLost; }
            return value;
          },
          close: error => { if (error) discarded++; return actual.close(error); },
        };
      };
      try {
        if (operation === 'claim') active = await execution.claimOwnedChatMessageExecution(initial, peerOwner);
        else if (operation === 'start') active = (await execution.startClaimedChatMessageExecution(active!)).claim;
        else await execution.finishClaimedChatMessageExecution(active!, 'succeeded');
      } finally { app.database.openDb = originalOpen; }
      assert(committed, 'The actual COMMIT ran before its response was lost.'); assert.equal(mutations, 1);
      assert.equal(discarded, 1, 'The failed transaction lease must be discarded before fresh target confirmation.');
      await phase(id, operation === 'claim' ? 'dispatching' : operation === 'start' ? 'running' : 'succeeded', operation === 'claim' ? 2 : operation === 'start' ? 3 : 4, peer);
      if (operation !== 'finish') await execution.finishClaimedChatMessageExecution(active!, 'cancelled');
    }

    if (native) {
      stage = 'a different same-owner claim cannot confirm a rejected COMMIT';
      const id = 'different-attempt-token';
      const originalMessage = await admit(id, peer), originalOpen = app.database.openDb;
      const commitRejected = new Error('Actual COMMIT was not sent; its connection is discarded.');
      let rejectedBeforeCommit = false, firstAttemptToken = '', competingClaim: Claim | undefined;
      let firstDiscarded = false;
      app.database.openDb = async () => {
        const actual = await originalOpen(); let mutated = false;
        return { ...actual,
          get: async (query, params = []) => {
            const result = await actual.get(query, params);
            if (!rejectedBeforeCommit && /UPDATE\s+pi_message_delivery_receipts/iu.test(query) && params.includes(id)) {
              mutated = true;
              firstAttemptToken = String((await actual.get(`SELECT runtime_token FROM pi_message_delivery_receipts WHERE client_message_id=$1
                AND pi_session_db_id=(SELECT id FROM pi_sessions WHERE session_id=$2 AND user_id=$3)`, [id, peer.sessionId, peer.userId]) as { runtime_token: string }).runtime_token);
            }
            return result;
          },
          run: async (query, params = []) => {
            if (mutated && !rejectedBeforeCommit && query.trim() === 'COMMIT') { rejectedBeforeCommit = true; throw commitRejected; }
            return actual.run(query, params);
          },
          close: async error => {
            await actual.close(error);
            if (!mutated || !rejectedBeforeCommit || firstDiscarded) return;
            firstDiscarded = true; assert(error);
            app.database.openDb = originalOpen;
            await phase(id, 'queued', 1, peer);
            competingClaim = await execution.claimOwnedChatMessageExecution(await fresh(id, peer), peerOwner);
          },
        };
      };
      try { await assert.rejects(execution.claimOwnedChatMessageExecution(originalMessage, peerOwner), { code: 'MESSAGE_EXECUTION_UNCERTAIN', status: 409 }); }
      finally { app.database.openDb = originalOpen; }
      assert(rejectedBeforeCommit && firstDiscarded && competingClaim);
      assert((await phase(id, 'dispatching', 2, peer)).runtime_token !== firstAttemptToken,
        'A second actual claim by the same runtime has a different SQL attempt token.');
      await execution.finishClaimedChatMessageExecution(competingClaim, 'cancelled');

      stage = 'failed native ROLLBACK discards the actual CAS lease';
      const discardId = 'rollback-discard';
      const discardMessage = await admit(discardId, peer);
      const updateFault = new Error('Actual CAS succeeded but its response was lost.');
      const rollbackFault = new Error('ROLLBACK transport failed before delegation.');
      let updated = false, rollbackFailed = false, discardedPid = 0, discardError: Error | undefined, readsAfterRollback = 0;
      app.database.openDb = async () => {
        const actual = await originalOpen(); let mutated = false;
        return { ...actual,
          get: async (query, params = []) => {
            if (rollbackFailed) readsAfterRollback++;
            const result = await actual.get(query, params);
            if (!updated && /UPDATE\s+pi_message_delivery_receipts/iu.test(query) && params.includes(discardId)) {
              mutated = true; updated = true;
              discardedPid = Number((await actual.get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid);
              throw updateFault;
            }
            return result;
          },
          run: async (query, params = []) => {
            if (mutated && query.trim() === 'ROLLBACK') { rollbackFailed = true; throw rollbackFault; }
            return actual.run(query, params);
          },
          close: error => { if (mutated) discardError = error; return actual.close(error); },
        };
      };
      try {
        await assert.rejects(execution.claimOwnedChatMessageExecution(discardMessage, peerOwner), error => {
          assert(error instanceof AggregateError && error.errors.includes(updateFault) && error.errors.includes(rollbackFault)); return true;
        });
      } finally { app.database.openDb = originalOpen; }
      assert(updated && rollbackFailed && discardedPid > 0); assert(discardError);
      assert.equal(Reflect.get(discardError, 'cause'), rollbackFault); assert.equal(readsAfterRollback, 0);
      await sql(async database => {
        const current = await database.get('SELECT pg_backend_pid() AS pid,txid_current_if_assigned()::text AS tx') as { pid: number; tx: string | null };
        assert.notEqual(current.pid, discardedPid); assert.equal(current.tx, null);
      });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const current = await sql(database => database.get('SELECT COUNT(*)::integer AS count FROM pg_stat_activity WHERE pid=$1', [discardedPid])) as { count: number };
        if (current.count === 0) break;
        assert(Date.now() < deadline, 'The discarded backend must close and roll back.');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await phase(discardId, 'queued', 1, peer);
      await execution.cancelOwnedQueuedChatMessages([await fresh(discardId, peer)]);

      stage = 'two actual processes serialize same and different SQL message claims';
      const { runDurableExecutionClaimRace } = await import('./helpers/durable-message-execution-workers');
      for (const ids of [['worker-a', 'worker-b'], ['worker-same', 'worker-same']] as const) {
        for (const messageId of new Set(ids)) await admit(messageId, peer);
        const raced = await runDurableExecutionClaimRace({ fixture, session: { userId: peer.userId, sessionId: peer.sessionId, agentId: peer.agentId }, clientMessageIds: ids });
        assert.equal(raced.outcomes.filter(value => value.outcome === 'claimed').length, 1);
        assert.equal(raced.outcomes.filter(value => value.outcome === 'conflict').length, 1);
        for (const queued of raced.afterSettlement.filter(value => value.phase === 'queued')) {
          await execution.cancelOwnedQueuedChatMessages([await fresh(queued.clientMessageId, peer)]);
        }
      }

      stage = 'discard failure never confirms or retries a committed claim';
      const failedFrame = await fixture.createSessionRuntime({ userId: 'alice', agentId: frame.agentId });
      const failedOwner = await runtime.getRegisteredPiRuntimeExecutionOwner(failedFrame.runtime);
      const failedId = 'discard-error';
      const failedMessage = await admit(failedId, failedFrame);
      const commitReplyLost = new Error('Actual COMMIT response lost before a failed discard.');
      const discardFault = new Error('Discard acknowledgement failed after actual native release.');
      let commitExecuted = false, discardAttempted = false, laterCheckouts = 0;
      app.database.openDb = async () => {
        if (discardAttempted) laterCheckouts++;
        const actual = await originalOpen(); let mutated = false;
        return { ...actual,
          get: async (query, params = []) => {
            const result = await actual.get(query, params);
            if (/UPDATE\s+pi_message_delivery_receipts/iu.test(query) && params.includes(failedId)) mutated = true;
            return result;
          },
          run: async (query, params = []) => {
            const result = await actual.run(query, params);
            if (mutated && !commitExecuted && query.trim() === 'COMMIT') { commitExecuted = true; throw commitReplyLost; }
            return result;
          },
          close: async error => {
            await actual.close(error);
            if (mutated && error) { discardAttempted = true; throw discardFault; }
          },
        };
      };
      try {
        await assert.rejects(execution.claimOwnedChatMessageExecution(failedMessage, failedOwner), error => {
          assert(error instanceof AggregateError && error.errors.includes(commitReplyLost) && error.errors.includes(discardFault)); return true;
        });
      } finally { app.database.openDb = originalOpen; }
      assert(commitExecuted && discardAttempted); assert.equal(laterCheckouts, 0, 'A failed discard cannot trigger recovery reads or a repeated claim.');
      await phase(failedId, 'dispatching', 2, failedFrame);
      await assert.rejects(execution.claimOwnedChatMessageExecution(await fresh(failedId, failedFrame), failedOwner), conflict);
    }
    const counts = fixture.counts(); assert.equal(counts.forbiddenModelRequests, 0); assert.equal(counts.externalRequests, 0);
    assert.equal((await sql(database => database.all('SELECT id FROM pi_messages'))).length, 0);
    assert.equal(Number((await sql(database => database.get('SELECT COUNT(*) AS count FROM file_agent_turns')) as { count: number }).count), 0);
    console.log(`PASS durable message execution SQL (${native ? 'actual PostgreSQL pool2' : 'actual PGlite'}): genuine registered runtime owners, one-shot phase/revision CAS, session exclusivity, fresh Use, stale/clone rejection, terminal bookkeeping, exact lost-COMMIT confirmation; no model/business execution, automatic retry or restart-recovery claim.`);
  } catch (error) { console.error(`Durable execution SQL stage: ${stage}`); throw error; }
  finally { await fixture.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
