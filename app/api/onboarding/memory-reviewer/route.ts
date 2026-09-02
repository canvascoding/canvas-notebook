import { NextRequest, NextResponse } from 'next/server';

import { isAdminUser } from '@/app/lib/admin-auth';
import { providerVerificationErrorResponse } from '@/app/lib/agent-runtime-policy/provider-verification-service';
import { auth } from '@/app/lib/auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  readMemoryReviewRuntimeCatalog,
  verifyAndConfigureMemoryReviewRuntime,
} from '@/app/lib/memory/runtime-configuration';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireOnboardingMemoryAdmin(request: NextRequest) {
  if (!isOnboardingEnabled()) {
    return { ok: false as const, response: NextResponse.json({ success: false, error: 'Onboarding is disabled.' }, { status: 403 }) };
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return { ok: false as const, response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) };
  }
  if (!isAdminUser(session.user)) {
    return { ok: false as const, response: NextResponse.json({ success: false, error: 'Forbidden: owner or admin required.' }, { status: 403 }) };
  }
  if (await isOnboardingComplete()) {
    return { ok: false as const, response: NextResponse.json({ success: false, error: 'Instance onboarding is already complete.' }, { status: 409 }) };
  }
  const organization = await readOrganizationPermissionForUser(session.user.id);
  if (!organization.configured || !organization.organizationId) {
    return { ok: false as const, response: NextResponse.json({ success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Complete the organization setup before configuring the Memory Reviewer.' }, { status: 409 }) };
  }
  if (!isOrganizationAdminLike(organization.permission)) {
    return { ok: false as const, response: NextResponse.json({ success: false, code: 'ADMIN_REQUIRED', error: 'Organization admin permission required.' }, { status: 403 }) };
  }
  return { ok: true as const, session, organizationId: organization.organizationId };
}

export async function GET(request: NextRequest) {
  const admin = await requireOnboardingMemoryAdmin(request);
  if (!admin.ok) return admin.response;
  return NextResponse.json({
    success: true,
    data: await readMemoryReviewRuntimeCatalog(admin.organizationId),
  });
}

export async function POST(request: NextRequest) {
  const admin = await requireOnboardingMemoryAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, {
    limit: 5,
    windowMs: 60_000,
    keyPrefix: `onboarding-memory-reviewer:${admin.session.user.id}`,
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
      source: 'onboarding',
      eventType: 'admin',
      entityType: 'memory_review_runtime',
      entityId: admin.organizationId,
      action: 'onboarding.memory_reviewer.verify',
      status: 'success',
      summary: 'Onboarding Memory Reviewer verified and configured.',
      metadata: {
        providerInstallationId,
        modelId,
        catalogRevision: result.verification.catalogRevision,
        reactivatedJobs: result.reactivatedJobs,
      },
    });
    const { triggerMemoryReviewWorker } = await import('@/app/lib/memory/review-worker');
    triggerMemoryReviewWorker();
    return NextResponse.json({ success: true, data: { ...result, catalog: await readMemoryReviewRuntimeCatalog(admin.organizationId) } });
  } catch (error) {
    const response = providerVerificationErrorResponse(error);
    await recordAuditEvent({
      organizationId: admin.organizationId,
      userId: admin.session.user.id,
      source: 'onboarding',
      eventType: 'admin',
      entityType: 'memory_review_runtime',
      entityId: admin.organizationId,
      action: 'onboarding.memory_reviewer.verify',
      status: response.status >= 500 ? 'error' : 'failure',
      summary: 'Onboarding Memory Reviewer verification failed.',
      metadata: { providerInstallationId, modelId, errorCode: response.code },
    });
    return NextResponse.json({ success: false, code: response.code, error: response.message }, { status: response.status });
  }
}
