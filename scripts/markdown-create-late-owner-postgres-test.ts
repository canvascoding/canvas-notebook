import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Release the real A lock after its root proof but during B's fresh rights
// observation. A late fence must deny before the first mutating helper starts.
async function markdownCreateLateOwnerPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async h => {
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const pool = getPostgresRuntimeQueryable() as unknown as Pool; assert(pool);
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge,create_knowledge_source';
    await h.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
    await h.admin.query('UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2',
      [JSON.stringify(['knowledge:read','knowledge:search','knowledge:write']),h.clientId]);
    await h.setPiEnabledTools(['write']);
    const token = await h.issue({ scope:'knowledge:read knowledge:search knowledge:write' });
    await h.seed({ filePath:'original.md',text:'# Original native data\n' });
    const content = '# Late owner fence\n\nOriginal bytes äöü 😀.\n';
    let registered:AgentTool | undefined, rpcId = 0;
    const call = async (actor:'agent' | 'mcp',target:string,key:string):Promise<Record<string,unknown>> => {
      if (actor === 'agent') {
        if (!registered) {
          const { getPiTools } = await import('../app/lib/pi/tool-registry');
          registered = (await getPiTools('reader',h.agentId,h.piSessionId,
            { strictAuthorization:true,metadataOnlyExternal:true })).find(tool => tool.name === 'write'); assert(registered);
        }
        return await registered.execute(randomUUID(),{ path:target,content,idempotencyKey:key }) as unknown as Record<string,unknown>;
      }
      const id = ++rpcId, response = await handleDirectMcpPost(new Request('http://localhost/mcp',{ method:'POST',headers:{
        authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream',
        'mcp-protocol-version':'2025-11-25',
      },body:JSON.stringify({ jsonrpc:'2.0',id,method:'tools/call',params:{ name:'create_knowledge_source',
        arguments:{ workspace_id:h.workspaceId,path:target,content,idempotency_key:key } } }) }));
      assert.equal(response.status,200); const body = await response.json(); assert.equal(body.id,id); assert(!body.error);
      return body.result as Record<string,unknown>;
    };
    const births = async () => (await h.admin.query(`SELECT to_jsonb(b) AS birth,b.xmin::text AS birth_xmin,
      to_jsonb(r) AS receipt,r.xmin::text AS receipt_xmin FROM collaboration_markdown_create_births b
      LEFT JOIN collaboration_markdown_file_import_receipts r ON r.workspace_id=b.workspace_id AND r.operation_id=b.operation_id
      ORDER BY b.operation_id`)).rows;
    const storage = async () => {
      const values = [];
      for (const name of (await fs.readdir(h.dataRoot,{ recursive:true })).sort()) {
        if (!name.split(path.sep)[0].startsWith('canvas-markdown-create-births')) continue;
        const full = path.join(h.dataRoot,name), stat = await fs.lstat(full); assert(!stat.isSymbolicLink());
        values.push({ name,inode:stat.ino,mode:stat.mode,
          ...(stat.isFile() ? { hash:createHash('sha256').update(await fs.readFile(full)).digest('hex') } : {}) });
      }
      return values;
    };
    let tracking = false, fault = false, injected = false, owner:PoolClient | undefined, spawns = 0;
    let handles:FileHandle[] = [];
    const descriptors = new Map<PoolClient,PropertyDescriptor | undefined>();
    const attach = (client:PoolClient) => {
      if (descriptors.has(client)) return;
      descriptors.set(client,Object.getOwnPropertyDescriptor(client,'query')); const original = client.query;
      Object.defineProperty(client,'query',{ configurable:true,writable:true,value:(...args:unknown[]) => {
        const input = args[0], text = typeof input === 'string' ? input
          : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input,'text')?.value : undefined;
        const actual = Reflect.apply(original,client,args);
        if (!actual || typeof actual.then !== 'function') return actual;
        return actual.then(async (result:QueryResult) => {
          if (!tracking || spawns || handles.length !== 2 || typeof text !== 'string') return result;
          if (text.startsWith('SELECT realm.*,EXISTS(') && text.includes('pg_catalog.pg_locks')
            && text.includes('AS workspace_id') && result.rows[0]?.held === true) owner = client;
          else if (fault && !injected && owner && client !== owner && /^\s*SELECT\b/iu.test(text)) {
            const unlocked = await Reflect.apply(Object.getPrototypeOf(owner).query,owner,
              ['SELECT pg_advisory_unlock($1::bigint) AS unlocked',[collaborationAdmissionLockKey(h.workspaceId)]]) as QueryResult;
            assert.equal(unlocked.rows[0]?.unlocked,true); injected = true;
          }
          return result;
        });
      } });
    };
    pool.on('acquire',attach);
    const require = createRequire(import.meta.url), fsModule = require('node:fs/promises') as typeof import('node:fs/promises');
    const originalOpen = fsModule.open;
    const roots = new Set([path.resolve(h.dataRoot),await fs.realpath(h.dataRoot),path.resolve(h.workspaceRoot),await fs.realpath(h.workspaceRoot)]);
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
    syncBuiltinESMExports(); let cases = 0, deniedBeforeHelper = 0, closedHandles = 0;
    try {
      for (const actor of ['agent','mcp'] as const) for (const selected of [false,true]) {
        const target = `late-owner/${actor}-${selected ? 'unlock' : 'control'}.md`, key = randomUUID();
        const before = await h.snapshot(), originalBirths = await births(), originalStorage = await storage();
        fault = selected; injected = false; owner = undefined; spawns = 0; handles = []; tracking = true;
        let failure:unknown, result:Record<string,unknown> | undefined;
        try { result = await call(actor,target,key); } catch (error) { failure = error; } finally { tracking = false; }
        console.log('LATE_OWNER_WINDOW',JSON.stringify({ actor,fault:selected,injected,spawns,failed:!!failure || result?.isError === true }));
        assert.equal(handles.length,2);
        for (const handle of handles) { assert.equal(handle.fd,-1); await assert.rejects(handle.stat(),{ code:'EBADF' }); closedHandles++; }
        if (selected) {
          assert(injected); assert(failure || result?.isError === true);
          assert.equal(spawns,0,'A real owner loss during B Current must be fenced before the first mutating helper starts.');
          assert.deepEqual(await h.snapshot(),before); assert.deepEqual(await births(),originalBirths); assert.deepEqual(await storage(),originalStorage);
          await assert.rejects(fs.lstat(path.join(h.workspaceRoot,target)),{ code:'ENOENT' }); deniedBeforeHelper++;
          fault = false; assert.notEqual((await call(actor,target,key)).isError,true);
        } else { assert(!failure); assert.notEqual(result?.isError,true); assert(spawns > 0); }
        const completed = await h.snapshot(), savedBirths = await births(), savedStorage = await storage();
        assert.notEqual((await call(actor,target,key)).isError,true);
        assert.deepEqual(await h.snapshot(),completed); assert.deepEqual(await births(),savedBirths); assert.deepEqual(await storage(),savedStorage);
        assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot,target)),Buffer.from(content)); cases++;
      }
      assert.equal(cases,4); assert.equal(deniedBeforeHelper,2); assert.equal(closedHandles,8);
      console.log('LATE_OWNER_PROOF',JSON.stringify({ cases,deniedBeforeHelper,closedHandles,actualOwnerUnlockDuringFreshB:true,
        noPositiveSqlOrIoSubstitution:true,originalRowsXminClaimsAnchorsAndBytesRetained:true,explicitSameKeyRetry:true }));
    } finally {
      tracking = false; fsModule.open = originalOpen; childModule.spawn = originalSpawn; syncBuiltinESMExports(); pool.off('acquire',attach);
      for (const [client,descriptor] of descriptors) { if (descriptor) Object.defineProperty(client,'query',descriptor); else Reflect.deleteProperty(client,'query'); }
    }
  });
}
await markdownCreateLateOwnerPostgresTest();
