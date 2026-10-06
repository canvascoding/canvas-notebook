import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { Type } from 'typebox';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workflow-error-'));
  const database = await createPiTestDatabase();
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/isolated_error_fixture',
    AUTH_SECRET: randomUUID() + randomUUID(), QMD_ENABLED: 'false', BASE_URL: 'http://localhost:3000', BETTER_AUTH_BASE_URL: 'http://localhost:3000' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const modules = new Map<string, unknown>();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (modules.has(name)) return modules.get(name);
    return original(name, parent, isMain);
  };
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) modules.set(name, await import(name));
    const { agents } = await import('../app/lib/db/schema');
    const privateMarker = `private-binding-${randomUUID()}`;
    const row = { agentId: 'error-fixture-agent', name: 'Own error fixture', createdAt: new Date(), updatedAt: new Date(),
      relevantConnectionsJson: JSON.stringify({ privateBinding: privateMarker }) };
    await database.db.insert(agents).values(row);
    let failure: unknown;
    try { await database.db.insert(agents).values(row); } catch (error) { failure = error; }
    assert(failure instanceof Error && failure.name === 'Error', 'The actual Drizzle query must fail on the own unique key.');
    assert(failure.message.includes(privateMarker), 'The provider fault must contain the inert private bind parameter.');
    const { managementErrorDetails } = await import('../app/lib/agents/management-actions');
    const { ensureAuthReady } = await import('../app/lib/auth');
    await ensureAuthReady();
    const details = managementErrorDetails(failure);
    const response = NextResponse.json({ success: false, code: details.code, error: details.message }, { status: details.status });
    const apiReflected = (await response.text()).includes(privateMarker);
    const { createProgressiveGatewayTool, PROGRESSIVE_GATEWAY_DEFINITIONS } = await import('../app/lib/pi/progressive-tool-gateway');
    const definition = PROGRESSIVE_GATEWAY_DEFINITIONS.find(candidate => candidate.name === 'agent_manage');
    assert(definition);
    const gateway = createProgressiveGatewayTool({ ...definition, operations: ['update_agent_configuration'] }, [{ name: 'update_agent_configuration', label: 'Update own fixture', description: 'Replay the actual database transport fault.',
      parameters: Type.Object({}, { additionalProperties: false }), execute: async () => { throw failure; } }]);
    const result = await gateway.execute('own-error-call', { action: 'call', operation: 'update_agent_configuration', arguments: {} });
    const toolReflected = JSON.stringify(result).includes(privateMarker);
    console.log(JSON.stringify({ actualDrizzleFault: true, apiBoundaryReflected: apiReflected, toolBoundaryReflected: toolReflected,
      scope: 'own PGlite query + actual response formatter and progressive tool error boundary; no authenticated API request' }));
    assert.equal(apiReflected, false, 'Unexpected database errors must not reflect private bind parameters in an HTTP error.');
    assert.equal(toolReflected, false, 'Unexpected database errors must not reflect private bind parameters in an agent tool error.');
    assert.equal(response.status, 500);
    assert.equal((result.details as Record<string, unknown>).code, 'AGENT_MANAGEMENT_FAILED');
    const { AgentWorkflowError } = await import('../app/lib/agents/workflow-contracts');
    for (const status of [403, 409]) {
      const known = managementErrorDetails(new AgentWorkflowError('AGENT_WORKFLOW_CHOICE_DENIED', 'Current workflow choice is unavailable.', status));
      assert.equal(known.status, status); assert.equal(known.code, 'AGENT_WORKFLOW_CHOICE_DENIED');
      assert.equal(known.message, 'Current workflow choice is unavailable.');
    }
    const { AgentDefaultPolicyError } = await import('../app/lib/agent-runtime-policy/agent-default-service');
    const catalog = managementErrorDetails(new AgentDefaultPolicyError('AGENT_DEFAULT_CATALOG_REVISION_CONFLICT', 'Model catalogue changed.', 409, 7));
    assert.equal(catalog.status, 409); assert.equal(catalog.details?.currentCatalogRevision, 7);
    console.log('agent-workflow-error-reflection-test: PASS (actual private Drizzle fault hidden; known workflow 403/409 and model catalogue revision retained)');
  } finally {
    loader._load = original;
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
