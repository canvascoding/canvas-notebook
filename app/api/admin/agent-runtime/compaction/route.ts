import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  PiCompactionSettingsError,
  readPiCompactionAdminSettings,
  updatePiCompactionAdminSettings,
} from '@/app/lib/pi/compaction/settings-service';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireCompactionAdmin(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin;
  const organization = await readOrganizationPermissionForUser(admin.session.user.id);
  if (!organization.configured || !organization.organizationId) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Complete the app setup before configuring compaction.' },
        { status: 409 },
      ),
    };
  }
  if (!isOrganizationAdminLike(organization.permission)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, code: 'ADMIN_REQUIRED', error: 'Organization admin permission required.' },
        { status: 403 },
      ),
    };
  }
  return { ok: true as const, session: admin.session, organizationId: organization.organizationId };
}

function parseUpdate(value: unknown): {
  tailMode: 'legacy' | 'lean';
  summaryModel: string | null;
  expectedCatalogRevision: number;
  expectedSettingsRevision: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_COMPACTION_SETTINGS');
  const input = value as Record<string, unknown>;
  const allowed = new Set(['tailMode', 'summaryModel', 'expectedCatalogRevision', 'expectedSettingsRevision']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('INVALID_COMPACTION_SETTINGS');
  if (input.tailMode !== 'legacy' && input.tailMode !== 'lean') throw new Error('INVALID_COMPACTION_SETTINGS');
  if (input.summaryModel !== null && typeof input.summaryModel !== 'string') throw new Error('INVALID_COMPACTION_SETTINGS');
  if (!Number.isInteger(input.expectedCatalogRevision) || (input.expectedCatalogRevision as number) < 0) {
    throw new Error('INVALID_COMPACTION_SETTINGS');
  }
  if (!Number.isInteger(input.expectedSettingsRevision) || (input.expectedSettingsRevision as number) < 0) {
    throw new Error('INVALID_COMPACTION_SETTINGS');
  }
  return {
    tailMode: input.tailMode,
    summaryModel: input.summaryModel,
    expectedCatalogRevision: input.expectedCatalogRevision as number,
    expectedSettingsRevision: input.expectedSettingsRevision as number,
  };
}

function routeError(error: unknown) {
  if (error instanceof PiCompactionSettingsError) {
    return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
  }
  if (error instanceof Error && error.message === 'INVALID_COMPACTION_SETTINGS') {
    return NextResponse.json(
      {
        success: false,
        code: 'INVALID_COMPACTION_SETTINGS',
        error: 'tailMode, summaryModel, and expectedCatalogRevision are invalid.',
      },
      { status: 400 },
    );
  }
  console.error('[admin/agent-runtime/compaction] Request failed.', {
    errorType: error instanceof Error ? error.name : 'UnknownError',
  });
  return NextResponse.json(
    { success: false, code: 'COMPACTION_SETTINGS_FAILED', error: 'Failed to update compaction settings.' },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  const admin = await requireCompactionAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-compaction-get:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;
  try {
    return NextResponse.json({ success: true, data: await readPiCompactionAdminSettings(admin.organizationId) });
  } catch (error) {
    return routeError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const admin = await requireCompactionAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-compaction-patch:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const update = parseUpdate(await request.json().catch(() => null));
    const settings = await updatePiCompactionAdminSettings({
      organizationId: admin.organizationId,
      actorUserId: admin.session.user.id,
      ...update,
    });
    await recordAuditEvent({
      organizationId: admin.organizationId,
      userId: admin.session.user.id,
      source: 'agent-runtime',
      eventType: 'admin',
      entityType: 'pi_compaction_settings',
      entityId: admin.organizationId,
      action: 'pi_compaction_settings.update',
      status: 'success',
      summary: 'Session compaction settings updated.',
      metadata: {
        tailMode: update.tailMode,
        hasSummaryModel: update.summaryModel !== null,
        catalogRevision: settings.catalogRevision,
        settingsRevision: settings.settingsRevision,
      },
    });
    return NextResponse.json({ success: true, data: settings });
  } catch (error) {
    return routeError(error);
  }
}
