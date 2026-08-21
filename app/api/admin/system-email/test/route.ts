import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { sendSystemEmailTestMessage, systemEmailErrorDetails } from '@/app/lib/email/system-email-admin-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, { limit: 5, windowMs: 60_000, keyPrefix: `admin-system-email-test:${admin.session.user.id}` });
  if (!limited.ok) return limited.response;

  try {
    const result = await sendSystemEmailTestMessage(admin.session.user.email);
    await recordAuditEvent({
      userId: admin.session.user.id,
      source: 'system_email',
      eventType: 'connection',
      entityType: 'system_smtp',
      entityId: 'system',
      action: 'system_email.test_send',
      status: 'success',
      summary: 'System email test message accepted by the configured provider.',
      metadata: result,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const details = systemEmailErrorDetails(error);
    await recordAuditEvent({
      userId: admin.session.user.id,
      source: 'system_email',
      eventType: 'connection',
      entityType: 'system_smtp',
      entityId: 'system',
      action: 'system_email.test_send',
      status: 'failure',
      summary: 'System email test message failed.',
      metadata: { code: details.code },
    });
    return NextResponse.json({ success: false, code: details.code, error: details.message, settingsLink: '/settings?tab=integrations' }, { status: details.status });
  }
}
