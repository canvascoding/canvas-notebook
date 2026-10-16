import 'server-only';

import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { isInternalWorkspaceStagingPath } from '../files/internal-staging-path';
import { assertWorkspaceOriginalPathCurrent, type WorkspaceOriginalPathObservation,
  type WorkspaceOriginalRootObservation } from '../files/workspace-original-file-source';
import { filesystemFileVersion } from '../filesystem/file-version';
import type { WorkspaceContext } from '../workspaces/types';
import { isSensitiveWorkspacePath, publicShareFileIdentityMatches, type PublicShareRow } from './public-file-shares';

export class PublicSharePhysicalTargetError extends Error {
  readonly code = 'PUBLIC_SHARE_TARGET_CHANGED';
  readonly status = 409;
  constructor() { super('PUBLIC_SHARE_TARGET_CHANGED'); this.name = 'PublicSharePhysicalTargetError'; }
}

const changed = (): never => { throw new PublicSharePhysicalTargetError(); };
function regular(stat: Stats): void {
  if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size < 0) changed();
}

/** Historical filesystem proof only. Caller owns the actual workspace kernel,
 * authority, admission, SQL transaction and finality through operation cleanup.
 * No content is read and no native identity is inferred from a physical path. */
export async function withPreparedPublicSharePhysicalTarget<T>(workspace: WorkspaceContext, row: PublicShareRow,
  operation: (capture: Readonly<{ assertCurrent: () => Promise<void> }>) => Promise<T>): Promise<T> {
  const configuredRootPath = workspace.rootPath, relativePath = row.workspacePath, fileIdentity = row.fileIdentity;
  if (typeof configuredRootPath !== 'string' || !path.isAbsolute(configuredRootPath)
    || /[\u0000-\u001f\u007f]/u.test(configuredRootPath) || !isCanonicalAdmissionPath(relativePath)
    || isInternalWorkspaceStagingPath(relativePath) || isSensitiveWorkspacePath(relativePath)
    || typeof fileIdentity !== 'string' || !fileIdentity || typeof operation !== 'function'
    || row.documentId !== null || row.lineageId !== null || row.lifecycleGeneration !== null) changed();

  let handle: FileHandle | undefined;
  let active = false, accepting = false;
  const pending = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined, primary: { error: unknown } | undefined, outcome: { value: T } | undefined;
  try {
    let source: { configuredRootPath: string; root: WorkspaceOriginalRootObservation; observed: WorkspaceOriginalPathObservation };
    let rootIdentity: string, fileVersion: string;
    try {
      const resolvedRootPath = await fs.realpath(configuredRootPath);
      const rootStat = await fs.lstat(resolvedRootPath), configuredRootStat = await fs.lstat(configuredRootPath);
      rootIdentity = filesystemFileVersion(rootStat);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !configuredRootStat.isDirectory()
        || configuredRootStat.isSymbolicLink() || filesystemFileVersion(configuredRootStat) !== rootIdentity) changed();
      const entries = new Map<string, WorkspaceOriginalPathObservation>();
      let observedPath = '';
      for (const segment of relativePath.split('/')) {
        observedPath = observedPath ? `${observedPath}/${segment}` : segment;
        const stat = await fs.lstat(path.join(resolvedRootPath, observedPath));
        if (stat.isSymbolicLink() || observedPath !== relativePath && !stat.isDirectory()) changed();
        entries.set(observedPath, Object.freeze({ relativePath: observedPath, stat, identity: filesystemFileVersion(stat) }));
      }
      const observed = entries.get(relativePath)!;
      regular(observed.stat);
      if (!publicShareFileIdentityMatches(observed.stat, fileIdentity)) changed();
      fileVersion = observed.identity;
      source = { configuredRootPath, root: Object.freeze({ resolvedRootPath, identity: rootIdentity, entries }), observed };
      await assertWorkspaceOriginalPathCurrent(source);
      handle = await fs.open(path.join(resolvedRootPath, relativePath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) { throw error instanceof PublicSharePhysicalTargetError ? error : new PublicSharePhysicalTargetError(); }

    const held = handle;
    if (!held) changed();
    const assertPhysicalCurrent = async () => {
      try {
        await assertWorkspaceOriginalPathCurrent(source);
        const before = await held.stat(); regular(before);
        const configuredRootStat = await fs.lstat(configuredRootPath);
        if (filesystemFileVersion(before) !== fileVersion || !publicShareFileIdentityMatches(before, fileIdentity)
          || !configuredRootStat.isDirectory() || configuredRootStat.isSymbolicLink()
          || filesystemFileVersion(configuredRootStat) !== rootIdentity) changed();
        await assertWorkspaceOriginalPathCurrent(source);
        const after = await held.stat(); regular(after);
        if (filesystemFileVersion(after) !== fileVersion || !publicShareFileIdentityMatches(after, fileIdentity)) changed();
      } catch (error) { throw error instanceof PublicSharePhysicalTargetError ? error : new PublicSharePhysicalTargetError(); }
    };
    await assertPhysicalCurrent();
    active = true; accepting = true;
    const assertCurrent = (): Promise<void> => {
      const check = (async () => {
        try {
          if (!active || !accepting || failure) changed();
          await assertPhysicalCurrent();
          if (!active || !accepting || failure) changed();
        } catch (error) { failure ??= { error }; throw error; }
      })();
      pending.add(check);
      void check.then(() => pending.delete(check), () => pending.delete(check));
      return check;
    };
    try { outcome = { value: await operation(Object.freeze({ assertCurrent })) }; }
    catch (error) { primary = { error }; }
    accepting = false;
    if (pending.size) {
      failure ??= { error: new PublicSharePhysicalTargetError() };
      await Promise.allSettled([...pending]);
    }
    if (!primary && failure) primary = failure;
    if (!primary) {
      await assertPhysicalCurrent();
      if (failure) primary = failure;
    }
  } catch (error) { primary ??= { error }; }
  finally {
    accepting = false; active = false;
    if (handle) {
      try { await handle.close(); }
      catch (error) { primary = { error: new AggregateError([...(primary ? [primary.error] : []), error],
        'Public share physical target cleanup could not be confirmed.') }; }
    }
  }
  if (!primary && failure) primary = failure;
  if (primary) throw primary.error;
  return outcome!.value;
}
