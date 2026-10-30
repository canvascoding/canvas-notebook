import 'server-only';
import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveExistingWorkspacePath } from '@/app/lib/filesystem/workspace-files';
import { filesystemFileVersion } from '@/app/lib/filesystem/file-version';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export const MANIFEST_MAX_FILE_BYTES = 100 * 1024 * 1024;
export class ManifestReadError extends Error {
  constructor(readonly code: 'MANIFEST_FILE_TOO_LARGE' | 'MANIFEST_FILE_CHANGED') { super(code); }
}

/** Hash the opened bytes with bounded memory and reject concurrent file changes. */
export async function readManifestFile(workspace: WorkspaceContext, path: string) {
  const fullPath = await resolveExistingWorkspacePath(path, { workspace });
  const file = await fs.open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new ManifestReadError('MANIFEST_FILE_CHANGED');
    if (before.size > MANIFEST_MAX_FILE_BYTES) throw new ManifestReadError('MANIFEST_FILE_TOO_LARGE');
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, MANIFEST_MAX_FILE_BYTES + 1 - size), size);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MANIFEST_MAX_FILE_BYTES) throw new ManifestReadError('MANIFEST_FILE_TOO_LARGE');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat(), pathAfter = await fs.lstat(fullPath);
    if (size !== before.size || filesystemFileVersion(before) !== filesystemFileVersion(after)
      || filesystemFileVersion(after) !== filesystemFileVersion(pathAfter)) throw new ManifestReadError('MANIFEST_FILE_CHANGED');
    const sha256 = hash.digest('hex');
    return { size, sha256, revision: `sha256:${sha256}`, modified_at: after.mtime.toISOString() };
  } finally { await file.close(); }
}
