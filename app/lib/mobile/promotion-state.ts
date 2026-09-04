import 'server-only';

import { and, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';

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

function preservedPromotionFields() {
  return {
    impressionCount: sql<number>`case
      when ${mobileAppPromotionStates.promotionVersion} = ${MOBILE_APP_PROMOTION_VERSION}
        then ${mobileAppPromotionStates.impressionCount}
      else 0
    end`,
    dismissalCount: sql<number>`case
      when ${mobileAppPromotionStates.promotionVersion} = ${MOBILE_APP_PROMOTION_VERSION}
        then ${mobileAppPromotionStates.dismissalCount}
      else 0
    end`,
    lastShownAt: sql<Date | null>`case
      when ${mobileAppPromotionStates.promotionVersion} = ${MOBILE_APP_PROMOTION_VERSION}
        then ${mobileAppPromotionStates.lastShownAt}
      else null
    end`,
    dismissedUntil: sql<Date | null>`case
      when ${mobileAppPromotionStates.promotionVersion} = ${MOBILE_APP_PROMOTION_VERSION}
        then ${mobileAppPromotionStates.dismissedUntil}
      else null
    end`,
    permanentlyDismissedAt: sql<Date | null>`case
      when ${mobileAppPromotionStates.promotionVersion} = ${MOBILE_APP_PROMOTION_VERSION}
        then ${mobileAppPromotionStates.permanentlyDismissedAt}
      else null
    end`,
    ctaClickedAt: sql<Date | null>`case
      when ${mobileAppPromotionStates.promotionVersion} = ${MOBILE_APP_PROMOTION_VERSION}
        then ${mobileAppPromotionStates.ctaClickedAt}
      else null
    end`,
  };
}

function latestPromotionAuditFields(lastAction: string, nowSeconds: number) {
  return {
    lastAction: sql<string>`case
      when ${mobileAppPromotionStates.promotionVersion} != ${MOBILE_APP_PROMOTION_VERSION}
        or ${mobileAppPromotionStates.updatedAt} <= ${nowSeconds}
        then ${lastAction}
      else ${mobileAppPromotionStates.lastAction}
    end`,
    updatedAt: sql<Date>`case
      when ${mobileAppPromotionStates.updatedAt} < ${nowSeconds} then ${nowSeconds}
      else ${mobileAppPromotionStates.updatedAt}
    end`,
  };
}

export async function recordMobileAppPromotionAction(input: {
  userId: string;
  action: MobileAppPromotionAction;
  now?: Date;
  rolloutEnabled?: boolean;
}): Promise<{ recorded: boolean; status: MobileAppPromotionStatus }> {
  const now = input.now ?? new Date();
  const rolloutEnabled = input.rolloutEnabled ?? isMobileAppPromotionRolloutEnabled();
  const nowSeconds = Math.floor(now.getTime() / 1_000);

  if (input.action.action === 'shown') {
    const snapshot = await loadPromotionSnapshot(input.userId);
    const before = evaluateMobileAppPromotion({ ...snapshot, now, rolloutEnabled });
    if (!before.eligible) return { recorded: false, status: before };

    const repeatCutoff = new Date(now.getTime() - MOBILE_APP_PROMOTION_REPEAT_DELAY_MS);
    const rows = await db.insert(mobileAppPromotionStates).values({
      ...baseValues(input.userId, now),
      impressionCount: 1,
      lastShownAt: now,
      lastAction: 'shown',
    }).onConflictDoUpdate({
      target: mobileAppPromotionStates.userId,
      set: {
        promotionVersion: MOBILE_APP_PROMOTION_VERSION,
        ...preservedPromotionFields(),
        impressionCount: sql<number>`case
          when ${mobileAppPromotionStates.promotionVersion} = ${MOBILE_APP_PROMOTION_VERSION}
            then ${mobileAppPromotionStates.impressionCount} + 1
          else 1
        end`,
        lastShownAt: now,
        ...latestPromotionAuditFields('shown', nowSeconds),
      },
      setWhere: or(
        ne(mobileAppPromotionStates.promotionVersion, MOBILE_APP_PROMOTION_VERSION),
        and(
          isNull(mobileAppPromotionStates.permanentlyDismissedAt),
          or(
            isNull(mobileAppPromotionStates.dismissedUntil),
            lte(mobileAppPromotionStates.dismissedUntil, now),
          ),
          or(
            isNull(mobileAppPromotionStates.lastShownAt),
            lte(mobileAppPromotionStates.lastShownAt, repeatCutoff),
          ),
        ),
      ),
    }).returning({ userId: mobileAppPromotionStates.userId });

    if (rows.length === 0) {
      return {
        recorded: false,
        status: await getMobileAppPromotionStatus({ userId: input.userId, now, rolloutEnabled }),
      };
    }
  } else if (input.action.action === 'dismissed') {
    const dismissedUntil = new Date(now.getTime() + MOBILE_APP_PROMOTION_REPEAT_DELAY_MS);
    const dismissedUntilSeconds = Math.floor(dismissedUntil.getTime() / 1_000);
    const extendedUntil = new Date(now.getTime() + MOBILE_APP_PROMOTION_EXTENDED_DELAY_MS);
    const extendedUntilSeconds = Math.floor(extendedUntil.getTime() / 1_000);
    const lastAction = input.action.source === 'legacy' ? 'dismissed:legacy' : 'dismissed:dialog';

    await db.insert(mobileAppPromotionStates).values({
      ...baseValues(input.userId, now),
      dismissalCount: 1,
      dismissedUntil,
      lastAction,
    }).onConflictDoUpdate({
      target: mobileAppPromotionStates.userId,
      set: {
        promotionVersion: MOBILE_APP_PROMOTION_VERSION,
        ...preservedPromotionFields(),
        dismissalCount: sql<number>`case
          when ${mobileAppPromotionStates.promotionVersion} = ${MOBILE_APP_PROMOTION_VERSION}
            then ${mobileAppPromotionStates.dismissalCount} + 1
          else 1
        end`,
        dismissedUntil: sql<Date>`case
          when (
            case
              when ${mobileAppPromotionStates.promotionVersion} = ${MOBILE_APP_PROMOTION_VERSION}
                then ${mobileAppPromotionStates.dismissalCount} + 1
              else 1
            end
          ) >= ${MOBILE_APP_PROMOTION_EXTENDED_DELAY_AFTER_DISMISSALS}
            then case
              when ${mobileAppPromotionStates.promotionVersion} != ${MOBILE_APP_PROMOTION_VERSION}
                or ${mobileAppPromotionStates.dismissedUntil} is null
                or ${mobileAppPromotionStates.dismissedUntil} < ${extendedUntilSeconds}
                then ${extendedUntilSeconds}
              else ${mobileAppPromotionStates.dismissedUntil}
            end
          else case
            when ${mobileAppPromotionStates.promotionVersion} != ${MOBILE_APP_PROMOTION_VERSION}
              or ${mobileAppPromotionStates.dismissedUntil} is null
              or ${mobileAppPromotionStates.dismissedUntil} < ${dismissedUntilSeconds}
              then ${dismissedUntilSeconds}
            else ${mobileAppPromotionStates.dismissedUntil}
          end
        end`,
        ...latestPromotionAuditFields(lastAction, nowSeconds),
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
        ...preservedPromotionFields(),
        permanentlyDismissedAt: sql<Date>`case
          when ${mobileAppPromotionStates.promotionVersion} = ${MOBILE_APP_PROMOTION_VERSION}
            and ${mobileAppPromotionStates.permanentlyDismissedAt} is not null
            then ${mobileAppPromotionStates.permanentlyDismissedAt}
          else ${nowSeconds}
        end`,
        ...latestPromotionAuditFields('permanently_dismissed', nowSeconds),
      },
    });
  } else {
    const dismissedUntil = new Date(now.getTime() + MOBILE_APP_PROMOTION_CTA_DELAY_MS);
    const dismissedUntilSeconds = Math.floor(dismissedUntil.getTime() / 1_000);
    const lastAction = `cta_clicked:${input.action.kind}`;

    await db.insert(mobileAppPromotionStates).values({
      ...baseValues(input.userId, now),
      dismissedUntil,
      ctaClickedAt: now,
      lastAction,
    }).onConflictDoUpdate({
      target: mobileAppPromotionStates.userId,
      set: {
        promotionVersion: MOBILE_APP_PROMOTION_VERSION,
        ...preservedPromotionFields(),
        dismissedUntil: sql<Date>`case
          when ${mobileAppPromotionStates.promotionVersion} != ${MOBILE_APP_PROMOTION_VERSION}
            or ${mobileAppPromotionStates.dismissedUntil} is null
            or ${mobileAppPromotionStates.dismissedUntil} < ${dismissedUntilSeconds}
            then ${dismissedUntilSeconds}
          else ${mobileAppPromotionStates.dismissedUntil}
        end`,
        ctaClickedAt: sql<Date>`case
          when ${mobileAppPromotionStates.promotionVersion} != ${MOBILE_APP_PROMOTION_VERSION}
            or ${mobileAppPromotionStates.ctaClickedAt} is null
            or ${mobileAppPromotionStates.ctaClickedAt} < ${nowSeconds}
            then ${nowSeconds}
          else ${mobileAppPromotionStates.ctaClickedAt}
        end`,
        ...latestPromotionAuditFields(lastAction, nowSeconds),
      },
    });
  }

  return {
    recorded: true,
    status: await getMobileAppPromotionStatus({ userId: input.userId, now, rolloutEnabled }),
  };
}
