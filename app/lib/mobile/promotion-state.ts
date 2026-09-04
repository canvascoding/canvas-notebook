import 'server-only';

import { eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { mobileAppPromotionStates, mobilePushDevices, user } from '@/app/lib/db/schema';
import {
  MOBILE_APP_PROMOTION_CTA_DELAY_MS,
  MOBILE_APP_PROMOTION_EXTENDED_DELAY_AFTER_DISMISSALS,
  MOBILE_APP_PROMOTION_EXTENDED_DELAY_MS,
  MOBILE_APP_PROMOTION_INITIAL_DELAY_MS,
  MOBILE_APP_PROMOTION_REPEAT_DELAY_MS,
  MOBILE_APP_PROMOTION_VERSION,
  type MobileAppPromotionAction,
  type MobileAppPromotionReason,
  type MobileAppPromotionStatus,
} from './promotion-contract';

type PromotionRow = typeof mobileAppPromotionStates.$inferSelect;

type PromotionSnapshot = {
  accountCreatedAt: Date;
  hasRegisteredMobileDevice: boolean;
  row: PromotionRow | null;
};

export type MobileAppPromotionEvaluation = {
  rolloutEnabled: boolean;
  now: Date;
  accountCreatedAt: Date;
  hasRegisteredMobileDevice: boolean;
  row: PromotionRow | null;
};

export function isMobileAppPromotionRolloutEnabled(
  value = process.env.CANVAS_MOBILE_APP_PROMO_ENABLED,
): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function currentVersionRow(row: PromotionRow | null): PromotionRow | null {
  return row?.promotionVersion === MOBILE_APP_PROMOTION_VERSION ? row : null;
}

function dateString(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export function evaluateMobileAppPromotion(input: MobileAppPromotionEvaluation): MobileAppPromotionStatus {
  const row = currentVersionRow(input.row);
  let reason: MobileAppPromotionReason = 'eligible';

  if (!input.rolloutEnabled) reason = 'rollout_disabled';
  else if (input.hasRegisteredMobileDevice) reason = 'mobile_device_registered';
  else if (row?.permanentlyDismissedAt) reason = 'permanently_dismissed';
  else if (input.now.getTime() - input.accountCreatedAt.getTime() < MOBILE_APP_PROMOTION_INITIAL_DELAY_MS) {
    reason = 'new_account';
  } else if (
    (row?.dismissedUntil && row.dismissedUntil.getTime() > input.now.getTime())
    || (row?.lastShownAt && input.now.getTime() - row.lastShownAt.getTime() < MOBILE_APP_PROMOTION_REPEAT_DELAY_MS)
  ) {
    reason = 'cooldown';
  }

  return {
    eligible: reason === 'eligible',
    reason,
    version: MOBILE_APP_PROMOTION_VERSION,
    impressionCount: row?.impressionCount ?? 0,
    dismissalCount: row?.dismissalCount ?? 0,
    lastShownAt: dateString(row?.lastShownAt),
    dismissedUntil: dateString(row?.dismissedUntil),
    permanentlyDismissedAt: dateString(row?.permanentlyDismissedAt),
    ctaClickedAt: dateString(row?.ctaClickedAt),
  };
}

async function loadPromotionSnapshot(userId: string): Promise<PromotionSnapshot> {
  const [userRows, stateRows, deviceRows] = await Promise.all([
    db.select({ createdAt: user.createdAt }).from(user).where(eq(user.id, userId)).limit(1),
    db.select().from(mobileAppPromotionStates).where(eq(mobileAppPromotionStates.userId, userId)).limit(1),
    db.select({ id: mobilePushDevices.id }).from(mobilePushDevices).where(eq(mobilePushDevices.userId, userId)).limit(1),
  ]);

  return {
    accountCreatedAt: userRows[0]?.createdAt ?? new Date(),
    hasRegisteredMobileDevice: deviceRows.length > 0,
    row: stateRows[0] ?? null,
  };
}

export async function getMobileAppPromotionStatus(input: {
  userId: string;
  now?: Date;
  rolloutEnabled?: boolean;
}): Promise<MobileAppPromotionStatus> {
  const snapshot = await loadPromotionSnapshot(input.userId);
  return evaluateMobileAppPromotion({
    ...snapshot,
    now: input.now ?? new Date(),
    rolloutEnabled: input.rolloutEnabled ?? isMobileAppPromotionRolloutEnabled(),
  });
}

function baseValues(userId: string, now: Date) {
  return {
    userId,
    promotionVersion: MOBILE_APP_PROMOTION_VERSION,
    impressionCount: 0,
    dismissalCount: 0,
    lastShownAt: null,
    dismissedUntil: null,
    permanentlyDismissedAt: null,
    ctaClickedAt: null,
    lastAction: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function recordMobileAppPromotionAction(input: {
  userId: string;
  action: MobileAppPromotionAction;
  now?: Date;
  rolloutEnabled?: boolean;
}): Promise<{ recorded: boolean; status: MobileAppPromotionStatus }> {
  const now = input.now ?? new Date();
  const snapshot = await loadPromotionSnapshot(input.userId);
  const existing = currentVersionRow(snapshot.row);
  const rolloutEnabled = input.rolloutEnabled ?? isMobileAppPromotionRolloutEnabled();

  if (input.action.action === 'shown') {
    const before = evaluateMobileAppPromotion({ ...snapshot, now, rolloutEnabled });
    if (!before.eligible) return { recorded: false, status: before };
    const impressionCount = (existing?.impressionCount ?? 0) + 1;
    await db.insert(mobileAppPromotionStates).values({
      ...baseValues(input.userId, now),
      impressionCount,
      lastShownAt: now,
      lastAction: 'shown',
    }).onConflictDoUpdate({
      target: mobileAppPromotionStates.userId,
      set: {
        promotionVersion: MOBILE_APP_PROMOTION_VERSION,
        impressionCount,
        dismissalCount: existing?.dismissalCount ?? 0,
        lastShownAt: now,
        dismissedUntil: existing?.dismissedUntil ?? null,
        permanentlyDismissedAt: existing?.permanentlyDismissedAt ?? null,
        ctaClickedAt: existing?.ctaClickedAt ?? null,
        lastAction: 'shown',
        updatedAt: now,
      },
    });
  } else if (input.action.action === 'dismissed') {
    const dismissalCount = (existing?.dismissalCount ?? 0) + 1;
    const delay = dismissalCount >= MOBILE_APP_PROMOTION_EXTENDED_DELAY_AFTER_DISMISSALS
      ? MOBILE_APP_PROMOTION_EXTENDED_DELAY_MS
      : MOBILE_APP_PROMOTION_REPEAT_DELAY_MS;
    const dismissedUntil = new Date(now.getTime() + delay);
    await db.insert(mobileAppPromotionStates).values({
      ...baseValues(input.userId, now),
      dismissalCount,
      dismissedUntil,
      lastAction: input.action.source === 'legacy' ? 'dismissed:legacy' : 'dismissed:dialog',
    }).onConflictDoUpdate({
      target: mobileAppPromotionStates.userId,
      set: {
        promotionVersion: MOBILE_APP_PROMOTION_VERSION,
        impressionCount: existing?.impressionCount ?? 0,
        dismissalCount,
        lastShownAt: existing?.lastShownAt ?? null,
        dismissedUntil,
        permanentlyDismissedAt: existing?.permanentlyDismissedAt ?? null,
        ctaClickedAt: existing?.ctaClickedAt ?? null,
        lastAction: input.action.source === 'legacy' ? 'dismissed:legacy' : 'dismissed:dialog',
        updatedAt: now,
      },
    });
  } else if (input.action.action === 'permanently_dismissed') {
    await db.insert(mobileAppPromotionStates).values({
      ...baseValues(input.userId, now),
      permanentlyDismissedAt: now,
      lastAction: 'permanently_dismissed',
    }).onConflictDoUpdate({
      target: mobileAppPromotionStates.userId,
      set: {
        promotionVersion: MOBILE_APP_PROMOTION_VERSION,
        impressionCount: existing?.impressionCount ?? 0,
        dismissalCount: existing?.dismissalCount ?? 0,
        lastShownAt: existing?.lastShownAt ?? null,
        dismissedUntil: existing?.dismissedUntil ?? null,
        permanentlyDismissedAt: now,
        ctaClickedAt: existing?.ctaClickedAt ?? null,
        lastAction: 'permanently_dismissed',
        updatedAt: now,
      },
    });
  } else {
    const dismissedUntil = new Date(now.getTime() + MOBILE_APP_PROMOTION_CTA_DELAY_MS);
    await db.insert(mobileAppPromotionStates).values({
      ...baseValues(input.userId, now),
      dismissedUntil,
      ctaClickedAt: now,
      lastAction: `cta_clicked:${input.action.kind}`,
    }).onConflictDoUpdate({
      target: mobileAppPromotionStates.userId,
      set: {
        promotionVersion: MOBILE_APP_PROMOTION_VERSION,
        impressionCount: existing?.impressionCount ?? 0,
        dismissalCount: existing?.dismissalCount ?? 0,
        lastShownAt: existing?.lastShownAt ?? null,
        dismissedUntil,
        permanentlyDismissedAt: existing?.permanentlyDismissedAt ?? null,
        ctaClickedAt: now,
        lastAction: `cta_clicked:${input.action.kind}`,
        updatedAt: now,
      },
    });
  }

  return {
    recorded: true,
    status: await getMobileAppPromotionStatus({ userId: input.userId, now, rolloutEnabled }),
  };
}
