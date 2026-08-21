import 'server-only';

import { createHmac, randomUUID } from 'node:crypto';

import { resolveAuthSecret } from '@/app/lib/security/auth-secret';

export type DirectMcpDiagnosticPhase =
  | 'discovery.authorization_server'
  | 'discovery.protected_resource'
  | 'mcp.http'
  | 'oauth.request';

export type DirectMcpDiagnosticContext = {
  requestId: string;
  flowRef: string | null;
  phase: DirectMcpDiagnosticPhase;
  method: string;
};

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

export function completeDirectMcpDiagnostic(
  context: DirectMcpDiagnosticContext,
  input: {
    statusCode: number;
    code: string;
    startedAt: number;
  },
): void {
  emitDiagnostic({
    event: 'direct_mcp_diagnostic',
    requestId: context.requestId,
    ...(context.flowRef ? { flowRef: context.flowRef } : {}),
    phase: context.phase,
    outcome: input.statusCode >= 500 ? 'failed' : 'succeeded',
    method: context.method,
    statusCode: input.statusCode,
    code: input.code,
    durationMs: Math.max(0, Date.now() - input.startedAt),
  });
}

export function failDirectMcpDiagnostic(
  context: DirectMcpDiagnosticContext,
  input: {
    code: string;
    startedAt: number;
    statusCode?: number;
  },
): void {
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
