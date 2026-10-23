import { DEFAULT_DOCUMENT_READ_PAGE_BYTES, DocumentReadError, MAX_DOCUMENT_READ_PAGE_BYTES,
  MIN_DOCUMENT_READ_PAGE_BYTES } from './contracts';

export { DEFAULT_DOCUMENT_READ_PAGE_BYTES, MAX_DOCUMENT_READ_PAGE_BYTES, MIN_DOCUMENT_READ_PAGE_BYTES } from './contracts';

export type DocumentUtf8PageV1 = Readonly<{
  fragment: string;
  byteOffset: number;
  byteLength: number;
  totalBytes: number;
  nextOffset: number | null;
  complete: boolean;
}>;

function continuationByte(byte: number): boolean { return (byte & 0xc0) === 0x80; }

/** Slice stable, caller-captured UTF-8 bytes without splitting codepoints.
 * Offsets have no authorization or version semantics; the service binds them.
 * Allocation/decoding is bounded to this page, never the entire document. */
export function sliceDocumentUtf8PageV1(bytes: Uint8Array, byteOffset = 0,
  maxBytes = DEFAULT_DOCUMENT_READ_PAGE_BYTES): DocumentUtf8PageV1 {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset > bytes.byteLength
    || !Number.isSafeInteger(maxBytes) || maxBytes < MIN_DOCUMENT_READ_PAGE_BYTES || maxBytes > MAX_DOCUMENT_READ_PAGE_BYTES
    || byteOffset < bytes.byteLength && continuationByte(bytes[byteOffset])) throw new DocumentReadError('INVALID_REQUEST');
  let end = Math.min(bytes.byteLength, byteOffset + maxBytes);
  while (end < bytes.byteLength && end > byteOffset && continuationByte(bytes[end])) end--;
  if (end === byteOffset && byteOffset < bytes.byteLength) throw new DocumentReadError('INVALID_REQUEST');
  let fragment: string;
  try {
    fragment = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(byteOffset, end));
  } catch { throw new DocumentReadError('INVALID_REQUEST'); }
  const complete = end === bytes.byteLength;
  return Object.freeze({ fragment, byteOffset, byteLength: end - byteOffset, totalBytes: bytes.byteLength,
    nextOffset: complete ? null : end, complete });
}
