import assert from 'node:assert/strict';
import type { SqlConnection } from '../app/lib/db';
import type { OwnedAcceptedChatMessage, PreparedChatMessageAdmission } from '../app/lib/pi/durable-message-admission';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';

type Frame = Awaited<ReturnType<Awaited<ReturnType<typeof createDurableMessageExecutionFixture>>['createSessionRuntime']>>;
type Row = { client_message_id: string; payload_hash: string; private_payload: string; runtime_token: string;
  execution_phase: string; execution_revision: number; queue_lane: string | null; queue_ordinal: number | null;
  queue_disposition: string | null };

/** Real prepared admissions, owned SQL rows and current Use. Faults delegate
 * actual SQL first where a successful write/COMMIT is claimed. No successful
 * authority/source/provider verdict or Runtime owner is synthesized. */
async function main(): Promise<void> {
  const native = process.argv.includes('--native');
  const fixture = await createDurableMessageExecutionFixture({ native, ...(native ? { nativePoolMax: 2 } : {}) });
  const app = fixture.application;
  const sql = async <T>(operation: (database: SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await app.database.openDb();
    try { return await operation(database); } finally { await database.close(); }
  };
  let stage = 'actual replacement fixture';
  try {
    const admission = await import('../app/lib/pi/durable-message-admission');
    const execution = await import('../app/lib/pi/durable-message-execution');
    const runtime = fixture.runtimeApi;
    const first = await fixture.createSessionRuntime({ userId: 'alice' });
    const newFrame = (userId: 'alice' | 'bob' = 'alice') => fixture.createSessionRuntime({ userId, agentId: first.agentId });
    const identity = (active: Frame, id: string) => ({ userId: active.userId, sessionId: active.sessionId, clientMessageId: id,
      expectedAgentId: active.agentId, expectedWorkspaceId: active.context.workspaceId });
    const prepare = async (active: Frame, id: string, content = `Actual immutable replacement intent ${id}.`) => {
      const value = await admission.prepareChatMessageAdmission({ ...identity(active, id),
        message: { role: 'user', content, timestamp: 100 } });
      assert.equal(value.kind, 'prepared'); if (value.kind !== 'prepared') throw new Error('Expected a genuine new prepared admission.');
      return value.admission;
    };
    const admit = async (active: Frame, id: string) => admission.commitPreparedChatMessageAdmission(await prepare(active, id));
    const fresh = async (active: Frame, id: string) => { const value = await admission.readOwnedAcceptedChatMessage(identity(active, id)); assert(value); return value; };
    const snapshot = (message: OwnedAcceptedChatMessage) => admission.readOwnedChatMessageExecutionSnapshot(message);
    const stored = (active: Frame) => sql(async database => ({
      rows: await database.all(`SELECT client_message_id,payload_hash,private_payload,runtime_token,execution_phase,execution_revision,
        queue_lane,queue_ordinal,queue_disposition FROM pi_message_delivery_receipts
        WHERE pi_session_db_id=(SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2) ORDER BY client_message_id`, [active.userId, active.sessionId]) as Row[],
      counter: Number((await database.get('SELECT message_queue_ordinal AS ordinal FROM pi_sessions WHERE user_id=$1 AND session_id=$2',
        [active.userId, active.sessionId]) as { ordinal: number }).ordinal),
    }));
    const row = async (active: Frame, id: string) => { const value = (await stored(active)).rows.find(value => value.client_message_id === id); assert(value); return value; };
    const immutable = (before: Row, after: Row) => {
      assert.equal(after.private_payload, before.private_payload); assert.equal(after.payload_hash, before.payload_hash);
      assert.equal(after.runtime_token, before.runtime_token); assert.equal(after.queue_lane, before.queue_lane);
      assert.equal(after.queue_ordinal, before.queue_ordinal); assert.equal(after.queue_disposition, before.queue_disposition);
    };
    const conflict = { code: 'MESSAGE_EXECUTION_CONFLICT', status: 409 };
    const denied = (error: unknown) => {
      if (error instanceof Error && ['Workspace not found or inaccessible.',
        'The originating agent session is unavailable in this workspace.', 'Agent access is no longer available in this workspace.'].includes(error.message)) return true;
      assert(error && typeof error === 'object'); assert.equal(Reflect.get(error, 'status'), 403,
        `Expected a precise current authority denial, received ${error instanceof Error ? error.message : typeof error}.`);
      assert(['AGENT_EXTENSION_CONTEXT_DENIED', 'AGENT_MESSAGE_EXECUTION_DENIED', 'AGENT_ACCESS_DENIED', 'AGENT_ACTOR_CONTEXT_DENIED'].includes(String(Reflect.get(error, 'code'))));
      return true;
    };

    stage = 'atomic replacement of genuine ready and suspended rows';
    await admit(first, 'a'); const initialB = await admit(first, 'b');
    await execution.promoteOwnedQueuedChatMessage(initialB);
    const a = await fresh(first, 'a'), b = await fresh(first, 'b');
    const originalA = snapshot(a), originalB = snapshot(b), before = await stored(first);
    const prepared = await prepare(first, 'c');
    const replaced = await admission.commitPreparedChatMessageReplacement(prepared, [a, b], { lane: 'follow_up' });
    assert(Object.isFrozen(replaced)); assert(Object.isFrozen(replaced.cancelled)); assert(replaced.cancelled.every(Object.isFrozen));
    const current = snapshot(replaced.message);
    assert.equal(current.phase, 'queued'); assert.equal(current.executionRevision, 1);
    assert.deepEqual(current.queue, { lane: 'follow_up', ordinal: 3, disposition: 'ready' });
    assert.equal(current.payload.clientMessageId, 'c'); assert.equal(current.payload.mode, 'message');
    assert.notEqual(current.payload.serverMessageId, originalA.payload.serverMessageId); assert.notEqual(current.payload.serverMessageId, originalB.payload.serverMessageId);
    assert.deepEqual(replaced.cancelled.map(value => value.clientMessageId).sort(), ['a', 'b']);
    for (const old of before.rows) {
      const after = await row(first, old.client_message_id); immutable(old, after);
      assert.equal(after.execution_phase, 'cancelled'); assert.equal(after.execution_revision, old.execution_revision + 1);
    }
    assert.equal((await stored(first)).counter, 3);
    const afterSuccess = await stored(first);
    const replay = await admission.commitPreparedChatMessageReplacement(prepared, [a, b], { lane: 'follow_up' });
    assert.deepEqual(snapshot(replay.message), current); assert.deepEqual(replay.cancelled, replaced.cancelled);
    assert.deepEqual(await stored(first), afterSuccess, 'The same held replacement intent confirms its complete result without another mutation.');
    const withoutOriginals = await admission.commitPreparedChatMessageReplacement(prepared, [], { lane: 'follow_up' });
    assert.deepEqual(snapshot(withoutOriginals.message), current); assert.deepEqual(withoutOriginals.cancelled, []);
    await assert.rejects(admission.commitPreparedChatMessageReplacement(prepared, [await fresh(first, 'a'), await fresh(first, 'b')]), conflict);
    assert.deepEqual(await stored(first), afterSuccess);
    assert.deepEqual(snapshot(await fresh(first, 'c')), current, 'A retry without the original handles can read the actual stored result.');

    stage = 'a normal admitted row is not a completed replacement';
    const normal = await newFrame(); const normalA = await admit(normal, 'a'), normalB = await admit(normal, 'b');
    const normalPrepared = await prepare(normal, 'c'); await admission.commitPreparedChatMessageAdmission(normalPrepared);
    const beforeNormal = await stored(normal);
    await assert.rejects(admission.commitPreparedChatMessageReplacement(normalPrepared, [normalA, normalB]), conflict);
    assert.deepEqual(await stored(normal), beforeNormal);
    assert.equal((await row(normal, 'a')).execution_phase, 'queued'); assert.equal((await row(normal, 'b')).execution_phase, 'queued');

    stage = 'strict original handles, identity and stale expected states';
    const invalid = await newFrame(); const invalidA = await admit(invalid, 'a'), invalidB = await admit(invalid, 'b');
    const invalidPrepared = await prepare(invalid, 'c'), beforeInvalid = await stored(invalid);
    for (const copied of [{ kind: 'prepared_chat_message_admission' }, { ...invalidPrepared }, structuredClone(invalidPrepared)]) {
      await assert.rejects(admission.commitPreparedChatMessageReplacement(copied as PreparedChatMessageAdmission, [invalidA, invalidB]), denied);
    }
    for (const copied of [{ kind: 'owned_accepted_chat_message' }, { ...invalidA }, structuredClone(invalidA)]) {
      await assert.rejects(admission.commitPreparedChatMessageReplacement(invalidPrepared, [invalidB, copied as OwnedAcceptedChatMessage]), denied);
    }
    await assert.rejects(admission.commitPreparedChatMessageReplacement(invalidPrepared, [invalidA, invalidA]), conflict);
    const foreign = await newFrame('bob'), foreignA = await admit(foreign, 'foreign');
    const beforeForeign = await stored(foreign);
    await assert.rejects(admission.commitPreparedChatMessageReplacement(invalidPrepared, [invalidA, foreignA]), denied);
    assert.deepEqual(await stored(invalid), beforeInvalid); assert.deepEqual(await stored(foreign), beforeForeign);
    await execution.promoteOwnedQueuedChatMessage(invalidB);
    const beforeStale = await stored(invalid);
    await assert.rejects(admission.commitPreparedChatMessageReplacement(invalidPrepared, [invalidA, await fresh(invalid, 'b')]), conflict);
    assert.deepEqual(await stored(invalid), beforeStale);

    stage = 'the new client ID cannot equal a cancellation target';
    const sameId = await newFrame();
    const sameIdPrepared = await prepare(sameId, 'same', 'A genuinely prepared different replacement text.');
    const sameIdTarget = await admit(sameId, 'same'), beforeSameId = await stored(sameId);
    await assert.rejects(admission.commitPreparedChatMessageReplacement(sameIdPrepared, [sameIdTarget]), conflict);
    assert.deepEqual(await stored(sameId), beforeSameId);

    stage = 'a running execution is preserved while another queued message is replaced';
    const active = await newFrame(), owner = await runtime.getRegisteredPiRuntimeExecutionOwner(active.runtime);
    const activeRunning = await execution.startClaimedChatMessageExecution(await execution.claimOwnedChatMessageExecution(await admit(active, 'running'), owner));
    const activeB = await admit(active, 'b'), runningBefore = await row(active, 'running');
    await admission.commitPreparedChatMessageReplacement(await prepare(active, 'c'), [activeB]);
    assert.deepEqual(await row(active, 'running'), runningBefore);
    const beforeEmpty = await stored(active);
    const empty = await admission.commitPreparedChatMessageReplacement(await prepare(active, 'empty-targets'), []);
    assert.deepEqual(empty.cancelled, []); assert.equal(snapshot(empty.message).payload.clientMessageId, 'empty-targets');
    for (const beforeRow of beforeEmpty.rows) assert.deepEqual(await row(active, beforeRow.client_message_id), beforeRow);
    const runningRejected = await prepare(active, 'cannot-replace-running'), beforeRunningRejected = await stored(active);
    await assert.rejects(admission.commitPreparedChatMessageReplacement(runningRejected, [activeRunning.message]), conflict);
    assert.deepEqual(await stored(active), beforeRunningRejected);
    await execution.finishClaimedChatMessageExecution(activeRunning.claim, 'cancelled');

    stage = 'actual first and second cancellation CAS failures roll back the complete transaction';
    const originalOpen = app.database.openDb;
    for (const fault of ['first-cas', 'second-cas', 'insert'] as const) {
      const target = await newFrame(), targetA = await admit(target, 'a'), targetB = await admit(target, 'b');
      const targetPrepared = await prepare(target, 'c'), beforeFault = await stored(target);
      const transportFault = new Error(`Actual replacement ${fault} reply lost.`);
      let casWrites = 0, inserted = false, injected = false;
      app.database.openDb = async () => {
        const actual = await originalOpen();
        return { ...actual, get: async (query, params = []) => {
          const value = await actual.get(query, params);
          if (/UPDATE\s+pi_message_delivery_receipts/iu.test(query)) casWrites++;
          if (/INSERT\s+INTO\s+pi_message_delivery_receipts/iu.test(query) && params.includes('c')) inserted = true;
          if (!injected && (fault === 'first-cas' && casWrites === 1 || fault === 'second-cas' && casWrites === 2 || fault === 'insert' && inserted)) {
            injected = true; throw transportFault;
          }
          return value;
        } };
      };
      try { await assert.rejects(admission.commitPreparedChatMessageReplacement(targetPrepared, [targetA, targetB]), error => error === transportFault); }
      finally { app.database.openDb = originalOpen; }
      assert(injected); if (fault === 'insert') assert(inserted); else assert.equal(casWrites, fault === 'first-cas' ? 1 : 2);
      assert.deepEqual(await stored(target), beforeFault, 'No cancelled target, new receipt or allocated ordinal may survive a rollback.');
    }

    stage = 'actual Agent Use revocation before commit produces no partial replacement';
    const revoked = await newFrame(), revokedA = await admit(revoked, 'a'), revokedB = await admit(revoked, 'b');
    const revokedPrepared = await prepare(revoked, 'c'), beforeRevoked = await stored(revoked);
    const management = await import('../app/lib/agents/management-actions'), actor = { ...app.owner, source: 'api' as const };
    const inspected = await management.inspectManagedAgent(actor, first.agentId);
    const removed = await management.removeManagedAgentGrant({ actor, agentId: first.agentId, expectedRevision: inspected.agent.revision,
      targetType: 'user', targetId: revoked.userId });
    try { await assert.rejects(admission.commitPreparedChatMessageReplacement(revokedPrepared, [revokedA, revokedB]), denied); }
    finally { await management.setManagedAgentGrant({ actor, agentId: first.agentId, expectedRevision: removed.agent.revision,
      targetType: 'user', targetId: revoked.userId, canUse: true, canEdit: false, canManage: false }); }
    assert.deepEqual(await stored(revoked), beforeRevoked);

    stage = 'actual replacement COMMIT loss discards before fresh exact vector recovery';
    for (const changedVector of [false, true]) {
      const target = await newFrame(), targetA = await admit(target, 'a'), targetB = await admit(target, 'b');
      const targetPrepared = await prepare(target, 'c'), beforeCommit = await stored(target);
      const acknowledgementLost = new Error('Actual replacement COMMIT reply lost.');
      let committed = false, discarded = 0, queriesOnFailedLease = 0, recoveryCheckouts = 0, changed = false;
      app.database.openDb = async () => {
        if (committed) recoveryCheckouts++;
        const actual = await originalOpen(); let wrote = false, failed = false;
        return { ...actual, get: async (query, params = []) => {
          if (failed) queriesOnFailedLease++;
          const value = await actual.get(query, params);
          if (/INSERT\s+INTO\s+pi_message_delivery_receipts|UPDATE\s+pi_message_delivery_receipts/iu.test(query)) wrote = true;
          return value;
        }, all: async (query, params = []) => { if (failed) queriesOnFailedLease++; return actual.all(query, params); },
        run: async (query, params = []) => {
          if (failed) queriesOnFailedLease++;
          const value = await actual.run(query, params);
          if (!committed && wrote && query.trim() === 'COMMIT') {
            committed = true;
            if (changedVector) {
              const observer = await originalOpen();
              try {
                const result = await observer.run(`UPDATE pi_message_delivery_receipts SET execution_revision=execution_revision+1
                  WHERE client_message_id='a' AND execution_phase='cancelled' AND pi_session_db_id=(SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2)`, [target.userId, target.sessionId]);
                assert.equal((result as { changes: number }).changes, 1); changed = true;
              } finally { await observer.close(); }
            }
            failed = true; throw acknowledgementLost;
          }
          return value;
        }, close: error => { if (error) discarded++; return actual.close(error); } };
      };
      try {
        const operation = admission.commitPreparedChatMessageReplacement(targetPrepared, [targetA, targetB]);
        if (changedVector) await assert.rejects(operation, { code: 'MESSAGE_EXECUTION_UNCERTAIN', status: 409 });
        else {
          const result = await operation; assert.equal(snapshot(result.message).payload.clientMessageId, 'c');
          assert.deepEqual(result.cancelled.map(value => value.clientMessageId).sort(), ['a', 'b']);
        }
      } finally { app.database.openDb = originalOpen; }
      assert(committed); assert.equal(changed, changedVector); assert.equal(discarded, 1);
      assert.equal(queriesOnFailedLease, 0); assert(recoveryCheckouts > 0);
      const final = await stored(target); assert.equal(final.counter, 3); assert.equal(final.rows.length, 3);
      for (const beforeRow of beforeCommit.rows) immutable(beforeRow, await row(target, beforeRow.client_message_id));
      assert.equal((await row(target, 'b')).execution_revision, 2);
      assert.equal((await row(target, 'a')).execution_revision, changedVector ? 3 : 2);
      assert.equal((await row(target, 'c')).execution_phase, 'queued');
    }

    stage = 'normal admission also discards a lost COMMIT lease before recovery';
    const plain = await newFrame(), plainPrepared = await prepare(plain, 'plain');
    const plainAcknowledgementLost = new Error('Actual normal admission COMMIT reply lost.');
    let plainCommitted = false, plainDiscarded = false, plainQueriesAfterFailure = 0, plainFreshReads = 0;
    app.database.openDb = async () => {
      if (plainDiscarded) plainFreshReads++;
      const actual = await originalOpen(); let inserted = false, failed = false;
      return { ...actual, get: async (query, params = []) => {
        if (failed) plainQueriesAfterFailure++;
        const value = await actual.get(query, params); if (/INSERT\s+INTO\s+pi_message_delivery_receipts/iu.test(query)) inserted = true; return value;
      }, all: async (query, params = []) => { if (failed) plainQueriesAfterFailure++; return actual.all(query, params); },
      run: async (query, params = []) => {
        if (failed) plainQueriesAfterFailure++;
        const value = await actual.run(query, params);
        if (!plainCommitted && inserted && query.trim() === 'COMMIT') { plainCommitted = true; failed = true; throw plainAcknowledgementLost; }
        return value;
      }, close: error => { if (error) plainDiscarded = true; return actual.close(error); } };
    };
    try { assert.equal(snapshot(await admission.commitPreparedChatMessageAdmission(plainPrepared)).payload.clientMessageId, 'plain'); }
    finally { app.database.openDb = originalOpen; }
    assert(plainCommitted && plainDiscarded && plainFreshReads > 0); assert.equal(plainQueriesAfterFailure, 0);

    stage = 'a lost replay COMMIT confirms the actual winner from two genuine prepared admissions';
    const replayFrame = await newFrame();
    const preparedWinner = await prepare(replayFrame, 'same'), preparedReplay = await prepare(replayFrame, 'same');
    assert.notEqual(preparedWinner, preparedReplay);
    const actualWinner = await admission.commitPreparedChatMessageAdmission(preparedWinner), winnerSnapshot = snapshot(actualWinner);
    const beforeReplay = await stored(replayFrame), replayAcknowledgementLost = new Error('Actual read-only replay COMMIT reply lost.');
    let replayCommitted = false, replayDiscarded = 0, replayInserts = 0, replayQueriesAfterFailure = 0;
    app.database.openDb = async () => {
      const actual = await originalOpen(); let readReceipt = false, failed = false;
      return { ...actual, get: async (query, params = []) => {
        if (failed) replayQueriesAfterFailure++;
        const value = await actual.get(query, params);
        if (/FROM\s+pi_message_delivery_receipts/iu.test(query) && params.includes('same')) readReceipt = true;
        if (/INSERT\s+INTO\s+pi_message_delivery_receipts/iu.test(query)) replayInserts++;
        return value;
      }, all: async (query, params = []) => { if (failed) replayQueriesAfterFailure++; return actual.all(query, params); },
      run: async (query, params = []) => {
        if (failed) replayQueriesAfterFailure++;
        const value = await actual.run(query, params);
        if (!replayCommitted && readReceipt && query.trim() === 'COMMIT') { replayCommitted = true; failed = true; throw replayAcknowledgementLost; }
        return value;
      }, close: error => { if (error) replayDiscarded++; return actual.close(error); } };
    };
    try {
      const recovered = await admission.commitPreparedChatMessageAdmission(preparedReplay);
      assert.equal(snapshot(recovered).payload.serverMessageId, winnerSnapshot.payload.serverMessageId);
      assert.deepEqual(snapshot(recovered), winnerSnapshot, 'Recovery confirms the actual SQL winner, not the other prepared admission payload.');
    } finally { app.database.openDb = originalOpen; }
    assert(replayCommitted); assert.equal(replayDiscarded, 1); assert.equal(replayInserts, 0); assert.equal(replayQueriesAfterFailure, 0);
    assert.deepEqual(await stored(replayFrame), beforeReplay);

    stage = 'actual claim during a replacement COMMIT ACK invalidates its exact new-row proof';
    const claimedFrame = await newFrame(), claimOwner = await runtime.getRegisteredPiRuntimeExecutionOwner(claimedFrame.runtime);
    const claimA = await admit(claimedFrame, 'a'), claimB = await admit(claimedFrame, 'b'), claimPrepared = await prepare(claimedFrame, 'c');
    const claimedAcknowledgementLost = new Error('Actual replacement COMMIT reply lost after the new message was publicly claimed.');
    let committedBeforeClaim = false, claimedDiscarded = 0, queriedFailedClaimLease = 0;
    let concurrentClaim: Awaited<ReturnType<typeof execution.claimOwnedChatMessageExecution>> | undefined;
    app.database.openDb = async () => {
      const actual = await originalOpen(); let wrote = false, failed = false;
      return { ...actual, get: async (query, params = []) => {
        if (failed) queriedFailedClaimLease++;
        const value = await actual.get(query, params);
        if (/INSERT\s+INTO\s+pi_message_delivery_receipts/iu.test(query)) wrote = true;
        return value;
      }, all: async (query, params = []) => { if (failed) queriedFailedClaimLease++; return actual.all(query, params); },
      run: async (query, params = []) => {
        if (failed) queriedFailedClaimLease++;
        const value = await actual.run(query, params);
        if (!committedBeforeClaim && wrote && query.trim() === 'COMMIT') {
          committedBeforeClaim = true;
          concurrentClaim = await execution.claimOwnedChatMessageExecution(await fresh(claimedFrame, 'c'), claimOwner);
          failed = true; throw claimedAcknowledgementLost;
        }
        return value;
      }, close: error => { if (error) claimedDiscarded++; return actual.close(error); } };
    };
    try { await assert.rejects(admission.commitPreparedChatMessageReplacement(claimPrepared, [claimA, claimB]), { code: 'MESSAGE_EXECUTION_UNCERTAIN', status: 409 }); }
    finally { app.database.openDb = originalOpen; }
    try {
      assert(committedBeforeClaim && concurrentClaim); assert.equal(claimedDiscarded, 1); assert.equal(queriedFailedClaimLease, 0);
      for (const id of ['a', 'b']) { const cancelled = await row(claimedFrame, id); assert.equal(cancelled.execution_phase, 'cancelled'); assert.equal(cancelled.execution_revision, 2); }
      const newRow = await row(claimedFrame, 'c'); assert.equal(newRow.execution_phase, 'dispatching'); assert.equal(newRow.execution_revision, 2);
      assert.equal((await stored(claimedFrame)).counter, 3);
    } finally { if (concurrentClaim) await execution.finishClaimedChatMessageExecution(concurrentClaim, 'cancelled'); }

    if (native) {
      stage = 'native Replace versus Cancel has one winner and no partial vector';
      const race = await newFrame(), raceA = await admit(race, 'a'), raceB = await admit(race, 'b'), racePrepared = await prepare(race, 'c');
      const results = await Promise.allSettled([admission.commitPreparedChatMessageReplacement(racePrepared, [raceA, raceB]),
        execution.cancelOwnedQueuedChatMessages([raceA])]);
      assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
      for (const result of results) if (result.status === 'rejected') { assert.equal(result.reason?.code, conflict.code); assert.equal(result.reason?.status, 409); }
      if (results[0].status === 'fulfilled') {
        assert.equal((await stored(race)).counter, 3); assert.equal((await row(race, 'b')).execution_phase, 'cancelled');
        assert.equal((await row(race, 'c')).execution_phase, 'queued');
      } else {
        const actual = await stored(race); assert.equal(actual.counter, 2); assert.equal(actual.rows.length, 2);
        assert.equal((await row(race, 'a')).execution_phase, 'cancelled'); assert.equal((await row(race, 'b')).execution_phase, 'queued');
      }

      stage = 'failed native replacement rollback discards the lease without recovery';
      const target = await newFrame(), targetA = await admit(target, 'a'), targetB = await admit(target, 'b'), targetPrepared = await prepare(target, 'c');
      const beforeFault = await stored(target), updateFault = new Error('Actual replacement cancellation CAS reply lost.'), rollbackFault = new Error('Replacement ROLLBACK failed before delegation.');
      let updated = false, rollbackFailed = false, discardedError: Error | undefined, failedPid = 0, laterReads = 0;
      app.database.openDb = async () => {
        const actual = await originalOpen(); let wrote = false;
        return { ...actual, get: async (query, params = []) => {
          if (rollbackFailed) laterReads++;
          const value = await actual.get(query, params);
          if (!updated && /UPDATE\s+pi_message_delivery_receipts/iu.test(query)) {
            wrote = true; updated = true; failedPid = Number((await actual.get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid); throw updateFault;
          }
          return value;
        }, run: async (query, params = []) => {
          if (wrote && query.trim() === 'ROLLBACK') { rollbackFailed = true; throw rollbackFault; }
          return actual.run(query, params);
        }, close: error => { if (wrote) discardedError = error; return actual.close(error); } };
      };
      try { await assert.rejects(admission.commitPreparedChatMessageReplacement(targetPrepared, [targetA, targetB]), error => error === updateFault); }
      finally { app.database.openDb = originalOpen; }
      assert(updated && rollbackFailed && failedPid > 0 && discardedError); assert.equal(discardedError, rollbackFault); assert.equal(laterReads, 0);
      await sql(async database => {
        const actual = await database.get('SELECT pg_backend_pid() AS pid,txid_current_if_assigned()::text AS tx') as { pid: number; tx: string | null };
        assert.notEqual(actual.pid, failedPid); assert.equal(actual.tx, null);
      });
      assert.deepEqual(await stored(target), beforeFault);

      stage = 'a failed discard cannot confirm or automatically retry a committed replacement';
      const uncertain = await newFrame(), uncertainA = await admit(uncertain, 'a'), uncertainB = await admit(uncertain, 'b');
      const uncertainPrepared = await prepare(uncertain, 'c');
      const acknowledgementLost = new Error('Actual replacement COMMIT reply lost before discard failure.'), discardFault = new Error('Actual native release succeeded but its acknowledgement failed.');
      let uncertainCommitted = false, discardFailed = false, recoveryAfterFailedDiscard = 0;
      app.database.openDb = async () => {
        if (discardFailed) recoveryAfterFailedDiscard++;
        const actual = await originalOpen(); let wrote = false;
        return { ...actual, get: async (query, params = []) => {
          const value = await actual.get(query, params); if (/INSERT\s+INTO\s+pi_message_delivery_receipts/iu.test(query)) wrote = true; return value;
        }, run: async (query, params = []) => {
          const value = await actual.run(query, params);
          if (!uncertainCommitted && wrote && query.trim() === 'COMMIT') { uncertainCommitted = true; throw acknowledgementLost; }
          return value;
        }, close: async error => {
          await actual.close(error);
          if (wrote && error) { discardFailed = true; throw discardFault; }
        } };
      };
      try { await assert.rejects(admission.commitPreparedChatMessageReplacement(uncertainPrepared, [uncertainA, uncertainB]), error => {
        assert(error instanceof AggregateError && error.errors.includes(acknowledgementLost) && error.errors.includes(discardFault)); return true;
      }); } finally { app.database.openDb = originalOpen; }
      assert(uncertainCommitted && discardFailed); assert.equal(recoveryAfterFailedDiscard, 0);
      const persisted = await stored(uncertain); assert.equal(persisted.counter, 3); assert.equal(persisted.rows.length, 3);
      for (const id of ['a', 'b']) { assert.equal((await row(uncertain, id)).execution_phase, 'cancelled'); assert.equal((await row(uncertain, id)).execution_revision, 2); }
      assert.equal((await row(uncertain, 'c')).execution_phase, 'queued');
    }

    assert.equal(fixture.counts().forbiddenModelRequests, 0); assert.equal(fixture.counts().externalRequests, 0);
    assert.equal(Number((await sql(database => database.get('SELECT COUNT(*) AS count FROM pi_messages')) as { count: number }).count), 0);
    assert.equal(Number((await sql(database => database.get('SELECT COUNT(*) AS count FROM file_agent_turns')) as { count: number }).count), 0);
    console.log(`PASS durable message replacement SQL (${native ? 'actual PostgreSQL pool2' : 'actual PGlite'}): atomic new receipt+cancel vector+counter, original intent preserved, strict provenance/replay, running claim unchanged, delegated SQL rollback and exact discarded-COMMIT recovery; no model/business execution or automatic retry.`);
  } catch (error) { console.error(`Durable replacement SQL stage: ${stage}`); throw error; }
  finally { await fixture.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
