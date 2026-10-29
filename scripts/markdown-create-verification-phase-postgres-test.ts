import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { isMarkdownCreateBirthVerificationEntry, type MarkdownCreateBirthStorageInput } from '../app/lib/files/markdown-create-birth';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Hold delivery of the real final verify child's close while changing the
// actual held B. Its real exit and all positive query replies stay unchanged.
async function markdownCreateVerificationPhasePostgresTest(): Promise<void> {
  assert.equal(isMarkdownCreateBirthVerificationEntry({} as MarkdownCreateBirthStorageInput), false);
  assert.equal(isMarkdownCreateBirthVerificationEntry(new Proxy({} as MarkdownCreateBirthStorageInput,
    { get() { throw new Error('Caller properties cannot select the private verification phase.'); } })), false);
  await withDocumentReadToolDispatchFixture(async h => {
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const pool = getPostgresRuntimeQueryable() as unknown as Pool;
    const schema = (await h.admin.query('SELECT current_schema() AS schema')).rows[0].schema as string;
    assert.match(schema, /^[a-z0-9_]+$/u);
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge,create_knowledge_source';
    await h.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
    await h.admin.query('UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2',
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), h.clientId]);
    await h.setPiEnabledTools(['write']);
    const token = await h.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
    const content = '# Verification phase\n\nOriginal content äöü 😀.\n';
    let registered: AgentTool | undefined, rpcId = 0;
    const call = async (actor: 'agent' | 'mcp', target: string, key: string): Promise<Record<string, unknown>> => {
      if (actor === 'agent') {
        if (!registered) {
          const { getPiTools } = await import('../app/lib/pi/tool-registry');
          registered = (await getPiTools('reader', h.agentId, h.piSessionId,
            { strictAuthorization: true, metadataOnlyExternal: true })).find(tool => tool.name === 'write'); assert(registered);
        }
        return await registered.execute(randomUUID(), { path: target, content, idempotencyKey: key }) as unknown as Record<string, unknown>;
      }
      const id = ++rpcId, response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'create_knowledge_source',
        arguments: { workspace_id: h.workspaceId, path: target, content, idempotency_key: key } } }) }));
      assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.id, id); assert(!body.error);
      return body.result as Record<string, unknown>;
    };
    const observe = async (target: string) => (await h.admin.query(`SELECT to_jsonb(d) AS document,d.xmin::text AS document_xmin,
      to_jsonb(l) AS lineage,l.xmin::text AS lineage_xmin,to_jsonb(y) AS native,y.xmin::text AS native_xmin,
      to_jsonb(b) AS birth,b.xmin::text AS birth_xmin,to_jsonb(r) AS receipt,r.xmin::text AS receipt_xmin,
      u.banned,u.xmin::text AS user_xmin
      FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
      JOIN collaboration_yjs_states y ON y.document_id=d.id
      JOIN collaboration_markdown_create_births b ON b.document_id=d.id
      JOIN collaboration_markdown_file_import_receipts r ON r.workspace_id=b.workspace_id AND r.operation_id=b.operation_id
      CROSS JOIN "user" u WHERE d.workspace_id=$1 AND d.path=$2 AND u.id='reader'`, [h.workspaceId, target])).rows;
    type Fault = 'sequence' | 'account-ban' | 'search-path';
    let fault: Fault | undefined, currentTarget = '', armed = false, injected = false, finalizingClient: PoolClient | undefined;
    let before: unknown, copiedInput: MarkdownCreateBirthStorageInput | undefined, forgeryChecks = 0, heldCloses = 0;
    const pending: Promise<void>[] = [], mutationErrors: unknown[] = [];
    const descriptors = new Map<PoolClient, PropertyDescriptor | undefined>();
    const attach = (client: PoolClient) => {
      if (descriptors.has(client)) return;
      descriptors.set(client, Object.getOwnPropertyDescriptor(client, 'query')); const original = client.query;
      Object.defineProperty(client, 'query', { configurable: true, writable: true, value: (...args: unknown[]) => {
        if (copiedInput) { assert.equal(isMarkdownCreateBirthVerificationEntry(copiedInput), false); forgeryChecks++; }
        const input = args[0], text = typeof input === 'string' ? input
          : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
        const result = Reflect.apply(original, client, args);
        if (!fault || typeof text !== 'string' || !text.includes('UPDATE collaboration_markdown_create_births SET finalized=1')) return result;
        return Promise.resolve(result).then(value => {
          assert.equal((value as QueryResult).rowCount, 1); finalizingClient = client; armed = true; return value;
        });
      } });
    };
    pool.on('acquire', attach);
    const childModule = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
    const originalSpawn = childModule.spawn;
    childModule.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const child = originalSpawn(...args);
      if (!Array.isArray(args[1]) || !args[1].some(value => String(value).endsWith('/markdown-create-birth.py'))) return child;
      let action = '';
      const stream = child.stdin!, write = stream.write;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (!action) {
          const message = JSON.parse(String(chunk)); action = message.action;
          copiedInput = { workspaceRoot: h.workspaceRoot, targetPath: message.intent.targetPath,
            origin: message.intent.origin, source: message.intent.source, operationId: message.intent.operationId };
          assert.equal(isMarkdownCreateBirthVerificationEntry(copiedInput), false);
        }
        return Reflect.apply(write, stream, [chunk, ...rest]);
      }) as typeof stream.write;
      const emit = child.emit;
      child.emit = ((event: string | symbol, ...values: unknown[]) => {
        if (event !== 'close' || action !== 'verify' || !armed || injected) return Reflect.apply(emit, child, [event, ...values]);
        armed = false; heldCloses++;
        const mutation = (async () => {
          assert(finalizingClient); before = await observe(currentTarget); assert(Array.isArray(before)); assert.equal(before.length, 1);
          const sql = fault === 'sequence' ? `UPDATE "${schema}".collaboration_yjs_states SET document_sequence=document_sequence+1 WHERE workspace_id=$1 AND path=$2`
            : fault === 'account-ban' ? `UPDATE "${schema}"."user" SET banned=1 WHERE id='reader'` : 'SET LOCAL search_path=pg_catalog';
          const changed = await Reflect.apply(Object.getPrototypeOf(finalizingClient).query, finalizingClient,
            [sql, fault === 'sequence' ? [h.workspaceId, currentTarget] : undefined]) as QueryResult;
          if (fault !== 'search-path') assert.equal(changed.rowCount, 1);
          injected = true;
        })();
        pending.push(mutation);
        void mutation.then(() => { Reflect.apply(emit, child, [event, ...values]); }, error => {
          mutationErrors.push(error); Reflect.apply(emit, child, [event, ...values]);
        });
        return true;
      }) as typeof child.emit;
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports(); let cases = 0;
    try {
      for (const actor of ['mcp', 'agent'] as const) {
        currentTarget = `verification-phase/${actor}-control.md`;
        assert.notEqual((await call(actor, currentTarget, randomUUID())).isError, true);
        assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, currentTarget)), Buffer.from(content)); cases++;
        for (const selected of ['sequence', 'account-ban', 'search-path'] as const) {
          fault = selected; injected = armed = false; before = undefined; finalizingClient = undefined;
          currentTarget = `verification-phase/${actor}-${selected}.md`; const key = randomUUID();
          let failure: unknown, result: Record<string, unknown> | undefined;
          try { result = await call(actor, currentTarget, key); } catch (error) { failure = error; }
          await Promise.all(pending); assert.deepEqual(mutationErrors, []); assert(injected);
          assert(failure || result?.isError === true, 'Drift during the final verification must never return successful completion.');
          assert.deepEqual(await observe(currentTarget), before, 'Rollback restores original rows/xmin, native state, receipt and account.');
          assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, currentTarget)), Buffer.from(content));
          fault = undefined;
          assert.notEqual((await call(actor, currentTarget, key)).isError, true);
          const after = await observe(currentTarget); assert.equal(after.length, 1); assert(Array.isArray(before));
          assert.equal(after[0].document.id, before[0].document.id); assert.equal(after[0].document.lineage_id, before[0].document.lineage_id);
          assert.equal(after[0].birth.operation_id, before[0].birth.operation_id); assert.equal(after[0].birth.claim_id, before[0].birth.claim_id);
          assert.deepEqual(after[0].native.yjs_state, before[0].native.yjs_state); assert.deepEqual(after[0].native.state_vector, before[0].native.state_vector);
          assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, currentTarget)), Buffer.from(content)); cases++;
        }
      }
      assert.equal(cases, 8); assert.equal(heldCloses, 6); assert(forgeryChecks > 0);
      console.log('VERIFICATION_PHASE_PROOF', JSON.stringify({ cases, realFinalVerifyCloseFaults: heldCloses,
        copiedInputsRejected: forgeryChecks, fullExitFenceRetained: true, originalRowsXminBytesAndReceiptPreserved: true,
        explicitRetrySameIdentity: true }));
    } finally {
      await Promise.allSettled(pending); childModule.spawn = originalSpawn; syncBuiltinESMExports(); pool.off('acquire', attach);
      for (const [client, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(client, 'query', descriptor); else Reflect.deleteProperty(client, 'query');
      }
    }
  });
}
await markdownCreateVerificationPhasePostgresTest();
