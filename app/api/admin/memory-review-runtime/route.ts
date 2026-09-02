import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { providerVerificationErrorResponse } from '@/app/lib/agent-runtime-policy/provider-verification-service';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  readMemoryReviewRuntimeCatalog,
  verifyAndConfigureMemoryReviewRuntime,
} from '@/app/lib/memory/runtime-configuration';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireMemoryRuntimeAdmin(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin;
  const organization = await readOrganizationPermissionForUser(admin.session.user.id);
  if (!organization.configured || !organization.organizationId) {
    return { ok: false as const, response: NextResponse.json({ success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Organization setup is required.' }, { status: 409 }) };
  }
  if (!isOrganizationAdminLike(organization.permission)) {
    return { ok: false as const, response: NextResponse.json({ success: false, code: 'ADMIN_REQUIRED', error: 'Organization admin permission required.' }, { status: 403 }) };
  }
  return { ok: true as const, session: admin.session, organizationId: organization.organizationId };
}

export async function GET(request: NextRequest) {
  const admin = await requireMemoryRuntimeAdmin(request);
  if (!admin.ok) return admin.response;
  return NextResponse.json({ success: true, data: await readMemoryReviewRuntimeCatalog(admin.organizationId) });
}

export async function POST(request: NextRequest) {
  const admin = await requireMemoryRuntimeAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, {
    limit: 5,
    windowMs: 60_000,
    keyPrefix: `admin-memory-review-runtime:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const providerInstallationId = typeof body?.providerInstallationId === 'string' ? body.providerInstallationId.trim() : '';
  const modelId = typeof body?.modelId === 'string' ? body.modelId.trim() : '';
  const expectedCatalogRevision = Number(body?.expectedCatalogRevision);
  if (!providerInstallationId || !modelId || !Number.isInteger(expectedCatalogRevision) || expectedCatalogRevision < 1) {
    return NextResponse.json({ success: false, code: 'INVALID_MEMORY_REVIEWER_SELECTION', error: 'Select a provider and model from the current catalog.' }, { status: 400 });
  }

  try {
    const result = await verifyAndConfigureMemoryReviewRuntime({
      organizationId: admin.organizationId,
      actorUserId: admin.session.user.id,
      providerInstallationId,
      modelId,
      expectedCatalogRevision,
      signal: request.signal,
    });
    await recordAuditEvent({
      organizationId: admin.organizationId,
      userId: admin.session.user.id,
      source: 'settings',
      eventType: 'admin',
      entityType: 'memory_review_runtime',
      entityId: admin.organizationId,
      action: 'memory_reviewer.verify',
      status: 'success',
      summary: 'Memory Reviewer verified and configured.',
      metadata: { providerInstallationId, modelId, catalogRevision: result.verification.catalogRevision, reactivatedJobs: result.reactivatedJobs },
    });
    const { triggerMemoryReviewWorker } = await import('@/app/lib/memory/review-worker');
    triggerMemoryReviewWorker();
    return NextResponse.json({ success: true, data: await readMemoryReviewRuntimeCatalog(admin.organizationId) });
  } catch (error) {
    const response = providerVerificationErrorResponse(error);
    await recordAuditEvent({
      organizationId: admin.organizationId,
      userId: admin.session.user.id,
      source: 'settings',
      eventType: 'admin',
      entityType: 'memory_review_runtime',
      entityId: admin.organizationId,
      action: 'memory_reviewer.verify',
      status: response.status >= 500 ? 'error' : 'failure',
      summary: 'Memory Reviewer verification failed.',
      metadata: { providerInstallationId, modelId, errorCode: response.code },
    });
    return NextResponse.json({ success: false, code: response.code, error: response.message }, { status: response.status });
  }
}
