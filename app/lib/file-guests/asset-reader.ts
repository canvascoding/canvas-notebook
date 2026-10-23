import 'server-only';

import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { isCanonicalAdmissionPath } from '@/app/lib/collaboration/room-admission-contract';
import { filesystemFileVersion } from '@/app/lib/filesystem/file-version';
import { isInternalWorkspaceStagingPath } from '@/app/lib/files/internal-staging-path';
import { assertWorkspaceOriginalPathCurrent, WorkspaceOriginalFileSourceError,
  type WorkspaceOriginalPathObservation } from '@/app/lib/files/workspace-original-file-source';
import { isSensitiveWorkspacePath, publicShareFileIdentityMatches } from '@/app/lib/public-sharing/public-file-shares';
import type { FileGuestAsset } from './types';

const MAX_ASSET_BYTES = 20 * 1024 * 1024;

export class FileGuestAssetReadError extends Error {
  readonly code = 'FILE_GUEST_ASSET_UNAVAILABLE';
  readonly status = 404;
  constructor() { super('Das freigegebene Bild ist nicht mehr sicher verfügbar.'); this.name = 'FileGuestAssetReadError'; }
}
const reject = (): never => { throw new FileGuestAssetReadError(); };

/** Reuse the exact ancestry rejection proof without changing the original
 * Markdown source reader's separate 5 MiB budget. */
async function filesystem<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof WorkspaceOriginalFileSourceError || error && typeof error === 'object'
      && ['ENOENT','ENOTDIR','ELOOP','EACCES','EPERM','ENAMETOOLONG'].includes(String(Reflect.get(error,'code')))) reject();
    throw error;
  }
}

async function exactEntry(parent: string, name: string): Promise<boolean> {
  const directory = await fs.opendir(parent);
  try { for (let entry = await directory.read(); entry; entry = await directory.read()) if (entry.name === name) return true; return false; }
  finally { await directory.close(); }
}

/** Only reads an already approved asset. The caller owns genuine Guest access
 * and policy/pin checks; verifyCurrent is rejection-only and grants no rights.
 * No path normalizer, root creation, SQL or descriptor escapes this helper. */
export async function readApprovedFileGuestAsset(workspace: WorkspaceContext, asset: Readonly<FileGuestAsset>,
  verifyCurrent: () => Promise<void>): Promise<Uint8Array> {
  const configuredRootPath = workspace.rootPath, filePath = asset.path, identity = asset.identity;
  if (typeof configuredRootPath !== 'string' || !path.isAbsolute(configuredRootPath)
    || !isCanonicalAdmissionPath(filePath) || isSensitiveWorkspacePath(filePath) || isInternalWorkspaceStagingPath(filePath)
    || typeof identity !== 'string' || !identity || identity.length > 256 || typeof verifyCurrent !== 'function') reject();
  await verifyCurrent();
  const source = await filesystem(async () => {
    const root = await fs.realpath(configuredRootPath), rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) reject();
    const entries = new Map<string, WorkspaceOriginalPathObservation>();
    let parent = root, relativePath = '', observed: WorkspaceOriginalPathObservation | undefined;
    const segments = filePath.split('/');
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index], absolute = path.join(parent,segment);
      const stat: Stats = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || !await exactEntry(parent,segment)
        || index < segments.length-1 && !stat.isDirectory()) reject();
      relativePath = relativePath ? `${relativePath}/${segment}` : segment;
      observed = {relativePath,stat,identity:filesystemFileVersion(stat)};
      entries.set(relativePath,observed); parent = absolute;
    }
    if (!observed) throw new FileGuestAssetReadError();
    if (!observed.stat.isFile() || observed.stat.nlink !== 1 || !Number.isSafeInteger(observed.stat.size)
      || observed.stat.size < 0 || observed.stat.size > MAX_ASSET_BYTES || !publicShareFileIdentityMatches(observed.stat,identity)) reject();
    return {configuredRootPath,root:{resolvedRootPath:root,identity:filesystemFileVersion(rootStat),entries},observed};
  });
  await filesystem(() => assertWorkspaceOriginalPathCurrent(source));
  const handle = await filesystem(() => fs.open(path.join(source.root.resolvedRootPath,filePath),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const bytes = await filesystem(async () => {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || !publicShareFileIdentityMatches(before,identity)
        || filesystemFileVersion(before) !== source.observed.identity) reject();
      await assertWorkspaceOriginalPathCurrent(source);
      const buffer = Buffer.alloc(source.observed.stat.size+1); let used = 0;
      while (used < buffer.byteLength) {
        const {bytesRead} = await handle.read(buffer,used,buffer.byteLength-used,used);
        if (!bytesRead) break; used += bytesRead;
      }
      const after = await handle.stat();
      if (!after.isFile() || after.nlink !== 1 || used !== source.observed.stat.size || used > MAX_ASSET_BYTES
        || filesystemFileVersion(after) !== source.observed.identity || !publicShareFileIdentityMatches(after,identity)) reject();
      await assertWorkspaceOriginalPathCurrent(source);
      return Uint8Array.from(buffer.subarray(0,used));
    });
    // Preserve the caller's actual authorization/COMMIT errors unchanged.
    await verifyCurrent();
    await filesystem(() => assertWorkspaceOriginalPathCurrent(source));
    return bytes;
  } finally { await handle.close(); }
}
