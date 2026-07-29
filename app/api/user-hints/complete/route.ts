import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getPageDefinition } from '@/app/components/onboarding/hint-config';
import { ensureUserExists } from '@/app/lib/db/ensure-user';
import { completeUserHintPage } from '@/app/lib/onboarding/hint-state';

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  await ensureUserExists(userId, { name: session.user.name ?? undefined, email: session.user.email ?? undefined, image: session.user.image ?? undefined });

  const body = await request.json();
  const { page } = body;

  if (!page || typeof page !== 'string') {
    return NextResponse.json({ error: 'page is required' }, { status: 400 });
  }

  const pageDef = getPageDefinition(page);
  if (!pageDef) {
    return NextResponse.json({ error: 'Unknown page' }, { status: 400 });
  }

  await completeUserHintPage({ userId, pageDef });

  return NextResponse.json({
    ok: true,
    page,
    completed: true,
  });
}
