import 'server-only';

import {
  getUserInboxExcludedWorkspaceIds,
  setUserInboxExcludedWorkspaceIds,
} from '@/app/lib/user-preferences';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { loadWorkspaceListingForActor } from '@/app/lib/workspaces/listing-action';
import type { WorkspaceContext, WorkspaceType } from '@/app/lib/workspaces/types';

import { MobileInboxError } from './inbox';

type MobileInboxSessionUser = {
  id: string;
  email?: string | null;
  role?: string | null;
};

export type MobileInboxSource = {
  id: string;
  type: WorkspaceType;
  name: string;
  included: boolean;
};

export type MobileInboxScope = {
  availableWorkspaces: WorkspaceContext[];
  includedWorkspaces: WorkspaceContext[];
  excludedWorkspaceIds: string[];
  sources: MobileInboxSource[];
};

function availableInboxWorkspaces(workspaces: WorkspaceContext[]): WorkspaceContext[] {
  return workspaces.filter((workspace) => (
    workspace.permissions.canRead
    && (workspace.status ?? 'active') === 'active'
  ));
}

export async function loadMobileInboxScope(user: MobileInboxSessionUser): Promise<MobileInboxScope> {
  const actor = resolveWorkspaceActor(user);
  const [listing, storedExcludedWorkspaceIds] = await Promise.all([
    loadWorkspaceListingForActor(actor),
    getUserInboxExcludedWorkspaceIds(user.id),
  ]);
  const availableWorkspaces = availableInboxWorkspaces(listing.workspaces);
  const availableIds = new Set(availableWorkspaces.map((workspace) => workspace.workspaceId));
  const excludedWorkspaceIds = storedExcludedWorkspaceIds.filter((workspaceId) => availableIds.has(workspaceId));
  const excludedIds = new Set(excludedWorkspaceIds);
  const includedWorkspaces = availableWorkspaces.filter((workspace) => !excludedIds.has(workspace.workspaceId));
  return {
    availableWorkspaces,
    includedWorkspaces,
    excludedWorkspaceIds,
    sources: availableWorkspaces.map((workspace) => ({
      id: workspace.workspaceId,
      type: workspace.workspaceType,
      name: workspace.displayName || workspace.workspaceType,
      included: !excludedIds.has(workspace.workspaceId),
    })),
  };
}

export async function updateMobileInboxScope(
  user: MobileInboxSessionUser,
  excludedWorkspaceIds: unknown,
): Promise<MobileInboxScope> {
  if (
    !Array.isArray(excludedWorkspaceIds)
    || excludedWorkspaceIds.length > 250
    || excludedWorkspaceIds.some((value) => (
      typeof value !== 'string'
      || !value.trim()
      || value.trim() !== value
      || value.length > 200
    ))
    || new Set(excludedWorkspaceIds).size !== excludedWorkspaceIds.length
  ) {
    throw new MobileInboxError(
      'INVALID_INBOX_SOURCES',
      'The Inbox workspace selection is invalid.',
      400,
    );
  }
  const current = await loadMobileInboxScope(user);
  const availableIds = new Set(current.availableWorkspaces.map((workspace) => workspace.workspaceId));
  if (excludedWorkspaceIds.some((workspaceId) => !availableIds.has(workspaceId))) {
    throw new MobileInboxError(
      'INVALID_INBOX_SOURCES',
      'The Inbox workspace selection contains an unavailable workspace.',
      400,
    );
  }
  if (current.availableWorkspaces.length > 0 && excludedWorkspaceIds.length === current.availableWorkspaces.length) {
    throw new MobileInboxError(
      'EMPTY_INBOX_SCOPE',
      'Keep at least one workspace in the Inbox.',
      400,
    );
  }
  await setUserInboxExcludedWorkspaceIds(user.id, excludedWorkspaceIds);
  return loadMobileInboxScope(user);
}
