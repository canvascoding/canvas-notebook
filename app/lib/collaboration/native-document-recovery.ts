import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { getSchema, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import type * as YTypes from 'yjs';
import { BLOCK_TREE_KEY, CollaborationBlockTree } from './block-tree';
import { inspectPersistedNativeCollaborationSnapshot } from './document-snapshot';
import { createPlainTextYDoc, richMarkdownSchemaExtensions } from './markdown-state';
import type { PersistedCollaborationState } from './persistence';
import { TiptapTransformer, Y, YProsemirror } from './server-runtime';
import { readRichDocumentJson } from './rich-document';
import { isCanonicalAdmissionPath } from './room-admission-contract';

const MAGIC = Buffer.from('CNATIVE2');
export const NATIVE_RECOVERY_PAYLOAD_LIMIT = 128 * 1024 * 1024;
const HEADER_LIMIT = 8 * 1024 * 1024;
const DOCUMENT_LIMIT = 10_000;
const HASH = /^[a-f0-9]{64}$/u;

export type NativeRecoveryRecord = {
  lineageId: string;
  state: PersistedCollaborationState;
};
type RecoveryMetadata = Omit<PersistedCollaborationState, 'yjsState' | 'stateVector'> & {
  lineageId: string; stateProof: string; updateBytes: number; vectorBytes: number; updateSha256: string; vectorSha256: string;
};

export class NativeDocumentRecoveryError extends Error {
  readonly code = 'NATIVE_DOCUMENT_RECOVERY_UNAVAILABLE';
  readonly status = 409;
  constructor() { super('The native document recovery payload is invalid, unsupported, or incomplete.'); }
}
function reject(): never { throw new NativeDocumentRecoveryError(); }
function hash(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function validateRecoveryIdentity(state: PersistedCollaborationState, lineageId: string): void {
  if (!validIdentity(lineageId) || !validIdentity(state.documentId) || !validIdentity(state.workspaceId)
    || state.organizationId !== null && !validIdentity(state.organizationId) || !isCanonicalAdmissionPath(state.path)
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(state.representation)
    || !['lf', 'crlf'].includes(state.newlineStyle) || typeof state.hasBom !== 'boolean' || typeof state.degraded !== 'boolean'
    || state.projectionFinalized !== undefined && typeof state.projectionFinalized !== 'boolean'
    || state.canonicalHash !== null && (typeof state.canonicalHash !== 'string' || !HASH.test(state.canonicalHash))
    || state.serializedHash !== null && (typeof state.serializedHash !== 'string' || !HASH.test(state.serializedHash))
    || state.checkpointedAt !== null && (!Number.isFinite(state.checkpointedAt) || state.checkpointedAt < 0)
    || !Number.isFinite(state.persistedAt) || state.persistedAt < 0) reject();
  if (state.projectionError !== undefined) {
    const error = state.projectionError;
    assertKnownKeys(error, ['code', 'sequence', 'permanent', 'phase']);
    if (typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
      || !Number.isSafeInteger(error.sequence) || error.sequence < 0 || error.sequence > state.documentSequence
      || typeof error.permanent !== 'boolean'
      || error.phase !== undefined && (typeof error.phase !== 'string' || error.phase.length > 128)) reject();
  }
}

/** Private binary payload. Metadata, vectors, and native bytes must never enter public responses. */
export function serializeNativeRecoveryPayload(records: readonly NativeRecoveryRecord[]): Buffer {
  if (records.length > DOCUMENT_LIMIT) reject();
  const identities = new Set<string>();
  const lineages = new Set<string>();
  const scopes = new Set<string>();
  let binarySize = 0;
  for (const record of records) {
    if (!(record.state.yjsState instanceof Uint8Array) || !(record.state.stateVector instanceof Uint8Array)) reject();
    binarySize += record.state.yjsState.byteLength + record.state.stateVector.byteLength;
    if (binarySize > NATIVE_RECOVERY_PAYLOAD_LIMIT) reject();
  }
  const chunks: Buffer[] = [];
  const metadata = records.map(({ lineageId, state }): RecoveryMetadata => {
    validateRecoveryIdentity(state, lineageId);
    const scope = JSON.stringify([state.workspaceId, state.organizationId, state.path]);
    if (identities.has(state.documentId) || lineages.has(lineageId) || scopes.has(scope)) reject();
    identities.add(state.documentId);
    lineages.add(lineageId); scopes.add(scope);
    const { yjsState, stateVector, ...identity } = state;
    const stateProof = inspectPersistedNativeCollaborationSnapshot(state, (_doc, snapshot) => snapshot.version.stateProof);
    chunks.push(Buffer.from(yjsState.buffer, yjsState.byteOffset, yjsState.byteLength),
      Buffer.from(stateVector.buffer, stateVector.byteOffset, stateVector.byteLength));
    return { ...identity, lineageId, stateProof, updateBytes: yjsState.byteLength, vectorBytes: stateVector.byteLength,
      updateSha256: hash(yjsState), vectorSha256: hash(stateVector) };
  });
  const header = Buffer.from(JSON.stringify({ version: 2, records: metadata }));
  const total = MAGIC.length + 4 + header.length + chunks.reduce((size, chunk) => size + chunk.length, 0);
  if (header.length > HEADER_LIMIT || total > NATIVE_RECOVERY_PAYLOAD_LIMIT) reject();
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  return Buffer.concat([MAGIC, length, header, ...chunks], total);
}

/** Verifies the complete container, every binary, native identity, vector, and deletion-sensitive proof. */
export function deserializeNativeRecoveryPayload(payload: Uint8Array): NativeRecoveryRecord[] {
  try {
    if (payload.byteLength > NATIVE_RECOVERY_PAYLOAD_LIMIT) reject();
    const buffer = Buffer.from(payload);
    if (buffer.length > NATIVE_RECOVERY_PAYLOAD_LIMIT || buffer.length < MAGIC.length + 4
      || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) reject();
    const size = buffer.readUInt32BE(MAGIC.length);
    let offset = MAGIC.length + 4 + size;
    if (size > HEADER_LIMIT || offset > buffer.length) reject();
    const header = JSON.parse(buffer.subarray(MAGIC.length + 4, offset).toString('utf8')) as {
      version?: unknown; records?: RecoveryMetadata[];
    };
    if (header.version !== 2 || !Array.isArray(header.records) || header.records.length > DOCUMENT_LIMIT) reject();
    assertKnownKeys(header, ['version', 'records']);
    const identities = new Set<string>();
    const lineages = new Set<string>();
    const scopes = new Set<string>();
    const records = header.records.map((entry): NativeRecoveryRecord => {
      if (!entry || typeof entry !== 'object' || typeof entry.lineageId !== 'string' || !entry.lineageId
        || !Number.isSafeInteger(entry.updateBytes) || entry.updateBytes < 1
        || !Number.isSafeInteger(entry.vectorBytes) || entry.vectorBytes < 1
        || !HASH.test(entry.updateSha256) || !HASH.test(entry.vectorSha256)
        || identities.has(entry.documentId)) reject();
      assertKnownKeys(entry as unknown as Record<string, unknown>, ['documentId', 'workspaceId', 'organizationId', 'path',
        'representation', 'lifecycleGeneration', 'schemaVersion', 'documentSequence', 'persistedAt', 'checkpointedAt',
        'checkpointSequence', 'canonicalHash', 'serializedHash', 'newlineStyle', 'hasBom', 'degraded', 'status',
        'projectionError', 'projectionFinalized', 'lineageId', 'stateProof', 'updateBytes', 'vectorBytes', 'updateSha256', 'vectorSha256']);
      identities.add(entry.documentId);
      const updateEnd = offset + entry.updateBytes;
      const vectorEnd = updateEnd + entry.vectorBytes;
      if (vectorEnd > buffer.length) reject();
      const yjsState = new Uint8Array(buffer.subarray(offset, updateEnd));
      const stateVector = new Uint8Array(buffer.subarray(updateEnd, vectorEnd));
      offset = vectorEnd;
      if (hash(yjsState) !== entry.updateSha256 || hash(stateVector) !== entry.vectorSha256) reject();
      const { lineageId, stateProof, updateBytes: _updateBytes, vectorBytes: _vectorBytes,
        updateSha256: _updateHash, vectorSha256: _vectorHash, ...identity } = entry;
      if (!['lf', 'crlf'].includes(identity.newlineStyle) || typeof identity.hasBom !== 'boolean'
        || typeof identity.degraded !== 'boolean'
        || identity.canonicalHash !== null && !HASH.test(identity.canonicalHash)
        || identity.serializedHash !== null && !HASH.test(identity.serializedHash)
        || identity.checkpointedAt !== null && !Number.isFinite(identity.checkpointedAt)) reject();
      const state: PersistedCollaborationState = { ...identity, yjsState, stateVector };
      validateRecoveryIdentity(state, lineageId);
      const scope = JSON.stringify([state.workspaceId, state.organizationId, state.path]);
      if (lineages.has(lineageId) || scopes.has(scope)) reject();
      lineages.add(lineageId); scopes.add(scope);
      if (inspectPersistedNativeCollaborationSnapshot(state, (_doc, snapshot) => snapshot.version.stateProof) !== stateProof) reject();
      return { lineageId, state };
    });
    if (offset !== buffer.length) reject();
    return records;
  } catch { return reject(); }
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) reject();
}
function assertKnownRichJson(node: JSONContent, schema: Schema): void {
  assertKnownKeys(node as Record<string, unknown>, ['type', 'attrs', 'content', 'marks', 'text']);
  const type = node.type && schema.nodes[node.type];
  if (!type) reject();
  if (node.attrs) assertKnownKeys(node.attrs, Object.keys(type.spec.attrs ?? {}));
  for (const mark of node.marks ?? []) {
    assertKnownKeys(mark as Record<string, unknown>, ['type', 'attrs']);
    const markType = schema.marks[mark.type];
    if (!markType) reject();
    if (mark.attrs) assertKnownKeys(mark.attrs, Object.keys(markType.spec.attrs ?? {}));
  }
  for (const child of node.content ?? []) {
    // y-prosemirror groups text-only fragment content in one array.
    if (Array.isArray(child)) {
      for (const inline of child) assertKnownRichJson(inline, schema);
    } else assertKnownRichJson(child, schema);
  }
}

/** PM decoding fills defaults and may drop unknown attrs. Refuse that loss before creating a fresh document. */
function assertCloneSupportsRawDocument(doc: YTypes.Doc, representation: PersistedCollaborationState['representation'], schema: Schema): void {
  const rootKeys = representation === 'plain_text' ? ['content']
    : [representation === 'tiptap_blocks' ? BLOCK_TREE_KEY : 'body', 'frontmatter', 'bodyFinalLineEnding'];
  if ([...doc.share.keys()].some(key => !rootKeys.includes(key))) reject();
  if (representation === 'plain_text') return;
  if (representation === 'tiptap_xml') {
    assertKnownRichJson(YProsemirror.yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('body')), schema);
    return;
  }
  const tree = new CollaborationBlockTree(doc, schema);
  assertKnownKeys(Object.fromEntries(tree.root.entries()), ['version', 'records', 'operations', 'receipts']);
  for (const record of tree.records.values()) {
    assertKnownKeys(Object.fromEntries(record.entries()), ['initial', 'shape', 'attributes', 'content']);
    const shape = record.get('shape') as { type: string; inline: boolean };
    assertKnownKeys(shape, ['type', 'inline']);
    const type = schema.nodes[shape.type];
    if (!type) reject();
    assertKnownKeys((record.get('attributes') as YTypes.Map<unknown>).toJSON(), Object.keys(type.spec.attrs ?? {}));
    const initial = record.get('initial') as Record<string, unknown>;
    assertKnownKeys(initial, ['id', 'parentId', 'order']);
    assertKnownRichJson(YProsemirror.yXmlFragmentToProsemirrorJSON(record.get('content') as YTypes.XmlFragment), schema);
  }
  for (const operation of [...tree.operations.values(), ...tree.receipts.values()]) {
    assertKnownKeys(operation, ['id', 'clock', 'actor', 'transactionId', 'ordinal', 'kind', 'blockId', 'parentId', 'beforeId', 'blockIds']);
  }
}

export type NativeDocumentClone = {
  doc: YTypes.Doc;
  blockIdMapping: Record<string, string>;
};

/** Semantic independent clone: keeps every supported native attribute and creates fresh CRDT/block identities. */
export function cloneNativeCollaborationDocument(state: PersistedCollaborationState): NativeDocumentClone {
  return inspectPersistedNativeCollaborationSnapshot(state, (source, snapshot) => {
    const schema = getSchema(richMarkdownSchemaExtensions());
    assertCloneSupportsRawDocument(source, state.representation, schema);
    const blockIdMapping: Record<string, string> = Object.create(null);
    if (snapshot.content.kind === 'plain_text') {
      const doc = createPlainTextYDoc(snapshot.content.text);
      if ([...doc.store.clients.keys()].some(clientId => source.store.clients.has(clientId))) { doc.destroy(); reject(); }
      return { doc, blockIdMapping };
    }
    const json = structuredClone(snapshot.content.document);
    const remap = (node: JSONContent) => {
      if (node.type !== 'doc' && node.type !== 'text') {
        const id = node.attrs?.id;
        if (typeof id !== 'string' || !id || blockIdMapping[id]) reject();
        const replacement = randomUUID(); blockIdMapping[id] = replacement;
        node.attrs = { ...node.attrs, id: replacement };
      }
      for (const child of node.content ?? []) remap(child);
    };
    remap(json);
    let doc: YTypes.Doc | undefined;
    try {
      if (state.representation === 'tiptap_xml') doc = TiptapTransformer.toYdoc(json, 'body', richMarkdownSchemaExtensions());
      else { doc = new Y.Doc(); CollaborationBlockTree.create(doc, schema.nodeFromJSON(json)); }
      if (snapshot.content.frontmatter) doc.getText('frontmatter').insert(0, snapshot.content.frontmatter);
      if (snapshot.content.bodyFinalLineEnding) doc.getText('bodyFinalLineEnding').insert(0, snapshot.content.bodyFinalLineEnding);
      if ([...doc.store.clients.keys()].some(clientId => source.store.clients.has(clientId))
        || JSON.stringify(readRichDocumentJson(doc, schema)) !== JSON.stringify(json)
        || doc.getText('frontmatter').toString() !== snapshot.content.frontmatter
        || doc.getText('bodyFinalLineEnding').toString() !== snapshot.content.bodyFinalLineEnding) reject();
      return { doc, blockIdMapping };
    } catch { doc?.destroy(); return reject(); }
  });
}
