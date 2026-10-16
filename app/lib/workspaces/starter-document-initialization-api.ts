import 'server-only';

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '../auth';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { rateLimit } from '../utils/rate-limit';
import {
  completeWorkspaceStarterDocumentInitialization,
  observeWorkspaceStarterDocumentInitialization,
} from './starter-document-initialization';
import type { WorkspaceStarterInitializationResult } from './starter-document-initialization-contract';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

function originalRequest(request: Request): NextRequest {
  // Keep the real credentials. Compiled routes can have a different NextRequest constructor.
  return new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
}

function unconfirmed(workspaceId: string): WorkspaceStarterInitializationResult {
  return { version: 1, workspaceId, status: 'pending', code: 'WORKSPACE_STARTER_INITIALIZATION_UNCONFIRMED' };
}

/** Creation has already committed. An unconfirmed starter must never report that
 * the workspace was not created or invite the caller to repeat workspace creation. */
export async function initializeCreatedWorkspaceStarter(
  request: Request,
  workspaceId: string,
): Promise<WorkspaceStarterInitializationResult | undefined> {
  if (!authenticatedNativeTextSessionEnabled()) return undefined;
  try {
    return await completeWorkspaceStarterDocumentInitialization(originalRequest(request), workspaceId, { requireIntent: true });
  } catch {
    return unconfirmed(workspaceId);
  }
}

/** Web and Mobile resume the persisted attempt for this workspace. GET only
 * observes; the caller cannot supply new operation IDs, content or source paths. */
export async function workspaceStarterInitializationResponse(
  request: NextRequest,
  workspaceId: string,
  action: 'observe' | 'complete',
): Promise<NextResponse> {
  if (!workspaceId.trim() || workspaceId.length > 160) {
    return NextResponse.json({ success: false, code: 'WORKSPACE_ID_INVALID' }, { status: 400, headers: responseHeaders });
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401, headers: responseHeaders });
  }
  if (action === 'complete') {
    const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'workspace-starter-initialization' });
    if (!limited.ok) return limited.response;
  }
  let initialization: WorkspaceStarterInitializationResult;
  try {
    const original = originalRequest(request);
    initialization = action === 'observe'
      ? await observeWorkspaceStarterDocumentInitialization(original, workspaceId, { requireIntent: true })
      : await completeWorkspaceStarterDocumentInitialization(original, workspaceId, { requireIntent: true });
  } catch {
    initialization = unconfirmed(workspaceId);
  }
  const status = action === 'observe' ? 200
    : initialization.status === 'pending' ? 202
    : initialization.status === 'blocked' ? 409 : 200;
  return NextResponse.json({ success: initialization.status !== 'blocked', starterDocumentInitialization: initialization },
    { status, headers: responseHeaders });
}
