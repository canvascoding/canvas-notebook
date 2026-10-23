import 'server-only';

import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { filesystemFileVersion } from '../filesystem/file-version';

/** Historical observations only: these shapes grant no read/write or SQL authority. */
export type WorkspaceOriginalPathObservation = Readonly<{ relativePath: string; stat: Stats; identity: string }>;
export type WorkspaceOriginalRootObservation = Readonly<{ resolvedRootPath: string; identity: string;
  entries: ReadonlyMap<string, WorkspaceOriginalPathObservation> }>;
type Source = { configuredRootPath: string; root: WorkspaceOriginalRootObservation; observed: WorkspaceOriginalPathObservation };
type CapturedPath = Readonly<{ relativePath: string; identity: string; size: number; nlink: number; kind: 'file' | 'directory' | 'unsafe' }>;
type CapturedSource = Readonly<{ configuredRootPath: string; resolvedRootPath: string; rootIdentity: string;
  observed: CapturedPath; ancestors: readonly CapturedPath[] }>;
const MAX_ORIGINAL_SOURCE_BYTES = 5 * 1024 * 1024;

export class WorkspaceOriginalFileSourceError extends Error {
  constructor(readonly code: 'invalid-source-path' | 'invalid-source-limit' | 'physical-scope-changed'
    | 'physical-source-changed' | 'unsafe-physical-source' | 'source-too-large', readonly filePath: string) {
    super(code); this.name = 'WorkspaceOriginalFileSourceError';
  }
}
const fail = (code: WorkspaceOriginalFileSourceError['code'], filePath: string): never => {
  throw new WorkspaceOriginalFileSourceError(code, filePath);
};
function capturePath(observed: WorkspaceOriginalPathObservation): CapturedPath {
  const { relativePath, identity, stat } = observed;
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 4096
    || /[\\\u0000-\u001f\u007f]/u.test(relativePath)
    || relativePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail('invalid-source-path', relativePath);
  if (typeof identity !== 'string' || identity !== filesystemFileVersion(stat)
    || !Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isSafeInteger(stat.nlink) || stat.nlink < 1) {
    fail('physical-source-changed', relativePath);
  }
  return Object.freeze({ relativePath, identity, size: stat.size, nlink: stat.nlink,
    kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'unsafe' });
}
function capture(input: Source): CapturedSource {
  const observed = capturePath(input.observed);
  const { configuredRootPath, root } = input;
  if (typeof configuredRootPath !== 'string' || !configuredRootPath || configuredRootPath.includes('\0')
    || typeof root.resolvedRootPath !== 'string' || !path.isAbsolute(root.resolvedRootPath)
    || typeof root.identity !== 'string' || !root.identity) fail('physical-scope-changed', observed.relativePath);
  // Copy this path's ancestry before yielding, never the whole workspace map.
  const ancestors: CapturedPath[] = []; let relativePath = '';
  for (const segment of observed.relativePath.split('/')) {
    relativePath = relativePath ? `${relativePath}/${segment}` : segment;
    const prior = root.entries.get(relativePath);
    if (!prior || prior.relativePath !== relativePath) return fail('physical-source-changed', observed.relativePath);
    const captured = capturePath(prior);
    if (relativePath === observed.relativePath ? captured.identity !== observed.identity
      : captured.kind !== 'directory') fail('physical-source-changed', observed.relativePath);
    ancestors.push(captured);
  }
  return Object.freeze({ configuredRootPath, resolvedRootPath: root.resolvedRootPath, rootIdentity: root.identity,
    observed, ancestors: Object.freeze(ancestors) });
}
async function hasExactDirectoryEntry(parent: string, segment: string): Promise<boolean> {
  // Stream names instead of allocating an entire potentially large directory.
  const directory = await fs.opendir(parent);
  try {
    for (let entry = await directory.read(); entry; entry = await directory.read()) {
      if (entry.name === segment) return true;
    }
    return false;
  } finally { await directory.close(); }
}
async function assertCurrent(source: CapturedSource): Promise<void> {
  const root = await fs.stat(source.resolvedRootPath);
  if (!root.isDirectory() || filesystemFileVersion(root) !== source.rootIdentity
    || await fs.realpath(source.configuredRootPath) !== source.resolvedRootPath) fail('physical-scope-changed', source.observed.relativePath);
  let parent = source.resolvedRootPath;
  for (const captured of source.ancestors) {
    const segment = captured.relativePath.split('/').at(-1)!;
    // Exact directory entries preserve spaces and reject case aliases even on a
    // case-insensitive filesystem. No path normalizer or trimming is involved.
    if (!await hasExactDirectoryEntry(parent, segment)) fail('physical-source-changed', source.observed.relativePath);
    const absolutePath = path.join(source.resolvedRootPath, captured.relativePath);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink() || filesystemFileVersion(stat) !== captured.identity
      || captured.relativePath !== source.observed.relativePath && !stat.isDirectory()) {
      fail('physical-source-changed', source.observed.relativePath);
    }
    parent = absolutePath;
  }
}

/** Point-in-time FS proof only. Caller owns ACL, admission and any transaction. */
export async function assertWorkspaceOriginalPathCurrent(input: Source): Promise<void> {
  await assertCurrent(capture(input));
}

/** One point-in-time namespace observation. Each parent is streamed once for
 * its required exact names; no result survives this call or grants authority.
 * The single-path and byte-reader checks retain their independent lifetimes. */
export async function assertWorkspaceOriginalPathsCurrent(input: {
  configuredRootPath: string; root: WorkspaceOriginalRootObservation;
  observed: readonly WorkspaceOriginalPathObservation[];
}): Promise<void> {
  const { configuredRootPath, root, observed } = input;
  const resolvedRootPath = root.resolvedRootPath, rootIdentity = root.identity;
  if (typeof configuredRootPath !== 'string' || !configuredRootPath || configuredRootPath.includes('\0')
    || typeof resolvedRootPath !== 'string' || !path.isAbsolute(resolvedRootPath)
    || typeof rootIdentity !== 'string' || !rootIdentity) fail('physical-scope-changed', '');
  if (!Array.isArray(observed) || observed.length > 10_000) fail('invalid-source-limit', '');
  const paths = new Map<string, CapturedPath>(), leaves = new Set<string>();
  // Capture every child AND ancestor before the first await. Subsequent caller
  // mutation of Stats, the input array or root.entries cannot replace facts.
  for (const item of observed) {
    const source = capture({ configuredRootPath, root, observed: item });
    if (source.resolvedRootPath !== resolvedRootPath || source.rootIdentity !== rootIdentity
      || leaves.has(source.observed.relativePath)) fail('physical-source-changed', source.observed.relativePath);
    leaves.add(source.observed.relativePath);
    for (const captured of source.ancestors) {
      if (captured.kind === 'unsafe') fail('unsafe-physical-source', captured.relativePath);
      const prior = paths.get(captured.relativePath);
      if (prior && (prior.identity !== captured.identity || prior.kind !== captured.kind
        || prior.size !== captured.size || prior.nlink !== captured.nlink)) fail('physical-source-changed', captured.relativePath);
      if (!prior && paths.size >= 10_000) fail('invalid-source-limit', captured.relativePath);
      paths.set(captured.relativePath, captured);
    }
  }
  const parents = new Map<string, Map<string, CapturedPath>>();
  for (const captured of paths.values()) {
    const directory = path.posix.dirname(captured.relativePath), parent = directory === '.' ? '' : directory;
    let children = parents.get(parent);
    if (!children) { children = new Map(); parents.set(parent, children); }
    children.set(path.posix.basename(captured.relativePath), captured);
  }
  const assertRoot = async () => {
    const current = await fs.stat(resolvedRootPath);
    if (!current.isDirectory() || filesystemFileVersion(current) !== rootIdentity
      || await fs.realpath(configuredRootPath) !== resolvedRootPath) fail('physical-scope-changed', '');
  };
  const assertPath = async (captured: CapturedPath) => {
    const current = await fs.lstat(path.join(resolvedRootPath, captured.relativePath));
    if (current.isSymbolicLink() || filesystemFileVersion(current) !== captured.identity
      || captured.kind === 'directory' && !current.isDirectory()
      || captured.kind === 'file' && !current.isFile()) fail('physical-source-changed', captured.relativePath);
  };
  const orderedParents = [...parents].sort(([a], [b]) => (a ? a.split('/').length : 0)
    - (b ? b.split('/').length : 0) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
  await assertRoot();
  for (const [parent, children] of orderedParents) {
    const capturedParent = parent ? paths.get(parent) : undefined;
    if (parent && capturedParent?.kind !== 'directory') fail('physical-source-changed', parent);
    if (capturedParent) await assertPath(capturedParent); else await assertRoot();
    // Store only requested names. Excluded siblings neither become namespace
    // facts nor introduce an artificial bound on raw directory membership.
    const missing = new Set(children.keys());
    const directory = await fs.opendir(parent ? path.join(resolvedRootPath, parent) : resolvedRootPath);
    try {
      while (missing.size) {
        const entry = await directory.read(); if (!entry) break;
        missing.delete(entry.name);
      }
    } finally { await directory.close(); }
    if (missing.size) fail('physical-source-changed', children.get(missing.values().next().value!)!.relativePath);
    if (capturedParent) await assertPath(capturedParent); else await assertRoot();
    for (const child of children.values()) await assertPath(child);
  }
  // A directory may have changed after its own group was checked while later
  // descendants were awaited. Retain every original ancestor, then the root.
  for (const captured of paths.values()) if (captured.kind === 'directory') await assertPath(captured);
  await assertRoot();
}

/** Opaque original bytes: no decoding, native IDs, filesystem writes or SQL.
 * Caller must retain its actual fence and await its own fresh source check.
 * No file descriptor escapes, including on a failed check/read/close. */
export async function readWorkspaceOriginalFileSource(input: Source & { maxBytes: number;
  verifyCurrentSource: () => Promise<void>; afterSourceFingerprint?: (relativePath: string) => Promise<void> }): Promise<Uint8Array> {
  const source = capture(input), { maxBytes, verifyCurrentSource, afterSourceFingerprint } = input;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_ORIGINAL_SOURCE_BYTES
    || typeof verifyCurrentSource !== 'function') fail('invalid-source-limit', source.observed.relativePath);
  if (source.observed.kind !== 'file' || source.observed.nlink !== 1) fail('unsafe-physical-source', source.observed.relativePath);
  if (source.observed.size > maxBytes) fail('source-too-large', source.observed.relativePath);
  await afterSourceFingerprint?.(source.observed.relativePath);
  await assertCurrent(source);
  await verifyCurrentSource();
  await assertCurrent(source);
  const handle = await fs.open(path.join(source.resolvedRootPath, source.observed.relativePath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) fail('unsafe-physical-source', source.observed.relativePath);
    if (filesystemFileVersion(before) !== source.observed.identity) fail('physical-source-changed', source.observed.relativePath);
    await assertCurrent(source);
    // Allocate only the captured bounded size plus one byte to detect growth.
    const buffer = Buffer.alloc(source.observed.size + 1); let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || used > maxBytes || used !== source.observed.size
      || filesystemFileVersion(after) !== source.observed.identity) fail('physical-source-changed', source.observed.relativePath);
    await assertCurrent(source);
    return Uint8Array.from(buffer.subarray(0, used));
  } finally { await handle.close(); }
}
