import 'server-only';

import { types } from 'node:util';
import { getFileDisplayName } from '../files/display-name';
import { DocumentReadError, type DocumentCreateMutationResultV1, type DocumentRepresentationV1 } from './contracts';
import { documentMetadataVersionV1, documentVersionV1, type DocumentVersionIdentityV1 } from './read-version';

/** Observed facts only. Null metadata revision means the actual row was absent;
 * a present row with a null title retains its real non-null revision. */
export type DocumentCreateMutationFactsV1 = DocumentVersionIdentityV1 & Readonly<{
  operationId: string;
  outcome: 'created' | 'already_created';
  fullStateProof: string;
  path: string;
  metadataTitle: string | null;
  metadataRevision: number | null;
  persistedSequence: number;
  persistedAt: number;
  checkpointSequence: number;
  checkpointedAt: number;
}>;

const keys = ['operationId', 'outcome', 'workspaceId', 'organizationId', 'documentId', 'lineageId',
  'lifecycleGeneration', 'representation', 'schemaVersion', 'fullStateProof', 'path', 'metadataTitle',
  'metadataRevision', 'persistedSequence', 'persistedAt', 'checkpointSequence', 'checkpointedAt'] as const;
type Key = typeof keys[number];
function invalid(): never { throw new DocumentReadError('INVALID_REQUEST'); }
function ownFacts(value: unknown): Record<Key, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const properties = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(properties);
  if (names.length !== keys.length || names.some(name => typeof name !== 'string' || !keys.includes(name as Key))) return invalid();
  const result = {} as Record<Key, unknown>;
  for (const key of keys) {
    const descriptor = properties[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return invalid();
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || Buffer.from(value, 'utf8').toString('utf8') !== value) return invalid();
  return value;
}
function identifier(value: unknown): string {
  const selected = text(value, 256);
  if (!selected || selected !== selected.trim() || /[\u0000-\u001f\u007f]/u.test(selected)) return invalid();
  return selected;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalid();
  return value;
}
function representation(value: unknown): DocumentRepresentationV1 {
  if (value !== 'plain_text' && value !== 'tiptap_xml' && value !== 'tiptap_blocks') return invalid();
  return value;
}

/** Pure projection of already-confirmed facts. No IO, authority, transaction,
 * source body, synthetic metadata or durable-outcome assertion is created here. */
export function encodeDocumentCreateMutationResultV1(value: unknown): DocumentCreateMutationResultV1 {
  const facts = ownFacts(value), operationId = identifier(facts.operationId), outcome = facts.outcome;
  if (outcome !== 'created' && outcome !== 'already_created') return invalid();
  const identity: DocumentVersionIdentityV1 = {
    workspaceId: identifier(facts.workspaceId), organizationId: facts.organizationId === null ? null : identifier(facts.organizationId),
    documentId: identifier(facts.documentId), lineageId: identifier(facts.lineageId),
    lifecycleGeneration: integer(facts.lifecycleGeneration, 1), representation: representation(facts.representation),
    schemaVersion: integer(facts.schemaVersion, 1),
  };
  const fullStateProof = text(facts.fullStateProof, 128), filePath = text(facts.path, 4096);
  const metadataTitle = facts.metadataTitle === null ? null : text(facts.metadataTitle, 4096);
  const metadataRevision = facts.metadataRevision === null ? null : integer(facts.metadataRevision);
  if (metadataRevision === null && metadataTitle !== null) return invalid();
  const persistedSequence = integer(facts.persistedSequence), persistedAt = integer(facts.persistedAt);
  const checkpointSequence = integer(facts.checkpointSequence), checkpointedAt = integer(facts.checkpointedAt);
  if (checkpointSequence !== persistedSequence) return invalid();
  const title = metadataTitle ?? getFileDisplayName({ name: filePath.split('/').at(-1)!, type: 'file' });
  const version = documentVersionV1(identity, fullStateProof);
  const metadataVersion = documentMetadataVersionV1(identity, { path: filePath, title, metadataRevision });
  return Object.freeze({ apiVersion: 1, operationId, outcome,
    document: Object.freeze({ kind: 'native_document', ...identity, path: filePath, title, version, metadataVersion }),
    currency: Object.freeze({ source: 'persisted_yjs', observedVersion: version, observedDurable: true,
      durableVersion: version, durableSequence: persistedSequence, persistedAt }),
    projection: Object.freeze({ checkpointSequence, checkpointedAt, status: 'current' }),
  });
}
