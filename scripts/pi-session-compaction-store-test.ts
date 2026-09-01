import assert from 'node:assert/strict';

import Database from 'better-sqlite3';
import { PGlite } from '@electric-sql/pglite';

import type { SqlConnection } from '../app/lib/db';
import { runMigrations } from '../app/lib/db/migrate';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import {
  auditPiMessageSequenceIntegrityOnConnection,
  commitPiSessionCompactionSummaryOnConnection,
  countPiSessionCompactionIneffectiveAttemptsOnConnection,
  countPiSessionCompactionRetryFailuresOnConnection,
  finishPiSessionCompactionAttemptOnConnection,
  PiCompactionHistoryIntegrityError,
  PiCompactionScopeError,
  recordPiSessionCompactionProgressOnConnection,
  startPiSessionCompactionAttemptOnConnection,
} from '../app/lib/pi/session-compaction-store';

type Provider = 'sqlite' | 'postgres';

function translatePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function sqliteConnection(sqlite: Database.Database): SqlConnection {
  const statement = (sql: string, params?: unknown[]) => {
    const prepared = sqlite.prepare(sql);
    return params === undefined ? prepared : prepared.bind(...params);
  };
  return {
    get: (sql, params) => statement(sql, params).get(),
    run: (sql, params) => statement(sql, params).run(),
    all: (sql, params) => statement(sql, params).all(),
    close: () => undefined,
  };
}

function postgresConnection(postgres: PGlite): SqlConnection {
  const query = (sql: string, params?: unknown[]) => postgres.query(
    translatePlaceholders(sql),
    params as never[] | undefined,
  );
  return {
    get: async (sql, params) => (await query(sql, params)).rows[0],
    run: async (sql, params) => {
      const result = await query(sql, params);
      return { changes: result.affectedRows ?? 0 };
    },
    all: async (sql, params) => (await query(sql, params)).rows,
    close: () => undefined,
  };
}

async function seed(connection: SqlConnection, provider: Provider): Promise<void> {
  const userTable = provider === 'postgres' ? '"user"' : 'user';
  await connection.run(
    `INSERT INTO ${userTable} (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
    ['user-compaction', 'Compaction User', `${provider}@example.test`, 1_700_000_000, 1_700_000_000],
  );
  await connection.run(
    `INSERT INTO pi_sessions (
       session_id, user_id, agent_id, provider, model, title, created_at, updated_at,
       workspace_id, summary_revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      `session-${provider}`,
      'user-compaction',
      'agent-compaction',
      'test-provider',
      'test-model',
      'Compaction Session',
      1_700_000_000,
      1_700_000_000,
      'workspace-compaction',
    ],
  );
  const session = await connection.get(
    'SELECT id FROM pi_sessions WHERE session_id = ?',
    [`session-${provider}`],
  ) as { id: number | string };
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    await connection.run(
      `INSERT INTO pi_messages (pi_session_db_id, role, content, timestamp, sequence)
       VALUES (?, 'user', ?, ?, ?)`,
      [session.id, JSON.stringify({ role: 'user', content: `message-${sequence}` }), 1_700_000_000 + sequence, sequence],
    );
  }
}

async function installRollbackFence(
  connection: SqlConnection,
  provider: Provider,
  attemptId: string,
): Promise<() => Promise<void>> {
  if (provider === 'sqlite') {
    await connection.run(`
      CREATE TRIGGER reject_compaction_success
      BEFORE UPDATE OF state ON pi_session_compaction_attempts
      WHEN NEW.id = '${attemptId}' AND NEW.state = 'succeeded'
      BEGIN
        SELECT RAISE(ABORT, 'injected attempt update failure');
      END
    `);
    return async () => { await connection.run('DROP TRIGGER reject_compaction_success'); };
  }
  await connection.run(`
    ALTER TABLE pi_session_compaction_attempts
    ADD CONSTRAINT reject_compaction_success
    CHECK (id <> '${attemptId}' OR state <> 'succeeded')
  `);
  return async () => {
    await connection.run('ALTER TABLE pi_session_compaction_attempts DROP CONSTRAINT reject_compaction_success');
  };
}

async function exerciseStore(connection: SqlConnection, provider: Provider): Promise<void> {
  await seed(connection, provider);
  const scope = {
    sessionId: `session-${provider}`,
    userId: 'user-compaction',
    agentId: 'agent-compaction',
    workspaceId: 'workspace-compaction',
  } as const;
  const now = new Date('2026-08-27T10:00:00.000Z');
  const deadlineAt = new Date('2026-08-27T10:05:00.000Z');

  const started = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-1`,
    trigger: 'automatic',
    expectedSummaryRevision: 0,
    expectedThroughSequence: null,
    deadlineAt,
    provider: 'test-provider',
    model: 'test-model',
    contractFingerprint: 'fingerprint-without-content',
    metrics: {
      beforeEstimatedTokens: 2_000,
      beforeEstimatedBytes: 8_000,
      protectedUnitCount: 1,
      triggerTokens: 1_800,
      targetTokens: 900,
      beforePressureBasisPoints: 11_111,
      headUnitCount: 1,
      middleUnitCount: 2,
      tailUnitCount: 1,
      anchorCount: 4,
      summaryProvider: 'summary-provider',
      summaryModel: 'summary-model',
    },
    idleDeadlineAt: new Date('2026-08-27T10:02:00.000Z'),
    now,
  });
  assert.equal(started.status, 'started');
  assert.equal(started.attempt.attemptOrdinal, 1);
  assert.equal(started.attempt.messageSequenceCheckpoint, 3);
  assert.equal(Object.isFrozen(started.attempt), true);
  assert.equal(started.attempt.telemetry.summaryModel, 'summary-model');
  assert.equal(started.attempt.telemetry.anchorCount, 4);
  assert.equal(await recordPiSessionCompactionProgressOnConnection(connection, provider, {
    ...scope,
    attemptId: started.attempt.attemptId,
    idleDeadlineAt: new Date('2026-08-27T10:03:00.000Z'),
    now: new Date('2026-08-27T10:01:00.000Z'),
  }), true);

  const secondStart = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-parallel`,
    trigger: 'manual',
    expectedSummaryRevision: 0,
    expectedThroughSequence: null,
    deadlineAt,
    provider: 'test-provider',
    model: 'test-model',
    now,
  });
  assert.equal(secondStart.status, 'already_running');
  assert.equal(secondStart.attempt.attemptId, started.attempt.attemptId);

  const session = await connection.get(
    'SELECT id FROM pi_sessions WHERE session_id = ?',
    [scope.sessionId],
  ) as { id: number | string };
  await connection.run(
    `INSERT INTO pi_messages (pi_session_db_id, role, content, timestamp, sequence)
     VALUES (?, 'user', ?, ?, 4)`,
    [session.id, JSON.stringify({ role: 'user', content: 'concurrent append' }), 1_700_000_004],
  );

  const committed = await commitPiSessionCompactionSummaryOnConnection(connection, provider, {
    ...scope,
    attemptId: started.attempt.attemptId,
    expectedSummaryRevision: 0,
    expectedThroughSequence: null,
    summaryText: 'Bounded internal summary',
    throughSequence: 3,
    metrics: {
      afterEstimatedTokens: 900,
      afterEstimatedBytes: 3_600,
      afterPressureBasisPoints: 5_000,
      summarizedUnitCount: 2,
      omittedUnitCount: 2,
      progressEventCount: 1,
    },
    now: new Date('2026-08-27T10:01:00.000Z'),
  });
  assert.equal(committed.status, 'committed');
  assert.equal(committed.summary.summaryRevision, 1);
  assert.equal(committed.summary.summaryThroughSequence, 3);
  assert.equal(committed.summary.summaryThroughTimestamp, 1_700_000_003);
  assert.equal(committed.attempt.state, 'succeeded');
  assert.equal(committed.attempt.committedSummaryRevision, 1);
  assert.equal(committed.attempt.progressEventCount, 1);
  assert.equal(committed.attempt.lastProgressAt?.toISOString(), '2026-08-27T10:01:00.000Z');
  assert.equal(committed.attempt.idleDeadlineAt?.toISOString(), '2026-08-27T10:03:00.000Z');
  assert.equal(committed.attempt.durationMs, 60_000);
  assert.equal(committed.attempt.telemetry.beforePressureBasisPoints, 11_111);
  assert.equal(committed.attempt.telemetry.afterPressureBasisPoints, 5_000);
  assert.equal(committed.attempt.telemetry.errorClass, null);

  const persisted = await connection.get(
    `SELECT summary_text, summary_revision, summary_through_sequence,
            (SELECT COUNT(*) FROM pi_messages WHERE pi_session_db_id = pi_sessions.id) AS message_count
     FROM pi_sessions WHERE id = ?`,
    [session.id],
  ) as Record<string, unknown>;
  assert.equal(persisted.summary_text, 'Bounded internal summary');
  assert.equal(Number(persisted.summary_revision), 1);
  assert.equal(Number(persisted.summary_through_sequence), 3);
  assert.equal(Number(persisted.message_count), 4, 'a concurrent append above the checkpoint must remain');

  const rollbackAttempt = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-rollback`,
    trigger: 'manual',
    expectedSummaryRevision: 1,
    expectedThroughSequence: 3,
    deadlineAt,
    provider: 'test-provider',
    model: 'test-model',
    now,
  });
  assert.equal(rollbackAttempt.status, 'started');
  const removeRollbackFence = await installRollbackFence(connection, provider, rollbackAttempt.attempt.attemptId);
  await assert.rejects(
    commitPiSessionCompactionSummaryOnConnection(connection, provider, {
      ...scope,
      attemptId: rollbackAttempt.attempt.attemptId,
      expectedSummaryRevision: 1,
      expectedThroughSequence: 3,
      summaryText: 'This transaction must roll back',
      throughSequence: 4,
      now: new Date('2026-08-27T10:02:00.000Z'),
    }),
    /injected attempt update failure|reject_compaction_success/u,
  );
  await removeRollbackFence();
  const afterRollback = await connection.get(
    `SELECT summary_text, summary_revision, summary_through_sequence
     FROM pi_sessions WHERE id = ?`,
    [session.id],
  ) as Record<string, unknown>;
  assert.equal(afterRollback.summary_text, 'Bounded internal summary');
  assert.equal(Number(afterRollback.summary_revision), 1);
  assert.equal(Number(afterRollback.summary_through_sequence), 3);
  const finishedRollback = await finishPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: rollbackAttempt.attempt.attemptId,
    state: 'failed',
    reasonCode: 'persistence_conflict',
    now: new Date('2026-08-27T10:03:00.000Z'),
  });
  assert.equal(finishedRollback.changed, true);
  assert.equal(finishedRollback.attempt.state, 'failed');

  const staleAttempt = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-stale`,
    trigger: 'automation',
    expectedSummaryRevision: 1,
    expectedThroughSequence: 3,
    deadlineAt,
    provider: 'test-provider',
    model: 'test-model',
    now,
  });
  assert.equal(staleAttempt.status, 'started');
  await connection.run(
    `UPDATE pi_sessions SET summary_revision = 2, summary_through_sequence = 4 WHERE id = ?`,
    [session.id],
  );
  const staleCommit = await commitPiSessionCompactionSummaryOnConnection(connection, provider, {
    ...scope,
    attemptId: staleAttempt.attempt.attemptId,
    expectedSummaryRevision: 1,
    expectedThroughSequence: 3,
    summaryText: 'Stale summary must not win',
    throughSequence: 4,
    now: new Date('2026-08-27T10:04:00.000Z'),
  });
  assert.equal(staleCommit.status, 'stale');
  assert.equal(staleCommit.attempt.reasonCode, 'stale_snapshot');
  const afterStale = await connection.get(
    'SELECT summary_text, summary_revision FROM pi_sessions WHERE id = ?',
    [session.id],
  ) as Record<string, unknown>;
  assert.equal(afterStale.summary_text, 'Bounded internal summary');
  assert.equal(Number(afterStale.summary_revision), 2);

  const cooldownSource = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-cooldown-source`,
    trigger: 'automatic',
    expectedSummaryRevision: 2,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:10:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    now: new Date('2026-08-27T10:05:00.000Z'),
  });
  assert.equal(cooldownSource.status, 'started');
  await finishPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-cooldown-source`,
    state: 'failed',
    reasonCode: 'summary_provider_error',
    retryAt: new Date('2026-08-27T10:15:00.000Z'),
    now: new Date('2026-08-27T10:05:30.000Z'),
  });
  const automaticCooldown = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-cooldown-auto`,
    trigger: 'automatic',
    expectedSummaryRevision: 2,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:12:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    now: new Date('2026-08-27T10:06:00.000Z'),
  });
  assert.equal(automaticCooldown.status, 'cooldown_active');
  const exactBudgetBypass = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-cooldown-exact-budget`,
    trigger: 'automatic',
    bypassCooldown: true,
    expectedSummaryRevision: 2,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:12:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    contractFingerprint: 'exact-budget-retry:test-contract',
    now: new Date('2026-08-27T10:06:00.000Z'),
  });
  assert.equal(exactBudgetBypass.status, 'started');
  assert.equal(exactBudgetBypass.attempt.trigger, 'automatic');
  await finishPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-cooldown-exact-budget`,
    state: 'failed',
    reasonCode: 'summary_provider_error',
    retryAt: new Date('2026-08-27T10:16:00.000Z'),
    now: new Date('2026-08-27T10:06:30.000Z'),
  });
  const secondExactBudgetBypass = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-cooldown-exact-budget-second`,
    trigger: 'automatic',
    bypassCooldown: true,
    expectedSummaryRevision: 2,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:12:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    contractFingerprint: 'exact-budget-retry:test-contract',
    now: new Date('2026-08-27T10:07:00.000Z'),
  });
  assert.equal(secondExactBudgetBypass.status, 'cooldown_active');
  const manualBypass = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-cooldown-manual`,
    trigger: 'manual',
    expectedSummaryRevision: 2,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:12:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    now: new Date('2026-08-27T10:06:00.000Z'),
  });
  assert.equal(manualBypass.status, 'started');
  await finishPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-cooldown-manual`,
    state: 'failed',
    reasonCode: 'summary_provider_error',
    retryAt: new Date('2026-08-27T10:16:00.000Z'),
    now: new Date('2026-08-27T10:06:30.000Z'),
  });
  const secondManualBypass = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-cooldown-manual-second`,
    trigger: 'manual',
    expectedSummaryRevision: 2,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:12:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    now: new Date('2026-08-27T10:07:00.000Z'),
  });
  assert.equal(secondManualBypass.status, 'cooldown_active');
  assert.equal(
    await countPiSessionCompactionRetryFailuresOnConnection(connection, provider, scope),
    3,
  );

  const resetAttempt = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-cooldown-reset`,
    trigger: 'automatic',
    expectedSummaryRevision: 2,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:22:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    now: new Date('2026-08-27T10:17:00.000Z'),
  });
  assert.equal(resetAttempt.status, 'started');
  const resetCommit = await commitPiSessionCompactionSummaryOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-cooldown-reset`,
    expectedSummaryRevision: 2,
    expectedThroughSequence: 4,
    summaryText: 'Successful summary resets retry history',
    throughSequence: 4,
    now: new Date('2026-08-27T10:18:00.000Z'),
  });
  assert.equal(resetCommit.status, 'committed');
  assert.equal(
    await countPiSessionCompactionRetryFailuresOnConnection(connection, provider, scope),
    0,
  );

  const ineffectiveOne = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-ineffective-1`,
    trigger: 'automatic',
    expectedSummaryRevision: 3,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:25:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    now: new Date('2026-08-27T10:19:00.000Z'),
  });
  assert.equal(ineffectiveOne.status, 'started');
  await finishPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-ineffective-1`,
    state: 'no_op',
    reasonCode: 'nothing_eligible',
    now: new Date('2026-08-27T10:19:30.000Z'),
  });
  assert.equal(
    await countPiSessionCompactionIneffectiveAttemptsOnConnection(connection, provider, scope),
    1,
  );

  const ineffectiveTwo = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-ineffective-2`,
    trigger: 'automatic',
    expectedSummaryRevision: 3,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:26:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    now: new Date('2026-08-27T10:20:00.000Z'),
  });
  assert.equal(ineffectiveTwo.status, 'started');
  await finishPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-ineffective-2`,
    state: 'no_op',
    reasonCode: 'nothing_eligible',
    retryAt: new Date('2026-08-27T10:25:30.000Z'),
    now: new Date('2026-08-27T10:20:30.000Z'),
  });
  assert.equal(
    await countPiSessionCompactionIneffectiveAttemptsOnConnection(connection, provider, scope),
    2,
  );
  const breakerBlocked = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-breaker-blocked`,
    trigger: 'automatic',
    expectedSummaryRevision: 3,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:27:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    now: new Date('2026-08-27T10:21:00.000Z'),
  });
  assert.equal(breakerBlocked.status, 'breaker_active');

  const breakerManualProbe = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-breaker-manual-probe`,
    trigger: 'manual',
    expectedSummaryRevision: 3,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:27:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    now: new Date('2026-08-27T10:21:00.000Z'),
  });
  assert.equal(breakerManualProbe.status, 'started');
  await finishPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-breaker-manual-probe`,
    state: 'no_op',
    reasonCode: 'nothing_eligible',
    now: new Date('2026-08-27T10:21:30.000Z'),
  });
  const secondManualProbe = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-breaker-manual-second`,
    trigger: 'manual',
    expectedSummaryRevision: 3,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:28:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    now: new Date('2026-08-27T10:22:00.000Z'),
  });
  assert.equal(secondManualProbe.status, 'breaker_active');

  const recoveryProbe = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-breaker-recovery`,
    trigger: 'automatic',
    expectedSummaryRevision: 3,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:32:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    now: new Date('2026-08-27T10:26:00.000Z'),
  });
  assert.equal(recoveryProbe.status, 'started');
  await finishPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-breaker-recovery`,
    state: 'aborted',
    reasonCode: 'aborted',
    now: new Date('2026-08-27T10:26:30.000Z'),
  });

  const orphanedIdleAttempt = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-orphaned-idle`,
    trigger: 'automatic',
    expectedSummaryRevision: 3,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:40:00.000Z'),
    idleDeadlineAt: new Date('2026-08-27T10:28:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    now: new Date('2026-08-27T10:27:00.000Z'),
  });
  assert.equal(orphanedIdleAttempt.status, 'started');
  const reapedIdleAttempt = await startPiSessionCompactionAttemptOnConnection(connection, provider, {
    ...scope,
    attemptId: `attempt-${provider}-after-orphaned-idle`,
    trigger: 'automatic',
    expectedSummaryRevision: 3,
    expectedThroughSequence: 4,
    deadlineAt: new Date('2026-08-27T10:45:00.000Z'),
    idleDeadlineAt: new Date('2026-08-27T10:31:00.000Z'),
    provider: 'test-provider',
    model: 'test-model',
    expiredAttemptRetryAt: new Date('2026-08-27T10:34:00.000Z'),
    now: new Date('2026-08-27T10:29:00.000Z'),
  });
  assert.equal(reapedIdleAttempt.status, 'cooldown_active');
  assert.equal(reapedIdleAttempt.attempt.state, 'timed_out');
  assert.equal(reapedIdleAttempt.attempt.reasonCode, 'summary_idle_timeout');
  assert.equal(reapedIdleAttempt.attempt.durationMs, 120_000);

  await assert.rejects(
    startPiSessionCompactionAttemptOnConnection(connection, provider, {
      ...scope,
      workspaceId: 'workspace-other',
      attemptId: `attempt-${provider}-wrong-scope`,
      trigger: 'manual',
      expectedSummaryRevision: 3,
      expectedThroughSequence: 4,
      deadlineAt: new Date('2026-08-27T10:45:00.000Z'),
      provider: 'test-provider',
      model: 'test-model',
      now: new Date('2026-08-27T10:40:00.000Z'),
    }),
    PiCompactionScopeError,
  );

  const audit = await auditPiMessageSequenceIntegrityOnConnection(connection, session.id);
  assert.deepEqual(audit, {
    messageCount: 4,
    distinctSequenceCount: 4,
    minimumSequence: 1,
    maximumSequence: 4,
    nullSequenceCount: 0,
    valid: true,
  });

  await connection.run('DROP INDEX idx_pi_messages_session_sequence_unique');
  await connection.run(
    `INSERT INTO pi_messages (pi_session_db_id, role, content, timestamp, sequence)
     VALUES (?, 'user', ?, ?, 4)`,
    [session.id, JSON.stringify({ role: 'user', content: 'duplicate sequence' }), 1_700_000_005],
  );
  await assert.rejects(
    startPiSessionCompactionAttemptOnConnection(connection, provider, {
      ...scope,
      attemptId: `attempt-${provider}-invalid-history`,
      trigger: 'manual',
      expectedSummaryRevision: 3,
      expectedThroughSequence: 4,
      deadlineAt: new Date('2026-08-27T10:45:00.000Z'),
      provider: 'test-provider',
      model: 'test-model',
      now: new Date('2026-08-27T10:40:00.000Z'),
    }),
    PiCompactionHistoryIntegrityError,
  );
}

async function main(): Promise<void> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  runMigrations(sqlite);
  try {
    const columns = sqlite.prepare('PRAGMA table_info(pi_sessions)').all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'summary_revision'));
    assert.ok(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_session_compaction_attempts'").get());
    const attemptColumns = sqlite.prepare('PRAGMA table_info(pi_session_compaction_attempts)').all() as Array<{ name: string }>;
    assert.ok(attemptColumns.some((column) => column.name === 'attempt_ordinal'));
    assert.ok(attemptColumns.some((column) => column.name === 'telemetry_json'));
    assert.ok(attemptColumns.some((column) => column.name === 'progress_event_count'));
    assert.ok(attemptColumns.some((column) => column.name === 'idle_deadline_at'));
    assert.ok(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_pi_compaction_attempts_active_session'").get());
    assert.ok(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_pi_compaction_attempts_session_ordinal'").get());
    await exerciseStore(sqliteConnection(sqlite), 'sqlite');
    runMigrations(sqlite);
    assert.equal(
      sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_pi_messages_session_sequence_unique'").get(),
      undefined,
      'a legacy sequence conflict must defer the unique index instead of rewriting history',
    );
  } finally {
    sqlite.close();
  }

  const postgres = new PGlite();
  try {
    const migrationTarget = postgres as unknown as Parameters<typeof runPostgresMigrations>[0];
    await runPostgresMigrations(migrationTarget);
    await postgres.exec(`
      DROP TABLE pi_session_compaction_attempts;
      ALTER TABLE pi_sessions DROP COLUMN summary_revision;
      DROP INDEX idx_pi_messages_session_sequence_unique;
    `);
    await runPostgresMigrations(migrationTarget);
    const postgresColumns = await postgres.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'pi_sessions' AND column_name = 'summary_revision'
    `);
    assert.equal(postgresColumns.rows.length, 1);
    const postgresAttemptTable = await postgres.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name = 'pi_session_compaction_attempts'
    `);
    assert.equal(postgresAttemptTable.rows.length, 1);
    const postgresSequenceIndex = await postgres.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'pi_messages' AND indexname = 'idx_pi_messages_session_sequence_unique'
    `);
    assert.equal(postgresSequenceIndex.rows.length, 1);
    const postgresAttemptIndexes = await postgres.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'pi_session_compaction_attempts'
        AND indexname IN (
          'idx_pi_compaction_attempts_active_session',
          'idx_pi_compaction_attempts_session_ordinal',
          'idx_pi_compaction_attempts_state_deadline'
        )
    `);
    assert.equal(postgresAttemptIndexes.rows.length, 3);
    await postgres.exec(`
      DROP INDEX idx_pi_compaction_attempts_session_ordinal;
      ALTER TABLE pi_session_compaction_attempts DROP COLUMN attempt_ordinal;
    `);
    await runPostgresMigrations(migrationTarget);
    const restoredAttemptOrdinal = await postgres.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'pi_session_compaction_attempts' AND column_name = 'attempt_ordinal'
    `);
    assert.equal(restoredAttemptOrdinal.rows.length, 1);
    const restoredAttemptOrdinalIndex = await postgres.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'pi_session_compaction_attempts'
        AND indexname = 'idx_pi_compaction_attempts_session_ordinal'
    `);
    assert.equal(restoredAttemptOrdinalIndex.rows.length, 1);
    const postgresTelemetryColumns = await postgres.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'pi_session_compaction_attempts'
        AND column_name IN ('telemetry_json', 'progress_event_count', 'idle_deadline_at')
    `);
    assert.equal(postgresTelemetryColumns.rows.length, 3);
    await exerciseStore(postgresConnection(postgres), 'postgres');
    await runPostgresMigrations(migrationTarget);
    const deferredSequenceIndex = await postgres.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'pi_messages' AND indexname = 'idx_pi_messages_session_sequence_unique'
    `);
    assert.equal(
      deferredSequenceIndex.rows.length,
      0,
      'PostgreSQL must also defer the unique index when the audit finds legacy conflicts',
    );
  } finally {
    await postgres.close();
  }

  console.log('pi-session-compaction-store-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
