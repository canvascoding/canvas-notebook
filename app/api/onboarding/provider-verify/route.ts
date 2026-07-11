import { NextRequest, NextResponse } from 'next/server';

import { isAdminUser } from '@/app/lib/admin-auth';
import { readAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/catalog-store';
import {
  providerProbeFailureHttpStatus,
  providerVerificationErrorResponse,
  verifyProviderInstallation,
} from '@/app/lib/agent-runtime-policy/provider-verification-service';
import { auth } from '@/app/lib/auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { markInstanceProviderVerified } from '@/app/lib/server-settings';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  if (!isOnboardingEnabled()) {
    return NextResponse.json({ success: false, error: 'Onboarding is disabled.' }, { status: 403 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdminUser(session.user)) {
    return NextResponse.json({ success: false, error: 'Forbidden: owner or admin required.' }, { status: 403 });
  }
  const organizationState = await readOrganizationPermissionForUser(session.user.id);
  if (!organizationState.configured || !organizationState.organizationId) {
    return NextResponse.json(
      { success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Complete the organization setup before verifying an AI provider.' },
      { status: 409 },
    );
  }
  if (!isOrganizationAdminLike(organizationState.permission)) {
    return NextResponse.json(
      { success: false, code: 'ADMIN_REQUIRED', error: 'Organization admin permission required.' },
      { status: 403 },
    );
  }
  if (await isOnboardingComplete()) {
    return NextResponse.json({ success: false, error: 'Instance onboarding is already complete.' }, { status: 409 });
  }

  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'onboarding-provider-verify',
  });
  if (!limited.ok) return limited.response;

  if (request.body !== null) {
    return NextResponse.json(
      { success: false, code: 'REQUEST_BODY_NOT_ALLOWED', error: 'Provider verification does not accept a request body.' },
      { status: 400 },
    );
  }

  try {
    const catalog = await readAppRuntimeCatalog(organizationState.organizationId);
    if (!catalog.defaultSelection) {
      return NextResponse.json(
        { success: false, code: 'APP_DEFAULT_REQUIRED', error: 'Save an app-default provider and model before verification.' },
        { status: 409 },
      );
    }
    const result = await verifyProviderInstallation({
      organizationId: organizationState.organizationId,
      actorUserId: session.user.id,
      providerInstallationId: catalog.defaultSelection.providerInstallationId,
    });
    await recordAuditEvent({
      organizationId: organizationState.organizationId,
      userId: session.user.id,
      source: 'onboarding',
      eventType: 'admin',
      entityType: 'ai_provider_installation',
      entityId: result.providerInstallationId,
      action: 'onboarding.ai_provider.verify',
      status: result.success ? 'success' : 'failure',
      summary: result.success ? 'Onboarding AI provider verified.' : 'Onboarding AI provider verification failed.',
      metadata: {
        providerInstallationId: result.providerInstallationId,
        providerId: result.providerId,
        modelId: result.modelId,
        verificationCode: result.code,
        catalogRevision: result.catalogRevision,
      },
    });
    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          code: result.code,
          error: 'Could not verify the app-default provider. Check its model, endpoint, and credentials.',
          data: result,
        },
        { status: providerProbeFailureHttpStatus(result.code) },
      );
    }

    const settings = await markInstanceProviderVerified(session.user.id, {
      catalogRevision: result.catalogRevision,
      providerInstallationId: result.providerInstallationId,
    });
    return NextResponse.json({
      success: true,
      data: {
        providerVerifiedAt: settings.providerVerifiedAt,
        providerInstallationId: result.providerInstallationId,
        providerId: result.providerId,
        modelId: result.modelId,
        catalogRevision: result.catalogRevision,
      },
    });
  } catch (error) {
    const response = providerVerificationErrorResponse(error);
    return NextResponse.json(
      { success: false, code: response.code, error: response.message },
      { status: response.status },
    );
  }
}
