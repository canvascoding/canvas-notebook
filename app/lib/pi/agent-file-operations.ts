import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { parseDocument } from 'yaml';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { logger } from '@/app/lib/logging';
import { normalizeExpectedSha256 as normalizeAgentExpectedSha256 } from '@/app/lib/files/revision-guard';
import {
  syncPublicSharesAfterDelete,
  syncPublicSharesAfterMove,
  syncPublicSharesAfterWrite,
} from '@/app/lib/public-sharing/public-file-shares';
import { getAgentExecutionContext, type AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';

const SNAPSHOT_DIR_NAME = 'agent-file-snapshots';
const MAX_DIFF_CHARS = 24_000;
const DEFAULT_MAX_SNAPSHOT_COUNT = 500;
const DEFAULT_MAX_SNAPSHOT_BYTES = 250 * 1024 * 1024;
const MAX_PATH_SUMMARY_ENTRIES = 5_000;
const MAX_AUDIT_PATH_ENTRIES = 100;
const MAX_AUDIT_ENTITY_ID_LENGTH = 500;
const agentFileAuditLogger = logger.module('AgentFileAudit');

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

export type AgentPathType = 'file' | 'directory' | 'other' | 'missing' | 'mixed';

export type AgentPathOperationEntry = {
  sourcePath: string;
  destinationPath?: string;
  sourceResolvedPath: string;
  destinationResolvedPath?: string;
  type: AgentPathType;
  changed: boolean;
  overwritten: boolean;
  bytes: number;
  files: number;
  directories: number;
  truncated: boolean;
};

export type AgentPathOperationResult = {
  operation: 'copy_path' | 'move_path' | 'delete_path';
  sourcePath: string;
  sourcePaths: string[];
  destinationPath?: string;
  sourceResolvedPath: string;
  sourceResolvedPaths: string[];
  destinationResolvedPath?: string;
  type: AgentPathType;
  changed: boolean;
  overwritten: boolean;
  bytes: number;
  files: number;
  directories: number;
  truncated: boolean;
  entries: AgentPathOperationEntry[];
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
  const executionContext = getAgentExecutionContext();
  if (executionContext?.workspaceRoot) {
    return executionContext.workspaceRoot;
  }

  return path.join(getAgentDataRoot(), 'workspace');
}

function getSnapshotRoot(): string {
  return path.join(getAgentDataRoot(), 'cache', SNAPSHOT_DIR_NAME);
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function getMaxSnapshotCount(): number {
  return readPositiveIntegerEnv('AGENT_FILE_SNAPSHOT_MAX_COUNT', DEFAULT_MAX_SNAPSHOT_COUNT);
}

function getMaxSnapshotBytes(): number {
  return readPositiveIntegerEnv('AGENT_FILE_SNAPSHOT_MAX_BYTES', DEFAULT_MAX_SNAPSHOT_BYTES);
}

function isPathWithin(candidatePath: string, basePath: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedBase = path.resolve(basePath);
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}${path.sep}`);
}

function rootPathVariants(rootPath: string): string[] {
  const variants = new Set([path.resolve(rootPath)]);
  try {
    if (existsSync(rootPath)) {
      variants.add(realpathSync(rootPath));
    }
  } catch {
    // Keep the configured path variant when the root cannot be resolved synchronously.
  }
  return [...variants];
}

function isPathWithinRootVariants(candidatePath: string, rootPath: string): boolean {
  return rootPathVariants(rootPath).some((rootVariant) => isPathWithin(candidatePath, rootVariant));
}

function isPathWithinAnyRootVariant(candidatePath: string, rootPaths: string[]): boolean {
  return rootPaths.some((rootPath) => isPathWithinRootVariants(candidatePath, rootPath));
}

function getLegacyWorkspaceRoots(): string[] {
  const dataRoot = getAgentDataRoot();
  return [
    path.join(dataRoot, 'workspace'),
    '/data/workspace',
  ];
}

function getAllowedRuntimeReadRoots(): string[] {
  const dataRoot = getAgentDataRoot();
  return [
    path.join(dataRoot, 'user-uploads'),
    path.join(dataRoot, 'studio'),
    '/data/user-uploads',
    '/data/studio',
  ];
}

function isAllowedRuntimeReadPath(candidatePath: string): boolean {
  return isPathWithinAnyRootVariant(candidatePath, getAllowedRuntimeReadRoots());
}

function assertContextWorkspaceReadAllowed(candidatePath: string): void {
  const executionContext = getAgentExecutionContext();
  if (!executionContext) return;

  const resolvedPath = path.resolve(candidatePath);
  if (isPathWithinRootVariants(resolvedPath, executionContext.workspaceRoot) || isAllowedRuntimeReadPath(resolvedPath)) {
    return;
  }

  throw new Error('Agent file access is limited to the workspace bound to this chat session or trusted runtime intake paths.');
}

async function assertContextWorkspaceWriteAllowed(candidatePath: string): Promise<void> {
  const executionContext = getAgentExecutionContext();
  if (!executionContext) return;

  const workspaceRoot = path.resolve(executionContext.workspaceRoot);
  const resolvedPath = path.resolve(candidatePath);
  if (!isPathWithin(resolvedPath, workspaceRoot)) {
    throw new Error('Agent file writes are limited to the workspace bound to this chat session.');
  }

  if (!executionContext.canWrite) {
    throw new Error('Agent file writes are disabled for the active workspace.');
  }

  const workspaceRootRealPath = await resolveWorkspaceRootRealPath(workspaceRoot);
  try {
    const realPath = await fs.realpath(resolvedPath);
    if (!isPathWithin(realPath, workspaceRootRealPath)) {
      throw new Error('Agent file writes are limited to the workspace bound to this chat session.');
    }
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }

    const realParent = await resolveNearestExistingParentPath(resolvedPath);
    if (!isPathWithin(realParent, workspaceRootRealPath)) {
      throw new Error('Agent file writes are limited to the workspace bound to this chat session.');
    }
  }
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
  assertContextWorkspaceReadAllowed(candidatePath);

  if (isProtectedAgentPath(candidatePath)) {
    throw new Error('Access to this path is restricted for security reasons.');
  }

  try {
    const realPath = await fs.realpath(candidatePath);
    assertContextWorkspaceReadAllowed(realPath);
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

async function resolveNearestExistingParentPath(candidatePath: string): Promise<string> {
  let current = path.dirname(path.resolve(candidatePath));

  while (current !== path.dirname(current)) {
    try {
      return await fs.realpath(current);
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

async function resolveWorkspaceRootRealPath(workspaceRoot: string): Promise<string> {
  try {
    return await fs.realpath(workspaceRoot);
  } catch (error) {
    if (isEnoent(error)) {
      return path.resolve(workspaceRoot);
    }
    throw error;
  }
}

async function assertNearestWritableParentAllowed(candidatePath: string): Promise<void> {
  const realParent = await resolveNearestExistingParentPath(candidatePath);
  if (isProtectedAgentPath(realParent)) {
    throw new Error('Access to this path is restricted for security reasons.');
  }
}

export async function assertAgentWritablePathAllowed(candidatePath: string): Promise<void> {
  await assertContextWorkspaceWriteAllowed(candidatePath);
  await assertAgentPathAllowed(candidatePath);
  await assertNearestWritableParentAllowed(candidatePath);
}

function assertValidAgentPathInput(filePath: string): void {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Agent file path must be a non-empty string.');
  }
  if (filePath.includes('\0')) {
    throw new Error('Agent file path contains an invalid null byte.');
  }
}

function relativePathWithin(candidatePath: string, basePath: string): string | null {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedBase = path.resolve(basePath);
  const relativePath = path.relative(normalizedBase, normalizedCandidate);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return normalizedCandidate === normalizedBase ? '.' : null;
  }
  return relativePath;
}

function auditPathReference(fullPath: string, executionContext: AgentExecutionContext | null): string {
  const resolvedPath = path.resolve(fullPath);
  if (!executionContext?.workspaceRoot) {
    return resolvedPath;
  }

  const workspaceRelativePath = relativePathWithin(resolvedPath, executionContext.workspaceRoot);
  return workspaceRelativePath ?? resolvedPath;
}

function auditResolvedPathReference(value: string, executionContext: AgentExecutionContext | null): string {
  return path.isAbsolute(value) ? auditPathReference(value, executionContext) : value;
}

function auditWorkspaceMetadata(executionContext: AgentExecutionContext | null) {
  if (!executionContext) return null;
  return {
    workspaceId: executionContext.workspaceId,
    workspaceType: executionContext.workspaceType,
    workspaceName: executionContext.workspaceName,
    workspaceRootRelativePath: executionContext.workspaceRootRelativePath,
    legacy: executionContext.legacy,
  };
}

function activeWorkspaceRequiresRevisionGuard(): boolean {
  const executionContext = getAgentExecutionContext();
  return executionContext?.workspaceType === 'team' || executionContext?.workspaceType === 'project';
}

function assertAgentSharedWorkspaceRevision(params: {
  operation: string;
  path: string;
  beforeExisted: boolean;
  expectedSha256?: string | null;
}): void {
  if (!params.beforeExisted || !activeWorkspaceRequiresRevisionGuard()) return;
  if (normalizeAgentExpectedSha256(params.expectedSha256)) return;

  throw new Error(
    `Refusing to ${params.operation} ${params.path}: existing shared workspace files require expectedSha256. Read the file first and retry with the current SHA-256 hash.`,
  );
}

async function recordAgentFileChangeAudit(result: AgentFileChangeResult, operation: string): Promise<void> {
  if (!result.changed) return;

  const executionContext = getAgentExecutionContext();
  if (!executionContext) {
    agentFileAuditLogger.warn('Skipping agent file audit without execution context', {
      operation,
      path: result.path,
    });
    return;
  }

  await recordAuditEvent({
    organizationId: executionContext.organizationId,
    customerId: executionContext.customerId,
    projectId: executionContext.projectId,
    workspaceId: executionContext.workspaceId,
    userId: executionContext.userId,
    sessionId: executionContext.sessionId,
    agentId: executionContext.agentId,
    source: 'agent_tool',
    eventType: 'file',
    entityType: 'workspace_file',
    entityId: result.path,
    action: `agent_file.${operation}`,
    status: 'success',
    summary: `Agent file ${operation} changed ${result.path}.`,
    metadata: {
      path: result.path,
      resolvedPath: auditPathReference(result.resolvedPath, executionContext),
      workspace: auditWorkspaceMetadata(executionContext),
      revision: {
        snapshotId: result.snapshot?.id ?? null,
        snapshotOperation: result.snapshot?.operation ?? null,
        snapshotExisted: result.snapshot?.existed ?? null,
        beforeSha256: result.beforeSha256,
        afterSha256: result.afterSha256,
      },
      size: result.size,
      validation: {
        ok: result.validation.ok,
        checks: result.validation.checks.map((check) => ({
          name: check.name,
          ok: check.ok,
          message: check.message,
        })),
      },
    },
    inputHash: result.beforeSha256,
    outputHash: result.afterSha256,
    artifactRef: result.snapshot ? `agent-file-snapshot:${result.snapshot.id}` : null,
  });
}

function summarizeAuditPathEntries(entries: AgentPathOperationEntry[], executionContext: AgentExecutionContext | null) {
  return entries.slice(0, MAX_AUDIT_PATH_ENTRIES).map((entry) => ({
    sourcePath: entry.sourcePath,
    destinationPath: entry.destinationPath,
    sourceResolvedPath: auditPathReference(entry.sourceResolvedPath, executionContext),
    destinationResolvedPath: entry.destinationResolvedPath
      ? auditPathReference(entry.destinationResolvedPath, executionContext)
      : undefined,
    type: entry.type,
    changed: entry.changed,
    overwritten: entry.overwritten,
    bytes: entry.bytes,
    files: entry.files,
    directories: entry.directories,
    truncated: entry.truncated,
  }));
}

function truncateAuditEntityId(entityId: string): string {
  if (entityId.length <= MAX_AUDIT_ENTITY_ID_LENGTH) return entityId;
  return `${entityId.slice(0, MAX_AUDIT_ENTITY_ID_LENGTH - 3)}...`;
}

function pathOperationEntityId(result: AgentPathOperationResult): string {
  const paths = result.operation === 'delete_path'
    ? result.entries.map((entry) => entry.sourcePath)
    : result.entries.map((entry) => entry.destinationPath ?? entry.sourcePath);
  return truncateAuditEntityId(paths.join(', '));
}

async function recordAgentPathOperationAudit(result: AgentPathOperationResult): Promise<void> {
  if (!result.changed) return;

  const executionContext = getAgentExecutionContext();
  if (!executionContext) {
    agentFileAuditLogger.warn('Skipping agent path audit without execution context', {
      operation: result.operation,
      sourcePath: result.sourcePath,
      destinationPath: result.destinationPath,
    });
    return;
  }

  await recordAuditEvent({
    organizationId: executionContext.organizationId,
    customerId: executionContext.customerId,
    projectId: executionContext.projectId,
    workspaceId: executionContext.workspaceId,
    userId: executionContext.userId,
    sessionId: executionContext.sessionId,
    agentId: executionContext.agentId,
    source: 'agent_tool',
    eventType: 'file',
    entityType: 'workspace_path',
    entityId: pathOperationEntityId(result),
    action: `agent_path.${result.operation}`,
    status: 'success',
    summary: `Agent path ${result.operation} changed ${result.destinationPath ?? result.sourcePath}.`,
    metadata: {
      operation: result.operation,
      sourcePath: result.sourcePath,
      sourcePaths: result.sourcePaths,
      destinationPath: result.destinationPath,
      sourceResolvedPath: auditResolvedPathReference(result.sourceResolvedPath, executionContext),
      sourceResolvedPaths: result.sourceResolvedPaths.map((sourcePath) => auditPathReference(sourcePath, executionContext)),
      destinationResolvedPath: result.destinationResolvedPath
        ? auditPathReference(result.destinationResolvedPath, executionContext)
        : null,
      workspace: auditWorkspaceMetadata(executionContext),
      type: result.type,
      overwritten: result.overwritten,
      bytes: result.bytes,
      files: result.files,
      directories: result.directories,
      truncated: result.truncated,
      entries: summarizeAuditPathEntries(result.entries, executionContext),
      entriesTruncated: result.entries.length > MAX_AUDIT_PATH_ENTRIES,
      totalEntries: result.entries.length,
    },
  });
}

function resolveLegacyWorkspaceAlias(filePath: string): string | null {
  const workspaceRoot = getAgentWorkspaceRoot();
  for (const legacyRoot of getLegacyWorkspaceRoots()) {
    const relativePath = relativePathWithin(filePath, legacyRoot);
    if (relativePath) {
      return relativePath === '.'
        ? workspaceRoot
        : path.join(workspaceRoot, relativePath);
    }
  }
  return null;
}

export function resolveAgentPath(filePath: string): string {
  assertValidAgentPathInput(filePath);
  const trimmedPath = filePath.trim();
  if (!path.isAbsolute(trimmedPath)) {
    return path.join(getAgentWorkspaceRoot(), trimmedPath);
  }

  return resolveLegacyWorkspaceAlias(trimmedPath) ?? path.resolve(trimmedPath);
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
  const maxCount = getMaxSnapshotCount();
  const maxBytes = getMaxSnapshotBytes();
  const stale = new Set<AgentFileSnapshotMetadata>(snapshots.slice(maxCount));
  let runningBytes = 0;

  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    if (!snapshot) continue;
    if (stale.has(snapshot)) continue;
    if (index === 0) {
      runningBytes += snapshot.size;
      continue;
    }
    if (runningBytes + snapshot.size > maxBytes) {
      stale.add(snapshot);
      continue;
    }
    runningBytes += snapshot.size;
  }

  await Promise.allSettled(
    [...stale].map(async (snapshot) => {
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
  await pruneSnapshots().catch(() => undefined);
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
  await syncPublicSharesAfterWrite([params.fullPath]);

  const result: AgentFileChangeResult = {
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
  await recordAgentFileChangeAudit(result, params.operation);
  return result;
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
  const expectedSha256 = normalizeAgentExpectedSha256(params.expectedSha256);
  assertAgentSharedWorkspaceRevision({
    operation: params.operation ?? 'write',
    path: params.path,
    beforeExisted: before.existed,
    expectedSha256,
  });

  if (expectedSha256 && beforeSha256 !== expectedSha256) {
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
  const expectedSha256 = normalizeAgentExpectedSha256(params.expectedSha256);
  assertAgentSharedWorkspaceRevision({
    operation: 'edit_file',
    path: params.path,
    beforeExisted: before.existed,
    expectedSha256,
  });

  if (expectedSha256 && beforeSha256 !== expectedSha256) {
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
    const expectedSha256 = normalizeAgentExpectedSha256(file.expectedSha256);
    assertAgentSharedWorkspaceRevision({
      operation: 'patch',
      path: file.path,
      beforeExisted: before.existed,
      expectedSha256,
    });

    if (expectedSha256 && beforeSha256 !== expectedSha256) {
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
    await syncPublicSharesAfterDelete([fullPath]);
    const result: AgentFileChangeResult = {
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
    await recordAgentFileChangeAudit(result, 'restore_file_snapshot');
    return result;
  }

  const content = await fs.readFile(snapshotContentPath(snapshot.id));
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
  const readBack = await fs.readFile(fullPath);
  if (sha256Buffer(readBack) !== sha256Buffer(content)) {
    throw new Error(`Read-after-restore verification failed for ${snapshot.path}.`);
  }
  await syncPublicSharesAfterWrite([fullPath]);

  const beforeText = before.buffer && !isProbablyBinary(before.buffer) ? before.buffer.toString('utf8') : null;
  const afterText = !isProbablyBinary(readBack) ? readBack.toString('utf8') : null;

  const result: AgentFileChangeResult = {
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
  await recordAgentFileChangeAudit(result, 'restore_file_snapshot');
  return result;
}

function getPathType(stats: Stats): AgentPathType {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return 'other';
}

async function summarizePath(fullPath: string): Promise<{
  type: AgentPathType;
  bytes: number;
  files: number;
  directories: number;
  truncated: boolean;
}> {
  const stats = await fs.stat(fullPath);
  const type = getPathType(stats);

  if (!stats.isDirectory()) {
    return {
      type,
      bytes: stats.size,
      files: stats.isFile() ? 1 : 0,
      directories: 0,
      truncated: false,
    };
  }

  let bytes = 0;
  let files = 0;
  let directories = 1;
  let entriesSeen = 0;
  let truncated = false;
  const pending = [fullPath];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_PATH_SUMMARY_ENTRIES) {
        truncated = true;
        pending.length = 0;
        break;
      }

      const entryPath = path.join(current, entry.name);
      const entryStats = await fs.stat(entryPath);
      if (entry.isDirectory()) {
        directories += 1;
        pending.push(entryPath);
      } else if (entry.isFile()) {
        files += 1;
        bytes += entryStats.size;
      } else {
        bytes += entryStats.size;
      }
    }
  }

  return { type, bytes, files, directories, truncated };
}

async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await fs.stat(fullPath);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function assertDestinationIsNotInsideSource(sourcePath: string, destinationPath: string, sourceType: AgentPathOperationResult['type']): void {
  if (sourceType === 'directory' && isPathWithin(destinationPath, sourcePath)) {
    throw new Error('Destination must not be inside the source directory.');
  }
}

function normalizePathList(paths: string[], fieldName: string): string[] {
  const normalized = paths.map((pathValue) => pathValue.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must include at least one path.`);
  }
  return normalized;
}

function pathOperationSummary(
  operation: AgentPathOperationResult['operation'],
  entries: AgentPathOperationEntry[],
  destinationPath?: string,
  destinationResolvedPath?: string,
): AgentPathOperationResult {
  if (entries.length === 0) {
    throw new Error('Path operation result must include at least one entry.');
  }

  const typeSet = new Set(entries.map((entry) => entry.type));
  const aggregateType: AgentPathType = typeSet.size === 1 ? entries[0].type : 'mixed';
  const sourcePath = entries.length === 1 ? entries[0].sourcePath : `${entries.length} paths`;
  const sourceResolvedPath = entries.length === 1 ? entries[0].sourceResolvedPath : `${entries.length} paths`;

  return {
    operation,
    sourcePath,
    sourcePaths: entries.map((entry) => entry.sourcePath),
    destinationPath,
    sourceResolvedPath,
    sourceResolvedPaths: entries.map((entry) => entry.sourceResolvedPath),
    destinationResolvedPath,
    type: aggregateType,
    changed: entries.some((entry) => entry.changed),
    overwritten: entries.some((entry) => entry.overwritten),
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    files: entries.reduce((total, entry) => total + entry.files, 0),
    directories: entries.reduce((total, entry) => total + entry.directories, 0),
    truncated: entries.some((entry) => entry.truncated),
    entries,
  };
}

function getDestinationPathForSource(destinationDirectoryPath: string, sourcePath: string): string {
  const baseName = path.basename(path.resolve(sourcePath));
  if (!baseName || baseName === path.sep) {
    throw new Error(`Unable to derive destination name for ${sourcePath}.`);
  }
  return path.join(destinationDirectoryPath, baseName);
}

async function assertDestinationDirectoryAvailable(destinationFullPath: string, destinationPath: string): Promise<void> {
  if (await pathExists(destinationFullPath)) {
    const stats = await fs.stat(destinationFullPath);
    if (!stats.isDirectory()) {
      throw new Error(`Destination must be a directory when multiple sources are provided: ${destinationPath}`);
    }
  }
}

function assertNoDuplicateDestinations(entries: AgentPathOperationEntry[]): void {
  const destinations = new Set<string>();
  for (const entry of entries) {
    if (!entry.destinationResolvedPath) continue;
    if (destinations.has(entry.destinationResolvedPath)) {
      throw new Error(`Multiple sources resolve to the same destination: ${entry.destinationPath}`);
    }
    destinations.add(entry.destinationResolvedPath);
  }
}

function assertNoNestedCopyMoveSources(entries: AgentPathOperationEntry[]): void {
  for (const parentEntry of entries) {
    if (parentEntry.type !== 'directory') continue;
    for (const childEntry of entries) {
      if (parentEntry === childEntry) continue;
      if (isPathWithin(childEntry.sourceResolvedPath, parentEntry.sourceResolvedPath)) {
        throw new Error('Multiple sources must not include paths nested under another source directory.');
      }
    }
  }
}

export async function copyAgentPath(params: {
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
  recursive?: boolean;
}): Promise<AgentPathOperationResult> {
  return copyAgentPaths({
    sourcePaths: [params.sourcePath],
    destinationPath: params.destinationPath,
    overwrite: params.overwrite,
    recursive: params.recursive,
  });
}

export async function copyAgentPaths(params: {
  sourcePaths: string[];
  destinationPath: string;
  overwrite?: boolean;
  recursive?: boolean;
}): Promise<AgentPathOperationResult> {
  const sourcePaths = normalizePathList(params.sourcePaths, 'sourcePaths');
  const multipleSources = sourcePaths.length > 1;
  const destinationFullPath = resolveAgentPath(params.destinationPath);
  await assertAgentWritablePathAllowed(destinationFullPath);

  if (multipleSources) {
    await assertDestinationDirectoryAvailable(destinationFullPath, params.destinationPath);
  }

  const entries: AgentPathOperationEntry[] = [];
  for (const sourcePath of sourcePaths) {
    const sourceFullPath = resolveAgentPath(sourcePath);
    await assertAgentPathAllowed(sourceFullPath);

    const summary = await summarizePath(sourceFullPath);
    if (summary.type === 'directory' && params.recursive === false) {
      throw new Error('Source is a directory. Set recursive to true to copy directories.');
    }

    const entryDestinationPath = multipleSources
      ? getDestinationPathForSource(params.destinationPath, sourcePath)
      : params.destinationPath;
    const entryDestinationFullPath = multipleSources
      ? getDestinationPathForSource(destinationFullPath, sourceFullPath)
      : destinationFullPath;
    await assertAgentWritablePathAllowed(entryDestinationFullPath);

    if (path.resolve(sourceFullPath) === path.resolve(entryDestinationFullPath)) {
      throw new Error('Source and destination must be different paths.');
    }
    assertDestinationIsNotInsideSource(sourceFullPath, entryDestinationFullPath, summary.type);

    const overwritten = await pathExists(entryDestinationFullPath);
    if (overwritten && !params.overwrite) {
      throw new Error(`Destination already exists: ${entryDestinationPath}`);
    }

    entries.push({
      sourcePath,
      destinationPath: entryDestinationPath,
      sourceResolvedPath: sourceFullPath,
      destinationResolvedPath: entryDestinationFullPath,
      changed: true,
      overwritten,
      ...summary,
    });
  }

  assertNoDuplicateDestinations(entries);
  assertNoNestedCopyMoveSources(entries);

  for (const entry of entries) {
    if (!entry.destinationResolvedPath) continue;
    await fs.mkdir(path.dirname(entry.destinationResolvedPath), { recursive: true });
    if (entry.overwritten && params.overwrite) {
      await fs.rm(entry.destinationResolvedPath, { recursive: true, force: true });
    }
    await fs.cp(entry.sourceResolvedPath, entry.destinationResolvedPath, {
      recursive: entry.type === 'directory',
      force: params.overwrite === true,
      errorOnExist: params.overwrite !== true,
    });
  }
  await syncPublicSharesAfterWrite(entries.map((entry) => entry.destinationResolvedPath).filter((value): value is string => Boolean(value)));

  const result = pathOperationSummary('copy_path', entries, params.destinationPath, destinationFullPath);
  await recordAgentPathOperationAudit(result);
  return result;
}

export async function moveAgentPath(params: {
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
}): Promise<AgentPathOperationResult> {
  return moveAgentPaths({
    sourcePaths: [params.sourcePath],
    destinationPath: params.destinationPath,
    overwrite: params.overwrite,
  });
}

export async function moveAgentPaths(params: {
  sourcePaths: string[];
  destinationPath: string;
  overwrite?: boolean;
}): Promise<AgentPathOperationResult> {
  const sourcePaths = normalizePathList(params.sourcePaths, 'sourcePaths');
  const multipleSources = sourcePaths.length > 1;
  const destinationFullPath = resolveAgentPath(params.destinationPath);
  await assertAgentWritablePathAllowed(destinationFullPath);

  if (multipleSources) {
    await assertDestinationDirectoryAvailable(destinationFullPath, params.destinationPath);
  }

  const entries: AgentPathOperationEntry[] = [];
  for (const sourcePath of sourcePaths) {
    const sourceFullPath = resolveAgentPath(sourcePath);
    await assertAgentWritablePathAllowed(sourceFullPath);

    const summary = await summarizePath(sourceFullPath);
    const entryDestinationPath = multipleSources
      ? getDestinationPathForSource(params.destinationPath, sourcePath)
      : params.destinationPath;
    const entryDestinationFullPath = multipleSources
      ? getDestinationPathForSource(destinationFullPath, sourceFullPath)
      : destinationFullPath;
    await assertAgentWritablePathAllowed(entryDestinationFullPath);

    if (path.resolve(sourceFullPath) === path.resolve(entryDestinationFullPath)) {
      throw new Error('Source and destination must be different paths.');
    }
    assertDestinationIsNotInsideSource(sourceFullPath, entryDestinationFullPath, summary.type);

    const overwritten = await pathExists(entryDestinationFullPath);
    if (overwritten && !params.overwrite) {
      throw new Error(`Destination already exists: ${entryDestinationPath}`);
    }

    entries.push({
      sourcePath,
      destinationPath: entryDestinationPath,
      sourceResolvedPath: sourceFullPath,
      destinationResolvedPath: entryDestinationFullPath,
      changed: true,
      overwritten,
      ...summary,
    });
  }

  assertNoDuplicateDestinations(entries);
  assertNoNestedCopyMoveSources(entries);

  for (const entry of entries) {
    if (!entry.destinationResolvedPath) continue;
    await fs.mkdir(path.dirname(entry.destinationResolvedPath), { recursive: true });
    if (entry.overwritten && params.overwrite) {
      await fs.rm(entry.destinationResolvedPath, { recursive: true, force: true });
    }

    try {
      await fs.rename(entry.sourceResolvedPath, entry.destinationResolvedPath);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV')) {
        throw error;
      }
      await fs.cp(entry.sourceResolvedPath, entry.destinationResolvedPath, { recursive: entry.type === 'directory', force: true });
      await fs.rm(entry.sourceResolvedPath, { recursive: entry.type === 'directory', force: true });
    }
  }
  for (const entry of entries) {
    if (entry.destinationResolvedPath) {
      await syncPublicSharesAfterMove(entry.sourceResolvedPath, entry.destinationResolvedPath);
    }
  }

  const result = pathOperationSummary('move_path', entries, params.destinationPath, destinationFullPath);
  await recordAgentPathOperationAudit(result);
  return result;
}

export async function deleteAgentPath(params: {
  path: string;
  recursive?: boolean;
  ignoreMissing?: boolean;
}): Promise<AgentPathOperationResult> {
  return deleteAgentPaths({
    paths: [params.path],
    recursive: params.recursive,
    ignoreMissing: params.ignoreMissing,
  });
}

export async function deleteAgentPaths(params: {
  paths: string[];
  recursive?: boolean;
  ignoreMissing?: boolean;
}): Promise<AgentPathOperationResult> {
  const requestedPaths = normalizePathList(params.paths, 'paths');
  const seenResolvedPaths = new Set<string>();
  const entries: AgentPathOperationEntry[] = [];

  for (const requestedPath of requestedPaths) {
    const fullPath = resolveAgentPath(requestedPath);
    await assertAgentWritablePathAllowed(fullPath);
    const resolvedFullPath = path.resolve(fullPath);
    if (seenResolvedPaths.has(resolvedFullPath)) continue;
    seenResolvedPaths.add(resolvedFullPath);

    if (!(await pathExists(fullPath))) {
      if (!params.ignoreMissing) {
        throw new Error(`Path does not exist: ${requestedPath}`);
      }
      entries.push({
        sourcePath: requestedPath,
        sourceResolvedPath: fullPath,
        type: 'missing',
        changed: false,
        overwritten: false,
        bytes: 0,
        files: 0,
        directories: 0,
        truncated: false,
      });
      continue;
    }

    const summary = await summarizePath(fullPath);
    if (summary.type === 'directory' && params.recursive !== true) {
      throw new Error('Path is a directory. Set recursive to true to delete directories.');
    }

    entries.push({
      sourcePath: requestedPath,
      sourceResolvedPath: fullPath,
      changed: true,
      overwritten: false,
      ...summary,
    });
  }

  const deletableEntries = entries
    .filter((entry) => entry.changed)
    .sort((a, b) => b.sourceResolvedPath.length - a.sourceResolvedPath.length);

  for (const entry of deletableEntries) {
    await fs.rm(entry.sourceResolvedPath, {
      recursive: entry.type === 'directory',
      force: false,
    });
  }
  await syncPublicSharesAfterDelete(deletableEntries.map((entry) => entry.sourceResolvedPath));

  const result = pathOperationSummary('delete_path', entries);
  await recordAgentPathOperationAudit(result);
  return result;
}

function isManagedDataPath(target: string): boolean {
  const normalized = path.isAbsolute(target) ? path.resolve(target) : target;
  if (/^\/data\/(?:workspace|workspaces|agents)(?:\/|$)/.test(normalized)) {
    return true;
  }
  if (!path.isAbsolute(normalized)) {
    return false;
  }

  const dataRoot = getAgentDataRoot();
  const candidateRoots = [
    getAgentWorkspaceRoot(),
    path.join(dataRoot, 'workspaces'),
    path.join(dataRoot, 'agents'),
  ];
  return candidateRoots.some((candidateRoot) => isPathWithin(normalized, candidateRoot));
}

function findShellDataPathMentions(command: string): string[] {
  const mentions = new Set<string>();
  const pathPattern = /(?:^|[\s"'`=(:])((?:\/data|[^\s"'`;&|()]*\/data)\/(?:workspaces|workspace|agents|user-uploads|studio)(?:\/[^\s"'`;&|()]*)?)/g;

  for (const match of command.matchAll(pathPattern)) {
    const mention = stripShellTokenQuotes(match[1] || '').trim();
    if (mention) {
      mentions.add(mention);
    }
  }

  const executionContext = getAgentExecutionContext();
  if (executionContext?.workspaceRoot) {
    const escapedWorkspaceRoot = executionContext.workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const workspaceRootPattern = new RegExp(`(?:^|[\\s"'\\\`=(:])(${escapedWorkspaceRoot}(?:\\/[^\\s"'\\\`;&|()]*)?)`, 'g');
    for (const match of command.matchAll(workspaceRootPattern)) {
      const mention = stripShellTokenQuotes(match[1] || '').trim();
      if (mention) {
        mentions.add(mention);
      }
    }
  }

  return [...mentions];
}

function shellDataPathMentionViolatesContext(command: string): boolean {
  const executionContext = getAgentExecutionContext();
  if (!executionContext) return false;

  const workspaceRootVariants = rootPathVariants(executionContext.workspaceRoot);
  return findShellDataPathMentions(command).some((mention) => {
    const resolvedMention = path.resolve(mention);
    try {
      if (existsSync(resolvedMention)) {
        const realMention = realpathSync(resolvedMention);
        if (workspaceRootVariants.some((rootVariant) => isPathWithin(realMention, rootVariant))) {
          return false;
        }
        return true;
      }
    } catch {
      return true;
    }

    if (workspaceRootVariants.some((rootVariant) => isPathWithin(resolvedMention, rootVariant))) return false;
    if (resolveLegacyWorkspaceAlias(resolvedMention)) return false;
    return true;
  });
}

function stripShellTokenQuotes(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function findShellWriteRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  const redirectPattern = /(?:^|[^<])(?:\d*|&)?>>?\s*(?![&(])(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/g;
  for (const match of command.matchAll(redirectPattern)) {
    const target = stripShellTokenQuotes(match[1] || match[2] || match[3] || '');
    if (!target || /^&\d+$/.test(target)) continue;
    targets.push(target);
  }
  return targets;
}

function shellRedirectWritesManagedPath(command: string, cdsIntoManagedPath: boolean): boolean {
  const targets = findShellWriteRedirectTargets(command);
  if (targets.length === 0) return false;

  return targets.some((target) => {
    if (isManagedDataPath(target)) return true;
    if (path.isAbsolute(target)) return false;
    return cdsIntoManagedPath;
  });
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
  if (shellDataPathMentionViolatesContext(normalized)) {
    return 'Shell commands are limited to the workspace bound to this chat session. Use dedicated file tools for allowed non-workspace inputs.';
  }

  const executionContext = getAgentExecutionContext();
  const mentionsManagedPath = /\/data\/(?:workspace|workspaces|agents)(?:\/|$)/.test(normalized) ||
    Boolean(executionContext?.workspaceRoot && normalized.includes(executionContext.workspaceRoot));
  const cdsIntoManagedPath = /\bcd\s+\/data\/(?:workspace|workspaces|agents)(?:\/|$|\s)/.test(normalized);

  if (/\bsed\b(?=[^;&|]*\s-[A-Za-z]*i(?:\b|\.|['"]|$))/.test(normalized)) {
    return 'Unsafe in-place file edits with sed are blocked. Use edit_file or apply_patch instead.';
  }

  if (/\bperl\b(?=[^;&|]*\s-[A-Za-z0-9]*p?i(?:\b|\.|['"]|$))/.test(normalized)) {
    return 'Unsafe in-place file edits with perl are blocked. Use edit_file or apply_patch instead.';
  }

  if ((mentionsManagedPath || cdsIntoManagedPath) && /\btee\b/.test(normalized)) {
    return 'Shell file writes with tee in workspace or agent paths are blocked. Use write, edit_file, or apply_patch instead.';
  }

  if ((mentionsManagedPath || cdsIntoManagedPath) && shellRedirectWritesManagedPath(normalized, cdsIntoManagedPath)) {
    return 'Shell redirects that write workspace or agent files are blocked. Use write, edit_file, or apply_patch instead.';
  }

  return null;
}
