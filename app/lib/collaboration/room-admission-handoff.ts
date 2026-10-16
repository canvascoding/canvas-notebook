import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import type { SqlConnection } from '@/app/lib/db';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { captureCollaborationAdmissionScopeTargets, captureCollaborationAdmissionTargetRow,
  type CollaborationAdmissionTarget } from './room-admission';
import { captureCollaborationAdmissionRequest, CollaborationAdmissionError,
  collaborationAdmissionLockKey, type CollaborationAdmissionRequest } from './room-admission-contract';
import { captureCollaborationAdmissionOutcomeResult, captureCollaborationAdmissionOutcomeSnapshot,
  assertUnchangedCollaborationAdmissionAbortSnapshot, captureCollaborationAdmissionAbortReason,
  collaborationAdmissionOutcomeDigest, readCollaborationAdmissionOutcome,
  serializeCollaborationAdmissionOutcome,
  type CollaborationAdmissionAbortReason, type CollaborationAdmissionOutcome } from './room-admission-outcome';
import { inspectCollaborationAdmissionQuiescence,
  type CollaborationAdmissionQuiescenceProof } from './room-admission-quiescence';
import { lockIdentity } from './room-owner';
import { hasCollaborationHandoffExecutionContext, withCollaborationHandoffExecutionContext } from './handoff-execution-context';
import { getWorkspaceFileLifecycleLeases } from './file-lifecycle-admission-context';
import type { RichMigrationTransaction } from './rich-migration-domain';

type Captured = ReturnType<typeof captureCollaborationAdmissionRequest>;
type Row = Record<string, unknown>;
type HandoffPreparation = {
  authorize: (request: CollaborationAdmissionRequest) => Promise<void>;
  prepare: (database: SqlConnection) => Promise<void>;
  withMutationTransaction?: RichMigrationTransaction;
};
type HandoffMutation = HandoffPreparation & {
  mutate: (database: SqlConnection, proofs: readonly CollaborationAdmissionQuiescenceProof[])
    => Promise<Readonly<Record<string, string>>>;
};
type HandoffOperation = (HandoffMutation & { kind: 'apply' })
  | (HandoffPreparation & { kind: 'abort'; reasonCode: CollaborationAdmissionAbortReason });

// This authority cannot be manufactured by a caller or transferred to a wrapper
// connection. It exists only while the verified handoff awaits its SQL mutation.
const mutationAuthorities = new WeakMap<SqlConnection, {
  request: CollaborationAdmissionRequest;
  targets: readonly CollaborationAdmissionTarget[];
  claimed: Set<string>;
  active: boolean;
  inFlight: number;
}>();

export function requireCollaborationAdmissionMutationRequest(
  database: SqlConnection, action: CollaborationAdmissionRequest['action'],
): CollaborationAdmissionRequest {
  const authority = mutationAuthorities.get(database);
  if (!authority?.active || authority.request.action !== action) {
    throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  }
  return authority.request;
}

/** Track the whole persistence call, including awaits before its single-use claim. */
export async function withCollaborationAdmissionMutation<T>(
  database: SqlConnection, action: CollaborationAdmissionRequest['action'],
  operation: (assertActive: () => void) => Promise<T>,
): Promise<T> {
  requireCollaborationAdmissionMutationRequest(database, action);
  const authority = mutationAuthorities.get(database)!;
  const assertActive = () => {
    if (!authority.active || mutationAuthorities.get(database) !== authority) {
      throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    }
  };
  authority.inFlight += 1;
  try { return await operation(assertActive); }
  finally { authority.inFlight -= 1; }
}

/** Single-use authority for the exact locked input, including deletion-only updates. */
export function claimCollaborationAdmissionMutation(
  database: SqlConnection, action: CollaborationAdmissionRequest['action'], row: Row,
): void {
  requireCollaborationAdmissionMutationRequest(database, action);
  const authority = mutationAuthorities.get(database)!;
  const target = authority.targets.find((candidate) => candidate.document.documentId === row.document_id);
  if (!target || authority.claimed.has(target.document.documentId)) {
    throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  }
  const current = captureCollaborationAdmissionTargetRow(row, target.document);
  if (current.ownerToken !== null || current.ownerBackendPid !== null || current.ownerBackendStart !== null
    || JSON.stringify(current) !== JSON.stringify(target)) {
    throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  }
  authority.claimed.add(target.document.documentId);
}

class UnconfirmedHandoffCommit extends Error {
  constructor(readonly outcome: CollaborationAdmissionOutcome, cause: unknown) {
    super('The handoff commit needs durable verification.', { cause });
  }
}

/** The existing DA04 transition, shared by an owning service and a borrowed
 * phase. This owns neither a connection nor a transaction/lock lifetime. */
async function executeCapturedHandoffOnConnection(
  transaction: SqlConnection, captured: Captured, domain: HandoffOperation,
  afterMutation?: () => Promise<void>,
): Promise<CollaborationAdmissionOutcome> {
  await domain.prepare(transaction);
  if (domain.kind === 'abort') await domain.authorize(captured.request);
  const header = await transaction.get(
    'SELECT * FROM collaboration_admission_requests WHERE request_id = $1 FOR UPDATE',
    [captured.request.requestId]) as Row | undefined;
  if (!header || header.request_digest !== captured.requestDigest || header.intent_text !== captured.intentText) {
    throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  }
  if (header.status === 'committed') {
    const completed = await readCollaborationAdmissionOutcome(transaction, captured);
    if (!completed) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    return completed;
  }
  const revision = Number(header.revision);
  if (!['reserved', 'draining'].includes(header.status as string) || header.outcome_text !== null
    || !Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  }
  const rows = await transaction.all(`SELECT document_id FROM collaboration_admission_targets
    WHERE request_id = $1 ORDER BY document_id FOR UPDATE`, [captured.request.requestId]) as Row[];
  if (rows.length !== captured.request.expectedDocuments.length || rows.some((row, index) =>
    row.document_id !== captured.request.expectedDocuments[index].documentId)) {
    throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  }
  const before = await captureCollaborationAdmissionScopeTargets(transaction, captured);
  const proofs: CollaborationAdmissionQuiescenceProof[] = [];
  for (const document of captured.request.expectedDocuments) {
    const inspected = await inspectCollaborationAdmissionQuiescence(transaction, captured, document.documentId);
    if (!inspected.alreadyProven) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    proofs.push(inspected.proof);
  }
  let result = captureCollaborationAdmissionOutcomeResult({});
  if (domain.kind === 'apply') {
    if (mutationAuthorities.has(transaction)) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    const authority = { request: captured.request, targets: before, claimed: new Set<string>(), active: true, inFlight: 0 };
    mutationAuthorities.set(transaction, authority);
    try {
      result = captureCollaborationAdmissionOutcomeResult(await domain.mutate(transaction, Object.freeze(proofs)));
    } finally {
      authority.active = false;
      mutationAuthorities.delete(transaction);
    }
    // A detached persistence call must roll back, never escape the lease.
    if (authority.inFlight !== 0) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    if (afterMutation) await afterMutation();
  }
  const targets = [];
  for (const [index, proof] of proofs.entries()) {
    const row = await transaction.get('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
      [proof.documentId]) as Row | undefined;
    if (!row) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
    const snapshot = captureCollaborationAdmissionOutcomeSnapshot(row, captured);
    if (snapshot.ownerEpoch !== before[index].ownerEpoch || snapshot.documentSequence < before[index].documentSequence
      || snapshot.document.lifecycleGeneration < before[index].document.lifecycleGeneration) {
      throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
    }
    const snapshotText = JSON.stringify(snapshot);
    if (domain.kind === 'abort') {
      assertUnchangedCollaborationAdmissionAbortSnapshot(captured, proof.documentId, proof.proofText, snapshotText);
      if (snapshotText !== JSON.stringify(before[index])) throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
    }
    const snapshotDigest = collaborationAdmissionOutcomeDigest('snapshot', snapshotText);
    targets.push(Object.freeze({ documentId: proof.documentId,
      proofDigest: collaborationAdmissionOutcomeDigest('input', proof.proofText), snapshotText, snapshotDigest }));
    await transaction.run(`UPDATE collaboration_admission_targets SET status = 'completed', active = false,
      outcome_snapshot_text = $3, outcome_snapshot_digest = $4 WHERE request_id = $1 AND document_id = $2`,
    [captured.request.requestId, proof.documentId, snapshotText, snapshotDigest]);
  }
  const outcome: CollaborationAdmissionOutcome = Object.freeze({
    ...(domain.kind === 'abort' ? { version: 2 as const, disposition: 'aborted' as const, reasonCode: domain.reasonCode }
      : { version: 1 as const }), requestId: captured.request.requestId,
    requestDigest: captured.requestDigest, result, targets: Object.freeze(targets) });
  const outcomeText = serializeCollaborationAdmissionOutcome(outcome);
  await transaction.run(`UPDATE collaboration_admission_requests SET status = 'committed', revision = revision + 1,
    completed_at = $2, outcome_text = $3 WHERE request_id = $1`,
  [captured.request.requestId, Date.now(), outcomeText]);
  return outcome;
}

export type BorrowedCollaborationAdmissionHandoffOperation =
  | (Omit<HandoffMutation, 'withMutationTransaction'> & { kind: 'apply' })
  | (Omit<HandoffPreparation, 'withMutationTransaction'> & { kind: 'abort'; reasonCode: CollaborationAdmissionAbortReason });
type BorrowedIdentity = Readonly<{
  backend: number; start: string; database: string; schema: string; searchPath: string; transaction: string;
}>;
type BorrowedFrame = { active: boolean; failure?: Error };
const borrowedHandoffContext = new AsyncLocalStorage<BorrowedFrame>();
const borrowedHandoffConnections = new WeakMap<SqlConnection, BorrowedFrame>();
function captureBorrowedOperation(input: BorrowedCollaborationAdmissionHandoffOperation): BorrowedCollaborationAdmissionHandoffOperation {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  const field = (name: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
    return descriptor.value;
  };
  const kind = field('kind');
  const keys = kind === 'apply' ? ['kind', 'authorize', 'prepare', 'mutate']
    : kind === 'abort' ? ['kind', 'authorize', 'prepare', 'reasonCode'] : [];
  if (!keys.length || Reflect.ownKeys(input).length !== keys.length
    || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  const authorize = field('authorize'), prepare = field('prepare');
  if (typeof authorize !== 'function' || typeof prepare !== 'function') throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  if (kind === 'abort') return Object.freeze({ kind, authorize, prepare, reasonCode: captureCollaborationAdmissionAbortReason(field('reasonCode')) });
  const mutate = field('mutate');
  if (typeof mutate !== 'function') throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  return Object.freeze({ kind: 'apply', authorize, prepare, mutate });
}
async function borrowedIdentity(database: SqlConnection, assign: boolean): Promise<BorrowedIdentity> {
  let row: Row | undefined;
  try { row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS backend,
    extract(epoch FROM a.backend_start)::text AS start,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::text AS schema,
    pg_catalog.current_setting('search_path') AS search_path,
    pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('session_replication_role') AS replication,
    ${assign ? 'pg_catalog.pg_current_xact_id()' : 'pg_catalog.pg_current_xact_id_if_assigned()'}::text AS transaction
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Row | undefined; }
  catch (cause) { const error = new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED'); error.cause = cause; throw error; }
  if (!row || !Number.isSafeInteger(row.backend) || Number(row.backend) < 1
    || typeof row.start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.start)
    || typeof row.database !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(row.database)
    || typeof row.schema !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(row.schema)
    || typeof row.search_path !== 'string' || !row.search_path
    || typeof row.transaction !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(row.transaction)
    || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin') {
    throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  }
  return Object.freeze({ backend: Number(row.backend), start: row.start, database: row.database,
    schema: row.schema, searchPath: row.search_path, transaction: row.transaction });
}

/** Borrowed, already-authorized domain phase on the caller's actual B/TX.
 * Never checks out, commits, rolls back, closes, or reacquires a workspace mutex.
 * The owner must retain its real workspace/room session guards across B1/FS/B2
 * and must abandon the transaction on ANY error. PostgreSQL lock observations
 * alone do not prove that outer lifetime or confer principal authorization.
 * Historical completed reads still authorize, but need no new mutation guards. */
export async function executeCollaborationAdmissionHandoffOnConnection(
  database: SqlConnection, input: CollaborationAdmissionRequest, domain: BorrowedCollaborationAdmissionHandoffOperation,
): Promise<CollaborationAdmissionOutcome> {
  const inherited = borrowedHandoffContext.getStore();
  if (inherited) {
    const error = new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED'); inherited.failure ??= error; throw error;
  }
  if (!database || typeof database !== 'object') throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  const sibling = borrowedHandoffConnections.get(database);
  if (sibling) {
    const error = new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED'); sibling.failure ??= error; throw error;
  }
  const frame: BorrowedFrame = { active: true };
  borrowedHandoffConnections.set(database, frame);
  const assertFrame = () => {
    if (frame.failure) throw frame.failure;
    if (!frame.active) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  };
  try {
    const captured = captureCollaborationAdmissionRequest(input);
    const operation = captureBorrowedOperation(domain);
    if (captured.request.actionPayloadText === undefined || hasCollaborationHandoffExecutionContext()) {
      throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
    }
    assertFrame();
    const pinned = await borrowedIdentity(database, true);
    assertFrame();
    let checkMutation: (() => Promise<void>) | undefined;
    const check = async () => {
      assertFrame();
      try {
        const current = await borrowedIdentity(database, false);
        if (JSON.stringify(current) !== JSON.stringify(pinned)) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
        if (checkMutation) await checkMutation();
        assertFrame();
      } catch (error) {
        const failure = error instanceof CollaborationAdmissionError ? error : new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
        if (failure !== error) failure.cause = error;
        frame.failure ??= failure; throw frame.failure;
      }
    };
    await check(); // Two observations reject autocommit before any domain callback.
    assertFrame();
    const result = await borrowedHandoffContext.run(frame, () => withCollaborationHandoffExecutionContext(async () => {
      await operation.authorize(captured.request); assertFrame(); await check(); assertFrame();
      const completed = await readCollaborationAdmissionOutcome(database, captured); assertFrame(); await check(); assertFrame();
      if (completed) return completed;
      const context = getWorkspaceFileLifecycleLeases();
      const leases = captured.workspaceIds.map(workspaceId => ({ workspaceId, lease: context?.get(workspaceId) }));
      if (leases.some(item => !item.lease?.active)) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
      const keys = [...captured.workspaceIds.map(collaborationAdmissionLockKey),
        ...captured.request.expectedDocuments.map(document => lockIdentity(document.documentId).key)]
        .map(key => BigInt.asUintN(64, BigInt(key)).toString());
      if (new Set(keys).size !== keys.length) throw new CollaborationAdmissionError('ADMISSION_CONFLICT');
      checkMutation = async () => {
        for (const { workspaceId, lease } of leases) {
          if (!lease?.active || getWorkspaceFileLifecycleLeases()?.get(workspaceId) !== lease
            || !await lease.verify() || !lease.active || getWorkspaceFileLifecycleLeases()?.get(workspaceId) !== lease) {
            throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
          }
        }
        const held = await database.get(`SELECT count(*)::integer AS count FROM pg_catalog.pg_locks l
          WHERE l.pid=pg_catalog.pg_backend_pid() AND l.pid=$1 AND l.locktype='advisory'
            AND l.granted AND l.mode='ExclusiveLock' AND l.objsubid=1 AND l.database=$2::oid
            AND (l.classid::bigint::numeric*4294967296+l.objid::bigint::numeric)=ANY($3::numeric[])`,
        [pinned.backend, pinned.database, keys]) as Row | undefined;
        if (held?.count !== keys.length) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
        const current = await borrowedIdentity(database, false);
        if (JSON.stringify(current) !== JSON.stringify(pinned)) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
      };
      const authorize: HandoffPreparation['authorize'] = async request => {
        await check(); assertFrame(); await operation.authorize(request); assertFrame(); await check(); assertFrame();
      };
      const prepare: HandoffPreparation['prepare'] = async connection => {
        await check(); assertFrame(); await operation.prepare(connection); assertFrame(); await check(); assertFrame();
      };
      const guarded: HandoffOperation = operation.kind === 'apply'
        ? { kind: 'apply', authorize, prepare, mutate: async (connection, proofs) => {
          await check(); assertFrame(); return operation.mutate(connection, proofs);
        } }
        : { kind: 'abort', authorize, prepare, reasonCode: operation.reasonCode };
      await check(); assertFrame();
      const result = await executeCapturedHandoffOnConnection(database, captured, guarded, check);
      assertFrame(); await check(); assertFrame(); return result;
    }));
    assertFrame(); return result;
  } finally { frame.active = false; if (borrowedHandoffConnections.get(database) === frame) borrowedHandoffConnections.delete(database); }
}

/**
 * Internal SQL handoff, deliberately not installed in runtime lifecycle routes.
 * The caller authorizes every invocation (including completed retries), repeats
 * write authorization with domain/path locks in prepare, and only writes SQL in
 * mutate. Filesystem projection needs its own durable journal. readOutcome and
 * loadRequest are trusted coordinator reads, not user-facing authorization APIs.
 * openConnection must return a dedicated, bounded-query session whose close(error)
 * destroys its backend. withMutationLocks must await the entire callback, COMMIT
 * included. Guards are acquired before that wrapper and retained on the same SQL
 * session until it is destroyed, including successful commits and failed tries.
 */
export function createCollaborationAdmissionHandoffService(options: {
  openConnection: () => Promise<SqlConnection>;
  withMutationLocks: <T>(workspaceIds: readonly string[], operation: () => Promise<T>) => Promise<T>;
}) {
  const readTransaction = async <T>(read: (database: SqlConnection) => Promise<T>): Promise<T> => {
    const database = await options.openConnection();
    try {
      // FOR SHARE requires a normal transaction, although this path writes no data.
      await database.run('BEGIN');
      await database.run("SET LOCAL statement_timeout = '5s'");
      await database.run("SET LOCAL lock_timeout = '4s'");
      return await read(database);
    } finally {
      await database.close(new Error('Discarding admission outcome read session.'));
    }
  };
  const readCaptured = (captured: Captured) => readTransaction(
    (database) => readCollaborationAdmissionOutcome(database, captured));

  const service = {
    readOutcome(input: CollaborationAdmissionRequest): Promise<CollaborationAdmissionOutcome | null> {
      return readCaptured(captureCollaborationAdmissionRequest(input));
    },

    loadRequest(requestId: string): Promise<CollaborationAdmissionRequest | null> {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(requestId)) {
        throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
      }
      return readTransaction(async (database) => {
        const row = await database.get('SELECT * FROM collaboration_admission_requests WHERE request_id = $1 FOR SHARE',
          [requestId]) as Row | undefined;
        if (!row) return null;
        let captured: Captured;
        try { captured = captureCollaborationAdmissionRequest(JSON.parse(row.intent_text as string)); }
        catch { throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED'); }
        if (captured.request.requestId !== requestId || captured.intentText !== row.intent_text
          || captured.requestDigest !== row.request_digest || captured.request.actionPayloadText === undefined) {
          throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
        }
        return captured.request;
      });
    },

    async executeHandoff(input: CollaborationAdmissionRequest, domain: HandoffOperation): Promise<CollaborationAdmissionOutcome> {
      const captured = captureCollaborationAdmissionRequest(input);
      if (captured.request.actionPayloadText === undefined) {
        throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
      }
      // A committed retry still requires read/action access, even though it must
      // not reenter mutation locks or execute the domain operation a second time.
      await domain.authorize(captured.request);
      const previous = await readCaptured(captured);
      if (previous) return previous;

      const database = await options.openConnection();
      let closed = false;
      const dedicated: SqlConnection = {
        get: (sql, params) => database.get(sql, params),
        all: (sql, params) => database.all(sql, params),
        run: (sql, params) => database.run(sql, params),
        close: async (error) => {
          if (closed) return;
          closed = true;
          await database.close(error ?? new Error('Discarding guarded admission handoff session.'));
        },
      };
      try {
        const keys = captured.request.expectedDocuments.map((document) => lockIdentity(document.documentId).key);
        if (new Set(keys).size !== keys.length) throw new CollaborationAdmissionError('ADMISSION_CONFLICT');
        for (const key of keys.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)) {
          const row = await database.get('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key]) as Row | undefined;
          if (row?.locked !== true) {
            await dedicated.close();
            const completed = await readCaptured(captured);
            if (completed) return completed;
            throw new CollaborationAdmissionError('ADMISSION_CONFLICT');
          }
        }
        try {
          return await options.withMutationLocks(captured.workspaceIds, () => executeLifecycleTransaction({
            openConnection: async () => dedicated,
            execute: async (transaction) => {
              await transaction.run("SET LOCAL statement_timeout = '5s'");
              await transaction.run("SET LOCAL lock_timeout = '4s'");
              const execute = () => executeCapturedHandoffOnConnection(transaction, captured, domain);
              return domain.withMutationTransaction ? domain.withMutationTransaction(transaction, execute) : execute();
            },
            recoverCommitted: async (attempted, cause) => { throw new UnconfirmedHandoffCommit(attempted, cause); },
          }));
        } catch (error) {
          // executeLifecycleTransaction has destroyed the uncertain backend, and
          // the workspace/path wrapper has now unwound. Do not acquire a new room
          // guard here: a new owner may legitimately hold it after this COMMIT.
          if (!(error instanceof UnconfirmedHandoffCommit)) throw error;
          const completed = await readCaptured(captured);
          if (!completed || JSON.stringify(completed) !== JSON.stringify(error.outcome)) {
            throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
          }
          return completed;
        }
      } finally {
        if (!closed) await dedicated.close();
      }
    },
  };
  return {
    readOutcome: service.readOutcome,
    loadRequest: service.loadRequest,
    execute(input: CollaborationAdmissionRequest, domain: HandoffMutation) {
      return withCollaborationHandoffExecutionContext(() => service.executeHandoff(input, { ...domain, kind: 'apply' }));
    },
    /** Explicit, proven no-write terminal outcome; never a catch-all error handler. */
    abort(input: CollaborationAdmissionRequest, domain: HandoffPreparation, reasonCode: CollaborationAdmissionAbortReason) {
      return withCollaborationHandoffExecutionContext(() => service.executeHandoff(input, {
        kind: 'abort', authorize: domain.authorize, prepare: domain.prepare,
        withMutationTransaction: domain.withMutationTransaction,
        reasonCode: captureCollaborationAdmissionAbortReason(reasonCode),
      }));
    },
  };
}
