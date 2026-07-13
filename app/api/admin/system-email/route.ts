import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import {
  clearSystemSmtpConfiguration,
  getSystemSmtpConfigurationStatus,
  saveSystemSmtpConfiguration,
  type SystemSmtpConfigurationInput,
} from '@/app/lib/email/system-smtp-config';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function GET(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  try {
    return NextResponse.json(
      { success: true, data: await getSystemSmtpConfigurationStatus() },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error, 'Failed to load system email settings.') }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  try {
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return NextResponse.json({ success: false, error: 'Invalid system email configuration.' }, { status: 400 });
    }

    const status = await saveSystemSmtpConfiguration(payload as SystemSmtpConfigurationInput);
    await recordAuditEvent({
      userId: admin.session.user.id,
      source: 'system_email',
      eventType: 'configuration',
      entityType: 'system_smtp',
      entityId: 'system',
      action: 'system_email.configure',
      status: 'success',
      summary: 'System SMTP notification sender configured.',
      metadata: {
        host: status.host,
        port: status.port,
        secure: status.secure,
        fromAddress: status.fromAddress,
        replyToConfigured: Boolean(status.replyTo),
      },
    });
    return NextResponse.json({ success: true, data: status });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error, 'Failed to save system email settings.') }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  try {
    const status = await clearSystemSmtpConfiguration();
    await recordAuditEvent({
      userId: admin.session.user.id,
      source: 'system_email',
      eventType: 'configuration',
      entityType: 'system_smtp',
      entityId: 'system',
      action: 'system_email.remove',
      status: 'success',
      summary: 'System SMTP notification sender removed.',
    });
    return NextResponse.json({ success: true, data: status });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error, 'Failed to remove system email settings.') }, { status: 500 });
  }
}
