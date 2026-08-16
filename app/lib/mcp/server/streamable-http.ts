import 'server-only';

import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
} from '@modelcontextprotocol/server';

import {
  DirectMcpAuthorizationError,
  verifyDirectMcpRequest,
} from '@/app/lib/mcp/server/access-token-verifier';
import { createDirectMcpServer } from '@/app/lib/mcp/server/direct-server';
import {
  resolveDirectMcpOAuthConfig,
} from '@/app/lib/mcp/server/config';
import { getDirectMcpRuntimeSettings } from '@/app/lib/mcp/server/runtime-settings';
import { isConfiguredTrustedOrigin } from '@/app/lib/security/trusted-origins';

const MCP_ALLOWED_METHODS = 'POST, OPTIONS';
const MCP_ALLOWED_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
  'mcp-session-id',
].join(', ');
const MCP_EXPOSED_HEADERS = [
  'mcp-protocol-version',
  'mcp-session-id',
  'www-authenticate',
].join(', ');

function createModernMcpHandler(enabledTools: readonly import('@/app/lib/mcp/server/config').DirectMcpToolId[]) {
  return createMcpHandler(
    () => createDirectMcpServer(enabledTools),
    {
    legacy: 'reject',
    onerror: (error) => {
      console.error('[MCP] Direct server request failed', error);
    },
    },
  );
}

async function handleProtocolRequest(
  request: Request,
  enabledTools: readonly import('@/app/lib/mcp/server/config').DirectMcpToolId[],
  authInfo?: AuthInfo,
): Promise<Response> {
  if (!await isLegacyRequest(request)) {
    return createModernMcpHandler(enabledTools).fetch(request, { authInfo });
  }

  const server = createDirectMcpServer(enabledTools);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { authInfo });
  } finally {
    await server.close().catch(() => undefined);
  }
}

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

function methodNotAllowed(request: Request): Response {
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
      allow: MCP_ALLOWED_METHODS,
    },
  }), request);
}

async function resolveAuthInfo(request: Request): Promise<AuthInfo | undefined> {
  if (!request.headers.has('authorization')) return undefined;

  const principal = await verifyDirectMcpRequest(request);
  const { resource } = resolveDirectMcpOAuthConfig();
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
  const runtimeSettings = await getDirectMcpRuntimeSettings();
  if (!runtimeSettings.enabled) return directMcpNotFound();
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

  const response = await handleProtocolRequest(request, runtimeSettings.tools, authInfo);
  return withDirectMcpHeaders(response, request);
}

export async function handleDirectMcpUnsupportedMethod(request: Request): Promise<Response> {
  if (!(await getDirectMcpRuntimeSettings()).enabled) return directMcpNotFound();
  return rejectUntrustedOrigin(request) || methodNotAllowed(request);
}

export async function handleDirectMcpOptions(request: Request): Promise<Response> {
  if (!(await getDirectMcpRuntimeSettings()).enabled) return directMcpNotFound();
  const originRejection = rejectUntrustedOrigin(request);
  if (originRejection) return originRejection;
  const origin = request.headers.get('origin');
  const requestedHeaders = request.headers.get('access-control-request-headers');
  const headers = new Headers({
    'access-control-allow-headers': requestedHeaders || MCP_ALLOWED_HEADERS,
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
