'use client';

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { readPluginNavigation, updatePluginNavigation, type PluginNavigation } from '@/app/lib/plugins/plugin-navigation';

export function usePluginNavigation() {
  const searchParams = useSearchParams();
  const navigation = useMemo(() => readPluginNavigation(searchParams), [searchParams]);
  const navigate = useCallback((patch: Partial<PluginNavigation>) => {
    const href = updatePluginNavigation(searchParams.toString(), patch);
    const query = href.slice(href.indexOf('?'));
    if (query === window.location.search) return;
    window.history.pushState(null, '', `${window.location.pathname}${query}${window.location.hash}`);
  }, [searchParams]);
  return { navigation, navigate };
}
