import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
} from '@/app/lib/license/entitlements';
import { listMobileWorkspaceMembers } from '@/app/lib/mobile/workspaces';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { WorkspaceOperationError } from '@/app/lib/workspaces/service';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Vary': `Cookie, ${WORKSPACE_ID_HEADER}`,
  'X-Content-Type-Options': 'nosniff',
};

type MentionCandidate = {
  detail: string | null;
  label: string;
  userId: string;
};

function safeMentionLabel(name: string | null | undefined, email: string | null | undefined): string {
  const emailName = email?.split('@')[0];
  return (name?.trim() || emailName?.trim() || 'Member')
    .replace(/[|{}\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120) || 'Member';
}

function candidateFromUser(user: {
  email?: string | null;
  id: string;
  name?: string | null;
}): MentionCandidate {
  return {
    detail: user.email?.trim().slice(0, 200) || null,
    label: safeMentionLabel(user.name, user.email),
    userId: user.id,
  };
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof WorkspaceOperationError) {
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status: error.status, headers: responseHeaders },
    );
  }
  if (error instanceof LicenseEntitlementError) {
    return NextResponse.json(
      licenseEntitlementErrorPayload(error),
      { status: error.statusCode, headers: responseHeaders },
    );
  }
  console.error('[API] Workspace mention candidates failed:', error);
  return NextResponse.json(
    { success: false, code: 'INTERNAL_ERROR', error: 'Mention candidates could not be loaded.' },
    { status: 500, headers: responseHeaders },
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' },
      { status: 401, headers: responseHeaders },
    );
  }

  const limited = rateLimit(request, {
    keyPrefix: 'workspace-mention-candidates',
    limit: 120,
    windowMs: 60_000,
  });
  if (!limited.ok) return limited.response;

  const { id } = await context.params;
  const workspaceId = id.trim();
  const selectedWorkspaceId = request.headers.get(WORKSPACE_ID_HEADER)?.trim() || '';
  if (!workspaceId || selectedWorkspaceId !== workspaceId) {
    return NextResponse.json(
      {
        success: false,
        code: 'WORKSPACE_CONTEXT_MISMATCH',
        error: 'Select this workspace to load mention candidates.',
      },
      { status: 409, headers: responseHeaders },
    );
  }

  const currentUser = candidateFromUser(session.user);

  try {
    const result = await listMobileWorkspaceMembers({
      actor: resolveWorkspaceActor({
        id: session.user.id,
        email: session.user.email,
        role: session.user.role,
      }),
      workspaceId,
    });
    const candidates = result.members
      .filter((member) => member.status === 'active')
      .map((member) => candidateFromUser({
        email: member.email,
        id: member.userId,
        name: member.name,
      }));
    if (!candidates.some((candidate) => candidate.userId === currentUser.userId)) {
      candidates.unshift(currentUser);
    }
    return NextResponse.json(
      { success: true, candidates: candidates.slice(0, 200) },
      { headers: responseHeaders },
    );
  } catch (error) {
    if (
      error instanceof WorkspaceOperationError
      && [
        'WORKSPACE_MEMBERS_UNSUPPORTED',
        'WORKSPACE_ORGANIZATION_MANAGED_VIA_ORG',
        'WORKSPACE_PERSONAL_NO_MEMBERS',
      ].includes(error.code)
    ) {
      return NextResponse.json(
        { success: true, candidates: [currentUser] },
        { headers: responseHeaders },
      );
    }
    return errorResponse(error);
  }
}
