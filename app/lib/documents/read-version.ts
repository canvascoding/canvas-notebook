import 'server-only';

import { createHash } from 'node:crypto';
import { isCollaborationStateProof } from '../collaboration/state-proof';
import { isCanonicalWorkspacePath } from '../workspaces/path-identity';
import { DocumentReadError, type DocumentRepresentationV1 } from './contracts';

export type DocumentVersionIdentityV1 = Readonly<{
  workspaceId: string;
  organizationId: string | null;
  documentId: string;
  lineageId: string;
  lifecycleGeneration: number;
  representation: DocumentRepresentationV1;
  schemaVersion: number;
}>;

export type DocumentMetadataIdentityV1 = Readonly<{
  path: string;
  title: string;
  /** Null means no shared metadata row; never infer a revision from disk. */
  metadataRevision: number | null;
}>;

const identityKeys = ['workspaceId', 'organizationId', 'documentId', 'lineageId',
  'lifecycleGeneration', 'representation', 'schemaVersion'] as const;
const metadataKeys = ['path', 'title', 'metadataRevision'] as const;

function ownValues(value: unknown, keys: readonly string[]): unknown[] {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new DocumentReadError('INVALID_REQUEST');
  }
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(properties).length !== keys.length
    || Reflect.ownKeys(properties).some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new DocumentReadError('INVALID_REQUEST');
  }
  return keys.map(key => {
    const descriptor = properties[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new DocumentReadError('INVALID_REQUEST');
    }
    return descriptor.value as unknown;
  });
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function identityValues(identity: DocumentVersionIdentityV1): unknown[] {
  const values = ownValues(identity, identityKeys);
  const [workspaceId, organizationId, documentId, lineageId, generation, representation, schemaVersion] = values;
  if (!validId(workspaceId) || organizationId !== null && !validId(organizationId)
    || !validId(documentId) || !validId(lineageId)
    || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1
    || typeof representation !== 'string' || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(representation)
    || typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new DocumentReadError('INVALID_REQUEST');
  }
  return values;
}

function hash(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

/** Includes deletion evidence. This is comparison evidence, never a grant. */
export function documentVersionV1(identity: DocumentVersionIdentityV1, fullStateProof: string): string {
  const values = identityValues(identity);
  if (!isCollaborationStateProof(fullStateProof)) throw new DocumentReadError('INVALID_REQUEST');
  return `canvas-document-v1:${hash(['canvas-document-content', 1, ...values, fullStateProof])}`;
}

/** Location/title changes are separate from the native content version. */
export function documentMetadataVersionV1(identity: DocumentVersionIdentityV1, metadata: DocumentMetadataIdentityV1): string {
  const values = identityValues(identity);
  const [path, title, revision] = ownValues(metadata, metadataKeys);
  if (!isCanonicalWorkspacePath(path) || typeof title !== 'string' || title.length > 4096
    || revision !== null && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)) {
    throw new DocumentReadError('INVALID_REQUEST');
  }
  return `canvas-document-metadata-v1:${hash(['canvas-document-metadata', 1, ...values, path, title, revision])}`;
}
