import 'server-only';

import { types } from 'node:util';
import { isDocumentVersionTokenV1 } from './contracts';
import type { DocumentVersionIdentityV1 } from './read-version';
import { DocumentEditError } from './edit-contracts';

export const MAX_DOCUMENT_EDIT_OPERATION_RESULT_BYTES = 8 * 1024;
export type DocumentEditStatusRequestV1 = Readonly<{ apiVersion: 1; workspaceId: string; operationId: string }>;
export type DocumentEditOperationResultV1 = Readonly<{
  apiVersion: 1; operationId: string; state: 'pending' | 'confirmed' | 'conflict' | 'failed';
  document: Readonly<DocumentVersionIdentityV1 & { kind: 'native_document' }>;
  /** Historical actual effect. This is neither a current document nor a durable snapshot version. */
  effect: Readonly<{ outcome: 'applied' | 'no_change'; beforeVersion: string; afterVersion: string; appliedAt: number }> | null;
  persistence: Readonly<{ status: 'confirmed' | 'unconfirmed'; confirmedInSequence: number | null; confirmedAt: number | null }>;
  /** Recorded historical checkpoint only, never current filesystem availability. */
  projection: Readonly<{ status: 'checkpointed' | 'unconfirmed'; checkpointedAt: number | null; revisionId: string | null }>;
  history: Readonly<{ status: 'captured' | 'unconfirmed' | 'over_limit'; revisionId: string | null }>;
}>;

function invalid(): never { throw new DocumentEditError('INVALID_REQUEST'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = descriptors[key];
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) invalid();
    result[key] = field.value as unknown;
  }
  return result;
}
function text(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function operationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function revision(value: unknown): value is string { return text(value, 128); }
export function decodeDocumentEditStatusRequestV1(value: unknown): DocumentEditStatusRequestV1 {
  const input = object(value, ['apiVersion', 'workspaceId', 'operationId']);
  if (input.apiVersion !== 1 || !text(input.workspaceId) || !operationId(input.operationId)) invalid();
  return Object.freeze({ apiVersion: 1, workspaceId: input.workspaceId, operationId: input.operationId });
}

/** Strict detached comparison DTO. Encoding grants no authority and proves no mutation. */
export function encodeDocumentEditOperationResultV1(value: unknown): DocumentEditOperationResultV1 {
  const input = object(value, ['apiVersion', 'operationId', 'state', 'document', 'effect', 'persistence', 'projection', 'history']);
  if (input.apiVersion !== 1 || !operationId(input.operationId)
    || !['pending', 'confirmed', 'conflict', 'failed'].includes(typeof input.state === 'string' ? input.state : '')) invalid();
  const identity = object(input.document, ['kind', 'workspaceId', 'organizationId', 'documentId', 'lineageId', 'lifecycleGeneration', 'representation', 'schemaVersion']);
  if (identity.kind !== 'native_document' || !text(identity.workspaceId) || !text(identity.documentId) || !text(identity.lineageId)
    || identity.organizationId !== null && !text(identity.organizationId)
    || !integer(identity.lifecycleGeneration, 1) || !integer(identity.schemaVersion, 1)
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(typeof identity.representation === 'string' ? identity.representation : '')) invalid();
  const document: DocumentEditOperationResultV1['document'] = Object.freeze({ kind: 'native_document', workspaceId: identity.workspaceId,
    organizationId: identity.organizationId as string | null, documentId: identity.documentId, lineageId: identity.lineageId,
    lifecycleGeneration: identity.lifecycleGeneration, representation: identity.representation as DocumentVersionIdentityV1['representation'], schemaVersion: identity.schemaVersion });
  let effect: DocumentEditOperationResultV1['effect'] = null;
  if (input.effect !== null) {
    const fields = object(input.effect, ['outcome', 'beforeVersion', 'afterVersion', 'appliedAt']);
    if (!['applied', 'no_change'].includes(typeof fields.outcome === 'string' ? fields.outcome : '')
      || !isDocumentVersionTokenV1(fields.beforeVersion) || !isDocumentVersionTokenV1(fields.afterVersion) || !integer(fields.appliedAt)
      || (fields.outcome === 'no_change') !== (fields.beforeVersion === fields.afterVersion)) invalid();
    effect = Object.freeze({ outcome: fields.outcome as 'applied' | 'no_change', beforeVersion: fields.beforeVersion, afterVersion: fields.afterVersion, appliedAt: fields.appliedAt });
  }
  const p = object(input.persistence, ['status', 'confirmedInSequence', 'confirmedAt']);
  if (p.status !== 'confirmed' && p.status !== 'unconfirmed') invalid();
  if (p.status === 'confirmed' ? !effect || !integer(p.confirmedInSequence) || !integer(p.confirmedAt)
    : p.confirmedInSequence !== null || p.confirmedAt !== null) invalid();
  if (effect && p.status === 'confirmed' && integer(p.confirmedAt) && p.confirmedAt < effect.appliedAt) invalid();
  if ((input.state === 'confirmed') !== (p.status === 'confirmed')
    || (input.state === 'conflict' || input.state === 'failed') && effect !== null) invalid();
  const projection = object(input.projection, ['status', 'checkpointedAt', 'revisionId']);
  if (projection.status !== 'checkpointed' && projection.status !== 'unconfirmed') invalid();
  if (projection.status === 'checkpointed' ? p.status !== 'confirmed' || !integer(projection.checkpointedAt) || !revision(projection.revisionId)
    : projection.checkpointedAt !== null || projection.revisionId !== null) invalid();
  if (projection.status === 'checkpointed' && integer(projection.checkpointedAt) && integer(p.confirmedAt)
    && projection.checkpointedAt < p.confirmedAt) invalid();
  const history = object(input.history, ['status', 'revisionId']);
  if (!['captured', 'unconfirmed', 'over_limit'].includes(typeof history.status === 'string' ? history.status : '')) invalid();
  if (history.status === 'captured' ? !effect || !revision(history.revisionId)
    : history.revisionId !== null || history.status === 'over_limit' && !effect) invalid();
  const result: DocumentEditOperationResultV1 = Object.freeze({ apiVersion: 1, operationId: input.operationId,
    state: input.state as DocumentEditOperationResultV1['state'], document, effect,
    persistence: Object.freeze({ status: p.status, confirmedInSequence: p.confirmedInSequence as number | null, confirmedAt: p.confirmedAt as number | null }),
    projection: Object.freeze({ status: projection.status, checkpointedAt: projection.checkpointedAt as number | null, revisionId: projection.revisionId as string | null }),
    history: Object.freeze({ status: history.status as DocumentEditOperationResultV1['history']['status'], revisionId: history.revisionId as string | null }) });
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_DOCUMENT_EDIT_OPERATION_RESULT_BYTES) throw new DocumentEditError('DOCUMENT_TOO_LARGE');
  return result;
}

const idSchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 256 });
const revisionSchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 128 });
const operationSchema = Object.freeze({ type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', maxLength: 128 });
const numberSchema = Object.freeze({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullSchema = Object.freeze({ type: 'null' });
const versionSchema = Object.freeze({ type: 'string', pattern: '^canvas-document-v1:[a-f0-9]{64}$' });
export const DOCUMENT_EDIT_STATUS_REQUEST_JSON_SCHEMA_V1 = Object.freeze({ type: 'object', additionalProperties: false,
  required: Object.freeze(['apiVersion', 'workspaceId', 'operationId']), properties: Object.freeze({
    apiVersion: Object.freeze({ const: 1 }), workspaceId: idSchema, operationId: operationSchema }) });
export const DOCUMENT_EDIT_OPERATION_RESULT_JSON_SCHEMA_V1 = Object.freeze({ type: 'object', additionalProperties: false,
  required: Object.freeze(['apiVersion', 'operationId', 'state', 'document', 'effect', 'persistence', 'projection', 'history']),
  properties: Object.freeze({ apiVersion: Object.freeze({ const: 1 }), operationId: operationSchema,
    state: Object.freeze({ enum: Object.freeze(['pending', 'confirmed', 'conflict', 'failed']) }),
    document: Object.freeze({ type: 'object', additionalProperties: false,
      required: Object.freeze(['kind', 'workspaceId', 'organizationId', 'documentId', 'lineageId', 'lifecycleGeneration', 'representation', 'schemaVersion']),
      properties: Object.freeze({ kind: Object.freeze({ const: 'native_document' }), workspaceId: idSchema, documentId: idSchema, lineageId: idSchema,
        organizationId: Object.freeze({ anyOf: Object.freeze([idSchema, Object.freeze({ type: 'null' })]) }),
        lifecycleGeneration: Object.freeze({ ...numberSchema, minimum: 1 }), schemaVersion: Object.freeze({ ...numberSchema, minimum: 1 }),
        representation: Object.freeze({ enum: Object.freeze(['plain_text', 'tiptap_xml', 'tiptap_blocks']) }) }) }),
    effect: Object.freeze({ anyOf: Object.freeze([Object.freeze({ type: 'null' }), Object.freeze({ type: 'object', additionalProperties: false,
      required: Object.freeze(['outcome', 'beforeVersion', 'afterVersion', 'appliedAt']), properties: Object.freeze({
        outcome: Object.freeze({ enum: Object.freeze(['applied', 'no_change']) }), beforeVersion: versionSchema, afterVersion: versionSchema, appliedAt: numberSchema }) })]) }),
    persistence: Object.freeze({ oneOf: Object.freeze(['confirmed', 'unconfirmed'].map(status => Object.freeze({ type: 'object', additionalProperties: false,
      required: Object.freeze(['status', 'confirmedInSequence', 'confirmedAt']), properties: Object.freeze({ status: Object.freeze({ const: status }),
        confirmedInSequence: status === 'confirmed' ? numberSchema : nullSchema, confirmedAt: status === 'confirmed' ? numberSchema : nullSchema }) }))) }),
    projection: Object.freeze({ oneOf: Object.freeze(['checkpointed', 'unconfirmed'].map(status => Object.freeze({ type: 'object', additionalProperties: false,
      required: Object.freeze(['status', 'checkpointedAt', 'revisionId']), properties: Object.freeze({ status: Object.freeze({ const: status }),
        checkpointedAt: status === 'checkpointed' ? numberSchema : nullSchema, revisionId: status === 'checkpointed' ? revisionSchema : nullSchema }) }))) }),
    history: Object.freeze({ oneOf: Object.freeze(['captured', 'unconfirmed', 'over_limit'].map(status => Object.freeze({ type: 'object', additionalProperties: false,
      required: Object.freeze(['status', 'revisionId']), properties: Object.freeze({ status: Object.freeze({ const: status }),
        revisionId: status === 'captured' ? revisionSchema : nullSchema }) }))) }),
  }),
  allOf: Object.freeze([
    Object.freeze({ if: Object.freeze({ properties: Object.freeze({ state: Object.freeze({ const: 'confirmed' }) }), required: Object.freeze(['state']) }),
      then: Object.freeze({ properties: Object.freeze({ effect: Object.freeze({ type: 'object' }), persistence: Object.freeze({ properties: Object.freeze({ status: Object.freeze({ const: 'confirmed' }) }) }) }) }),
      else: Object.freeze({ properties: Object.freeze({ persistence: Object.freeze({ properties: Object.freeze({ status: Object.freeze({ const: 'unconfirmed' }) }) }) }) }) }),
    Object.freeze({ if: Object.freeze({ properties: Object.freeze({ state: Object.freeze({ enum: Object.freeze(['conflict', 'failed']) }) }), required: Object.freeze(['state']) }),
      then: Object.freeze({ properties: Object.freeze({ effect: nullSchema }) }) }),
    Object.freeze({ if: Object.freeze({ properties: Object.freeze({ projection: Object.freeze({ properties: Object.freeze({ status: Object.freeze({ const: 'checkpointed' }) }) }) }) }),
      then: Object.freeze({ properties: Object.freeze({ state: Object.freeze({ const: 'confirmed' }) }) }) }),
    Object.freeze({ if: Object.freeze({ properties: Object.freeze({ history: Object.freeze({ properties: Object.freeze({ status: Object.freeze({ enum: Object.freeze(['captured', 'over_limit']) }) }) }) }) }),
      then: Object.freeze({ properties: Object.freeze({ effect: Object.freeze({ type: 'object' }) }) }) }),
  ]),
});
