import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { jsonDatabaseUnavailable } from '@/app/lib/api/route-helpers';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { requireRequestWorkspace, type RequestWorkspace } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { ExcalidrawDocumentError } from './scene-service';
import { ExcalidrawApiInputError } from './api-contract';
import { assertExcalidrawProviderAvailable } from './provider';

export async function requireExcalidrawRequestWorkspace(request: NextRequest, options: {
  workspaceId?: string; permissions: 'canRead' | 'canWrite';
}) {
  const ids = [options.workspaceId, request.headers.get(WORKSPACE_ID_HEADER),
    ...request.nextUrl.searchParams.getAll('workspaceId')].filter((value): value is string => value !== undefined && value !== null);
  if (ids.some(value => !value.trim() || value.length > 200)) throw new ExcalidrawApiInputError('workspaceId must contain 1–200 characters.');
  const unique = new Set(ids.map(value => value.trim()));
  if (unique.size > 1) throw new ExcalidrawApiInputError('The body, query and workspace header must identify the same workspace.');
  const result = await requireRequestWorkspace(request, { workspaceId: ids[0]?.trim(), permissions: options.permissions });
  if (result.response && result.response.status >= 500) await assertExcalidrawProviderAvailable();
  return result;
}

/** Re-resolve the same session and workspace immediately before a locked operation. */
export function excalidrawRequestAuthority(request: NextRequest, initial: RequestWorkspace,
  permissions: 'canRead' | 'canWrite'): () => Promise<WorkspaceContext> {
  return async () => {
    request.signal.throwIfAborted();
    const fresh = await requireRequestWorkspace(request, { workspaceId: initial.workspace.workspaceId, permissions });
    if (fresh.response && fresh.response.status >= 500) await assertExcalidrawProviderAvailable();
    if (fresh.response) throw new ExcalidrawDocumentError('EXCALIDRAW_AUTHORITY_CHANGED', fresh.response.status,
      'The session or workspace no longer allows this operation. Sign in and read the document again.');
    if (fresh.session.user.id !== initial.session.user.id || fresh.session.session.id !== initial.session.session.id
      || fresh.workspace.workspaceId !== initial.workspace.workspaceId || fresh.workspace.rootPath !== initial.workspace.rootPath
      || (fresh.workspace.organizationId ?? null) !== (initial.workspace.organizationId ?? null)) {
      throw new ExcalidrawDocumentError('EXCALIDRAW_AUTHORITY_CHANGED', 403, 'The session or workspace identity changed. Read the document again.');
    }
    return fresh.workspace;
  };
}

export function excalidrawRouteError(error: unknown): NextResponse {
  const database = jsonDatabaseUnavailable(error);
  if (database) return database;
  const detail = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; message?: unknown } : {};
  const code = typeof detail.code === 'string' ? detail.code : 'EXCALIDRAW_OPERATION_FAILED';
  const status = Number.isSafeInteger(detail.status) && Number(detail.status) >= 400 && Number(detail.status) <= 599
    ? Number(detail.status) : /IDEMPOTENCY_CONFLICT|RESYNC_REQUIRED|CHECKPOINT_CONFLICT/u.test(code) ? 409
      : code === 'ENOENT' ? 404 : 500;
  const message = code === 'ENOENT' ? 'The Excalidraw document was not found.'
    : typeof detail.code === 'string' && typeof detail.message === 'string' ? detail.message
      : 'The Excalidraw operation failed. Read the current scene before retrying.';
  return NextResponse.json({ success: false, code, error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}
