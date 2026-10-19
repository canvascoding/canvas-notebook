import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope, WorkspaceOperationDirectMcpAuthorization,
  WorkspaceOperationNativeDeleteBatchPlan } from '../app/lib/files/workspace-operation-batch-contract';
import type { WorkspaceOperationNativeMoveBatchPlan } from '../app/lib/files/workspace-operation-native-move-plan';
import type { WorkspaceOperationMcpJobPrincipal } from '../app/lib/workspaces/workspace-operation-mcp-job-principal';
import type { DirectMcpWorkspaceMovePrincipalAccess, DirectMcpWorkspaceDeletePrincipalAccess } from '../app/lib/mcp/server/document-read-principal';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Actual fixture JWT -> current fixed MCP principal -> actual Store claim and
// OriginalMove/Delete owner -> PG18/native links/FD/Trash. No HTTP, OAuth issue,
// SDK, original browser incident or public tool integration is claimed here.
const sha = (value: string | Uint8Array): string => crypto.createHash('sha256').update(value).digest('hex');
type Kind = 'move' | 'delete';
type NativePlan = WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationNativeDeleteBatchPlan;
let currentCase = 'fixture setup', groups = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
function code(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const actual = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  if (typeof actual === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(actual)) return actual;
  return error.constructor === Error && /^[A-Z][A-Z0-9_]{1,127}$/u.test(error.message) ? error.message : null;
}
const rejected = (...expected: string[]) => (error: unknown): boolean => {
  if (error instanceof assert.AssertionError || !expected.includes(code(error) ?? '')) {
    const describe = (value: unknown, depth = 0): unknown => depth > 4 || !(value instanceof Error) ? null : ({
      name: value.name, code: code(value),
      ...(value instanceof AggregateError ? { errors: value.errors.slice(0, 4).map(child => describe(child, depth + 1)) } : {}),
      ...(value.cause instanceof Error ? { cause: describe(value.cause, depth + 1) } : {}),
    });
    console.error(JSON.stringify({ unexpectedRejection: describe(error), expected }));
  }
  assert(!(error instanceof assert.AssertionError));
  assert(expected.includes(code(error) ?? ''), `Unexpected actual error code ${code(error) ?? 'UNCLASSIFIED'}`); return true;
};
const absent = async (filename: string): Promise<void> => { await assert.rejects(fs.lstat(filename), { code: 'ENOENT' }); };

export async function directMcpWorkspacePathOwnerPostgresTest(): Promise<void> {
  const originalBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'move_knowledge_source,delete_knowledge_source,read_knowledge_source' });
    const { auth } = await import('../app/lib/auth');
    const { openDb } = await import('../app/lib/db');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { upsertPostgresWorkspaceMemberForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { withDirectMcpWorkspaceMovePrincipal: moveCapture, withDirectMcpWorkspaceDeletePrincipal: deleteCapture,
      withDirectMcpWorkspaceMovePrincipalOnConnection: movePhase,
      withDirectMcpWorkspaceDeletePrincipalOnConnection: deletePhase } = await import('../app/lib/mcp/server/document-read-principal');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
    const { executeWorkspaceOperationBatch } = await import('../app/lib/files/workspace-operation-batch-executor');
    const { createWorkspaceOperationBatchWorker } = await import('../app/lib/files/workspace-operation-batch-worker');
    const { withWorkspaceOperationMcpJobPolicyOnConnection } = await import('../app/lib/workspaces/workspace-operation-mcp-job-principal');
    const { readWorkspaceOperationNativeMoveBatchStatus: moveStatus } = await import('../app/lib/files/workspace-operation-native-move-status');
    const { readWorkspaceOperationNativeDeleteBatchStatus: deleteStatus } = await import('../app/lib/files/workspace-operation-native-delete-status');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks: links } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const store = new WorkspaceOperationBatchStore();
    const owner = resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' });
    // Real member/organization grants; the stale fixture workspace DTO is never
    // edited into a permission grant. Every operation obtains a fresh MCP B.
    await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId,
      { userId: 'member', canRead: true, canWrite: true, canManage: false });
    assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1
      WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1);
    assert.equal(h.source.permissions.canWrite, false, 'No permission DTO substitution.');
    const clientId = `mcp-job-${crypto.randomUUID()}`;
    const register = async (client: string, user: 'member' | 'owner'): Promise<void> => {
      await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
        VALUES($1,$1,$2,'Actual MCP path fixture',0,'[]',100,100)`, [client, user]);
      await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
        VALUES($1,$2,$3,'["knowledge:write","knowledge:read"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), client, user]);
      for (const workspaceId of [h.source.workspaceId, h.destination.workspaceId]) {
        await h.admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
          VALUES($1,'owner',100,100) ON CONFLICT(workspace_id) DO NOTHING`, [workspaceId]);
        await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
          VALUES($1,$2,$3,100,100)`, [client, user, workspaceId]);
      }
    };
    await register(clientId, 'member');
    const issue = async (sessionId = 'session-member', client = clientId, user = 'member'): Promise<string> => {
      const seconds = Math.floor(Date.now() / 1000);
      const value = await auth.api.signJWT({ body: { payload: { sub: user, azp: client, sid: sessionId,
        iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp', iat: seconds - 1, exp: seconds + 600,
        scope: 'knowledge:write knowledge:read' } } }); assert(value.token); return value.token;
    };
    const authInfo = (token: string): AuthInfo => ({ token, clientId: 'ignored-untrusted-client', scopes: [], extra: { userId: 'owner' } });
    let currentSession = 'session-member', currentToken = await issue(), currentRequestToken: string | undefined;
    const run = <T>(kind: Kind, token: string, workspaceId: string,
      operation: (principal: WorkspaceOperationMcpJobPrincipal) => Promise<T>): Promise<T> => kind === 'move'
      ? moveCapture(authInfo(token), { workspaceId }, () => undefined, principal => operation({ kind: 'move', principal }))
      : deleteCapture(authInfo(token), { workspaceId }, () => undefined, principal => operation({ kind: 'delete', principal }));
    const freshScope = async (live: WorkspaceOperationMcpJobPrincipal, expectedUser = 'member'): Promise<WorkspaceOperationBatchScope> => {
      const db = await openDb(); let began = false, committed = false, failed: Error | undefined;
      try {
        await db.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
        const consume = async (access: DirectMcpWorkspaceMovePrincipalAccess | DirectMcpWorkspaceDeletePrincipalAccess) => {
          assert.equal(access.userId, expectedUser); assert(access.workspace.permissions.canRead && access.workspace.permissions.canWrite
            && access.workspace.permissions.canDelete && access.workspace.permissions.canRunAgent);
          assert.equal(access.tool, live.kind === 'move' ? 'move_knowledge_source' : 'delete_knowledge_source');
          await access.assertCurrent(); return { workspace: access.workspace, fileOptions: { workspace: access.workspace } };
        };
        const scope = live.kind === 'move' ? await movePhase(db, live.principal, consume) : await deletePhase(db, live.principal, consume);
        await db.run('COMMIT'); committed = true; return scope;
      } catch (error) {
        failed = error instanceof Error ? error : new Error('Current MCP scope failed.');
        if (began && !committed) try { await db.run('ROLLBACK'); } catch (rollback) { failed = new AggregateError([error, rollback], 'Current scope rollback failed.'); }
        throw failed;
      } finally { await db.close(failed); }
    };
    type Job = { kind: Kind; operationId: string; plan: NativePlan; scope: WorkspaceOperationBatchScope;
      sourcePath: string; destinationPath: string; incomingPath: string; pdfPath: string | null; destinationPdf: string | null;
      pdf: Buffer | null; targetId: string; incomingId: string; lineageId: string; generation: number; title: string;
      originalBinary: Buffer; originalVector: Buffer; batch?: WorkspaceOperationBatchRecord; original?: WorkspaceOperationDirectMcpAuthorization };
    const seed = async (kind: Kind, withPdf = false): Promise<Job> => {
      const prefix = `mcp-${kind}-${crypto.randomUUID()}`, sourcePath = `${prefix}.md`, destinationPath = `${prefix}-moved.md`;
      const incomingPath = `${prefix}-incoming.md`, pdfPath = withPdf ? `${prefix}.pdf` : null;
      const destinationPdf = withPdf ? `${prefix}-moved.pdf` : null;
      const target = await h.upload(sourcePath, Buffer.from('# Original target\n\nActual native body.\n'));
      const incoming = await h.upload(incomingPath, Buffer.from(`[Original](${sourcePath})${pdfPath ? ` [PDF](${pdfPath})` : ''}\n`)), title = `Title ${prefix}`;
      await h.metadata(h.source, sourcePath, { title, isFavorite: true, pinned: true }, 'member', currentRequestToken);
      const pdf = withPdf ? Buffer.from('%PDF-1.7\nactual owned bytes\n%%EOF\n') : null;
      if (pdfPath && pdf) await fs.writeFile(path.join(h.source.rootPath, pdfPath), pdf, { mode: 0o600, flag: 'wx' });
      await fs.unlink(path.join(h.source.rootPath, sourcePath)); await absent(path.join(h.source.rootPath, sourcePath));
      const state = await load(h.connection, target.documentId); assert(state);
      const row = (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [target.documentId])).rows[0]; assert(row);
      return run(kind, currentToken, h.source.workspaceId, async live => {
        const scope = await freshScope(live);
        const plan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: crypto.randomUUID(), kind,
          selections: kind === 'delete' ? [{ sourcePath }] : [{ sourcePath, destinationPath },
            ...(pdfPath && destinationPdf ? [{ sourcePath: pdfPath, destinationPath: destinationPdf }] : [])] }] });
        assert(plan.version !== 1); assert(plan.version === (kind === 'move' ? 3 : 2)); assert.equal(plan.readiness, 'ready');
        return { kind, operationId: crypto.randomUUID(), plan, scope, sourcePath, destinationPath, incomingPath, pdfPath, destinationPdf,
          pdf, targetId: target.documentId, incomingId: incoming.documentId, lineageId: row.lineage_id, title,
          generation: target.lifecycleGeneration, originalBinary: Buffer.from(state.yjsState), originalVector: Buffer.from(state.stateVector) };
      });
    };
    const create = async (job: Job, live: WorkspaceOperationMcpJobPrincipal): Promise<WorkspaceOperationBatchRecord> => {
      assert.equal(live.kind, job.kind);
      const result = live.kind === 'move' && job.plan.version === 3
        ? await store.createMcpMoveAndClaim(live.principal, { operationId: job.operationId, plan: job.plan })
        : live.kind === 'delete' && job.plan.version === 2
          ? await store.createMcpDeleteAndClaim(live.principal, { operationId: job.operationId, plan: job.plan }) : assert.fail('Mismatched genuine plan.');
      assert.equal(result.kind, 'claimed'); assert(result.kind === 'claimed'); job.batch = result.batch;
      assert(result.batch.authorization.mode === 'direct-mcp'); job.original = result.batch.authorization;
      assert.equal(job.original.clientId, clientId); assert.equal(job.original.actorUserId, 'member');
      assert.equal(job.original.actorSessionId, currentSession); assert.equal(job.original.actorType, 'agent');
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM agents WHERE agent_id=$1', [job.original.actorId])).rows[0].n, 0);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM pi_sessions WHERE session_id=$1', [job.original.actorSessionId])).rows[0].n, 0);
      return result.batch;
    };
    const existing = (job: Job, live: WorkspaceOperationMcpJobPrincipal, workspaceId = job.plan.workspaceId) =>
      live.kind === 'move' ? store.claimExistingMcpMove(live.principal, { operationId: job.operationId, workspaceId, planId: job.plan.planId })
        : store.claimExistingMcpDelete(live.principal, { operationId: job.operationId, workspaceId, planId: job.plan.planId });
    const invoke = async (job: Job, live: WorkspaceOperationMcpJobPrincipal, batch: WorkspaceOperationBatchRecord) => {
      const scope = await freshScope(live);
      return store.withClaim(batch, async jobClaim => {
        assert(batch.authorization.mode === 'direct-mcp'); const original = batch.authorization;
        try {
          const result = await executeWorkspaceOperationBatch({ batchId: batch.batchId, plan: batch.plan, scope,
            actorUserId: original.actorUserId, actorId: original.actorId, actorType: 'agent', actorDisplayName: original.actorDisplayName,
            actorSessionId: original.actorSessionId, jobClaim, mcpPrincipal: live });
          assert.equal(result.status, 'applied', result.errorCode ?? 'UNCLASSIFIED');
          const finished = await store.finishClaim(batch, { status: result.status, completedActions: result.completedActions,
            trashEntryIds: result.trashEntryIds, errorCode: result.errorCode, phase: 'complete' });
          assert.equal(finished?.status, 'applied'); return result;
        } catch (error) {
          // Retain the actual error and an honest unfinished durable job. This
          // bookkeeping never converts a failed owner effect into success.
          try {
            const finished = await store.finishClaim(batch, { status: 'needs_recovery', phase: 'recovery',
              errorCode: code(error) ?? 'MCP_FIXTURE_UNCLASSIFIED_OWNER_ERROR' }); assert(finished);
          } catch (finalization) {
            throw Object.assign(new AggregateError([error, finalization], 'Actual owner failure and unfinished-job finalization failed.'),
              { code: code(error) ?? code(finalization) ?? 'MCP_FIXTURE_UNCLASSIFIED_OWNER_ERROR' });
          }
          throw error;
        }
      });
    };
    const recover = (job: Job) => run(job.kind, currentToken, job.plan.workspaceId, async live => {
      const resumed = await existing(job, live); assert.equal(resumed.kind, 'claimed'); assert(resumed.kind === 'claimed');
      assert.deepEqual(resumed.batch.authorization, job.original); return invoke(job, live, resumed.batch);
    });
    const row = async (table: string, batchId: string) => (await h.admin.query(
      `SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${table}" t WHERE batch_id=$1 ORDER BY to_jsonb(t)::text`, [batchId])).rows;
    const immutableBatch = async (job: Job) => {
      assert(job.batch); return (await h.admin.query(`SELECT batch_id,plan_id,workspace_id,plan_json,authorization_json,
        created_at,total_actions,action_mode FROM workspace_file_operation_batches WHERE batch_id=$1`, [job.batch.batchId])).rows[0];
    };
    const intentTable = (job: Job) => `workspace_file_operation_${job.kind}_intents`;
    const receiptTable = (job: Job) => `workspace_file_operation_${job.kind}_receipts`;
    const snapshot = async () => {
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)'
          OR c.relname IN ('file_revisions','file_revision_contents','file_version_blobs','workspace_trash_entries')) ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
      assert(tables.length > 15 && tables.length <= 512); const rows: Record<string, unknown> = {};
      for (const table of tables) {
        assert.equal(typeof table.relname, 'string'); const name = String(table.relname).replaceAll('"', '""');
        const values = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${name}" t ORDER BY to_jsonb(t)::text,xmin::text LIMIT 10001`)).rows;
        assert(values.length <= 10000); rows[table.relname] = values;
      }
      return { tables, rows };
    };
    const filesystem = async () => {
      const result: unknown[] = [];
      const visit = async (relative: string): Promise<void> => {
        assert(result.length < 10000); const full = path.join(h.dataRoot, relative), value = await fs.lstat(full, { bigint: true });
        assert(!value.isSymbolicLink()); const identity = { path: relative, dev: String(value.dev), ino: String(value.ino), mode: String(value.mode),
          uid: String(value.uid), nlink: String(value.nlink), size: String(value.size), mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) };
        result.push(value.isFile() ? { ...identity, sha256: sha(await fs.readFile(full)) } : identity);
        if (value.isDirectory()) for (const name of (await fs.readdir(full)).sort()) await visit(path.join(relative, name));
      };
      await visit('.'); return result;
    };
    const noMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
      const before = await snapshot(), files = await filesystem(); let statements = 0; const writes: string[] = [];
      const result = await h.withProbe(async event => {
        assert(++statements <= 5000);
        if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[\s\S]*?\bSET\b|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)) writes.push(event.text);
      }, operation);
      assert(statements > 0); assert.deepEqual(writes, [], 'Actual pure status must issue no DML/DDL.');
      assert.deepEqual(await snapshot(), before); assert.deepEqual(await filesystem(), files); return result;
    };
    const status = async (job: Job, live: WorkspaceOperationMcpJobPrincipal) => {
      const scope = await freshScope(live); assert(job.batch); return job.kind === 'move'
        ? moveStatus({ batchId: job.batch.batchId, scope, mcpPrincipal: live })
        : deleteStatus({ batchId: job.batch.batchId, scope, mcpPrincipal: live });
    };
    const assertComplete = async (job: Job): Promise<void> => {
      assert(job.batch && job.original); const durable = await store.get(job.batch.batchId); assert(durable);
      assert.equal(durable.status, 'applied'); assert.deepEqual(durable.authorization, job.original);
      const source = path.join(h.source.rootPath, job.sourcePath); await absent(source);
      const registry = (await h.admin.query('SELECT id,lineage_id,path,status FROM collaboration_documents WHERE id=$1', [job.targetId])).rows[0];
      const lineage = (await h.admin.query('SELECT id,path,status FROM file_collaboration_lineages WHERE id=$1', [job.lineageId])).rows[0];
      assert.equal(registry.id, job.targetId); assert.equal(registry.lineage_id, job.lineageId); assert.equal(lineage.id, job.lineageId);
      const incoming = await load(h.connection, job.incomingId); assert(incoming); const inventory = links(incoming);
      assert.equal(inventory.links.some(link => link.targetPathText === job.sourcePath), false);
      if (job.kind === 'move') {
        assert.equal(registry.path, job.destinationPath); assert.equal(lineage.path, job.destinationPath);
        assert.equal(registry.status, 'active'); assert.equal(lineage.status, 'active');
        const moved = await load(h.connection, job.targetId); assert(moved); assert.equal(moved.lifecycleGeneration, job.generation);
        assert.deepEqual(Buffer.from(moved.yjsState), job.originalBinary); assert.deepEqual(Buffer.from(moved.stateVector), job.originalVector);
        assert(inventory.links.some(link => link.targetPathText === job.destinationPath));
        await absent(path.join(h.source.rootPath, job.destinationPath));
        const metadata = (await h.admin.query('SELECT title FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2',
          [h.source.workspaceId, job.destinationPath])).rows; assert.deepEqual(metadata, [{ title: job.title }]);
        const personal = (await h.admin.query('SELECT is_favorite,pinned_at FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2 AND user_id=\'member\'',
          [h.source.workspaceId, job.destinationPath])).rows; assert.equal(personal.length, 1); assert.equal(Number(personal[0].is_favorite), 1); assert(personal[0].pinned_at !== null);
        if (job.pdfPath && job.destinationPdf && job.pdf) {
          await absent(path.join(h.source.rootPath, job.pdfPath)); assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, job.destinationPdf)), job.pdf);
          assert(inventory.links.some(link => link.targetPathText === job.destinationPdf));
        }
      } else {
        assert.equal(registry.status, 'archived'); assert.equal(lineage.status, 'archived');
        const raw = (await h.admin.query('SELECT status,lifecycle_generation,yjs_state,state_vector FROM collaboration_yjs_states WHERE document_id=$1', [job.targetId])).rows[0];
        assert.equal(raw.status, 'archived'); assert.equal(Number(raw.lifecycle_generation), job.generation + 1);
        assert.deepEqual(raw.yjs_state, job.originalBinary); assert.deepEqual(raw.state_vector, job.originalVector);
        assert.equal(durable.trashEntryIds.length, 1);
        const trash = (await h.admin.query('SELECT * FROM workspace_trash_entries WHERE id=$1', [durable.trashEntryIds[0]])).rows[0]; assert(trash);
        assert.equal(trash.status, 'trashed'); assert.equal(trash.original_path, job.sourcePath); assert.equal(trash.deleted_by_user_id, 'member');
        assert.equal(JSON.parse(trash.metadata_json).payloadKind, 'native_archive');
      }
      assert.equal((await h.admin.query('SELECT path FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, job.sourcePath])).rows.length, 0);
      assert.equal((await h.admin.query('SELECT path FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, job.sourcePath])).rows.length, 0);
      assert.equal((await row(intentTable(job), job.batch.batchId)).length, 1); assert.equal((await row(receiptTable(job), job.batch.batchId)).length, 1);
    };
    type CommitObservation = { before: Awaited<ReturnType<typeof row>>; pid: number; start: string; xid: string };
    const afterActualCommit = async <T>(job: Job, table: string, mutate: () => Promise<void>, operation: () => Promise<T>) => {
      assert(job.batch); assert.equal((await row(table, job.batch.batchId)).length, 0);
      let selected: MetadataSqlEvent['client'] | undefined, observation: CommitObservation | undefined, fired = false;
      let result: T;
      try { result = await h.withProbe(async event => {
        if (/^\s*INSERT\s+INTO\b/iu.test(event.text) && event.text.includes(table) && event.values[0] === job.batch!.batchId && event.result.rowCount === 1) {
          assert.equal(selected, undefined); selected = event.client;
          const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
            pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
          assert.equal(witness.schema, h.schema); assert(witness.xid);
          const before = (await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${table}" t WHERE batch_id=$1`, [job.batch!.batchId])).rows;
          assert.equal(before.length, 1); assert.equal((await row(table, job.batch!.batchId)).length, 0, 'Original write is invisible before actual COMMIT.');
          observation = { before, pid: Number(witness.pid), start: witness.start, xid: witness.xid };
        }
        if (/^\s*COMMIT\s*$/iu.test(event.text) && event.client === selected && !fired) {
          assert(observation); assert.equal(event.result.command, 'COMMIT');
          const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
            pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
          assert.equal(Number(witness.pid), observation.pid); assert.equal(witness.start, observation.start); assert.equal(witness.xid, null);
          assert.deepEqual(await row(table, job.batch!.batchId), observation.before, 'Independent admin sees the exact committed row/xmin.');
          fired = true; await mutate();
        }
      }, operation); } catch (error) {
        if (!fired || !observation) throw new Error('FIXTURE_ACTUAL_COMMIT_POINT_NOT_REACHED', { cause: error });
        throw error;
      }
      assert(fired && observation); return result;
    };
    const rotate = async (): Promise<string> => {
      const old = currentToken, previous = currentSession, next = `session-member-${crypto.randomUUID()}`, now = Date.now();
      const requestToken = crypto.randomBytes(32).toString('hex');
      await h.admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,\'member\',$3,$4,$4)',
        [next, requestToken, now + 3600000, now]);
      const token = await issue(next);
      assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [previous])).rowCount, 1);
      currentSession = next; currentToken = token; currentRequestToken = requestToken; return old;
    };
    const check = async (name: string, callback: () => Promise<void>) => { currentCase = name; await callback(); groups++; console.log(`MCP job owner case passed: ${name}`); };
    let moved: Job, deleted: Job;
    await check('Move real missing-projection native and PDF roots with incoming links, stable D/L and no PI identity', async () => {
      moved = await seed('move', true);
      await run('move', currentToken, h.source.workspaceId, async live => invoke(moved, live, await create(moved, live)));
      await assertComplete(moved);
    });
    await check('Delete real native target with incoming links, annotations, native Archive and original Trash', async () => {
      deleted = await seed('delete');
      await run('delete', currentToken, h.source.workspaceId, async live => invoke(deleted, live, await create(deleted, live)));
      await assertComplete(deleted);
    });
    await check('ordinary claim/tick/enqueue/loose heartbeat/finish cannot touch an eligible expired MCP header', async () => {
      const job = await seed('move');
      await run('move', currentToken, h.source.workspaceId, async live => {
        const batch = await create(job, live); assert(batch.leaseOwner);
        // A declared actual scheduling fault, not forged authority or a clock
        // override: make this durable applying header eligible for old claim.
        assert.equal((await h.admin.query('UPDATE workspace_file_operation_batches SET lease_expires_at=1 WHERE batch_id=$1 AND status=\'applying\' RETURNING batch_id', [batch.batchId])).rowCount, 1);
        const before = await snapshot(), files = await filesystem();
        assert.equal(await store.claim(crypto.randomUUID()), null); assert.equal(await createWorkspaceOperationBatchWorker({ store }).tick(), false);
        await assert.rejects(store.enqueue({ batchId: batch.batchId, planId: batch.planId, userId: 'member', displayName: 'Member', action: 'resume' }), rejected('BATCH_DIRECT_AUTHORIZATION_REQUIRED'));
        await assert.rejects(store.heartbeat(batch.batchId, batch.leaseOwner), rejected('BATCH_DIRECT_AUTHORIZATION_REQUIRED'));
        await assert.rejects(store.finish(batch.batchId, batch.leaseOwner, { status: 'applied' }), rejected('BATCH_DIRECT_AUTHORIZATION_REQUIRED'));
        assert.deepEqual(await snapshot(), before); assert.deepEqual(await filesystem(), files);
      });
      let caughtLate = false, returnedFromConsumer = false, lateCheck: (() => Promise<void>) | undefined;
      await assert.rejects(run('move', currentToken, h.source.workspaceId, async live => {
        const selected = await existing(job, live); assert(selected.kind === 'claimed');
        return store.withClaim(selected.batch, async claim => {
          const db = await openDb(); let began = false; let phaseError: Error | undefined;
          try {
            await db.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
            await h.withProbe(async event => {
              if (returnedFromConsumer && !caughtLate && /^\s*SELECT\b/iu.test(event.text)) {
                assert(lateCheck); caughtLate = true;
                // The genuine access was issued inside this phase. The real
                // final SQL has completed, but its outer guard has not returned.
                await assert.rejects(lateCheck(), rejected('MCP_READ_PRINCIPAL_REENTRANT'));
              }
            }, () => withWorkspaceOperationMcpJobPolicyOnConnection(db, { claim, principal: live }, async access => {
              lateCheck = access.assertCurrent; returnedFromConsumer = true; return undefined;
            }));
            assert.fail('A swallowed late check must poison the actual closing phase.');
          } catch (error) {
            phaseError = error instanceof Error ? error : new Error('Unclassified actual phase failure.');
            assert(caughtLate); assert.equal(code(error), 'MCP_READ_PRINCIPAL_REENTRANT');
            if (began) { await db.run('ROLLBACK'); began = false; }
            assert(await store.finishClaim(selected.batch, { status: 'needs_recovery', phase: 'recovery', errorCode: code(error) }));
            throw error;
          } finally { if (began) await db.run('ROLLBACK'); await db.close(phaseError); }
        });
      }), rejected('MCP_READ_PRINCIPAL_REENTRANT'));
      assert(caughtLate);
      await recover(job); await assertComplete(job);
    });
    await check('completed claim retry and genuine historical status are SELECT-only with exact domain xmins and FS', async () => {
      for (const job of [moved!, deleted!]) await run(job.kind, currentToken, h.source.workspaceId, live => noMutation(async () => {
        const known = await existing(job, live); assert.equal(known.kind, 'historical-header'); assert(known.kind === 'historical-header');
        assert.deepEqual(known.batch.authorization, job.original); const result = await status(job, live); assert(result);
        assert.equal(result.observation.apply, 'complete'); assert.deepEqual(result.batch.authorization, job.original);
      }));
      const before = await snapshot(), files = await filesystem(); let rrClient: MetadataSqlEvent['client'] | undefined, revoked = false;
      try {
        await assert.rejects(run('move', currentToken, h.source.workspaceId, live => h.withProbe(async event => {
          if (/^\s*BEGIN\s+ISOLATION\s+LEVEL\s+REPEATABLE\s+READ\s+READ\s+ONLY\s*$/iu.test(event.text)) {
            assert.equal(rrClient, undefined); rrClient = event.client;
          }
          if (/^\s*COMMIT\s*$/iu.test(event.text) && event.client === rrClient && !revoked) {
            assert.equal(event.result.command, 'COMMIT');
            assert.equal((await h.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 AND user_id=\'member\' AND workspace_id=$2 RETURNING client_id',
              [clientId, h.source.workspaceId])).rowCount, 1); revoked = true;
          }
        }, async () => { await status(moved!, live); assert.fail('C2 must reject a grant revoked after the real historical snapshot COMMIT.'); })),
        rejected('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
        assert(revoked && rrClient); assert.deepEqual(await snapshot(), before); assert.deepEqual(await filesystem(), files);
      } finally {
        await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
          VALUES($1,'member',$2,100,100) ON CONFLICT DO NOTHING`, [clientId, h.source.workspaceId]);
      }
    });
    await check('unknown existing operation, valid foreign client/user/workspace cannot take an original', async () => {
      const foreign = `foreign-${crypto.randomUUID()}`, ownerClient = `owner-${crypto.randomUUID()}`;
      await register(foreign, 'member'); await register(ownerClient, 'owner');
      const tokens = [{ token: await issue(currentSession, foreign), user: 'member', workspaceId: h.source.workspaceId },
        { token: await issue('session-owner', ownerClient, 'owner'), user: 'owner', workspaceId: h.source.workspaceId },
        { token: currentToken, user: 'member', workspaceId: h.destination.workspaceId }];
      for (const candidate of tokens) await run('move', candidate.token, candidate.workspaceId, async live => {
        await freshScope(live, candidate.user); const before = await snapshot(), files = await filesystem();
        assert.equal((await existing(moved!, live, candidate.workspaceId)).kind, 'absent');
        assert.deepEqual(await snapshot(), before); assert.deepEqual(await filesystem(), files);
      });
      await run('move', currentToken, h.source.workspaceId, live => noMutation(async () => {
        assert(live.kind === 'move'); const result = await store.claimExistingMcpMove(live.principal,
          { operationId: crypto.randomUUID(), workspaceId: h.source.workspaceId, planId: moved!.plan.planId }); assert.equal(result.kind, 'absent');
      }));
    });
    await check('grant revoked after genuine intent COMMIT refuses the next Move B and preserves Original', async () => {
      const job = await seed('move', true);
      try {
        await assert.rejects(run('move', currentToken, h.source.workspaceId, async live => {
          await create(job, live);
          return afterActualCommit(job, intentTable(job), async () => {
            assert.equal((await h.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 AND user_id=\'member\' AND workspace_id=$2 RETURNING client_id', [clientId, h.source.workspaceId])).rowCount, 1);
          }, () => invoke(job, live, job.batch!));
        }), rejected('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
        assert(job.batch); const original = await immutableBatch(job), intent = await row(intentTable(job), job.batch.batchId);
        assert.equal(intent.length, 1); assert.equal((await row(receiptTable(job), job.batch.batchId)).length, 0);
        assert.equal((await load(h.connection, job.targetId))?.path, job.sourcePath); assert(job.pdfPath && job.pdf);
        assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, job.pdfPath)), job.pdf); await absent(path.join(h.source.rootPath, job.destinationPath));
        await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,'member',$2,100,100)`, [clientId, h.source.workspaceId]);
        await recover(job); assert.deepEqual(await immutableBatch(job), original); assert.deepEqual(await row(intentTable(job), job.batch.batchId), intent); await assertComplete(job);
      } finally {
        await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,'member',$2,100,100) ON CONFLICT DO NOTHING`, [clientId, h.source.workspaceId]);
      }
    });
    await check('Delete permission lost after intent COMMIT creates no Archive/Trash and resumes original after restoration', async () => {
      const job = await seed('delete');
      try {
        await assert.rejects(run('delete', currentToken, h.source.workspaceId, async live => {
          await create(job, live); return afterActualCommit(job, intentTable(job), async () => {
            assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=0
              WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1);
          }, () => invoke(job, live, job.batch!));
        }), rejected('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
        assert(job.batch); const original = await immutableBatch(job), intent = await row(intentTable(job), job.batch.batchId); assert.equal(intent.length, 1);
        assert.equal((await row(receiptTable(job), job.batch.batchId)).length, 0);
        assert.equal((await h.admin.query('SELECT status FROM collaboration_documents WHERE id=$1', [job.targetId])).rows[0].status, 'active');
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_trash_entries WHERE workspace_id=$1 AND original_path=$2', [h.source.workspaceId, job.sourcePath])).rows[0].n, 0);
        await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'`);
        await recover(job); assert.deepEqual(await immutableBatch(job), original); assert.deepEqual(await row(intentTable(job), job.batch.batchId), intent); await assertComplete(job);
      } finally { await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'`); }
    });
    await check('real completion COMMIT then lost ACK, genuine renewed SID-B recovers Original-A for Move and Delete', async () => {
      for (const kind of ['move', 'delete'] as const) {
        const job = await seed(kind); let faulted = false;
        await assert.rejects(run(kind, currentToken, h.source.workspaceId, async live => {
          await create(job, live); return afterActualCommit(job, receiptTable(job), async () => {
            faulted = true; throw Object.assign(new Error('Lost successful actual owner COMMIT acknowledgement.'), { code: 'FIXTURE_MCP_JOB_ACK_LOST' });
          }, () => invoke(job, live, job.batch!));
        }), rejected('JOB_LIFECYCLE_COMMIT_UNCONFIRMED'));
        assert(faulted && job.batch && job.original); const original = await immutableBatch(job), intent = await row(intentTable(job), job.batch.batchId);
        const receipt = await row(receiptTable(job), job.batch.batchId); assert.equal(receipt.length, 1);
        const originalSession = job.original.actorSessionId, before = await load(h.connection, job.incomingId); assert(before);
        const old = await rotate(); assert.notEqual(currentSession, originalSession);
        await assert.rejects(run(kind, old, h.source.workspaceId, async live => {
          await freshScope(live); assert.fail('Expired SID-A cannot enter an actual current policy phase.');
        }), rejected('invalid_token'));
        await recover(job); assert.deepEqual(await immutableBatch(job), original); assert.deepEqual(await row(intentTable(job), job.batch.batchId), intent);
        assert.deepEqual(await row(receiptTable(job), job.batch.batchId), receipt); const after = await load(h.connection, job.incomingId); assert(after);
        assert.deepEqual(Buffer.from(after.yjsState), Buffer.from(before.yjsState)); assert.equal(after.documentSequence, before.documentSequence);
        await assertComplete(job);
      }
    });
    await check('current SID expiry between durable Delete phases cannot use stored SID-A and a real new SID resumes', async () => {
      const job = await seed('delete'), oldSession = currentSession;
      await assert.rejects(run('delete', currentToken, h.source.workspaceId, async live => {
        await create(job, live); return afterActualCommit(job, intentTable(job), async () => {
          assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [oldSession])).rowCount, 1);
        }, () => invoke(job, live, job.batch!));
      }), rejected('invalid_token'));
      assert(job.batch); const original = await immutableBatch(job), intent = await row(intentTable(job), job.batch.batchId);
      assert.equal(intent.length, 1); assert.equal((await row(receiptTable(job), job.batch.batchId)).length, 0);
      await rotate(); await recover(job); assert.deepEqual(await immutableBatch(job), original); assert.deepEqual(await row(intentTable(job), job.batch.batchId), intent);
      assert.equal(job.original?.actorSessionId, oldSession); await assertComplete(job);
    });
    await check('real Store claim COMMIT then lost ACK grants no copied-header claim and fixed Recover preserves Original', async () => {
      for (const kind of ['move', 'delete'] as const) {
        const job = await seed(kind), batchTable = 'workspace_file_operation_batches';
        const before = await snapshot(), files = await filesystem();
        const observed: { value?: CommitObservation & { batchId: string } } = {};
        let selected: MetadataSqlEvent['client'] | undefined, fired = false, returned = false, inserts = 0;
        const fault = Object.assign(new Error('Lost acknowledgement after successful actual Store claim COMMIT.'),
          { code: 'FIXTURE_MCP_STORE_CLAIM_ACK_LOST' });
        await assert.rejects(run(kind, currentToken, h.source.workspaceId, live => h.withProbe(async event => {
          if (/^\s*INSERT\s+INTO\b/iu.test(event.text) && event.text.includes(batchTable)
            && event.values[1] === job.plan.planId && event.values[2] === job.plan.workspaceId) {
            assert.equal(++inserts, 1); assert.equal(selected, undefined);
            assert.equal(event.result.command, 'INSERT'); assert.equal(event.result.rowCount, 1);
            const batchId = event.values[0]; assert.equal(typeof batchId, 'string');
            assert(typeof batchId === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(batchId));
            selected = event.client;
            const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
              pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
            assert.equal(witness.schema, h.schema); assert(Number.isSafeInteger(Number(witness.pid)) && Number(witness.pid) > 0);
            assert.equal(typeof witness.start, 'string'); assert.equal(typeof witness.xid, 'string');
            assert(/^[1-9][0-9]{0,31}$/u.test(witness.xid));
            const pending = (await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
              FROM "workspace_file_operation_batches" t WHERE batch_id=$1`, [batchId])).rows;
            assert.equal(pending.length, 1);
            assert.equal((await row(batchTable, batchId)).length, 0, 'Independent admin cannot see the uncommitted actual claim INSERT.');
            observed.value = { before: pending, batchId, pid: Number(witness.pid), start: witness.start, xid: witness.xid };
          }
          if (/^\s*COMMIT\s*$/iu.test(event.text) && event.client === selected && !fired) {
            const captured = observed.value; assert(captured); assert.equal(event.result.command, 'COMMIT');
            const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
              pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
            assert.equal(Number(witness.pid), captured.pid); assert.equal(witness.start, captured.start); assert.equal(witness.xid, null);
            assert.deepEqual(await row(batchTable, captured.batchId), captured.before,
              'Independent admin sees the exact committed header body and original xmin before the ACK fault.');
            fired = true; throw fault;
          }
        }, async () => { await create(job, live); returned = true; })), error => {
          assert(rejected('BATCH_CLAIM_COMMIT_UNCONFIRMED')(error));
          assert(error instanceof Error); assert.equal(Object.getOwnPropertyDescriptor(error, 'status')?.value, 503); return true;
        });
        const committed = observed.value; assert(committed && fired); assert.equal(inserts, 1); assert.equal(returned, false);
        assert.equal(job.batch, undefined); assert.equal(job.original, undefined);
        const stored = await store.get(committed.batchId); assert(stored);
        assert.equal(stored.batchId, committed.batchId); assert.equal(stored.planId, job.plan.planId);
        assert.equal(stored.workspaceId, job.plan.workspaceId); assert.deepEqual(stored.plan, job.plan);
        assert.equal(stored.status, 'applying'); assert.equal(stored.actionMode, 'apply');
        assert(stored.authorization.mode === 'direct-mcp');
        assert.equal(stored.authorization.clientId, clientId); assert.equal(stored.authorization.actorUserId, 'member');
        assert.equal(stored.authorization.actorSessionId, currentSession);
        assert.equal(stored.authorization.tool, kind === 'move' ? 'move_knowledge_source' : 'delete_knowledge_source');
        let invoked = false;
        await assert.rejects(store.withClaim(stored, async () => {
          invoked = true; assert.fail('A freshly read copied header must not mint the lost acknowledgement claim.');
        }), rejected('BATCH_CLAIM_REQUIRED'));
        assert.equal(invoked, false);
        assert.deepEqual(await row(batchTable, committed.batchId), committed.before);
        // Compare every actual domain row/xmin; the one proven durable header
        // INSERT is the sole expected difference. No SQL result is replaced.
        const after = await snapshot(); assert.deepEqual(after.tables, before.tables);
        assert.deepEqual(Object.keys(after.rows), Object.keys(before.rows));
        for (const [name, records] of Object.entries(before.rows)) {
          const actual = after.rows[name]; assert(Array.isArray(records) && Array.isArray(actual));
          const expected: unknown[] = name === batchTable ? [...records, ...committed.before] : records;
          assert.equal(actual.length, expected.length, `Unexpected actual row count in ${name}.`);
          assert.deepEqual(new Set(actual.map(value => JSON.stringify(value))), new Set(expected.map(value => JSON.stringify(value))),
            `Actual rows and xmins changed in ${name}.`);
        }
        assert.deepEqual(await filesystem(), files);
        job.batch = stored; job.original = stored.authorization;
        const original = await immutableBatch(job);
        assert.equal((await row(intentTable(job), committed.batchId)).length, 0);
        assert.equal((await row(receiptTable(job), committed.batchId)).length, 0);
        // Explicit actual scheduling fault only: expire this committed lease.
        // No principal, original attribution or native source is manufactured.
        assert.equal((await h.admin.query(`UPDATE workspace_file_operation_batches SET lease_expires_at=1
          WHERE batch_id=$1 AND status='applying' RETURNING batch_id,lease_expires_at`, [committed.batchId])).rowCount, 1);
        await run(kind, currentToken, h.source.workspaceId, async live => {
          const resumed = await existing(job, live); assert(resumed.kind === 'claimed');
          assert.equal(resumed.batch.batchId, committed.batchId); assert.deepEqual(resumed.batch.authorization, job.original);
          return invoke(job, live, resumed.batch);
        });
        assert.deepEqual(await immutableBatch(job), original); await assertComplete(job);
      }
    });
    await check('current expired session denies historical status and existing claim with zero domain/FS changes', async () => {
      assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [currentSession])).rowCount, 1);
      const before = await snapshot(), files = await filesystem();
      await assert.rejects(run('move', currentToken, h.source.workspaceId, async live => { await status(moved!, live); }), rejected('invalid_token'));
      await assert.rejects(run('delete', currentToken, h.source.workspaceId, async live => { await existing(deleted!, live); }), rejected('invalid_token'));
      assert.deepEqual(await snapshot(), before); assert.deepEqual(await filesystem(), files);
    });
    assert.equal(groups, 11);
    console.log(JSON.stringify({ test: 'direct-mcp-job-owner-integration', groups,
      scope: 'actual fixture JWT/current MCP/Store/OriginalMove/Delete/PG18/FD; no OAuth issuance, HTTP, SDK, public-handler or browser claim' }));
  }); completed = true;
  } finally { if (originalBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = originalBase; }
}
directMcpWorkspacePathOwnerPostgresTest().catch(error => {
  const causes = error instanceof AggregateError ? error.errors.slice(0, 4).map(code) : [code(Object.getOwnPropertyDescriptor(error ?? {}, 'cause')?.value)];
  console.error(JSON.stringify({ test: 'direct-mcp-job-owner-integration', failed: true, case: currentCase, groups, code: code(error), causes,
    name: error instanceof Error ? error.name : 'Unknown', stack: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s*at\b/u.test(line)).slice(0, 6) : [] }));
  process.exitCode = 1;
});
