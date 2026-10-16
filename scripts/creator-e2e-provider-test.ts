import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Composio } from '@composio/client';
import { CREATOR_COMPANY_DOMAIN, CREATOR_HUBSPOT_TOOL, CREATOR_RESEARCH_TOOL,
  CREATOR_SOURCE_TOOL, startCreatorE2eProviderFixture } from './helpers/creator-e2e-provider-fixture';
import { installMcpAccessMocks } from './fixtures/mcp-test-access';

async function main() {
  const fixture = await startCreatorE2eProviderFixture();
  const fakeApiKey = 'creator-selftest-key-must-not-be-recorded';
  const client = new Composio({ apiKey: fakeApiKey, baseURL: fixture.baseUrl, maxRetries: 0, timeout: 5_000 });
  const entities = { 'actor-a': 'creator-private-entity-alpha', 'actor-b': 'creator-private-entity-beta' } as const;
  const envKeys = ['CANVAS_DATA_ROOT', 'DATA', 'MCP_ALLOW_PRIVATE_NETWORK', 'MCP_ALLOW_INSECURE_HTTP'] as const;
  const oldEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-creator-provider-test-'));
  const mocks = installMcpAccessMocks();
  let closeMcp: (() => Promise<void>) | undefined;
  try {
    const catalogue = await client.toolkits.list({ search: 'hubspot' });
    assert.equal(catalogue.items[0]?.slug, 'hubspot');
    assert.equal((await client.connectedAccounts.list({ user_ids: ['unknown-entity'] })).items.length, 0);
    for (const slot of ['actor-a', 'actor-b'] as const) {
      const response = await fetch(fixture.controlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: fixture.nonce, control: { action: 'register_entity', slot, entity: entities[slot] } }) });
      assert.equal(response.status, 200);
    }
    assert.throws(() => fixture.control({ action: 'register_entity', slot: 'actor-b', entity: entities['actor-a'] }));
    const first = await client.connectedAccounts.list({ user_ids: [entities['actor-a']], toolkit_slugs: ['hubspot'], statuses: ['ACTIVE'] });
    const second = await client.connectedAccounts.list({ user_ids: [entities['actor-b']], toolkit_slugs: ['hubspot'], statuses: ['ACTIVE'] });
    assert.equal(first.items.length, 1); assert.equal(second.items.length, 1);
    const firstId = first.items[0].id, secondId = second.items[0].id;
    assert.notEqual(firstId, secondId);
    assert.equal((await client.connectedAccounts.retrieve(firstId)).id, firstId);
    const discovered = await client.tools.list({ toolkit_slug: 'hubspot', search: 'company' });
    assert.equal(discovered.items[0]?.slug, CREATOR_HUBSPOT_TOOL);
    const schema = await client.tools.retrieve(CREATOR_HUBSPOT_TOOL);
    assert.deepEqual(schema.input_parameters.required, ['domain']);
    const execute = (entity: string, id: string, version = schema.version, args: Record<string, unknown> = { domain: CREATOR_COMPANY_DOMAIN }) => client.tools.execute(CREATOR_HUBSPOT_TOOL,
      { user_id: entity, connected_account_id: id, version, arguments: args });
    for (const [entity, id] of [[entities['actor-a'], firstId], [entities['actor-b'], secondId]]) {
      const result = await execute(entity, id);
      assert.equal(result.successful, true);
      assert.equal((result.data.company as Record<string, unknown>).name, 'Acme Research GmbH');
    }
    assert.equal((await execute(entities['actor-b'], firstId)).successful, false);
    fixture.control({ action: 'schema', provider: 'composio', rotated: true });
    assert.equal((await execute(entities['actor-a'], firstId)).error, 'SCHEMA_STALE');
    const fresh = await client.tools.retrieve(CREATOR_HUBSPOT_TOOL);
    assert.notEqual(fresh.version, schema.version);
    assert.equal((await execute(entities['actor-a'], firstId, fresh.version, { domain: CREATOR_COMPANY_DOMAIN, research_depth: 'brief' })).successful, true);
    fixture.control({ action: 'revoke_account', slot: 'actor-a', toolkit: 'hubspot', revoked: true });
    assert.equal((await client.connectedAccounts.list({ user_ids: [entities['actor-a']], toolkit_slugs: ['hubspot'], statuses: ['ACTIVE'] })).items.length, 0);
    assert.equal((await execute(entities['actor-a'], firstId, fresh.version, { domain: CREATOR_COMPANY_DOMAIN, research_depth: 'brief' })).error, 'ACCOUNT_BINDING_DENIED');
    fixture.control({ action: 'availability', provider: 'composio', available: false });
    await assert.rejects(() => client.tools.list({ toolkit_slug: 'hubspot' }), error => Boolean(error && typeof error === 'object' && 'status' in error && error.status === 503));
    fixture.control({ action: 'availability', provider: 'composio', available: true });
    Object.assign(process.env, { CANVAS_DATA_ROOT: data, DATA: data, MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true' });
    const { writeMcpConfigRaw } = await import('../app/lib/mcp/config');
    const { MCP_SYSTEM_SCOPE } = await import('../app/lib/mcp/scope');
    const { listMcpTools, callMcpTool, getMcpRuntimeStatus, closeAllMcpServers } = await import('../app/lib/mcp/manager');
    closeMcp = closeAllMcpServers;
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: { research: { url: fixture.mcpUrl, timeoutMs: 5_000 } } }), MCP_SYSTEM_SCOPE);
    const listed = await listMcpTools('research', { scope: MCP_SYSTEM_SCOPE, preferCache: false });
    assert.deepEqual(listed.map(tool => tool.name).sort(), [CREATOR_RESEARCH_TOOL, CREATOR_SOURCE_TOOL].sort());
    assert(listed.every(tool => tool.annotations?.readOnlyHint === true));
    const research = await callMcpTool('research', CREATOR_RESEARCH_TOOL, { domain: CREATOR_COMPANY_DOMAIN }, undefined, MCP_SYSTEM_SCOPE);
    const result = research.structuredContent as { company: string; facts: unknown[]; sources: { id: string }[] };
    assert.equal(result.company, 'Acme Research GmbH'); assert.equal(result.facts.length, 3); assert.equal(result.sources.length, 2);
    const source = await callMcpTool('research', CREATOR_SOURCE_TOOL, { source_id: result.sources[0].id }, undefined, MCP_SYSTEM_SCOPE);
    assert.equal((source.structuredContent as { source: { id: string } }).source.id, result.sources[0].id);
    const runtime = await getMcpRuntimeStatus('research', MCP_SYSTEM_SCOPE);
    assert.equal(runtime.servers[0].protocolVersion, '2026-07-28');
    fixture.control({ action: 'schema', provider: 'mcp', rotated: true });
    const rotatedTools = await listMcpTools('research', { scope: MCP_SYSTEM_SCOPE, preferCache: false });
    assert.deepEqual(rotatedTools.find(tool => tool.name === CREATOR_RESEARCH_TOOL)?.inputSchema.required, ['domain', 'source_limit']);
    const stale = await callMcpTool('research', CREATOR_RESEARCH_TOOL, { domain: CREATOR_COMPANY_DOMAIN }, undefined, MCP_SYSTEM_SCOPE);
    assert.equal(stale.isError, true);
    const repaired = await callMcpTool('research', CREATOR_RESEARCH_TOOL, { domain: CREATOR_COMPANY_DOMAIN, source_limit: 2 }, undefined, MCP_SYSTEM_SCOPE);
    assert.equal(repaired.isError, undefined);
    fixture.control({ action: 'availability', provider: 'mcp', available: false });
    await assert.rejects(() => listMcpTools('research', { scope: MCP_SYSTEM_SCOPE, preferCache: false }));
    const safe = JSON.stringify(await (await fetch(fixture.statusUrl)).json());
    for (const privateValue of [fakeApiKey, ...Object.values(entities), firstId, secondId]) assert.equal(safe.includes(privateValue), false);
    assert(fixture.status().calls.some(call => call.actorSlot === 'actor-a' && call.successful && call.exactBinding));
    assert(fixture.status().calls.some(call => call.actorSlot === 'actor-b' && call.successful && call.exactBinding));
    assert.equal((await fetch(fixture.controlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: 'wrong', control: {} }) })).status, 403);
    assert.equal((await fetch(fixture.controlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: JSON.stringify({ nonce: fixture.nonce, control: {} }) })).status, 403);
    console.log('creator-e2e-provider: real Composio SDK catalogue/schema/exact two-account execution, stale/revoke/unavailable; real MCP manager 2026-07-28 tools/calls/schema/unavailable; safe records PASS');
  } finally {
    await closeMcp?.(); mocks.restore();
    for (const key of envKeys) { const value = oldEnv.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fixture.close(); await fs.rm(data, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
