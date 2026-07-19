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
  user: {
    id: 'user-1',
    name: 'Mobile User',
    email: 'mobile@example.test',
    role: 'admin',
  },
  listing,
});

assert.equal(bootstrap.product, 'canvas-notebook');
assert.deepEqual(bootstrap.mobileApi.capabilities, [
  'workspace.read',
  'workspace.switch',
  'chat.agents',
  'chat.sessions',
  'chat.messages',
  'chat.realtime',
  'push.devices',
  'push.agent_response_ready',
  'notebook.documents',
  'notebook.revision_write',
  'workspace.create',
]);
assert.equal(bootstrap.user.role, 'admin');
assert.equal(bootstrap.workspace.activeWorkspaceId, workspace.workspaceId);
assert.equal(bootstrap.workspace.items[0]?.access, 'manage');
assert.equal(bootstrap.workspace.items[0]?.permissions.canRunAgent, true);

const serialized = JSON.stringify(bootstrap);
assert.equal(serialized.includes('/private/data'), false);
assert.equal(serialized.includes('workspaces/personal'), false);
assert.equal(serialized.includes('organization-private-id'), false);
assert.equal(serialized.includes('internal warning'), false);

console.log('mobile-bootstrap-test: ok');
