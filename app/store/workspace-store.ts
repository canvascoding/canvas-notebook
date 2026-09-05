import { create } from 'zustand';

import type {
  ClientWorkspaceResponse,
  ClientWorkspaceSummary,
  ClientWorkspaceType,
} from '@/app/lib/workspaces/client-types';
import { DEFAULT_WORKSPACE_COLOR, parseWorkspaceColor } from '@/app/lib/workspaces/colors';
import { isWorkspaceIcon } from '@/app/lib/workspaces/icons';

export const WORKSPACE_CHANGED_EVENT = 'canvas:workspace-changed';
const ACTIVE_WORKSPACE_STORAGE_KEY = 'canvas.activeWorkspaceId';

export type WorkspaceSwitchSource =
  | 'home'
  | 'navbar'
  | 'chat'
  | 'file-browser'
  | 'notebook'
  | 'studio'
  | 'system'
  | 'test';

export interface WorkspaceChangedDetail {
  previousWorkspaceId: string | null;
  activeWorkspaceId: string;
  workspace: ClientWorkspaceSummary;
  source: WorkspaceSwitchSource;
}

export interface TeamModeUnavailableState {
  message: string;
  code: string | null;
  feature: string | null;
}

interface WorkspaceStoreState {
  workspaces: ClientWorkspaceSummary[];
  activeWorkspaceId: string | null;
  organizationId: string | null;
  teamFeaturesEnabled: boolean;
  projectFeaturesEnabled: boolean;
  canCreateSharedWorkspaces: boolean;
  databaseProvider: string | null;
  teamModeUnavailable: TeamModeUnavailableState | null;
  warnings: string[];
  isLoading: boolean;
  initialized: boolean;
  error: string | null;
  lastUpdatedAt: number | null;
  hydrateWorkspaces: (options?: { force?: boolean }) => Promise<void>;
  setActiveWorkspace: (workspaceId: string, source?: WorkspaceSwitchSource) => Promise<boolean>;
  refreshWorkspaces: () => Promise<void>;
}

function teamModeUnavailableFromPayload(payload: ClientWorkspaceResponse): TeamModeUnavailableState | null {
  const feature = typeof payload.feature === 'string' ? payload.feature : null;
  const code = typeof payload.code === 'string' ? payload.code : null;
  const message = typeof payload.error === 'string' ? payload.error : '';
  const blocksTeamRuntime = /team runtime|team workspace|team mode/iu.test(message);

  if (feature !== 'teamWorkspace' && !blocksTeamRuntime) return null;
  if (
    code
    && code !== 'LICENSE_FEATURE_REQUIRED'
    && code !== 'LICENSE_TEAM_REQUIRED'
    && !blocksTeamRuntime
  ) return null;

  return {
    message: message || 'Team mode is currently not available for this self-hosted instance.',
    code,
    feature,
  };
}

function readCachedActiveWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const stored = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
    return stored?.trim() || null;
  } catch {
    return null;
  }
}

function writeCachedActiveWorkspaceId(workspaceId: string) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
  } catch {
    // Non-critical: the server remains the source of truth for allowed workspaces.
  }
}

function dispatchWorkspaceChanged(detail: WorkspaceChangedDetail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<WorkspaceChangedDetail>(WORKSPACE_CHANGED_EVENT, { detail }));
}

function isWorkspaceType(value: unknown): value is ClientWorkspaceType {
  return value === 'personal' || value === 'organization' || value === 'team' || value === 'project';
}

function normalizeWorkspace(candidate: unknown): ClientWorkspaceSummary | null {
  if (!candidate || typeof candidate !== 'object') return null;

  const record = candidate as Partial<ClientWorkspaceSummary>;
  if (typeof record.id !== 'string' || !record.id.trim()) return null;
  if (!isWorkspaceType(record.type)) return null;

  const permissions = record.permissions;
  if (!permissions || typeof permissions !== 'object' || permissions.canRead !== true) {
    return null;
  }

  return {
    id: record.id,
    type: record.type,
    name: typeof record.name === 'string' && record.name.trim() ? record.name : `${record.type} workspace`,
    description: typeof record.description === 'string' ? record.description : '',
    organizationId: typeof record.organizationId === 'string' ? record.organizationId : null,
    customerId: typeof record.customerId === 'string' ? record.customerId : null,
    projectId: typeof record.projectId === 'string' ? record.projectId : null,
    ownerUserId: typeof record.ownerUserId === 'string' ? record.ownerUserId : null,
    rootRelativePath: typeof record.rootRelativePath === 'string' ? record.rootRelativePath : undefined,
    icon: isWorkspaceIcon(record.icon) ? record.icon : undefined,
    color: parseWorkspaceColor(record.color) || DEFAULT_WORKSPACE_COLOR,
    status: record.status === 'archived' || record.status === 'disabled' || record.status === 'recovery_locked' ? record.status : 'active',
    isDefault: Boolean(record.isDefault),
    permissions: {
      canRead: Boolean(permissions.canRead),
      canWrite: Boolean(permissions.canWrite),
      canDelete: Boolean(permissions.canDelete),
      canCreatePublicLinks: Boolean(permissions.canCreatePublicLinks),
      canManageWorkspace: Boolean(permissions.canManageWorkspace),
      canRunAgent: Boolean(permissions.canRunAgent),
    },
    legacy: Boolean(record.legacy),
  };
}

export function normalizeWorkspaceResponse(payload: ClientWorkspaceResponse): {
  workspaces: ClientWorkspaceSummary[];
  activeWorkspaceId: string | null;
  organizationId: string | null;
  teamFeaturesEnabled: boolean;
  projectFeaturesEnabled: boolean;
  canCreateSharedWorkspaces: boolean;
  databaseProvider: string | null;
  warnings: string[];
} {
  const workspaces = Array.isArray(payload.workspaces)
    ? payload.workspaces.map(normalizeWorkspace).filter((workspace): workspace is ClientWorkspaceSummary => Boolean(workspace))
    : [];
  const cachedWorkspaceId = readCachedActiveWorkspaceId();
  const serverDefaultId = typeof payload.activeWorkspaceId === 'string' ? payload.activeWorkspaceId : null;
  const preferredWorkspaceId = cachedWorkspaceId || serverDefaultId;
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === preferredWorkspaceId && workspace.status === 'active') ||
    workspaces.find((workspace) => workspace.id === serverDefaultId && workspace.status === 'active') ||
    workspaces.find((workspace) => workspace.status === 'active') ||
    null;

  return {
    workspaces,
    activeWorkspaceId: activeWorkspace?.id || null,
    organizationId: typeof payload.organizationId === 'string' ? payload.organizationId : null,
    teamFeaturesEnabled: Boolean(payload.teamFeaturesEnabled),
    projectFeaturesEnabled: Boolean(payload.projectFeaturesEnabled),
    canCreateSharedWorkspaces: Boolean(payload.canCreateSharedWorkspaces),
    databaseProvider: typeof payload.databaseProvider === 'string' ? payload.databaseProvider : null,
    warnings: Array.isArray(payload.warnings)
      ? payload.warnings.filter((warning): warning is string => typeof warning === 'string' && warning.trim().length > 0)
      : [],
  };
}

export function selectActiveWorkspace(state: Pick<WorkspaceStoreState, 'workspaces' | 'activeWorkspaceId'>) {
  return state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) || null;
}

let workspaceSwitchRequestId = 0;

let workspaceHydrationPromise: Promise<void> | null = null;

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: readCachedActiveWorkspaceId(),
  organizationId: null,
  teamFeaturesEnabled: false,
  projectFeaturesEnabled: false,
  canCreateSharedWorkspaces: false,
  databaseProvider: null,
  teamModeUnavailable: null,
  warnings: [],
  isLoading: false,
  initialized: false,
  error: null,
  lastUpdatedAt: null,

  hydrateWorkspaces: async (options = {}) => {
    const force = Boolean(options.force);
    if (get().initialized && !force) return;
    if (workspaceHydrationPromise) {
      await workspaceHydrationPromise;
      if (!force) return;
    }

    const request = (async () => {
      set({ isLoading: true, error: null });

      try {
        const response = await fetch('/api/workspaces', {
          credentials: 'include',
          cache: 'no-store',
        });
        const payload = (await response.json()) as ClientWorkspaceResponse;
        if (!response.ok || !payload.success) {
          const teamModeUnavailable = teamModeUnavailableFromPayload(payload);
          if (teamModeUnavailable) {
            set({
              workspaces: [],
              activeWorkspaceId: null,
              organizationId: typeof payload.organizationId === 'string' ? payload.organizationId : get().organizationId,
              teamFeaturesEnabled: true,
              projectFeaturesEnabled: Boolean(payload.projectFeaturesEnabled),
              canCreateSharedWorkspaces: false,
              databaseProvider: typeof payload.databaseProvider === 'string' ? payload.databaseProvider : get().databaseProvider,
              teamModeUnavailable,
              warnings: [],
              initialized: true,
              isLoading: false,
              error: null,
              lastUpdatedAt: Date.now(),
            });
            return;
          }
          throw new Error(payload.error || 'Could not load workspaces');
        }

        const normalized = normalizeWorkspaceResponse(payload);
        if (normalized.activeWorkspaceId) {
          writeCachedActiveWorkspaceId(normalized.activeWorkspaceId);
        }

        set({
          ...normalized,
          initialized: true,
          isLoading: false,
          teamModeUnavailable: null,
          error: null,
          lastUpdatedAt: Date.now(),
        });
      } catch (error) {
        set({
          initialized: true,
          isLoading: false,
          teamModeUnavailable: null,
          error: error instanceof Error ? error.message : 'Could not load workspaces',
          lastUpdatedAt: Date.now(),
        });
      }
    })();

    workspaceHydrationPromise = request;
    try {
      await request;
    } finally {
      if (workspaceHydrationPromise === request) {
        workspaceHydrationPromise = null;
      }
    }
  },

  setActiveWorkspace: async (workspaceId, source = 'system') => {
    const requestId = ++workspaceSwitchRequestId;
    const workspace = get().workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace || workspace.status !== 'active' || !workspace.permissions.canRead) return false;

    const previousWorkspaceId = get().activeWorkspaceId;
    if (previousWorkspaceId === workspace.id) return false;

    try {
      const { useFileStore } = await import('@/app/store/file-store');
      if (requestId !== workspaceSwitchRequestId || get().activeWorkspaceId !== previousWorkspaceId) return false;
      await useFileStore.getState().prepareCurrentFileForTransition();
      if (requestId !== workspaceSwitchRequestId || get().activeWorkspaceId !== previousWorkspaceId) return false;
    } catch (error) {
      if (requestId === workspaceSwitchRequestId) set({
        error: error instanceof Error ? error.message : 'Could not save the current document.',
      });
      return false;
    }
    // Permissions may have changed while the editor was saving.
    const latestWorkspace = get().workspaces.find((candidate) => candidate.id === workspaceId);
    if (!latestWorkspace || latestWorkspace.status !== 'active' || !latestWorkspace.permissions.canRead) return false;
    writeCachedActiveWorkspaceId(workspace.id);
    set({
      activeWorkspaceId: workspace.id,
      teamModeUnavailable: null,
      error: null,
      lastUpdatedAt: Date.now(),
    });
    dispatchWorkspaceChanged({
      previousWorkspaceId,
      activeWorkspaceId: workspace.id,
      workspace,
      source,
    });
    return true;
  },

  refreshWorkspaces: async () => {
    await get().hydrateWorkspaces({ force: true });
  },
}));
