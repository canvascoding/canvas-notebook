import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { verifySystemSmtpConnection } from '@/app/lib/email/system-smtp-service';

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  try {
    const result = await verifySystemSmtpConnection();
    await recordAuditEvent({
      userId: admin.session.user.id,
      source: 'system_email',
      eventType: 'connection',
      entityType: 'system_smtp',
      entityId: 'system',
      action: 'system_email.test_connection',
      status: 'success',
      summary: 'System SMTP connection verified.',
      metadata: result,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'System SMTP connection test failed.';
    await recordAuditEvent({
      userId: admin.session.user.id,
      source: 'system_email',
      eventType: 'connection',
      entityType: 'system_smtp',
      entityId: 'system',
      action: 'system_email.test_connection',
      status: 'failure',
      summary: 'System SMTP connection test failed.',
      metadata: { error: message },
    });
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
