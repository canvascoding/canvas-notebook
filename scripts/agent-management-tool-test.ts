import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-agent-management-tool-'));
process.env.DATA = dataDir;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only' || request === '@earendil-works/pi-agent-core') return {};
  if (request === '@earendil-works/pi-ai/compat') {
    return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
  }
  if (request === '@earendil-works/pi-ai/oauth') return { getOAuthProvider: () => null };
  return originalLoad(request, parent, isMain);
};

function text(result: unknown): string {
  return (result as { content?: Array<{ type?: string; text?: string }> }).content
    ?.find((entry) => entry.type === 'text')?.text || '';
}

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const { createAgentManagementTools, AGENT_MANAGEMENT_OPERATION_NAMES } = await import('../app/lib/pi/agent-management-tools');
  const { collapseProgressiveToolGroups, getProgressiveGatewayCapabilityNames } = await import('../app/lib/pi/progressive-tool-gateway');
  const { DISABLED_BY_DEFAULT_TOOL_NAMES, getDefaultEnabledToolNames } = await import('../app/lib/pi/enabled-tools');
  const { PLANNING_MODE_ALLOWED_TOOLS } = await import('../app/lib/pi/planning-mode');
  const { getPiTools } = await import('../app/lib/pi/tool-registry');
  const { getPiToolsetsForTool } = await import('../app/lib/pi/toolsets');

  const owner = await createInitialOwner({
    name: 'Agent Tool Owner',
    email: 'agent-tool-owner@example.test',
    password: 'OwnerPassword123!',
  });
  const tools = createAgentManagementTools(owner.id, 'canvas-agent', 'agent-tool-session');
  assert.deepEqual(tools.map((tool) => tool.name), [
    'list_agents',
    'inspect_agent',
    ...AGENT_MANAGEMENT_OPERATION_NAMES,
  ]);
  assert.throws(() => createAgentManagementTools(owner.id, 'special-agent'), /only to Bradley, the main agent/);
  assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('list_agents'), true);
  assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('inspect_agent'), true);
  assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('create_agent'), false);
  assert.deepEqual(getPiToolsetsForTool('create_agent'), ['agents']);
  const agentToolNames = ['list_agents', 'inspect_agent', ...AGENT_MANAGEMENT_OPERATION_NAMES];
  const defaultEnabledToolNames = getDefaultEnabledToolNames(agentToolNames);
  for (const name of agentToolNames) {
    assert.equal(DISABLED_BY_DEFAULT_TOOL_NAMES.has(name), false, `${name} must not be disabled by default`);
    assert.equal(defaultEnabledToolNames.has(name), true, `${name} must be enabled by default`);
  }
  const defaultRuntimeToolNames = getProgressiveGatewayCapabilityNames(
    await getPiTools(owner.id, 'canvas-agent'),
  );
  for (const name of agentToolNames) {
    assert.equal(defaultRuntimeToolNames.includes(name), true, `${name} must be available in the default Bradley runtime`);
  }

  const collapsed = collapseProgressiveToolGroups(tools);
  assert.deepEqual(collapsed.map((tool) => tool.name), ['list_agents', 'inspect_agent', 'agent_manage']);
  assert.deepEqual(getProgressiveGatewayCapabilityNames(collapsed), [
    'list_agents',
    'inspect_agent',
    ...AGENT_MANAGEMENT_OPERATION_NAMES,
  ]);
  const gateway = collapsed.find((tool) => tool.name === 'agent_manage');
  assert.ok(gateway);
  const search = await gateway.execute('search', { action: 'search', query: 'create agent' });
  assert.match(text(search), /create_agent/);
  assert.doesNotMatch(text(search), /Input schema/);
  const describe = await gateway.execute('describe', { action: 'describe', operation: 'create_agent' });
  assert.match(text(describe), /scopeType/);
  assert.match(text(describe), /capabilities/);
  assert.match(text(describe), /grants/);
  assert.match(text(describe), /AGENTS\.md/);

  const createdResult = await gateway.execute('create', {
    action: 'call',
    operation: 'create_agent',
    arguments: {
      name: 'Tool-created Marketing Agent',
      scopeType: 'user',
      enabledTools: ['read', 'web_search'],
      files: { 'AGENTS.md': '# Tool-created instructions' },
    },
  });
  assert.match(text(createdResult), /Created user agent/);
  const created = (createdResult.details as {
    result?: { agent?: { agentId: string; revision: number } };
    agent?: { agentId: string; revision: number };
  }).agent || (createdResult.details as { result?: { agent?: { agentId: string; revision: number } } }).result?.agent;
  assert.ok(created);

  const listTool = collapsed.find((tool) => tool.name === 'list_agents');
  assert.ok(listTool);
  const listed = await listTool.execute('list', {});
  assert.match(text(listed), /Tool-created Marketing Agent/);

  const updateResult = await gateway.execute('update', {
    action: 'call',
    operation: 'update_agent_profile',
    arguments: {
      agentId: created.agentId,
      expectedRevision: created.revision,
      name: 'Updated Marketing Agent',
    },
  });
  assert.match(text(updateResult), /revision 2/);

  const inspectTool = collapsed.find((tool) => tool.name === 'inspect_agent');
  assert.ok(inspectTool);
  const inspected = await inspectTool.execute('inspect', { agentId: created.agentId, includeFiles: true });
  assert.match(text(inspected), /Updated Marketing Agent/);
  assert.equal((inspected.details as { agent: { revision: number } }).agent.revision, 2);

  const preview = await gateway.execute('preview', {
    action: 'call',
    operation: 'preview_agent_deletion',
    arguments: { agentId: created.agentId },
  });
  const previewDetails = preview.details as {
    agent?: { revision: number };
    confirmationToken?: string;
    result?: { agent: { revision: number }; confirmationToken: string };
  };
  const previewPayload = previewDetails.result || previewDetails;
  assert.ok(previewPayload.confirmationToken);
  const deleted = await gateway.execute('delete', {
    action: 'call',
    operation: 'delete_agent',
    arguments: {
      agentId: created.agentId,
      expectedRevision: previewPayload.agent!.revision,
      confirmationToken: previewPayload.confirmationToken,
    },
  });
  assert.match(text(deleted), /Deleted agent/);

  console.log('agent management tool tests passed');
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
