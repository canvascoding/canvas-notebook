import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseDocument } from 'yaml';

const SNAPSHOT_DIR_NAME = 'agent-file-snapshots';
const MAX_DIFF_CHARS = 24_000;
const MAX_SNAPSHOT_COUNT = 500;

export type AgentFileValidationCheck = {
  name: string;
  ok: boolean;
  message: string;
};

export type AgentFileValidationResult = {
  ok: boolean;
  checks: AgentFileValidationCheck[];
};

export type AgentFileSnapshotMetadata = {
  version: 1;
  id: string;
  path: string;
  resolvedPath: string;
  existed: boolean;
  size: number;
  sha256: string | null;
  operation: string;
  createdAt: string;
};

export type AgentFileChangeResult = {
  path: string;
  resolvedPath: string;
  changed: boolean;
  snapshot: AgentFileSnapshotMetadata | null;
  beforeSha256: string | null;
  afterSha256: string;
  size: number;
  diff: string;
  validation: AgentFileValidationResult;
};

export type AgentPatchFileInput = {
  path: string;
  expectedSha256?: string;
  edits: Array<{
    oldText: string;
    newText: string;
    expectedOccurrences?: number;
  }>;
};

function getRuntimeCwd(): string {
  return Reflect.apply(process.cwd, process, []) as string;
}

export function getAgentDataRoot(): string {
  const configuredDataDir = process.env.DATA?.trim();
  if (!configuredDataDir || configuredDataDir === './data' || configuredDataDir === 'data') {
    return path.join(getRuntimeCwd(), 'data');
  }

  return path.isAbsolute(configuredDataDir)
    ? configuredDataDir
    : path.resolve(getRuntimeCwd(), configuredDataDir);
}

export function getAgentWorkspaceRoot(): string {
  return path.join(getAgentDataRoot(), 'workspace');
}

function getSnapshotRoot(): string {
  return path.join(getAgentDataRoot(), 'cache', SNAPSHOT_DIR_NAME);
}

function isPathWithin(candidatePath: string, basePath: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedBase = path.resolve(basePath);
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}${path.sep}`);
}

function getProtectedAgentPaths(): string[] {
  const dataRoot = getAgentDataRoot();
  return [
    path.join(dataRoot, 'secrets'),
    path.join(dataRoot, 'cache', SNAPSHOT_DIR_NAME),
    '/data/secrets',
    '/data/cache/agent-file-snapshots',
    '/proc',
    '/run/secrets',
    '/sys/firmware',
  ];
}

export function isProtectedAgentPath(candidatePath: string): boolean {
  return getProtectedAgentPaths().some((protectedPath) => isPathWithin(candidatePath, protectedPath));
}

export async function assertAgentPathAllowed(candidatePath: string): Promise<void> {
  if (isProtectedAgentPath(candidatePath)) {
    throw new Error('Access to this path is restricted for security reasons.');
  }

  try {
    const realPath = await fs.realpath(candidatePath);
    if (isProtectedAgentPath(realPath)) {
      throw new Error('Access to this path is restricted for security reasons.');
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function assertNearestWritableParentAllowed(candidatePath: string): Promise<void> {
  let current = path.dirname(path.resolve(candidatePath));

  while (current !== path.dirname(current)) {
    try {
      const realCurrent = await fs.realpath(current);
      if (isProtectedAgentPath(realCurrent)) {
        throw new Error('Access to this path is restricted for security reasons.');
      }
      return;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        current = path.dirname(current);
        continue;
      }
      throw error;
    }
  }

  throw new Error('Unable to resolve a writable parent directory.');
}

export async function assertAgentWritablePathAllowed(candidatePath: string): Promise<void> {
  await assertAgentPathAllowed(candidatePath);
  await assertNearestWritableParentAllowed(candidatePath);
}

export function resolveAgentPath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(getAgentWorkspaceRoot(), filePath);
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0;

  let count = 0;
  let index = 0;
  while (index <= content.length) {
    const found = content.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function applyExactEdit(
  content: string,
  edit: { oldText: string; newText: string; expectedOccurrences?: number },
  filePath: string,
): string {
  const expectedOccurrences = edit.expectedOccurrences ?? 1;
  if (!Number.isInteger(expectedOccurrences) || expectedOccurrences < 1) {
    throw new Error(`Invalid expectedOccurrences for ${filePath}. Use a positive integer.`);
  }
  if (!edit.oldText) {
    throw new Error(`oldText must not be empty for ${filePath}.`);
  }

  const occurrences = countOccurrences(content, edit.oldText);
  if (occurrences !== expectedOccurrences) {
    throw new Error(
      `Refusing to edit ${filePath}: oldText matched ${occurrences} time(s), expected ${expectedOccurrences}. No changes were written.`,
    );
  }

  return content.split(edit.oldText).join(edit.newText);
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.split('\n');
}

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n... diff truncated ...`;
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

export function createUnifiedDiff(
  before: string,
  after: string,
  beforeLabel: string,
  afterLabel: string,
): string {
  if (before === after) {
    return '(no textual changes)';
  }

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  let prefix = 0;

  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (
    beforeSuffix >= prefix &&
    afterSuffix >= prefix &&
    beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }

  const contextStart = Math.max(0, prefix - 3);
  const beforeContextEnd = Math.min(beforeLines.length - 1, beforeSuffix + 3);
  const afterContextEnd = Math.min(afterLines.length - 1, afterSuffix + 3);
  const lines = [
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    `@@ -${contextStart + 1},${Math.max(0, beforeContextEnd - contextStart + 1)} +${contextStart + 1},${Math.max(0, afterContextEnd - contextStart + 1)} @@`,
  ];

  for (let index = contextStart; index < prefix; index += 1) {
    lines.push(` ${beforeLines[index]}`);
  }
  for (let index = prefix; index <= beforeSuffix; index += 1) {
    lines.push(`-${beforeLines[index]}`);
  }
  for (let index = prefix; index <= afterSuffix; index += 1) {
    lines.push(`+${afterLines[index]}`);
  }
  for (let index = beforeSuffix + 1; index <= beforeContextEnd; index += 1) {
    if (index >= prefix && beforeLines[index] !== undefined) {
      lines.push(` ${beforeLines[index]}`);
    }
  }

  return truncateDiff(lines.join('\n'));
}

function splitMarkdownTableRow(line: string): string[] | null {
  if (!line.includes('|')) return null;

  let normalized = line.trim();
  if (normalized.startsWith('|')) normalized = normalized.slice(1);
  if (normalized.endsWith('|') && !normalized.endsWith('\\|')) normalized = normalized.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let escaped = false;

  for (const char of normalized) {
    if (char === '|' && !escaped) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
    escaped = char === '\\' && !escaped;
    if (char !== '\\') {
      escaped = false;
    }
  }

  cells.push(current.trim());
  return cells.length > 1 ? cells : null;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return Boolean(cells && cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim())));
}

function validateMarkdownTables(content: string): AgentFileValidationCheck {
  const lines = content.split('\n');
  const errors: string[] = [];
  let tableCount = 0;

  for (let index = 1; index < lines.length; index += 1) {
    if (!isMarkdownTableSeparator(lines[index])) continue;

    const headerCells = splitMarkdownTableRow(lines[index - 1]);
    const separatorCells = splitMarkdownTableRow(lines[index]);
    if (!headerCells || !separatorCells) continue;

    tableCount += 1;
    const expectedColumns = headerCells.length;
    if (separatorCells.length !== expectedColumns) {
      errors.push(`line ${index + 1}: separator has ${separatorCells.length} column(s), expected ${expectedColumns}`);
    }

    for (let rowIndex = index + 1; rowIndex < lines.length; rowIndex += 1) {
      const row = lines[rowIndex];
      if (!row.trim() || !row.includes('|')) break;
      if (isMarkdownTableSeparator(row)) break;

      const rowCells = splitMarkdownTableRow(row);
      if (!rowCells) break;
      if (rowCells.length !== expectedColumns) {
        errors.push(`line ${rowIndex + 1}: row has ${rowCells.length} column(s), expected ${expectedColumns}`);
      }
    }
  }

  return {
    name: 'markdown-tables',
    ok: errors.length === 0,
    message: errors.length === 0
      ? `Markdown table structure OK (${tableCount} table${tableCount === 1 ? '' : 's'} checked).`
      : errors.join('; '),
  };
}

export function validateAgentFileContent(filePath: string, content: string): AgentFileValidationResult {
  const extension = path.extname(filePath).toLowerCase();
  const checks: AgentFileValidationCheck[] = [];

  if (['.md', '.mdx', '.markdown'].includes(extension)) {
    checks.push(validateMarkdownTables(content));
  }

  if (extension === '.json') {
    try {
      JSON.parse(content);
      checks.push({ name: 'json-parse', ok: true, message: 'JSON syntax OK.' });
    } catch (error) {
      checks.push({
        name: 'json-parse',
        ok: false,
        message: error instanceof Error ? error.message : 'Invalid JSON syntax.',
      });
    }
  }

  if (['.yaml', '.yml'].includes(extension)) {
    const document = parseDocument(content, { prettyErrors: false });
    checks.push({
      name: 'yaml-parse',
      ok: document.errors.length === 0,
      message: document.errors.length === 0
        ? 'YAML syntax OK.'
        : document.errors.map((error) => error.message).join('; '),
    });
  }

  if (checks.length === 0) {
    checks.push({ name: 'read-after-write', ok: true, message: 'No file-type-specific validator configured; read-after-write will verify exact bytes.' });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

async function ensureSnapshotRoot(): Promise<string> {
  const root = getSnapshotRoot();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

function snapshotMetadataPath(snapshotId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(snapshotId)) {
    throw new Error('Invalid snapshot ID.');
  }
  return path.join(getSnapshotRoot(), `${snapshotId}.json`);
}

function snapshotContentPath(snapshotId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(snapshotId)) {
    throw new Error('Invalid snapshot ID.');
  }
  return path.join(getSnapshotRoot(), `${snapshotId}.bin`);
}

async function readSnapshotMetadata(snapshotId: string): Promise<AgentFileSnapshotMetadata> {
  const raw = await fs.readFile(snapshotMetadataPath(snapshotId), 'utf8');
  return JSON.parse(raw) as AgentFileSnapshotMetadata;
}

async function listAllSnapshotMetadata(): Promise<AgentFileSnapshotMetadata[]> {
  const root = getSnapshotRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  const metadata = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.json'))
      .map(async (entry) => {
        try {
          const raw = await fs.readFile(path.join(root, entry), 'utf8');
          return JSON.parse(raw) as AgentFileSnapshotMetadata;
        } catch {
          return null;
        }
      }),
  );

  return metadata
    .filter((entry): entry is AgentFileSnapshotMetadata => Boolean(entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function pruneSnapshots(): Promise<void> {
  const snapshots = await listAllSnapshotMetadata();
  const stale = snapshots.slice(MAX_SNAPSHOT_COUNT);
  await Promise.allSettled(
    stale.map(async (snapshot) => {
      await fs.rm(snapshotMetadataPath(snapshot.id), { force: true });
      await fs.rm(snapshotContentPath(snapshot.id), { force: true });
    }),
  );
}

async function createSnapshotFromBuffer(params: {
  inputPath: string;
  fullPath: string;
  existed: boolean;
  beforeBuffer: Buffer | null;
  operation: string;
}): Promise<AgentFileSnapshotMetadata> {
  const root = await ensureSnapshotRoot();
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const metadata: AgentFileSnapshotMetadata = {
    version: 1,
    id,
    path: params.inputPath,
    resolvedPath: path.resolve(params.fullPath),
    existed: params.existed,
    size: params.beforeBuffer?.length ?? 0,
    sha256: params.beforeBuffer ? sha256Buffer(params.beforeBuffer) : null,
    operation: params.operation,
    createdAt: new Date().toISOString(),
  };

  if (params.beforeBuffer) {
    await fs.writeFile(path.join(root, `${id}.bin`), params.beforeBuffer, { mode: 0o600 });
  }
  await fs.writeFile(path.join(root, `${id}.json`), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  void pruneSnapshots().catch(() => {});
  return metadata;
}

async function readExistingFile(fullPath: string): Promise<{ existed: boolean; buffer: Buffer | null }> {
  try {
    return { existed: true, buffer: await fs.readFile(fullPath) };
  } catch (error) {
    if (isEnoent(error)) {
      return { existed: false, buffer: null };
    }
    throw error;
  }
}

async function commitTextChange(params: {
  inputPath: string;
  fullPath: string;
  beforeBuffer: Buffer | null;
  beforeExisted: boolean;
  nextContent: string;
  operation: string;
  enforceValidation: boolean;
}): Promise<AgentFileChangeResult> {
  const beforeContent = params.beforeBuffer?.toString('utf8') ?? '';
  const beforeSha256 = params.beforeBuffer ? sha256Buffer(params.beforeBuffer) : null;
  const validation = validateAgentFileContent(params.inputPath, params.nextContent);
  if (params.enforceValidation && !validation.ok) {
    throw new Error(`Refusing to write ${params.inputPath}: validation failed. ${validation.checks.map((check) => check.message).join(' ')}`);
  }

  if (params.beforeExisted && beforeContent === params.nextContent) {
    return {
      path: params.inputPath,
      resolvedPath: params.fullPath,
      changed: false,
      snapshot: null,
      beforeSha256,
      afterSha256: beforeSha256 ?? sha256Text(params.nextContent),
      size: Buffer.byteLength(params.nextContent, 'utf8'),
      diff: '(no textual changes)',
      validation,
    };
  }

  await assertAgentWritablePathAllowed(params.fullPath);
  await fs.mkdir(path.dirname(params.fullPath), { recursive: true });
  const snapshot = await createSnapshotFromBuffer({
    inputPath: params.inputPath,
    fullPath: params.fullPath,
    existed: params.beforeExisted,
    beforeBuffer: params.beforeBuffer,
    operation: params.operation,
  });

  await fs.writeFile(params.fullPath, params.nextContent, 'utf8');
  const readBack = await fs.readFile(params.fullPath);
  const readBackText = readBack.toString('utf8');
  if (readBackText !== params.nextContent) {
    throw new Error(`Read-after-write verification failed for ${params.inputPath}.`);
  }

  return {
    path: params.inputPath,
    resolvedPath: params.fullPath,
    changed: true,
    snapshot,
    beforeSha256,
    afterSha256: sha256Buffer(readBack),
    size: readBack.length,
    diff: createUnifiedDiff(beforeContent, readBackText, `${params.inputPath} (before)`, `${params.inputPath} (after)`),
    validation,
  };
}

export async function writeAgentTextFile(params: {
  path: string;
  content: string;
  expectedSha256?: string;
  operation?: string;
}): Promise<AgentFileChangeResult> {
  const fullPath = resolveAgentPath(params.path);
  await assertAgentWritablePathAllowed(fullPath);
  const before = await readExistingFile(fullPath);
  const beforeSha256 = before.buffer ? sha256Buffer(before.buffer) : null;

  if (params.expectedSha256 && beforeSha256 !== params.expectedSha256) {
    throw new Error(`Refusing to write ${params.path}: expectedSha256 did not match current file hash.`);
  }

  return commitTextChange({
    inputPath: params.path,
    fullPath,
    beforeBuffer: before.buffer,
    beforeExisted: before.existed,
    nextContent: params.content,
    operation: params.operation ?? 'write',
    enforceValidation: true,
  });
}

export async function editAgentFile(params: {
  path: string;
  oldText: string;
  newText: string;
  expectedOccurrences?: number;
  expectedSha256?: string;
}): Promise<AgentFileChangeResult> {
  const fullPath = resolveAgentPath(params.path);
  await assertAgentPathAllowed(fullPath);
  const before = await readExistingFile(fullPath);
  if (!before.existed || !before.buffer) {
    throw new Error(`File does not exist: ${params.path}`);
  }

  const beforeSha256 = sha256Buffer(before.buffer);
  if (params.expectedSha256 && beforeSha256 !== params.expectedSha256) {
    throw new Error(`Refusing to edit ${params.path}: expectedSha256 did not match current file hash.`);
  }

  const beforeContent = before.buffer.toString('utf8');
  const nextContent = applyExactEdit(beforeContent, params, params.path);
  return commitTextChange({
    inputPath: params.path,
    fullPath,
    beforeBuffer: before.buffer,
    beforeExisted: true,
    nextContent,
    operation: 'edit_file',
    enforceValidation: true,
  });
}

export async function applyAgentFilePatch(params: { files: AgentPatchFileInput[] }): Promise<AgentFileChangeResult[]> {
  if (!Array.isArray(params.files) || params.files.length === 0) {
    throw new Error('apply_patch requires at least one file.');
  }

  const seen = new Set<string>();
  const prepared: Array<{
    inputPath: string;
    fullPath: string;
    beforeBuffer: Buffer;
    nextContent: string;
  }> = [];

  for (const file of params.files) {
    if (!Array.isArray(file.edits) || file.edits.length === 0) {
      throw new Error(`No edits provided for ${file.path}.`);
    }

    const fullPath = resolveAgentPath(file.path);
    await assertAgentPathAllowed(fullPath);
    const resolved = path.resolve(fullPath);
    if (seen.has(resolved)) {
      throw new Error(`Duplicate file in patch: ${file.path}`);
    }
    seen.add(resolved);

    const before = await readExistingFile(fullPath);
    if (!before.existed || !before.buffer) {
      throw new Error(`File does not exist: ${file.path}`);
    }

    const beforeSha256 = sha256Buffer(before.buffer);
    if (file.expectedSha256 && beforeSha256 !== file.expectedSha256) {
      throw new Error(`Refusing to patch ${file.path}: expectedSha256 did not match current file hash.`);
    }

    let nextContent = before.buffer.toString('utf8');
    for (const edit of file.edits) {
      nextContent = applyExactEdit(nextContent, edit, file.path);
    }

    const validation = validateAgentFileContent(file.path, nextContent);
    if (!validation.ok) {
      throw new Error(`Refusing to patch ${file.path}: validation failed. ${validation.checks.map((check) => check.message).join(' ')}`);
    }

    prepared.push({
      inputPath: file.path,
      fullPath,
      beforeBuffer: before.buffer,
      nextContent,
    });
  }

  const results: AgentFileChangeResult[] = [];
  for (const file of prepared) {
    results.push(await commitTextChange({
      inputPath: file.inputPath,
      fullPath: file.fullPath,
      beforeBuffer: file.beforeBuffer,
      beforeExisted: true,
      nextContent: file.nextContent,
      operation: 'apply_patch',
      enforceValidation: true,
    }));
  }

  return results;
}

export async function listAgentFileSnapshots(params: { path?: string; limit?: number } = {}): Promise<AgentFileSnapshotMetadata[]> {
  const limit = Math.max(1, Math.min(Math.trunc(params.limit ?? 20), 100));
  const resolvedFilterPath = params.path ? path.resolve(resolveAgentPath(params.path)) : null;
  if (resolvedFilterPath) {
    await assertAgentPathAllowed(resolvedFilterPath);
  }

  const snapshots = await listAllSnapshotMetadata();
  return snapshots
    .filter((snapshot) => !resolvedFilterPath || path.resolve(snapshot.resolvedPath) === resolvedFilterPath)
    .slice(0, limit);
}

export async function restoreAgentFileSnapshot(params: { snapshotId: string }): Promise<AgentFileChangeResult> {
  const snapshot = await readSnapshotMetadata(params.snapshotId);
  const fullPath = path.resolve(snapshot.resolvedPath);
  await assertAgentWritablePathAllowed(fullPath);

  const before = await readExistingFile(fullPath);
  const undoSnapshot = await createSnapshotFromBuffer({
    inputPath: snapshot.path,
    fullPath,
    existed: before.existed,
    beforeBuffer: before.buffer,
    operation: 'restore_file_snapshot',
  });

  if (!snapshot.existed) {
    await fs.rm(fullPath, { force: true });
    return {
      path: snapshot.path,
      resolvedPath: fullPath,
      changed: before.existed,
      snapshot: undoSnapshot,
      beforeSha256: before.buffer ? sha256Buffer(before.buffer) : null,
      afterSha256: sha256Text(''),
      size: 0,
      diff: before.buffer && !isProbablyBinary(before.buffer)
        ? createUnifiedDiff(before.buffer.toString('utf8'), '', `${snapshot.path} (before restore)`, `${snapshot.path} (after restore)`)
        : '(file removed; textual diff unavailable)',
      validation: { ok: true, checks: [{ name: 'restore', ok: true, message: 'Restored snapshot by removing file that did not exist before the original edit.' }] },
    };
  }

  const content = await fs.readFile(snapshotContentPath(snapshot.id));
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
  const readBack = await fs.readFile(fullPath);
  if (sha256Buffer(readBack) !== sha256Buffer(content)) {
    throw new Error(`Read-after-restore verification failed for ${snapshot.path}.`);
  }

  const beforeText = before.buffer && !isProbablyBinary(before.buffer) ? before.buffer.toString('utf8') : null;
  const afterText = !isProbablyBinary(readBack) ? readBack.toString('utf8') : null;

  return {
    path: snapshot.path,
    resolvedPath: fullPath,
    changed: true,
    snapshot: undoSnapshot,
    beforeSha256: before.buffer ? sha256Buffer(before.buffer) : null,
    afterSha256: sha256Buffer(readBack),
    size: readBack.length,
    diff: beforeText !== null && afterText !== null
      ? createUnifiedDiff(beforeText, afterText, `${snapshot.path} (before restore)`, `${snapshot.path} (after restore)`)
      : '(binary file restored; textual diff unavailable)',
    validation: validateAgentFileContent(snapshot.path, readBack.toString('utf8')),
  };
}

export function detectUnsafeBashCommand(command: string): string | null {
  const secretPatterns = [
    /\b(?:env|printenv)\b/i,
    /\bdeclare\s+-x\b/i,
    /\bset\b\s*(?:[;&|]|$)/i,
    /\bexport\b\s*(?:[;&|]|$)/i,
    /\/proc\/[^;&|`$()\s]*\/environ/i,
    /\/data\/secrets(?:\/|$)/i,
    /\/run\/secrets(?:\/|$)/i,
    /\/sys\/firmware(?:\/|$)/i,
    /Canvas-(?:Integrations|Agents)\.env/i,
    /agent-file-snapshots/i,
  ];

  if (secretPatterns.some((pattern) => pattern.test(command))) {
    return 'Commands that expose environment variables or restricted secret paths are not allowed.';
  }

  const normalized = command.replace(/\s+/g, ' ').trim();
  const mentionsManagedPath = /\/data\/(?:workspace|agents)(?:\/|$)/.test(normalized);
  const cdsIntoManagedPath = /\bcd\s+\/data\/(?:workspace|agents)(?:\/|$|\s)/.test(normalized);

  if (/\bsed\b(?=[^;&|]*\s-[A-Za-z]*i(?:\b|\.|['"]|$))/.test(normalized)) {
    return 'Unsafe in-place file edits with sed are blocked. Use edit_file or apply_patch instead.';
  }

  if (/\bperl\b(?=[^;&|]*\s-[A-Za-z0-9]*p?i(?:\b|\.|['"]|$))/.test(normalized)) {
    return 'Unsafe in-place file edits with perl are blocked. Use edit_file or apply_patch instead.';
  }

  if ((mentionsManagedPath || cdsIntoManagedPath) && /\b(?:rm|mv|cp|tee)\b/.test(normalized)) {
    return 'Shell file mutations in /data/workspace or /data/agents are blocked. Use the dedicated file tools instead.';
  }

  if ((mentionsManagedPath || cdsIntoManagedPath) && /(^|[^<>])>>?\s*(?!&)/.test(normalized)) {
    return 'Shell redirects that write workspace or agent files are blocked. Use write, edit_file, or apply_patch instead.';
  }

  return null;
}
