import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { recordHumanActivity } from '@/app/lib/instance/human-activity';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;
  const result = await recordHumanActivity();
  return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
}
