import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NextResponse } from 'next/server';
import ts from 'typescript';
import { createMobileBootstrap } from '../app/lib/mobile/bootstrap';
import { createMobileCompatibility } from '../app/lib/mobile/compatibility';

async function main() {
  const filename = path.resolve('app/api/mobile/v1/bootstrap/route.ts');
  const load = createRequire(filename);
  const exports = {} as typeof import('../app/api/mobile/v1/bootstrap/route');
  let signedIn = true, seats = 0, listings = 0;
  class FixtureGuardError extends Error {}
  const mocks: Record<string, unknown> = {
    '@/app/lib/auth': { auth: { api: { getSession: async () => signedIn ? { user: { id: 'fixture-user', email: 'fixture@example.test', role: 'admin' } } : null } } },
    '@/app/lib/license/entitlements': { LicenseEntitlementError: FixtureGuardError },
    '@/app/lib/license/seat-limit': { SeatLimitGuardError: FixtureGuardError, assertUserSeatAccess: async (input: { userId: string }) => { assert.equal(input.userId, 'fixture-user'); seats++; } },
    '@/app/lib/license/instance': { getLicenseInstanceId: () => 'private-fixture-instance' },
    '@/app/lib/migration/app-version': { getCurrentAppVersion: () => 'fixture-version' },
    '@/app/lib/organization/config': { getDeploymentMode: () => 'self-hosted' },
    '@/app/lib/workspaces/context': { resolveWorkspaceActor: (user: unknown) => user },
    '@/app/lib/workspaces/listing-action': { WorkspaceListingError: FixtureGuardError, loadWorkspaceListingForActor: async () => {
      listings++;
      return { activeWorkspaceId: null, defaultWorkspace: null, workspaces: [], canCreateSharedWorkspaces: false, teamFeaturesEnabled: false, projectFeaturesEnabled: false };
    } },
    '@/app/lib/mobile/user-profile': { resolveMobileUserProfile: async () => ({ name: 'Fixture', avatarKind: 'initials', initials: 'F', iconId: null, imagePath: null, revision: 1 }) },
    '@/app/lib/mobile/bootstrap': { createMobileBootstrap },
    '@/app/lib/mobile/compatibility': { createMobileCompatibility },
    '@/app/lib/api/route-helpers': { jsonServerError: () => NextResponse.json({ success: false }, { status: 500 }) },
  };
  const source = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', source)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports);
  const request = new Request('https://canvas.test/api/mobile/v1/bootstrap');
  signedIn = false;
  const denied = await exports.GET(request);
  assert.equal(denied.status, 401);
  assert.equal(seats + listings, 0, 'authentication precedes seat/workspace access');
  signedIn = true;
  const response = await exports.GET(request);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control')!, /no-store/);
  assert.equal(seats, 1); assert.equal(listings, 1);
  const body = await response.json();
  assert.ok(body.mobileApi.capabilities.includes('chat.dictation.v1'));
  assert.deepEqual(body.workspace.items, []);
  assert.equal(JSON.stringify(body).includes('private-fixture-instance'), false);
  console.log('mobile-bootstrap-route-test: auth, seat/workspace guards, actual bootstrap dictation capability and private instance isolation passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
