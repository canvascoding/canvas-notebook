import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { publicShareFileIdentityMatches, resolvePublicShareToken, type PublicShareResolution } from './public-file-shares';
import { exportNativePublicSnapshot, PublicShareNativeExportError } from './native-public-export';

type ResolvedShare = Extract<PublicShareResolution, { ok: true }>;
export const PUBLIC_SHARE_TEXT_SIZE_LIMIT = 5 * 1024 * 1024;

export class PublicShareReadError extends Error {
  constructor(message: string, readonly statusCode: 404 | 409 | 410 | 413 | 503) {
    super(message);
    this.name = 'PublicShareReadError';
  }
}

export async function assertPublicShareStillActive(resolved: ResolvedShare): Promise<void> {
  const current = await resolvePublicShareToken(resolved.row.token, { recordAccess: false });
  if (!current.ok) throw new PublicShareReadError('Public share changed or is no longer available.',
    current.status === 409 || current.status === 413 || current.status === 503 ? current.status : 410);
  if (current.row.policyRevision !== resolved.row.policyRevision
    || current.kind !== resolved.kind || current.row.id !== resolved.row.id
    || current.row.tokenHash !== resolved.row.tokenHash || current.row.workspaceId !== resolved.row.workspaceId
    || current.row.documentId !== resolved.row.documentId || current.row.lineageId !== resolved.row.lineageId
    || current.row.lifecycleGeneration !== resolved.row.lifecycleGeneration
    || current.workspacePath !== resolved.workspacePath || current.row.fileIdentity !== resolved.row.fileIdentity) {
    throw new PublicShareReadError('Public share changed or is no longer available.', 410);
  }
  if (current.kind === 'native' && resolved.kind === 'native'
    && (current.snapshot.documentId !== resolved.snapshot.documentId || current.snapshot.workspaceId !== resolved.snapshot.workspaceId
        || current.snapshot.organizationId !== resolved.snapshot.organizationId || current.snapshot.path !== resolved.snapshot.path
        || current.snapshot.lifecycleGeneration !== resolved.snapshot.lifecycleGeneration
        || current.snapshot.representation !== resolved.snapshot.representation || current.snapshot.schemaVersion !== resolved.snapshot.schemaVersion
        || current.snapshot.version.stateProof !== resolved.snapshot.version.stateProof
        || current.snapshot.version.documentSequence !== resolved.snapshot.version.documentSequence
        || current.exportProfile.newlineStyle !== resolved.exportProfile.newlineStyle || current.exportProfile.hasBom !== resolved.exportProfile.hasBom)) {
    throw new PublicShareReadError('The native public document changed during this read.', 409);
  }
}

/** Native reads export the exact accepted persisted snapshot. Historical
 * physical links retain their original file identity and never discover Yjs. */
export async function readPublicShareText(resolved: ResolvedShare, maxBytes = PUBLIC_SHARE_TEXT_SIZE_LIMIT): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new PublicShareReadError('Invalid text export limit.', 413);
  let content: string;
  if (resolved.kind === 'native') {
    try { content = exportNativePublicSnapshot(resolved.snapshot, resolved.exportProfile, maxBytes).text; }
    catch (error) {
      if (error instanceof PublicShareNativeExportError) throw new PublicShareReadError(error.message, error.statusCode);
      throw error;
    }
  } else {
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
