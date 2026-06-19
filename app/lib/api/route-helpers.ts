import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { invalidateFileReferenceCache } from '@/app/lib/filesystem/file-reference-cache';
import type { WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import { clearFileTreeCache, clearSubtreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';

interface RateLimitOptions {
  limit: number;
  windowMs: number;
  keyPrefix: string;
}

interface InvalidateWorkspaceFileViewsOptions {
  fileOptions?: WorkspaceFileOperationOptions;
  fullTree?: boolean;
  subtreeDirs?: Iterable<string>;
  references?: boolean;
}

export async function requireApiSession(request: NextRequest): Promise<NextResponse | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  return session ? null : jsonError('Unauthorized', 401);
}

export function applyRateLimit(request: NextRequest, options: RateLimitOptions): NextResponse | null {
  const limited = rateLimit(request, options);
  return limited.ok ? null : limited.response;
}

export async function readJsonBody<T>(request: NextRequest): Promise<T> {
  return request.json() as Promise<T>;
}

export function jsonSuccess(payload: Record<string, unknown> = {}, init?: ResponseInit): NextResponse {
  return NextResponse.json({ success: true, ...payload }, init);
}

export function jsonError(error: string, status: number, details: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ success: false, error, ...details }, { status });
}

export function jsonServerError(scope: string, error: unknown, fallbackMessage: string): NextResponse {
  console.error(scope, error);
  const message = error instanceof Error ? error.message : fallbackMessage;
  return jsonError(message, 500);
}

export function invalidateWorkspaceFileViews({
  fileOptions,
  fullTree = false,
  subtreeDirs = [],
  references = true,
}: InvalidateWorkspaceFileViewsOptions = {}): void {
  const workspaceId = fileOptions?.workspace?.workspaceId;
  if (fullTree) {
    clearFileTreeCache(workspaceId);
  }

  for (const dirPath of subtreeDirs) {
    clearSubtreeCache(dirPath, workspaceId);
  }

  if (references) {
    invalidateFileReferenceCache(fileOptions);
  }
}
