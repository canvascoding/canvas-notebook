import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import Module from 'node:module';
import path from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentExecutionContext } from '../../app/lib/pi/agent-execution-context';
import type { IntegrationExecutionContext, IntegrationPolicy } from '../../app/lib/integration-tools/contracts';

type Input = { version: 1; nonce: string; actorUserId: string; sessionId: string; agentId: string; connectionId: string; toolCallId: string };
type ParentReceipt = {
  version: 1; nonce: string; actorId: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; rootDevice: string; rootInode: string; databaseName: string; databaseOwner: string;
  createAcknowledged: boolean; listenerVerified: boolean; phase: string; uncertain: boolean; serverPid: number;
  directoryProofs: Record<string, { device: string; inode: string }>;
};
type Ownership = { input: Input; parent: ParentReceipt; outputPath: string; expectedMcpUrl: string };
const privateConsole = { log: console.log.bind(console), error: console.error.bind(console) };
let failureStage: 'ownership' | 'imports' | 'runtime-db' | 'runtime-context' | 'runtime-policy' | 'runtime-backend'
  | 'dispatch' | 'persistence' | 'closure' | 'output' = 'ownership';
const SAFE_ERROR_CLASSES = new Set(['Error', 'AssertionError', 'TypeError', 'ReferenceError', 'SyntaxError', 'IntegrationContractError',
  'IntegrationConnectionError', 'AgentWorkflowError', 'PiSessionRuntimeAccessError', 'McpAccessError', 'DatabaseUnavailableError']);
const SAFE_ERROR_CODES = new Set(['invalid_request', 'invalid_cursor', 'provider_unavailable', 'provider_denied', 'tool_not_found', 'tool_denied',
  'binding_changed', 'schema_changed', 'invalid_arguments', 'schema_unsupported', 'outcome_unknown', 'ERR_ASSERTION', 'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE', 'SESSION_NOT_FOUND',
  'AGENT_ACCESS_DENIED', 'WORKSPACE_ACCESS_DENIED', 'CONNECTION_CONTEXT_CHANGED', 'CONNECTION_ACCESS_DENIED', 'CONNECTION_BACKEND_UNAVAILABLE',
  'CONNECTION_CONFIG_INVALID', 'CONNECTION_NOT_FOUND', '23502', '23503', '23505', '42P01', '42703', '42501', '08006', 'ECONNREFUSED']);

async function readPrivateJson(file: string, owner: number, maxBytes: number): Promise<unknown> {
  assert.equal(await fs.realpath(file), file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === owner && (stat.mode & 0o777) === 0o600 && stat.size > 1 && stat.size <= maxBytes);
    const result: unknown = JSON.parse(await handle.readFile('utf8'));
    const current = await fs.lstat(file);
    assert(current.isFile() && !current.isSymbolicLink() && current.dev === stat.dev && current.ino === stat.ino && current.uid === owner);
    return result;
  } finally { await handle.close(); }
}

async function assertOwnRoot(parent: ParentReceipt): Promise<void> {
  const root = await fs.lstat(parent.fixtureRoot);
  assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid?.() && (root.mode & 0o777) === 0o700);
  assert.equal(await fs.realpath(parent.fixtureRoot), parent.fixtureRoot);
  assert.equal(String(root.dev), parent.rootDevice); assert.equal(String(root.ino), parent.rootInode);
  const marker = await fs.open(path.join(parent.fixtureRoot, '.fixture-owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await marker.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === root.uid && (stat.mode & 0o777) === 0o600 && stat.size > 1 && stat.size < 1024);
    assert.equal(await marker.readFile('utf8'), parent.ownerMarker);
  } finally { await marker.close(); }
  for (const [directory, basename] of [[parent.dataRoot, 'data'], [parent.tmpRoot, 'tmp']]) {
    assert.equal(directory, path.join(parent.fixtureRoot, basename));
    const stat = await fs.lstat(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === root.uid && (stat.mode & 0o777) === 0o700);
    assert.equal(await fs.realpath(directory), directory);
    assert.deepEqual({ device: String(stat.dev), inode: String(stat.ino) }, parent.directoryProofs[directory]);
  }
}

async function assertOwnedMobileMcpInput(): Promise<Ownership> {
  for (const flag of ['CANVAS_AGENT_SETTINGS_BROWSER_RUN', 'CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN', 'CANVAS_MOBILE_MCP_APPS_BROWSER_RUN', 'E2E_EXTERNAL_SERVER']) assert.equal(process.env[flag], '1');
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.__NEXT_PROCESSED_ENV, 'true');
  assert.equal(process.argv.length, 3, 'The saved-invocation fixture accepts exactly one private input file.');
  const parentPath = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE ?? '';
  assert(path.isAbsolute(parentPath) && path.basename(parentPath) === 'recovery.json');
  const root = path.dirname(parentPath), stat = await fs.lstat(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
  const parent = await readPrivateJson(parentPath, stat.uid, 64 * 1024) as ParentReceipt;
  assert.equal(parent.version, 1); assert.match(parent.nonce, /^[a-f0-9]{32}$/u); assert.equal(parent.fixtureRoot, root);
  assert.equal(parent.createAcknowledged, true); assert.equal(parent.listenerVerified, true); assert.equal(parent.phase, 'browser'); assert.equal(parent.uncertain, false);
  assert(Number.isSafeInteger(parent.serverPid) && parent.serverPid > 0); process.kill(parent.serverPid, 0);
  assert.equal(parent.repo, await fs.realpath(process.cwd())); await assertOwnRoot(parent);
  assert.equal(process.env.DATA, parent.dataRoot); assert.equal(process.env.CANVAS_DATA_ROOT, parent.dataRoot); assert.equal(process.env.TMPDIR, parent.tmpRoot);
  assert.equal(process.env.CANVAS_APP_ROOT, parent.repo); assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  assert.equal(process.env.BASE_URL, 'http://127.0.0.1:3001');
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(databaseUrl.protocol)); assert.equal(databaseUrl.hostname, '127.0.0.1'); assert.equal(databaseUrl.port, '55433');
  assert.equal(parent.databaseName, `canvas_connection_test_${parent.nonce}`); assert.equal(databaseUrl.pathname, `/${parent.databaseName}`);
  assert.equal(databaseUrl.search, ''); assert.equal(databaseUrl.hash, ''); assert(typeof parent.databaseOwner === 'string' && parent.databaseOwner.length > 0);
  const inputPath = process.argv[2]; assert(path.isAbsolute(inputPath) && path.dirname(inputPath) === root);
  assert(/^[A-Za-z0-9_-]{1,128}\.json$/u.test(path.basename(inputPath)) && inputPath !== parentPath);
  const input = await readPrivateJson(inputPath, stat.uid, 16 * 1024) as Input;
  assert(input && typeof input === 'object' && !Array.isArray(input));
  assert.deepEqual(Object.keys(input).sort(), ['actorUserId', 'agentId', 'connectionId', 'nonce', 'sessionId', 'toolCallId', 'version']);
  assert.equal(input.version, 1); assert.equal(input.nonce, parent.nonce);
  for (const key of ['actorUserId', 'sessionId', 'agentId', 'toolCallId'] as const) {
    assert(typeof input[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(input[key]));
  }
  assert.equal(input.actorUserId, parent.actorId);
  assert(typeof input.connectionId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(input.connectionId));
  const mcpUrl = new URL(process.env.CANVAS_SHARED_MCP_APPS_URL ?? '');
  assert.equal(mcpUrl.protocol, 'http:'); assert.equal(mcpUrl.hostname, '127.0.0.1');
  assert(mcpUrl.port && !['3001', '3100', '4001', '4004', '55433'].includes(mcpUrl.port));
  assert.equal(mcpUrl.pathname, '/mcp'); assert.equal(mcpUrl.search, ''); assert.equal(mcpUrl.hash, '');
  assert.equal(mcpUrl.username, ''); assert.equal(mcpUrl.password, '');
  const outputPath = inputPath.slice(0, -5) + '.output.json';
  await assert.rejects(fs.lstat(outputPath), { code: 'ENOENT' }, 'A previous saved invocation cannot be adopted or replayed.');
  return { input, parent, outputPath, expectedMcpUrl: mcpUrl.href };
}

/** Real dispatcher -> actual local MCP HTTP -> persistence. This never runs a model or fabricates an app authority proof. */
async function saveOwnedMobileMcpInvocation(): Promise<void> {
  // Library diagnostics may contain routes. The only published output is the bounded public DTO in the private output file.
  const originalConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const key of ['log', 'warn', 'error', 'info', 'debug'] as const) console[key] = () => {};
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  const exports = new Map<string, unknown>();
  let closeMcp: (() => Promise<void>) | undefined, closeDatabase: (() => Promise<void>) | undefined;
  let output: unknown;
  let ownership: Ownership | undefined;
  try {
    ownership = await assertOwnedMobileMcpInput(); const { input, parent, expectedMcpUrl } = ownership;
    failureStage = 'imports';
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) {
      exports.set(name, await import(name));
    }
    loader._load = (name, caller, isMain) => exports.has(name) ? exports.get(name) : originalLoad(name, caller, isMain);
    const database = await import('../../app/lib/db'); closeDatabase = database.closeDatabaseConnections;
    closeMcp = (await import('../../app/lib/mcp/manager')).closeAllMcpServers;
    const { resolveIntegrationExecutionContext } = await import('../../app/lib/integration-tools/context');
    const { resolveIntegrationRuntimePolicy } = await import('../../app/lib/integration-tools/runtime-policy');
    const { UNRESTRICTED_INTEGRATION_POLICY } = await import('../../app/lib/integration-tools/policy');
    const { readIntegrationToolGatewayAvailability } = await import('../../app/lib/integration-tool-gateway-availability');
    const { attachAgentWorkflowRuntimeProjection } = await import('../../app/lib/agents/workflow-runtime');
    const { assertMcpConnectionAccess } = await import('../../app/lib/mcp/access');
    const { hashMcpServerConfig } = await import('../../app/lib/mcp/manager');
    const { createIntegrationProviderRef } = await import('../../app/lib/integration-tools/references');
    const { integrationDispatcher } = await import('../../app/lib/integration-tools/dispatcher');
    const { runWithAgentExecutionContext } = await import('../../app/lib/pi/agent-execution-context');
    const { projectAgentMessageForPersistence } = await import('../../app/lib/pi/visual-data-projection');
    const { readToolAppInvocation } = await import('../../app/lib/tool-apps/types');
    const signal = AbortSignal.timeout(120_000);
    failureStage = 'runtime-db';
    const sql = await database.openDb();
    try {
      const identity = await sql.get('SELECT current_database() AS database_name,current_user AS database_owner') as { database_name?: unknown; database_owner?: unknown };
      assert.equal(identity.database_name, parent.databaseName); assert.equal(identity.database_owner, parent.databaseOwner);
      const duplicate = await sql.get(`SELECT id FROM pi_messages WHERE pi_session_db_id IN
        (SELECT id FROM pi_sessions WHERE session_id=$1 AND user_id=$2 AND agent_id=$3)
        AND content::jsonb->>'toolCallId'=$4 LIMIT 1`, [input.sessionId, input.actorUserId, input.agentId, input.toolCallId]);
      assert.equal(duplicate, undefined, 'The actual tool call id must be new in the owned chat.');
    } finally { await sql.close(); }
    const fresh = async (): Promise<{ context: IntegrationExecutionContext; policy: IntegrationPolicy; executionContext: AgentExecutionContext; providerRef: string; configHash: string }> => {
      failureStage = 'runtime-context';
      signal.throwIfAborted(); assert.equal(readIntegrationToolGatewayAvailability().integrationToolGatewayEnabled, true);
      const authority = await resolveIntegrationExecutionContext({ actorUserId: input.actorUserId, sessionId: input.sessionId,
        agentId: input.agentId, policyRevision: 'mobile-mcp-apps-browser-fixture' });
      failureStage = 'runtime-policy';
      const runtime = await resolveIntegrationRuntimePolicy({ executionContext: authority.executionContext, ceiling: UNRESTRICTED_INTEGRATION_POLICY });
      const context = { ...authority.integrationContext, sessionId: input.sessionId, policyRevision: runtime.policyRevision };
      if (runtime.workflowProjection) attachAgentWorkflowRuntimeProjection(context, runtime.workflowProjection);
      assert.equal(authority.executionContext.userId, input.actorUserId); assert.equal(authority.executionContext.agentId, input.agentId);
      assert.equal(authority.executionContext.sessionId, input.sessionId);
      failureStage = 'runtime-backend';
      assert.equal(authority.executionContext.workspaceType, 'personal');
      const { connection } = await assertMcpConnectionAccess(input.connectionId, { userId: input.actorUserId });
      assert.equal(connection.connectionId, input.connectionId); assert.equal(connection.ownerUserId, input.actorUserId);
      assert.equal(connection.url, expectedMcpUrl); assert.equal(connection.auth, 'none');
      assert(connection.enabled !== false && !connection.command && !connection.oauth && !connection.headers
        && !connection.headersFromEnv && !connection.bearerTokenEnv && !connection.serverDefinitionId);
      const providerRef = createIntegrationProviderRef({ source: 'mcp', connectionId: input.connectionId,
        scope: { type: 'user', ownerUserId: input.actorUserId, resourceId: input.connectionId } });
      return { context, policy: runtime.policy, executionContext: authority.executionContext, providerRef, configHash: hashMcpServerConfig(connection) };
    };
    const authority = await fresh();
    const revalidate = async () => {
      const callerStage = failureStage;
      const current = await fresh();
      failureStage = 'runtime-context';
      for (const key of ['userId', 'sessionId', 'agentId', 'workspaceId', 'workspaceType', 'organizationId', 'workspaceRoot'] as const) {
        assert.equal(current.executionContext[key], authority.executionContext[key]);
      }
      failureStage = 'runtime-policy';
      assert.equal(current.context.policyRevision, authority.context.policyRevision);
      assert.equal(current.providerRef, authority.providerRef); assert.equal(current.configHash, authority.configHash);
      assert.deepEqual(current.policy, authority.policy);
      failureStage = callerStage;
    };
    const execute = (request: unknown) => runWithAgentExecutionContext(authority.executionContext, () => integrationDispatcher.execute({
      context: authority.context, policy: authority.policy, request, toolCallId: input.toolCallId, signal, beforeToolCall: revalidate,
    }));
    failureStage = 'dispatch';
    const page = await execute({ action: 'list', target: 'tools', providerRef: authority.providerRef, limit: 50 });
    assert('target' in page && page.target === 'tools' && page.providerRef === authority.providerRef && page.complete);
    const selected = page.tools.filter(tool => tool.name === 'app_view'); assert.equal(selected.length, 1); assert.equal(selected[0].effect, 'read');
    const schema = await execute({ action: 'describe', toolRef: selected[0].toolRef });
    assert('schemaRef' in schema && schema.providerRef === authority.providerRef && schema.toolRef === selected[0].toolRef);
    const called = await execute({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: {} });
    assert('target' in called && called.target === 'result' && called.source === 'mcp' && called.providerRef === authority.providerRef);
    const details = called.result.details as Record<string, unknown>;
    assert(details && typeof details === 'object' && !details.error && details.isError !== true);
    const message = projectAgentMessageForPersistence({ role: 'toolResult', toolCallId: input.toolCallId, toolName: 'integrations',
      content: called.result.content, details: called.result.details, isError: false, timestamp: Date.now() } as AgentMessage);
    const invocation = readToolAppInvocation(message);
    assert(invocation?.kind === 'mcp' && invocation.descriptor.version === 1 && invocation.descriptor.toolName === 'app_view'
      && invocation.descriptor.connectionId === input.connectionId);
    const projected = message as unknown as { timestamp: number; details: Record<string, unknown> };
    assert.equal(projected.details.mcpAppAuthority, undefined, 'The personal v1 invocation must come from the actual personal adapter.');
    const publicOutput = { descriptor: invocation.descriptor, input: invocation.input, result: invocation.result };
    assert(JSON.stringify(publicOutput).length <= 2 * 1024 * 1024);
    failureStage = 'persistence'; await revalidate(); await assertOwnRoot(parent);
    const connection = await database.openDb(); let transaction = false;
    try {
      await connection.run('BEGIN'); transaction = true;
      const owned = await connection.get(`SELECT id FROM pi_sessions WHERE session_id=$1 AND user_id=$2 AND agent_id=$3
        AND workspace_id=$4 AND organization_id IS NOT DISTINCT FROM $5 AND archived_at IS NULL FOR UPDATE`,
      [input.sessionId, input.actorUserId, input.agentId, authority.executionContext.workspaceId, authority.executionContext.organizationId]) as { id?: unknown } | undefined;
      assert(owned && Number.isSafeInteger(Number(owned.id)) && Number(owned.id) > 0);
      const audit = await connection.get(`SELECT COUNT(*) AS count,COUNT(DISTINCT sequence) AS distinct_count,
        MIN(sequence) AS minimum,MAX(sequence) AS maximum FROM pi_messages WHERE pi_session_db_id=$1`, [owned.id]) as Record<string, unknown>;
      const count = Number(audit.count); assert(Number.isSafeInteger(count) && count >= 0 && count < 25_000);
      assert.equal(Number(audit.distinct_count), count);
      assert(count === 0 || Number(audit.minimum) === 1 && Number(audit.maximum) === count, 'The existing saved message sequence must be contiguous.');
      const duplicate = await connection.get(`SELECT id FROM pi_messages WHERE pi_session_db_id=$1 AND content::jsonb->>'toolCallId'=$2 LIMIT 1`, [owned.id, input.toolCallId]);
      assert.equal(duplicate, undefined);
      const sequence = count + 1;
      const saved = await connection.get(`INSERT INTO pi_messages(pi_session_db_id,role,content,timestamp,sequence)
        VALUES($1,'toolResult',$2,$3,$4) RETURNING id,sequence,content`, [owned.id, JSON.stringify(message), projected.timestamp, sequence]) as { id?: unknown; sequence?: unknown; content?: unknown };
      assert(Number.isSafeInteger(Number(saved.id)) && Number(saved.id) > 0); assert.equal(Number(saved.sequence), sequence);
      assert.equal(saved.content, JSON.stringify(message));
      await connection.run('UPDATE pi_sessions SET updated_at=$1,last_message_at=$1 WHERE id=$2', [projected.timestamp, owned.id]);
      await connection.run('COMMIT'); transaction = false;
      output = { ...publicOutput, messageId: Number(saved.id), sequence };
    } finally { try { if (transaction) await connection.run('ROLLBACK'); } finally { await connection.close(); } }
  } finally {
    const priorStage = failureStage;
    failureStage = 'closure';
    try { await closeMcp?.(); } finally {
      try { await closeDatabase?.(); } finally { loader._load = originalLoad; Object.assign(console, originalConsole); }
    }
    failureStage = priorStage;
  }
  assert(ownership && output); failureStage = 'output'; await assertOwnRoot(ownership.parent);
  const file = await fs.open(ownership.outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(output)); await file.sync(); } finally { await file.close(); }
  privateConsole.log('MOBILE_MCP_APPS_INVOCATION_SAVED');
}
void saveOwnedMobileMcpInvocation().catch((error: unknown) => {
  const source = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; stack?: unknown } : null;
  const errorClass = typeof source?.name === 'string' && SAFE_ERROR_CLASSES.has(source.name) ? source.name : 'UnknownError';
  const errorCode = typeof source?.code === 'string' && SAFE_ERROR_CODES.has(source.code) ? source.code : 'unknown';
  const line = typeof source?.stack === 'string' ? source.stack.slice(0, 20_000)
    .match(/scripts\/helpers\/mobile-mcp-apps-invocation-fixture\.ts:(\d{1,5}):(\d{1,5})/u) : null;
  const site = line ? `scripts/helpers/mobile-mcp-apps-invocation-fixture.ts:${line[1]}:${line[2]}` : 'unknown';
  privateConsole.error(`MOBILE_MCP_APPS_INVOCATION_FAILED ${failureStage} class=${errorClass} code=${errorCode} site=${site}`);
  process.exitCode = 1;
});
