import 'server-only';

import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { SqlConnection } from '../db';
import { decodeNativeFileOperationBundleText } from '../markdown/native-file-operation-handoff';
import { captureCollaborationAdmissionRequest, type CollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { decodeWorkspaceOperationMixedOriginalSourceWitness } from './workspace-operation-native-original-source';
import type { WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';
import type { WorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';
import type { WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';
import { decodeWorkspaceOperationOriginalMoveNativeBundleData, getWorkspaceOperationOriginalMoveNativeIds,
  type WorkspaceOperationOriginalMoveActor, type WorkspaceOperationOriginalMoveContext,
  type WorkspaceOperationOriginalMoveNativeBundleData } from './workspace-operation-original-move';
import { createWorkspaceOperationOriginalMoveAdmissionRequestFromBundle } from './workspace-operation-original-move-admission';

/** Immutable P0 data, never a claim, admission lease, actor or SQL authority.
 * The original owner captures the real witness and owns the whole transaction. */
export type WorkspaceOperationOriginalMovePreparation = Readonly<{
  batchId: string; planId: string; workspaceId: string; requestHash: string;
  actor: WorkspaceOperationOriginalMoveActor; jobScope: WorkspaceOperationJobScope;
  requestId: string; requestDigest: string; actionPayloadText: string;
  nativeBundle: Readonly<{ operationId: string; requestId: string; changesBundleProof: string }> | null;
}> & (Readonly<{ version: 1; currentWitness: WorkspaceOperationNativeSourceEvidenceV2 }>
  | Readonly<{ version: 2; currentWitness: WorkspaceOperationNativeSourceEvidenceV3 }>
  | Readonly<{ version: 3; currentWitness: WorkspaceOperationMixedSourceEvidenceV5 }>);
export type WorkspaceOperationOriginalMovePrepared = Readonly<{
  preparation: WorkspaceOperationOriginalMovePreparation;
  preparationText: string; preparationDigest: string;
  request: CollaborationAdmissionRequest;
  nativeBundleData: WorkspaceOperationOriginalMoveNativeBundleData | null;
}>;
export type WorkspaceOperationOriginalMoveStoredPreparation = WorkspaceOperationOriginalMovePrepared & Readonly<{ createdAt: number }>;
export type WorkspaceOperationOriginalMovePreparationInsertResult =
  Readonly<{ kind: 'created' | 'existing'; row: WorkspaceOperationOriginalMoveStoredPreparation }> | Readonly<{ kind: 'conflict' }>;
type PreparationRow = Record<string, unknown>;
type PreparationJson = null | string | boolean | number | readonly PreparationJson[] | { readonly [key: string]: PreparationJson };
type PreparationCaptureState = { remaining: number; nodes: number; depth: number; ancestors: Set<object> };
const preparationLimit = 16 * 1024 ** 2, nativeBundleLimit = 8 * 1024 ** 2;
const preparationColumns = `batch_id AS "batchId",plan_id AS "planId",workspace_id AS "workspaceId",request_hash AS "requestHash",
  request_id AS "requestId",request_digest AS "requestDigest",
  CASE WHEN octet_length(preparation_text) BETWEEN 1 AND ${preparationLimit} THEN preparation_text ELSE NULL END AS "preparationText",
  preparation_digest AS "preparationDigest",created_at AS "createdAt"`;

function originalMovePreparationFailure(code: 'ORIGINAL_MOVE_PREPARATION_INVALID' | 'ORIGINAL_MOVE_PREPARATION_CHANGED'
  | 'ORIGINAL_MOVE_PREPARATION_TOO_LARGE' = 'ORIGINAL_MOVE_PREPARATION_INVALID'): never {
  throw Object.assign(new Error('Original Move preparation could not be confirmed.'),
    { code, status: code === 'ORIGINAL_MOVE_PREPARATION_TOO_LARGE' ? 413 : 409 });
}

/** Cost before cloning, reject accessors/proxies/cycles, detach and deeply freeze.
 * Sorted own keys give one canonical byte representation without calling toJSON. */
function captureOriginalMovePreparationJson(value: unknown, maximum = preparationLimit,
  suppliedState?: PreparationCaptureState): PreparationJson {
  const state = suppliedState ?? { remaining: maximum, nodes: 600_000, depth: 0, ancestors: new Set<object>() };
  if (--state.nodes < 0 || state.depth > 64) originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_TOO_LARGE');
  let cost = 0;
  if (typeof value === 'string') {
    if (value.length > maximum) originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_TOO_LARGE');
    cost = 2;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) originalMovePreparationFailure();
        cost += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff) originalMovePreparationFailure();
      else cost += code === 34 || code === 92 ? 2 : code < 32 ? [8, 9, 10, 12, 13].includes(code) ? 2 : 6 : code < 128 ? 1 : code < 2048 ? 2 : 3;
      if (cost > state.remaining) originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_TOO_LARGE');
    }
  } else if (value === null || typeof value === 'boolean') cost = value === null || value === true ? 4 : 5;
  else if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) originalMovePreparationFailure();
    cost = JSON.stringify(value).length;
  } else {
    if (!value || typeof value !== 'object' || types.isProxy(value) || state.ancestors.has(value)) originalMovePreparationFailure();
    const arrayValue = Array.isArray(value) ? value : null;
    const array = arrayValue !== null, keys = Reflect.ownKeys(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) originalMovePreparationFailure();
    if (!array && keys.some(key => typeof key !== 'string')) originalMovePreparationFailure();
    if (arrayValue !== null ? arrayValue.length > 100_000 || keys.length !== arrayValue.length + 1 : keys.length > 4096) {
      originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_TOO_LARGE');
    }
    const size = arrayValue === null ? keys.length : arrayValue.length;
    state.remaining -= 2 + Math.max(size - 1, 0);
    if (state.remaining < 0) originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_TOO_LARGE');
    state.ancestors.add(value); state.depth++;
    const result: PreparationJson[] | Record<string, PreparationJson> = array ? [] : {};
    const selectedKeys: (string | symbol)[] = array ? Array.from({ length: size }, (_, index) => String(index)) : keys.sort();
    for (const key of selectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)
        || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) originalMovePreparationFailure();
      if (!array) {
        state.nodes++; // Object keys consume bytes, not additional value nodes.
        captureOriginalMovePreparationJson(key, maximum, state); state.remaining--;
        if (state.remaining < 0) originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_TOO_LARGE');
      }
      const child = captureOriginalMovePreparationJson(descriptor.value, maximum, state);
      if (array) (result as PreparationJson[]).push(child); else (result as Record<string, PreparationJson>)[key] = child;
    }
    state.depth--; state.ancestors.delete(value); return Object.freeze(result);
  }
  state.remaining -= cost;
  if (state.remaining < 0) originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_TOO_LARGE');
  return value as null | string | boolean | number;
}

function originalMovePreparationCanonicalText(value: unknown, maximum = preparationLimit): string {
  const text = JSON.stringify(captureOriginalMovePreparationJson(value, maximum));
  if (Buffer.byteLength(text, 'utf8') > maximum) originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_TOO_LARGE');
  return text;
}

function originalMovePreparationSchema(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 63 || Buffer.byteLength(value, 'utf8') > 63
    || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) originalMovePreparationFailure();
  return `"${value.replaceAll('"', '""')}"`;
}

export function createWorkspaceOperationOriginalMovePreparation(context: WorkspaceOperationOriginalMoveContext,
  input: Readonly<{ currentWitness: WorkspaceOperationNativeSourceEvidenceV2; nativeBundleData: WorkspaceOperationOriginalMoveNativeBundleData | null }>
): WorkspaceOperationOriginalMovePrepared & { preparation: Extract<WorkspaceOperationOriginalMovePreparation, { version: 1 }> };
export function createWorkspaceOperationOriginalMovePreparation(context: WorkspaceOperationOriginalMoveContext,
  input: Readonly<{ currentWitness: WorkspaceOperationNativeSourceEvidenceV3; nativeBundleData: WorkspaceOperationOriginalMoveNativeBundleData | null }>
): WorkspaceOperationOriginalMovePrepared & { preparation: Extract<WorkspaceOperationOriginalMovePreparation, { version: 2 }> };
export function createWorkspaceOperationOriginalMovePreparation(context: WorkspaceOperationOriginalMoveContext,
  input: Readonly<{ currentWitness: WorkspaceOperationMixedSourceEvidenceV5; nativeBundleData: WorkspaceOperationOriginalMoveNativeBundleData | null }>
): WorkspaceOperationOriginalMovePrepared & { preparation: Extract<WorkspaceOperationOriginalMovePreparation, { version: 3 }> };
export function createWorkspaceOperationOriginalMovePreparation(context: WorkspaceOperationOriginalMoveContext,
  input: Readonly<{ currentWitness: WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3 | WorkspaceOperationMixedSourceEvidenceV5;
    nativeBundleData: WorkspaceOperationOriginalMoveNativeBundleData | null }>
): WorkspaceOperationOriginalMovePrepared;
export function createWorkspaceOperationOriginalMovePreparation(context: WorkspaceOperationOriginalMoveContext,
  input: Readonly<{ currentWitness: WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3 | WorkspaceOperationMixedSourceEvidenceV5;
    nativeBundleData: WorkspaceOperationOriginalMoveNativeBundleData | null }>
): WorkspaceOperationOriginalMovePrepared {
  const selected = captureOriginalMovePreparationJson(context, 64 * 1024 ** 2) as unknown as WorkspaceOperationOriginalMoveContext;
  getWorkspaceOperationOriginalMoveNativeIds(selected); // exact existing context/plan/actor validation, including the fallback arm
  if (selected.plan.planIdentityVersion !== 2 && selected.plan.planIdentityVersion !== 3 && selected.plan.planIdentityVersion !== 4) originalMovePreparationFailure();
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== 2) originalMovePreparationFailure();
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const name of ['currentWitness', 'nativeBundleData']) if (!fields[name]?.enumerable || !Object.hasOwn(fields[name], 'value')) originalMovePreparationFailure();
  const currentWitness = decodeWorkspaceOperationMixedOriginalSourceWitness(selected.plan.sourceEvidence,
    captureOriginalMovePreparationJson(fields.currentWitness.value, nativeBundleLimit));
  const nativeBundleData = captureOriginalMovePreparationJson(fields.nativeBundleData.value, 8 * nativeBundleLimit) as WorkspaceOperationOriginalMoveNativeBundleData | null;
  const bundle = decodeWorkspaceOperationOriginalMoveNativeBundleData(nativeBundleData, selected, currentWitness);
  const request = createWorkspaceOperationOriginalMoveAdmissionRequestFromBundle(selected, nativeBundleData, currentWitness);
  const requestDigest = captureCollaborationAdmissionRequest(request).requestDigest;
  if (typeof request.actionPayloadText !== 'string') originalMovePreparationFailure();
  const preparation = captureOriginalMovePreparationJson({ version: selected.plan.planIdentityVersion === 4 ? 3 : selected.plan.planIdentityVersion === 3 ? 2 : 1,
    batchId: selected.batchId, planId: selected.plan.planId,
    workspaceId: selected.plan.workspaceId, requestHash: selected.requestHash, actor: selected.actor,
    jobScope: selected.plan.sourceEvidence.workspaceScope, currentWitness, requestId: request.requestId, requestDigest,
    actionPayloadText: request.actionPayloadText, nativeBundle: bundle === null ? null
      : { operationId: bundle.operationId, requestId: bundle.requestId, changesBundleProof: nativeBundleData!.changesBundleProof } }
  ) as unknown as WorkspaceOperationOriginalMovePreparation;
  const preparationText = originalMovePreparationCanonicalText(preparation);
  return Object.freeze({ preparation, preparationText, preparationDigest: createHash('sha256').update(preparationText, 'utf8').digest('hex'),
    request, nativeBundleData });
}

export function decodeWorkspaceOperationOriginalMovePreparation(preparationText: string, context: WorkspaceOperationOriginalMoveContext,
  nativeBundleData: WorkspaceOperationOriginalMoveNativeBundleData | null): WorkspaceOperationOriginalMovePrepared {
  if (typeof preparationText !== 'string' || !preparationText.length || preparationText.length > preparationLimit
    || Buffer.byteLength(preparationText, 'utf8') > preparationLimit || Buffer.from(preparationText, 'utf8').toString('utf8') !== preparationText) originalMovePreparationFailure();
  let parsed: unknown;
  try { parsed = JSON.parse(preparationText); } catch { originalMovePreparationFailure(); }
  const captured = captureOriginalMovePreparationJson(parsed) as PreparationRow;
  if (!captured || Array.isArray(captured) || typeof captured !== 'object' || !Object.hasOwn(captured, 'currentWitness')) originalMovePreparationFailure();
  const prepared = createWorkspaceOperationOriginalMovePreparation(context, {
    currentWitness: captured.currentWitness as WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3 | WorkspaceOperationMixedSourceEvidenceV5, nativeBundleData });
  if (prepared.preparationText !== preparationText) originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_CHANGED');
  return prepared;
}

function originalMovePreparationStoredRow(row: unknown, context: WorkspaceOperationOriginalMoveContext,
  nativeBundleData: WorkspaceOperationOriginalMoveNativeBundleData | null): WorkspaceOperationOriginalMoveStoredPreparation {
  // SQL returns an exact bounded row; own-data capture rejects surprising adapters.
  const captured = captureOriginalMovePreparationJson(row, 2 * preparationLimit) as PreparationRow;
  if (!captured || Array.isArray(captured) || typeof captured !== 'object' || Object.keys(captured).length !== 9) originalMovePreparationFailure();
  const prepared = decodeWorkspaceOperationOriginalMovePreparation(captured.preparationText as string, context, nativeBundleData);
  const expected = prepared.preparation;
  if (captured.batchId !== expected.batchId || captured.planId !== expected.planId || captured.workspaceId !== expected.workspaceId
    || captured.requestHash !== expected.requestHash || captured.requestId !== expected.requestId || captured.requestDigest !== expected.requestDigest
    || captured.preparationDigest !== prepared.preparationDigest) originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_CHANGED');
  const createdAt = typeof captured.createdAt === 'string' && /^(?:0|[1-9][0-9]{0,15})$/u.test(captured.createdAt)
    ? Number(captured.createdAt) : captured.createdAt;
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || Object.is(createdAt, -0)
    || createdAt < 0 || createdAt > Number.MAX_SAFE_INTEGER - 1) originalMovePreparationFailure();
  return Object.freeze({ ...prepared, createdAt });
}

/** Caller-owned snapshot/transaction only. A row is usable only with its exact
 * immutable native intent; no deltas, witness, reservation or claims are made. */
export async function readWorkspaceOperationOriginalMovePreparationOnConnection(database: SqlConnection,
  input: Readonly<{ schema: string; context: WorkspaceOperationOriginalMoveContext; readOnly?: true }>
): Promise<WorkspaceOperationOriginalMoveStoredPreparation | null> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) originalMovePreparationFailure();
  const fields = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(input);
  if (keys.length !== (Object.hasOwn(fields, 'readOnly') ? 3 : 2)) originalMovePreparationFailure();
  for (const name of ['schema', 'context', ...(Object.hasOwn(fields, 'readOnly') ? ['readOnly'] : [])]) {
    if (!fields[name]?.enumerable || !Object.hasOwn(fields[name], 'value')) originalMovePreparationFailure();
  }
  if (Object.hasOwn(fields, 'readOnly') && fields.readOnly?.value !== true) originalMovePreparationFailure();
  const schema = originalMovePreparationSchema(fields.schema.value);
  const context = captureOriginalMovePreparationJson(fields.context.value, 64 * 1024 ** 2) as unknown as WorkspaceOperationOriginalMoveContext;
  const nativeIds = getWorkspaceOperationOriginalMoveNativeIds(context);
  if (context.plan.planIdentityVersion !== 2 && context.plan.planIdentityVersion !== 3 && context.plan.planIdentityVersion !== 4) originalMovePreparationFailure();
  const lock = Object.hasOwn(fields, 'readOnly') ? '' : ' FOR SHARE NOWAIT';
  const row = await database.get(`SELECT ${preparationColumns} FROM ${schema}.workspace_file_operation_move_preparations WHERE batch_id=$1${lock}`, [context.batchId]);
  if (!row) return null;
  const stored = captureOriginalMovePreparationJson(row, 2 * preparationLimit) as PreparationRow;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)
    || typeof stored.preparationText !== 'string' || !stored.preparationText.length
    || Buffer.byteLength(stored.preparationText, 'utf8') > preparationLimit) originalMovePreparationFailure();
  let parsed: unknown;
  try { parsed = JSON.parse(stored.preparationText); } catch { originalMovePreparationFailure(); }
  const body = captureOriginalMovePreparationJson(parsed) as PreparationRow;
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.version !== (context.plan.planIdentityVersion === 4 ? 3 : context.plan.planIdentityVersion === 3 ? 2 : 1)
    || Object.keys(body).length !== 12 || body.batchId !== context.batchId || body.planId !== context.plan.planId
    || body.workspaceId !== context.plan.workspaceId || body.requestHash !== context.requestHash
    || originalMovePreparationCanonicalText(body.actor) !== originalMovePreparationCanonicalText(context.actor)
    || originalMovePreparationCanonicalText(body.jobScope) !== originalMovePreparationCanonicalText(context.plan.sourceEvidence.workspaceScope)
    || originalMovePreparationCanonicalText(body) !== stored.preparationText
    || createHash('sha256').update(stored.preparationText, 'utf8').digest('hex') !== stored.preparationDigest
    || stored.batchId !== body.batchId || stored.planId !== body.planId || stored.workspaceId !== body.workspaceId
    || stored.requestHash !== body.requestHash || stored.requestId !== body.requestId || stored.requestDigest !== body.requestDigest) {
    originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_CHANGED');
  }
  decodeWorkspaceOperationMixedOriginalSourceWitness(context.plan.sourceEvidence, body.currentWitness);
  let nativeBundleData: WorkspaceOperationOriginalMoveNativeBundleData | null = null;
  if (body.nativeBundle !== null) {
    const reference = body.nativeBundle as PreparationRow;
    if (!reference || Array.isArray(reference) || typeof reference !== 'object'
      || Object.keys(reference).length !== 3 || typeof reference.operationId !== 'string'
      || reference.operationId !== nativeIds.operationId || reference.requestId !== nativeIds.requestId || body.requestId !== nativeIds.requestId
      || typeof reference.changesBundleProof !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.changesBundleProof)
      || typeof body.actionPayloadText !== 'string') originalMovePreparationFailure();
    const native = await database.get(`SELECT CASE WHEN octet_length(operation_id) BETWEEN 1 AND 256 THEN operation_id ELSE NULL END AS "operationId",
      CASE WHEN octet_length(request_id) BETWEEN 1 AND 256 THEN request_id ELSE NULL END AS "requestId",
      CASE WHEN octet_length(changes_bundle_proof)=64 THEN changes_bundle_proof ELSE NULL END AS "changesBundleProof",
      CASE WHEN octet_length(intent_text) BETWEEN 1 AND ${nativeBundleLimit} THEN intent_text ELSE NULL END AS "privateText"
      FROM ${schema}.collaboration_native_file_operation_intents WHERE operation_id=$1${lock}`, [reference.operationId]);
    const captured = captureOriginalMovePreparationJson(native, 8 * nativeBundleLimit) as PreparationRow;
    if (!captured || typeof captured !== 'object' || Array.isArray(captured) || Object.keys(captured).length !== 4
      || captured.operationId !== reference.operationId || captured.requestId !== reference.requestId
      || captured.changesBundleProof !== reference.changesBundleProof || typeof captured.privateText !== 'string'
      || !captured.privateText.length || Buffer.byteLength(captured.privateText, 'utf8') > nativeBundleLimit
      || createHash('sha256').update(captured.privateText, 'utf8').digest('hex') !== reference.changesBundleProof) originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_CHANGED');
    // Admission stores a canonical JSON payload; the native bundle codec keeps
    // its own exact payload bytes. Derive those bytes from the one immutable
    // bundle rather than substituting Admission's differently ordered JSON.
    const bundle = decodeNativeFileOperationBundleText(captured.privateText);
    if (bundle.privateText !== captured.privateText || bundle.changesBundleProof !== reference.changesBundleProof) {
      originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_CHANGED');
    }
    nativeBundleData = Object.freeze({ privateText: bundle.privateText, changesBundleProof: bundle.changesBundleProof,
      actionPayloadText: bundle.actionPayloadText });
  }
  return originalMovePreparationStoredRow(stored, context, nativeBundleData);
}

/** Borrowed write only. Bundle staging and admission reserve must be in this
 * same original-owner transaction; this result never confirms a COMMIT. */
export async function insertWorkspaceOperationOriginalMovePreparationOnConnection(database: SqlConnection,
  input: Readonly<{ schema: string; context: WorkspaceOperationOriginalMoveContext; prepared: WorkspaceOperationOriginalMovePrepared }>
): Promise<WorkspaceOperationOriginalMovePreparationInsertResult> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== 3) originalMovePreparationFailure();
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const name of ['schema', 'context', 'prepared']) if (!fields[name]?.enumerable || !Object.hasOwn(fields[name], 'value')) originalMovePreparationFailure();
  const schema = originalMovePreparationSchema(fields.schema.value);
  const context = captureOriginalMovePreparationJson(fields.context.value, 64 * 1024 ** 2) as unknown as WorkspaceOperationOriginalMoveContext;
  const supplied = fields.prepared.value as unknown;
  if (!supplied || typeof supplied !== 'object' || types.isProxy(supplied) || Object.getPrototypeOf(supplied) !== Object.prototype
    || Reflect.ownKeys(supplied).length !== 5) originalMovePreparationFailure();
  const suppliedFields = Object.getOwnPropertyDescriptors(supplied);
  for (const name of ['preparationText', 'preparationDigest', 'preparation', 'request', 'nativeBundleData']) {
    if (!suppliedFields[name]?.enumerable || !Object.hasOwn(suppliedFields[name], 'value')) originalMovePreparationFailure();
  }
  const prepared = decodeWorkspaceOperationOriginalMovePreparation(suppliedFields.preparationText.value, context, suppliedFields.nativeBundleData.value);
  if (suppliedFields.preparationDigest.value !== prepared.preparationDigest
    || originalMovePreparationCanonicalText(suppliedFields.preparation.value) !== prepared.preparationText
    || originalMovePreparationCanonicalText(suppliedFields.request.value) !== originalMovePreparationCanonicalText(prepared.request)) originalMovePreparationFailure('ORIGINAL_MOVE_PREPARATION_CHANGED');
  const p = prepared.preparation;
  if (!await database.get(`SELECT batch_id FROM ${schema}.workspace_file_operation_batches WHERE batch_id=$1 FOR UPDATE NOWAIT`, [p.batchId])) return Object.freeze({ kind: 'conflict' });
  const inserted = await database.get(`INSERT INTO ${schema}.workspace_file_operation_move_preparations
    (batch_id,plan_id,workspace_id,request_hash,request_id,request_digest,preparation_text,preparation_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(batch_id) DO NOTHING RETURNING ${preparationColumns}`,
  [p.batchId, p.planId, p.workspaceId, p.requestHash, p.requestId, p.requestDigest, prepared.preparationText, prepared.preparationDigest]);
  const current = await database.get(`SELECT ${preparationColumns} FROM ${schema}.workspace_file_operation_move_preparations WHERE batch_id=$1 FOR SHARE NOWAIT`, [p.batchId]);
  if (!current) return Object.freeze({ kind: 'conflict' });
  const currentData = captureOriginalMovePreparationJson(current, 2 * preparationLimit) as PreparationRow;
  if (!currentData || typeof currentData !== 'object' || Array.isArray(currentData)
    || currentData.preparationText !== prepared.preparationText || currentData.preparationDigest !== prepared.preparationDigest
    || currentData.batchId !== p.batchId || currentData.planId !== p.planId || currentData.workspaceId !== p.workspaceId
    || currentData.requestHash !== p.requestHash || currentData.requestId !== p.requestId || currentData.requestDigest !== p.requestDigest) return Object.freeze({ kind: 'conflict' });
  const row = originalMovePreparationStoredRow(currentData, context, prepared.nativeBundleData);
  if (inserted && originalMovePreparationStoredRow(inserted, context, prepared.nativeBundleData).createdAt !== row.createdAt) return Object.freeze({ kind: 'conflict' });
  return Object.freeze({ kind: inserted ? 'created' : 'existing', row });
}
