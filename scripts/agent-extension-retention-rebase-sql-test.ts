import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import { rebaseAgentExtensionRetentions } from '../app/components/agents/agent-extension-retention-rebase';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';

// Real SQL actor/source/agent grants, published Store bytes, private retention
// issuance and public writers. Fixture license/model transport is controlled;
// no auth/source/retention authority is mocked and no provider is called.
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  try {
    const { owner, alice, organizationId } = fixture, actor = { ...owner, source: 'api' as const };
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const source = async (displayName: string) => createSharedMcpConnection({ ...owner, organizationId }, {
      ownership: { type: 'organization', organizationId }, displayName, accessMode: 'restricted', allowedToolNames: ['READ', 'WRITE'],
      grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canManage: true, allowedToolNames: ['READ', 'WRITE'] }],
      config: { url: 'https://retention.fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true },
    });
    const packageSource = await source('Package retention'), standaloneSource = await source('Standalone retention');
    const pluginRegistry = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const name = `retention-${randomUUID().slice(0, 8)}`;
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Retention source', skills: './skills',
        connectors: { mcp: [{ name: 'lookup', required: false, configPath: 'mcp.json' }] }, workflow: { version: 1,
          integrationCapabilities: [{ id: 'lookup', application: 'lookup', required: false,
            alternatives: [{ source: 'mcp', connector: 'lookup', requiredTools: ['READ'] }] }] } }),
      'mcp.json': JSON.stringify({ url: 'https://retention.fixture.invalid/mcp', transport: 'http', auth: 'none' }),
      'skills/retention-brief/SKILL.md': '---\nname: retention-brief\ndescription: Exact retention fixture\n---\nRetain exact source.\n',
    }, pluginRegistry.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canEdit: false, canManage: false }] });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const configuration: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed',
      selections: [{ selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null }],
      workflow: { version: 1, packages: [{ ...pin, skillSelection: { kind: 'plugin' }, declarations: [{ declarationPath: '.canvas-plugin/plugin.json',
        capabilities: [{ capabilityId: 'lookup', selection: { mode: 'fixed', alternativeKey: 'mcp:lookup', target: { kind: 'shared', source: 'mcp',
          connectionRef: packageSource.resource.connectionRef, bindingRevision: packageSource.resource.bindingRevision,
          mcpMapping: { kind: 'manager_confirmation' } }, toolCap: ['READ', 'WRITE'] } }] }] }] },
      standalone: [{ mode: 'fixed', entry: { requirement: 'optional', toolCap: ['READ', 'WRITE'], selection: { kind: 'mcp', source: 'mcp',
        target: { kind: 'shared', connectionRef: standaloneSource.resource.connectionRef, bindingRevision: standaloneSource.resource.bindingRevision } } } }],
    };
    const management = await import('../app/lib/agents/management-actions');
    const workflow = await import('../app/lib/agents/workflow-configuration');
    const { inspectManagedAgentExtensions } = await import('../app/lib/agents/extension-inspection');
    const created = await management.createManagedAgent(actor, { name: 'Actual retention grant agent', agentId: `retention-agent-${randomUUID()}`,
      scopeType: 'organization', enabledTools: ['read', 'mcp'], extensions: configuration });
    const before = await inspectManagedAgentExtensions(actor, created.agent.agentId);
    assert(before.configuration?.mode === 'fixed');
    assert(JSON.stringify(before.configuration).includes('agent-workflow-retain:v1:'));
    assert(JSON.stringify(before.configuration).includes('agent-extension-retain:v1:'));
    const draft = structuredClone(before.configuration);
    assert(draft.standalone[0].mode === 'fixed'); draft.standalone[0].entry.toolCap = ['READ'];
    const draftPackageChoice = draft.workflow!.packages[0].declarations[0].capabilities[0].selection;
    assert(draftPackageChoice.mode === 'fixed'); draftPackageChoice.toolCap = ['READ'];
    const granted = await management.setManagedAgentGrant({ actor, agentId: created.agent.agentId, expectedRevision: before.revision,
      targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false });
    const fresh = await inspectManagedAgentExtensions(actor, created.agent.agentId);
    assert(fresh.configuration?.mode === 'fixed');
    assert.equal(fresh.revision, granted.agent.revision); assert(fresh.revision > before.revision);
    assert.equal(fresh.workflowRevision, before.workflowRevision);
    await assert.rejects(() => workflow.updateManagedAgentConfiguration({ actor, agentId: created.agent.agentId, expectedRevision: fresh.revision,
      expectedWorkflowRevision: fresh.workflowRevision, extensions: draft }), error => /RETENTION_INVALID/u.test(String((error as { code?: string }).code)));
    const rebased = rebaseAgentExtensionRetentions({ draft: { intent: 'replace', configuration: draft }, before: before.configuration, current: fresh.configuration });
    assert(rebased.configuration?.mode === 'fixed');
    assert.deepEqual(rebased.configuration.standalone[0].mode === 'fixed' && rebased.configuration.standalone[0].entry.toolCap, ['READ']);
    assert.notDeepEqual(rebased.configuration, draft); assert.deepEqual(before.configuration.standalone[0].mode === 'fixed' && before.configuration.standalone[0].entry.toolCap, ['READ', 'WRITE']);
    const written = await workflow.updateManagedAgentConfiguration({ actor, agentId: created.agent.agentId, expectedRevision: fresh.revision,
      expectedWorkflowRevision: fresh.workflowRevision, extensions: rebased.configuration });
    assert.equal(written.agent.workflowRevision, fresh.workflowRevision + 1);
    const after = await inspectManagedAgentExtensions(actor, created.agent.agentId);
    assert(after.configuration?.mode === 'fixed');
    const afterPackageChoice = after.configuration.workflow!.packages[0].declarations[0].capabilities[0].selection;
    assert(afterPackageChoice.mode === 'fixed'); assert.deepEqual(afterPackageChoice.toolCap, ['READ']);
    assert.deepEqual(after.configuration.standalone[0].mode === 'fixed' && after.configuration.standalone[0].entry.toolCap, ['READ']);
    assert.throws(() => rebaseAgentExtensionRetentions({ draft: { intent: 'replace', configuration: draft }, before: before.configuration, current: after.configuration }), /changed/u);
    console.log('PASS actual SQL retention: real Grant ACK invalidates package/standalone hints; exact fresh inspection rebase preserves local caps and passes the genuine writer; changed source configuration rejects.');
  } finally { await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
