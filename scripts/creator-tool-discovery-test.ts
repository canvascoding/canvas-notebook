import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';

function details(result: AgentToolResult<unknown>): Record<string, unknown> {
  assert(result.details && typeof result.details === 'object' && !Array.isArray(result.details));
  return result.details as Record<string, unknown>;
}

/** Real scoped operation metadata and gateway search/filter/schema paths; no mutation or provider call. */
async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-creator-tool-discovery-'));
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/no_creator_discovery_database',
    NODE_ENV: 'test', BASE_URL: 'http://127.0.0.1:1', QMD_ENABLED: 'false' };
  const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoader = loader._load, originalFetch = globalThis.fetch;
  const esm = new Map<string, unknown>();
  let networkRequests = 0;
  globalThis.fetch = async () => { networkRequests++; throw new Error('Discovery cannot contact a provider.'); };
  loader._load = (name, parent, isMain) => esm.has(name) ? esm.get(name) : originalLoader(name, parent, isMain);
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth'])
      esm.set(name, await import(name));
    const { createUserScopedTools } = await import('../app/lib/pi/scoped-tools');
    const { PROGRESSIVE_GATEWAY_DEFINITIONS, createProgressiveGatewayTool, withAllowedProgressiveGatewayOperations,
      getProgressiveGatewayCapabilityNames } = await import('../app/lib/pi/progressive-tool-gateway');
    const { filterToolsForPlanningMode } = await import('../app/lib/pi/planning-mode');
    const { filterToolsForWorkspacePermissions } = await import('../app/lib/pi/workspace-tool-policy');
    const { Value } = await import('typebox/value');
    const tools = createUserScopedTools('routing-user', 'routing-worker', 'routing-session', { registrationKind: 'special' });
    const definition = PROGRESSIVE_GATEWAY_DEFINITIONS.find(value => value.name === 'canvas_extensions');
    assert(definition);
    const scopedOperations = tools.filter(tool => definition.operations.includes(tool.name));
    const gateway = createProgressiveGatewayTool({ ...definition,
      operations: definition.operations.filter(name => scopedOperations.some(tool => tool.name === name)),
    }, scopedOperations);
    const canonicalName = 'create_canvas_package_draft';
    for (const query of ['create plugin', 'create skill', canonicalName]) {
      const result = details(await gateway.execute('search-only', { action: 'search', query }));
      const operations = result.operations as Array<{ name: string; description: string }>;
      assert.equal(operations[0]?.name, canonicalName, `The managed route must lead actual discovery for ${query}.`);
      assert(operations[0].description.length <= 280);
      assert.match(operations[0].description, /new organization plugin or skill/u);
      assert.match(operations[0].description, /draftRef/u);
      assert.match(operations[0].description, /operation=create/u);
    }
    const canonical = tools.find(tool => tool.name === canonicalName); assert(canonical);
    assert.equal(Value.Check(canonical.parameters, { operation: 'create', kind: 'plugin', targetName: 'routing-plugin',
      requestId: 'a8ec2654-02aa-438c-9d34-702e9923b480' }), true);
    assert.equal(Value.Check(canonical.parameters, { operation: 'create', kind: 'plugin', pluginName: 'routing-plugin', draftId: 'legacy-draft' }), false);
    for (const [name, input] of [
      ['create_canvas_plugin_draft', { pluginName: 'legacy-plugin', draftId: 'legacy-plugin-draft' }],
      ['create_canvas_skill_draft', { skillName: 'legacy-skill', draftId: 'legacy-skill-draft' }],
      ['install_canvas_plugin_from_workspace', { workspacePath: '.canvas-plugin-drafts/legacy-plugin-draft/legacy-plugin' }],
      ['install_canvas_skill_from_workspace', { draftPath: '.canvas-skill-drafts/legacy-skill-draft/legacy-skill' }],
    ] as const) {
      const operation = tools.find(tool => tool.name === name); assert(operation);
      const described = details(await gateway.execute('describe-only', { action: 'describe', operation: name }));
      assert.equal(described.operation, name);
      assert.equal(Value.Check(operation.parameters, input), true, 'Legacy arguments remain available without redirection.');
      assert.match(operation.description, /^Legacy personal workspace/u);
      assert.match(operation.description.slice(0, 280), /create_canvas_package_draft/u);
      assert.match(operation.description, /import_canvas_package_workspace_draft/u);
      assert.match(operation.description.slice(0, 280), /packagePath/u);
    }
    for (const name of ['inspect_canvas_package_workspace_draft', 'import_canvas_package_workspace_draft']) {
      const described = details(await gateway.execute('describe-only', { action: 'describe', operation: name }));
      assert.equal(described.operation, name, 'Explicit legacy draft inspection and import remain available.');
    }
    const restricted = withAllowedProgressiveGatewayOperations(gateway, ['inspect_canvas_package', 'create_canvas_plugin_draft']);
    assert(restricted);
    const filtered = filterToolsForWorkspacePermissions([restricted], { canWrite: false, canDelete: false, canShare: false });
    assert.deepEqual(getProgressiveGatewayCapabilityNames(filtered), ['inspect_canvas_package', 'create_canvas_plugin_draft']);
    const restrictedResults = details(await filtered[0].execute('search-only', { action: 'search', query: 'create plugin' }));
    assert(!(restrictedResults.operations as Array<{ name: string }>).some(operation => operation.name === canonicalName));
    for (const action of ['describe', 'call']) {
      const denied = details(await filtered[0].execute('unavailable-only', { action, operation: canonicalName, arguments: {} }));
      assert.match(String(denied.error), /not available/u, 'A recommendation cannot restore a removed operation.');
    }
    const planning = filterToolsForPlanningMode([gateway]);
    assert.equal(planning.length, 1);
    const planningNames = getProgressiveGatewayCapabilityNames(planning);
    for (const name of [canonicalName, 'create_canvas_plugin_draft', 'create_canvas_skill_draft', 'import_canvas_package_workspace_draft']) {
      assert(!planningNames.includes(name));
      const denied = details(await planning[0].execute('planning-denied', { action: 'call', operation: name, arguments: {} }));
      assert.match(String(denied.error), /not available/u);
    }
    assert.equal(networkRequests, 0);
    console.info('PASS Creator discovery: real metadata ranks managed plugin/skill creation first; bounded Org/draftRef summary, unchanged legacy schemas and explicit import, monotone Agent/workspace/Planning filters, no execution or provider requests.');
  } finally {
    loader._load = originalLoader; globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
