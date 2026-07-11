import { NextRequest, NextResponse } from 'next/server';

import {
  ManagedCatalogSyncError,
  syncManagedAgentRuntimeCatalog,
} from '@/app/lib/agent-runtime-policy/bootstrap-service';
import { catalogErrorResponse } from '@/app/lib/agent-runtime-policy/catalog-service';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const state = await readOrganizationPermissionForUser(admin.session.user.id);
  if (!state.configured || !state.organizationId) {
    return NextResponse.json(
      { success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Complete the app setup first.' },
      { status: 409 },
    );
  }
  if (!isOrganizationAdminLike(state.permission)) {
    return NextResponse.json(
      { success: false, code: 'ADMIN_REQUIRED', error: 'Organization admin permission required.' },
      { status: 403 },
    );
  }

  const limited = rateLimit(request, {
    limit: 5,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-managed-sync:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  const payload = await request.json().catch(() => null);
  if (
    !isRecord(payload)
    || Object.keys(payload).some((key) => key !== 'expectedRevision' && key !== 'setAsDefault')
    || typeof payload.expectedRevision !== 'number'
    || !Number.isInteger(payload.expectedRevision)
    || payload.expectedRevision < 0
    || typeof payload.setAsDefault !== 'boolean'
  ) {
    return NextResponse.json(
      { success: false, code: 'INVALID_MANAGED_SYNC_INPUT', error: 'Managed sync input is invalid.' },
      { status: 400 },
    );
  }

  try {
    const catalog = await syncManagedAgentRuntimeCatalog({
      organizationId: state.organizationId,
      actorUserId: admin.session.user.id,
      expectedRevision: payload.expectedRevision,
      setAsDefault: payload.setAsDefault,
    });
    return NextResponse.json({ success: true, data: { catalog } });
  } catch (error) {
    const response = error instanceof ManagedCatalogSyncError
      ? { status: error.status, code: error.code, message: error.message }
      : catalogErrorResponse(error);
    await recordAuditEvent({
      organizationId: state.organizationId,
      userId: admin.session.user.id,
      source: 'agent-runtime',
      eventType: 'admin',
      entityType: 'ai_runtime_catalog',
      entityId: state.organizationId,
      action: 'ai_managed_catalog.sync',
      status: response.status >= 500 ? 'error' : 'blocked',
      summary: 'Canvas Control Plane model catalog sync failed.',
      metadata: { errorCode: response.code },
    });
    if (response.status >= 500) {
      console.error('[admin/agent-runtime/managed-sync] Sync failed.', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    return NextResponse.json(
      { success: false, code: response.code, error: response.message },
      { status: response.status },
    );
  }
}
