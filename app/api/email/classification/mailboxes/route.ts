import { NextRequest, NextResponse } from 'next/server';
import { resolveAuthorizedEmailClassificationMailboxes } from '@/app/lib/email/classification/mailbox-registry';
import type { EmailMailboxSourceOption } from '@/app/lib/email/classification/mailbox-types';
import { emailClassificationRouteActor, EMAIL_CLASSIFICATION_PRIVATE_HEADERS } from '@/app/lib/email/classification/route-support';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const actor = await emailClassificationRouteActor(request, false, 'email-classification-mailboxes');
    if (actor instanceof NextResponse) return actor;
    const sources = await resolveAuthorizedEmailClassificationMailboxes(actor.userId);
    const mailboxes: EmailMailboxSourceOption[] = sources.map(source => ({
      mailboxRef: source.mailboxRef, accountId: source.accountId, accountSource: source.accountSource,
      workspaceId: source.workspaceId, mailboxId: source.mailboxId, emailAddress: source.emailAddress,
      displayName: source.displayName, workspaceName: source.workspaceName,
      capabilities: {
        canRead: source.capabilities.canRead, canWrite: source.capabilities.canWrite, canDelete: source.capabilities.canDelete,
        canRunAgent: source.capabilities.canRunAgent, canManage: source.capabilities.canManage,
      },
    }));
    return NextResponse.json({ success: true, data: { mailboxes } }, { headers: EMAIL_CLASSIFICATION_PRIVATE_HEADERS });
  } catch {
    return NextResponse.json({ success: false, code: 'EMAIL_MAILBOX_CATALOG_UNAVAILABLE', error: 'The mailbox list is temporarily unavailable.' }, { status: 503, headers: EMAIL_CLASSIFICATION_PRIVATE_HEADERS });
  }
}
