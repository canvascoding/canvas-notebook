import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client, type Notification } from 'pg';
import { WebSocket } from 'ws';
import { Hocuspocus, MessageType } from '@hocuspocus/server';
import { AuthMessageType } from '@hocuspocus/common';
import { NextRequest } from 'next/server';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type * as YTypes from 'yjs';
import type { DocumentVersionIdentityV1 } from '../app/lib/documents/read-version';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';
import type { WorkspaceOperationBatchScope, WorkspaceOperationDirectMcpAuthorization,
  WorkspaceOperationNativeDeleteBatchPlan } from '../app/lib/files/workspace-operation-batch-contract';
import type { WorkspaceOperationNativeMoveBatchPlan } from '../app/lib/files/workspace-operation-native-move-plan';
import type { WorkspaceOperationMcpJobPrincipal } from '../app/lib/workspaces/workspace-operation-mcp-job-principal';
import type { DirectMcpWorkspaceMovePrincipalAccess, DirectMcpWorkspaceDeletePrincipalAccess } from '../app/lib/mcp/server/document-read-principal';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Actual fixture JWT -> current fixed MCP principal -> actual Store claim and
// OriginalMove/Delete owner -> PG18/native links/FD/Trash, plus two actual Web
// Request/Response rename boundaries. No HTTP listener for file routes, OAuth
// issue, SDK, original browser incident or public tool integration is claimed.
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
async function waitForNativePathRoomCondition(test: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(label);
}

export async function directMcpWorkspacePathOwnerPostgresTest(): Promise<void> {
  // Developer-only focused iteration. The unchanged default suite remains
  // mandatory: focused success never establishes all 43 owner cases.
  const htmlDeleteCaseNames = {
    cohort: 'all seven existing Cohort6 owner families',
    'physical-web': 'Physical5 actual cookie Web DELETE and ordinary worker prove links, pristine registry and Trash response',
    'physical-b2-revocation': 'Physical5 real rename fault, revoked grant and genuine SID-B recover original pristine PDF once',
    'implicit-live-update': 'implicit Web rename retains a real accepted rich update through its pending final store and original Move',
    'after-physical': 'HTML Delete4: after-physical retains genuine E6 Original and SID-B completes Archive/unlinks/Trash exactly once',
    'grant-after-intent': 'HTML Delete4: grant-after-intent retains genuine E6 Original and SID-B completes Archive/unlinks/Trash exactly once',
    'commit-ack-loss': 'HTML Delete E6: actual completion COMMIT ACK loss and genuine SID-B preserve Original, receipts and later same-path D2 exactly once',
    'archive-negative': 'HTML Delete E6: actual archive CAS faults roll back all B2 effects and SID-B recovers the same Original exactly once',
    'grouped-read-revocation': 'HTML Delete E6: current tool revocation after a genuine B2 domain read denies all effects and SID-B recovers the same Original exactly once',
    public: 'HTML Delete4: real MCP preview, OriginalOwner archive/unlink and same original SID-B history preserve HTML/raw bytes',
    blocked: 'HTML Delete4: affected native and opaque physical HTML block public preview/apply before every domain or FS mutation',
  } as const;
  const selectedCaseId = process.env.CANVAS_MCP_PATH_OWNER_HTML_DELETE_CASE;
  assert(selectedCaseId === undefined || Object.hasOwn(htmlDeleteCaseNames, selectedCaseId),
    'CANVAS_MCP_PATH_OWNER_HTML_DELETE_CASE must be absent or one of cohort, physical-web, physical-b2-revocation, implicit-live-update, after-physical, grant-after-intent, commit-ack-loss, archive-negative, grouped-read-revocation, public, blocked.');
  const selectedCaseName = selectedCaseId === undefined ? undefined
    : htmlDeleteCaseNames[selectedCaseId as keyof typeof htmlDeleteCaseNames];
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
    const { advanceWorkspaceOperationNativePathAdmission } = await import('../app/lib/files/workspace-operation-native-path-admission');
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
          // This is the real, fixed prelude, OUTSIDE the old lifecycle owner's
          // workspace flock. Pending is an honest retained job, not an effect.
          const admission = await advanceWorkspaceOperationNativePathAdmission(jobClaim, { mcpPrincipal: live });
          if (admission.status === 'pending') {
            assert(admission.requestId);
            const unfinished = await store.finishClaim(batch, { status: 'needs_recovery', phase: 'recovery',
              errorCode: 'COLLABORATION_FILE_LIFECYCLE_BUSY' });
            assert.equal(unfinished?.status, 'needs_recovery');
            return admission;
          }
          assert.equal(admission.status, 'ready');
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
    // The real room server also runs background projection. Its materializer
    // owns these same workspace locks through receipt/file finalization. Wait
    // outside the locks, then recheck inside; never filter writes out of the
    // global SQL observer or wait on a blocked projector while holding a lock.
    const withSettledProjectionReadBoundary = async <T>(operation: () => Promise<T>): Promise<T> => {
      const { listPendingCollaborationProjections } = await import('../app/lib/collaboration/projection-repository');
      const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
      const workspaces = [...new Set([h.source.workspaceId, h.destination.workspaceId])].sort();
      const assertProjectionWorkspaceScope = async () => {
        const rows = (await h.admin.query(`SELECT DISTINCT workspace_id FROM collaboration_yjs_states
          WHERE status='active' ORDER BY workspace_id LIMIT 513`)).rows;
        assert(rows.length <= 512);
        for (const row of rows) assert(workspaces.includes(row.workspace_id),
          'Every real projector workspace in the observed realm must be inside the read barrier.');
      };
      const pending = async () => {
        await assertProjectionWorkspaceScope();
        const requests = await listPendingCollaborationProjections('', 500);
        assert(requests.length < 500, 'The owned projection census must remain bounded and complete.');
        return requests.length !== 0;
      };
      const locked = <R>(index: number, action: () => Promise<R>): Promise<R> => index === workspaces.length
        ? action() : withWorkspaceMutationLock(workspaces[index], () => locked(index + 1, action));
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        if (!await pending()) {
          const observed = await locked(0, async () => {
            if (await pending()) return { ready: false as const };
            return { ready: true as const, result: await operation() };
          });
          if (observed.ready) return observed.result;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.fail('Real background projections did not finalize before the historical read boundary.');
    };
    const noMutation = async <T>(operation: () => Promise<T>, callsite: 'unspecified' | 'pending-current-a-get'
      | 'pending-original-a-get' | 'pending-original-a-post' | 'pending-current-b-get' | 'pending-final-b-get' = 'unspecified'): Promise<T> => {
      let diagnosticPhase = 'beforeDomainSnapshot', statements = 0, notifyStatements = 0;
      let before: Awaited<ReturnType<typeof snapshot>> | undefined, files: Awaited<ReturnType<typeof filesystem>> | undefined;
      const writes: string[] = [], writerClients = new Set<MetadataSqlEvent['client']>(), mentionedTables = new Set<string>();
      const statementKinds: Record<string, number> = Object.create(null);
      const kinds = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP',
        'BEGIN', 'COMMIT', 'ROLLBACK', 'SET', 'LOCK', 'SAVEPOINT', 'RELEASE']);
      const fixedTables = new Set<string>();
      try {
        before = await snapshot(); diagnosticPhase = 'beforeFilesystemSnapshot'; files = await filesystem();
        for (const table of before.tables) if (typeof table.relname === 'string'
          && /^(?:(?:collaboration_|file_collaboration_|workspace_file_)[a-z0-9_]{1,100}|file_revisions|file_revision_contents|file_version_blobs|workspace_trash_entries)$/u.test(table.relname)) fixedTables.add(table.relname);
        diagnosticPhase = 'operation';
        const result = await h.withProbe(async event => {
          diagnosticPhase = 'budget';
          assert(++statements <= 5000);
          const word = /^\s*([A-Za-z]+)/u.exec(event.text)?.[1]?.toUpperCase() ?? 'OTHER';
          const kind = kinds.has(word) ? word : 'OTHER'; statementKinds[kind] = (statementKinds[kind] ?? 0) + 1;
          if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[\s\S]*?\bSET\b|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)
            || /\bpg_notify\s*\(/iu.test(event.text)) {
            writes.push(event.text); writerClients.add(event.client);
            if (/\bpg_notify\s*\(/iu.test(event.text)) notifyStatements++;
            // Fixed migration-table names mentioned by a detected write, not
            // SQL text or a claim that every mentioned table was its target.
            for (const name of fixedTables) if (event.text.includes(name)) mentionedTables.add(name);
          }
          diagnosticPhase = 'operation';
        }, operation);
        diagnosticPhase = 'budget'; assert(statements > 0);
        diagnosticPhase = 'noDMLNotify'; assert.deepEqual(writes, [], 'Actual pure status must issue no DML/DDL.');
        diagnosticPhase = 'domainSnapshot'; assert.deepEqual(await snapshot(), before);
        diagnosticPhase = 'filesystemSnapshot'; assert.deepEqual(await filesystem(), files); return result;
      } catch (error) {
        try {
          const diagnostic: Record<string, unknown> = { callsite, phase: diagnosticPhase, statements, writerStatements: writes.length, notifyStatements,
            writerClients: writerClients.size, statementKinds, mentionedFixedTables: [...mentionedTables].sort().slice(0, 16),
            mentionedFixedTablesTruncated: mentionedTables.size > 16 };
          if (error instanceof assert.AssertionError && diagnosticPhase === 'domainSnapshot') {
            const actual = error.actual as { rows?: Record<string, unknown>; tables?: unknown[] } | null;
            const expected = error.expected as { rows?: Record<string, unknown>; tables?: unknown[] } | null;
            if (actual?.rows && expected?.rows) {
              const changed: Array<{ table: string; beforeRows: number | null; afterRows: number | null }> = [];
              for (const table of fixedTables) {
                const a = actual.rows[table], b = expected.rows[table];
                if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length
                  || a.slice(0, 10000).some((row, index) => row?.body !== b[index]?.body || row?.xmin !== b[index]?.xmin)) {
                  changed.push({ table, beforeRows: Array.isArray(b) ? b.length : null, afterRows: Array.isArray(a) ? a.length : null });
                  if (changed.length === 17) break;
                }
              }
              diagnostic.domain = { changedTables: changed.slice(0, 16), truncated: changed.length > 16,
                beforeTableCount: Array.isArray(expected.tables) ? expected.tables.length : null,
                afterTableCount: Array.isArray(actual.tables) ? actual.tables.length : null };
            }
          }
          if (error instanceof assert.AssertionError && diagnosticPhase === 'filesystemSnapshot'
            && Array.isArray(error.actual) && Array.isArray(error.expected)) {
            const actual = new Map<string, Record<string, unknown>>(), expected = new Map<string, Record<string, unknown>>();
            for (const entry of error.actual.slice(0, 10000)) if (entry && typeof entry === 'object' && typeof entry.path === 'string') actual.set(entry.path, entry);
            for (const entry of error.expected.slice(0, 10000)) if (entry && typeof entry === 'object' && typeof entry.path === 'string') expected.set(entry.path, entry);
            const changed: string[] = [], keys = new Set([...actual.keys(), ...expected.keys()]);
            for (const key of keys) {
              const a = actual.get(key), b = expected.get(key);
              if (!a || !b || ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'sha256'].some(field => a[field] !== b[field])) {
                changed.push(sha(key)); if (changed.length === 17) break;
              }
            }
            diagnostic.filesystem = { beforeEntries: error.expected.length, afterEntries: error.actual.length,
              changedKeyHashes: changed.slice(0, 16), truncated: changed.length > 16 };
          }
          console.error(JSON.stringify({ test: 'native-path-no-mutation-diagnostic', case: currentCase, ...diagnostic }));
        } catch {
          try { console.error(JSON.stringify({ test: 'native-path-no-mutation-diagnostic', phase: diagnosticPhase, diagnosticUnavailable: true })); }
          catch { /* Diagnostics cannot replace the original failure. */ }
        }
        throw error;
      }
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
    // One real probe, never wrapped around afterActualCommit/noMutation. The
    // separate test channel orders negative observations without a sleep.
    const observeNativePathTerminalNotifications = async <T>(job: Job,
      expected: Readonly<{ mode: 'committed' | 'rollback' | 'none'; requestId?: string }>,
      operation: () => Promise<T>, loseCommitAck = false): Promise<T> => {
      assert(job.batch); const batchId = job.batch.batchId;
      const controlChannel = `canvas_path_notify_${crypto.randomBytes(12).toString('hex')}`, barrier = crypto.randomUUID();
      const productChannel = 'canvas_workspace_files', payload = JSON.stringify({ workspaceId: job.plan.workspaceId });
      const sql = expected.requestId === undefined
        ? `SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${receiptTable(job)}" t WHERE batch_id=$1`
        : 'SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM collaboration_admission_requests t WHERE request_id=$1';
      const key = expected.requestId ?? batchId, packets: Notification[] = [];
      const subscriberPid = Number((await h.admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      assert(Number.isSafeInteger(subscriberPid) && subscriberPid > 0);
      let observedClient: MetadataSqlEvent['client'] | undefined, observed: CommitObservation | undefined;
      let before: unknown, terminal = false, barrierSeen = false, notifyCalls = 0, listenerFailure: unknown;
      let failed = false, failure: unknown, result!: T, probeStage = 'listen', notifyCandidates = 0;
      let exactTerminalSql = false, failureStage: string | null = null;
      const injected = Object.assign(new Error('FIXTURE_TERMINAL_NOTIFY_ROLLBACK'), { code: 'FIXTURE_TERMINAL_NOTIFY_ROLLBACK' });
      const onNativePathTerminalNotification = (message: Notification): void => {
        try {
          if (message.channel === controlChannel && message.payload === barrier) {
            assert.equal(message.processId, observed?.pid ?? subscriberPid); barrierSeen = true; return;
          }
          if (message.channel !== productChannel || message.payload !== payload) return;
          assert(packets.length < 8); assert.deepEqual(JSON.parse(message.payload), { workspaceId: job.plan.workspaceId }); packets.push(message);
        } catch (error) { listenerFailure ??= error; }
      };
      h.admin.on('notification', onNativePathTerminalNotification);
      try {
        await h.admin.query(`LISTEN ${productChannel}`); await h.admin.query(`LISTEN ${controlChannel}`);
        probeStage = 'operation';
        try { result = await h.withProbe(async event => {
          if (/\bpg_notify\s*\(/iu.test(event.text)) {
            probeStage = 'notify-arguments'; notifyCandidates++;
            exactTerminalSql = event.text === 'SELECT pg_catalog.pg_notify($1, $2)';
            assert.equal(expected.mode === 'none', false, 'Historical work must execute no Notify statement.');
            assert.deepEqual(event.values, [productChannel, payload]); assert.equal(++notifyCalls, 1, 'Count SQL calls as well as deduplicated PG deliveries.');
            observedClient = event.client; probeStage = 'notify-witness';
            const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
              pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
            assert.equal(witness.schema, h.schema); assert(witness.xid); assert.notEqual(Number(witness.pid), subscriberPid); assert.equal(packets.length, 0);
            probeStage = 'terminal-rows';
            const own = (await event.raw(sql, [key])).rows; assert.equal(own.length, 1);
            const body = JSON.parse(own[0].body);
            if (expected.requestId === undefined) assert.equal(body.batch_id, batchId);
            else {
              const outcome = JSON.parse(body.outcome_text); assert.equal(body.request_id, expected.requestId);
              assert.equal(body.status, 'committed'); assert.equal(outcome.version, 2); assert.equal(outcome.disposition, 'aborted');
              assert.equal(outcome.reasonCode, 'precondition_failed'); assert.equal(outcome.requestId, expected.requestId);
              const request = JSON.parse(body.intent_text), action = JSON.parse(request.actionPayloadText);
              assert.equal(action.batchId, batchId); assert.equal(action.planId, job.plan.planId);
            }
            probeStage = 'uncommitted-observer';
            before = (await h.admin.query(sql, [key])).rows;
            assert.notDeepEqual(before, own, 'The independently observed terminal effect is not committed yet.');
            observed = { before: own, pid: Number(witness.pid), start: witness.start, xid: witness.xid };
            if (expected.mode === 'rollback') { probeStage = 'rollback-fault'; throw injected; }
          }
          if (observed && event.client === observedClient && /^\s*(?:COMMIT|ROLLBACK)\s*$/iu.test(event.text) && !terminal) {
            probeStage = 'terminal-command';
            assert.equal(event.result.command, expected.mode === 'rollback' ? 'ROLLBACK' : 'COMMIT'); terminal = true;
            probeStage = 'terminal-witness';
            const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
              pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
            assert.equal(Number(witness.pid), observed.pid); assert.equal(witness.start, observed.start); assert.equal(witness.xid, null);
            probeStage = 'terminal-visible-rows';
            assert.deepEqual((await h.admin.query(sql, [key])).rows, expected.mode === 'rollback' ? before : observed.before);
            probeStage = 'terminal-barrier';
            await event.raw('SELECT pg_catalog.pg_notify($1,$2)', [controlChannel, barrier]);
            if (loseCommitAck) { probeStage = 'commit-ack-fault'; throw Object.assign(new Error('FIXTURE_TERMINAL_NOTIFY_ACK_LOST'), { code: 'FIXTURE_TERMINAL_NOTIFY_ACK_LOST' }); }
          }
        }, operation); } catch (error) { failed = true; failure = error; failureStage = probeStage; }
        probeStage = 'notify-count';
        if (expected.mode === 'none') {
          assert.equal(notifyCalls, 0); await h.admin.query('SELECT pg_catalog.pg_notify($1,$2)', [controlChannel, barrier]);
        } else { assert.equal(notifyCalls, 1); assert(terminal && observed); }
        probeStage = 'barrier-wait';
        await waitForNativePathRoomCondition(() => barrierSeen || listenerFailure !== undefined, 'Actual terminal-notification server barrier was not delivered.');
        probeStage = 'listener';
        if (listenerFailure !== undefined) throw listenerFailure;
        probeStage = 'packet-count';
        assert.equal(packets.length, expected.mode === 'committed' ? 1 : 0);
        probeStage = 'packet-origin';
        if (expected.mode === 'committed') { assert(observed); assert.equal(packets[0].processId, observed.pid); }
        probeStage = 'injected-identity';
        if (expected.mode === 'rollback') { assert(failed); assert.equal(failure, injected); }
        probeStage = 'original-failure';
        if (failed) throw failure; return result;
      } catch (error) {
        // Diagnostic only: retain the stored operation error even if a later
        // observation assertion is the outgoing failure. Never change either.
        try {
          const queued: Array<{ role: string; value: unknown; depth: number }> = [
            { role: 'outgoing', value: error, depth: 0 }, { role: 'stored', value: failure, depth: 0 },
            { role: 'listener', value: listenerFailure, depth: 0 },
          ];
          const seen = new WeakSet<object>(), diagnostics: Record<string, unknown>[] = [];
          while (queued.length && diagnostics.length < 8) {
            const item = queued.shift()!;
            if (!item.value || typeof item.value !== 'object' || item.depth > 4) continue;
            const value = item.value, fields = Object.getOwnPropertyDescriptors(value);
            const record: Record<string, unknown> = { role: item.role, code: code(value) };
            const sqlstate = fields.code?.value;
            if (typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/u.test(sqlstate)) record.sqlstate = sqlstate;
            const name = value instanceof Error ? value.name : fields.name?.value;
            if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name)) record.name = name;
            for (const key of ['actual', 'expected']) {
              const scalar = fields[key]?.value;
              if (scalar === null || typeof scalar === 'boolean' || typeof scalar === 'number' && Number.isFinite(scalar)
                || typeof scalar === 'string' && /^(?:[A-Z][A-Z0-9_]{0,95}|none|committed|rollback|move|delete|precondition_failed|aborted|owner_drain)$/u.test(scalar)) record[key] = scalar;
            }
            const stack = fields.stack?.value;
            if (typeof stack === 'string') record.frames = stack.slice(0, 8192).split('\n')
              .filter(line => /^\s*at\b/u.test(line)).slice(0, 6).map(line => line.trim().slice(0, 384));
            diagnostics.push(record);
            if (seen.has(value)) continue; seen.add(value);
            if (fields.cause && 'value' in fields.cause) queued.push({ role: `${item.role}.cause`, value: fields.cause.value, depth: item.depth + 1 });
            if (Array.isArray(fields.errors?.value)) for (const child of fields.errors.value.slice(0, 4)) {
              queued.push({ role: `${item.role}.aggregate`, value: child, depth: item.depth + 1 });
            }
          }
          console.error(JSON.stringify({ test: 'path-terminal-notify-original-error', kind: job.kind, mode: expected.mode,
            probeStage, failureStage, failed, notifyCandidates, exactTerminalSql, notifyCalls, terminal, observed: Boolean(observed),
            barrierSeen, packets: packets.length, diagnostics }));
        } catch { /* Diagnostic failure must not replace the existing assertion. */ }
        throw error;
      } finally {
        h.admin.off('notification', onNativePathTerminalNotification);
        try { await h.admin.query(`UNLISTEN ${controlChannel}`); }
        finally { await h.admin.query(`UNLISTEN ${productChannel}`); }
      }
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
    let discoveredGroups = 0;
    const omittedCases: string[] = [];
    const check = async (name: string, callback: () => Promise<void>) => {
      discoveredGroups++;
      if (selectedCaseName !== undefined && (selectedCaseId === 'cohort' ? !name.startsWith('Cohort6 ') : name !== selectedCaseName)) {
        omittedCases.push(name);
        console.log(JSON.stringify({ test: 'direct-mcp-job-owner-integration', status: 'omitted', case: name,
          selectedCaseId, fullSuite: false }));
        return;
      }
      currentCase = name; await callback(); groups++; console.log(`MCP job owner case passed: ${name}`);
    };
    // Only the new live families construct this runtime. Existing cases below
    // retain their original genuine PG/FD setup and assertions.
    async function startNativePathRoomRuntime() {
      const { Y } = await import('../app/lib/collaboration/server-runtime');
      const { createCollaborationServer, flushCollaborationDocuments } = await import('../server/collaboration-server');
      const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
      const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
      const admission = createCollaborationAdmissionService({ openConnection: openDb });
      const documents = new Map<string, import('@hocuspocus/server').Document>();
      const sockets = new Set<WebSocket>(), clientDocs = new Set<YTypes.Doc>(), clients = new Set<Client>();
      const sessions = new Set<Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>>();
      const backends: Array<{ pid: number; start: string }> = [], failures: unknown[] = [];
      const server = http.createServer((_request, response) => { response.statusCode = 404; response.end(); });
      const originalHooks = Hocuspocus.prototype.hooks;
      let runtime: Hocuspocus | undefined, wss: ReturnType<typeof createCollaborationServer> | undefined, closing = false;
      let gate: { documentId: string; entered: boolean; released: boolean; release: () => void; wait: Promise<void> } | undefined;
      const close = async () => {
        closing = true; gate?.release();
        const cleanup: unknown[] = [];
        for (const socket of sockets) socket.terminate();
        try {
          await waitForNativePathRoomCondition(() => [...documents.values()].every(doc => doc.getConnectionsCount() === 0), 'Owned live peer connections did not close.');
          await flushCollaborationDocuments();
        } catch (error) { cleanup.push(error); }
        if (runtime) {
          for (const doc of [...runtime.documents.values()]) try { await runtime.unloadDocument(doc); } catch (error) { cleanup.push(error); }
          for (const pending of [...runtime.unloadingDocuments.values()]) try { await pending; } catch (error) { cleanup.push(error); }
        }
        if (wss) try {
          let finished = false, failure: Error | undefined;
          wss.close(error => { failure = error; finished = true; });
          await waitForNativePathRoomCondition(() => finished, 'Owned live WSS did not close.'); if (failure) throw failure;
        } catch (error) { cleanup.push(error); }
        try { await waitForNativePathRoomCondition(() => [...sockets].every(socket => socket.readyState === WebSocket.CLOSED), 'Owned actual peer sockets remain open.'); }
        catch (error) { cleanup.push(error); }
        try {
          let finished = false, failure: Error | undefined;
          server.close(error => { if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') failure = error; finished = true; });
          await waitForNativePathRoomCondition(() => finished, 'Owned live HTTP server did not close.'); if (failure) throw failure;
        } catch (error) { cleanup.push(error); }
        for (const session of sessions) try { await session.close(); } catch (error) { cleanup.push(error); }
        for (const client of clients) try { await client.end(); clients.delete(client); } catch (error) { cleanup.push(error); }
        for (const doc of clientDocs) doc.destroy();
        Hocuspocus.prototype.hooks = originalHooks;
        for (const backend of backends) try {
          await waitForNativePathRoomCondition(async () => {
            const rows = (await h.admin.query('SELECT extract(epoch FROM backend_start)::text AS start FROM pg_stat_activity WHERE pid=$1', [backend.pid])).rows;
            if (rows.length) assert.equal(rows[0].start, backend.start, 'Observed owner PID was reused.');
            return rows.length === 0;
          }, 'Owned actual room backend remains.');
        } catch (error) { cleanup.push(error); }
        cleanup.push(...failures);
        if (cleanup.length) throw new AggregateError(cleanup, 'Actual native path room closure failed.');
        console.log(JSON.stringify({ closure: 'native-path-live-room', actualOwnerBackendsClosed: backends.length, socketsClosed: sockets.size }));
      };
      try {
        Hocuspocus.prototype.hooks = (async function (this: Hocuspocus, name: string, payload: Record<string, unknown>, ...args: unknown[]) {
          if (runtime) assert.equal(this, runtime, 'Only the one owned Hocuspocus instance is observed.');
          else {
            // Capture the actual server instance only for observation and its
            // awaited teardown; no substituted runtime is supplied to product.
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            runtime = this;
          }
          const result = await Reflect.apply(originalHooks, this, [name, payload, ...args]);
          if (name === 'onLoadDocument' && typeof payload.documentName === 'string' && payload.document) {
            documents.set(payload.documentName, payload.document as import('@hocuspocus/server').Document);
          }
          if (name === 'connected' && typeof payload.documentName === 'string' && payload.connection) {
            documents.set(payload.documentName, (payload.connection as import('@hocuspocus/server').Connection).document);
          }
          // Original beforeSync has already acquired its real activity/mutex
          // and authorized the exact frame. This gate only holds its ACK.
          if (name === 'beforeSync' && gate && !gate.entered && payload.documentName === gate.documentId && payload.type === 2) {
            gate.entered = true; await gate.wait;
          }
          return result;
        }) as typeof originalHooks;
        wss = createCollaborationServer(server, { roomOwner: {
          createSession: async onInvalidated => {
            const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: h.applicationName,
              options: `-c search_path=${h.schema},pg_catalog -c statement_timeout=15000`, connectionTimeoutMillis: 5000 });
            clients.add(client); client.on('error', error => { if (!closing) failures.push(error); }); await client.connect();
            const actual = (await client.query(`SELECT current_schema() AS schema,pg_backend_pid() AS pid,
              extract(epoch FROM backend_start)::text AS start FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
            assert.equal(actual.schema, h.schema); backends.push({ pid: Number(actual.pid), start: actual.start });
            const session = await createCollaborationRoomOwnerSession({ query: client.query.bind(client), on: client.on.bind(client),
              end: async () => { await client.end(); clients.delete(client); } }, onInvalidated);
            sessions.add(session); return session;
          }, heartbeatMs: 100,
          admission: { pendingDrains: admission.pendingDrains, readDrain: admission.readDrain, pollMs: 50 },
        } });
        let listening = false, listenError: Error | undefined;
        server.once('error', error => { listenError = error; listening = true; }); server.listen(0, '127.0.0.1', () => { listening = true; });
        await waitForNativePathRoomCondition(() => listening, 'Owned actual room server did not listen.'); if (listenError) throw listenError;
        return { Y, server, documents, sockets, clientDocs, backends, admission, flush: flushCollaborationDocuments, close,
          isLoaded: (documentId: string) => runtime?.documents.has(documentId) ?? false,
          actualDocument: (documentId: string) => runtime?.documents.get(documentId),
          assertHealthy: () => { if (failures.length) throw new AggregateError(failures, 'Owned live room failed.'); },
          holdNextUpdate: (documentId: string) => {
            assert(!gate || gate.released); let release!: () => void;
            const wait = new Promise<void>(resolve => { release = resolve; });
            const selected: { documentId: string; entered: boolean; released: boolean; wait: Promise<void>; release: () => void } = { documentId, entered: false, released: false, wait, release: () => {
              if (selected.released) return; selected.released = true; clearTimeout(timer); release();
            } };
            const timer = setTimeout(() => { failures.push(new Error('Owned beforeSync observation gate exceeded 8 seconds.')); selected.release(); }, 8_000);
            gate = selected; return selected;
          } };
      } catch (error) {
        try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Owned actual room startup and closure failed.'); }
        throw error;
      }
    }
    async function openNativePathRoomPeer(room: Awaited<ReturnType<typeof startNativePathRoomRuntime>>, documentId: string) {
      const { issueCollaborationTicket } = await import('../app/lib/collaboration/ticket');
      const { inspectNativeDocument } = await import('../app/lib/collaboration/document-snapshot');
      const state = await load(h.connection, documentId); assert(state?.status === 'active');
      const registry = (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [documentId])).rows[0]; assert(registry);
      const identity: DocumentVersionIdentityV1 = { documentId, workspaceId: state.workspaceId, organizationId: state.organizationId,
        lineageId: registry.lineage_id, lifecycleGeneration: state.lifecycleGeneration, representation: state.representation, schemaVersion: state.schemaVersion };
      const request = await h.request(h.source, 'member', true, currentRequestToken), session = await auth.api.getSession({ headers: request.headers });
      assert(session); assert.equal(session.session.id, currentSession); assert.equal(session.user.id, 'member');
      const cookie = request.headers.get('cookie'); assert(cookie);
      const issued = issueCollaborationTicket({ userId: 'member', sessionId: session.session.id, documentId,
        workspaceId: state.workspaceId, organizationId: state.organizationId, path: state.path, representation: state.representation,
        lifecycleGeneration: state.lifecycleGeneration, provider: 'yjs', permission: 'write' });
      const address = room.server.address(); assert(address && typeof address === 'object');
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/collaboration`, { headers: { origin: 'http://localhost', cookie, 'x-canvas-workspace-id': h.source.workspaceId } });
      room.sockets.add(socket); const doc = new room.Y.Doc(); room.clientDocs.add(doc);
      let opened = false, authenticated = false, denied = false, startup = false, failure: unknown, closeReason: string | null = null;
      let acceptedUpdates = 0, rejectedUpdates = 0;
      socket.once('open', () => { opened = true; }); socket.on('error', error => { failure = error; });
      socket.on('message', data => {
        try {
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? new Uint8Array(Buffer.concat(data)) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const decoder = decoding.createDecoder(bytes); assert.equal(decoding.readVarString(decoder), documentId); const type = decoding.readVarUint(decoder);
          if (type === MessageType.Auth) { const value = decoding.readVarUint(decoder); authenticated ||= value === AuthMessageType.Authenticated; denied ||= value === AuthMessageType.PermissionDenied; }
          if (type === MessageType.Stateless) startup ||= JSON.parse(decoding.readVarString(decoder)).type === 'durability_snapshot';
          if (type === MessageType.SyncStatus) {
            const accepted = decoding.readVarUint(decoder); assert(accepted === 0 || accepted === 1);
            if (accepted === 1) acceptedUpdates++; else rejectedUpdates++;
          }
          if (type === MessageType.CLOSE) closeReason = decoding.readVarString(decoder);
          if (type === MessageType.Sync) { const subtype = decoding.readVarUint(decoder); if (subtype === 1 || subtype === 2) room.Y.applyUpdate(doc, decoding.readVarUint8Array(decoder)); }
        } catch (error) { failure = error; }
      });
      await waitForNativePathRoomCondition(() => opened || Boolean(failure), 'Actual native path peer did not open.'); if (failure) throw failure;
      const authFrame = encoding.createEncoder(); encoding.writeVarString(authFrame, documentId); encoding.writeVarUint(authFrame, MessageType.Auth);
      encoding.writeVarUint(authFrame, AuthMessageType.Token); encoding.writeVarString(authFrame, issued.token); socket.send(encoding.toUint8Array(authFrame));
      await waitForNativePathRoomCondition(() => authenticated || denied || Boolean(failure), 'Actual native path peer did not authenticate.'); if (failure) throw failure; assert(authenticated && !denied);
      await waitForNativePathRoomCondition(() => startup && room.documents.has(documentId), 'Actual native path room did not load.');
      const sync = encoding.createEncoder(); encoding.writeVarString(sync, documentId); encoding.writeVarUint(sync, MessageType.Sync); encoding.writeVarUint(sync, 0);
      encoding.writeVarUint8Array(sync, room.Y.encodeStateVector(doc)); socket.send(encoding.toUint8Array(sync));
      const persisted = new room.Y.Doc();
      try {
        room.Y.applyUpdate(persisted, state.yjsState); const expected = inspectNativeDocument(persisted, identity.representation).version.stateProof;
        await waitForNativePathRoomCondition(() => {
          if (failure) throw failure; try { return inspectNativeDocument(doc, identity.representation).version.stateProof === expected; } catch { return false; }
        }, 'Actual native path peer did not fully synchronize.');
      } finally { persisted.destroy(); }
      const ownerRow = (await h.admin.query(`SELECT room_owner_epoch,room_owner_token,room_owner_backend_pid,room_owner_backend_start
        FROM collaboration_yjs_states WHERE document_id=$1`, [documentId])).rows[0];
      assert(ownerRow?.room_owner_token); assert(room.backends.some(value => value.pid === Number(ownerRow.room_owner_backend_pid)));
      return { doc, socket, identity, ownerRow, closeReason: () => closeReason,
        updateAcks: () => ({ accepted: acceptedUpdates, rejected: rejectedUpdates }),
        sendUpdate: (update: Uint8Array) => { assert.equal(socket.readyState, WebSocket.OPEN); const frame = encoding.createEncoder();
          encoding.writeVarString(frame, documentId); encoding.writeVarUint(frame, MessageType.Sync); encoding.writeVarUint(frame, 2); encoding.writeVarUint8Array(frame, update); socket.send(encoding.toUint8Array(frame)); } };
    }
    async function sendNativePathRoomParagraph(room: Awaited<ReturnType<typeof startNativePathRoomRuntime>>,
      peer: Awaited<ReturnType<typeof openNativePathRoomPeer>>, marker: string) {
      const { prepareNativeDocumentEditInDocument } = await import('../app/lib/collaboration/native-document-edit-preparation');
      const { inspectNativeDocument } = await import('../app/lib/collaboration/document-snapshot');
      const { documentVersionV1 } = await import('../app/lib/documents/read-version');
      const before = inspectNativeDocument(peer.doc, peer.identity.representation), vector = room.Y.encodeStateVector(peer.doc);
      const prepared = prepareNativeDocumentEditInDocument({ doc: peer.doc, identity: peer.identity,
        expectedVersion: documentVersionV1(peer.identity, before.version.stateProof), groupId: `live-peer-${crypto.randomUUID()}`,
        patch: { kind: 'native_text_replace', edits: [{ oldText: 'Original', newText: `Original ${marker}` }] } });
      assert.equal(prepared.noChange, false); room.Y.applyUpdate(peer.doc, prepared.nativeAfterUpdate);
      const expected = inspectNativeDocument(peer.doc, peer.identity.representation).version.stateProof;
      peer.sendUpdate(room.Y.encodeStateAsUpdate(peer.doc, vector));
      await waitForNativePathRoomCondition(() => {
        const actual = room.actualDocument(peer.identity.documentId); if (!actual) return false;
        return inspectNativeDocument(actual, peer.identity.representation).version.stateProof === expected;
      }, 'Actual accepted native peer edit never reached the room.');
      return expected;
    }
    async function captureNativePathAdmissionProof(job: Job, requestId: string, peer: Awaited<ReturnType<typeof openNativePathRoomPeer>>) {
      const { captureCollaborationAdmissionDrainTicket, readCollaborationAdmissionTerminalDrain } = await import('../app/lib/collaboration/room-admission-drain');
      const { collaborationRoomReleaseDigest } = await import('../app/lib/collaboration/room-owner-release');
      const header = (await h.admin.query(`SELECT request_id,request_digest,intent_text,status FROM collaboration_admission_requests WHERE request_id=$1`, [requestId])).rows[0];
      assert(header); assert.equal(header.status, 'committed'); assert(/^[a-f0-9]{64}$/u.test(header.request_digest));
      const target = (await h.admin.query(`SELECT document_id,snapshot_text,status,active,release_id,quiescence_kind,quiescence_text
        FROM collaboration_admission_targets WHERE request_id=$1 AND document_id=$2`, [requestId, peer.identity.documentId])).rows[0];
      assert(target); assert.equal(target.status, 'completed'); assert.equal(target.active, false); assert.equal(target.quiescence_kind, 'owner_drain');
      assert.equal(typeof target.quiescence_text, 'string'); const reserved = JSON.parse(target.snapshot_text);
      assert.equal(reserved.ownerToken, peer.ownerRow.room_owner_token); assert.equal(Number(reserved.ownerEpoch), Number(peer.ownerRow.room_owner_epoch));
      const ticket = captureCollaborationAdmissionDrainTicket({ requestId, requestDigest: header.request_digest, releaseId: target.release_id,
        fence: { scope: { documentId: peer.identity.documentId, workspaceId: peer.identity.workspaceId, organizationId: peer.identity.organizationId,
          path: job.incomingPath, representation: peer.identity.representation, lifecycleGeneration: peer.identity.lifecycleGeneration, schemaVersion: peer.identity.schemaVersion },
        epoch: Number(peer.ownerRow.room_owner_epoch), token: peer.ownerRow.room_owner_token,
        backendPid: Number(peer.ownerRow.room_owner_backend_pid), backendStart: peer.ownerRow.room_owner_backend_start } });
      assert.deepEqual((await readCollaborationAdmissionTerminalDrain(h.connection, ticket)).ticket, ticket);
      const receipt = (await h.admin.query('SELECT * FROM collaboration_room_release_receipts WHERE release_id=$1', [ticket.releaseId])).rows[0]; assert(receipt);
      assert.equal(receipt.document_id, peer.identity.documentId); assert.equal(receipt.owner_token, ticket.fence.token);
      assert.equal(Number(receipt.owner_backend_pid), ticket.fence.backendPid); assert.equal(receipt.owner_backend_start, ticket.fence.backendStart);
      const { Y } = await import('../app/lib/collaboration/server-runtime');
      assert.equal(receipt.live_update_hash, collaborationRoomReleaseDigest('update', Y.encodeStateAsUpdate(peer.doc)));
      assert.equal(receipt.live_vector_hash, collaborationRoomReleaseDigest('vector', Y.encodeStateVector(peer.doc)));
      const quiescence = JSON.parse(target.quiescence_text); assert.equal(quiescence.kind, 'owner_drain');
      assert.equal(quiescence.requestId, requestId); assert.equal(quiescence.requestDigest, header.request_digest); assert.equal(quiescence.receipt.release_id, receipt.release_id);
      assert.equal(peer.closeReason(), 'Collaboration document transition'); return { header, ticket, target, receipt };
    }
    await check('a changed second genuine B2 intent SQL reply cannot reuse prior pure facts; SID-B resumes Original', async () => {
      const job = await seed('move', true);
      type Witness = { client: MetadataSqlEvent['client']; pid: number; start: string; xid: string };
      let ownerWitness: Witness | undefined, changed: Witness | undefined;
      let original: Awaited<ReturnType<typeof immutableBatch>> | undefined;
      let header: Awaited<ReturnType<typeof row>> | undefined, physical: Awaited<ReturnType<typeof row>> | undefined;
      let domain: Awaited<ReturnType<typeof snapshot>> | undefined, files: Awaited<ReturnType<typeof filesystem>> | undefined;
      const first = new Map<string, Record<string, unknown>>(), effects = new Map<string, number>();
      const witness = async (event: MetadataSqlEvent): Promise<Witness> => {
        const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
          pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema,
          pg_catalog.to_regnamespace(current_schema())::oid::text AS schema_oid
          FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
        assert.equal(actual.schema, h.schema); assert.equal(actual.schema_oid, h.schemaOid);
        assert(Number.isSafeInteger(Number(actual.pid)) && Number(actual.pid) > 0);
        assert.equal(typeof actual.start, 'string'); assert(/^[0-9]+\.[0-9]+$/u.test(actual.start));
        assert.equal(typeof actual.xid, 'string'); assert(/^[0-9]{1,32}$/u.test(actual.xid));
        return { client: event.client, pid: Number(actual.pid), start: actual.start, xid: actual.xid };
      };
      await assert.rejects(run('move', currentToken, h.source.workspaceId, async live => {
        await create(job, live);
        return h.withProbe(async event => {
          if (/^\s*INSERT\s+INTO\b/iu.test(event.text) && event.text.includes('workspace_file_operation_move_path_receipts')
            && event.values[0] === job.batch!.batchId && event.result.rowCount === 1) {
            const actual = await witness(event);
            if (ownerWitness) { assert.equal(actual.client, ownerWitness.client); assert.equal(actual.pid, ownerWitness.pid);
              assert.equal(actual.start, ownerWitness.start); }
            else ownerWitness = actual;
          }
          if (!ownerWitness || event.client !== ownerWitness.client) return;
          if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[\s\S]*?\bSET\b|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)
            || /\bpg_notify\s*\(/iu.test(event.text)) {
            const actual = await witness(event); effects.set(actual.xid, (effects.get(actual.xid) ?? 0) + 1);
          }
          if (!/^\s*SELECT\b/iu.test(event.text) || !event.text.includes('workspace_file_operation_move_intents')
            || !/\bFOR\s+SHARE\s+NOWAIT\s*$/iu.test(event.text) || event.values[0] !== job.batch!.batchId
            || event.result.rowCount !== 1 || !Object.hasOwn(event.result.rows[0], 'intentText')) return;
          const rows = (await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
            FROM workspace_file_operation_move_path_receipts t WHERE batch_id=$1 ORDER BY to_jsonb(t)::text`, [job.batch!.batchId])).rows;
          // Stage's INSERT reselect/final read and every unfinished B1 phase are excluded.
          if (rows.length !== 2) return;
          assert.equal(job.plan.actions[0].selections.length, 2);
          assert.deepEqual(await row('workspace_file_operation_move_path_receipts', job.batch!.batchId), rows,
            'Both original B1 path receipts must be independently committed before observing B2.');
          const actual = await witness(event);
          assert.equal(actual.pid, ownerWitness.pid); assert.equal(actual.start, ownerWitness.start);
          const previous = first.get(actual.xid);
          if (!previous) { first.set(actual.xid, { ...event.result.rows[0] }); return; }
          assert.equal(changed, undefined); assert.deepEqual(event.result.rows[0], previous);
          assert.equal(effects.get(actual.xid) ?? 0, 0, 'No native or other DML/DDL/notify precedes the changed B2 reply.');
          changed = actual; original = await immutableBatch(job); header = await row(intentTable(job), job.batch!.batchId);
          physical = rows; domain = await snapshot(); delete domain.rows.workspace_file_operation_batches;
          files = await filesystem();
          const reply = event.result.rows[0], other = reply.requestHash === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
          assert(typeof reply.requestHash === 'string'); assert(/^[a-f0-9]{64}$/u.test(reply.requestHash));
          reply.requestHash = other; // Only this successful genuine SQL result is faulted; no persisted row is changed.
        }, () => invoke(job, live, job.batch!));
      }), rejected('ORIGINAL_MOVE_CHANGED'));
      assert(changed && ownerWitness && job.batch && job.original && original && header && physical && domain && files);
      assert(first.has(changed.xid)); assert.equal(changed.client, ownerWitness.client);
      assert.equal(effects.get(changed.xid) ?? 0, 0, 'Fresh-row rejection must occur before native B2 effects.');
      assert.equal((await store.get(job.batch.batchId))?.status, 'needs_recovery');
      assert.equal((await row(receiptTable(job), job.batch.batchId)).length, 0);
      assert.equal(header.length, 1); assert.deepEqual(await row(intentTable(job), job.batch.batchId), header);
      assert.deepEqual(await row('workspace_file_operation_move_path_receipts', job.batch.batchId), physical);
      assert.deepEqual(await immutableBatch(job), original);
      const after = await snapshot(); delete after.rows.workspace_file_operation_batches; assert.deepEqual(after, domain);
      assert.deepEqual(await filesystem(), files, 'Only B2 is unchanged here; B1 already moved the original PDF.');
      assert(job.pdfPath && job.destinationPdf && job.pdf); await absent(path.join(h.source.rootPath, job.pdfPath));
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, job.destinationPdf)), job.pdf);
      const beforeIncoming = await load(h.connection, job.incomingId); assert(beforeIncoming);
      const sidA = job.original.actorSessionId, old = await rotate(); assert.notEqual(currentSession, sidA);
      await assert.rejects(run('move', old, h.source.workspaceId, async live => { await freshScope(live); }), rejected('invalid_token'));
      await recover(job); assert.equal(job.original.actorSessionId, sidA); await assertComplete(job);
      assert.deepEqual(await immutableBatch(job), original); assert.deepEqual(await row(intentTable(job), job.batch.batchId), header);
      assert.deepEqual(await row('workspace_file_operation_move_path_receipts', job.batch.batchId), physical);
      const finalIncoming = await load(h.connection, job.incomingId); assert(finalIncoming);
      assert.equal(finalIncoming.documentSequence, beforeIncoming.documentSequence + 1);
    });
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
    await check('terminal Move/Delete hints share the actual B2 COMMIT; rollback is silent and lost ACK is already published once', async () => {
      for (const kind of ['move', 'delete'] as const) {
        const job = await seed(kind);
        await run(kind, currentToken, job.plan.workspaceId, async live => { await create(job, live); });
        const incomingBefore = await load(h.connection, job.incomingId); assert(incomingBefore);
        await assert.rejects(observeNativePathTerminalNotifications(job, { mode: 'rollback' },
          () => run(kind, currentToken, job.plan.workspaceId, live => invoke(job, live, job.batch!))),
        rejected('FIXTURE_TERMINAL_NOTIFY_ROLLBACK'));
        assert.equal((await row(receiptTable(job), job.batch!.batchId)).length, 0);
        assert.deepEqual((await h.admin.query('SELECT status,path FROM collaboration_documents WHERE id=$1', [job.targetId])).rows,
          [{ status: 'active', path: job.sourcePath }]);
        const incomingAfter = await load(h.connection, job.incomingId); assert(incomingAfter);
        assert.deepEqual(Buffer.from(incomingAfter.yjsState), Buffer.from(incomingBefore.yjsState));
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_trash_entries WHERE workspace_id=$1 AND original_path=$2',
          [job.plan.workspaceId, job.sourcePath])).rows[0].n, 0);
        await assert.rejects(observeNativePathTerminalNotifications(job, { mode: 'committed' }, () => recover(job), true),
          rejected('JOB_LIFECYCLE_COMMIT_UNCONFIRMED'));
        const receipt = await row(receiptTable(job), job.batch!.batchId); assert.equal(receipt.length, 1);
        const original = await immutableBatch(job);
        await observeNativePathTerminalNotifications(job, { mode: 'none' }, () => recover(job));
        assert.deepEqual(await row(receiptTable(job), job.batch!.batchId), receipt);
        assert.deepEqual(await immutableBatch(job), original); await assertComplete(job);
        await run(kind, currentToken, job.plan.workspaceId, live => noMutation(() => status(job, live)));
      }
    });
    const nativeRooms = await startNativePathRoomRuntime();
    let nativeRoomFailure: unknown;
    try {
      await check('actual live Incoming rooms drain by retained tickets before native Move and Delete; explicit SID-B recovery keeps Original', async () => {
        const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
        const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
        for (const kind of ['move', 'delete'] as const) {
          const job = await seed(kind), peer = await openNativePathRoomPeer(nativeRooms, job.incomingId), marker = `live-${crypto.randomUUID()}`;
          await sendNativePathRoomParagraph(nativeRooms, peer, marker); await nativeRooms.flush();
          // Final initial planning follows actual accepted/saved peer content.
          // No job or immutable Original exists until this exact plan is bound.
          await run(kind, currentToken, h.source.workspaceId, async live => {
            job.scope = await freshScope(live); const actual = await buildWorkspaceOperationBatchPlan({ scope: job.scope, actions: job.plan.actions });
            assert(actual.version === 2 || actual.version === 3); job.plan = actual;
          });
          const hold = nativeRooms.holdNextUpdate(job.incomingId);
          peer.sendUpdate(nativeRooms.Y.encodeStateAsUpdate(peer.doc, nativeRooms.Y.encodeStateVector(peer.doc)));
          await waitForNativePathRoomCondition(() => hold.entered, 'Actual beforeSync activity was not entered.');
          let pending: { status: 'pending'; requestId: string };
          try {
            const actual = await run(kind, currentToken, h.source.workspaceId, async live => invoke(job, live, await create(job, live)));
            assert.equal(actual.status, 'pending'); assert('requestId' in actual && typeof actual.requestId === 'string');
            pending = { status: 'pending', requestId: actual.requestId };
            assert(job.batch && job.original); assert.equal((await row(intentTable(job), job.batch.batchId)).length, 0);
            assert.equal((await row(receiptTable(job), job.batch.batchId)).length, 0);
            const stored = await store.get(job.batch.batchId); assert(stored); assert.equal(stored.status, 'needs_recovery');
            assert.equal(stored.errorCode, 'COLLABORATION_FILE_LIFECYCLE_BUSY'); assert.equal(stored.leaseOwner, null);
            const target = (await h.admin.query(`SELECT status,active,release_id FROM collaboration_admission_targets
              WHERE request_id=$1 AND document_id=$2`, [pending.requestId, job.incomingId])).rows[0];
            assert(target); assert.equal(target.status, 'draining'); assert.equal(target.active, true); assert.equal(target.release_id, null);
            const key = BigInt.asUintN(64, BigInt(collaborationAdmissionLockKey(job.plan.workspaceId)));
            assert.equal((await h.admin.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND granted
              AND mode='ExclusiveLock' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
              AND classid::bigint=$1 AND objid::bigint=$2 AND objsubid=1`,
            [Number(key >> BigInt(32)), Number(key & BigInt('0xffffffff'))])).rows[0].n, 0, 'Pending retains no exclusive workspace session/TX fence.');
            let reacquired = false, lockFailure: unknown;
            const lockProbe = withWorkspaceMutationLock(job.plan.workspaceId, async () => { reacquired = true; }).catch(error => { lockFailure = error; });
            try { await waitForNativePathRoomCondition(() => reacquired || Boolean(lockFailure), 'Pending retained the workspace kernel flock.'); }
            finally { if (!reacquired) hold.release(); await lockProbe; }
            if (lockFailure) throw lockFailure;
          } finally { hold.release(); }
          const original = await immutableBatch(job), originalSession = job.original!.actorSessionId;
          const before = (await h.admin.query(`SELECT request_id,request_digest,intent_text FROM collaboration_admission_requests WHERE request_id=$1`, [pending.requestId])).rows;
          assert.equal(before.length, 1);
          await waitForNativePathRoomCondition(async () => {
            const target = (await h.admin.query('SELECT release_id,status FROM collaboration_admission_targets WHERE request_id=$1 AND document_id=$2', [pending.requestId, job.incomingId])).rows[0];
            return target?.status === 'released' && typeof target.release_id === 'string' && !nativeRooms.isLoaded(job.incomingId);
          }, 'Actual ticket-bound release did not finish after real activity was released.');
          const oldToken = await rotate(); assert.notEqual(currentSession, originalSession);
          await assert.rejects(run(kind, oldToken, h.source.workspaceId, async live => { await freshScope(live); }), rejected('invalid_token'));
          const result = await recover(job); assert.equal(result.status, 'applied'); await assertComplete(job);
          assert.deepEqual(await immutableBatch(job), original); assert.equal(job.original!.actorSessionId, originalSession);
          assert.deepEqual((await h.admin.query(`SELECT request_id,request_digest,intent_text FROM collaboration_admission_requests WHERE request_id=$1`, [pending.requestId])).rows, before);
          await captureNativePathAdmissionProof(job, pending.requestId, peer);
          const incoming = await load(h.connection, job.incomingId); assert(incoming);
          const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
          const { nativeCollaborationSearchText } = await import('../app/lib/collaboration/workspace-search-reader');
          assert(nativeCollaborationSearchText(authoritativeNativeCollaborationSnapshot(incoming).content).includes(marker));
          await run(kind, currentToken, h.source.workspaceId, async live => noMutation(async () => {
            const historical = await status(job, live); assert(historical); assert.equal(historical.batch.status, 'applied');
          }));
          nativeRooms.assertHealthy();
        }
      });
      await check('a real foreign admission reservation cannot be adopted or drained by the current MCP job', async () => {
        const { collaborationAdmissionActionDigest } = await import('../app/lib/collaboration/room-admission-contract');
        const { workspacePathFailureV1 } = await import('../app/lib/mcp/server/workspace-path-tool-contract');
        const job = await seed('delete'), peer = await openNativePathRoomPeer(nativeRooms, job.incomingId); await nativeRooms.flush();
        await run('delete', currentToken, h.source.workspaceId, async live => {
          job.scope = await freshScope(live); const actual = await buildWorkspaceOperationBatchPlan({ scope: job.scope, actions: job.plan.actions });
          assert(actual.version === 2); job.plan = actual;
        });
        assert(job.plan.planIdentityVersion === 2);
        assert(job.plan.sourceEvidence.evidenceVersion === 2);
        const actionPayloadText = JSON.stringify({ version: 1, fixtureForeignOperation: crypto.randomUUID() });
        const foreign = { requestId: crypto.randomUUID(), actorId: 'fixture-foreign-reservation', action: 'archive' as const,
          actionPayloadText, actionDigest: collaborationAdmissionActionDigest('archive', actionPayloadText),
          scopes: [{ workspaceId: h.source.workspaceId, organizationId: h.source.organizationId ?? null, path: '', kind: 'subtree' as const }],
          expectedDocuments: job.plan.sourceEvidence.nativeBindings.map(value => ({ ...value.expected, status: 'active' as const })) };
        const reserved = await nativeRooms.admission.reserve(foreign);
        const before = (await h.admin.query('SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM collaboration_admission_requests t WHERE request_id=$1', [foreign.requestId])).rows;
        const targets = (await h.admin.query('SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM collaboration_admission_targets t WHERE request_id=$1 ORDER BY document_id', [foreign.requestId])).rows;
        try {
          await assert.rejects(run('delete', currentToken, h.source.workspaceId, async live => invoke(job, live, await create(job, live))), error => {
            assert(!(error instanceof assert.AssertionError)); assert.equal(workspacePathFailureV1(error).body.code, 'PATH_BUSY'); return true;
          });
          assert(job.batch); assert.equal((await row(intentTable(job), job.batch.batchId)).length, 0); assert.equal((await row(receiptTable(job), job.batch.batchId)).length, 0);
          assert.deepEqual((await h.admin.query('SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM collaboration_admission_requests t WHERE request_id=$1', [foreign.requestId])).rows, before);
          assert.deepEqual((await h.admin.query('SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM collaboration_admission_targets t WHERE request_id=$1 ORDER BY document_id', [foreign.requestId])).rows, targets);
          assert.equal(peer.closeReason(), null); assert(nativeRooms.isLoaded(job.incomingId));
          assert.equal((await h.admin.query('SELECT status FROM collaboration_documents WHERE id=$1', [job.targetId])).rows[0].status, 'active');
        } finally { await nativeRooms.admission.cancel(foreign, reserved.revision); }
        // The foreign request remains terminal and immutable. The same actual
        // job may now reserve its OWN drain; no source/plan/key is replaced.
        const resumed = await recover(job);
        if (resumed.status === 'pending') {
          await waitForNativePathRoomCondition(async () => {
            const target = (await h.admin.query('SELECT release_id FROM collaboration_admission_targets WHERE request_id=$1 AND document_id=$2', [resumed.requestId, job.incomingId])).rows[0];
            return typeof target?.release_id === 'string' && !nativeRooms.isLoaded(job.incomingId);
          }, 'The genuine job did not drain after foreign cancellation.');
          assert.equal((await recover(job)).status, 'applied');
        } else assert.equal(resumed.status, 'applied');
        await assertComplete(job); nativeRooms.assertHealthy();
      });
      await check('current Delete permission revoked after durable room release denies effects; explicit recovery preserves Original and ticket', async () => {
        const job = await seed('delete'), peer = await openNativePathRoomPeer(nativeRooms, job.incomingId); await nativeRooms.flush();
        await run('delete', currentToken, h.source.workspaceId, async live => {
          job.scope = await freshScope(live); const actual = await buildWorkspaceOperationBatchPlan({ scope: job.scope, actions: job.plan.actions });
          assert(actual.version === 2); job.plan = actual;
        });
        const hold = nativeRooms.holdNextUpdate(job.incomingId); peer.sendUpdate(nativeRooms.Y.encodeStateAsUpdate(peer.doc, nativeRooms.Y.encodeStateVector(peer.doc)));
        await waitForNativePathRoomCondition(() => hold.entered, 'Actual permission-race activity was not entered.');
        let requestId: string;
        try {
          const pending = await run('delete', currentToken, h.source.workspaceId, async live => invoke(job, live, await create(job, live)));
          assert.equal(pending.status, 'pending'); assert('requestId' in pending); requestId = pending.requestId;
        } finally { hold.release(); }
        await waitForNativePathRoomCondition(async () => {
          const target = (await h.admin.query('SELECT release_id FROM collaboration_admission_targets WHERE request_id=$1 AND document_id=$2', [requestId, job.incomingId])).rows[0];
          return typeof target?.release_id === 'string' && !nativeRooms.isLoaded(job.incomingId);
        }, 'The permission-race room never durably released.');
        const original = await immutableBatch(job), retained = (await h.admin.query('SELECT request_id,request_digest,intent_text FROM collaboration_admission_requests WHERE request_id=$1', [requestId])).rows;
        assert(job.batch); assert.equal((await row(intentTable(job), job.batch.batchId)).length, 0);
        try {
          assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=0 WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1);
          const before = await snapshot(), files = await filesystem();
          await assert.rejects(recover(job), rejected('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
          assert.deepEqual(await snapshot(), before); assert.deepEqual(await filesystem(), files);
          assert.deepEqual(await immutableBatch(job), original); assert.equal((await row(receiptTable(job), job.batch.batchId)).length, 0);
          assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_trash_entries WHERE workspace_id=$1 AND original_path=$2', [h.source.workspaceId, job.sourcePath])).rows[0].n, 0);
        } finally { await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'`); }
        assert.equal((await recover(job)).status, 'applied'); await assertComplete(job); assert.deepEqual(await immutableBatch(job), original);
        assert.deepEqual((await h.admin.query('SELECT request_id,request_digest,intent_text FROM collaboration_admission_requests WHERE request_id=$1', [requestId])).rows, retained);
        await captureNativePathAdmissionProof(job, requestId, peer); nativeRooms.assertHealthy();
      });
      await check('an accepted live peer change after the bound plan is a precise plan conflict, never a new preview or adopted edit', async () => {
        const { workspacePathFailureV1 } = await import('../app/lib/mcp/server/workspace-path-tool-contract');
        const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
        const { nativeCollaborationSearchText } = await import('../app/lib/collaboration/workspace-search-reader');
        const job = await seed('delete'), peer = await openNativePathRoomPeer(nativeRooms, job.incomingId); await nativeRooms.flush();
        await run('delete', currentToken, h.source.workspaceId, async live => {
          job.scope = await freshScope(live); const actual = await buildWorkspaceOperationBatchPlan({ scope: job.scope, actions: job.plan.actions });
          assert(actual.version === 2); job.plan = actual; await create(job, live);
        });
        const original = await immutableBatch(job), marker = `accepted-after-plan-${crypto.randomUUID()}`;
        await sendNativePathRoomParagraph(nativeRooms, peer, marker);
        await assert.rejects(async () => {
          const first = await run('delete', currentToken, h.source.workspaceId, live => invoke(job, live, job.batch!));
          assert.equal(first.status, 'pending', 'A changed plan must never produce an applied effect.'); assert('requestId' in first);
          await waitForNativePathRoomCondition(async () => {
            const target = (await h.admin.query('SELECT release_id FROM collaboration_admission_targets WHERE request_id=$1 AND document_id=$2', [first.requestId, job.incomingId])).rows[0];
            return typeof target?.release_id === 'string' && !nativeRooms.isLoaded(job.incomingId);
          }, 'The stale-plan room did not retain its actual peer bytes in a durable release.');
          await observeNativePathTerminalNotifications(job, { mode: 'committed', requestId: first.requestId }, () => recover(job));
        }, error => {
          assert(!(error instanceof assert.AssertionError)); assert.equal(workspacePathFailureV1(error).body.code, 'PATH_PLAN_CHANGED'); return true;
        });
        assert(job.batch); assert.equal((await row(intentTable(job), job.batch.batchId)).length, 0); assert.equal((await row(receiptTable(job), job.batch.batchId)).length, 0);
        await assert.rejects(observeNativePathTerminalNotifications(job, { mode: 'none' }, () => recover(job)), error => {
          assert(!(error instanceof assert.AssertionError)); assert.equal(workspacePathFailureV1(error).body.code, 'PATH_PLAN_CHANGED'); return true;
        });
        assert.deepEqual(await immutableBatch(job), original);
        assert.equal((await h.admin.query('SELECT status,path FROM collaboration_documents WHERE id=$1', [job.targetId])).rows[0].status, 'active');
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_trash_entries WHERE workspace_id=$1 AND original_path=$2', [h.source.workspaceId, job.sourcePath])).rows[0].n, 0);
        const retained = await load(h.connection, job.incomingId); assert(retained);
        assert(nativeCollaborationSearchText(authoritativeNativeCollaborationSnapshot(retained).content).includes(marker));
        const inventory = links(retained); assert(inventory.links.some(link => link.targetPathText === job.sourcePath));
        await absent(path.join(h.source.rootPath, job.sourcePath)); nativeRooms.assertHealthy();
      });
      // Reuse the same owned server, current cookie session, actual Web handler
      // and ordinary queued worker. Neither a substituted plan nor an MCP
      // principal grants the two Web requests their execution authority.
      const { POST: renameWeb } = await import('../app/api/files/rename/route');
      const { GET: readWebBatch } = await import('../app/api/files/operations/batches/[batchId]/route');
      const { inspectNativeDocument, authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
      const { nativeCollaborationSearchText } = await import('../app/lib/collaboration/workspace-search-reader');
      type WebRenameResult = { status: number; body: WorkspacePathOperationResponse & {
        success: boolean; code?: string; dryRun?: boolean; plan?: { planId: string } } };
      const renameWithActualCookie = async (body: Record<string, unknown>): Promise<WebRenameResult> => {
        const actual = await h.request(h.source, 'member', true, currentRequestToken);
        assert(actual.headers.has('cookie')); assert.equal(actual.headers.has('authorization'), false);
        const headers = new Headers(actual.headers); headers.set('Content-Type', 'application/json');
        const response = await renameWeb(new NextRequest('http://localhost/api/files/rename', {
          method: 'POST', headers, body: JSON.stringify(body),
        }));
        const text = await response.text(); assert(Buffer.byteLength(text) <= 1024 * 1024);
        return { status: response.status, body: JSON.parse(text) as WebRenameResult['body'] };
      };
      const readPendingWebRename = async (initial: WebRenameResult, timeoutMs = 10_000): Promise<WebRenameResult> => {
        if (initial.status !== 202) return initial;
        assert.equal(initial.body.success, true);
        const original = initial.body.operation; assert(original);
        assert.match(original.batchId, /^[a-f0-9]{64}$/u); assert.match(original.planId, /^[a-f0-9]{64}$/u);
        assert.equal(original.workspaceId, h.source.workspaceId);
        assert(['queued', 'applying'].includes(original.status));
        assert.equal(initial.body.mutation, undefined); assert.equal(initial.body.linkStatus, undefined);
        let current = initial;
        await waitForNativePathRoomCondition(async () => {
          const actual = await h.request(h.source, 'member', true, currentRequestToken);
          assert(actual.headers.has('cookie')); assert.equal(actual.headers.has('authorization'), false);
          const response = await readWebBatch(new NextRequest(`http://localhost/api/files/operations/batches/${original.batchId}`,
            { headers: actual.headers }), { params: Promise.resolve({ batchId: original.batchId }) });
          assert.equal(response.status, 200);
          const text = await response.text(); assert(Buffer.byteLength(text) <= 1024 * 1024);
          const body = JSON.parse(text) as WebRenameResult['body'];
          assert.equal(body.success, true); assert(body.operation);
          assert.equal(body.operation.batchId, original.batchId); assert.equal(body.operation.planId, original.planId);
          assert.equal(body.operation.workspaceId, original.workspaceId); assert.equal(body.operation.kind, original.kind);
          assert.deepEqual(body.operation.selections, original.selections);
          assert(['queued', 'applying', 'applied', 'blocked', 'needs_review', 'needs_recovery', 'failed', 'undone'].includes(body.operation.status));
          current = { status: response.status, body };
          const terminal = !['queued', 'applying'].includes(body.operation.status);
          if (!terminal) await new Promise(resolve => setTimeout(resolve, 500));
          return terminal;
        }, 'The real pending Web rename never reached a terminal status through its original authenticated batch route.', timeoutMs);
        return current;
      };
      await check('implicit Web rename retains a real accepted rich update through its pending final store and original Move', async () => {
        const job = await seed('move'), peer = await openNativePathRoomPeer(nativeRooms, job.targetId);
        assert(peer.identity.representation === 'tiptap_xml' || peer.identity.representation === 'tiptap_blocks');
        await nativeRooms.flush();
        const oldPersisted = await load(h.connection, job.targetId); assert(oldPersisted);
        const document = nativeRooms.actualDocument(job.targetId); assert(document);
        // This is Hocuspocus's actual save mutex. Peer frame processing still
        // runs normally; only scheduled/final stores wait for this real lock.
        const unlockSave = await document.saveMutex.acquire(); let saveReleased = false;
        const releaseSave = () => { if (!saveReleased) { saveReleased = true; unlockSave(); } };
        const request = { oldPath: job.sourcePath, newPath: job.destinationPath, idempotencyKey: crypto.randomUUID() };
        let pending: Promise<void> | undefined, pump: Promise<void> | undefined, finished = false;
        let requestFailure: unknown, workerFailure: unknown, result: WebRenameResult | undefined, initialResult: WebRenameResult | undefined, requestId: string | undefined;
        let batchLockAttempted = false, batchLockWaitObserved = false, batchLockFailure: unknown;
        let batchLockObserver: Promise<void> | undefined;
        let acceptedBinary: Buffer | undefined, acceptedVector: Buffer | undefined, acceptedContent: unknown;
        try {
          const acks = peer.updateAcks(), marker = `implicit-accepted-${crypto.randomUUID()}`;
          const acceptedProof = await sendNativePathRoomParagraph(nativeRooms, peer, marker);
          await waitForNativePathRoomCondition(() => peer.updateAcks().accepted === acks.accepted + 1,
            'The actual rich update never received a positive WebSocket SyncStatus ACK.');
          assert.equal(peer.updateAcks().rejected, acks.rejected);
          const accepted = inspectNativeDocument(document, peer.identity.representation);
          assert.equal(accepted.version.stateProof, acceptedProof);
          assert(nativeCollaborationSearchText(accepted.content).includes(marker));
          acceptedBinary = Buffer.from(nativeRooms.Y.encodeStateAsUpdate(document));
          acceptedVector = Buffer.from(nativeRooms.Y.encodeStateVector(document));
          acceptedContent = JSON.parse(JSON.stringify(accepted.content));
          const stillOld = await load(h.connection, job.targetId); assert(stillOld);
          assert.deepEqual(Buffer.from(stillOld.yjsState), Buffer.from(oldPersisted.yjsState));
          assert.equal(stillOld.documentSequence, oldPersisted.documentSequence);
          assert.notDeepEqual(acceptedBinary, Buffer.from(stillOld.yjsState), 'An accepted room edit must genuinely be absent from PG.');
          const worker = createWorkspaceOperationBatchWorker({ store });
          pending = h.withProbe(async event => {
            if (batchLockAttempted || !requestId || event.text !== 'SELECT pg_catalog.to_regclass($1)::oid::bigint AS table_oid'
              || event.values[0] !== `"${h.schema}".workspace_file_operation_batches`) return;
            const actual = (await event.raw('SELECT pg_backend_pid() AS pid,current_schema() AS schema')).rows[0];
            assert.equal(actual.schema, h.schema);
            batchLockAttempted = true;
            const blocker = await openDb();
            try {
              await blocker.run('BEGIN');
              const identity = await blocker.get('SELECT pg_backend_pid() AS pid,current_schema() AS schema') as { pid: number; schema: string };
              assert.equal(identity.schema, h.schema); assert.notEqual(identity.pid, actual.pid);
              await blocker.run(`LOCK TABLE "${h.schema}".workspace_file_operation_batches IN ROW EXCLUSIVE MODE`);
              // A real independent short table writer, compatible with other
              // worker polls. Release only after the actual insert owner waits.
              batchLockObserver = (async () => {
                try {
                  const deadline = Date.now() + 2000;
                  while (!finished && Date.now() < deadline) {
                    const observed = (await h.admin.query(`SELECT
                      EXISTS(SELECT 1 FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid=l.relation
                        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=$1
                        AND n.nspname=$3 AND c.relname='workspace_file_operation_batches'
                        AND l.mode='ShareRowExclusiveLock' AND NOT l.granted) AS waiting,
                      $2::integer=ANY(pg_catalog.pg_blocking_pids($1::integer)) AS blocked_by_fixture`,
                    [actual.pid, identity.pid, h.schema])).rows[0];
                    if (observed.waiting && observed.blocked_by_fixture) { batchLockWaitObserved = true; break; }
                    await new Promise(resolve => setTimeout(resolve, 1));
                  }
                } finally { try { await blocker.run('ROLLBACK'); } finally { await blocker.close(); } }
              })().catch(error => { batchLockFailure = error; });
            } catch (error) {
              try { await blocker.run('ROLLBACK'); } finally { await blocker.close(); }
              throw error;
            }
          }, async () => {
            const value = await renameWithActualCookie(request);
            if (value.body.operation) {
              assert.equal(value.body.operation.batchId, sha(JSON.stringify(['workspace-path-operation-id-v1',
                h.source.workspaceId, 'member', request.idempotencyKey])));
              assert.equal(value.body.operation.kind, 'rename');
              assert.deepEqual(value.body.operation.selections, [{ sourcePath: job.sourcePath, destinationPath: job.destinationPath }]);
            }
            initialResult = value; result = await readPendingWebRename(value);
          }).catch(error => { requestFailure = error; })
            .finally(() => { finished = true; });
          pump = (async () => {
            try { while (!finished) { await worker.tick(); if (!finished) await new Promise(resolve => setTimeout(resolve, 25)); } }
            catch (error) { workerFailure = error; }
          })();
          let targets: Record<string, unknown>[] = [];
          await waitForNativePathRoomCondition(async () => {
            if (workerFailure) throw workerFailure;
            targets = (await h.admin.query(`SELECT request_id,status,active,release_id,snapshot_text
              FROM collaboration_admission_targets WHERE document_id=$1 AND active ORDER BY request_id LIMIT 2`, [job.targetId])).rows;
            if (targets.length === 1 && targets[0].status === 'draining') return true;
            assert(!finished, `Web rename settled before a genuine room drain: ${result?.status}/${result?.body.code ?? 'unknown'}`);
            return false;
          }, 'Implicit Web rename never committed the real accepted-update drain request.');
          assert.equal(targets.length, 1); assert.equal(targets[0].status, 'draining');
          assert.equal(targets[0].active, true); assert.equal(targets[0].release_id, null);
          assert.equal(typeof targets[0].request_id, 'string'); requestId = targets[0].request_id as string;
          const reserved = JSON.parse(String(targets[0].snapshot_text));
          const { lineageId: _lineageId, ...roomIdentity } = peer.identity;
          assert.deepEqual(reserved.document, { ...roomIdentity, path: job.sourcePath, status: 'active' });
          assert.equal(reserved.ownerEpoch, Number(peer.ownerRow.room_owner_epoch));
          assert.equal(reserved.ownerToken, peer.ownerRow.room_owner_token);
          assert.equal(document.saveMutex.isLocked(), true); assert.equal(nativeRooms.actualDocument(job.targetId), document);
          const notStored = await load(h.connection, job.targetId); assert(notStored);
          assert.equal(notStored.path, job.sourcePath); assert.deepEqual(Buffer.from(notStored.yjsState), Buffer.from(oldPersisted.yjsState));
          await absent(path.join(h.source.rootPath, job.destinationPath));
          // The independently visible draining row proves the actual initial
          // reservation COMMIT. Release the real save lock here; waiting for
          // the close packet first needlessly consumes the owner's 10s budget.
          releaseSave();
          await waitForNativePathRoomCondition(() => peer.closeReason() === 'Collaboration document transition',
            'Implicit Web rename never closed the actual room for its committed drain.');
          await pending;
        } finally {
          releaseSave(); if (pending) await pending; finished = true; if (pump) await pump;
          if (batchLockObserver) await batchLockObserver;
        }
        if (requestFailure) throw requestFailure; if (workerFailure) throw workerFailure;
        if (batchLockFailure) throw batchLockFailure;
        assert(result && requestId && acceptedBinary && acceptedVector);
        const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value) ? value : null;
        console.log(JSON.stringify({ test: 'implicit-web-rename-accepted-update-result', initialStatus: initialResult?.status, status: result.status,
          success: result.body.success === true, code: safeCode(result.body.code),
          operationCode: safeCode(result.body.operation?.errorCode),
          operationStatus: ['queued', 'applying', 'applied', 'blocked', 'needs_review', 'needs_recovery', 'failed']
            .includes(result.body.operation?.status) ? result.body.operation.status : null }));
        assert.equal(result.status, 200, `Implicit rename lost an accepted update: ${result.body.code ?? result.body.operation?.errorCode ?? 'unknown'}`);
        assert(batchLockAttempted && batchLockWaitObserved, 'The actual batch insert must wait for the independently held short writer lock.');
        assert.equal(result.body.success, true); assert.equal(result.body.operation.status, 'applied');
        assert.equal(result.body.linkStatus, 'complete'); assert.equal(result.body.linkUpdates?.updatedLinks, 1);
        const batch = await store.get(result.body.operation.batchId); assert(batch);
        assert.equal(batch.authorization.mode, 'direct'); assert.equal(batch.status, 'applied'); assert.equal(batch.completedActions, batch.totalActions);
        assert.equal(batch.plan.version, 3);
        const registry = (await h.admin.query('SELECT id,lineage_id,path,status FROM collaboration_documents WHERE id=$1', [job.targetId])).rows;
        assert.deepEqual(registry, [{ id: job.targetId, lineage_id: job.lineageId, path: job.destinationPath, status: 'active' }]);
        assert.deepEqual((await h.admin.query('SELECT id,path,status FROM file_collaboration_lineages WHERE id=$1', [job.lineageId])).rows,
          [{ id: job.lineageId, path: job.destinationPath, status: 'active' }]);
        const movedState = await load(h.connection, job.targetId), incomingState = await load(h.connection, job.incomingId); assert(movedState && incomingState);
        assert.equal(movedState.lifecycleGeneration, job.generation); assert.equal(movedState.path, job.destinationPath);
        assert.deepEqual(Buffer.from(movedState.yjsState), acceptedBinary); assert.deepEqual(Buffer.from(movedState.stateVector), acceptedVector);
        assert.deepEqual(JSON.parse(JSON.stringify(authoritativeNativeCollaborationSnapshot(movedState).content)), acceptedContent);
        assert.equal(links(incomingState).links.filter(link => link.targetPathText === job.destinationPath).length, 1);
        assert.equal(links(incomingState).links.some(link => link.targetPathText === job.sourcePath), false);
        assert.equal((await row('workspace_file_operation_move_intents', batch.batchId)).length, 1);
        const completedRows = await row('workspace_file_operation_move_receipts', batch.batchId); assert.equal(completedRows.length, 1);
        const completion = JSON.parse(JSON.parse(completedRows[0].body).receipt_text); assert(completion.native);
        const mutationRows = (await h.admin.query(`SELECT document_id,mutation_id,receipt_digest FROM collaboration_native_file_operation_receipts
          WHERE operation_id=$1 ORDER BY document_id COLLATE "C"`, [completion.native.operationId])).rows;
        assert.deepEqual(mutationRows.map(value => value.document_id).sort(), [job.targetId, job.incomingId].sort());
        // The existing proof helper compares the real old-path ticket. Its
        // incomingPath field is comparison data, not an execution grant.
        await captureNativePathAdmissionProof({ ...job, incomingPath: job.sourcePath }, requestId, peer);
        assert.equal(nativeRooms.isLoaded(job.targetId), false);
        const retry = await renameWithActualCookie(request); assert.equal(retry.status, 200);
        assert.equal(retry.body.operation.batchId, batch.batchId);
        assert.deepEqual(await row('workspace_file_operation_move_receipts', batch.batchId), completedRows);
        assert.deepEqual((await h.admin.query(`SELECT document_id,mutation_id,receipt_digest FROM collaboration_native_file_operation_receipts
          WHERE operation_id=$1 ORDER BY document_id COLLATE "C"`, [completion.native.operationId])).rows, mutationRows);
        const retriedState = await load(h.connection, job.targetId), retriedIncoming = await load(h.connection, job.incomingId); assert(retriedState && retriedIncoming);
        assert.deepEqual(Buffer.from(retriedState.yjsState), Buffer.from(movedState.yjsState)); assert.equal(retriedState.documentSequence, movedState.documentSequence);
        assert.deepEqual(Buffer.from(retriedIncoming.yjsState), Buffer.from(incomingState.yjsState)); assert.equal(retriedIncoming.documentSequence, incomingState.documentSequence);
        nativeRooms.assertHealthy();
      });
      await check('explicit Web preview stays stale after a real accepted and persisted rich edit, without path or native effects', async () => {
        const job = await seed('move'), peer = await openNativePathRoomPeer(nativeRooms, job.targetId);
        assert(peer.identity.representation === 'tiptap_xml' || peer.identity.representation === 'tiptap_blocks'); await nativeRooms.flush();
        const request = { oldPath: job.sourcePath, newPath: job.destinationPath, idempotencyKey: crypto.randomUUID() };
        const preview = await renameWithActualCookie({ ...request, dryRun: true });
        assert.equal(preview.status, 200); assert.equal(preview.body.dryRun, true); assert(preview.body.plan);
        assert.match(preview.body.plan.planId, /^[a-f0-9]{64}$/u);
        const acks = peer.updateAcks(), marker = `explicit-stale-${crypto.randomUUID()}`;
        const acceptedProof = await sendNativePathRoomParagraph(nativeRooms, peer, marker);
        await waitForNativePathRoomCondition(() => peer.updateAcks().accepted === acks.accepted + 1,
          'The explicit-preview edit never received its actual positive SyncStatus ACK.');
        assert.equal(peer.updateAcks().rejected, acks.rejected); await nativeRooms.flush();
        const persisted = await load(h.connection, job.targetId); assert(persisted);
        assert.equal(authoritativeNativeCollaborationSnapshot(persisted).version.stateProof, acceptedProof);
        assert(nativeCollaborationSearchText(authoritativeNativeCollaborationSnapshot(persisted).content).includes(marker));
        await withSettledProjectionReadBoundary(async () => {
          const before = await snapshot(), files = await filesystem(), domainWrites: string[] = [];
          const result = await h.withProbe(async event => {
            if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE)\b/iu.test(event.text)
              && /\b(?:collaboration_[a-z_]+|file_collaboration_[a-z_]+|workspace_file_[a-z_]+|file_revisions|file_revision_contents|file_version_blobs|workspace_trash_entries)\b/iu.test(event.text)) domainWrites.push(event.text);
          }, () => renameWithActualCookie({ ...request, planId: preview.body.plan!.planId }));
          assert.equal(result.status, 409); assert.equal(result.body.code, 'PREVIEW_STALE');
          assert.deepEqual(domainWrites, []); assert.deepEqual(await snapshot(), before); assert.deepEqual(await filesystem(), files);
        });
        assert.equal(peer.closeReason(), null); assert.equal(nativeRooms.isLoaded(job.targetId), true);
        const unchanged = await load(h.connection, job.targetId); assert(unchanged);
        assert.equal(unchanged.path, job.sourcePath); assert.deepEqual(Buffer.from(unchanged.yjsState), Buffer.from(persisted.yjsState));
        await absent(path.join(h.source.rootPath, job.destinationPath)); peer.socket.close(); nativeRooms.assertHealthy();
      });
      // Exactly the three new original-A rejection pairs use this finite
      // witness. noMutation and all authorized/current/historical reads retain
      // their original positive observation and no-DML/no-notify contracts.
      const authRealmRows = async () => {
        const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'
          ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
        assert(tables.length > 15 && tables.length <= 512);
        for (const name of ['user','session','account','verification','jwks','oauth_client','oauth_access_token','oauth_refresh_token','oauth_consent']) {
          assert(tables.some(table => table.relname === name));
        }
        const rows: Record<string, Array<{ body: string; xmin: string }>> = {};
        for (const table of tables) {
          assert.equal(typeof table.relname, 'string'); const name = String(table.relname).replaceAll('"', '""');
          const values = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
            FROM "${name}" t ORDER BY to_jsonb(t)::text,xmin::text LIMIT 10001`)).rows;
          assert(values.length <= 10000); rows[table.relname] = values;
        }
        return { tables, rows };
      };
      const createOriginalAAuthRejectionWitness = async (input: {
        family: 'pending' | 'selection' | 'final-handoff'; originalSessionId: string; originalHeaders: Headers;
      }) => {
        // Capture each family's actual, already-expired DB row after rotate;
        // no fixture row, cookie, principal or terminal response is synthesized.
        const expired = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
          FROM "session" t WHERE id=$1`, [input.originalSessionId])).rows;
        assert.equal(expired.length, 1);
        const originalExpiredAuthRow = Object.freeze({ body: String(expired[0].body), xmin: String(expired[0].xmin) });
        const original = JSON.parse(originalExpiredAuthRow.body) as Record<string, unknown>;
        assert.equal(original.id, input.originalSessionId); assert.equal(original.user_id, 'member');
        assert.equal(typeof original.token, 'string'); assert(original.token);
        assert.equal(Number(original.expires_at), 1); assert(Number(original.expires_at) < Date.now());
        const cookie = input.originalHeaders.get('cookie'); assert(cookie);
        assert.equal(input.originalHeaders.has('authorization'), false);
        let authRejectionChecks = 0, originalExpiredSessionDeleted = false;
        return async <T extends { status: number; body: { success: boolean } }>(method: 'GET' | 'POST',
          operation: () => Promise<T>): Promise<T> => {
          let diagnosticPhase = 'credential', statements = 0, deletes = 0;
          let realmChangedTables: string[] = [];
          let lastStatementHash: string | null = null;
          try {
            assert.equal(method, authRejectionChecks === 0 ? 'GET' : 'POST'); assert(authRejectionChecks < 2);
            assert.equal(input.originalHeaders.get('cookie') === cookie, true, 'Original-A credential headers must remain exact.');
            diagnosticPhase = 'beforeSnapshots';
            const before = await snapshot(), files = await filesystem(), authBefore = await authRealmRows();
            const originalBefore = authBefore.rows.session.filter(value => JSON.parse(value.body).id === input.originalSessionId);
            assert(originalBefore.length <= 1);
            if (originalBefore.length === 1) {
              assert.equal(sha(JSON.stringify(originalBefore[0])), sha(JSON.stringify(originalExpiredAuthRow)), 'Original expired SID-A row/xmin must be exact.');
            } else assert(originalExpiredSessionDeleted, 'Only this family earlier observed cleanup can explain an absent SID-A.');
            diagnosticPhase = 'requestSql';
            const result = await h.withProbe(async event => {
              lastStatementHash = sha(event.text);
              assert(++statements <= 5000);
              assert.equal(/\bpg_notify\s*\(/iu.test(event.text), false, 'Rejected authentication must not notify.');
              const writes = /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[\s\S]*?\bSET\b|MERGE\s+INTO|TRUNCATE|CREATE|ALTER|DROP|COPY|CALL|DO|GRANT|REVOKE)\b/iu.test(event.text);
              if (!writes) {
                assert(/^\s*(?:SELECT|WITH|BEGIN|COMMIT|ROLLBACK)\b/iu.test(event.text), 'Only real auth reads/transaction control may accompany the one cleanup.');
                return;
              }
              assert.equal(event.text, 'delete from "session" where "session"."token" = $1', 'Only the source-pinned expired-session DELETE is permitted.');
              assert.equal(originalBefore.length, 1); assert.equal(originalExpiredSessionDeleted, false); assert.equal(deletes, 0);
              assert.equal(event.values.length === 1 && event.values[0] === original.token, true, 'Cleanup parameter must be this family actual original SID-A token.');
              assert.equal(event.result.command, 'DELETE'); assert.equal(event.result.rowCount, 1); deletes++;
            }, operation);
            diagnosticPhase = 'response';
            assert(statements > 0);
            assert.equal(result.status, 401); assert.equal(result.body.success, false);
            assert.equal(Object.hasOwn(result.body, 'preparation'), false); assert.equal(Object.hasOwn(result.body, 'operation'), false);
            assert.equal(Object.hasOwn(result.body, 'plan'), false);
            assert.equal(input.originalHeaders.get('cookie') === cookie, true);
            diagnosticPhase = 'domainSnapshot';
            assert.equal(sha(JSON.stringify(await snapshot())), sha(JSON.stringify(before)), 'Rejected SID-A must preserve every domain row/xmin.');
            diagnosticPhase = 'filesystemSnapshot';
            assert.deepEqual(await filesystem(), files);
            const expectedAuth: Awaited<ReturnType<typeof authRealmRows>> = { ...authBefore, rows: { ...authBefore.rows,
              session: deletes === 1 ? authBefore.rows.session.filter(value => JSON.parse(value.body).id !== input.originalSessionId) : authBefore.rows.session } };
            // Exact hashes prevent any token, account secret or raw auth row
            // from leaking through assertion diff output.
            diagnosticPhase = 'realmSnapshot';
            const actualAuth = await authRealmRows();
            realmChangedTables = [...new Set([...Object.keys(actualAuth.rows), ...Object.keys(expectedAuth.rows)])]
              .filter(name => sha(JSON.stringify(actualAuth.rows[name] ?? null)) !== sha(JSON.stringify(expectedAuth.rows[name] ?? null)))
              .slice(0, 16).map(name => /^[a-z_][a-z0-9_]{0,127}$/u.test(name) ? name : sha(name));
            assert.equal(sha(JSON.stringify(actualAuth)), sha(JSON.stringify(expectedAuth)),
              'All other persistent auth/realm rows and xmins must remain exact.');
            if (deletes === 1) originalExpiredSessionDeleted = true;
            authRejectionChecks++; if (method === 'POST') assert.equal(authRejectionChecks, 2);
            console.log(JSON.stringify({ test: 'implicit-original-a-auth-rejection', family: input.family, method,
              httpStatus: result.status, statements, expiredSessionDeletes: deletes, exactOriginalTokenParameter: deletes === 1,
              authTablesChecked: authBefore.tables.length, allOtherRowsAndXminsUnchanged: true, domainAndFilesystemUnchanged: true }));
            return result;
          } catch (error) {
            // Never serialize credentials, auth rows, assertion values or query parameters.
            try {
              console.error(JSON.stringify({ test: 'implicit-original-a-auth-rejection-failure', family: input.family,
                method, phase: diagnosticPhase, statements, expiredSessionDeletes: deletes, realmChangedTables,
                lastStatementHash, assertion: error instanceof assert.AssertionError }));
            } catch { /* Diagnostics must preserve the original failure. */ }
            throw error;
          }
        };
      };
      await check('actual Web pending preparation survives expired SID-A and genuine SID-B resume without rotating its original selection', async () => {
        const { GET: readPreparationWeb, POST: resumePreparationWeb } = await import('../app/api/files/operations/implicit-moves/[requestId]/route');
        const { decodeWorkspaceImplicitMoveSelectionRequest, getWorkspaceImplicitMoveRequestIdentity,
          getWorkspaceImplicitMoveSelectionDigest } = await import('../app/lib/files/workspace-implicit-move-selection');
        type Preparation = { version: 2; kind: 'implicit-move-preparation'; state: 'pending'; actorUserId:string;workspaceId: string;
          operationId: string; requestId: string; selectionDigest: string;action:'rename';
          selections:Array<{sourcePath:string;destinationPath:string}>;status:'reserved'|'draining'|'recovery_required';
          canResume:boolean;statusUrl: string; resumeUrl: string };
        type PreparationResult = { status: number; body: Partial<WorkspacePathOperationResponse> & {
          success: boolean; code?: string; preparation?: Preparation } };
        // Finish prior stores before the new family; no old case body or
        // assertion is changed, and no parallel application runtime is started.
        await nativeRooms.flush();
        const job = await seed('move'), peer = await openNativePathRoomPeer(nativeRooms, job.targetId);
        assert(peer.identity.representation === 'tiptap_xml' || peer.identity.representation === 'tiptap_blocks');
        await nativeRooms.flush();
        const sourceBefore = await load(h.connection, job.targetId), incomingBefore = await load(h.connection, job.incomingId);
        assert(sourceBefore && incomingBefore);
        const document = nativeRooms.actualDocument(job.targetId); assert(document);
        const unlockSave = await document.saveMutex.acquire(); let saveReleased = false;
        const releaseSave = () => { if (!saveReleased) { saveReleased = true; unlockSave(); } };
        const sessionA = currentSession, tokenA = currentRequestToken;
        const originalBrowserRequest = await h.request(h.source, 'member', true, tokenA);
        const authenticatedA = await auth.api.getSession({ headers: originalBrowserRequest.headers });
        assert.equal(authenticatedA?.session.id, sessionA); assert.equal(authenticatedA?.user.id, 'member');
        const operationId = crypto.randomUUID(), identity = getWorkspaceImplicitMoveRequestIdentity({
          workspaceId: h.source.workspaceId, userId: 'member', operationId });
        const requestBody = { oldPath: job.sourcePath, newPath: job.destinationPath, idempotencyKey: operationId };
        const expectedUrl = `/api/files/operations/implicit-moves/${identity.requestId}`;
        let selectionDigest:string|undefined;
        const assertBinding=(body:Partial<WorkspacePathOperationResponse>)=>{
          assert(body.operation); assert(selectionDigest);
          const operation=body.operation as typeof body.operation & {implicitBinding?:unknown;legacyImplicitReplay?:unknown;preparation?:unknown};
          assert.deepEqual(operation.implicitBinding,{version:1,kind:'implicit-move-binding',actorUserId:'member',
            workspaceId:h.source.workspaceId,operationId,requestId:identity.requestId,selectionDigest});
          assert.equal(operation.legacyImplicitReplay,undefined);assert.equal(operation.preparation,undefined);
          assert.equal(operation.batchId,identity.batchId);assert.equal(operation.workspaceId,h.source.workspaceId);
          assert.equal(operation.kind,'rename');assert.deepEqual(operation.selections,[{sourcePath:job.sourcePath,destinationPath:job.destinationPath}]);
        };
        const nativeIntentRows=async()=>{
          const rows=(await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
            FROM collaboration_native_file_operation_intents t ORDER BY operation_id LIMIT 1025`)).rows;
          assert(rows.length<1025);return rows;
        };
        const actualPreparationRequest = async (method: 'GET' | 'POST', originalHeaders?: Headers): Promise<PreparationResult> => {
          const actual = originalHeaders ? undefined : await h.request(h.source, 'member', true, currentRequestToken);
          const headers = new Headers(originalHeaders ?? actual!.headers);
          assert(headers.has('cookie')); assert.equal(headers.has('authorization'), false);
          const request = new NextRequest(`http://localhost${expectedUrl}`, { method, headers });
          const context = { params: Promise.resolve({ requestId: identity.requestId }) };
          const response = await (method === 'GET' ? readPreparationWeb : resumePreparationWeb)(request, context);
          if ([200,202].includes(response.status)) assert.equal(response.headers.get('Cache-Control'), 'no-store');
          const text = await response.text(); assert(Buffer.byteLength(text) <= 1024 * 1024);
          const body = JSON.parse(text) as PreparationResult['body'];
          console.log(JSON.stringify({ test: 'implicit-preparation-web-response', method,
            credential: originalHeaders ? 'original-a' : 'current', httpStatus: response.status, success: body.success,
            preparationState: body.preparation?.state ?? null, operationStatus: body.operation?.status ?? null }));
          return { status: response.status, body };
        };
        const immutableSelection = async () => (await h.admin.query(`SELECT request_id,request_digest,intent_text,created_at
          FROM collaboration_admission_requests WHERE request_id=$1`, [identity.requestId])).rows;
        // Pending-census acceptance uses this same genuine saved selection and
        // current Cookie principal. No permission DTO or executable grant is made.
        const { requireExistingSelectedRequestWorkspace } = await import('../app/lib/workspaces/request');
        const { createRuntimeFileVersionCenterDatabase } = await import('../app/lib/file-version-center/database');
        const { listWorkspaceImplicitMovePreparationNotificationFacts: listPreparationFacts } = await import('../app/lib/files/workspace-implicit-move-notification-source');
        const { workspacePathOperationNotificationSource } = await import('../app/lib/files/workspace-operation-notification-source');
        const censusDatabase = createRuntimeFileVersionCenterDatabase();
        const inboxRows = async () => {
          const rows = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
            FROM mobile_inbox_read_states t ORDER BY to_jsonb(t)::text,xmin::text LIMIT 10001`)).rows;
          assert(rows.length <= 10000); return rows;
        };
        const currentCensusScope = async (headers: Headers, expectedUser: 'member' | 'owner' = 'member',
          expectedWorkspace = h.source.workspaceId) => {
          const request = new NextRequest('http://localhost/api/notifications/summary', { headers: new Headers(headers) });
          assert(request.headers.has('cookie')); assert.equal(request.headers.has('authorization'), false);
          const current = await requireExistingSelectedRequestWorkspace(request, { permissions: ['canRead'] });
          if (current.response) assert.fail(`Actual pending-census scope denied: ${current.response.status}`);
          assert.equal(current.session.user.id, expectedUser); assert.equal(current.workspace.workspaceId, expectedWorkspace);
          assert(current.workspace.permissions.canRead && current.workspace.permissions.canWrite && current.workspace.permissions.canDelete);
          return { userId: current.session.user.id, workspace: current.workspace };
        };
        const actualCensus = async (headers: Headers, expectedUser: 'member' | 'owner' = 'member',
          expectedWorkspace = h.source.workspaceId) => {
          const input = await currentCensusScope(headers, expectedUser, expectedWorkspace);
          return censusDatabase.transaction(transaction => listPreparationFacts(transaction, input));
        };
        const originalFact = (facts: Awaited<ReturnType<typeof actualCensus>>) => {
          const matches = facts.filter(fact => fact.requestId === identity.requestId);
          assert.equal(matches.length, 1); return matches[0];
        };
        // Faults are actual, transaction-local PostgreSQL rows/catalog changes.
        // Their rollback never grants admission or alters the original request.
        const unavailableCensus = async (prepare: (database: Awaited<ReturnType<typeof openDb>>) => Promise<void>) => {
          const input = await currentCensusScope(originalBrowserRequest.headers);
          const before = await snapshot(), files = await filesystem(), inbox = await inboxRows();
          const database = await openDb(); let began = false, failure: Error | undefined;
          try {
            await database.run('BEGIN'); began = true;
            await prepare(database);
            const transaction = { query: async <Row>(sql: string, params?: unknown[]) => ({ rows: await database.all(sql, params) as Row[] }) };
            const rejection = await noMutation(async () => {
              try { await listPreparationFacts(transaction, input); return null; }
              catch (error) { return error; }
            });
            assert(rejection instanceof Error);
            assert.equal(rejection.message, 'Implicit file preparation notifications could not be verified.');
          } catch (error) {
            failure = error instanceof Error ? error : new Error('Pending census fixture failed.'); throw error;
          } finally {
            try { if (began) await database.run('ROLLBACK'); }
            catch (error) { failure = error instanceof Error ? error : new Error('Pending census rollback failed.'); throw error; }
            finally { await database.close(failure); }
          }
          assert.deepEqual(await snapshot(), before); assert.deepEqual(await filesystem(), files);
          assert.deepEqual(await inboxRows(), inbox);
        };
        let pump: Promise<void> | undefined, resumed: Promise<PreparationResult> | undefined, stopWorker = false, workerFailure: unknown;
        try {
          const marker = `pending-sid-b-${crypto.randomUUID()}`, acks = peer.updateAcks();
          const acceptedProof = await sendNativePathRoomParagraph(nativeRooms, peer, marker);
          await waitForNativePathRoomCondition(() => peer.updateAcks().accepted === acks.accepted + 1,
            'Pending/SID-B update never received its genuine positive SyncStatus ACK.');
          assert.equal(peer.updateAcks().rejected, acks.rejected);
          const acceptedBinary = Buffer.from(nativeRooms.Y.encodeStateAsUpdate(document));
          const acceptedVector = Buffer.from(nativeRooms.Y.encodeStateVector(document));
          const accepted = inspectNativeDocument(document, peer.identity.representation);
          assert.equal(accepted.version.stateProof, acceptedProof);
          assert(nativeCollaborationSearchText(accepted.content).includes(marker));
          const oldState = await load(h.connection, job.targetId); assert(oldState);
          assert.deepEqual(Buffer.from(oldState.yjsState), Buffer.from(sourceBefore.yjsState));
          assert.equal(oldState.documentSequence, sourceBefore.documentSequence);
          assert.notDeepEqual(acceptedBinary, Buffer.from(oldState.yjsState));

          const nativeIntentsBeforeTransfer=await nativeIntentRows();
          // Use the real default 20s HTTP preparation wait. The actual save
          // mutex remains held throughout; no test wait option is supplied.
          const started = performance.now();
          const initial = await renameWithActualCookie(requestBody), elapsed = performance.now() - started;
          assert(elapsed >= 19_000, `Initial pending response skipped the actual 20s budget (${Math.round(elapsed)}ms).`);
          assert.equal(initial.status, 202); const first = initial.body as unknown as PreparationResult['body'];
          assert.equal(first.success, true); assert.equal(Object.hasOwn(first, 'operation'), false);
          assert.equal(Object.hasOwn(first, 'plan'), false); assert(first.preparation);
          assert.deepEqual(Object.keys(first.preparation).sort(), ['version','kind','state','actorUserId','workspaceId','operationId',
            'requestId','selectionDigest','action','selections','status','canResume','statusUrl','resumeUrl'].sort());
          const pending = first.preparation;
          assert.deepEqual({...pending,status:undefined,canResume:undefined}, { version: 2, kind: 'implicit-move-preparation', state: 'pending', actorUserId:'member',workspaceId: h.source.workspaceId,
            operationId, requestId: identity.requestId, selectionDigest: pending.selectionDigest,action:'rename',
            selections:[{sourcePath:job.sourcePath,destinationPath:job.destinationPath}],status:undefined,canResume:undefined,
            statusUrl: expectedUrl, resumeUrl: expectedUrl });
          assert(['reserved','draining'].includes(pending.status));assert.equal(pending.canResume,true);
          selectionDigest=pending.selectionDigest;
          assert.match(pending.selectionDigest, /^[a-f0-9]{64}$/u);
          const originalSelection = await immutableSelection(); assert.equal(originalSelection.length, 1);
          const savedRequest = JSON.parse(originalSelection[0].intent_text);
          const selection = decodeWorkspaceImplicitMoveSelectionRequest(savedRequest);
          assert.equal(selection.origin.sessionId, sessionA); assert.equal(selection.batchId, identity.batchId);
          assert.equal(selection.origin.userId, 'member'); assert.equal(selection.operationId, operationId);
          assert.equal(getWorkspaceImplicitMoveSelectionDigest(selection), pending.selectionDigest);
          assert.deepEqual(selection.selections, [{ sourcePath: job.sourcePath, destinationPath: job.destinationPath }]);
          assert.equal(document.saveMutex.isLocked(), true); assert.equal(nativeRooms.actualDocument(job.targetId), document);
          const notDurable = await load(h.connection, job.targetId); assert(notDurable);
          assert.deepEqual(Buffer.from(notDurable.yjsState), Buffer.from(sourceBefore.yjsState));
          assert.deepEqual(Buffer.from((await load(h.connection, job.incomingId))!.yjsState), Buffer.from(incomingBefore.yjsState));
          await absent(path.join(h.source.rootPath, job.destinationPath));
          assert.equal(await store.get(identity.batchId), null);
          for (const table of ['workspace_file_operation_move_preparations','workspace_file_operation_move_intents','workspace_file_operation_move_receipts']) {
            assert.equal((await row(table, identity.batchId)).length, 0);
          }
          assert.deepEqual(await nativeIntentRows(),nativeIntentsBeforeTransfer,'Pending selection must not stage any native intent before final transfer.');
          const actualTarget = (await h.admin.query(`SELECT status,active,release_id FROM collaboration_admission_targets
            WHERE request_id=$1 AND document_id=$2`, [identity.requestId, job.targetId])).rows;
          assert.equal(actualTarget.length, 1); assert.equal(actualTarget[0].status, 'draining');
          assert.equal(actualTarget[0].active, true); assert.equal(actualTarget[0].release_id, null);

          // Existing observer proves no domain writes or filesystem changes.
          // It does not claim to intercept every possible filesystem read.
          const statusA = await noMutation(() => actualPreparationRequest('GET'), 'pending-current-a-get');
          assert.equal(statusA.status, 200); assert.equal(statusA.body.success, true);
          assert.deepEqual(statusA.body.preparation, pending); assert.equal(Object.hasOwn(statusA.body, 'operation'), false);
          assert.deepEqual(await immutableSelection(), originalSelection);

          const inboxBeforeCensus = await inboxRows();
          const factA = originalFact(await noMutation(() => actualCensus(originalBrowserRequest.headers)));
          assert.equal(factA.requestDigest, originalSelection[0].request_digest);
          assert.equal(factA.item.target.preparationRequestId, identity.requestId);
          assert.equal(factA.item.target.status, 'pending'); assert.equal(factA.item.target.operationKind, 'rename');
          assert.equal(factA.item.workspaceId, h.source.workspaceId); assert.equal(factA.item.detail, job.sourcePath);
          assert.equal(factA.item.unread, true);
          const sourceInputA = await currentCensusScope(originalBrowserRequest.headers);
          const sourceListA = await noMutation(() => workspacePathOperationNotificationSource.list(sourceInputA));
          assert.deepEqual(sourceListA.items.filter(item => item.id === factA.item.id), [factA.item]);
          assert.equal(new URL(factA.item.deepLink, 'http://localhost').searchParams.get('workspacePathPreparation'), identity.requestId);
          assert.deepEqual(originalFact(await noMutation(() => actualCensus(originalBrowserRequest.headers))), factA);
          assert.deepEqual(await inboxRows(), inboxBeforeCensus, 'Passive discovery must not mark a preparation read.');
          const ownerBrowser = await h.request(h.source, 'owner', true);
          const ownerFacts = await noMutation(() => actualCensus(ownerBrowser.headers, 'owner'));
          assert.equal(ownerFacts.some(fact => fact.requestId === identity.requestId), false, 'Another current actor cannot discover the original actor pending selection.');
          const destinationBrowser = await h.request(h.destination, 'member', true, currentRequestToken);
          const destinationFacts = await noMutation(() => actualCensus(destinationBrowser.headers, 'member', h.destination.workspaceId));
          assert.equal(destinationFacts.some(fact => fact.requestId === identity.requestId), false, 'A different permitted workspace cannot discover this pending selection.');
          assert.deepEqual(await inboxRows(), inboxBeforeCensus);
          const ownerReadInput = await currentCensusScope(ownerBrowser.headers, 'owner');
          const destinationReadInput = await currentCensusScope(destinationBrowser.headers, 'member', h.destination.workspaceId);
          for (const input of [ownerReadInput, destinationReadInput]) {
            assert.deepEqual(await noMutation(() => workspacePathOperationNotificationSource.markRead({ ...input, itemId: factA.item.id })),
              { updated: 0 }, 'Foreign actor/workspace cannot create read state for the original preparation.');
          }
          assert.deepEqual(await inboxRows(), inboxBeforeCensus);

          await unavailableCensus(async database => {
            assert.equal((await database.all('UPDATE collaboration_admission_requests SET request_digest=$2 WHERE request_id=$1 RETURNING request_id',
              [identity.requestId, 'f'.repeat(64)])).length, 1);
          });
          await unavailableCensus(async database => {
            // Even an owner that bypasses RLS must reject an unverified realm.
            await database.run('ALTER TABLE mobile_inbox_read_states ENABLE ROW LEVEL SECURITY');
          });
          await unavailableCensus(async database => {
            // Recognizable saved-header overflow is unavailable, never a partial
            // empty result. These rollback-only rows are NOT 201 authorized Moves.
            const requestIds = Array.from({ length: 201 }, () => crypto.randomUUID());
            assert.equal((await database.all(`INSERT INTO collaboration_admission_requests
              (request_id,request_digest,intent_text,status,revision,created_at,completed_at,outcome_text)
              SELECT extra.request_id,r.request_digest,r.intent_text,'reserved',1,r.created_at,NULL,NULL
              FROM unnest($2::text[]) extra(request_id) CROSS JOIN collaboration_admission_requests r
              WHERE r.request_id=$1 RETURNING request_id`, [identity.requestId, requestIds])).length, 201);
            assert.equal((await database.all(`INSERT INTO collaboration_admission_scopes
              (request_id,ordinal,workspace_id,organization_id,path,kind)
              SELECT extra.request_id,s.ordinal,s.workspace_id,s.organization_id,s.path,s.kind
              FROM unnest($2::text[]) extra(request_id) CROSS JOIN collaboration_admission_scopes s
              WHERE s.request_id=$1 RETURNING request_id`, [identity.requestId, requestIds])).length, 201);
          });
          assert.deepEqual(originalFact(await noMutation(() => actualCensus(originalBrowserRequest.headers))), factA,
            'Each rejected/rolled-back census fixture must leave the actual pending preparation discoverable.');
          assert.deepEqual(await immutableSelection(), originalSelection);

          const markInput = await currentCensusScope(originalBrowserRequest.headers);
          const beforeRead = await snapshot(), filesBeforeRead = await filesystem(), readWrites: string[] = [];
          const readResult = await h.withProbe(async event => {
            if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[\s\S]*?\bSET\b|MERGE\s+INTO|TRUNCATE|CREATE|ALTER|DROP)\b/iu.test(event.text)) {
              readWrites.push(event.text);
              assert(/^\s*INSERT\s+INTO\s+mobile_inbox_read_states\b/iu.test(event.text), 'markRead may write only inbox read state.');
            }
            assert.equal(/\bpg_notify\s*\(/iu.test(event.text), false);
          }, () => workspacePathOperationNotificationSource.markRead({ ...markInput, itemId: factA.item.id }));
          assert.deepEqual(readResult, { updated: 1 }); assert.equal(readWrites.length, 1);
          assert.deepEqual(await snapshot(), beforeRead); assert.deepEqual(await filesystem(), filesBeforeRead);
          assert.deepEqual(await immutableSelection(), originalSelection);
          const readState = (await h.admin.query(`SELECT user_id,workspace_id,item_key,read_at,dismissed_at
            FROM mobile_inbox_read_states WHERE user_id=$1 AND workspace_id=$2 AND item_key=$3`,
          ['member', h.source.workspaceId, factA.item.id])).rows;
          assert.deepEqual(readState, [{ user_id: 'member', workspace_id: h.source.workspaceId, item_key: factA.item.id,
            read_at: factA.createdAt, dismissed_at: null }]);
          const inboxAfterRead = await inboxRows(); assert.equal(inboxAfterRead.length, inboxBeforeCensus.length + 1);
          assert.deepEqual(inboxAfterRead.filter(value => JSON.parse(value.body).item_key !== factA.item.id), inboxBeforeCensus,
            'markRead must preserve all unrelated inbox rows and their xmins.');
          const readFact = originalFact(await noMutation(() => actualCensus(originalBrowserRequest.headers)));
          assert.deepEqual(readFact, { ...factA, item: { ...factA.item, unread: false } });
          const readSourceList = await noMutation(() => workspacePathOperationNotificationSource.list(sourceInputA));
          assert.deepEqual(readSourceList.items.filter(item => item.id === factA.item.id), [readFact.item]);
          assert.deepEqual(await inboxRows(), inboxAfterRead, 'Passive reread preserves durable read state and the pending Home entry.');

          // Existing renewal helper inserts a real SID-B/cookie credential and
          // expires A. Keep B current for the unchanged final revoked-session case.
          const oldMcpToken = await rotate(), sessionB = currentSession;
          assert.notEqual(sessionB, sessionA); assert.equal((await h.admin.query('SELECT expires_at FROM "session" WHERE id=$1', [sessionA])).rows[0].expires_at, 1);
          const originalARejected = await createOriginalAAuthRejectionWitness({ family: 'pending', originalSessionId: sessionA, originalHeaders: originalBrowserRequest.headers });
          const browserB = await h.request(h.source, 'member', true, currentRequestToken);
          const authenticatedB = await auth.api.getSession({ headers: browserB.headers });
          assert.equal(authenticatedB?.session.id, sessionB); assert.equal(authenticatedB?.user.id, 'member');
          assert.notEqual(browserB.headers.get('cookie'), originalBrowserRequest.headers.get('cookie'));
          await assert.rejects(run('move', oldMcpToken, h.source.workspaceId, async live => { await freshScope(live);
            assert.fail('Expired A must not enter a current MCP policy phase.'); }), rejected('invalid_token'));
          const revokedA = await originalARejected('GET', () => actualPreparationRequest('GET', originalBrowserRequest.headers));
          assert.equal(revokedA.status, 401); assert.equal(revokedA.body.success, false);
          const revokedResumeA=await originalARejected('POST', () => actualPreparationRequest('POST',originalBrowserRequest.headers));
          assert.equal(revokedResumeA.status,401);assert.equal(revokedResumeA.body.success,false);
          const statusB = await noMutation(() => actualPreparationRequest('GET'), 'pending-current-b-get');
          assert.equal(statusB.status, 200); assert.deepEqual(statusB.body.preparation, pending);
          assert.deepEqual(await immutableSelection(), originalSelection);
          const censusB = originalFact(await noMutation(() => actualCensus(browserB.headers)));
          assert.deepEqual(censusB, readFact, 'A genuine renewed SID rediscovers the same pending UUID and durable inbox read state.');
          assert.deepEqual(await inboxRows(), inboxAfterRead);

          assert.deepEqual(await nativeIntentRows(),nativeIntentsBeforeTransfer);
          assert.equal(await store.get(identity.batchId),null);
          for(const table of ['workspace_file_operation_move_preparations','workspace_file_operation_move_intents','workspace_file_operation_move_receipts'])
            assert.equal((await row(table,identity.batchId)).length,0);
          releaseSave();
          const { workspaceOperationFailureDiagnostics } = await import('../app/lib/files/workspace-operation-failure-diagnostics');
          const { workspaceOperationBatchErrorCode } = await import('../app/lib/files/workspace-operation-batch-failure');
          const worker = createWorkspaceOperationBatchWorker({ store, execute: async input => {
            try { return await executeWorkspaceOperationBatch(input); }
            catch (error) {
              console.error(JSON.stringify({ test: 'implicit-pending-worker-execution-error',
                diagnostic: workspaceOperationFailureDiagnostics(error) }));
              throw error;
            }
          } });
          pump = (async () => {
            try { while (!stopWorker) { await worker.tick(); if (!stopWorker) await new Promise(resolve => setTimeout(resolve, 25)); } }
            catch (error) { workerFailure = error; }
          })();
          resumed = actualPreparationRequest('POST'); const resumedResult = await resumed;
          assert([200,202].includes(resumedResult.status)); assert.equal(resumedResult.body.success, true);
          assertBinding(resumedResult.body);assert(resumedResult.body.operation); assert.equal(resumedResult.body.operation.batchId, identity.batchId);
          const resumedPlanId=resumedResult.body.operation.planId;assert.match(resumedPlanId,/^[a-f0-9]{64}$/u);
          assert.equal(Object.hasOwn(resumedResult.body, 'preparation'), false);
          try {
            if (workerFailure) throw workerFailure;
            const completed = await readPendingWebRename({ status: resumedResult.status,
              body: { ...resumedResult.body, operation: resumedResult.body.operation } }, 60_000);
            if (workerFailure) throw workerFailure;
            assert.equal(completed.status, 200); assert.equal(completed.body.success, true);
            assert(completed.body.operation);
            assert.equal(completed.body.operation.status, 'applied',
              `Actual SID-B worker failed: ${completed.body.operation.status}/${completed.body.operation.errorCode ?? 'none'}`);
          } catch (error) {
            // One failure-only journal read retains the actual terminal diagnosis.
            try {
              const batch = await store.get(identity.batchId);
              if (batch) console.error(JSON.stringify({
                test: 'implicit-pending-worker-terminal-state', status: batch.status, phase: batch.phase,
                code: batch.errorCode === null ? null : workspaceOperationBatchErrorCode({ code: batch.errorCode }),
                completedActions: batch.completedActions, totalActions: batch.totalActions,
              }));
            } catch { /* Preserve the original HTTP, worker or assertion failure. */ }
            throw error;
          }
          stopWorker = true; await pump; if (workerFailure) throw workerFailure;
          const applied = await withSettledProjectionReadBoundary(() => noMutation(() => actualPreparationRequest('GET'), 'pending-final-b-get'));
          assert.equal(applied.status, 200); assert.equal(applied.body.success, true);assertBinding(applied.body); assert(applied.body.operation);
          assert.equal(applied.body.operation.planId,resumedPlanId);assert.equal(applied.body.preparation,undefined);
          assert.equal(applied.body.operation.batchId, identity.batchId); assert.equal(applied.body.operation.status, 'applied');
          assert.equal(applied.body.linkStatus, 'complete'); assert.equal(applied.body.linkUpdates?.updatedLinks, 1);
          const completedCensus = await noMutation(() => actualCensus(browserB.headers));
          assert.equal(completedCensus.some(fact => fact.requestId === identity.requestId), false,
            'Only the real committed selection leaves pending discovery; marking read alone never removed it.');
          assert.deepEqual(await inboxRows(), inboxAfterRead);
          console.log(JSON.stringify({ test: 'implicit-pending-census-read-state', currentCookieScope: true, sameUuidAcrossSidB: true,
            passiveSelectOnly: true, foreignActorWorkspaceHidden: true, malformedRealmOverflowUnavailable: true, inboxOnlyMarkRead: true }));
          const batch = await store.get(identity.batchId); assert(batch); assert.equal(batch.status, 'applied');
          assert.equal(batch.completedActions, batch.totalActions); assert.equal(batch.authorization.mode, 'direct');
          assert(batch.authorization.mode === 'direct');
          assert.equal(batch.authorization.actorType, 'user'); assert.equal(batch.authorization.actorUserId, 'member');
          assert.equal(batch.authorization.actorId, 'member'); assert.equal(batch.authorization.actorSessionId, undefined);
          assert.equal(batch.authorization.requestHash, selection.requestHash); assert.equal(batch.plan.version, 3);
          const movedState = await load(h.connection, job.targetId), incomingState = await load(h.connection, job.incomingId); assert(movedState && incomingState);
          assert.equal(movedState.path, job.destinationPath); assert.equal(movedState.lifecycleGeneration, job.generation);
          assert.deepEqual(Buffer.from(movedState.yjsState), acceptedBinary); assert.deepEqual(Buffer.from(movedState.stateVector), acceptedVector);
          assert.equal(authoritativeNativeCollaborationSnapshot(movedState).version.stateProof, acceptedProof);
          assert(nativeCollaborationSearchText(authoritativeNativeCollaborationSnapshot(movedState).content).includes(marker));
          assert.equal(links(incomingState).links.filter(link => link.targetPathText === job.destinationPath).length, 1);
          assert.equal(links(incomingState).links.some(link => link.targetPathText === job.sourcePath), false);
          assert.deepEqual((await h.admin.query('SELECT id,lineage_id,path,status FROM collaboration_documents WHERE id=$1', [job.targetId])).rows,
            [{ id: job.targetId, lineage_id: job.lineageId, path: job.destinationPath, status: 'active' }]);
          assert.deepEqual((await h.admin.query('SELECT id,path,status FROM file_collaboration_lineages WHERE id=$1', [job.lineageId])).rows,
            [{ id: job.lineageId, path: job.destinationPath, status: 'active' }]);
          await absent(path.join(h.source.rootPath, job.sourcePath));
          await captureNativePathAdmissionProof({ ...job, incomingPath: job.sourcePath }, identity.requestId, peer);
          assert.equal(nativeRooms.isLoaded(job.targetId), false);
          assert.deepEqual(await immutableSelection(), originalSelection);
          assert.equal(decodeWorkspaceImplicitMoveSelectionRequest(JSON.parse((await immutableSelection())[0].intent_text)).origin.sessionId, sessionA);
          const header = (await h.admin.query('SELECT status,outcome_text FROM collaboration_admission_requests WHERE request_id=$1', [identity.requestId])).rows[0];
          assert.equal(header.status, 'committed'); const outcome = JSON.parse(header.outcome_text);
          assert.equal(outcome.version, 1); assert.equal(outcome.result.kind, 'implicitNativeMoveV1');
          assert.equal(outcome.result.batchId, identity.batchId); assert.equal(outcome.result.selectionDigest, pending.selectionDigest);
          assert.notEqual(outcome.result.finalRequestId, identity.requestId);
          const finalRequests = (await h.admin.query('SELECT request_id,request_digest,status FROM collaboration_admission_requests WHERE request_id=$1',
            [outcome.result.finalRequestId])).rows;
          assert.deepEqual(finalRequests, [{ request_id: outcome.result.finalRequestId, request_digest: outcome.result.finalRequestDigest, status: 'committed' }]);
          for (const table of ['workspace_file_operation_move_preparations','workspace_file_operation_move_intents','workspace_file_operation_move_receipts']) {
            assert.equal((await row(table, identity.batchId)).length, 1);
          }
          const all = (await h.admin.query('SELECT request_id,intent_text FROM collaboration_admission_requests ORDER BY request_id LIMIT 1025')).rows;
          assert(all.length < 1025);
          const sameSelection = all.filter(value => {
            const request = JSON.parse(value.intent_text); if (typeof request.actionPayloadText !== 'string') return false;
            const data = JSON.parse(request.actionPayloadText);
            return data?.kind === 'implicit-native-move-selection' && data.operationId === operationId;
          });
          assert.deepEqual(sameSelection.map(value => value.request_id), [identity.requestId]);
          // Both routes still succeed once the original source path is gone.
          // Existing full-domain/xmin/FS snapshots prove no duplicate writes.
          const retry = await withSettledProjectionReadBoundary(() => noMutation(() => actualPreparationRequest('POST')));
          assert.equal(retry.status, 200);assertBinding(retry.body); assert.equal(retry.body.operation?.batchId, identity.batchId);
          assert.equal(retry.body.operation?.status, 'applied'); assert.deepEqual(await immutableSelection(), originalSelection);
          const keyedHistory=await withSettledProjectionReadBoundary(()=>noMutation(()=>renameWithActualCookie(requestBody)));
          assert.equal(keyedHistory.status,200);assert.equal(keyedHistory.body.historical,true);assertBinding(keyedHistory.body);
          assert.equal(keyedHistory.body.operation.status,'applied');assert.equal(keyedHistory.body.operation.planId,resumedPlanId);
          assert.deepEqual(await immutableSelection(),originalSelection);
          console.log(JSON.stringify({ test: 'implicit-web-pending-sid-b', initialStatus: initial.status, statusRead: applied.status,
            initialWaitMs: Math.round(elapsed), renewedActualSession: sessionB !== sessionA, originalSelectionUnchanged: true,
            originalSourceAbsent: true, oneFinalBatch: true, linkUpdates: applied.body.linkUpdates?.updatedLinks }));
          nativeRooms.assertHealthy();
        } finally {
          releaseSave();try{if(resumed)await resumed;}finally{stopWorker=true;if(pump)await pump;}
        }
      });
      for (const faultPhase of ['selection', 'final-handoff'] as const) {
        await check(`actual Web ${faultPhase} COMMIT then lost ACK recovers the same selection and final Move exactly once`, async () => {
          const { GET: readPreparationWeb, POST: resumePreparationWeb } = await import('../app/api/files/operations/implicit-moves/[requestId]/route');
          const { decodeWorkspaceImplicitMoveSelectionRequest, getWorkspaceImplicitMoveRequestIdentity,
            getWorkspaceImplicitMoveSelectionDigest } = await import('../app/lib/files/workspace-implicit-move-selection');
          const { captureCollaborationAdmissionRequest } = await import('../app/lib/collaboration/room-admission-contract');
          const { workspaceOperationBatchErrorCode } = await import('../app/lib/files/workspace-operation-batch-failure');
          type FaultResult = { status: number; body: Partial<WorkspacePathOperationResponse> & {
            success: boolean; code?: string; preparation?: unknown } };
          await nativeRooms.flush();
          const job = await seed('move'), peer = await openNativePathRoomPeer(nativeRooms, job.targetId);
          assert(peer.identity.representation === 'tiptap_xml' || peer.identity.representation === 'tiptap_blocks');
          await nativeRooms.flush();
          const sourceBefore = await load(h.connection, job.targetId), incomingBefore = await load(h.connection, job.incomingId);
          assert(sourceBefore && incomingBefore);
          const incomingIdentityBefore = (await h.admin.query('SELECT id,lineage_id,path,status FROM collaboration_documents WHERE id=$1',
            [job.incomingId])).rows; assert.equal(incomingIdentityBefore.length, 1);
          const browser = await h.request(h.source, 'member', true, currentRequestToken);
          assert(browser.headers.has('cookie')); assert.equal(browser.headers.has('authorization'), false);
          const authenticated = await auth.api.getSession({ headers: browser.headers });
          assert.equal(authenticated?.session.id, currentSession); assert.equal(authenticated?.user.id, 'member');
          const originalSessionId = currentSession, operationId = crypto.randomUUID();
          const identity = getWorkspaceImplicitMoveRequestIdentity({ workspaceId: h.source.workspaceId, userId: 'member', operationId });
          const expectedUrl = `/api/files/operations/implicit-moves/${identity.requestId}`;
          const requestBody = { oldPath: job.sourcePath, newPath: job.destinationPath, idempotencyKey: operationId };
          const preparationRequest = async (method: 'GET' | 'POST',previousHeaders?:Headers): Promise<FaultResult> => {
            const actual = previousHeaders ? undefined : await h.request(h.source, 'member', true, currentRequestToken);
            const headers=new Headers(previousHeaders??actual!.headers);
            assert(headers.has('cookie')); assert.equal(headers.has('authorization'), false);
            const response = await (method === 'GET' ? readPreparationWeb : resumePreparationWeb)(
              new NextRequest(`http://localhost${expectedUrl}`, { method, headers }),
              { params: Promise.resolve({ requestId: identity.requestId }) });
            if ([200,202].includes(response.status)) assert.equal(response.headers.get('Cache-Control'), 'no-store');
            const text = await response.text(); assert(Buffer.byteLength(text) <= 1024 * 1024);
            return { status: response.status, body: JSON.parse(text) as FaultResult['body'] };
          };
          const document = nativeRooms.actualDocument(job.targetId); assert(document);
          const unlockSave = await document.saveMutex.acquire(); let released = false;
          const releaseSave = () => { if (!released) { released = true; unlockSave(); } };
          let workerFailure: unknown, pendingFailure: unknown, stopWorker = false, finished = false;
          let pump: Promise<void> | undefined, pending: Promise<void> | undefined, initial: FaultResult | undefined;
          let selected: MetadataSqlEvent['client'] | undefined, observed: CommitObservation | undefined, fired = false;
          let bootstrapInserts = 0, batchInserts = 0, p0Inserts = 0, bootstrapCompletions = 0, finalReservations = 0;
          let immutableSelection: Record<string, unknown>[] | undefined, planTextAtInsert: string | undefined;
          let committedFinalRequestId: string | undefined, committedFinalDigest: string | undefined;
          let selectionDigest: string | undefined, finalOutcomeResult: Record<string, string> | undefined;
          const fault = Object.assign(new Error('Lost acknowledgement after the exact successful implicit Move COMMIT.'),
            { code: faultPhase === 'selection' ? 'FIXTURE_IMPLICIT_SELECTION_ACK_LOST' : 'FIXTURE_IMPLICIT_FINAL_ACK_LOST' });
          const immutableReadSql = `SELECT request_id,request_digest,intent_text,created_at FROM collaboration_admission_requests WHERE request_id=$1`;
          const rootRowSql = `SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM collaboration_admission_requests t WHERE request_id=$1`;
          const assertBinding = (response: FaultResult) => {
            assert(response.body.operation);
            const operation=response.body.operation as typeof response.body.operation & {implicitBinding?:unknown;legacyImplicitReplay?:unknown;preparation?:unknown};
            const binding=operation.implicitBinding;
            assert.equal(operation.legacyImplicitReplay,undefined);assert.equal(operation.preparation,undefined);assert.equal(response.body.preparation,undefined);
            assert.equal(operation.batchId,identity.batchId);assert.equal(operation.workspaceId,h.source.workspaceId);assert.equal(operation.kind,'rename');
            assert.deepEqual(operation.selections,[{sourcePath:job.sourcePath,destinationPath:job.destinationPath}]);
            if(finalOutcomeResult?.planId)assert.equal(operation.planId,finalOutcomeResult.planId);
            assert.deepEqual(binding, { version: 1, kind: 'implicit-move-binding', actorUserId: 'member',
              workspaceId: h.source.workspaceId, operationId, requestId: identity.requestId, selectionDigest });
          };
          try {
            const marker = `implicit-${faultPhase}-ack-${crypto.randomUUID()}`, acks = peer.updateAcks();
            const acceptedProof = await sendNativePathRoomParagraph(nativeRooms, peer, marker);
            await waitForNativePathRoomCondition(() => peer.updateAcks().accepted === acks.accepted + 1,
              'ACK-fault fixture rich edit never received its real positive SyncStatus ACK.');
            assert.equal(peer.updateAcks().rejected, acks.rejected);
            const accepted = inspectNativeDocument(document, peer.identity.representation);
            assert.equal(accepted.version.stateProof, acceptedProof);
            assert(nativeCollaborationSearchText(accepted.content).includes(marker));
            const acceptedBinary = Buffer.from(nativeRooms.Y.encodeStateAsUpdate(document));
            const acceptedVector = Buffer.from(nativeRooms.Y.encodeStateVector(document));
            const stillOld = await load(h.connection, job.targetId); assert(stillOld);
            assert.deepEqual(Buffer.from(stillOld.yjsState), Buffer.from(sourceBefore.yjsState));
            assert.equal(stillOld.documentSequence, sourceBefore.documentSequence);
            assert.notDeepEqual(acceptedBinary, Buffer.from(stillOld.yjsState));

            const nativeIntentRows=async()=>{const rows=(await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
              FROM collaboration_native_file_operation_intents t ORDER BY operation_id LIMIT 1025`)).rows;assert(rows.length<1025);return rows;};
            const nativeIntentsBeforeTransfer=await nativeIntentRows();
            await h.withProbe(async event => {
              const inserting = /^\s*INSERT\s+INTO\b/iu.test(event.text);
              if (inserting && event.text.includes('collaboration_admission_requests') && event.values[0] === identity.requestId) {
                assert.equal(++bootstrapInserts, 1); assert.equal(event.result.command, 'INSERT'); assert.equal(event.result.rowCount, 1);
                const saved = JSON.parse(String(event.values[2]));
                const selection = decodeWorkspaceImplicitMoveSelectionRequest(saved);
                assert.equal(selection.operationId, operationId); assert.equal(selection.batchId, identity.batchId);
                assert.equal(selection.origin.userId, 'member'); assert.equal(selection.origin.sessionId, originalSessionId);
                assert.deepEqual(selection.selections, [{ sourcePath: job.sourcePath, destinationPath: job.destinationPath }]);
                selectionDigest = getWorkspaceImplicitMoveSelectionDigest(selection);
                immutableSelection = (await event.raw(immutableReadSql, [identity.requestId])).rows;
                assert.equal(immutableSelection.length, 1);
                assert.deepEqual((await h.admin.query(immutableReadSql, [identity.requestId])).rows, [],
                  'Independent admin cannot see the genuine uncommitted selection reservation.');
                if (faultPhase === 'selection') {
                  assert.equal(selected, undefined); selected = event.client;
                  const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                    pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
                  assert.equal(witness.schema, h.schema); assert.match(witness.xid, /^[1-9][0-9]{0,31}$/u);
                  observed = { before: (await event.raw(rootRowSql, [identity.requestId])).rows,
                    pid: Number(witness.pid), start: witness.start, xid: witness.xid };
                  assert.equal(observed.before.length, 1);
                }
              }
              if (inserting && event.text.includes('workspace_file_operation_batches') && event.values[0] === identity.batchId) {
                assert.equal(++batchInserts, 1); assert.equal(event.result.rowCount, 1);
                assert.equal(typeof event.values[3], 'string'); planTextAtInsert = event.values[3] as string;
              }
              if (inserting && event.text.includes('workspace_file_operation_move_preparations') && event.values[0] === identity.batchId) {
                assert.equal(++p0Inserts, 1); assert.equal(event.result.rowCount, 1);
              }
              const completingBootstrap = /^\s*UPDATE\s+collaboration_admission_requests\s+SET\s+status\s*=\s*'committed'/iu.test(event.text)
                && event.values[0] === identity.requestId;
              if (completingBootstrap) {
                assert.equal(++bootstrapCompletions, 1); assert.equal(event.result.rowCount, 1);
                const outcome = JSON.parse(String(event.values[2]));
                assert.equal(outcome.version, 1); assert.equal(outcome.requestId, identity.requestId);
                assert.equal(outcome.result.kind, 'implicitNativeMoveV1'); assert.equal(outcome.result.batchId, identity.batchId);
                assert.equal(outcome.result.selectionDigest, selectionDigest);
                finalOutcomeResult = outcome.result;
                committedFinalRequestId = outcome.result.finalRequestId; committedFinalDigest = outcome.result.finalRequestDigest;
                assert.match(committedFinalRequestId!, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
                assert.notEqual(committedFinalRequestId, identity.requestId);
                assert.match(committedFinalDigest!, /^[a-f0-9]{64}$/u);
                if (faultPhase === 'final-handoff') {
                  assert.equal(selected, undefined); selected = event.client;
                  const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                    pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
                  assert.equal(witness.schema, h.schema); assert.match(witness.xid, /^[1-9][0-9]{0,31}$/u);
                  observed = { before: (await event.raw(rootRowSql, [identity.requestId])).rows,
                    pid: Number(witness.pid), start: witness.start, xid: witness.xid };
                  assert.equal(observed.before.length, 1);
                  const independent = (await h.admin.query('SELECT status FROM collaboration_admission_requests WHERE request_id=$1', [identity.requestId])).rows;
                  assert.equal(independent.length, 1); assert.notEqual(independent[0].status, 'committed');
                  for (const table of ['workspace_file_operation_batches','workspace_file_operation_move_preparations']) {
                    assert.equal((await event.raw(`SELECT batch_id FROM ${table} WHERE batch_id=$1`, [identity.batchId])).rows.length, 1);
                    assert.equal((await row(table, identity.batchId)).length, 0,
                      'Batch and P0 stay invisible outside the actual final handoff B until its genuine COMMIT.');
                  }
                }
              }
              if (inserting && event.text.includes('collaboration_admission_requests')
                && committedFinalRequestId !== undefined && event.values[0] === committedFinalRequestId) {
                assert.equal(++finalReservations, 1); assert.equal(event.result.rowCount, 1);
              }
              if (!fired && event.client === selected && /^\s*COMMIT\s*$/iu.test(event.text)) {
                assert(observed && immutableSelection && selectionDigest); assert.equal(event.result.command, 'COMMIT');
                const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                  pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
                assert.equal(Number(witness.pid), observed.pid); assert.equal(witness.start, observed.start); assert.equal(witness.xid, null);
                assert.deepEqual((await h.admin.query(rootRowSql, [identity.requestId])).rows, observed.before,
                  'Independent admin sees the exact committed request body and original xmin before the ACK fault.');
                assert.deepEqual((await h.admin.query(immutableReadSql, [identity.requestId])).rows, immutableSelection);
                const root = JSON.parse(String(observed.before[0].body));
                if (faultPhase === 'selection') {
                  assert.equal(root.status, 'reserved'); assert.equal(root.outcome_text, null);
                  assert.equal(batchInserts, 0); assert.equal(p0Inserts, 0); assert.equal(bootstrapCompletions, 0);
                  assert.equal((await row('workspace_file_operation_batches', identity.batchId)).length, 0);
                  assert.deepEqual(await nativeIntentRows(),nativeIntentsBeforeTransfer,'Selection COMMIT cannot stage a native intent before final transfer.');
                  for(const table of ['workspace_file_operation_move_preparations','workspace_file_operation_move_intents','workspace_file_operation_move_receipts'])
                    assert.equal((await row(table,identity.batchId)).length,0);
                  const expected = captureCollaborationAdmissionRequest(JSON.parse(String(immutableSelection[0].intent_text)));
                  assert.equal((await h.admin.query('SELECT document_id FROM collaboration_admission_targets WHERE request_id=$1', [identity.requestId])).rowCount,
                    expected.request.expectedDocuments.length);
                  assert.equal((await h.admin.query('SELECT ordinal FROM collaboration_admission_scopes WHERE request_id=$1', [identity.requestId])).rowCount,
                    expected.request.scopes.length);
                } else {
                  assert.equal(root.status, 'committed'); assert(finalOutcomeResult && committedFinalRequestId && committedFinalDigest);
                  assert.deepEqual(JSON.parse(root.outcome_text).result, finalOutcomeResult);
                  assert.equal(batchInserts, 1); assert.equal(p0Inserts, 1); assert.equal(finalReservations, 1);
                  for (const table of ['workspace_file_operation_batches','workspace_file_operation_move_preparations']) {
                    const actual = (await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM ${table} t WHERE batch_id=$1`, [identity.batchId])).rows;
                    assert.equal(actual.length, 1); assert.deepEqual(await row(table, identity.batchId), actual,
                      'Independent admin confirms the same atomic final batch/P0 bodies and xmins.');
                  }
                  const native=(await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM collaboration_native_file_operation_intents t WHERE request_id=$1`,[committedFinalRequestId])).rows;
                  assert.equal(native.length,1);
                  assert.deepEqual((await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM collaboration_native_file_operation_intents t WHERE request_id=$1`,[committedFinalRequestId])).rows,native,
                    'Actual final transfer atomically commits its one genuine native intent alongside Batch/P0.');
                  const final = (await event.raw(rootRowSql, [committedFinalRequestId])).rows;
                  assert.equal(final.length, 1); assert.deepEqual((await h.admin.query(rootRowSql, [committedFinalRequestId])).rows, final);
                  const reserved = JSON.parse(final[0].body); assert.equal(reserved.status, 'reserved'); assert.equal(reserved.outcome_text, null);
                  const captured = captureCollaborationAdmissionRequest(JSON.parse(reserved.intent_text));
                  assert.equal(captured.request.requestId, committedFinalRequestId); assert.equal(captured.requestDigest, committedFinalDigest);
                  assert.equal((await h.admin.query('SELECT document_id FROM collaboration_admission_targets WHERE request_id=$1 AND active',
                    [committedFinalRequestId])).rowCount, captured.request.expectedDocuments.length);
                  assert.equal((await h.admin.query('SELECT document_id FROM collaboration_admission_targets WHERE request_id=$1 AND active',
                    [identity.requestId])).rowCount, 0);
                }
                // This throw happens only AFTER the real PostgreSQL COMMIT and
                // independent visibility proofs, on that exact original B.
                fired = true; throw fault;
              }
            }, async () => {
              const worker = createWorkspaceOperationBatchWorker({ store });
              // Do not let a different worker COMMIT masquerade as the fault
              // or race the independent immutable commit proof above. Once it
              // is injected, use the unchanged genuine ordinary worker.
              pump = (async () => {
                try { while (!stopWorker) { if (fired) await worker.tick(); if (!stopWorker) await new Promise(resolve => setTimeout(resolve, 25)); } }
                catch (error) { workerFailure = error; }
              })();
              pending = renameWithActualCookie(requestBody).then(value => { initial = value; }, error => { pendingFailure = error; })
                .finally(() => { finished = true; });
              await waitForNativePathRoomCondition(async () => {
                if (workerFailure) throw workerFailure; if (pendingFailure) throw pendingFailure;
                const target = (await h.admin.query('SELECT status,active,release_id FROM collaboration_admission_targets WHERE request_id=$1 AND document_id=$2',
                  [identity.requestId, job.targetId])).rows;
                if (target.length === 1 && target[0].status === 'draining') {
                  assert.equal(target[0].active, true); assert.equal(target[0].release_id, null); return true;
                }
                assert(!finished, `ACK-fault request ended before genuine drain: ${initial?.status}/${initial?.body.code ?? 'unknown'}`); return false;
              }, 'ACK-fault request never committed its actual selected room drain.');
              assert.equal(document.saveMutex.isLocked(), true); releaseSave(); await pending;
              if (pendingFailure) throw pendingFailure; assert(initial);
              assert(fired && observed && immutableSelection && selectionDigest);
              assert([200,202].includes(initial.status)); assert.equal(initial.body.success, true);
              let transferred = initial;
              if (initial.body.preparation !== undefined) {
                const preparation = initial.body.preparation as Record<string, unknown>;
                assert.equal(initial.status, 202); assert.deepEqual(Object.keys(preparation).sort(), ['version','kind','state','actorUserId',
                  'workspaceId','operationId','requestId','selectionDigest','action','selections','status','canResume','statusUrl','resumeUrl'].sort());
                assert.deepEqual({ ...preparation, status: undefined, canResume: undefined }, { version: 2, kind: 'implicit-move-preparation', state: 'pending',
                  actorUserId: 'member', workspaceId: h.source.workspaceId, operationId, requestId: identity.requestId, selectionDigest,
                  action: 'rename', selections: [{ sourcePath: job.sourcePath, destinationPath: job.destinationPath }],
                  status: undefined, canResume: undefined, statusUrl: expectedUrl, resumeUrl: expectedUrl });
                assert(['reserved','draining'].includes(String(preparation.status))); assert.equal(preparation.canResume, true);
                const resumed = await preparationRequest('POST'); assert([200,202].includes(resumed.status));
                assert.equal(resumed.body.success, true); assertBinding(resumed); transferred = resumed;
              } else assertBinding(initial);
              try {
                if (workerFailure) throw workerFailure;
                assert(transferred.body.operation);
                const completed = await readPendingWebRename({ status: transferred.status,
                  body: { ...transferred.body, operation: transferred.body.operation } }, 60_000);
                if (workerFailure) throw workerFailure;
                assert.equal(completed.status, 200); assert.equal(completed.body.success, true);
                assert(completed.body.operation);
                assert.equal(completed.body.operation.status, 'applied',
                  `ACK recovery failed: ${completed.body.operation.status}/${completed.body.operation.errorCode ?? 'none'}`);
              } catch (error) {
                try {
                  const batch = await store.get(identity.batchId);
                  if (batch) console.error(JSON.stringify({
                    test: 'implicit-ack-worker-terminal-state', faultPhase, status: batch.status, phase: batch.phase,
                    code: batch.errorCode === null ? null : workspaceOperationBatchErrorCode({ code: batch.errorCode }),
                    completedActions: batch.completedActions, totalActions: batch.totalActions,
                  }));
                } catch { /* Preserve the original HTTP, worker or assertion failure. */ }
                throw error;
              }
              stopWorker = true; await pump; if (workerFailure) throw workerFailure;
            });
            assert(fired && observed && immutableSelection && finalOutcomeResult && planTextAtInsert);
            assert.equal(bootstrapInserts, 1); assert.equal(batchInserts, 1); assert.equal(p0Inserts, 1);
            assert.equal(bootstrapCompletions, 1); assert.equal(finalReservations, 1);
            const original = await store.get(identity.batchId); assert(original && original.plan.version === 3);
            assert.equal(original.status, 'applied'); assert.equal(original.completedActions, original.totalActions);
            assert.deepEqual(original.plan, JSON.parse(planTextAtInsert)); assert.equal(original.plan.planId, finalOutcomeResult.planId);
            assert.equal((await h.admin.query('SELECT plan_json FROM workspace_file_operation_batches WHERE batch_id=$1',
              [identity.batchId])).rows[0].plan_json, planTextAtInsert);
            assert(original.authorization.mode === 'direct'); assert.equal(original.authorization.actorUserId, 'member');
            assert.equal(original.authorization.actorId, 'member'); assert.equal(original.authorization.actorType, 'user');
            assert.equal(original.authorization.actorSessionId, undefined);
            const saved = decodeWorkspaceImplicitMoveSelectionRequest(JSON.parse(String(immutableSelection[0].intent_text)));
            assert.equal(original.authorization.requestHash, saved.requestHash); assert.equal(saved.origin.sessionId, originalSessionId);
            const moved = await load(h.connection, job.targetId), incoming = await load(h.connection, job.incomingId); assert(moved && incoming);
            assert.equal(moved.path, job.destinationPath); assert.equal(moved.lifecycleGeneration, job.generation);
            assert.deepEqual(Buffer.from(moved.yjsState), acceptedBinary); assert.deepEqual(Buffer.from(moved.stateVector), acceptedVector);
            assert.equal(authoritativeNativeCollaborationSnapshot(moved).version.stateProof, acceptedProof);
            assert(nativeCollaborationSearchText(authoritativeNativeCollaborationSnapshot(moved).content).includes(marker));
            assert.equal(links(incoming).links.filter(link => link.targetPathText === job.destinationPath).length, 1);
            assert.equal(links(incoming).links.some(link => link.targetPathText === job.sourcePath), false);
            assert.deepEqual((await h.admin.query('SELECT id,lineage_id,path,status FROM collaboration_documents WHERE id=$1', [job.targetId])).rows,
              [{ id: job.targetId, lineage_id: job.lineageId, path: job.destinationPath, status: 'active' }]);
            assert.deepEqual((await h.admin.query('SELECT id,path,status FROM file_collaboration_lineages WHERE id=$1', [job.lineageId])).rows,
              [{ id: job.lineageId, path: job.destinationPath, status: 'active' }]);
            assert.deepEqual((await h.admin.query('SELECT id,lineage_id,path,status FROM collaboration_documents WHERE id=$1', [job.incomingId])).rows,
              incomingIdentityBefore);
            assert.deepEqual((await h.admin.query('SELECT title FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2',
              [h.source.workspaceId, job.destinationPath])).rows, [{ title: job.title }]);
            await absent(path.join(h.source.rootPath, job.sourcePath));
            await captureNativePathAdmissionProof({ ...job, incomingPath: job.sourcePath }, identity.requestId, peer);
            assert.equal(nativeRooms.isLoaded(job.targetId), false);
            assert.deepEqual((await h.admin.query(immutableReadSql, [identity.requestId])).rows, immutableSelection);
            const outcome = (await h.admin.query('SELECT status,outcome_text FROM collaboration_admission_requests WHERE request_id=$1', [identity.requestId])).rows[0];
            assert.equal(outcome.status, 'committed'); assert.deepEqual(JSON.parse(outcome.outcome_text).result, finalOutcomeResult);
            assert.deepEqual((await h.admin.query('SELECT request_id,request_digest,status FROM collaboration_admission_requests WHERE request_id=$1',
              [committedFinalRequestId])).rows, [{ request_id: committedFinalRequestId, request_digest: committedFinalDigest, status: 'committed' }]);
            for (const table of ['workspace_file_operation_batches','workspace_file_operation_move_preparations',
              'workspace_file_operation_move_intents','workspace_file_operation_move_receipts']) assert.equal((await row(table, identity.batchId)).length, 1);
            const receipts = (await h.admin.query(`SELECT count(*)::int AS n,count(DISTINCT mutation_id)::int AS distinct_n
              FROM collaboration_native_file_operation_receipts WHERE request_id=$1`, [committedFinalRequestId])).rows[0];
            assert(receipts.n > 0); assert.equal(receipts.n, receipts.distinct_n);
            const candidates = (await h.admin.query('SELECT request_id,intent_text FROM collaboration_admission_requests ORDER BY request_id LIMIT 1025')).rows;
            assert(candidates.length < 1025);
            const sameSelection = candidates.filter(value => {
              const request = JSON.parse(value.intent_text); if (typeof request.actionPayloadText !== 'string') return false;
              const valuePayload = JSON.parse(request.actionPayloadText);
              return valuePayload?.kind === 'implicit-native-move-selection' && valuePayload.operationId === operationId;
            });
            assert.deepEqual(sameSelection.map(value => value.request_id), [identity.requestId]);
            // Fresh actual cookie requests read the original result after the
            // source is gone. Existing noMutation proves unchanged domain/xmins
            // and FS state; it does not intercept every filesystem read.
            await nativeRooms.flush();
            const oldMcpToken=await rotate(),sessionB=currentSession;assert.notEqual(sessionB,originalSessionId);
            const originalARejected = await createOriginalAAuthRejectionWitness({ family: faultPhase, originalSessionId, originalHeaders: browser.headers });
            const browserB=await h.request(h.source,'member',true,currentRequestToken);
            const authenticatedB=await auth.api.getSession({headers:browserB.headers});
            assert.equal(authenticatedB?.session.id,sessionB);assert.equal(authenticatedB?.user.id,'member');
            assert.notEqual(browserB.headers.get('cookie'),browser.headers.get('cookie'));
            await assert.rejects(run('move',oldMcpToken,h.source.workspaceId,async live=>{await freshScope(live);}),rejected('invalid_token'));
            const expiredA=await withSettledProjectionReadBoundary(() => originalARejected('GET', () => preparationRequest('GET',browser.headers)));
            assert.equal(expiredA.status,401);assert.equal(expiredA.body.success,false);
            const expiredResumeA=await withSettledProjectionReadBoundary(() => originalARejected('POST', () => preparationRequest('POST',browser.headers)));
            assert.equal(expiredResumeA.status,401);assert.equal(expiredResumeA.body.success,false);
            const read = await withSettledProjectionReadBoundary(() => noMutation(() => preparationRequest('GET')));
            assert.equal(read.status, 200); assert.equal(read.body.success, true); assertBinding(read);
            assert.equal(read.body.operation?.status, 'applied'); assert.equal(read.body.linkStatus, 'complete');
            assert.equal(read.body.linkUpdates?.updatedLinks, 1);
            const resumed = await withSettledProjectionReadBoundary(() => noMutation(() => preparationRequest('POST')));
            assert.equal(resumed.status, 200); assert.equal(resumed.body.operation?.status, 'applied'); assertBinding(resumed);
            const retried = await withSettledProjectionReadBoundary(() => noMutation(() => renameWithActualCookie(requestBody)));
            assert.equal(retried.status, 200); assert.equal(retried.body.historical, true); assertBinding(retried);
            assert.equal(retried.body.operation?.batchId, identity.batchId); assert.equal(retried.body.operation?.status, 'applied');
            assert.deepEqual((await h.admin.query(immutableReadSql, [identity.requestId])).rows, immutableSelection);
            console.log(JSON.stringify({ test: 'implicit-web-actual-commit-ack-loss', phase: faultPhase, actualCommitProven: true,
              independentOriginalXminProven: true, actualCookieRecovery: true,renewedActualSession:sessionB!==originalSessionId, originalSelectionUnchanged: true,
              oneBootstrap: bootstrapInserts, oneBatch: batchInserts, oneP0: p0Inserts, oneFinalReservation: finalReservations,
              stableNativeIdentity: true, acceptedRichBytesRetained: true, originalSourceAbsent: true, updatedLinks: read.body.linkUpdates?.updatedLinks }));
            nativeRooms.assertHealthy();
          } finally {
            releaseSave();try{if(pending)await pending;}finally{stopWorker=true;if(pump)await pump;}
          }
        });
      }
    } catch (error) { nativeRoomFailure = error; throw error; }
    finally {
      try { await nativeRooms.close(); }
      catch (cleanup) { throw nativeRoomFailure === undefined ? cleanup
        : new AggregateError([nativeRoomFailure, cleanup], 'Live native path assertion and resource closure failed.'); }
    }
    // These two families observe the actual new Stage -> proof-group -> FS
    // boundary. Existing families above/below retain their bodies and oracles.
    type ProofGroupRows = Array<{body:string;xmin:string}>;
    const proofGroupRows = async (table:string, key:string, value:string):Promise<ProofGroupRows> => {
      assert(['workspace_file_operation_move_preparations','collaboration_native_file_operation_intents',
        'collaboration_native_file_operation_receipts','collaboration_admission_targets'].includes(table));
      assert(['batch_id','operation_id','request_id'].includes(key));
      return (await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${table}" t
        WHERE "${key}"=$1 ORDER BY to_jsonb(t)::text,xmin::text`,[value])).rows;
    };
    const readProofGroupOriginal = async (job:Job) => {
      assert(job.kind==='move' && job.batch);
      const p0=await proofGroupRows('workspace_file_operation_move_preparations','batch_id',job.batch.batchId);
      assert.equal(p0.length,1);
      const preparation=JSON.parse(p0[0].body) as {request_id:string;request_digest:string;preparation_text:string};
      const body=JSON.parse(preparation.preparation_text) as {requestId:string;nativeBundle:{operationId:string;requestId:string}};
      assert.equal(body.requestId,preparation.request_id); assert(body.nativeBundle);
      const headers=(await h.admin.query(`SELECT request_id,request_digest,intent_text FROM collaboration_admission_requests
        WHERE request_id=$1`,[preparation.request_id])).rows;
      assert.equal(headers.length,1);
      const {captureCollaborationAdmissionRequest}=await import('../app/lib/collaboration/room-admission-contract');
      const captured=captureCollaborationAdmissionRequest(JSON.parse(headers[0].intent_text));
      assert.equal(captured.intentText,headers[0].intent_text); assert.equal(captured.requestDigest,headers[0].request_digest);
      assert.equal(captured.request.requestId,body.requestId); assert.equal(captured.requestDigest,preparation.request_digest);
      assert(captured.request.expectedDocuments.some(document=>document.documentId===job.targetId));
      assert(captured.request.expectedDocuments.some(document=>document.documentId===job.incomingId));
      const native=await proofGroupRows('collaboration_native_file_operation_intents','operation_id',body.nativeBundle.operationId);
      assert.equal(native.length,1);
      const nativeRow=JSON.parse(native[0].body) as {operation_id:string;request_id:string;intent_text:string};
      assert.equal(nativeRow.operation_id,body.nativeBundle.operationId); assert.equal(nativeRow.request_id,body.nativeBundle.requestId);
      const nativeIntent=JSON.parse(nativeRow.intent_text) as {mutations:Array<{mutationId:string}>};
      const intent=await row(intentTable(job),job.batch.batchId); assert.equal(intent.length,1);
      return {p0,native,intent,header:headers[0] as {request_id:string;request_digest:string;intent_text:string},
        request:captured.request,operationId:nativeRow.operation_id,
        mutationIds:nativeIntent.mutations.map(mutation=>mutation.mutationId).sort()};
    };
    type ProofGroupOriginal=Awaited<ReturnType<typeof readProofGroupOriginal>>;
    type ProofGroupWitness={client:MetadataSqlEvent['client'];pid:number;start:string;xid:string};
    type ProofGroupObservation={protocol?:ProofGroupOriginal;owner?:ProofGroupWitness;stageWitness?:ProofGroupWitness;stageCommitted:boolean;
      files?:Awaited<ReturnType<typeof filesystem>>;targetsAtCommit?:ProofGroupRows;
      commits:Array<{pid:number;start:string;xid:string;documentIds:string[]}>;
      groups:string[][];physicalObserved:boolean;lostAcknowledgement:boolean};
    const observeActualMoveProofGroups = async <T>(job:Job,observed:ProofGroupObservation,loseFirstGroupCommit:boolean,operation:()=>Promise<T>):Promise<T> => {
      assert(job.kind==='move' && job.batch);
      const {collaborationAdmissionLockKey}=await import('../app/lib/collaboration/room-admission-contract');
      const {lockIdentity}=await import('../app/lib/collaboration/room-owner');
      const workspaceSessionKey=collaborationAdmissionLockKey(job.plan.workspaceId);
      const workspaceKey=BigInt.asUintN(64,BigInt(workspaceSessionKey));
      const sessionGuards=new Map<MetadataSqlEvent['client'],{pid:number;start:string;rooms:Set<string>}>();
      const exactSessionGuards=(client:MetadataSqlEvent['client'],protocol:ProofGroupOriginal) => {
        const actual=sessionGuards.get(client);
        const expected=new Set(protocol.request.expectedDocuments.map(document=>lockIdentity(document.documentId).key));
        return actual && actual.rooms.size===expected.size && [...expected].every(key=>actual.rooms.has(key)) ? actual : undefined;
      };
      let stage: {client:MetadataSqlEvent['client'];witness:ProofGroupWitness;rows:Awaited<ReturnType<typeof row>>}|undefined;
      let group:{witness:ProofGroupWitness;ids:string[]}|undefined;
      const witness=async(event:MetadataSqlEvent,requireGuards:boolean):Promise<ProofGroupWitness|undefined> => {
        const protocol=observed.protocol;
        const session=protocol && requireGuards ? exactSessionGuards(event.client,protocol) : sessionGuards.get(event.client);
        if(!session || requireGuards && !protocol) return undefined;
        const guards=protocol?.request.expectedDocuments.map(document=>BigInt.asUintN(64,BigInt(lockIdentity(document.documentId).key)).toString()) ?? [];
        const actual=(await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM a.backend_start)::text AS start,
          pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema,
          EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory' AND l.granted
            AND l.mode='ExclusiveLock' AND l.objsubid=1 AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND l.classid::bigint=$1 AND l.objid::bigint=$2) AS workspace_held,
          (SELECT count(*)::int FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory' AND l.granted
            AND l.mode='ExclusiveLock' AND l.objsubid=1 AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND (l.classid::bigint::numeric*4294967296+l.objid::bigint::numeric)=ANY($3::numeric[])) AS rooms
          FROM pg_stat_activity a WHERE pid=pg_backend_pid()`,
        [Number(workspaceKey>>BigInt(32)),Number(workspaceKey&BigInt('0xffffffff')),guards])).rows[0];
        assert.equal(actual.schema,h.schema);
        assert.equal(Number(actual.pid),session.pid); assert.equal(actual.start,session.start);
        if(actual.workspace_held!==true || requireGuards && (!protocol || actual.rooms!==guards.length)) return undefined;
        if(actual.xid===null) return undefined;
        assert(/^[0-9]+$/u.test(actual.xid)); assert.equal(typeof actual.start,'string');
        return {client:event.client,pid:Number(actual.pid),start:actual.start,xid:actual.xid};
      };
      return h.withProbe(async event=>{
        // Only successful session locks qualify. Prelude's pg_*_advisory_xact_lock
        // events can never install this observed owner identity.
        if(/^\s*SELECT\s+pg_advisory_lock\(\$1::bigint\),\s*true\s+AS\s+locked\s*$/iu.test(event.text)
          && event.values[0]===workspaceSessionKey && event.result.rows[0]?.locked===true) {
          const actual=(await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
            current_schema() AS schema FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
          assert.equal(actual.schema,h.schema); assert.equal(typeof actual.start,'string');
          sessionGuards.set(event.client,{pid:Number(actual.pid),start:actual.start,rooms:new Set()});
        }
        if(/^\s*SELECT\s+pg_try_advisory_lock\(\$1::bigint\)\s+AS\s+locked\s*$/iu.test(event.text)) {
          const session=sessionGuards.get(event.client);
          if(session) {
            assert.equal(event.result.rows[0]?.locked,true); assert.equal(typeof event.values[0],'string');
            const key=event.values[0] as string; assert(/^-?[0-9]+$/u.test(key));
            session.rooms.add(key); assert(session.rooms.size<=1024);
          }
        }
        if(/\bpg_advisory_unlock(?:_all)?\s*\(/iu.test(event.text)) sessionGuards.delete(event.client);
        if(/^\s*INSERT\s+INTO\b/iu.test(event.text) && event.text.includes('workspace_file_operation_move_intents')
          && event.values[0]===job.batch!.batchId && event.result.rowCount===1) {
          assert.equal(stage,undefined); assert.equal(observed.protocol,undefined);
          const actual=await witness(event,false); assert(actual);
          const own=(await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
            FROM workspace_file_operation_move_intents t WHERE batch_id=$1`,[job.batch!.batchId])).rows;
          assert.equal(own.length,1); assert.equal((await row(intentTable(job),job.batch!.batchId)).length,0);
          stage={client:event.client,witness:actual,rows:own};
        }
        if(/^\s*COMMIT\s*$/iu.test(event.text) && stage?.client===event.client && !observed.stageCommitted) {
          assert.equal(event.result.command,'COMMIT');
          const actual=(await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
            pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
          assert.equal(Number(actual.pid),stage.witness.pid); assert.equal(actual.start,stage.witness.start); assert.equal(actual.xid,null);
          assert.deepEqual(await row(intentTable(job),job.batch!.batchId),stage.rows);
          observed.protocol=await readProofGroupOriginal(job); observed.stageCommitted=true; observed.stageWitness=stage.witness;
          observed.files=await filesystem(); // Exact baseline while the outer owner still holds its genuine fences.
          const held=exactSessionGuards(event.client,observed.protocol); assert(held);
          assert.equal(held.pid,stage.witness.pid); assert.equal(held.start,stage.witness.start);
          observed.owner=stage.witness; // Fresh execution stays on its independently confirmed actual Stage B.
          return;
        }
        const protocol=observed.protocol;
        if(!protocol || !observed.stageCommitted || observed.physicalObserved) return;
        assert(observed.files);
        if(!observed.owner && /^\s*SELECT\b/iu.test(event.text) && event.text.includes('workspace_file_operation_move_intents')
          && /\bFOR\s+SHARE\s+NOWAIT\s*$/iu.test(event.text) && event.values[0]===job.batch!.batchId && event.result.rowCount===1) {
          const actual=await witness(event,true); if(actual) observed.owner=actual;
        }
        const actualOwner=observed.owner; if(!actualOwner || event.client!==actualOwner.client) return;
        if(/^\s*SELECT\s+\*\s+FROM\s+collaboration_admission_requests\s+WHERE\s+request_id\s*=\s*\$1\s+FOR\s+UPDATE\s*$/iu.test(event.text)
          && event.values[0]===protocol.request.requestId) {
          if(!group) { const actual=await witness(event,true); assert(actual); assert.equal(actual.pid,actualOwner.pid);
            assert.equal(actual.start,actualOwner.start);
            if(observed.stageWitness) assert.notEqual(actual.xid,observed.stageWitness.xid);
            assert.deepEqual(await filesystem(),observed.files,'Proof-group entry remains before every physical effect.');
            group={witness:actual,ids:[]}; }
          const header=event.result.rows[0]; assert(header); assert.equal(header.request_digest,protocol.header.request_digest);
          assert.equal(header.intent_text,protocol.header.intent_text);
        }
        if(group && /^\s*SELECT\s+\*\s+FROM\s+collaboration_admission_targets\b/iu.test(event.text)
          && /\bFOR\s+UPDATE\s*$/iu.test(event.text) && event.values[0]===protocol.request.requestId) {
          assert.equal(typeof event.values[1],'string'); const documentId=event.values[1] as string;
          assert(protocol.request.expectedDocuments.some(document=>document.documentId===documentId));
          assert(!group.ids.includes(documentId)); group.ids.push(documentId); assert(group.ids.length<=8);
        }
        if(/^\s*COMMIT\s*$/iu.test(event.text) && group) {
          assert.equal(event.result.command,'COMMIT');
          const actual=(await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
            pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
          assert.equal(Number(actual.pid),group.witness.pid); assert.equal(actual.start,group.witness.start); assert.equal(actual.xid,null);
          const offset=observed.groups.flat().length;
          const expected=protocol.request.expectedDocuments.slice(offset,offset+8).map(document=>document.documentId);
          assert(expected.length>0); assert.deepEqual(group.ids,expected);
          // Prelude may already have persisted every proof: this actual group
          // COMMIT can be SELECT-only. Never label existing xmins as group writes.
          const targets=await proofGroupRows('collaboration_admission_targets','request_id',protocol.request.requestId);
          assert.equal(targets.length,protocol.request.expectedDocuments.length);
          assert.deepEqual(await row(intentTable(job),job.batch!.batchId),protocol.intent);
          assert.deepEqual(await filesystem(),observed.files,'Every proof group COMMIT precedes mkdir/rename and physical receipts.');
          observed.targetsAtCommit=targets;
          observed.commits.push({pid:group.witness.pid,start:group.witness.start,xid:group.witness.xid,documentIds:[...group.ids]});
          observed.groups.push([...group.ids]); group=undefined;
          if(loseFirstGroupCommit && !observed.lostAcknowledgement) {
            observed.lostAcknowledgement=true;
            throw Object.assign(new Error('Lost actual proof-group COMMIT acknowledgement.'),{code:'FIXTURE_MOVE_PROOF_GROUP_ACK_LOST'});
          }
        }
        if(/^\s*INSERT\s+INTO\b/iu.test(event.text) && /\bworkspace_file_operation_move_(?:parent|path)_receipts\b/iu.test(event.text)
          && event.values[0]===job.batch!.batchId) {
          assert.equal(group,undefined);
          assert.deepEqual(observed.groups.flat(),protocol.request.expectedDocuments.map(document=>document.documentId),
            'An existing intent must not bypass even one current proof group before physical receipts.');
          observed.physicalObserved=true;
        }
      },operation);
    };
    const assertProofGroupOriginal = async(job:Job,original:ProofGroupOriginal) => {
      assert.deepEqual(await readProofGroupOriginal(job),original);
      const nativeReceipts=await proofGroupRows('collaboration_native_file_operation_receipts','operation_id',original.operationId);
      assert.deepEqual(nativeReceipts.map(value=>(JSON.parse(value.body) as {mutation_id:string}).mutation_id).sort(),original.mutationIds);
      await run('move',currentToken,h.source.workspaceId,live=>noMutation(async()=>{
        const known=await existing(job,live); assert.equal(known.kind,'historical-header');
        assert.deepEqual(known.batch.authorization,job.original); const historical=await status(job,live); assert(historical);
        assert.equal(historical.observation.apply,'complete');
      }));
      assert.deepEqual(await proofGroupRows('collaboration_native_file_operation_receipts','operation_id',original.operationId),nativeReceipts);
    };
    await check('Move Stage COMMIT then actual grant loss has no FS; existing-intent recovery commits every current proof group before FS',async()=>{
      const job=await seed('move',true); let revoked=false;
      let original:Awaited<ReturnType<typeof immutableBatch>>|undefined,stageFiles:Awaited<ReturnType<typeof filesystem>>|undefined;
      const incoming=await load(h.connection,job.incomingId); assert(incoming);
      try {
        await assert.rejects(run('move',currentToken,h.source.workspaceId,async live=>{
          await create(job,live); original=await immutableBatch(job);
          return afterActualCommit(job,intentTable(job),async()=>{
            stageFiles=await filesystem(); // Actual Stage committed while its kernel/room fences remain held.
            assert.equal((await h.admin.query(`DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 AND user_id='member'
              AND workspace_id=$2 RETURNING client_id`,[clientId,h.source.workspaceId])).rowCount,1); revoked=true;
          },()=>invoke(job,live,job.batch!));
        }),rejected('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
        assert(revoked && job.batch && job.original && original && stageFiles);
        assert.deepEqual(await filesystem(),stageFiles); assert.deepEqual(await immutableBatch(job),original);
        assert.equal((await row(receiptTable(job),job.batch.batchId)).length,0);
        const retained=await readProofGroupOriginal(job); assert(retained.request.expectedDocuments.length>8);
        assert.deepEqual(Buffer.from((await load(h.connection,job.incomingId))!.yjsState),Buffer.from(incoming.yjsState));
        await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
          VALUES($1,'member',$2,100,100)`,[clientId,h.source.workspaceId]); revoked=false;
        const observed:ProofGroupObservation={protocol:retained,stageCommitted:true,files:stageFiles,commits:[],groups:[],physicalObserved:false,lostAcknowledgement:false};
        await observeActualMoveProofGroups(job,observed,false,()=>recover(job));
        assert(observed.owner && observed.physicalObserved); assert(observed.groups.length>1);
        assert.equal(observed.commits.length,observed.groups.length);
        assert.deepEqual(observed.groups.flat(),retained.request.expectedDocuments.map(document=>document.documentId));
        assert.deepEqual(await immutableBatch(job),original); await assertComplete(job); await assertProofGroupOriginal(job,retained);
        const after=await load(h.connection,job.incomingId); assert(after); assert.equal(after.documentSequence,incoming.documentSequence+1);
      } finally {
        if(revoked) await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
          VALUES($1,'member',$2,100,100) ON CONFLICT DO NOTHING`,[clientId,h.source.workspaceId]);
      }
    });
    await check('actual proof-group COMMIT then lost ACK preserves Original and no FS; real SID-B repeats all groups and completes once',async()=>{
      const job=await seed('move',true);
      let original:Awaited<ReturnType<typeof immutableBatch>>|undefined;
      const incoming=await load(h.connection,job.incomingId); assert(incoming);
      const first:ProofGroupObservation={stageCommitted:false,commits:[],groups:[],physicalObserved:false,lostAcknowledgement:false};
      await assert.rejects(run('move',currentToken,h.source.workspaceId,async live=>{
        await create(job,live); original=await immutableBatch(job);
        return observeActualMoveProofGroups(job,first,true,()=>invoke(job,live,job.batch!));
      }),rejected('JOB_LIFECYCLE_COMMIT_UNCONFIRMED'));
      assert(job.batch && job.original && original && first.files);
      assert(first.stageCommitted && first.lostAcknowledgement && first.owner && first.protocol && first.stageWitness);
      assert.equal(first.groups.length,1); assert.equal(first.groups[0].length,8); assert.equal(first.physicalObserved,false);
      assert.equal(first.commits.length,1); assert.notEqual(first.commits[0].xid,first.stageWitness.xid);
      const retained=first.protocol; assert(retained.request.expectedDocuments.length>8);
      assert.deepEqual(await filesystem(),first.files); assert.deepEqual(await immutableBatch(job),original);
      assert.equal((await row(receiptTable(job),job.batch.batchId)).length,0);
      const targetRows=await proofGroupRows('collaboration_admission_targets','request_id',retained.request.requestId);
      assert.deepEqual(targetRows,first.targetsAtCommit,'Independent rows/xmins remain exactly those observed after the actual uncertain group COMMIT.');
      assert.deepEqual(Buffer.from((await load(h.connection,job.incomingId))!.yjsState),Buffer.from(incoming.yjsState));
      const originalSession=job.original.actorSessionId,old=await rotate(); assert.notEqual(currentSession,originalSession);
      await assert.rejects(run('move',old,h.source.workspaceId,async live=>{await freshScope(live);}),rejected('invalid_token'));
      const resumed:ProofGroupObservation={protocol:retained,stageCommitted:true,files:first.files,commits:[],groups:[],physicalObserved:false,lostAcknowledgement:false};
      await observeActualMoveProofGroups(job,resumed,false,()=>recover(job));
      assert(resumed.owner && resumed.physicalObserved); assert(resumed.groups.length>1);
      assert.equal(resumed.commits.length,resumed.groups.length);
      assert.deepEqual(resumed.groups.flat(),retained.request.expectedDocuments.map(document=>document.documentId),
        'Recovery revalidates from offset zero rather than trusting the uncertain committed group.');
      assert.equal(job.original.actorSessionId,originalSession); assert.deepEqual(await immutableBatch(job),original);
      await assertComplete(job); await assertProofGroupOriginal(job,retained);
      const after=await load(h.connection,job.incomingId); assert(after); assert.equal(after.documentSequence,incoming.documentSequence+1);
    });
    // The earlier owned live runtime has closed. These E6 cases now reach
    // successful native-link writes and therefore need the genuine background
    // projector alive until their existing historical-read barriers finish.
    const htmlDeleteRooms = await startNativePathRoomRuntime();
    let htmlDeleteRoomFailure: unknown;
    try {
    for (const fault of ['after-physical', 'grant-after-intent'] as const) {
      await check(`HTML Delete4: ${fault} retains genuine E6 Original and SID-B completes Archive/unlinks/Trash exactly once`, async () => {
        const { inspectPersistedDocumentLinksV4 } = await import('../app/lib/markdown/workspace-native-link-inventory');
        const { inspectWorkspaceMarkdownHtmlV4 } = await import('../app/lib/markdown/workspace-local-link-parser');
        const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
        const prefix = 'html-delete4-fault-' + crypto.randomUUID(), sourcePath = prefix + '-target.md';
        const incomingPath = prefix + '-ordinary.md', htmlPath = prefix + '-html.md', pagePath = prefix + '.html';
        const sourceBytes = Buffer.from('# Original projected Delete4 fault target\n');
        const target = await h.upload(sourcePath, sourceBytes);
        const incoming = await h.upload(incomingPath, Buffer.from('[Original](' + sourcePath + ')\n'));
        const htmlRaw = '<p><a href="https://example.com">Unrelated HTML remains exact</a></p>';
        const htmlDocument = await h.upload(htmlPath, Buffer.from('[Original HTML source](' + sourcePath + ')\n\n' + htmlRaw + '\n'));
        const pageBytes = Buffer.from('<p>Unrelated physical HTML</p>\n');
        await fs.writeFile(path.join(h.source.rootPath, pagePath), pageBytes, { mode: 0o600, flag: 'wx' });
        const title = 'Original Delete4 fault ' + prefix;
        await h.metadata(h.source, sourcePath, { title, isFavorite: true, pinned: true }, 'member', currentRequestToken);
        const targetBefore = await load(h.connection, target.documentId), incomingBefore = await load(h.connection, incoming.documentId);
        const htmlBefore = await load(h.connection, htmlDocument.documentId); assert(targetBefore && incomingBefore && htmlBefore);
        const sourceIdentity = await fs.stat(path.join(h.source.rootPath, sourcePath)); assert(sourceIdentity.isFile());
        const lineage = (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [target.documentId])).rows;
        assert.equal(lineage.length, 1);
        const job: Job = await run('delete', currentToken, h.source.workspaceId, async (live): Promise<Job> => {
          const scope = await freshScope(live), plan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{
            reviewId: crypto.randomUUID(), kind: 'delete', selections: [{ sourcePath }] }] });
          assert(plan.version === 2 && plan.planIdentityVersion === 4);
          assert.equal(plan.sourceEvidence.evidenceVersion, 5); assert.equal(plan.coverage.complete, false);
          assert.equal(plan.linkAssessment.complete, true); assert.deepEqual(plan.linkAssessment.blockers, []);
          return { kind: 'delete', operationId: crypto.randomUUID(), plan, scope, sourcePath, destinationPath: prefix + '-unused.md',
            incomingPath, pdfPath: null, destinationPdf: null, pdf: null, targetId: target.documentId, incomingId: incoming.documentId,
            lineageId: lineage[0].lineage_id, generation: target.lifecycleGeneration, title,
            originalBinary: Buffer.from(targetBefore.yjsState), originalVector: Buffer.from(targetBefore.stateVector) };
        });
        const htmlFacts = (state: NonNullable<typeof htmlBefore>) => {
          const snapshot = authoritativeNativeCollaborationSnapshot(state); assert(snapshot.content.kind === 'plain_text');
          return inspectWorkspaceMarkdownHtmlV4(snapshot.content.text, state.path).occurrences
            .map(({ raw, fullyInspected, explicitLocalTargets }) => ({ raw, fullyInspected, explicitLocalTargets }));
        };
        const originalHtml = htmlFacts(htmlBefore); assert.equal(originalHtml.length, 1); assert.equal(originalHtml[0].raw, htmlRaw);
        type E6Intent = Extract<import('../app/lib/files/workspace-operation-original-delete-evidence').OriginalIntent, { version: 6 }>;
        let intent: E6Intent | undefined, intentRows: Awaited<ReturnType<typeof row>> | undefined;
        let original: Awaited<ReturnType<typeof immutableBatch>> | undefined;
        let stageDomain: Awaited<ReturnType<typeof snapshot>> | undefined, stageFiles: Awaited<ReturnType<typeof filesystem>> | undefined;
        let admissionIdentity: unknown, stageClient: MetadataSqlEvent['client'] | undefined;
        let stageWitness: { pid: number; start: string; xid: string } | undefined, pendingIntent: Awaited<ReturnType<typeof row>> | undefined;
        let stageCommitted = false, physicalFault = false, grantRemoved = false;
        const captureStage = async () => {
          assert(job.batch && job.original); intentRows = await row(intentTable(job), job.batch.batchId); assert.equal(intentRows.length, 1);
          intent = JSON.parse(JSON.parse(intentRows[0].body).intent_text) as E6Intent;
          assert.equal(intent.version, 6); assert.equal(intent.currentWitness.evidenceVersion, 5);
          assert.equal(intent.physical.source.kind, 'regular_file'); assert.equal(intent.physical.canonicalPath, sourcePath);
          assert(intent.physical.source.kind === 'regular_file'); assert.equal(intent.physical.source.sha256, sha(sourceBytes));
          assert.equal(intent.nativeLinks.length, 2);
          assert(intent.nativeLinks.every(item => item.prepared.contractVersion === 4 && item.prepared.parserVersion === 4));
          original = await immutableBatch(job); stageDomain = await snapshot(); delete stageDomain.rows.workspace_file_operation_batches;
          stageFiles = await filesystem();
          admissionIdentity = (await h.admin.query(`SELECT request_id,request_digest,intent_text FROM collaboration_admission_requests
            WHERE request_id=$1`, [intent.admission.requestId])).rows;
          assert.equal((admissionIdentity as unknown[]).length, 1);
          assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, sourcePath)), sourceBytes);
          await absent(path.join(h.dataRoot, intent.physical.trashRelativePath));
          stageCommitted = true;
        };
        const removeGrant = async () => {
          assert.equal((await h.admin.query(`DELETE FROM mcp_direct_workspace_grant
            WHERE client_id=$1 AND user_id='member' AND workspace_id=$2 RETURNING client_id`, [clientId, h.source.workspaceId])).rowCount, 1);
          grantRemoved = true;
        };
        const restoreGrant = async () => {
          if (grantRemoved) {
            assert.equal((await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
              VALUES($1,'member',$2,100,100) RETURNING client_id`, [clientId, h.source.workspaceId])).rowCount, 1);
            grantRemoved = false;
          }
        };
        try {
          await assert.rejects(run('delete', currentToken, h.source.workspaceId, async live => {
            await create(job, live);
            if (fault === 'grant-after-intent') return afterActualCommit(job, intentTable(job), async () => {
              await captureStage(); await removeGrant();
            }, () => invoke(job, live, job.batch!));
            return h.withProbe(async event => {
              if (/^\s*INSERT\s+INTO\b/iu.test(event.text) && event.text.includes(intentTable(job))
                && event.values[0] === job.batch!.batchId && event.result.rowCount === 1) {
                assert.equal(stageClient, undefined); stageClient = event.client;
                const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                  pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema,
                  pg_catalog.to_regnamespace(current_schema())::oid::text AS schema_oid
                  FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
                assert.equal(witness.schema, h.schema); assert.equal(witness.schema_oid, h.schemaOid); assert(witness.xid);
                stageWitness = { pid: Number(witness.pid), start: witness.start, xid: witness.xid };
                pendingIntent = (await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
                  FROM workspace_file_operation_delete_intents t WHERE batch_id=$1`, [job.batch!.batchId])).rows;
                assert.equal(pendingIntent.length, 1);
                assert.equal((await row(intentTable(job), job.batch!.batchId)).length, 0);
              }
              if (event.client !== stageClient) return;
              if (/^\s*COMMIT\s*$/iu.test(event.text) && !stageCommitted) {
                assert(stageWitness); assert.equal(event.result.command, 'COMMIT');
                const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                  pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
                assert.equal(Number(witness.pid), stageWitness.pid); assert.equal(witness.start, stageWitness.start); assert.equal(witness.xid, null);
                assert(pendingIntent); assert.deepEqual(await row(intentTable(job), job.batch!.batchId), pendingIntent);
                await captureStage(); return;
              }
              if (!stageCommitted || !intent || physicalFault || !/^\s*SELECT\b/iu.test(event.text)
                || !event.text.includes(intentTable(job)) || !/\bFOR\s+SHARE\s+NOWAIT\s*$/iu.test(event.text)
                || event.values[0] !== job.batch!.batchId || event.result.rowCount !== 1
                || !Object.hasOwn(event.result.rows[0], 'intentText')) return;
              const stillPresent = await fs.lstat(path.join(h.source.rootPath, sourcePath)).then(() => true,
                error => { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); return false; });
              if (stillPresent) return; // The genuine pre-rename read must remain completely unmodified.
              assert(stageWitness && intentRows && intent.physical.source.kind === 'regular_file');
              assert.equal(event.result.rows[0].intentText, JSON.parse(intentRows[0].body).intent_text);
              const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema,
                pg_catalog.to_regnamespace(current_schema())::oid::text AS schema_oid
                FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
              assert.equal(witness.schema, h.schema); assert.equal(witness.schema_oid, h.schemaOid);
              assert.equal(Number(witness.pid), stageWitness.pid); assert.equal(witness.start, stageWitness.start);
              assert(witness.xid); assert.notEqual(witness.xid, stageWitness.xid);
              const payload = path.join(h.dataRoot, intent.physical.trashRelativePath), moved = await fs.stat(payload);
              assert(moved.isFile()); assert.equal(moved.dev, sourceIdentity.dev); assert.equal(moved.ino, sourceIdentity.ino);
              assert.deepEqual(await fs.readFile(payload), sourceBytes);
              assert.equal((await row(receiptTable(job), job.batch!.batchId)).length, 0);
              physicalFault = true;
              throw Object.assign(new Error('Actual Delete4 physical rename completed before native B2 mutation.'), { code: 'FIXTURE_DELETE4_AFTER_PHYSICAL' });
            }, () => invoke(job, live, job.batch!));
          }), rejected(fault === 'after-physical' ? 'FIXTURE_DELETE4_AFTER_PHYSICAL' : 'MCP_READ_PRINCIPAL_ACCESS_DENIED'));
          assert(stageCommitted && intent && intentRows && original && stageDomain && stageFiles && job.batch && job.original);
          assert.equal(physicalFault, fault === 'after-physical');
          assert.equal((await store.get(job.batch.batchId))?.status, 'needs_recovery');
          assert.deepEqual(await immutableBatch(job), original); assert.deepEqual(await row(intentTable(job), job.batch.batchId), intentRows);
          assert.equal((await row(receiptTable(job), job.batch.batchId)).length, 0);
          assert.equal((await row('workspace_file_operation_delete_trash_receipts', job.batch.batchId)).length, 0);
          const afterFault = await snapshot(); delete afterFault.rows.workspace_file_operation_batches;
          assert.deepEqual(afterFault, stageDomain, 'No archive, unlink, annotation, receipt or admission effect may escape the failed B2.');
          assert.deepEqual(await load(h.connection, job.targetId), targetBefore);
          assert.deepEqual(await load(h.connection, job.incomingId), incomingBefore);
          assert.deepEqual(await load(h.connection, htmlDocument.documentId), htmlBefore);
          const header = (await h.admin.query('SELECT request_digest,status,outcome_text FROM collaboration_admission_requests WHERE request_id=$1',
            [intent.admission.requestId])).rows; assert.equal(header.length, 1);
          assert.equal(header[0].request_digest, intent.admission.requestDigest);
          assert(['reserved', 'draining'].includes(header[0].status)); assert.equal(header[0].outcome_text, null);
          const payloadPath = path.join(h.dataRoot, intent.physical.trashRelativePath);
          if (fault === 'after-physical') {
            await absent(path.join(h.source.rootPath, sourcePath)); assert.deepEqual(await fs.readFile(payloadPath), sourceBytes);
            // A real retained reservation and moved payload never replace a current MCP grant.
            await removeGrant();
            // This retained intent deliberately blocks projection publication
            // until recovery. Hold both real workspace locks across the full
            // NoMutation snapshots instead of waiting for that blocked queue.
            const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
            const readWorkspaces = [...new Set([h.source.workspaceId, h.destination.workspaceId])].sort();
            assert.equal(readWorkspaces.length, 2);
            await withWorkspaceMutationLock(readWorkspaces[0], () => withWorkspaceMutationLock(readWorkspaces[1], async () => {
              const rows = (await h.admin.query(`SELECT DISTINCT workspace_id FROM collaboration_yjs_states
                WHERE status='active' ORDER BY workspace_id LIMIT 513`)).rows;
              assert(rows.length <= 512);
              for (const row of rows) assert(readWorkspaces.includes(row.workspace_id),
                'Every real projector workspace in the observed realm must be inside the read barrier.');
              await noMutation(() => assert.rejects(run('delete', currentToken, h.source.workspaceId,
                async live => { await existing(job, live); }), rejected('MCP_READ_PRINCIPAL_ACCESS_DENIED')));
            }));
          } else {
            assert.deepEqual(await filesystem(), stageFiles, 'Grant loss after Stage COMMIT must precede every physical effect.');
            assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, sourcePath)), sourceBytes); await absent(payloadPath);
          }
          await restoreGrant();
          const sidA = job.original.actorSessionId, old = await rotate(); assert.notEqual(currentSession, sidA);
          await assert.rejects(run('delete', old, h.source.workspaceId, async live => { await freshScope(live); }), rejected('invalid_token'));
          await recover(job);
          assert.equal(job.original.actorSessionId, sidA); assert.deepEqual(await immutableBatch(job), original);
          assert.deepEqual(await row(intentTable(job), job.batch.batchId), intentRows);
          assert.deepEqual((await h.admin.query(`SELECT request_id,request_digest,intent_text FROM collaboration_admission_requests
            WHERE request_id=$1`, [intent.admission.requestId])).rows, admissionIdentity);
          const final = await store.get(job.batch.batchId); assert(final);
          assert.equal(final.status, 'applied'); assert.equal(final.completedActions, 3); assert.equal(final.totalActions, 3);
          assert.deepEqual(final.authorization, job.original); assert.deepEqual(final.trashEntryIds, [intent.physical.trashEntryId]);
          const completionRows = await row(receiptTable(job), job.batch.batchId), trashRows = await row('workspace_file_operation_delete_trash_receipts', job.batch.batchId);
          assert.equal(completionRows.length, 1); assert.equal(trashRows.length, 1);
          const completion = JSON.parse(JSON.parse(completionRows[0].body).receipt_text);
          assert.equal(completion.version, 6); assert.equal(completion.nativeLinks.length, 2);
          assert.equal(completion.physical.observation.kind, 'moved'); assert.equal(completion.physical.observation.sha256, sha(sourceBytes));
          assert(completion.nativeLinks.every((item: { contractVersion: number; resultEvidenceVersion: number; parserVersion: number }) =>
            item.contractVersion === 2 && item.resultEvidenceVersion === 4 && item.parserVersion === 4));
          const mutationIds = intent.nativeLinks.map(item => item.prepared.operationId); assert.equal(new Set(mutationIds).size, 2);
          const mutationRows = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
            FROM collaboration_native_link_mutation_receipts t WHERE operation_id=ANY($1::text[]) ORDER BY operation_id`, [mutationIds])).rows;
          assert.equal(mutationRows.length, 2);
          const archived = await load(h.connection, job.targetId, true), incomingAfter = await load(h.connection, job.incomingId);
          const htmlAfter = await load(h.connection, htmlDocument.documentId); assert(archived && incomingAfter && htmlAfter);
          assert.equal(archived.status, 'archived'); assert.equal(archived.lifecycleGeneration, job.generation + 1);
          assert.deepEqual(Buffer.from(archived.yjsState), job.originalBinary); assert.deepEqual(Buffer.from(archived.stateVector), job.originalVector);
          assert.deepEqual((await h.admin.query('SELECT id,lineage_id,status FROM collaboration_documents WHERE id=$1', [job.targetId])).rows,
            [{ id: job.targetId, lineage_id: job.lineageId, status: 'archived' }]);
          assert.deepEqual((await h.admin.query('SELECT id,status,trash_entry_id FROM file_collaboration_lineages WHERE id=$1', [job.lineageId])).rows,
            [{ id: job.lineageId, status: 'archived', trash_entry_id: intent.physical.trashEntryId }]);
          assert.equal(incomingAfter.documentSequence, incomingBefore.documentSequence + 1);
          assert.equal(htmlAfter.documentSequence, htmlBefore.documentSequence + 1);
          assert.equal(inspectPersistedDocumentLinksV4(incomingAfter).links.length, 0);
          assert.equal(inspectPersistedDocumentLinksV4(htmlAfter).links.length, 0); assert.deepEqual(htmlFacts(htmlAfter), originalHtml);
          await absent(path.join(h.source.rootPath, sourcePath)); assert.deepEqual(await fs.readFile(payloadPath), sourceBytes);
          const payloadIdentity = await fs.stat(payloadPath); assert.equal(payloadIdentity.dev, sourceIdentity.dev); assert.equal(payloadIdentity.ino, sourceIdentity.ino);
          const trash = (await h.admin.query('SELECT id,status,original_path,metadata_json FROM workspace_trash_entries WHERE workspace_id=$1 AND original_path=$2',
            [h.source.workspaceId, sourcePath])).rows; assert.equal(trash.length, 1);
          assert.equal(trash[0].id, intent.physical.trashEntryId); assert.equal(trash[0].status, 'trashed'); assert.equal(JSON.parse(trash[0].metadata_json).payloadKind, 'file');
          assert.deepEqual((await h.admin.query('SELECT path FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, sourcePath])).rows, []);
          assert.deepEqual((await h.admin.query('SELECT path FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, sourcePath])).rows, []);
          assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, pagePath)), pageBytes);
          const finalHeader = (await h.admin.query('SELECT status,outcome_text FROM collaboration_admission_requests WHERE request_id=$1', [intent.admission.requestId])).rows;
          assert.equal(finalHeader.length, 1); assert.equal(finalHeader[0].status, 'committed'); assert(finalHeader[0].outcome_text);
          await withSettledProjectionReadBoundary(() => run('delete', currentToken, h.source.workspaceId, live => noMutation(async () => {
            const known = await existing(job, live); assert.equal(known.kind, 'historical-header'); assert(known.kind === 'historical-header');
            assert.deepEqual(known.batch.authorization, job.original); const observed = await status(job, live); assert(observed);
            assert.equal(observed.observation.apply, 'complete'); assert.deepEqual(observed.batch.authorization, job.original);
          })));
          assert.deepEqual(await row(receiptTable(job), job.batch.batchId), completionRows);
          assert.deepEqual(await row('workspace_file_operation_delete_trash_receipts', job.batch.batchId), trashRows);
          assert.deepEqual((await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
            FROM collaboration_native_link_mutation_receipts t WHERE operation_id=ANY($1::text[]) ORDER BY operation_id`, [mutationIds])).rows, mutationRows);
        } finally { await restoreGrant(); }
      });
    }
    await check('HTML Delete E6: actual completion COMMIT ACK loss and genuine SID-B preserve Original, receipts and later same-path D2 exactly once', async () => {
      const { inspectPersistedDocumentLinksV4 } = await import('../app/lib/markdown/workspace-native-link-inventory');
      const { inspectWorkspaceMarkdownHtmlV4 } = await import('../app/lib/markdown/workspace-local-link-parser');
      const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
      const prefix = 'html-delete-e6-ack-' + crypto.randomUUID(), sourcePath = prefix + '-target.md';
      const incomingPath = prefix + '-ordinary.md', htmlPath = prefix + '-html.md', title = 'Original E6 ' + prefix;
      const sourceBytes = Buffer.from('# Actual projected E6 target\n\nKeep the original in Trash.\n');
      const target = await h.upload(sourcePath, sourceBytes);
      const incoming = await h.upload(incomingPath, Buffer.from('[Original](' + sourcePath + ')\n'));
      const htmlRaw = '<p><a href="' + incomingPath + '">Unrelated preserved HTML</a></p>';
      const htmlDocument = await h.upload(htmlPath, Buffer.from('[Original HTML source](' + sourcePath + ')\n\n' + htmlRaw + '\n'));
      await h.metadata(h.source, sourcePath, { title, isFavorite: true, pinned: true }, 'member', currentRequestToken);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, sourcePath)), sourceBytes);
      const originalFileIdentity = await fs.stat(path.join(h.source.rootPath, sourcePath)); assert(originalFileIdentity.isFile());
      const targetBefore = await load(h.connection, target.documentId), incomingBefore = await load(h.connection, incoming.documentId);
      const htmlBefore = await load(h.connection, htmlDocument.documentId); assert(targetBefore && incomingBefore && htmlBefore);
      const lineage = (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [target.documentId])).rows;
      assert.equal(lineage.length, 1);
      const job: Job = await run('delete', currentToken, h.source.workspaceId, async (live): Promise<Job> => {
        const scope = await freshScope(live), plan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{
          reviewId: crypto.randomUUID(), kind: 'delete', selections: [{ sourcePath }] }] });
        assert(plan.version === 2 && plan.planIdentityVersion === 4,
          `Expected HTML Delete4 plan, got ${plan.version}/${plan.version === 2 ? plan.planIdentityVersion : 'other'}.`);
        assert.equal(plan.sourceEvidence.evidenceVersion, 5); assert.equal(plan.coverage.complete, false);
        assert.equal(plan.linkAssessment.complete, true); assert.deepEqual(plan.linkAssessment.blockers, []);
        return { kind: 'delete', operationId: crypto.randomUUID(), plan, scope, sourcePath, destinationPath: prefix + '-unused.md',
          incomingPath, pdfPath: null, destinationPdf: null, pdf: null, targetId: target.documentId, incomingId: incoming.documentId,
          lineageId: lineage[0].lineage_id, generation: target.lifecycleGeneration, title,
          originalBinary: Buffer.from(targetBefore.yjsState), originalVector: Buffer.from(targetBefore.stateVector) };
      });
      const htmlFacts = (state: NonNullable<typeof htmlBefore>) => {
        const snapshot = authoritativeNativeCollaborationSnapshot(state); assert(snapshot.content.kind === 'plain_text');
        return inspectWorkspaceMarkdownHtmlV4(snapshot.content.text, state.path).occurrences
          .map(({ raw, fullyInspected, explicitLocalTargets }) => ({ raw, fullyInspected, explicitLocalTargets }));
      };
      const originalHtml = htmlFacts(htmlBefore); assert.equal(originalHtml.length, 1); assert.equal(originalHtml[0].raw, htmlRaw);
      let faulted = false;
      await assert.rejects(run('delete', currentToken, h.source.workspaceId, async live => {
        await create(job, live);
        return afterActualCommit(job, receiptTable(job), async () => {
          faulted = true;
          throw Object.assign(new Error('Lost actual E6 completion COMMIT acknowledgement.'), { code: 'FIXTURE_MCP_JOB_ACK_LOST' });
        }, () => invoke(job, live, job.batch!));
      }), rejected('JOB_LIFECYCLE_COMMIT_UNCONFIRMED'));
      assert(faulted && job.batch && job.original);
      const original = await immutableBatch(job), intentRows = await row(intentTable(job), job.batch.batchId);
      const completionRows = await row(receiptTable(job), job.batch.batchId);
      const trashReceipts = await row('workspace_file_operation_delete_trash_receipts', job.batch.batchId);
      assert.equal(intentRows.length, 1); assert.equal(completionRows.length, 1); assert.equal(trashReceipts.length, 1);
      const intent = JSON.parse(JSON.parse(intentRows[0].body).intent_text);
      const completion = JSON.parse(JSON.parse(completionRows[0].body).receipt_text);
      assert.equal(intent.version, 6); assert.equal(intent.currentWitness.evidenceVersion, 5);
      assert.equal(intent.physical.source.kind, 'regular_file'); assert.equal(intent.physical.source.sha256, sha(sourceBytes));
      assert.equal(intent.actor.actorSessionId, job.original.actorSessionId);
      assert.equal(completion.version, 6); assert.equal(completion.nativeLinks.length, 2); assert.equal(intent.nativeLinks.length, 2);
      assert.equal(completion.physical.observation.kind, 'moved'); assert.equal(completion.physical.observation.sha256, sha(sourceBytes));
      assert(intent.nativeLinks.every((item: { prepared: { contractVersion: number; parserVersion: number } }) =>
        item.prepared.contractVersion === 4 && item.prepared.parserVersion === 4));
      assert(completion.nativeLinks.every((item: { contractVersion: number; resultEvidenceVersion: number; parserVersion: number;
        htmlSourceProof: string }) => item.contractVersion === 2 && item.resultEvidenceVersion === 4
        && item.parserVersion === 4 && typeof item.htmlSourceProof === 'string' && /^[a-f0-9]{64}$/u.test(item.htmlSourceProof)));
      const mutationIds = intent.nativeLinks.map((item: { prepared: { operationId: string } }) => item.prepared.operationId);
      assert.equal(new Set(mutationIds).size, 2);
      const mutationRows = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
        FROM collaboration_native_link_mutation_receipts t WHERE operation_id=ANY($1::text[]) ORDER BY operation_id`, [mutationIds])).rows;
      assert.equal(mutationRows.length, 2);
      const archived = await load(h.connection, job.targetId, true), incomingAfterCommit = await load(h.connection, job.incomingId);
      const htmlAfterCommit = await load(h.connection, htmlDocument.documentId); assert(archived && incomingAfterCommit && htmlAfterCommit);
      assert.equal(archived.status, 'archived'); assert.equal(archived.lifecycleGeneration, job.generation + 1);
      assert.deepEqual((await h.admin.query('SELECT id,lineage_id,status FROM collaboration_documents WHERE id=$1',
        [job.targetId])).rows, [{ id: job.targetId, lineage_id: job.lineageId, status: 'archived' }]);
      assert.deepEqual((await h.admin.query('SELECT id,status,trash_entry_id FROM file_collaboration_lineages WHERE id=$1',
        [job.lineageId])).rows, [{ id: job.lineageId, status: 'archived', trash_entry_id: completion.trashEntryId }]);
      assert.deepEqual(Buffer.from(archived.yjsState), job.originalBinary); assert.deepEqual(Buffer.from(archived.stateVector), job.originalVector);
      assert.equal(incomingAfterCommit.documentSequence, incomingBefore.documentSequence + 1);
      assert.equal(htmlAfterCommit.documentSequence, htmlBefore.documentSequence + 1);
      assert.equal(inspectPersistedDocumentLinksV4(incomingAfterCommit).links.length, 0);
      assert.equal(inspectPersistedDocumentLinksV4(htmlAfterCommit).links.length, 0);
      assert.deepEqual(htmlFacts(htmlAfterCommit), originalHtml);
      await absent(path.join(h.source.rootPath, sourcePath));
      assert.deepEqual(await fs.readFile(path.join(h.dataRoot, intent.physical.trashRelativePath)), sourceBytes);
      const trashFileIdentity = await fs.stat(path.join(h.dataRoot, intent.physical.trashRelativePath));
      assert(trashFileIdentity.isFile()); assert.equal(trashFileIdentity.dev, originalFileIdentity.dev);
      assert.equal(trashFileIdentity.ino, originalFileIdentity.ino);
      const trash = (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_trash_entries WHERE id=$1',
        [completion.trashEntryId])).rows; assert.equal(trash.length, 1);
      assert.equal(trash[0].status, 'trashed'); assert.equal(trash[0].original_path, sourcePath);
      assert.equal(JSON.parse(trash[0].metadata_json).payloadKind, 'file');
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_trash_entries WHERE workspace_id=$1 AND original_path=$2',
        [h.source.workspaceId, sourcePath])).rows[0].n, 1);
      assert.deepEqual((await h.admin.query('SELECT path FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2',
        [h.source.workspaceId, sourcePath])).rows, []);
      assert.deepEqual((await h.admin.query('SELECT path FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2',
        [h.source.workspaceId, sourcePath])).rows, []);
      const originalSession = job.original.actorSessionId, oldToken = await rotate(); assert.notEqual(currentSession, originalSession);
      await assert.rejects(run('delete', oldToken, h.source.workspaceId, async live => {
        await freshScope(live); assert.fail('Expired original SID-A cannot supply current E6 recovery authority.');
      }), rejected('invalid_token'));
      // A real central authenticated upload creates a distinct native D2 after
      // the committed original effect, before SID-B recovers the original job.
      const replacementBytes = Buffer.from('# Independent D2 at old E6 spelling\n\nDo not delete or adopt this later document.\n');
      const replacement = await h.upload(sourcePath, replacementBytes); assert.notEqual(replacement.documentId, job.targetId);
      await h.metadata(h.source, sourcePath, { title: 'Later E6 D2', isFavorite: true, pinned: true }, 'member', currentRequestToken);
      const replacementBefore = await load(h.connection, replacement.documentId); assert(replacementBefore);
      assert.equal(replacementBefore.status, 'active');
      const replacementRegistry = (await h.admin.query('SELECT id,lineage_id,status FROM collaboration_documents WHERE id=$1',
        [replacement.documentId])).rows; assert.equal(replacementRegistry.length, 1);
      assert.equal(replacementRegistry[0].status, 'active'); assert.notEqual(replacementRegistry[0].lineage_id, job.lineageId);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, sourcePath)), replacementBytes);
      const domainTables = ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages', 'collaboration_file_projections',
        'collaboration_native_link_mutation_receipts', 'workspace_trash_entries', 'workspace_file_metadata', 'workspace_file_user_states',
        'public_file_shares', 'file_guest_invitations', 'workspace_file_operation_delete_intents',
        'workspace_file_operation_delete_trash_receipts', 'workspace_file_operation_delete_receipts',
        'collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets'];
      const domainRows = async () => {
        const result: Record<string, unknown> = {};
        for (const table of domainTables) {
          const rows = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${table}" t
            ORDER BY to_jsonb(t)::text,xmin::text LIMIT 10001`)).rows;
          assert(rows.length <= 10000); result[table] = rows;
        }
        return result;
      };
      const filesBeforeRecovery = await filesystem(), domainBeforeRecovery = await domainRows();
      const historicalWrites: Array<{ operation: string; table: string }> = [];
      await h.withProbe(async event => {
        const mutation = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+((?:"[^"]+"\.)?"?([a-z_]+)"?)/iu.exec(event.text);
        if (mutation && domainTables.includes(mutation[3])) historicalWrites.push({ operation: mutation[1], table: mutation[3] });
      }, () => recover(job));
      assert.deepEqual(historicalWrites, []);
      const domainAfterRecovery = await domainRows();
      for (const table of domainTables) {
        assert(Object.hasOwn(domainBeforeRecovery, table) && Object.hasOwn(domainAfterRecovery, table));
        assert.deepEqual(domainAfterRecovery[table], domainBeforeRecovery[table], table + ': historical E6 recovery must preserve row bytes and xmin.');
      }
      assert.deepEqual(await filesystem(), filesBeforeRecovery);
      assert.deepEqual(await immutableBatch(job), original); assert.equal(job.original.actorSessionId, originalSession);
      assert.notEqual(currentSession, job.original.actorSessionId);
      assert.deepEqual(await row(intentTable(job), job.batch.batchId), intentRows);
      assert.deepEqual(await row(receiptTable(job), job.batch.batchId), completionRows);
      assert.deepEqual(await row('workspace_file_operation_delete_trash_receipts', job.batch.batchId), trashReceipts);
      assert.deepEqual((await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
        FROM collaboration_native_link_mutation_receipts t WHERE operation_id=ANY($1::text[]) ORDER BY operation_id`, [mutationIds])).rows, mutationRows);
      assert.deepEqual((await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_trash_entries WHERE id=$1', [completion.trashEntryId])).rows, trash);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_trash_entries WHERE workspace_id=$1 AND original_path=$2',
        [h.source.workspaceId, sourcePath])).rows[0].n, 1);
      const replacementAfter = await load(h.connection, replacement.documentId); assert(replacementAfter);
      assert.deepEqual(replacementAfter, replacementBefore); assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, sourcePath)), replacementBytes);
      assert.deepEqual(await load(h.connection, job.targetId, true), archived);
      assert.deepEqual(await load(h.connection, job.incomingId), incomingAfterCommit);
      assert.deepEqual(await load(h.connection, htmlDocument.documentId), htmlAfterCommit);
      assert.deepEqual(htmlFacts(htmlAfterCommit), originalHtml);
      assert.deepEqual(await fs.readFile(path.join(h.dataRoot, intent.physical.trashRelativePath)), sourceBytes);
      const final = await store.get(job.batch.batchId); assert(final);
      assert.equal(final.status, 'applied'); assert.equal(final.phase, 'complete');
      assert.equal(final.completedActions, 3); assert.equal(final.totalActions, 3);
      assert.deepEqual(final.trashEntryIds, [completion.trashEntryId]); assert.deepEqual(final.authorization, job.original);
    });
    await check('HTML Delete4: real MCP preview, OriginalOwner archive/unlink and same original SID-B history preserve HTML/raw bytes', async () => {
      const { runDirectMcpWorkspaceDeleteService: publicDelete } = await import('../app/lib/files/workspace-operation-mcp-path-service');
      const { decodeDirectMcpWorkspaceDeleteRequestV1: requestDelete } = await import('../app/lib/mcp/server/workspace-path-tool-contract');
      const { inspectWorkspaceMarkdownHtmlV4 } = await import('../app/lib/markdown/workspace-local-link-parser');
      const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
      const prefix = 'html-delete-' + crypto.randomUUID(), sourcePath = prefix + '-target.md';
      const target = await h.upload(sourcePath, Buffer.from('# Actual projected Delete4 target\n'));
      const incoming = await h.upload(prefix + '-ordinary.md', Buffer.from('[Delete ordinary](' + sourcePath + ')\n'));
      const lineage = (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [target.documentId])).rows;
      assert.equal(lineage.length, 1);
      const job = { sourcePath, targetId: target.documentId, incomingId: incoming.documentId,
        lineageId: lineage[0].lineage_id, generation: target.lifecycleGeneration };
      const sourceBytes = await fs.readFile(path.join(h.source.rootPath, job.sourcePath));
      const keepPath = prefix + '-keep.md', htmlPath = prefix + '-incoming.md', pagePath = prefix + '.html', rawPath = prefix + '-raw.md';
      await h.upload(keepPath, Buffer.from('# HTML keep target\n'));
      const htmlRaw = '<p><a href="' + keepPath + '">Unrelated HTML</a></p>';
      const htmlDoc = await h.upload(htmlPath, Buffer.from('[Delete ordinary](' + job.sourcePath + ')\n\n' + htmlRaw + '\n'));
      const pageBytes = Buffer.from('<div><a href="' + keepPath + '">Physical unrelated HTML</a></div>\n');
      const rawBytes = Buffer.from('[Keep raw](' + keepPath + ')\n');
      await fs.writeFile(path.join(h.source.rootPath, pagePath), pageBytes, { mode: 0o600, flag: 'wx' });
      await fs.writeFile(path.join(h.source.rootPath, rawPath), rawBytes, { mode: 0o600, flag: 'wx' });
      const targetBefore = await load(h.connection, job.targetId), incomingBefore = await load(h.connection, job.incomingId);
      const htmlBefore = await load(h.connection, htmlDoc.documentId); assert(targetBefore && incomingBefore && htmlBefore);
      const htmlFacts = (state: NonNullable<typeof htmlBefore>) => {
        const snapshot = authoritativeNativeCollaborationSnapshot(state);
        assert.equal(snapshot.content.kind, 'plain_text'); assert(snapshot.content.kind === 'plain_text');
        return inspectWorkspaceMarkdownHtmlV4(snapshot.content.text, state.path).occurrences
          .map(({ raw, fullyInspected, explicitLocalTargets }) => ({ raw, fullyInspected, explicitLocalTargets }));
      };
      const beforeHtml = htmlFacts(htmlBefore); assert.equal(beforeHtml.length, 1); assert.equal(beforeHtml[0].raw, htmlRaw);
      const preview = await withSettledProjectionReadBoundary(() => noMutation(() => publicDelete(requestDelete({ api_version: 1, action: 'preview',
        workspace_id: h.source.workspaceId, path: job.sourcePath }), authInfo(currentToken))));
      assert.equal(preview.action, 'preview'); assert(preview.action === 'preview');
      assert.equal(preview.preview.kind, 'native-path-html-assessment'); assert(preview.preview.kind === 'native-path-html-assessment');
      assert.equal(preview.preview.version, 3); assert.equal(preview.preview.operationKind, 'delete');
      assert.equal(preview.preview.readiness, 'ready'); assert.equal(preview.preview.coverage.complete, false);
      assert.equal(preview.preview.linkAssessment.complete, true); assert.deepEqual(preview.preview.linkAssessment.blockers, []);
      assert(preview.preview.linkAssessment.warnings.some(item => item.path === htmlPath));
      assert(preview.preview.linkAssessment.warnings.some(item => item.path === pagePath));
      assert.deepEqual(preview.preview.paths, [{ sourcePath: job.sourcePath }]); assert.equal(preview.preview.linkChanges.unlinks, 2);
      const operationId = crypto.randomUUID(), planId = preview.preview.planId;
      const applyRequest = { api_version: 1, action: 'apply', workspace_id: h.source.workspaceId,
        path: job.sourcePath, operation_id: operationId, plan_id: planId };
      const result = await publicDelete(requestDelete(applyRequest), authInfo(currentToken));
      assert.equal(result.action, 'apply'); assert(result.action === 'apply');
      assert.equal(result.operation.journal.status, 'applied'); assert.equal(result.operation.execution.receiptStatus, 'available');
      assert.equal(result.operation.execution.finalization, 'complete'); assert.equal(result.operation.journal.completedActions, 3);
      assert.equal(result.operation.journal.totalActions, 3); assert.equal(result.operation.planId, planId);
      const batch = await store.get(result.operation.batchId); assert(batch && batch.plan.version === 2);
      assert.equal(batch.plan.planIdentityVersion, 4); assert.equal(batch.plan.sourceEvidence.evidenceVersion, 5);
      const storedIntent = (await row('workspace_file_operation_delete_intents', batch.batchId)); assert.equal(storedIntent.length, 1);
      const intent = JSON.parse(JSON.parse(storedIntent[0].body).intent_text);
      assert.equal(intent.version, 6); assert.equal(intent.currentWitness.evidenceVersion, 5); assert.equal(intent.nativeLinks.length, 2);
      assert.equal(intent.physical.source.kind, 'regular_file'); assert.equal(intent.physical.source.sha256, sha(sourceBytes));
      assert(intent.nativeLinks.every((item: { prepared: { contractVersion: number; parserVersion: number } }) =>
        item.prepared.contractVersion === 4 && item.prepared.parserVersion === 4));
      const storedReceipt = await row('workspace_file_operation_delete_receipts', batch.batchId); assert.equal(storedReceipt.length, 1);
      const receipt = JSON.parse(JSON.parse(storedReceipt[0].body).receipt_text);
      assert.equal(receipt.version, 6); assert.equal(receipt.nativeLinks.length, 2);
      assert.equal(receipt.physical.observation.kind, 'moved'); assert.equal(receipt.physical.observation.sha256, sha(sourceBytes));
      assert.deepEqual(await fs.readFile(path.join(h.dataRoot, intent.physical.trashRelativePath)), sourceBytes);
      assert(receipt.nativeLinks.every((item: { contractVersion: number; resultEvidenceVersion: number; parserVersion: number;
        htmlSourceProof: string; afterBinaryHash: string; afterVectorHash: string }) => item.contractVersion === 2
        && item.resultEvidenceVersion === 4 && item.parserVersion === 4 && /^[a-f0-9]{64}$/u.test(item.htmlSourceProof)
        && /^[a-f0-9]{64}$/u.test(item.afterBinaryHash) && /^[a-f0-9]{64}$/u.test(item.afterVectorHash)));
      const archived = (await h.admin.query('SELECT id,lineage_id,status FROM collaboration_documents WHERE id=$1', [job.targetId])).rows;
      assert.equal(archived.length, 1); assert.equal(archived[0].id, job.targetId); assert.equal(archived[0].lineage_id, job.lineageId);
      assert.equal(archived[0].status, 'archived');
      const archivedLineage = (await h.admin.query('SELECT id,status FROM file_collaboration_lineages WHERE id=$1', [job.lineageId])).rows;
      assert.deepEqual(archivedLineage, [{ id: job.lineageId, status: 'archived' }]);
      const targetAfter = await load(h.connection, job.targetId, true), incomingAfter = await load(h.connection, job.incomingId);
      const htmlAfter = await load(h.connection, htmlDoc.documentId); assert(targetAfter && incomingAfter && htmlAfter);
      assert.deepEqual(Buffer.from(targetAfter.yjsState), Buffer.from(targetBefore.yjsState));
      assert.equal(targetAfter.status, 'archived'); assert.equal(targetAfter.lifecycleGeneration, targetBefore.lifecycleGeneration + 1);
      assert.equal(incomingAfter.documentSequence, incomingBefore.documentSequence + 1); assert.equal(htmlAfter.documentSequence, htmlBefore.documentSequence + 1);
      assert.deepEqual(htmlFacts(htmlAfter), beforeHtml);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, pagePath)), pageBytes);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, rawPath)), rawBytes);
      await absent(path.join(h.source.rootPath, job.sourcePath));
      const firstSession = currentSession; await rotate(); assert.notEqual(currentSession, firstSession);
      const status = await withSettledProjectionReadBoundary(() => noMutation(() => publicDelete(requestDelete({ api_version: 1, action: 'status',
        workspace_id: h.source.workspaceId, operation_id: operationId }), authInfo(currentToken))));
      assert.equal(status.action, 'status'); assert(status.action === 'status');
      assert.equal(status.operation.batchId, batch.batchId); assert.equal(status.operation.planId, planId);
      assert.equal(status.operation.journal.status, 'applied'); assert.equal(status.operation.completion.status, 'confirmed');
      const replay = await withSettledProjectionReadBoundary(() => noMutation(() => publicDelete(requestDelete(applyRequest), authInfo(currentToken))));
      assert.equal(replay.action, 'apply'); assert(replay.action === 'apply');
      assert.equal(replay.alreadyKnown, true); assert.equal(replay.operation.batchId, batch.batchId);
      assert.deepEqual(await row('workspace_file_operation_delete_intents', batch.batchId), storedIntent);
      assert.deepEqual(await row('workspace_file_operation_delete_receipts', batch.batchId), storedReceipt);
      assert.equal((await load(h.connection, job.incomingId))!.documentSequence, incomingAfter.documentSequence);
      assert.equal((await load(h.connection, htmlDoc.documentId))!.documentSequence, htmlAfter.documentSequence);
    });
    // Additive Physical5 families. Existing 29 case bodies and all global
    // authority/realm/census/no-DML/FS/projection assertions above are retained.
    const { runDirectMcpWorkspaceDeleteService: physicalPublicDelete } = await import('../app/lib/files/workspace-operation-mcp-path-service');
    const { decodeDirectMcpWorkspaceDeleteRequestV1: physicalDeleteRequest } = await import('../app/lib/mcp/server/workspace-path-tool-contract');
    const { workspaceOperationMcpBatchId: physicalBatchId } = await import('../app/lib/files/workspace-operation-mcp-authorization');
    const { updateWorkspaceFileMetadata: physicalMetadata } = await import('../app/lib/files/workspace-file-metadata');
    const { filesystemFileVersion: physicalVersion } = await import('../app/lib/filesystem/file-version');
    const { inspectPersistedDocumentLinksV4: physicalLinks } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { inspectWorkspaceMarkdownHtmlV4: physicalHtml } = await import('../app/lib/markdown/workspace-local-link-parser');
    const { authoritativeNativeCollaborationSnapshot: physicalSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    type PhysicalIntent = Extract<import('../app/lib/files/workspace-operation-original-delete-evidence').OriginalIntent,{version:7}>;
    const physicalHtmlFacts = (state: NonNullable<Awaited<ReturnType<typeof load>>>) => {
      const snapshot = physicalSnapshot(state); assert(snapshot.content.kind === 'plain_text');
      return physicalHtml(snapshot.content.text,state.path).occurrences.map(({raw,fullyInspected,explicitLocalTargets})=>({raw,fullyInspected,explicitLocalTargets}));
    };
    const seedPhysical = async (extension:'png'|'pdf',pristine:boolean) => {
      const prefix='physical-delete5-'+crypto.randomUUID(),sourcePath=prefix+'.'+extension;
      const bytes=extension==='png'?Buffer.from([137,80,78,71,13,10,26,10,0,255,17,35]):Buffer.from('%PDF-1.7\nOriginal physical delete fixture\n%%EOF\n');
      await fs.writeFile(path.join(h.source.rootPath,sourcePath),bytes,{flag:'wx',mode:0o600});
      const selectedId=pristine?'physical-pristine-'+crypto.randomUUID():null,selectedLineage=pristine?'physical-lineage-'+crypto.randomUUID():null;
      if(pristine){
        assert(selectedId&&selectedLineage);
        await h.admin.query(`INSERT INTO file_collaboration_lineages(id,organization_id,customer_id,project_id,workspace_id,workspace_type,path,status,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'active',100)`,[selectedLineage,h.source.organizationId??null,h.source.customerId??null,h.source.projectId??null,h.source.workspaceId,h.source.workspaceType,sourcePath]);
        await h.admin.query(`INSERT INTO collaboration_documents(id,lineage_id,organization_id,customer_id,project_id,workspace_id,workspace_type,path,provider,status,state_version,yjs_state_lifecycle,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'yjs','active',0,'never_initialized',100,100)`,[selectedId,selectedLineage,h.source.organizationId??null,h.source.customerId??null,h.source.projectId??null,h.source.workspaceId,h.source.workspaceType,sourcePath]);
      }
      const incomingPath=prefix+'-ordinary.md',htmlPath=prefix+'-native-html.md',pagePath=prefix+'.html';
      const incoming=await h.upload(incomingPath,Buffer.from('[Asset]('+sourcePath+')\n'));
      const htmlRaw='<p><a href="https://example.com">Unchanged unrelated native HTML</a></p>';
      const html=await h.upload(htmlPath,Buffer.from('[Asset]('+sourcePath+')\n\n'+htmlRaw+'\n'));
      const pageBytes=Buffer.from('<p>Unrelated complete physical HTML</p>\n');
      await fs.writeFile(path.join(h.source.rootPath,pagePath),pageBytes,{flag:'wx',mode:0o600});
      const beforeFile=await fs.lstat(path.join(h.source.rootPath,sourcePath));assert(beforeFile.isFile());
      const expectedTarget={version:1,kind:'filesystem',workspaceId:h.source.workspaceId,path:sourcePath,entryType:'file',fileVersion:physicalVersion(beforeFile)};
      await physicalMetadata(await h.request(h.source,'member',false,currentRequestToken),{path:sourcePath,expectedTarget,title:'Original '+prefix,isFavorite:true,pinned:true});
      const incomingBefore=await load(h.connection,incoming.documentId),htmlBefore=await load(h.connection,html.documentId);assert(incomingBefore&&htmlBefore);
      const rawRegistry=(await h.admin.query('SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM collaboration_documents t WHERE id=$1',[selectedId])).rows;
      const rawLineage=(await h.admin.query('SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM file_collaboration_lineages t WHERE id=$1',[selectedLineage])).rows;
      assert.deepEqual((await h.admin.query('SELECT document_id FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2',[h.source.workspaceId,sourcePath])).rows,[]);
      return {sourcePath,bytes,beforeFile,selectedId,selectedLineage,incoming,html,incomingBefore,htmlBefore,pagePath,pageBytes,htmlRaw,rawRegistry,rawLineage};
    };
    type PhysicalSeed=Awaited<ReturnType<typeof seedPhysical>>;
    const previewPhysical=async(seed:PhysicalSeed)=>{
      const result=await withSettledProjectionReadBoundary(()=>noMutation(()=>physicalPublicDelete(physicalDeleteRequest({api_version:1,action:'preview',workspace_id:h.source.workspaceId,path:seed.sourcePath}),authInfo(currentToken))));
      assert(result.action==='preview'&&result.preview.kind==='native-path-html-assessment');assert.equal(result.preview.version,3);
      assert.equal(result.preview.readiness,'ready');assert.equal(result.preview.coverage.complete,false);assert.equal(result.preview.linkAssessment.complete,true);
      assert.equal(result.preview.linkChanges.unlinks,2);assert.equal(result.preview.linkChanges.affectedDocuments,2);
      assert.deepEqual(result.preview.paths,[{sourcePath:seed.sourcePath}]);return result.preview;
    };
    const physicalCall=(action:'apply'|'recover',seed:PhysicalSeed,operationId:string,planId:string)=>physicalPublicDelete(physicalDeleteRequest({api_version:1,action,workspace_id:h.source.workspaceId,path:seed.sourcePath,operation_id:operationId,plan_id:planId}),authInfo(currentToken));
    const physicalRows=async(batchId:string)=>({intent:await row('workspace_file_operation_delete_intents',batchId),completion:await row('workspace_file_operation_delete_receipts',batchId),trash:await row('workspace_file_operation_delete_trash_receipts',batchId)});
    const checkPhysicalCompletion=async(seed:PhysicalSeed,batchId:string,expectedMode:'direct'|'direct-mcp'='direct-mcp')=>{
      const batch=await store.get(batchId);assert(batch&&batch.plan.version===5);assert.equal(batch.authorization.mode,expectedMode);
      assert(batch.authorization.mode==='direct'||batch.authorization.mode==='direct-mcp');
      assert.equal(batch.plan.kind,'physical-original-delete');assert.equal(batch.plan.planIdentityVersion,5);assert.equal(Object.hasOwn(batch.plan,'nativeTarget'),false);
      assert.equal(batch.plan.physicalTarget.documentId,null);assert.equal(batch.status,'applied');assert.equal(batch.completedActions,3);assert.equal(batch.totalActions,3);
      const rows=await physicalRows(batchId);assert.equal(rows.intent.length,1);assert.equal(rows.completion.length,1);assert.equal(rows.trash.length,1);
      const intent=JSON.parse(JSON.parse(rows.intent[0].body).intent_text) as PhysicalIntent;
      const completion=JSON.parse(JSON.parse(rows.completion[0].body).receipt_text) as import('../app/lib/files/workspace-operation-original-delete-evidence').Completion;
      assert.equal(intent.version,7);assert.equal(intent.native,null);assert.equal(intent.currentWitness.evidenceVersion,5);assert.equal(intent.nativeLinks.length,2);
      assert.equal(completion.version,7);assert.equal(completion.native,null);assert.equal(completion.nativeLinks?.length,2);assert(completion.physicalRegistry);
      assert.equal(intent.physical.source.kind,'regular_file');assert(intent.physical.source.kind==='regular_file');assert.equal(intent.physical.source.sha256,sha(seed.bytes));
      assert.equal(completion.physical.observation.kind,'moved');assert(completion.physical.observation.kind==='moved');assert.equal(completion.physical.observation.sha256,sha(seed.bytes));
      assert.equal(completion.physical.observation.identity.device,seed.beforeFile.dev);assert.equal(completion.physical.observation.identity.inode,seed.beforeFile.ino);
      assert.equal(intent.actor.actorSessionId,batch.authorization.actorSessionId??null);assert.equal(intent.physicalRegistry.registry?.id??null,seed.selectedId);
      assert.equal(intent.physicalRegistry.lineage?.id??null,seed.selectedLineage);assert.deepEqual(completion.physicalRegistry.original,intent.physicalRegistry);
      await absent(path.join(h.source.rootPath,seed.sourcePath));assert.deepEqual(await fs.readFile(path.join(h.dataRoot,intent.physical.trashRelativePath)),seed.bytes);
      const payload=await fs.lstat(path.join(h.dataRoot,intent.physical.trashRelativePath));assert(payload.isFile());assert.equal(payload.dev,seed.beforeFile.dev);assert.equal(payload.ino,seed.beforeFile.ino);
      assert.deepEqual((await h.admin.query('SELECT document_id FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2',[h.source.workspaceId,seed.sourcePath])).rows,[]);
      if(seed.selectedId){
        assert.deepEqual((await h.admin.query('SELECT id,lineage_id,status,state_version::integer AS state_version,yjs_state_lifecycle FROM collaboration_documents WHERE id=$1',[seed.selectedId])).rows,
          [{id:seed.selectedId,lineage_id:seed.selectedLineage,status:'archived',state_version:0,yjs_state_lifecycle:'never_initialized'}]);
        assert.deepEqual((await h.admin.query('SELECT id,status,trash_entry_id FROM file_collaboration_lineages WHERE id=$1',[seed.selectedLineage])).rows,[{id:seed.selectedLineage,status:'archived',trash_entry_id:intent.physical.trashEntryId}]);
      }else{
        assert.equal(completion.physicalRegistry.registry,null);assert.equal(completion.physicalRegistry.lineage,null);
        assert.deepEqual((await h.admin.query('SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',[h.source.workspaceId,seed.sourcePath])).rows,[]);
      }
      const incomingAfter=await load(h.connection,seed.incoming.documentId),htmlAfter=await load(h.connection,seed.html.documentId);assert(incomingAfter&&htmlAfter);
      assert.equal(incomingAfter.documentSequence,seed.incomingBefore.documentSequence+1);assert.equal(htmlAfter.documentSequence,seed.htmlBefore.documentSequence+1);
      assert.equal(physicalLinks(incomingAfter).links.length,0);assert.equal(physicalLinks(htmlAfter).links.length,0);
      assert.deepEqual(physicalHtmlFacts(htmlAfter),physicalHtmlFacts(seed.htmlBefore));assert.equal(physicalHtmlFacts(htmlAfter)[0].raw,seed.htmlRaw);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath,seed.pagePath)),seed.pageBytes);
      for(const table of ['workspace_file_metadata','workspace_file_user_states'])assert.deepEqual((await h.admin.query(`SELECT path FROM ${table} WHERE workspace_id=$1 AND path=$2`,[h.source.workspaceId,seed.sourcePath])).rows,[]);
      const trash=(await h.admin.query('SELECT id,status,original_path,metadata_json FROM workspace_trash_entries WHERE workspace_id=$1 AND original_path=$2',[h.source.workspaceId,seed.sourcePath])).rows;
      assert.equal(trash.length,1);assert.equal(trash[0].id,intent.physical.trashEntryId);assert.equal(trash[0].status,'trashed');assert.equal(JSON.parse(trash[0].metadata_json).nativeDocumentId,null);
      const mutations=(await h.admin.query('SELECT operation_id FROM collaboration_native_link_mutation_receipts WHERE operation_id=ANY($1::text[]) ORDER BY operation_id',[intent.nativeLinks.map(link=>link.prepared.operationId)])).rows;
      assert.equal(mutations.length,2);return {batch,rows,intent,completion,incomingAfter,htmlAfter};
    };
    await check('Physical5 public PNG/unregistered and PDF/pristine delete preserve unaffected HTML and native link identities',async()=>{
      const {DELETE:webDelete}=await import('../app/api/files/delete/route');
      for(const extension of ['png','pdf'] as const){
        const seed=await seedPhysical(extension,extension==='pdf'),preview=await previewPhysical(seed);
        const webRequest=await h.request(h.source,'member',true,currentRequestToken);
        const webPreview=await withSettledProjectionReadBoundary(()=>noMutation(()=>webDelete(new NextRequest('http://localhost/api/files/delete',{method:'DELETE',headers:webRequest.headers,body:JSON.stringify({path:seed.sourcePath,dryRun:true})}))));
        assert.equal(webPreview.status,200);const webBody=await webPreview.json();assert.equal(webBody.dryRun,true);assert.equal(webBody.plan.version,2);assert.equal(webBody.plan.kind,'native-original-delete');assert.equal(webBody.plan.linkEdits.length,2);
        const operationId=crypto.randomUUID(),applied=await physicalCall('apply',seed,operationId,preview.planId);assert(applied.action==='apply');
        assert.equal(applied.operation.execution.receiptStatus,'available');assert.equal(applied.operation.execution.finalization,'complete');
        const checked=await checkPhysicalCompletion(seed,applied.operation.batchId);
        assert.equal(checked.batch.authorization.mode,'direct-mcp');
      }
    });
    await check('Physical5 actual cookie Web DELETE and ordinary worker prove links, pristine registry and Trash response',async()=>{
      if(selectedCaseId==='physical-web'){
        // Full36 reaches60 native Admission targets after the two unchanged
        // seedPhysical calls below add2 native backlink documents each.
        const existing=(await h.admin.query(`SELECT document_id FROM collaboration_yjs_states
          WHERE workspace_id=$1 AND status='active' ORDER BY document_id COLLATE "C" LIMIT 57`,[h.source.workspaceId])).rows;
        assert(existing.length<=56,'Focused Physical Web setup must fit the genuine Full36 starting census.');
        for(let index=existing.length;index<56;index++){
          const filePath='physical-web-neutral-'+crypto.randomUUID()+'.md';
          const document=await h.upload(filePath,Buffer.from('# Neutral focus document '+index+'\n\nUnlinked native diagnostic content.\n'));
          const state=await load(h.connection,document.documentId);assert(state);
          assert.equal(state.workspaceId,h.source.workspaceId);assert.equal(state.path,filePath);assert.equal(state.status,'active');
          assert.equal(links(state).links.length,0);
        }
        const ready=(await h.admin.query(`SELECT document_id FROM collaboration_yjs_states
          WHERE workspace_id=$1 AND status='active' ORDER BY document_id COLLATE "C" LIMIT 57`,[h.source.workspaceId])).rows;
        assert.equal(ready.length,56);
      }
      await run('delete',currentToken,h.source.workspaceId,live=>freshScope(live));
      const {DELETE:webDelete}=await import('../app/api/files/delete/route');
      const {GET:webBatch}=await import('../app/api/files/operations/batches/[batchId]/route');
      const seed=await seedPhysical('pdf',true),actual=await h.request(h.source,'member',true,currentRequestToken);
      // Real Web setup may create the user's personal workspace. Establish it
      // before observing the pure selected-workspace preview, as login does.
      const {requireRequestWorkspace}=await import('../app/lib/workspaces/request');
      const initialized=await requireRequestWorkspace(actual,{permissions:['canRead','canWrite','canDelete']});
      assert.equal(initialized.response,null);assert.equal(initialized.session!.user.id,'member');
      assert.equal(initialized.workspace!.workspaceId,h.source.workspaceId);assert.equal(initialized.workspace!.rootPath,h.source.rootPath);
      assert(initialized.workspace!.permissions.canRead&&initialized.workspace!.permissions.canWrite&&initialized.workspace!.permissions.canDelete);
      assert(actual.headers.has('cookie'));assert.equal(actual.headers.has('authorization'),false);
      const headers=new Headers(actual.headers);headers.set('Content-Type','application/json');
      // Real human authority loss after an actual preparation read must roll
      // back before intent insertion or any physical/native document effect.
      {
        const deniedSeed=await seedPhysical('pdf',true);
        const deniedPreviewResponse=await withSettledProjectionReadBoundary(()=>noMutation(()=>webDelete(new NextRequest('http://localhost/api/files/delete',
          {method:'DELETE',headers,body:JSON.stringify({path:deniedSeed.sourcePath,dryRun:true})}))));
        assert.equal(deniedPreviewResponse.status,200);const deniedPreview=await deniedPreviewResponse.json();
        assert.equal(deniedPreview.plan.version,2);assert.equal(deniedPreview.plan.kind,'native-original-delete');
        const {POST:resumeWebBatch}=await import('../app/api/files/operations/batches/[batchId]/route');
        const deniedWorker=createWorkspaceOperationBatchWorker({store});
        const driveDeniedWeb=async(request:()=>Promise<Response>)=>{
          let stopped=false,failure:unknown;const pendingResponse=request();
          const pumping=(async()=>{try{while(!stopped){await deniedWorker.tick();if(!stopped)await new Promise(resolve=>setTimeout(resolve,25));}}catch(error){failure=error;}})();
          try{
            const response=await pendingResponse;let body=await response.json() as WorkspacePathOperationResponse&{success:boolean;code?:string};
            assert([200,202,409].includes(response.status));assert(body.operation);const id=body.operation.batchId;
            if(response.status===202){
              const deadline=Date.now()+20000;
              do{
                await new Promise(resolve=>setTimeout(resolve,500));
                if(failure)throw failure;const status=await webBatch(new NextRequest('http://localhost/api/files/operations/batches/'+id,{headers}),{params:Promise.resolve({batchId:id})});
                assert.equal(status.status,200);body=await status.json();assert(body.operation);assert.equal(body.operation.batchId,id);
              }while(['queued','applying'].includes(body.operation!.status)&&Date.now()<deadline);
              if(['queued','applying'].includes(body.operation!.status))throw new Error('Physical5 authority fault/resume did not reach a terminal ordinary worker response.');
            }
            if(failure)throw failure;return {response,body};
          }finally{stopped=true;await pumping;if(failure)throw failure;}
        };
        let deniedOwner:MetadataSqlEvent['client']|undefined,deniedBatchId:string|undefined;
        let witness:{pid:number;start:string;xid:string}|undefined,originalBinding:unknown;
        let baseline:Awaited<ReturnType<typeof snapshot>>|undefined,files:Awaited<ReturnType<typeof filesystem>>|undefined;
        let injectedAuthDML=0,domainDML=0,notifications=0,rolledBack=false;
        const registryRead=`SELECT pg_catalog.to_jsonb(d) AS row FROM "${h.schema}".collaboration_documents d
          WHERE workspace_id=$1 AND path=$2 AND status='active' ORDER BY id LIMIT 2 FOR UPDATE NOWAIT`.replace(/\s+/gu,' ').trim();
        const denied=await h.withProbe(async event=>{
          if(deniedOwner===event.client&&injectedAuthDML&&!rolledBack){
            assert(!/^\s*COMMIT\s*$/iu.test(event.text),'A revoked preparation transaction cannot commit.');
            if(/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE|CREATE|ALTER|DROP)\b/iu.test(event.text))domainDML++;
            if(/\bpg_notify\s*\(/iu.test(event.text))notifications++;
            if(/^\s*ROLLBACK\s*$/iu.test(event.text)){
              assert.equal(event.result.command,'ROLLBACK');assert(witness);
              const ended=(await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema,to_regnamespace(current_schema())::oid::text AS schema_oid
                FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
              assert.equal(Number(ended.pid),witness.pid);assert.equal(ended.start,witness.start);assert.equal(ended.xid,null);
              assert.equal(ended.schema,h.schema);assert.equal(ended.schema_oid,h.schemaOid);rolledBack=true;
            }
          }
          if(injectedAuthDML||event.text.replace(/\s+/gu,' ').trim()!==registryRead
            ||event.values.length!==2||event.values[0]!==h.source.workspaceId||event.values[1]!==deniedSeed.sourcePath)return;
          assert.equal(event.result.command,'SELECT');assert.equal(event.result.rowCount,1);assert.equal(event.result.rows[0].row.id,deniedSeed.selectedId);
          const actual=(await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
            pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema,to_regnamespace(current_schema())::oid::text AS schema_oid
            FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
          assert.equal(actual.schema,h.schema);assert.equal(actual.schema_oid,h.schemaOid);assert.match(actual.xid,/^[0-9]{1,32}$/u);assert.match(actual.start,/^[0-9]+\.[0-9]+$/u);assert(Number.isSafeInteger(Number(actual.pid)));
          deniedOwner=event.client;witness={pid:Number(actual.pid),start:actual.start,xid:actual.xid};
          const bindings=(await event.raw(`SELECT batch_id,plan_id,workspace_id,plan_json,authorization_json,created_at,total_actions,action_mode
            FROM workspace_file_operation_batches WHERE workspace_id=$1 AND plan_id=$2 AND status='applying'`,[h.source.workspaceId,deniedPreview.plan.planId])).rows;
          assert.equal(bindings.length,1);originalBinding=bindings;deniedBatchId=bindings[0].batch_id;
          const authorization=JSON.parse(bindings[0].authorization_json),plan=JSON.parse(bindings[0].plan_json);
          assert.equal(authorization.mode,'direct');assert.equal(authorization.actorType,'user');assert.equal(authorization.actorUserId,'member');
          assert.equal(plan.version,5);assert.equal(plan.kind,'physical-original-delete');assert.equal(plan.pathSteps[0].sourcePath,deniedSeed.sourcePath);
          baseline=await snapshot();delete baseline.rows.workspace_file_operation_batches;files=await filesystem();
          const banned=await event.raw(`UPDATE "${h.schema}"."user" SET banned=1 WHERE id='member' AND banned=0 RETURNING id,banned`);
          assert.equal(banned.rowCount,1);assert.equal(banned.rows[0].id,'member');assert.equal(Number(banned.rows[0].banned),1);injectedAuthDML++;
        },()=>driveDeniedWeb(()=>webDelete(new NextRequest('http://localhost/api/files/delete',{method:'DELETE',headers,
          body:JSON.stringify({path:deniedSeed.sourcePath,planId:deniedPreview.plan.planId,idempotencyKey:crypto.randomUUID()})}))));
        assert(deniedOwner&&witness&&deniedBatchId&&baseline&&files&&originalBinding);assert.equal(injectedAuthDML,1);assert.equal(rolledBack,true);
        assert.equal(domainDML,0);assert.equal(notifications,0);assert.equal(denied.body.operation.batchId,deniedBatchId);
        assert.equal(denied.body.operation.status,'failed');assert.equal(denied.body.operation.errorCode,'PRINCIPAL_AUTH_REVOKED');
        if(denied.response.status===409)assert.equal(denied.body.code,'PRINCIPAL_AUTH_REVOKED');
        assert.equal(Number((await h.admin.query('SELECT banned FROM "user" WHERE id=$1',['member'])).rows[0].banned),0);
        const afterDenied=await snapshot();delete afterDenied.rows.workspace_file_operation_batches;assert.deepEqual(afterDenied,baseline);
        assert.deepEqual(await filesystem(),files);assert.deepEqual(await physicalRows(deniedBatchId),{intent:[],completion:[],trash:[]});
        assert.deepEqual((await h.admin.query(`SELECT batch_id,plan_id,workspace_id,plan_json,authorization_json,created_at,total_actions,action_mode
          FROM workspace_file_operation_batches WHERE batch_id=$1`,[deniedBatchId])).rows,originalBinding);
        const resumed=await driveDeniedWeb(()=>resumeWebBatch(new NextRequest('http://localhost/api/files/operations/batches/'+deniedBatchId,
          {method:'POST',headers,body:JSON.stringify({action:'resume',planId:deniedPreview.plan.planId})}),{params:Promise.resolve({batchId:deniedBatchId!})}));
        assert.equal(resumed.response.status,202);assert.equal(resumed.body.success,true);assert.equal(resumed.body.operation.batchId,deniedBatchId);
        assert.equal(resumed.body.operation.planId,deniedPreview.plan.planId);assert.equal(resumed.body.operation.status,'applied');
        await checkPhysicalCompletion(deniedSeed,deniedBatchId,'direct');
        const historicalRows=await physicalRows(deniedBatchId);
        const historical=await withSettledProjectionReadBoundary(()=>noMutation(()=>webBatch(new NextRequest('http://localhost/api/files/operations/batches/'+deniedBatchId,{headers}),
          {params:Promise.resolve({batchId:deniedBatchId!})})));
        assert.equal(historical.status,200);assert.equal((await historical.json()).operation.status,'applied');assert.deepEqual(await physicalRows(deniedBatchId),historicalRows);
      }
      const previewResponse=await withSettledProjectionReadBoundary(()=>noMutation(()=>webDelete(new NextRequest('http://localhost/api/files/delete',{method:'DELETE',headers,body:JSON.stringify({path:seed.sourcePath,dryRun:true})}))));
      assert.equal(previewResponse.status,200);const preview=await previewResponse.json();assert.equal(preview.plan.version,2);assert.equal(preview.plan.kind,'native-original-delete');
      const worker=createWorkspaceOperationBatchWorker({store});let stop=false,workerFailure:unknown;
      const pending=webDelete(new NextRequest('http://localhost/api/files/delete',{method:'DELETE',headers,
        body:JSON.stringify({path:seed.sourcePath,planId:preview.plan.planId,idempotencyKey:crypto.randomUUID()})}));
      const pump=(async()=>{try{while(!stop){await worker.tick();if(!stop)await new Promise(resolve=>setTimeout(resolve,25));}}catch(error){workerFailure=error;}})();
      try{
        const response=await pending;let body=await response.json() as WorkspacePathOperationResponse&{success:boolean;code?:unknown};
        if(![200,202].includes(response.status))console.error(JSON.stringify({test:'physical-web-delete-response',status:response.status,
          code:typeof body.code==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/u.test(body.code)?body.code:'UNCLASSIFIED'}));
        assert([200,202].includes(response.status),'Physical Web DELETE must return success or an accepted durable job.');
        assert.equal(body.success,true);assert(body.operation);const batchId=body.operation.batchId;
        if(response.status===202){
          const deadline=Date.now()+20000;
          do{
            await new Promise(resolve=>setTimeout(resolve,500));
            if(workerFailure)throw workerFailure;const credentials=await h.request(h.source,'member',true,currentRequestToken);
            const status=await webBatch(new NextRequest('http://localhost/api/files/operations/batches/'+batchId,{headers:credentials.headers}),{params:Promise.resolve({batchId})});
            assert.equal(status.status,200);body=await status.json();assert(body.operation);assert.equal(body.operation.batchId,batchId);
          }while(['queued','applying'].includes(body.operation!.status)&&Date.now()<deadline);
          if(['queued','applying'].includes(body.operation!.status))throw new Error('Physical5 queued Web DELETE did not reach a real terminal batch response.');
        }
        assert.equal(body.operation!.status,'applied');assert.deepEqual(body.deleted,[seed.sourcePath]);assert.equal(body.linkStatus,'complete');
        assert.equal(body.linkUpdates?.updatedLinks,2);assert.deepEqual([...body.linkUpdates!.updatedFiles].sort(),[seed.incomingBefore.path,seed.htmlBefore.path].sort());
        assert.equal(body.trashEntries?.length,1);await checkPhysicalCompletion(seed,batchId,'direct');
      }finally{stop=true;await pump;}
      if(workerFailure)throw workerFailure;
    });
    await check('Physical5 real rename fault, revoked grant and genuine SID-B recover original pristine PDF once',async()=>{
      // Obtain a genuine current principal before the separately observed pure
      // preview; the focused case must initialize its own authorization path.
      await run('delete',currentToken,h.source.workspaceId,live=>freshScope(live));
      const seed=await seedPhysical('pdf',true),preview=await previewPhysical(seed),operationId=crypto.randomUUID();
      const batchId=physicalBatchId({userId:'member',clientId,workspaceId:h.source.workspaceId,tool:'delete_knowledge_source',operationId});
      let faulted=false,intentBefore:PhysicalIntent|undefined,stageRows:Awaited<ReturnType<typeof physicalRows>>|undefined;
      await assert.rejects(h.withProbe(async event=>{
        if(faulted||!/^\s*SELECT\b/iu.test(event.text)||!event.text.includes('workspace_file_operation_delete_intents')
          ||!/\bFOR\s+SHARE\s+NOWAIT\s*$/iu.test(event.text)||event.values[0]!==batchId||event.result.rowCount!==1
          ||!Object.hasOwn(event.result.rows[0],'intentText'))return;
        const sourcePresent=await fs.lstat(path.join(h.source.rootPath,seed.sourcePath)).then(()=>true,error=>{assert.equal((error as NodeJS.ErrnoException).code,'ENOENT');return false;});
        if(sourcePresent)return;
        stageRows=await physicalRows(batchId);assert.equal(stageRows.intent.length,1);assert.equal(stageRows.completion.length,0);assert.equal(stageRows.trash.length,0);
        intentBefore=JSON.parse(JSON.parse(stageRows.intent[0].body).intent_text) as PhysicalIntent;assert.equal(intentBefore.version,7);
        assert.equal(event.result.rows[0].intentText,JSON.parse(stageRows.intent[0].body).intent_text);
        const witness=(await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema')).rows[0];
        assert(witness.xid);assert.equal(witness.schema,h.schema);
        const moved=await fs.lstat(path.join(h.dataRoot,intentBefore.physical.trashRelativePath));assert.equal(moved.dev,seed.beforeFile.dev);assert.equal(moved.ino,seed.beforeFile.ino);
        assert.deepEqual(await fs.readFile(path.join(h.dataRoot,intentBefore.physical.trashRelativePath)),seed.bytes);faulted=true;
        throw Object.assign(new Error('Physical5 actual rename completed before B2 domain mutation.'),{code:'FIXTURE_PHYSICAL5_AFTER_RENAME'});
      },()=>physicalCall('apply',seed,operationId,preview.planId)),rejected('FIXTURE_PHYSICAL5_AFTER_RENAME'));
      assert(faulted&&stageRows&&intentBefore);assert.deepEqual(await physicalRows(batchId),stageRows);
      assert.deepEqual((await h.admin.query('SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM collaboration_documents t WHERE id=$1',[seed.selectedId])).rows,seed.rawRegistry);
      assert.deepEqual((await h.admin.query('SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM file_collaboration_lineages t WHERE id=$1',[seed.selectedLineage])).rows,seed.rawLineage);
      assert.deepEqual(await load(h.connection,seed.incoming.documentId),seed.incomingBefore);assert.deepEqual(await load(h.connection,seed.html.documentId),seed.htmlBefore);
      const original=(await store.get(batchId))!.authorization;assert(original.mode==='direct-mcp');const sidA=original.actorSessionId;
      assert.equal((await h.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 AND user_id=$2 AND workspace_id=$3 RETURNING client_id',[clientId,'member',h.source.workspaceId])).rowCount,1);
      try{
        await withSettledProjectionReadBoundary(()=>noMutation(()=>assert.rejects(physicalCall('recover',seed,operationId,preview.planId),rejected('MCP_READ_PRINCIPAL_ACCESS_DENIED'))));
        assert.deepEqual(await physicalRows(batchId),stageRows);
      }finally{
        assert.equal((await h.admin.query('INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,$2,$3,100,100) RETURNING client_id',[clientId,'member',h.source.workspaceId])).rowCount,1);
      }
      // Revoke the actual tool after the fixed B2 domain has read its prior
      // receipt, before its first unlink/archive/annotation mutation. The new
      // read grouping must not cache authority across this boundary.
      const originalTools=process.env.CANVAS_MCP_DIRECT_TOOLS;assert.equal(typeof originalTools,'string');
      let revokedAfterRead=false,b2WritesAfterRead=0,b2NotificationsAfterRead=0;
      let b2Client:MetadataSqlEvent['client']|undefined,b2Baseline:Awaited<ReturnType<typeof snapshot>>|undefined;
      let b2Marker:{client:MetadataSqlEvent['client'];pid:number;start:string;xid:string}|undefined;
      const expectedB2Targets=intentBefore.currentWitness.nativeComponent.nativeBindings.map(item=>item.expected.documentId).sort();
      assert(expectedB2Targets.includes(seed.incoming.documentId)&&expectedB2Targets.includes(seed.html.documentId));
      try {
        await assert.rejects(h.withProbe(async event=>{
          if(b2Marker&&event.client===b2Marker.client&&/^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(event.text))b2Marker=undefined;
          if(event.text.replace(/\s+/gu,' ').trim()==='SELECT document_id FROM collaboration_admission_targets WHERE request_id = $1 ORDER BY document_id FOR UPDATE'
            &&event.values.length===1&&event.values[0]===intentBefore!.admission.requestId){
            assert.equal(b2Marker,undefined);assert.equal(event.result.command,'SELECT');
            assert.deepEqual(event.result.rows.map(item=>item.document_id),expectedB2Targets);
            const witness=(await event.raw('SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema,pg_catalog.to_regnamespace(current_schema())::oid::text AS schema_oid FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
            assert(witness.xid);assert.equal(witness.schema,h.schema);assert.equal(witness.schema_oid,h.schemaOid);
            b2Marker={client:event.client,pid:Number(witness.pid),start:witness.start,xid:witness.xid};return;
          }
          if(b2Marker&&event.client===b2Marker.client){
            if(/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE|CREATE|ALTER|DROP)\b/iu.test(event.text))b2WritesAfterRead++;
            if(/\bpg_notify\s*\(/iu.test(event.text))b2NotificationsAfterRead++;
          }
          if(revokedAfterRead)return;
          if(!b2Marker||event.client!==b2Marker.client||!/^\s*SELECT\b/iu.test(event.text)||!event.text.includes('"'+h.schema+'".workspace_file_operation_delete_receipts')
            ||!/\bFOR\s+SHARE\s+NOWAIT\s*$/iu.test(event.text)||event.values.length!==1||event.values[0]!==batchId)return;
          assert.equal(event.result.rowCount,0);assert.equal(b2WritesAfterRead,0);assert.equal(b2NotificationsAfterRead,0);
          const witness=(await event.raw('SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema,pg_catalog.to_regnamespace(current_schema())::oid::text AS schema_oid FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
          assert.equal(Number(witness.pid),b2Marker.pid);assert.equal(witness.start,b2Marker.start);assert.equal(witness.xid,b2Marker.xid);
          assert.equal(witness.schema,h.schema);assert.equal(witness.schema_oid,h.schemaOid);b2Client=event.client;
          b2Baseline=await snapshot();delete b2Baseline.rows.workspace_file_operation_batches;
          await absent(path.join(h.source.rootPath,seed.sourcePath));
          assert.deepEqual(await fs.readFile(path.join(h.dataRoot,intentBefore!.physical.trashRelativePath)),seed.bytes);
          process.env.CANVAS_MCP_DIRECT_TOOLS=originalTools!.split(',').filter(tool=>tool.trim()!=='delete_knowledge_source').join(',');
          revokedAfterRead=true;
        },()=>physicalCall('recover',seed,operationId,preview.planId)),rejected('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
      }finally{
        process.env.CANVAS_MCP_DIRECT_TOOLS=originalTools;
      }
      assert(revokedAfterRead&&b2Baseline&&b2Client);assert.equal(b2WritesAfterRead,0);assert.equal(b2NotificationsAfterRead,0);
      const deniedAfterRead=await snapshot();delete deniedAfterRead.rows.workspace_file_operation_batches;
      assert.deepEqual(deniedAfterRead,b2Baseline);assert.deepEqual(await physicalRows(batchId),stageRows);
      const old=await rotate();assert.notEqual(currentSession,sidA);
      await assert.rejects(physicalPublicDelete(physicalDeleteRequest({api_version:1,action:'recover',workspace_id:h.source.workspaceId,path:seed.sourcePath,operation_id:operationId,plan_id:preview.planId}),authInfo(old)),rejected('invalid_token'));
      // A later live occupant is never adopted as the original pending file.
      const d2=Buffer.from('Independent D2 before pending Physical5 recovery\n');
      await fs.writeFile(path.join(h.source.rootPath,seed.sourcePath),d2,{flag:'wx',mode:0o600});
      const beforeD2=await snapshot(),d2Files=await filesystem();
      const mutableRetryTables=['workspace_file_operation_batches','collaboration_admission_requests','collaboration_admission_scopes','collaboration_admission_targets'];
      for(const table of mutableRetryTables)delete beforeD2.rows[table];
      const originalAdmission=(await h.admin.query('SELECT request_id,request_digest,intent_text FROM collaboration_admission_requests WHERE request_id=$1',[intentBefore.admission.requestId])).rows;
      // The existing prepared source-vacancy contract reports source-changed;
      // the exact original payload and all later-D2 bytes remain unchanged.
      await assert.rejects(physicalCall('recover',seed,operationId,preview.planId),rejected('source-changed'));
      const afterD2=await snapshot();for(const table of mutableRetryTables)delete afterD2.rows[table];
      assert.deepEqual((await h.admin.query('SELECT request_id,request_digest,intent_text FROM collaboration_admission_requests WHERE request_id=$1',[intentBefore.admission.requestId])).rows,originalAdmission);
      assert.deepEqual(afterD2,beforeD2);assert.deepEqual(await filesystem(),d2Files);assert.deepEqual(await physicalRows(batchId),stageRows);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath,seed.sourcePath)),d2);await fs.unlink(path.join(h.source.rootPath,seed.sourcePath));
      const recovered=await physicalCall('recover',seed,operationId,preview.planId);assert(recovered.action==='recover');
      // Capture the complete state only after the real projector finalized its
      // checkpoint; the historical retry must then preserve every field.
      const checked=await withSettledProjectionReadBoundary(()=>checkPhysicalCompletion(seed,batchId));assert.deepEqual(checked.batch.authorization,original);assert.deepEqual(checked.rows.intent,stageRows.intent);
      await withSettledProjectionReadBoundary(()=>noMutation(()=>physicalCall('apply',seed,operationId,preview.planId)));
      assert.deepEqual(await physicalRows(batchId),checked.rows);assert.deepEqual(await load(h.connection,seed.incoming.documentId),checked.incomingAfter);
    });
    await check('Physical5 actual completion ACK loss and later physical D2 retain original SID and all receipt bytes',async()=>{
      const seed=await seedPhysical('png',false),preview=await previewPhysical(seed),operationId=crypto.randomUUID();
      const batchId=physicalBatchId({userId:'member',clientId,workspaceId:h.source.workspaceId,tool:'delete_knowledge_source',operationId});
      let client:MetadataSqlEvent['client']|undefined,committed=false;
      await assert.rejects(h.withProbe(async event=>{
        if(!client&&/^\s*INSERT\s+INTO\b/iu.test(event.text)&&event.text.includes('workspace_file_operation_delete_receipts')&&event.values[0]===batchId&&event.result.rowCount===1)client=event.client;
        if(committed||event.client!==client||!/^\s*COMMIT\s*$/iu.test(event.text))return;
        assert.equal(event.result.command,'COMMIT');const witness=(await event.raw('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0];assert.equal(witness.xid,null);
        const rows=await physicalRows(batchId);assert.equal(rows.completion.length,1);assert.equal(rows.trash.length,1);committed=true;
        throw Object.assign(new Error('Lost actual Physical5 completion acknowledgement.'),{code:'FIXTURE_PHYSICAL5_ACK_LOST'});
      },()=>physicalCall('apply',seed,operationId,preview.planId)),rejected('JOB_LIFECYCLE_COMMIT_UNCONFIRMED'));
      assert(committed);const rows=await physicalRows(batchId),batch=await store.get(batchId);assert(batch&&batch.authorization.mode==='direct-mcp');
      const original=batch.authorization,oldSid=original.actorSessionId,replacement=Buffer.from('Later unrelated physical D2\n');
      await fs.writeFile(path.join(h.source.rootPath,seed.sourcePath),replacement,{flag:'wx',mode:0o600});const replacementIdentity=await fs.lstat(path.join(h.source.rootPath,seed.sourcePath));
      await rotate();assert.notEqual(currentSession,oldSid);
      await physicalCall('recover',seed,operationId,preview.planId);
      const historical=await store.get(batchId);assert(historical);assert.equal(historical.status,'applied');assert.deepEqual(historical.authorization,original);
      await withSettledProjectionReadBoundary(async()=>{
        const filesBefore=await filesystem();await noMutation(()=>physicalCall('apply',seed,operationId,preview.planId));
        assert.deepEqual(await physicalRows(batchId),rows);assert.deepEqual(await filesystem(),filesBefore);assert.deepEqual(await fs.readFile(path.join(h.source.rootPath,seed.sourcePath)),replacement);
      });
      const after=await fs.lstat(path.join(h.source.rootPath,seed.sourcePath));assert.equal(after.dev,replacementIdentity.dev);assert.equal(after.ino,replacementIdentity.ino);
      const intent=JSON.parse(JSON.parse(rows.intent[0].body).intent_text) as PhysicalIntent;
      assert.deepEqual(await fs.readFile(path.join(h.dataRoot,intent.physical.trashRelativePath)),seed.bytes);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_trash_entries WHERE workspace_id=$1 AND original_path=$2',[h.source.workspaceId,seed.sourcePath])).rows[0].n,1);
    });
    await check('Physical5 affected and opaque HTML block real public preview/apply with no SQL or FS effects',async()=>{
      const seed=await seedPhysical('png',false),affected='physical5-affected-'+crypto.randomUUID()+'.md',opaque='physical5-opaque-'+crypto.randomUUID()+'.html';
      await h.upload(affected,Buffer.from('<img src="'+seed.sourcePath+'">\n'));
      await fs.writeFile(path.join(h.source.rootPath,opaque),Buffer.from('<iframe src="'+seed.sourcePath+'"></iframe>'),{flag:'wx',mode:0o600});
      try{
        const result=await withSettledProjectionReadBoundary(()=>noMutation(()=>physicalPublicDelete(physicalDeleteRequest({api_version:1,action:'preview',workspace_id:h.source.workspaceId,path:seed.sourcePath}),authInfo(currentToken))));
        assert(result.action==='preview'&&result.preview.kind==='native-path-html-assessment');assert.equal(result.preview.version,3);assert.equal(result.preview.readiness,'blocked');
        assert.equal(result.preview.coverage.complete,false);assert.equal(result.preview.linkAssessment.complete,false);
        assert(result.preview.linkAssessment.blockers.some(issue=>issue.path===affected&&issue.code==='affected-html-link'));
        assert(result.preview.linkAssessment.blockers.some(issue=>issue.path===opaque&&issue.code==='unevaluated-link'));
        await withSettledProjectionReadBoundary(()=>noMutation(()=>assert.rejects(physicalCall('apply',seed,crypto.randomUUID(),result.preview.planId),rejected('PATH_NATIVE_REQUIRED'))));
        assert.deepEqual(await fs.readFile(path.join(h.source.rootPath,seed.sourcePath)),seed.bytes);
        assert.deepEqual(await load(h.connection,seed.incoming.documentId),seed.incomingBefore);assert.deepEqual(await load(h.connection,seed.html.documentId),seed.htmlBefore);
      }finally{await fs.unlink(path.join(h.source.rootPath,opaque));}
    });
    await check('HTML Delete4: affected native and opaque physical HTML block public preview/apply before every domain or FS mutation', async () => {
      const { runDirectMcpWorkspaceDeleteService: publicDelete } = await import('../app/lib/files/workspace-operation-mcp-path-service');
      const { decodeDirectMcpWorkspaceDeleteRequestV1: requestDelete } = await import('../app/lib/mcp/server/workspace-path-tool-contract');
      const job = await seed('delete'), prefix = 'html-delete-block-' + crypto.randomUUID();
      const affectedPath = prefix + '-affected.md', opaquePath = prefix + '.html';
      await h.upload(affectedPath, Buffer.from('<p><a href="' + job.sourcePath + '">Affected</a></p>\n'));
      await fs.writeFile(path.join(h.source.rootPath, opaquePath), Buffer.from('<iframe src="' + job.sourcePath + '"></iframe>\n'),
        { mode: 0o600, flag: 'wx' });
      const targetBefore = await load(h.connection, job.targetId); assert(targetBefore);
      const preview = await withSettledProjectionReadBoundary(() => noMutation(() => publicDelete(requestDelete({ api_version: 1, action: 'preview',
        workspace_id: h.source.workspaceId, path: job.sourcePath }), authInfo(currentToken))));
      assert.equal(preview.action, 'preview'); assert(preview.action === 'preview');
      assert.equal(preview.preview.kind, 'native-path-html-assessment'); assert(preview.preview.kind === 'native-path-html-assessment');
      assert.equal(preview.preview.version, 3); assert.equal(preview.preview.readiness, 'blocked');
      assert.equal(preview.preview.coverage.complete, false); assert.equal(preview.preview.linkAssessment.complete, false);
      assert(preview.preview.linkAssessment.blockers.some(item => item.path === affectedPath && item.code === 'affected-html-link'));
      assert(preview.preview.linkAssessment.blockers.some(item => item.path === opaquePath && item.code === 'unevaluated-link'));
      const operationId = crypto.randomUUID();
      await withSettledProjectionReadBoundary(() => noMutation(() => assert.rejects(publicDelete(requestDelete({ api_version: 1, action: 'apply',
        workspace_id: h.source.workspaceId, path: job.sourcePath, operation_id: operationId, plan_id: preview.preview.planId }),
      authInfo(currentToken)), rejected('PATH_NATIVE_REQUIRED'))));
      assert.equal((await load(h.connection, job.targetId))!.status, 'active');
      assert.deepEqual(Buffer.from((await load(h.connection, job.targetId))!.yjsState), Buffer.from(targetBefore.yjsState));
      // This deliberately opaque fixture blocks every later operation. Retire
      // only this case's wx-created file after every unchanged NoMutation check.
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, opaquePath)),
        Buffer.from('<iframe src="' + job.sourcePath + '"></iframe>\n'));
      await fs.unlink(path.join(h.source.rootPath, opaquePath));
      await absent(path.join(h.source.rootPath, opaquePath));
    });
    } catch (error) { htmlDeleteRoomFailure = error; throw error; }
    finally {
      try { await htmlDeleteRooms.close(); }
      catch (cleanup) { throw htmlDeleteRoomFailure === undefined ? cleanup
        : new AggregateError([htmlDeleteRoomFailure, cleanup], 'HTML Delete assertion and owned runtime closure failed.'); }
    }
    await check('current expired session denies historical status and existing claim with zero domain/FS changes', async () => {
      assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [currentSession])).rowCount, 1);
      const before = await snapshot(), files = await filesystem();
      await assert.rejects(run('move', currentToken, h.source.workspaceId, async live => { await status(moved!, live); }), rejected('invalid_token'));
      await assert.rejects(run('delete', currentToken, h.source.workspaceId, async live => { await existing(deleted!, live); }), rejected('invalid_token'));
      assert.deepEqual(await snapshot(), before); assert.deepEqual(await filesystem(), files);
    });
    await check('HTML Delete E6: actual archive CAS faults roll back all B2 effects and SID-B recovers the same Original exactly once', async () => {
      const { executeWorkspaceOperationOriginalDelete } = await import('../app/lib/files/workspace-operation-original-delete');
      const { inspectPersistedDocumentLinksV4 } = await import('../app/lib/markdown/workspace-native-link-inventory');
      // The last original family genuinely expires its session. A focused run
      // omits it; both modes obtain their own real successor session here.
      await rotate();
      const archiveRoom = await startNativePathRoomRuntime();
      try {
        await withSettledProjectionReadBoundary(async () => undefined);
        for (const stopAfter of [1, 4] as const) {
          const prefix = 'archive-negative-' + crypto.randomUUID(), sourcePath = prefix + '-target.md';
          const incomingPath = prefix + '-incoming.md', htmlPath = prefix + '-html.md', pagePath = prefix + '.html';
          const sourceBytes = Buffer.from('# Original target\n\nActual native body.\n'), title = 'Archive negative ' + prefix;
          const target = await h.upload(sourcePath, sourceBytes);
          const incomingDocument = await h.upload(incomingPath, Buffer.from('[Original](' + sourcePath + ')\n'));
          const html = await h.upload(htmlPath, Buffer.from('[Original](' + sourcePath + ')\n\n<p>Unrelated HTML remains exact</p>\n'));
          await fs.writeFile(path.join(h.source.rootPath, pagePath), '<p>Unrelated physical HTML</p>\n', { mode: 0o600, flag: 'wx' });
          await h.metadata(h.source, sourcePath, { title, isFavorite: true, pinned: true }, 'member', currentRequestToken);
          await withSettledProjectionReadBoundary(async () => undefined);
          const sourceIdentity = await fs.stat(path.join(h.source.rootPath, sourcePath)); assert(sourceIdentity.isFile());
          const beforeTarget = await load(h.connection, target.documentId), beforeIncoming = await load(h.connection, incomingDocument.documentId);
          const beforeHtml = await load(h.connection, html.documentId); assert(beforeTarget && beforeIncoming && beforeHtml);
          const lineage = (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [target.documentId])).rows;
          assert.equal(lineage.length, 1);
          const job: Job = await run('delete', currentToken, h.source.workspaceId, async (live): Promise<Job> => {
            const scope = await freshScope(live), plan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: crypto.randomUUID(),
              kind: 'delete', selections: [{ sourcePath }] }] });
            assert(plan.version === 2 && plan.planIdentityVersion === 4);
            assert.equal(plan.sourceEvidence.evidenceVersion, 5); assert.equal(plan.linkAssessment.complete, true);
            return { kind: 'delete', operationId: crypto.randomUUID(), plan, scope, sourcePath, destinationPath: prefix + '-unused.md',
              incomingPath, pdfPath: null, destinationPdf: null, pdf: null, targetId: target.documentId, incomingId: incomingDocument.documentId,
              lineageId: lineage[0].lineage_id, generation: target.lifecycleGeneration, title,
              originalBinary: Buffer.from(beforeTarget.yjsState), originalVector: Buffer.from(beforeTarget.stateVector) };
          });
          type E6 = Extract<import('../app/lib/files/workspace-operation-original-delete-evidence').OriginalIntent, { version: 6 }>;
          let intent: E6 | undefined, original: Awaited<ReturnType<typeof immutableBatch>> | undefined;
          let committedIntent: Awaited<ReturnType<typeof row>> | undefined, baseline: Awaited<ReturnType<typeof snapshot>> | undefined;
          let faultFiles: Awaited<ReturnType<typeof filesystem>> | undefined, ownerClient: MetadataSqlEvent['client'] | undefined;
          let stageWitness: { pid: number; start: string; xid: string } | undefined;
          let b2Witness: { pid: number; start: string; xid: string } | undefined;
          let committed = false, injected = false, archiveWrites = 0, b2Notifications = 0;
          const expectedTables = ['collaboration_yjs_states', 'collaboration_documents', 'file_collaboration_lineages', 'collaboration_file_projections'];
          await assert.rejects(run('delete', currentToken, h.source.workspaceId, async live => {
            await create(job, live); assert(job.batch);
            return store.withClaim(job.batch, async claim => {
              const ready = await advanceWorkspaceOperationNativePathAdmission(claim, { mcpPrincipal: live }); assert.equal(ready.status, 'ready');
              try {
                return await h.withProbe(async event => {
                  if (/^\s*INSERT\s+INTO\b/iu.test(event.text) && event.text.includes(intentTable(job))
                    && event.values[0] === job.batch!.batchId && event.result.rowCount === 1) {
                    assert.equal(ownerClient, undefined); ownerClient = event.client;
                    const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                      pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema,
                      pg_catalog.to_regnamespace(current_schema())::oid::text AS schema_oid
                      FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
                    assert.equal(actual.schema, h.schema); assert.equal(actual.schema_oid, h.schemaOid); assert(actual.xid);
                    stageWitness = { pid: Number(actual.pid), start: actual.start, xid: actual.xid };
                    committedIntent = (await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
                      FROM workspace_file_operation_delete_intents t WHERE batch_id=$1`, [job.batch!.batchId])).rows;
                    assert.equal(committedIntent.length, 1); assert.equal((await row(intentTable(job), job.batch!.batchId)).length, 0);
                  }
                  if (event.client !== ownerClient) return;
                  if (/^\s*COMMIT\s*$/iu.test(event.text) && !committed) {
                    assert(stageWitness && committedIntent); assert.equal(event.result.command, 'COMMIT');
                    const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                      pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
                    assert.equal(Number(actual.pid), stageWitness.pid); assert.equal(actual.start, stageWitness.start); assert.equal(actual.xid, null);
                    assert.deepEqual(await row(intentTable(job), job.batch!.batchId), committedIntent);
                    intent = JSON.parse(JSON.parse(committedIntent[0].body).intent_text) as E6;
                    assert.equal(intent.version, 6); assert.equal(intent.currentWitness.evidenceVersion, 5); assert.equal(intent.nativeLinks.length, 2);
                    original = await immutableBatch(job); baseline = await snapshot(); delete baseline.rows.workspace_file_operation_batches;
                    committed = true; return;
                  }
                  if (!committed || !intent || injected) return;
                  if (/\bpg_notify\s*\(/iu.test(event.text)) b2Notifications++;
                  const match = /^\s*(?:UPDATE|INSERT\s+INTO)\s+"[^"]+"\.(collaboration_yjs_states|collaboration_documents|file_collaboration_lineages|collaboration_file_projections)\b/iu.exec(event.text);
                  if (!match || !event.values.includes(job.targetId) && !event.values.includes(job.lineageId)) return;
                  assert.equal(match[1], expectedTables[archiveWrites]); assert.equal(event.result.rowCount, 1); archiveWrites++;
                  if (archiveWrites !== stopAfter) return;
                  assert(stageWitness && baseline);
                  const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                    pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema,
                    pg_catalog.to_regnamespace(current_schema())::oid::text AS schema_oid
                    FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
                  assert.equal(actual.schema, h.schema); assert.equal(actual.schema_oid, h.schemaOid);
                  assert.equal(Number(actual.pid), stageWitness.pid); assert.equal(actual.start, stageWitness.start);
                  assert(actual.xid); assert.notEqual(actual.xid, stageWitness.xid);
                  b2Witness = { pid: Number(actual.pid), start: actual.start, xid: actual.xid };
                  const states = (await event.raw(`SELECT s.status AS state_status,d.status AS registry_status,l.status AS lineage_status,
                    s.lifecycle_generation,p.lifecycle_generation AS projection_generation FROM collaboration_yjs_states s
                    JOIN collaboration_documents d ON d.id=s.document_id JOIN file_collaboration_lineages l ON l.id=d.lineage_id
                    LEFT JOIN collaboration_file_projections p ON p.document_id=d.id WHERE d.id=$1`, [job.targetId])).rows;
                  assert.equal(states.length, 1); assert.equal(states[0].state_status, 'archived');
                  assert.equal(Number(states[0].lifecycle_generation), job.generation + 1);
                  assert.equal(states[0].registry_status, stopAfter === 4 ? 'archived' : 'active');
                  assert.equal(states[0].lineage_status, stopAfter === 4 ? 'archived' : 'active');
                  if (stopAfter === 4) assert.equal(Number(states[0].projection_generation), job.generation + 1);
                  const mutationIds = intent.nativeLinks.map(item => item.prepared.operationId);
                  assert.equal(new Set(mutationIds).size, 2);
                  assert.equal((await event.raw('SELECT operation_id FROM collaboration_native_link_mutation_receipts WHERE operation_id=ANY($1::text[])', [mutationIds])).rowCount, 2);
                  const visible = await snapshot(); delete visible.rows.workspace_file_operation_batches;
                  assert.deepEqual(visible, baseline, 'The independent backend sees no uncommitted unlink or archive effects.');
                  await absent(path.join(h.source.rootPath, job.sourcePath));
                  const payload = path.join(h.dataRoot, intent.physical.trashRelativePath), physical = await fs.stat(payload);
                  assert.equal(physical.dev, sourceIdentity.dev); assert.equal(physical.ino, sourceIdentity.ino);
                  assert.deepEqual(await fs.readFile(payload), sourceBytes); faultFiles = await filesystem();
                  injected = true; throw Object.assign(new Error('Owned fault after an actual E6 archive CAS.'), { code: 'FIXTURE_DELETE6_ARCHIVE_CAS' });
                }, () => executeWorkspaceOperationOriginalDelete(claim, openDb, live));
              } catch (error) {
                assert(await store.finishClaim(job.batch!, { status: 'needs_recovery', phase: 'recovery', errorCode: code(error) ?? 'UNCLASSIFIED' }));
                throw error;
              }
            });
          }), rejected('FIXTURE_DELETE6_ARCHIVE_CAS'));
          assert(injected && committed && intent && committedIntent && original && baseline && faultFiles && b2Witness && job.batch && job.original);
          assert.equal(archiveWrites, stopAfter); assert.equal(b2Notifications, 0);
          const after = await snapshot(); delete after.rows.workspace_file_operation_batches;
          assert.deepEqual(after, baseline, 'All actual B2 writes, including native unlink receipts and partial archive, roll back.');
          assert.deepEqual(await filesystem(), faultFiles); assert.deepEqual(await immutableBatch(job), original);
          assert.deepEqual(await row(intentTable(job), job.batch.batchId), committedIntent);
          assert.equal((await row(receiptTable(job), job.batch.batchId)).length, 0);
          assert.equal((await row('workspace_file_operation_delete_trash_receipts', job.batch.batchId)).length, 0);
          assert.deepEqual(await load(h.connection, job.targetId), beforeTarget);
          assert.deepEqual(await load(h.connection, job.incomingId), beforeIncoming); assert.deepEqual(await load(h.connection, html.documentId), beforeHtml);
          const sidA = job.original.actorSessionId, old = await rotate(); assert.notEqual(currentSession, sidA);
          await assert.rejects(run('delete', old, h.source.workspaceId, live => freshScope(live)), rejected('invalid_token'));
          await recover(job);
          // E6 has a genuine moved physical file; the legacy native_archive
          // completion helper does not describe this payload profile.
          const final = await store.get(job.batch.batchId); assert(final);
          assert.equal(final.status, 'applied'); assert.equal(final.completedActions, 3); assert.equal(final.totalActions, 3);
          assert.deepEqual(final.authorization, job.original); assert.deepEqual(final.trashEntryIds, [intent.physical.trashEntryId]);
          assert(intent.physical.source.kind === 'regular_file'); assert.equal(intent.physical.source.sha256, sha(sourceBytes));
          await absent(path.join(h.source.rootPath, job.sourcePath));
          const payloadPath = path.join(h.dataRoot, intent.physical.trashRelativePath), payloadIdentity = await fs.stat(payloadPath);
          assert(payloadIdentity.isFile()); assert.equal(payloadIdentity.dev, sourceIdentity.dev); assert.equal(payloadIdentity.ino, sourceIdentity.ino);
          assert.deepEqual(await fs.readFile(payloadPath), sourceBytes);
          assert.deepEqual((await h.admin.query('SELECT id,lineage_id,path,status FROM collaboration_documents WHERE id=$1', [job.targetId])).rows,
            [{ id: job.targetId, lineage_id: job.lineageId, path: job.sourcePath, status: 'archived' }]);
          assert.deepEqual((await h.admin.query('SELECT id,path,status,trash_entry_id FROM file_collaboration_lineages WHERE id=$1', [job.lineageId])).rows,
            [{ id: job.lineageId, path: job.sourcePath, status: 'archived', trash_entry_id: intent.physical.trashEntryId }]);
          const trash = (await h.admin.query('SELECT id,status,original_path,metadata_json FROM workspace_trash_entries WHERE workspace_id=$1 AND original_path=$2',
            [h.source.workspaceId, job.sourcePath])).rows; assert.equal(trash.length, 1);
          assert.equal(trash[0].id, intent.physical.trashEntryId); assert.equal(trash[0].status, 'trashed');
          assert.equal(trash[0].original_path, job.sourcePath); assert.equal(JSON.parse(trash[0].metadata_json).payloadKind, 'file');
          assert.deepEqual((await h.admin.query('SELECT path FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2',
            [h.source.workspaceId, job.sourcePath])).rows, []);
          assert.deepEqual((await h.admin.query('SELECT path FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2',
            [h.source.workspaceId, job.sourcePath])).rows, []);
          assert.equal(job.original.actorSessionId, sidA); assert.deepEqual(await immutableBatch(job), original);
          assert.deepEqual(await row(intentTable(job), job.batch.batchId), committedIntent);
          const completedRows = await row(receiptTable(job), job.batch.batchId); assert.equal(completedRows.length, 1);
          const completion = JSON.parse(JSON.parse(completedRows[0].body).receipt_text);
          assert.equal(completion.version, 6); assert.equal(completion.nativeLinks.length, 2);
          assert.equal(completion.batchId, job.batch.batchId); assert.equal(completion.trashEntryId, intent.physical.trashEntryId);
          assert.equal(completion.physical.observation.kind, 'moved'); assert.equal(completion.physical.observation.sha256, sha(sourceBytes));
          assert.equal((await row('workspace_file_operation_delete_trash_receipts', job.batch.batchId)).length, 1);
          const archived = await load(h.connection, job.targetId, true), incoming = await load(h.connection, job.incomingId);
          const htmlAfter = await load(h.connection, html.documentId); assert(archived && incoming && htmlAfter);
          assert.equal(archived.status, 'archived'); assert.equal(archived.lifecycleGeneration, job.generation + 1);
          assert.deepEqual(Buffer.from(archived.yjsState), job.originalBinary); assert.deepEqual(Buffer.from(archived.stateVector), job.originalVector);
          assert.equal(incoming.documentSequence, beforeIncoming.documentSequence + 1); assert.equal(htmlAfter.documentSequence, beforeHtml.documentSequence + 1);
          assert.equal(inspectPersistedDocumentLinksV4(incoming).links.length, 0); assert.equal(inspectPersistedDocumentLinksV4(htmlAfter).links.length, 0);
          const mutationIds = intent.nativeLinks.map(item => item.prepared.operationId);
          assert.equal((await h.admin.query('SELECT operation_id FROM collaboration_native_link_mutation_receipts WHERE operation_id=ANY($1::text[])', [mutationIds])).rowCount, 2);
          await withSettledProjectionReadBoundary(() => run('delete', currentToken, h.source.workspaceId, live => noMutation(async () => {
            const known = await existing(job, live); assert.equal(known.kind, 'historical-header');
            const observed = await status(job, live); assert(observed); assert.equal(observed.observation.apply, 'complete');
          })));
          assert.deepEqual(await row(receiptTable(job), job.batch.batchId), completedRows);
        }
      } finally { await archiveRoom.close(); }
    });
    await check('HTML Delete E6: current tool revocation after a genuine B2 domain read denies all effects and SID-B recovers the same Original exactly once', async () => {
      const { executeWorkspaceOperationOriginalDelete } = await import('../app/lib/files/workspace-operation-original-delete');
      const { inspectPersistedDocumentLinksV4 } = await import('../app/lib/markdown/workspace-native-link-inventory');
      const { getDirectMcpRuntimeSettings } = await import('../app/lib/mcp/server/runtime-settings');
      const originalTools = process.env.CANVAS_MCP_DIRECT_TOOLS;
      assert.equal(process.env.CANVAS_MCP_DIRECT_TOOLS_SOURCE, 'environment');
      assert.equal(typeof originalTools, 'string');
      assert((await getDirectMcpRuntimeSettings()).tools.includes('delete_knowledge_source'));
      // The last original family genuinely expires its session. A focused run
      // omits it; both modes obtain their own real successor session here.
      await rotate();
      const groupedReadRoom = await startNativePathRoomRuntime();
      try {
        await withSettledProjectionReadBoundary(async () => undefined);
        const prefix = 'grouped-read-revocation-' + crypto.randomUUID(), sourcePath = prefix + '-target.md';
        const incomingPath = prefix + '-incoming.md', htmlPath = prefix + '-html.md', pagePath = prefix + '.html';
        const sourceBytes = Buffer.from('# Original target\n\nActual native body.\n'), title = 'Grouped read revocation ' + prefix;
        const target = await h.upload(sourcePath, sourceBytes);
        const incomingDocument = await h.upload(incomingPath, Buffer.from('[Original](' + sourcePath + ')\n'));
        const html = await h.upload(htmlPath, Buffer.from('[Original](' + sourcePath + ')\n\n<p>Unrelated HTML remains exact</p>\n'));
        await fs.writeFile(path.join(h.source.rootPath, pagePath), '<p>Unrelated physical HTML</p>\n', { mode: 0o600, flag: 'wx' });
        await h.metadata(h.source, sourcePath, { title, isFavorite: true, pinned: true }, 'member', currentRequestToken);
        await withSettledProjectionReadBoundary(async () => undefined);
        const sourceIdentity = await fs.stat(path.join(h.source.rootPath, sourcePath)); assert(sourceIdentity.isFile());
        const beforeTarget = await load(h.connection, target.documentId), beforeIncoming = await load(h.connection, incomingDocument.documentId);
        const beforeHtml = await load(h.connection, html.documentId); assert(beforeTarget && beforeIncoming && beforeHtml);
        const lineage = (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [target.documentId])).rows;
        assert.equal(lineage.length, 1);
        const job: Job = await run('delete', currentToken, h.source.workspaceId, async (live): Promise<Job> => {
          const scope = await freshScope(live), plan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: crypto.randomUUID(),
            kind: 'delete', selections: [{ sourcePath }] }] });
          assert(plan.version === 2 && plan.planIdentityVersion === 4);
          assert.equal(plan.sourceEvidence.evidenceVersion, 5); assert.equal(plan.linkAssessment.complete, true);
          return { kind: 'delete', operationId: crypto.randomUUID(), plan, scope, sourcePath, destinationPath: prefix + '-unused.md',
            incomingPath, pdfPath: null, destinationPdf: null, pdf: null, targetId: target.documentId, incomingId: incomingDocument.documentId,
            lineageId: lineage[0].lineage_id, generation: target.lifecycleGeneration, title,
            originalBinary: Buffer.from(beforeTarget.yjsState), originalVector: Buffer.from(beforeTarget.stateVector) };
        });
        type E6 = Extract<import('../app/lib/files/workspace-operation-original-delete-evidence').OriginalIntent, { version: 6 }>;
        let intent: E6 | undefined, original: Awaited<ReturnType<typeof immutableBatch>> | undefined;
        let committedIntent: Awaited<ReturnType<typeof row>> | undefined, baseline: Awaited<ReturnType<typeof snapshot>> | undefined;
        let faultFiles: Awaited<ReturnType<typeof filesystem>> | undefined, ownerClient: MetadataSqlEvent['client'] | undefined;
        let stageWitness: { pid: number; start: string; xid: string } | undefined;
        let b2Witness: { pid: number; start: string; xid: string } | undefined;
        let committed = false, revoked = false, b2Writes = 0, b2Notifications = 0;
        try {
        await assert.rejects(run('delete', currentToken, h.source.workspaceId, async live => {
          await create(job, live); assert(job.batch);
          return store.withClaim(job.batch, async claim => {
            const ready = await advanceWorkspaceOperationNativePathAdmission(claim, { mcpPrincipal: live }); assert.equal(ready.status, 'ready');
            try {
              return await h.withProbe(async event => {
                if (/^\s*INSERT\s+INTO\b/iu.test(event.text) && event.text.includes(intentTable(job))
                  && event.values[0] === job.batch!.batchId && event.result.rowCount === 1) {
                  assert.equal(ownerClient, undefined); ownerClient = event.client;
                  const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                    pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema,
                    pg_catalog.to_regnamespace(current_schema())::oid::text AS schema_oid
                    FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
                  assert.equal(actual.schema, h.schema); assert.equal(actual.schema_oid, h.schemaOid); assert(actual.xid);
                  stageWitness = { pid: Number(actual.pid), start: actual.start, xid: actual.xid };
                  committedIntent = (await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin
                    FROM workspace_file_operation_delete_intents t WHERE batch_id=$1`, [job.batch!.batchId])).rows;
                  assert.equal(committedIntent.length, 1); assert.equal((await row(intentTable(job), job.batch!.batchId)).length, 0);
                }
                if (event.client !== ownerClient) return;
                if (/^\s*COMMIT\s*$/iu.test(event.text) && !committed) {
                  assert(stageWitness && committedIntent); assert.equal(event.result.command, 'COMMIT');
                  const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                    pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
                  assert.equal(Number(actual.pid), stageWitness.pid); assert.equal(actual.start, stageWitness.start); assert.equal(actual.xid, null);
                  assert.deepEqual(await row(intentTable(job), job.batch!.batchId), committedIntent);
                  intent = JSON.parse(JSON.parse(committedIntent[0].body).intent_text) as E6;
                  assert.equal(intent.version, 6); assert.equal(intent.currentWitness.evidenceVersion, 5); assert.equal(intent.nativeLinks.length, 2);
                  original = await immutableBatch(job); baseline = await snapshot(); delete baseline.rows.workspace_file_operation_batches;
                  committed = true; return;
                }
                if (!committed || !intent) return;
                if (/\bpg_notify\s*\(/iu.test(event.text)) b2Notifications++;
                if (/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE|CREATE|ALTER|DROP)\b/iu.test(event.text)) b2Writes++;
                if (revoked || !/^\s*SELECT\b/iu.test(event.text) || !event.text.includes('"' + h.schema + '".workspace_file_operation_delete_receipts')
                  || !/\bFOR\s+SHARE\s+NOWAIT\s*$/iu.test(event.text)
                  || event.values.length !== 1 || event.values[0] !== job.batch!.batchId) return;
                assert.equal(event.result.command, 'SELECT'); assert.equal(event.result.rowCount, 0); assert.equal(b2Writes, 0);
                assert(stageWitness && baseline);
                const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
                  pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema,
                  pg_catalog.to_regnamespace(current_schema())::oid::text AS schema_oid
                  FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
                assert.equal(actual.schema, h.schema); assert.equal(actual.schema_oid, h.schemaOid);
                assert.equal(Number(actual.pid), stageWitness.pid); assert.equal(actual.start, stageWitness.start);
                assert(actual.xid); assert.notEqual(actual.xid, stageWitness.xid);
                b2Witness = { pid: Number(actual.pid), start: actual.start, xid: actual.xid };
                const states = (await event.raw(`SELECT s.status AS state_status,d.status AS registry_status,l.status AS lineage_status,
                  s.lifecycle_generation FROM collaboration_yjs_states s JOIN collaboration_documents d ON d.id=s.document_id
                  JOIN file_collaboration_lineages l ON l.id=d.lineage_id WHERE d.id=$1`, [job.targetId])).rows;
                assert.equal(states.length, 1); assert.equal(states[0].state_status, 'active');
                assert.equal(states[0].registry_status, 'active'); assert.equal(states[0].lineage_status, 'active');
                assert.equal(Number(states[0].lifecycle_generation), job.generation);
                const mutationIds = intent.nativeLinks.map(item => item.prepared.operationId);
                assert.equal(new Set(mutationIds).size, 2);
                assert.equal((await event.raw('SELECT operation_id FROM collaboration_native_link_mutation_receipts WHERE operation_id=ANY($1::text[])', [mutationIds])).rowCount, 0);
                const visible = await snapshot(); delete visible.rows.workspace_file_operation_batches;
                assert.deepEqual(visible, baseline, 'The genuine B2 read precedes every native unlink, archive, annotation, Trash and completion effect.');
                await absent(path.join(h.source.rootPath, job.sourcePath));
                const payload = path.join(h.dataRoot, intent.physical.trashRelativePath), physical = await fs.stat(payload);
                assert.equal(physical.dev, sourceIdentity.dev); assert.equal(physical.ino, sourceIdentity.ino);
                assert.deepEqual(await fs.readFile(payload), sourceBytes); faultFiles = await filesystem();
                // Change the actual environment-managed tool setting. The next
                // ordinary current-authority barrier must reread it; no fake
                // principal, SQL result, authority callback or grant is supplied.
                process.env.CANVAS_MCP_DIRECT_TOOLS = originalTools!.split(',')
                  .filter(tool => tool.trim() !== 'delete_knowledge_source').join(',');
                const settings = await getDirectMcpRuntimeSettings();
                assert.equal(settings.enabled, true); assert.equal(settings.tools.includes('delete_knowledge_source'), false);
                revoked = true;
              }, () => executeWorkspaceOperationOriginalDelete(claim, openDb, live));
            } catch (error) {
              assert(await store.finishClaim(job.batch!, { status: 'needs_recovery', phase: 'recovery', errorCode: code(error) ?? 'UNCLASSIFIED' }));
              throw error;
            }
          });
        }), rejected('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
        } finally {
          if (originalTools === undefined) delete process.env.CANVAS_MCP_DIRECT_TOOLS;
          else process.env.CANVAS_MCP_DIRECT_TOOLS = originalTools;
        }
        assert(revoked && committed && intent && committedIntent && original && baseline && faultFiles && b2Witness && job.batch && job.original);
        assert.equal(b2Writes, 0); assert.equal(b2Notifications, 0);
        const after = await snapshot(); delete after.rows.workspace_file_operation_batches;
        assert.deepEqual(after, baseline, 'Current tool revocation after a genuine grouped read cannot publish any B2 domain effect.');
        assert.deepEqual(await filesystem(), faultFiles); assert.deepEqual(await immutableBatch(job), original);
        assert.deepEqual(await row(intentTable(job), job.batch.batchId), committedIntent);
        assert.equal((await row(receiptTable(job), job.batch.batchId)).length, 0);
        assert.equal((await row('workspace_file_operation_delete_trash_receipts', job.batch.batchId)).length, 0);
        assert.deepEqual(await load(h.connection, job.targetId), beforeTarget);
        assert.deepEqual(await load(h.connection, job.incomingId), beforeIncoming); assert.deepEqual(await load(h.connection, html.documentId), beforeHtml);
        const sidA = job.original.actorSessionId, old = await rotate(); assert.notEqual(currentSession, sidA);
        await assert.rejects(run('delete', old, h.source.workspaceId, live => freshScope(live)), rejected('invalid_token'));
        await recover(job);
        // E6 has a genuine moved physical file; the legacy native_archive
        // completion helper does not describe this payload profile.
        const final = await store.get(job.batch.batchId); assert(final);
        assert.equal(final.status, 'applied'); assert.equal(final.completedActions, 3); assert.equal(final.totalActions, 3);
        assert.deepEqual(final.authorization, job.original); assert.deepEqual(final.trashEntryIds, [intent.physical.trashEntryId]);
        assert(intent.physical.source.kind === 'regular_file'); assert.equal(intent.physical.source.sha256, sha(sourceBytes));
        await absent(path.join(h.source.rootPath, job.sourcePath));
        const payloadPath = path.join(h.dataRoot, intent.physical.trashRelativePath), payloadIdentity = await fs.stat(payloadPath);
        assert(payloadIdentity.isFile()); assert.equal(payloadIdentity.dev, sourceIdentity.dev); assert.equal(payloadIdentity.ino, sourceIdentity.ino);
        assert.deepEqual(await fs.readFile(payloadPath), sourceBytes);
        assert.deepEqual((await h.admin.query('SELECT id,lineage_id,path,status FROM collaboration_documents WHERE id=$1', [job.targetId])).rows,
          [{ id: job.targetId, lineage_id: job.lineageId, path: job.sourcePath, status: 'archived' }]);
        assert.deepEqual((await h.admin.query('SELECT id,path,status,trash_entry_id FROM file_collaboration_lineages WHERE id=$1', [job.lineageId])).rows,
          [{ id: job.lineageId, path: job.sourcePath, status: 'archived', trash_entry_id: intent.physical.trashEntryId }]);
        const trash = (await h.admin.query('SELECT id,status,original_path,metadata_json FROM workspace_trash_entries WHERE workspace_id=$1 AND original_path=$2',
          [h.source.workspaceId, job.sourcePath])).rows; assert.equal(trash.length, 1);
        assert.equal(trash[0].id, intent.physical.trashEntryId); assert.equal(trash[0].status, 'trashed');
        assert.equal(trash[0].original_path, job.sourcePath); assert.equal(JSON.parse(trash[0].metadata_json).payloadKind, 'file');
        assert.deepEqual((await h.admin.query('SELECT path FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2',
          [h.source.workspaceId, job.sourcePath])).rows, []);
        assert.deepEqual((await h.admin.query('SELECT path FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2',
          [h.source.workspaceId, job.sourcePath])).rows, []);
        assert.equal(job.original.actorSessionId, sidA); assert.deepEqual(await immutableBatch(job), original);
        assert.deepEqual(await row(intentTable(job), job.batch.batchId), committedIntent);
        const completedRows = await row(receiptTable(job), job.batch.batchId); assert.equal(completedRows.length, 1);
        const completion = JSON.parse(JSON.parse(completedRows[0].body).receipt_text);
        assert.equal(completion.version, 6); assert.equal(completion.nativeLinks.length, 2);
        assert.equal(completion.batchId, job.batch.batchId); assert.equal(completion.trashEntryId, intent.physical.trashEntryId);
        assert.equal(completion.physical.observation.kind, 'moved'); assert.equal(completion.physical.observation.sha256, sha(sourceBytes));
        assert.equal((await row('workspace_file_operation_delete_trash_receipts', job.batch.batchId)).length, 1);
        const archived = await load(h.connection, job.targetId, true), incoming = await load(h.connection, job.incomingId);
        const htmlAfter = await load(h.connection, html.documentId); assert(archived && incoming && htmlAfter);
        assert.equal(archived.status, 'archived'); assert.equal(archived.lifecycleGeneration, job.generation + 1);
        assert.deepEqual(Buffer.from(archived.yjsState), job.originalBinary); assert.deepEqual(Buffer.from(archived.stateVector), job.originalVector);
        assert.equal(incoming.documentSequence, beforeIncoming.documentSequence + 1); assert.equal(htmlAfter.documentSequence, beforeHtml.documentSequence + 1);
        assert.equal(inspectPersistedDocumentLinksV4(incoming).links.length, 0); assert.equal(inspectPersistedDocumentLinksV4(htmlAfter).links.length, 0);
        const mutationIds = intent.nativeLinks.map(item => item.prepared.operationId);
        assert.equal((await h.admin.query('SELECT operation_id FROM collaboration_native_link_mutation_receipts WHERE operation_id=ANY($1::text[])', [mutationIds])).rowCount, 2);
        await withSettledProjectionReadBoundary(() => run('delete', currentToken, h.source.workspaceId, live => noMutation(async () => {
          const known = await existing(job, live); assert.equal(known.kind, 'historical-header');
          const observed = await status(job, live); assert(observed); assert.equal(observed.observation.apply, 'complete');
        })));
        assert.deepEqual(await row(receiptTable(job), job.batch.batchId), completedRows);
      } finally {
        if (originalTools === undefined) delete process.env.CANVAS_MCP_DIRECT_TOOLS;
        else process.env.CANVAS_MCP_DIRECT_TOOLS = originalTools;
        await groupedReadRoom.close();
      }
    });
    // Bind the same genuine Physical5 dependencies in the outer Cohort scope.
    const { runDirectMcpWorkspaceDeleteService: physicalPublicDelete } = await import('../app/lib/files/workspace-operation-mcp-path-service');
    const { decodeDirectMcpWorkspaceDeleteRequestV1: physicalDeleteRequest } = await import('../app/lib/mcp/server/workspace-path-tool-contract');
    const { workspaceOperationMcpBatchId: physicalBatchId } = await import('../app/lib/files/workspace-operation-mcp-authorization');
    const { inspectPersistedDocumentLinksV4: physicalLinks } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const physicalRows=async(batchId:string)=>({intent:await row('workspace_file_operation_delete_intents',batchId),completion:await row('workspace_file_operation_delete_receipts',batchId),trash:await row('workspace_file_operation_delete_trash_receipts',batchId)});
    // Additive Cohort6 families use this same genuine JWT/PG18/room/FD owner
    // fixture. Every earlier owner family remains part of the default run.
    const seedCohort=async(multi=false)=>{
      const prefix='cohort6-'+crypto.randomUUID(),roots=multi?[prefix+'/a',prefix+'/b']:[prefix+'/folder'];
      for(const root of roots)await fs.mkdir(path.join(h.source.rootPath,root,'sub'),{recursive:true});
      const firstPath=roots[0]+'/note.md',secondPath=roots.at(-1)!+'/sub/other.md',pngPath=roots[0]+'/picture.png',pdfPath=roots.at(-1)!+'/report.pdf';
      const first=await h.upload(firstPath,Buffer.from('# First original\n')),second=await h.upload(secondPath,Buffer.from('# Second original\n'));
      const png=Buffer.from([137,80,78,71,13,10,26,10,0,255]),pdf=Buffer.from('%PDF-1.7\nOriginal cohort asset\n%%EOF\n');
      await fs.writeFile(path.join(h.source.rootPath,pngPath),png,{mode:0o600,flag:'wx'});await fs.writeFile(path.join(h.source.rootPath,pdfPath),pdf,{mode:0o600,flag:'wx'});
      // One native target deliberately has no projection. No fake file is made
      // for it by the Delete cohort and its durable Yjs bytes remain original.
      await fs.unlink(path.join(h.source.rootPath,secondPath));
      const incoming=await h.upload(prefix+'-incoming.md',Buffer.from(`[First](${firstPath}) [Second](${secondPath}) ![Picture](${pngPath}) [PDF](${pdfPath})\n\n<p><a href="https://example.com">Unchanged HTML</a></p>\n`));
      const pagePath=prefix+'-unrelated.html',page=Buffer.from('<p>Unaffected physical HTML</p>\n');await fs.writeFile(path.join(h.source.rootPath,pagePath),page,{mode:0o600,flag:'wx'});
      const states=await Promise.all([first,second,incoming].map(item=>load(h.connection,item.documentId)));assert(states.every(Boolean));
      const identities=await Promise.all([pngPath,pdfPath].map(file=>fs.lstat(path.join(h.source.rootPath,file))));
      const operationId=crypto.randomUUID();
      await absent(path.join(h.source.rootPath,secondPath));
      return {roots,first,second,incoming,firstPath,secondPath,pngPath,pdfPath,png,pdf,pagePath,page,states,identities,operationId};
    };
    type CohortSeed=Awaited<ReturnType<typeof seedCohort>>;
    const cohortPlan=async(seed:CohortSeed)=>run('delete',currentToken,h.source.workspaceId,async live=>{
      const scope=await freshScope(live),plan=await buildWorkspaceOperationBatchPlan({scope,actions:[{reviewId:'cohort-'+seed.operationId,kind:'delete',selections:seed.roots.map(sourcePath=>({sourcePath}))}]});
      assert(plan.version===6);assert.equal(plan.sourceEvidence.evidenceVersion,5);assert.equal(plan.linkAssessment.complete,true);assert.equal(plan.issues.length,0);return plan;});
    const executeCohortClaim=async(seed:CohortSeed,plan:Awaited<ReturnType<typeof cohortPlan>>,recover=false)=>run('delete',currentToken,h.source.workspaceId,async live=>{
      assert(live.kind==='delete');const selection=recover?await store.claimExistingMcpDelete(live.principal,{workspaceId:h.source.workspaceId,operationId:seed.operationId,planId:plan.planId})
        :await store.createMcpDeleteAndClaim(live.principal,{operationId:seed.operationId,plan});
      if(selection.kind==='historical-header')return selection.batch;
      assert(selection.kind==='claimed');const batch=selection.batch;
      await store.withClaim(batch,async claim=>{
        const scope=await freshScope(live),auth=batch.authorization;assert(auth.mode==='direct-mcp');
        try{const result=await executeWorkspaceOperationBatch({batchId:batch.batchId,plan,scope,jobClaim:claim,mcpPrincipal:live,
          actorUserId:auth.actorUserId,actorId:auth.actorId,actorType:auth.actorType,actorSessionId:auth.actorSessionId,actorDisplayName:auth.actorDisplayName});
          assert.equal(result.status,'applied');assert(await store.finishClaim(batch,{status:'applied',phase:'complete',completedActions:result.completedActions,trashEntryIds:result.trashEntryIds,errorCode:null}));
        }catch(error){assert(await store.finishClaim(batch,{status:'needs_recovery',phase:'recovery',errorCode:code(error)??'COHORT_FIXTURE_FAILURE'}));throw error;}
      });return (await store.get(batch.batchId))!;});
    const cohortBatchId=(seed:CohortSeed)=>physicalBatchId({userId:'member',clientId,workspaceId:h.source.workspaceId,tool:'delete_knowledge_source',operationId:seed.operationId});
    const checkCohort=async(seed:CohortSeed,batchId:string)=>{
      const batch=await store.get(batchId);assert(batch&&batch.plan.version===6);assert.equal(batch.status,'applied');assert.equal(batch.totalActions,seed.roots.length+1);assert.equal(batch.completedActions,batch.totalActions);
      const rows=await physicalRows(batchId);assert.equal(rows.intent.length,1);assert.equal(rows.completion.length,1);assert.equal(rows.trash.length,1);
      const intent=JSON.parse(JSON.parse(rows.intent[0].body).intent_text) as import('../app/lib/files/workspace-operation-cohort-delete-evidence').CohortDeleteIntent;
      const completion=JSON.parse(JSON.parse(rows.completion[0].body).receipt_text) as import('../app/lib/files/workspace-operation-cohort-delete-evidence').CohortDeleteCompletion;
      assert.equal(intent.kind,'cohort-delete-original');assert.equal(intent.roots.length,seed.roots.length);assert.equal(intent.nativeLinks.length,1);
      assert.equal(completion.kind,'cohort-delete-completion');assert.equal(completion.physical.length,seed.roots.length);assert.equal(completion.nativeLinks.length,1);
      assert.equal(completion.nativeLinks[0].resultEvidenceVersion,4);assert.equal(completion.nativeLinks[0].after.documentSequence,seed.states[2]!.documentSequence+1);
      const archived=await Promise.all([seed.first,seed.second].map(item=>load(h.connection,item.documentId,true)));
      for(const[index,state]of archived.entries()){assert(state);assert.equal(state.status,'archived');assert.equal(state.lifecycleGeneration,seed.states[index]!.lifecycleGeneration+1);
        assert.deepEqual(Buffer.from(state.yjsState),Buffer.from(seed.states[index]!.yjsState));assert.deepEqual(Buffer.from(state.stateVector),Buffer.from(seed.states[index]!.stateVector));}
      const incoming=await load(h.connection,seed.incoming.documentId);assert(incoming);assert.equal(incoming.documentSequence,seed.states[2]!.documentSequence+1);assert.equal(physicalLinks(incoming).links.length,0);
      for(const root of seed.roots)await absent(path.join(h.source.rootPath,root));
      for(const[index,file]of [seed.pngPath,seed.pdfPath].entries()){const root=intent.roots.find(root=>file.startsWith(root.physical.canonicalPath+'/'));assert(root);
        const payload=path.join(h.dataRoot,root.physical.trashRelativePath,file.slice(root.physical.canonicalPath.length+1)),stat=await fs.lstat(payload);
        assert.equal(stat.dev,seed.identities[index].dev);assert.equal(stat.ino,seed.identities[index].ino);assert.deepEqual(await fs.readFile(payload),index===0?seed.png:seed.pdf);}
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath,seed.pagePath)),seed.page);
      const trash=(await h.admin.query('SELECT id,original_path,item_type,metadata_json FROM workspace_trash_entries WHERE id=ANY($1::text[]) ORDER BY original_path',[intent.roots.map(root=>root.physical.trashEntryId)])).rows;
      assert.equal(trash.length,seed.roots.length);for(const entry of trash){assert.equal(entry.item_type,'directory');const metadata=JSON.parse(entry.metadata_json);assert.equal(metadata.payloadKind,'cohort');assert.equal(metadata.cohortBatchId,batchId);}
      return {batch,intent,completion,rows,incoming};
    };
    // Keep the existing Cohort room/projector alive through all seven cases.
    const cohortRooms=selectedCaseName===undefined||selectedCaseId==='cohort'?await startNativePathRoomRuntime():undefined;
    try{
    await check('Cohort6 public folder Delete archives native notes and PNG/PDF with one native4 source mutation; Restore is failclosed',async()=>{
      const seed=await seedCohort(),preview=await withSettledProjectionReadBoundary(()=>noMutation(()=>physicalPublicDelete(physicalDeleteRequest({api_version:1,action:'preview',workspace_id:h.source.workspaceId,path:seed.roots[0]}),authInfo(currentToken))));
      assert(preview.action==='preview'&&preview.preview.kind==='native-path-html-assessment');assert.equal(preview.preview.readiness,'ready');assert.equal(preview.preview.linkChanges.unlinks,4);
      const result=await physicalPublicDelete(physicalDeleteRequest({api_version:1,action:'apply',workspace_id:h.source.workspaceId,path:seed.roots[0],operation_id:seed.operationId,plan_id:preview.preview.planId}),authInfo(currentToken));
      assert(result.action==='apply');assert.equal(result.operation.execution.finalization,'complete');const checked=await checkCohort(seed,result.operation.batchId);
      const {restoreWorkspaceTrashEntry}=await import('../app/lib/filesystem/workspace-trash');
      await withSettledProjectionReadBoundary(()=>noMutation(()=>assert.rejects(restoreWorkspaceTrashEntry({workspace:h.source,entryId:checked.intent.roots[0].physical.trashEntryId,restoredByUserId:'member'}),rejected('COHORT_DELETE_RESTORE_UNSUPPORTED'))));
      assert.deepEqual(await physicalRows(result.operation.batchId),checked.rows);
    });
    await check('Cohort6 actual cookie Web multi-folder DELETE and worker preserve all original identities and one common backlink source',async()=>{
      const seed=await seedCohort(true),{DELETE:webDelete}=await import('../app/api/files/delete/route'),{GET:webBatch}=await import('../app/api/files/operations/batches/[batchId]/route');
      const credentials=await h.request(h.source,'member',true,currentRequestToken),headers=new Headers(credentials.headers);headers.set('Content-Type','application/json');
      // Establish the genuine cookie session and workspace before the pure preview, as in the existing Physical Web case.
      const {requireRequestWorkspace}=await import('../app/lib/workspaces/request');
      const initialized=await requireRequestWorkspace(credentials,{permissions:['canRead','canWrite','canDelete']});
      assert.equal(initialized.response,null);assert.equal(initialized.session!.session.id,currentSession);
      assert.equal(initialized.session!.user.id,'member');assert.equal(initialized.workspace!.workspaceId,h.source.workspaceId);
      assert.equal(initialized.workspace!.rootPath,h.source.rootPath);
      assert(initialized.workspace!.permissions.canRead&&initialized.workspace!.permissions.canWrite&&initialized.workspace!.permissions.canDelete);
      assert(credentials.headers.has('cookie'));assert.equal(credentials.headers.has('authorization'),false);
      const previewResponse=await withSettledProjectionReadBoundary(()=>noMutation(()=>webDelete(new NextRequest('http://localhost/api/files/delete',{method:'DELETE',headers,body:JSON.stringify({path:seed.roots,dryRun:true})}))));
      assert.equal(previewResponse.status,200);const preview=await previewResponse.json();assert.equal(preview.plan.kind,'native-original-delete');
      const worker=createWorkspaceOperationBatchWorker({store});let stop=false,workerFailure:unknown;
      const pending=webDelete(new NextRequest('http://localhost/api/files/delete',{method:'DELETE',headers,body:JSON.stringify({path:seed.roots,planId:preview.plan.planId,idempotencyKey:seed.operationId})}));
      const pump=(async()=>{try{while(!stop){await worker.tick();if(!stop)await new Promise(resolve=>setTimeout(resolve,25));}}catch(error){workerFailure=error;}})();
      try{const response=await pending;assert([200,202].includes(response.status));let body=await response.json() as WorkspacePathOperationResponse;assert(body.operation);const batchId=body.operation.batchId;
        if(response.status===202){
          const deadline=Date.now()+20000;
          do{
            // Match the real UI and existing Physical Web case; the room
            // helper's 10ms cadence is not the HTTP status-polling contract.
            await new Promise(resolve=>setTimeout(resolve,500));
            if(workerFailure)throw workerFailure;
            const response=await webBatch(new NextRequest('http://localhost/api/files/operations/batches/'+batchId,{headers}),{params:Promise.resolve({batchId})});assert.equal(response.status,200);body=await response.json();
          }while(body.operation?.status!=='applied'&&Date.now()<deadline);
          if(body.operation?.status!=='applied')throw new Error('Cohort6 Web multi Delete did not complete.');
        }
        assert.equal(body.operation?.status,'applied');assert.deepEqual(body.deleted,seed.roots);assert.equal(body.linkUpdates?.updatedFiles.length,1);assert.equal(body.linkUpdates?.updatedLinks,4);assert.equal(body.trashEntries?.length,2);
        await checkCohort(seed,batchId);
      }finally{stop=true;await pump;}if(workerFailure)throw workerFailure;
    });
    await check('Cohort6 open native target and backlink rooms drain and remain archived after folder Delete',async()=>{
      assert(cohortRooms);
      const seed=await seedCohort(),room=cohortRooms;
      const targetPeer=await openNativePathRoomPeer(room,seed.first.documentId),incomingPeer=await openNativePathRoomPeer(room,seed.incoming.documentId);
        assert(room.isLoaded(seed.first.documentId)&&room.isLoaded(seed.incoming.documentId));
        const plan=await cohortPlan(seed),batch=await executeCohortClaim(seed,plan);await checkCohort(seed,batch.batchId);
        await waitForNativePathRoomCondition(()=>!room.isLoaded(seed.first.documentId)&&!room.isLoaded(seed.incoming.documentId),'Cohort6 rooms did not drain');
        room.assertHealthy();assert(targetPeer&&incomingPeer);await room.flush();await absent(path.join(h.source.rootPath,seed.roots[0]));
    });
    await check('Cohort6 partial multi-root FS progress rejects pending D2 and revoked grants; SID-B recovers original B1',async()=>{
      const seed=await seedCohort(true);
      await withSettledProjectionReadBoundary(async()=>undefined);
      const plan=await cohortPlan(seed),batchId=cohortBatchId(seed);let faulted=false;
      await assert.rejects(h.withProbe(async event=>{
        if(faulted||!/^\s*SELECT\b/iu.test(event.text)||!event.text.includes('workspace_file_operation_delete_intents')||event.values[0]!==batchId)return;
        const firstGone=await fs.lstat(path.join(h.source.rootPath,seed.roots[0])).then(()=>false,error=>{assert.equal((error as NodeJS.ErrnoException).code,'ENOENT');return true;});
        const secondPresent=await fs.lstat(path.join(h.source.rootPath,seed.roots[1])).then(()=>true,()=>false);
        if(!firstGone||!secondPresent)return;faulted=true;throw Object.assign(new Error('Actual cohort root one moved; root two untouched.'),{code:'FIXTURE_COHORT6_PARTIAL'});
      },()=>executeCohortClaim(seed,plan)),rejected('FIXTURE_COHORT6_PARTIAL'));
      assert(faulted);const rows=await physicalRows(batchId);assert.equal(rows.intent.length,1);assert.equal(rows.completion.length,0);
      const original=(await store.get(batchId))!.authorization;assert(original.mode==='direct-mcp');const sidA=original.actorSessionId;
      assert.equal((await h.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 AND user_id=$2 AND workspace_id=$3 RETURNING client_id',[clientId,'member',h.source.workspaceId])).rowCount,1);
      try{await withSettledProjectionReadBoundary(()=>noMutation(()=>assert.rejects(executeCohortClaim(seed,plan,true),rejected('MCP_READ_PRINCIPAL_ACCESS_DENIED'))));}
      finally{await h.admin.query('INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,$2,$3,100,100)',[clientId,'member',h.source.workspaceId]);}
      await rotate();assert.notEqual(currentSession,sidA);await fs.mkdir(path.join(h.source.rootPath,seed.roots[0]),{recursive:true});const d2=Buffer.from('Independent pending D2\n');
      await fs.writeFile(path.join(h.source.rootPath,seed.roots[0],'replacement.txt'),d2,{flag:'wx',mode:0o600});
      const files=await filesystem();await assert.rejects(executeCohortClaim(seed,plan,true),rejected('recovery-conflict'));assert.deepEqual(await filesystem(),files);assert.deepEqual(await physicalRows(batchId),rows);
      await fs.rm(path.join(h.source.rootPath,seed.roots[0]),{recursive:true});await executeCohortClaim(seed,plan,true);const checked=await checkCohort(seed,batchId);
      assert.deepEqual(checked.rows.intent,rows.intent);assert.deepEqual(checked.batch.authorization,original);
    });
    await check('Cohort6 real archive CAS fault rolls back B2 native links and all target archives, then exact recovery completes',async()=>{
      const seed=await seedCohort(),plan=await cohortPlan(seed),batchId=cohortBatchId(seed);let faulted=false;
      await assert.rejects(h.withProbe(async event=>{
        if(faulted||!/^\s*UPDATE\s+/iu.test(event.text)||!event.text.includes('collaboration_yjs_states')||!/\bSET\s+status\s*=\s*'archived'/iu.test(event.text)||event.result.rowCount!==1)return;
        const rows=await physicalRows(batchId);if(rows.intent.length!==1||rows.completion.length)return;faulted=true;
        throw Object.assign(new Error('Actual cohort first archive CAS before B2 COMMIT.'),{code:'FIXTURE_COHORT6_ARCHIVE'});
      },()=>executeCohortClaim(seed,plan)),rejected('FIXTURE_COHORT6_ARCHIVE'));
      assert(faulted);const rows=await physicalRows(batchId);assert.equal(rows.completion.length,0);assert.equal(rows.trash.length,0);
      for(const[index,item]of [seed.first,seed.second,seed.incoming].entries())assert.deepEqual(await load(h.connection,item.documentId),seed.states[index]);
      assert.equal((await h.admin.query('SELECT id FROM workspace_trash_entries WHERE original_path=ANY($1::text[])',[seed.roots])).rowCount,0);
      await rotate();await executeCohortClaim(seed,plan,true);const checked=await checkCohort(seed,batchId);assert.deepEqual(checked.rows.intent,rows.intent);
    });
    await check('Cohort6 actual B2 COMMIT ACK loss preserves later folder occupant and every original receipt on SID-B recovery',async()=>{
      const seed=await seedCohort(),plan=await cohortPlan(seed),batchId=cohortBatchId(seed);let client:MetadataSqlEvent['client']|undefined,committed=false;
      await assert.rejects(h.withProbe(async event=>{
        if(!client&&/^\s*INSERT\s+INTO\b/iu.test(event.text)&&event.text.includes('workspace_file_operation_delete_receipts')&&event.values[0]===batchId&&event.result.rowCount===1)client=event.client;
        if(committed||event.client!==client||!/^\s*COMMIT\s*$/iu.test(event.text))return;
        assert.equal(event.result.command,'COMMIT');assert.equal((await event.raw('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0].xid,null);committed=true;
        throw Object.assign(new Error('Lost actual cohort B2 ACK.'),{code:'FIXTURE_COHORT6_ACK_LOST'});
      },()=>executeCohortClaim(seed,plan)),rejected('JOB_LIFECYCLE_COMMIT_UNCONFIRMED'));
      assert(committed);const rows=await physicalRows(batchId),original=(await store.get(batchId))!.authorization;
      await fs.mkdir(path.join(h.source.rootPath,seed.roots[0]),{recursive:true});const file=path.join(h.source.rootPath,seed.roots[0],'later.txt'),bytes=Buffer.from('Later independent folder occupant\n');
      await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});const identity=await fs.lstat(file);await rotate();await executeCohortClaim(seed,plan,true);
      assert.deepEqual(await physicalRows(batchId),rows);assert.deepEqual((await store.get(batchId))!.authorization,original);assert.deepEqual(await fs.readFile(file),bytes);
      const after=await fs.lstat(file);assert.equal(after.dev,identity.dev);assert.equal(after.ino,identity.ino);
    });
    await check('Cohort6 raw and affected HTML folder selections stay blocked before all central writes and filesystem effects',async()=>{
      const seed=await seedCohort();await fs.writeFile(path.join(h.source.rootPath,seed.roots[0],'raw.md'),Buffer.from('# Raw source stays unimported\n'),{flag:'wx',mode:0o600});
      const result=await withSettledProjectionReadBoundary(()=>noMutation(()=>physicalPublicDelete(physicalDeleteRequest({api_version:1,action:'preview',workspace_id:h.source.workspaceId,path:seed.roots[0]}),authInfo(currentToken))));
      assert(result.action==='preview'&&result.preview.kind==='native-path-html-assessment');assert.equal(result.preview.readiness,'blocked');
      assert(result.preview.issues.some(issue=>issue.path===seed.roots[0]+'/raw.md'&&issue.code==='unsupported-cohort-delete-source'));
      await withSettledProjectionReadBoundary(()=>noMutation(()=>assert.rejects(physicalPublicDelete(physicalDeleteRequest({api_version:1,action:'apply',workspace_id:h.source.workspaceId,path:seed.roots[0],operation_id:seed.operationId,plan_id:result.preview.planId}),authInfo(currentToken)),rejected('PATH_NATIVE_REQUIRED'))));
      await fs.unlink(path.join(h.source.rootPath,seed.roots[0],'raw.md'));const affected=seed.roots[0]+'-affected.md';
      const affectedTarget=path.posix.relative(path.posix.dirname(affected),seed.pngPath);
      const {resolveExactWorkspaceLink}=await import('../app/lib/markdown/workspace-local-link-parser');
      assert.deepEqual(resolveExactWorkspaceLink(affectedTarget,affected,new Set([seed.pngPath])),{candidates:[seed.pngPath],path:seed.pngPath,status:'resolved'});
      await h.upload(affected,Buffer.from('<img src="'+affectedTarget+'">\n'));
      const html=await withSettledProjectionReadBoundary(()=>noMutation(()=>physicalPublicDelete(physicalDeleteRequest({api_version:1,action:'preview',workspace_id:h.source.workspaceId,path:seed.roots[0]}),authInfo(currentToken))));
      assert(html.action==='preview'&&html.preview.kind==='native-path-html-assessment');assert.equal(html.preview.readiness,'blocked');assert(html.preview.linkAssessment.blockers.some(issue=>issue.path===affected&&issue.code==='affected-html-link'));
    });
    }finally{await cohortRooms?.close();}
    assert.equal(discoveredGroups, 43);
    assert.equal(groups, selectedCaseName === undefined ? 43 : selectedCaseId === 'cohort' ? 7 : 1);
    assert.equal(omittedCases.length, selectedCaseName === undefined ? 0 : selectedCaseId === 'cohort' ? 36 : 42);
    console.log(JSON.stringify({ test: 'direct-mcp-job-owner-integration', groups,
      ...(selectedCaseName === undefined ? {} : { mode: 'focused', selectedCaseId, selectedCaseName,
        omitted: omittedCases.length, fullSuite: false, fullDefaultSuiteStillRequired: true }),
      scope: selectedCaseName === undefined
        ? 'actual fixture JWT/current MCP/Store/OriginalMove/Delete/PG18/FD plus real room/socket/admission tickets and Web rename Request/Response; no OAuth issuance, file-route TCP, SDK or browser claim'
        : selectedCaseId === 'cohort'
          ? 'seven existing genuine Cohort6 owner cases only; 36 cases omitted; no full 43-case or performance acceptance claim'
          : 'one selected genuine path-action owner case only; 42 cases omitted; no full 43-case acceptance claim' }));
  }); completed = true;
  } finally { if (originalBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = originalBase; }
}
directMcpWorkspacePathOwnerPostgresTest().catch(error => {
  const causes = error instanceof AggregateError ? error.errors.slice(0, 4).map(code) : [code(Object.getOwnPropertyDescriptor(error ?? {}, 'cause')?.value)];
  console.error(JSON.stringify({ test: 'direct-mcp-job-owner-integration', failed: true, case: currentCase, groups, code: code(error), causes,
    name: error instanceof Error ? error.name : 'Unknown', stack: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s*at\b/u.test(line)).slice(0, 6) : [] }));
  process.exitCode = 1;
});
