import assert from 'node:assert/strict';

import { IntegrationDispatcher } from '../app/lib/integration-tools/dispatcher';
import { IntegrationContractError, type IntegrationExecutionContext, type IntegrationProviderDescriptor } from '../app/lib/integration-tools/contracts';
import { UNRESTRICTED_INTEGRATION_POLICY } from '../app/lib/integration-tools/policy';
import { IntegrationReferenceCache } from '../app/lib/integration-tools/reference-cache';
import { createIntegrationProviderRef } from '../app/lib/integration-tools/references';
import type { IntegrationAdapterToolSchema, IntegrationToolAdapter } from '../app/lib/integration-tools/runtime-contracts';

const context: IntegrationExecutionContext = { actorUserId: 'alice', organizationId: 'org-a', workspaceId: 'team-a', agentId: 'designer', policyRevision: 'policy-1' };

function fixture(source: 'mcp' | 'composio') {
  const scope = { type: 'user' as const, ownerUserId: 'alice', resourceId: `${source}-fixture` };
  const provider: IntegrationProviderDescriptor = {
    providerRef: createIntegrationProviderRef(source === 'mcp'
      ? { source, scope, connectionId: 'connection-1' } : { source, scope, profileId: 'profile-1', toolkit: 'canva' }),
    source, scope, application: 'canva', displayName: 'Canva', state: 'ready', configured: true,
    requiresAuth: true, authorized: true, health: 'healthy', canExecute: true,
    checkedAt: null, statusSource: 'provider', pluginRefs: [], skillRefs: [], matchReasons: [], nextActions: [],
  };
  let bindingRevision = 'account-1';
  let tool: IntegrationAdapterToolSchema = {
    name: 'create_design', description: 'Create a design', effect: 'write', toolVersion: '20261006_00',
    inputSchema: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string', minLength: 1 } } },
    outputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  };
  const executions: Array<Record<string, unknown>> = [];
  let failUnknown = false;
  let beforeResolve: (() => void) | undefined;
  let substituteProvider = false;
  const adapter: IntegrationToolAdapter = {
    source,
    async resolveProvider(_context, providerRef) {
      beforeResolve?.();
      assert.equal(providerRef, provider.providerRef);
      return { provider: { ...provider, providerRef: substituteProvider ? 'wrong-sibling-reference' : providerRef }, bindingRevision, binding: null };
    },
    async listTools(_context, _provider, input) {
      return { tools: input.allowedToolNames?.length === 0 ? [] : [tool], complete: true, providerErrors: [], nextCursor: null };
    },
    async describeTool() { return tool; },
    async callTool(_context, _provider, _tool, args) {
      executions.push(structuredClone(args));
      if (failUnknown) throw new IntegrationContractError('outcome_unknown', 'Check the provider outcome before retrying.');
      return { content: [{ type: 'text', text: `Created with ${source}` }], details: { selectedSource: source, id: 'design-1' } };
    },
  };
  return { provider, adapter, executions,
    changeBinding: () => { bindingRevision = 'account-2'; },
    changeSchema: () => { tool = { ...tool, inputSchema: { ...tool.inputSchema as object, required: ['title', 'width'], properties: { title: { type: 'string' }, width: { type: 'integer' } } } }; },
    setUnknown: () => { failUnknown = true; },
    onResolve: (callback: () => void) => { beforeResolve = callback; },
    substitute: () => { substituteProvider = true; },
    refuseArguments: () => { tool = { ...tool, inputSchema: false }; },
  };
}

async function main() {
  let now = 100;
  const mcp = fixture('mcp');
  const composio = fixture('composio');
  const dispatcher = new IntegrationDispatcher({ adapters: { mcp: mcp.adapter, composio: composio.adapter }, now: () => now });
  const execute = (request: unknown, overrides: Partial<Parameters<typeof dispatcher.execute>[0]> = {}) => dispatcher.execute({
    context, policy: UNRESTRICTED_INTEGRATION_POLICY, request, toolCallId: 'fixture-call', ...overrides,
  });
  const discover = async (providerRef: string) => {
    const page = await execute({ action: 'search', target: 'tools', providerRef, query: 'create design' });
    assert.ok('target' in page && page.target === 'tools');
    assert.equal(page.tools.length, 1);
    assert.ok(!('inputSchema' in page.tools[0]), 'discovery discloses descriptions only');
    const schema = await execute({ action: 'describe', toolRef: page.tools[0].toolRef });
    assert.ok('schemaRef' in schema);
    assert.equal(schema.nextActions[0]?.kind, 'input_required');
    return { toolRef: page.tools[0].toolRef, schemaRef: schema.schemaRef };
  };
  const mcpTool = await discover(mcp.provider.providerRef);
  const composioTool = await discover(composio.provider.providerRef);
  assert.notEqual(mcpTool.toolRef, composioTool.toolRef, 'same named tools from two sources retain their own identity');
  await assert.rejects(() => execute({ action: 'call', ...mcpTool, arguments: { title: 42 } }), { code: 'invalid_arguments' });
  assert.equal(mcp.executions.length, 0);
  const created = await execute({ action: 'call', ...mcpTool, arguments: { title: 'Campaign' } });
  assert.ok('target' in created && created.target === 'result');
  assert.equal(created.source, 'mcp');
  assert.equal(created.result.content[0].type, 'text');
  assert.equal(composio.executions.length, 0, 'execution is sent only to the selected provider');
  let resolveCalled = false;
  mcp.onResolve(() => { resolveCalled = true; });
  await assert.rejects(() => execute({ action: 'call', ...mcpTool, arguments: { title: 'x'.repeat(1024 * 1024) } }), { code: 'invalid_arguments' });
  assert.equal(resolveCalled, false, 'oversized model input is rejected before asynchronous provider work');
  mcp.onResolve(() => {});
  await execute({ action: 'call', ...composioTool, arguments: { title: 'Second campaign' } });
  assert.equal(composio.executions.length, 1);

  await assert.rejects(() => execute({ action: 'call', ...mcpTool, arguments: { title: 'Forbidden' } }, { policy: { ...UNRESTRICTED_INTEGRATION_POLICY, allowedToolNames: [] } }), { code: 'tool_denied' });
  await assert.rejects(() => execute({ action: 'call', ...mcpTool, arguments: { title: 'Foreign user' } }, { context: { ...context, actorUserId: 'bob' } }), { code: 'tool_not_found' });
  await assert.rejects(() => execute({ action: 'call', ...mcpTool, arguments: { title: 'Foreign team' } }, { context: { ...context, workspaceId: 'team-b' } }), { code: 'tool_not_found' });
  await assert.rejects(() => execute({ action: 'call', ...mcpTool, arguments: { title: 'Stale policy' } }, { context: { ...context, policyRevision: 'policy-2' } }), { code: 'schema_changed' });
  assert.equal(mcp.executions.length, 1);

  mcp.changeBinding();
  await assert.rejects(() => execute({ action: 'call', ...mcpTool, arguments: { title: 'Old account' } }), { code: 'binding_changed' });
  const rebound = await discover(mcp.provider.providerRef);
  mcp.changeSchema();
  await assert.rejects(() => execute({ action: 'call', ...rebound, arguments: { title: 'Old schema' } }), { code: 'schema_changed' });
  const updated = await discover(mcp.provider.providerRef);
  const mutable = { action: 'call', ...updated, arguments: { title: 'Original', width: 100 } };
  mcp.onResolve(() => { mutable.arguments.title = 'Changed during request'; });
  await execute(mutable);
  assert.deepEqual(mcp.executions.at(-1), { title: 'Original', width: 100 }, 'a call executes exactly the arguments captured before async work');
  mcp.onResolve(() => {});

  composio.setUnknown();
  await assert.rejects(() => execute({ action: 'call', ...composioTool, arguments: { title: 'Uncertain' } }), { code: 'outcome_unknown' });
  assert.equal(composio.executions.length, 2, 'an uncertain write has one provider attempt');
  assert.equal(mcp.executions.length, 2, 'there is no automatic fallback to another provider');
  composio.refuseArguments();
  const impossibleSchema = await execute({ action: 'describe', toolRef: composioTool.toolRef });
  assert.ok('schemaRef' in impossibleSchema);
  assert.deepEqual(impossibleSchema.nextActions, [], 'a schema accepting no input has no misleading call template');
  mcp.substitute();
  await assert.rejects(() => execute({ action: 'describe', toolRef: updated.toolRef }), { code: 'provider_denied' });
  now += 15 * 60_000;
  await assert.rejects(() => execute({ action: 'describe', toolRef: composioTool.toolRef }), { code: 'tool_not_found' });

  const cache = new IntegrationReferenceCache<number>(2, 10, () => now);
  cache.set('one', 1); cache.set('two', 2); assert.equal(cache.get('one'), 1); cache.set('three', 3);
  assert.equal(cache.size, 2); assert.equal(cache.get('two'), undefined);
  now += 10; assert.equal(cache.get('one'), undefined); assert.equal(cache.get('three'), undefined);
  assert.equal(cache.size, 0);
  console.log('PASS integration dispatcher: schema/binding guards, exact source, isolation, immutable calls, single uncertain execution and bounded references.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
