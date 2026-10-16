import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** Real SQL, common catalogue, immutable copy sources and the registered Planning gateway; no provider calls. */
async function main() {
  const previousKey = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  try {
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const sources = await import('../app/lib/capabilities/packages/authoring-catalog');
    const agents = await import('../app/lib/agents/registry');
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const storage = await import('../app/lib/agents/storage');
    await storage.writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG, runtimeMigrations: { skillToolsDefaultEnabled: true } });
    const name = 'authoring-discovery-source';
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Authoring discovery source', skills: './skills' }),
      'skills/authoring-copy/SKILL.md': '---\nname: authoring-copy\ndescription: Authoring discovery child\nmetadata:\n  version: "2.0.0"\n---\nKeep this exact complete source.\n',
      'skills/authoring-copy/references/source.md': 'AUTHORING_COMPLETE_COPY_EVIDENCE',
    }, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(fixture.owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: 'alice', canUse: false, canEdit: true, canManage: false }] });
    const readable = await resources.inspectCapabilityResource(fixture.alice, installed.resource.resourceRef);
    assert.equal(readable.access.canRead, true); assert.equal(readable.access.canUse, false);
    const { resolveOrganizationMcpTemplatesDir } = await import('../app/lib/runtime-data-paths');
    const definitionId = randomUUID(), definitionFile = path.join(resolveOrganizationMcpTemplatesDir(fixture.organizationId), 'approved-servers.json');
    await fs.mkdir(path.dirname(definitionFile), { recursive: true });
    await fs.writeFile(definitionFile, JSON.stringify({ version: 1, definitions: [{ version: 1, id: definitionId, organizationId: fixture.organizationId,
      name: 'Authoring discovery MCP', enabled: true, revision: 1, config: { url: 'https://example.test/private-authoring-mcp', transport: 'http' }, updatedAt: new Date().toISOString() }] }));
    const { createSharedComposioProfile } = await import('../app/lib/composio/composio-shared-profiles');
    const { createSharedIntegrationConnection, authorizeIntegrationConnection } = await import('../app/lib/integration-tools/connections/store');
    const ownership = { type: 'organization' as const, organizationId: fixture.organizationId };
    const profile = await createSharedComposioProfile({ actor: fixture.owner, ownership, name: 'PRIVATE authoring profile', providerMode: 'local' });
    const connection = await createSharedIntegrationConnection(fixture.owner, { ownership, displayName: 'PRIVATE authoring connection', accessMode: 'restricted',
      backend: { source: 'composio', profileId: profile.id, toolkit: 'hubspot', mode: 'local', accountBinding: 'pending', connectedAccountId: null },
      grants: [{ targetType: 'user', targetId: 'alice', canUse: false, canManage: true, allowedToolNames: null }] });
    assert.equal((await authorizeIntegrationConnection(fixture.alice, connection.resource.connectionRef, 'inspect')).access.canUse, false);
    const agent = await agents.createAgentProfile({ agentId: 'authoring-metadata-reader', name: 'Authoring metadata reader', scopeType: 'user', ownerUserId: 'alice',
      organizationId: fixture.organizationId, createdByUserId: 'alice', enabledTools: ['read', 'search_canvas_extensions'], relevantSkills: [], relevantConnections: [], accessPolicy: 'restricted' });
    await fixture.sql.run(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,session_kind,organization_id,workspace_id,workspace_type,workspace_name,created_at,updated_at)
      VALUES('authoring-discovery-session','alice',$1,'fixture','offline','conversation',$2,'personal-alice','personal','Alice',1,1)`, [agent.agentId, fixture.organizationId]);
    const { resolveAgentExecutionContextForSession } = await import('../app/lib/pi/session-workspace-context');
    const context = await resolveAgentExecutionContextForSession({ userId: 'alice', agentId: agent.agentId, sessionId: 'authoring-discovery-session' });
    const { getPiTools } = await import('../app/lib/pi/tool-registry');
    const { filterToolsForPlanningMode } = await import('../app/lib/pi/planning-mode');
    const { buildEffectiveToolManifest } = await import('../app/lib/pi/effective-tool-manifest');
    const { isProgressiveGatewayTool } = await import('../app/lib/pi/progressive-tool-gateway');
    const tools = filterToolsForPlanningMode(await getPiTools('alice', agent.agentId, context.sessionId, { executionContext: context, planningMode: true }));
    const manifest = buildEffectiveToolManifest(tools);
    assert(!manifest.registeredToolNames.some(value => /^(?:integrations|mcp|composio|COMPOSIO_)/u.test(value)));
    const gateway = tools.find(tool => tool.name === 'canvas_extensions'); assert(gateway && isProgressiveGatewayTool(gateway));
    assert.deepEqual(gateway.progressiveGateway.operations.map(value => value.name), ['search_canvas_extensions']);
    const invoke = async (arguments_: Record<string, unknown>) => {
      const result = await gateway.execute('authoring-discovery', { action: 'call', operation: 'search_canvas_extensions', arguments: arguments_ });
      const details = result.details as { extensionDiscovery?: Awaited<ReturnType<typeof import('../app/lib/capabilities/extensions/runtime-discovery').searchAuthoringExtensions>> };
      assert(details.extensionDiscovery, JSON.stringify(result)); return details.extensionDiscovery;
    };
    const found = await invoke({ purpose: 'authoring', query: 'authoring', types: ['plugin', 'skill', 'mcp'], limit: 20 });
    assert.equal(found.purpose, 'authoring');
    assert(found.items.some(item => item.kind === 'plugin' && item.package?.resourceRef === installed.resource.resourceRef));
    const child = found.items.find(item => item.kind === 'skill' && item.name === 'authoring-copy'); assert(child?.package);
    assert.equal(child.package.parentResourceRef, installed.resource.resourceRef);
    assert(found.items.some(item => item.kind === 'mcp' && item.mcp?.definitionId === definitionId));
    const exact = await sources.inspectCapabilityPackageAuthoringSourceAction(fixture.alice, child.package.resourceRef);
    assert.equal(exact.source.resourceRef, installed.resource.resourceRef); assert.equal(exact.source.revisionRef, installed.published.revisionRef);
    assert.equal(exact.skills[0]?.source.childRelativeRoot, 'skills/authoring-copy'); assert.equal(exact.skills[0]?.version, '2.0.0');
    const app = await invoke({ purpose: 'authoring', query: 'hubspot', types: ['integration'] });
    assert.equal(app.items[0]?.toolkit?.slug, 'hubspot', 'Readable pending app metadata needs neither account authorization nor provider Use.');
    const publicText = JSON.stringify({ found, app });
    for (const privateValue of [fixture.root, profile.id, profile.composioUserId, connection.resource.connectionRef, 'PRIVATE', 'private-authoring-mcp']) assert(!publicText.includes(privateValue));
    assert.doesNotMatch(publicText, /"(?:skillPath|runtimePath|connections|profileId|accountId|providerRef|schemaRef|toolRef|selectionFingerprint|coreSource)"/u);
    let sharedGrantReads = 0, sharedRevoked = false;
    fixture.setAfterRead(async (query, params) => {
      if (query.startsWith('SELECT * FROM integration_connection_grants') && params[0] === connection.resource.connectionRef) {
        sharedGrantReads += 1;
        // First list, then exact inspect: revoke after the actual inspect read returned its old snapshot.
        if (sharedGrantReads === 2) {
          await fixture.sql.run("UPDATE integration_connection_grants SET can_manage=0 WHERE connection_ref=$1 AND target_type='user' AND target_id='alice'", [connection.resource.connectionRef]);
          sharedRevoked = true;
        }
      }
    });
    const revokedKnownApp = await invoke({ purpose: 'authoring', query: 'hubspot', types: ['integration'] });
    fixture.setAfterRead(undefined);
    assert(sharedRevoked, 'The known-only revoke must run after an actual source inspect read.');
    assert.deepEqual(revokedKnownApp.items, [], 'A known-only toolkit cannot survive a removed source Read grant during metadata IO.');
    await fixture.sql.run("UPDATE integration_connection_grants SET can_manage=1 WHERE connection_ref=$1 AND target_type='user' AND target_id='alice'", [connection.resource.connectionRef]);
    const beforeManifest = JSON.stringify(manifest);
    const page = await invoke({ purpose: 'authoring', query: 'authoring', types: ['plugin', 'skill'], limit: 1 }); assert(page.pagination.nextCursor);
    await assert.rejects(() => import('../app/lib/capabilities/extensions/runtime-discovery').then(api => api.searchAuthoringExtensions(context,
      { purpose: 'authoring', query: 'different', types: ['plugin', 'skill'], limit: 1, cursor: page.pagination.nextCursor })));
    const direct = await import('../app/lib/capabilities/extensions/runtime-discovery');
    const ordinary = await direct.searchRuntimeExtensions(context, { query: 'authoring', types: ['plugin', 'skill'], limit: 20 });
    assert(!ordinary.items.some(item => item.id === child.id), 'Authoring Read cannot broaden the current fixed runtime package selection.');
    assert.deepEqual(await direct.searchCanvasExtensions(context, { query: 'authoring', types: ['plugin', 'skill'], limit: 20 }), ordinary);
    assert.deepEqual(await direct.searchCanvasExtensions(context, { purpose: 'runtime', query: 'authoring', types: ['plugin', 'skill'], limit: 20 }), ordinary);
    const { createExtensionDiscoveryTool } = await import('../app/lib/pi/extension-discovery-tool');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const actualTool = createExtensionDiscoveryTool('alice', agent.agentId, context.sessionId);
    await assert.rejects(() => actualTool.execute('missing-context', { purpose: 'authoring', query: 'authoring' }), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    await assert.rejects(() => runWithAgentExecutionContext({ ...context, userId: 'bob' }, () => actualTool.execute('wrong-actor', { purpose: 'authoring', query: 'authoring' })), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    for (const invalid of [{ query: 'hubspot', types: ['integration'] }, { purpose: 'authoring', query: 'hubspot', accountId: 'forged' },
      { purpose: 'authoring', query: 'hubspot', types: ['integration', 'integration'] }, { purpose: 'authoring', query: 'hubspot', cursor: '../outside' }]) {
      await assert.rejects(() => runWithAgentExecutionContext(context, () => actualTool.execute('invalid-authoring', invalid)));
    }
    assert.equal(JSON.stringify(buildEffectiveToolManifest(tools)), beforeManifest, 'Metadata browsing grants no provider operations or registry entries.');
    let changed = false;
    fixture.setBeforeFetch(async () => {
      if (!changed) { changed = true; await fixture.sql.run('UPDATE agents SET revision=revision+1 WHERE agent_id=$1', [agent.agentId]); }
    });
    await assert.rejects(() => direct.searchAuthoringExtensions(context, { purpose: 'authoring', query: 'authoring', types: ['plugin'] }), { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    assert(changed, 'The source-change negative must cross actual catalogue IO.'); fixture.setBeforeFetch(undefined);
    await fixture.sql.run("UPDATE organization_user_permissions SET status='revoked' WHERE user_id='alice'");
    await assert.rejects(() => direct.searchAuthoringExtensions(context, { purpose: 'authoring', query: 'hubspot', types: ['integration'] }));
    assert.equal(fixture.providerRequests(), 0, 'No account, OAuth, status, tool-schema or business-provider request is permitted.');
    console.info(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} authoring discovery: actual registered Planning gateway, current source Read without Use, exact parent/child composition identities, readable pending Composio/MCP metadata, strict purpose/actor/cursor validation, unchanged runtime pins/tool ceiling and in-flight/revoked-context refusal; no provider probes.`);
  } finally {
    await fixture.close();
    if (previousKey === undefined) delete process.env.COMPOSIO_API_KEY; else process.env.COMPOSIO_API_KEY = previousKey;
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
