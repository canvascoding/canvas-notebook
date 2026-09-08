import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizeDataScopeId, resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';

const DEFAULT_AGENT_RUNTIME_TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;
const MIN_AGENT_RUNTIME_TEMP_RETENTION_MS = 60 * 60 * 1000;
const AGENT_RUNTIME_TEMP_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_AGENT_RUNTIME_TEMP_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_AGENT_RUNTIME_TEMP_MAX_FILES = 10_000;

let lastAgentRuntimeTempCleanupAt = 0;
const activeAgentRuntimeTempLeases = new Map<string, number>();

export type AgentRuntimeTempIdentity = Pick<
  AgentExecutionContext,
  'userId' | 'sessionId' | 'agentId' | 'organizationId'
>;

export type AgentRuntimeTempCleanupResult = {
  root: string;
  retentionMs: number;
  deleted: string[];
  scanned: number;
};

export type AgentRuntimeTempLimits = {
  maxBytes: number;
  maxFiles: number;
};

export type AgentRuntimeTempUsage = {
  bytes: number;
  files: number;
  directories: number;
};

export function acquireAgentRuntimeTempLease(tempDir: string): () => void {
  const resolvedDir = path.resolve(tempDir);
  activeAgentRuntimeTempLeases.set(resolvedDir, (activeAgentRuntimeTempLeases.get(resolvedDir) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeAgentRuntimeTempLeases.get(resolvedDir) ?? 1) - 1;
    if (remaining > 0) activeAgentRuntimeTempLeases.set(resolvedDir, remaining);
    else activeAgentRuntimeTempLeases.delete(resolvedDir);
  };
}

function normalizeTempSegment(prefix: string, value: string | null | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  return `${prefix}-${normalizeDataScopeId(raw, `${prefix} temp scope`)}`;
}

export function resolveAgentRuntimeTempRoot(): string {
  return path.join(resolveCanvasDataRoot(), 'temp', 'agent-runtime');
}

export function resolveAgentRuntimeTempDir(identity: AgentRuntimeTempIdentity): string {
  return path.join(
    resolveAgentRuntimeTempRoot(),
    identity.organizationId
      ? normalizeTempSegment('org', identity.organizationId, 'unknown')
      : 'org-personal',
    normalizeTempSegment('user', identity.userId, 'unknown'),
    normalizeTempSegment('agent', identity.agentId, 'default'),
    normalizeTempSegment('session', identity.sessionId, 'unknown'),
  );
}

function readRetentionMs(): number {
  const configuredHours = Number(process.env.CANVAS_AGENT_RUNTIME_TEMP_RETENTION_HOURS ?? '');
  if (!Number.isFinite(configuredHours) || configuredHours <= 0) {
    return DEFAULT_AGENT_RUNTIME_TEMP_RETENTION_MS;
  }
  return Math.max(MIN_AGENT_RUNTIME_TEMP_RETENTION_MS, Math.trunc(configuredHours * 60 * 60 * 1000));
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? '');
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function readAgentRuntimeTempLimits(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): AgentRuntimeTempLimits {
  return {
    maxBytes: readPositiveInteger(env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES, DEFAULT_AGENT_RUNTIME_TEMP_MAX_BYTES),
    maxFiles: readPositiveInteger(env.CANVAS_AGENT_RUNTIME_TEMP_MAX_FILES, DEFAULT_AGENT_RUNTIME_TEMP_MAX_FILES),
  };
}

export async function inspectAgentRuntimeTempUsage(tempDir: string): Promise<AgentRuntimeTempUsage> {
  const usage: AgentRuntimeTempUsage = { bytes: 0, files: 0, directories: 0 };
  const pending = [tempDir];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const stats = await fs.lstat(entryPath);
      if (stats.isSymbolicLink()) {
        usage.files += 1;
        usage.bytes += stats.size;
      } else if (stats.isDirectory()) {
        usage.directories += 1;
        pending.push(entryPath);
      } else {
        usage.files += 1;
        usage.bytes += stats.size;
      }
    }
  }
  return usage;
}

export async function assertAgentRuntimeTempQuota(
  tempDir: string,
  projection: {
    additionalBytes?: number;
    additionalFiles?: number;
    releasedBytes?: number;
    releasedFiles?: number;
    limits?: AgentRuntimeTempLimits;
  } = {},
): Promise<AgentRuntimeTempUsage> {
  const usage = await inspectAgentRuntimeTempUsage(tempDir);
  const limits = projection.limits ?? readAgentRuntimeTempLimits();
  const projectedBytes = Math.max(
    0,
    usage.bytes + (projection.additionalBytes ?? 0) - (projection.releasedBytes ?? 0),
  );
  const projectedFiles = Math.max(
    0,
    usage.files + (projection.additionalFiles ?? 0) - (projection.releasedFiles ?? 0),
  );
  if (projectedBytes > limits.maxBytes) {
    throw new Error(
      `Agent runtime temp quota exceeded: ${projectedBytes} bytes would exceed the ${limits.maxBytes}-byte session limit. Remove intermediate files or promote the final artifact and retry.`,
    );
  }
  if (projectedFiles > limits.maxFiles) {
    throw new Error(
      `Agent runtime temp quota exceeded: ${projectedFiles} files would exceed the ${limits.maxFiles}-file session limit. Remove intermediate files and retry.`,
    );
  }
  return usage;
}

async function childDirectories(parentPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(parentPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parentPath, entry.name));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function sessionTempDirectories(rootPath: string): Promise<string[]> {
  const sessions: string[] = [];
  for (const orgDir of await childDirectories(rootPath)) {
    for (const userDir of await childDirectories(orgDir)) {
      for (const agentDir of await childDirectories(userDir)) {
        for (const sessionDir of await childDirectories(agentDir)) {
          if (path.basename(sessionDir).startsWith('session-')) {
            sessions.push(sessionDir);
          }
        }
      }
    }
  }
  return sessions;
}

export async function cleanupAgentRuntimeTempDirs(options: {
  nowMs?: number;
  retentionMs?: number;
  activeDir?: string;
  activeDirs?: string[];
  force?: boolean;
} = {}): Promise<AgentRuntimeTempCleanupResult> {
  const nowMs = options.nowMs ?? Date.now();
  const retentionMs = options.retentionMs ?? readRetentionMs();
  if (!options.force && nowMs - lastAgentRuntimeTempCleanupAt < AGENT_RUNTIME_TEMP_CLEANUP_INTERVAL_MS) {
    return {
      root: resolveAgentRuntimeTempRoot(),
      retentionMs,
      deleted: [],
      scanned: 0,
    };
  }
  lastAgentRuntimeTempCleanupAt = nowMs;

  const root = resolveAgentRuntimeTempRoot();
  const activeDirs = new Set(
    [
      ...activeAgentRuntimeTempLeases.keys(),
      ...(options.activeDirs ?? []),
      ...(options.activeDir ? [options.activeDir] : []),
    ].map((activeDir) => path.resolve(activeDir)),
  );
  const cutoffMs = nowMs - retentionMs;
  const deleted: string[] = [];
  let scanned = 0;

  for (const sessionDir of await sessionTempDirectories(root)) {
    const resolvedSessionDir = path.resolve(sessionDir);
    if (activeDirs.has(resolvedSessionDir)) continue;
    scanned += 1;
    const stats = await fs.lstat(sessionDir).catch(() => null);
    if (!stats || !stats.isDirectory() || stats.mtimeMs >= cutoffMs) continue;
    await fs.rm(sessionDir, { recursive: true, force: true });
    deleted.push(sessionDir);
  }

  return { root, retentionMs, deleted, scanned };
}

async function touchDirectory(directory: string, nowMs: number): Promise<void> {
  const now = new Date(nowMs);
  await fs.utimes(directory, now, now).catch(() => undefined);
}

async function ensurePrivateSessionDirectory(tempDir: string): Promise<void> {
  const root = resolveAgentRuntimeTempRoot();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Agent runtime temp root must be a real directory.');
  }
  await fs.chmod(root, 0o700);

  const relativeSegments = path.relative(root, tempDir).split(path.sep).filter(Boolean);
  if (relativeSegments.length !== 4 || relativeSegments.some((segment) => segment === '..')) {
    throw new Error('Agent runtime temp directory is outside the managed session hierarchy.');
  }
  let current = root;
  for (const segment of relativeSegments) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Agent runtime temp hierarchy must not contain symbolic links.');
    }
    await fs.chmod(current, 0o700);
  }
}

export async function ensureAgentRuntimeTempDir(identity: AgentRuntimeTempIdentity): Promise<string> {
  const tempDir = resolveAgentRuntimeTempDir(identity);
  const nowMs = Date.now();
  await ensurePrivateSessionDirectory(tempDir);
  await touchDirectory(tempDir, nowMs);
  await cleanupAgentRuntimeTempDirs({ nowMs, activeDir: tempDir }).catch(() => undefined);
  await assertAgentRuntimeTempQuota(tempDir);
  return tempDir;
}

export function getAgentRuntimeTempEnv(tempDir: string): Record<string, string> {
  return {
    CANVAS_AGENT_TEMP_DIR: tempDir,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    PYTHONPYCACHEPREFIX: path.join(tempDir, '__pycache__'),
  };
}

export function getAgentRuntimeTempPromptBlock(identity: AgentRuntimeTempIdentity): string {
  const tempDir = resolveAgentRuntimeTempDir(identity);
  return [
    '## Agent Runtime Temp Directory',
    `Temporary runtime directory: ${tempDir}`,
    'Use this directory for generated code, throwaway scripts, build output, virtual environments, extracted assets, document conversions, render previews, caches, and calculations.',
    'Promote only requested final artifacts into the workspace with copy_path or move_path. Do not write workspace files through Bash.',
    'Runtime commands receive CANVAS_AGENT_TEMP_DIR, TMPDIR, TMP, TEMP, and PYTHONPYCACHEPREFIX pointing to this directory.',
  ].join('\n');
}
