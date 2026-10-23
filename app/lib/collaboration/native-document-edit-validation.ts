import 'server-only';

import { types } from 'node:util';
import type * as YTypes from 'yjs';
import { DocumentEditError } from '../documents/edit-contracts';
import { isDocumentVersionTokenV1 } from '../documents/contracts';
import { documentVersionV1, type DocumentVersionIdentityV1 } from '../documents/read-version';
import type { AgentApplyConflict } from './agent-operations';
import { inspectNativeDocument } from './document-snapshot';
import { assertNativeDocumentSchema } from './native-document-schema';
import { getNativeInspectionSchema } from './native-inspection-schema';
import { assertNativeDocumentWithinReadBudget, type NativeDocumentReadBudget } from './native-search-budget';
import { collaborationStateProof } from './state-proof';
import { Y } from './server-runtime';
import { COLLABORATION_SCHEMA_VERSION, type TextCollaborationRepresentation } from './types';

type ConflictCode = AgentApplyConflict['code'];

// These synchronous clone/comparison helpers share mechanics with preparation.
// They grant no authority and contain no writer or operation runtime dependency.
const identityKeys = ['workspaceId', 'organizationId', 'documentId', 'lineageId',
  'lifecycleGeneration', 'representation', 'schemaVersion'] as const;

/** Fixed internal admission, never caller-adjustable or a durability promise. */
export const nativeBudget: NativeDocumentReadBudget = Object.freeze({
  maxStateBytes: 64 * 1024 * 1024, maxVectorBytes: 1024 * 1024,
  maxClients: 262_144, maxStructs: 262_144, maxNodes: 262_144,
  maxDepth: 64, maxStringBytes: 5 * 1024 * 1024, maxBinaryBytes: 64 * 1024 * 1024,
});

export function fail(code: ConstructorParameters<typeof DocumentEditError>[0]): never {
  throw new DocumentEditError(code);
}

export function ownCode(error: unknown): unknown {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
}

export function validString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

export function captureIdentity(value: DocumentVersionIdentityV1): Readonly<DocumentVersionIdentityV1> {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_REQUEST');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== identityKeys.length
    || keys.some(key => typeof key !== 'string' || !identityKeys.includes(key as typeof identityKeys[number]))) fail('INVALID_REQUEST');
  const values: Record<string, unknown> = {};
  for (const key of identityKeys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('INVALID_REQUEST');
    values[key] = descriptor.value as unknown;
  }
  for (const key of ['workspaceId', 'documentId', 'lineageId'] as const) {
    if (!validString(values[key], 256)) fail('INVALID_REQUEST');
  }
  if (values.organizationId !== null && !validString(values.organizationId, 256)
    || typeof values.lifecycleGeneration !== 'number' || !Number.isSafeInteger(values.lifecycleGeneration) || values.lifecycleGeneration < 1
    || typeof values.schemaVersion !== 'number' || !Number.isSafeInteger(values.schemaVersion) || values.schemaVersion < 1
    || typeof values.representation !== 'string'
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(values.representation)) fail('INVALID_REQUEST');
  return Object.freeze({ workspaceId: values.workspaceId as string,
    organizationId: values.organizationId as string | null, documentId: values.documentId as string,
    lineageId: values.lineageId as string, lifecycleGeneration: values.lifecycleGeneration,
    representation: values.representation as TextCollaborationRepresentation, schemaVersion: values.schemaVersion });
}

/** Native schema/content admission only. It neither exports Markdown nor certifies persistence. */
export function validateNativeDocumentEditCandidate(doc: YTypes.Doc,
  representation: TextCollaborationRepresentation): ConflictCode | null {
  try {
    if (!['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(representation)) return 'schema_invalid';
    assertNativeDocumentWithinReadBudget(doc, nativeBudget);
    if (Y.encodeStateVector(doc).byteLength > nativeBudget.maxVectorBytes
      || Y.encodeStateAsUpdate(doc).byteLength > nativeBudget.maxStateBytes) return 'limit_exceeded';
    assertNativeDocumentSchema(doc, representation, getNativeInspectionSchema());
    inspectNativeDocument(doc, representation);
    return null;
  } catch (error) {
    return ownCode(error) === 'DOCUMENT_TOO_LARGE' ? 'limit_exceeded' : 'schema_invalid';
  }
}

export function assertCandidate(doc: YTypes.Doc, representation: TextCollaborationRepresentation): void {
  const invalid = validateNativeDocumentEditCandidate(doc, representation);
  if (invalid) fail(invalid === 'limit_exceeded' ? 'DOCUMENT_TOO_LARGE' : 'DOCUMENT_STATE_INVALID');
}

export function assertVersion(doc: YTypes.Doc, identity: Readonly<DocumentVersionIdentityV1>, expectedVersion: string): {
  stateProof: string; version: string;
} {
  const stateProof = collaborationStateProof(doc, Y);
  if (!stateProof) fail('DOCUMENT_STATE_INVALID');
  const version = documentVersionV1(identity, stateProof);
  if (version !== expectedVersion) fail('DOCUMENT_VERSION_CONFLICT');
  if (identity.schemaVersion !== COLLABORATION_SCHEMA_VERSION) fail('DOCUMENT_EDIT_UNSUPPORTED');
  assertCandidate(doc, identity.representation);
  return { stateProof, version };
}

/** Capture/inspect exclusively on an owned gc:false clone. Even empty root-type
 * materialization and native schema hydration stay off the source document. */
export function withSourceClone<T>(source: YTypes.Doc, operation: (clone: YTypes.Doc, before: Uint8Array) => T): T {
  try { assertNativeDocumentWithinReadBudget(source, nativeBudget); }
  catch (error) { fail(ownCode(error) === 'DOCUMENT_TOO_LARGE' ? 'DOCUMENT_TOO_LARGE' : 'DOCUMENT_STATE_INVALID'); }
  const before = Y.encodeStateAsUpdate(source);
  if (before.byteLength > nativeBudget.maxStateBytes
    || Y.encodeStateVector(source).byteLength > nativeBudget.maxVectorBytes) fail('DOCUMENT_TOO_LARGE');
  const clone = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(clone, before);
    // Actual source awareness is only read by the existing IME preflight. No
    // source callback/state is forged and the writers only mutate our clone.
    const awareness = (source as YTypes.Doc & { awareness?: unknown }).awareness;
    if (awareness !== undefined) Object.defineProperty(clone, 'awareness', { value: awareness });
    return operation(clone, before);
  } finally { clone.destroy(); }
}

/** Identity/version comparison only; caller retains all real owner/authority fences. */
export function assertNativeDocumentEditPrecondition(input: {
  doc: YTypes.Doc; identity: DocumentVersionIdentityV1; expectedVersion: string;
}): void {
  const identity = captureIdentity(input.identity);
  if (!isDocumentVersionTokenV1(input.expectedVersion)) fail('INVALID_REQUEST');
  withSourceClone(input.doc, clone => { assertVersion(clone, identity, input.expectedVersion); });
}
