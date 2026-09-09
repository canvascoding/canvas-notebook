import 'server-only';

import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const REALTIME_TEXT_WORKSPACE_TYPES = new Set<WorkspaceContext['workspaceType']>([
  'personal',
  'organization',
  'team',
  'project',
]);

/**
 * Realtime text is a storage/runtime capability, not a workspace-sharing
 * policy. Personal workspaces remain owner-scoped by workspace resolution;
 * Postgres only provides the durable Yjs engine used after that authorization.
 */
export function workspaceSupportsRealtimeTextCollaboration(
  workspace: WorkspaceContext,
): boolean {
  return REALTIME_TEXT_WORKSPACE_TYPES.has(workspace.workspaceType);
}
