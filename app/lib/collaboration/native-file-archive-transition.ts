import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ARCHIVED_NATIVE_BINARY_LIMIT, inspectArchivedNativeSnapshot } from './archived-native-snapshot';
import { inspectPersistedNativeCollaborationSnapshot } from './document-snapshot';
import { isCollaborationStateQuarantined } from './failure';
import { getNativeInspectionSchema } from './native-inspection-schema';
import { assertNativeDocumentSchema } from './native-document-schema';
import type { PersistedCollaborationState } from './persistence';
import { isCanonicalAdmissionPath } from './room-admission-contract';
import { isCollaborationStateProof } from './state-proof';
import { COLLABORATION_SCHEMA_VERSION } from './types';

export type NativeFileArchiveExpected = Readonly<{
  documentId: string; lineageId: string; workspaceId: string; organizationId: string | null; path: string;
  representation: PersistedCollaborationState['representation']; schemaVersion: number; lifecycleGeneration: number;
  registryStateVersion: number; documentSequence: number; persistedAt: number;
  stateProof: string; binaryHash: string; vectorHash: string;
}>;
export type NativeFileArchiveSelection = Readonly<{ trashEntryId: string; archivedAt: number }>;
type ProjectionError = NonNullable<PersistedCollaborationState['projectionError']>;
type Identity = Pick<NativeFileArchiveExpected, 'documentId' | 'lineageId' | 'workspaceId' | 'organizationId'
  | 'path' | 'representation' | 'schemaVersion' | 'lifecycleGeneration'>;
type Clock = Pick<NativeFileArchiveExpected, 'documentSequence' | 'persistedAt' | 'stateProof' | 'binaryHash' | 'vectorHash'>;
export type NativeFileArchiveTransition = Readonly<{
  version: 1;
  before: Readonly<{ identity: Identity; clock: Clock; registryStateVersion: number;
    byteProfile: Readonly<{ newlineStyle: 'lf' | 'crlf'; hasBom: boolean }>;
    projection: Readonly<{ checkpointSequence: number; checkpointedAt: number | null; canonicalHash: string | null;
      serializedHash: string | null; finalized: boolean | null }>;
    diagnostics: Readonly<{ degraded: boolean; projectionError: ProjectionError | null }> }>;
  after: Readonly<{ identity: Identity; clock: Clock; registryStateVersion: 0; status: 'archived' }>;
  cas: Readonly<{
    state: Readonly<Omit<Identity, 'lineageId'> & Clock & { status: 'active' }>;
    registry: Readonly<{ documentId: string; lineageId: string; workspaceId: string; organizationId: string | null;
      path: string; provider: 'yjs'; stateLifecycle: 'initialized'; stateVersion: number; status: 'active' }>;
    lineage: Readonly<{ lineageId: string; workspaceId: string; organizationId: string | null; path: string; status: 'active' }>;
  }>;
  writes: Readonly<{
    state: Readonly<{ status: 'archived'; lifecycleGeneration: number; checkpointSequence: 0; checkpointedAt: null;
      canonicalHash: null; serializedHash: null; degraded: false; projectionError: null }>;
    registry: Readonly<{ status: 'archived'; stateVersion: 0; snapshotRevisionId: null; updatedAt: number }>;
    lineage: Readonly<{ status: 'archived'; archivedAt: number; trashEntryId: string }>;
    projection: Readonly<{ documentId: string; lifecycleGeneration: number; projectedSequence: number; finalized: false;
      revisionId: null; canonicalHash: null; serializedHash: null; updatedAt: number }>;
  }>;
  projectionDisposition: 'reset_derived_status_for_new_archive_generation';
}>;

export class NativeFileArchiveTransitionError extends Error {
  constructor(readonly code: 'NATIVE_FILE_ARCHIVE_INVALID' | 'NATIVE_FILE_ARCHIVE_SOURCE_CHANGED' | 'NATIVE_FILE_ARCHIVE_TOO_LARGE') {
    super(code); this.name = 'NativeFileArchiveTransitionError';
  }
}
const fail = (code: NativeFileArchiveTransitionError['code']): never => { throw new NativeFileArchiveTransitionError(code); };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= minimum && value < Number.MAX_SAFE_INTEGER;
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;

function capture<T extends object>(input: T, keys: readonly string[]): T {
  if (!plain(input) || Reflect.ownKeys(input).length !== keys.length) fail('NATIVE_FILE_ARCHIVE_INVALID');
  const copied: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input,key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) fail('NATIVE_FILE_ARCHIVE_INVALID');
    copied[key] = descriptor!.value;
  }
  return copied as T;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function diagnostics(state: PersistedCollaborationState): ProjectionError | null {
  if (typeof state.degraded !== 'boolean' || typeof state.hasBom !== 'boolean'
    || !['lf','crlf'].includes(state.newlineStyle) || !integer(state.checkpointSequence)
    || state.checkpointSequence > state.documentSequence || state.checkpointedAt !== null && !integer(state.checkpointedAt)
    || state.projectionFinalized !== undefined && typeof state.projectionFinalized !== 'boolean'
    || [state.canonicalHash,state.serializedHash].some(value => value !== null && (typeof value !== 'string' || value.length > 256))) {
    fail('NATIVE_FILE_ARCHIVE_INVALID');
  }
  if (state.projectionError === undefined) return null;
  const error = state.projectionError;
  if (!plain(error) || Reflect.ownKeys(error).some(key => typeof key !== 'string'
    || !['code','sequence','permanent','phase'].includes(key)
    || !Object.getOwnPropertyDescriptor(error,key)?.enumerable
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(error,key)!,'value'))
    || !id(error.code) || !integer(error.sequence) || error.sequence > state.documentSequence || typeof error.permanent !== 'boolean'
    || error.phase !== undefined && (typeof error.phase !== 'string' || error.phase.length > 256 || /[\u0000-\u001f\u007f]/u.test(error.phase))) {
    fail('NATIVE_FILE_ARCHIVE_INVALID');
  }
  return { code: error.code,sequence: error.sequence,permanent: error.permanent,
    ...(error.phase !== undefined ? { phase: error.phase } : {}) };
}

/** Pure mechanical data only. The caller must first validate raw SQL flags and
 * error-generation binding, actual registry/lineage rows and genuine owner-B
 * authority. This proves no SQL, room, actor, trash receipt or COMMIT authority.
 * Registry/lineage IDs are original CAS targets, never a fresh lookup by path. */
export function prepareNativeFileArchiveTransition(state: PersistedCollaborationState,
  expected: NativeFileArchiveExpected, selection: NativeFileArchiveSelection): NativeFileArchiveTransition {
  const bound = capture(expected,['documentId','lineageId','workspaceId','organizationId','path','representation','schemaVersion',
    'lifecycleGeneration','registryStateVersion','documentSequence','persistedAt','stateProof','binaryHash','vectorHash']);
  const chosen = capture(selection,['trashEntryId','archivedAt']);
  if (![bound.documentId,bound.lineageId,bound.workspaceId,chosen.trashEntryId].every(id)
    || bound.organizationId !== null && !id(bound.organizationId) || !isCanonicalAdmissionPath(bound.path)
    || !['plain_text','tiptap_xml','tiptap_blocks'].includes(bound.representation)
    || bound.schemaVersion !== COLLABORATION_SCHEMA_VERSION || !integer(bound.lifecycleGeneration,1)
    || !integer(bound.lifecycleGeneration+1,1) || !integer(bound.registryStateVersion) || !integer(bound.documentSequence)
    || bound.registryStateVersion > bound.documentSequence
    || !integer(bound.persistedAt) || !integer(chosen.archivedAt) || chosen.archivedAt < bound.persistedAt
    || !isCollaborationStateProof(bound.stateProof) || !digest(bound.binaryHash) || !digest(bound.vectorHash)) fail('NATIVE_FILE_ARCHIVE_INVALID');
  if (!state || typeof state !== 'object' || state.status !== 'active'
    || (['documentId','workspaceId','organizationId','path','representation','schemaVersion','lifecycleGeneration',
      'documentSequence','persistedAt'] as const).some(key => state[key] !== bound[key])) fail('NATIVE_FILE_ARCHIVE_SOURCE_CHANGED');
  if (!(state.yjsState instanceof Uint8Array) || !state.yjsState.byteLength
    || !(state.stateVector instanceof Uint8Array) || !state.stateVector.byteLength) fail('NATIVE_FILE_ARCHIVE_INVALID');
  // Match the existing archived snapshot bound and the current native vector bound
  // before decoding/allocating a temporary Y.Doc. No Markdown export is involved.
  if (state.yjsState.byteLength > ARCHIVED_NATIVE_BINARY_LIMIT || state.stateVector.byteLength > 1024 * 1024) fail('NATIVE_FILE_ARCHIVE_TOO_LARGE');
  const beforeError = diagnostics(state);
  if (hash(state.yjsState) !== bound.binaryHash || hash(state.stateVector) !== bound.vectorHash) fail('NATIVE_FILE_ARCHIVE_SOURCE_CHANGED');
  const snapshot = inspectPersistedNativeCollaborationSnapshot(state,(doc, native) => {
    assertNativeDocumentSchema(doc,state.representation,getNativeInspectionSchema());
    return native;
  });
  if (snapshot.version.stateProof !== bound.stateProof) fail('NATIVE_FILE_ARCHIVE_SOURCE_CHANGED');
  const identity: Identity = { documentId: bound.documentId,lineageId: bound.lineageId,workspaceId: bound.workspaceId,
    organizationId: bound.organizationId,path: bound.path,representation: bound.representation,
    schemaVersion: bound.schemaVersion,lifecycleGeneration: bound.lifecycleGeneration };
  const clock: Clock = { documentSequence: bound.documentSequence,persistedAt: bound.persistedAt,stateProof: bound.stateProof,
    binaryHash: bound.binaryHash,vectorHash: bound.vectorHash };
  const generation = bound.lifecycleGeneration+1;
  // Native inspection ABOVE rejects every permanent or unclassified degradation.
  // The new archived generation has no active derived-file checkpoint. Clear its
  // old nonpermanent projection errors and classified PERSISTENCE_FAILED retry
  // marker instead of falsely rebinding an old failure to the new generation.
  // Preserve the entire original diagnostic in before; this never clears a
  // quarantined input and never repairs/rebuilds the native bytes or content.
  return freeze({ version: 1,
    before: { identity,clock,registryStateVersion: bound.registryStateVersion,
      byteProfile: { newlineStyle: state.newlineStyle,hasBom: state.hasBom },
      projection: { checkpointSequence: state.checkpointSequence,checkpointedAt: state.checkpointedAt,
        canonicalHash: state.canonicalHash,serializedHash: state.serializedHash,finalized: state.projectionFinalized ?? null },
      diagnostics: { degraded: state.degraded,projectionError: beforeError } },
    after: { identity: { ...identity,lifecycleGeneration: generation },clock,registryStateVersion: 0,status: 'archived' },
    cas: {
      state: { documentId: bound.documentId,workspaceId: bound.workspaceId,organizationId: bound.organizationId,path: bound.path,
        representation: bound.representation,schemaVersion: bound.schemaVersion,lifecycleGeneration: bound.lifecycleGeneration,...clock,status: 'active' },
      registry: { documentId: bound.documentId,lineageId: bound.lineageId,workspaceId: bound.workspaceId,organizationId: bound.organizationId,
        path: bound.path,provider: 'yjs',stateLifecycle: 'initialized',stateVersion: bound.registryStateVersion,status: 'active' },
      lineage: { lineageId: bound.lineageId,workspaceId: bound.workspaceId,organizationId: bound.organizationId,path: bound.path,status: 'active' },
    },
    writes: {
      state: { status: 'archived',lifecycleGeneration: generation,checkpointSequence: 0,checkpointedAt: null,
        canonicalHash: null,serializedHash: null,degraded: false,projectionError: null },
      registry: { status: 'archived',stateVersion: 0,snapshotRevisionId: null,updatedAt: chosen.archivedAt },
      lineage: { status: 'archived',archivedAt: chosen.archivedAt,trashEntryId: chosen.trashEntryId },
      projection: { documentId: bound.documentId,lifecycleGeneration: generation,projectedSequence: bound.documentSequence,
        finalized: false,revisionId: null,canonicalHash: null,serializedHash: null,updatedAt: chosen.archivedAt },
    },
    projectionDisposition: 'reset_derived_status_for_new_archive_generation',
  });
}

export type NativeFileRestoreSelection = Readonly<{ trashEntryId: string; restoredAt: number }>;
export type NativeFileRestoreTransition = Readonly<{
  version: 1;
  archive: Readonly<{ originalIdentity: Identity; trashEntryId: string; archivedAt: number }>;
  before: NativeFileArchiveTransition['after'];
  after: Readonly<{ identity: Identity; clock: Clock; registryStateVersion: 0; status: 'active' }>;
  byteProfile: NativeFileArchiveTransition['before']['byteProfile'];
  cas: Readonly<{
    state: Readonly<Omit<Identity, 'lineageId'> & Clock & { status: 'archived' }>;
    registry: Readonly<Omit<NativeFileArchiveTransition['cas']['registry'], 'status' | 'stateVersion'>
      & { status: 'archived'; stateVersion: 0 }>;
    lineage: Readonly<Omit<NativeFileArchiveTransition['cas']['lineage'], 'status'>
      & { status: 'archived'; archivedAt: number; trashEntryId: string }>;
  }>;
  writes: Readonly<{
    state: Readonly<Omit<NativeFileArchiveTransition['writes']['state'], 'status'> & { status: 'active' }>;
    registry: Readonly<Omit<NativeFileArchiveTransition['writes']['registry'], 'status'> & { status: 'active' }>;
    lineage: Readonly<{ status: 'active'; archivedAt: null; trashEntryId: null }>;
    projection: NativeFileArchiveTransition['writes']['projection'];
  }>;
  projectionDisposition: 'reset_derived_status_for_new_restore_generation';
}>;

export class NativeFileRestoreTransitionError extends Error {
  constructor(readonly code: 'NATIVE_FILE_RESTORE_INVALID' | 'NATIVE_FILE_RESTORE_SOURCE_CHANGED' | 'NATIVE_FILE_RESTORE_TOO_LARGE') {
    super(code); this.name = 'NativeFileRestoreTransitionError';
  }
}
const restoreFail = (code: NativeFileRestoreTransitionError['code']): never => { throw new NativeFileRestoreTransitionError(code); };

/** Bounded DATA capture only; this is not a receipt/authenticity proof. Shared
 * with the DAL so caller mutations/accessors cannot change a recipe after await. */
export function captureNativeFileArchiveRestoreData<T>(input: T): T {
  let nodes = 0, characters = 0;
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 512 || depth > 12) restoreFail('NATIVE_FILE_RESTORE_INVALID');
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string') {
      characters += value.length;
      if (value.length > 8192 || characters > 65536) restoreFail('NATIVE_FILE_RESTORE_INVALID');
      return value;
    }
    if (!plain(value) || Reflect.ownKeys(value).length > 32) restoreFail('NATIVE_FILE_RESTORE_INVALID');
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value,key) : undefined;
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value') || key === '__proto__') restoreFail('NATIVE_FILE_RESTORE_INVALID');
      result[key as string] = visit(descriptor!.value,depth+1);
    }
    return Object.freeze(result);
  }
  return visit(input,0) as T;
}

/** Pure original-D1 restore mechanics. The archived status is inspected as-is;
 * no active-header substitution, Markdown export, new Yjs state or authority is
 * created. Authentic immutable receipt/trash/owner-B binding belongs to caller. */
export function prepareNativeFileRestoreTransition(state: PersistedCollaborationState,
  expected: NativeFileArchiveExpected, archived: NativeFileArchiveTransition,
  selection: NativeFileRestoreSelection): NativeFileRestoreTransition {
  const bound = captureNativeFileArchiveRestoreData(expected), receipt = captureNativeFileArchiveRestoreData(archived),
    chosen = captureNativeFileArchiveRestoreData(selection);
  if (!plain(bound) || !plain(chosen)) restoreFail('NATIVE_FILE_RESTORE_INVALID');
  const keys = ['documentId','lineageId','workspaceId','organizationId','path','representation','schemaVersion',
    'lifecycleGeneration','registryStateVersion','documentSequence','persistedAt','stateProof','binaryHash','vectorHash'];
  if (!plain(bound) || Object.keys(bound).length !== keys.length || keys.some(key => !Object.hasOwn(bound,key))
    || ![bound.documentId,bound.lineageId,bound.workspaceId,chosen.trashEntryId].every(id)
    || bound.organizationId !== null && !id(bound.organizationId) || !isCanonicalAdmissionPath(bound.path)
    || !['plain_text','tiptap_xml','tiptap_blocks'].includes(bound.representation) || bound.schemaVersion !== COLLABORATION_SCHEMA_VERSION
    || !integer(bound.lifecycleGeneration,1) || !integer(bound.lifecycleGeneration+2,1)
    || !integer(bound.registryStateVersion) || !integer(bound.documentSequence) || bound.registryStateVersion > bound.documentSequence
    || !integer(bound.persistedAt) || !isCollaborationStateProof(bound.stateProof) || !digest(bound.binaryHash) || !digest(bound.vectorHash)
    || !isDeepStrictEqual(Object.keys(chosen).sort(),['restoredAt','trashEntryId']) || !integer(chosen.restoredAt)) {
    restoreFail('NATIVE_FILE_RESTORE_INVALID');
  }
  const identity: Identity = { documentId: bound.documentId,lineageId: bound.lineageId,workspaceId: bound.workspaceId,
    organizationId: bound.organizationId,path: bound.path,representation: bound.representation,schemaVersion: bound.schemaVersion,
    lifecycleGeneration: bound.lifecycleGeneration };
  const clock: Clock = { documentSequence: bound.documentSequence,persistedAt: bound.persistedAt,stateProof: bound.stateProof,
    binaryHash: bound.binaryHash,vectorHash: bound.vectorHash };
  if (!plain(receipt?.before) || !plain(receipt.before.byteProfile) || !plain(receipt.before.projection)
    || !plain(receipt.before.diagnostics) || !plain(receipt?.writes?.registry)) restoreFail('NATIVE_FILE_RESTORE_INVALID');
  const before = receipt.before, archivedAt = receipt.writes.registry.updatedAt, generation = bound.lifecycleGeneration+1;
  if (!integer(archivedAt) || archivedAt < bound.persistedAt || chosen.restoredAt < archivedAt) restoreFail('NATIVE_FILE_RESTORE_INVALID');
  // Validate the recorded pre-archive diagnostic without relabelling an archived
  // state as active or using its historical metadata as current authority.
  try {
    const historical = { ...state,documentSequence: bound.documentSequence,
      newlineStyle: before.byteProfile.newlineStyle,hasBom: before.byteProfile.hasBom,
      checkpointSequence: before.projection.checkpointSequence,checkpointedAt: before.projection.checkpointedAt,
      canonicalHash: before.projection.canonicalHash,serializedHash: before.projection.serializedHash,
      projectionFinalized: before.projection.finalized ?? undefined,degraded: before.diagnostics.degraded,
      projectionError: before.diagnostics.projectionError ?? undefined };
    diagnostics(historical);
    if (isCollaborationStateQuarantined(historical)) restoreFail('NATIVE_FILE_RESTORE_INVALID');
  } catch { restoreFail('NATIVE_FILE_RESTORE_INVALID'); }
  const reset = { lifecycleGeneration: generation,checkpointSequence: 0,checkpointedAt: null,canonicalHash: null,
    serializedHash: null,degraded: false,projectionError: null } as const;
  const expectedReceipt: NativeFileArchiveTransition = { version: 1,
    before: { identity,clock,registryStateVersion: bound.registryStateVersion,
      byteProfile: { newlineStyle: before.byteProfile.newlineStyle,hasBom: before.byteProfile.hasBom },
      projection: { checkpointSequence: before.projection.checkpointSequence,checkpointedAt: before.projection.checkpointedAt,
        canonicalHash: before.projection.canonicalHash,serializedHash: before.projection.serializedHash,finalized: before.projection.finalized },
      diagnostics: { degraded: before.diagnostics.degraded,projectionError: before.diagnostics.projectionError } },
    after: { identity: { ...identity,lifecycleGeneration: generation },clock,registryStateVersion: 0,status: 'archived' },
    cas: {
      state: { documentId: bound.documentId,workspaceId: bound.workspaceId,organizationId: bound.organizationId,path: bound.path,
        representation: bound.representation,schemaVersion: bound.schemaVersion,lifecycleGeneration: bound.lifecycleGeneration,...clock,status: 'active' },
      registry: { documentId: bound.documentId,lineageId: bound.lineageId,workspaceId: bound.workspaceId,organizationId: bound.organizationId,
        path: bound.path,provider: 'yjs',stateLifecycle: 'initialized',stateVersion: bound.registryStateVersion,status: 'active' },
      lineage: { lineageId: bound.lineageId,workspaceId: bound.workspaceId,organizationId: bound.organizationId,path: bound.path,status: 'active' },
    },
    writes: { state: { status: 'archived',...reset },
      registry: { status: 'archived',stateVersion: 0,snapshotRevisionId: null,updatedAt: archivedAt },
      lineage: { status: 'archived',archivedAt,trashEntryId: chosen.trashEntryId },
      projection: { documentId: bound.documentId,lifecycleGeneration: generation,projectedSequence: bound.documentSequence,
        finalized: false,revisionId: null,canonicalHash: null,serializedHash: null,updatedAt: archivedAt } },
    projectionDisposition: 'reset_derived_status_for_new_archive_generation' };
  if (!isDeepStrictEqual(receipt,expectedReceipt)) restoreFail('NATIVE_FILE_RESTORE_SOURCE_CHANGED');
  if (!state || state.status !== 'archived' || (['documentId','workspaceId','organizationId','path','representation',
    'schemaVersion','documentSequence','persistedAt'] as const).some(key => state[key] !== bound[key])
    || state.lifecycleGeneration !== generation) restoreFail('NATIVE_FILE_RESTORE_SOURCE_CHANGED');
  if (!(state.yjsState instanceof Uint8Array) || !state.yjsState.byteLength
    || !(state.stateVector instanceof Uint8Array) || !state.stateVector.byteLength) restoreFail('NATIVE_FILE_RESTORE_INVALID');
  if (state.yjsState.byteLength > ARCHIVED_NATIVE_BINARY_LIMIT || state.stateVector.byteLength > 1024*1024) restoreFail('NATIVE_FILE_RESTORE_TOO_LARGE');
  diagnostics(state);
  if (state.newlineStyle !== before.byteProfile.newlineStyle || state.hasBom !== before.byteProfile.hasBom
    || state.checkpointSequence !== 0 || state.checkpointedAt !== null || state.canonicalHash !== null || state.serializedHash !== null
    || state.degraded || state.projectionError !== undefined || state.projectionFinalized !== undefined && state.projectionFinalized !== false
    || hash(state.yjsState) !== bound.binaryHash || hash(state.stateVector) !== bound.vectorHash) restoreFail('NATIVE_FILE_RESTORE_SOURCE_CHANGED');
  const snapshot = inspectArchivedNativeSnapshot(state);
  if (snapshot.version.stateProof !== bound.stateProof) restoreFail('NATIVE_FILE_RESTORE_SOURCE_CHANGED');
  const restoredGeneration = generation+1;
  return freeze({ version: 1,archive: { originalIdentity: identity,trashEntryId: chosen.trashEntryId,archivedAt },
    before: expectedReceipt.after,
    after: { identity: { ...identity,lifecycleGeneration: restoredGeneration },clock,registryStateVersion: 0,status: 'active' },
    byteProfile: { ...before.byteProfile },
    cas: { state: { ...expectedReceipt.cas.state,status: 'archived',lifecycleGeneration: generation },
      registry: { ...expectedReceipt.cas.registry,status: 'archived',stateVersion: 0 },
      lineage: { ...expectedReceipt.cas.lineage,status: 'archived',archivedAt,trashEntryId: chosen.trashEntryId } },
    // This is a new generation, not a checkpoint publication or share revival.
    // Exact original bytes/vector/sequence/time survive; derived status stays unconfirmed.
    writes: { state: { status: 'active',...reset,lifecycleGeneration: restoredGeneration },
      registry: { status: 'active',stateVersion: 0,snapshotRevisionId: null,updatedAt: chosen.restoredAt },
      lineage: { status: 'active',archivedAt: null,trashEntryId: null },
      projection: { ...expectedReceipt.writes.projection,lifecycleGeneration: restoredGeneration,updatedAt: chosen.restoredAt } },
    projectionDisposition: 'reset_derived_status_for_new_restore_generation' });
}
