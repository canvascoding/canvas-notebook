import { NextRequest, NextResponse } from 'next/server';

import { isValidCanvasInternalToken } from '@/app/lib/internal-auth';
import { pollTodoEmailReplies } from '@/app/lib/todos/email-reply-watchers';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const isValid = isValidCanvasInternalToken(request.headers.get('x-canvas-internal-token'));
  if (!isValid) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await pollTodoEmailReplies();
    if (result.processed > 0 || result.failed > 0 || result.expired > 0) {
      console.log('[TodoEmailReplyPoll] Poll result:', result);
    }
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('[TodoEmailReplyPoll] Failed to poll todo email replies:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to poll todo email replies.' },
      { status: 500 },
    );
  }
}
