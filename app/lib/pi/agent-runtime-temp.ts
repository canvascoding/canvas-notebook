import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizeDataScopeId, resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';

export type AgentRuntimeTempIdentity = Pick<
  AgentExecutionContext,
  'userId' | 'sessionId' | 'agentId' | 'organizationId'
>;

function normalizeTempSegment(prefix: string, value: string | null | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  return `${prefix}-${normalizeDataScopeId(raw, `${prefix} temp scope`)}`;
}

export function resolveAgentRuntimeTempDir(identity: AgentRuntimeTempIdentity): string {
  return path.join(
    resolveCanvasDataRoot(),
    'temp',
    'agent-runtime',
    identity.organizationId
      ? normalizeTempSegment('org', identity.organizationId, 'unknown')
      : 'org-personal',
    normalizeTempSegment('user', identity.userId, 'unknown'),
    normalizeTempSegment('agent', identity.agentId, 'default'),
    normalizeTempSegment('session', identity.sessionId, 'unknown'),
  );
}

export async function ensureAgentRuntimeTempDir(identity: AgentRuntimeTempIdentity): Promise<string> {
  const tempDir = resolveAgentRuntimeTempDir(identity);
  await fs.mkdir(tempDir, { recursive: true });
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
    'Use this directory for throwaway scripts, intermediate files, caches, extracted working data, temporary Python files, and calculations.',
    'Do not store final user-facing artifacts there. Copy only final outputs into the workspace when the user should keep them.',
    'Runtime commands receive CANVAS_AGENT_TEMP_DIR, TMPDIR, TMP, TEMP, and PYTHONPYCACHEPREFIX pointing to this directory.',
  ].join('\n');
}
