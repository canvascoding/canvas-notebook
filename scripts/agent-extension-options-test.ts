import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** Actual public options route + service + SQL/Store authority, separate from browser/model E2E. */
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  try {
    const { sql, alice, owner, organizationId } = fixture;
    const { NextRequest } = await import('next/server');
    const { listManagedAgentExtensionOptions } = await import('../app/lib/agents/extension-options');
    const { resolveAgentExtensionOptionsContext, revalidateAgentExtensionOptionsContext,
      listAgentExtensionSharedOptions } = await import('../app/lib/agents/extension-options-context');
    const { POST } = await import('../app/api/agents/extension-options/route');
    const { createManagedAgent } = await import('../app/lib/agents/management-actions');
    const { createSharedIntegrationConnection } = await import('../app/lib/integration-tools/connections/store');
    const { resolveOrganizationDataRoot } = await import('../app/lib/runtime-data-paths');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const actor = { ...alice, source: 'api' as const };
    const target = { kind: 'prospective' as const, scopeType: 'user' as const };
    const fixed = { version: 1 as const, origin: 'agent_configuration' as const, mode: 'fixed' as const,
      selections: [], workflow: null, standalone: [] };
    const rowsBefore = (await sql.all('SELECT id FROM agents')).length;
    const context = await resolveAgentExtensionOptionsContext(actor, target);
    assert.equal(Object.isFrozen(context), true); assert.equal(Object.isFrozen(context.actor), true);
    await assert.rejects(() => revalidateAgentExtensionOptionsContext({ ...context, allowPersonal: false }), { code: 'AGENT_ACCESS_DENIED' });
    await assert.rejects(() => resolveAgentExtensionOptionsContext(actor, { kind: 'prospective', scopeType: 'organization' }),
      { code: 'AGENT_ORGANIZATION_ADMIN_REQUIRED' });
    const organizationContext = await resolveAgentExtensionOptionsContext({ ...owner, source: 'api' }, { kind: 'prospective', scopeType: 'organization' });
    assert.equal(organizationContext.allowPersonal, false);
    assert.equal((await sql.all('SELECT id FROM agents')).length, rowsBefore, 'Discovery creates no prospective agents.');

    const name = `shared-options-${randomUUID().slice(0, 8)}`, version = '1.0.0';
    const files = { '.canvas-plugin/plugin.json': JSON.stringify({ name, version, skills: './skills', description: 'Find this options package',
      interface: { displayName: 'Exact extension options', logo: 'https://example.test/logo.svg?secret=never#fragment' } }),
      'skills/selected-step/SKILL.md': '---\nname: selected-step\ndescription: A selected actual child\n---\n\nRead actual source.\n' };
    const archive = await fixture.registry.addPackage('application', 'plugin', name, version, files, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version, checksum: archive.checksum }, ownership: { type: 'organization' }, grants: [
        { targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false },
        { targetType: 'user', targetId: owner.userId, canUse: true, canEdit: true, canManage: true },
      ] });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const packageResult = await listManagedAgentExtensionOptions(actor, { operation: 'package_version', target, ...pin });
    assert.equal(packageResult.operation, 'package_version');
    if (packageResult.operation !== 'package_version') throw new Error('Wrong operation');
    assert.deepEqual(packageResult.package.pin, pin);
    assert.deepEqual(packageResult.package.children.map(child => [child.name, child.relativeRoot, child.origin]),
      [['selected-step', 'skills/selected-step', 'plugin_child']]);
    assert.equal(packageResult.package.icon?.url, 'https://example.test/logo.svg');
    assert.doesNotMatch(JSON.stringify(packageResult), /rootPath|runtimePath|ownerUserId|storeOrigin|secret=never/u);
    const searchRequest = { operation: 'search', target, q: name, types: ['plugin', 'skill'], limit: 1 };
    const first = await listManagedAgentExtensionOptions(actor, searchRequest);
    assert.equal(first.operation, 'search');
    if (first.operation !== 'search') throw new Error('Wrong operation');
    assert.equal(first.items[0].eligibility.action, 'select');
    assert.deepEqual(first.items[0].publishedVersions?.[0].pin, pin);
    const childSearch = await listManagedAgentExtensionOptions(actor, { ...searchRequest, q: 'selected-step', limit: 20 });
    if (childSearch.operation !== 'search') throw new Error('Wrong operation');
    const child = childSearch.items.find(row => (row.item.kind === 'plugin' || row.item.kind === 'skill') && row.item.package?.parentResourceRef === pin.resourceRef);
    assert(child); assert.equal(child.eligibility.action, 'select');
    assert.deepEqual(child.selection, { kind: 'skill', origin: 'plugin_child', relativeRoot: 'skills/selected-step', package: pin });

    const created = await createManagedAgent({ ...owner, source: 'api' }, { name: `Options target ${randomUUID()}`,
      scopeType: 'organization', extensions: fixed,
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: false, canEdit: true, canManage: false }] });
    assert.equal(typeof created.agent.workflowRevision, 'number');
    const existingTarget = { kind: 'existing' as const, agentId: created.agent.agentId,
      expectedRevision: created.agent.revision, expectedWorkflowRevision: created.agent.workflowRevision! };
    const connectionId = randomUUID(), connection = await createSharedIntegrationConnection(owner, {
      ownership: { type: 'organization', organizationId }, displayName: 'Only the actual target may use this MCP', accessMode: 'restricted',
      backend: { source: 'mcp', connectionId }, allowedToolNames: ['allowed_action'], grants: [
        { targetType: 'agent', targetId: created.agent.agentId, canUse: true, canManage: false, allowedToolNames: ['allowed_action'] },
      ] });
    const configPath = path.join(resolveOrganizationDataRoot(organizationId), 'mcp', 'shared', connectionId, 'config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { 'exact-options-mcp': { connectionId, organizationId,
      displayName: 'Actual exact MCP', url: 'https://example.test/mcp', enabled: true } } }));
    assert.deepEqual(await listAgentExtensionSharedOptions(context, 'mcp'), []);
    const existing = await resolveAgentExtensionOptionsContext(actor, existingTarget);
    assert.equal(Object.isFrozen(existing.snapshot), true);
    const candidates = await listAgentExtensionSharedOptions(existing, 'mcp');
    assert.equal(candidates.length, 1); assert.equal(candidates[0].canUse, true); assert.equal(candidates[0].canManage, false);
    const mcpSearch = await listManagedAgentExtensionOptions(actor, { operation: 'search', target: existingTarget, q: 'Only the actual', types: ['mcp'] });
    if (mcpSearch.operation !== 'search') throw new Error('Wrong operation');
    assert.equal(mcpSearch.items.length, 1); assert.equal(mcpSearch.items[0].item.id, connection.resource.connectionRef);
    assert.equal(mcpSearch.items[0].eligibility.action, 'choose_connection');
    const choices = await listManagedAgentExtensionOptions(actor, { operation: 'connection_choices', target: existingTarget,
      selector: { kind: 'standalone', source: 'mcp' } });
    if (choices.operation !== 'connection_choices') throw new Error('Wrong operation');
    const exact = choices.connections.find(choice => choice.selection.target.kind === 'shared'
      && choice.selection.target.connectionRef === connection.resource.connectionRef);
    assert(exact); assert.equal(exact.eligibility.action, 'select'); assert.equal(exact.health, 'unknown');
    assert.doesNotMatch(JSON.stringify(choices), new RegExp(connectionId, 'u'), 'Private shared backend identity never reaches options.');
    await sql.run("UPDATE integration_connection_grants SET can_use=0 WHERE connection_ref=$1 AND target_type='agent'", [connection.resource.connectionRef]);
    assert.deepEqual(await listAgentExtensionSharedOptions(existing, 'mcp'), []);
    await sql.run('UPDATE agents SET revision=revision+1 WHERE agent_id=$1', [created.agent.agentId]);
    await assert.rejects(() => revalidateAgentExtensionOptionsContext(existing), { code: 'AGENT_WORKFLOW_REVISION_CONFLICT' });

    const request = (user: string | null, body: unknown, suffix = '') => new NextRequest(
      `http://localhost:3001/api/agents/extension-options?workspaceId=personal-alice${suffix}`,
      { method: 'POST', headers: user ? fixture.headers(user) : { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await POST(request('alice', { operation: 'package_version', target, ...pin }));
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control') ?? '', /no-store/u);
    assert.deepEqual((await response.json()).data.package.pin, pin);
    assert.equal((await POST(request(null, { operation: 'search', target }))).status, 401);
    assert.equal((await POST(request('bob', { operation: 'search', target }))).status, 403, 'Another actor cannot select Alice’s workspace.');
    assert.equal((await POST(request('alice', { operation: 'search', target, userId: 'owner' }))).status, 400);
    assert.equal((await POST(request('alice', { operation: 'search', target }, '&workspaceId=personal-alice'))).status, 400);
    const oversized = await POST(request('alice', { operation: 'search', target, q: 'x'.repeat(1_048_576) }));
    assert.equal(oversized.status, 413);
    await sql.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_id=$2', [pin.resourceRef, alice.userId]);
    const revoked = await POST(request('alice', { operation: 'package_version', target, ...pin }));
    assert([403, 404].includes(revoked.status), 'Revoked Use cannot return package metadata; an unreadable resource stays hidden.');
    assert.equal((await revoked.json()).success, false);
    assert.equal(fixture.providerRequests(), 0);
    console.log(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} complete extension options service/API: real prospective/existing target authority, immutable package and child search, target-only shared grants/Use without Manage/revoke, frozen issued context/revision conflicts, real authenticated bounded no-store route, no prospective rows or external account/provider IO.`);
  } finally { await fixture.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
