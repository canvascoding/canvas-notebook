'use client';

import { useState, useEffect, useCallback, startTransition, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { getPageDefinition } from './hint-config';

export interface HintState {
  page: string;
  version: number;
  completed: boolean;
  currentHintKey: string | null;
  hints: { hintKey: string; dismissed: boolean; dismissedAt: string | null }[];
}

export function useHintSequence(page: string) {
  const t = useTranslations('onboarding.hints');
  const [state, setState] = useState<HintState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);

  const pageDef = useMemo(() => getPageDefinition(page) ?? null, [page]);

  const fetchState = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/user-hints?page=${encodeURIComponent(page)}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch hint state: ${res.status}`);
      }
      const data = await res.json();
      setState(data);
    } catch (err) {
      console.warn('[onboarding] Failed to load hint state:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    startTransition(() => {
      void fetchState();
    });
  }, [fetchState]);

  const dismissCurrent = useCallback(async () => {
    if (!state?.currentHintKey || dismissing) return null;
    setDismissing(true);
    try {
      const res = await fetch('/api/user-hints', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hintKey: state.currentHintKey }),
      });
      if (!res.ok) {
        throw new Error(`Failed to dismiss hint: ${res.status}`);
      }
      const data = await res.json();
      setState((prev) => prev ? {
        ...prev,
        currentHintKey: data.nextHintKey,
        completed: data.completed,
        hints: prev.hints.map((h) =>
          h.hintKey === data.dismissedHintKey
            ? { ...h, dismissed: true, dismissedAt: new Date().toISOString() }
            : h
        ),
      } : prev);
      return data;
    } catch (err) {
      console.warn('[onboarding] Failed to dismiss hint:', err);
      return null;
    } finally {
      setDismissing(false);
    }
  }, [state, dismissing]);

  const completePage = useCallback(async () => {
    try {
      const res = await fetch('/api/user-hints/complete', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page }),
      });
      if (!res.ok) {
        throw new Error(`Failed to complete onboarding: ${res.status}`);
      }
      const data = await res.json();
      setState((prev) => prev ? { ...prev, completed: true, currentHintKey: null } : prev);
      return data;
    } catch (err) {
      console.warn('[onboarding] Failed to complete page:', err);
      return null;
    }
  }, [page]);

  const resetPage = useCallback(async () => {
    try {
      const res = await fetch(`/api/user-hints?page=${encodeURIComponent(page)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new Error(`Failed to reset page: ${res.status}`);
      }
      const data = await res.json();
      void fetchState();
      return data;
    } catch (err) {
      console.warn('[onboarding] Failed to reset page:', err);
      return null;
    }
  }, [page, fetchState]);

  const getCurrentHintTexts = useCallback(() => {
    if (!state?.currentHintKey || !pageDef) return null;
    const hintDef = pageDef.hints.find(
      (h) => h.hintKey === state.currentHintKey
    );
    if (!hintDef) return null;

    const pageName = hintDef.page;
    const hintName = hintDef.hintKey.split('.')[1];

    try {
      return {
        title: t(`${pageName}.${hintName}.title`),
        description: t(`${pageName}.${hintName}.description`),
        targetSelector: hintDef.targetSelector,
        mobileTargetSelector: hintDef.mobileTargetSelector ?? hintDef.targetSelector,
        requiredTab: hintDef.requiredTab,
      };
    } catch {
      return null;
    }
  }, [state, t, pageDef]);

  return {
    state,
    loading,
    error,
    dismissing,
    dismissCurrent,
    completePage,
    resetPage,
    getCurrentHintTexts,
    pageDef,
  };
}