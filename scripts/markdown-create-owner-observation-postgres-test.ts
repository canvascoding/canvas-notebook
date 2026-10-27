import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Actual tools and helper ACKs, including a real exclusive owner unlock on A.
// No successful database, lease or authorization reply is substituted.
async function publicationOwnerObservationPostgresTest(): Promise<void> {
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
    const baselineOnly = process.env.CANVAS_OWNER_FACTS_BASELINE === '1';
    const ackFacts: Array<{ actor: string; ownerReads: number }> = [];
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
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
      y.yjs_state,y.state_vector,y.lifecycle_generation,y.status,y.degraded,y.projection_error_code,
      y.projection_error_sequence,y.projection_error_generation,y.projection_error_phase,y.projection_error_permanent FROM collaboration_documents d
      JOIN collaboration_yjs_states y ON y.document_id=d.id WHERE d.workspace_id=$1 AND d.path=$2`,
    [h.workspaceId, target])).rows;
    type Action = { name: string; stage: string; proofs: number; nativeReads: number; ownerReads: number; nativeClient?: PoolClient; ownerClient?: PoolClient };
    let live: Action | undefined, actor: 'agent' | 'mcp' = 'mcp', race = false, injected = false, before: unknown;
    let currentTarget = '', checkedAcks = 0;
    let restoreOwnerSearchPath: (() => Promise<void>) | undefined;
    let fault: 'sequence' | 'degraded' | 'permanent' | 'owner' | 'schema' = 'sequence';
    const mutations: Promise<void>[] = [], mutationErrors: unknown[] = [];
    const descriptors = new Map<PoolClient, PropertyDescriptor | undefined>();
    const attach = (client: PoolClient) => {
      if (descriptors.has(client)) return;
      descriptors.set(client, Object.getOwnPropertyDescriptor(client, 'query')); const original = client.query;
      Object.defineProperty(client, 'query', { configurable: true, writable: true, value: (...args: unknown[]) => {
        const input = args[0], text = typeof input === 'string' ? input
          : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
        if (live && typeof text === 'string') {
          const owner = text.startsWith('SELECT realm.*,EXISTS(') && text.includes('pg_catalog.pg_locks');
          const origin = text.includes('type,organization_id,project_id,customer_id,owner_user_id,root_relative_path,status FROM canvas_workspaces WHERE id=$1');
          if (owner || origin) live.ownerReads++;
          if (owner) live.ownerClient = client;
        }
        if (live && typeof text === 'string' && /\bFROM\s+(?:collaboration_yjs_states|collaboration_documents|collaboration_markdown_file_import_receipts|file_collaboration_lineages)\b/iu.test(text)) live.nativeReads++;
        if (live && typeof text === 'string' && text.includes("r.live_yjs_state_sha256=encode(sha256(y.yjs_state),'hex')")) {
          live.proofs++; live.nativeClient = client;
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
      assert(!live); const action: Action = { name: '', stage: '', proofs: 0, nativeReads: 0, ownerReads: 0 }; live = action;
      let buffer = '';
      child.stdout!.on('data', chunk => {
        buffer += String(chunk);
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (typeof message.stage === 'string') { action.stage = message.stage; action.proofs = 0; action.nativeReads = 0; action.ownerReads = 0; }
        }
      });
      const stream = child.stdin!, write = stream.write;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (!action.name) { action.name = JSON.parse(String(chunk)).action; }
        if (String(chunk) === 'continue\n' && action.stage === 'before_link') {
          console.log('OWNER_OBSERVATION_BOUNDARY_CHECK', JSON.stringify({ actor, stage: action.stage, fullNativeProofs: action.proofs, nativeReadStatements: action.nativeReads, ownerReadStatements: action.ownerReads }));
          assert.equal(action.proofs, 1, 'One complete native proof is retained at this actual publication ACK.');
          assert.equal(action.nativeReads, 3, 'One fresh native/receipt read and the two existing strict catalogue reads suffice.');
          if (!baselineOnly) assert(action.ownerReads > 0 && action.ownerReads <= 3, 'A fresh actual owner proof remains, with a bounded number of reads.');
          ackFacts.push({ actor, ownerReads: action.ownerReads }); checkedAcks++;
        }
        if (String(chunk) === 'continue\n' && race && !injected && action.name === 'prepare' && action.stage === 'prepared_durable') {
          assert(action.nativeClient); injected = true;
          const changed = (async () => {
            before = await state(currentTarget); assert.equal((before as unknown[]).length, 1);
            if (fault === 'schema') {
              assert(action.ownerClient); const client = action.ownerClient;
              const actualQuery = Object.getPrototypeOf(client).query;
              const original = await Reflect.apply(actualQuery, client, ["SELECT current_setting('search_path') AS original_path"]) as QueryResult;
              assert.equal(typeof original.rows[0]?.original_path, 'string');
              restoreOwnerSearchPath = async () => {
                try { await Reflect.apply(actualQuery, client, ["SELECT set_config('search_path',$1,false)", [original.rows[0].original_path]]); }
                catch (error) {
                  const actual = client as unknown as { _ending?: boolean; connection?: { stream?: { destroyed?: boolean } } };
                  if (!actual._ending && !actual.connection?.stream?.destroyed) throw error;
                }
              };
              await Reflect.apply(actualQuery, client, ['SET search_path=pg_catalog']);
            } else if (fault === 'owner') {
              assert(action.ownerClient);
              const unlocked = await Reflect.apply(Object.getPrototypeOf(action.ownerClient).query, action.ownerClient,
                ['SELECT pg_advisory_unlock($1::bigint) AS unlocked', [collaborationAdmissionLockKey(h.workspaceId)]]) as QueryResult;
              assert.equal(unlocked.rows[0]?.unlocked, true, 'Release the actual exclusive workspace owner lock.');
            } else {
              const result = await Reflect.apply(Object.getPrototypeOf(action.nativeClient).query, action.nativeClient,
                [`UPDATE "${schema}".collaboration_yjs_states SET ${fault === 'sequence' ? 'document_sequence=document_sequence+1'
                    : fault === 'degraded' ? 'degraded=1'
                    : "projection_error_code='native-observation-test',projection_error_sequence=document_sequence,projection_error_generation=lifecycle_generation,projection_error_phase='publish',projection_error_permanent=1"}
                  WHERE workspace_id=$1 AND path=$2 RETURNING document_id`, [h.workspaceId, currentTarget]]) as QueryResult;
              assert.equal(result.rowCount, 1, 'Change the actual native version on the genuine held publication connection.');
            }
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
        if (baselineOnly) continue;
        for (const selectedFault of ['sequence', 'degraded', 'permanent', 'owner', 'schema'] as const) {
          restoreOwnerSearchPath = undefined; fault = selectedFault; currentTarget = `native-observation/${actor}-${fault}.md`; race = true; injected = false; before = undefined;
          const key = randomUUID(); let failed: unknown, result: Record<string, unknown> | undefined;
          try { result = await call(actor, currentTarget, key); } catch (error) { failed = error; }
          await Promise.all(mutations); assert(injected); assert.deepEqual(mutationErrors, []);
          if (fault === 'schema') {
            const restore = restoreOwnerSearchPath as (() => Promise<void>) | undefined; assert(restore); await restore();
          }
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
      }
      assert.equal(checkedAcks, baselineOnly ? 2 : 12); assert(!live);
      console.log('OWNER_OBSERVATION_PROOF', JSON.stringify({ actors: 2, checkedPublicationAcks: checkedAcks,
        actualNativeFaults: baselineOnly ? 0 : 6, actualOwnerLosses: baselineOnly ? 0 : 2, actualSchemaDrifts: baselineOnly ? 0 : 2, ackFacts, retainedFullNativeFence: true, originalNativeIdsBytesClockRestored: true, explicitRetrySameIdentity: !baselineOnly }));
    } finally {
      childModule.spawn = originalSpawn; syncBuiltinESMExports(); await Promise.allSettled(mutations);
      pool.off('acquire', attach);
      for (const [client, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(client, 'query', descriptor); else Reflect.deleteProperty(client, 'query');
      }
    }
  });
}
await publicationOwnerObservationPostgresTest();
