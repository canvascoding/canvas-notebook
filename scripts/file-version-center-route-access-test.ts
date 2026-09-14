import assert from 'node:assert/strict';
import { NextRequest, NextResponse } from 'next/server';

import {
  createFileVersionCenterRouteAuthorizer,
  fileVersionCenterCaughtError,
} from '../app/lib/file-version-center/route-adapter';
import {
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  parseFileVersionCenterErrorResponseV1,
} from '../app/lib/file-version-center/contracts/v1';

const request = new NextRequest('https://canvas.test/api/files/version-center/v1/resolve');
const session = { user: { id: 'user-one', email: 'user@example.test', role: 'member' } } as never;
const workspace = (id: string, status: 'active' | 'archived' = 'active') => ({
  workspaceId: id,
  workspaceType: 'team',
  rootPath: '/private/workspace',
  status,
  legacy: false,
  permissions: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canCreatePublicLinks: true,
    canManageWorkspace: false,
    canRunAgent: true,
  },
});

async function main() {
  const requested: unknown[] = [];
  const authorize = createFileVersionCenterRouteAuthorizer(async (_request, options) => {
    requested.push(options);
    return { session, workspace: workspace('workspace-one'), response: null } as never;
  });
  const authorized = await authorize(request, 'workspace-one', 'canRead');
  assert.equal(authorized.authorized, true);
  assert.deepEqual(requested, [{ workspaceId: 'workspace-one', permissions: 'canRead' }]);
  if (authorized.authorized) {
    assert.deepEqual(authorized.access, {
      userId: 'user-one',
      authenticatedWorkspaceId: 'workspace-one',
      requestedWorkspaceId: 'workspace-one',
      membership: 'active',
      permissionsResolved: true,
      canRead: true,
      canWrite: true,
      canRunAgent: true,
      canManageWorkspace: false,
    });
  }

  const crossWorkspace = createFileVersionCenterRouteAuthorizer(async () => ({
    session,
    workspace: workspace('workspace-other'),
    response: null,
  }) as never);
  const crossed = await crossWorkspace(request, 'workspace-one', 'canRead');
  assert.equal(crossed.authorized, false);
  if (!crossed.authorized) {
    assert.equal(crossed.response.status, 403);
    assert.equal(parseFileVersionCenterErrorResponseV1(await crossed.response.json()).error.code, 'FVRC_ACCESS_DENIED');
  }

  const accessLost = createFileVersionCenterRouteAuthorizer(async () => ({
    session: null,
    workspace: null,
    response: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }),
  }) as never);
  const denied = await accessLost(request, 'workspace-one', 'canRead');
  assert.equal(denied.authorized, false);
  if (!denied.authorized) {
    assert.equal(denied.response.status, 403);
    assert.equal(denied.response.headers.get('cache-control'), 'private, no-store, max-age=0');
  }

  const inactive = createFileVersionCenterRouteAuthorizer(async () => ({
    session,
    workspace: workspace('workspace-one', 'archived'),
    response: null,
  }) as never);
  assert.equal((await inactive(request, 'workspace-one', 'canRead')).authorized, false);

  const stale = fileVersionCenterCaughtError(new FileVersionCenterContractError(
    FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
    'Reload the current document.',
  ));
  assert.equal(stale.status, 409);
  assert.equal(parseFileVersionCenterErrorResponseV1(await stale.json()).error.retryable, false);
  const hidden = fileVersionCenterCaughtError(new Error('secret database path'));
  assert.equal(hidden.status, 500);
  assert.doesNotMatch(await hidden.text(), /secret database path/u);
  console.log('file-version-center-route-access-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
