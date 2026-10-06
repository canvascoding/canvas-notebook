import { NextRequest, NextResponse } from 'next/server';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { emailClassificationAdminErrorDetails, testEmailClassificationProvider } from '@/app/lib/email/classification/admin-service';
import { validateEmailClassificationConfiguration } from '@/app/lib/email/classification/settings-validation';
import type { EmailClassificationConfiguration } from '@/app/lib/email/classification/settings-types';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', headers['Cache-Control']);
  return response;
}

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return privateResponse(admin.response);
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return privateResponse(origin.response);
  const limited = rateLimit(request, { limit: 5, windowMs: 60_000, keyPrefix: 'admin-email-classification-provider-test', verifiedUserId: admin.session.user.id });
  if (!limited.ok) return privateResponse(limited.response);
  const payload: unknown = await request.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'configuration')) {
    return NextResponse.json({ success: false, code: 'INVALID_TEST_CONFIGURATION', error: 'A provider test accepts only an optional configuration.' }, { status: 400, headers });
  }
  const record = payload as Record<string, unknown>;
  let configuration: EmailClassificationConfiguration | undefined;
  if ('configuration' in record) {
    try { configuration = validateEmailClassificationConfiguration(record.configuration); }
    catch { return NextResponse.json({ success: false, code: 'INVALID_TEST_CONFIGURATION', error: 'The provider test configuration is invalid.' }, { status: 400, headers }); }
  }
  try {
    // The service owns the synthetic mail and questions. Requests cannot submit
    // real mail contents, credentials or an alternative evaluation state.
    const data = await testEmailClassificationProvider({ ...(configuration ? { configuration } : {}), signal: request.signal });
    await recordAuditEvent({
      userId: admin.session.user.id, source: 'email_classification', eventType: 'connection', entityType: 'email_classification_provider', entityId: 'instance',
      action: 'email_classification.test', status: 'success', summary: 'Synthetic email classification provider test completed.', metadata: { synthetic: true },
    });
    return NextResponse.json({ success: true, data }, { headers });
  } catch (error) {
    const details = emailClassificationAdminErrorDetails(error);
    await recordAuditEvent({
      userId: admin.session.user.id, source: 'email_classification', eventType: 'connection', entityType: 'email_classification_provider', entityId: 'instance',
      action: 'email_classification.test', status: 'failure', summary: 'Synthetic email classification provider test failed.', metadata: { synthetic: true, code: details.code },
    });
    return NextResponse.json({ success: false, code: details.code, error: details.message, ...(details.settingsLink ? { settingsLink: details.settingsLink } : {}) }, { status: details.status, headers });
  }
}
