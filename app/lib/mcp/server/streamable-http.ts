import 'server-only';

import { WebStandardStreamableHTTPServerTransport } from
  '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import {
  DirectMcpAuthorizationError,
  verifyDirectMcpRequest,
} from '@/app/lib/mcp/server/access-token-verifier';
import { createDirectMcpAuthProbeServer } from '@/app/lib/mcp/server/auth-probe';
import {
  isDirectMcpEnabled,
  resolveDirectMcpServerConfig,
} from '@/app/lib/mcp/server/config';
import { isConfiguredTrustedOrigin } from '@/app/lib/security/trusted-origins';

const MCP_ALLOWED_METHODS = 'POST, GET, DELETE, OPTIONS';
const MCP_ALLOWED_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
].join(', ');
const MCP_EXPOSED_HEADERS = [
  'mcp-protocol-version',
  'mcp-session-id',
  'www-authenticate',
].join(', ');

function withDirectMcpHeaders(response: Response, request?: Request): Response {
  const headers = new Headers(response.headers);
  const requestOrigin = request?.headers.get('origin');
  if (requestOrigin && isConfiguredTrustedOrigin(requestOrigin)) {
    headers.set('access-control-allow-origin', new URL(requestOrigin).origin);
    headers.append('vary', 'Origin');
  }
  headers.set('access-control-expose-headers', MCP_EXPOSED_HEADERS);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rejectUntrustedOrigin(request: Request): Response | null {
  const origin = request.headers.get('origin');
  if (!origin || isConfiguredTrustedOrigin(origin)) return null;

  return withDirectMcpHeaders(Response.json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Forbidden: untrusted Origin header.',
    },
    id: null,
  }, {
    status: 403,
  }), request);
}

function directMcpNotFound(): Response {
  return withDirectMcpHeaders(new Response(null, { status: 404 }));
}

function methodNotAllowed(): Response {
  return withDirectMcpHeaders(Response.json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Method not allowed.',
    },
    id: null,
  }, {
    status: 405,
    headers: {
      allow: 'POST, OPTIONS',
    },
  }));
}

async function resolveAuthInfo(request: Request): Promise<AuthInfo | undefined> {
  if (!request.headers.has('authorization')) return undefined;

  const principal = await verifyDirectMcpRequest(request);
  const { resource } = resolveDirectMcpServerConfig();
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.replace(/^Bearer\s+/iu, '');
  return {
    token,
    clientId: principal.clientId,
    scopes: principal.scopes,
    expiresAt: principal.expiresAt,
    resource: new URL(resource),
    extra: {
      sessionId: principal.sessionId,
      userId: principal.userId,
    },
  };
}

export async function handleDirectMcpPost(request: Request): Promise<Response> {
  if (!isDirectMcpEnabled()) return directMcpNotFound();
  const originRejection = rejectUntrustedOrigin(request);
  if (originRejection) return originRejection;

  let authInfo: AuthInfo | undefined;
  try {
    authInfo = await resolveAuthInfo(request);
  } catch (error) {
    if (error instanceof DirectMcpAuthorizationError) {
      return withDirectMcpHeaders(error.toResponse(), request);
    }
    throw error;
  }

  const server = createDirectMcpAuthProbeServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, { authInfo });
    return withDirectMcpHeaders(response, request);
  } finally {
    await server.close().catch(() => undefined);
  }
}

export function handleDirectMcpUnsupportedMethod(request: Request): Response {
  if (!isDirectMcpEnabled()) return directMcpNotFound();
  return rejectUntrustedOrigin(request) || methodNotAllowed();
}

export function handleDirectMcpOptions(request: Request): Response {
  if (!isDirectMcpEnabled()) return directMcpNotFound();
  const originRejection = rejectUntrustedOrigin(request);
  if (originRejection) return originRejection;
  const origin = request.headers.get('origin');
  const headers = new Headers({
    'access-control-allow-headers': MCP_ALLOWED_HEADERS,
    'access-control-allow-methods': MCP_ALLOWED_METHODS,
    'access-control-expose-headers': MCP_EXPOSED_HEADERS,
    'access-control-max-age': '300',
    allow: MCP_ALLOWED_METHODS,
  });
  if (origin && isConfiguredTrustedOrigin(origin)) {
    headers.set('access-control-allow-origin', new URL(origin).origin);
    headers.append('vary', 'Origin');
  }
  return new Response(null, {
    status: 204,
    headers,
  });
}
