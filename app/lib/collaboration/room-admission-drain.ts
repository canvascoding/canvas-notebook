import { createHash } from 'node:crypto';
import type { CollaborationRoomOwnerFence } from './room-owner';
import type { CollaborationAdmissionTarget } from './room-admission';
import { CollaborationAdmissionError, isCanonicalAdmissionPath } from './room-admission-contract';

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
  const target = (await query(`SELECT snapshot_text, status, active, release_id FROM collaboration_admission_targets
    WHERE request_id = $1 AND document_id = $2 FOR ${lock}`, [ticket.requestId, ticket.fence.scope.documentId]))[0];
  if (!target || target.active !== true || !['draining', 'released'].includes(target.status as string)
    || (expectedStatus && target.status !== expectedStatus)
    || target.release_id !== (target.status === 'released' ? ticket.releaseId : null)) {
    throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  }
  const expected = admissionDrainTicketForTarget(ticket.requestId, ticket.requestDigest,
    JSON.parse(target.snapshot_text as string) as CollaborationAdmissionTarget);
  if (!sameCollaborationAdmissionDrainTicket(ticket, expected)) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  return target.status as 'draining' | 'released';
}

/** The caller already holds header/target locks and has inserted the exact receipt in this transaction. */
export async function acknowledgeCollaborationAdmissionDrain(query: Query, ticket: CollaborationAdmissionDrainTicket): Promise<void> {
  const rows = await query(`UPDATE collaboration_admission_targets SET status = 'released', release_id = $3
    WHERE request_id = $1 AND document_id = $2 AND status = 'draining' AND active AND release_id IS NULL
    RETURNING document_id`, [ticket.requestId, ticket.fence.scope.documentId, ticket.releaseId]);
  if (rows.length !== 1) throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  await query('UPDATE collaboration_admission_requests SET revision = revision + 1 WHERE request_id = $1', [ticket.requestId]);
}
