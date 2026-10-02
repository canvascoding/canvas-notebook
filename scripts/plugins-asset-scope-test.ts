import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createCapabilityResourceId } from '../app/lib/capabilities/reference';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
let signedIn = true;
let active = true;
let manager = false;
let assigned = true;
let blocked = false;
let conflict = false;
let snapshotCalls = 0;
let storageReads = 0;
let personal: Record<string, unknown>;
let organization: Record<string, unknown>;

internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (parent?.filename.endsWith('/installed-plugin-read.ts') && request === '@/app/lib/plugins/canvas-plugin-registry') return {
    getCanvasPlugin: async (name: string, scope: { scopeType: string; userId?: string; organizationId?: string }) => {
      storageReads += 1;
      assert.equal(name, 'same-name');
      if (scope.scopeType === 'organization') { assert.equal(scope.organizationId, 'org'); return organization; }
      assert.equal(scope.userId, 'member'); return personal;
    },
  };
  if (parent?.filename.endsWith('/api/plugins/asset/route.ts')) {
    if (request === 'next/headers') return { headers: async () => new Headers() };
    if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => signedIn ? ({ user: { id: 'member' } }) : null } } };
    if (request === '@/app/lib/organization/permissions') return { readOrganizationPermissionForUser: async () => ({ organizationId: 'org', permission: { status: active ? 'active' : 'disabled', role: manager ? 'admin' : 'member', canSharePluginsAndSkills: manager } }) };
    if (request === '@/app/lib/capabilities/request-scope') return {
      resolveCapabilityExecutionContextForUser: async (input: { userId: string; organizationId: string; requestedWorkspaceId: string }) => {
        assert.equal(input.userId, 'member'); assert.equal(input.organizationId, 'org');
        if (input.requestedWorkspaceId !== 'org-workspace') throw new Error('Workspace unavailable');
        return { userId: 'member', organizationId: 'org', workspaceId: 'org-workspace' };
      },
    };
    if (request === '@/app/lib/capabilities/catalog') return { resolveEffectiveCapabilitySnapshot: async () => {
      snapshotCalls += 1;
      return { capabilities: assigned ? [{ ref: { resourceType: 'plugin', scopeType: 'organization', resourceId: 'org-resource', name: 'same-name' }, effectivePolicy: blocked ? 'blocked' : 'required', readiness: conflict ? 'conflict' : 'personal-connection-required' }] : [] };
    } };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-assets-'));
  try {
    const personalDir = path.join(root, 'personal');
    const orgDir = path.join(root, 'organization');
    await Promise.all([fs.mkdir(path.join(personalDir, 'assets'), { recursive: true }), fs.mkdir(path.join(orgDir, 'assets'), { recursive: true })]);
    await fs.writeFile(path.join(personalDir, 'assets', 'icon.svg'), '<svg>personal</svg>');
    await fs.writeFile(path.join(orgDir, 'assets', 'icon.svg'), '<svg>organization</svg>');
    await fs.writeFile(path.join(root, 'outside.svg'), '<svg>outside</svg>');
    await fs.symlink(path.join(root, 'outside.svg'), path.join(orgDir, 'assets', 'symlink.svg'));
    await fs.symlink(root, path.join(orgDir, 'escape'));
    personal = { name: 'same-name', scopeType: 'user', ownerUserId: 'member', resourceId: 'personal-resource', installDir: personalDir };
    organization = { name: 'same-name', scopeType: 'organization', organizationId: 'org', resourceId: 'org-resource', installDir: orgDir };
    const { GET } = await import('../app/api/plugins/asset/route');
    const request = (patch: Record<string, string | undefined> = {}, workspaceHeader = 'org-workspace') => {
      const params = new URLSearchParams({ plugin: 'same-name', path: './assets/icon.svg', scope: 'organization', resourceId: 'org-resource' });
      for (const [key, value] of Object.entries(patch)) { if (value === undefined) params.delete(key); else params.set(key, value); }
      return GET(new NextRequest(`https://canvas.example.test/api/plugins/asset?${params}`, { headers: { 'x-canvas-workspace-id': workspaceHeader } }));
    };
    const exactOrg = await request();
    assert.equal(exactOrg.status, 200);
    assert.equal(exactOrg.headers.get('content-type'), 'image/svg+xml');
    assert.equal(await exactOrg.text(), '<svg>organization</svg>', 'same-name personal icon cannot replace the assigned organization asset');
    const exactPersonal = await request({ scope: 'user', resourceId: 'personal-resource' });
    assert.equal(exactPersonal.status, 200);
    assert.equal(await exactPersonal.text(), '<svg>personal</svg>');
    assert.equal((await request({ scope: 'user', resourceId: 'org-resource' })).status, 404);
    const originalPersonal = personal;
    personal = { ...personal, ownerUserId: 'foreign-user' };
    assert.equal((await request({ scope: 'user', resourceId: 'personal-resource' })).status, 404, 'explicit foreign ownership is denied');
    personal = { ...originalPersonal, resourceId: undefined, scopeType: undefined, ownerUserId: undefined };
    const legacyId = createCapabilityResourceId({ resourceType: 'plugin', scopeType: 'user', ownerUserId: 'member', sourceType: 'standalone', name: 'same-name' });
    assert.equal((await request({ scope: 'user', resourceId: legacyId })).status, 200);
    assert.equal((await request({ scope: 'user', resourceId: undefined })).status, 200, 'legacy personal calls without IDs remain supported');
    assert.equal((await request({ scope: 'user', resourceId: 'forged-id' })).status, 404);
    const systemId = createCapabilityResourceId({ resourceType: 'plugin', scopeType: 'system', sourceType: 'standalone', name: 'same-name' });
    personal = { ...personal, scopeType: 'system', resourceId: systemId };
    assert.equal((await request({ scope: 'user', resourceId: systemId })).status, 200, 'legacy global system assets returned by the user lookup retain their existing read access');
    assert.equal((await request({ scope: 'user', resourceId: undefined })).status, 200);
    assert.equal((await request({ scope: 'user', resourceId: legacyId })).status, 404, 'system fallback does not accept a forged personal resource');
    personal = { ...personal, resourceId: undefined };
    assert.equal((await request({ scope: 'user', resourceId: systemId })).status, 200);
    personal = originalPersonal;
    for (const patch of [{ resourceId: 'foreign-resource' }, { resourceId: 'personal-resource' }, { resourceId: undefined }]) {
      const before = storageReads;
      assert.equal((await request(patch)).status, 403);
      assert.equal(storageReads, before, 'unassigned resource is denied before the file storage lookup');
    }
    assigned = false; assert.equal((await request()).status, 403); assigned = true;
    blocked = true; assert.equal((await request()).status, 403); blocked = false;
    conflict = true; assert.equal((await request()).status, 403); conflict = false;
    active = false; assert.equal((await request()).status, 403); active = true;
    assert.equal((await request({}, 'foreign-workspace')).status, 403);
    assert.equal((await request({ workspaceId: 'foreign-workspace' })).status, 403);
    const originalOrg = organization;
    organization = { ...organization, organizationId: 'foreign-org' };
    assert.equal((await request()).status, 404, 'the assigned identity also requires the matching recorded organization owner');
    organization = originalOrg;
    manager = true; assigned = false;
    const beforeManager = snapshotCalls;
    assert.equal((await request()).status, 200, 'authorized managers can read an unassigned exact organization installation');
    assert.equal(snapshotCalls, beforeManager);
    assert.equal((await request({ resourceId: 'foreign-resource' })).status, 404);
    assert.equal((await request({}, 'foreign-workspace')).status, 403);
    manager = false; assigned = true;
    for (const filePath of ['../outside.svg', 'assets/../../outside.svg', '/outside.svg', 'C:\\outside.svg', 'assets/\0icon.svg', 'assets/symlink.svg', 'escape/outside.svg']) {
      assert.equal((await request({ path: filePath })).status, 400, `unsafe asset path is denied: ${JSON.stringify(filePath)}`);
    }
    assert.equal((await request({ path: 'assets' })).status, 400);
    assert.equal((await request({ path: 'assets/config.json' })).status, 400);
    assert.equal((await request({ path: 'assets/missing.svg' })).status, 404);
    signedIn = false; assert.equal((await request()).status, 401);
    console.log('Plugin assets: exact personal/organization identity, legacy IDs, ownership, assignment/workspace policy and real path/symlink boundaries passed.');
  } finally {
    internals._load = originalLoad;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
