export const MOBILE_APP_PROMOTION_VERSION = 2;
export const MOBILE_APP_PROMOTION_INITIAL_DELAY_MS = 48 * 60 * 60 * 1_000;
export const MOBILE_APP_PROMOTION_REPEAT_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;
export const MOBILE_APP_PROMOTION_EXTENDED_DELAY_MS = 90 * 24 * 60 * 60 * 1_000;
export const MOBILE_APP_PROMOTION_CTA_DELAY_MS = 180 * 24 * 60 * 60 * 1_000;
export const MOBILE_APP_PROMOTION_EXTENDED_DELAY_AFTER_DISMISSALS = 3;

export type MobileAppPromotionReason =
  | 'eligible'
  | 'rollout_disabled'
  | 'new_account'
  | 'mobile_device_registered'
  | 'permanently_dismissed'
  | 'cooldown';

export type MobileAppPromotionStatus = {
  eligible: boolean;
  reason: MobileAppPromotionReason;
  version: number;
  impressionCount: number;
  dismissalCount: number;
  lastShownAt: string | null;
  dismissedUntil: string | null;
  permanentlyDismissedAt: string | null;
  ctaClickedAt: string | null;
};

export type MobileAppPromotionAction =
  | { action: 'shown' }
  | { action: 'dismissed'; source?: 'dialog' | 'legacy' }
  | { action: 'permanently_dismissed' }
  | { action: 'cta_clicked'; kind: 'open-app' | 'app-store' | 'copy-link' };

export function parseMobileAppPromotionAction(value: unknown): MobileAppPromotionAction | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.action === 'shown') return { action: 'shown' };
  if (candidate.action === 'permanently_dismissed') return { action: 'permanently_dismissed' };
  if (candidate.action === 'dismissed') {
    const source = candidate.source;
    if (source === undefined || source === 'dialog' || source === 'legacy') {
      return { action: 'dismissed', source };
    }
    return null;
  }
  if (candidate.action === 'cta_clicked') {
    const kind = candidate.kind;
    if (kind === 'open-app' || kind === 'app-store' || kind === 'copy-link') {
      return { action: 'cta_clicked', kind };
    }
  }
  return null;
}
