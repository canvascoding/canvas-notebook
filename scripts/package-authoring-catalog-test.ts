import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import type { CapabilityPackageAuthoringSource } from '../app/lib/capabilities/packages/authoring-catalog-contracts';
import type { CapabilityPackageDraft } from '../app/lib/capabilities/packages/contracts';

/** Actual authenticated package routes, immutable source bytes, catalogue authority and draft CAS. */
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  try {
    const { NextRequest } = await import('next/server');
    const sourceRoute = await import('../app/api/capabilities/packages/[resourceRef]/authoring-source/route');
    const requirements = await import('../app/api/capabilities/packages/drafts/[draftRef]/requirements/route');
    const { creatorPluginManifestTemplate } = await import('../app/lib/plugins/creator-plugin-manifest');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const { composeCapabilityPackageSkillsAction } = await import('../app/lib/capabilities/packages/composition');
    const { resolveOrganizationMcpTemplatesDir } = await import('../app/lib/runtime-data-paths');
    const { createSharedComposioProfile } = await import('../app/lib/composio/composio-shared-profiles');
    const { createSharedIntegrationConnection } = await import('../app/lib/integration-tools/connections/store');
    const request = (user: string | null, url: string, body?: unknown) => new NextRequest(`http://localhost:3001/api/capabilities/packages/${url}`, {
      method: body === undefined ? 'GET' : 'POST', headers: user ? fixture.headers(user) : new Headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const params = (key: string, ref: string) => ({ params: Promise.resolve({ [key]: ref }) });
    async function success<T>(response: Response): Promise<T> {
      assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get('cache-control'), 'no-store');
      const value = await response.json(); assert.equal(value.success, true); assert(!JSON.stringify(value).includes(fixture.root));
      return value.data as T;
    }
    async function denied(response: Response, status: number) {
      assert.equal(response.status, status, await response.clone().text()); const value = await response.json(); assert.equal(value.success, false);
    }
    const inspect = (user: string, ref: string, query = '') => sourceRoute.GET(request(user, `${encodeURIComponent(ref)}/authoring-source${query}`), params('resourceRef', ref));
    const add = (user: string, draft: CapabilityPackageDraft, body: Record<string, unknown>) => requirements.POST(request(user,
      `drafts/${encodeURIComponent(draft.draftRef)}/requirements`, { expectedDraftRevision: draft.draftRevision, ...body }), params('draftRef', draft.draftRef));
    const skill = (name: string, version = '1.0.0') => `---\nname: ${name}\ndescription: Exact reusable authoring source\nmetadata:\n  version: "${version}"\n---\nKeep source evidence visible.\n`;
    const ownership = { type: 'organization' as const, organizationId: fixture.organizationId };
    const grants = [{ targetType: 'user' as const, targetId: 'alice', canUse: false, canEdit: true, canManage: false }];
    const archive = await fixture.registry.addPackage('application', 'plugin', 'authoring-source-parent', '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name: 'authoring-source-parent', version: '1.0.0', description: 'Complete parent source', skills: './skills' }),
      'skills/source-one/SKILL.md': skill('source-one'), 'skills/source-one/references/evidence.md': 'Complete child evidence.',
      'skills/source-one/references/example/SKILL.md': skill('example'), 'skills/source-two/SKILL.md': skill('source-two', '2.0.0'),
      'shared/readme.md': 'Complete parent evidence.',
    }, plugins.computeCanvasPluginChecksum);
    const parent = await stores.installCapabilityPackageFromStoreAction(fixture.owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: 'authoring-source-parent', version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' }, grants });
    const standaloneArchive = await fixture.registry.addPackage('application', 'skill', 'authoring-standalone', '1.0.0', {
      'SKILL.md': skill('authoring-standalone'), 'references/complete.md': 'Whole standalone source.',
    }, plugins.computeCanvasPluginChecksum);
    const standalone = await stores.installCapabilityPackageFromStoreAction(fixture.owner, { source: { kind: 'skill', registryId: 'store-application',
      entryKey: 'authoring-standalone', version: '1.0.0', checksum: standaloneArchive.checksum }, ownership: { type: 'organization' }, grants });
    const aliceAccess = await resources.inspectCapabilityResource(fixture.alice, parent.resource.resourceRef);
    assert.equal(aliceAccess.access.canRead, true); assert.equal(aliceAccess.access.canUse, false);
    const parentSource = await success<CapabilityPackageAuthoringSource>(await inspect('alice', parent.resource.resourceRef));
    assert.equal(parentSource.source.resourceRef, parent.resource.resourceRef); assert.equal(parentSource.source.revisionRef, parent.published.revisionRef);
    assert.match(parentSource.source.expectedChecksum, /^[a-f0-9]{64}$/u);
    assert.deepEqual(parentSource.skills.map(value => [value.name, value.version, value.source.childRelativeRoot]),
      [['source-one', '1.0.0', 'skills/source-one'], ['source-two', '2.0.0', 'skills/source-two']]);
    assert(parentSource.skills.every(value => value.source.resourceRef === parent.resource.resourceRef && value.source.expectedChecksum === parentSource.source.expectedChecksum));
    const actualChild = (await resources.listCapabilityResources(fixture.alice)).find(value => value.artifact.sourcePluginId === aliceAccess.artifact.resourceId && value.artifact.name === 'source-one');
    assert(actualChild);
    const childSource = await success<CapabilityPackageAuthoringSource>(await inspect('alice', actualChild.metadata.resourceRef));
    assert.equal(childSource.source.resourceRef, parent.resource.resourceRef); assert.deepEqual(childSource.skills, [parentSource.skills[0]]);
    const standaloneSource = await success<CapabilityPackageAuthoringSource>(await inspect('alice', standalone.resource.resourceRef));
    assert.equal(standaloneSource.source.revisionRef, standalone.published.revisionRef); assert.equal(standaloneSource.skills[0]?.source.childRelativeRoot, undefined);
    assert.equal(standaloneSource.skills[0]?.name, 'authoring-standalone');
    await denied(await inspect('bob', parent.resource.resourceRef), 404);
    await denied(await inspect('owner', parent.resource.resourceRef, `?revisionRef=canvas-package-revision:${randomUUID()}`), 404);
    await denied(await sourceRoute.GET(request(null, `${encodeURIComponent(parent.resource.resourceRef)}/authoring-source`), params('resourceRef', parent.resource.resourceRef)), 401);
    const count = async (table: string) => Number((await fixture.sql.get(`SELECT COUNT(*)::integer AS count FROM ${table}`) as { count: number }).count);
    const before = await Promise.all(['capability_resources', 'capability_package_versions', 'capability_package_states', 'pi_sessions', 'pi_messages'].map(count));
    const create = (kind: 'skill' | 'plugin', targetName: string) => packages.createCapabilityPackageDraftAction(fixture.owner,
      { operation: 'create', kind, targetName, requestId: randomUUID() });
    const write = async (draft: CapabilityPackageDraft, file: string, text: string) => (await packages.writeCapabilityPackageDraftFileAction(fixture.owner, draft.draftRef,
      { expectedDraftRevision: draft.draftRevision, path: file, encoding: 'base64', content: Buffer.from(text).toString('base64') })).draft;
    let draft = await create('plugin', 'authoring-target');
    const definitionId = randomUUID(), definitionFile = path.join(resolveOrganizationMcpTemplatesDir(fixture.organizationId), 'approved-servers.json');
    await fs.mkdir(path.dirname(definitionFile), { recursive: true });
    const definition = { version: 1, id: definitionId, organizationId: fixture.organizationId, name: 'PRIVATE definition label', enabled: true, revision: 1,
      config: { url: 'https://example.test/private-mcp', transport: 'http' }, updatedAt: new Date().toISOString() };
    await fs.writeFile(definitionFile, JSON.stringify({ version: 1, definitions: [definition] }));
    const mcpBody = { catalogId: `mcp-definition:${definitionId}`, connectorName: 'research', required: true };
    await denied(await add('owner', draft, mcpBody), 400);
    draft = await write(draft, '.canvas-plugin/plugin.json', JSON.stringify({ ...structuredClone(creatorPluginManifestTemplate), name: draft.name }));
    draft = await write(draft, 'skills/base-step/SKILL.md', skill('base-step'));
    const composed = await composeCapabilityPackageSkillsAction(fixture.owner, draft.draftRef, { expectedDraftRevision: draft.draftRevision,
      skills: [{ source: parentSource.skills[0].source }, { source: standaloneSource.skills[0].source }] });
    draft = composed.draft;
    const evidence = await packages.readCapabilityPackageDraftFileAction(fixture.owner, draft.draftRef, { path: 'skills/source-one/references/evidence.md' });
    assert.equal(Buffer.from(evidence.file.content, 'base64').toString(), 'Complete child evidence.');
    const added = await success<{draft: CapabilityPackageDraft; changed: boolean}>(await add('owner', draft, mcpBody));
    assert.equal(added.changed, true); draft = added.draft;
    const repeated = await success<{draft: CapabilityPackageDraft; changed: boolean}>(await add('owner', draft, mcpBody));
    assert.equal(repeated.changed, false); assert.equal(repeated.draft.draftRevision, draft.draftRevision);
    await denied(await add('owner', draft, { ...mcpBody, required: false }), 409);
    await denied(await add('owner', draft, { ...mcpBody, expectedDraftRevision: draft.draftRevision - 1 }), 409);
    await denied(await add('owner', draft, { catalogId: `mcp-definition:${definitionId}`, required: true }), 400);
    await denied(await add('owner', draft, { ...mcpBody, connectionId: definitionId }), 400);
    await denied(await add('owner', draft, { catalogId: parent.resource.resourceRef, required: true }), 404);
    await denied(await add('alice', draft, mcpBody), 404);
    const standaloneDraft = await create('skill', 'requirement-standalone');
    await denied(await add('owner', standaloneDraft, mcpBody), 400);
    const profile = await createSharedComposioProfile({ actor: fixture.owner, ownership, name: 'PRIVATE profile label', providerMode: 'local' });
    const shared = await createSharedIntegrationConnection(fixture.owner, { ownership, displayName: 'PRIVATE connection label', accessMode: 'restricted',
      backend: { source: 'composio', profileId: profile.id, toolkit: 'hubspot', mode: 'local', accountBinding: 'pending', connectedAccountId: null } });
    const composioBody = { catalogId: 'composio:hubspot', required: true };
    const integration = await success<{draft: CapabilityPackageDraft; changed: boolean}>(await add('owner', draft, composioBody));
    assert.equal(integration.changed, true); draft = integration.draft;
    const readManifest = async () => JSON.parse(Buffer.from((await packages.readCapabilityPackageDraftFileAction(fixture.owner, draft.draftRef,
      { path: '.canvas-plugin/plugin.json' })).file.content, 'base64').toString('utf8')) as Record<string, unknown> & { connectors: {mcp: Record<string, unknown>[]; composio: Record<string, unknown>[]} };
    let manifest = await readManifest();
    assert.deepEqual(manifest.connectors.mcp, [{ name: 'research', required: true }]); assert.deepEqual(manifest.connectors.composio, [{ toolkit: 'hubspot', required: true }]);
    const serialized = JSON.stringify(manifest);
    for (const secret of [definitionId, profile.id, profile.composioUserId, shared.resource.connectionRef, 'PRIVATE', 'private-mcp']) assert(!serialized.includes(secret));
    Object.assign(manifest.connectors.mcp[0], { label: 'Preserve existing research', env: ['RESEARCH_KEY'] });
    Object.assign(manifest.connectors.composio[0], { label: 'Preserve HubSpot', tools: ['READ_COMPANY'] });
    draft = await write(draft, '.canvas-plugin/plugin.json', JSON.stringify(manifest));
    for (const body of [mcpBody, composioBody]) {
      const kept = await success<{draft: CapabilityPackageDraft; changed: boolean}>(await add('owner', draft, body));
      assert.equal(kept.changed, false); assert.equal(kept.draft.draftRevision, draft.draftRevision);
    }
    assert.deepEqual(await readManifest(), manifest, 'Idempotence preserves labels, env and tools without rewriting the manifest.');
    await denied(await add('owner', draft, { ...composioBody, required: false }), 409);
    await denied(await add('owner', draft, { ...composioBody, connectorName: 'guessed' }), 400);
    // PGlite exposes one shared SQL transport; only native independent leases prove parallel transactions.
    const results = fixture.native
      ? await Promise.all([add('owner', draft, { ...mcpBody, connectorName: 'concurrent-a' }), add('owner', draft, { ...mcpBody, connectorName: 'concurrent-b' })])
      : [await add('owner', draft, { ...mcpBody, connectorName: 'concurrent-a' }), await add('owner', draft, { ...mcpBody, connectorName: 'concurrent-b' })];
    assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
    const winner = results.find(response => response.status === 200)!;
    draft = (await success<{draft: CapabilityPackageDraft}>(winner)).draft;
    manifest = await readManifest(); assert.equal(manifest.connectors.mcp.length, 2);
    await fs.writeFile(definitionFile, JSON.stringify({ version: 1, definitions: [{ ...definition, enabled: false }] }));
    await denied(await add('owner', draft, { ...mcpBody, connectorName: 'no-longer-readable' }), 404);
    await fixture.sql.run("UPDATE capability_resource_grants SET can_edit=0 WHERE resource_ref=$1 AND target_type='user' AND target_id='alice'", [parent.resource.resourceRef]);
    await denied(await inspect('alice', parent.resource.resourceRef), 404);
    assert.deepEqual(await Promise.all(['capability_resources', 'capability_package_versions', 'capability_package_states', 'pi_sessions', 'pi_messages'].map(count)), before);
    assert.equal(fixture.providerRequests(), 0);
    console.info(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} authoring catalogue: real Read without Use, exact standalone/parent/child sources and actual composition, canonical portable MCP/Composio declarations, rich idempotence, conflicts and ${fixture.native ? 'concurrent' : 'stale'} CAS, current catalogue/revoked access, no credentials or publication.`);
  } finally { await fixture.close(); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
