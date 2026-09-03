import 'server-only';

import type { ClientWorkspaceSummary } from './client-types';
import { DEFAULT_WORKSPACE_COLOR } from './colors';
import type { WorkspaceContext } from './types';

export function serializeWorkspaceContext(workspace: WorkspaceContext): ClientWorkspaceSummary {
  return {
    id: workspace.workspaceId,
    type: workspace.workspaceType,
    name: workspace.displayName || workspace.workspaceType,
    description: workspace.description || '',
    organizationId: workspace.organizationId,
    customerId: workspace.customerId,
    projectId: workspace.projectId,
    ownerUserId: workspace.ownerUserId,
    rootRelativePath: workspace.rootRelativePath,
    icon: workspace.icon,
    color: workspace.color || DEFAULT_WORKSPACE_COLOR,
    status: workspace.status || 'active',
    isDefault: Boolean(workspace.isDefault),
    permissions: workspace.permissions,
    legacy: workspace.legacy,
  };
}
