import { NextRequest, NextResponse } from 'next/server';

import {
  providerProbeFailureHttpStatus,
  providerVerificationErrorResponse,
  verifyProviderInstallation,
  type ProviderVerificationResult,
} from '@/app/lib/agent-runtime-policy/provider-verification-service';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { recordAuditEvent, type AuditStatus } from '@/app/lib/audit/audit-service';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { hasRequestPayload } from '@/app/lib/api/request-body';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const INSTALLATION_ID_PATTERN = /^aip_[a-f0-9]{24}$/u;

async function requireProviderVerificationAdmin(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin;

  const state = await readOrganizationPermissionForUser(admin.session.user.id);
  if (!state.configured || !state.organizationId) {
    return {
      ok: false as const,
      response: NextResponse.json(
        {
          success: false,
          code: 'ORGANIZATION_SETUP_REQUIRED',
          error: 'Complete the app setup before verifying AI providers.',
        },
        { status: 409 },
      ),
    };
  }
  if (!isOrganizationAdminLike(state.permission)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, code: 'ADMIN_REQUIRED', error: 'Organization admin permission required.' },
        { status: 403 },
      ),
    };
  }

  return {
    ok: true as const,
    session: admin.session,
    organizationId: state.organizationId,
  };
}

async function recordVerificationAudit(input: {
  organizationId: string;
  actorUserId: string;
  installationId: string;
  status: AuditStatus;
  summary: string;
  result?: ProviderVerificationResult;
  errorCode?: string;
}) {
  await recordAuditEvent({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    source: 'agent-runtime',
    eventType: 'admin',
    entityType: 'ai_provider_installation',
    entityId: INSTALLATION_ID_PATTERN.test(input.installationId) ? input.installationId : null,
    action: 'ai_provider_installation.verify',
    status: input.status,
    summary: input.summary,
    metadata: input.result
      ? {
          providerInstallationId: input.result.providerInstallationId,
          providerId: input.result.providerId,
          modelId: input.result.modelId,
          verificationCode: input.result.code,
          providerStatus: input.result.status,
          catalogRevision: input.result.catalogRevision,
          providerRevision: input.result.providerRevision,
          durationMs: input.result.durationMs,
        }
      : { errorCode: input.errorCode ?? 'PROVIDER_VERIFICATION_FAILED' },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ installationId: string }> },
) {
  const admin = await requireProviderVerificationAdmin(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 5,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-provider-verify:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  const { installationId: rawInstallationId } = await params;
  const installationId = rawInstallationId.trim();
  // Verification credentials are resolved only from the installation's
  // server-side scope. This endpoint intentionally accepts no request body.
  if (await hasRequestPayload(request)) {
    await recordVerificationAudit({
      organizationId: admin.organizationId,
      actorUserId: admin.session.user.id,
      installationId,
      status: 'blocked',
      summary: 'AI provider verification rejected an unexpected request body.',
      errorCode: 'REQUEST_BODY_NOT_ALLOWED',
    });
    return NextResponse.json(
      {
        success: false,
        code: 'REQUEST_BODY_NOT_ALLOWED',
        error: 'Provider verification does not accept a request body.',
      },
      { status: 400 },
    );
  }

  try {
    const result = await verifyProviderInstallation({
      organizationId: admin.organizationId,
      actorUserId: admin.session.user.id,
      providerInstallationId: installationId,
      signal: request.signal,
    });
    await recordVerificationAudit({
      organizationId: admin.organizationId,
      actorUserId: admin.session.user.id,
      installationId,
      status: result.success ? 'success' : 'failure',
      summary: result.success
        ? 'AI provider installation verified.'
        : 'AI provider installation verification failed.',
      result,
    });

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          code: result.code,
          error: 'Could not verify the configured provider default. Check its endpoint and credentials.',
          data: result,
        },
        { status: providerProbeFailureHttpStatus(result.code) },
      );
    }
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const response = providerVerificationErrorResponse(error);
    await recordVerificationAudit({
      organizationId: admin.organizationId,
      actorUserId: admin.session.user.id,
      installationId,
      status: response.status >= 500 ? 'error' : 'blocked',
      summary: 'AI provider installation verification could not start or persist.',
      errorCode: response.code,
    });
    if (response.status >= 500) {
      console.error('[admin/agent-runtime/providers/verify] Verification failed.', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    return NextResponse.json(
      { success: false, code: response.code, error: response.message },
      { status: response.status },
    );
  }
}
