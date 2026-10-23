import 'server-only';

import { constants, createWriteStream, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import ZipStream from 'zip-stream';
import { withNativeWorkspaceFilesRead, type NativeWorkspaceFilesReadScope } from '../collaboration/workspace-native-file-read';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { filesystemFileVersion } from '../filesystem/file-version';
import { assertWorkspacePathHasNoAliases } from '../workspaces/path-guard';
import type { WorkspaceContext } from '../workspaces/types';

const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_NATIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 64;
type Limits = { maxBytes: number; maxNativeBytes: number; maxEntries: number; maxDepth: number };
type Dependencies = Parameters<typeof withNativeWorkspaceFilesRead>[2] & {
  limits?: Partial<Limits>;
  /** Test fault seam; every path/authority observation is checked after it. */
  beforeMaterialize?: () => Promise<void>;
};
type Entry = { workspacePath: string; archivePath: string; type: 'file' | 'directory'; native: boolean; stats?: Stats };
type Observation = { fullPath: string; identity: string };
export type WorkspaceDownloadArchive = { archivePath: string; tempDirectory: string };

export class WorkspaceDownloadArchiveError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
function fail(code: string, message: string, status = 409): never {
  throw new WorkspaceDownloadArchiveError(code, message, status);
}
function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code)));
}
function selected(filePath: string, paths: readonly string[]): boolean {
  return paths.some(p => p === '.' || p === filePath || filePath.startsWith(`${p}/`));
}

async function collectEntries(workspace: WorkspaceContext, paths: readonly string[], scope: NativeWorkspaceFilesReadScope, limits: Limits) {
  const root = await fs.realpath(workspace.rootPath), rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory()) fail('ARCHIVE_SOURCE_CHANGED', 'The workspace root is unavailable.');
  const observations = new Map<string, Observation>([['.', { fullPath: root, identity: filesystemFileVersion(rootStat) }]]);
  const entries = new Map<string, Entry>(), names = new Map<string, string>();
  const documents = new Map(scope.documents.map(d => [d.path, d]));
  const archiveName = (filePath: string) => paths.includes('.') ? filePath === '.' ? 'workspace' : `workspace/${filePath}` : filePath;
  let physicalBytes = 0;
  const register = (entry: Entry) => {
    if (entry.workspacePath !== '.' && !isCanonicalAdmissionPath(entry.workspacePath)) fail('ARCHIVE_UNSUPPORTED_ENTRY', 'A download path is not canonical.', 400);
    if (entry.workspacePath.split('/').length - 1 > limits.maxDepth) fail('ARCHIVE_TOO_DEEP', 'Folder nesting is too deep to download.', 413);
    const old = entries.get(entry.workspacePath);
    if (old && old.type !== entry.type) fail('ARCHIVE_NAME_CONFLICT', 'A native document conflicts with a directory.');
    const key = entry.archivePath.replace(/\/$/u, '').normalize('NFC').toLocaleLowerCase('en-US');
    const prior = names.get(key);
    if (prior && prior !== entry.workspacePath) fail('ARCHIVE_NAME_CONFLICT', 'The selection contains conflicting archive names.');
    if (!old && entries.size >= limits.maxEntries) fail('ARCHIVE_TOO_MANY_ENTRIES', 'Too many entries in this download.', 413);
    names.set(key, entry.workspacePath);
    entries.set(entry.workspacePath, entry);
  };
  const visit = async (filePath: string, depth: number, checkAliases = true): Promise<void> => {
    if (depth > limits.maxDepth) fail('ARCHIVE_TOO_DEEP', 'Folder nesting is too deep to download.', 413);
    if (checkAliases) await assertWorkspacePathHasNoAliases(workspace, filePath, { readOnly: true });
    const fullPath = filePath === '.' ? root : path.join(root, filePath);
    const stats = await fs.lstat(fullPath);
    if (stats.isSymbolicLink()) fail('ARCHIVE_SYMBOLIC_LINK', 'Symbolic links cannot be included in downloads.', 400);
    if (!stats.isDirectory() && !stats.isFile()) fail('ARCHIVE_UNSUPPORTED_ENTRY', 'The selection contains an unsupported file type.', 400);
    observations.set(filePath, { fullPath, identity: filesystemFileVersion(stats) });
    if (stats.isDirectory()) {
      register({ workspacePath: filePath, archivePath: `${archiveName(filePath)}/`, type: 'directory', native: false });
      const children = [];
      for await (const child of await fs.opendir(fullPath)) {
        if (children.length >= limits.maxEntries - entries.size) fail('ARCHIVE_TOO_MANY_ENTRIES', 'Too many entries in this download.', 413);
        children.push(child);
      }
      children.sort((a, b) => a.name.localeCompare(b.name));
      // These child names came from the actual directory, rather than user
      // aliases. Parent and inode observations are confirmed again at read.
      for (const child of children) await visit(filePath === '.' ? child.name : `${filePath}/${child.name}`, depth + 1, false);
    } else {
      const authority = documents.get(filePath)?.authority;
      if (authority === 'missing-state') fail('NATIVE_STATE_UNAVAILABLE', 'The native document state is unavailable.');
      if (authority !== 'initialized') {
        if (stats.nlink !== 1) fail('ARCHIVE_UNSUPPORTED_ENTRY', 'Hard-linked files cannot be included in this download.', 400);
        physicalBytes += stats.size;
        if (physicalBytes > limits.maxBytes) fail('ARCHIVE_TOO_LARGE', 'The selected files exceed the ZIP download limit.', 413);
      }
      register({ workspacePath: filePath, archivePath: archiveName(filePath), type: 'file', native: authority === 'initialized', stats });
    }
  };
  // Capture existing selected ancestors as well: a missing virtual directory
  // never excuses a physical file, alias or changing parent in its path.
  for (const selection of paths) {
    if (selection !== '.') {
      const parts = selection.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/');
        try {
          await assertWorkspacePathHasNoAliases(workspace, parent, { readOnly: true });
          const fullPath = path.join(root, parent), stat = await fs.lstat(fullPath);
          if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ARCHIVE_NAME_CONFLICT', 'A selected parent is not a directory.');
          observations.set(parent, { fullPath, identity: filesystemFileVersion(stat) });
        } catch (error) { if (!missing(error)) throw error; }
      }
    }
    try { await visit(selection, 0); }
    catch (error) {
      if (!missing(error) || !scope.documents.some(d => selected(d.path, [selection]))) throw error;
    }
  }
  for (const document of scope.documents) {
    if (!selected(document.path, paths)) fail('ARCHIVE_SOURCE_CHANGED', 'A native document is outside the download scope.');
    if (document.authority === 'missing-state') fail('NATIVE_STATE_UNAVAILABLE', 'The native document state is unavailable.');
    if (document.authority === 'pristine') {
      if (entries.get(document.path)?.type !== 'file') fail('ARCHIVE_SOURCE_CHANGED', 'A never-initialized file has no physical source.');
      continue;
    }
    await assertWorkspacePathHasNoAliases(workspace, document.path, { readOnly: true });
    register({ workspacePath: document.path, archivePath: archiveName(document.path), type: 'file', native: true });
    let parent = path.posix.dirname(document.path);
    while (parent !== '.' && selected(parent, paths)) {
      register({ workspacePath: parent, archivePath: `${archiveName(parent)}/`, type: 'directory', native: false });
      parent = path.posix.dirname(parent);
    }
    if (paths.includes('.')) register({ workspacePath: '.', archivePath: 'workspace/', type: 'directory', native: false });
  }
  const verifyRoot = async () => {
    if (await fs.realpath(workspace.rootPath) !== root
      || filesystemFileVersion(await fs.lstat(root)) !== observations.get('.')!.identity) {
      fail('ARCHIVE_SOURCE_CHANGED', 'The workspace root changed.');
    }
  };
  const verifyObservation = async (observation: Observation) => {
    const stat = await fs.lstat(observation.fullPath);
    if (stat.isSymbolicLink() || filesystemFileVersion(stat) !== observation.identity) fail('ARCHIVE_SOURCE_CHANGED', 'A selected file or directory changed.');
  };
  const verifyFile = async (filePath: string) => {
    await verifyRoot();
    await assertWorkspacePathHasNoAliases(workspace, filePath, { readOnly: true });
    const parts = filePath.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const observation = observations.get(parts.slice(0, i).join('/'));
      if (observation) await verifyObservation(observation);
    }
  };
  const verify = async () => {
    await verifyRoot();
    for (const observation of observations.values()) await verifyObservation(observation);
  };
  await verify();
  return { root, entries: [...entries.values()].sort((a, b) => a.archivePath.localeCompare(b.archivePath)), physicalBytes, verify, verifyFile };
}

/** Strict text ZIP export, including native-only documents and virtual parents.
 * The complete temporary archive is materialized under one shared admission
 * fence; response streaming uses only that owned artifact after SQL COMMIT.
 * It is a download, not a binary recovery backup or multi-document snapshot. */
export async function materializeWorkspaceDownloadArchive(workspace: WorkspaceContext, paths: readonly string[], dependencies: Dependencies = {}): Promise<WorkspaceDownloadArchive> {
  workspace = structuredClone(workspace); paths = [...paths];
  const limits: Limits = { maxBytes: MAX_BYTES, maxNativeBytes: MAX_NATIVE_BYTES, maxEntries: MAX_ENTRIES, maxDepth: MAX_DEPTH, ...dependencies.limits };
  const maxima: Limits = { maxBytes: MAX_BYTES, maxNativeBytes: MAX_NATIVE_BYTES, maxEntries: MAX_ENTRIES, maxDepth: MAX_DEPTH };
  if (Object.entries(limits).some(([k, v]) => !Number.isSafeInteger(v) || v < 1 || v > maxima[k as keyof Limits])) throw new Error('Invalid archive download limits.');
  let artifact: WorkspaceDownloadArchive | undefined;
  try {
    return await withNativeWorkspaceFilesRead({ workspace, paths, maxEntries: limits.maxEntries }, async scope => {
      const plan = await collectEntries(workspace, paths, scope, limits);
      await dependencies.beforeMaterialize?.();
      await plan.verify();
      const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-download-'));
      artifact = { tempDirectory, archivePath: path.join(tempDirectory, 'selection.zip') };
      const archive = new ZipStream({ level: 1 }), output = createWriteStream(artifact.archivePath, { mode: 0o600 });
      const outputFinished = finished(output);
      // Register rejection handling immediately; zip errors may precede the
      // first awaited entry callback. The original promise is awaited below.
      void outputFinished.catch(() => {});
      archive.on('error', error => output.destroy(error));
      archive.pipe(output);
      const append = (source: NodeJS.ReadableStream | Buffer | null, entry: Entry, stats?: Stats) => new Promise<void>((resolve, reject) => {
        const done = (error?: Error | null) => {
          archive.off('error', done); output.off('error', done);
          if (error) reject(error); else resolve();
        };
        archive.once('error', done); output.once('error', done);
        archive.entry(source, { name: entry.archivePath, type: entry.type, ...(stats ? { stats } : {}) }, done);
      });
      let totalBytes = plan.physicalBytes;
      try {
        for (const entry of plan.entries) {
          if (entry.type === 'directory') { await append(null, entry); continue; }
          if (entry.native) {
            const remainingBytes = limits.maxBytes - totalBytes;
            const native = await scope.readFile(entry.workspacePath, Math.min(limits.maxNativeBytes, remainingBytes));
            if (!native?.content) fail('ARCHIVE_SOURCE_CHANGED', 'A native export changed its authority.');
            totalBytes += native.content.length;
            if (totalBytes > limits.maxBytes) fail('ARCHIVE_TOO_LARGE', 'The selected files exceed the ZIP download limit.', 413);
            await append(native.content, entry);
            continue;
          }
          if (!entry.stats) fail('ARCHIVE_ENTRY_INVALID', 'Invalid physical archive entry.', 500);
          await assertWorkspacePathHasNoAliases(workspace, entry.workspacePath, { readOnly: true });
          const fullPath = path.join(plan.root, entry.workspacePath), expected = filesystemFileVersion(entry.stats);
          const handle = await fs.open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            if (filesystemFileVersion(await handle.stat()) !== expected) fail('ARCHIVE_SOURCE_CHANGED', 'A selected file changed.');
            await plan.verifyFile(entry.workspacePath);
            const source = entry.stats.size === 0 ? Buffer.alloc(0) : handle.createReadStream({ autoClose: false, start: 0, end: entry.stats.size - 1 });
            try {
              await append(source, entry, entry.stats);
              if (filesystemFileVersion(await handle.stat()) !== expected) fail('ARCHIVE_SOURCE_CHANGED', 'A selected file changed while reading.');
            }
            finally { if (!Buffer.isBuffer(source)) source.destroy(); }
          } finally { await handle.close(); }
          await plan.verifyFile(entry.workspacePath);
        }
        archive.finish();
        await outputFinished;
        await plan.verify();
        return artifact;
      } catch (error) {
        archive.destroy(error instanceof Error ? error : new Error('Failed to create ZIP archive'));
        output.destroy();
        await outputFinished.catch(() => {});
        throw error;
      }
    }, dependencies);
  } catch (error) {
    if (artifact) await fs.rm(artifact.tempDirectory, { recursive: true, force: true });
    throw error;
  }
}
