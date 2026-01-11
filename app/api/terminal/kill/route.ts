import { NextRequest, NextResponse } from 'next/server';
import { createRequire } from 'node:module';
import { getSession } from '@/app/lib/auth/session';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const require = createRequire(import.meta.url);
const { terminateAllSessions } = require('../../../../server/terminal-manager.js');

export async function POST(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 10,
      windowMs: 60_000,
      keyPrefix: 'terminal-kill',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const session = await getSession();
    if (!session.isLoggedIn) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const result = terminateAllSessions();
    return NextResponse.json({ success: true, closed: result.closed });
  } catch (error) {
    console.error('Terminal kill error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
