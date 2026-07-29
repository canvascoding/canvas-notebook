import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

import type { PageDefinition } from '../app/components/onboarding/hint-config';

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-onboarding-hints-'));
  const previousData = process.env.DATA;
  const previousBetterAuthUrl = process.env.BETTER_AUTH_URL;
  process.env.DATA = dataDir;
  process.env.BETTER_AUTH_URL = 'http://localhost:3000';

  try {
    const { and, eq } = await import('drizzle-orm');
    const { ONBOARDING_PAGES } = await import('../app/components/onboarding/hint-config');
    const { db } = await import('../app/lib/db');
    const { pageOnboardingState, user, userHintState } = await import('../app/lib/db/schema');
    const {
      completeUserHintPage,
      dismissUserHint,
      isHintDismissedForVersion,
      resetUserHintPage,
    } = await import('../app/lib/onboarding/hint-state');

    const now = new Date('2026-07-29T10:00:00.000Z');
    const userId = 'hint-user';
    await db.insert(user).values({
      id: userId,
      name: 'Hint User',
      email: 'hint-user@example.test',
      emailVerified: true,
      role: 'user',
      createdAt: now,
      updatedAt: now,
    });

    const homeV1 = ONBOARDING_PAGES.home;
    const firstHint = homeV1.hints[0];
    const firstDismissal = await dismissUserHint({ userId, hintDef: firstHint, pageDef: homeV1, now });
    assert.equal(firstDismissal.dismissedHintKey, firstHint.hintKey);
    assert.equal(firstDismissal.nextHintKey, homeV1.hints[1].hintKey);
    assert.equal(firstDismissal.completed, false);

    await completeUserHintPage({ userId, pageDef: homeV1, now });
    const completedV1 = await db.select().from(pageOnboardingState).where(
      and(eq(pageOnboardingState.userId, userId), eq(pageOnboardingState.page, homeV1.page)),
    );
    assert.equal(completedV1[0]?.completed, true);
    assert.equal(completedV1[0]?.version, 1);

    const homeV2: PageDefinition = { ...homeV1, version: 2 };
    const v1Rows = await db.select().from(userHintState).where(
      and(eq(userHintState.userId, userId), eq(userHintState.page, homeV1.page)),
    );
    assert.ok(v1Rows.every((row) => !isHintDismissedForVersion(row, homeV2.version)));

    const { auth } = await import('../app/lib/auth');
    assert.equal(Reflect.set(auth.api, 'getSession', async () => ({
      user: {
        id: userId,
        name: 'Hint User',
        email: 'hint-user@example.test',
        image: null,
        role: 'user',
      },
      session: { id: 'hint-session' },
    })), true);
    homeV1.version = 2;
    const hintRoute = await import('../app/api/user-hints/route');
    const versionedResponse = await hintRoute.GET(
      new NextRequest('http://localhost/api/user-hints?page=home'),
    );
    assert.equal(versionedResponse.status, 200);
    const versionedPayload = await versionedResponse.json() as {
      completed: boolean;
      currentHintKey: string | null;
      hints: { dismissed: boolean; dismissedAt: string | null }[];
    };
    assert.equal(versionedPayload.completed, false);
    assert.equal(versionedPayload.currentHintKey, firstHint.hintKey);
    assert.ok(versionedPayload.hints.every((hint) => !hint.dismissed && hint.dismissedAt === null));
    homeV1.version = 1;

    const firstV2Dismissal = await dismissUserHint({ userId, hintDef: firstHint, pageDef: homeV2, now });
    assert.equal(firstV2Dismissal.completed, false);
    assert.equal(firstV2Dismissal.nextHintKey, homeV2.hints[1].hintKey);
    const firstV2Row = await db.select().from(userHintState).where(
      and(eq(userHintState.userId, userId), eq(userHintState.hintKey, firstHint.hintKey)),
    );
    assert.equal(firstV2Row[0]?.version, 2);

    await resetUserHintPage({ userId, pageDef: homeV2, now });
    const resetRows = await db.select().from(userHintState).where(
      and(eq(userHintState.userId, userId), eq(userHintState.page, homeV2.page)),
    );
    assert.ok(resetRows.every((row) => row.dismissed === false && row.version === 2));
    const resetPage = await db.select().from(pageOnboardingState).where(
      and(eq(pageOnboardingState.userId, userId), eq(pageOnboardingState.page, homeV2.page)),
    );
    assert.equal(resetPage[0]?.completed, false);
    assert.equal(resetPage[0]?.version, 2);

    const rollbackUserId = 'hint-rollback-user';
    await db.insert(user).values({
      id: rollbackUserId,
      name: 'Rollback User',
      email: 'hint-rollback@example.test',
      emailVerified: true,
      role: 'user',
      createdAt: now,
      updatedAt: now,
    });
    const invalidPage = {
      page: 'rollback',
      version: 1,
      hints: [
        { hintKey: 'rollback.valid', page: 'rollback', targetSelector: '#valid' },
        { hintKey: null as unknown as string, page: 'rollback', targetSelector: '#invalid' },
      ],
    };
    await assert.rejects(completeUserHintPage({ userId: rollbackUserId, pageDef: invalidPage, now }));
    const rollbackRows = await db.select().from(userHintState).where(eq(userHintState.userId, rollbackUserId));
    assert.equal(rollbackRows.length, 0);

    console.log('onboarding-hints-test: ok');
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    if (previousBetterAuthUrl === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = previousBetterAuthUrl;
    await rm(dataDir, { recursive: true, force: true });
  }
}

void main();
