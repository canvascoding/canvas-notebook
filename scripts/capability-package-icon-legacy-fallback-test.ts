import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  try {
    const {listCapabilityResources} = await import('../app/lib/capabilities/resources/actions');
    const {readCapabilityPackageIconAction} = await import('../app/lib/capabilities/packages/presentation-actions');
    const {GET} = await import('../app/api/capabilities/packages/[resourceRef]/icon/route');
    const {resolveScopedSkillsDataDir} = await import('../app/lib/runtime-data-paths');
    const actor = fixture.actor('bob'), userRoot = resolveScopedSkillsDataDir(fixture.userScope('bob'));
    await assert.rejects(fs.stat(userRoot), {code: 'ENOENT'});
    const name = 'legacy-icon-default', legacyRoot = path.join(fixture.root, 'skills', name);
    await fs.mkdir(legacyRoot, {recursive: true});
    await fs.writeFile(path.join(legacyRoot, 'SKILL.md'), `---\nname: ${name}\ndescription: Public legacy default without icon\n---\nDefault metadata.\n`);
    const listed = await listCapabilityResources(actor);
    const resource = listed.find(value => value.artifact.name === name && value.artifact.sourceType === 'standalone');
    assert(resource?.access.canRead, 'The real legacy fallback remains listed for its current actor');
    await assert.rejects(readCapabilityPackageIconAction(actor, resource.metadata.resourceRef, {revision: String(resource.artifact.revision)}),
      {code: 'ENOENT'}, 'The optional route fallback never rebinds the canonical source or grants content read');
    const counts = async () => Promise.all(['capability_resources', 'capability_package_states', 'capability_package_versions', 'capability_resource_history']
      .map(async table => (await fixture.sql.get(`SELECT COUNT(*)::int AS count FROM ${table}`) as {count: number}).count));
    const before = await counts();
    const imageRequest = (resourceRef: string, user: string, query: string) => {
      const headers = fixture.headers(user);headers.delete('x-canvas-workspace-id');
      return GET(new Request(`http://localhost:3001/api/capabilities/packages/${encodeURIComponent(resourceRef)}/icon?${query}`, {headers}),
        {params: Promise.resolve({resourceRef})});
    };
    const query = new URLSearchParams({workspaceId: actor.workspaceId!, revision: String(resource.artifact.revision)});
    const response = await imageRequest(resource.metadata.resourceRef, 'bob', String(query));
    assert.equal(response.status, 204);assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');assert(response.headers.get('Content-Security-Policy')?.includes("sandbox; default-src 'none'"));
    assert.equal(response.headers.get('Location'), null);
    for (const [resourceRef, user, requestedQuery, status] of [
      [resource.metadata.resourceRef, 'alice', 'workspaceId=personal-alice', 404],
      [resource.metadata.resourceRef, 'bob', 'workspaceId=personal-owner', 403],
      [`canvas-resource:${randomUUID()}`, 'bob', 'workspaceId=personal-bob', 404],
      [resource.metadata.resourceRef, 'bob', 'workspaceId=personal-bob&path=SKILL.md', 400],
      [resource.metadata.resourceRef, 'bob', 'workspaceId=personal-bob&revision=-1', 400],
    ] as const) {
      const denied = await imageRequest(resourceRef, user, requestedQuery);assert.equal(denied.status, status);
      assert.equal(denied.headers.get('Location'), null);assert(!(await denied.text()).includes(fixture.root));
    }
    const core = listed.find(value => value.artifact.sourceType === 'core' && value.artifact.name === 'find-skills');assert(core);
    const coreResponse = await imageRequest(core.metadata.resourceRef, 'bob', `workspaceId=personal-bob&revision=${core.artifact.revision}`);
    assert.equal(coreResponse.status, 204);assert.equal((await coreResponse.arrayBuffer()).byteLength, 0, 'An actual undeclared core image remains the ordinary zero-byte fallback');
    assert.deepEqual(await counts(), before);await assert.rejects(fs.stat(userRoot), {code: 'ENOENT'});
    assert.equal(fixture.providerRequests(), 0);
    console.log('PASS actual legacy/default icon API: ENOENT zero-byte fallback, core204, actor/resource/schema denial, no root rebinding or DB/provider mutation.');
  } finally { await fixture.close(); }
}
main().catch(error => {console.error(error);process.exitCode = 1;});
