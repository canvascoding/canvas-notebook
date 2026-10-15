import type { NativeCollaborationContent } from '../collaboration/document-snapshot';
import type { CollaborationSessionResponse } from '../collaboration/types';
import type { FileGuestPermission } from './types';

export const FILE_GUEST_CONTENT_LIMIT = 5 * 1024 * 1024;

/** A native bootstrap is validated document content, never a Markdown export. */
export type FileGuestContentBootstrap =
  | Readonly<{ kind: 'markdown'; markdown: string }>
  | Readonly<{ kind: 'native_document'; content: NativeCollaborationContent }>;

export type FileGuestDocumentResponse = Readonly<{
  success: true;
  fileName: string;
  path: string;
  bootstrap: FileGuestContentBootstrap;
  assets: string[];
  permission: FileGuestPermission;
  expiresAt: string | null;
  session: CollaborationSessionResponse;
}>;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;

/** Wire-shape validation only. Native schema validation remains server-owned;
 * rendering/editing still waits for the actual authorized Yjs document. */
export function isFileGuestContentBootstrap(value: unknown): value is FileGuestContentBootstrap {
  if (!object(value) || Object.keys(value).length !== 2) return false;
  if (value.kind === 'markdown') return typeof value.markdown === 'string';
  if (value.kind !== 'native_document' || !object(value.content)) return false;
  const native = value.content;
  if (native.kind === 'plain_text') return Object.keys(native).length === 2 && typeof native.text === 'string';
  return native.kind === 'rich_text' && Object.keys(native).length === 4 && object(native.document)
    && native.document.type === 'doc' && typeof native.frontmatter === 'string' && typeof native.bodyFinalLineEnding === 'string';
}
