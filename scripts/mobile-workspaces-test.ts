import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  serializeMobileWorkspaceMember,
  serializeMobileWorkspaceMemberCandidate,
} from '../app/lib/mobile/workspaces';

const member = serializeMobileWorkspaceMember({
  workspaceId: 'workspace-1',
  userId: 'user-1',
  name: 'Mobile Member',
  email: 'member@example.test',
  role: 'member',
  status: 'active',
  canRead: true,
  canWrite: true,
  canManage: false,
  createdAt: 1,
  updatedAt: 2,
});
assert.deepEqual(member, {
  userId: 'user-1',
  name: 'Mobile Member',
  email: 'member@example.test',
  role: 'member',
  status: 'active',
  access: 'edit',
});
assert.equal(JSON.stringify(member).includes('workspace-1'), false);
assert.deepEqual(serializeMobileWorkspaceMemberCandidate({
  userId: 'user-2',
  name: 'Candidate',
  email: 'candidate@example.test',
  role: 'member',
  status: 'active',
}), {
  userId: 'user-2',
  name: 'Candidate',
  email: 'candidate@example.test',
  role: 'member',
  status: 'active',
});

const root = process.cwd();
const createRoute = readFileSync(path.join(root, 'app/api/mobile/v1/workspaces/route.ts'), 'utf8');
const updateRoute = readFileSync(path.join(root, 'app/api/mobile/v1/workspaces/[workspaceId]/route.ts'), 'utf8');
const membersRoute = readFileSync(path.join(root, 'app/api/mobile/v1/workspaces/[workspaceId]/members/route.ts'), 'utf8');
const memberDeleteRoute = readFileSync(path.join(root, 'app/api/mobile/v1/workspaces/[workspaceId]/members/[userId]/route.ts'), 'utf8');
const candidatesRoute = readFileSync(path.join(root, 'app/api/mobile/v1/workspaces/member-candidates/route.ts'), 'utf8');
assert.match(createRoute, /createMobileWorkspace/u);
assert.match(createRoute, /resolveWorkspaceActor/u);
assert.match(updateRoute, /WORKSPACE_CONTEXT_MISMATCH/u);
assert.match(updateRoute, /updateMobileWorkspace/u);
assert.match(membersRoute, /listMobileWorkspaceMembers/u);
assert.match(membersRoute, /updateMobileWorkspaceMember/u);
assert.match(membersRoute, /x-canvas-workspace-id/iu);
assert.match(memberDeleteRoute, /removeMobileWorkspaceMember/u);
assert.match(candidatesRoute, /listMobileWorkspaceMemberCandidates/u);

console.log('mobile-workspaces-test: ok');
