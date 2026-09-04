'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';

import { useTheme } from '@/app/components/ThemeProvider';
import {
  DEFAULT_WORKSPACE_BRANDING,
  WorkspaceBrandingContext,
} from '@/app/components/workspaces/WorkspaceBrandingContext';
import {
  WORKSPACE_ACCENT_CSS_PROPERTIES,
  WORKSPACE_APPEARANCE_CSS_PROPERTIES,
  WORKSPACE_APPEARANCE_UPDATED_EVENT,
  createWorkspaceAccentCssTokens,
  createWorkspaceAppearanceCssTokens,
  normalizeWorkspaceAppearanceDefinition,
  workspaceAppearanceDefinitionFromProfile,
  type WorkspaceAppearanceDefinition,
} from '@/app/lib/workspaces/appearance-theme';
import { normalizeWorkspaceBrandProfile } from '@/app/lib/workspaces/brand-profile';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';

const CACHE_PREFIX = 'canvas.workspaceAppearance.';
const NON_WORKSPACE_ROUTE_PATTERN = /\/(?:login|sign-in|sign-up|setup|onboarding)(?:\/|$)/u;

type LoadedWorkspaceBranding = {
  workspaceId: string;
  definition: WorkspaceAppearanceDefinition;
  brandName: string;
  logoUrl: string | null;
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

function applyWorkspaceAccent(
  root: HTMLElement,
  workspaceId: string,
  accentColor: string,
  mode: 'light' | 'dark',
) {
  clearWorkspaceAppearance(root);
  const tokens = createWorkspaceAccentCssTokens(accentColor, mode);
  root.dataset.workspaceAppearance = 'accent';
  root.dataset.workspaceAppearanceWorkspace = workspaceId;
  for (const property of WORKSPACE_ACCENT_CSS_PROPERTIES) {
    root.style.setProperty(property, tokens[property]);
  }
}

export function WorkspaceAppearanceProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const activeWorkspaceId = activeWorkspace?.id || null;
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const [loadedBranding, setLoadedBranding] = useState<LoadedWorkspaceBranding | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const requestIdRef = useRef(0);
  const workspaceAppearanceAllowed = !NON_WORKSPACE_ROUTE_PATTERN.test(pathname || '');

  useEffect(() => {
    if (!workspaceAppearanceAllowed) return;
    void hydrateWorkspaces();
  }, [hydrateWorkspaces, workspaceAppearanceAllowed]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!workspaceAppearanceAllowed || !activeWorkspace) {
      clearWorkspaceAppearance(root);
      return;
    }
    const workspaceId = activeWorkspace.id;

    const definition = loadedBranding?.workspaceId === workspaceId
      ? loadedBranding.definition
      : readCachedAppearance(workspaceId);
    if (definition?.enabled) {
      applyWorkspaceAppearance(root, workspaceId, definition, resolvedTheme);
    } else {
      applyWorkspaceAccent(root, workspaceId, activeWorkspace.color, resolvedTheme);
    }
  }, [activeWorkspace, loadedBranding, resolvedTheme, workspaceAppearanceAllowed]);

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
        const payload = await response.json().catch(() => null) as {
          success?: boolean;
          profile?: unknown;
          revision?: unknown;
          source?: unknown;
          updatedAt?: unknown;
        } | null;
        if (!response.ok || !payload?.success || !payload.profile) return;
        if (requestId !== requestIdRef.current) return;

        const profile = normalizeWorkspaceBrandProfile(payload.profile);
        const definition = workspaceAppearanceDefinitionFromProfile(profile);
        const logoVersion = [
          typeof payload.source === 'string' ? payload.source : 'default',
          typeof payload.revision === 'number' ? payload.revision : 0,
          typeof payload.updatedAt === 'number' ? payload.updatedAt : 0,
        ].join('-');
        const logoUrl = profile.appearance.enabled && profile.logoPath
          ? `/api/workspaces/${encodeURIComponent(activeWorkspaceId)}/brand/logo?v=${encodeURIComponent(logoVersion)}`
          : null;
        writeCachedAppearance(activeWorkspaceId, definition);
        setLoadedBranding({
          workspaceId: activeWorkspaceId,
          definition,
          brandName: profile.brandName,
          logoUrl,
        });
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

  const workspaceBranding = useMemo(() => {
    if (
      !workspaceAppearanceAllowed
      || !activeWorkspaceId
      || loadedBranding?.workspaceId !== activeWorkspaceId
    ) {
      return DEFAULT_WORKSPACE_BRANDING;
    }
    return {
      workspaceId: activeWorkspaceId,
      brandName: loadedBranding.brandName,
      logoUrl: loadedBranding.logoUrl,
    };
  }, [activeWorkspaceId, loadedBranding, workspaceAppearanceAllowed]);

  return (
    <WorkspaceBrandingContext.Provider value={workspaceBranding}>
      {children}
    </WorkspaceBrandingContext.Provider>
  );
}
