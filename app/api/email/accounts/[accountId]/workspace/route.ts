import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  assignStoredEmailAccountWorkspace,
  getActiveWorkspaceMailboxForEmailAccount,
  getEmailAccountForUser,
} from '@/app/lib/email/account-store';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function workspaceIdFromBody(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workspaceId must be a string or null.');
  }
  const workspaceId = (value as Record<string, unknown>).workspaceId;
  if (workspaceId === null || workspaceId === undefined || workspaceId === '') return null;
  if (typeof workspaceId !== 'string') throw new Error('workspaceId must be a string or null.');
  return workspaceId.trim() || null;
}

export async function PUT(request: NextRequest, context: { params: Promise<{ accountId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'email-account-workspace-put' });
  if (!limited.ok) return limited.response;

  try {
    const { accountId } = await context.params;
    const workspaceId = workspaceIdFromBody(await request.json());
    const existing = await getEmailAccountForUser(session.user.id, accountId);
    const existingMailbox = await getActiveWorkspaceMailboxForEmailAccount(existing.id);
    const account = await assignStoredEmailAccountWorkspace(
      session.user.id,
      accountId,
      workspaceId,
    );
    await recordAuditEvent({
      workspaceId: account.workspaceId || existingMailbox?.workspaceId || null,
      userId: session.user.id,
      source: 'email',
      eventType: 'email_mailbox',
      entityType: 'email_account',
      entityId: account.id,
      action: account.workspaceId ? 'email_mailbox.workspace_assigned' : 'email_mailbox.workspace_unassigned',
      status: 'success',
      summary: account.workspaceId
        ? `Email account ${account.id} assigned to workspace ${account.workspaceId}.`
        : `Email account ${account.id} unassigned from its workspace.`,
      metadata: {
        previousWorkspaceId: existingMailbox?.workspaceId || null,
        requestedWorkspaceId: workspaceId,
        workspaceId: account.workspaceId,
      },
    });
    return NextResponse.json({ success: true, data: account });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update email account workspace.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
