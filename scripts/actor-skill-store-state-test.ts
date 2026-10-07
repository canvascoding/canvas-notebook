import assert from 'node:assert/strict';
import Module from 'node:module';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { CanvasSkillStoreRegistry } from '../app/lib/skills/canvas-skill-store';
import { projectActorCanvasSkillStoreState } from '../app/lib/skills/actor-skill-store-state';

const registry: CanvasSkillStoreRegistry = { schemaVersion: 1, id: 'fixture', name: 'Fixture', updatedAt: '2026-10-07',
  registryUrl: 'file:///private/store/registry.json', homepage: 'https://user:private-token@store.example.test/info?token=private-token#secret',
  publisher: { name: 'Store', url: '/private/publisher' }, skills: [{ name: 'visible-skill', displayName: 'Visible skill', description: '', latestVersion: '3.0.0',
    icon: 'file:///private/icon.svg', iconUrl: 'file:///private/icon.svg', publisher: { name: 'Publisher', url: 'https://user:private-token@store.example.test/publisher?token=private-token' },
    versions: { '3.0.0': { version: '3.0.0', downloadUrl: 'https://user:private-token@store.example.test/skill.zip?token=private-token#secret', checksum: 'public-offering-digest' },
      '2.0.0': { version: '2.0.0', downloadUrl: '/private/packages/skill.zip', checksum: 'public-older-digest' } } },
    { name: 'hidden-skill', displayName: 'Hidden skill', description: '', latestVersion: '3.0.0', versions: {} }] };
function descriptor(ref: string, ownership: CapabilityResourceDescriptor['metadata']['ownership'], enabled: boolean): CapabilityResourceDescriptor {
  return { metadata: { resourceRef: ref, legacyResourceId: `${ref}:legacy`, resourceType: 'skill', sourceType: 'standalone', sourcePluginId: null,
    ownership, displayName: null, description: null, responsibleUserId: null, createdByUserId: null, updatedByUserId: null,
    metadataRevision: 1, grantsRevision: 1, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1 },
    access: { canRead: true, canUse: enabled, canEdit: false, canManage: false },
    artifact: { resourceType: 'skill', resourceId: `${ref}:legacy`, scopeType: ownership.type === 'user' ? 'user' : 'organization',
      name: 'visible-skill', version: ref === 'personal' ? '1.0.0' : '2.0.0', revision: 1, checksum: 'private-checksum', sourceType: 'standalone', sourcePluginId: null },
    grants: [], ownershipLabel: ownership.type,
    activation: { effectivePolicy: 'optional', enabled, readiness: 'unknown', blockedReason: null } };
}

async function main() {
  const personal = descriptor('personal', { type: 'user', ownerUserId: 'owner', organizationId: 'org-a' }, false);
  const team = descriptor('team', { type: 'team', organizationId: 'org-a', workspaceId: 'team-a' }, true);
  const denied = descriptor('denied', { type: 'organization', organizationId: 'org-a' }, true);
  denied.access.canRead = false; denied.artifact.name = 'hidden-skill';
  // Defensive DTO projection must not copy future accidental raw fields from a descriptor.
  Object.assign(team, { installDir: '/private/root', sourcePath: 'private-source', secret: 'private-token' });
  Object.assign(team.artifact, { skillPath: '/private/root/SKILL.md' });
  Object.assign(team.metadata, { sourceRegistryUrl: 'private-origin' });
  const projected = projectActorCanvasSkillStoreState(registry, [personal, team, denied], { scopeType: 'user', userId: 'reader' });
  const state = projected.skills[0].installed;
  assert.deepEqual(state.resources?.map(resource => resource.metadata.resourceRef), ['personal', 'team']);
  assert.equal(state.version, undefined); assert.equal(state.enabled, false);
  assert.equal(state.installedSkill, undefined); assert.equal(state.comparison, 'unknown');
  assert.equal(state.updateAvailable, false); assert.equal(state.modified, false); assert.equal(state.restoreAvailable, false);
  assert.equal(state.resources?.[1].activation?.enabled, true);
  assert.equal(state.resources?.[1].activation?.readiness, 'unknown');
  assert.equal(projected.skills[1].installed.installed, false);
  assert.equal(projected.registry.registryUrl, ''); assert.equal(projected.registry.homepage, 'https://store.example.test/info');
  assert.equal(projected.registry.publisher?.url, undefined); assert.equal(projected.skills[0].iconUrl, undefined);
  assert.equal(projected.skills[0].versions['3.0.0'].downloadUrl, 'https://store.example.test/skill.zip');
  assert.equal(projected.skills[0].versions['2.0.0'].downloadUrl, '');
  assert.equal(projected.skills[0].versions['3.0.0'].checksum, 'public-offering-digest');
  for (const forbidden of ['private-checksum', '/private/', 'private-source', 'private-token', 'private-origin', '"grants"', 'denied']) {
    assert(!JSON.stringify(projected).includes(forbidden), forbidden);
  }
  const organization = projectActorCanvasSkillStoreState(registry, [personal, team], { scopeType: 'organization', organizationId: 'org-a' });
  assert.deepEqual(organization.skills[0].installed.resources?.map(resource => resource.metadata.resourceRef), ['team']);
  assert.equal(organization.skills[0].installed.version, '2.0.0');
  assert.equal(organization.skills[0].installed.enabled, true);
  assert.equal(projectActorCanvasSkillStoreState(registry, [team], { scopeType: 'organization', organizationId: 'org-b' }).stats.installed, 0);

  // Route transport only: real ACL/store fixtures run independently. These seams
  // verify authenticated actor forwarding, mobile parity and static error DTOs.
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  let captured: Record<string, unknown> | undefined;
  let failure: Error | undefined;
  let active = true;
  loader._load = (name, parent, isMain) => {
    if (name === 'next/headers') return { headers: async () => new Headers() };
    if (name === '@/app/lib/auth') return { auth: { api: { getSession: async () => ({ user: { id: 'actor' } }) } } };
    if (name === '@/app/lib/organization/permissions') return { readOrganizationPermissionForUser: async () => ({ configured: true, organizationId: 'org-a', permission: { status: active ? 'active' : 'disabled' } }) };
    if (name === '@/app/lib/pi/session-workspace-context') return {};
    if (name === '@/app/lib/skills/canvas-skill-store') return { listCanvasSkillStore: async (options: Record<string, unknown>) => {
      captured = options; if (failure) throw failure; return { ...projected, comparison: 'unknown' };
    } };
    return original(name, parent, isMain);
  };
  try {
    const { NextRequest } = await import('next/server');
    const { WORKSPACE_ID_HEADER } = await import('../app/lib/workspaces/constants');
    const route = await import('../app/api/skills/store/route');
    const mobile = await import('../app/api/mobile/v1/extensions/skills/store/route');
    assert.equal(mobile.GET, route.GET);
    const request = () => new NextRequest('http://localhost/api/skills/store?scope=organization&workspaceId=ignored&state=updates', { headers: { [WORKSPACE_ID_HEADER]: ' team-a ' } });
    const response = await route.GET(request());
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(captured?.actor, { userId: 'actor', workspaceId: 'team-a' });
    assert.deepEqual(captured?.scope, { scopeType: 'organization', organizationId: 'org-a' });
    assert.equal((await response.json()).comparison, 'unknown');
    failure = Object.assign(new Error('private credential /private/root'), { code: 'WORKSPACE_PERMISSION_DENIED' });
    const deniedResponse = await mobile.GET(request()); assert.equal(deniedResponse.status, 403);
    assert(!(await deniedResponse.text()).includes('private'));
    failure = undefined; active = false; captured = undefined;
    assert.equal((await route.GET(request())).status, 403); assert.equal(captured, undefined);
    active = true; failure = new Error('private config and secret');
    const log = console.error; console.error = () => {};
    try { const unavailable = await route.GET(request()); assert.equal(unavailable.status, 500); assert(!(await unavailable.text()).includes('private')); }
    finally { console.error = log; }
  } finally { loader._load = original; }
  console.log('Actor skill-store projection and route transport test passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
