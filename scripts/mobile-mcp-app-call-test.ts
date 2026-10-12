import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { MOBILE_MCP_APP_CALL_STATEMENTS } from '../app/lib/db/mobile-mcp-app-call-migration';
import type { SqlConnection } from '../app/lib/db';
import type { MobileMcpActor } from '../app/lib/mobile/mcp-apps-access';
import type { MobileMcpApp, MobileMcpPrepare } from '../app/lib/mobile/mcp-apps-contracts';
import { installMcpAccessMocks } from './fixtures/mcp-test-access';

async function load<T>(filename: string, mocks: Record<string, unknown>): Promise<T> {
  const absolute = path.resolve(filename), native = createRequire(absolute), compiled = { exports: {} };
  const source = ts.transpileModule(await fs.readFile(absolute, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  new Function('require','module','exports',source)((name: string) => name in mocks ? mocks[name] : native(name), compiled, compiled.exports);
  return compiled.exports as T;
}
async function main() {
  const access = installMcpAccessMocks(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-mcp-calls-'));
  const old = { CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT, BASE_URL: process.env.BASE_URL, CANVAS_MCP_APPS_ENABLED: process.env.CANVAS_MCP_APPS_ENABLED };
  process.env.CANVAS_DATA_ROOT = root; process.env.BASE_URL = 'http://localhost:3103'; process.env.CANVAS_MCP_APPS_ENABLED = 'true';
  const actor: MobileMcpActor = { userId: 'mobile-call-user', authSessionId: 'auth-one', workspaceId: 'workspace-one',
    sessionId: 'chat-one', agentId: 'agent-one', authSessionExpiresAt: Date.now() + 300_000 };
  access.memberships.set(actor.userId, { organizationId: 'org-one', role: 'admin', status: 'active' });
  const app: MobileMcpApp = { version: 1, connectionId: randomUUID(), toolName: 'view', resourceUri: 'ui://test/widget.html' };
  let targetRevision = 1, calls = 0, delay = false;
  let expireBusinessCall: (() => void) | null = null;
  const provider = http.createServer(async (request, response) => {
    const mcp = new McpServer({ name: 'mobile-call-proof', version: '1' });
    mcp.registerTool('view', { inputSchema: z.object({}), _meta: { ui: { resourceUri: app.resourceUri, visibility: ['model','app'] } } }, async () => ({ content: [] }));
    mcp.registerTool('action', { inputSchema: z.object({ value: z.string() }),
      _meta: { ui: { visibility: ['app'] }, revision: targetRevision } }, async ({ value }) => {
      calls++; if (delay) {
        // Initialization has a generous cold-start bound. This business deadline
        // fires only after the real provider received the already claimed action.
        expireBusinessCall?.(); await new Promise(resolve => setTimeout(resolve, 1500));
      }
      return { content: [{ type: 'text', text: value }], _meta: { appOnly: 'kept' } };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => { void transport.close(); void mcp.close(); });
    try { await mcp.connect(transport); await transport.handleRequest(request, response); }
    catch { if (!response.headersSent) response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address() as { port: number };
  const postgres = new PGlite();
  await postgres.exec('CREATE TABLE pi_sessions(id bigint PRIMARY KEY); INSERT INTO pi_sessions VALUES (7)');
  for (let pass = 0; pass < 2; pass++) for (const sql of MOBILE_MCP_APP_CALL_STATEMENTS) await postgres.exec(sql);
  let lock = Promise.resolve(), loseCommit: 'none' | 'committed' | 'rejected' = 'none';
  const open = async (): Promise<SqlConnection> => {
    const previous = lock; let release!: () => void; lock = new Promise<void>(resolve => { release = resolve; }); await previous;
    return { get: async (sql, args) => (await postgres.query(sql, args)).rows[0],
      all: async (sql, args) => (await postgres.query(sql, args)).rows,
      run: async (sql, args) => {
        if (sql === 'COMMIT' && loseCommit !== 'none') {
          const mode = loseCommit; loseCommit = 'none'; await postgres.exec(mode === 'committed' ? 'COMMIT' : 'ROLLBACK');
          throw new Error('Injected lost COMMIT response.');
        }
        return postgres.query(sql, args);
      }, close: () => release() };
  };
  const manager = await import('../app/lib/mcp/manager');
  try {
    const config = await import('../app/lib/mcp/config');
    await config.writeMcpConfigRaw(JSON.stringify({ settings: { idleTimeout: 10 }, mcpServers: { proof: {
      organizationId: 'org-one',
      url: `http://127.0.0.1:${address.port}/mcp`, timeoutMs: 15000 } } }), { userId: actor.userId });
    app.connectionId = (await config.readMcpConfig({ userId: actor.userId })).mcpServers.proof.connectionId!;
    const contracts = await import('../app/lib/mobile/mcp-apps-contracts');
    const lifecycle = await import('../app/lib/collaboration/lifecycle-transaction');
    const storeModule = await load<typeof import('../app/lib/mcp/mobile-app-call-store')>('app/lib/mcp/mobile-app-call-store.ts', {
      '@/app/lib/db': {}, '@/app/lib/collaboration/lifecycle-transaction': lifecycle,
    });
    const store = new storeModule.MobileMcpAppCallStore(open), secondStore = new storeModule.MobileMcpAppCallStore(open);
    const sourceDigest = 'a'.repeat(64); let sourceValid = true, authVersion = 1, hostValid = true;
    const source = async (current: MobileMcpActor) => {
      if (!sourceValid || current.authSessionId !== actor.authSessionId || current.userId !== actor.userId) throw new Error('Current source authorization denied.');
      const selected = await (await import('../app/lib/mcp/access')).assertMcpConnectionAccess(app.connectionId, { userId: current.userId });
      const environment = await (await import('../app/lib/mcp/env-runtime')).readMcpAvailableEnvSnapshot({ userId: current.userId });
      return { piSessionDbId: 7, sourceReceiptDigest: sourceDigest, input: {}, result: { content: [] }, authVersion,
        connectionId: app.connectionId, scope: { userId: current.userId }, configHash: manager.hashMcpServerConfig(selected.connection), environmentRevision: environment.revision };
    };
    const auth = await load<typeof import('../app/lib/mobile/mcp-apps-access')>('app/lib/mobile/mcp-apps-access.ts', {
      '@/app/lib/db': {}, '@/app/lib/mcp/apps-host': {}, './tool-apps-route': {},
    });
    const service = await load<typeof import('../app/lib/mcp/mobile-app-call-service')>('app/lib/mcp/mobile-app-call-service.ts', {
      './mobile-app-call-store': { ...storeModule, mobileMcpAppCallStore: store }, './manager': { ...manager,
        callMcpAppTool: (...args: Parameters<typeof manager.callMcpAppTool>) => {
          if (args[4].value === 'timeout') {
            const controller = new AbortController();
            expireBusinessCall = () => controller.abort(new DOMException('Injected business timeout after dispatch.', 'TimeoutError'));
            args[5] = controller.signal;
          }
          return manager.callMcpAppTool(...args);
        },
      },
      './mobile-app-tickets': { requireMobileMcpAppChannel: async (current: MobileMcpActor) => {
        await source(current); if (!hostValid) throw new Error('Expired host.');
        const selected = await (await import('../app/lib/mcp/access')).assertMcpConnectionAccess(app.connectionId, { userId: actor.userId });
        const environment = await (await import('../app/lib/mcp/env-runtime')).readMcpAvailableEnvSnapshot({ userId: current.userId });
        return { authVersion, connectionId: app.connectionId, environmentRevision: environment.revision,
          sourceReceiptDigest: sourceDigest, expiresAt: Date.now() + 60_000, configHash: manager.hashMcpServerConfig(selected.connection) };
      } }, '@/app/lib/mobile/mcp-apps-access': { ...auth, readAuthorizedMobileMcpSource: source },
    });
    const prepare = (value = 'approved'): MobileMcpPrepare => ({ toolCallId: 'source-call', app, hostChannelId: randomUUID(), requestId: randomUUID(), tool: 'action', arguments: { value } });
    const firstRequest = prepare();
    const first = await service.prepareMobileMcpAppCall(actor, firstRequest);
    const repeated = await service.prepareMobileMcpAppCall(actor, firstRequest);
    assert.equal(first.call!.callId, repeated.call!.callId); assert.equal(first.approval!.token, repeated.approval!.token); assert.equal(calls, 0);
    await assert.rejects(service.prepareMobileMcpAppCall(actor, { ...firstRequest, arguments: { value: 'changed' } }), { code: 'MCP_CALL_CONFLICT' });
    const rejected = await service.decideMobileMcpAppCall(actor, first.call!.callId, 'reject', first.approval!.token);
    assert.equal(rejected.call!.status, 'rejected'); assert.equal(calls, 0);
    assert.equal((await service.decideMobileMcpAppCall(actor, first.call!.callId, 'approve', first.approval!.token)).call!.status, 'rejected'); assert.equal(calls, 0);
    const approved = await service.prepareMobileMcpAppCall(actor, prepare());
    const outcomes = await Promise.all([service.decideMobileMcpAppCall(actor, approved.call!.callId, 'approve', approved.approval!.token),
      service.decideMobileMcpAppCall(actor, approved.call!.callId, 'approve', approved.approval!.token)]);
    assert.ok(outcomes.some(outcome => outcome.call!.status === 'completed')); assert.equal(calls, 1, 'Concurrent approval dispatches once.');
    const status = await service.readMobileMcpAppCall(actor, { callId: approved.call!.callId });
    assert.equal(status.approval, null); assert.equal(status.call!.result!._meta?.appOnly, 'kept'); assert.equal(calls, 1);
    assert.equal((await service.decideMobileMcpAppCall(actor, approved.call!.callId, 'approve', approved.approval!.token)).call!.status, 'completed'); assert.equal(calls, 1);
    const changed = await service.prepareMobileMcpAppCall(actor, prepare()); targetRevision++;
    await assert.rejects(service.decideMobileMcpAppCall(actor, changed.call!.callId, 'approve', changed.approval!.token), { code: 'MCP_TOOL_CHANGED' }); assert.equal(calls, 1);
    const invalidSchema = await service.prepareMobileMcpAppCall(actor, { ...prepare(), arguments: { value: 7 } });
    await assert.rejects(service.decideMobileMcpAppCall(actor, invalidSchema.call!.callId, 'approve', invalidSchema.approval!.token), { code: 'MCP_TOOL_CHANGED' });
    assert.equal((await store.get(actor, invalidSchema.call!.callId))!.status, 'prepared', 'Actual argument-schema validation precedes the one-shot claim.');
    assert.equal(calls, 1);
    const expired = await service.prepareMobileMcpAppCall(actor, prepare());
    const originalClock = Date.now;
    Date.now = () => expired.call!.approvalExpiresAt + 1;
    try { assert.equal((await service.decideMobileMcpAppCall(actor, expired.call!.callId, 'approve', expired.approval!.token)).call!.status, 'expired'); }
    finally { Date.now = originalClock; }
    assert.equal(calls, 1);
    const pending = await service.prepareMobileMcpAppCall(actor, prepare()); const row = (await store.get(actor, pending.call!.callId))!;
    loseCommit = 'committed'; const recovered = await secondStore.decide(row, 'approve', async () => undefined);
    assert.equal(recovered.claimed, true); assert.equal((await store.get(actor, row.callId))!.executionId, recovered.record.executionId);
    assert.equal((await store.decide(row, 'approve', async () => undefined)).claimed, false, 'No lease reacquisition.');
    const pendingRollback = await service.prepareMobileMcpAppCall(actor, prepare()); loseCommit = 'rejected';
    await assert.rejects(secondStore.decide((await store.get(actor, pendingRollback.call!.callId))!, 'approve', async () => undefined), /unconfirmed/u); assert.equal(calls, 1);
    loseCommit = 'committed'; await store.finish(recovered.record, { status: 'completed', result: { content: [] } });
    assert.equal((await store.get(actor, row.callId))!.status, 'completed');
    const interrupted = await service.prepareMobileMcpAppCall(actor, prepare());
    const claim = await store.decide((await store.get(actor, interrupted.call!.callId))!, 'approve', async () => undefined);
    const before = await store.get(actor, claim.record.callId);
    assert.equal(storeModule.presentMobileMcpCall(before!, before!.executionDeadlineAt! + 1).status, 'unknown');
    assert.equal((await store.get(actor, claim.record.callId))!.status, 'executing', 'Status is a read-only projection.');
    assert.equal((await secondStore.decide(claim.record, 'approve', async () => undefined)).claimed, false);
    const slow = await service.prepareMobileMcpAppCall(actor, prepare('timeout')); delay = true;
    assert.equal((await service.decideMobileMcpAppCall(actor, slow.call!.callId, 'approve', slow.approval!.token)).call!.status, 'unknown'); assert.equal(calls, 2);
    await service.readMobileMcpAppCall(actor, { requestId: slow.call!.requestId });
    await service.decideMobileMcpAppCall(actor, slow.call!.callId, 'approve', slow.approval!.token); assert.equal(calls, 2);
    delay = false; hostValid = false; await assert.rejects(service.prepareMobileMcpAppCall(actor, prepare())); hostValid = true;
    sourceValid = false; await assert.rejects(service.readMobileMcpAppCall(actor, { callId: slow.call!.callId })); sourceValid = true;
    authVersion++; await assert.rejects(service.readMobileMcpAppCall(actor, { callId: slow.call!.callId }), { code: 'MCP_CONNECTION_CHANGED' }); authVersion--;
    assert.equal(await store.get({ ...actor, authSessionId: 'replacement-auth' }, row.callId), null);
    assert.throws(() => contracts.readMobileMcpPrepare({ contractVersion: 1, ...prepare(), arguments: JSON.parse('{"__proto__":1}') }));
    assert.throws(() => contracts.readMobileMcpPrepare({ contractVersion: 1, ...prepare(), arguments: { value: 'ü'.repeat(20_000) } }), { status: 413 });
    assert.equal(contracts.mobileMcpCanonicalJson({ b: 2, a: 1 }), contracts.mobileMcpCanonicalJson({ a: 1, b: 2 }));
    const beforeLoss = calls;
    const lostApproval = await service.prepareMobileMcpAppCall(actor, prepare('lost-approval-ack'));
    loseCommit = 'committed';
    assert.equal((await service.decideMobileMcpAppCall(actor, lostApproval.call!.callId, 'approve', lostApproval.approval!.token)).call!.status, 'completed');
    assert.equal(calls, beforeLoss + 1, 'Exact committed execution proof allows the first dispatch only.');
    const rejectedApproval = await service.prepareMobileMcpAppCall(actor, prepare('rejected-commit'));
    loseCommit = 'rejected';
    await assert.rejects(service.decideMobileMcpAppCall(actor, rejectedApproval.call!.callId, 'approve', rejectedApproval.approval!.token));
    assert.equal(calls, beforeLoss + 1, 'Unconfirmed/rejected commit authorizes zero provider dispatches.');
    const bad = await open(); await assert.rejects(async () => await bad.run('UPDATE mobile_mcp_app_calls SET result_json=$2 WHERE call_id=$1', [row.callId, '[]'])); await bad.close();
    console.log('Mobile MCP calls: actual SDK transport + isolated PGlite with controlled Auth/source seams; one-shot approval, commit-loss proof, schema-before-claim, reject zero, metadata/ENV fences and read-only unknown recovery passed; no native/Bearer acceptance claim.');
  } finally {
    await manager.closeAllMcpServers(); await postgres.close(); await new Promise<void>(resolve => provider.close(() => resolve()));
    access.restore(); for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
