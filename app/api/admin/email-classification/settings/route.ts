import { NextRequest, NextResponse } from 'next/server';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  emailClassificationAdminErrorDetails, readAdminEmailClassificationSettings, updateAdminEmailClassificationSettings,
} from '@/app/lib/email/classification/admin-service';
import { validateEmailClassificationConfiguration } from '@/app/lib/email/classification/settings-validation';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } from '@/app/lib/email/classification/settings-types';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', headers['Cache-Control']);
  return response;
}

function errorResponse(error: unknown): NextResponse {
  const details = emailClassificationAdminErrorDetails(error);
  return NextResponse.json({ success: false, code: details.code, error: details.message, ...(details.settingsLink ? { settingsLink: details.settingsLink } : {}) }, { status: details.status, headers });
}

export async function GET(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return privateResponse(admin.response);
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'admin-email-classification-settings-get', verifiedUserId: admin.session.user.id });
  if (!limited.ok) return privateResponse(limited.response);
  try {
    return NextResponse.json({ success: true, data: await readAdminEmailClassificationSettings() }, { headers });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return privateResponse(admin.response);
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return privateResponse(origin.response);
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'admin-email-classification-settings-patch', verifiedUserId: admin.session.user.id });
  if (!limited.ok) return privateResponse(limited.response);
  const payload: unknown = await request.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return NextResponse.json({ success: false, code: 'INVALID_CONFIGURATION', error: 'Provide configuration and its current revision.' }, { status: 400, headers });
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).some(key => !['configuration', 'expectedRevision'].includes(key)) || typeof record.expectedRevision !== 'number' || !Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 0) {
    return NextResponse.json({ success: false, code: 'INVALID_CONFIGURATION', error: 'Provide configuration and its current revision.' }, { status: 400, headers });
  }
  let configuration;
  try { configuration = validateEmailClassificationConfiguration(record.configuration); }
  catch { return NextResponse.json({ success: false, code: 'INVALID_CONFIGURATION', error: 'The email classification configuration is invalid.' }, { status: 400, headers }); }
  try {
    const data = await updateAdminEmailClassificationSettings({ configuration, expectedRevision: record.expectedRevision, actorUserId: admin.session.user.id });
    const allowedFields = Object.keys(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION);
    await recordAuditEvent({
      userId: admin.session.user.id, source: 'email_classification', eventType: 'configuration', entityType: 'email_classification_settings', entityId: 'instance',
      action: 'email_classification.configure', status: 'success', summary: 'Email classification settings updated.',
      metadata: { previousRevision: record.expectedRevision, revision: data.settings.revision, changedFields: data.changedFields.filter(field => allowedFields.includes(field)) },
    });
    return NextResponse.json({ success: true, data }, { headers });
  } catch (error) { return errorResponse(error); }
}
