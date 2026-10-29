import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Actual tool calls and kernel/helper acknowledgements. Positive SQL/IO answers
// are untouched; rights/native faults run on the actual held publication backend.
async function markdownCreatePrivateAcksPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async h => {
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { observeMarkdownCreateBirth, isMarkdownCreateBirthPrivateStorageBoundary } = await import('../app/lib/files/markdown-create-birth');
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
    const domain = async (target: string) => (await h.admin.query(`SELECT to_jsonb(d) AS document,d.xmin::text AS document_xmin,
      to_jsonb(l) AS lineage,l.xmin::text AS lineage_xmin,to_jsonb(y)-'room_owner_token' AS native,y.xmin::text AS native_xmin,
      encode(sha256(convert_to(to_jsonb(y)->>'room_owner_token','UTF8')),'hex') AS room_owner_token_hash,
      to_jsonb(b) AS birth,b.xmin::text AS birth_xmin,to_jsonb(r) AS receipt,r.xmin::text AS receipt_xmin
      FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
      JOIN collaboration_yjs_states y ON y.document_id=d.id
      JOIN collaboration_markdown_create_births b ON b.document_id=d.id
      JOIN collaboration_markdown_file_import_receipts r ON r.workspace_id=b.workspace_id AND r.operation_id=b.operation_id
      WHERE d.workspace_id=$1 AND d.path=$2`, [h.workspaceId, target])).rows;
    const authority = async () => (await h.admin.query('SELECT to_jsonb(u) AS value,u.xmin::text AS xmin FROM "user" u WHERE id=$1', ['reader'])).rows;
    type Fault = { action: string; stage: string; mutation: 'account' | 'sequence' };
    type Action = { name: string; stage: string; target: string; nativeReads: number; authorization: number; currentRightsReads: number;
      inputCopy?: Parameters<typeof isMarkdownCreateBirthPrivateStorageBoundary>[0] };
    const privateStages = new Set(['temp_synced', 'prepared_durable', 'target_linked', 'born_durable', 'complete_durable']);
    let live: Action | undefined, publicationClient: PoolClient | undefined;
    let target = '', operationId = '', fault: Fault | undefined, injected = false, originalDomain: Awaited<ReturnType<typeof domain>> | undefined;
    let checkedPrivateAcks = 0, checkedPublicAcks = 0, lockChecks = 0, activeCopiedInputDenials = 0, cases = 0;
    const mutations: Promise<void>[] = [], mutationErrors: unknown[] = [];
    const descriptors = new Map<PoolClient, PropertyDescriptor | undefined>();
    const attach = (client: PoolClient) => {
      if (descriptors.has(client)) return;
      descriptors.set(client, Object.getOwnPropertyDescriptor(client, 'query')); const original = client.query;
      Object.defineProperty(client, 'query', { configurable: true, writable: true, value: (...args: unknown[]) => {
        const input = args[0], text = typeof input === 'string' ? input
          : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
        if (live?.target === target && privateStages.has(live.stage) && live.inputCopy) {
          // These actual A/pending-operation reads run inside the selected ACK
          // guard, before its context is cleared and stdin is continued.
          assert.equal(isMarkdownCreateBirthPrivateStorageBoundary(live.inputCopy),false,
            'A copied tuple cannot select the active private acknowledgement context.');
          activeCopiedInputDenials++;
        }
        if (typeof text === 'string' && text.includes("r.live_yjs_state_sha256=encode(sha256(y.yjs_state),'hex')")) publicationClient = client;
        if (live?.stage && live.target === target && client === publicationClient) {
          const metrics = Reflect.get(globalThis, Symbol.for('canvas.document-operation-metrics.v1'));
          if (metrics?.context?.getStore()?.phases?.includes('authorization')) live.authorization++;
          if (typeof text === 'string' && /\bSELECT\b/iu.test(text) && /\b(?:pi_sessions|oauth_client)\b/u.test(text)) live.currentRightsReads++;
          if (typeof text === 'string' && /\bFROM\s+(?:collaboration_yjs_states|collaboration_documents|collaboration_markdown_file_import_receipts|file_collaboration_lineages|collaboration_markdown_create_births)\b/iu.test(text)) live.nativeReads++;
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
      assert(!live); const action: Action = { name: '', stage: '', target: '', nativeReads: 0, authorization: 0, currentRightsReads: 0 }; live = action;
      let buffer = '';
      child.stdout!.on('data', chunk => {
        buffer += String(chunk);
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const message = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1);
          if (typeof message.stage === 'string') { action.stage = message.stage; action.nativeReads = action.authorization = action.currentRightsReads = 0; }
        }
      });
      const stream = child.stdin!, write = stream.write;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (!action.name) {
          const message = JSON.parse(String(chunk)); action.name = message.action; action.target = message.intent.targetPath;
          action.inputCopy = { workspaceRoot:h.workspaceRoot,targetPath:message.intent.targetPath,origin:message.intent.origin,
            source:message.intent.source,operationId:message.intent.operationId };
          if (action.target === target) operationId = message.intent.operationId;
        }
        if (String(chunk) !== 'continue\n' || action.target !== target || !['prepare', 'observe', 'complete'].includes(action.name)) {
          return Reflect.apply(write, stream, [chunk,...rest]);
        }
        if (privateStages.has(action.stage)) {
          console.log('PRIVATE_ACK_WINDOW',JSON.stringify({ action:action.name,stage:action.stage,nativeReads:action.nativeReads,
            authorization:action.authorization,currentRightsReads:action.currentRightsReads }));
          assert.equal(action.nativeReads, 0, 'An internal acknowledgement must retain its held phase without repeating the full native snapshot.');
          assert.equal(action.authorization, 0, 'An internal acknowledgement must not repeat the enclosing current-rights observation.');
          assert.equal(action.currentRightsReads, 0, 'Neither actual Agent nor MCP session/account reads repeat inside a private acknowledgement.');
          checkedPrivateAcks++;
        } else if (action.stage === 'before_link') {
          // MCP Current is not tagged with the Agent authorization metric.
          // Check its actual session/account SELECTs on B instead.
          assert(action.nativeReads > 0); assert(action.currentRightsReads > 0); checkedPublicAcks++;
        }
        assert(publicationClient);
        const work = (async () => {
          // A separate actual backend cannot revoke a row locked by this B.
          await h.admin.query('BEGIN');
          try {
            await h.admin.query("SET LOCAL lock_timeout='10ms'");
            await assert.rejects(h.admin.query("UPDATE \"user\" SET banned=1 WHERE id='reader'"), { code: '55P03' }); lockChecks++;
          } finally { await h.admin.query('ROLLBACK'); }
          if (fault && !injected && action.name === fault.action && action.stage === fault.stage) {
            originalDomain = await domain(target); assert.equal(originalDomain.length,1); injected = true;
            const sql = fault.mutation === 'account' ? `UPDATE "${schema}"."user" SET banned=1 WHERE id='reader'`
              : `UPDATE "${schema}".collaboration_yjs_states SET document_sequence=document_sequence+1 WHERE workspace_id=$1 AND path=$2`;
            const result = await Reflect.apply(Object.getPrototypeOf(publicationClient).query, publicationClient,
              [sql, fault.mutation === 'sequence' ? [h.workspaceId,target] : undefined]) as QueryResult;
            assert.equal(result.rowCount,1);
          }
          action.stage = ''; Reflect.apply(write,stream,[chunk,...rest]);
        })();
        mutations.push(work); void work.catch(error => { mutationErrors.push(error); child.kill('SIGKILL'); });
        return true;
      }) as typeof stream.write;
      child.once('close', () => { if (live === action) live = undefined; }); return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    try {
      for (const actor of ['agent','mcp'] as const) {
        const faults: Array<Fault | undefined> = [undefined,
          { action: 'prepare', stage: 'temp_synced', mutation: 'account' },
          { action: 'prepare', stage: 'prepared_durable', mutation: 'sequence' },
          { action: 'observe', stage: 'target_linked', mutation: 'account' },
          { action: 'complete', stage: 'complete_durable', mutation: 'account' }];
        for (const selected of faults) {
          console.log('PRIVATE_ACK_CASE',JSON.stringify({ actor,fault:selected ?? null }));
          fault = selected; injected = false; originalDomain = undefined; publicationClient = undefined; operationId = '';
          target = `private-acks/${actor}-${selected ? `${selected.action}-${selected.stage}-${selected.mutation}` : 'control'}.md`;
          const key = randomUUID(), originalAuthority = await authority();
          let failure: unknown, result: Record<string,unknown> | undefined;
          try { result = await call(actor,target,key); } catch (error) { failure = error; }
          await Promise.all(mutations); assert.deepEqual(mutationErrors,[]);
          if (!selected && (failure || result?.isError)) console.log('PRIVATE_ACK_CONTROL_ERROR',JSON.stringify({ result,
            failure:failure instanceof Error ? { name:failure.name,message:failure.message } : failure }));
          if (!selected) { assert(!failure); assert.notEqual(result?.isError,true); }
          else {
            assert(injected); assert(failure || result?.isError === true, 'Actual same-B drift cannot publish or confirm success.');
            assert.deepEqual(await authority(),originalAuthority); assert.deepEqual(await domain(target),originalDomain);
            if (selected.action === 'prepare') await assert.rejects(fs.lstat(path.join(h.workspaceRoot,target)),{ code: 'ENOENT' });
            else assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot,target)),Buffer.from(content));
            const original = await observeMarkdownCreateBirth({ workspaceRoot:h.workspaceRoot,workspaceId:h.workspaceId,operationId });
            fault = undefined; const resumed = await call(actor,target,key);
            if (resumed.isError === true) console.log('PRIVATE_ACK_RESUME_ERROR',JSON.stringify(resumed));
            assert.notEqual(resumed.isError,true);
            const after = await domain(target); assert.equal(after.length,1); const before = originalDomain![0];
            assert.equal(after[0].document.id,before.document.id); assert.equal(after[0].lineage.id,before.lineage.id);
            assert.deepEqual(after[0].receipt,before.receipt); assert.deepEqual(after[0].native.yjs_state,before.native.yjs_state);
            assert.deepEqual(after[0].native.state_vector,before.native.state_vector);
            const completed = await observeMarkdownCreateBirth({ workspaceRoot:h.workspaceRoot,workspaceId:h.workspaceId,operationId });
            assert(completed.complete); assert.equal(completed.id,original.id); assert.equal(completed.fingerprint,original.fingerprint);
            assert.deepEqual(completed.intent,original.intent);
          }
          assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot,target)),Buffer.from(content)); cases++;
        }
      }
      assert.equal(cases,10); assert(checkedPrivateAcks >= 10); assert(checkedPublicAcks >= 2); assert(lockChecks >= checkedPrivateAcks);
      assert(activeCopiedInputDenials >= checkedPrivateAcks);
      const unrelated = 'private-acks/unrelated-hardlink.md', twin = 'private-acks/unrelated-twin.md';
      await fs.writeFile(path.join(h.workspaceRoot,unrelated),'Unrelated original bytes.\n');
      await fs.link(path.join(h.workspaceRoot,unrelated),path.join(h.workspaceRoot,twin));
      const originalFile = await fs.stat(path.join(h.workspaceRoot,unrelated)), originalBytes = await fs.readFile(path.join(h.workspaceRoot,unrelated));
      const blocked = await call('agent',unrelated,randomUUID()); assert.equal(blocked.isError,true);
      assert.deepEqual(await domain(unrelated),[]);
      for (const name of [unrelated,twin]) {
        const current = await fs.stat(path.join(h.workspaceRoot,name));
        assert.equal(current.ino,originalFile.ino); assert.equal(current.nlink,2);
        assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot,name)),originalBytes);
      }
      console.log('PRIVATE_ACKS_PROOF',JSON.stringify({ cases,checkedPrivateAcks,checkedPublicAcks,lockChecks,activeCopiedInputDenials,
        actualSameBackendFaults:8,originalDataAndRetryIdentityPreserved:true,unrelatedHardlinkStillBlocked:true }));
    } finally {
      childModule.spawn = originalSpawn; syncBuiltinESMExports(); await Promise.allSettled(mutations); pool.off('acquire',attach);
      for (const [client,descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(client,'query',descriptor); else Reflect.deleteProperty(client,'query');
      }
    }
  });
}
await markdownCreatePrivateAcksPostgresTest();
