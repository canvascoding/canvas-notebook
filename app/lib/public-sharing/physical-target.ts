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

export type PublicSharePhysicalPublicationMetadata = Readonly<{
  workspacePath: string; fileName: string; fileIdentity: string; lastKnownRevision: string; sizeBytes: number;
}>;
type PreparedPhysicalTarget = Readonly<{
  metadata: PublicSharePhysicalPublicationMetadata; assertCurrent: () => Promise<void>;
}>;

/** Mechanical filesystem proof only. The caller retains its actual kernel,
 * current authority, admission and transaction through operation cleanup. */
async function withPreparedPhysicalTarget<T>(workspace: WorkspaceContext, relativePath: string, expectedIdentity: string | undefined,
  operation: (capture: PreparedPhysicalTarget) => Promise<T>): Promise<T> {
  const configuredRootPath = workspace.rootPath;
  if (typeof configuredRootPath !== 'string' || !path.isAbsolute(configuredRootPath)
    || /[\u0000-\u001f\u007f]/u.test(configuredRootPath) || !isCanonicalAdmissionPath(relativePath)
    || isInternalWorkspaceStagingPath(relativePath) || isSensitiveWorkspacePath(relativePath)
    || expectedIdentity !== undefined && (typeof expectedIdentity !== 'string' || !expectedIdentity)
    || typeof operation !== 'function') changed();

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
      if (expectedIdentity !== undefined && !publicShareFileIdentityMatches(observed.stat, expectedIdentity)) changed();
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
        if (filesystemFileVersion(before) !== fileVersion
          || expectedIdentity !== undefined && !publicShareFileIdentityMatches(before, expectedIdentity)
          || !configuredRootStat.isDirectory() || configuredRootStat.isSymbolicLink()
          || filesystemFileVersion(configuredRootStat) !== rootIdentity) changed();
        await assertWorkspaceOriginalPathCurrent(source);
        const after = await held.stat(); regular(after);
        if (filesystemFileVersion(after) !== fileVersion
          || expectedIdentity !== undefined && !publicShareFileIdentityMatches(after, expectedIdentity)) changed();
        return after;
      } catch (error) { throw error instanceof PublicSharePhysicalTargetError ? error : new PublicSharePhysicalTargetError(); }
    };
    const initial = await assertPhysicalCurrent();
    const fileIdentity = `${initial.dev}:${initial.ino}:${initial.birthtimeMs}`;
    const metadata: PublicSharePhysicalPublicationMetadata = Object.freeze({
      workspacePath: relativePath, fileName: path.posix.basename(relativePath), fileIdentity,
      lastKnownRevision: `${Math.trunc(initial.mtimeMs)}:${initial.size}:${fileIdentity}`, sizeBytes: initial.size,
    });
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
    try { outcome = { value: await operation(Object.freeze({ metadata, assertCurrent })) }; }
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

/** Historical filesystem proof only. Original all-null native pins and legacy
 * dev:ino identities retain the existing policy contract. No metadata rebind. */
export async function withPreparedPublicSharePhysicalTarget<T>(workspace: WorkspaceContext, row: PublicShareRow,
  operation: (capture: Readonly<{ assertCurrent: () => Promise<void> }>) => Promise<T>): Promise<T> {
  const relativePath = row.workspacePath, expectedIdentity = row.fileIdentity;
  if (typeof expectedIdentity !== 'string' || !expectedIdentity || typeof operation !== 'function'
    || row.documentId !== null || row.lineageId !== null || row.lifecycleGeneration !== null) changed();
  return withPreparedPhysicalTarget(workspace, relativePath, expectedIdentity,
    capture => operation(Object.freeze({ assertCurrent: capture.assertCurrent })));
}

/** Fresh publication facts come from the actual held FD, never a synthetic
 * share row. This opens no SQL, reads no content and mints no authority.
 * The caller must acquire its workspace kernel before entering this scope. */
export async function withPreparedPublicSharePhysicalPublicationTarget<T>(workspace: WorkspaceContext, canonicalPath: string,
  operation: (capture: PreparedPhysicalTarget) => Promise<T>): Promise<T> {
  return withPreparedPhysicalTarget(workspace, canonicalPath, undefined, operation);
}
