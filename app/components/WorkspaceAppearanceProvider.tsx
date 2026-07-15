'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

import { useTheme } from '@/app/components/ThemeProvider';
import {
  WORKSPACE_APPEARANCE_CSS_PROPERTIES,
  WORKSPACE_APPEARANCE_UPDATED_EVENT,
  createWorkspaceAppearanceCssTokens,
  normalizeWorkspaceAppearanceDefinition,
  workspaceAppearanceDefinitionFromProfile,
  type WorkspaceAppearanceDefinition,
} from '@/app/lib/workspaces/appearance-theme';
import { normalizeWorkspaceBrandProfile } from '@/app/lib/workspaces/brand-profile';
import { useWorkspaceStore } from '@/app/store/workspace-store';

const CACHE_PREFIX = 'canvas.workspaceAppearance.';
const NON_WORKSPACE_ROUTE_PATTERN = /\/(?:login|sign-in|sign-up|setup|onboarding)(?:\/|$)/u;

type LoadedAppearance = {
  workspaceId: string;
  definition: WorkspaceAppearanceDefinition;
};

function cacheKey(workspaceId: string): string {
  return `${CACHE_PREFIX}${workspaceId}`;
}

function readCachedAppearance(workspaceId: string): WorkspaceAppearanceDefinition | null {
  try {
    return normalizeWorkspaceAppearanceDefinition(JSON.parse(window.localStorage.getItem(cacheKey(workspaceId)) || 'null'));
  } catch {
    return null;
  }
}

function writeCachedAppearance(workspaceId: string, definition: WorkspaceAppearanceDefinition) {
  try {
    window.localStorage.setItem(cacheKey(workspaceId), JSON.stringify(definition));
  } catch {
    // The server response remains authoritative when browser storage is unavailable.
  }
}

function clearCachedAppearances() {
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(CACHE_PREFIX)) keysToRemove.push(key);
    }
    for (const key of keysToRemove) window.localStorage.removeItem(key);
  } catch {
    // Cache invalidation is best-effort; every workspace is revalidated by the API on activation.
  }
}

function clearWorkspaceAppearance(root: HTMLElement) {
  delete root.dataset.workspaceAppearance;
  delete root.dataset.workspaceAppearanceWorkspace;
  for (const property of WORKSPACE_APPEARANCE_CSS_PROPERTIES) {
    root.style.removeProperty(property);
  }
}

function applyWorkspaceAppearance(
  root: HTMLElement,
  workspaceId: string,
  definition: WorkspaceAppearanceDefinition,
  mode: 'light' | 'dark',
) {
  if (!definition.enabled) {
    clearWorkspaceAppearance(root);
    return;
  }

  const tokens = createWorkspaceAppearanceCssTokens(definition, mode);
  root.dataset.workspaceAppearance = 'true';
  root.dataset.workspaceAppearanceWorkspace = workspaceId;
  for (const property of WORKSPACE_APPEARANCE_CSS_PROPERTIES) {
    root.style.setProperty(property, tokens[property]);
  }
}

export function WorkspaceAppearanceProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const [loadedAppearance, setLoadedAppearance] = useState<LoadedAppearance | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const requestIdRef = useRef(0);
  const workspaceAppearanceAllowed = !NON_WORKSPACE_ROUTE_PATTERN.test(pathname || '');

  useEffect(() => {
    if (!workspaceAppearanceAllowed) return;
    void hydrateWorkspaces();
  }, [hydrateWorkspaces, workspaceAppearanceAllowed]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!workspaceAppearanceAllowed || !activeWorkspaceId) {
      clearWorkspaceAppearance(root);
      return;
    }

    const definition = loadedAppearance?.workspaceId === activeWorkspaceId
      ? loadedAppearance.definition
      : readCachedAppearance(activeWorkspaceId);
    if (!definition) {
      clearWorkspaceAppearance(root);
      return;
    }
    applyWorkspaceAppearance(root, activeWorkspaceId, definition, resolvedTheme);
  }, [activeWorkspaceId, loadedAppearance, resolvedTheme, workspaceAppearanceAllowed]);

  useEffect(() => {
    if (!workspaceAppearanceAllowed || !activeWorkspaceId) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(activeWorkspaceId)}/brand`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as { success?: boolean; profile?: unknown } | null;
        if (!response.ok || !payload?.success || !payload.profile) return;
        if (requestId !== requestIdRef.current) return;

        const profile = normalizeWorkspaceBrandProfile(payload.profile);
        const definition = workspaceAppearanceDefinitionFromProfile(profile);
        writeCachedAppearance(activeWorkspaceId, definition);
        setLoadedAppearance({ workspaceId: activeWorkspaceId, definition });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.warn('[WorkspaceAppearance] Failed to refresh workspace design:', error);
        }
      }
    })();

    return () => controller.abort();
  }, [activeWorkspaceId, refreshRevision, workspaceAppearanceAllowed]);

  const refreshAppearance = useCallback(() => {
    clearCachedAppearances();
    setRefreshRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    window.addEventListener(WORKSPACE_APPEARANCE_UPDATED_EVENT, refreshAppearance);
    return () => window.removeEventListener(WORKSPACE_APPEARANCE_UPDATED_EVENT, refreshAppearance);
  }, [refreshAppearance]);

  return children;
}
