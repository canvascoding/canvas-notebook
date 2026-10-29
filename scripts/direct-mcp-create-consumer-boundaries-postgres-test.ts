import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Genuine transport, Principal and kernel handles. Revoke on the real B after
// its entry reply or after the last ordinary close fence. No reply is replaced.
async function directMcpCreateConsumerBoundariesPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async h => {
    // The enclosing Principal executes its exit check in an anonymous async
    // closure, so V8 does not retain the outer factory's name in this stack.
    // Observe the actual exit callsite in our source bundle, never a fake reply.
    const exitCallsites = (await fs.readFile(new URL(import.meta.url),'utf8')).split('\n')
      .flatMap((line,index) => /\bawait current\w*\(phase\w*,\s*true\)/u.test(line) ? [`${import.meta.url}:${index + 1}:`] : []);
    assert.equal(exitCallsites.length,1);
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const pool = getPostgresRuntimeQueryable() as unknown as Pool; assert(pool);
    const schema = (await h.admin.query('SELECT current_schema() AS schema')).rows[0].schema as string; assert.match(schema,/^[a-z0-9_]+$/u);
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge,create_knowledge_source';
    await h.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
    await h.admin.query('UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2',
      [JSON.stringify(['knowledge:read','knowledge:search','knowledge:write']),h.clientId]);
    const token = await h.issue({ scope:'knowledge:read knowledge:search knowledge:write' });
    await h.seed({ filePath:'consumer/original.md',text:'# Original native data\n' });
    const content = '# Consumer boundaries\n\nOriginal bytes äöü 😀.\n'; let rpcId = 0;
    const call = async (target:string,key:string):Promise<Record<string,unknown>> => {
      const id = ++rpcId, response = await handleDirectMcpPost(new Request('http://localhost/mcp',{ method:'POST',headers:{
        authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream',
        'mcp-protocol-version':'2025-11-25',
      },body:JSON.stringify({ jsonrpc:'2.0',id,method:'tools/call',params:{ name:'create_knowledge_source',
        arguments:{ workspace_id:h.workspaceId,path:target,content,idempotency_key:key } } }) }));
      assert.equal(response.status,200); const body = await response.json(); assert.equal(body.id,id); assert(!body.error); return body.result;
    };
    const domain = async () => ({ native:await h.snapshot(),births:(await h.admin.query(`SELECT to_jsonb(b) AS birth,b.xmin::text AS birth_xmin,
      to_jsonb(r) AS receipt,r.xmin::text AS receipt_xmin FROM collaboration_markdown_create_births b
      LEFT JOIN collaboration_markdown_file_import_receipts r ON r.workspace_id=b.workspace_id AND r.operation_id=b.operation_id
      ORDER BY b.operation_id`)).rows });
    const authority = async () => (await h.admin.query('SELECT to_jsonb(u) AS value,u.xmin::text AS xmin FROM "user" u WHERE id=$1',['reader'])).rows;
    const storage = async () => {
      const result = [];
      for (const name of (await fs.readdir(h.dataRoot,{ recursive:true })).sort()) {
        if (!name.split(path.sep)[0].startsWith('canvas-markdown-create-births')) continue;
        const full = path.join(h.dataRoot,name), stat = await fs.lstat(full); assert(!stat.isSymbolicLink());
        result.push({ name,inode:stat.ino,mode:stat.mode,...(stat.isFile()
          ? { hash:createHash('sha256').update(await fs.readFile(full)).digest('hex') } : {}) });
      }
      return result;
    };
    type Fault = 'control' | 'entry-ban' | 'exit-ban';
    let tracking = false, fault:Fault = 'control', injected = false, spawns = 0, entryFacts = 0, lateOwners = 0, finalGuardReads = 0;
    let handles:FileHandle[] = [], latestB:PoolClient | undefined, published:Awaited<ReturnType<typeof domain>> | undefined;
    let stored:Awaited<ReturnType<typeof storage>> | undefined;
    const descriptors = new Map<PoolClient,PropertyDescriptor | undefined>();
    const attach = (client:PoolClient) => {
      if (descriptors.has(client)) return;
      descriptors.set(client,Object.getOwnPropertyDescriptor(client,'query')); const original = client.query;
      Object.defineProperty(client,'query',{ configurable:true,writable:true,value:(...args:unknown[]) => {
        const input = args[0], text = typeof input === 'string' ? input
          : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input,'text')?.value : undefined;
        const depth = Error.stackTraceLimit; let stack:string | undefined;
        try { Error.stackTraceLimit = 30; stack = (new Error()).stack; } finally { Error.stackTraceLimit = depth; }
        const actual = Reflect.apply(original,client,args); if (!actual || typeof actual.then !== 'function') return actual;
        return actual.then(async (result:QueryResult) => {
          if (!tracking || handles.length !== 2 || typeof text !== 'string') return result;
          const facts = result.rows[0]?.facts;
          if (facts?.raw_id === 'reader' && Array.isArray(facts.schema_relations)) {
            latestB = client;
            if (injected && fault === 'exit-ban' && (facts.raw_banned === 1 || facts.raw_banned === '1')
              && exitCallsites.some(callsite => stack?.includes(callsite))
              && !stack?.includes('assertAuthenticatedCreateOriginCurrent')) finalGuardReads++;
            if (!spawns) entryFacts++;
            if (!injected && fault === 'entry-ban' && entryFacts === 2) {
              assert.equal((await Reflect.apply(Object.getPrototypeOf(client).query,client,
                [`UPDATE "${schema}"."user" SET banned=1 WHERE id='reader'`]) as QueryResult).rowCount,1); injected = true;
            }
          }
          if (text.startsWith('SELECT realm.*,EXISTS(') && text.includes('pg_catalog.pg_locks') && handles.every(handle => handle.fd === -1)) {
            lateOwners++;
            if (!injected && fault === 'exit-ban' && lateOwners === 3) {
              assert(latestB && latestB !== client); published = await domain(); stored = await storage();
              assert.equal((await Reflect.apply(Object.getPrototypeOf(latestB).query,latestB,
                [`UPDATE "${schema}"."user" SET banned=1 WHERE id='reader'`]) as QueryResult).rowCount,1); injected = true;
            }
          }
          return result;
        });
      } });
    };
    pool.on('acquire',attach);
    const require = createRequire(import.meta.url), fsModule = require('node:fs/promises') as typeof import('node:fs/promises');
    const originalOpen = fsModule.open, roots = new Set([path.resolve(h.dataRoot),await fs.realpath(h.dataRoot),path.resolve(h.workspaceRoot),await fs.realpath(h.workspaceRoot)]);
    fsModule.open = (async (...args:Parameters<typeof originalOpen>) => {
      const handle = await Reflect.apply(originalOpen,fsModule,args);
      if (tracking && typeof args[0] === 'string' && roots.has(path.resolve(args[0]))
        && (new Error()).stack?.includes('withMarkdownCreateBirthClaim')) handles.push(handle);
      return handle;
    }) as typeof originalOpen;
    const childModule = require('node:child_process') as typeof import('node:child_process'), originalSpawn = childModule.spawn;
    childModule.spawn = ((...args:Parameters<typeof originalSpawn>) => {
      if (tracking && Array.isArray(args[1]) && args[1].some(value => String(value).endsWith('/markdown-create-birth.py'))) spawns++;
      return originalSpawn(...args);
    }) as typeof originalSpawn;
    syncBuiltinESMExports(); let cases = 0, closedHandles = 0, exitProofs = 0;
    try {
      for (const selected of ['control','entry-ban','exit-ban'] as const) {
        fault = selected; injected = false; spawns = entryFacts = lateOwners = finalGuardReads = 0; handles = []; latestB = undefined; published = undefined; stored = undefined;
        const target = `consumer/${selected}.md`, key = randomUUID(), before = await domain(), beforeStore = await storage(), originalUser = await authority();
        let failure:unknown, result:Record<string,unknown> | undefined; tracking = true;
        try { result = await call(target,key); } catch (error) { failure = error; } finally { tracking = false; }
        const resultCode = /\b(?:MARKDOWN_IMPORT_[A-Z_]+|MCP_READ_PRINCIPAL_[A-Z_]+|invalid_token)\b/u.exec(JSON.stringify(result ?? {}))?.[0];
        console.log('MCP_CONSUMER_BOUNDARY_CASE',JSON.stringify({ fault,spawns,injected,lateOwners,finalGuardReads,failed:!!failure || result?.isError === true,resultCode }));
        assert.equal(handles.length,2);
        for (const handle of handles) { assert.equal(handle.fd,-1); await assert.rejects(handle.stat(),{ code:'EBADF' }); closedHandles++; }
        assert.deepEqual(await authority(),originalUser);
        if (selected === 'control') { assert(!failure); assert.notEqual(result?.isError,true); }
        else {
          assert(injected); assert(failure || result?.isError === true);
          if (selected === 'entry-ban') {
            assert.equal(spawns,0); assert.deepEqual(await domain(),before); assert.deepEqual(await storage(),beforeStore);
            await assert.rejects(fs.lstat(path.join(h.workspaceRoot,target)),{ code:'ENOENT' });
          } else {
            assert(published && stored); assert(finalGuardReads > 0,'The genuine enclosing exit Current must observe the late revocation.');
            exitProofs++; assert.deepEqual(await domain(),published); assert.deepEqual(await storage(),stored);
          }
          fault = 'control'; assert.notEqual((await call(target,key)).isError,true);
        }
        const completed = await domain(), completeStore = await storage(); assert.notEqual((await call(target,key)).isError,true);
        assert.deepEqual(await domain(),completed); assert.deepEqual(await storage(),completeStore);
        assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot,target)),Buffer.from(content)); cases++;
      }
      assert.equal(cases,3); assert.equal(closedHandles,6); assert.equal(exitProofs,1);
      console.log('MCP_CONSUMER_BOUNDARY_PROOF',JSON.stringify({ cases,closedHandles,exitProofs,entryRevocationFencedBeforeAnyHelper:true,
        actualUnderlyingExitCurrentRequired:true,originalUserAndNativeRowsXminClaimsAnchorsAndBytesPreserved:true,explicitSameKeyRetries:true,noPositiveReplySubstitution:true }));
    } finally {
      tracking = false; fsModule.open = originalOpen; childModule.spawn = originalSpawn; syncBuiltinESMExports(); pool.off('acquire',attach);
      for (const [client,descriptor] of descriptors) { if (descriptor) Object.defineProperty(client,'query',descriptor); else Reflect.deleteProperty(client,'query'); }
    }
  });
}
await directMcpCreateConsumerBoundariesPostgresTest();
