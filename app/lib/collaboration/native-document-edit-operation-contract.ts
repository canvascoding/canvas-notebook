import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { isDocumentVersionTokenV1 } from '../documents/contracts';
import { DocumentEditError } from '../documents/edit-contracts';
import type { NativeDocumentEditAuthorityOrigin } from '../documents/edit-principal';
import { documentVersionV1, type DocumentVersionIdentityV1 } from '../documents/read-version';
import { isCanonicalWorkspacePath } from '../workspaces/path-identity';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { captureIdentity } from './native-document-edit-validation';
import { isCollaborationStateProof } from './state-proof';

/** A bounded recovery reference, never authority or an assertion of success. */
export class NativeDocumentEditOperationError extends DocumentEditError {
  readonly operationId: string;
  constructor(code: ConstructorParameters<typeof DocumentEditError>[0], operationId: string) {
    super(code);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operationId)) throw new DocumentEditError('EDIT_OUTCOME_UNCONFIRMED');
    this.name = 'NativeDocumentEditOperationError'; this.operationId = operationId;
  }
}
export const NATIVE_EDIT_HISTORY_BYTES = 1024 * 1024;
export type NativeDocumentEditOriginalV1 = Readonly<{
  kind: 'native_document_edit_original'; version: 1;
  requestFingerprint: string; identity: Readonly<DocumentVersionIdentityV1>; expectedVersion: string;
  origin: NativeDocumentEditAuthorityOrigin;
  actor: Readonly<{ userId: string; actorType: 'user' | 'agent'; actorId: string; sessionId: string }>;
  source: Readonly<{ path: string; stateProof: string; stateVectorHash: string; persistedSequence: number }>;
  preparedIntentProof: string; originalProof: string;
}>;
export type NativeDocumentEditHistoryDescriptor = Readonly<
  { status: 'ready'; format: 'native-yjs-update-v1'; sha256: string; sizeBytes: number }
  | { status: 'over_limit'; format: 'native-yjs-update-v1'; sizeBytes: number | null }
>;
export type NativeDocumentEditAfterV1 = Readonly<{
  kind: 'native_document_edit_after'; version: 1; originalProof: string;
  outcome: 'applied' | 'no_change'; identity: Readonly<DocumentVersionIdentityV1>;
  beforeVersion: string; afterVersion: string; stateProof: string;
  stateVectorHash: string; stateSnapshotHash: string; appliedAt: number;
  history: NativeDocumentEditHistoryDescriptor; afterProof: string;
}>;

function invalid(): never { throw new DocumentEditError('EDIT_OUTCOME_UNCONFIRMED'); }
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= minimum;
function text(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid();
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value); if (result === undefined) invalid(); return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}
/** Comparison proof only. Input is server-captured data, never an authority. */
export function nativeDocumentEditDataProof(value: unknown): string {
  const captured = captureWorkspaceOperationNativePlanData(value, () => invalid());
  return createHash('sha256').update(canonical(captured), 'utf8').digest('hex');
}
export function nativeDocumentEditBytesProof(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const scopeOriginKeys = ['transport', 'userId', 'workspaceId', 'workspaceType', 'organizationId', 'customerId',
  'projectId', 'ownerUserId', 'rootPath', 'rootRelativePath', 'legacy', 'status', 'schema', 'schemaOid',
  'searchPath', 'databaseOid'] as const;
/** Exact historical scalar shapes. No token, Request, invocation, closure or B survives. */
export function captureNativeDocumentEditOrigin(value: unknown): NativeDocumentEditAuthorityOrigin {
  if (!value || typeof value !== 'object' || types.isProxy(value)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'transport');
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid();
  const transport: unknown = descriptor.value;
  const extra = transport === 'request' ? ['sessionId', 'impersonatedBy']
    : transport === 'direct-mcp' ? ['clientId', 'sessionId', 'tool']
      : transport === 'agent-tool' ? ['agentId', 'piSessionId', 'toolName', 'toolCallId', 'agentTurnId',
        'piSessionDbId', 'agentProfileId', 'agentProfileRevision', 'workflowVersion', 'workflowRevision'] : null;
  if (!extra) invalid();
  const row = object(value, [...scopeOriginKeys, ...extra]);
  for (const key of ['userId', 'workspaceId', 'workspaceType']) if (!text(row[key])) invalid();
  for (const key of ['organizationId', 'customerId', 'projectId', 'ownerUserId']) if (row[key] !== null && !text(row[key])) invalid();
  for (const key of ['rootPath', 'rootRelativePath', 'searchPath']) if (!text(row[key], 4096)) invalid();
  if (row.legacy !== false || row.status !== 'active' || !text(row.schema, 63)
    || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(row.schema) || row.schema.startsWith('pg_')
    || !integer(row.schemaOid, 1) || row.schemaOid > 4294967295
    || !integer(row.databaseOid, 1) || row.databaseOid > 4294967295) invalid();
  if (transport === 'request') {
    if (!text(row.sessionId) || row.impersonatedBy !== null && !text(row.impersonatedBy)) invalid();
  } else if (transport === 'direct-mcp') {
    if (!text(row.sessionId) || !text(row.clientId) || row.tool !== 'edit_knowledge_source') invalid();
  } else {
    for (const key of ['agentId', 'piSessionId', 'toolName', 'toolCallId']) if (!text(row[key])) invalid();
    if (row.agentTurnId !== null && !text(row.agentTurnId)
      || row.toolName !== 'edit_file' || !integer(row.piSessionDbId, 1) || !integer(row.agentProfileId, 1)
      || !integer(row.agentProfileRevision) || !integer(row.workflowRevision)
      || row.workflowVersion !== null && !integer(row.workflowVersion)) invalid();
  }
  if (Buffer.byteLength(canonical(row), 'utf8') > 16 * 1024) invalid();
  return Object.freeze(row) as unknown as NativeDocumentEditAuthorityOrigin;
}

export function nativeDocumentEditOwnerTuple(origin: NativeDocumentEditAuthorityOrigin): readonly string[] {
  const captured = captureNativeDocumentEditOrigin(origin);
  return Object.freeze(captured.transport === 'direct-mcp' ? [captured.transport, captured.userId, captured.clientId]
    : captured.transport === 'agent-tool' ? [captured.transport, captured.userId, captured.agentId]
      : [captured.transport, captured.userId]);
}
export function nativeDocumentEditLedgerKey(origin: NativeDocumentEditAuthorityOrigin, suppliedKey: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(suppliedKey)) invalid();
  return `native-edit-v1:${nativeDocumentEditDataProof([nativeDocumentEditOwnerTuple(origin), suppliedKey])}`;
}

type OriginalBody = Omit<NativeDocumentEditOriginalV1, 'originalProof'>;
export function makeNativeDocumentEditOriginal(body: OriginalBody): NativeDocumentEditOriginalV1 {
  return captureNativeDocumentEditOriginal({ ...body, originalProof: nativeDocumentEditDataProof(body) });
}
export function captureNativeDocumentEditOriginal(value: unknown): NativeDocumentEditOriginalV1 {
  const row = object(value, ['kind', 'version', 'requestFingerprint', 'identity', 'expectedVersion', 'origin',
    'actor', 'source', 'preparedIntentProof', 'originalProof']);
  const identity = captureIdentity(row.identity as DocumentVersionIdentityV1), origin = captureNativeDocumentEditOrigin(row.origin);
  const actor = object(row.actor, ['userId', 'actorType', 'actorId', 'sessionId']);
  const source = object(row.source, ['path', 'stateProof', 'stateVectorHash', 'persistedSequence']);
  if (row.kind !== 'native_document_edit_original' || row.version !== 1
    || !hash(row.requestFingerprint) || !hash(row.preparedIntentProof) || !hash(row.originalProof)
    || actor.userId !== origin.userId || !text(actor.actorId) || !text(actor.sessionId)
    || actor.actorType !== (origin.transport === 'request' ? 'user' : 'agent')
    || (origin.transport !== 'agent-tool' && actor.sessionId !== origin.sessionId)
    || (origin.transport === 'agent-tool' && (actor.sessionId !== origin.piSessionId || actor.actorId !== origin.agentId))
    || (origin.transport === 'request' && actor.actorId !== origin.userId)
    || (origin.transport === 'direct-mcp' && actor.actorId !== `direct-mcp:${createHash('sha256').update(origin.clientId).digest('hex').slice(0,32)}`)
    || identity.workspaceId !== origin.workspaceId || identity.organizationId !== origin.organizationId
    || !isCanonicalWorkspacePath(source.path) || Buffer.from(source.path, 'utf8').toString('utf8') !== source.path
    || !isCollaborationStateProof(source.stateProof)
    || !hash(source.stateVectorHash) || !integer(source.persistedSequence)
    || documentVersionV1(identity, source.stateProof) !== row.expectedVersion) invalid();
  const body: OriginalBody = { kind: 'native_document_edit_original', version: 1,
    requestFingerprint: row.requestFingerprint, identity, expectedVersion: row.expectedVersion as string, origin,
    actor: Object.freeze({userId:actor.userId as string,actorType:actor.actorType as 'user'|'agent',
      actorId:actor.actorId,sessionId:actor.sessionId}),
    source: Object.freeze({path:source.path,stateProof:source.stateProof,stateVectorHash:source.stateVectorHash,
      persistedSequence:source.persistedSequence}), preparedIntentProof: row.preparedIntentProof };
  if (Buffer.byteLength(canonical(body), 'utf8') > 32 * 1024 || nativeDocumentEditDataProof(body) !== row.originalProof) invalid();
  return Object.freeze({ ...body, originalProof: row.originalProof });
}

type AfterBody = Omit<NativeDocumentEditAfterV1, 'afterProof'>;
export function makeNativeDocumentEditAfter(body: AfterBody, original: NativeDocumentEditOriginalV1): NativeDocumentEditAfterV1 {
  return captureNativeDocumentEditAfter({ ...body, afterProof: nativeDocumentEditDataProof(body) }, original);
}
export function captureNativeDocumentEditAfter(value: unknown, original?: NativeDocumentEditOriginalV1): NativeDocumentEditAfterV1 {
  const row = object(value, ['kind', 'version', 'originalProof', 'outcome', 'identity', 'beforeVersion', 'afterVersion',
    'stateProof', 'stateVectorHash', 'stateSnapshotHash', 'appliedAt', 'history', 'afterProof']);
  const identity = captureIdentity(row.identity as DocumentVersionIdentityV1);
  const historyValue = row.history;
  if (!historyValue || typeof historyValue !== 'object' || types.isProxy(historyValue)) invalid();
  const status = Object.getOwnPropertyDescriptor(historyValue, 'status');
  if (!status || !Object.prototype.hasOwnProperty.call(status, 'value')) invalid();
  const history = object(historyValue, status.value === 'ready' ? ['status', 'format', 'sha256', 'sizeBytes'] : ['status', 'format', 'sizeBytes']);
  if (history.format !== 'native-yjs-update-v1'
    || (history.status === 'ready' ? !hash(history.sha256) || !integer(history.sizeBytes, 1) || history.sizeBytes > NATIVE_EDIT_HISTORY_BYTES
      : history.status !== 'over_limit' || history.sizeBytes !== null && !integer(history.sizeBytes, 1))) invalid();
  if (row.kind !== 'native_document_edit_after' || row.version !== 1 || !hash(row.originalProof)
    || !isDocumentVersionTokenV1(row.beforeVersion) || typeof row.outcome !== 'string' || !['applied', 'no_change'].includes(row.outcome) || !isCollaborationStateProof(row.stateProof)
    || documentVersionV1(identity, row.stateProof) !== row.afterVersion
    || !hash(row.stateVectorHash) || !hash(row.stateSnapshotHash) || !integer(row.appliedAt)
    || row.stateSnapshotHash !== row.stateProof.slice('yjs-snapshot-sha256-v1:'.length) || !hash(row.afterProof)) invalid();
  if (original && (row.originalProof !== original.originalProof || !isDeepStrictEqual(identity, original.identity)
    || row.beforeVersion !== original.expectedVersion
    || row.outcome === 'no_change' && row.afterVersion !== row.beforeVersion)) invalid();
  const body: AfterBody = { kind: 'native_document_edit_after', version: 1, originalProof: row.originalProof,
    outcome: row.outcome as AfterBody['outcome'], identity, beforeVersion: row.beforeVersion as string,
    afterVersion: row.afterVersion as string, stateProof: row.stateProof, stateVectorHash: row.stateVectorHash,
    stateSnapshotHash: row.stateSnapshotHash, appliedAt: row.appliedAt,
    history: Object.freeze(history.status === 'ready'
      ? {status:'ready',format:'native-yjs-update-v1',sha256:history.sha256 as string,sizeBytes:history.sizeBytes as number}
      : {status:'over_limit',format:'native-yjs-update-v1',sizeBytes:history.sizeBytes as number|null}) };
  if (nativeDocumentEditDataProof(body) !== row.afterProof) invalid();
  return Object.freeze({ ...body, afterProof: row.afterProof });
}
