import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import type { CollaborationRoomOwnerFence, CollaborationRoomOwnerScope } from './room-owner';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { collaborationRoomReleaseDigest } from './room-owner-release';
import {
  admissionDrainTicketForTarget,
  captureCollaborationAdmissionDrainTicket,
  captureCollaborationAdmissionOwnerFence,
  lockCollaborationAdmissionDrain,
  matchesCollaborationAdmissionDrainFence,
  readCollaborationAdmissionTerminalDrain,
  type CollaborationAdmissionDrainTicket,
} from './room-admission-drain';
import {
  CollaborationAdmissionError,
  captureCollaborationAdmissionRequest,
  collaborationAdmissionLockKey,
  type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest,
  type CollaborationAdmissionScope,
  type CollaborationAdmissionStatus,
} from './room-admission-contract';

type Query = (sql: string, values?: unknown[]) => Promise<Array<Record<string, unknown>>>;
type CapturedRequest = ReturnType<typeof captureCollaborationAdmissionRequest>;
export type CollaborationAdmissionTarget = Readonly<{
  document: CollaborationAdmissionDocument;
  ownerEpoch: number;
  ownerToken: string | null;
  ownerBackendPid: number | null;
  ownerBackendStart: string | null;
  documentSequence: number;
  /** Older reservations lack these fields and cannot prove quiescence. */
  persistedUpdateHash?: string;
  persistedVectorHash?: string;
}>;
export type CollaborationAdmissionResult = Readonly<{
  requestId: string;
  requestDigest: string;
  status: CollaborationAdmissionStatus;
  revision: number;
  targets: readonly CollaborationAdmissionTarget[];
}>;

const ACTIVE_REQUEST = "r.status NOT IN ('committed', 'cancelled')";
const matchesPath = `(s.path = $2 OR (s.kind = 'subtree'
  AND (s.path = '' OR left($2, length(s.path) + 1) = s.path || '/')))`;

/** Caller owns a short transaction. Never wait for a room owner while holding this guard. */
export async function lockCollaborationAdmissionWorkspace(query: Query, workspaceId: string): Promise<void> {
  await query('SELECT pg_advisory_xact_lock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]);
}

/** Under the workspace admission guard, before a NONBLOCKING room-owner try-lock. */
export async function assertCollaborationAdmissionOpen(query: Query,
  scope: Pick<CollaborationRoomOwnerScope, 'workspaceId' | 'path' | 'documentId'>): Promise<void> {
  const reservedScope = await query(`SELECT s.request_id FROM collaboration_admission_scopes s
    JOIN collaboration_admission_requests r ON r.request_id = s.request_id
    WHERE s.workspace_id = $1 AND ${ACTIVE_REQUEST} AND ${matchesPath} LIMIT 1`, [scope.workspaceId, scope.path]);
  const reservedDocument = await query(`SELECT request_id FROM collaboration_admission_targets
    WHERE document_id = $1 AND active LIMIT 1`, [scope.documentId]);
  if (reservedScope.length || reservedDocument.length) throw new CollaborationAdmissionError('ADMISSION_CONFLICT');
}

function safeNumber(value: unknown, minimum: number): number {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !/^(?:0|[1-9][0-9]*)$/u.test(value))) {
    throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  return number;
}

function captureTarget(row: Record<string, unknown>, expected: CollaborationAdmissionDocument): CollaborationAdmissionTarget {
  const document = Object.freeze({ documentId: row.document_id as string, workspaceId: row.workspace_id as string,
    organizationId: row.organization_id as string | null, path: row.path as string,
    representation: row.representation as CollaborationAdmissionDocument['representation'],
    lifecycleGeneration: safeNumber(row.lifecycle_generation, 1), schemaVersion: safeNumber(row.schema_version, 1),
    status: row.status as CollaborationAdmissionDocument['status'] });
  if (Object.keys(expected).some((key) => document[key as keyof typeof document] !== expected[key as keyof typeof expected])) {
    throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  }
  const ownerEpoch = safeNumber(row.room_owner_epoch, 0);
  const token = row.room_owner_token;
  const pid = row.room_owner_backend_pid;
  const started = row.room_owner_backend_start;
  if (token === null ? pid !== null || started !== null
    : ownerEpoch === 0 || typeof token !== 'string' || !token || !Number.isSafeInteger(pid) || Number(pid) < 1
      || typeof started !== 'string' || !started) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  if (!(row.yjs_state instanceof Uint8Array) || !(row.state_vector instanceof Uint8Array)) {
    throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  }
  return Object.freeze({ document, ownerEpoch, ownerToken: token as string | null,
    ownerBackendPid: pid as number | null, ownerBackendStart: started as string | null,
    documentSequence: safeNumber(row.document_sequence, 0),
    persistedUpdateHash: collaborationRoomReleaseDigest('update', row.yjs_state),
    persistedVectorHash: collaborationRoomReleaseDigest('vector', row.state_vector) });
}

export { captureTarget as captureCollaborationAdmissionTargetRow };

/** Strict v1 snapshot decoding for quiescence; legacy snapshots fail closed. */
export function decodeCollaborationAdmissionTarget(text: string,
  expected: CollaborationAdmissionDocument): CollaborationAdmissionTarget {
  let target: CollaborationAdmissionTarget;
  try { target = JSON.parse(text) as CollaborationAdmissionTarget; }
  catch { throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED'); }
  if (!target?.document || Object.keys(expected).some((key) =>
    target.document[key as keyof CollaborationAdmissionDocument] !== expected[key as keyof CollaborationAdmissionDocument])
    || !Number.isSafeInteger(target.ownerEpoch) || target.ownerEpoch < 0
    || !Number.isSafeInteger(target.documentSequence) || target.documentSequence < 0
    || typeof target.persistedUpdateHash !== 'string' || !/^[0-9a-f]{64}$/u.test(target.persistedUpdateHash)
    || typeof target.persistedVectorHash !== 'string' || !/^[0-9a-f]{64}$/u.test(target.persistedVectorHash)) {
    throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  }
  if (target.ownerToken === null) {
    if (target.ownerBackendPid !== null || target.ownerBackendStart !== null) {
      throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
    }
  } else {
    try {
      captureCollaborationAdmissionOwnerFence({ scope: target.document, epoch: target.ownerEpoch,
        token: target.ownerToken, backendPid: target.ownerBackendPid!, backendStart: target.ownerBackendStart! });
    } catch { throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED'); }
  }
  const canonical = Object.freeze({
    document: Object.freeze({ documentId: expected.documentId, workspaceId: expected.workspaceId,
      organizationId: expected.organizationId, path: expected.path, representation: expected.representation,
      lifecycleGeneration: expected.lifecycleGeneration, schemaVersion: expected.schemaVersion, status: expected.status }),
    ownerEpoch: target.ownerEpoch, ownerToken: target.ownerToken, ownerBackendPid: target.ownerBackendPid,
    ownerBackendStart: target.ownerBackendStart, documentSequence: target.documentSequence,
    persistedUpdateHash: target.persistedUpdateHash, persistedVectorHash: target.persistedVectorHash,
  });
  if (JSON.stringify(canonical) !== text) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  return canonical;
}

async function readRequest(database: SqlConnection, captured: CapturedRequest): Promise<CollaborationAdmissionResult | null> {
  // Every target mutation must lock its request row first. Retain the shared
  // header lock while reading children so cancellation cannot split this view.
  const header = await database.get('SELECT * FROM collaboration_admission_requests WHERE request_id = $1 FOR SHARE',
    [captured.request.requestId]) as Record<string, unknown> | undefined;
  if (!header) return null;
  if (header.request_digest !== captured.requestDigest || header.intent_text !== captured.intentText) {
    throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  }
  const rows = await database.all(`SELECT snapshot_text FROM collaboration_admission_targets
    WHERE request_id = $1 ORDER BY document_id`, [captured.request.requestId]) as Array<{ snapshot_text: string }>;
  const targets = rows.map((row) => {
    const target = JSON.parse(row.snapshot_text) as CollaborationAdmissionTarget;
    return Object.freeze({ ...target, document: Object.freeze({ ...target.document }) });
  });
  return Object.freeze({ requestId: captured.request.requestId, requestDigest: captured.requestDigest,
    status: header.status as CollaborationAdmissionStatus, revision: safeNumber(header.revision, 1), targets: Object.freeze(targets) });
}

async function lockRequest(database: SqlConnection, captured: CapturedRequest): Promise<void> {
  const key = BigInt.asIntN(64, BigInt(`0x${createHash('sha256')
    .update(`canvas.collaboration.admission-request-lock.v1\0${captured.request.requestId}`).digest('hex').slice(0, 16)}`)).toString();
  await database.run('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
  for (const workspaceId of captured.workspaceIds) {
    await database.run('SELECT pg_advisory_xact_lock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]);
  }
}

async function assertNoOverlap(database: SqlConnection, scope: CollaborationAdmissionScope): Promise<void> {
  const conflict = await database.get(`SELECT s.request_id FROM collaboration_admission_scopes s
    JOIN collaboration_admission_requests r ON r.request_id = s.request_id
    WHERE s.workspace_id = $1 AND ${ACTIVE_REQUEST} AND (${matchesPath}
      OR ($3 = 'subtree' AND ($2 = '' OR left(s.path, length($2) + 1) = $2 || '/'))) LIMIT 1`,
  [scope.workspaceId, scope.path, scope.kind]);
  if (conflict) throw new CollaborationAdmissionError('ADMISSION_CONFLICT');
}

async function captureTargets(database: SqlConnection, captured: CapturedRequest): Promise<CollaborationAdmissionTarget[]> {
  const values: unknown[] = [];
  const paths = captured.request.scopes.map((scope) => {
    values.push(scope.workspaceId, scope.path);
    const workspace = `$${values.length - 1}`, path = `$${values.length}`;
    const subtree = scope.kind === 'subtree' ? ` OR (${path} = '' OR left(path, length(${path}) + 1) = ${path} || '/')` : '';
    return `(workspace_id = ${workspace} AND (path = ${path}${subtree}))`;
  });
  values.push(captured.request.expectedDocuments.filter((doc) => doc.status === 'archived').map((doc) => doc.documentId));
  const rows = await database.all(`SELECT document_id, workspace_id, organization_id, path, representation,
    lifecycle_generation, schema_version, status, room_owner_epoch, room_owner_token,
    room_owner_backend_pid, room_owner_backend_start, document_sequence, yjs_state, state_vector FROM collaboration_yjs_states
    WHERE (status = 'active' AND (${paths.join(' OR ')}))
      OR (status = 'archived' AND document_id = ANY($${values.length}::text[]))
    ORDER BY document_id LIMIT 1025 FOR UPDATE`, values) as Array<Record<string, unknown>>;
  const expected = new Map(captured.request.expectedDocuments.map((doc) => [doc.documentId, doc]));
  if (rows.length !== expected.size || rows.length > 1024) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  return rows.map((row) => {
    const document = expected.get(row.document_id as string);
    if (!document) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
    return captureTarget(row, document);
  });
}

export { captureTargets as captureCollaborationAdmissionScopeTargets };

/**
 * Internal mechanics only, no auth or lifecycle mutation authority. Connections
 * must be dedicated and close(error) must destroy uncertain backends. No runtime
 * caller is installed until drain, recovery and all writer admission gates exist.
 */
export function createCollaborationAdmissionService(options: { openConnection: () => Promise<SqlConnection> }) {
  const transaction = <T>(execute: (database: SqlConnection) => Promise<T>, recoverCommitted: (value: T) => Promise<T>) =>
    executeLifecycleTransaction({ openConnection: options.openConnection,
      execute: async (database) => {
        await database.run("SET LOCAL statement_timeout = '5s'");
        await database.run("SET LOCAL lock_timeout = '4s'");
        return execute(database);
      }, recoverCommitted });
  const readCaptured = (captured: CapturedRequest) => transaction(
    (database) => readRequest(database, captured), async (verified) => verified);
  const readDrain = (input: CollaborationAdmissionDrainTicket) => {
    const ticket = captureCollaborationAdmissionDrainTicket(input);
    return transaction(async (database) => {
      const header = await database.get('SELECT status FROM collaboration_admission_requests WHERE request_id = $1',
        [ticket.requestId]) as Record<string, unknown> | undefined;
      if (header?.status === 'committed') {
        const terminal = await readCollaborationAdmissionTerminalDrain(database, ticket);
        return Object.freeze({ ticket: terminal.ticket, status: terminal.status });
      }
      const status = await lockCollaborationAdmissionDrain(async (sql, values) =>
        await database.all(sql, values) as Array<Record<string, unknown>>, ticket);
      return Object.freeze({ ticket, status });
    }, async (verified) => verified);
  };
  return {
    readDrain,
    startDrain(input: CollaborationAdmissionRequest, documentId: string): Promise<CollaborationAdmissionDrainTicket> {
      const captured = captureCollaborationAdmissionRequest(input);
      if (!captured.request.expectedDocuments.some((document) => document.documentId === documentId)) {
        throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
      }
      return transaction(async (database) => {
        await database.get('SELECT request_id FROM collaboration_admission_requests WHERE request_id = $1 FOR UPDATE',
          [captured.request.requestId]);
        const current = await readRequest(database, captured);
        if (!current || !['reserved', 'draining'].includes(current.status) || current.revision >= Number.MAX_SAFE_INTEGER) {
          throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
        }
        const target = current.targets.find((item) => item.document.documentId === documentId);
        if (!target) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
        const ticket = admissionDrainTicketForTarget(current.requestId, current.requestDigest, target);
        const row = await database.get(`SELECT status, active, release_id, quiescence_kind, quiescence_text FROM collaboration_admission_targets
          WHERE request_id = $1 AND document_id = $2 FOR UPDATE`, [ticket.requestId, documentId]) as Record<string, unknown>;
        if (!row || row.active !== true || !['reserved', 'draining', 'released'].includes(row.status as string)
          || row.release_id !== (row.status === 'released' ? ticket.releaseId : null)
          || (row.status === 'released' ? row.quiescence_kind !== 'owner_drain'
            : row.quiescence_kind !== null || row.quiescence_text !== null)) {
          throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
        }
        if (row.status === 'reserved') {
          await database.run(`UPDATE collaboration_admission_targets SET status = 'draining'
            WHERE request_id = $1 AND document_id = $2`, [ticket.requestId, documentId]);
          await database.run(`UPDATE collaboration_admission_requests SET status = 'draining', revision = revision + 1
            WHERE request_id = $1`, [ticket.requestId]);
        } else if (current.status !== 'draining') {
          throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
        }
        return ticket;
      }, async (ticket) => {
        await readDrain(ticket);
        return ticket;
      });
    },
    /** Durable polling also returns released targets whose local destruction still needs retry. */
    pendingDrains(inputs: readonly CollaborationRoomOwnerFence[]): Promise<readonly CollaborationAdmissionDrainTicket[]> {
      if (!Array.isArray(inputs) || inputs.length > 256) throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
      const fences = inputs.map(captureCollaborationAdmissionOwnerFence);
      if (new Set(fences.map((fence) => fence.scope.documentId)).size !== fences.length) {
        throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
      }
      if (!fences.length) return Promise.resolve(Object.freeze([]));
      return transaction(async (database) => {
        const rows = await database.all(`SELECT r.request_id, r.request_digest, r.status AS request_status,
            t.snapshot_text, t.status, t.release_id
          FROM collaboration_admission_requests r JOIN collaboration_admission_targets t ON t.request_id = r.request_id
          WHERE ((r.status = 'draining' AND t.active
              AND ((t.status = 'draining' AND t.quiescence_kind IS NULL AND t.quiescence_text IS NULL)
                OR (t.status = 'released' AND t.quiescence_kind = 'owner_drain')))
            OR (r.status = 'committed' AND NOT t.active AND t.status = 'completed'
              AND t.quiescence_kind = 'owner_drain'))
            AND t.document_id = ANY($1::text[]) ORDER BY r.request_id, t.document_id FOR SHARE OF r, t`,
        [fences.map((fence) => fence.scope.documentId)]) as Array<Record<string, unknown>>;
        const pending: CollaborationAdmissionDrainTicket[] = [];
        for (const row of rows) {
          const ticket = admissionDrainTicketForTarget(row.request_id as string, row.request_digest as string,
            JSON.parse(row.snapshot_text as string) as CollaborationAdmissionTarget);
          const fence = fences.find((item) => item.scope.documentId === ticket.fence.scope.documentId);
          if (!fence || !matchesCollaborationAdmissionDrainFence(ticket, fence)) continue;
          if (row.request_status === 'committed') {
            await readCollaborationAdmissionTerminalDrain(database, ticket);
          } else if (row.release_id !== (row.status === 'released' ? ticket.releaseId : null)) {
            throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
          }
          pending.push(ticket);
        }
        return Object.freeze(pending);
      }, async (verified) => verified);
    },
    read(input: CollaborationAdmissionRequest) {
      const captured = captureCollaborationAdmissionRequest(input);
      return readCaptured(captured);
    },
    reserve(input: CollaborationAdmissionRequest): Promise<CollaborationAdmissionResult> {
      const captured = captureCollaborationAdmissionRequest(input);
      return transaction(async (database) => {
        await lockRequest(database, captured);
        const existing = await readRequest(database, captured);
        if (existing) return existing;
        for (const scope of captured.request.scopes) await assertNoOverlap(database, scope);
        const targets = await captureTargets(database, captured);
        await database.run(`INSERT INTO collaboration_admission_requests
          (request_id, request_digest, intent_text, status, revision, created_at) VALUES ($1, $2, $3, 'reserved', 1, $4)`,
        [captured.request.requestId, captured.requestDigest, captured.intentText, Date.now()]);
        for (const [index, scope] of captured.request.scopes.entries()) {
          await database.run(`INSERT INTO collaboration_admission_scopes
            (request_id, ordinal, workspace_id, organization_id, path, kind) VALUES ($1, $2, $3, $4, $5, $6)`,
          [captured.request.requestId, index, scope.workspaceId, scope.organizationId, scope.path, scope.kind]);
        }
        for (const target of targets) {
          await database.run(`INSERT INTO collaboration_admission_targets (request_id, document_id, snapshot_text)
            VALUES ($1, $2, $3)`, [captured.request.requestId, target.document.documentId, JSON.stringify(target)]);
        }
        return Object.freeze({ requestId: captured.request.requestId, requestDigest: captured.requestDigest,
          status: 'reserved' as const, revision: 1, targets: Object.freeze(targets) });
      }, async () => {
        const found = await readCaptured(captured);
        if (!found) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
        return found;
      });
    },
    /** Only an unstarted request may cancel. Drain/mutation phases require their own outcome proof. */
    cancel(input: CollaborationAdmissionRequest, expectedRevision: number): Promise<CollaborationAdmissionResult> {
      const captured = captureCollaborationAdmissionRequest(input);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
        throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
      }
      return transaction(async (database) => {
        await lockRequest(database, captured);
        await database.get('SELECT request_id FROM collaboration_admission_requests WHERE request_id = $1 FOR UPDATE',
          [captured.request.requestId]);
        const current = await readRequest(database, captured);
        if (current?.status === 'cancelled' && current.revision === expectedRevision + 1) return current;
        if (current?.status !== 'reserved' || current.revision !== expectedRevision) {
          throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
        }
        const started = await database.get(`SELECT document_id FROM collaboration_admission_targets WHERE request_id = $1
          AND (status <> 'reserved' OR release_id IS NOT NULL OR quiescence_kind IS NOT NULL
            OR quiescence_text IS NOT NULL OR NOT active) LIMIT 1`, [captured.request.requestId]);
        if (started) throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
        await database.run(`UPDATE collaboration_admission_targets SET active = false, status = 'cancelled' WHERE request_id = $1`,
          [captured.request.requestId]);
        await database.run(`UPDATE collaboration_admission_requests SET status = 'cancelled', revision = revision + 1,
          completed_at = $2 WHERE request_id = $1`, [captured.request.requestId, Date.now()]);
        return Object.freeze({ ...current, status: 'cancelled' as const, revision: expectedRevision + 1 });
      }, async () => {
        const found = await readCaptured(captured);
        if (found?.status !== 'cancelled' || found.revision !== expectedRevision + 1) {
          throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
        }
        return found;
      });
    },
  };
}
