'use client';

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { readPluginNavigation, updatePluginNavigation, type PluginNavigation } from '@/app/lib/plugins/plugin-navigation';
import { confirmPluginNavigation } from './plugin-navigation-guard';

export function usePluginNavigation() {
  const searchParams = useSearchParams();
  const navigation = useMemo(() => readPluginNavigation(searchParams), [searchParams]);
  const navigate = useCallback((patch: Partial<PluginNavigation>, options?: { replace?: boolean }) => {
    const href = updatePluginNavigation(searchParams.toString(), patch);
    const query = href.slice(href.indexOf('?'));
    if (query === window.location.search) return false;
    if (!confirmPluginNavigation()) return false;
    const url = `${window.location.pathname}${query}${window.location.hash}`;
    if (options?.replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    return true;
  }, [searchParams]);
  return { navigation, navigate };
}
