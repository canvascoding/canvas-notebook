import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { IntegrationToolPage, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';

let diagnosticHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
const diagnostic: { version: 1; step: string; scope: 'organization' | 'team' | null; readCalls: number;
  counters: Record<'flag' | 'session' | 'authorization' | 'list' | 'describe' | 'call' | 'result_shape', number>;
  failure?: { name: string; code?: string; site?: { file: string; line: number } } } = {
  version: 1, step: 'preflight', scope: null, readCalls: 0,
  counters: { flag: 0, session: 0, authorization: 0, list: 0, describe: 0, call: 0, result_shape: 0 },
};

/** Executes the real dispatcher, not a model chat, under fresh actual human authority. */
async function main() {
  assert.equal(process.env.CANVAS_COMPOSIO_LIVE_BROWSER_RUN, '1'); assert.equal(process.env.BASE_URL, 'http://127.0.0.1:3001');
  assert.equal(process.env.COMPOSIO_BASE_URL, undefined); assert.equal(process.env.__NEXT_PROCESSED_ENV, 'true');
  const file = process.argv[2]; assert(file && path.isAbsolute(file) && path.basename(file) === 'live-gateway-input.json');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: { nonce: string; actorId: string; authSessionHash: string; targets: Array<{ scope: string; workspaceId: string; organizationId: string; connectionRef: string }> };
  try { const stat = await handle.stat(); assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size < 16384); input = JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
  assert.match(input.nonce, /^[a-f0-9]{32}$/u); assert.equal(path.dirname(file), path.dirname(process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE!));
  const dbUrl = new URL(process.env.DATABASE_URL!); assert.equal(dbUrl.hostname, '127.0.0.1'); assert.equal(dbUrl.port, '55433'); assert.equal(dbUrl.pathname, `/canvas_connection_test_${input.nonce}`);
  assert.equal(process.env.DATA, path.join(path.dirname(file), 'data')); assert.equal(input.targets.length, 2);
  const root = await fs.lstat(path.dirname(file)); assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid?.() && (root.mode & 0o777) === 0o700);
  assert.equal(await fs.realpath(path.dirname(file)), path.dirname(file));
  diagnosticHandle = await fs.open(path.join(path.dirname(file), 'live-gateway-diagnostic.json'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const diagnosticStat = await diagnosticHandle.stat(); assert(diagnosticStat.isFile() && diagnosticStat.nlink === 1 && diagnosticStat.uid === root.uid && (diagnosticStat.mode & 0o777) === 0o600);
  await diagnosticHandle.truncate(0); await diagnosticHandle.write(JSON.stringify(diagnostic), 0, 'utf8'); await diagnosticHandle.sync();
  const { openDb, closeDatabaseConnections } = await import('../app/lib/db');
  try {
    diagnostic.step = 'flag'; diagnostic.counters.flag++;
    await diagnosticHandle.truncate(0); await diagnosticHandle.write(JSON.stringify(diagnostic), 0, 'utf8'); await diagnosticHandle.sync();
    const { readIntegrationToolGatewayAvailability } = await import('../app/lib/integration-tool-gateway-availability');
    assert(readIntegrationToolGatewayAvailability().integrationToolGatewayEnabled, 'The actual isolated gateway flag is required.');
    const { authorizeIntegrationConnection } = await import('../app/lib/integration-tools/connections/store');
    const { createSharedIntegrationProviderRef } = await import('../app/lib/integration-tools/connections/provider-authorization');
    const { IntegrationDispatcher } = await import('../app/lib/integration-tools/dispatcher');
    const { parseIntegrationRequest } = await import('../app/lib/integration-tools/contracts');
    const dispatcher = new IntegrationDispatcher();
    const proof = { version: 1, nonce: input.nonce, readCalls: 0, scopes: [] as Array<{ scope: string; providerRefHash: string; schemaRefHash: string; version: string; successful: true }> };
    for (const target of input.targets) {
      assert(['organization', 'team'].includes(target.scope)); assert.match(target.connectionRef, /^canvas-connection:[a-f0-9-]{36}$/u);
      diagnostic.scope = target.scope as 'organization' | 'team'; diagnostic.step = 'session'; diagnostic.counters.session++;
      await diagnosticHandle.truncate(0); await diagnosticHandle.write(JSON.stringify(diagnostic), 0, 'utf8'); await diagnosticHandle.sync();
      const database = await openDb();
      try {
        const sessions = await database.all('SELECT id FROM session WHERE user_id=$1 AND expires_at>$2', [input.actorId, Date.now()]) as Array<{ id: string }>;
        assert(sessions.some(session => createHash('sha256').update(session.id).digest('hex') === input.authSessionHash), 'The original live human session must remain active.');
      } finally { await database.close(); }
      diagnostic.step = 'authorization'; diagnostic.counters.authorization++;
      await diagnosticHandle.truncate(0); await diagnosticHandle.write(JSON.stringify(diagnostic), 0, 'utf8'); await diagnosticHandle.sync();
      const authorization = await authorizeIntegrationConnection({ userId: input.actorId, organizationId: target.organizationId, workspaceId: target.workspaceId }, target.connectionRef, 'use', 'CANVA_GET_USERS_ME_CAPABILITIES');
      assert.equal(authorization.resource.createdByUserId, input.actorId); assert.equal(authorization.resource.source, 'composio');
      assert.equal(authorization.resource.application, 'canva'); assert.equal(authorization.resource.ownership.type, target.scope);
      assert.equal(authorization.resource.ownership.organizationId, target.organizationId);
      if (authorization.resource.ownership.type === 'team') assert.equal(authorization.resource.ownership.workspaceId, target.workspaceId);
      const providerRef = createSharedIntegrationProviderRef(authorization.resource);
      const context = { actorUserId: input.actorId, organizationId: target.organizationId, workspaceId: target.workspaceId, policyRevision: `live-canva:${input.nonce}:${target.scope}` };
      const operations = ['list_providers', 'search_providers', 'list_tools', 'search_tools', 'describe', 'call'] as const;
      const policy = { allowedSources: ['composio'] as const, allowedProviderRefs: [providerRef], allowedApplications: ['canva'],
        allowedToolNames: ['CANVA_GET_USERS_ME_CAPABILITIES'], allowedOperations: operations.map(operation => `composio.${operation}`),
        providerToolRules: [{ source: 'composio' as const, providerRef, allowedToolNames: ['CANVA_GET_USERS_ME_CAPABILITIES'], allowedOperations: operations }] };
      diagnostic.step = 'list'; diagnostic.counters.list++;
      await diagnosticHandle.truncate(0); await diagnosticHandle.write(JSON.stringify(diagnostic), 0, 'utf8'); await diagnosticHandle.sync();
      const tools = await dispatcher.execute({ context, policy, toolCallId: `live-list-${target.scope}`, request: parseIntegrationRequest({ action: 'list', target: 'tools', providerRef }), signal: AbortSignal.timeout(90_000) }) as IntegrationToolPage;
      assert.equal(tools.target, 'tools');
      assert.equal(tools.tools.length, 1); assert.equal(tools.tools[0].name, 'CANVA_GET_USERS_ME_CAPABILITIES');
      diagnostic.step = 'describe'; diagnostic.counters.describe++;
      await diagnosticHandle.truncate(0); await diagnosticHandle.write(JSON.stringify(diagnostic), 0, 'utf8'); await diagnosticHandle.sync();
      const schema = await dispatcher.execute({ context, policy, toolCallId: `live-schema-${target.scope}`, request: parseIntegrationRequest({ action: 'describe', toolRef: tools.tools[0].toolRef }), signal: AbortSignal.timeout(90_000) }) as IntegrationToolSchema;
      assert('schemaRef' in schema && typeof schema.schemaRef === 'string');
      assert.equal(schema.providerRef, providerRef); assert(schema.toolVersion && schema.inputSchema && typeof schema.inputSchema === 'object');
      const inputSchema = schema.inputSchema as { required?: string[] }; assert(!inputSchema.required?.length, 'Do not invent required live tool arguments.');
      diagnostic.step = 'call'; diagnostic.counters.call++;
      await diagnosticHandle.truncate(0); await diagnosticHandle.write(JSON.stringify(diagnostic), 0, 'utf8'); await diagnosticHandle.sync();
      const result = await dispatcher.execute({ context, policy, toolCallId: `live-read-${target.scope}`, request: parseIntegrationRequest({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: {} }), signal: AbortSignal.timeout(150_000) }) as { target: string; providerRef: string; result: unknown };
      diagnostic.step = 'result_shape'; diagnostic.counters.result_shape++;
      await diagnosticHandle.truncate(0); await diagnosticHandle.write(JSON.stringify(diagnostic), 0, 'utf8'); await diagnosticHandle.sync();
      assert.equal(result.target, 'result');
      assert.equal(result.providerRef, providerRef);
      const content = (result.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean }).content;
      assert(content && content.length === 1 && content[0].type === 'text' && typeof content[0].text === 'string');
      const output = JSON.parse(content[0].text) as { successful?: boolean; error?: unknown; data?: { capabilities?: unknown } };
      assert.equal(output.successful, true); assert(!output.error); assert(output.data && typeof output.data === 'object');
      proof.readCalls++; proof.scopes.push({ scope: target.scope, providerRefHash: createHash('sha256').update(providerRef).digest('hex'),
        schemaRefHash: createHash('sha256').update(schema.schemaRef).digest('hex'), version: schema.toolVersion, successful: true });
      diagnostic.readCalls = proof.readCalls;
      await fs.writeFile(path.join(path.dirname(file), 'live-gateway-read-proof.json'), JSON.stringify(proof), { mode: 0o600 });
    }
    assert.equal(proof.readCalls, 2);
    diagnostic.step = 'complete';
    await diagnosticHandle.truncate(0); await diagnosticHandle.write(JSON.stringify(diagnostic), 0, 'utf8'); await diagnosticHandle.sync();
  } finally { await closeDatabaseConnections(); }
}
main().then(async () => { await diagnosticHandle?.close(); console.info('Actual live Canva dispatcher read: 2 scopes PASS.'); }, async error => {
  const knownNames = ['Error', 'TypeError', 'RangeError', 'AssertionError', 'IntegrationContractError', 'IntegrationConnectionError', 'DatabaseUnavailableError', 'ComposioError'];
  const knownCodes = ['ERR_ASSERTION', 'EACCES', 'ENOENT', 'EEXIST', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
    'invalid_request', 'invalid_cursor', 'provider_unavailable', 'provider_denied', 'tool_not_found', 'tool_denied', 'binding_changed', 'schema_changed',
    'invalid_arguments', 'schema_unsupported', 'outcome_unknown', 'CONNECTION_ACCESS_DENIED', 'CONNECTION_NOT_FOUND'];
  const code: unknown = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  const site = error instanceof Error && typeof error.stack === 'string'
    ? error.stack.match(/((?:scripts|app\/lib)\/[A-Za-z0-9_/-]+\.(?:ts|tsx|js|mjs|cjs)):(\d+):\d+/u) : null;
  diagnostic.failure = { name: error instanceof Error && knownNames.includes(error.name) ? error.name : 'UnknownError',
    ...(typeof code === 'string' && knownCodes.includes(code) ? { code } : {}),
    ...(site && Number.isSafeInteger(Number(site[2])) ? { site: { file: site[1], line: Number(site[2]) } } : {}) };
  try { if (diagnosticHandle) { await diagnosticHandle.truncate(0); await diagnosticHandle.write(JSON.stringify(diagnostic), 0, 'utf8'); await diagnosticHandle.sync(); } }
  catch { /* Diagnostics never print the underlying failure or technical data. */ }
  finally { await diagnosticHandle?.close().catch(() => undefined); }
  console.error('The actual live Canva dispatcher read failed; preserve the private fixture.'); process.exitCode = 1;
});
