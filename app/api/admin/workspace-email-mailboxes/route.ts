import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import {
  listAdminWorkspaceMailboxes,
  listWorkspaceMailboxWorkspaceChoices,
  saveAdminWorkspaceMailbox,
  type WorkspaceMailboxSmtpInput,
} from '@/app/lib/email/workspace-mailbox-store';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function GET(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  try {
    const [mailboxes, workspaces] = await Promise.all([
      listAdminWorkspaceMailboxes(),
      listWorkspaceMailboxWorkspaceChoices(),
    ]);
    return NextResponse.json({ success: true, data: { mailboxes, workspaces } }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error, 'Failed to load workspace mailboxes.') }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'admin-workspace-mailbox-create' });
  if (!limited.ok) return limited.response;
  try {
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return NextResponse.json({ success: false, error: 'Invalid workspace mailbox configuration.' }, { status: 400 });
    }
    const mailbox = await saveAdminWorkspaceMailbox(admin.session.user.id, payload as WorkspaceMailboxSmtpInput, { verify: Boolean((payload as { verifyConnection?: unknown }).verifyConnection) });
    await recordAuditEvent({
      userId: admin.session.user.id,
      workspaceId: mailbox.workspaceId || undefined,
      source: 'system_email', eventType: 'workspace_mailbox', entityType: 'workspace_email_mailbox', entityId: mailbox.id,
      action: 'workspace_email_mailbox.create', status: 'success',
      summary: `Business mailbox ${mailbox.emailAddress} connected in System Email.`,
      metadata: { accountId: mailbox.accountId, provider: mailbox.provider, authType: mailbox.authType },
    });
    return NextResponse.json({ success: true, data: mailbox }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error, 'Failed to create workspace mailbox.') }, { status: 400 });
  }
}
