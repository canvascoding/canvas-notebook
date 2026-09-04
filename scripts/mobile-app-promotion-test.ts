import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-promotion-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataDir;

  try {
    const { db } = await import('../app/lib/db');
    const { mobileAppPromotionStates, mobilePushDevices, session, user } = await import('../app/lib/db/schema');
    const {
      MOBILE_APP_PROMOTION_EXTENDED_DELAY_MS,
      MOBILE_APP_PROMOTION_REPEAT_DELAY_MS,
      parseMobileAppPromotionAction,
    } = await import('../app/lib/mobile/promotion-contract');
    const {
      evaluateMobileAppPromotion,
      getMobileAppPromotionStatus,
      recordMobileAppPromotionAction,
    } = await import('../app/lib/mobile/promotion-state');

    const now = new Date('2026-09-04T12:00:00.000Z');
    const accountCreatedAt = new Date('2026-08-01T12:00:00.000Z');
    const userId = 'mobile-promo-user';
    await db.insert(user).values({
      id: userId,
      name: 'Mobile Promo User',
      email: 'mobile-promo@example.test',
      emailVerified: true,
      role: 'user',
      createdAt: accountCreatedAt,
      updatedAt: accountCreatedAt,
    });

    assert.deepEqual(parseMobileAppPromotionAction({ action: 'shown' }), { action: 'shown' });
    assert.deepEqual(parseMobileAppPromotionAction({ action: 'cta_clicked', kind: 'copy-link' }), {
      action: 'cta_clicked',
      kind: 'copy-link',
    });
    assert.equal(parseMobileAppPromotionAction({ action: 'cta_clicked', kind: 'unknown' }), null);

    const disabled = evaluateMobileAppPromotion({
      rolloutEnabled: false,
      now,
      accountCreatedAt,
      hasRegisteredMobileDevice: false,
      row: null,
    });
    assert.equal(disabled.reason, 'rollout_disabled');

    const initial = await getMobileAppPromotionStatus({ userId, now, rolloutEnabled: true });
    assert.equal(initial.eligible, true);

    const shown = await recordMobileAppPromotionAction({
      userId,
      action: { action: 'shown' },
      now,
      rolloutEnabled: true,
    });
    assert.equal(shown.recorded, true);
    assert.equal(shown.status.reason, 'cooldown');
    assert.equal(shown.status.impressionCount, 1);

    const duplicateShown = await recordMobileAppPromotionAction({
      userId,
      action: { action: 'shown' },
      now,
      rolloutEnabled: true,
    });
    assert.equal(duplicateShown.recorded, false);
    assert.equal(duplicateShown.status.impressionCount, 1);

    const afterRepeatDelay = new Date(now.getTime() + MOBILE_APP_PROMOTION_REPEAT_DELAY_MS + 1);
    assert.equal((await getMobileAppPromotionStatus({ userId, now: afterRepeatDelay, rolloutEnabled: true })).eligible, true);

    let dismissalTime = afterRepeatDelay;
    let lastDismissalAt = dismissalTime;
    for (let dismissal = 1; dismissal <= 3; dismissal += 1) {
      lastDismissalAt = dismissalTime;
      const result = await recordMobileAppPromotionAction({
        userId,
        action: { action: 'dismissed', source: 'dialog' },
        now: dismissalTime,
        rolloutEnabled: true,
      });
      assert.equal(result.status.dismissalCount, dismissal);
      dismissalTime = new Date(dismissalTime.getTime() + MOBILE_APP_PROMOTION_REPEAT_DELAY_MS + 1);
    }
    const rows = await db.select().from(mobileAppPromotionStates);
    assert.equal(rows[0]?.lastAction, 'dismissed:dialog');
    assert.equal(
      Math.floor((rows[0]?.dismissedUntil?.getTime() ?? 0) / 1_000),
      Math.floor((lastDismissalAt.getTime() + MOBILE_APP_PROMOTION_EXTENDED_DELAY_MS) / 1_000),
    );

    const authSessionId = 'mobile-promo-session';
    await db.insert(session).values({
      id: authSessionId,
      userId,
      token: 'mobile-promo-token',
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(mobilePushDevices).values({
      id: 'mobile-promo-device',
      installationId: 'cmi_mobilepromotestdevice',
      userId,
      authSessionId,
      expoPushToken: 'ExponentPushToken[mobile-promo-test]',
      platform: 'ios',
      appVariant: 'production',
      enabled: true,
      agentResponseReady: true,
      todoAttention: true,
      emailReview: true,
      studioCompleted: true,
      failureAttention: true,
      automationRunStatus: false,
      previewEnabled: false,
      lastRegisteredAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const afterExtendedDelay = new Date(dismissalTime.getTime() + MOBILE_APP_PROMOTION_EXTENDED_DELAY_MS);
    const mobileUserStatus = await getMobileAppPromotionStatus({
      userId,
      now: afterExtendedDelay,
      rolloutEnabled: true,
    });
    assert.equal(mobileUserStatus.reason, 'mobile_device_registered');

    console.log('mobile-app-promotion-test: ok');
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await rm(dataDir, { recursive: true, force: true });
  }
}

void main();
