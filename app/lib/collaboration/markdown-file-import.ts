import 'server-only';

import { createHash } from 'node:crypto';
import { analyzeMarkdownRichMode } from '../markdown/rich-markdown-codec';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownFromYDoc, validateRichMarkdownYDoc } from './markdown-state';
import { serializeCanonicalText } from './persistence';
import { Y } from './server-runtime';
import type { TextCollaborationRepresentation } from './types';

export const MARKDOWN_FILE_IMPORT_LIMIT = 8 * 1024 * 1024;
export type MarkdownImportErrorCode = 'MARKDOWN_IMPORT_INVALID_INPUT' | 'MARKDOWN_IMPORT_ENCODING_UNSUPPORTED'
  | 'MARKDOWN_IMPORT_RICH_UNAVAILABLE' | 'MARKDOWN_IMPORT_TARGET_CHANGED' | 'MARKDOWN_IMPORT_TARGET_NOT_EMPTY'
  | 'MARKDOWN_IMPORT_LIFECYCLE_REQUIRED' | 'MARKDOWN_IMPORT_REQUEST_CONFLICT' | 'MARKDOWN_IMPORT_BUSY'
  | 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED';
export class MarkdownFileImportError extends Error {
  readonly status = 409;
  constructor(readonly code: MarkdownImportErrorCode) {
    super(`The complete Markdown import is unavailable: ${code}.`);
    this.name = 'MarkdownFileImportError';
  }
}
export type PreparedMarkdownFileImport = {
  version: 1;
  representation: TextCollaborationRepresentation;
  canonical: string;
  newlineStyle: 'lf' | 'crlf';
  hasBom: boolean;
  sourceHash: string;
  sourceBytes: number;
  /** Private preparation only: never serialize native bytes in a public response. */
  yjsState: Uint8Array;
  stateVector: Uint8Array;
  sourceFallbackReason?: string;
};

/** Complete-file import is different from body paste: retain frontmatter and
 * the exact supported byte profile, and never opt into source normalization. */
export function prepareMarkdownFileImport(bytes: Uint8Array, options: {
  representation?: TextCollaborationRepresentation | 'auto';
} = {}): PreparedMarkdownFileImport {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MARKDOWN_FILE_IMPORT_LIMIT
    || !['auto', 'plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(options.representation ?? 'auto')) {
    throw new MarkdownFileImportError('MARKDOWN_IMPORT_INVALID_INPUT');
  }
  // Fatal decoding prevents replacement characters from silently changing bytes.
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new MarkdownFileImportError('MARKDOWN_IMPORT_ENCODING_UNSUPPORTED'); }
  if (!Buffer.from(source, 'utf8').equals(Buffer.from(bytes))) throw new MarkdownFileImportError('MARKDOWN_IMPORT_ENCODING_UNSUPPORTED');
  const hasBom = source.startsWith('\uFEFF');
  const body = hasBom ? source.slice(1) : source;
  const crlf = /\r\n/u.test(body);
  // The existing persistence profile cannot represent mixed or bare-CR endings.
  if (/\r(?!\n)/u.test(body) || crlf && /(?<!\r)\n/u.test(body)) {
    throw new MarkdownFileImportError('MARKDOWN_IMPORT_ENCODING_UNSUPPORTED');
  }
  const newlineStyle = crlf ? 'crlf' : 'lf';
  const canonical = body.replace(/\r\n/gu, '\n');
  const requested = options.representation ?? 'auto';
  let representation: TextCollaborationRepresentation = requested === 'auto' ? 'tiptap_blocks' : requested;
  let sourceFallbackReason: string | undefined;
  let doc: InstanceType<typeof Y.Doc> | undefined;
  try {
    if (representation !== 'plain_text') {
      const analysis = analyzeMarkdownRichMode(canonical);
      if (analysis.mode !== 'rich') sourceFallbackReason = analysis.mode === 'source' ? analysis.reason : 'source_normalization_required';
      else {
        try {
          doc = createRichMarkdownYDoc(canonical, representation);
          const validation = validateRichMarkdownYDoc(doc);
          if (!validation.valid || richMarkdownFromYDoc(doc) !== canonical) sourceFallbackReason = validation.code ?? 'source_roundtrip_changed';
          // An empty XML root has no Yjs item and disappears from persisted bytes.
          if (representation === 'tiptap_xml' && !doc.getXmlFragment('body').length) sourceFallbackReason = 'empty_xml_root';
        } catch { sourceFallbackReason = 'rich_parse_failed'; }
      }
      if (sourceFallbackReason) {
        doc?.destroy(); doc = undefined;
        if (requested !== 'auto') throw new MarkdownFileImportError('MARKDOWN_IMPORT_RICH_UNAVAILABLE');
        representation = 'plain_text';
      }
    }
    doc ??= createPlainTextYDoc(canonical);
    if (serializeCanonicalText(canonical, { newlineStyle, hasBom }) !== source) {
      throw new MarkdownFileImportError('MARKDOWN_IMPORT_ENCODING_UNSUPPORTED');
    }
    return { version: 1, representation, canonical, newlineStyle, hasBom,
      sourceHash: createHash('sha256').update(bytes).digest('hex'), sourceBytes: bytes.byteLength,
      yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
      ...(sourceFallbackReason ? { sourceFallbackReason } : {}) };
  } finally { doc?.destroy(); }
}
