import 'server-only';

import path from 'node:path';
import { getSchema } from '@tiptap/core';
import type { NativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { serializeCanonicalText } from '../collaboration/persistence';
import { richMarkdownSchemaExtensions } from '../collaboration/markdown-state';
import { createRichMarkdownManager, restoreRichMarkdownFinalLineEnding } from '../markdown/rich-markdown-codec';
import { equivalentRichDocument } from '../markdown/core/equivalence';
import { composeCanvasMarkdownDocument, splitCanvasMarkdownForRichEditor } from '../markdown/obsidian-metadata';

export type NativePublicExportProfile = Readonly<{ newlineStyle: 'lf' | 'crlf'; hasBom: boolean }>;
export const NATIVE_PUBLIC_EXPORT_SIZE_LIMIT = 5 * 1024 * 1024;

export class PublicShareNativeExportError extends Error {
  constructor(readonly code: 'PUBLIC_SHARE_NATIVE_EXPORT_UNAVAILABLE' | 'PUBLIC_SHARE_NATIVE_EXPORT_TOO_LARGE') {
    super(code === 'PUBLIC_SHARE_NATIVE_EXPORT_TOO_LARGE' ? 'The native document is too large to export.'
      : 'A lossless text export of this native document is unavailable. Its native preview remains available.');
    this.name = 'PublicShareNativeExportError';
  }
  get statusCode(): 409 | 413 { return this.code === 'PUBLIC_SHARE_NATIVE_EXPORT_TOO_LARGE' ? 413 : 409; }
}

function unavailable(): never { throw new PublicShareNativeExportError('PUBLIC_SHARE_NATIVE_EXPORT_UNAVAILABLE'); }
function tooLarge(): never { throw new PublicShareNativeExportError('PUBLIC_SHARE_NATIVE_EXPORT_TOO_LARGE'); }

/** Pure derived export of exactly one validated persisted snapshot. No Yjs
 * room, file projection, authority, mutation or best-effort serialization. */
export function exportNativePublicSnapshot(snapshot: NativeCollaborationSnapshot, profile: NativePublicExportProfile,
  maxBytes = NATIVE_PUBLIC_EXPORT_SIZE_LIMIT): Readonly<{ text: string; bytes: Buffer<ArrayBuffer> }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > NATIVE_PUBLIC_EXPORT_SIZE_LIMIT
    || !profile || !['lf', 'crlf'].includes(profile.newlineStyle) || typeof profile.hasBom !== 'boolean'
    || snapshot.source !== 'persisted_yjs' || snapshot.snapshotVersion !== 1) unavailable();
  try {
    let canonical: string;
    if (snapshot.content.kind === 'plain_text') canonical = snapshot.content.text;
    else {
      const content = snapshot.content, schema = getSchema(richMarkdownSchemaExtensions());
      if (!/^(?:\r?\n)*$/u.test(content.bodyFinalLineEnding)) unavailable();
      const original = schema.nodeFromJSON(content.document); if (original.content.size > 0) original.check();
      const manager = createRichMarkdownManager();
      canonical = composeCanvasMarkdownDocument(content.frontmatter,
        restoreRichMarkdownFinalLineEnding(content.bodyFinalLineEnding, manager.serialize(content.document)));
      const parts = splitCanvasMarkdownForRichEditor(canonical);
      // This is the same parser/schema/equivalence contract used by native rich
      // exports. Reparse the complete source so metadata cannot absorb body text.
      const parsed = schema.nodeFromJSON(manager.parse(parts.body)); if (parsed.content.size > 0) parsed.check();
      const roundtrip = composeCanvasMarkdownDocument(parts.prefix,
        restoreRichMarkdownFinalLineEnding(parts.body, manager.serialize(parsed.toJSON())));
      if (parts.prefix !== content.frontmatter || roundtrip !== canonical
        || !equivalentRichDocument(content.document, parsed.toJSON())) unavailable();
    }
    if (Buffer.byteLength(canonical, 'utf8') > maxBytes) tooLarge();
    const text = serializeCanonicalText(canonical, profile);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) tooLarge();
    return Object.freeze({ text, bytes: Buffer.from(text, 'utf8') });
  } catch (error) {
    if (error instanceof PublicShareNativeExportError) throw error;
    unavailable();
  }
}

/** Names and MIME describe the emitted text, including native .docx/.pdf paths. */
export function nativePublicExportMetadata(fileName: string, snapshot: NativeCollaborationSnapshot): Readonly<{
  fileName: string; mimeType: string;
}> {
  const original = path.posix.basename(fileName), extension = path.posix.extname(original);
  const markdown = snapshot.content.kind === 'rich_text' || ['.md', '.markdown', '.mdx'].includes(extension.toLowerCase());
  const suffix = markdown ? '.md' : '.txt';
  return Object.freeze({ fileName: `${extension ? original.slice(0, -extension.length) : original}${suffix}`,
    mimeType: markdown ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8' });
}
