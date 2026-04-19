'use client';

import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useHintSequence } from './useHintSequence';
import { HintTooltip } from './HintTooltip';

interface HintProviderProps {
  page: string;
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

export function HintProvider({ page, children }: HintProviderProps) {
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

    const effectiveId = hint.targetId;
    const checkTarget = () => {
      const el = document.getElementById(effectiveId);
      if (!el) {
        console.warn(`[onboarding] Target element #${effectiveId} not found, skipping hint`);
        setSkipHint(true);
      } else {
        setSkipHint(false);
      }
    };

    const timer = setTimeout(checkTarget, 500);
    return () => clearTimeout(timer);
  }, [state?.currentHintKey, state?.completed, loading, error, getCurrentHintTexts]);

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
          targetId={currentHint.targetId}
          mobileTargetId={currentHint.mobileTargetId}
          onDismiss={handleDismiss}
          dismissing={dismissing}
        />
      )}
    </HintContext.Provider>
  );
}