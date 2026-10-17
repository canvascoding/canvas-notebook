import 'server-only';

import { createHash } from 'node:crypto';
import type { NativeDocumentReadObservation } from '../collaboration/native-document-read';
import type { NativeCollaborationContent } from '../collaboration/document-snapshot';
import { getNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import { nativeCollaborationSearchText } from '../collaboration/workspace-search-reader';
import { equivalentRichDocument } from '../markdown/core/equivalence';
import { composeCanvasMarkdownDocument } from '../markdown/obsidian-metadata';
import { createRichMarkdownManager, restoreRichMarkdownFinalLineEnding } from '../markdown/rich-markdown-codec';
import { DocumentReadError, type DocumentReadFormatV1, type DocumentReadPageV1 } from './contracts';

export const MAX_DOCUMENT_READ_BODY_BYTES = 128 * 1024 * 1024;

export type EncodedDocumentReadBodyV1 = Readonly<{
  format: DocumentReadFormatV1;
  mediaType: DocumentReadPageV1['mediaType'];
  /** Private captured bytes. The service must not expose or mutate this buffer. */
  bytes: Uint8Array;
  totalBytes: number;
  bodySha256: string;
}>;

function explicitMarkdown(content: NativeCollaborationContent): string {
  if (content.kind === 'plain_text') return content.text;
  try {
    const manager = createRichMarkdownManager();
    const serialized = restoreRichMarkdownFinalLineEnding(content.bodyFinalLineEnding, manager.serialize(content.document));
    const roundtrip = getNativeInspectionSchema().nodeFromJSON(manager.parse(serialized));
    if (roundtrip.content.size > 0) roundtrip.check();
    const normalizedRoundtrip = roundtrip.toJSON();
    if (!equivalentRichDocument(content.document, normalizedRoundtrip)
      || restoreRichMarkdownFinalLineEnding(content.bodyFinalLineEnding, manager.serialize(normalizedRoundtrip)) !== serialized) {
      throw new DocumentReadError('DOCUMENT_FORMAT_UNAVAILABLE');
    }
    return composeCanvasMarkdownDocument(content.frontmatter, serialized);
  } catch { throw new DocumentReadError('DOCUMENT_FORMAT_UNAVAILABLE'); }
}

/** UTF-8 cannot faithfully represent isolated UTF-16 surrogates. Native JSON
 * retains them as escapes; text exports must never silently replace them. */
function assertFaithfulUtf8(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new DocumentReadError('DOCUMENT_FORMAT_UNAVAILABLE');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new DocumentReadError('DOCUMENT_FORMAT_UNAVAILABLE');
  }
}

/** Format conversion of exactly the already-authorized observed native body.
 * This grants no access and performs no state, disk or projection read. Only
 * explicit Markdown invokes the Markdown serializer and roundtrip parser. */
export function encodeDocumentReadBodyV1(observation: NativeDocumentReadObservation,
  format: DocumentReadFormatV1): EncodedDocumentReadBodyV1 {
  const content = observation.native.observed.content;
  let serialized: string;
  let mediaType: DocumentReadPageV1['mediaType'];
  if (format === 'native') {
    serialized = JSON.stringify({ bodyVersion: 1, representation: observation.native.representation, content });
    mediaType = 'application/vnd.canvas.native-document+json';
  } else if (format === 'text') {
    serialized = nativeCollaborationSearchText(content);
    mediaType = 'text/plain';
  } else if (format === 'markdown') {
    serialized = explicitMarkdown(content);
    mediaType = 'text/markdown';
  } else throw new DocumentReadError('INVALID_REQUEST');
  // UTF-8 needs at least one byte per UTF-16 unit. Reject oversized strings
  // before scanning or allocating the complete encoded buffer.
  if (serialized.length > MAX_DOCUMENT_READ_BODY_BYTES) throw new DocumentReadError('DOCUMENT_TOO_LARGE');
  const totalBytes = Buffer.byteLength(serialized, 'utf8');
  if (totalBytes > MAX_DOCUMENT_READ_BODY_BYTES) throw new DocumentReadError('DOCUMENT_TOO_LARGE');
  assertFaithfulUtf8(serialized);
  const bytes = Buffer.from(serialized, 'utf8');
  return Object.freeze({ format, mediaType, bytes, totalBytes,
    bodySha256: createHash('sha256').update(bytes).digest('hex') });
}
