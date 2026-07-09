import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizeDataScopeId, resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';

const DEFAULT_AGENT_RUNTIME_TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;
const MIN_AGENT_RUNTIME_TEMP_RETENTION_MS = 60 * 60 * 1000;
const AGENT_RUNTIME_TEMP_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

let lastAgentRuntimeTempCleanupAt = 0;

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
  const activeDir = options.activeDir ? path.resolve(options.activeDir) : null;
  const cutoffMs = nowMs - retentionMs;
  const deleted: string[] = [];
  let scanned = 0;

  for (const sessionDir of await sessionTempDirectories(root)) {
    const resolvedSessionDir = path.resolve(sessionDir);
    if (activeDir && resolvedSessionDir === activeDir) continue;
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

export async function ensureAgentRuntimeTempDir(identity: AgentRuntimeTempIdentity): Promise<string> {
  const tempDir = resolveAgentRuntimeTempDir(identity);
  const nowMs = Date.now();
  await fs.mkdir(tempDir, { recursive: true });
  await touchDirectory(tempDir, nowMs);
  await cleanupAgentRuntimeTempDirs({ nowMs, activeDir: tempDir }).catch(() => undefined);
  return tempDir;
}

export async function removeAgentRuntimeTempDir(identity: AgentRuntimeTempIdentity): Promise<void> {
  await fs.rm(resolveAgentRuntimeTempDir(identity), { recursive: true, force: true });
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
    'Use this directory for throwaway scripts, intermediate files, caches, extracted working data, temporary Python files, and calculations.',
    'Do not store final user-facing artifacts there. Copy only final outputs into the workspace when the user should keep them.',
    'Runtime commands receive CANVAS_AGENT_TEMP_DIR, TMPDIR, TMP, TEMP, and PYTHONPYCACHEPREFIX pointing to this directory.',
  ].join('\n');
}
