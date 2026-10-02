import assert from 'node:assert/strict';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { loadIsolatedModule } from './helpers/isolated-source-module';
import * as contracts from '../app/lib/file-version-center/contracts/v1';

import {
  createFileVersionCenterRouteAuthorizer,
  documentReviewUnavailableResponse,
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
  }, () => true);
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
  }) as never, () => true);
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
  }) as never, () => { throw new Error('Availability must be checked after authorization.'); });
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
  }) as never, () => { throw new Error('Availability must be checked after active membership.'); });
  assert.equal((await inactive(request, 'workspace-one', 'canRead')).authorized, false);

  let enabled = false;
  const featureControlled = createFileVersionCenterRouteAuthorizer(async () => ({
    session,
    workspace: workspace('workspace-one'),
    response: null,
  }) as never, () => enabled);
  const unavailable = await featureControlled(request, 'workspace-one', 'canWrite');
  assert.equal(unavailable.authorized, false);
  if (!unavailable.authorized) {
    assert.equal(unavailable.response.status, 409);
    assert.equal(unavailable.response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(parseFileVersionCenterErrorResponseV1(await unavailable.response.json()).error.code,
      FILE_VERSION_CENTER_ERROR_CODES.capabilityUnavailable);
  }
  enabled = true;
  assert.equal((await featureControlled(request, 'workspace-one', 'canWrite')).authorized, true);
  enabled = false;
  assert.equal((await featureControlled(request, 'workspace-one', 'canRead')).authorized, false);
  assert.equal(documentReviewUnavailableResponse(() => true), null);
  assert.equal(documentReviewUnavailableResponse(() => false)?.status, 409);

  const stale = fileVersionCenterCaughtError(new FileVersionCenterContractError(
    FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
    'Reload the current document.',
  ));
  assert.equal(stale.status, 409);
  assert.equal(parseFileVersionCenterErrorResponseV1(await stale.json()).error.retryable, false);
  const disabledCapability = fileVersionCenterCaughtError(new FileVersionCenterContractError(
    FILE_VERSION_CENTER_ERROR_CODES.capabilityUnavailable,
    'The Document Review Center is disabled.',
  ));
  assert.equal(disabledCapability.status, 409);
  assert.equal(parseFileVersionCenterErrorResponseV1(await disabledCapability.json()).error.retryable, false);
  const hidden = fileVersionCenterCaughtError(new Error('secret database path'));
  assert.equal(hidden.status, 500);
  assert.doesNotMatch(await hidden.text(), /secret database path/u);
  for (const endpoint of ['resolve', 'timeline']) {
    const calls: Array<{ includeHistoryProvenance?: boolean }> = [];
    const route = loadIsolatedModule<{ POST: (request: NextRequest) => Promise<Response> }>(
      path.resolve(`app/api/files/version-center/v1/${endpoint}/route.ts`), {
        'next/server': { NextRequest, NextResponse },
        '@/app/lib/file-version-center/contracts/v1': contracts,
        '@/app/lib/file-version-center/observability': { observeFileVersionCenter: () => {} },
        '@/app/lib/file-version-center/policy-v1': { FILE_VERSION_CENTER_RATE_LIMITS_V1: { resolve: {}, timeline: {} } },
        '@/app/lib/file-version-center/query-service': { fileVersionCenterQueryService: {
          timeline: async (input: { includeHistoryProvenance?: boolean }) => { calls.push(input); return { entries: [] }; },
        } },
        '@/app/lib/file-version-center/route-adapter': {
          authorizeFileVersionCenterRequest: authorize,
          readFileVersionCenterJson: (request: NextRequest) => request.json(),
          applyFileVersionCenterRateLimit: () => null,
          FILE_VERSION_CENTER_PRIVATE_HEADERS: { 'Cache-Control': 'private, no-store, max-age=0' },
          fileVersionCenterCaughtError,
        },
      },
    );
    for (const capability of [null, '0', 'true', '1']) {
      const headers = new Headers({ 'content-type': 'application/json' });
      if (capability) headers.set(contracts.FILE_VERSION_HISTORY_PROVENANCE_HEADER_V1, capability);
      const response = await route.POST(new NextRequest(`https://canvas.test/api/files/version-center/v1/${endpoint}`, {
        method: 'POST', headers, body: JSON.stringify({ contractVersion: 1,
          target: { kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-one' },
          ...(endpoint === 'resolve' ? { initialView: 'history', source: 'editor' } : {}),
        }),
      }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
      assert.equal(calls.at(-1)?.includeHistoryProvenance, capability === '1',
        `${endpoint}: only the exact capability header opts into response provenance`);
    }
  }
  console.log('file-version-center-route-access-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
