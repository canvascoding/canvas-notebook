import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { DISABLED_ALL_TOOLS_SENTINEL } from '../app/lib/pi/enabled-tools';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// No positive answers are replaced. Revoke on actual held B only after a real
// verify process closes, then require the enclosing write boundary to deny DML.
async function markdownCreateWriteBoundaryPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async h => {
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { observeMarkdownCreateBirth } = await import('../app/lib/files/markdown-create-birth');
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
    const content = '# Actual write boundary\n\nKept original body äöü 😀.\n';
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
    const authority = async () => ({ user: (await h.admin.query('SELECT to_jsonb(u) AS row,u.xmin::text AS xmin FROM "user" u WHERE id=$1', ['reader'])).rows,
      agent: (await h.admin.query('SELECT to_jsonb(a) AS row,a.xmin::text AS xmin FROM agents a WHERE agent_id=$1', [h.agentId])).rows });
    const rows = async (target: string) => (await h.admin.query(`SELECT d.id,d.lineage_id,b.operation_id,b.claim_id
      FROM collaboration_documents d JOIN collaboration_markdown_create_births b ON b.document_id=d.id
      WHERE d.workspace_id=$1 AND d.path=$2`, [h.workspaceId, target])).rows;
    const domain = async (target: string) => (await h.admin.query(`SELECT to_jsonb(d) AS document,d.xmin::text AS document_xmin,
      to_jsonb(l) AS lineage,l.xmin::text AS lineage_xmin,
      to_jsonb(y)-'room_owner_token' AS native,y.xmin::text AS native_xmin,
      encode(sha256(convert_to(to_jsonb(y)->>'room_owner_token','UTF8')),'hex') AS room_owner_token_hash,
      to_jsonb(b) AS birth,b.xmin::text AS birth_xmin,to_jsonb(r) AS receipt,r.xmin::text AS receipt_xmin
      FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
      JOIN collaboration_yjs_states y ON y.document_id=d.id
      JOIN collaboration_markdown_create_births b ON b.document_id=d.id
      JOIN collaboration_markdown_file_import_receipts r ON r.workspace_id=b.workspace_id AND r.operation_id=b.operation_id
      WHERE d.workspace_id=$1 AND d.path=$2`, [h.workspaceId, target])).rows;
    type Fault = 'account-ban' | 'search-path' | 'tool-disabled' | 'final-account-ban';
    let fault: Fault | undefined, currentTarget = '', nativeDml = false, injected = false, operationId = '';
    let currentB: PoolClient | undefined, authorizationInVerify = 0, observedVerifyQueries = 0, heldCloses = 0;
    let publicationCommitted = false, beforeFinalDenial: unknown;
    const publicationClients = new Set<PoolClient>();
    const pending: Promise<void>[] = [], mutationErrors: unknown[] = [];
    const descriptors = new Map<PoolClient, PropertyDescriptor | undefined>();
    const attach = (client: PoolClient) => {
      if (descriptors.has(client)) return;
      descriptors.set(client, Object.getOwnPropertyDescriptor(client, 'query')); const original = client.query;
      Object.defineProperty(client, 'query', { configurable: true, writable: true, value: (...args: unknown[]) => {
        const runtime = Reflect.get(globalThis, Symbol.for('canvas.document-operation-metrics.v1')) as
          { context: { getStore(): { phases: readonly string[] } | undefined } } | undefined;
        const phases = runtime?.context.getStore()?.phases;
        if (phases?.includes('birth_verify')) {
          observedVerifyQueries++;
          if (phases.includes('authorization')) authorizationInVerify++;
        }
        const input = args[0], text = typeof input === 'string' ? input
          : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
        if (typeof text === 'string' && /\b(?:INSERT INTO|UPDATE) (?:collaboration_documents|file_collaboration_lineages|collaboration_yjs_states)\b/u.test(text)) nativeDml = true;
        const actual = Reflect.apply(original, client, args);
        if (!actual || typeof actual.then !== 'function') return actual;
        return actual.then((result: QueryResult) => {
          if (typeof text === 'string' && text.includes('UPDATE collaboration_markdown_create_births SET finalized=1')) publicationClients.add(client);
          if (typeof text === 'string' && text.trim() === 'COMMIT' && result.command === 'COMMIT'
            && publicationClients.delete(client)) publicationCommitted = true;
          const first = Array.isArray(result.rows) ? result.rows[0] : undefined;
          const row = first?.principal_identity ?? first?.facts ?? first;
          if (row?.schema === schema && typeof (row.transaction ?? row.xid) === 'string' && typeof row.start === 'string') currentB = client;
          return result;
        });
      } });
    };
    pool.on('acquire', attach);
    const childModule = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
    const originalSpawn = childModule.spawn;
    childModule.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const child = originalSpawn(...args);
      if (!Array.isArray(args[1]) || !args[1].some(value => String(value).endsWith('/markdown-create-birth.py'))) return child;
      let action = '', target = '';
      const stream = child.stdin!, write = stream.write;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (!action) {
          const message = JSON.parse(String(chunk)); action = message.action; target = message.intent.targetPath;
          if (target === currentTarget) operationId = message.intent.operationId;
        }
        return Reflect.apply(write, stream, [chunk, ...rest]);
      }) as typeof stream.write;
      const emit = child.emit;
      child.emit = ((event: string | symbol, ...values: unknown[]) => {
        if (event !== 'close' || action !== 'verify' || target !== currentTarget || !fault || injected
          || (fault === 'final-account-ban' ? !publicationCommitted : nativeDml)) return Reflect.apply(emit, child, [event, ...values]);
        assert(currentB); injected = true; heldCloses++;
        const mutation = (async () => {
          if (fault === 'final-account-ban') { beforeFinalDenial = await domain(currentTarget); assert(Array.isArray(beforeFinalDenial)); assert.equal(beforeFinalDenial.length, 1); }
          const sql = fault === 'account-ban' || fault === 'final-account-ban' ? `UPDATE "${schema}"."user" SET banned=1 WHERE id='reader'`
            : fault === 'tool-disabled' ? `UPDATE "${schema}".agents SET enabled_tools_json=$1 WHERE agent_id=$2` : 'SET LOCAL search_path=pg_catalog';
          const changed = await Reflect.apply(Object.getPrototypeOf(currentB).query, currentB,
            [sql, fault === 'tool-disabled' ? [JSON.stringify([DISABLED_ALL_TOOLS_SENTINEL]), h.agentId] : undefined]) as QueryResult;
          if (fault !== 'search-path') assert.equal(changed.rowCount, 1);
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
        const selections = actor === 'agent' ? [undefined, 'account-ban', 'search-path', 'tool-disabled', 'final-account-ban'] as const
          : [undefined, 'account-ban', 'search-path', 'final-account-ban'] as const;
        for (const selected of selections) {
          fault = selected; currentTarget = `write-boundary/${actor}-${selected ?? 'control'}.md`;
          nativeDml = injected = publicationCommitted = false; beforeFinalDenial = undefined;
          currentB = undefined; operationId = ''; const key = randomUUID();
          const originalAuthority = await authority();
          let failure: unknown, result: Record<string, unknown> | undefined;
          try { result = await call(actor, currentTarget, key); } catch (error) { failure = error; }
          await Promise.all(pending); assert.deepEqual(mutationErrors, []);
          assert.equal(authorizationInVerify, 0, 'Pure private verification must not repeat the enclosing current-rights observation.');
          if (!selected) {
            if (failure) console.error('WRITE_BOUNDARY_CONTROL_FAILURE', failure instanceof Error
              ? { name: failure.name, message: failure.message, stack: failure.stack?.split('\n').slice(0,4) } : { kind: typeof failure });
            assert(!failure); assert.notEqual(result?.isError, true);
          }
          else {
            assert(injected); assert(failure || result?.isError === true, 'Drift at actual verify close must deny writing or final success.');
            if (selected === 'final-account-ban') {
              assert(nativeDml); assert(publicationCommitted); assert(Array.isArray(beforeFinalDenial));
              assert.deepEqual(await domain(currentTarget), beforeFinalDenial);
              assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, currentTarget)), Buffer.from(content));
            } else {
              assert.equal(nativeDml, false); assert.deepEqual(await rows(currentTarget), []);
              await assert.rejects(fs.lstat(path.join(h.workspaceRoot, currentTarget)), { code: 'ENOENT' });
            }
            assert.deepEqual(await authority(), originalAuthority, 'Rollback retains original authority rows and xmin.');
            const original = await observeMarkdownCreateBirth({ workspaceRoot: h.workspaceRoot, workspaceId: h.workspaceId, operationId });
            fault = undefined;
            assert.notEqual((await call(actor, currentTarget, key)).isError, true);
            const after = await rows(currentTarget); assert.equal(after.length, 1);
            assert.equal(after[0].operation_id, operationId); assert.equal(after[0].claim_id, original.id);
            const complete = await observeMarkdownCreateBirth({ workspaceRoot: h.workspaceRoot, workspaceId: h.workspaceId, operationId });
            assert(complete.complete); assert.equal(complete.fingerprint, original.fingerprint); assert.deepEqual(complete.intent, original.intent);
            if (selected === 'final-account-ban') assert.deepEqual(await domain(currentTarget), beforeFinalDenial, 'Final retry retains every completed row and xmin.');
          }
          assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, currentTarget)), Buffer.from(content)); cases++;
        }
      }
      assert.equal(cases, 9); assert.equal(heldCloses, 7); assert(observedVerifyQueries > 0);
      assert.equal(authorizationInVerify, 0);
      console.log('WRITE_BOUNDARY_PROOF', JSON.stringify({ cases, realHeldCloseMutations: heldCloses,
        authorizationSqlInsidePureVerify: 0, actualWriteBoundaryDeniesDrift: true, freshFinalPrincipalExitRetained: true,
        originalAuthorityRowsXminRetained: true,
        originalClaimAndIntentRetainedOnExplicitRetry: true, allOriginalBytesPreserved: true }));
    } finally {
      await Promise.allSettled(pending); childModule.spawn = originalSpawn; syncBuiltinESMExports(); pool.off('acquire', attach);
      for (const [client, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(client, 'query', descriptor); else Reflect.deleteProperty(client, 'query');
      }
    }
  });
}
await markdownCreateWriteBoundaryPostgresTest();
