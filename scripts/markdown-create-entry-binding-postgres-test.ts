import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Binding opens only read-only roots. Real competing SQL between binding and
// helper admission must still prevent every mutating helper and native write.
async function markdownCreateEntryBindingPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async h => {
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { observeMarkdownCreateBirth } = await import('../app/lib/files/markdown-create-birth');
    const pool = getPostgresRuntimeQueryable() as unknown as Pool; assert(pool);
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge,create_knowledge_source';
    await h.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
    await h.admin.query('UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2',
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), h.clientId]);
    await h.setPiEnabledTools(['write']);
    const token = await h.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
    const content = '# Entry binding\n\nOriginal bytes äöü 😀.\n';
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
      assert.equal(response.status,200); const body = await response.json(); assert.equal(body.id,id); assert(!body.error);
      return body.result as Record<string, unknown>;
    };
    const authority = async () => (await h.admin.query('SELECT to_jsonb(u) AS value,u.xmin::text AS xmin FROM "user" u WHERE id=$1',['reader'])).rows;
    const receipts = async () => (await h.admin.query(`SELECT to_jsonb(b) AS birth,b.xmin::text AS birth_xmin,
      to_jsonb(r) AS receipt,r.xmin::text AS receipt_xmin FROM collaboration_markdown_create_births b
      LEFT JOIN collaboration_markdown_file_import_receipts r ON r.workspace_id=b.workspace_id AND r.operation_id=b.operation_id
      ORDER BY b.operation_id`)).rows;
    const storage = async () => {
      const result: Array<{ name: string; inode: number; mode: number; hash?: string }> = [];
      const visit = async (name: string): Promise<void> => {
        const full = path.join(h.dataRoot,name), info = await fs.lstat(full);
        assert(!info.isSymbolicLink());
        result.push({ name,inode:info.ino,mode:info.mode,
          ...(info.isFile() ? { hash:createHash('sha256').update(await fs.readFile(full)).digest('hex') } : {}) });
        if (info.isDirectory()) for (const child of (await fs.readdir(full)).sort()) await visit(path.join(name,child));
      };
      for (const name of (await fs.readdir(h.dataRoot)).sort()) if (name.startsWith('canvas-markdown-create-births')) await visit(name);
      return result;
    };
    let tracking = false, phaseStarts = 0, lastRootPhaseStarts = 0, freshFirstHelperAdmissions = 0;
    let spawns = 0, operationId = '', fault: 'data' | 'workspace' | undefined, injected = false, locked = false;
    let handles: FileHandle[] = [];
    const descriptors = new Map<PoolClient, PropertyDescriptor | undefined>();
    const attach = (client: PoolClient) => {
      if (descriptors.has(client)) return;
      descriptors.set(client,Object.getOwnPropertyDescriptor(client,'query')); const original = client.query;
      Object.defineProperty(client,'query',{ configurable:true,writable:true,value:(...args:unknown[]) => {
        const input = args[0], text = typeof input === 'string' ? input
          : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input,'text')?.value : undefined;
        if (tracking && typeof text === 'string' && text.startsWith("SET LOCAL statement_timeout='5s'")) phaseStarts++;
        return Reflect.apply(original,client,args);
      } });
    };
    pool.on('acquire',attach);
    const require = createRequire(import.meta.url), fsModule = require('node:fs/promises') as typeof import('node:fs/promises');
    const originalOpen = fsModule.open;
    const roots = new Map([[path.resolve(h.dataRoot),'data'],[await fs.realpath(h.dataRoot),'data'],
      [path.resolve(h.workspaceRoot),'workspace'],[await fs.realpath(h.workspaceRoot),'workspace']]);
    fsModule.open = (async (...args:Parameters<typeof originalOpen>) => {
      const handle = await Reflect.apply(originalOpen,fsModule,args);
      const kind = typeof args[0] === 'string' ? roots.get(path.resolve(args[0])) : undefined;
      if (!tracking || !kind || !(new Error()).stack?.includes('withMarkdownCreateBirthClaim')) return handle;
      handles.push(handle); lastRootPhaseStarts = phaseStarts;
      if (fault === kind && !injected) {
        await h.admin.query('BEGIN'); locked = true;
        assert.equal((await h.admin.query("UPDATE \"user\" SET banned=1 WHERE id='reader'")).rowCount,1); injected = true;
      }
      return handle;
    }) as typeof originalOpen;
    const childModule = require('node:child_process') as typeof import('node:child_process'), originalSpawn = childModule.spawn;
    childModule.spawn = ((...args:Parameters<typeof originalSpawn>) => {
      const child = originalSpawn(...args);
      if (!tracking || !Array.isArray(args[1]) || !args[1].some(value => String(value).endsWith('/markdown-create-birth.py'))) return child;
      if (spawns++ === 0) {
        assert(phaseStarts > lastRootPhaseStarts,'The first actual helper must acquire a fresh Principal after the read-only root opens.');
        freshFirstHelperAdmissions++;
      }
      let first = true; const stream = child.stdin!, write = stream.write;
      stream.write = ((chunk:unknown,...rest:unknown[]) => {
        if (first) { first = false; operationId = JSON.parse(String(chunk)).intent.operationId; }
        return Reflect.apply(write,stream,[chunk,...rest]);
      }) as typeof stream.write;
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports(); let cases = 0, deniedBeforeHelper = 0, actualClosedHandles = 0;
    try {
      for (const actor of ['agent','mcp'] as const) for (const selected of [undefined,'data','workspace'] as const) {
        const target = `entry-binding/${actor}-${selected ?? 'control'}.md`, key = randomUUID();
        const before = await h.snapshot(), beforeReceipts = await receipts(), beforeStorage = await storage(), beforeAuthority = await authority();
        fault = selected; injected = false; handles = []; spawns = phaseStarts = lastRootPhaseStarts = 0; operationId = ''; tracking = true;
        let failure:unknown, result:Record<string,unknown> | undefined;
        try { result = await call(actor,target,key); } catch (error) { failure = error; }
        finally { tracking = false; if (locked) { await h.admin.query('ROLLBACK'); locked = false; } }
        assert.equal(handles.length,2);
        for (const handle of handles) { assert.equal(handle.fd,-1); await assert.rejects(handle.stat(),{ code:'EBADF' }); actualClosedHandles++; }
        assert.deepEqual(await authority(),beforeAuthority);
        if (selected) {
          assert(injected); assert(failure || result?.isError === true); assert.equal(spawns,0); deniedBeforeHelper++;
          assert.deepEqual(await h.snapshot(),before); assert.deepEqual(await receipts(),beforeReceipts); assert.deepEqual(await storage(),beforeStorage);
          await assert.rejects(fs.lstat(path.join(h.workspaceRoot,target)),{ code:'ENOENT' });
          fault = undefined; handles = []; spawns = phaseStarts = lastRootPhaseStarts = 0; tracking = true;
          try { assert.notEqual((await call(actor,target,key)).isError,true); } finally { tracking = false; }
          for (const handle of handles) { assert.equal(handle.fd,-1); await assert.rejects(handle.stat(),{ code:'EBADF' }); actualClosedHandles++; }
        } else {
          if (failure || result?.isError) console.log('ENTRY_BINDING_CONTROL_ERROR',JSON.stringify({ result,failure:failure instanceof Error ? failure.message : failure }));
          assert(!failure); assert.notEqual(result?.isError,true);
        }
        assert(operationId); const original = await observeMarkdownCreateBirth({ workspaceRoot:h.workspaceRoot,workspaceId:h.workspaceId,operationId });
        assert(original.complete); const saved = await h.snapshot(), savedReceipts = await receipts(), savedStorage = await storage();
        assert.notEqual((await call(actor,target,key)).isError,true);
        assert.deepEqual(await h.snapshot(),saved); assert.deepEqual(await receipts(),savedReceipts); assert.deepEqual(await storage(),savedStorage);
        const repeated = await observeMarkdownCreateBirth({ workspaceRoot:h.workspaceRoot,workspaceId:h.workspaceId,operationId });
        assert.deepEqual(repeated,original); assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot,target)),Buffer.from(content));
        console.log('ENTRY_BINDING_CASE',JSON.stringify({ actor,fault:selected ?? null,phaseStarts,spawns })); cases++;
      }
      assert.equal(cases,6); assert.equal(deniedBeforeHelper,4); assert.equal(freshFirstHelperAdmissions,6); assert.equal(actualClosedHandles,20);
      console.log('ENTRY_BINDING_PROOF',JSON.stringify({ cases,deniedBeforeHelper,freshFirstHelperAdmissions,actualClosedHandles,
        actualSqlAndIo:true,originalRowsXminReceiptsIdentitiesAndBytesRetained:true }));
    } finally {
      tracking = false; if (locked) await h.admin.query('ROLLBACK');
      fsModule.open = originalOpen; childModule.spawn = originalSpawn; syncBuiltinESMExports(); pool.off('acquire',attach);
      for (const [client,descriptor] of descriptors) { if (descriptor) Object.defineProperty(client,'query',descriptor); else Reflect.deleteProperty(client,'query'); }
    }
  });
}
await markdownCreateEntryBindingPostgresTest();
