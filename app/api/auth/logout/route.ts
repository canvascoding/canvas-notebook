import { NextResponse } from 'next/server';
import { getSession } from '@/app/lib/auth/session';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 30,
      windowMs: 60_000,
      keyPrefix: 'auth-logout',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const session = await getSession();
    session.destroy();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
