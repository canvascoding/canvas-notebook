import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import { captureCollaborationAdmissionTargetRow, decodeCollaborationAdmissionTarget,
  type CollaborationAdmissionTarget } from './room-admission';
import { captureCollaborationAdmissionRequest, CollaborationAdmissionError,
  type CollaborationAdmissionDocument } from './room-admission-contract';
import { mergeCollaborationPersistenceUpdates } from './persistence-merge';

type Captured = ReturnType<typeof captureCollaborationAdmissionRequest>;
type Row = Record<string, unknown>;
// Covers 1024 maximally escaped snapshots within the request contract. Writers
// and readers share the cap so a committed result can always be read on retry.
export const COLLABORATION_ADMISSION_OUTCOME_MAX_BYTES = 32 * 1024 * 1024;
export type CollaborationAdmissionOutcomeTarget = Readonly<{
  documentId: string;
  proofDigest: string;
  snapshotText: string;
  snapshotDigest: string;
}>;
export type CollaborationAdmissionAbortReason = 'user_cancelled' | 'precondition_failed';
type CollaborationAdmissionOutcomeBase = Readonly<{
  requestId: string;
  requestDigest: string;
  result: Readonly<Record<string, string>>;
  targets: readonly CollaborationAdmissionOutcomeTarget[];
}>;
// `committed` describes the durable protocol outcome, not necessarily a domain
// write. Preserve v1 byte-for-byte; only the new v2 member denotes an abort.
export type CollaborationAdmissionOutcome = CollaborationAdmissionOutcomeBase & (
  Readonly<{ version: 1 }>
  | Readonly<{ version: 2; disposition: 'aborted'; reasonCode: CollaborationAdmissionAbortReason }>
);

export function captureCollaborationAdmissionAbortReason(value: unknown): CollaborationAdmissionAbortReason {
  if (value !== 'user_cancelled' && value !== 'precondition_failed') {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  return value;
}

/** Abort proves unchanged input, not merely non-regressing counters. */
export function assertUnchangedCollaborationAdmissionAbortSnapshot(
  captured: Captured, documentId: string, proofText: string, snapshotText: string,
): void {
  let proof: Row;
  try { proof = JSON.parse(proofText) as Row; }
  catch { throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED'); }
  const expected = captured.request.expectedDocuments.find((document) => document.documentId === documentId);
  if (!expected || !proof || proof.version !== 1 || proof.requestId !== captured.request.requestId
    || proof.requestDigest !== captured.requestDigest
    || !['vacant', 'normal_release', 'owner_drain', 'lifecycle_outcome'].includes(proof.kind as string)
    || JSON.stringify(proof.current) !== snapshotText) {
    throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  }
  const snapshot = decodeCollaborationAdmissionTarget(snapshotText, expected);
  if (snapshot.ownerToken !== null) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
}

export function serializeCollaborationAdmissionOutcome(outcome: CollaborationAdmissionOutcome): string {
  const text = JSON.stringify(outcome);
  if (Buffer.byteLength(text, 'utf8') > COLLABORATION_ADMISSION_OUTCOME_MAX_BYTES) {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  return text;
}

export function collaborationAdmissionOutcomeDigest(kind: 'snapshot' | 'input', text: string): string {
  return createHash('sha256').update(`canvas.admission-outcome.${kind}.v1\0`).update(text).digest('hex');
}

export function captureCollaborationAdmissionOutcomeResult(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.keys(input).length > 32) {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  const result: Record<string, string> = Object.create(null);
  for (const key of Object.keys(input).sort()) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)
      || typeof input[key] !== 'string' || Buffer.byteLength(input[key], 'utf8') > 4096) {
      throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
    }
    result[key] = input[key];
  }
  return Object.freeze(result);
}

/** Domain code owns the change; resulting identity must stay inside its reserved footprint. */
export function captureCollaborationAdmissionOutcomeSnapshot(row: Row, captured: Captured): CollaborationAdmissionTarget {
  const document: CollaborationAdmissionDocument = {
    documentId: row.document_id as string, workspaceId: row.workspace_id as string,
    organizationId: row.organization_id as string | null, path: row.path as string,
    representation: row.representation as CollaborationAdmissionDocument['representation'],
    lifecycleGeneration: Number(row.lifecycle_generation), schemaVersion: Number(row.schema_version),
    status: row.status as CollaborationAdmissionDocument['status'],
  };
  if (!captured.request.expectedDocuments.some((expected) => expected.documentId === document.documentId)) {
    throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  }
  // Reuse canonical scope validation, including organization and archive identity.
  captureCollaborationAdmissionRequest({ ...captured.request, expectedDocuments: [document] });
  const snapshot = captureCollaborationAdmissionTargetRow(row, document);
  if (snapshot.ownerToken !== null) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  try {
    const update = row.yjs_state as Uint8Array;
    const parsed = mergeCollaborationPersistenceUpdates(update, update);
    if (!Buffer.from(parsed.stateVector).equals(Buffer.from(row.state_vector as Uint8Array))) throw new Error('Invalid vector.');
  } catch { throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED'); }
  return snapshot;
}

/** Caller owns a transaction. This is a historical result, never fresh mutation authority. */
export async function readCollaborationAdmissionOutcome(database: SqlConnection, captured: Captured): Promise<CollaborationAdmissionOutcome | null> {
  const header = await database.get('SELECT * FROM collaboration_admission_requests WHERE request_id = $1 FOR SHARE',
    [captured.request.requestId]) as Row | undefined;
  if (!header) return null;
  if (header.request_digest !== captured.requestDigest || header.intent_text !== captured.intentText) {
    throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  }
  if (header.status !== 'committed') {
    if (header.outcome_text !== null) throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
    return null;
  }
  if (typeof header.outcome_text !== 'string'
    || Buffer.byteLength(header.outcome_text, 'utf8') > COLLABORATION_ADMISSION_OUTCOME_MAX_BYTES) {
    throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  }
  let stored: CollaborationAdmissionOutcome;
  try { stored = JSON.parse(header.outcome_text) as CollaborationAdmissionOutcome; }
  catch { throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED'); }
  if (![1, 2].includes(stored?.version) || stored.requestId !== captured.request.requestId || stored.requestDigest !== captured.requestDigest
    || !Array.isArray(stored.targets) || stored.targets.length !== captured.request.expectedDocuments.length) {
    throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  }
  if (stored.version === 2 && (stored.disposition !== 'aborted'
    || !['user_cancelled', 'precondition_failed'].includes(stored.reasonCode)
    || !stored.result || typeof stored.result !== 'object' || Array.isArray(stored.result)
    || Object.keys(stored.result).length !== 0)) {
    throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  }
  const rows = await database.all(`SELECT * FROM collaboration_admission_targets
    WHERE request_id = $1 ORDER BY document_id FOR SHARE`, [captured.request.requestId]) as Row[];
  if (rows.length !== stored.targets.length) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  const targets = rows.map((row, index) => {
    const item = stored.targets[index];
    if (!item || item.documentId !== captured.request.expectedDocuments[index].documentId
      || row.document_id !== item.documentId || row.status !== 'completed' || row.active !== false
      || typeof row.quiescence_text !== 'string' || typeof item.snapshotText !== 'string'
      || row.outcome_snapshot_text !== item.snapshotText || row.outcome_snapshot_digest !== item.snapshotDigest
      || collaborationAdmissionOutcomeDigest('input', row.quiescence_text) !== item.proofDigest
      || collaborationAdmissionOutcomeDigest('snapshot', item.snapshotText) !== item.snapshotDigest) {
      throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    }
    let snapshot: CollaborationAdmissionTarget;
    try { snapshot = JSON.parse(item.snapshotText) as CollaborationAdmissionTarget; }
    catch { throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED'); }
    if (!snapshot?.document || snapshot.document.documentId !== item.documentId || snapshot.ownerToken !== null) {
      throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    }
    captureCollaborationAdmissionRequest({ ...captured.request, expectedDocuments: [snapshot.document] });
    decodeCollaborationAdmissionTarget(item.snapshotText, snapshot.document);
    if (stored.version === 2) {
      assertUnchangedCollaborationAdmissionAbortSnapshot(captured, item.documentId, row.quiescence_text, item.snapshotText);
      const proof = JSON.parse(row.quiescence_text) as Row;
      if (typeof row.snapshot_text !== 'string' || proof.kind !== row.quiescence_kind
        || proof.snapshotDigest !== createHash('sha256').update('canvas.admission-quiescence.snapshot.v1\0')
          .update(row.snapshot_text).digest('hex')) {
        throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
      }
      const reserved = decodeCollaborationAdmissionTarget(row.snapshot_text, captured.request.expectedDocuments[index]);
      if (snapshot.ownerEpoch !== reserved.ownerEpoch || snapshot.documentSequence < reserved.documentSequence
        || (reserved.ownerToken === null && item.snapshotText !== row.snapshot_text)) {
        throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
      }
    }
    return Object.freeze({ documentId: item.documentId, proofDigest: item.proofDigest,
      snapshotText: item.snapshotText, snapshotDigest: item.snapshotDigest });
  });
  const outcome: CollaborationAdmissionOutcome = Object.freeze({
    ...(stored.version === 2 ? { version: 2 as const, disposition: 'aborted' as const, reasonCode: stored.reasonCode }
      : { version: 1 as const }),
    requestId: captured.request.requestId, requestDigest: captured.requestDigest,
    result: captureCollaborationAdmissionOutcomeResult(stored.result), targets: Object.freeze(targets) });
  if (JSON.stringify(outcome) !== header.outcome_text) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  return outcome;
}

/** Exact poststate lookup, never a "latest outcome" or same-epoch inference. */
export async function findCollaborationAdmissionOutcomeSource(database: SqlConnection, current: CollaborationAdmissionTarget) {
  const text = JSON.stringify(current);
  const digest = collaborationAdmissionOutcomeDigest('snapshot', text);
  const source = await database.get(`SELECT r.request_id, r.intent_text FROM collaboration_admission_targets t
    JOIN collaboration_admission_requests r ON r.request_id = t.request_id
    WHERE t.document_id = $1 AND t.status = 'completed' AND NOT t.active
      AND r.status = 'committed' AND t.outcome_snapshot_digest = $2 AND t.outcome_snapshot_text = $3
    ORDER BY r.request_id LIMIT 1`, [current.document.documentId, digest, text]) as Row | undefined;
  if (!source) return null;
  let captured: Captured;
  try { captured = captureCollaborationAdmissionRequest(JSON.parse(source.intent_text as string)); }
  catch { throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED'); }
  const outcome = await readCollaborationAdmissionOutcome(database, captured);
  const target = outcome?.targets.find((item) => item.documentId === current.document.documentId);
  if (!outcome || source.request_id !== outcome.requestId || target?.snapshotText !== text || target.snapshotDigest !== digest) {
    throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  }
  return Object.freeze({ requestId: outcome.requestId, requestDigest: outcome.requestDigest,
    documentId: current.document.documentId, snapshotDigest: digest });
}
