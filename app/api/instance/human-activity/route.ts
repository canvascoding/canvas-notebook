import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { recordHumanActivity } from '@/app/lib/instance/human-activity';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const origin = request.headers.get('origin');
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const result = await recordHumanActivity();
  return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
}
