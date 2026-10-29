import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { isMarkdownCreateBirthVerification, isMarkdownCreateBirthVerificationOperation,
  type MarkdownCreateBirthStorageInput } from '../app/lib/files/markdown-create-birth';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Real tools, SQL and child results. Hold only delivery while actually revoking
// rights after native COMMIT or publication COMMIT; never synthesize authority.
async function markdownCreateReadonlyPhasePostgresTest(): Promise<void> {
  const foreign = new Proxy({} as MarkdownCreateBirthStorageInput,
    { get() { throw new Error('A foreign input must not be read by a private-message predicate.'); } });
  assert.equal(isMarkdownCreateBirthVerification(foreign), false);
  assert.equal(isMarkdownCreateBirthVerificationOperation(foreign, async () => undefined), false);
  await withDocumentReadToolDispatchFixture(async h => {
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { observeMarkdownCreateBirth } = await import('../app/lib/files/markdown-create-birth');
    const pool = getPostgresRuntimeQueryable() as unknown as Pool;
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge,create_knowledge_source';
    await h.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
    await h.admin.query('UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2',
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), h.clientId]);
    await h.setPiEnabledTools(['write']);
    const token = await h.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
    const content = '# Read-only phase\n\nOriginal content äöü 😀.\n';
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
    type Fault = 'before-publication' | 'after-publication';
    let fault: Fault | undefined, target = '', injected = false, nativeCommitted = false, publicationCommitted = false;
    let intermediateClosed = false, standaloneBegins = 0, operationId = '', heldCloses = 0, publicationRevocations = 0;
    let before: unknown, copiedInput: MarkdownCreateBirthStorageInput | undefined;
    let foreignSelectionChecks = 0;
    const native = new Set<PoolClient>(), publication = new Set<PoolClient>();
    const pending: Promise<void>[] = [], errors: unknown[] = [];
    const revoke = async () => {
      const rows = await observe(target); assert.equal(rows.length, 1); before = rows;
      assert.equal((await h.admin.query("UPDATE \"user\" SET banned=1 WHERE id='reader'")).rowCount, 1); injected = true;
    };
    const descriptors = new Map<PoolClient, PropertyDescriptor | undefined>();
    const attach = (client: PoolClient) => {
      if (descriptors.has(client)) return;
      descriptors.set(client, Object.getOwnPropertyDescriptor(client, 'query')); const original = client.query;
      Object.defineProperty(client, 'query', { configurable: true, writable: true, value: (...args: unknown[]) => {
        if (copiedInput) {
          assert.equal(isMarkdownCreateBirthVerification(copiedInput), false);
          assert.equal(isMarkdownCreateBirthVerificationOperation(copiedInput, async () => undefined), false);
          assert.equal(isMarkdownCreateBirthVerification(foreign), false); foreignSelectionChecks++;
        }
        const input = args[0], text = typeof input === 'string' ? input
          : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
        if (typeof text === 'string') {
          if (/^BEGIN\b/u.test(text.trim())) {
            native.delete(client); publication.delete(client);
            if (nativeCommitted && !intermediateClosed) standaloneBegins++;
          }
        }
        const actual = Reflect.apply(original, client, args);
        if (!actual || typeof actual.then !== 'function') return actual;
        return actual.then(async (result: QueryResult) => {
          if (typeof text !== 'string') return result;
          if (/\bINSERT INTO collaboration_documents\b/u.test(text)) native.add(client);
          if (text.includes('UPDATE collaboration_markdown_create_births SET finalized=1')) publication.add(client);
          if (text.trim() === 'COMMIT' && result.command === 'COMMIT') {
            if (native.delete(client)) nativeCommitted = true;
            if (publication.delete(client)) {
              publicationCommitted = true;
              if (fault === 'after-publication' && !injected) { await revoke(); publicationRevocations++; }
            }
          }
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
      let action = '', selected = '';
      const stream = child.stdin!, write = stream.write;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (!action) {
          const message = JSON.parse(String(chunk)); action = message.action; selected = message.intent.targetPath;
          copiedInput = { workspaceRoot: h.workspaceRoot, targetPath: selected, origin: message.intent.origin,
            source: message.intent.source, operationId: message.intent.operationId };
          assert.equal(isMarkdownCreateBirthVerificationOperation(copiedInput, async () => undefined), false);
          if (selected === target) operationId = message.intent.operationId;
        }
        return Reflect.apply(write, stream, [chunk, ...rest]);
      }) as typeof stream.write;
      const emit = child.emit;
      child.emit = ((event: string | symbol, ...values: unknown[]) => {
        if (event !== 'close' || action !== 'verify' || selected !== target || !nativeCommitted
          || publicationCommitted || intermediateClosed) return Reflect.apply(emit, child, [event, ...values]);
        intermediateClosed = true;
        if (fault !== 'before-publication' || injected) return Reflect.apply(emit, child, [event, ...values]);
        heldCloses++; const change = revoke(); pending.push(change);
        void change.then(() => { Reflect.apply(emit, child, [event, ...values]); }, error => {
          errors.push(error); Reflect.apply(emit, child, [event, ...values]);
        });
        return true;
      }) as typeof child.emit;
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports(); let cases = 0;
    try {
      for (const actor of ['mcp', 'agent'] as const) {
        for (const selected of [undefined, 'before-publication', 'after-publication'] as const) {
          fault = selected; target = `readonly-phase/${actor}-${selected ?? 'control'}.md`;
          injected = nativeCommitted = publicationCommitted = intermediateClosed = false;
          standaloneBegins = 0; operationId = ''; before = undefined; const key = randomUUID();
          let failure: unknown, result: Record<string, unknown> | undefined;
          try { result = await call(actor, target, key); } catch (error) { failure = error; }
          await Promise.all(pending); assert.deepEqual(errors, []);
          assert(intermediateClosed, 'Observe the actual historical verify after native COMMIT.');
          assert.equal(standaloneBegins, 0, 'Historical read-only verification must not open a new SQL/Principal phase.');
          if (!selected) { assert(!failure); assert.notEqual(result?.isError, true); }
          else {
            assert(injected); assert(failure || result?.isError === true, 'Committed revocation cannot return successful completion.');
            assert(Array.isArray(before)); assert.deepEqual(await observe(target), before, 'Denial preserves all original rows/xmin and bytes.');
            if (selected === 'before-publication') {
              assert.equal(publicationCommitted, false);
              await assert.rejects(fs.lstat(path.join(h.workspaceRoot, target)), { code: 'ENOENT' });
            } else assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, target)), Buffer.from(content));
            const original = await observeMarkdownCreateBirth({ workspaceRoot: h.workspaceRoot, workspaceId: h.workspaceId, operationId });
            await h.admin.query("UPDATE \"user\" SET banned=0 WHERE id='reader'"); fault = undefined;
            assert.notEqual((await call(actor, target, key)).isError, true);
            const after = await observe(target); assert.equal(after.length, 1);
            assert.equal(after[0].document.id, before[0].document.id); assert.equal(after[0].document.lineage_id, before[0].document.lineage_id);
            assert.equal(after[0].birth.operation_id, before[0].birth.operation_id); assert.equal(after[0].birth.claim_id, before[0].birth.claim_id);
            assert.deepEqual(after[0].native.yjs_state, before[0].native.yjs_state); assert.deepEqual(after[0].native.state_vector, before[0].native.state_vector);
            assert.deepEqual(after[0].receipt, before[0].receipt); assert.equal(after[0].receipt_xmin, before[0].receipt_xmin);
            if (selected === 'after-publication') assert.deepEqual(after, before, 'Completed retry performs no new document mutation.');
            const settled = await observeMarkdownCreateBirth({ workspaceRoot: h.workspaceRoot, workspaceId: h.workspaceId, operationId });
            assert.equal(settled.complete, true); assert.equal(settled.id, original.id); assert.deepEqual(settled.intent, original.intent);
          }
          assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, target)), Buffer.from(content)); cases++;
        }
      }
      assert.equal(cases, 6); assert.equal(heldCloses, 2); assert.equal(publicationRevocations, 2);
      assert(foreignSelectionChecks > 0);
      console.log('READONLY_PHASE_PROOF', JSON.stringify({ cases, historicalVerifyStartsSqlPhase: false,
        foreignSelectionsRejected: foreignSelectionChecks,
        realPrepublicationRevocations: heldCloses, realPostCommitRevocations: publicationRevocations,
        freshFinalConfirmation: true, originalIdentityBytesAndReceiptPreserved: true, explicitRetrySameIdentity: true }));
    } finally {
      await Promise.allSettled(pending); childModule.spawn = originalSpawn; syncBuiltinESMExports(); pool.off('acquire', attach);
      for (const [client, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(client, 'query', descriptor); else Reflect.deleteProperty(client, 'query');
      }
      await h.admin.query("UPDATE \"user\" SET banned=0 WHERE id='reader'");
    }
  });
}
await markdownCreateReadonlyPhasePostgresTest();
