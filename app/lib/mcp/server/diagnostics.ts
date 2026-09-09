import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { DirectMcpAccessPrincipal } from '@/app/lib/mcp/server/access-token-verifier';
import { recordDirectMcpConnectionUsage, type DirectMcpUsagePrincipal } from '@/app/lib/mcp/server/connection-usage';

import {
  recordDirectMcpRequestHistory,
  type DirectMcpRequestHistoryEntry,
} from '@/app/lib/mcp/server/request-history';
import { normalizeDirectMcpClientName } from '@/app/lib/mcp/server/client-name';
import { type DirectMcpOAuthFailureCode } from '@/app/lib/mcp/server/oauth-diagnostic-codes';
import { resolveAuthSecret } from '@/app/lib/security/auth-secret';

export type DirectMcpDiagnosticPhase =
  | 'discovery.authorization_server'
  | 'discovery.protected_resource'
  | 'mcp.http'
  | 'oauth.authorization'
  | 'oauth.consent'
  | 'oauth.introspection'
  | 'oauth.registration'
  | 'oauth.revocation'
  | 'oauth.token';

const directMcpDiagnosticStorage = new AsyncLocalStorage<DirectMcpDiagnosticContext>();

export type DirectMcpDiagnosticContext = {
  requestId: string;
  flowRef: string | null;
  phase: DirectMcpDiagnosticPhase;
  method: string;
  clientName?: string;
  operation?: 'tools/list' | 'tools/call';
  toolName?: string;
  historyCode?: string;
  historyRecorded?: boolean;
  verifiedPrincipal?: DirectMcpUsagePrincipal;
};

export function recordDirectMcpRequestPrincipal(principal: DirectMcpAccessPrincipal, token: string): void {
  const context = directMcpDiagnosticStorage.getStore();
  if (!context || context.phase !== 'mcp.http') return;
  context.verifiedPrincipal = {
    userId: principal.userId, clientId: principal.clientId, sessionId: principal.sessionId,
    issuedAt: principal.issuedAt, expiresAt: principal.expiresAt,
    scopes: principal.scopes,
    tokenHash: createHash('sha256').update(token).digest('base64url'),
  };
}

export async function recordDirectMcpSuccessfulOperation(): Promise<void> {
  const context = directMcpDiagnosticStorage.getStore();
  if (!context?.verifiedPrincipal || context.phase !== 'mcp.http' || !context.operation || context.historyCode === 'MCP_TOOL_ERROR') return;
  await recordDirectMcpConnectionUsage(context.verifiedPrincipal).catch(() => {
    console.warn('[direct-mcp] MCP_CONNECTION_USAGE_WRITE_FAILED');
  });
}

type DirectMcpDiagnosticOutcome = 'started' | 'succeeded' | 'failed';

type DirectMcpDiagnosticEvent = {
  event: 'direct_mcp_diagnostic';
  requestId: string;
  flowRef?: string;
  phase: DirectMcpDiagnosticPhase;
  outcome: DirectMcpDiagnosticOutcome;
  method: string;
  statusCode?: number;
  code: string;
  durationMs?: number;
};

function createFlowRef(request: Request): string | null {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const clientId = url.searchParams.get('client_id');
  if (!state || !clientId) return null;

  try {
    return createHmac('sha256', resolveAuthSecret())
      .update(`direct-mcp-oauth-flow:${clientId}:${state}`)
      .digest('hex')
      .slice(0, 24);
  } catch {
    // Diagnostics must never make an already invalid auth configuration worse.
    return null;
  }
}

function emitDiagnostic(event: DirectMcpDiagnosticEvent): void {
  const serialized = JSON.stringify(event);
  if (event.outcome === 'failed') {
    console.error('[direct-mcp]', serialized);
    return;
  }
  console.info('[direct-mcp]', serialized);
}

export function beginDirectMcpDiagnostic(
  request: Request,
  phase: DirectMcpDiagnosticPhase,
): DirectMcpDiagnosticContext {
  const context: DirectMcpDiagnosticContext = {
    requestId: randomUUID(),
    flowRef: createFlowRef(request),
    phase,
    method: request.method,
  };
  emitDiagnostic({
    event: 'direct_mcp_diagnostic',
    requestId: context.requestId,
    ...(context.flowRef ? { flowRef: context.flowRef } : {}),
    phase,
    outcome: 'started',
    method: context.method,
    code: 'MCP_REQUEST_STARTED',
  });
  return context;
}

function historyOutcome(
  statusCode: number,
  historyCode: string,
): DirectMcpRequestHistoryEntry['outcome'] {
  if (statusCode >= 500 || historyCode === 'MCP_TOOL_ERROR' || historyCode.startsWith('OAUTH_PERSISTENCE_')) {
    return 'failed';
  }
  if (statusCode >= 400) return 'rejected';
  return 'succeeded';
}

async function recordRequestHistory(
  context: DirectMcpDiagnosticContext,
  input: {
    statusCode?: number;
    code: string;
    startedAt: number;
    outcome: DirectMcpRequestHistoryEntry['outcome'];
  },
): Promise<void> {
  if (context.historyRecorded) return;
  context.historyRecorded = true;
  await recordDirectMcpRequestHistory({
    requestId: context.requestId,
    flowRef: context.flowRef,
    phase: context.phase,
    httpMethod: context.method,
    clientName: context.clientName,
    operation: context.operation,
    toolName: context.toolName,
    outcome: input.outcome,
    statusCode: input.statusCode,
    code: input.code,
    durationMs: Math.max(0, Date.now() - input.startedAt),
  });
}

export async function completeDirectMcpDiagnostic(
  context: DirectMcpDiagnosticContext,
  input: {
    statusCode: number;
    code: string;
    startedAt: number;
  },
): Promise<void> {
  const historyCode = context.historyCode ?? input.code;
  emitDiagnostic({
    event: 'direct_mcp_diagnostic',
    requestId: context.requestId,
    ...(context.flowRef ? { flowRef: context.flowRef } : {}),
    phase: context.phase,
    outcome: input.statusCode >= 400 ? 'failed' : 'succeeded',
    method: context.method,
    statusCode: input.statusCode,
    code: historyCode,
    durationMs: Math.max(0, Date.now() - input.startedAt),
  });
  await recordRequestHistory(context, {
    statusCode: input.statusCode,
    code: historyCode,
    startedAt: input.startedAt,
    outcome: historyOutcome(input.statusCode, historyCode),
  });
}

export async function failDirectMcpDiagnostic(
  context: DirectMcpDiagnosticContext,
  input: {
    code: string;
    startedAt: number;
    statusCode?: number;
  },
): Promise<void> {
  emitDiagnostic({
    event: 'direct_mcp_diagnostic',
    requestId: context.requestId,
    ...(context.flowRef ? { flowRef: context.flowRef } : {}),
    phase: context.phase,
    outcome: 'failed',
    method: context.method,
    ...(input.statusCode ? { statusCode: input.statusCode } : {}),
    code: input.code,
    durationMs: Math.max(0, Date.now() - input.startedAt),
  });
  await recordRequestHistory(context, {
    statusCode: input.statusCode,
    code: input.code,
    startedAt: input.startedAt,
    outcome: 'failed',
  });
}

export function recordDirectMcpRequestOperation(
  operation: 'tools/list' | 'tools/call',
  toolName?: string,
): void {
  const context = directMcpDiagnosticStorage.getStore();
  if (!context) return;
  context.operation = operation;
  if (toolName) context.toolName = toolName;
}

export function recordDirectMcpRequestClientName(clientName: string): void {
  const context = directMcpDiagnosticStorage.getStore();
  const normalizedClientName = normalizeDirectMcpClientName(clientName);
  if (!context || !normalizedClientName) return;
  context.clientName = normalizedClientName;
}

export function recordDirectMcpToolFailure(): void {
  const context = directMcpDiagnosticStorage.getStore();
  if (!context) return;
  context.historyCode = 'MCP_TOOL_ERROR';
}

export function recordDirectMcpOAuthFailure(code: DirectMcpOAuthFailureCode): void {
  const context = directMcpDiagnosticStorage.getStore();
  if (context && !context.historyCode) context.historyCode = code;
}

export async function recordDirectMcpOAuthResponseFailure(response: Response): Promise<void> {
  if (response.status < 400 || response.status >= 500) return;
  try {
    // Some provider errors are returned directly instead of invoking onAPIError.
    // Inspect only our local provider response and retain only allowlisted codes.
    recordDirectMcpOAuthProviderError({ status: response.status, body: await response.clone().json() });
  } catch {
    // Diagnostic parsing must not consume or change the protocol response.
  }
}

export function withDirectMcpRequestId(
  response: Response,
  requestId: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set('x-request-id', requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function runWithDirectMcpDiagnostic<T>(
  context: DirectMcpDiagnosticContext,
  operation: () => Promise<T>,
): Promise<T> {
  return directMcpDiagnosticStorage.run(context, operation);
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== 'object' || !('message' in error)) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message.toLowerCase() : '';
}

function isServerFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return true;
  const status = (error as { status?: unknown }).status;
  return status === 'INTERNAL_SERVER_ERROR'
    || (typeof status === 'number' && status >= 500);
}

function classifyProviderError(error: unknown): string {
  const message = errorMessage(error);
  if (/relation|table|column|does not exist|schema/u.test(message)) {
    return 'OAUTH_PERSISTENCE_SCHEMA_ERROR';
  }
  if (/constraint|duplicate|database|transaction|query/u.test(message)) {
    return 'OAUTH_PERSISTENCE_ERROR';
  }
  return 'OAUTH_PROVIDER_INTERNAL_ERROR';
}

export function recordDirectMcpOAuthProviderError(
  error: unknown,
): boolean {
  const context = directMcpDiagnosticStorage.getStore();
  if (!context) return false;
  if (!isServerFailure(error)) {
    const body = (error as { body?: { error?: unknown } }).body;
    const codes: Record<string, DirectMcpOAuthFailureCode> = {
      invalid_grant: 'OAUTH_TOKEN_INVALID_GRANT',
      invalid_client: 'OAUTH_TOKEN_INVALID_CLIENT',
      invalid_scope: 'OAUTH_TOKEN_INVALID_SCOPE',
      invalid_target: 'OAUTH_TOKEN_INVALID_TARGET',
    };
    const code = typeof body?.error === 'string' && Object.hasOwn(codes, body.error)
      ? codes[body.error] : undefined;
    if (context.phase !== 'oauth.token' || !code) return false;
    recordDirectMcpOAuthFailure(code);
    return true;
  }

  // Keep production diagnostics correlatable without recording client metadata,
  // credentials, authorization codes, tokens, or provider error text.
  const code = classifyProviderError(error);
  emitDiagnostic({
    event: 'direct_mcp_diagnostic',
    requestId: context.requestId,
    ...(context.flowRef ? { flowRef: context.flowRef } : {}),
    phase: context.phase,
    outcome: 'failed',
    method: context.method,
    code,
  });
  context.historyCode = code;
  return true;
}
