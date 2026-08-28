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
import { pruneUnusedDirectMcpDynamicClients } from '@/app/lib/mcp/server/oauth-client-maintenance';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const DIRECT_MCP_DYNAMIC_CLIENT_REGISTRATION_RATE_LIMIT = 10;
const DIRECT_MCP_DYNAMIC_CLIENT_REGISTRATION_RATE_WINDOW_MS = 60_000;

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

function directMcpOAuthRegistrationRateLimitedResponse(response: Response): Response {
  const retryAfter = response.headers.get('retry-after') || '60';
  return NextResponse.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'Direct MCP client registration is temporarily rate limited. Try again later.',
    },
    {
      status: 429,
      headers: {
        'cache-control': 'no-store',
        pragma: 'no-cache',
        'retry-after': retryAfter,
      },
    },
  );
}

function directMcpRegistrationAuditStatus(status: number): 'success' | 'failure' | 'error' | 'blocked' {
  if (status === 429) return 'blocked';
  if (status >= 500) return 'error';
  return status < 400 ? 'success' : 'failure';
}

async function recordDirectMcpRegistrationAudit(response: Response): Promise<void> {
  await recordAuditEvent({
    source: 'direct_mcp',
    eventType: 'oauth_client_registration',
    entityType: 'oauth_client',
    action: 'direct_mcp.dynamic_client_registration',
    status: directMcpRegistrationAuditStatus(response.status),
    summary: `Direct MCP OAuth client registration returned HTTP ${response.status}.`,
    metadata: {
      endpoint: '/api/auth/oauth2/register',
      statusCode: response.status,
      rateLimited: response.status === 429,
    },
  });
}

class DirectMcpOAuthStageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DirectMcpOAuthStageError';
  }
}

async function runDirectMcpOAuthStage<T>(
  code: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    // Preserve a stable, non-sensitive failure stage for production
    // correlation. Do not attach the upstream error: it can contain OAuth
    // client metadata, tokens, or database details.
    throw new DirectMcpOAuthStageError(code);
  }
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
  const isRegistration = request.nextUrl.pathname === '/api/auth/oauth2/register';
  try {
    const response = withDirectMcpRequestId(
      await runWithDirectMcpDiagnostic(
        diagnostics,
        handler,
      ),
      diagnostics.requestId,
    );
    if (response.status >= 500) {
      const unavailableResponse = withDirectMcpRequestId(
        directMcpOAuthUnavailableResponse(),
        diagnostics.requestId,
      );
      if (isRegistration) await recordDirectMcpRegistrationAudit(unavailableResponse);
      await completeDirectMcpDiagnostic(diagnostics, {
        statusCode: 503,
        code: 'OAUTH_PROVIDER_ERROR',
        startedAt,
      });
      return unavailableResponse;
    }
    if (isRegistration) await recordDirectMcpRegistrationAudit(response);
    await completeDirectMcpDiagnostic(diagnostics, {
      statusCode: response.status,
      code: isRegistration && response.status === 429
        ? 'OAUTH_REGISTRATION_RATE_LIMITED'
        : 'OAUTH_REQUEST_COMPLETED',
      startedAt,
    });
    return response;
  } catch (error) {
    const unavailableResponse = withDirectMcpRequestId(
      directMcpOAuthUnavailableResponse(),
      diagnostics.requestId,
    );
    if (isRegistration) await recordDirectMcpRegistrationAudit(unavailableResponse);
    await failDirectMcpDiagnostic(diagnostics, {
      code: error instanceof DirectMcpOAuthStageError
        ? error.code
        : 'OAUTH_INTERNAL_ERROR',
      startedAt,
      statusCode: 503,
    });
    return unavailableResponse;
  }
}

export async function GET(request: NextRequest) {
  return handleDirectMcpOAuthRequest(request, async () => {
    const prepared = await runDirectMcpOAuthStage(
      'OAUTH_REQUEST_POLICY_ERROR',
      () => prepareDirectMcpOAuthRequest(request),
    );
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
    const isRegistration = pathname === '/api/auth/oauth2/register';
    const prepared = await runDirectMcpOAuthStage(
      isRegistration
        ? 'OAUTH_REGISTRATION_NORMALIZATION_ERROR'
        : 'OAUTH_REQUEST_POLICY_ERROR',
      () => prepareDirectMcpOAuthRequest(request),
    );
    if (prepared.response) return prepared.response;
    if (isRegistration) {
      const limited = rateLimit(request, {
        limit: DIRECT_MCP_DYNAMIC_CLIENT_REGISTRATION_RATE_LIMIT,
        windowMs: DIRECT_MCP_DYNAMIC_CLIENT_REGISTRATION_RATE_WINDOW_MS,
        keyPrefix: 'direct-mcp-oauth-client-registration',
      });
      if (!limited.ok) return directMcpOAuthRegistrationRateLimitedResponse(limited.response);

      try {
        await pruneUnusedDirectMcpDynamicClients();
      } catch {
        // Maintenance must never make a legitimate public client registration
        // fail. The OAuth provider still owns the authoritative registration.
        console.warn('[direct-mcp] Unable to prune unused OAuth clients.');
      }
    }
    const authRequest = prepared.request;
    const revocationCandidate = await runDirectMcpOAuthStage(
      isRegistration
        ? 'OAUTH_REGISTRATION_PRE_PROVIDER_ERROR'
        : 'OAUTH_REQUEST_PRE_PROVIDER_ERROR',
      () => prepareDirectMcpRevocation(authRequest),
    );

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

    const response = await runDirectMcpOAuthStage(
      isRegistration
        ? 'OAUTH_REGISTRATION_PROVIDER_THROWN'
        : 'OAUTH_REQUEST_PROVIDER_THROWN',
      () => auth.handler(authRequest),
    );
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
