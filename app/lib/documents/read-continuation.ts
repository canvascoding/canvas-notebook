import 'server-only';

import { DocumentReadError, isDocumentVersionTokenV1, type DocumentReadFormatV1 } from './contracts';
import { MAX_DOCUMENT_READ_BODY_BYTES } from './read-body';

export type DocumentReadContinuationBindingV1 = Readonly<{
  /** Genuine current origin/realm/workspace binding, stable across requests.
   * This hash must not contain a particular request's backend PID or TX. */
  authorityScopeSha256: string;
  identitySha256: string;
  lifecycleGeneration: number;
  contentVersion: string;
  metadataVersion: string;
  format: DocumentReadFormatV1;
  totalBytes: number;
  bodySha256: string;
}>;

type Envelope = DocumentReadContinuationBindingV1 & Readonly<{
  cursorVersion: 1;
  purpose: 'canvas.document.read.v1';
  byteOffset: number;
}>;
const bindingKeys = ['authorityScopeSha256', 'identitySha256', 'lifecycleGeneration', 'contentVersion',
  'metadataVersion', 'format', 'totalBytes', 'bodySha256'] as const;
const envelopeKeys = ['cursorVersion', 'purpose', ...bindingKeys, 'byteOffset'] as const;
const MAX_CURSOR_CHARACTERS = 4096;
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

function invalid(): never { throw new DocumentReadError('INVALID_REQUEST'); }

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const properties = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(properties);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = properties[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid();
    result[key] = descriptor.value as unknown;
  }
  return result;
}

function bindingFrom(values: Record<string, unknown>): DocumentReadContinuationBindingV1 {
  if (!sha256(values.authorityScopeSha256) || !sha256(values.identitySha256) || !sha256(values.bodySha256)
    || typeof values.lifecycleGeneration !== 'number' || !Number.isSafeInteger(values.lifecycleGeneration)
    || values.lifecycleGeneration < 1 || !isDocumentVersionTokenV1(values.contentVersion)
    || typeof values.metadataVersion !== 'string' || !/^canvas-document-metadata-v1:[a-f0-9]{64}$/u.test(values.metadataVersion)
    || values.format !== 'native' && values.format !== 'text' && values.format !== 'markdown'
    || typeof values.totalBytes !== 'number' || !Number.isSafeInteger(values.totalBytes)
    || values.totalBytes < 0 || values.totalBytes > MAX_DOCUMENT_READ_BODY_BYTES) invalid();
  return Object.freeze({ authorityScopeSha256: values.authorityScopeSha256, identitySha256: values.identitySha256,
    lifecycleGeneration: values.lifecycleGeneration, contentVersion: values.contentVersion,
    metadataVersion: values.metadataVersion, format: values.format, totalBytes: values.totalBytes,
    bodySha256: values.bodySha256 });
}

function envelope(binding: DocumentReadContinuationBindingV1, byteOffset: unknown): Envelope {
  if (typeof byteOffset !== 'number' || !Number.isSafeInteger(byteOffset) || byteOffset <= 0
    || byteOffset >= binding.totalBytes) invalid();
  return Object.freeze({ cursorVersion: 1, purpose: 'canvas.document.read.v1', ...binding, byteOffset });
}

/** Comparison evidence only, without a signature or grant. Each page requires
 * fresh genuine authorization and a current native observation in the service. */
export function encodeDocumentReadContinuationV1(binding: DocumentReadContinuationBindingV1, byteOffset: number): string {
  const current = bindingFrom(ownData(binding, bindingKeys));
  const cursor = Buffer.from(JSON.stringify(envelope(current, byteOffset)), 'utf8').toString('base64url');
  if (cursor.length > MAX_CURSOR_CHARACTERS) invalid();
  return cursor;
}

/** Return the next comparison-bound byte offset, never an authorization result.
 * The UTF-8 page helper additionally checks the actual codepoint boundary. */
export function decodeDocumentReadContinuationV1(cursor: string, binding: DocumentReadContinuationBindingV1): number {
  const current = bindingFrom(ownData(binding, bindingKeys));
  if (typeof cursor !== 'string' || !cursor || cursor.length > MAX_CURSOR_CHARACTERS || !/^[A-Za-z0-9_-]+$/u.test(cursor)) invalid();
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) invalid();
  let serialized: string;
  let parsed: unknown;
  try {
    serialized = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    parsed = JSON.parse(serialized);
  } catch { return invalid(); }
  const values = ownData(parsed, envelopeKeys);
  if (values.cursorVersion !== 1 || values.purpose !== 'canvas.document.read.v1') invalid();
  const captured = bindingFrom(values);
  const original = envelope(captured, values.byteOffset);
  if (JSON.stringify(original) !== serialized) invalid();
  if (captured.authorityScopeSha256 !== current.authorityScopeSha256 || captured.identitySha256 !== current.identitySha256
    || captured.lifecycleGeneration !== current.lifecycleGeneration) throw new DocumentReadError('DOCUMENT_SCOPE_CHANGED');
  if (captured.contentVersion !== current.contentVersion || captured.metadataVersion !== current.metadataVersion
    || captured.format !== current.format || captured.totalBytes !== current.totalBytes || captured.bodySha256 !== current.bodySha256) {
    throw new DocumentReadError('DOCUMENT_VERSION_CONFLICT');
  }
  return original.byteOffset;
}
