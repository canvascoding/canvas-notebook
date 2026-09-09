import 'server-only';

import { and, eq } from 'drizzle-orm';

import type { HintDefinition, PageDefinition } from '@/app/components/onboarding/hint-config';
import { db } from '@/app/lib/db';
import { pageOnboardingState, userHintState } from '@/app/lib/db/schema';

type HintTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type HintRow = typeof userHintState.$inferSelect;

export type DismissUserHintResult = {
  page: string;
  dismissedHintKey: string;
  nextHintKey: string | null;
  completed: boolean;
};

async function runHintTransaction<T>(
  callback: (tx: HintTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(callback);
}

export function isHintDismissedForVersion(
  row: Pick<HintRow, 'dismissed' | 'version'> | undefined,
  version: number,
): boolean {
  return row?.dismissed === true && row.version >= version;
}

function resolveDismissResult(
  userId: string,
  hintDef: HintDefinition,
  pageDef: PageDefinition,
  rows: HintRow[],
): DismissUserHintResult {
  const allPageHintsDismissed = pageDef.hints.every((hint) => {
    const row = rows.find((candidate) => candidate.userId === userId && candidate.hintKey === hint.hintKey);
    return isHintDismissedForVersion(row, pageDef.version);
  });
  const nextHint = allPageHintsDismissed
    ? undefined
    : pageDef.hints.find((hint) => {
        const row = rows.find((candidate) => candidate.userId === userId && candidate.hintKey === hint.hintKey);
        return !isHintDismissedForVersion(row, pageDef.version);
      });

  return {
    page: pageDef.page,
    dismissedHintKey: hintDef.hintKey,
    nextHintKey: nextHint?.hintKey ?? null,
    completed: allPageHintsDismissed,
  };
}

export async function dismissUserHint(input: {
  userId: string;
  hintDef: HintDefinition;
  pageDef: PageDefinition;
  now?: Date;
}): Promise<DismissUserHintResult> {
  const { userId, hintDef, pageDef } = input;
  if (hintDef.page !== pageDef.page || !pageDef.hints.some((hint) => hint.hintKey === hintDef.hintKey)) {
    throw new Error('Hint does not belong to the page definition.');
  }
  const now = input.now ?? new Date();
  const wherePage = and(eq(userHintState.userId, userId), eq(userHintState.page, pageDef.page));
  const values = {
    userId,
    hintKey: hintDef.hintKey,
    page: pageDef.page,
    dismissed: true,
    dismissedAt: now,
    version: pageDef.version,
    createdAt: now,
    updatedAt: now,
  };
  const conflictUpdate = {
    dismissed: true,
    dismissedAt: now,
    version: pageDef.version,
    updatedAt: now,
  };

  return runHintTransaction(async (tx) => {
    await tx.insert(userHintState).values(values).onConflictDoUpdate({
      target: [userHintState.userId, userHintState.hintKey],
      set: conflictUpdate,
    });
    const rows = await tx.select().from(userHintState).where(wherePage);
    const result = resolveDismissResult(userId, hintDef, pageDef, rows);
    if (result.completed) {
      await tx.insert(pageOnboardingState).values({
        userId,
        page: pageDef.page,
        completed: true,
        completedAt: now,
        version: pageDef.version,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [pageOnboardingState.userId, pageOnboardingState.page],
        set: {
          completed: true,
          completedAt: now,
          version: pageDef.version,
          updatedAt: now,
        },
      });
    }
    return result;
  });
}

export async function completeUserHintPage(input: {
  userId: string;
  pageDef: PageDefinition;
  now?: Date;
}): Promise<void> {
  const { userId, pageDef } = input;
  const now = input.now ?? new Date();

  const insertHintRows = async (tx: HintTransaction) => {
    for (const hint of pageDef.hints) {
      await tx.insert(userHintState).values({
        userId,
        hintKey: hint.hintKey,
        page: pageDef.page,
        dismissed: true,
        dismissedAt: now,
        version: pageDef.version,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [userHintState.userId, userHintState.hintKey],
        set: {
          dismissed: true,
          dismissedAt: now,
          version: pageDef.version,
          updatedAt: now,
        },
      });
    }
  };
  const insertPageRow = async (tx: HintTransaction) => {
    await tx.insert(pageOnboardingState).values({
      userId,
      page: pageDef.page,
      completed: true,
      completedAt: now,
      version: pageDef.version,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [pageOnboardingState.userId, pageOnboardingState.page],
      set: {
        completed: true,
        completedAt: now,
        version: pageDef.version,
        updatedAt: now,
      },
    });
  };

  await runHintTransaction(async (tx) => {
    await insertHintRows(tx);
    await insertPageRow(tx);
  });
}

export async function resetUserHintPage(input: {
  userId: string;
  pageDef: PageDefinition;
  now?: Date;
}): Promise<void> {
  const { userId, pageDef } = input;
  const now = input.now ?? new Date();
  const wherePage = and(eq(userHintState.userId, userId), eq(userHintState.page, pageDef.page));
  const pageValues = {
    userId,
    page: pageDef.page,
    completed: false,
    completedAt: null,
    version: pageDef.version,
    createdAt: now,
    updatedAt: now,
  };
  const pageUpdate = {
    completed: false,
    completedAt: null,
    version: pageDef.version,
    updatedAt: now,
  };

  await runHintTransaction(async (tx) => {
    await tx.update(userHintState)
      .set({ dismissed: false, dismissedAt: null, version: pageDef.version, updatedAt: now })
      .where(wherePage);
    await tx.insert(pageOnboardingState).values(pageValues).onConflictDoUpdate({
      target: [pageOnboardingState.userId, pageOnboardingState.page],
      set: pageUpdate,
    });
  });
}
