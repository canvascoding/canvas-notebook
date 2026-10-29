import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Actual handles, driver replies and kernel closes. Competing SQL is always
// rolled back; only a real close acknowledgement can be lost.
async function markdownCreateClosePhasePostgresTest(): Promise<void> {
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
    const content = '# Closing phase\n\nOriginal bytes äöü 😀.\n';
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
    const domain = async (target: string) => (await h.admin.query(`SELECT to_jsonb(d) AS document,d.xmin::text AS document_xmin,
      to_jsonb(l) AS lineage,l.xmin::text AS lineage_xmin,to_jsonb(y)-'room_owner_token' AS native,y.xmin::text AS native_xmin,
      encode(sha256(convert_to(to_jsonb(y)->>'room_owner_token','UTF8')),'hex') AS room_owner_token_hash,
      to_jsonb(b) AS birth,b.xmin::text AS birth_xmin,to_jsonb(r) AS receipt,r.xmin::text AS receipt_xmin
      FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
      JOIN collaboration_yjs_states y ON y.document_id=d.id
      JOIN collaboration_markdown_create_births b ON b.document_id=d.id
      JOIN collaboration_markdown_file_import_receipts r ON r.workspace_id=b.workspace_id AND r.operation_id=b.operation_id
      WHERE d.workspace_id=$1 AND d.path=$2`, [h.workspaceId, target])).rows;
    type Identity = { client: PoolClient; key: string };
    type Handle = { handle: FileHandle; kind: string; descriptor?: PropertyDescriptor; original: FileHandle['close'];
      attempts: number; closed: boolean; locks: unknown[]; principal?: string };
    type Fault = 'ban-after-close' | 'close-ack-lost' | 'entry-denied';
    let fault: Fault | undefined, target = '', published = false, injected = false, operationId = '';
    let latest: Identity | undefined, finalVerify: Identity | undefined, publishedRows: unknown;
    let handles: Handle[] = [], closingCommits: boolean[] = [];
    const transactions = new Map<PoolClient, string>(), publications = new Set<PoolClient>();
    const descriptors = new Map<PoolClient, PropertyDescriptor | undefined>();
    const attach = (client: PoolClient) => {
      if (descriptors.has(client)) return;
      descriptors.set(client, Object.getOwnPropertyDescriptor(client, 'query')); const original = client.query;
      Object.defineProperty(client, 'query', { configurable: true, writable: true, value: (...args: unknown[]) => {
        const input = args[0], text = typeof input === 'string' ? input
          : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
        const actual = Reflect.apply(original, client, args);
        if (!actual || typeof actual.then !== 'function') return actual;
        return actual.then(async (result: QueryResult) => {
          const first = Array.isArray(result.rows) ? result.rows[0] : undefined;
          const row = first?.principal_identity ?? first?.facts ?? first, xid = row?.transaction ?? row?.xid;
          if (row?.schema === schema && typeof xid === 'string' && typeof row.start === 'string') {
            latest = { client, key: `${row.backend}:${row.start}:${xid}` }; transactions.set(client, latest.key);
          }
          if (typeof text !== 'string') return result;
          if (text.includes('UPDATE collaboration_markdown_create_births SET finalized=1')) publications.add(client);
          if (text.trim() === 'COMMIT' && result.command === 'COMMIT') {
            if (published && finalVerify?.client === client && transactions.get(client) === finalVerify.key) {
              closingCommits.push(handles.length === 2 && handles.every(v => v.closed));
            }
            if (publications.delete(client)) {
              published = true; publishedRows = await domain(target); assert(Array.isArray(publishedRows)); assert.equal(publishedRows.length, 1);
              if (fault === 'entry-denied' && !injected) {
                assert.equal((await h.admin.query("UPDATE \"user\" SET banned=1 WHERE id='reader'")).rowCount, 1); injected = true;
              }
            }
          }
          if (/^(?:COMMIT|ROLLBACK)\b/u.test(text.trim())) transactions.delete(client);
          return result;
        });
      } });
    };
    pool.on('acquire', attach);
    const compete = async () => {
      let code: unknown; await h.admin.query('BEGIN');
      try {
        await h.admin.query("SET LOCAL lock_timeout='50ms'");
        await h.admin.query("UPDATE \"user\" SET banned=1 WHERE id='reader'");
      } catch (error) { code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined; }
      finally { await h.admin.query('ROLLBACK'); }
      return code;
    };
    const selected = new Map([[path.resolve(h.dataRoot), 'data'], [await fs.realpath(h.dataRoot), 'data'],
      [path.resolve(h.workspaceRoot), 'workspace'], [await fs.realpath(h.workspaceRoot), 'workspace']]);
    const fsModule = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
    const originalOpen = fsModule.open;
    fsModule.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await Reflect.apply(originalOpen, fsModule, args);
      const kind = typeof args[0] === 'string' ? selected.get(path.resolve(args[0])) : undefined;
      if (!kind || !(new Error()).stack?.includes('withMarkdownCreateBirthClaim')) return handle;
      const item: Handle = { handle, kind, descriptor: Object.getOwnPropertyDescriptor(handle, 'close'),
        original: handle.close, attempts: 0, closed: false, locks: [] }; handles.push(item);
      Object.defineProperty(handle, 'close', { configurable: true, writable: true, value: async () => {
        item.attempts++;
        if (item.closed || !published) { const result = await Reflect.apply(item.original, handle, []); item.closed = true; return result; }
        item.principal = latest && transactions.get(latest.client) === latest.key ? latest.key : undefined;
        item.locks.push(await compete());
        const result = await Reflect.apply(item.original, handle, []); item.closed = true;
        item.locks.push(await compete());
        if (kind === 'workspace' && fault === 'ban-after-close' && !injected) {
          assert(latest && transactions.get(latest.client) === latest.key);
          const changed = await Reflect.apply(Object.getPrototypeOf(latest.client).query, latest.client,
            [`UPDATE "${schema}"."user" SET banned=1 WHERE id='reader'`]) as QueryResult;
          assert.equal(changed.rowCount, 1); injected = true;
        }
        if (kind === 'workspace' && fault === 'close-ack-lost' && !injected) {
          injected = true; throw Object.assign(new Error('Lost acknowledgement after actual successful descriptor close.'), { code: 'FIXTURE_CLOSE_ACK_LOST' });
        }
        return result;
      } });
      return handle;
    }) as typeof originalOpen;
    const childModule = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
    const originalSpawn = childModule.spawn;
    childModule.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const child = originalSpawn(...args);
      if (!Array.isArray(args[1]) || !args[1].some(value => String(value).endsWith('/markdown-create-birth.py'))) return child;
      let first = true; const stream = child.stdin!, write = stream.write;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (first) { first = false; const message = JSON.parse(String(chunk)); operationId = message.intent.operationId;
          if (published && message.action === 'verify') finalVerify = latest; }
        return Reflect.apply(write, stream, [chunk, ...rest]);
      }) as typeof stream.write;
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports(); let cases = 0, lockedCloses = 0, fallbackCloses = 0;
    const allHandles: Handle[] = [];
    try {
      for (const actor of ['mcp', 'agent'] as const) {
        for (const variant of [undefined, 'ban-after-close', 'close-ack-lost', 'entry-denied'] as const) {
          fault = variant; target = `close-phase/${actor}-${variant ?? 'control'}.md`; const key = randomUUID();
          published = injected = false; operationId = ''; finalVerify = undefined; publishedRows = undefined;
          handles = []; closingCommits = []; const authorityBefore = (await h.admin.query('SELECT to_jsonb(u) AS row,u.xmin::text AS xmin FROM "user" u WHERE id=$1', ['reader'])).rows;
          let failure: unknown, result: Record<string, unknown> | undefined;
          try { result = await call(actor, target, key); } catch (error) { failure = error; }
          allHandles.push(...handles); assert.equal(handles.length, 2);
          for (const item of handles) { assert.equal(item.handle.fd, -1); await assert.rejects(item.handle.stat(), { code: 'EBADF' }); }
          if (variant === 'entry-denied') {
            assert(injected); assert(!finalVerify); fallbackCloses += handles.length;
            await h.admin.query("UPDATE \"user\" SET banned=0 WHERE id='reader'");
          } else {
            assert(finalVerify); assert(handles.every(v => v.principal === finalVerify?.key), 'Final verification and both real closes must share the same actual Principal.');
            assert(handles.every(v => v.locks.length === 2 && v.locks.every(code => code === '55P03')),
              'Genuine authorization row locks must span both actual descriptor closes.'); lockedCloses += handles.length;
            if (!variant || variant === 'close-ack-lost') assert.deepEqual(closingCommits, [true], 'The confirmation COMMIT follows both real closes.');
            assert.deepEqual((await h.admin.query('SELECT to_jsonb(u) AS row,u.xmin::text AS xmin FROM "user" u WHERE id=$1', ['reader'])).rows, authorityBefore);
          }
          if (variant) {
            assert(injected); assert(failure || result?.isError === true, 'Denial or close acknowledgement loss must never claim success.');
            assert(Array.isArray(publishedRows)); assert.deepEqual(await domain(target), publishedRows);
            if (variant === 'close-ack-lost') assert.equal(handles.find(v => v.kind === 'workspace')?.attempts, 2, 'Retain the existing single close retry.');
            const original = await observeMarkdownCreateBirth({ workspaceRoot: h.workspaceRoot, workspaceId: h.workspaceId, operationId });
            fault = undefined; assert.notEqual((await call(actor, target, key)).isError, true);
            assert.deepEqual(await domain(target), publishedRows);
            const complete = await observeMarkdownCreateBirth({ workspaceRoot: h.workspaceRoot, workspaceId: h.workspaceId, operationId });
            assert(complete.complete); assert.equal(complete.id, original.id); assert.deepEqual(complete.intent, original.intent);
          } else { assert(!failure); assert.notEqual(result?.isError, true); }
          assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, target)), Buffer.from(content)); cases++;
        }
      }
      assert.equal(cases, 8); assert.equal(lockedCloses, 12); assert.equal(fallbackCloses, 4);
      console.log('CLOSE_PHASE_PROOF', JSON.stringify({ cases, lockedActualCloses: lockedCloses, deniedEntryFallbackCloses: fallbackCloses,
        actualCloseAcknowledgementLossCases: 2, finalVerificationAndClosesSharePrincipal: true,
        finalConfirmationAfterActualClose: true, originalRowsXminIdentityReceiptAndBytesRetained: true }));
    } finally {
      fsModule.open = originalOpen; childModule.spawn = originalSpawn; syncBuiltinESMExports(); pool.off('acquire', attach);
      for (const item of allHandles) { if (item.descriptor) Object.defineProperty(item.handle, 'close', item.descriptor); else Reflect.deleteProperty(item.handle, 'close'); }
      for (const [client, descriptor] of descriptors) { if (descriptor) Object.defineProperty(client, 'query', descriptor); else Reflect.deleteProperty(client, 'query'); }
    }
  });
}
await markdownCreateClosePhasePostgresTest();
