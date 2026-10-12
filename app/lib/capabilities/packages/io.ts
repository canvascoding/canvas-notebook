import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { computeCanvasPluginChecksum } from '@/app/lib/plugins/canvas-plugin-registry';
import { isValidCanvasPluginName } from '@/app/lib/plugins/canvas-plugin-manifest';
import { isValidAgentSkillName } from '@/app/lib/skills/canvas-skill-manifest';
import { resolveCanvasDataRoot, resolveOrganizationDataRoot, resolveUserDataRoot } from '@/app/lib/runtime-data-paths';
import type { CapabilityResourceOwnerScope } from '../resources/contracts';
import {
  CAPABILITY_PACKAGE_CONTRACT_VERSION, CAPABILITY_PACKAGE_LIMITS, CapabilityPackageError,
  type CapabilityPackageDraftLocation, type CapabilityPackageFileEntry, type CapabilityPackageFileRead,
  type CapabilityPackageFileWrite, type CapabilityPackageKind, type CapabilityPackagePreparedSnapshot,
  type CapabilityPackagePrivateLocation, type CapabilityPackagePublishedLocation,
  type CapabilityPackageRevisionIdentity, type CapabilityPackageSnapshotMarker,
  type CapabilityPackageTreeEntry, type CapabilityPackageValidation,
} from './contracts';

const ignoredEntries = new Set(['.git', 'node_modules', '.DS_Store']);
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const protectedNames = new Set(['.env', '.npmrc', '.netrc', '.git-credentials', 'credentials', 'credentials.json',
  'secrets.json', 'token.json', 'oauth-token.json', 'auth.json', 'service-account.json', 'client-secret.json',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']);

export type ExactCapabilityPackageInventory = {
  files: Array<CapabilityPackageFileEntry & { relativePath: string; bytes: Buffer; executable: boolean }>;
  directories: string[];
  checksum: string;
  totalBytes: number;
};

function invalidPath(message = 'The package path is invalid.'): never {
  throw new CapabilityPackageError('PACKAGE_PATH_INVALID', message, 400);
}

function limit(message: string): never {
  throw new CapabilityPackageError('PACKAGE_LIMIT_EXCEEDED', message, 413);
}

/** Reject unsafe input instead of silently sanitizing it into a different file. */
export function normalizeCapabilityPackageRelativePath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')
    || value.length > CAPABILITY_PACKAGE_LIMITS.maxRelativePathLength || value.startsWith('/')
    || /^[a-z]:/iu.test(value)) invalidPath();
  const segments = value.split('/');
  if (segments.length > CAPABILITY_PACKAGE_LIMITS.maxDepth
    || segments.some(segment => !segment || segment === '.' || segment === '..')) invalidPath();
  return value;
}

function assertNotSecret(relativePath: string, bytes?: Buffer): void {
  const name = path.posix.basename(relativePath).toLowerCase();
  if (protectedNames.has(name) || (name.startsWith('.env.') && !['.env.example', '.env.sample', '.env.template'].includes(name))
    || ['.pem', '.key', '.p12', '.pfx', '.jks'].includes(path.posix.extname(name))
    || name.includes('private-key')
    || /(?:^|[-_.])(credentials?|secrets?|tokens?|oauth)(?:[-_.]|$)/u.test(name)
      && /\.(?:json|ya?ml|toml|ini|conf|config)$/u.test(name)
    || bytes && /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u.test(bytes.toString('utf8'))) {
    throw new CapabilityPackageError('PACKAGE_INVALID', 'Packages must reference central secrets instead of bundling secret files.', 400);
  }
}

function identifier(reference: string, prefix: string): string {
  const match = new RegExp(`^${prefix}:(${uuidPattern})$`, 'iu').exec(reference);
  if (!match) invalidPath('The package reference is invalid.');
  return match[1].toLowerCase();
}

function validName(kind: CapabilityPackageKind, name: string): void {
  if (!(kind === 'skill' ? isValidAgentSkillName(name) : kind === 'plugin' && isValidCanvasPluginName(name))) invalidPath();
}

function ownerRoot(owner: CapabilityResourceOwnerScope): string {
  if (owner.type === 'user') return resolveUserDataRoot(owner.ownerUserId);
  if (owner.type === 'organization' || owner.type === 'team') return resolveOrganizationDataRoot(owner.organizationId);
  return path.join(resolveCanvasDataRoot(), 'system');
}

export function resolveOwnerScopedPackageVersionPath(input: {
  owner: CapabilityResourceOwnerScope; kind: CapabilityPackageKind; name: string; resourceRef: string; revisionRef: string;
}): string {
  validName(input.kind, input.name);
  return path.join(ownerRoot(input.owner), 'capability-packages', 'published', identifier(input.resourceRef, 'canvas-resource'),
    identifier(input.revisionRef, 'canvas-package-revision'), input.name);
}

export function resolveCapabilityPackageDraftLocation(input: Omit<CapabilityPackageDraftLocation, 'rootPath'>): CapabilityPackageDraftLocation {
  validName(input.kind, input.name);
  identifier(input.resourceRef, 'canvas-resource');
  if (!Number.isSafeInteger(input.draftRevision) || input.draftRevision < 1) invalidPath('The draft revision is invalid.');
  return { ...input, rootPath: path.join(resolveUserDataRoot(input.actorUserId), 'capability-packages', 'drafts',
    identifier(input.draftRef, 'canvas-package-draft'), String(input.draftRevision), input.name) };
}

function sameStats(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

async function realDirectory(rootPath: string): Promise<string> {
  const dataRoot = path.resolve(resolveCanvasDataRoot());
  const candidate = path.resolve(rootPath);
  const realDataRoot = await fs.realpath(dataRoot);
  const anchor = candidate.startsWith(`${dataRoot}${path.sep}`) ? dataRoot
    : candidate.startsWith(`${realDataRoot}${path.sep}`) ? realDataRoot : null;
  if (anchor) {
    let current = anchor;
    for (const segment of path.relative(anchor, candidate).split(path.sep)) {
      current = path.join(current, segment);
      const ancestor = await fs.lstat(current);
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) invalidPath('Managed package directories cannot be symbolic links.');
    }
  }
  const stats = await fs.lstat(rootPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) invalidPath('The package root must be a real directory.');
  return fs.realpath(rootPath);
}

async function assertFileAncestors(rootPath: string, relativePath: string): Promise<void> {
  const segments = normalizeCapabilityPackageRelativePath(relativePath).split('/');
  await realDirectory(rootPath);
  for (let index = 1; index < segments.length; index += 1) await realDirectory(path.join(rootPath, ...segments.slice(0, index)));
}

/** Read only the observed file size, never allocating an unbounded growing file. */
async function readObservedFile(filePath: string, observed: BigIntStats, budget: number): Promise<Buffer> {
  if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== BigInt(1)) invalidPath('Packages contain regular, non-linked files only.');
  if (observed.size > BigInt(Math.min(budget, CAPABILITY_PACKAGE_LIMITS.maxFileBytes))) limit('The package file or package exceeds its byte limit.');
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameStats(observed, await handle.stat({ bigint: true }))) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The package changed during reading.', 409);
    const bytes = Buffer.alloc(Number(observed.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (!read.bytesRead) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The package changed during reading.', 409);
      offset += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    if (extra.bytesRead || !sameStats(observed, await handle.stat({ bigint: true }))) {
      throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The package changed during reading.', 409);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function makeRealDirectories(directory: string): Promise<void> {
  const resolved = path.resolve(directory), dataRoot = path.resolve(resolveCanvasDataRoot());
  let existing = resolved;
  const missing: string[] = [];
  while (!(await fs.lstat(existing).catch(() => null))) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  if (resolved.startsWith(`${dataRoot}${path.sep}`)) await realDirectory(existing);
  let current = await realDirectory(existing);
  for (const part of missing) {
    current = path.join(current, part);
    await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await realDirectory(current);
  }
}

async function canonicalParent(targetRoot: string): Promise<string> {
  const parent = path.dirname(path.resolve(targetRoot));
  await makeRealDirectories(parent);
  return path.join(await realDirectory(parent), path.basename(targetRoot));
}

async function writeCapturedInventory(inventory: Omit<ExactCapabilityPackageInventory, 'checksum'>, targetRoot: string): Promise<string> {
  const canonical = await canonicalParent(targetRoot);
  await fs.mkdir(canonical, { mode: 0o700 });
  try {
    for (const directory of inventory.directories) await fs.mkdir(path.join(canonical, ...directory.split('/')), { recursive: true, mode: 0o700 });
    for (const file of inventory.files) {
      const target = path.join(canonical, ...file.relativePath.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        file.executable ? 0o700 : 0o600);
      try { await handle.writeFile(file.bytes); await handle.sync(); } finally { await handle.close(); }
    }
    return await computeCanvasPluginChecksum(canonical);
  } catch (error) {
    await fs.rm(canonical, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Internal filesystem primitive: callers resolve fresh resource authority before and after capture. */
export async function readExactPackageInventory(rootPath: string,
  budget: { maxFiles?: number; maxTotalBytes?: number } = {}): Promise<ExactCapabilityPackageInventory> {
  const maxFiles = Math.min(budget.maxFiles ?? CAPABILITY_PACKAGE_LIMITS.maxFiles, CAPABILITY_PACKAGE_LIMITS.maxFiles);
  const maxTotalBytes = Math.min(budget.maxTotalBytes ?? CAPABILITY_PACKAGE_LIMITS.maxTotalBytes, CAPABILITY_PACKAGE_LIMITS.maxTotalBytes);
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0 || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) limit('The package capture budget is invalid.');
  const root = await realDirectory(rootPath);
  const files: ExactCapabilityPackageInventory['files'] = [];
  const directories: string[] = [];
  const observations: Array<{ filePath: string; stats: BigIntStats }> = [];
  let totalBytes = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > CAPABILITY_PACKAGE_LIMITS.maxDepth) limit('The package directory depth exceeds its limit.');
    const before = await fs.lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) invalidPath();
    observations.push({ filePath: directory, stats: before });
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (ignoredEntries.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      const relativePath = normalizeCapabilityPackageRelativePath(path.relative(root, fullPath).split(path.sep).join('/'));
      const stats = await fs.lstat(fullPath, { bigint: true });
      if (stats.isSymbolicLink()) invalidPath('Package symbolic links are not supported.');
      if (stats.isDirectory()) {
        directories.push(relativePath);
        if (directories.length > CAPABILITY_PACKAGE_LIMITS.maxFiles) limit('The package contains too many directories.');
        await visit(fullPath, depth + 1);
      } else {
        if (files.length >= maxFiles) limit('The package contains too many files.');
        assertNotSecret(relativePath);
        const bytes = await readObservedFile(fullPath, stats, maxTotalBytes - totalBytes);
        assertNotSecret(relativePath, bytes);
        totalBytes += bytes.byteLength;
        files.push({ path: relativePath, relativePath, bytes, size: bytes.byteLength,
          checksum: createHash('sha256').update(bytes).digest('hex'), executable: Boolean(stats.mode & BigInt(0o111)) });
        observations.push({ filePath: fullPath, stats });
      }
    }
  }
  await visit(root, 0);
  for (const observation of observations) {
    if (!sameStats(observation.stats, await fs.lstat(observation.filePath, { bigint: true }))) {
      throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The package changed during capture.', 409);
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  directories.sort((left, right) => left.localeCompare(right));
  const captureParent = path.join(await fs.realpath(resolveCanvasDataRoot()), 'capability-packages', '.captures');
  const captureRoot = path.join(captureParent, randomUUID());
  let checksum: string;
  try { checksum = await writeCapturedInventory({ files, directories, totalBytes }, captureRoot); }
  finally { await fs.rm(captureRoot, { recursive: true, force: true }).catch(() => undefined); }
  return { files, directories, totalBytes, checksum };
}

export async function copyExactPackage(sourceRoot: string, targetRoot: string): Promise<ExactCapabilityPackageInventory> {
  const source = await fs.realpath(sourceRoot);
  const target = path.resolve(targetRoot);
  if (target === source || target.startsWith(`${source}${path.sep}`)) invalidPath('A copied package must have a separate destination.');
  const inventory = await readExactPackageInventory(sourceRoot);
  const checksum = await writeCapturedInventory(inventory, targetRoot);
  if (checksum !== inventory.checksum) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The package copy did not match the captured bytes.', 409);
  return inventory;
}

function assertDraftLocation(location: CapabilityPackageDraftLocation): void {
  const expected = resolveCapabilityPackageDraftLocation(location);
  if (location.owner.type === 'system' || path.resolve(expected.rootPath) !== path.resolve(location.rootPath)) {
    throw new CapabilityPackageError('PACKAGE_READ_ONLY', 'The draft is not a writable actor-owned location.', 403);
  }
}

type PackageSourceCopyOptions = { expectedSourceChecksum?: string; bundledReferences?: readonly {
  source: CapabilityPackagePrivateLocation; relativeTargetRoot: string; checksum: string;
}[] };

/** Internal IO only; callers must hold or revalidate the exact source's read authority. */
export async function copyCapabilityPackageSourceWithReferences(source: CapabilityPackagePrivateLocation,
  targetRoot: string, options: PackageSourceCopyOptions = {}): Promise<ExactCapabilityPackageInventory> {
  const sourceInventory = await readExactPackageInventory(source.rootPath);
  if (options.expectedSourceChecksum !== undefined && sourceInventory.checksum !== options.expectedSourceChecksum) {
    throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The source package changed before draft capture.', 409);
  }
  const references = options.bundledReferences ?? [];
  if (references.length && source.kind !== 'plugin') throw new CapabilityPackageError('PACKAGE_INVALID', 'Only plugin packages can bundle referenced skills.', 400);
  const files = [...sourceInventory.files], directories = new Set(sourceInventory.directories);
  let totalBytes = sourceInventory.totalBytes;
  let manifest: Record<string, unknown> | null = null;
  if (references.length) {
    const manifestFile = files.find(file => file.path === '.canvas-plugin/plugin.json');
    if (!manifestFile) throw new CapabilityPackageError('PACKAGE_INVALID', 'The plugin manifest is missing.', 400);
    manifest = JSON.parse(manifestFile.bytes.toString('utf8')) as Record<string, unknown>;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new CapabilityPackageError('PACKAGE_INVALID', 'The plugin manifest is invalid.', 400);
    const rawDeclared = manifest.skillRefs ?? manifest.skill_refs ?? manifest.seedSkills ?? manifest.seed_skills;
    const declared = (Array.isArray(rawDeclared) ? rawDeclared : rawDeclared === undefined ? [] : [rawDeclared])
      .map(value => typeof value === 'string' ? { name: value, source: 'seed' } : value);
    if (declared.length !== references.length) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The referenced skill set changed before capture.', 409);
    const prefix = typeof manifest.skills === 'string' && manifest.skills ? path.posix.normalize(manifest.skills) : 'skills';
    if (prefix !== '.') normalizeCapabilityPackageRelativePath(prefix);
    const seen = new Set<string>();
    for (const reference of references) {
      validName('skill', reference.source.name);
      if (reference.source.kind !== 'skill') throw new CapabilityPackageError('PACKAGE_INVALID', 'The referenced package is not a skill.', 400);
      const target = normalizeCapabilityPackageRelativePath(reference.relativeTargetRoot);
      if (target !== path.posix.join(prefix, reference.source.name) || seen.has(target)
        || !declared.some(value => value && typeof value === 'object' && (value as Record<string, unknown>).name === reference.source.name
          && (!(value as Record<string, unknown>).source || (value as Record<string, unknown>).source === 'seed'))
        || files.some(file => file.path === target || file.path.startsWith(`${target}/`) || target.startsWith(`${file.path}/`))
        || directories.has(target)) throw new CapabilityPackageError('PACKAGE_INVALID', 'The referenced skill target conflicts with the package.', 400);
      seen.add(target);
      const captured = await readExactPackageInventory(reference.source.rootPath, {
        maxFiles: CAPABILITY_PACKAGE_LIMITS.maxFiles - files.length,
        maxTotalBytes: CAPABILITY_PACKAGE_LIMITS.maxTotalBytes - totalBytes,
      });
      if (captured.checksum !== reference.checksum) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'A referenced skill changed before draft capture.', 409);
      for (const file of captured.files) {
        const relativePath = normalizeCapabilityPackageRelativePath(`${target}/${file.path}`);
        files.push({ ...file, path: relativePath, relativePath });
      }
      directories.add(target);
      for (const directory of captured.directories) directories.add(normalizeCapabilityPackageRelativePath(`${target}/${directory}`));
      totalBytes += captured.totalBytes;
    }
    // The published package owns its complete dependency bytes. It never follows
    // seed directories again after this actor-authorized source capture.
    manifest.skills = prefix === '.' ? '.' : `./${prefix}`;
    for (const alias of ['skillRefs', 'skill_refs', 'seedSkills', 'seed_skills']) delete manifest[alias];
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    totalBytes += bytes.byteLength - manifestFile.size;
    if (totalBytes > CAPABILITY_PACKAGE_LIMITS.maxTotalBytes) limit('The package exceeds its byte limit.');
    const index = files.indexOf(manifestFile);
    files[index] = { ...manifestFile, bytes, size: bytes.byteLength, checksum: createHash('sha256').update(bytes).digest('hex') };
    if (directories.size > CAPABILITY_PACKAGE_LIMITS.maxFiles) limit('The package contains too many directories.');
  }
  // Capture all dependencies before creating any draft bytes. All subsequent
  // writes use those immutable buffers rather than rereading mutable sources.
  await writeCapturedInventory({ files, directories: [...directories].sort(), totalBytes }, targetRoot);
  return readExactPackageInventory(targetRoot);
}

export async function createCapabilityPackageDraft(source: CapabilityPackagePrivateLocation,
  draft: CapabilityPackageDraftLocation,
  options: { expectedSourceChecksum?: string; bundledReferences?: readonly {
    source: CapabilityPackagePrivateLocation; relativeTargetRoot: string; checksum: string;
  }[] } = {}): Promise<ExactCapabilityPackageInventory> {
  assertDraftLocation(draft);
  let inventory = await copyCapabilityPackageSourceWithReferences(source, draft.rootPath, options);
  if (source.name !== draft.name) {
    const relative = draft.kind === 'plugin' ? '.canvas-plugin/plugin.json' : 'SKILL.md';
    const file = inventory.files.find(entry => entry.path === relative);
    if (!file) throw new CapabilityPackageError('PACKAGE_INVALID', 'The fork manifest is missing.', 400);
    let renamed: string;
    if (draft.kind === 'plugin') {
      const manifest = JSON.parse(file.bytes.toString('utf8')) as Record<string, unknown>;
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new CapabilityPackageError('PACKAGE_INVALID', 'The plugin manifest is invalid.', 400);
      renamed = `${JSON.stringify({ ...manifest, name: draft.name }, null, 2)}\n`;
    } else {
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(file.bytes.toString('utf8'));
      const manifest = match ? YAML.parse(match[1]) as unknown : null;
      if (!match || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new CapabilityPackageError('PACKAGE_INVALID', 'The skill frontmatter is invalid.', 400);
      }
      renamed = `---\n${YAML.stringify({ ...manifest, name: draft.name }).trimEnd()}\n---\n${match[2]}`;
    }
    const handle = await fs.open(path.join(draft.rootPath, ...relative.split('/')), constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try { await handle.writeFile(renamed, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    inventory = await readExactPackageInventory(draft.rootPath);
  }
  await sealPackageDirectory(draft.rootPath, inventory);
  return inventory;
}

export async function listCapabilityPackageFiles(location: CapabilityPackagePrivateLocation): Promise<CapabilityPackageTreeEntry[]> {
  const inventory = await readExactPackageInventory(location.rootPath);
  return [...inventory.directories.map(directory => ({ path: directory, type: 'directory' as const })),
    ...inventory.files.map(({ path: filePath, size, checksum }) => ({ path: filePath, size, checksum, type: 'file' as const }))]
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function readCapabilityPackageFile(location: CapabilityPackagePrivateLocation,
  input: { path: string; offset?: number; maxBytes?: number }): Promise<CapabilityPackageFileRead> {
  const relative = normalizeCapabilityPackageRelativePath(input.path);
  assertNotSecret(relative);
  const offset = input.offset ?? 0, maxBytes = input.maxBytes ?? CAPABILITY_PACKAGE_LIMITS.maxReadBytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || maxBytes > CAPABILITY_PACKAGE_LIMITS.maxReadBytes) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The byte range is invalid.', 400);
  await assertFileAncestors(location.rootPath, relative);
  const filePath = path.join(location.rootPath, ...relative.split('/'));
  const bytes = await readObservedFile(filePath, await fs.lstat(filePath, { bigint: true }), CAPABILITY_PACKAGE_LIMITS.maxFileBytes);
  assertNotSecret(relative, bytes);
  if (offset > bytes.byteLength) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The byte offset is beyond this file.', 400);
  const selected = bytes.subarray(offset, offset + maxBytes);
  return { path: relative, encoding: 'base64', content: selected.toString('base64'), size: bytes.byteLength,
    checksum: createHash('sha256').update(bytes).digest('hex'), offset, byteLength: selected.byteLength,
    eof: offset + selected.byteLength === bytes.byteLength };
}

function decodeWrite(input: Pick<CapabilityPackageFileWrite, 'encoding' | 'content'>): Buffer {
  if (input.encoding !== 'base64' || typeof input.content !== 'string'
    || input.content.length > 4 * Math.ceil(CAPABILITY_PACKAGE_LIMITS.maxFileBytes / 3)
    || input.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.content)) {
    throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The file must be valid bounded base64.', 400);
  }
  const bytes = Buffer.from(input.content, 'base64');
  if (bytes.byteLength > CAPABILITY_PACKAGE_LIMITS.maxFileBytes) limit('The file exceeds its byte limit.');
  if (bytes.toString('base64') !== input.content) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The base64 encoding is not canonical.', 400);
  return bytes;
}

export async function writeCapabilityPackageDraftFile(location: CapabilityPackageDraftLocation,
  input: Pick<CapabilityPackageFileWrite, 'path' | 'encoding' | 'content'>): Promise<ExactCapabilityPackageInventory> {
  assertDraftLocation(location);
  const relative = normalizeCapabilityPackageRelativePath(input.path);
  const bytes = decodeWrite(input);
  assertNotSecret(relative, bytes);
  const inventory = await readExactPackageInventory(location.rootPath);
  const previous = inventory.files.find(file => file.path === relative);
  if (!previous && inventory.files.length >= CAPABILITY_PACKAGE_LIMITS.maxFiles) limit('The package contains too many files.');
  if (inventory.totalBytes - (previous?.size ?? 0) + bytes.byteLength > CAPABILITY_PACKAGE_LIMITS.maxTotalBytes) limit('The package exceeds its byte limit.');
  const next = await prepareNextDraftRevision(location, inventory);
  const target = path.join(next.rootPath, ...relative.split('/'));
  await makeRealDirectories(path.dirname(target));
  await assertFileAncestors(next.rootPath, relative);
  const current = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (current && (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1)) invalidPath();
  const temporary = path.join(path.dirname(target), `.canvas-package-write-${randomUUID()}`);
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    previous?.executable ? 0o700 : 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, target); } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  const updated = await readExactPackageInventory(next.rootPath);
  await sealPackageDirectory(next.rootPath, updated);
  return updated;
}

export async function deleteCapabilityPackageDraftFile(location: CapabilityPackageDraftLocation,
  input: { path: string }): Promise<ExactCapabilityPackageInventory> {
  assertDraftLocation(location);
  const relative = normalizeCapabilityPackageRelativePath(input.path);
  await assertFileAncestors(location.rootPath, relative);
  const target = path.join(location.rootPath, ...relative.split('/'));
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) invalidPath();
  const current = await readExactPackageInventory(location.rootPath);
  const next = await prepareNextDraftRevision(location, current);
  await fs.unlink(path.join(next.rootPath, ...relative.split('/')));
  const updated = await readExactPackageInventory(next.rootPath);
  await sealPackageDirectory(next.rootPath, updated);
  return updated;
}

async function unlockOwnedDraftTree(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.chmod(directory, 0o700);
    for (const entry of await fs.readdir(directory)) await unlockOwnedDraftTree(path.join(directory, entry));
  }
}

/** Call only inside the issued current draft/resource lock. r+1 is not referenced by SQL yet. */
async function prepareNextDraftRevision(location: CapabilityPackageDraftLocation,
  current: ExactCapabilityPackageInventory): Promise<CapabilityPackageDraftLocation> {
  assertDraftLocation(location);
  const next = resolveCapabilityPackageDraftLocation({ ...location, draftRevision: location.draftRevision + 1 });
  const revisionContainer = path.dirname(next.rootPath);
  const existing = await fs.lstat(revisionContainer).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing) {
    await realDirectory(revisionContainer);
    await unlockOwnedDraftTree(revisionContainer);
    await fs.rm(revisionContainer, { recursive: true });
  }
  const copiedChecksum = await writeCapturedInventory(current, next.rootPath);
  if (copiedChecksum !== current.checksum) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The draft copy is inconsistent.', 409);
  return next;
}

/** SQL first verifies the exact creator/ref/current revision before this owned draft cleanup. */
export async function removeCapabilityPackageDraft(location: CapabilityPackageDraftLocation): Promise<void> {
  assertDraftLocation(location);
  const container = path.dirname(path.dirname(location.rootPath));
  const existing = await fs.lstat(container).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!existing) return;
  await realDirectory(container);
  await unlockOwnedDraftTree(container);
  await fs.rm(container, { recursive: true });
}

async function sealPackageDirectory(rootPath: string, inventory: ExactCapabilityPackageInventory): Promise<void> {
  for (const file of inventory.files) await fs.chmod(path.join(rootPath, ...file.path.split('/')), file.executable ? 0o500 : 0o400);
  for (const directory of [...inventory.directories].sort((left, right) => right.length - left.length)) {
    await fs.chmod(path.join(rootPath, ...directory.split('/')), 0o500);
  }
  await fs.chmod(rootPath, 0o500);
}

function markerPath(location: CapabilityPackagePublishedLocation): string {
  return path.join(path.dirname(location.rootPath), 'published.json');
}

export async function preparePublishedSnapshot(draft: CapabilityPackageDraftLocation,
  identity: CapabilityPackageRevisionIdentity & { owner: CapabilityResourceOwnerScope },
  validation: CapabilityPackageValidation): Promise<CapabilityPackagePreparedSnapshot> {
  assertDraftLocation(draft);
  return prepareExactPublishedSnapshot(draft.rootPath, identity, validation);
}

async function prepareExactPublishedSnapshot(sourceRoot: string,
  identity: CapabilityPackageRevisionIdentity & { owner: CapabilityResourceOwnerScope },
  validation: CapabilityPackageValidation): Promise<CapabilityPackagePreparedSnapshot> {
  if (identity.owner.type === 'system') throw new CapabilityPackageError('PACKAGE_READ_ONLY', 'Bundled packages cannot be published in place.', 403);
  if (!validation.valid || validation.name !== identity.name || validation.kind !== identity.kind || validation.version !== identity.version
    || validation.checksum !== identity.checksum) throw new CapabilityPackageError('PACKAGE_INVALID', 'The validated package identity changed.', 409);
  const location: CapabilityPackagePublishedLocation = { ...identity,
    rootPath: resolveOwnerScopedPackageVersionPath(identity) };
  const inventory = await copyExactPackage(sourceRoot, location.rootPath);
  if (inventory.checksum !== identity.checksum) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The draft changed after validation.', 409);
  const marker: CapabilityPackageSnapshotMarker = { contractVersion: CAPABILITY_PACKAGE_CONTRACT_VERSION,
    resourceRef: identity.resourceRef, revisionRef: identity.revisionRef, checksum: identity.checksum };
  await fs.writeFile(markerPath(location), `${JSON.stringify(marker)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o400 });
  await sealPackageDirectory(location.rootPath, inventory);
  return { location, marker, validation };
}

/** Store publication supplies its source only through a held, private preparation context. */
export async function prepareHeldStorePackageSnapshot(
  authorization: import('./contracts').AuthorizedCapabilityPackageResource,
  identity: CapabilityPackageRevisionIdentity & { owner: CapabilityResourceOwnerScope },
  validation: CapabilityPackageValidation, database: import('@/app/lib/db').SqlConnection,
): Promise<CapabilityPackagePreparedSnapshot> {
  const { getHeldCapabilityStorePublicationSource } = await import('./store');
  const source = getHeldCapabilityStorePublicationSource(authorization, database, identity.revisionRef);
  if (identity.resourceRef !== authorization.record.metadata.resourceRef || identity.kind !== authorization.record.storage.resourceType
    || identity.name !== authorization.record.storage.name || identity.checksum !== source.checksum
    || JSON.stringify(identity.owner) !== JSON.stringify(authorization.record.metadata.ownership)) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The Store snapshot is not bound to this publication.', 403);
  }
  return prepareExactPublishedSnapshot(source.rootPath, identity, validation);
}

export async function verifyCapabilityPackageSnapshot(location: CapabilityPackagePublishedLocation,
  options: { verifyBytes?: boolean } = {}): Promise<void> {
  if (path.resolve(location.rootPath) !== path.resolve(resolveOwnerScopedPackageVersionPath(location))) invalidPath();
  await realDirectory(location.rootPath);
  const markerFile = markerPath(location);
  const bytes = await readObservedFile(markerFile, await fs.lstat(markerFile, { bigint: true }), 4096);
  let marker: CapabilityPackageSnapshotMarker;
  try { marker = JSON.parse(bytes.toString('utf8')) as CapabilityPackageSnapshotMarker; }
  catch { throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The published package snapshot is unavailable.', 409); }
  if (marker.contractVersion !== CAPABILITY_PACKAGE_CONTRACT_VERSION || marker.resourceRef !== location.resourceRef
    || marker.revisionRef !== location.revisionRef || marker.checksum !== location.checksum) {
    throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The published package binding is inconsistent.', 409);
  }
  if (options.verifyBytes !== false && (await readExactPackageInventory(location.rootPath)).checksum !== location.checksum) {
    throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The published package bytes changed.', 409);
  }
}
