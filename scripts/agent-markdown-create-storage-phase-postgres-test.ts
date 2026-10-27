import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Observe actual helper messages and actual PostgreSQL identity replies. The
// real spawn, bytes, SQL results, authority and operation are never replaced.
await withNativeCopyMetadataOwnerFixture(async h => {
  const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
  const { writeAgentTextFile } = await import('../app/lib/pi/agent-file-operations');
  const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
  const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
  const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
  const { readDocumentForRequest } = await import('../app/lib/documents/service');
  const sessionId = `storage-phase-${randomUUID()}`, toolCallId = `storage-call-${randomUUID()}`;
  await h.admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
    VALUES($1,'System','main','legacy','organization','principal-org','["write"]',100,100)
    ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json=excluded.enabled_tools_json`, [MAIN_AGENT_ID]);
  await h.admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
    workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
    VALUES($1,'owner',$2,'fixture','fixture','principal-org',$3,'team','Storage phase',$4,100,100)`,
  [sessionId, MAIN_AGENT_ID, h.source.workspaceId, h.source.rootRelativePath]);
  const context = await resolveAgentExecutionContextForStoredSession({ sessionId, userId: 'owner', agentId: MAIN_AGENT_ID,
    permissions: ['canRead', 'canRunAgent', 'canWrite'] });
  const content = '# One storage phase\n\nOriginal content with äöü and 😀.\n', filePath = 'storage-phase/note.md';
  const sourceHash = createHash('sha256').update(content).digest('hex');
  type Action = { action: string; transactions: Set<string>; observations: number; stages: number; closed: boolean; lockChecked: boolean };
  const actions: Action[] = [];
  let live: Action | undefined, latestTransaction: string | undefined;
  let blockedAcks = 0, revokeAfterOpen = false, revoked = false;
  const ackChecks: Promise<void>[] = [], ackFailures: unknown[] = [];
  const childModule = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const originalSpawn = childModule.spawn;
  childModule.spawn = ((...args: Parameters<typeof originalSpawn>) => {
    const child = originalSpawn(...args);
    if (Array.isArray(args[1]) && args[1].some(value => String(value).endsWith('/markdown-create-birth.py'))) {
      assert.equal(live, undefined, 'Owned storage helpers remain serial.');
      const current: Action = { action: 'unobserved', transactions: new Set(latestTransaction ? [latestTransaction] : []),
        observations: latestTransaction ? 1 : 0, stages: 0, closed: false, lockChecked: false };
      actions.push(current); live = current;
      const stream = child.stdin!; const originalWrite = stream.write;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (current.action === 'unobserved') {
          const message: unknown = JSON.parse(String(chunk));
          assert(message && typeof message === 'object');
          const action = Reflect.get(message, 'action');
          assert(['open', 'verify', 'prepare', 'observe', 'complete'].includes(action)); current.action = action;
        }
        if (String(chunk) === 'continue\n' && current.action === 'open' && !current.lockChecked) {
          current.lockChecked = true;
          // The real helper is paused at intent_durable. A genuine competing
          // authority mutation must remain blocked until this action closes.
          const checked = (async () => {
            let code: unknown;
            await h.admin.query('BEGIN');
            try {
              await h.admin.query("SET LOCAL lock_timeout='50ms'");
              await h.admin.query("UPDATE \"user\" SET banned=1 WHERE id='owner'");
            } catch (error) { code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined; }
            finally { await h.admin.query('ROLLBACK'); }
            assert.equal(code, '55P03', 'The action must retain its actual authority locks through the helper ACK.');
            blockedAcks++;
            Reflect.apply(originalWrite, stream, [chunk, ...rest]);
          })();
          ackChecks.push(checked);
          void checked.catch(error => { ackFailures.push(error); child.kill('SIGKILL'); });
          return true;
        }
        return Reflect.apply(originalWrite, stream, [chunk, ...rest]);
      }) as typeof stream.write;
      let buffer = '';
      child.stdout!.on('data', chunk => {
        buffer += String(chunk);
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          const message: unknown = JSON.parse(line);
          if (message && typeof message === 'object' && typeof Reflect.get(message, 'stage') === 'string') current.stages++;
        }
      });
      child.once('close', () => { current.closed = true; if (live === current) live = undefined; });
    }
    return child;
  }) as typeof originalSpawn;
  syncBuiltinESMExports();
  const observe: Parameters<typeof h.withProbe>[0] = async event => {
    const last = actions.at(-1);
    if (revokeAfterOpen && !revoked && last?.action === 'open' && last.closed && /^COMMIT$/u.test(event.text.trim())) {
      assert.equal((await h.admin.query("UPDATE \"user\" SET banned=1 WHERE id='owner'")).rowCount, 1);
      revoked = true;
    }
    const row: unknown = Array.isArray(event.result.rows) ? event.result.rows[0] : undefined;
    if (!row || typeof row !== 'object' || Reflect.get(row, 'schema') !== h.schema
      || !Array.isArray(Reflect.get(row, 'relations')) || typeof Reflect.get(row, 'transaction') !== 'string') return;
    latestTransaction = `${String(Reflect.get(row, 'backend'))}:${String(Reflect.get(row, 'transaction'))}`;
    if (live) { live.transactions.add(latestTransaction); live.observations++; }
  };
  const deniedPath = 'storage-phase/revoked-after-open.md';
  try {
    const result = await h.withProbe(observe, () => runWithAgentExecutionContext(context, () => withAgentToolInvocation(context,
      { toolName: 'write', toolCallId }, () => writeAgentTextFile({ path: filePath, content, operation: 'write', idempotencyKey: toolCallId }))));
    assert.equal(result.changed, true); assert.equal(result.afterSha256, sourceHash);
    revokeAfterOpen = true;
    await assert.rejects(h.withProbe(observe, () => runWithAgentExecutionContext(context, () => withAgentToolInvocation(context,
      { toolName: 'write', toolCallId: `${toolCallId}-revoked` }, () => writeAgentTextFile({ path: deniedPath, content,
        operation: 'write', idempotencyKey: `${toolCallId}-revoked` })))), error => {
      const codes: string[] = [], pending: unknown[] = [error]; const seen = new Set<unknown>();
      for (const current of pending) {
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current); assert(seen.size < 64);
        const code = Reflect.get(current, 'code'); if (typeof code === 'string') codes.push(code);
        pending.push(Reflect.get(current, 'cause'));
        const errors: unknown = Reflect.get(current, 'errors'); if (Array.isArray(errors)) pending.push(...errors);
      }
      console.log('AGENT_STORAGE_NEXT_PHASE_DENIAL', JSON.stringify({ revoked, codes }));
      return revoked && codes.includes('PRINCIPAL_AUTH_REVOKED');
    });
  } finally {
    childModule.spawn = originalSpawn; syncBuiltinESMExports(); await Promise.allSettled(ackChecks);
    if (revoked) await h.admin.query("UPDATE \"user\" SET banned=0 WHERE id='owner'");
  }
  assert.deepEqual(ackFailures, []); assert.equal(blockedAcks, 2); assert.equal(revoked, true);
  assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
    [h.source.workspaceId, deniedPath])).rows[0].n, 0);
  assert.equal((await h.admin.query("SELECT count(*)::int AS n FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND private_result->'target'->>'path'=$2",
    [h.source.workspaceId, deniedPath])).rows[0].n, 0);
  await assert.rejects(fs.lstat(path.join(h.source.rootPath, deniedPath)), { code: 'ENOENT' });
  assert.equal(live, undefined); assert(actions.length > 3); assert(actions.every(action => action.closed));
  const target = (await h.admin.query(`SELECT d.id,d.lineage_id,b.finalized AS birth_finalized,p.finalized AS projection_finalized
    FROM collaboration_documents d JOIN collaboration_markdown_create_births b ON b.document_id=d.id
    JOIN collaboration_file_projections p ON p.document_id=d.id WHERE d.workspace_id=$1 AND d.path=$2`,
  [h.source.workspaceId, filePath])).rows;
  assert.equal(target.length, 1); assert.equal(Number(target[0].birth_finalized), 1); assert.equal(Number(target[0].projection_finalized), 1);
  const page = await readDocumentForRequest(await h.request(h.source, 'owner'), { apiVersion: 1,
    workspaceId: h.source.workspaceId, documentId: target[0].id, format: 'markdown' });
  assert.equal(page.complete, true); assert.equal(page.fragment, content); assert.equal(page.document.lineageId, target[0].lineage_id);
  assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, filePath)), Buffer.from(content));
  const observed = actions.map(action => ({ action: action.action, transactions: action.transactions.size,
    observations: action.observations, stages: action.stages, closed: action.closed }));
  console.log('AGENT_STORAGE_ACTION_TRANSACTIONS', JSON.stringify(observed));
  assert(actions.every(action => action.transactions.size === 1), 'Every observed storage action retains one actual transaction.');
  const opened = actions.filter(action => action.action === 'open'); assert.equal(opened.length, 2);
  for (const action of opened) {
    assert(action.stages > 0 && action.observations > 1, 'The real open ACK must have an actual observed Principal.');
    assert.equal(action.transactions.size, 1, 'One storage action must retain one actual Principal transaction through its helper ACK.');
  }
});
