import { NextRequest, NextResponse } from 'next/server';

import { pollWorkspaceMailboxInboxEvents } from '@/app/lib/email/inbox-events';
import { isValidCanvasInternalToken } from '@/app/lib/internal-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!isValidCanvasInternalToken(request.headers.get('x-canvas-internal-token'))) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json({ success: true, result: await pollWorkspaceMailboxInboxEvents() });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed to poll workspace mailboxes.' }, { status: 500 });
  }
}
