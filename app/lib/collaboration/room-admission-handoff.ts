import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { captureCollaborationAdmissionScopeTargets, captureCollaborationAdmissionTargetRow,
  type CollaborationAdmissionTarget } from './room-admission';
import { captureCollaborationAdmissionRequest, CollaborationAdmissionError,
  type CollaborationAdmissionRequest } from './room-admission-contract';
import { captureCollaborationAdmissionOutcomeResult, captureCollaborationAdmissionOutcomeSnapshot,
  collaborationAdmissionOutcomeDigest, readCollaborationAdmissionOutcome,
  serializeCollaborationAdmissionOutcome,
  type CollaborationAdmissionOutcome } from './room-admission-outcome';
import { inspectCollaborationAdmissionQuiescence,
  type CollaborationAdmissionQuiescenceProof } from './room-admission-quiescence';
import { lockIdentity } from './room-owner';

type Captured = ReturnType<typeof captureCollaborationAdmissionRequest>;
type Row = Record<string, unknown>;

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

    async execute(input: CollaborationAdmissionRequest, domain: {
      authorize: (request: CollaborationAdmissionRequest) => Promise<void>;
      prepare: (database: SqlConnection) => Promise<void>;
      mutate: (database: SqlConnection, proofs: readonly CollaborationAdmissionQuiescenceProof[])
        => Promise<Readonly<Record<string, string>>>;
    }): Promise<CollaborationAdmissionOutcome> {
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
              await domain.prepare(transaction);
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
              let result: Readonly<Record<string, string>>;
              if (mutationAuthorities.has(transaction)) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
              const authority = { request: captured.request, targets: before, claimed: new Set<string>(), active: true, inFlight: 0 };
              mutationAuthorities.set(transaction, authority);
              try {
                result = captureCollaborationAdmissionOutcomeResult(await domain.mutate(transaction, Object.freeze(proofs)));
              } finally {
                authority.active = false;
                mutationAuthorities.delete(transaction);
              }
              // Reject a caller which started persistence but returned without
              // awaiting it. Its queued query precedes ROLLBACK on this session;
              // revoked authority prevents every subsequent persistence query.
              if (authority.inFlight !== 0) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
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
                const snapshotDigest = collaborationAdmissionOutcomeDigest('snapshot', snapshotText);
                targets.push(Object.freeze({ documentId: proof.documentId,
                  proofDigest: collaborationAdmissionOutcomeDigest('input', proof.proofText), snapshotText, snapshotDigest }));
                await transaction.run(`UPDATE collaboration_admission_targets SET status = 'completed', active = false,
                  outcome_snapshot_text = $3, outcome_snapshot_digest = $4 WHERE request_id = $1 AND document_id = $2`,
                [captured.request.requestId, proof.documentId, snapshotText, snapshotDigest]);
              }
              const outcome = Object.freeze({ version: 1 as const, requestId: captured.request.requestId,
                requestDigest: captured.requestDigest, result, targets: Object.freeze(targets) });
              const outcomeText = serializeCollaborationAdmissionOutcome(outcome);
              await transaction.run(`UPDATE collaboration_admission_requests SET status = 'committed', revision = revision + 1,
                completed_at = $2, outcome_text = $3 WHERE request_id = $1`,
              [captured.request.requestId, Date.now(), outcomeText]);
              return outcome;
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
  return service;
}
