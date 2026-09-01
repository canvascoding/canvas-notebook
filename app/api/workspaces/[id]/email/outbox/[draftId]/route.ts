import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { normalizeEmailAttachmentInputs } from '@/app/lib/email/attachments';
import { updateWorkspaceOutboxDraft } from '@/app/lib/email/workspace-inbox-outbox';

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string; draftId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const { id, draftId } = await context.params;
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid outbox draft.');
    const value = body as Record<string, unknown>;
    const updated = await updateWorkspaceOutboxDraft({
      userId: session.user.id, workspaceId: id, draftId, expectedVersion: Number(value.expectedVersion),
      subject: typeof value.subject === 'string' ? value.subject : '', body: typeof value.body === 'string' ? value.body : '',
      to: Array.isArray(value.to) ? value.to.filter((item): item is string => typeof item === 'string') : [],
      cc: Array.isArray(value.cc) ? value.cc.filter((item): item is string => typeof item === 'string') : [],
      bcc: Array.isArray(value.bcc) ? value.bcc.filter((item): item is string => typeof item === 'string') : [],
      attachments: value.attachments === undefined ? undefined : normalizeEmailAttachmentInputs(value.attachments),
      status: value.status === 'awaiting_review' || value.status === 'editing' || value.status === 'discarded' ? value.status : undefined,
    });
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed to update outbox draft.' }, { status: 409 });
  }
}
