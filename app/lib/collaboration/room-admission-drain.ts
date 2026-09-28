import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import type { CollaborationRoomOwnerFence } from './room-owner';
import type { CollaborationAdmissionTarget } from './room-admission';
import {
  captureCollaborationAdmissionRequest,
  CollaborationAdmissionError,
  isCanonicalAdmissionPath,
} from './room-admission-contract';

export type CollaborationAdmissionDrainTicket = Readonly<{
  requestId: string;
  requestDigest: string;
  releaseId: string;
  fence: CollaborationRoomOwnerFence;
}>;
type Query = (sql: string, values?: unknown[]) => Promise<Array<Record<string, unknown>>>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);

export function captureCollaborationAdmissionOwnerFence(input: CollaborationRoomOwnerFence): CollaborationRoomOwnerFence {
  const scope = input?.scope;
  if (!scope || !id(scope.documentId) || !id(scope.workspaceId)
    || (scope.organizationId !== null && !id(scope.organizationId)) || !isCanonicalAdmissionPath(scope.path)
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(scope.representation)
    || !Number.isSafeInteger(scope.lifecycleGeneration) || scope.lifecycleGeneration < 1
    || !Number.isSafeInteger(scope.schemaVersion) || scope.schemaVersion < 1
    || !Number.isSafeInteger(input.epoch) || input.epoch < 1 || !id(input.token)
    || !Number.isSafeInteger(input.backendPid) || input.backendPid < 1 || !id(input.backendStart)) {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  return Object.freeze({ scope: Object.freeze({ documentId: scope.documentId, workspaceId: scope.workspaceId,
    organizationId: scope.organizationId, path: scope.path, representation: scope.representation,
    lifecycleGeneration: scope.lifecycleGeneration, schemaVersion: scope.schemaVersion }),
  epoch: input.epoch, token: input.token, backendPid: input.backendPid, backendStart: input.backendStart });
}

function releaseIdFor(requestId: string, requestDigest: string, documentId: string): string {
  const hash = createHash('sha256').update(JSON.stringify([
    'canvas.admission-drain-release.v1', requestId, requestDigest, documentId,
  ])).digest('hex');
  // UUIDv8: deterministic opaque identity, not a claim about release success.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function captureCollaborationAdmissionDrainTicket(input: CollaborationAdmissionDrainTicket): CollaborationAdmissionDrainTicket {
  if (!input || !uuid.test(input.requestId) || !/^[0-9a-f]{64}$/u.test(input.requestDigest)) {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  const fence = captureCollaborationAdmissionOwnerFence(input.fence);
  if (input.releaseId !== releaseIdFor(input.requestId, input.requestDigest, fence.scope.documentId)) {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  return Object.freeze({ requestId: input.requestId, requestDigest: input.requestDigest, releaseId: input.releaseId, fence });
}

export function admissionDrainTicketForTarget(requestId: string, requestDigest: string,
  target: CollaborationAdmissionTarget): CollaborationAdmissionDrainTicket {
  if (target.document.status !== 'active' || target.ownerToken === null
    || target.ownerBackendPid === null || target.ownerBackendStart === null) {
    throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  }
  return captureCollaborationAdmissionDrainTicket({ requestId, requestDigest,
    releaseId: releaseIdFor(requestId, requestDigest, target.document.documentId),
    fence: { scope: target.document, epoch: target.ownerEpoch, token: target.ownerToken,
      backendPid: target.ownerBackendPid, backendStart: target.ownerBackendStart } });
}

export function matchesCollaborationAdmissionDrainFence(ticket: CollaborationAdmissionDrainTicket,
  fence: CollaborationRoomOwnerFence): boolean {
  return JSON.stringify(captureCollaborationAdmissionOwnerFence(ticket.fence))
    === JSON.stringify(captureCollaborationAdmissionOwnerFence(fence));
}

export function sameCollaborationAdmissionDrainTicket(a: CollaborationAdmissionDrainTicket,
  b: CollaborationAdmissionDrainTicket): boolean {
  return JSON.stringify(captureCollaborationAdmissionDrainTicket(a)) === JSON.stringify(captureCollaborationAdmissionDrainTicket(b));
}

export type CollaborationAdmissionTerminalDrain = Readonly<{
  ticket: CollaborationAdmissionDrainTicket;
  status: 'released';
  quiescenceText: string;
}>;

const plainRecord = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Verifies the immutable committed outcome for local cleanup of the exact old
 * room instance. This is historical evidence only and grants no mutation or
 * owner-token authority.
 */
export async function readCollaborationAdmissionTerminalDrain(
  database: SqlConnection,
  input: CollaborationAdmissionDrainTicket,
): Promise<CollaborationAdmissionTerminalDrain> {
  const ticket = captureCollaborationAdmissionDrainTicket(input);
  const header = await database.get(`SELECT request_digest, intent_text, status
    FROM collaboration_admission_requests WHERE request_id = $1 FOR SHARE`,
  [ticket.requestId]) as Record<string, unknown> | undefined;
  if (!header || header.request_digest !== ticket.requestDigest) {
    throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  }
  if (header.status !== 'committed' || typeof header.intent_text !== 'string') {
    throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  }
  let captured: ReturnType<typeof captureCollaborationAdmissionRequest>;
  try { captured = captureCollaborationAdmissionRequest(JSON.parse(header.intent_text) as never); }
  catch { throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED'); }
  if (captured.request.requestId !== ticket.requestId || captured.requestDigest !== ticket.requestDigest
    || captured.intentText !== header.intent_text) {
    throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  }

  // Dynamic imports avoid the room-admission -> outcome -> room-admission
  // initialization cycle; all modules are fully initialized before this path.
  const [{ readCollaborationAdmissionOutcome, collaborationAdmissionOutcomeDigest },
    { decodeCollaborationAdmissionTarget }] = await Promise.all([
    import('./room-admission-outcome'), import('./room-admission'),
  ]);
  const outcome = await readCollaborationAdmissionOutcome(database, captured);
  if (!outcome) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  const targetRow = await database.get(`SELECT snapshot_text, status, active, release_id,
      quiescence_kind, quiescence_text
    FROM collaboration_admission_targets WHERE request_id = $1 AND document_id = $2 FOR SHARE`,
  [ticket.requestId, ticket.fence.scope.documentId]) as Record<string, unknown> | undefined;
  if (!targetRow || targetRow.status !== 'completed' || targetRow.active !== false
    || targetRow.release_id !== ticket.releaseId || targetRow.quiescence_kind !== 'owner_drain'
    || typeof targetRow.snapshot_text !== 'string' || typeof targetRow.quiescence_text !== 'string'
    || Buffer.byteLength(targetRow.quiescence_text, 'utf8') > 4 * 1024 * 1024) {
    throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  }
  const expectedDocument = captured.request.expectedDocuments.find((document) =>
    document.documentId === ticket.fence.scope.documentId);
  if (!expectedDocument) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  const target = decodeCollaborationAdmissionTarget(targetRow.snapshot_text, expectedDocument);
  const expectedTicket = admissionDrainTicketForTarget(ticket.requestId, ticket.requestDigest, target);
  if (!sameCollaborationAdmissionDrainTicket(ticket, expectedTicket)) {
    throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  }
  const outcomeTarget = outcome.targets.find((item) => item.documentId === ticket.fence.scope.documentId);
  if (!outcomeTarget
    || outcomeTarget.proofDigest !== collaborationAdmissionOutcomeDigest('input', targetRow.quiescence_text)) {
    throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  }
  let proof: Record<string, unknown>;
  try { proof = JSON.parse(targetRow.quiescence_text) as Record<string, unknown>; }
  catch { throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED'); }
  const snapshotDigest = createHash('sha256').update('canvas.admission-quiescence.snapshot.v1\0')
    .update(targetRow.snapshot_text).digest('hex');
  if (!plainRecord(proof) || proof.version !== 1 || proof.requestId !== ticket.requestId
    || proof.requestDigest !== ticket.requestDigest || proof.snapshotDigest !== snapshotDigest
    || proof.kind !== 'owner_drain' || !plainRecord(proof.current) || !plainRecord(proof.receipt)
    || JSON.stringify({ version: 1, requestId: ticket.requestId, requestDigest: ticket.requestDigest,
      snapshotDigest, kind: 'owner_drain', current: proof.current, receipt: proof.receipt }) !== targetRow.quiescence_text) {
    throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  }
  return Object.freeze({ ticket, status: 'released' as const, quiescenceText: targetRow.quiescence_text });
}

/** Header -> target -> state row, retained through the owner release transaction. */
export async function lockCollaborationAdmissionDrain(query: Query, input: CollaborationAdmissionDrainTicket,
  expectedStatus?: 'draining' | 'released'): Promise<'draining' | 'released'> {
  const ticket = captureCollaborationAdmissionDrainTicket(input);
  const lock = expectedStatus === 'draining' ? 'UPDATE' : 'SHARE';
  const header = (await query(`SELECT request_digest, status, revision FROM collaboration_admission_requests
    WHERE request_id = $1 FOR ${lock}`, [ticket.requestId]))[0];
  if (!header || header.request_digest !== ticket.requestDigest) throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  if (header.status !== 'draining' || !Number.isSafeInteger(Number(header.revision))
    || Number(header.revision) < 1 || Number(header.revision) >= Number.MAX_SAFE_INTEGER) {
    throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  }
  const target = (await query(`SELECT snapshot_text, status, active, release_id, quiescence_kind, quiescence_text FROM collaboration_admission_targets
    WHERE request_id = $1 AND document_id = $2 FOR ${lock}`, [ticket.requestId, ticket.fence.scope.documentId]))[0];
  const quiescenceIsValid = target?.status === 'draining'
    ? target.quiescence_kind === null && target.quiescence_text === null
    : target?.status === 'released'
      ? target.quiescence_kind === 'owner_drain'
        && (target.quiescence_text === null || typeof target.quiescence_text === 'string')
      : false;
  if (!target || target.active !== true || !['draining', 'released'].includes(target.status as string)
    || (expectedStatus && target.status !== expectedStatus)
    || target.release_id !== (target.status === 'released' ? ticket.releaseId : null)
    || !quiescenceIsValid) {
    throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  }
  const expected = admissionDrainTicketForTarget(ticket.requestId, ticket.requestDigest,
    JSON.parse(target.snapshot_text as string) as CollaborationAdmissionTarget);
  if (!sameCollaborationAdmissionDrainTicket(ticket, expected)) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  return target.status as 'draining' | 'released';
}

/** The caller already holds header/target locks and has inserted the exact receipt in this transaction. */
export async function acknowledgeCollaborationAdmissionDrain(query: Query, ticket: CollaborationAdmissionDrainTicket): Promise<void> {
  const rows = await query(`UPDATE collaboration_admission_targets
    SET status = 'released', release_id = $3, quiescence_kind = 'owner_drain'
    WHERE request_id = $1 AND document_id = $2 AND status = 'draining' AND active AND release_id IS NULL
      AND quiescence_kind IS NULL AND quiescence_text IS NULL
    RETURNING document_id`, [ticket.requestId, ticket.fence.scope.documentId, ticket.releaseId]);
  if (rows.length !== 1) throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  await query('UPDATE collaboration_admission_requests SET revision = revision + 1 WHERE request_id = $1', [ticket.requestId]);
}
