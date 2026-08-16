import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import {
  removeAdminWorkspaceMailbox,
  saveAdminWorkspaceMailbox,
  type WorkspaceMailboxSmtpInput,
} from '@/app/lib/email/workspace-mailbox-store';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ mailboxId: string }> }) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'admin-workspace-mailbox-update' });
  if (!limited.ok) return limited.response;
  try {
    const { mailboxId } = await context.params;
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return NextResponse.json({ success: false, error: 'Invalid workspace mailbox configuration.' }, { status: 400 });
    }
    const mailbox = await saveAdminWorkspaceMailbox(admin.session.user.id, { ...(payload as WorkspaceMailboxSmtpInput), mailboxId }, { verify: Boolean((payload as { verifyConnection?: unknown }).verifyConnection) });
    await recordAuditEvent({
      userId: admin.session.user.id,
      workspaceId: mailbox.workspaceId,
      source: 'system_email', eventType: 'workspace_mailbox', entityType: 'workspace_email_mailbox', entityId: mailbox.id,
      action: 'workspace_email_mailbox.update', status: 'success',
      summary: `Workspace mailbox ${mailbox.emailAddress} updated.`,
      metadata: { accountId: mailbox.accountId, provider: mailbox.provider, authType: mailbox.authType },
    });
    return NextResponse.json({ success: true, data: mailbox });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error, 'Failed to update workspace mailbox.') }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ mailboxId: string }> }) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'admin-workspace-mailbox-remove' });
  if (!limited.ok) return limited.response;
  try {
    const { mailboxId } = await context.params;
    await removeAdminWorkspaceMailbox(admin.session.user.id, mailboxId);
    await recordAuditEvent({
      userId: admin.session.user.id,
      source: 'system_email', eventType: 'workspace_mailbox', entityType: 'workspace_email_mailbox', entityId: mailboxId,
      action: 'workspace_email_mailbox.remove', status: 'success',
      summary: 'Workspace mailbox removed and its credentials deleted.',
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error, 'Failed to remove workspace mailbox.') }, { status: 400 });
  }
}
