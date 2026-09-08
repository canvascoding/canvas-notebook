import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import { publicShareFileIdentityMatches, resolvePublicShareToken, type PublicShareResolution } from './public-file-shares';

type ResolvedShare = Extract<PublicShareResolution, { ok: true }>;
export const PUBLIC_SHARE_TEXT_SIZE_LIMIT = 5 * 1024 * 1024;

export class PublicShareReadError extends Error {
  constructor(message: string, readonly statusCode: 404 | 410 | 413) {
    super(message);
    this.name = 'PublicShareReadError';
  }
}

export async function assertPublicShareStillActive(resolved: ResolvedShare): Promise<void> {
  const current = await resolvePublicShareToken(resolved.row.token, { recordAccess: false });
  if (!current.ok || current.row.policyRevision !== resolved.row.policyRevision
    || current.row.fileIdentity !== resolved.row.fileIdentity) {
    throw new PublicShareReadError('Public share changed or is no longer available.', 410);
  }
}

/** Read the accepted collaborative state, including edits awaiting a checkpoint. */
export async function readPublicShareText(resolved: ResolvedShare, maxBytes = PUBLIC_SHARE_TEXT_SIZE_LIMIT): Promise<string> {
  let content: string | undefined;
  if (getDatabaseProvider() === 'postgres' && /\.(md|markdown|txt)$/i.test(resolved.workspacePath)) {
    const { getFileCollaborationState } = await import('@/app/lib/files/collaboration-policy');
    const state = await getFileCollaborationState({ workspace: resolved.workspace, path: resolved.workspacePath, ensureDocument: false });
    if (state.document) {
      const { loadCollaborationStateIncludingArchived, serializeCanonicalText } = await import('@/app/lib/collaboration/persistence');
      const persisted = await loadCollaborationStateIncludingArchived(state.document.id);
      if (persisted) {
        if (persisted.status !== 'active' || persisted.workspaceId !== resolved.workspace.workspaceId
          || persisted.path !== resolved.workspacePath) throw new PublicShareReadError('Collaborative file changed.', 410);
        const { readCurrentCollaborationDocument } = await import('@/app/lib/collaboration/document-access');
        const { richMarkdownFromYDoc } = await import('@/app/lib/collaboration/markdown-state');
        content = serializeCanonicalText(await readCurrentCollaborationDocument({
          documentId: state.document.id, workspaceId: resolved.workspace.workspaceId,
          read: (doc) => persisted.representation === 'plain_text' ? doc.getText('content').toString() : richMarkdownFromYDoc(doc),
        }), persisted);
      }
    }
  }
  if (content === undefined) {
    const file = await fs.open(resolved.fullPath, 'r');
    try {
      const stats = await file.stat();
      if (!stats.isFile() || !publicShareFileIdentityMatches(stats, resolved.row.fileIdentity)) throw new PublicShareReadError('Shared file was replaced.', 404);
      if (stats.size > maxBytes) throw new PublicShareReadError('Shared text file is too large.', 413);
      content = await file.readFile('utf8');
    } finally {
      await file.close();
    }
  }
  if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new PublicShareReadError('Shared text file is too large.', 413);
  await assertPublicShareStillActive(resolved);
  return content;
}

export function isPublicSharedTextPath(workspacePath: string): boolean {
  return ['.md', '.markdown', '.mdx', '.txt'].includes(path.extname(workspacePath).toLowerCase());
}
