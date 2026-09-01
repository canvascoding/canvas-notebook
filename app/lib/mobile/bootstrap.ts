import 'server-only';

import type { MobileCompatibility } from './compatibility';
import type { MobileUserProfile } from './user-profile';
import type { WorkspaceListing } from '@/app/lib/workspaces/listing-action';
import type { WorkspaceContext, WorkspacePermissions, WorkspaceUserRole } from '@/app/lib/workspaces/types';
import { buildPublicRequestUrl } from '@/app/lib/utils/request-origin';

export type MobileWorkspaceAccess = 'manage' | 'edit' | 'read';

export type MobileWorkspaceSummary = {
  id: string;
  type: WorkspaceContext['workspaceType'];
  name: string;
  description: string;
  icon: string | null;
  status: NonNullable<WorkspaceContext['status']>;
  isDefault: boolean;
  legacy: boolean;
  access: MobileWorkspaceAccess;
  permissions: WorkspacePermissions;
};

export type MobileBootstrap = {
  product: 'canvas-notebook';
  mobileApi: {
    version: 'v1';
    capabilities: string[];
  };
  instance: MobileCompatibility['instance'];
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    profile: MobileUserProfile;
    role: WorkspaceUserRole;
  };
  workspace: {
    activeWorkspaceId: string | null;
    defaultWorkspaceId: string | null;
    teamFeaturesEnabled: boolean;
    projectFeaturesEnabled: boolean;
    canCreateSharedWorkspaces: boolean;
    items: MobileWorkspaceSummary[];
  };
};

function workspaceAccess(workspace: WorkspaceContext): MobileWorkspaceAccess {
  if (workspace.permissions.canManageWorkspace) return 'manage';
  if (workspace.permissions.canWrite) return 'edit';
  return 'read';
}

export function serializeMobileWorkspace(workspace: WorkspaceContext): MobileWorkspaceSummary {
  return {
    id: workspace.workspaceId,
    type: workspace.workspaceType,
    name: workspace.displayName || workspace.workspaceType,
    description: workspace.description || '',
    icon: workspace.icon || null,
    status: workspace.status || 'active',
    isDefault: Boolean(workspace.isDefault),
    legacy: workspace.legacy,
    access: workspaceAccess(workspace),
    permissions: workspace.permissions,
  };
}

function normalizeRole(value: string | null | undefined): WorkspaceUserRole {
  if (value === 'owner' || value === 'admin' || value === 'external') return value;
  return 'member';
}

export function createMobileBootstrap(input: {
  compatibility: MobileCompatibility;
  request: {
    headers: Pick<Headers, 'get'>;
    url: string | URL;
  };
  user: {
    id: string;
    name?: string | null;
    email: string;
    image?: string | null;
    role?: string | null;
  };
  profile: MobileUserProfile;
  listing: WorkspaceListing;
}): MobileBootstrap {
  const capabilities = [
    'account.preferences',
    'account.profile.read',
    'account.profile.update',
    'account.profile.avatar',
    'workspace.read',
    'workspace.switch',
    'workspace.update',
    'workspace.members.read',
    'workspace.brand.read',
    'workspace.brand.update',
    'license.status',
    'license.register',
    'license.activate',
    'chat.agents',
    'chat.sessions',
    'chat.messages',
    'chat.realtime',
    'chat.session_manage',
    'chat.attachments',
    'chat.runtime_control',
    'chat.runtime_selection',
    'browser.live_view',
    'agents.manage',
    'push.devices',
    'push.agent_response_ready',
    'push.attention_categories',
    'push.automation_run_status',
    'push.receipts',
    'push.rich_previews',
    'push.app_badge',
    'notebook.documents',
    'notebook.revision_write',
    'notebook.image_import',
    'notebook.collaboration.yjs',
    'notebook.collaboration.session.v1',
    'files.browse',
    'files.sort.v1',
    'files.html_preview',
    'files.marp_preview.v1',
    'files.mutate',
    'files.excalidraw_edit',
    'files.copy',
    'files.export',
    'files.upload',
    'files.public_share',
    'inbox.feed',
    'inbox.aggregate',
    'inbox.sources',
    'inbox.categories',
    'inbox.email_attention',
    'inbox.read_state',
    'inbox.dismiss',
    'todos.read',
    'todos.write',
    'todos.follow_up',
    'todos.scope',
    'studio.quick_create',
    'studio.generations',
    'studio.references',
    'studio.outputs',
    'studio.advanced_options',
    'studio.library',
    'studio.output_actions',
    'studio.library_manage',
    'studio.presets_manage',
    'studio.bulk',
    'studio.aspect_ratio',
    'studio.aspect_ratio.positioned_crop',
    'studio.aspect_ratio.canvas_frame',
    'automations.jobs',
    'automations.run_control',
    'automations.run_history',
    'automations.webhooks',
    'automations.composio_triggers',
    'extensions.store',
    'extensions.marketplace_v2',
    'integrations.composio_catalog',
    'integrations.composio_mobile_auth',
  ];
  if (input.listing.canCreateSharedWorkspaces) capabilities.push('workspace.create');

  return {
    product: 'canvas-notebook',
    mobileApi: {
      version: 'v1',
      capabilities,
    },
    instance: input.compatibility.instance,
    user: {
      id: input.user.id,
      name: input.user.name?.trim() || input.user.email,
      email: input.user.email,
      image: resolveMobileUserImageUrl(input.user.image, input.request),
      profile: input.profile,
      role: normalizeRole(input.user.role),
    },
    workspace: {
      activeWorkspaceId: input.listing.activeWorkspaceId,
      defaultWorkspaceId: input.listing.defaultWorkspace?.workspaceId || null,
      teamFeaturesEnabled: input.listing.teamFeaturesEnabled,
      projectFeaturesEnabled: input.listing.projectFeaturesEnabled,
      canCreateSharedWorkspaces: input.listing.canCreateSharedWorkspaces,
      items: input.listing.workspaces.map(serializeMobileWorkspace),
    },
  };
}

function resolveMobileUserImageUrl(
  value: string | null | undefined,
  request: { headers: Pick<Headers, 'get'>; url: string | URL },
): string | null {
  const imageUrl = value?.trim();
  if (!imageUrl) return null;
  if (imageUrl.startsWith('/')) {
    return buildPublicRequestUrl(request, imageUrl).toString();
  }
  try {
    const parsed = new URL(imageUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}
