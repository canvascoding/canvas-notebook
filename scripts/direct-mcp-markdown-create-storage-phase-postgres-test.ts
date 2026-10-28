import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Genuine MCP transport, user/token and original SQL replies. Observe real
// helper ACKs; only an actual completed COMMIT acknowledgement can be lost.
async function directMcpMarkdownCreateStoragePhasePostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async h => {
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { observeMarkdownCreateBirth } = await import('../app/lib/files/markdown-create-birth');
    const pool = getPostgresRuntimeQueryable() as unknown as Pool; assert(pool);
    const schema = (await h.admin.query('SELECT current_schema() AS schema')).rows[0].schema as string;
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge,create_knowledge_source';
    await h.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
    await h.admin.query('UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2',
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), h.clientId]);
    const token = await h.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
    const content = '# Actual MCP storage phase\n\nOriginal content äöü 😀.\n';
    let rpcId = 0;
    const call = async (target: string, key: string) => {
      const id = ++rpcId;
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'create_knowledge_source',
        arguments: { workspace_id: h.workspaceId, path: target, content, idempotency_key: key } } }) }));
      assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.id, id);
      assert(!body.error); return body.result as Record<string, unknown>;
    };
    const targetRows = async (target: string) => (await h.admin.query(`SELECT d.id,d.lineage_id,to_jsonb(d) AS registry,
      d.xmin::text AS registry_xmin,to_jsonb(y) AS native,y.xmin::text AS native_xmin,
      to_jsonb(r) AS receipt,r.xmin::text AS receipt_xmin,to_jsonb(b) AS birth,b.xmin::text AS birth_xmin
      FROM collaboration_documents d LEFT JOIN collaboration_yjs_states y ON y.document_id=d.id
      LEFT JOIN collaboration_markdown_create_births b ON b.document_id=d.id
      LEFT JOIN collaboration_markdown_file_import_receipts r ON r.operation_id=b.operation_id AND r.workspace_id=d.workspace_id
      WHERE d.workspace_id=$1 AND d.path=$2 ORDER BY d.id`, [h.workspaceId, target])).rows;
    type Identity = { client: PoolClient; xid: string; backend: number; start: string };
    type Action = { action: string; target: string; operationId: string; identity: Identity; transactions: Set<string>; observations: number;
      stages: number; closed: boolean; lockChecked: boolean };
    const actions: Action[] = [], ackChecks: Promise<void>[] = [], ackFailures: unknown[] = [];
    let latest: Identity | undefined, live: Action | undefined, blocked = 0, revoke = false, revoked = false;
    let freshBannedReads = 0;
    let lose: 'open' | 'verify' | undefined, lost: (Identity & { operationId: string }) | undefined, helpersAtLoss = 0;
    const commitObservations: Array<{ wanted: string; action?: string; closed: boolean; sameClient: boolean;
      sameXid: boolean; domainDml: boolean; nativeCount?: number }> = [];
    const transactions = new Map<PoolClient, string>();
    const dml = new Set<PoolClient>();
    const descriptors = new Map<PoolClient, PropertyDescriptor | undefined>();
    const observe = async (client: PoolClient, text: string, result: QueryResult) => {
      if (/^BEGIN\b/u.test(text.trim())) { transactions.delete(client); dml.delete(client); }
      if (/^(?:INSERT|UPDATE|DELETE|WITH)\b/u.test(text.trim())) dml.add(client);
      const rows = Array.isArray(result.rows) ? result.rows : [];
      const row = rows[0]?.facts ?? rows[0];
      if (revoked && row?.raw_id === 'reader' && row.raw_banned === 1 && row.user_banned === 1) freshBannedReads++;
      if (row?.schema === schema && typeof row.xid === 'string' && typeof row.start === 'string') {
        latest = { client, xid: row.xid, backend: Number(row.backend), start: row.start };
        transactions.set(client, row.xid);
        if (live) { live.transactions.add(`${latest.backend}:${latest.xid}`); live.observations++; }
      }
      const action = actions.at(-1);
      const commit = text.trim() === 'COMMIT' && lose ? { wanted: lose, action: action?.action, closed: action?.closed === true,
        sameClient: action?.identity.client === client, sameXid: transactions.get(client) === action?.identity.xid,
        domainDml: dml.has(client) } : undefined;
      if (commit) commitObservations.push(commit);
      if (text.trim() !== 'COMMIT' || result.command !== 'COMMIT' || !action?.closed
        || action.identity.client !== client || transactions.get(client) !== action.identity.xid) return;
      if (revoke && !revoked && action.action === 'open') {
        assert.equal((await h.admin.query("UPDATE \"user\" SET banned=1 WHERE id='reader'")).rowCount, 1); revoked = true;
      }
      if (lose === action.action && !lost && !dml.has(client)) {
        const nativeCount = (await targetRows(action.target)).length;
        if (commit) Reflect.set(commit, 'nativeCount', nativeCount);
        if (lose === 'verify' && nativeCount === 0) return;
        lost = { ...action.identity, operationId: action.operationId }; helpersAtLoss = actions.length;
        throw Object.assign(new Error('Lost actual MCP storage-action COMMIT acknowledgement.'), { code: 'FIXTURE_ACK_LOST' });
      }
    };
    const attach = (client: PoolClient) => {
      if (descriptors.has(client)) return;
      descriptors.set(client, Object.getOwnPropertyDescriptor(client, 'query'));
      const original = client.query;
      Object.defineProperty(client, 'query', { configurable: true, writable: true, value: (...args: unknown[]) => {
        const answer = Reflect.apply(original, client, args);
        // Callback/cursor forms retain their exact driver behavior. This probe
        // observes only the genuine Promise SQL used by held native phases.
        if (!answer || typeof answer.then !== 'function') return answer;
        const input = args[0], text = typeof input === 'string' ? input
          : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
        return answer.then(async (result: QueryResult) => {
          if (typeof text === 'string') await observe(client, text, result);
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
      assert(!live); assert(latest);
      const action: Action = { action: 'unobserved', target: '', operationId: '', identity: latest, transactions: new Set([`${latest.backend}:${latest.xid}`]),
        observations: 1, stages: 0, closed: false, lockChecked: false };
      actions.push(action); live = action;
      const stream = child.stdin!, write = stream.write;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (action.action === 'unobserved') {
          const message = JSON.parse(String(chunk)); assert(['open', 'verify', 'prepare', 'observe', 'complete'].includes(message.action));
          assert.equal(typeof message.intent.targetPath, 'string'); action.action = message.action; action.target = message.intent.targetPath;
          assert.equal(typeof message.intent.operationId, 'string'); action.operationId = message.intent.operationId;
        }
        if (String(chunk) === 'continue\n' && action.action === 'open' && !action.lockChecked) {
          action.lockChecked = true;
          const checked = (async () => {
            let code: unknown;
            await h.admin.query('BEGIN');
            try {
              await h.admin.query("SET LOCAL lock_timeout='50ms'");
              await h.admin.query("UPDATE \"user\" SET banned=1 WHERE id='reader'");
            } catch (error) { code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined; }
            finally { await h.admin.query('ROLLBACK'); }
            assert.equal(code, '55P03', 'Authority locks must span the real paused helper ACK.'); blocked++;
            Reflect.apply(write, stream, [chunk, ...rest]);
          })();
          ackChecks.push(checked); void checked.catch(error => { ackFailures.push(error); child.kill('SIGKILL'); });
          return true;
        }
        return Reflect.apply(write, stream, [chunk, ...rest]);
      }) as typeof stream.write;
      let buffer = '';
      child.stdout!.on('data', chunk => {
        buffer += String(chunk);
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (typeof message.stage === 'string') action.stages++;
        }
      });
      child.once('close', () => { action.closed = true; if (live === action) live = undefined; });
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    try {
      const target = 'mcp-storage/control.md', key = randomUUID(), first = await call(target, key);
      if (first.isError) console.error('MCP_STORAGE_BASELINE_DIAGNOSTIC', JSON.stringify({
        code: (first.structuredContent as Record<string, unknown> | undefined)?.code,
        actions: actions.map(action => ({ action: action.action, transactions: action.transactions.size, closed: action.closed })),
        ackFailures: ackFailures.map(error => error instanceof Error ? error.message : 'non-error'),
      }));
      assert.notEqual(first.isError, true); const receipt = first.structuredContent as Record<string, unknown>;
      const before = await targetRows(target); assert.equal(before.length, 1);
      const again = await call(target, key); assert.notEqual(again.isError, true);
      assert.equal((again.structuredContent as Record<string, unknown>).operation_id, receipt.operation_id);
      assert.deepEqual(await targetRows(target), before); assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, target)), Buffer.from(content));
      revoke = true;
      const deniedTarget = 'mcp-storage/revoked.md', denied = await call(deniedTarget, randomUUID());
      assert.equal(denied.isError, true); assert(revoked);
      const detail = denied.structuredContent as Record<string, unknown> | undefined;
      const challenge = (denied._meta as Record<string, unknown> | undefined)?.['mcp/www_authenticate'];
      console.log('MCP_STORAGE_NEXT_PHASE_DENIAL', JSON.stringify({ revoked, freshBannedReads,
        code: detail?.code, challenge: Array.isArray(challenge) }));
      assert(freshBannedReads > 0, 'The next phase must actually reread the committed account ban.');
      // Multiple authentic denial/closure failures can be aggregated and masked
      // by the public tool adapter. Verify the real fresh denial facts as well.
      assert(detail?.code === 'MCP_READ_PRINCIPAL_ACCESS_DENIED' || detail?.code === 'MCP_INGEST_FAILED' || Array.isArray(challenge));
      assert.equal((await targetRows(deniedTarget)).length, 0);
      assert.equal((await h.admin.query(`SELECT count(*)::integer AS n FROM collaboration_markdown_file_import_receipts
        WHERE workspace_id=$1 AND private_result->'target'->>'path'=$2`, [h.workspaceId, deniedTarget])).rows[0].n, 0);
      await assert.rejects(fs.lstat(path.join(h.workspaceRoot, deniedTarget)), { code: 'ENOENT' });
      await h.admin.query("UPDATE \"user\" SET banned=0 WHERE id='reader'"); revoke = false;
      for (const action of ['open', 'verify'] as const) {
        const partialTarget = `mcp-storage/lost-${action}.md`, retryKey = randomUUID();
        lose = action; lost = undefined; commitObservations.length = 0;
        const failed = await call(partialTarget, retryKey);
        console.log('MCP_STORAGE_COMMIT_LOSS_DIAGNOSTIC', JSON.stringify({ wanted: action, lost: !!lost,
          commits: commitObservations, actions: actions.filter(value => value.target === partialTarget)
            .map(value => ({ action: value.action, transactions: value.transactions.size, closed: value.closed })) }));
        assert.equal(failed.isError, true); assert.equal((failed.structuredContent as Record<string, unknown>).code, 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
        assert(lost); assert.equal(actions.length, helpersAtLoss, 'An unconfirmed storage action must not replay automatically.');
        const partial = await targetRows(partialTarget); assert.equal(partial.length, action === 'open' ? 0 : 1);
        if (action === 'open') await assert.rejects(fs.lstat(path.join(h.workspaceRoot, partialTarget)), { code: 'ENOENT' });
        else {
          assert.equal(partial[0].birth.finalized, 1, 'The retained final confirmation follows the real publication COMMIT.');
          assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, partialTarget)), Buffer.from(content));
        }
        const lostBackend = lost as Identity & { operationId: string };
        assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid=$1 AND extract(epoch FROM backend_start)::text=$2',
          [lostBackend.backend, lostBackend.start])).rows[0].n, 0, 'Discard uncertain B before retry.');
        assert.deepEqual(await targetRows(partialTarget), partial);
        const retained = await observeMarkdownCreateBirth({ workspaceRoot: h.workspaceRoot, workspaceId: h.workspaceId,
          operationId: lostBackend.operationId });
        assert.equal(retained.complete, action === 'verify');
        lose = undefined;
        const resumed = await call(partialTarget, retryKey); assert.notEqual(resumed.isError, true);
        assert.equal((resumed.structuredContent as Record<string, unknown>).operation_id, lostBackend.operationId);
        const complete = await targetRows(partialTarget); assert.equal(complete.length, 1);
        if (partial.length) assert.deepEqual(complete, partial, 'Final-confirmation recovery retains every original row and xmin.');
        assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, partialTarget)), Buffer.from(content));
        const finalBirth = await observeMarkdownCreateBirth({ workspaceRoot: h.workspaceRoot, workspaceId: h.workspaceId,
          operationId: lostBackend.operationId });
        assert.equal(finalBirth.complete, true); assert.deepEqual(finalBirth.intent, retained.intent);
      }
      assert.deepEqual(ackFailures, []); assert(blocked >= 4);
      assert.equal(blocked, actions.filter(action => action.action === 'open' && action.stages > 0).length); assert(!live);
      assert(actions.every(action => action.closed && action.transactions.size === 1));
      // An existing retained intent returns without a new durable-intent ACK.
      assert(actions.filter(action => action.action === 'open' && action.stages > 0).every(action => action.observations > 1));
      console.log('MCP_STORAGE_PHASE_PROOF', JSON.stringify({ actions: actions.length, oneTransactionPerAction: true,
        authorityBlockedThroughAck: blocked, freshNextActionRevocation: true, actualCommitLossCases: 2,
        originalIdsBytesRetainedOnExplicitRetry: true, originalBirthIntentRetained: true,
        reusedIntentOpens: actions.filter(action => action.action === 'open' && action.stages === 0).length }));
    } finally {
      childModule.spawn = originalSpawn; syncBuiltinESMExports(); await Promise.allSettled(ackChecks);
      pool.off('acquire', attach);
      for (const [client, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(client, 'query', descriptor); else Reflect.deleteProperty(client, 'query');
      }
      if (revoked) await h.admin.query("UPDATE \"user\" SET banned=0 WHERE id='reader'");
    }
  });
}
await directMcpMarkdownCreateStoragePhasePostgresTest();
