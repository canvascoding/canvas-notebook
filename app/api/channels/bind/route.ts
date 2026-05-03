import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { deleteBinding, getBinding } from '@/app/lib/channels/telegram/link-token';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'channels-bind-delete' });
  if (!limited.ok) return limited.response;

  try {
    const binding = await getBinding('telegram', session.user.id);
    if (!binding) {
      return NextResponse.json({ success: false, error: 'No binding found' }, { status: 404 });
    }

    await deleteBinding(session.user.id, 'telegram');
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] channels/bind DELETE error:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete binding' }, { status: 500 });
  }
}