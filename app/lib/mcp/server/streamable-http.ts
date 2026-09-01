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
import {
  beginDirectMcpDiagnostic,
  completeDirectMcpDiagnostic,
  failDirectMcpDiagnostic,
  runWithDirectMcpDiagnostic,
  type DirectMcpDiagnosticContext,
} from '@/app/lib/mcp/server/diagnostics';
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
  'x-request-id',
].join(', ');

function createModernMcpHandler(
  enabledTools: readonly import('@/app/lib/mcp/server/config').DirectMcpToolId[],
  diagnostics: DirectMcpDiagnosticContext,
  startedAt: number,
) {
  return createMcpHandler(
    () => createDirectMcpServer(enabledTools),
    {
      legacy: 'reject',
      onerror: () => {
        void failDirectMcpDiagnostic(diagnostics, {
          code: 'MCP_TRANSPORT_ERROR',
          startedAt,
          statusCode: 500,
        });
      },
    },
  );
}

async function handleProtocolRequest(
  request: Request,
  enabledTools: readonly import('@/app/lib/mcp/server/config').DirectMcpToolId[],
  authInfo?: AuthInfo,
  diagnostics?: DirectMcpDiagnosticContext,
  startedAt?: number,
): Promise<Response> {
  if (!await isLegacyRequest(request)) {
    if (!diagnostics || !startedAt) {
      throw new Error('Direct MCP diagnostics context is required.');
    }
    return createModernMcpHandler(enabledTools, diagnostics, startedAt)
      .fetch(request, { authInfo });
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

function withDirectMcpHeaders(
  response: Response,
  request?: Request,
  requestId?: string,
): Response {
  const headers = new Headers(response.headers);
  const requestOrigin = request?.headers.get('origin');
  if (requestOrigin && isConfiguredTrustedOrigin(requestOrigin)) {
    headers.set('access-control-allow-origin', new URL(requestOrigin).origin);
    headers.append('vary', 'Origin');
  }
  headers.set('access-control-expose-headers', MCP_EXPOSED_HEADERS);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  if (requestId) headers.set('x-request-id', requestId);
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

function internalMcpErrorResponse(): Response {
  return Response.json({
    jsonrpc: '2.0',
    error: {
      code: -32603,
      message: 'Internal server error.',
    },
    id: null,
  }, { status: 500 });
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
  const startedAt = Date.now();
  const diagnostics = beginDirectMcpDiagnostic(request, 'mcp.http');
  return runWithDirectMcpDiagnostic(diagnostics, async () => {
    try {
      const runtimeSettings = await getDirectMcpRuntimeSettings();
      if (!runtimeSettings.enabled) {
        const response = withDirectMcpHeaders(directMcpNotFound(), request, diagnostics.requestId);
        await completeDirectMcpDiagnostic(diagnostics, {
          statusCode: response.status,
          code: 'MCP_DISABLED',
          startedAt,
        });
        return response;
      }
      const originRejection = rejectUntrustedOrigin(request);
      if (originRejection) {
        const response = withDirectMcpHeaders(originRejection, request, diagnostics.requestId);
        await completeDirectMcpDiagnostic(diagnostics, {
          statusCode: response.status,
          code: 'MCP_ORIGIN_REJECTED',
          startedAt,
        });
        return response;
      }

      let authInfo: AuthInfo | undefined;
      try {
        authInfo = await resolveAuthInfo(request);
      } catch (error) {
        if (error instanceof DirectMcpAuthorizationError) {
          const response = withDirectMcpHeaders(error.toResponse(), request, diagnostics.requestId);
          await completeDirectMcpDiagnostic(diagnostics, {
            statusCode: response.status,
            code: `MCP_${error.code.toUpperCase()}`,
            startedAt,
          });
          return response;
        }
        throw error;
      }

      const response = withDirectMcpHeaders(
        await handleProtocolRequest(
          request,
          runtimeSettings.tools,
          authInfo,
          diagnostics,
          startedAt,
        ),
        request,
        diagnostics.requestId,
      );
      await completeDirectMcpDiagnostic(diagnostics, {
        statusCode: response.status,
        code: response.status >= 500 ? 'MCP_TRANSPORT_ERROR' : 'MCP_REQUEST_COMPLETED',
        startedAt,
      });
      return response;
    } catch {
      await failDirectMcpDiagnostic(diagnostics, {
        code: 'MCP_INTERNAL_ERROR',
        startedAt,
        statusCode: 500,
      });
      return withDirectMcpHeaders(internalMcpErrorResponse(), request, diagnostics.requestId);
    }
  });
}

export async function handleDirectMcpUnsupportedMethod(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const diagnostics = beginDirectMcpDiagnostic(request, 'mcp.http');
  try {
    const runtimeSettings = await getDirectMcpRuntimeSettings();
    const response = !runtimeSettings.enabled
      ? directMcpNotFound()
      : rejectUntrustedOrigin(request) || methodNotAllowed(request);
    const responseWithHeaders = withDirectMcpHeaders(
      response,
      request,
      diagnostics.requestId,
    );
    await completeDirectMcpDiagnostic(diagnostics, {
      statusCode: responseWithHeaders.status,
      code: responseWithHeaders.status === 404
        ? 'MCP_DISABLED'
        : responseWithHeaders.status === 403
          ? 'MCP_ORIGIN_REJECTED'
          : 'MCP_METHOD_REJECTED',
      startedAt,
    });
    return responseWithHeaders;
  } catch {
    await failDirectMcpDiagnostic(diagnostics, {
      code: 'MCP_INTERNAL_ERROR',
      startedAt,
      statusCode: 500,
    });
    return withDirectMcpHeaders(
      internalMcpErrorResponse(),
      request,
      diagnostics.requestId,
    );
  }
}

export async function handleDirectMcpOptions(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const diagnostics = beginDirectMcpDiagnostic(request, 'mcp.http');
  try {
    const runtimeSettings = await getDirectMcpRuntimeSettings();
    if (!runtimeSettings.enabled) {
      const response = withDirectMcpHeaders(
        directMcpNotFound(),
        request,
        diagnostics.requestId,
      );
      await completeDirectMcpDiagnostic(diagnostics, {
        statusCode: response.status,
        code: 'MCP_DISABLED',
        startedAt,
      });
      return response;
    }
    const originRejection = rejectUntrustedOrigin(request);
    if (originRejection) {
      const response = withDirectMcpHeaders(
        originRejection,
        request,
        diagnostics.requestId,
      );
      await completeDirectMcpDiagnostic(diagnostics, {
        statusCode: response.status,
        code: 'MCP_ORIGIN_REJECTED',
        startedAt,
      });
      return response;
    }
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
    const response = withDirectMcpHeaders(
      new Response(null, { status: 204, headers }),
      request,
      diagnostics.requestId,
    );
    await completeDirectMcpDiagnostic(diagnostics, {
      statusCode: response.status,
      code: 'MCP_OPTIONS_COMPLETED',
      startedAt,
    });
    return response;
  } catch {
    await failDirectMcpDiagnostic(diagnostics, {
      code: 'MCP_INTERNAL_ERROR',
      startedAt,
      statusCode: 500,
    });
    return withDirectMcpHeaders(
      internalMcpErrorResponse(),
      request,
      diagnostics.requestId,
    );
  }
}
