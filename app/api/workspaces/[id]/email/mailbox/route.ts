import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { assignAdminWorkspaceMailbox, listAssignableBusinessMailboxes } from '@/app/lib/email/workspace-mailbox-store';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function accountIdFromBody(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('accountId must be a string or null.');
  const accountId = (value as Record<string, unknown>).accountId;
  if (accountId === null || accountId === undefined || accountId === '') return null;
  if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('accountId must be a string or null.');
  return accountId.trim();
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await context.params;
  const workspace = await requireRequestWorkspace(request, { workspaceId, permissions: 'canManageWorkspace' });
  if (workspace.response) return workspace.response;
  try {
    const mailboxes = await listAssignableBusinessMailboxes({
      workspaceId,
      organizationId: workspace.workspace.organizationId || null,
    });
    return NextResponse.json({ success: true, data: { mailboxes } }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed to load business mailboxes.' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await context.params;
  const workspace = await requireRequestWorkspace(request, { workspaceId, permissions: 'canManageWorkspace' });
  if (workspace.response) return workspace.response;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'workspace-email-mailbox-assignment' });
  if (!limited.ok) return limited.response;

  try {
    const accountId = accountIdFromBody(await request.json());
    if (!accountId) throw new Error('Select a connected business mailbox.');
    const mailbox = await assignAdminWorkspaceMailbox({ actorUserId: workspace.session.user.id, accountId, workspaceId });
    await recordAuditEvent({
      source: 'workspace_email', eventType: 'workspace_mailbox.assignment', entityType: 'email_account', entityId: accountId,
      action: 'assign', status: 'success', workspaceId, userId: workspace.session.user.id,
      summary: `Business mailbox ${mailbox.emailAddress} assigned to workspace.`, metadata: { mailboxId: mailbox.mailboxId },
    });
    return NextResponse.json({ success: true, data: mailbox });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed to assign business mailbox.' }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await context.params;
  const workspace = await requireRequestWorkspace(request, { workspaceId, permissions: 'canManageWorkspace' });
  if (workspace.response) return workspace.response;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'workspace-email-mailbox-unassignment' });
  if (!limited.ok) return limited.response;

  try {
    const accountId = accountIdFromBody(await request.json());
    if (!accountId) throw new Error('Select the assigned business mailbox.');
    const mailbox = await assignAdminWorkspaceMailbox({ actorUserId: workspace.session.user.id, accountId, workspaceId: null });
    await recordAuditEvent({
      source: 'workspace_email', eventType: 'workspace_mailbox.assignment', entityType: 'email_account', entityId: accountId,
      action: 'unassign', status: 'success', workspaceId, userId: workspace.session.user.id,
      summary: `Business mailbox ${mailbox.emailAddress} unassigned from workspace.`,
    });
    return NextResponse.json({ success: true, data: mailbox });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed to unassign business mailbox.' }, { status: 400 });
  }
}
