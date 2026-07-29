import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { userHintState, pageOnboardingState } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { getPageDefinition, getHintDefinition, ALL_PAGES } from '@/app/components/onboarding/hint-config';
import { ensureUserExists } from '@/app/lib/db/ensure-user';
import {
  dismissUserHint,
  isHintDismissedForVersion,
  resetUserHintPage,
} from '@/app/lib/onboarding/hint-state';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const url = new URL(request.url);
  const pageParam = url.searchParams.get('page');

  const results: {
    page: string;
    version: number;
    completed: boolean;
    currentHintKey: string | null;
    hints: { hintKey: string; dismissed: boolean; dismissedAt: string | null }[];
  }[] = [];

  const pagesToProcess = pageParam
    ? [getPageDefinition(pageParam)].filter((p): p is NonNullable<typeof p> => p !== undefined)
    : ALL_PAGES;

  for (const pageDef of pagesToProcess) {
    const [rows, pageStateRows] = await Promise.all([
      db.select().from(userHintState).where(
        and(eq(userHintState.userId, userId), eq(userHintState.page, pageDef.page))
      ),
      db.select().from(pageOnboardingState).where(
        and(eq(pageOnboardingState.userId, userId), eq(pageOnboardingState.page, pageDef.page))
      ),
    ]);

    const pageState = pageStateRows[0];
    const savedVersion = pageState?.version ?? 0;
    const effectiveCompleted = pageState?.completed === true && savedVersion >= pageDef.version;

    const dismissedKeys = new Set(
      rows
        .filter((row) => isHintDismissedForVersion(row, pageDef.version))
        .map((row) => row.hintKey)
    );

    const hints = pageDef.hints.map((h) => {
      const row = rows.find((r) => r.hintKey === h.hintKey);
      const dismissed = isHintDismissedForVersion(row, pageDef.version);
      return {
        hintKey: h.hintKey,
        dismissed,
        dismissedAt: dismissed && row?.dismissedAt ? row.dismissedAt.toISOString() : null,
      };
    });

    let currentHintKey: string | null = null;
    if (!effectiveCompleted) {
      for (const hint of pageDef.hints) {
        if (!dismissedKeys.has(hint.hintKey)) {
          currentHintKey = hint.hintKey;
          break;
        }
      }
    }

    results.push({
      page: pageDef.page,
      version: pageDef.version,
      completed: effectiveCompleted,
      currentHintKey: effectiveCompleted ? null : currentHintKey,
      hints,
    });
  }

  if (pageParam) {
    return NextResponse.json(results[0] ?? { error: 'Unknown page' }, { status: results[0] ? 200 : 400 });
  }

  return NextResponse.json({ pages: results });
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  await ensureUserExists(userId, { name: session.user.name ?? undefined, email: session.user.email ?? undefined, image: session.user.image ?? undefined });

  const body = await request.json();
  const { hintKey } = body;

  if (!hintKey || typeof hintKey !== 'string') {
    return NextResponse.json({ error: 'hintKey is required' }, { status: 400 });
  }

  const hintDef = getHintDefinition(hintKey);
  if (!hintDef) {
    return NextResponse.json({ error: 'Unknown hintKey' }, { status: 400 });
  }

  const pageDef = getPageDefinition(hintDef.page);
  if (!pageDef) {
    return NextResponse.json({ error: 'Unknown page' }, { status: 400 });
  }

  const result = await dismissUserHint({ userId, hintDef, pageDef });

  return NextResponse.json({
    ok: true,
    ...result,
  });
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  await ensureUserExists(userId, { name: session.user.name ?? undefined, email: session.user.email ?? undefined, image: session.user.image ?? undefined });

  const url = new URL(request.url);
  const page = url.searchParams.get('page');

  if (!page) {
    return NextResponse.json({ error: 'page query parameter is required' }, { status: 400 });
  }

  const pageDef = getPageDefinition(page);
  if (!pageDef) {
    return NextResponse.json({ error: 'Unknown page' }, { status: 400 });
  }

  await resetUserHintPage({ userId, pageDef });

  return NextResponse.json({
    ok: true,
    page,
    completed: false,
    currentHintKey: pageDef.hints[0]?.hintKey ?? null,
  });
}
