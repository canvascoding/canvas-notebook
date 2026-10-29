import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Actual registered tools and actual helper ACKs. A same-B version change after
// staging must be caught by the retained fresh native fence before publication.
async function publicationBoundariesPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async h => {
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const pool = getPostgresRuntimeQueryable() as unknown as Pool; assert(pool);
    const schema = (await h.admin.query('SELECT current_schema() AS schema')).rows[0].schema as string;
    assert.match(schema, /^[a-z0-9_]+$/u);
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge,create_knowledge_source';
    await h.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
    await h.admin.query('UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2',
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), h.clientId]);
    await h.setPiEnabledTools(['write']);
    const token = await h.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
    const content = '# Original publication\n\nOriginal body äöü 😀.\n';
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
    const state = async (target: string) => (await h.admin.query(`SELECT d.id,d.lineage_id,y.document_sequence,
      y.yjs_state,y.state_vector,y.lifecycle_generation,y.status FROM collaboration_documents d
      JOIN collaboration_yjs_states y ON y.document_id=d.id WHERE d.workspace_id=$1 AND d.path=$2`,
    [h.workspaceId, target])).rows;
    type Action = { name: string; stage: string; proofs: number; nativeClient?: PoolClient };
    let live: Action | undefined, actor: 'agent' | 'mcp' = 'mcp', race = false, injected = false, before: unknown;
    let latestNativeClient: PoolClient | undefined;
    let currentTarget = '', checkedAcks = 0;
    const mutations: Promise<void>[] = [], mutationErrors: unknown[] = [];
    const descriptors = new Map<PoolClient, PropertyDescriptor | undefined>();
    const attach = (client: PoolClient) => {
      if (descriptors.has(client)) return;
      descriptors.set(client, Object.getOwnPropertyDescriptor(client, 'query')); const original = client.query;
      Object.defineProperty(client, 'query', { configurable: true, writable: true, value: (...args: unknown[]) => {
        const input = args[0], text = typeof input === 'string' ? input
          : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
        if (typeof text === 'string' && text.includes("r.live_yjs_state_sha256=encode(sha256(y.yjs_state),'hex')")) {
          latestNativeClient = client;
          if (live) { live.proofs++; live.nativeClient = client; }
        }
        return Reflect.apply(original, client, args);
      } });
    };
    pool.on('acquire', attach);
    const childModule = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
    const originalSpawn = childModule.spawn;
    childModule.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const child = originalSpawn(...args);
      if (!Array.isArray(args[1]) || !args[1].some(value => String(value).endsWith('/markdown-create-birth.py'))) return child;
      // Reuse the real entry observation as the injection handle; assertions
      // still require a fresh full proof at the actual before-link ACK.
      assert(!live); const action: Action = { name: '', stage: '', proofs: 0,
        nativeClient: latestNativeClient }; live = action;
      let buffer = '';
      child.stdout!.on('data', chunk => {
        buffer += String(chunk);
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (typeof message.stage === 'string') { action.stage = message.stage; action.proofs = 0; }
        }
      });
      const stream = child.stdin!, write = stream.write;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (!action.name) { action.name = JSON.parse(String(chunk)).action; }
        if (String(chunk) === 'continue\n' && action.stage === 'before_link') {
          console.log('PUBLICATION_BOUNDARY_CHECK', JSON.stringify({ actor, stage: action.stage, fullNativeProofs: action.proofs }));
          assert.equal(action.proofs, 1, 'One complete native proof is retained at this actual publication ACK.'); checkedAcks++;
        }
        if (String(chunk) === 'continue\n' && race && !injected && action.name === 'prepare' && action.stage === 'prepared_durable') {
          assert(action.nativeClient); injected = true;
          const changed = (async () => {
            before = await state(currentTarget); assert.equal((before as unknown[]).length, 1);
            const result = await Reflect.apply(Object.getPrototypeOf(action.nativeClient).query, action.nativeClient,
              [`UPDATE "${schema}".collaboration_yjs_states SET document_sequence=document_sequence+1
                WHERE workspace_id=$1 AND path=$2 RETURNING document_id`, [h.workspaceId, currentTarget]]) as QueryResult;
            assert.equal(result.rowCount, 1, 'Change the actual native version on the genuine held publication connection.');
            Reflect.apply(write, stream, [chunk, ...rest]);
          })();
          mutations.push(changed); void changed.catch(error => { mutationErrors.push(error); child.kill('SIGKILL'); });
          return true;
        }
        return Reflect.apply(write, stream, [chunk, ...rest]);
      }) as typeof stream.write;
      child.once('close', () => { if (live === action) live = undefined; });
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    try {
      for (const selected of ['mcp', 'agent'] as const) {
        actor = selected; currentTarget = `publication-boundary/${actor}-control.md`;
        const control = await call(actor, currentTarget, randomUUID()); assert.notEqual(control.isError, true);
        assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, currentTarget)), Buffer.from(content));
        currentTarget = `publication-boundary/${actor}-version-race.md`; race = true; injected = false; before = undefined;
        const key = randomUUID(); let failed: unknown, result: Record<string, unknown> | undefined;
        try { result = await call(actor, currentTarget, key); } catch (error) { failed = error; }
        await Promise.all(mutations); assert(injected); assert.deepEqual(mutationErrors, []);
        assert(failed || result?.isError === true, 'A native version race cannot return a successful creation.');
        await assert.rejects(fs.lstat(path.join(h.workspaceRoot, currentTarget)), { code: 'ENOENT' });
        assert.deepEqual(await state(currentTarget), before, 'Rollback preserves the committed original native IDs, bytes, vector and clock.');
        race = false;
        const resumed = await call(actor, currentTarget, key); assert.notEqual(resumed.isError, true);
        const after = await state(currentTarget); assert.equal(after.length, 1);
        assert.equal(after[0].id, (before as typeof after)[0].id); assert.equal(after[0].lineage_id, (before as typeof after)[0].lineage_id);
        assert.deepEqual(after[0].yjs_state, (before as typeof after)[0].yjs_state);
        assert.deepEqual(after[0].state_vector, (before as typeof after)[0].state_vector);
        assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, currentTarget)), Buffer.from(content));
      }
      assert.equal(checkedAcks, 4); assert(!live);
      console.log('PUBLICATION_BOUNDARIES_PROOF', JSON.stringify({ actors: 2, checkedPublicationAcks: checkedAcks,
        actualVersionRaces: 2, retainedFullNativeFence: true, originalNativeIdsBytesClockRestored: true, explicitRetrySameIdentity: true }));
    } finally {
      childModule.spawn = originalSpawn; syncBuiltinESMExports(); await Promise.allSettled(mutations);
      pool.off('acquire', attach);
      for (const [client, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(client, 'query', descriptor); else Reflect.deleteProperty(client, 'query');
      }
    }
  });
}
await publicationBoundariesPostgresTest();
