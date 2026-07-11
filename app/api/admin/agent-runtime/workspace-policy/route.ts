import { NextRequest, NextResponse } from 'next/server';

import { readAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/catalog-store';
import { readWorkspaceModelPolicy } from '@/app/lib/agent-runtime-policy/runtime-store';
import {
  parseWorkspacePolicyUpdate,
  replaceWorkspaceRuntimePolicy,
  resetWorkspaceRuntimePolicy,
  runtimeErrorResponse,
} from '@/app/lib/agent-runtime-policy/runtime-service';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireSessionWorkspace } from '@/app/lib/workspaces/request';

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

async function requirePolicyAdmin(request: NextRequest, workspaceId: string | null) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin;
  if (!workspaceId) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, code: 'WORKSPACE_ID_REQUIRED', error: 'workspaceId is required.' },
        { status: 400 },
      ),
    };
  }
  const access = await requireSessionWorkspace(admin.session, {
    workspaceId,
    permissions: ['canRead', 'canManageWorkspace'],
  });
  if (access.response) return { ok: false as const, response: access.response };
  if (!access.workspace.organizationId) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Complete the app setup first.' },
        { status: 409 },
      ),
    };
  }
  if (access.workspace.workspaceType === 'personal') {
    return {
      ok: false as const,
      response: NextResponse.json(
        {
          success: false,
          code: 'WORKSPACE_POLICY_NOT_SUPPORTED',
          error: 'Personal workspaces use app defaults and user preferences.',
        },
        { status: 409 },
      ),
    };
  }
  return {
    ok: true as const,
    session: admin.session,
    workspace: access.workspace,
    organizationId: access.workspace.organizationId,
  };
}

function routeError(error: unknown) {
  const response = runtimeErrorResponse(error);
  if (response.status >= 500) {
    console.error('[admin/agent-runtime/workspace-policy] Request failed.', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  return NextResponse.json(
    { success: false, code: response.code, error: response.message, ...(response.details ?? {}) },
    { status: response.status },
  );
}

function parseOptionalExpectedRevision(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  if (!/^\d+$/u.test(value)) throw new Error('INVALID_EXPECTED_REVISION');
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new Error('INVALID_EXPECTED_REVISION');
  return revision;
}

export async function GET(request: NextRequest) {
  const admin = await requirePolicyAdmin(request, normalizedString(request.nextUrl.searchParams.get('workspaceId')));
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-workspace-policy-get:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const [catalog, policy] = await Promise.all([
      readAppRuntimeCatalog(admin.organizationId),
      readWorkspaceModelPolicy(admin.organizationId, admin.workspace.workspaceId),
    ]);
    return NextResponse.json({
      success: true,
      data: {
        workspace: {
          id: admin.workspace.workspaceId,
          type: admin.workspace.workspaceType,
          name: admin.workspace.displayName ?? null,
        },
        catalogRevision: catalog.revision,
        policy,
      },
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function PUT(request: NextRequest) {
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  const admin = await requirePolicyAdmin(request, normalizedString(payload?.workspaceId));
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-workspace-policy-put:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const update = parseWorkspacePolicyUpdate(payload);
    const policy = await replaceWorkspaceRuntimePolicy({
      organizationId: admin.organizationId,
      workspaceId: admin.workspace.workspaceId,
      workspaceType: admin.workspace.workspaceType,
      actorUserId: admin.session.user.id,
      update,
    });
    await recordAuditEvent({
      organizationId: admin.organizationId,
      workspaceId: admin.workspace.workspaceId,
      userId: admin.session.user.id,
      source: 'agent-runtime',
      eventType: 'admin',
      entityType: 'ai_workspace_model_policy',
      entityId: admin.workspace.workspaceId,
      action: 'ai_workspace_model_policy.update',
      status: 'success',
      summary: 'Workspace AI model policy updated.',
      metadata: {
        revision: policy.revision,
        allowedModelCount: policy.allowedModels?.length ?? null,
        allowUserCredentials: policy.allowUserCredentials,
        defaultSelection: policy.defaultSelection,
      },
    });
    return NextResponse.json({ success: true, data: { policy } });
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const admin = await requirePolicyAdmin(request, normalizedString(request.nextUrl.searchParams.get('workspaceId')));
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-workspace-policy-delete:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const expectedRevision = parseOptionalExpectedRevision(request.nextUrl.searchParams.get('expectedRevision'));
    const deleted = await resetWorkspaceRuntimePolicy({
      organizationId: admin.organizationId,
      workspaceId: admin.workspace.workspaceId,
      expectedRevision,
    });
    await recordAuditEvent({
      organizationId: admin.organizationId,
      workspaceId: admin.workspace.workspaceId,
      userId: admin.session.user.id,
      source: 'agent-runtime',
      eventType: 'admin',
      entityType: 'ai_workspace_model_policy',
      entityId: admin.workspace.workspaceId,
      action: 'ai_workspace_model_policy.reset',
      status: 'success',
      summary: 'Workspace AI model policy reset to the app catalog.',
      metadata: { deleted },
    });
    return NextResponse.json({ success: true, data: { policy: null } });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_EXPECTED_REVISION') {
      return NextResponse.json(
        { success: false, code: 'INVALID_EXPECTED_REVISION', error: 'expectedRevision is invalid.' },
        { status: 400 },
      );
    }
    return routeError(error);
  }
}
