import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Actual registered tools, helper ACKs and same-B SQL mutations. Positive
// replies, original identities and native contents are never manufactured.
async function markdownCreateBirthRealmObservationPostgresTest(): Promise<void> {
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
    const content = '# Original birth realm\n\nOriginal body äöü 😀.\n';
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
      to_jsonb(b) AS birth,b.xmin::text AS birth_xmin,to_jsonb(r) AS receipt,r.xmin::text AS receipt_xmin
      FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
      JOIN collaboration_yjs_states y ON y.document_id=d.id
      JOIN collaboration_markdown_create_births b ON b.document_id=d.id
      JOIN collaboration_markdown_file_import_receipts r ON r.workspace_id=b.workspace_id AND r.operation_id=b.operation_id
      WHERE d.workspace_id=$1 AND d.path=$2`, [h.workspaceId, target])).rows;
    type Fault = 'search-path' | 'relation-shadow' | 'missing-birth' | 'claim' | 'generation';
    let fault: Fault | undefined, pendingFault = false, injected = false, currentTarget = '';
    let joined = 0, standalone = 0, checkedAcks = 0, before: unknown;
    const descriptors = new Map<PoolClient, PropertyDescriptor | undefined>();
    const attach = (client: PoolClient) => {
      if (descriptors.has(client)) return;
      descriptors.set(client, Object.getOwnPropertyDescriptor(client, 'query')); const original = client.query;
      Object.defineProperty(client, 'query', { configurable: true, writable: true, value: (...args: unknown[]) => {
        const input = args[0], text = typeof input === 'string' ? input
          : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
        if (typeof text !== 'string') return Reflect.apply(original, client, args);
        if (/^\s*SELECT \* FROM collaboration_markdown_create_births WHERE workspace_id=/u.test(text)) standalone++;
        if (!text.includes('AS __canvas_birth_row_present')) return Reflect.apply(original, client, args);
        joined++;
        if (!pendingFault) return Reflect.apply(original, client, args);
        pendingFault = false;
        return (async () => {
          const originalRows = await observe(currentTarget); assert.equal(originalRows.length, 1); assert.equal(originalRows[0].birth.finalized, 0);
          before = originalRows;
          const mutate = (sql: string, values?: unknown[]) => Reflect.apply(original, client, [sql, values]) as Promise<QueryResult>;
          if (fault === 'search-path') await mutate('SET LOCAL search_path=pg_catalog');
          else if (fault === 'relation-shadow') {
            await mutate(`ALTER TABLE "${schema}".collaboration_markdown_create_births RENAME TO birth_realm_original`);
            await mutate(`CREATE TEMP TABLE collaboration_markdown_create_births (LIKE "${schema}".birth_realm_original INCLUDING ALL)`);
          } else {
            // The normal trigger already forbids these corruptions. Exercise
            // the independent reader as well, with actual owner-level DDL/DML
            // inside B; the failed transaction restores the trigger and rows.
            await mutate(`ALTER TABLE "${schema}".collaboration_markdown_create_births DISABLE TRIGGER markdown_create_birth_guard`);
            const changed = await mutate(`${fault === 'missing-birth' ? 'DELETE FROM' : 'UPDATE'} "${schema}".collaboration_markdown_create_births
              ${fault === 'claim' ? "SET claim_fingerprint=repeat('f',64)" : fault === 'generation' ? 'SET lifecycle_generation=lifecycle_generation+1' : ''}
              WHERE document_id=(SELECT id FROM "${schema}".collaboration_documents WHERE workspace_id=$1 AND path=$2)`,
            [h.workspaceId, currentTarget]); assert.equal(changed.rowCount, 1);
          }
          injected = true; return Reflect.apply(original, client, args);
        })();
      } });
    };
    pool.on('acquire', attach);
    const childModule = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
    const originalSpawn = childModule.spawn;
    childModule.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const child = originalSpawn(...args);
      if (!Array.isArray(args[1]) || !args[1].some(value => String(value).endsWith('/markdown-create-birth.py'))) return child;
      let action = '', stage = '', buffer = '';
      child.stdout!.on('data', chunk => {
        buffer += String(chunk);
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (typeof message.stage === 'string') { stage = message.stage; if (stage === 'before_link') joined = standalone = 0; }
        }
      });
      const stream = child.stdin!, write = stream.write;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (!action) action = JSON.parse(String(chunk)).action;
        if (String(chunk) === 'continue\n' && action === 'prepare' && stage === 'prepared_durable' && fault && !injected) pendingFault = true;
        if (String(chunk) === 'continue\n' && stage === 'before_link') {
          assert.equal(standalone, 0, 'An ACK must not repeat the separate birth-row read.');
          assert.equal(joined, 1, 'The actual publication ACK retains one fresh combined realm/birth observation.'); checkedAcks++;
        }
        return Reflect.apply(write, stream, [chunk, ...rest]);
      }) as typeof stream.write;
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports(); let cases = 0;
    try {
      for (const actor of ['mcp', 'agent'] as const) {
        currentTarget = `birth-realm/${actor}-control.md`;
        assert.notEqual((await call(actor, currentTarget, randomUUID())).isError, true);
        assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, currentTarget)), Buffer.from(content)); cases++;
        if (actor === 'mcp') {
          // User-added row columns must not replace trusted realm/presence
          // aliases. All subsequent faults and successful retries retain them.
          await h.admin.query(`ALTER TABLE collaboration_markdown_create_births
            ADD COLUMN __canvas_birth_realm_same boolean DEFAULT false,
            ADD COLUMN __canvas_birth_realm_schema text DEFAULT 'foreign-schema',
            ADD COLUMN __canvas_birth_row_present boolean DEFAULT false`);
        }
        for (const selected of ['search-path', 'relation-shadow', 'missing-birth', 'claim', 'generation'] as const) {
          fault = selected; injected = pendingFault = false; before = undefined;
          currentTarget = `birth-realm/${actor}-${selected}.md`; const key = randomUUID();
          let failure: unknown, result: Record<string, unknown> | undefined;
          try { result = await call(actor, currentTarget, key); } catch (error) { failure = error; }
          assert(injected, `The actual ${selected} SQL mutation must run on B.`);
          assert(failure || result?.isError === true, 'Changed realm or original birth facts cannot publish.');
          await assert.rejects(fs.lstat(path.join(h.workspaceRoot, currentTarget)), { code: 'ENOENT' });
          assert.deepEqual(await observe(currentTarget), before, 'Rollback preserves every original row/xmin, native bytes and receipt.');
          assert.deepEqual((await h.admin.query(`SELECT tgenabled FROM pg_trigger
            WHERE tgrelid=to_regclass($1) AND tgname='markdown_create_birth_guard'`,
          [`${schema}.collaboration_markdown_create_births`])).rows, [{ tgenabled: 'O' }],
          'The actual original immutability trigger must be restored after every fault.');
          fault = undefined;
          assert.notEqual((await call(actor, currentTarget, key)).isError, true);
          const after = await observe(currentTarget); assert.equal(after.length, 1); assert(Array.isArray(before)); assert.equal(before.length, 1);
          assert.equal(after[0].document.id, before[0].document.id); assert.equal(after[0].document.lineage_id, before[0].document.lineage_id);
          assert.equal(after[0].birth.operation_id, before[0].birth.operation_id); assert.equal(after[0].birth.claim_id, before[0].birth.claim_id);
          assert.deepEqual(after[0].native.yjs_state, before[0].native.yjs_state); assert.deepEqual(after[0].native.state_vector, before[0].native.state_vector);
          assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, currentTarget)), Buffer.from(content)); cases++;
        }
      }
      assert.equal(cases, 12); assert.equal(checkedAcks, 12);
      console.log('BIRTH_REALM_OBSERVATION_PROOF', JSON.stringify({ cases, actualSameBackendFaults: 10,
        checkedPublicationAcks: checkedAcks, trustedAliasCollisionsTested: true, originalTriggerRestored: true,
        originalIdentityRowsXminBytesAndReceiptPreserved: true, retrySameOriginalOperation: true }));
    } finally {
      childModule.spawn = originalSpawn; syncBuiltinESMExports(); pool.off('acquire', attach);
      for (const [client, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(client, 'query', descriptor); else Reflect.deleteProperty(client, 'query');
      }
    }
  });
}
await markdownCreateBirthRealmObservationPostgresTest();
