import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { isEmailMessageNotFoundError } from '@/app/lib/email/errors';
import { isImapMailboxChangedError } from '@/app/lib/email/imap-service';
import { readInboundEmailAttachmentStream } from '@/app/lib/email/inbound-attachments';
import { downloadEmailAttachment } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string; messageId: string; attachmentId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'email-attachment-get' });
  if (!limited.ok) return limited.response;

  try {
    const { accountId, messageId, attachmentId } = await params;
    const folder = request.nextUrl.searchParams.get('folder') || undefined;
    const downloaded = await downloadEmailAttachment(
      session.user.id,
      accountId,
      messageId,
      attachmentId,
      folder,
      { enforceReadPolicy: false },
    );
    const content = await readInboundEmailAttachmentStream(downloaded.content);
    const filename = Buffer.from(downloaded.attachment.filename, 'utf8').toString('utf8');
    const fallbackName = filename.replace(/[^A-Za-z0-9._-]/gu, '_') || 'attachment';
    return new NextResponse(new Uint8Array(content), {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Content-Length': String(content.length),
        'Content-Type': downloaded.attachment.contentType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (isImapMailboxChangedError(error)) {
      return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
    }
    if (isEmailMessageNotFoundError(error)) {
      return NextResponse.json({ success: false, code: 'EMAIL_MESSAGE_NOT_FOUND', error: 'Email attachment is no longer available.' }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to download email attachment';
    const status = /25 MB download limit/iu.test(message) ? 413 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
