import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { MarkdownFileImportReceipt } from '../app/lib/collaboration/markdown-file-import-persistence';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { AgentFileChangeResult } from '../app/lib/pi/agent-file-operations';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// The same genuine PI call and native-birth assertions are retained for RED
// and GREEN. SQL only observes the result; it never manufactures a document.
let phase = 'fixture', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });

export async function piMarkdownCreatePostgresTest(options: { firstCreateLatencyOnly?: true } = {}): Promise<void> {
  const originalBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try {
    await withNativeCopyMetadataOwnerFixture(async h => {
      const { writeAgentTextFile } = await import('../app/lib/pi/agent-file-operations');
      const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
      const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
      const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
      const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
      const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
      const { authenticatedNativeTextSessionEnabled } = await import('../app/lib/collaboration/native-text-session-activation');
      const { loadCollaborationStateOnConnection } = await import('../app/lib/collaboration/persistence');
      const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
      const { authoritativeCollaborationSnapshot } = await import('../app/lib/collaboration/checkpoint');
      const { readDocumentForRequest } = await import('../app/lib/documents/service');
      const { observeMarkdownCreateBirth } = await import('../app/lib/files/markdown-create-birth');
      assert.equal(authenticatedNativeTextSessionEnabled(), true);
      assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
      const agentId = `pi-create-${crypto.randomUUID()}`, sessionId = `pi-create-owner-${crypto.randomUUID()}`;
      const toolCallId = `pi-create-call-${crypto.randomUUID()}`;
      await h.admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
        VALUES($1,'System','main','legacy','organization','principal-org','["write"]',100,100),
        ($2,'PI Create fixture','special','restricted','organization','principal-org','["write"]',100,100)
        ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json=excluded.enabled_tools_json`, [MAIN_AGENT_ID, agentId]);
      await h.admin.query(`INSERT INTO agent_members(agent_id,organization_id,user_id,status,can_use,created_at,updated_at)
        VALUES($1,'principal-org','owner','active',0,100,100)`, [agentId]);
      await h.admin.query(`INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,created_at,updated_at)
        VALUES($1,$2,'principal-org','workspace',$3,1,100,100)`, [crypto.randomUUID(), agentId, h.source.workspaceId]);
      await h.admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
        workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
        VALUES($1,'owner',$2,'fixture','fixture','principal-org',$3,'team','PI Create source',$4,100,100)`,
      [sessionId, agentId, h.source.workspaceId, h.source.rootRelativePath]);

      const piMarkdownCreateInvocation = async <T>(operation: () => Promise<T>): Promise<T> => {
        const actual = await resolveAgentExecutionContextForStoredSession({ sessionId, userId: 'owner', agentId,
          permissions: ['canRead', 'canRunAgent', 'canWrite'] });
        assert.equal(actual.workspaceId, h.source.workspaceId); assert.equal(actual.agentId, agentId);
        assert.equal(actual.userId, 'owner'); assert.equal(actual.sessionId, sessionId);
        assert.equal(actual.canWrite, true); assert.equal(actual.legacy, false);
        return runWithAgentExecutionContext(actual, () => withAgentToolInvocation(actual,
          { toolName: 'write', toolCallId }, operation));
      };

      const filePath = `${options.firstCreateLatencyOnly ? 'campaign/linkedin/posts/' : ''}pi-created-${crypto.randomUUID()}.md`;
      const content = options.firstCreateLatencyOnly ? '# Post fixture\n\n' + 'Literal Markdown with äöü and 😀. '.repeat(60) + '\n'
        : 'Native PI document creation preserves this text, including äöü and 😀.\n';
      const source = Buffer.from(content), sourceHash = crypto.createHash('sha256').update(source).digest('hex');
      await assert.rejects(fs.lstat(path.join(h.source.rootPath, filePath)), { code: 'ENOENT' });
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
        [h.source.workspaceId, filePath])).rows[0].n, 0);

      const piMarkdownCreateNativeBirthAssertions = async (): Promise<void> => {
        // Observe every linked component before asserting presence. A raw-only
        // write reports all missing birth components in the preserved RED.
        const registry = (await h.admin.query(`SELECT d.* FROM collaboration_documents d
          WHERE d.workspace_id=$1 AND d.path=$2`, [h.source.workspaceId, filePath])).rows;
        const receipts = (await h.admin.query(`SELECT r.* FROM collaboration_markdown_file_import_receipts r
          WHERE r.workspace_id=$1 AND r.private_result->'target'->>'path'=$2`, [h.source.workspaceId, filePath])).rows;
        const births = (await h.admin.query(`SELECT b.* FROM collaboration_markdown_create_births b
          JOIN collaboration_markdown_file_import_receipts r ON r.workspace_id=b.workspace_id AND r.operation_id=b.operation_id
          WHERE b.workspace_id=$1 AND r.private_result->'target'->>'path'=$2`, [h.source.workspaceId, filePath])).rows;
        const projections = (await h.admin.query(`SELECT p.* FROM collaboration_file_projections p
          JOIN collaboration_documents d ON d.id=p.document_id WHERE d.workspace_id=$1 AND d.path=$2`,
        [h.source.workspaceId, filePath])).rows;
        const observed = { registry: registry.length, immutableImportReceipts: receipts.length,
          birthBindings: births.length, projections: projections.length };
        console.log('PI_MARKDOWN_CREATE_NATIVE_COMPONENTS', JSON.stringify(observed));
        assert.deepEqual(observed, { registry: 1, immutableImportReceipts: 1, birthBindings: 1, projections: 1 },
          'A successful PI Markdown creation must have one central native identity, import receipt, birth and projection.');
        const document = registry[0], row = receipts[0], birth = births[0], projection = projections[0];
        const receipt = row.private_result as MarkdownFileImportReceipt;
        assert.equal(row.actor_user_id, 'owner'); assert.equal(row.actor_session_id, sessionId);
        assert.equal(row.workspace_id, h.source.workspaceId); assert.equal(row.organization_id, 'principal-org');
        assert.equal(receipt.version, 1); assert.equal(receipt.operationId, row.operation_id);
        assert.equal(receipt.sourceHash, sourceHash); assert.equal(receipt.sourceBytes, source.length);
        assert.equal(receipt.target.path, filePath); assert.equal(receipt.target.workspaceId, h.source.workspaceId);
        assert.equal(receipt.target.documentId, document.id); assert.equal(receipt.target.lineageId, document.lineage_id);
        assert.equal(receipt.target.lifecycleGeneration, 1); assert.equal(receipt.target.initialSequence, 0);
        assert.equal(document.provider, 'yjs'); assert.equal(document.yjs_state_lifecycle, 'initialized');
        assert.equal(document.status, 'active'); assert.equal(typeof document.id, 'string'); assert(document.id.length > 0);
        assert.equal(typeof document.lineage_id, 'string'); assert(document.lineage_id.length > 0);
        const lineages = (await h.admin.query('SELECT * FROM file_collaboration_lineages WHERE id=$1', [document.lineage_id])).rows;
        assert.equal(lineages.length, 1); assert.equal(lineages[0].status, 'active');
        assert.equal(lineages[0].workspace_id, h.source.workspaceId);
        assert.equal(birth.operation_id, row.operation_id); assert.equal(birth.document_id, document.id);
        assert.equal(Number(birth.lifecycle_generation), 1); assert.equal(Number(birth.finalized), 1);
        assert.equal(projection.document_id, document.id); assert.equal(Number(projection.finalized), 1);
        assert.equal(projection.revision_id, birth.revision_id); assert.equal(projection.serialized_hash, sourceHash);
        assert.equal(birth.serialized_hash, sourceHash);
        const original = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath,
          workspaceId: h.source.workspaceId, operationId: row.operation_id });
        assert.equal(original.complete, true); assert.equal(original.id, birth.claim_id);
        assert.equal(original.fingerprint, birth.claim_fingerprint); assert.equal(original.revisionId, birth.revision_id);
        const state = await loadCollaborationStateOnConnection(h.connection, document.id); assert(state);
        assert.equal(state.status, 'active'); assert.equal(state.path, filePath); assert.equal(state.lifecycleGeneration, 1);
        assert.equal(state.documentSequence, 0); assert.equal(state.checkpointSequence, state.documentSequence);
        assert.notEqual(state.checkpointedAt, null);
        const snapshot = authoritativeNativeCollaborationSnapshot(state);
        assert.equal(state.representation, receipt.target.representation);
        assert.equal(authoritativeCollaborationSnapshot(state).canonicalContent, content);
        assert.equal(snapshot.version.stateProof, receipt.target.initialStateProof);
        const page = await readDocumentForRequest(await h.request(h.source, 'owner'), { apiVersion: 1,
          workspaceId: h.source.workspaceId, documentId: document.id, format: 'native', maxBytes: 262144 });
        assert.equal(page.complete, true); assert.equal(page.nextCursor, null);
        assert.equal(page.document.documentId, document.id); assert.equal(page.document.lineageId, document.lineage_id);
        assert.equal(page.document.path, filePath); assert.equal(page.projection.status, 'current');
        assert.deepEqual(JSON.parse(page.fragment).content, JSON.parse(JSON.stringify(snapshot.content)));
        assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, filePath)), source);
      };

      phase = 'genuine stored PI invocation creates new Markdown';
      const create = () => piMarkdownCreateInvocation(() => writeAgentTextFile({ path: filePath, content,
        operation: 'write', idempotencyKey: toolCallId }));
      let result: AgentFileChangeResult;
      if (options.firstCreateLatencyOnly) {
        const transactions = new Map<object, number>(), statements: number[] = [];
        let queryCount = 0;
        result = await h.withProbe(async event => {
          if (/^BEGIN\b/u.test(event.text)) transactions.set(event.client, 0);
          if (transactions.has(event.client)) transactions.set(event.client, transactions.get(event.client)! + 1);
          if (/^(COMMIT|ROLLBACK)$/u.test(event.text) && transactions.has(event.client)) {
            statements.push(transactions.get(event.client)!); transactions.delete(event.client);
          }
          // Delay real acknowledgements, never substitute SQL results or auth.
          // The unchanged genuine Principal and PostgreSQL five-second budgets
          // must still permit the complete first projection.
          if (++queryCount % 4 === 0) await new Promise(resolve => setTimeout(resolve, 1));
        }, create);
        assert(statements.length > 5);
        assert(Math.max(...statements) < 5000, 'first projection must not regress to thousands of duplicate authorization reads');
        console.log('PI_CREATE_LATENCY_BUDGET', JSON.stringify({ queryCount, largestTransactionStatements: Math.max(...statements) }));
      } else result = await create();
      assert.equal(result.path, filePath); assert.equal(result.changed, true); assert.equal(result.beforeSha256, null);
      assert.equal(result.afterSha256, sourceHash); assert.equal(result.size, source.length);
      assert.equal(result.review, undefined); assert.equal(result.proposal, undefined);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, filePath)), source);
      await piMarkdownCreateNativeBirthAssertions();
      groups++; console.log('PASS PI Markdown create: genuine authority -> native birth -> projection -> authenticated ID read');
      if (options.firstCreateLatencyOnly) return;

      // Additional families share the same genuine baseline and owned fixture.
      const { readPiRuntimeConfig } = await import('../app/lib/agents/storage');
      const { piTools } = await import('../app/lib/pi/core-tools');
      await readPiRuntimeConfig();
      const sessions = new Map<string, AgentExecutionContext>();
      for (const [name, userId] of [['sid-a', 'owner'], ['sid-b', 'owner'], ['readonly', 'member']] as const) {
        const nextSession = `pi-create-${name}-${crypto.randomUUID()}`;
        if (userId === 'member') await h.admin.query(`INSERT INTO agent_members(agent_id,organization_id,user_id,status,can_use,created_at,updated_at)
          VALUES($1,'principal-org','member','active',0,100,100)`, [agentId]);
        await h.admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
          workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
          VALUES($1,$2,$3,'fixture','fixture','principal-org',$4,'team','PI Create source',$5,100,100)`,
        [nextSession, userId, agentId, h.source.workspaceId, h.source.rootRelativePath]);
        const actual = await resolveAgentExecutionContextForStoredSession({ sessionId: nextSession, userId, agentId,
          permissions: ['canRead', 'canRunAgent'] });
        assert.equal(actual.sessionId, nextSession); assert.equal(actual.userId, userId);
        assert.equal(actual.workspaceId, h.source.workspaceId); assert.equal(actual.agentId, agentId); assert.equal(actual.legacy, false);
        assert.equal(actual.canWrite, userId === 'owner'); sessions.set(name, actual);
        await runWithAgentExecutionContext(actual, () => withAgentToolInvocation(actual,
          { toolName: 'write', toolCallId: `prewarm-${crypto.randomUUID()}` }, async () => undefined));
      }

      const piMarkdownCreateDomainSnapshot = async () => {
        let begun = false, totalBytes = 0;
        try {
          await h.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
          const identity = (await h.admin.query(`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid::text AS oid,
            current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS ro,
            pg_current_xact_id_if_assigned() IS NULL AS unassigned`)).rows[0];
          assert.deepEqual(identity, { schema: h.schema, oid: h.schemaOid, isolation: 'repeatable read', ro: 'on', unassigned: true });
          const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p')
            ORDER BY c.relname LIMIT 2049`, [h.schema])).rows;
          assert(tables.length > 20 && tables.length <= 2048); const rows: Record<string, unknown> = {};
          for (const table of tables) {
            assert.match(table.relname, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
            const values = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin
              FROM "${h.schema}"."${table.relname}" t ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
            assert(values.length <= 10000);
            for (const row of values) { totalBytes += Buffer.byteLength(row.body); assert(totalBytes <= 128 * 1024 ** 2); }
            rows[table.relname] = { oid: table.oid, values };
          }
          assert.equal((await h.admin.query('SELECT pg_current_xact_id_if_assigned() IS NULL AS unassigned')).rows[0].unassigned, true);
          await h.admin.query('COMMIT'); begun = false; return { identity, rows };
        } finally { if (begun) await h.admin.query('ROLLBACK'); }
      };
      const piMarkdownCreateFilesystem = async () => {
        const pending = ['.'], files: unknown[] = []; let totalBytes = 0;
        for (let index = 0; index < pending.length; index++) {
          assert(pending.length <= 10000); const relative = pending[index], file = path.join(h.dataRoot, relative);
          assert(file === h.dataRoot || file.startsWith(h.dataRoot + path.sep));
          const before = await fs.lstat(file, { bigint: true });
          const identity = { dev: String(before.dev), ino: String(before.ino), mode: String(before.mode), uid: String(before.uid), gid: String(before.gid),
            nlink: String(before.nlink), size: String(before.size), mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) };
          totalBytes += Number(before.size); assert(totalBytes <= 128 * 1024 ** 2);
          if (before.isSymbolicLink()) {
            const target = await fs.readlink(file), after = await fs.lstat(file, { bigint: true });
            for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key]);
            files.push({ path: relative, kind: 'symlink', ...identity, target }); continue;
          }
          if (before.isDirectory()) {
            files.push({ path: relative, kind: 'directory', ...identity });
            pending.push(...(await fs.readdir(file)).sort().map(name => path.join(relative, name))); continue;
          }
          assert(before.isFile() && before.nlink === BigInt(1) && before.size <= BigInt(8 * 1024 ** 2));
          const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const opened = await fd.stat({ bigint: true });
            for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.equal(opened[key], before[key]);
            const bytes = await fd.readFile(); assert.equal(BigInt(bytes.length), before.size);
            for (const after of [await fd.stat({ bigint: true }), await fs.lstat(file, { bigint: true })]) {
              for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key]);
            }
            files.push({ path: relative, kind: 'file', ...identity, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
          } finally { await fd.close(); }
        }
        return files;
      };
      const piMarkdownCreateNoWrites = async <T>(operation: () => Promise<T>): Promise<T> => {
        const beforeRows = await piMarkdownCreateDomainSnapshot(), beforeFiles = await piMarkdownCreateFilesystem();
        let statements = 0, writes = 0, value: T | undefined; const failures: unknown[] = [];
        try { value = await h.withProbe(async event => {
          assert(++statements <= 10000);
          if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'NOTIFY'].includes(event.result.command)
            || /\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX)|NOTIFY)\b/iu.test(event.text)
            || /\bpg_notify\s*\(/iu.test(event.text)) writes++;
        }, operation); } catch (error) { failures.push(error); }
        // Every oracle runs even after a rejected operation or earlier oracle.
        const checks = await Promise.allSettled([
          (async () => assert.deepEqual(await piMarkdownCreateDomainSnapshot(), beforeRows))(),
          (async () => assert.deepEqual(await piMarkdownCreateFilesystem(), beforeFiles))(),
          (async () => assert.equal(writes, 0, 'NoWrite forbids even rolled-back SQL/CTE/NOTIFY mutation attempts.'))(),
        ]);
        failures.push(...checks.flatMap(check => check.status === 'rejected' ? [check.reason as unknown] : []));
        console.log('PI_CREATE_NOWRITE', JSON.stringify({ phase, statements, writes, checks: checks.map(check => check.status) }));
        if (failures.length === 1) throw failures[0]; if (failures.length) throw new AggregateError(failures, 'PI Create NoWrite oracles failed.');
        return value as T;
      };
      const piMarkdownCreateCall = async (context: AgentExecutionContext, target: string, text: string,
        key: string | undefined, callId = `pi-create-${crypto.randomUUID()}`, toolName = 'write', expectedSha256?: string) =>
        runWithAgentExecutionContext(context, () => withAgentToolInvocation(context, { toolName, toolCallId: callId },
          () => writeAgentTextFile({ path: target, content: text, operation: 'write', ...(key === undefined ? {} : { idempotencyKey: key }),
            ...(expectedSha256 === undefined ? {} : { expectedSha256 }) })));
      const piMarkdownCreateObserveRows = async (target: string) => ({
        registry: (await h.admin.query(`SELECT to_jsonb(d) AS body,d.xmin::text AS xmin FROM collaboration_documents d
          WHERE d.workspace_id=$1 AND d.path=$2 ORDER BY d.id`, [h.source.workspaceId, target])).rows,
        receipts: (await h.admin.query(`SELECT to_jsonb(r) AS body,r.xmin::text AS xmin FROM collaboration_markdown_file_import_receipts r
          WHERE r.workspace_id=$1 AND r.private_result->'target'->>'path'=$2 ORDER BY r.operation_id`, [h.source.workspaceId, target])).rows,
        births: (await h.admin.query(`SELECT to_jsonb(b) AS body,b.xmin::text AS xmin FROM collaboration_markdown_create_births b
          JOIN collaboration_markdown_file_import_receipts r ON r.workspace_id=b.workspace_id AND r.operation_id=b.operation_id
          WHERE b.workspace_id=$1 AND r.private_result->'target'->>'path'=$2 ORDER BY b.operation_id`, [h.source.workspaceId, target])).rows,
      });
      const piMarkdownCreateAssertResult = async (created: AgentFileChangeResult, target: string, text: string, originalSession: string,
        outcome: 'created' | 'already_created') => {
        const native = created.nativeCreate; assert(native, 'PI creation must expose the actual central native Create result.');
        assert.equal(native.apiVersion, 1); assert.equal(native.outcome, outcome); assert.equal(native.document.path, target);
        assert.equal(native.document.workspaceId, h.source.workspaceId); assert.equal(native.document.organizationId, 'principal-org');
        assert.equal(native.projection.status, 'current'); assert.equal(native.currency.source, 'persisted_yjs');
        assert.equal(native.currency.observedDurable, true); assert.equal(native.currency.observedVersion, native.document.version);
        assert.equal(native.currency.durableVersion, native.document.version);
        const rows = await piMarkdownCreateObserveRows(target);
        assert.equal(rows.registry.length, 1); assert.equal(rows.receipts.length, 1); assert.equal(rows.births.length, 1);
        const receiptRow = rows.receipts[0].body, receipt = receiptRow.private_result as MarkdownFileImportReceipt;
        const bytes = Buffer.from(text), sha = crypto.createHash('sha256').update(bytes).digest('hex');
        assert.equal(receiptRow.operation_id, native.operationId); assert.equal(receiptRow.actor_user_id, 'owner');
        assert.equal(receiptRow.actor_session_id, originalSession); assert.equal(receipt.sourceHash, sha); assert.equal(receipt.sourceBytes, bytes.length);
        assert.equal(receipt.target.documentId, native.document.documentId); assert.equal(receipt.target.lineageId, native.document.lineageId);
        assert.equal(receipt.target.lifecycleGeneration, native.document.lifecycleGeneration); assert.equal(receipt.target.initialSequence, 0);
        assert.equal(receipt.target.hasBom, text.startsWith('\uFEFF')); assert.equal(receipt.target.newlineStyle, /\r\n/u.test(text) ? 'crlf' : 'lf');
        assert.equal(rows.registry[0].body.id, native.document.documentId); assert.equal(rows.registry[0].body.lineage_id, native.document.lineageId);
        assert.equal(rows.births[0].body.document_id, native.document.documentId); assert.equal(Number(rows.births[0].body.finalized), 1);
        assert.equal(rows.births[0].body.serialized_hash, sha);
        const state = await loadCollaborationStateOnConnection(h.connection, native.document.documentId); assert(state);
        assert.equal(state.documentSequence, 0); assert.equal(state.checkpointSequence, 0); assert.notEqual(state.checkpointedAt, null);
        assert.equal(state.representation, native.document.representation); assert.equal(state.newlineStyle, receipt.target.newlineStyle);
        assert.equal(state.hasBom, receipt.target.hasBom);
        const canonical = (text.startsWith('\uFEFF') ? text.slice(1) : text).replace(/\r\n/gu, '\n');
        assert.equal(authoritativeCollaborationSnapshot(state).canonicalContent, canonical);
        const page = await readDocumentForRequest(await h.request(h.source, 'owner'), { apiVersion: 1,
          workspaceId: h.source.workspaceId, documentId: native.document.documentId, format: 'native', maxBytes: 262144 });
        assert.equal(page.complete, true); assert.equal(page.nextCursor, null); assert.deepEqual(page.document, native.document);
        assert.deepEqual(JSON.parse(page.fragment).content, JSON.parse(JSON.stringify(authoritativeNativeCollaborationSnapshot(state).content)));
        assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, target)), bytes);
        const original = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath, workspaceId: h.source.workspaceId, operationId: native.operationId });
        assert.equal(original.complete, true); assert.equal(original.id, rows.births[0].body.claim_id);
        return rows;
      };

      const sidA = sessions.get('sid-a')!, sidB = sessions.get('sid-b')!;
      const repeatedPath = `pi-repeat-${crypto.randomUUID()}.md`, repeatedText = 'The first PI body remains the original. 😀\n';
      const stableKey = `explicit-create-${crypto.randomUUID()}`, firstCall = `original-tool-call-${crypto.randomUUID()}`;
      phase = 'Explicit stable key replay and changed body conflict retain the complete immutable original';
      const first = await piMarkdownCreateCall(sidA, repeatedPath, repeatedText, stableKey, firstCall);
      const firstRows = await piMarkdownCreateAssertResult(first, repeatedPath, repeatedText, sidA.sessionId, 'created');
      const firstOriginal = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath,
        workspaceId: h.source.workspaceId, operationId: first.nativeCreate!.operationId });
      const originalSource = firstOriginal.intent.source as Record<string, unknown>, originalOrigin = firstOriginal.intent.origin as Record<string, unknown>;
      assert.equal(originalSource.kind, 'agent-markdown-v1'); assert.equal(originalSource.workspaceId, h.source.workspaceId);
      assert.equal(originalSource.targetPath, repeatedPath); assert.equal(originalSource.actorUserId, 'owner');
      assert.equal(originalSource.actorSessionId, sidA.sessionId); assert.equal(originalSource.agentId, agentId);
      assert.equal(originalSource.toolName, 'write'); assert.equal(originalSource.toolCallId, firstCall);
      assert.equal(originalSource.operationId, first.nativeCreate!.operationId); assert.equal(originalSource.requestId, `agent-create:${first.nativeCreate!.operationId}`);
      assert.equal(originalSource.sourceHash, crypto.createHash('sha256').update(repeatedText).digest('hex'));
      assert.equal(originalSource.sourceBytes, Buffer.byteLength(repeatedText)); assert.match(String(originalSource.requestFingerprint), /^[a-f0-9]{64}$/u);
      assert.equal(originalOrigin.userId, 'owner'); assert.equal(originalOrigin.piSessionId, sidA.sessionId);
      assert.equal(originalOrigin.agentId, agentId); assert.equal(originalOrigin.toolName, 'write'); assert.equal(originalOrigin.toolCallId, firstCall);
      assert.equal(originalOrigin.workspaceId, h.source.workspaceId); assert.equal(originalOrigin.schema, h.schema);
      assert.equal(String(originalOrigin.schemaOid), h.schemaOid); assert.equal(originalOrigin.rootPath, h.source.rootPath);
      const piIdentity = (await h.admin.query('SELECT id FROM pi_sessions WHERE session_id=$1', [sidA.sessionId])).rows;
      const profileIdentity = (await h.admin.query('SELECT id,revision FROM agents WHERE agent_id=$1', [agentId])).rows;
      assert.equal(piIdentity.length, 1); assert.equal(profileIdentity.length, 1);
      assert.equal(originalOrigin.piSessionDbId, Number(piIdentity[0].id)); assert.equal(originalOrigin.agentProfileId, Number(profileIdentity[0].id));
      assert.equal(originalOrigin.agentProfileRevision, Number(profileIdentity[0].revision));
      const replay = await piMarkdownCreateNoWrites(() => piMarkdownCreateCall(sidA, repeatedPath, repeatedText, stableKey));
      assert.equal(replay.changed, false); assert.equal(replay.nativeCreate?.operationId, first.nativeCreate!.operationId);
      await piMarkdownCreateAssertResult(replay, repeatedPath, repeatedText, sidA.sessionId, 'already_created');
      await piMarkdownCreateNoWrites(async () => {
        await assert.rejects(() => piMarkdownCreateCall(sidA, repeatedPath, repeatedText + 'Changed body must conflict.\n', stableKey),
          { code: 'MARKDOWN_IMPORT_REQUEST_CONFLICT' });
      });
      assert.deepEqual(await piMarkdownCreateObserveRows(repeatedPath), firstRows);
      assert.deepEqual(await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath,
        workspaceId: h.source.workspaceId, operationId: first.nativeCreate!.operationId }), firstOriginal);
      groups++; console.log('PASS PI Markdown create: explicit key replay and changed body preserve all original receipt facts/xmin');

      phase = 'Genuine SID-B reuses the same explicit key and retains original SID-A attribution';
      assert.notEqual(sidA.sessionId, sidB.sessionId);
      const renewed = await piMarkdownCreateNoWrites(() => piMarkdownCreateCall(sidB, repeatedPath, repeatedText, stableKey));
      assert.equal(renewed.changed, false); assert.equal(renewed.nativeCreate?.operationId, first.nativeCreate!.operationId);
      await piMarkdownCreateAssertResult(renewed, repeatedPath, repeatedText, sidA.sessionId, 'already_created');
      assert.deepEqual(await piMarkdownCreateObserveRows(repeatedPath), firstRows);
      assert.deepEqual(await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath,
        workspaceId: h.source.workspaceId, operationId: first.nativeCreate!.operationId }), firstOriginal);
      const piMarkdownCreateCoreToolReplay = async () => {
        const tool = piTools.find(candidate => candidate.name === 'write'); assert(tool);
        const properties = Reflect.get(tool.parameters, 'properties'); assert(properties && typeof properties === 'object');
        assert(Object.hasOwn(properties, 'idempotencyKey'), 'The actual write tool schema must disclose the stable retry key.');
        const currentCall = `actual-core-tool-replay-${crypto.randomUUID()}`; assert.notEqual(currentCall, firstCall);
        return runWithAgentExecutionContext(sidB, () => withAgentToolInvocation(sidB, { toolName: 'write', toolCallId: currentCall },
          () => tool.execute(currentCall, { path: repeatedPath, content: repeatedText, idempotencyKey: stableKey })));
      };
      const actualTool = await piMarkdownCreateNoWrites(piMarkdownCreateCoreToolReplay);
      assert.notEqual(Reflect.get(actualTool, 'isError'), true); assert(actualTool.details && typeof actualTool.details === 'object');
      assert.equal(Reflect.get(actualTool.details, 'outcome'), 'unchanged');
      assert.equal(Reflect.get(actualTool.details, 'changed'), false);
      assert.deepEqual(Reflect.get(actualTool.details, 'nativeCreate'), renewed.nativeCreate);
      const toolText = actualTool.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      assert(toolText.includes(first.nativeCreate!.document.documentId)); assert(toolText.includes(first.nativeCreate!.operationId));
      assert.deepEqual(await piMarkdownCreateObserveRows(repeatedPath), firstRows);
      groups++; console.log('PASS PI Markdown create: actual SID-B explicit-key replay is NoWrite and preserves SID-A original');

      phase = 'Current workspace ACL and actual agent tool policy reject before any mutation or raw fallback';
      const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
      const { upsertPostgresWorkspaceMemberForActor } = await import('../app/lib/workspaces/postgres-runtime');
      const actor = resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' });
      await upsertPostgresWorkspaceMemberForActor(actor, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false });
      const member = sessions.get('readonly')!;
      const onceWritable = await resolveAgentExecutionContextForStoredSession({ sessionId: member.sessionId, userId: 'member', agentId,
        permissions: ['canRead', 'canRunAgent', 'canWrite'] });
      assert.equal(onceWritable.canWrite, true);
      await runWithAgentExecutionContext(onceWritable, () => withAgentToolInvocation(onceWritable,
        { toolName: 'write', toolCallId: `prewarm-${crypto.randomUUID()}` }, async () => undefined));
      await upsertPostgresWorkspaceMemberForActor(actor, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: false, canManage: false });
      const deniedPath = `pi-denied-${crypto.randomUUID()}.md`;
      await piMarkdownCreateNoWrites(async () => {
        await assert.rejects(() => piMarkdownCreateCall(onceWritable, deniedPath, 'Must not be written.\n', `denied-${crypto.randomUUID()}`),
          error => error instanceof Error && error.constructor === Error && error.message === 'Workspace permission denied'
            && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'WORKSPACE_PERMISSION_DENIED'
            && Object.getOwnPropertyDescriptor(error, 'status')?.value === 403);
      });
      await assert.rejects(fs.lstat(path.join(h.source.rootPath, deniedPath)), { code: 'ENOENT' });
      assert.deepEqual(await piMarkdownCreateObserveRows(deniedPath), { registry: [], receipts: [], births: [] });
      await h.admin.query('UPDATE agents SET enabled_tools_json=$1 WHERE agent_id=$2', ['["read"]', agentId]);
      try {
        await piMarkdownCreateNoWrites(async () => {
          await assert.rejects(() => piMarkdownCreateCall(sidB, repeatedPath, repeatedText, stableKey), { code: 'TOOL_POLICY_DENIED' });
        });
      } finally { await h.admin.query('UPDATE agents SET enabled_tools_json=$1 WHERE agent_id=$2', ['["write"]', agentId]); }
      assert.deepEqual(await piMarkdownCreateObserveRows(repeatedPath), firstRows);
      groups++; console.log('PASS PI Markdown create: actual fresh ACL and revoked tool policy reject with all NoWrite oracles');

      phase = 'Empty document and full pasted Markdown retain the supported native profile and all source bytes';
      const pasted = '\uFEFF---\r\ntitle: PI pasted document\r\naliases: [PI Paste]\r\n---\r\n# Pasted document\r\n\r\nText with **strong text**, äöü and 😀.\r\n\r\n[External](https://example.test/path#section)\r\n';
      for (const [label, text] of [['empty', ''], ['pasted', pasted]] as const) {
        const target = `pi-${label}-${crypto.randomUUID()}.md`;
        const created = await piMarkdownCreateCall(sidA, target, text, `pi-profile-${crypto.randomUUID()}`);
        assert.equal(created.changed, true); assert.equal(created.beforeSha256, null);
        await piMarkdownCreateAssertResult(created, target, text, sidA.sessionId, 'created');
      }
      groups++; console.log('PASS PI Markdown create: empty and full BOM/CRLF/frontmatter Markdown native births preserve source profile');

      phase = 'Existing raw source and native missing/zero-byte projections never acquire a duplicate Create birth';
      const rawPath = `pi-existing-raw-${crypto.randomUUID()}.md`, rawText = 'Existing raw source remains an existing-file operation.\n';
      const rawSha = crypto.createHash('sha256').update(rawText).digest('hex');
      await fs.writeFile(path.join(h.source.rootPath, rawPath), rawText, { flag: 'wx', mode: 0o600 });
      const rawResult = await piMarkdownCreateCall(sidA, rawPath, rawText, `raw-existing-${crypto.randomUUID()}`, undefined, 'write', rawSha);
      assert.equal(rawResult.nativeCreate, undefined); assert.equal(rawResult.changed, false);
      assert.equal((await piMarkdownCreateObserveRows(rawPath)).births.length, 0);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, rawPath)), Buffer.from(rawText));
      for (const profile of ['missing', 'zero'] as const) {
        const target = `pi-native-${profile}-${crypto.randomUUID()}.md`, text = `Native ${profile} original content.\n`;
        const uploaded = await h.upload(target, Buffer.from(text));
        const originalState = await loadCollaborationStateOnConnection(h.connection, uploaded.documentId); assert(originalState);
        const immutable = await piMarkdownCreateObserveRows(target);
        // The genuine Web upload already has its own completed native birth.
        assert.equal(immutable.births.length, 1); assert.equal(immutable.receipts.length, 1);
        assert.equal(immutable.births[0].body.document_id, uploaded.documentId);
        assert.equal(immutable.receipts[0].body.actor_session_id, 'session-owner');
        if (profile === 'missing') await fs.unlink(path.join(h.source.rootPath, target));
        else await fs.writeFile(path.join(h.source.rootPath, target), Buffer.alloc(0));
        await piMarkdownCreateNoWrites(async () => {
          await assert.rejects(() => piMarkdownCreateCall(sidA, target, text, `existing-native-${crypto.randomUUID()}`,
            undefined, 'write', profile === 'zero' ? crypto.createHash('sha256').update('').digest('hex') : undefined),
          { code: 'MARKDOWN_IMPORT_LIFECYCLE_REQUIRED' });
        });
        assert.deepEqual(await piMarkdownCreateObserveRows(target), immutable);
        const current = await loadCollaborationStateOnConnection(h.connection, uploaded.documentId); assert(current);
        assert.deepEqual(current, originalState);
        if (profile === 'missing') await assert.rejects(fs.lstat(path.join(h.source.rootPath, target)), { code: 'ENOENT' });
        else assert.equal((await fs.lstat(path.join(h.source.rootPath, target))).size, 0);
      }
      groups++; console.log('PASS PI Markdown create: occupied raw/native paths have no duplicate birth or raw replacement');

      phase = 'Existing pdf_to_markdown helper without explicit key uses only its genuine tool call fallback';
      await h.admin.query('UPDATE agents SET enabled_tools_json=$1 WHERE agent_id=$2', ['["write","pdf_to_markdown"]', agentId]);
      const pdfPath = `pi-pdf-helper-${crypto.randomUUID()}.md`, pdfText = 'Already parsed PDF text reaches the central Markdown Create helper.\n';
      const pdfCall = `genuine-pdf-call-${crypto.randomUUID()}`;
      const pdf = await piMarkdownCreateCall(sidA, pdfPath, pdfText, undefined, pdfCall, 'pdf_to_markdown');
      const pdfRows = await piMarkdownCreateAssertResult(pdf, pdfPath, pdfText, sidA.sessionId, 'created');
      const pdfRepeated = await piMarkdownCreateNoWrites(() => piMarkdownCreateCall(sidA, pdfPath, pdfText, undefined, pdfCall, 'pdf_to_markdown'));
      assert.equal(pdfRepeated.changed, false); assert.equal(pdfRepeated.nativeCreate?.operationId, pdf.nativeCreate!.operationId);
      await piMarkdownCreateAssertResult(pdfRepeated, pdfPath, pdfText, sidA.sessionId, 'already_created');
      assert.deepEqual(await piMarkdownCreateObserveRows(pdfPath), pdfRows);
      groups++; console.log('PASS PI Markdown create: genuine PDF-helper invocation fallback and exact-call replay, without a conversion claim');

      // V5 isolates the review-confirmed mutable-ALS eligibility regression.
      // No filesystem/path method, invocation primitive or SQL is replaced.
      const piMarkdownCreateMutableOriginDrift = async () => {
        phase = 'A genuine PI legacy-origin drift during the first actual path await rejects before native or raw mutation';
        const target = `pi-origin-drift-${crypto.randomUUID()}.md`, key = `pi-origin-drift-key-${crypto.randomUUID()}`;
        const originalLegacy = sidA.legacy; assert.equal(originalLegacy, false); assert.equal(Object.isFrozen(sidA), false);
        let entered = false, dispatched = false, mutated = false, restored = false;
        await piMarkdownCreateNoWrites(async () => {
          await assert.rejects(() => runWithAgentExecutionContext(sidA, () => withAgentToolInvocation(sidA,
            { toolName: 'write', toolCallId: `actual-origin-drift-${crypto.randomUUID()}` }, () => {
              entered = true;
              // Async write dispatch runs synchronously through its first
              // real path-validation await before returning this Promise.
              // Change the actual stored-session context while that genuine
              // await is outstanding, without stubbing any path operation.
              const pending = writeAgentTextFile({ path: target, content: 'Mutable origin must never turn a native creation into a raw write.\n',
                operation: 'write', idempotencyKey: key });
              dispatched = true; sidA.legacy = true; mutated = true;
              return pending.finally(() => {
                // Restore before the ordinary outer invocation's final check.
                // Only a guard pinned across the actual path await can catch
                // this transient downgrade; a late final check is insufficient.
                sidA.legacy = originalLegacy; restored = true;
              });
            })), { code: 'AGENT_TOOL_INVOCATION_ORIGIN_CHANGED' });
        });
        assert(entered && dispatched && mutated && restored); assert.equal(sidA.legacy, originalLegacy);
        await assert.rejects(fs.lstat(path.join(h.source.rootPath, target)), { code: 'ENOENT' });
        assert.deepEqual(await piMarkdownCreateObserveRows(target), { registry: [], receipts: [], births: [] });
        console.log('PI_CREATE_MUTABLE_ORIGIN', JSON.stringify({ entered, dispatched, mutated, restored, legacy: sidA.legacy }));
      };
      await piMarkdownCreateMutableOriginDrift();
      groups++; console.log('PASS PI Markdown create: transient genuine legacy-origin drift is poisoned before all native/raw writes');
      // Explicit fresh-Agent MVP limit. The original 6MiB PRINCIPAL_EXPIRED
      // counterexample remains frozen separately as deferred size work.
      const piMarkdownCreateLargeBoundary = async () => {
        phase = 'The fresh-Agent MVP accepts exactly 1MiB UTF-8 with genuine native birth and cursor read';
        const target = `pi-large-${crypto.randomUUID()}.md`, key = `pi-large-key-${crypto.randomUUID()}`;
        const prefix = '<!-- Preserve unsupported Markdown source bytes at the agent boundary. -->\n';
        const remaining = 1024 ** 2 - Buffer.byteLength(prefix) - 1;
        const text = prefix + '"\t'.repeat(Math.floor(remaining / 2)) + (remaining % 2 ? '"' : '') + '\n';
        const bytes = Buffer.from(text), sha = crypto.createHash('sha256').update(bytes).digest('hex');
        assert.equal(bytes.length, 1024 ** 2);
        const escapedJsonBytes = Buffer.byteLength(JSON.stringify(text));
        assert(escapedJsonBytes > bytes.length);
        // Actual markdown-create-birth prepare uses these fields plus its
        // fixed action/key/intent envelope. This is a strict lower bound of
        // the real base64 JSON message, not an invented transport format.
        const prepareJsonLowerBound = Buffer.byteLength(JSON.stringify({ bytes: bytes.toString('base64'), serializedHash: sha }));
        assert(prepareJsonLowerBound > bytes.length);
        console.log('PI_CREATE_LARGE_INPUT', JSON.stringify({ sourceBytes: bytes.length, escapedJsonBytes, prepareJsonLowerBound }));
        const created = await piMarkdownCreateCall(sidA, target, text, key);
        assert.equal(created.changed, true); assert.equal(created.beforeSha256, null);
        assert.equal(created.afterSha256, sha); assert.equal(created.size, bytes.length);
        const native = created.nativeCreate; assert(native); assert.equal(native.outcome, 'created');
        assert.equal(native.document.workspaceId, h.source.workspaceId); assert.equal(native.document.path, target);
        assert.equal(native.projection.status, 'current'); assert.equal(native.currency.observedDurable, true);
        const rows = await piMarkdownCreateObserveRows(target);
        assert.equal(rows.registry.length, 1); assert.equal(rows.receipts.length, 1); assert.equal(rows.births.length, 1);
        const receiptRow = rows.receipts[0].body, receipt = receiptRow.private_result as MarkdownFileImportReceipt;
        assert.equal(receiptRow.actor_user_id, 'owner'); assert.equal(receiptRow.actor_session_id, sidA.sessionId);
        assert.equal(receipt.operationId, native.operationId); assert.equal(receipt.sourceBytes, bytes.length); assert.equal(receipt.sourceHash, sha);
        assert.equal(receipt.target.documentId, native.document.documentId); assert.equal(receipt.target.lineageId, native.document.lineageId);
        assert.equal(receipt.target.initialSequence, 0); assert.equal(receipt.target.lifecycleGeneration, 1);
        assert.equal(rows.registry[0].body.id, native.document.documentId); assert.equal(rows.registry[0].body.lineage_id, native.document.lineageId);
        assert.equal(rows.births[0].body.document_id, native.document.documentId); assert.equal(Number(rows.births[0].body.finalized), 1);
        assert.equal(rows.births[0].body.serialized_hash, sha);
        const lineages = (await h.admin.query('SELECT id,status,workspace_id FROM file_collaboration_lineages WHERE id=$1', [native.document.lineageId])).rows;
        assert.equal(lineages.length, 1); assert.equal(lineages[0].status, 'active'); assert.equal(lineages[0].workspace_id, h.source.workspaceId);
        const projections = (await h.admin.query('SELECT * FROM collaboration_file_projections WHERE document_id=$1', [native.document.documentId])).rows;
        assert.equal(projections.length, 1); assert.equal(Number(projections[0].finalized), 1);
        assert.equal(projections[0].serialized_hash, sha); assert.equal(projections[0].revision_id, rows.births[0].body.revision_id);
        const original = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath, workspaceId: h.source.workspaceId, operationId: native.operationId });
        assert.equal(original.complete, true); assert.equal(original.serializedHash, sha); assert.equal(original.id, rows.births[0].body.claim_id);
        const state = await loadCollaborationStateOnConnection(h.connection, native.document.documentId); assert(state);
        assert.equal(state.documentSequence, 0); assert.equal(state.checkpointSequence, 0); assert.notEqual(state.checkpointedAt, null);
        assert.equal(state.representation, receipt.target.representation);
        assert.equal(crypto.createHash('sha256').update(authoritativeCollaborationSnapshot(state).canonicalContent).digest('hex'), sha);
        const snapshot = authoritativeNativeCollaborationSnapshot(state); assert.equal(snapshot.version.stateProof, receipt.target.initialStateProof);
        const actualBytes = await fs.readFile(path.join(h.source.rootPath, target));
        assert.equal(actualBytes.length, bytes.length); assert.equal(crypto.createHash('sha256').update(actualBytes).digest('hex'), sha);

        const fragments: string[] = []; let cursor: string | undefined, offset = 0, total = -1, pages = 0, finished = false;
        for (; pages < 256; pages++) {
          const page = await readDocumentForRequest(await h.request(h.source, 'owner'), { apiVersion: 1, workspaceId: h.source.workspaceId,
            documentId: native.document.documentId, format: 'native', maxBytes: 262144, ...(cursor === undefined ? {} : { cursor }) });
          assert.deepEqual(page.document, native.document); assert.equal(page.byteOffset, offset);
          assert.equal(page.byteLength, Buffer.byteLength(page.fragment)); assert(page.byteLength > 0 && page.byteLength <= 262144);
          if (total === -1) { total = page.totalBytes; assert(total > 262144 && total <= 64 * 1024 ** 2); }
          else assert.equal(page.totalBytes, total);
          offset += page.byteLength; assert(offset <= total); fragments.push(page.fragment);
          if (page.complete) { assert.equal(page.nextCursor, null); assert.equal(offset, total); finished = true; pages++; break; }
          assert.equal(typeof page.nextCursor, 'string'); assert(page.nextCursor); cursor = page.nextCursor;
        }
        assert(finished && pages > 1 && pages <= 256, 'The genuine native ID read must finish through its actual continuation cursor.');
        const joined = fragments.join(''); assert.equal(Buffer.byteLength(joined), total);
        const read = JSON.parse(joined) as { representation: string; content: unknown };
        assert.equal(read.representation, state.representation);
        assert.equal(crypto.createHash('sha256').update(JSON.stringify(read.content)).digest('hex'),
          crypto.createHash('sha256').update(JSON.stringify(snapshot.content)).digest('hex'));
        console.log('PI_CREATE_LARGE_NATIVE_READ', JSON.stringify({ pages, totalBytes: total, complete: finished }));

        const replay = await piMarkdownCreateNoWrites(() => piMarkdownCreateCall(sidB, target, text, key));
        assert.equal(replay.changed, false); assert.equal(replay.nativeCreate?.outcome, 'already_created');
        assert.equal(replay.nativeCreate?.operationId, native.operationId); assert.deepEqual(replay.nativeCreate?.document, native.document);
        assert.deepEqual(await piMarkdownCreateObserveRows(target), rows);
        assert.deepEqual(await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath,
          workspaceId: h.source.workspaceId, operationId: native.operationId }), original);

        phase = 'Fresh-Agent UTF-8 source over 1MiB rejects before Birth/raw fallback even below 1MiB UTF-16';
        const overMvpTarget = `pi-over-mvp-limit-${crypto.randomUUID()}.md`, overMvp = 'ß'.repeat(512 * 1024 + 1);
        assert(overMvp.length < 1024 ** 2); assert(Buffer.byteLength(overMvp) > 1024 ** 2);
        await piMarkdownCreateNoWrites(async () => {
          await assert.rejects(() => piMarkdownCreateCall(sidA, overMvpTarget, overMvp, `pi-over-mvp-limit-${crypto.randomUUID()}`),
            { code: 'MARKDOWN_IMPORT_INVALID_INPUT' });
        });
        await assert.rejects(fs.lstat(path.join(h.source.rootPath, overMvpTarget)), { code: 'ENOENT' });
        assert.deepEqual(await piMarkdownCreateObserveRows(overMvpTarget), { registry: [], receipts: [], births: [] });

        phase = 'UTF-8 source over 8MiB rejects before a raw fallback; a pure limit denial may issue zero SQL';
        const oversizedTarget = `pi-over-limit-${crypto.randomUUID()}.md`, oversized = 'ß'.repeat(4 * 1024 * 1024 + 1);
        assert(oversized.length < 8 * 1024 ** 2); assert(Buffer.byteLength(oversized) > 8 * 1024 ** 2);
        await piMarkdownCreateNoWrites(async () => {
          await assert.rejects(() => piMarkdownCreateCall(sidA, oversizedTarget, oversized, `pi-over-limit-${crypto.randomUUID()}`),
            { code: 'MARKDOWN_IMPORT_INVALID_INPUT' });
        });
        await assert.rejects(fs.lstat(path.join(h.source.rootPath, oversizedTarget)), { code: 'ENOENT' });
        assert.deepEqual(await piMarkdownCreateObserveRows(oversizedTarget), { registry: [], receipts: [], births: [] });
      };
      await piMarkdownCreateLargeBoundary();
      groups++; console.log('PASS PI Markdown create: exact 1MiB fresh-Agent MVP limit, full cursor read, historical replay and >1MiB/>8MiB UTF-8 rejection');
      // V4 is independent of the separate large-boundary V3. The seven
      // original small families above remain byte-for-byte unchanged.
      const piMarkdownCreateCommitAckLoss = async () => {
        phase = 'Actual import/Birth COMMIT succeeds and loses one ACK; the central Agent branch confirms the original';
        const target = `pi-commit-ack-${crypto.randomUUID()}.md`, text = 'One actual committed native PI creation survives its lost acknowledgement.\n';
        const key = `pi-commit-ack-key-${crypto.randomUUID()}`, callId = `pi-commit-ack-call-${crypto.randomUUID()}`;
        const receiptClients = new Set<MetadataSqlEvent['client']>(), birthClients = new Set<MetadataSqlEvent['client']>();
        let lost = 0, originalClient: MetadataSqlEvent['client'] | undefined, recoveryReads = 0;
        let committed: Awaited<ReturnType<typeof piMarkdownCreateObserveRows>> | undefined;
        const result = await h.withProbe(async event => {
          if (/\bINSERT\s+INTO\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?collaboration_markdown_file_import_receipts"?(?=\s|\()/iu.test(event.text)) receiptClients.add(event.client);
          if (/\bINSERT\s+INTO\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?collaboration_markdown_create_births"?(?=\s|\()/iu.test(event.text)) birthClients.add(event.client);
          if (lost === 0 && receiptClients.has(event.client) && /^\s*COMMIT\s*$/iu.test(event.text)) {
            assert.equal(event.result.command, 'COMMIT'); assert.equal(receiptClients.size, 1);
            assert(birthClients.has(event.client)); assert.equal(birthClients.size, 1);
            originalClient = event.client;
            // This independent real reader sees committed rows before the
            // acknowledgement is lost; no SQL result is replaced or forged.
            committed = await piMarkdownCreateObserveRows(target);
            assert.equal(committed.receipts.length, 1); assert.equal(committed.births.length, 1);
            assert.equal(committed.receipts[0].body.actor_session_id, sidA.sessionId);
            assert.equal(Number(committed.births[0].body.finalized), 0);
            lost++;
            throw Object.assign(new Error('Fixture lost the actual completed PI import COMMIT acknowledgement.'), { code: 'PI_CREATE_FIXTURE_ACK_LOST' });
          }
          if (lost === 1 && /\b(?:FROM|JOIN)\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?collaboration_markdown_file_import_receipts"?\b/iu.test(event.text)) {
            assert.notEqual(event.client, originalClient, 'Recovery must observe durable original rows on a real different client after discarded B.'); recoveryReads++;
          }
        }, () => piMarkdownCreateCall(sidA, target, text, key, callId));
        assert.equal(lost, 1); assert(recoveryReads > 0); assert(committed);
        const completed = await piMarkdownCreateAssertResult(result, target, text, sidA.sessionId, 'created');
        assert.deepEqual(completed.receipts, committed.receipts, 'The actual committed original import receipt/xmin cannot be recreated.');
        const birth = completed.births[0].body, before = committed.births[0].body;
        for (const field of ['workspace_id', 'operation_id', 'document_id', 'lifecycle_generation', 'claim_id', 'claim_fingerprint', 'request_fingerprint']) {
          assert.deepEqual(birth[field], before[field]);
        }
        const original = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath,
          workspaceId: h.source.workspaceId, operationId: result.nativeCreate!.operationId });
        const source = original.intent.source as Record<string, unknown>;
        assert.equal(source.actorSessionId, sidA.sessionId); assert.equal(source.agentId, agentId); assert.equal(source.toolCallId, callId);
        const replay = await piMarkdownCreateNoWrites(() => piMarkdownCreateCall(sidB, target, text, key));
        assert.equal(replay.changed, false); assert.equal(replay.nativeCreate?.operationId, result.nativeCreate!.operationId);
        assert.equal(replay.nativeCreate?.outcome, 'already_created');
        assert.deepEqual(await piMarkdownCreateObserveRows(target), completed);
        assert.deepEqual(await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath,
          workspaceId: h.source.workspaceId, operationId: result.nativeCreate!.operationId }), original);
        console.log('PI_CREATE_COMMIT_ACK', JSON.stringify({ lost, receiptClients: receiptClients.size, birthClients: birthClients.size, recoveryReads }));
      };
      await piMarkdownCreateCommitAckLoss();
      groups++; console.log('PASS PI Markdown create: actual successful COMMIT/lost ACK confirms one original birth and immutable PI attribution');

      const piMarkdownCreateInitialTempShadow = async () => {
        phase = 'The new Agent initial Create principal rejects a real TEMP shadow before canonical pin or native mutation';
        const target = `pi-initial-shadow-${crypto.randomUUID()}.md`, key = `pi-initial-shadow-key-${crypto.randomUUID()}`;
        const beforeRows = await piMarkdownCreateDomainSnapshot(), beforeFiles = await piMarkdownCreateFilesystem();
        let shadowClient: MetadataSqlEvent['client'] | undefined, injected = false, resolvedShadow = false, rolledBack = false;
        let nativeWrites = 0, normalizingSets = 0, observedError: unknown; const failures: unknown[] = [];
        try {
          await h.withProbe(async event => {
            if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'NOTIFY'].includes(event.result.command)
              || /\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX)|NOTIFY)\b/iu.test(event.text)
              || /\bpg_notify\s*\(/iu.test(event.text)) nativeWrites++;
            if (/\bset_config\s*\(\s*'search_path'/iu.test(event.text)) normalizingSets++;
            if (!injected && /^\s*SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE\s*$/iu.test(event.text)) {
              shadowClient = event.client;
              // The first actual B phase is before operation-ID/FD Birth
              // creation. This raw call executes real, explicitly-owned test
              // setup; it never substitutes a product query or its result.
              const before = (await event.raw('SELECT current_schema() AS schema,current_setting(\'search_path\') AS search_path')).rows[0];
              assert.equal(before.schema, h.schema); assert.equal(before.search_path.includes('pg_temp'), false);
              await event.raw('CREATE TEMP TABLE pi_sessions(id bigint) ON COMMIT PRESERVE ROWS'); injected = true;
              const proof = (await event.raw(`SELECT to_regclass('pi_sessions')::oid::text AS resolved,
                to_regclass(quote_ident($1)||'.pi_sessions')::oid::text AS original`, [h.schema])).rows[0];
              assert.equal(typeof proof.resolved, 'string'); assert.equal(typeof proof.original, 'string');
              assert.notEqual(proof.resolved, proof.original); resolvedShadow = true;
            }
            if (injected && event.client === shadowClient && /^\s*ROLLBACK\s*$/iu.test(event.text)) {
              assert.equal(event.result.command, 'ROLLBACK');
              assert.equal((await event.raw("SELECT to_regclass('pg_temp.pi_sessions')::text AS shadow")).rows[0].shadow, null);
              rolledBack = true;
            }
          }, async () => {
            try { await piMarkdownCreateCall(sidA, target, 'Must not acquire a native or raw birth.\n', key); }
            catch (error) { observedError = error; throw error; }
          });
          failures.push(new Error('The actual new Agent initial principal must reject its TEMP relation shadow.'));
        } catch (error) {
          try {
            assert.equal(error, observedError); assert(error instanceof Error);
            // Exact first initial phase, before inner try/operation ID. Later
            // Create-phase uncertainty is a separate COMMIT_UNCONFIRMED arm.
            assert.equal(Object.getOwnPropertyDescriptor(error, 'code')?.value, 'PRINCIPAL_SCHEMA_INVALID');
            assert.equal(Object.hasOwn(error, 'operationId'), false); assert.equal(Object.hasOwn(error, 'cause'), false);
          } catch (failure) { failures.push(failure); }
        }
        const checks = await Promise.allSettled([
          (async () => assert.deepEqual(await piMarkdownCreateDomainSnapshot(), beforeRows))(),
          (async () => assert.deepEqual(await piMarkdownCreateFilesystem(), beforeFiles))(),
          (async () => { assert(injected && resolvedShadow && rolledBack); assert.equal(nativeWrites, 0); assert.equal(normalizingSets, 0); })(),
        ]);
        failures.push(...checks.flatMap(check => check.status === 'rejected' ? [check.reason as unknown] : []));
        console.log('PI_CREATE_INITIAL_SHADOW', JSON.stringify({ injected, resolvedShadow, rolledBack, nativeWrites, normalizingSets,
          checks: checks.map(check => check.status) }));
        if (failures.length === 1) throw failures[0]; if (failures.length) throw new AggregateError(failures, 'Initial PI Create shadow NoWrite oracles failed.');
        await assert.rejects(fs.lstat(path.join(h.source.rootPath, target)), { code: 'ENOENT' });
        assert.deepEqual(await piMarkdownCreateObserveRows(target), { registry: [], receipts: [], births: [] });
      };
      await piMarkdownCreateInitialTempShadow();
      groups++; console.log('PASS PI Markdown create: actual initial TEMP shadow is rejected without normalization, native/raw writes or persistent residue');

      const piMarkdownCreateEncodingError = async () => {
        phase = 'The actual write tool preserves a known mixed-newline encoding error without a native/raw target';
        const target = `pi-invalid-encoding-${crypto.randomUUID()}.md`, key = `pi-invalid-encoding-key-${crypto.randomUUID()}`;
        const callId = `actual-encoding-tool-${crypto.randomUUID()}`, text = 'First line uses CRLF.\r\nSecond line uses LF.\n';
        const tool = piTools.find(candidate => candidate.name === 'write'); assert(tool);
        const { wrapToolWithExecutionContext } = await import('../app/lib/pi/tool-runtime-helpers');
        // Enter the same genuine runtime wrapper used by the tool registry.
        // It must drain/terminate the real invocation before mapping this known
        // Markdown error; the nested origin/failure guards remain active.
        // Private attempt journals may exist, so no full NoWrite is claimed.
        const output = await wrapToolWithExecutionContext(tool, sidA).execute(callId,
          { path: target, content: text, idempotencyKey: key });
        assert.equal(Reflect.get(output, 'isError'), true); assert(output.details && typeof output.details === 'object');
        assert.equal(Reflect.get(output.details, 'contractVersion'), 1);
        assert.equal(Reflect.get(output.details, 'kind'), 'file_mutation_error');
        assert.equal(Reflect.get(output.details, 'operation'), 'write');
        assert.equal(Reflect.get(output.details, 'path'), target);
        assert.equal(Reflect.get(output.details, 'code'), 'MARKDOWN_IMPORT_ENCODING_UNSUPPORTED');
        assert.equal(Reflect.get(output.details, 'outcome'), 'blocked');
        assert.equal(Reflect.get(output.details, 'safeToAutoRetry'), false);
        assert.equal(Reflect.get(output.details, 'nativeCreate'), undefined);
        assert.equal(Reflect.get(output.details, 'collaboration'), undefined);
        // This exact known Prepare denial has no commit/outcome uncertainty
        // and currently carries no genuine operationId/key to publish.
        assert.equal(Reflect.get(output.details, 'operationId'), undefined);
        assert.equal(Reflect.get(output.details, 'idempotencyKey'), undefined);
        const message = output.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        assert(message.includes('MARKDOWN_IMPORT_ENCODING_UNSUPPORTED'));
        assert.equal(message.includes('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED'), false);
        await assert.rejects(fs.lstat(path.join(h.source.rootPath, target)), { code: 'ENOENT' });
        assert.deepEqual(await piMarkdownCreateObserveRows(target), { registry: [], receipts: [], births: [] });
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2',
          [h.source.workspaceId, target])).rows[0].n, 0);
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM file_collaboration_lineages WHERE workspace_id=$1 AND path=$2',
          [h.source.workspaceId, target])).rows[0].n, 0);


        // Transport-only fixtures below exercise the HIGH shared wrapper. The
        // test values are not actual commits, receipts, native IDs or rights;
        // actual owner/create acceptance remains in the eleven families above.
        const { MarkdownFileImportError } = await import('../app/lib/collaboration/markdown-file-import');
        const fixtureOperationId = `test-transport-only-operation-${crypto.randomUUID()}`;
        const fixtureKey = `test-transport-only-key-${crypto.randomUUID()}`;
        const privateCauseMarker = `test-private-cause-${crypto.randomUUID()}`;
        const fixtureError = Object.assign(new MarkdownFileImportError('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED'), {
          operationId: fixtureOperationId, idempotencyKey: fixtureKey, cause: new Error(privateCauseMarker),
        });
        const transported = await wrapToolWithExecutionContext({ ...tool,
          execute: async () => { throw fixtureError; },
        }, sidA).execute(`test-transport-error-${crypto.randomUUID()}`, { path: target });
        assert.equal(Reflect.get(transported, 'isError'), true);
        assert(transported.details && typeof transported.details === 'object');
        assert.equal(Reflect.get(transported.details, 'code'), 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
        assert.equal(Reflect.get(transported.details, 'outcome'), 'blocked');
        assert.equal(Reflect.get(transported.details, 'safeToAutoRetry'), false);
        assert.equal(Reflect.get(transported.details, 'operation'), 'write');
        assert.equal(Reflect.get(transported.details, 'path'), target);
        assert.equal(Reflect.get(transported.details, 'operationId'), fixtureOperationId);
        assert.equal(Reflect.get(transported.details, 'idempotencyKey'), fixtureKey);
        assert.equal(Reflect.get(transported.details, 'cause'), undefined);
        assert.equal(Reflect.get(transported.details, 'nativeCreate'), undefined);
        assert.equal(Reflect.get(transported.details, 'collaboration'), undefined);
        const transportedText = transported.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        assert(transportedText.includes('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED'));
        assert(transportedText.includes(JSON.stringify(fixtureOperationId)));
        assert(transportedText.includes(JSON.stringify(fixtureKey)));
        assert.equal(JSON.stringify(transported).includes(privateCauseMarker), false);
        assert.equal(Object.hasOwn(transported, 'cause'), false);

        const ordinaryError = new Error('Test-only ordinary runtime failure must remain rejected.');
        await assert.rejects(wrapToolWithExecutionContext({ ...tool,
          execute: async () => { throw ordinaryError; },
        }, sidA).execute(`test-ordinary-error-${crypto.randomUUID()}`, { path: target }), error => {
          assert.equal(error, ordinaryError); return true;
        });
        const nonWriteError = new MarkdownFileImportError('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
        await assert.rejects(wrapToolWithExecutionContext({ ...tool, name: 'read',
          execute: async () => { throw nonWriteError; },
        }, sidA).execute(`test-read-error-${crypto.randomUUID()}`, { path: target }), error => {
          assert.equal(error, nonWriteError); return true;
        });

        const { getAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
        const { captureCurrentAgentToolInvocation, assertCurrentAgentToolInvocation,
          AgentToolInvocationError } = await import('../app/lib/pi/agent-tool-invocation');
        let capturedOriginFailure: unknown, restoredActualContext = false;
        await assert.rejects(wrapToolWithExecutionContext({ ...tool,
          execute: async () => {
            const actual = getAgentExecutionContext(); assert(actual); assert.notEqual(actual, sidA);
            const held = captureCurrentAgentToolInvocation(); assert.equal(actual.legacy, false);
            try {
              actual.legacy = true;
              assert.throws(() => assertCurrentAgentToolInvocation(held), error => {
                assert(error instanceof AgentToolInvocationError);
                assert.equal(error.code, 'AGENT_TOOL_INVOCATION_ORIGIN_CHANGED');
                capturedOriginFailure = error; return true;
              });
            } finally { actual.legacy = false; restoredActualContext = true; }
            // A swallowed real origin poison cannot become this fake success,
            // even though the actual ALS origin is restored before returning.
            return { content: [{ type: 'text' as const, text: 'TEST-only fake success after transient origin drift.' }], details: {} };
          },
        }, sidA).execute(`test-origin-poison-${crypto.randomUUID()}`, { path: target }), error => {
          assert(error instanceof AgentToolInvocationError);
          assert.equal(error.code, 'AGENT_TOOL_INVOCATION_ORIGIN_CHANGED');
          assert.equal(error, capturedOriginFailure); return true;
        });
        assert(restoredActualContext); assert(capturedOriginFailure instanceof AgentToolInvocationError);
        assert.equal(sidA.legacy, false);
      };
      await piMarkdownCreateEncodingError();
      groups++; console.log('PASS PI Markdown create: actual core tool preserves the known encoding error without publishing a native/raw target');
    });
    complete = true; console.log(JSON.stringify({ test: 'pi-markdown-create-postgres', groups, complete }));
  } catch (error) {
    console.error(JSON.stringify({ test: 'pi-markdown-create-postgres', phase, groups, complete: false,
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value ?? null : null }));
    throw error;
  } finally {
    if (originalBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = originalBase;
  }
}
