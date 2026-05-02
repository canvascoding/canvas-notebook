'use client';

import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState, startTransition } from 'react';
import { useHintSequence } from './useHintSequence';
import { HintTooltip } from './HintTooltip';

interface HintProviderProps {
  page?: string;
  children: ReactNode;
}

interface HintContextValue {
  page: string;
  state: import('./useHintSequence').HintState | null;
  loading: boolean;
  dismissing: boolean;
  dismissCurrent: () => Promise<unknown>;
  completePage: () => Promise<unknown>;
  resetPage: () => Promise<unknown>;
  activeTabOverride: string | null;
  showHint: boolean;
}

export const HintContext = createContext<HintContextValue>({
  page: '',
  state: null,
  loading: true,
  dismissing: false,
  dismissCurrent: async () => {},
  completePage: async () => {},
  resetPage: async () => {},
  activeTabOverride: null,
  showHint: false,
});

export function useHintContext() {
  return useContext(HintContext);
}

const TARGET_POLL_ATTEMPTS = 10;
const TARGET_POLL_INTERVAL_MS = 300;

export function HintProvider({ page = '', children }: HintProviderProps) {
  const {
    state,
    loading,
    error,
    dismissing,
    dismissCurrent,
    completePage,
    resetPage,
    getCurrentHintTexts,
  } = useHintSequence(page);

  const currentHint = getCurrentHintTexts();
  const [skipHint, setSkipHint] = useState(false);
  const activeTabOverride = useMemo(() => currentHint?.requiredTab ?? null, [currentHint?.requiredTab]);

  const handleDismiss = useCallback(async () => {
    const result = await dismissCurrent();
    if (!result) return;
    setSkipHint(false);
  }, [dismissCurrent]);

  useEffect(() => {
    if (loading || error) return;
    if (!state?.currentHintKey) return;
    if (state.completed) return;

    const hint = getCurrentHintTexts();
    if (!hint) return;

    const effectiveSelector = hint.targetSelector;
    let attempts = 0;
    let cancelled = false;

    const pollTarget = () => {
      if (cancelled) return;
      const el = document.querySelector(effectiveSelector);
      if (el) {
        setSkipHint(false);
        return;
      }
      attempts++;
      if (attempts >= TARGET_POLL_ATTEMPTS) {
        console.warn(`[onboarding] Target element "${effectiveSelector}" not found after ${TARGET_POLL_ATTEMPTS} attempts, auto-dismissing hint`);
        void dismissCurrent();
        return;
      }
      setTimeout(pollTarget, TARGET_POLL_INTERVAL_MS);
    };

    const timer = setTimeout(pollTarget, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state?.currentHintKey, state?.completed, loading, error, getCurrentHintTexts, dismissCurrent]);

  useEffect(() => {
    startTransition(() => {
      setSkipHint(false);
    });
  }, [state?.currentHintKey]);

  const showHint = !loading && !error && state && !state.completed && state.currentHintKey && currentHint && !skipHint;

  return (
    <HintContext.Provider
      value={{
        page,
        state,
        loading,
        dismissing,
        dismissCurrent: handleDismiss,
        completePage,
        resetPage,
        activeTabOverride,
        showHint: !!showHint,
      }}
    >
      {children}
      {showHint && currentHint && (
        <HintTooltip
          title={currentHint.title}
          description={currentHint.description}
          targetSelector={currentHint.targetSelector}
          mobileTargetSelector={currentHint.mobileTargetSelector}
          onDismiss={handleDismiss}
          dismissing={dismissing}
        />
      )}
    </HintContext.Provider>
  );
}