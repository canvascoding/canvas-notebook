import assert from 'node:assert/strict';

import { createMobileBootstrap } from '../app/lib/mobile/bootstrap';
import { createMobileCompatibility } from '../app/lib/mobile/compatibility';
import type { WorkspaceListing } from '../app/lib/workspaces/listing-action';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const permissions = {
  canRead: true,
  canWrite: true,
  canDelete: true,
  canCreatePublicLinks: true,
  canManageWorkspace: true,
  canRunAgent: true,
};

const workspace: WorkspaceContext = {
  workspaceId: 'workspace-personal-1',
  workspaceType: 'personal',
  rootPath: '/private/data/workspaces/personal/user-1/files',
  rootRelativePath: 'workspaces/personal/user-1/files',
  displayName: 'Mobile Workspace',
  description: 'The first mobile workspace.',
  status: 'active',
  isDefault: true,
  ownerUserId: 'user-1',
  permissions,
  legacy: false,
};

const listing: WorkspaceListing = {
  organizationId: 'organization-private-id',
  teamFeaturesEnabled: true,
  projectFeaturesEnabled: false,
  canCreateSharedWorkspaces: true,
  databaseProvider: 'postgres',
  activeWorkspaceId: workspace.workspaceId,
  defaultWorkspace: workspace,
  workspaces: [workspace],
  warnings: ['internal warning must not be exposed'],
};

const bootstrap = createMobileBootstrap({
  compatibility: createMobileCompatibility({
    rawInstanceId: 'private-instance-id',
    instanceName: 'Test Canvas',
    serverVersion: '2026.7.19',
    deploymentMode: 'managed-team',
  }),
  request: {
    headers: new Headers({
      host: 'internal-canvas:3000',
      'x-forwarded-host': 'canvas.example.test',
      'x-forwarded-proto': 'https',
    }),
    url: 'http://internal-canvas:3000/api/mobile/v1/bootstrap',
  },
  user: {
    id: 'user-1',
    name: 'Mobile User',
    email: 'mobile@example.test',
    image: '/api/account/profile/avatar?v=3',
    role: 'admin',
  },
  profile: {
    name: 'Mobile User',
    avatarKind: 'icon',
    iconId: 'rocket',
    initials: 'MU',
    imagePath: null,
    revision: 3,
  },
  listing,
});

assert.equal(bootstrap.product, 'canvas-notebook');
assert.equal(
  bootstrap.user.image,
  'https://canvas.example.test/api/account/profile/avatar?v=3',
);
assert.deepEqual(bootstrap.mobileApi.capabilities, [
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
  'push.device_session_sync',
  'push.preference_updates',
  'push.email_review',
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
  'workspace.create',
]);
assert.deepEqual(bootstrap.user.profile, {
  name: 'Mobile User',
  avatarKind: 'icon',
  iconId: 'rocket',
  initials: 'MU',
  imagePath: null,
  revision: 3,
});
assert.equal(bootstrap.user.role, 'admin');
assert.equal(bootstrap.workspace.activeWorkspaceId, workspace.workspaceId);
assert.equal(bootstrap.workspace.items[0]?.access, 'manage');
assert.equal(bootstrap.workspace.items[0]?.legacy, false);
assert.equal(bootstrap.workspace.items[0]?.permissions.canRunAgent, true);

const serialized = JSON.stringify(bootstrap);
assert.equal(serialized.includes('/private/data'), false);
assert.equal(serialized.includes('workspaces/personal'), false);
assert.equal(serialized.includes('organization-private-id'), false);
assert.equal(serialized.includes('internal warning'), false);

console.log('mobile-bootstrap-test: ok');
