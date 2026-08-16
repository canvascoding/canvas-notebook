import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { testAdminWorkspaceMailbox } from '@/app/lib/email/workspace-mailbox-store';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest, context: { params: Promise<{ mailboxId: string }> }) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'admin-workspace-mailbox-test' });
  if (!limited.ok) return limited.response;
  try {
    const { mailboxId } = await context.params;
    const result = await testAdminWorkspaceMailbox(mailboxId);
    await recordAuditEvent({
      userId: admin.session.user.id,
      source: 'system_email', eventType: 'workspace_mailbox', entityType: 'workspace_email_mailbox', entityId: mailboxId,
      action: 'workspace_email_mailbox.test_connection', status: 'success',
      summary: 'Workspace mailbox connection verified.', metadata: result,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workspace mailbox connection test failed.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
