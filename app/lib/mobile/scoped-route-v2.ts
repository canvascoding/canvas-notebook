import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import { normalizeDatabaseTimestamp } from '@/app/lib/db/timestamps';
import { assertUserSeatAccess, SeatLimitGuardError } from '@/app/lib/license/seat-limit';
import { requireSessionWorkspace, type RequestWorkspaceSession } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { isIntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { isAgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { managementErrorDetails } from '@/app/lib/agents/management-actions';
import { isSecretReadinessError } from '@/app/lib/secrets/readiness';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { MobileFileReviewError, mobileFileReviewWorkspaceId, readMobileFileReviewJson } from './file-review-route';

export const MOBILE_SCOPED_HEADERS = { 'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Authorization, Cookie, X-Canvas-Workspace-Id', 'X-Content-Type-Options': 'nosniff' };
export type MobileScopedContext = Readonly<{ userId: string; authSessionId: string; workspaceId: string;
  organizationId: string | null; projectId: string | null; workspaceType: WorkspaceContext['workspaceType'] }>;
type Proof = { session: RequestWorkspaceSession; userId: string; authSessionId: string; workspaceId: string;
  organizationId: string | null; projectId: string | null; workspaceType: WorkspaceContext['workspaceType'] };
const proofs = new WeakMap<MobileScopedContext, Proof>();
export class MobileScopedError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'MobileScopedError'; }
}

/** Identity is captured from Better Auth, never reconstructed from a DTO or a later browser session. */
async function originalSession(context: MobileScopedContext): Promise<Proof> {
  const proof = proofs.get(context);
  if (!proof || ['userId', 'authSessionId', 'workspaceId', 'organizationId', 'projectId', 'workspaceType']
    .some(key => Reflect.get(context, key) !== Reflect.get(proof, key))) {
    throw new MobileScopedError('UNAUTHORIZED', 'An original authenticated context is required.', 401);
  }
  const database = await openDb();
  try {
    const row = await database.get('SELECT s.user_id,s.expires_at,u.banned,u.role FROM "session" s JOIN "user" u ON u.id=s.user_id WHERE s.id=$1',
      [proof.authSessionId]) as { user_id?: unknown; expires_at?: unknown; banned?: unknown; role?: unknown } | undefined;
    const expiry = normalizeDatabaseTimestamp(Number(row?.expires_at));
    if (!row || row.user_id !== proof.userId || !Number.isFinite(expiry) || expiry <= Date.now()
      || row.banned === true || Number(row.banned) === 1 || row.role !== proof.session.user.role) {
      throw new MobileScopedError('UNAUTHORIZED', 'The original authenticated session is unavailable.', 401);
    }
    return proof;
  } finally { await database.close(); }
}
export async function revalidateMobileScopedContext(context: MobileScopedContext): Promise<void> {
  const proof = await originalSession(context);
  const seat = await assertUserSeatAccess({ userId: proof.userId });
  if (seat.userId !== proof.userId || seat.mode === 'team' && seat.organizationId !== proof.organizationId) {
    throw new MobileScopedError('WORKSPACE_UNAVAILABLE', 'The original account scope is unavailable.', 403);
  }
  const selected = await requireSessionWorkspace(proof.session, { workspaceId: proof.workspaceId, permissions: 'canRead' });
  if (selected.response || selected.workspace.workspaceId !== proof.workspaceId || (selected.workspace.status ?? 'active') !== 'active'
    || (selected.workspace.organizationId ?? null) !== proof.organizationId || (selected.workspace.projectId ?? null) !== proof.projectId
    || selected.workspace.workspaceType !== proof.workspaceType) {
    throw new MobileScopedError('WORKSPACE_UNAVAILABLE', 'The original workspace is unavailable.', selected.response?.status ?? 403);
  }
  await originalSession(context);
}
export async function requireMobileScopedContext(request: NextRequest, allowedQueryKeys: readonly string[] = []): Promise<MobileScopedContext> {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const browserMarked = ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'].some(key => request.headers.has(key));
    if (browserMarked && !requireTrustedMutationOrigin(request).ok) {
      throw new MobileScopedError('CSRF_ORIGIN_INVALID', 'The request origin is not allowed.', 403);
    }
    if (!/^application\/json(?:\s*;.*)?$/iu.test(request.headers.get('content-type') ?? '')) {
      throw new MobileScopedError('INVALID_REQUEST', 'A JSON request is required.', 415);
    }
  }
  const workspaceId = mobileFileReviewWorkspaceId(request), query = new URL(request.url).searchParams;
  const permitted = new Set(['workspaceId', ...allowedQueryKeys]);
  for (const key of query.keys()) if (!permitted.has(key) || query.getAll(key).length !== 1) {
    throw new MobileScopedError('INVALID_REQUEST', 'Unknown or duplicate selectors are not supported.');
  }
  if (query.has('workspaceId') && query.get('workspaceId') !== workspaceId) throw new MobileScopedError('INVALID_REQUEST', 'The workspace selectors do not match.');
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session || !session.session.id) throw new MobileScopedError('UNAUTHORIZED', 'Sign in to use scoped resources.', 401);
  const selected = await requireSessionWorkspace(session, { workspaceId, permissions: 'canRead' });
  if (selected.response) throw new MobileScopedError('WORKSPACE_UNAVAILABLE', 'The active workspace is unavailable.', selected.response.status);
  const context = Object.freeze({ userId: session.user.id, authSessionId: session.session.id, workspaceId,
    organizationId: selected.workspace.organizationId ?? null, projectId: selected.workspace.projectId ?? null,
    workspaceType: selected.workspace.workspaceType });
  proofs.set(context, { ...context, session: structuredClone(session) });
  await revalidateMobileScopedContext(context);
  const limited = rateLimit(request, { limit: request.method === 'GET' ? 90 : 30, windowMs: 60_000,
    keyPrefix: `mobile-scoped-v2-${request.method}`, verifiedUserId: context.userId });
  if (!limited.ok) throw new MobileScopedError('RATE_LIMITED', 'Please wait before trying again.', 429);
  return context;
}
/** Returns domain JSON after removing only the mandatory native envelope version. Domain schemas remain authoritative. */
export async function mobileScopedJson(request: Request, maxBytes = 1_048_576): Promise<Record<string, unknown>> {
  const body = await readMobileFileReviewJson(request, maxBytes);
  if (body.contractVersion !== 2) throw new MobileScopedError('INVALID_REQUEST', 'A version 2 request is required.');
  const { contractVersion: _version, ...domain } = body;
  return domain;
}
/** Revalidates after the action, including cached read results; no source proof or auth material is serialized. */
export async function mobileScopedResponse(context: MobileScopedContext, data: Record<string, unknown>, status = 200): Promise<NextResponse> {
  await revalidateMobileScopedContext(context);
  const value = { success: true, contractVersion: 2, workspaceId: context.workspaceId, checkedAt: Date.now(), data };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1_048_576) throw new MobileScopedError('RESPONSE_TOO_LARGE', 'The response exceeds its limits.', 413);
  return NextResponse.json(value, { status, headers: MOBILE_SCOPED_HEADERS });
}
export function mobileScopedError(error: unknown): NextResponse {
  let code = 'SCOPED_RESOURCE_UNAVAILABLE', status = 503;
  const secrets = isSecretReadinessError(error);
  if (secrets) { code = error.code; status = 503; }
  else if (error instanceof MobileScopedError || error instanceof MobileFileReviewError || error instanceof CapabilityResourceError
    || error instanceof SeatLimitGuardError || isIntegrationConnectionError(error) || isAgentWorkflowError(error)) {
    code = error.code; status = error.status;
  } else if (error instanceof Error && error.name === 'ZodError') { code = 'INVALID_REQUEST'; status = 400; }
  else {
    const domain = managementErrorDetails(error);
    if (domain.status >= 400 && domain.status < 500) { code = domain.code; status = domain.status; }
  }
  if (!/^[A-Za-z0-9_]{1,100}$/u.test(code)) code = 'SCOPED_RESOURCE_UNAVAILABLE';
  if (!Number.isInteger(status) || status < 400 || status > 599) status = 503;
  // Domain messages may contain names, paths or provider diagnostics. The public code carries the actionable reason.
  const message = secrets ? 'Configure the required secrets in Settings.' : status === 401 ? 'Sign in again.' : status === 403 || status === 404 ? 'The selected resource is unavailable.'
    : status === 409 ? 'The selected resource changed. Reload its current revision.' : status === 400 || status === 415 ? 'The scoped request is invalid.'
      : status === 413 ? 'The request or response exceeds its limits.' : status === 429 ? 'Please wait before trying again.' : 'The scoped resource is unavailable.';
  return NextResponse.json({ success: false, contractVersion: 2, code, error: message,
    ...(secrets ? { setupHref: '/settings?tab=secrets' } : {}) }, { status, headers: MOBILE_SCOPED_HEADERS });
}
