import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';
import { CREATOR_COMPANY_DOMAIN, CREATOR_RESEARCH_TOOL, startCreatorE2eProviderFixture } from './helpers/creator-e2e-provider-fixture';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { ChatExtensionSelectionInput, ExtensionPackagePin, StandaloneExtensionSelection } from '../app/lib/capabilities/extensions/contracts';
import type { ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import type { IntegrationProviderPage, IntegrationToolPage, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';

/** Actual isolated SQL/package/ACL/Chat/AcceptedTurn/Runtime/Gateway. Only readonly MCP transport is an owned loopback fixture. */
async function main() {
  const native = process.argv.includes('--native');
  const fixture = await createDurableMessageExecutionFixture({ native, ...(native ? { nativePoolMax: 10 as const } : {}) });
  const provider = await startCreatorE2eProviderFixture();
  const app = fixture.application, previousFetch = globalThis.fetch, networkFetch = (await import('undici')).fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== provider.baseUrl) return previousFetch(input, init);
    assert.equal(url.pathname, '/mcp');
    assert(['GET', 'POST', 'DELETE'].includes(init?.method ?? (input instanceof Request ? input.method : 'GET')));
    return networkFetch(url.href, init as Parameters<typeof networkFetch>[1]) as unknown as Promise<Response>;
  };
  let stage = 'setup';
  try {
    const management = await import('../app/lib/agents/management-actions');
    const options = await import('../app/lib/chat/extension-options');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const activation = await import('../app/lib/capabilities/packages/activation');
    const personalActivation = await import('../app/lib/capabilities/activation-actions');
    const shared = await import('../app/lib/mcp/shared-connections');
    const definitions = await import('../app/lib/mcp/server-definitions');
    const personal = await import('../app/lib/mcp/personal-connections');
    const owner = { ...app.owner, source: 'api' as const }, alice = { ...app.alice, source: 'api' as const };
    const general = await management.createManagedAgent(owner, { name: `Optional MCP ${randomUUID()}`, scopeType: 'organization', enabledTools: ['read', 'mcp'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' },
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }] });
    const target = (actor: typeof app.owner) => ({ kind: 'draft_turn' as const, agentId: general.agent.agentId, workspaceId: actor.workspaceId! });
    const install = async (template: 'none' | 'valid' | 'invalid') => {
      const name = `optional-mcp-${template}-${randomUUID().slice(0, 8)}`;
      const files: Record<string, string> = {
        '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Optional portable MCP template', skills: './skills',
          connectors: { mcp: [{ name: 'research', ...(template === 'none' ? {} : { configPath: 'research.json' }) }] },
          workflow: { version: 1, integrationCapabilities: [{ id: 'research', application: 'research', required: true,
            alternatives: [{ source: 'mcp', connector: 'research', requiredTools: [CREATOR_RESEARCH_TOOL] }] }] } }),
        [`skills/research-${template}/SKILL.md`]: `---\nname: research-${template}\ndescription: Research the selected company\n---\nUse the explicitly chosen research connection.\n`,
      };
      if (template !== 'none') files['research.json'] = template === 'valid' ? JSON.stringify({ url: provider.mcpUrl, transport: 'http', auth: 'none' }) : '{';
      const archive = await app.registry.addPackage('application', 'plugin', name, '1.0.0', files, plugins.computeCanvasPluginChecksum);
      const installed = await stores.installCapabilityPackageFromStoreAction(app.owner, { source: { kind: 'plugin', registryId: 'store-application', entryKey: name,
        version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' }, grants: [app.owner, app.alice].map(actor => ({
          targetType: 'user' as const, targetId: actor.userId, canUse: true, canEdit: false, canManage: false })) });
      const inspect = await packages.inspectCapabilityPackage(app.owner, installed.resource.resourceRef);
      await activation.setCapabilityPackageDefaultActivationAction(app.owner, installed.resource.resourceRef, { expectedMetadataRevision: inspect.resource.metadataRevision,
        expectedGrantsRevision: inspect.resource.grantsRevision, expectedPackageRevision: inspect.state!.packageRevision,
        expectedPublishedRevisionRef: installed.published.revisionRef, expectedDefaultEnabled: false, enabled: true });
      for (const actor of [app.owner, app.alice]) await personalActivation.setPersonalCapabilityActivation({ context: { userId: actor.userId, organizationId: app.organizationId,
        workspaceId: actor.workspaceId, role: actor.userId === 'owner' ? 'owner' : 'member' }, actorUserId: actor.userId, resourceId: inspect.sourceStamp.resourceId, enabled: true });
      return { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    };
    const pin = await install('none');
    const definition = await definitions.publishMcpServerDefinition(app.organizationId, 'Approved fixture research', { url: provider.mcpUrl, transport: 'http', auth: 'none', enabled: true });
    const own = await personal.createPersonalMcpConnection(owner.userId, definition.id, 'Owner research');
    const aliceOwn = await personal.createPersonalMcpConnection(alice.userId, definition.id, 'Alice research');
    const sourceActor = { ...app.owner, organizationId: app.organizationId };
    const createShared = (url: string, grant = true) => shared.createSharedMcpConnection(sourceActor, { ownership: { type: 'organization', organizationId: app.organizationId },
      displayName: 'Explicit research choice', accessMode: 'restricted', allowedToolNames: [CREATOR_RESEARCH_TOOL],
      config: { url, transport: 'http', auth: 'none', enabled: true },
      grants: grant ? [{ targetType: 'agent', targetId: general.agent.agentId, canUse: true, canManage: false, allowedToolNames: [CREATOR_RESEARCH_TOOL] }] : [] });
    const available = await createShared(provider.mcpUrl), denied = await createShared(provider.mcpUrl, false), wrong = await createShared(`${provider.baseUrl}/wrong`);
    const selector = (selected: ExtensionPackagePin) => ({ kind: 'package' as const, package: selected,
      declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'research', alternativeKey: 'mcp:research' });
    stage = 'actual no-template Chat chooser';
    const choices = await options.listChatExtensionOptions(alice, { operation: 'connection_choices', target: target(alice), selector: selector(pin) });
    assert(choices.operation === 'connection_choices');
    const chosen = choices.connections.find(choice => choice.selection.target.kind === 'shared' && choice.selection.target.connectionRef === available.resource.connectionRef);
    assert(chosen && chosen.eligibility.action === 'select' && chosen.mappingRequired === false);
    assert(choices.connections.some(choice => choice.selection.kind === 'mcp' && choice.selection.target.kind === 'personal' && choice.selection.target.connectionRef === `mcp-personal:${aliceOwn.connectionId}`));
    assert(!choices.connections.some(choice => choice.selection.kind === 'mcp' && choice.selection.target.kind === 'personal' && choice.selection.target.connectionRef === `mcp-personal:${own.connectionId}`));
    assert(!choices.connections.some(choice => choice.selection.target.kind === 'shared' && choice.selection.target.connectionRef === denied.resource.connectionRef));
    const selection = (selected: ExtensionPackagePin, connection: StandaloneExtensionSelection): ChatExtensionSelectionInput => ({ version: 1, origin: 'turn_reference',
      selections: [{ selection: { kind: 'plugin', package: selected, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: [CREATOR_RESEARCH_TOOL] },
        { selection: connection, requirement: 'optional', toolCap: [CREATOR_RESEARCH_TOOL] }],
      packageConnections: [{ ...selector(selected), connectionSelection: connection }].map(({ package: pkg, declarationPath, capabilityId, alternativeKey, connectionSelection }) =>
        ({ package: pkg, declarationPath, capabilityId, alternativeKey, connectionSelection })) });
    const selected = selection(pin, chosen.selection);
    const body: ChatBodyV1 = { version: 1, parts: [{ type: 'extension_reference', occurrenceId: 'research', bundleId: 'research' }],
      bundles: [{ id: 'research', caption: 'Research', primary: selected.selections[0], supporting: [{ selection: chosen.selection,
        requirement: 'optional', toolCap: [CREATOR_RESEARCH_TOOL] }], packageConnections: selected.packageConnections! }] };
    const preview = await options.listChatExtensionOptions(alice, { operation: 'preview', target: target(alice), body, intakeSelection: selected });
    assert(preview.operation === 'preview'); assert.equal(preview.preview.issues.filter(issue => issue.severity === 'error').length, 0);
    await assert.rejects(options.listChatExtensionOptions(alice, { operation: 'connection_choices', target: target(alice), selector: selector({ ...pin, checksum: '0'.repeat(64) }) }));
    const fixed = await management.createManagedAgent(owner, { name: `Fixed ${randomUUID()}`, scopeType: 'organization', enabledTools: ['read', 'mcp'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] },
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }] });
    await assert.rejects(options.listChatExtensionOptions(alice, { operation: 'connection_choices', target: { ...target(alice), agentId: fixed.agent.agentId }, selector: selector(pin) }), { code: 'CHAT_EXTENSION_AGENT_SCOPE' });
    stage = 'real declared templates stay strict';
    const templated = await install('valid');
    const filtered = await options.listChatExtensionOptions(alice, { operation: 'connection_choices', target: target(alice), selector: selector(templated) });
    assert(filtered.operation === 'connection_choices');
    assert(filtered.connections.some(choice => choice.selection.target.kind === 'shared' && choice.selection.target.connectionRef === available.resource.connectionRef));
    assert(!filtered.connections.some(choice => choice.selection.target.kind === 'shared' && choice.selection.target.connectionRef === wrong.resource.connectionRef));
    const invalid = await install('invalid');
    await assert.rejects(options.listChatExtensionOptions(alice, { operation: 'connection_choices', target: target(alice), selector: selector(invalid) }));
    stage = 'actual AcceptedTurn and held Runtime';
    const frame = await fixture.createSessionRuntime({ userId: 'alice', agentId: general.agent.agentId });
    const intake = await import('../app/lib/capabilities/extensions/accepted-turn-selection');
    const runtime = await import('../app/lib/capabilities/packages/runtime-bindings');
    const turns = await import('../app/lib/capabilities/extensions/turn-runtime');
    const effective = await import('../app/lib/capabilities/extensions/effective-context');
    const compile = async (value: ChatExtensionSelectionInput) => {
      const intakeContext = { ...frame.context, agentTurnId: randomUUID() };
      const accepted = await intake.prepareAcceptedTurnExtensionSelection(intakeContext, value);
      const context: AgentExecutionContext = { ...frame.context, agentTurnId: randomUUID(), turnExtensions: intake.readAcceptedTurnExtensionSelection(accepted, intakeContext).publicSelection };
      const packageSelection = await runtime.getAuthorizedAgentWorkflowPackageSelections(context);
      context.turnExtensionSource = await turns.reissueAcceptedTurnRuntimeSelection(context, accepted, intakeContext, { packageSelection });
      return effective.resolveEffectiveExtensionContext(context, { packageSelection });
    };
    const compiled = await compile(selected), projection = effective.readEffectiveExtensionContext(compiled)!;
    assert.equal(projection.workflowProjection?.unavailable, false);
    assert(projection.packageSelection.packages.some(pkg => pkg.resourceRef === pin.resourceRef && pkg.publishedRevisionRef === pin.publishedRevisionRef && pkg.checksum === pin.checksum));
    const ownSelection = selection(pin, { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${aliceOwn.connectionId}` } });
    assert.equal(effective.readEffectiveExtensionContext(await compile(ownSelection))!.workflowProjection?.unavailable, false);
    await assert.rejects(compile(selection(invalid, chosen.selection)));
    await assert.rejects(compile(selection(templated, { kind: 'mcp', source: 'mcp', target: { kind: 'shared', connectionRef: wrong.resource.connectionRef, bindingRevision: wrong.resource.bindingRevision } })));
    stage = 'normal getPiTools and targeted controlled MCP call';
    const { getPiTools } = await import('../app/lib/pi/tool-registry');
    const { isIntegrationGatewayTool } = await import('../app/lib/pi/integration-tool-gateway');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const tools = await getPiTools(alice.userId, general.agent.agentId, frame.sessionId, { executionContext: compiled, strictAuthorization: true, metadataOnlyExternal: true });
    const gateway = tools.find(isIntegrationGatewayTool); assert(gateway);
    const invoke = (args: Parameters<typeof gateway.execute>[1]) => runWithAgentExecutionContext(compiled, () => gateway.execute('optional-template-regression', args));
    const detail = <T>(result: { details: unknown }): T => { const details = result.details as Record<string, unknown>; assert(!details.integrationError); return details as T; };
    const providers = detail<IntegrationProviderPage>(await invoke({ action: 'list', target: 'providers', limit: 50 }));
    const providerRow = providers.providers.find(row => row.source === 'mcp' && row.canExecute); assert(providerRow);
    const discovered = detail<IntegrationToolPage>(await invoke({ action: 'list', target: 'tools', providerRef: providerRow.providerRef, limit: 50 }));
    const tool = discovered.tools.find(tool => tool.name === CREATOR_RESEARCH_TOOL); assert(tool);
    const schema = detail<IntegrationToolSchema>(await invoke({ action: 'describe', toolRef: tool.toolRef }));
    const calledBefore = provider.status().calls.filter(call => call.operation === 'tools/call').length;
    detail(await invoke({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: { domain: CREATOR_COMPANY_DOMAIN } }));
    const calls = provider.status().calls.filter(call => call.operation === 'tools/call');
    assert.equal(calls.length, calledBefore + 1); assert(calls.at(-1)?.successful && calls.at(-1)?.tool === CREATOR_RESEARCH_TOOL);
    stage = 'independent personal MCP approval';
    await definitions.setMcpServerDefinitionEnabled(app.organizationId, definition.id, false);
    await assert.rejects(compile(ownSelection));
    stage = 'fresh Use revocation';
    const connections = await import('../app/lib/integration-tools/connections/store');
    await connections.mutateSharedIntegrationConnection(sourceActor, available.resource.connectionRef, { expectedMetadataRevision: available.resource.metadataRevision,
      expectedGrantsRevision: available.resource.grantsRevision, expectedBindingRevision: available.resource.bindingRevision, grants: [] });
    await assert.rejects(compile(selected));
    assert.equal(fixture.counts().forbiddenModelRequests, 0); assert.equal(app.providerRequests(), 0);
    console.log(`PASS ${app.native ? 'native PostgreSQL' : 'PGlite'} Chat optional MCP template: actual own/shared chooser, preview, exact AcceptedTurn, held effective context, getPiTools and targeted MCP call; real templates, stale pin, foreign ownership, fixed scope and fresh Use remain strict.`);
  } catch (error) { console.error(`Optional MCP template regression failed during ${stage}`); throw error; }
  finally {
    await (await import('../app/lib/mcp/manager')).closeAllMcpServers();
    globalThis.fetch = previousFetch; await provider.close(); await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
