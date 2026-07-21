import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { pollMobilePushReceipts } from '@/app/lib/mobile/push-devices';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: responseHeaders },
    );
  }

  try {
    const receipts = await pollMobilePushReceipts({ userId: session.user.id });
    return NextResponse.json({ success: true, receipts }, { headers: responseHeaders });
  } catch (error) {
    console.error('[API] Mobile push receipt polling failed:', error);
    return NextResponse.json(
      { success: false, error: 'Could not check push delivery receipts.', code: 'RECEIPT_POLL_FAILED' },
      { status: 502, headers: responseHeaders },
    );
  }
}
