import type { TextCollaborationRepresentation } from '../collaboration/types';

export const MIN_DOCUMENT_READ_PAGE_BYTES = 4;
export const DEFAULT_DOCUMENT_READ_PAGE_BYTES = 64 * 1024;
export const MAX_DOCUMENT_READ_PAGE_BYTES = 256 * 1024;

export type DocumentRepresentationV1 = TextCollaborationRepresentation;
export type DocumentReadFormatV1 = 'native' | 'text' | 'markdown';

/** Identity and comparison evidence only. This DTO never grants access. */
export type NativeDocumentRefV1 = Readonly<{
  kind: 'native_document';
  workspaceId: string;
  organizationId: string | null;
  documentId: string;
  lineageId: string;
  lifecycleGeneration: number;
  representation: DocumentRepresentationV1;
  schemaVersion: number;
  path: string;
  title: string;
  /** Full native content identity; independent of path and title. */
  version: string;
  metadataVersion: string;
}>;

export type DocumentCurrencyV1 = Readonly<{
  source: 'persisted_yjs' | 'live_yjs';
  observedVersion: string;
  observedDurable: boolean;
  durableVersion: string;
  durableSequence: number;
  persistedAt: number;
}>;

export type DocumentProjectionV1 = Readonly<{
  checkpointSequence: number;
  checkpointedAt: number | null;
  status: 'current' | 'pending' | 'unavailable';
  errorCode?: string;
}>;

/** Confirmed native creation comparison data only. The caller publishes this
 * only after its real COMMIT/recovery and connection cleanup have completed. */
export type DocumentCreateMutationResultV1 = Readonly<{
  apiVersion: 1;
  operationId: string;
  outcome: 'created' | 'already_created';
  document: NativeDocumentRefV1;
  currency: DocumentCurrencyV1;
  projection: DocumentProjectionV1;
}>;

export type DocumentReadRequestV1 = Readonly<{
  apiVersion: 1;
  workspaceId: string;
  documentId: string;
  format?: DocumentReadFormatV1;
  expectedVersion?: string;
  maxBytes?: number;
  /** Opaque continuation evidence; callers still need current authorization. */
  cursor?: string;
}>;

export type DecodedDocumentReadRequestV1 = Readonly<{
  apiVersion: 1;
  workspaceId: string;
  documentId: string;
  format: DocumentReadFormatV1;
  expectedVersion?: string;
  maxBytes: number;
  cursor?: string;
}>;

export type DocumentReadPageV1 = Readonly<{
  apiVersion: 1;
  document: NativeDocumentRefV1;
  currency: DocumentCurrencyV1;
  projection: DocumentProjectionV1;
  format: DocumentReadFormatV1;
  mediaType: 'application/vnd.canvas.native-document+json' | 'text/plain' | 'text/markdown';
  encoding: 'utf-8';
  /** Native JSON can span pages. Parse its fully concatenated byte stream. */
  fragment: string;
  byteOffset: number;
  byteLength: number;
  totalBytes: number;
  nextCursor: string | null;
  complete: boolean;
}>;

const errorStatuses = {
  INVALID_REQUEST: 400,
  AUTHENTICATION_REQUIRED: 401,
  ACCESS_DENIED: 403,
  DOCUMENT_NOT_FOUND: 404,
  DOCUMENT_SCOPE_CHANGED: 409,
  DOCUMENT_VERSION_CONFLICT: 409,
  DOCUMENT_STATE_MISSING: 409,
  DOCUMENT_STATE_INVALID: 409,
  DOCUMENT_QUARANTINED: 409,
  DOCUMENT_BUSY: 409,
  DOCUMENT_FORMAT_UNAVAILABLE: 422,
  DOCUMENT_TOO_LARGE: 413,
  READ_OUTCOME_UNCONFIRMED: 503,
  DOCUMENT_READ_UNAVAILABLE: 503,
} as const;

export type DocumentReadErrorCodeV1 = keyof typeof errorStatuses;
export type DocumentReadErrorV1 = Readonly<{
  apiVersion: 1;
  success: false;
  code: DocumentReadErrorCodeV1;
}>;

/** Public error code only; private state, credentials and SQL stay internal. */
export class DocumentReadError extends Error {
  readonly status: number;
  constructor(readonly code: DocumentReadErrorCodeV1) {
    super(code);
    this.name = 'DocumentReadError';
    this.status = errorStatuses[code];
  }
}

export function isDocumentVersionTokenV1(value: unknown): value is string {
  return typeof value === 'string' && /^canvas-document-v1:[a-f0-9]{64}$/u.test(value);
}

const requestKeys = new Set(['apiVersion', 'workspaceId', 'documentId', 'format', 'expectedVersion', 'maxBytes', 'cursor']);

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Reads descriptors before values so rejected getters are never evaluated. */
export function decodeDocumentReadRequestV1(value: unknown): DecodedDocumentReadRequestV1 {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new DocumentReadError('INVALID_REQUEST');
  }
  const properties = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(properties)) {
    if (typeof key !== 'string' || !requestKeys.has(key)) throw new DocumentReadError('INVALID_REQUEST');
    const descriptor = properties[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new DocumentReadError('INVALID_REQUEST');
    }
  }
  const own = (key: string): PropertyDescriptor | undefined => Object.prototype.hasOwnProperty.call(properties, key)
    ? properties[key] : undefined;
  const apiVersion: unknown = own('apiVersion')?.value;
  const workspaceId: unknown = own('workspaceId')?.value;
  const documentId: unknown = own('documentId')?.value;
  const format: unknown = own('format') ? own('format')!.value : 'native';
  const maxBytes: unknown = own('maxBytes') ? own('maxBytes')!.value : DEFAULT_DOCUMENT_READ_PAGE_BYTES;
  const expectedVersion: unknown = own('expectedVersion')?.value;
  const cursor: unknown = own('cursor')?.value;
  if (apiVersion !== 1 || !validId(workspaceId) || !validId(documentId)
    || format !== 'native' && format !== 'text' && format !== 'markdown'
    || typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes)
    || maxBytes < MIN_DOCUMENT_READ_PAGE_BYTES || maxBytes > MAX_DOCUMENT_READ_PAGE_BYTES
    || own('expectedVersion') && !isDocumentVersionTokenV1(expectedVersion)
    || own('cursor') && (typeof cursor !== 'string' || !cursor || cursor.length > 4096
      || cursor !== cursor.trim() || /[\u0000-\u001f\u007f]/u.test(cursor))) {
    throw new DocumentReadError('INVALID_REQUEST');
  }
  return Object.freeze({ apiVersion: 1, workspaceId, documentId, format, maxBytes,
    ...(own('expectedVersion') ? { expectedVersion: expectedVersion as string } : {}),
    ...(own('cursor') ? { cursor: cursor as string } : {}) });
}
