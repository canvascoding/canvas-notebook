import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import {
  EmailRecipientDiscoveryError,
  findEmailRecipients,
  suggestEmailReplyRecipients,
} from '@/app/lib/email/recipient-discovery';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const privateHeaders = { 'Cache-Control': 'private, no-store' };

/** Read-only discovery. Owner, purpose and mailbox policy are always selected server-side. */
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: privateHeaders });
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'email-recipients', verifiedUserId: session.user.id });
  if (!limited.ok) {
    limited.response.headers.set('Cache-Control', 'private, no-store');
    return limited.response;
  }
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ success: false, error: 'Invalid recipient query.' }, { status: 400, headers: privateHeaders });
    }
    const value = body as Record<string, unknown>;
    if (typeof value.accountId !== 'string' || !value.accountId.trim()
      || value.mailboxWorkspaceId != null && typeof value.mailboxWorkspaceId !== 'string'
      || value.folder !== undefined && typeof value.folder !== 'string'
      || value.exclude !== undefined && (!Array.isArray(value.exclude) || value.exclude.length > 50 || value.exclude.some(item => typeof item !== 'string'))
      || value.mode !== 'find' && value.mode !== 'reply') {
      return NextResponse.json({ success: false, error: 'Invalid recipient query.' }, { status: 400, headers: privateHeaders });
    }
    const context = {
      actorUserId: session.user.id,
      accountId: value.accountId.trim(),
      mailboxWorkspaceId: typeof value.mailboxWorkspaceId === 'string' ? value.mailboxWorkspaceId : null,
      purpose: 'human' as const,
      folder: value.folder as string | undefined,
      exclude: value.exclude as string[] | undefined,
    };
    if (value.mode === 'find' && (typeof value.query !== 'string'
      || value.offset !== undefined && (typeof value.offset !== 'number' || !Number.isInteger(value.offset)))) {
      return NextResponse.json({ success: false, error: 'Invalid recipient query.' }, { status: 400, headers: privateHeaders });
    }
    if (value.mode === 'reply' && (typeof value.messageId !== 'string'
      || value.replyMode !== undefined && value.replyMode !== 'reply' && value.replyMode !== 'reply-all')) {
      return NextResponse.json({ success: false, error: 'Invalid reply context.' }, { status: 400, headers: privateHeaders });
    }
    const data = value.mode === 'find'
      ? await findEmailRecipients({ ...context, query: value.query as string, offset: value.offset as number | undefined })
      : await suggestEmailReplyRecipients({ ...context, messageId: value.messageId as string, mode: value.replyMode as 'reply' | 'reply-all' | undefined });
    return NextResponse.json({ success: true, data }, { headers: privateHeaders });
  } catch (error) {
    const known = error instanceof EmailRecipientDiscoveryError;
    return NextResponse.json({
      success: false,
      error: known ? error.message : 'Recipient lookup is unavailable. Try again or enter an address directly.',
      ...(known ? { code: error.code } : {}),
    }, { status: known ? error.status : error instanceof SyntaxError ? 400 : 502, headers: privateHeaders });
  }
}
