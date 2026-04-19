import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { userHintState, pageOnboardingState } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { getPageDefinition, getHintDefinition, ALL_PAGES } from '@/app/components/onboarding/hint-config';

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
      rows.filter((r) => r.dismissed).map((r) => r.hintKey)
    );

    const hints = pageDef.hints.map((h) => {
      const row = rows.find((r) => r.hintKey === h.hintKey);
      return {
        hintKey: h.hintKey,
        dismissed: row?.dismissed ?? false,
        dismissedAt: row?.dismissedAt ? row.dismissedAt.toISOString() : null,
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

  const now = new Date();
  const existingRows = await db.select().from(userHintState).where(
    and(eq(userHintState.userId, userId), eq(userHintState.hintKey, hintKey))
  );

  if (existingRows.length > 0) {
    await db.update(userHintState)
      .set({ dismissed: true, dismissedAt: now, updatedAt: now })
      .where(and(eq(userHintState.userId, userId), eq(userHintState.hintKey, hintKey)));
  } else {
    await db.insert(userHintState).values({
      userId,
      hintKey,
      page: hintDef.page,
      dismissed: true,
      dismissedAt: now,
      version: pageDef.version,
      createdAt: now,
      updatedAt: now,
    });
  }

  const allHintsForPage = await db.select().from(userHintState).where(
    and(eq(userHintState.userId, userId), eq(userHintState.page, hintDef.page))
  );

  const allPageHintsDismissed = pageDef.hints.every((h) =>
    allHintsForPage.some((r) => r.hintKey === h.hintKey && r.dismissed)
  );

  if (allPageHintsDismissed) {
    await db.insert(pageOnboardingState).values({
      userId,
      page: hintDef.page,
      completed: true,
      completedAt: now,
      version: pageDef.version,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [pageOnboardingState.userId, pageOnboardingState.page],
      set: { completed: true, completedAt: now, version: pageDef.version, updatedAt: now },
    });
  }

  let nextHintKey: string | null = null;
  for (const hint of pageDef.hints) {
    const row = allHintsForPage.find((r) => r.hintKey === hint.hintKey);
    if (!row || !row.dismissed) {
      if (hint.hintKey !== hintKey) {
        nextHintKey = hint.hintKey;
        break;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    page: hintDef.page,
    dismissedHintKey: hintKey,
    nextHintKey,
    completed: allPageHintsDismissed,
  });
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const url = new URL(request.url);
  const page = url.searchParams.get('page');

  if (!page) {
    return NextResponse.json({ error: 'page query parameter is required' }, { status: 400 });
  }

  const pageDef = getPageDefinition(page);
  if (!pageDef) {
    return NextResponse.json({ error: 'Unknown page' }, { status: 400 });
  }

  const now = new Date();

  await db.update(userHintState)
    .set({ dismissed: false, dismissedAt: null, updatedAt: now })
    .where(and(eq(userHintState.userId, userId), eq(userHintState.page, page)));

  await db.insert(pageOnboardingState).values({
    userId,
    page,
    completed: false,
    completedAt: null,
    version: pageDef.version,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [pageOnboardingState.userId, pageOnboardingState.page],
    set: { completed: false, completedAt: null, version: pageDef.version, updatedAt: now },
  });

  return NextResponse.json({
    ok: true,
    page,
    completed: false,
    currentHintKey: pageDef.hints[0]?.hintKey ?? null,
  });
}