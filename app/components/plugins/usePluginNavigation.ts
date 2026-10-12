'use client';

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { readPluginNavigation, updatePluginNavigation, type PluginNavigation } from '@/app/lib/plugins/plugin-navigation';
import { confirmPluginNavigation } from './plugin-navigation-guard';

export function usePluginNavigation() {
  const searchParams = useSearchParams();
  const navigation = useMemo(() => readPluginNavigation(searchParams), [searchParams]);
  const navigate = useCallback((patch: Partial<PluginNavigation>) => {
    const href = updatePluginNavigation(searchParams.toString(), patch);
    const query = href.slice(href.indexOf('?'));
    if (query === window.location.search) return false;
    if (!confirmPluginNavigation()) return false;
    window.history.pushState(null, '', `${window.location.pathname}${query}${window.location.hash}`);
    return true;
  }, [searchParams]);
  return { navigation, navigate };
}
