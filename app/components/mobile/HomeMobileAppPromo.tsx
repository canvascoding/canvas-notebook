'use client';

import { useCallback, useEffect, useState } from 'react';

import { useHintContext } from '@/app/components/onboarding/HintProvider';
import {
  MOBILE_APP_PROMOTION_CTA_DELAY_MS,
  MOBILE_APP_PROMOTION_REPEAT_DELAY_MS,
  type MobileAppPromotionAction,
  type MobileAppPromotionStatus,
} from '@/app/lib/mobile/promotion-contract';
import {
  MobileAppSetupDialog,
  type MobileAppSetupAction,
} from './MobileAppSetupCard';

const LEGACY_DISMISSAL_KEY = 'canvas-home-mobile-app-promo-v1';
const LOCAL_FALLBACK_KEY = 'canvas-home-mobile-app-promo-v2';
const SESSION_IMPRESSION_KEY = 'canvas-home-mobile-app-promo-v2-shown';
const ACTIVE_USAGE_DELAY_MS = 45_000;
const BLOCKED_RETRY_DELAY_MS = 15_000;
const DESKTOP_MEDIA_QUERY = '(min-width: 900px)';

type PromotionStatusResponse = {
  success: boolean;
  promotion?: MobileAppPromotionStatus;
};

type PromotionActionResponse = {
  success: boolean;
  recorded?: boolean;
  status?: MobileAppPromotionStatus;
};

type LocalFallbackState = {
  dismissedUntil?: string;
  permanentlyDismissed?: boolean;
};

function readLocalFallback(now = Date.now()): LocalFallbackState | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_FALLBACK_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as LocalFallbackState;
    if (value.permanentlyDismissed) return value;
    if (value.dismissedUntil && new Date(value.dismissedUntil).getTime() > now) return value;
    window.localStorage.removeItem(LOCAL_FALLBACK_KEY);
  } catch {
    // Server state remains authoritative if local storage is unavailable or malformed.
  }
  return null;
}

function writeLocalFallback(state: LocalFallbackState) {
  try {
    window.localStorage.setItem(LOCAL_FALLBACK_KEY, JSON.stringify(state));
  } catch {
    // The server state still prevents repeated impressions.
  }
}

function markShownInSession() {
  try {
    window.sessionStorage.setItem(SESSION_IMPRESSION_KEY, 'shown');
  } catch {
    // The server-side impression cooldown is the durable fallback.
  }
}

function wasShownInSession(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_IMPRESSION_KEY) === 'shown';
  } catch {
    return false;
  }
}

function isDesktopViewport(): boolean {
  if (typeof window.matchMedia === 'function') return window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
  return window.innerWidth >= 900;
}

function anotherDialogIsOpen(): boolean {
  return document.querySelector('[role="dialog"]') !== null;
}

async function postPromotionAction(action: MobileAppPromotionAction): Promise<PromotionActionResponse | null> {
  try {
    const response = await fetch('/api/mobile-app-promotion', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    if (!response.ok) return null;
    return await response.json() as PromotionActionResponse;
  } catch {
    return null;
  }
}

function updateFallbackFromStatus(status: MobileAppPromotionStatus | undefined) {
  if (status?.permanentlyDismissedAt) {
    writeLocalFallback({ permanentlyDismissed: true });
  } else if (status?.dismissedUntil) {
    writeLocalFallback({ dismissedUntil: status.dismissedUntil });
  }
}

export function HomeMobileAppPromo({ hasPriorityAttention = false }: { hasPriorityAttention?: boolean }) {
  const { showHint } = useHintContext();
  const [eligible, setEligible] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!isDesktopViewport() || wasShownInSession() || readLocalFallback()) return;

    async function loadEligibility() {
      try {
        if (window.localStorage.getItem(LEGACY_DISMISSAL_KEY) === 'dismissed') {
          const dismissedUntil = new Date(Date.now() + MOBILE_APP_PROMOTION_REPEAT_DELAY_MS).toISOString();
          writeLocalFallback({ dismissedUntil });
          markShownInSession();
          const result = await postPromotionAction({ action: 'dismissed', source: 'legacy' });
          if (result?.success) {
            window.localStorage.removeItem(LEGACY_DISMISSAL_KEY);
            updateFallbackFromStatus(result.status);
          }
          return;
        }

        const response = await fetch('/api/mobile-app-promotion', {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!response.ok) return;
        const payload = await response.json() as PromotionStatusResponse;
        if (!cancelled && payload.success && payload.promotion?.eligible) setEligible(true);
      } catch {
        // A promotion must never interfere with the home page when eligibility cannot be loaded.
      }
    }

    void loadEligibility();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!eligible || open || showHint || hasPriorityAttention) return;

    let cancelled = false;
    let showTimer: number | undefined;

    const attemptShow = async () => {
      if (cancelled) return;
      if (document.visibilityState !== 'visible' || anotherDialogIsOpen()) {
        showTimer = window.setTimeout(() => void attemptShow(), BLOCKED_RETRY_DELAY_MS);
        return;
      }

      const result = await postPromotionAction({ action: 'shown' });
      if (cancelled) return;
      if (result?.success && result.recorded) {
        markShownInSession();
        setEligible(false);
        setOpen(true);
        return;
      }
      if (result) setEligible(false);
      else showTimer = window.setTimeout(() => void attemptShow(), BLOCKED_RETRY_DELAY_MS);
    };

    const startActiveUsageTimer = () => {
      window.removeEventListener('pointerdown', startActiveUsageTimer);
      window.removeEventListener('keydown', startActiveUsageTimer);
      showTimer = window.setTimeout(() => void attemptShow(), ACTIVE_USAGE_DELAY_MS);
    };

    if (navigator.userActivation?.hasBeenActive) startActiveUsageTimer();
    else {
      window.addEventListener('pointerdown', startActiveUsageTimer, { once: true });
      window.addEventListener('keydown', startActiveUsageTimer, { once: true });
    }

    return () => {
      cancelled = true;
      if (showTimer !== undefined) window.clearTimeout(showTimer);
      window.removeEventListener('pointerdown', startActiveUsageTimer);
      window.removeEventListener('keydown', startActiveUsageTimer);
    };
  }, [eligible, hasPriorityAttention, open, showHint]);

  const dismiss = useCallback(() => {
    setOpen(false);
    const dismissedUntil = new Date(Date.now() + MOBILE_APP_PROMOTION_REPEAT_DELAY_MS).toISOString();
    writeLocalFallback({ dismissedUntil });
    void postPromotionAction({ action: 'dismissed', source: 'dialog' }).then((result) => {
      updateFallbackFromStatus(result?.status);
    });
  }, []);

  const permanentlyDismiss = useCallback(() => {
    setOpen(false);
    writeLocalFallback({ permanentlyDismissed: true });
    void postPromotionAction({ action: 'permanently_dismissed' }).then((result) => {
      updateFallbackFromStatus(result?.status);
    });
  }, []);

  const recordAction = useCallback((action: MobileAppSetupAction) => {
    writeLocalFallback({
      dismissedUntil: new Date(Date.now() + MOBILE_APP_PROMOTION_CTA_DELAY_MS).toISOString(),
    });
    void postPromotionAction({ action: 'cta_clicked', kind: action }).then((result) => {
      updateFallbackFromStatus(result?.status);
    });
  }, []);

  return (
    <MobileAppSetupDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && open) dismiss();
      }}
      onPermanentDismiss={permanentlyDismiss}
      onAction={recordAction}
    />
  );
}
