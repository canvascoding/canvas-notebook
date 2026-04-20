import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/db';
import { userHintState, pageOnboardingState } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { getPageDefinition } from '@/app/components/onboarding/hint-config';

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const body = await request.json();
  const { page } = body;

  if (!page || typeof page !== 'string') {
    return NextResponse.json({ error: 'page is required' }, { status: 400 });
  }

  const pageDef = getPageDefinition(page);
  if (!pageDef) {
    return NextResponse.json({ error: 'Unknown page' }, { status: 400 });
  }

  const now = new Date();

  for (const hint of pageDef.hints) {
    await db.insert(userHintState).values({
      userId,
      hintKey: hint.hintKey,
      page: hint.page,
      dismissed: true,
      dismissedAt: now,
      version: pageDef.version,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [userHintState.userId, userHintState.hintKey],
      set: { dismissed: true, dismissedAt: now, version: pageDef.version, updatedAt: now },
    });
  }

  await db.insert(pageOnboardingState).values({
    userId,
    page,
    completed: true,
    completedAt: now,
    version: pageDef.version,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [pageOnboardingState.userId, pageOnboardingState.page],
    set: { completed: true, completedAt: now, version: pageDef.version, updatedAt: now },
  });

  return NextResponse.json({
    ok: true,
    page,
    completed: true,
  });
}