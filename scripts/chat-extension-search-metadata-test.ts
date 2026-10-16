import assert from 'node:assert/strict';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';
import { deriveChatBodySelection, parseChatBody } from '../app/lib/chat/chat-body-contracts';
import type { ExtensionSelection } from '../app/lib/capabilities/extensions/contracts';

/** Real package bytes, SQL ACLs and Agent contexts. No provider, model or Runtime is invoked. */
async function main() {
  const fixture = await createDurableMessageExecutionFixture(), app = fixture.application;
  try {
    const management = await import('../app/lib/agents/management-actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const activation = await import('../app/lib/capabilities/packages/activation');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const contexts = await import('../app/lib/chat/extension-options-context');
    const eligibility = await import('../app/lib/chat/extension-options-eligibility');
    const { listChatExtensionOptions } = await import('../app/lib/chat/extension-options');
    const { setPersonalCapabilityActivation } = await import('../app/lib/capabilities/activation-actions');
    const owner = app.owner, alice = app.alice;
    const general = await management.createManagedAgent({ ...alice, source: 'api' }, { name: 'Metadata search reader', scopeType: 'user', enabledTools: ['read'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' } });
    const target = { kind: 'draft_turn' as const, agentId: general.agent.agentId, workspaceId: app.alice.workspaceId! };
    const name = 'search-metadata-parent';
    const archive = await app.registry.addPackage('application', 'plugin', name, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Actual metadata source', skills: './skills' }),
      'skills/first/SKILL.md': '---\nname: first\ndescription: First exact child\n---\nRead the exact first child.\n',
      'skills/second/SKILL.md': '---\nname: second\ndescription: Second exact child\n---\nRead the exact second child.\n',
    }, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
      grants: [owner, alice].map(actor => ({ targetType: 'user', targetId: actor.userId, canUse: true, canEdit: false, canManage: false })) });
    const inspected = await packages.inspectCapabilityPackage(owner, installed.resource.resourceRef);
    await activation.setCapabilityPackageDefaultActivationAction(owner, installed.resource.resourceRef, { expectedMetadataRevision: inspected.resource.metadataRevision,
      expectedGrantsRevision: inspected.resource.grantsRevision, expectedPackageRevision: inspected.state!.packageRevision,
      expectedPublishedRevisionRef: installed.published.revisionRef, expectedDefaultEnabled: false, enabled: true });
    await setPersonalCapabilityActivation({ context: { userId: alice.userId, organizationId: app.organizationId,
      workspaceId: alice.workspaceId, role: 'member' }, actorUserId: alice.userId, resourceId: inspected.sourceStamp.resourceId, enabled: true });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const context = await contexts.resolveChatExtensionOptionsContext(alice, target);
    const actualResources = new Map((await resources.listCapabilityResources(alice)).map(resource => [resource.metadata.resourceRef, resource]));
    const found = await listChatExtensionOptions(alice, { operation: 'search', phase: 'local', target, q: name, types: ['plugin', 'skill'] });
    assert.equal(found.operation, 'search'); if (found.operation !== 'search') throw new Error('Expected search');
    const parent = found.items.find(row => row.item.name === name)!;
    assert.equal(parent.selection?.kind, 'plugin');
    let sourceReads = 0;
    const metadataOnly = { resources: actualResources, packageVersion: async () => { sourceReads++; throw new Error('Search projection must not reread a vetted package.'); } };
    const projected = await eligibility.projectChatExtensionSearchItem(context, parent, metadataOnly);
    assert.deepEqual(projected.selection, { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } });
    const children = await listChatExtensionOptions(alice, { operation: 'search', phase: 'local', target, q: 'first', types: ['skill'] });
    assert.equal(children.operation, 'search'); if (children.operation !== 'search') throw new Error('Expected children');
    const child = children.items.find(row => row.item.name === 'first')!;
    assert.equal(child.selection?.kind, 'skill');
    const childProjected = await eligibility.projectChatExtensionSearchItem(context, child, metadataOnly);
    assert.deepEqual(childProjected.selection, { kind: 'skill', origin: 'plugin_child', relativeRoot: 'skills/first', package: pin });
    const skillName = 'search-metadata-standalone';
    const skillArchive = await app.registry.addPackage('application', 'skill', skillName, '1.0.0', {
      'SKILL.md': `---\nname: ${skillName}\ndescription: Actual standalone source\nmetadata:\n  version: "1.0.0"\n---\nRead the standalone source.\n`,
    }, plugins.computeCanvasPluginChecksum);
    const skillInstalled = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'skill', registryId: 'store-application',
      entryKey: skillName, version: '1.0.0', checksum: skillArchive.checksum }, ownership: { type: 'organization' },
      grants: [owner, alice].map(actor => ({ targetType: 'user', targetId: actor.userId, canUse: true, canEdit: false, canManage: false })) });
    const skillInspect = await packages.inspectCapabilityPackage(owner, skillInstalled.resource.resourceRef);
    await activation.setCapabilityPackageDefaultActivationAction(owner, skillInstalled.resource.resourceRef, { expectedMetadataRevision: skillInspect.resource.metadataRevision,
      expectedGrantsRevision: skillInspect.resource.grantsRevision, expectedPackageRevision: skillInspect.state!.packageRevision,
      expectedPublishedRevisionRef: skillInstalled.published.revisionRef, expectedDefaultEnabled: false, enabled: true });
    await setPersonalCapabilityActivation({ context: { userId: alice.userId, organizationId: app.organizationId,
      workspaceId: alice.workspaceId, role: 'member' }, actorUserId: alice.userId, resourceId: skillInspect.sourceStamp.resourceId, enabled: true });
    const standalone = await listChatExtensionOptions(alice, { operation: 'search', phase: 'local', target, q: skillName, types: ['skill'] });
    assert.equal(standalone.operation, 'search'); if (standalone.operation !== 'search') throw new Error('Expected standalone search');
    for (const resource of await resources.listCapabilityResources(alice)) actualResources.set(resource.metadata.resourceRef, resource);
    const skillProjected = await eligibility.projectChatExtensionSearchItem(context, standalone.items.find(row => row.item.name === skillName)!, metadataOnly);
    assert.deepEqual(skillProjected.selection, { kind: 'skill', origin: 'standalone', relativeRoot: '', package: {
      resourceRef: skillInstalled.resource.resourceRef, publishedRevisionRef: skillInstalled.published.revisionRef, checksum: skillInstalled.published.checksum } });
    assert.equal(sourceReads, 0);
    const preview = async (selection: ExtensionSelection) => {
      const id = 'selected-source', body = parseChatBody({ version: 1, parts: [{ type: 'extension_reference', occurrenceId: 'source-occurrence', bundleId: id }],
        bundles: [{ id, caption: 'Actual source', primary: { selection, requirement: 'required', toolCap: null }, supporting: [], packageConnections: [] }] });
      const result = await listChatExtensionOptions(alice, { operation: 'preview', target, body, intakeSelection: deriveChatBodySelection(body) });
      assert.equal(result.operation, 'preview'); if (result.operation !== 'preview') throw new Error('Expected preview');
      return result.preview;
    };
    assert.equal((await preview(childProjected.selection!)).issues.length, 0);
    assert.equal((await preview(skillProjected.selection!)).issues.length, 0);
    assert(skillProjected.selection?.kind === 'skill');
    assert.equal((await preview({ kind: 'plugin', package: skillProjected.selection.package, skillSelection: { kind: 'all' } })).configurationReadiness, 'blocked');
    assert.equal((await preview({ kind: 'skill', origin: 'plugin_child', relativeRoot: 'skills/absent', package: pin })).configurationReadiness, 'blocked');
    assert.equal((await preview({ kind: 'skill', origin: 'standalone', relativeRoot: '', package: pin })).configurationReadiness, 'blocked');
    assert.equal((await preview({ kind: 'plugin', package: { ...pin, checksum: 'f'.repeat(64) }, skillSelection: { kind: 'all' } })).configurationReadiness, 'blocked');
    const database = await app.database.openDb();
    try { await database.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_id=$2', [pin.resourceRef, alice.userId]); }
    finally { await database.close(); }
    assert.equal((await preview(childProjected.selection!)).configurationReadiness, 'blocked', 'A formerly valid metadata selection cannot retain revoked source authority.');
    const revoked = await listChatExtensionOptions(alice, { operation: 'search', phase: 'local', target, q: name, types: ['plugin', 'skill'] });
    assert.equal(revoked.operation, 'search'); if (revoked.operation !== 'search') throw new Error('Expected revoked search');
    assert(!revoked.items.some(row => row.selection && row.eligibility.action === 'select'));
    assert.equal(app.providerRequests(), 0);
    const cancelled = new AbortController(); cancelled.abort(new Error('Explicit metadata cancellation'));
    await assert.rejects(listChatExtensionOptions(alice, { operation: 'search', phase: 'local', target, q: name }, { signal: cancelled.signal }), /Explicit metadata cancellation/u);
    console.log('PASS actual local Chat search: exact parent/child/standalone metadata projection without extra source reads; fresh Preview rejects bad kind, child, origin, checksum and revoked Use; cancellation retained; no provider, message or Runtime authority.');
  } finally { await fixture.close(); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
