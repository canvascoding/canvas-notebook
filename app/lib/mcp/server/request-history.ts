import 'server-only';

import { randomUUID } from 'node:crypto';

import { desc, inArray, lte } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { directMcpRequestHistory } from '@/app/lib/db/schema';
import { DIRECT_MCP_SERVER_VERSION } from '@/app/lib/mcp/server/version';

export const DIRECT_MCP_REQUEST_HISTORY_RETENTION_HOURS = 24;
export const DIRECT_MCP_REQUEST_HISTORY_MAX_ENTRIES = 100;
const DIRECT_MCP_REQUEST_HISTORY_RETENTION_MS = DIRECT_MCP_REQUEST_HISTORY_RETENTION_HOURS * 60 * 60 * 1000;
const DIRECT_MCP_REQUEST_HISTORY_LIST_LIMIT = DIRECT_MCP_REQUEST_HISTORY_MAX_ENTRIES;

const PHASES = new Set([
  'discovery.authorization_server',
  'discovery.protected_resource',
  'mcp.http',
  'oauth.authorization',
  'oauth.consent',
  'oauth.introspection',
  'oauth.registration',
  'oauth.revocation',
  'oauth.token',
]);
const OUTCOMES = new Set(['succeeded', 'failed', 'rejected']);
const OPERATIONS = new Set(['tools/list', 'tools/call']);
const TOOL_NAMES = new Set([
  'auth_probe',
  'list_workspaces',
  'get_workspace_overview',
  'list_knowledge_tree',
  'search_knowledge',
  'read_knowledge_source',
  'edit_knowledge_source',
  'read_knowledge_asset',
  'upload_knowledge_asset',
]);

export type DirectMcpRequestHistoryInput = {
  requestId: string;
  flowRef?: string | null;
  phase: string;
  httpMethod: string;
  operation?: string | null;
  toolName?: string | null;
  outcome: string;
  statusCode?: number | null;
  code: string;
  durationMs: number;
  createdAt?: Date;
};

export type DirectMcpRequestHistoryEntry = {
  requestId: string;
  serverVersion: string | null;
  flowRef: string | null;
  phase: string;
  httpMethod: string;
  operation: string | null;
  toolName: string | null;
  outcome: 'succeeded' | 'failed' | 'rejected';
  statusCode: number | null;
  code: string;
  durationMs: number;
  createdAt: Date;
};

function toSafeCode(value: string): string {
  return /^[A-Z0-9_]{1,120}$/u.test(value) ? value : 'MCP_UNCLASSIFIED';
}

function toSafeHttpMethod(value: string): string {
  return /^[A-Z]{1,10}$/u.test(value) ? value : 'UNKNOWN';
}

function toSafeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(60 * 60 * 1000, Math.trunc(value))) : 0;
}

function toSafeStatusCode(value: number | null | undefined): number | null {
  if (!Number.isInteger(value) || !value || value < 100 || value > 599) return null;
  return value;
}

function toSafeFlowRef(value: string | null | undefined): string | null {
  return value && /^[a-f0-9]{24}$/u.test(value) ? value : null;
}

async function pruneDirectMcpRequestHistory(now: Date): Promise<void> {
  await db.delete(directMcpRequestHistory).where(lte(directMcpRequestHistory.expiresAt, now));

  while (true) {
    const overflow = await db
      .select({ id: directMcpRequestHistory.id })
      .from(directMcpRequestHistory)
      .orderBy(desc(directMcpRequestHistory.createdAt), desc(directMcpRequestHistory.id))
      .limit(DIRECT_MCP_REQUEST_HISTORY_MAX_ENTRIES)
      .offset(DIRECT_MCP_REQUEST_HISTORY_MAX_ENTRIES);
    if (overflow.length === 0) return;
    await db.delete(directMcpRequestHistory).where(inArray(
      directMcpRequestHistory.id,
      overflow.map((entry) => entry.id),
    ));
  }
}

export async function recordDirectMcpRequestHistory(input: DirectMcpRequestHistoryInput): Promise<void> {
  const createdAt = input.createdAt ?? new Date();
  const phase = PHASES.has(input.phase) ? input.phase : 'mcp.http';
  const outcome = OUTCOMES.has(input.outcome) ? input.outcome as DirectMcpRequestHistoryEntry['outcome'] : 'failed';
  const operation = input.operation && OPERATIONS.has(input.operation) ? input.operation : null;
  const toolName = input.toolName && TOOL_NAMES.has(input.toolName) ? input.toolName : null;

  try {
    await db.insert(directMcpRequestHistory).values({
      id: `direct-mcp-request-${randomUUID()}`,
      requestId: input.requestId,
      serverVersion: DIRECT_MCP_SERVER_VERSION,
      flowRef: toSafeFlowRef(input.flowRef),
      phase,
      httpMethod: toSafeHttpMethod(input.httpMethod),
      operation,
      toolName,
      outcome,
      statusCode: toSafeStatusCode(input.statusCode),
      code: toSafeCode(input.code),
      durationMs: toSafeDuration(input.durationMs),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + DIRECT_MCP_REQUEST_HISTORY_RETENTION_MS),
    });
    await pruneDirectMcpRequestHistory(createdAt);
  } catch {
    // Request tracing is optional observability. It must never block MCP,
    // OAuth, or discovery responses, and no database error details are logged.
    console.warn('[direct-mcp]', JSON.stringify({
      event: 'direct_mcp_request_history',
      outcome: 'failed',
      code: 'MCP_REQUEST_HISTORY_WRITE_FAILED',
    }));
  }
}

export async function listRecentDirectMcpRequestHistory(): Promise<DirectMcpRequestHistoryEntry[]> {
  const now = new Date();
  try {
    await pruneDirectMcpRequestHistory(now);
    const entries = await db
      .select({
        requestId: directMcpRequestHistory.requestId,
        serverVersion: directMcpRequestHistory.serverVersion,
        flowRef: directMcpRequestHistory.flowRef,
        phase: directMcpRequestHistory.phase,
        httpMethod: directMcpRequestHistory.httpMethod,
        operation: directMcpRequestHistory.operation,
        toolName: directMcpRequestHistory.toolName,
        outcome: directMcpRequestHistory.outcome,
        statusCode: directMcpRequestHistory.statusCode,
        code: directMcpRequestHistory.code,
        durationMs: directMcpRequestHistory.durationMs,
        createdAt: directMcpRequestHistory.createdAt,
      })
      .from(directMcpRequestHistory)
      .orderBy(desc(directMcpRequestHistory.createdAt), desc(directMcpRequestHistory.id))
      .limit(DIRECT_MCP_REQUEST_HISTORY_LIST_LIMIT);

    return entries.map((entry) => ({
      ...entry,
      outcome: entry.outcome as DirectMcpRequestHistoryEntry['outcome'],
    }));
  } catch {
    throw new Error('Direct MCP request history is unavailable.');
  }
}
