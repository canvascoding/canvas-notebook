import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import { initializeUserOnboarding } from '@/app/lib/user-preferences';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import {
  isDirectMcpOAuthPath,
  prepareDirectMcpOAuthRequest,
} from '@/app/lib/mcp/server/oauth-request-policy';
import {
  applyDirectMcpRevocation,
  prepareDirectMcpRevocation,
} from '@/app/lib/mcp/server/oauth-grant-revocation';
import {
  beginDirectMcpDiagnostic,
  completeDirectMcpDiagnostic,
  failDirectMcpDiagnostic,
  runWithDirectMcpDiagnostic,
  withDirectMcpRequestId,
} from '@/app/lib/mcp/server/diagnostics';

function hasAuthPathSegment(pathname: string, segment: string): boolean {
  return new RegExp(`/${segment}(?:/|$)`).test(pathname);
}

function isTeamUserManagementPath(pathname: string): boolean {
  return /\/api\/auth\/admin(?:\/|$)/u.test(pathname);
}

function authAuditAction(pathname: string): string | null {
  if (hasAuthPathSegment(pathname, 'sign-in')) return 'auth.sign_in';
  if (hasAuthPathSegment(pathname, 'sign-out')) return 'auth.sign_out';
  if (hasAuthPathSegment(pathname, 'sign-up')) return 'auth.sign_up';
  return null;
}

function authAuditStatus(status: number): 'success' | 'failure' | 'blocked' {
  if (status === 403) return 'blocked';
  return status < 400 ? 'success' : 'failure';
}

async function getCurrentAuthUserId(request: NextRequest): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

function readUserIdFromPayload(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const directUserId = typeof record.userId === 'string' ? record.userId.trim() : '';
  if (directUserId) return directUserId;

  const userValue = record.user;
  if (!userValue || typeof userValue !== 'object') return null;
  const userId = (userValue as Record<string, unknown>).id;
  return typeof userId === 'string' && userId.trim() ? userId.trim() : null;
}

async function getAuthResponseUserId(response: Response): Promise<string | null> {
  if (response.status >= 400) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) return null;

  try {
    return readUserIdFromPayload(await response.clone().json());
  } catch {
    return null;
  }
}

async function resolveAuthAuditUserId(request: NextRequest, action: string, response: Response, beforeUserId: string | null): Promise<string | null> {
  if (action === 'auth.sign_out') return beforeUserId;
  if (action === 'auth.sign_in') return (await getAuthResponseUserId(response)) ?? null;
  return beforeUserId;
}

async function recordAuthRequestAudit(
  request: NextRequest,
  action: string,
  response: Response,
  beforeUserId: string | null,
) {
  await recordAuditEvent({
    userId: await resolveAuthAuditUserId(request, action, response, beforeUserId),
    source: 'auth',
    eventType: 'auth',
    entityType: 'auth_request',
    action,
    status: authAuditStatus(response.status),
    summary: `${action} returned HTTP ${response.status}.`,
    metadata: {
      endpoint: request.nextUrl.pathname,
      statusCode: response.status,
    },
  });
}

async function initializeCreatedUserOnboarding(pathname: string, response: Response): Promise<void> {
  if (!hasAuthPathSegment(pathname, 'create-user') || response.status >= 400) return;
  if (!isOnboardingEnabled() || !(await isOnboardingComplete())) return;
  const userId = await getAuthResponseUserId(response);
  if (!userId) return;
  await initializeUserOnboarding(userId);
}

function directMcpOAuthUnavailableResponse(): Response {
  return NextResponse.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'The Direct MCP OAuth service is temporarily unavailable.',
    },
    {
      status: 503,
      headers: {
        'cache-control': 'no-store',
        pragma: 'no-cache',
      },
    },
  );
}

async function handleDirectMcpOAuthRequest(
  request: NextRequest,
  handler: () => Promise<Response>,
): Promise<Response> {
  if (!isDirectMcpOAuthPath(request.nextUrl.pathname)) return handler();

  const startedAt = Date.now();
  const diagnostics = beginDirectMcpDiagnostic(
    request,
    request.nextUrl.pathname === '/api/auth/oauth2/register'
      ? 'oauth.registration'
      : 'oauth.request',
  );
  try {
    const response = withDirectMcpRequestId(
      await runWithDirectMcpDiagnostic(
        diagnostics,
        handler,
      ),
      diagnostics.requestId,
    );
    if (response.status >= 500) {
      completeDirectMcpDiagnostic(diagnostics, {
        statusCode: 503,
        code: 'OAUTH_PROVIDER_ERROR',
        startedAt,
      });
      return withDirectMcpRequestId(
        directMcpOAuthUnavailableResponse(),
        diagnostics.requestId,
      );
    }
    completeDirectMcpDiagnostic(diagnostics, {
      statusCode: response.status,
      code: 'OAUTH_REQUEST_COMPLETED',
      startedAt,
    });
    return response;
  } catch {
    failDirectMcpDiagnostic(diagnostics, {
      code: 'OAUTH_INTERNAL_ERROR',
      startedAt,
      statusCode: 503,
    });
    return withDirectMcpRequestId(
      directMcpOAuthUnavailableResponse(),
      diagnostics.requestId,
    );
  }
}

export async function GET(request: NextRequest) {
  return handleDirectMcpOAuthRequest(request, async () => {
    const prepared = await prepareDirectMcpOAuthRequest(request);
    if (prepared.response) return prepared.response;

    if (isTeamUserManagementPath(request.nextUrl.pathname)) {
      const licenseResponse = await requireTeamRuntimeRoute();
      if (licenseResponse) return licenseResponse;
    }
    return auth.handler(prepared.request);
  });
}

export async function POST(request: NextRequest) {
  return handleDirectMcpOAuthRequest(request, async () => {
    const pathname = request.nextUrl.pathname;
    const prepared = await prepareDirectMcpOAuthRequest(request);
    if (prepared.response) return prepared.response;
    const authRequest = prepared.request;
    const revocationCandidate = await prepareDirectMcpRevocation(authRequest);

    if (revocationCandidate) {
      try {
        await applyDirectMcpRevocation(revocationCandidate);
        return new Response(null, {
          status: 200,
          headers: { 'cache-control': 'no-store' },
        });
      } catch {
        console.error('[auth] Failed to revoke the local Direct MCP grant.');
        return NextResponse.json({
          error: 'temporarily_unavailable',
          error_description: 'The local OAuth grant could not be revoked.',
        }, { status: 503, headers: { 'cache-control': 'no-store', pragma: 'no-cache' } });
      }
    }

    const action = authAuditAction(pathname);
    const beforeUserId = action ? await getCurrentAuthUserId(request) : null;

    if (hasAuthPathSegment(pathname, 'sign-up')) {
      const response = NextResponse.json({ message: 'Sign up is disabled' }, { status: 403 });
      if (action) await recordAuthRequestAudit(request, action, response, beforeUserId);
      return response;
    }

    if (isTeamUserManagementPath(pathname)) {
      const licenseResponse = await requireTeamRuntimeRoute();
      if (licenseResponse) return licenseResponse;
    }

    const response = await auth.handler(authRequest);
    try {
      await initializeCreatedUserOnboarding(pathname, response);
    } catch (error) {
      // Account creation must keep Better Auth's response semantics. The admin
      // UI retries the explicit initializer if persistence briefly fails.
      console.error('[auth] Failed to initialize personal onboarding for created user:', error);
    }
    if (action) await recordAuthRequestAudit(request, action, response, beforeUserId);
    return response;
  });
}
