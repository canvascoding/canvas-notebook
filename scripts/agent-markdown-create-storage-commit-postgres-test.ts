import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

async function agentMarkdownCreateStorageCommitPostgresTest(): Promise<void> {
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
    const { writeAgentTextFile } = await import('../app/lib/pi/agent-file-operations');
    const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
    const { observeMarkdownCreateBirth } = await import('../app/lib/files/markdown-create-birth');
    const { readDocumentForRequest } = await import('../app/lib/documents/service');
    const sessionId = `storage-commit-${randomUUID()}`;
    await h.admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'System','main','legacy','organization','principal-org','["write"]',100,100)
      ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json=excluded.enabled_tools_json`, [MAIN_AGENT_ID]);
    await h.admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
      workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES($1,'owner',$2,'fixture','fixture','principal-org',$3,'team','Storage commit',$4,100,100)`,
    [sessionId, MAIN_AGENT_ID, h.source.workspaceId, h.source.rootRelativePath]);
    const context = await resolveAgentExecutionContextForStoredSession({ sessionId, userId: 'owner', agentId: MAIN_AGENT_ID,
      permissions: ['canRead', 'canRunAgent', 'canWrite'] });
    const observe = async (target: string) => ({
      documents: (await h.admin.query(`SELECT to_jsonb(d) AS body,d.xmin::text AS xmin FROM collaboration_documents d
        WHERE workspace_id=$1 AND path=$2 ORDER BY id`, [h.source.workspaceId, target])).rows,
      receipts: (await h.admin.query(`SELECT to_jsonb(r) AS body,r.xmin::text AS xmin FROM collaboration_markdown_file_import_receipts r
        WHERE workspace_id=$1 AND private_result->'target'->>'path'=$2 ORDER BY operation_id`, [h.source.workspaceId, target])).rows,
      states: (await h.admin.query(`SELECT to_jsonb(y) AS body,y.xmin::text AS xmin FROM collaboration_yjs_states y
        WHERE workspace_id=$1 AND path=$2 ORDER BY document_id`, [h.source.workspaceId, target])).rows,
      lineages: (await h.admin.query(`SELECT to_jsonb(l) AS body,l.xmin::text AS xmin FROM file_collaboration_lineages l
        JOIN collaboration_documents d ON d.lineage_id=l.id WHERE d.workspace_id=$1 AND d.path=$2 ORDER BY l.id`,
      [h.source.workspaceId, target])).rows,
      revisions: (await h.admin.query(`SELECT to_jsonb(v) AS body,v.xmin::text AS xmin FROM file_revisions v
        WHERE workspace_id=$1 AND path=$2 ORDER BY id`, [h.source.workspaceId, target])).rows,
      births: (await h.admin.query(`SELECT to_jsonb(b) AS body,b.xmin::text AS xmin FROM collaboration_markdown_create_births b
        JOIN collaboration_documents d ON d.id=b.document_id WHERE d.workspace_id=$1 AND d.path=$2 ORDER BY b.operation_id`,
      [h.source.workspaceId, target])).rows,
      projections: (await h.admin.query(`SELECT to_jsonb(p) AS body,p.xmin::text AS xmin FROM collaboration_file_projections p
        JOIN collaboration_documents d ON d.id=p.document_id WHERE d.workspace_id=$1 AND d.path=$2 ORDER BY p.document_id`,
      [h.source.workspaceId, target])).rows,
    });
    for (const wanted of ['open', 'verify'] as const) {
      const target = `storage-commit/${wanted}.md`, key = `storage-commit-key-${randomUUID()}`;
      const content = `# ${wanted} original\n\nFull original content with äöü and 😀.\n`;
      const sourceHash = createHash('sha256').update(content).digest('hex');
      const call = () => runWithAgentExecutionContext(context, () => withAgentToolInvocation(context,
        { toolName: 'write', toolCallId: `storage-commit-call-${randomUUID()}` }, () =>
          writeAgentTextFile({ path: target, content, operation: 'write', idempotencyKey: key })));
      type Identity = { client: MetadataSqlEvent['client']; transaction: string; backend: number; start: string };
      type Helper = { action: string; identity: Identity; closed: boolean };
      let latest: Identity | undefined, live: Helper | undefined, lost = 0, helperCountAtLoss = -1;
      let lostIdentity: Identity | undefined, partial: Awaited<ReturnType<typeof observe>> | undefined;
      const helpers: Helper[] = [], transactions = new Map<MetadataSqlEvent['client'], string>();
      const dml = new Set<MetadataSqlEvent['client']>();
      const childModule = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
      const originalSpawn = childModule.spawn;
      childModule.spawn = ((...args: Parameters<typeof originalSpawn>) => {
        const storage = Array.isArray(args[1]) && args[1].some(value => String(value).endsWith('/markdown-create-birth.py'));
        if (storage) { assert.equal(live, undefined); assert(latest); }
        const child = originalSpawn(...args);
        if (storage) {
          const helper: Helper = { action: 'unobserved', identity: latest!, closed: false }; helpers.push(helper); live = helper;
          const stream = child.stdin!; const originalWrite = stream.write;
          stream.write = ((chunk: unknown, ...rest: unknown[]) => {
            if (helper.action === 'unobserved') {
              const message: unknown = JSON.parse(String(chunk)); assert(message && typeof message === 'object');
              const action = Reflect.get(message, 'action'); assert(['open', 'verify', 'prepare', 'observe', 'complete'].includes(action));
              helper.action = action;
            }
            return Reflect.apply(originalWrite, stream, [chunk, ...rest]);
          }) as typeof stream.write;
          child.once('close', () => { helper.closed = true; if (live === helper) live = undefined; });
        }
        return child;
      }) as typeof originalSpawn;
      syncBuiltinESMExports();
      let observedError: unknown;
      try {
        await callWithLoss();
      } catch (error) { observedError = error; }
      finally { childModule.spawn = originalSpawn; syncBuiltinESMExports(); }

      async function callWithLoss() {
        return h.withProbe(async event => {
          const text = event.text.trim();
          if (/^BEGIN\b/u.test(text)) { dml.delete(event.client); transactions.delete(event.client); }
          if (/^(?:INSERT|UPDATE|DELETE|WITH)\b/u.test(text)) dml.add(event.client);
          const row: unknown = Array.isArray(event.result.rows) ? event.result.rows[0] : undefined;
          if (row && typeof row === 'object' && Reflect.get(row, 'schema') === h.schema
            && Array.isArray(Reflect.get(row, 'relations')) && typeof Reflect.get(row, 'transaction') === 'string') {
            latest = { client: event.client, transaction: String(Reflect.get(row, 'transaction')),
              backend: Number(Reflect.get(row, 'backend')), start: String(Reflect.get(row, 'start')) };
            transactions.set(event.client, latest.transaction);
          }
          const helper = helpers.at(-1);
          if (lost || text !== 'COMMIT' || event.result.command !== 'COMMIT' || !helper?.closed
            || helper.action !== wanted || helper.identity.client !== event.client || dml.has(event.client)
            || helper.identity.transaction !== transactions.get(event.client)) return;
          const current = await observe(target);
          if (wanted === 'verify' && current.documents.length === 0) return;
          assert.equal(current.documents.length, wanted === 'open' ? 0 : 1);
          assert.equal(current.receipts.length, wanted === 'open' ? 0 : 1);
          assert.equal(current.births.length, wanted === 'open' ? 0 : 1);
          assert.equal(current.revisions.length, 0);
          if (wanted === 'verify') assert.equal(Number(current.births[0].body.finalized), 0);
          await assert.rejects(fs.lstat(path.join(h.source.rootPath, target)), { code: 'ENOENT' });
          partial = current; lostIdentity = helper.identity; lost++; helperCountAtLoss = helpers.length;
          // PostgreSQL has really completed this exact read-only helper-action
          // COMMIT. Lose its acknowledgement only; never replace any SQL row.
          throw Object.assign(new Error('Lost actual storage-action COMMIT acknowledgement.'), { code: 'STORAGE_ACTION_FIXTURE_ACK_LOST' });
        }, call);
      }
      assert.equal(lost, 1); assert(partial && lostIdentity); assert(observedError);
      assert.equal(helpers.length, helperCountAtLoss, 'An unconfirmed action cannot automatically replay its helper.');
      assert(helpers.every(helper => helper.closed)); assert.equal(live, undefined);
      const codes: string[] = [], pending: unknown[] = [observedError]; const seen = new Set<unknown>();
      let operationId: string | undefined;
      for (const error of pending) {
        if (!error || typeof error !== 'object' || seen.has(error)) continue;
        seen.add(error); assert(seen.size < 64);
        const code = Reflect.get(error, 'code'); if (typeof code === 'string') codes.push(code);
        const operation = Reflect.get(error, 'operationId'); if (typeof operation === 'string') operationId ??= operation;
        pending.push(Reflect.get(error, 'cause')); const errors: unknown = Reflect.get(error, 'errors'); if (Array.isArray(errors)) pending.push(...errors);
      }
      assert(codes.includes('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED')); assert(operationId);
      assert(observedError && typeof observedError === 'object');
      assert.equal(Reflect.get(observedError, 'idempotencyKey'), key, 'The unconfirmed result retains the caller\'s original retry key.');
      let remaining = 1; const deadline = performance.now() + 2000;
      do {
        remaining = (await h.admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE pid=$1 AND extract(epoch FROM backend_start)::text=$2`, [lostIdentity.backend, lostIdentity.start])).rows[0].n;
        if (!remaining || performance.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (true);
      assert.equal(remaining, 0, 'Unconfirmed B must be discarded before a new attempt.');
      assert.deepEqual(await observe(target), partial);
      const original = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath, workspaceId: h.source.workspaceId, operationId });
      assert.equal(original.complete, false);
      const originalLineageId: unknown = partial.lineages[0]?.body.id; let retainedLineageUpserts = 0;
      const created = await h.withProbe(async event => {
        if (wanted !== 'verify') return;
        assert(!/\bDELETE\s+FROM\s+(?:"[^"]+"\.)?"?file_collaboration_lineages\b/iu.test(event.text), 'Recovery cannot delete the original lineage.');
        if (/\bINSERT\s+INTO\s+(?:"[^"]+"\.)?"?file_collaboration_lineages\b/iu.test(event.text)) {
          assert(/\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/iu.test(event.text));
          assert.equal(event.result.rows.length, 1); assert.equal(event.result.rows[0].id, originalLineageId);
          assert.notEqual(event.values[0], originalLineageId, 'The actual conflict branch must retain the old ID instead of the proposed fresh ID.');
          retainedLineageUpserts++;
        }
      }, call);
      assert(created.nativeCreate); assert.equal(created.nativeCreate.operationId, operationId);
      const completed = await observe(target);
      for (const rows of Object.values(completed)) assert.equal(rows.length, 1);
      const document = completed.documents[0].body, receipt = completed.receipts[0].body;
      assert.equal(document.id, created.nativeCreate.document.documentId); assert.equal(document.lineage_id, created.nativeCreate.document.lineageId);
      assert.equal(receipt.operation_id, operationId); assert.equal(receipt.private_result.sourceHash, sourceHash);
      assert.equal(completed.revisions[0].body.content_hash, sourceHash);
      assert.equal(Number(completed.births[0].body.finalized), 1); assert.equal(Number(completed.projections[0].body.finalized), 1);
      assert.equal(completed.births[0].body.claim_id, original.id); assert.equal(completed.births[0].body.claim_fingerprint, original.fingerprint);
      assert.equal(Number(completed.states[0].body.lifecycle_generation), 1); assert.equal(Number(completed.states[0].body.document_sequence), 0);
      assert.equal(Number(completed.states[0].body.checkpoint_sequence), 0); assert.notEqual(completed.states[0].body.checkpointed_at, null);
      if (wanted === 'verify') {
        assert.equal(document.id, partial.documents[0].body.id); assert.equal(document.lineage_id, partial.documents[0].body.lineage_id);
        assert.deepEqual(completed.receipts, partial.receipts, 'The committed original import receipt/xmin cannot be recreated.');
        // Normal first projection binds its revision using the established
        // lineage UPSERT. It may advance xmin while retaining the entire row.
        assert.deepEqual(completed.lineages.map(row => row.body), partial.lineages.map(row => row.body));
        if (completed.lineages[0].xmin !== partial.lineages[0].xmin) assert(retainedLineageUpserts > 0);
        for (const key of ['yjs_state', 'state_vector', 'lifecycle_generation', 'document_sequence']) {
          assert.deepEqual(completed.states[0].body[key], partial.states[0].body[key]);
        }
      }
      const settled = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath, workspaceId: h.source.workspaceId, operationId });
      assert.equal(settled.complete, true); assert.equal(settled.id, original.id); assert.equal(settled.fingerprint, original.fingerprint);
      assert.deepEqual(settled.intent, original.intent);
      const page = await readDocumentForRequest(await h.request(h.source, 'owner'), { apiVersion: 1,
        workspaceId: h.source.workspaceId, documentId: document.id, format: 'markdown' });
      assert.equal(page.complete, true); assert.equal(page.fragment, content);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, target)), Buffer.from(content));
      let completedRetryDml = 0;
      const retry = await h.withProbe(async event => {
        if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(event.text)) completedRetryDml++;
      }, call);
      assert.equal(completedRetryDml, 0, 'A completed original retry must perform no observed SQL DML.');
      assert.equal(retry.changed, false); assert.equal(retry.nativeCreate?.outcome, 'already_created');
      assert.deepEqual(await observe(target), completed);
      assert.deepEqual(await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath, workspaceId: h.source.workspaceId, operationId }), settled);
      console.log('AGENT_STORAGE_COMMIT_RECOVERY', JSON.stringify({ action: wanted, lostAcknowledgements: lost,
        discardedBackendConfirmed: true, automaticHelperReplay: false, nativeDocumentsBeforeRetry: partial.documents.length,
        completedDocuments: completed.documents.length, originalIntentAndClaimPreserved: true,
        originalNativeAndReceiptPreserved: wanted === 'verify' ? true : null,
        retainedOriginalLineageUpserts: retainedLineageUpserts, singleRevision: true,
        completedRetryDml, stableCompletedRetry: true }));
    }
  });
}

await agentMarkdownCreateStorageCommitPostgresTest();
