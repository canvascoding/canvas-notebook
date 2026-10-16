import { createHash } from 'node:crypto';
import { getSchema } from '@tiptap/core';
import { ARCHIVED_NATIVE_BINARY_LIMIT } from './archived-native-snapshot';
import { inspectPersistedNativeCollaborationSnapshot } from './document-snapshot';
import { richMarkdownSchemaExtensions } from './markdown-state';
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
    assertNativeDocumentSchema(doc,state.representation,getSchema(richMarkdownSchemaExtensions()));
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
