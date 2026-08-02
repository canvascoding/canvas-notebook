import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import {
  LicenseControlPlaneError,
} from '../app/lib/license/control-plane';
import {
  TEAM_SEAT_ERROR_CODES,
  TeamSeatContractError,
} from '../app/lib/license/team-seat-contract';
import {
  claimTeamSeatOutboxOperation,
  enqueueTeamSeatOutboxOperation,
  getTeamSeatOutboxOperation,
  recordTeamSeatOutboxOperationSuccess,
} from '../app/lib/license/team-seat-outbox';
import {
  runTeamSeatOutboxWorkerCycle,
} from '../app/lib/license/team-seat-outbox-worker';
import {
  registerTeamSeatOutboxWorkerSignal,
} from '../app/lib/license/team-seat-outbox-worker-signal';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'canvas-team-seat-worker-'));
const sqlitePath = path.join(tempRoot, 'worker.db');
const sqlite = new Database(sqlitePath);
sqlite.pragma('foreign_keys = ON');
runMigrations(sqlite);
const competingSqlite = new Database(sqlitePath);
competingSqlite.pragma('foreign_keys = ON');
competingSqlite.pragma('busy_timeout = 5000');

const connection = {
  get: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sql).get(...params) : sqlite.prepare(sql).get()
  ),
  run: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sql).run(...params) : sqlite.prepare(sql).run()
  ),
  all: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sql).all(...params) : sqlite.prepare(sql).all()
  ),
  close: () => undefined,
};
const competingConnection = {
  get: (sql: string, params?: unknown[]) => (
    params ? competingSqlite.prepare(sql).get(...params) : competingSqlite.prepare(sql).get()
  ),
  run: (sql: string, params?: unknown[]) => (
    params ? competingSqlite.prepare(sql).run(...params) : competingSqlite.prepare(sql).run()
  ),
  all: (sql: string, params?: unknown[]) => (
    params ? competingSqlite.prepare(sql).all(...params) : competingSqlite.prepare(sql).all()
  ),
  close: () => undefined,
};

async function enqueue(
  dedupeKey: string,
  operationKind: 'seat_prepare' | 'seat_execute',
  now: number,
  maxAttempts = 3,
) {
  return (await enqueueTeamSeatOutboxOperation(connection, {
    organizationId: 'organization-worker',
    dedupeKey,
    operationKind,
    operationType: 'member_create',
    request: { protocolVersion: 'canvas-team-seat-protocol-v1', dedupeKey },
    now: now - 1_000,
    nextAttemptAt: now - 1_000,
    maxAttempts,
  })).operation;
}

async function succeed(operationId: string, now: number): Promise<void> {
  await recordTeamSeatOutboxOperationSuccess(connection, {
    operationId,
    response: { ok: true, operationId },
    now,
  });
}

async function main(): Promise<void> {
  sqlite.prepare(`
    INSERT INTO "user" (
      id, name, email, email_verified, role, created_at, updated_at
    ) VALUES ('owner-worker', 'Owner', 'owner@example.test', 1, 'admin', 1, 1)
  `).run();
  sqlite.prepare(`
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('organization-worker', 'owner-worker', 'team', 1, 1, 1)
  `).run();

  let signals = 0;
  registerTeamSeatOutboxWorkerSignal(() => {
    signals += 1;
  });
  const parallel = await enqueue('worker-parallel', 'seat_prepare', 1_000);
  assert.equal(signals, 1);

  let releaseDispatch!: () => void;
  let markDispatchStarted!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => {
    markDispatchStarted = resolve;
  });
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  let parallelDispatches = 0;
  const firstWorker = runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 1_000,
    leaseMs: 1_000,
    dispatchOperation: async (operation) => {
      parallelDispatches += 1;
      markDispatchStarted();
      await dispatchGate;
      await succeed(operation.operationId, 1_001);
    },
  });
  await dispatchStarted;
  const competingWorker = await runTeamSeatOutboxWorkerCycle({
    database: competingConnection,
    now: 1_000,
    leaseMs: 1_000,
    dispatchOperation: async () => {
      throw new Error('A concurrently leased operation must not be dispatched.');
    },
  });
  assert.equal(competingWorker.claimed, 0);
  releaseDispatch();
  const firstResult = await firstWorker;
  assert.equal(firstResult.succeeded, 1);
  assert.equal(parallelDispatches, 1);
  assert.equal((await getTeamSeatOutboxOperation(connection, parallel.operationId))?.status, 'succeeded');
  assert.equal((await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 10_000,
    dispatchOperation: async () => {
      throw new Error('Succeeded operations must never be dispatched again.');
    },
  })).claimed, 0);

  const crashedPrepare = await enqueue('worker-crash-prepare', 'seat_prepare', 20_000);
  const initialClaim = await claimTeamSeatOutboxOperation(connection, {
    operationId: crashedPrepare.operationId,
    allowPending: true,
    now: 20_000,
    leaseMs: 1_000,
  });
  assert.equal(initialClaim.claimed, true);
  assert.equal((await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 20_999,
    leaseMs: 1_000,
    dispatchOperation: async () => {
      throw new Error('A live lease must not be recovered early.');
    },
  })).claimed, 0);
  const recovered = await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 21_000,
    leaseMs: 1_000,
    dispatchOperation: async (operation) => {
      assert.equal(operation.operationId, crashedPrepare.operationId);
      await succeed(operation.operationId, 21_000);
    },
  });
  assert.equal(recovered.succeeded, 1);

  const execute = await enqueue('worker-explicit-execute', 'seat_execute', 30_000);
  assert.equal((await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 30_000,
    leaseMs: 1_000,
    dispatchOperation: async () => {
      throw new Error('An unarmed Seat execution must not run automatically.');
    },
  })).claimed, 0);
  assert.equal((await claimTeamSeatOutboxOperation(connection, {
    operationId: execute.operationId,
    allowPending: true,
    now: 30_000,
    leaseMs: 1_000,
  })).claimed, true);
  const recoveredExecute = await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 31_000,
    leaseMs: 1_000,
    dispatchOperation: async (operation) => {
      assert.equal(operation.operationId, execute.operationId);
      await succeed(operation.operationId, 31_000);
    },
  });
  assert.equal(recoveredExecute.succeeded, 1);

  const temporary = await enqueue('worker-temporary', 'seat_prepare', 40_000);
  const deferred = await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 40_000,
    dispatchOperation: async () => {
      throw new Error('temporary transport failure');
    },
  });
  assert.equal(deferred.deferred, 1);
  const retryWait = await getTeamSeatOutboxOperation(connection, temporary.operationId);
  assert.equal(retryWait?.status, 'retry_wait');
  assert.equal(retryWait?.attemptCount, 1);
  assert.equal(retryWait?.nextAttemptAt, 55_000);
  assert.equal((await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 54_999,
    dispatchOperation: async () => {
      throw new Error('Backoff must be respected.');
    },
  })).claimed, 0);
  const retried = await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 55_000,
    dispatchOperation: async (operation) => {
      assert.equal(operation.operationId, temporary.operationId);
      await succeed(operation.operationId, 55_000);
    },
  });
  assert.equal(retried.succeeded, 1);

  const authentication = await enqueue('worker-terminal-auth', 'seat_prepare', 60_000);
  let authenticationDispatches = 0;
  const authenticationFailure = await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 60_000,
    dispatchOperation: async () => {
      authenticationDispatches += 1;
      throw new LicenseControlPlaneError(
        'Bearer super-secret-token was rejected.',
        401,
        TEAM_SEAT_ERROR_CODES.tokenInvalid,
        false,
        null,
        'authentication',
      );
    },
  });
  assert.equal(authenticationFailure.failed, 1);
  const failedAuthentication = await getTeamSeatOutboxOperation(
    connection,
    authentication.operationId,
  );
  assert.equal(failedAuthentication?.status, 'failed');
  assert.equal(failedAuthentication?.attemptCount, 1);
  assert.doesNotMatch(failedAuthentication?.lastError || '', /super-secret-token/u);
  assert.equal((await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 120_000,
    dispatchOperation: async () => {
      authenticationDispatches += 1;
    },
  })).claimed, 0);
  assert.equal(authenticationDispatches, 1);
  const explicitRecovery = await claimTeamSeatOutboxOperation(connection, {
    operationId: authentication.operationId,
    allowPending: true,
    allowFailed: true,
    now: 120_001,
  });
  assert.equal(explicitRecovery.claimed, true);
  assert.equal(explicitRecovery.operation.operationId, authentication.operationId);
  await succeed(authentication.operationId, 120_001);
  assert.equal(
    (await getTeamSeatOutboxOperation(connection, authentication.operationId))?.status,
    'succeeded',
  );

  const contract = await enqueue('worker-terminal-contract', 'seat_prepare', 130_000);
  const contractFailure = await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 130_000,
    dispatchOperation: async () => {
      throw new TeamSeatContractError(
        TEAM_SEAT_ERROR_CODES.invalidRequest,
        'The persisted response violates the protocol.',
        'response',
      );
    },
  });
  assert.equal(contractFailure.failed, 1);
  assert.equal((await getTeamSeatOutboxOperation(connection, contract.operationId))?.status, 'failed');

  const exhausted = await enqueue('worker-retry-exhausted', 'seat_prepare', 140_000, 2);
  const alwaysTemporary = async () => {
    throw new Error('The network remains unavailable.');
  };
  assert.equal((await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 140_000,
    dispatchOperation: alwaysTemporary,
  })).deferred, 1);
  const exhaustedResult = await runTeamSeatOutboxWorkerCycle({
    database: connection,
    now: 155_000,
    dispatchOperation: alwaysTemporary,
  });
  assert.equal(exhaustedResult.failed, 1);
  const exhaustedOperation = await getTeamSeatOutboxOperation(
    connection,
    exhausted.operationId,
  );
  assert.equal(exhaustedOperation?.status, 'failed');
  assert.equal(exhaustedOperation?.attemptCount, 2);
  assert.equal(exhaustedOperation?.nextAttemptAt, null);

  const instrumentationSource = readFileSync(
    path.join(process.cwd(), 'instrumentation.ts'),
    'utf8',
  );
  assert.match(instrumentationSource, /initializeTeamSeatOutboxWorkerRuntime/u);
  registerTeamSeatOutboxWorkerSignal(null);
  console.log('team-seat-outbox-worker-test: ok');
}

void main()
  .finally(() => {
    competingSqlite.close();
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
