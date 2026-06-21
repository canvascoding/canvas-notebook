import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { isAdminUser } from '@/app/lib/admin-auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { getPublicRequestOrigin } from '@/app/lib/utils/request-origin';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { requireRequestWorkspace, requireSessionWorkspace } from '@/app/lib/workspaces/request';
import {
  createPublicFileShares,
  listPublicFileShares,
  type PublicShareSource,
  type PublicShareStatus,
  type PublicShareTypeFilter,
} from '@/app/lib/public-sharing/public-file-shares';
import { normalizePublicShareSecurityMode } from '@/app/lib/public-sharing/public-share-security';

function parseStatus(value: string | null): PublicShareStatus | 'all' {
  if (value === 'active' || value === 'revoked' || value === 'missing' || value === 'stale' || value === 'expired') {
    return value;
  }
  return 'all';
}

function parseType(value: string | null): PublicShareTypeFilter {
  if (value === 'image' || value === 'html' || value === 'pdf' || value === 'media' || value === 'other') {
    return value;
  }
  return 'all';
}

function parseSource(value: string | null): PublicShareSource | 'all' {
  if (value === 'ui' || value === 'agent') return value;
  return 'all';
}

function parsePathFilters(searchParams: URLSearchParams): string[] {
  return Array.from(new Set([
    ...searchParams.getAll('path'),
    ...searchParams.getAll('paths').flatMap((value) => value.split('\n')),
  ].map((value) => value.trim()).filter(Boolean)));
}

function requestWorkspaceId(request: NextRequest): string | null {
  return request.headers.get(WORKSPACE_ID_HEADER)?.trim() || null;
}

function parseExpiry(body: Record<string, unknown>): Date | null {
  if (body.expiresAt === null || body.expiresAt === 'never') return null;
  if (body.expiresInDays === null || body.expiresInDays === 0 || body.expiresInDays === '0') return null;
  if (typeof body.expiresAt === 'string' && body.expiresAt.trim()) {
    const parsed = new Date(body.expiresAt);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) return parsed;
  }

  const rawDays = body.expiresInDays;
  const days = typeof rawDays === 'number'
    ? rawDays
    : typeof rawDays === 'string'
      ? Number.parseInt(rawDays, 10)
      : 30;
  if (!Number.isFinite(days) || days <= 0) return null;
  const normalizedDays = Math.min(Math.trunc(days), 365);
  return new Date(Date.now() + normalizedDays * 24 * 60 * 60 * 1000);
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'public-shares-list',
  });
  if (!limited.ok) return limited.response;

  const { searchParams } = new URL(request.url);
  const limit = Math.max(1, Math.min(Number.parseInt(searchParams.get('limit') || '500', 10), 1000));
  const isAdmin = isAdminUser(session.user);
  const requestedWorkspaceId = requestWorkspaceId(request);
  const workspaceResult = requestedWorkspaceId
    ? await requireSessionWorkspace(session, { workspaceId: requestedWorkspaceId, permissions: 'canRead' })
    : null;
  if (workspaceResult?.response) return workspaceResult.response;

  const shares = await listPublicFileShares({
    userId: session.user.id,
    workspace: workspaceResult?.workspace ?? null,
    isAdmin,
    status: parseStatus(searchParams.get('status')),
    type: parseType(searchParams.get('type')),
    source: parseSource(searchParams.get('source')),
    query: searchParams.get('q') || '',
    paths: parsePathFilters(searchParams),
    limit,
    baseUrl: getPublicRequestOrigin(request),
  });

  return NextResponse.json({ success: true, shares });
}

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canCreatePublicLinks' });
  if (workspaceResult.response) return workspaceResult.response;
  const { session, workspace } = workspaceResult;

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'public-shares-create',
  });
  if (!limited.ok) return limited.response;

  try {
    const body = await request.json() as Record<string, unknown>;
    const pathsValue = body.paths ?? body.path;
    const paths = Array.isArray(pathsValue)
      ? pathsValue.filter((value): value is string => typeof value === 'string')
      : typeof pathsValue === 'string'
        ? [pathsValue]
        : [];

    if (paths.length === 0) {
      return NextResponse.json({ success: false, error: 'At least one file path is required.' }, { status: 400 });
    }

    const result = await createPublicFileShares({
      paths,
      createdByUserId: session.user.id,
      workspace,
      source: 'ui',
      expiresAt: parseExpiry(body),
      reason: typeof body.reason === 'string' ? body.reason : null,
      securityMode: normalizePublicShareSecurityMode(body.securityMode),
      confirmPublicExposure: true,
      baseUrl: getPublicRequestOrigin(request),
    });

    clearFileTreeCache(workspace.workspaceId);

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create public shares.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
