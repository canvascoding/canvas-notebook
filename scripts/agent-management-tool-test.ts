import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-agent-management-tool-'));
const environment = {
  DATA: dataDir, CANVAS_DATA_ROOT: dataDir, NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://127.0.0.1:1/isolated_agent_management_fixture',
  CANVAS_ORGANIZATION_ID: `agent-tool-${randomUUID()}`, CANVAS_DEPLOYMENT_MODE: 'single_user',
  CANVAS_TEAM_FEATURES_ENABLED: 'false', CANVAS_MANAGED_SERVICES_ENABLED: 'false',
  BASE_URL: 'http://localhost:3000', BETTER_AUTH_BASE_URL: 'http://localhost:3000',
  AUTH_SECRET: randomUUID() + randomUUID(), QMD_ENABLED: 'false',
};
const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;

function text(result: unknown): string {
  return (result as { content?: Array<{ type?: string; text?: string }> }).content
    ?.find((entry) => entry.type === 'text')?.text || '';
}

async function main() {
  const database = await createPiTestDatabase();
  const previousLoader = moduleInternals._load;
  const modules = new Map<string, unknown>();
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return database;
    if (modules.has(request)) return modules.get(request);
    return previousLoader(request, parent, isMain);
  };
  try {
    // Preserve the actual ESM exports when the tsx fixture's CJS dependency graph loads them.
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) {
      modules.set(name, await import(name));
    }
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
    const { ensureCanvasAgent } = await import('../app/lib/agents/registry');
    const { DEFAULT_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
    const mainAgent = await ensureCanvasAgent();
    assert.equal(mainAgent.agentId, DEFAULT_MANAGED_AGENT_ID);
    assert.equal(mainAgent.type, 'main');
    const tools = createAgentManagementTools(owner.id, DEFAULT_MANAGED_AGENT_ID, 'agent-tool-session');
    assert.deepEqual(tools.map((tool) => tool.name), [
      'list_agents',
      'inspect_agent',
      'inspect_agent_workflow',
      'list_agent_workflow_options',
      'list_agent_workflow_personal_options',
      ...AGENT_MANAGEMENT_OPERATION_NAMES,
    ]);
    assert.throws(() => createAgentManagementTools(owner.id, 'special-agent'), /only to Bradley, the main agent/);
    assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('list_agents'), true);
    assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('inspect_agent'), true);
    assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('inspect_agent_workflow'), true);
    assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('list_agent_workflow_options'), true);
    assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('list_agent_workflow_personal_options'), false);
    assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('update_agent_configuration'), false);
    assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('set_agent_workflow_choice'), false);
    assert.equal(PLANNING_MODE_ALLOWED_TOOLS.has('create_agent'), false);
    assert.deepEqual(getPiToolsetsForTool('create_agent'), ['agents']);
    assert.deepEqual(getPiToolsetsForTool('list_agent_workflow_personal_options'), ['agents']);
    const agentToolNames = ['list_agents', 'inspect_agent', 'inspect_agent_workflow', 'list_agent_workflow_options', 'list_agent_workflow_personal_options', ...AGENT_MANAGEMENT_OPERATION_NAMES];
    const defaultEnabledToolNames = getDefaultEnabledToolNames(agentToolNames);
    for (const name of agentToolNames) {
      assert.equal(DISABLED_BY_DEFAULT_TOOL_NAMES.has(name), false, `${name} must not be disabled by default`);
      assert.equal(defaultEnabledToolNames.has(name), true, `${name} must be enabled by default`);
    }
    const defaultRuntimeToolNames = getProgressiveGatewayCapabilityNames(
      await getPiTools(owner.id, DEFAULT_MANAGED_AGENT_ID),
    );
    for (const name of agentToolNames) {
      assert.equal(defaultRuntimeToolNames.includes(name), true, `${name} must be available in the default Bradley runtime`);
    }

    const collapsed = collapseProgressiveToolGroups(tools);
    assert.deepEqual(collapsed.map((tool) => tool.name), ['list_agents', 'inspect_agent', 'inspect_agent_workflow', 'list_agent_workflow_options', 'list_agent_workflow_personal_options', 'agent_manage']);
    assert.deepEqual(getProgressiveGatewayCapabilityNames(collapsed), [
      'list_agents',
      'inspect_agent',
      'inspect_agent_workflow',
      'list_agent_workflow_options',
      'list_agent_workflow_personal_options',
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
    assert.ok(text(updateResult).includes(`revision ${created.revision + 1}`));

    const inspectTool = collapsed.find((tool) => tool.name === 'inspect_agent');
    assert.ok(inspectTool);
    const inspected = await inspectTool.execute('inspect', { agentId: created.agentId, includeFiles: true });
    assert.match(text(inspected), /Updated Marketing Agent/);
    assert.equal((inspected.details as { agent: { revision: number } }).agent.revision, created.revision + 1);

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
  } finally {
    moduleInternals._load = previousLoader;
    await database.close();
  }
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
