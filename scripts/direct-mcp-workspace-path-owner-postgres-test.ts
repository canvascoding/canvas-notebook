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
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type * as YTypes from 'yjs';
import type { DocumentVersionIdentityV1 } from '../app/lib/documents/read-version';
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
async function waitForNativePathRoomCondition(test: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(label);
}

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
    const noMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
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
          const diagnostic: Record<string, unknown> = { phase: diagnosticPhase, statements, writerStatements: writes.length, notifyStatements,
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
    const check = async (name: string, callback: () => Promise<void>) => { currentCase = name; await callback(); groups++; console.log(`MCP job owner case passed: ${name}`); };
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
      socket.once('open', () => { opened = true; }); socket.on('error', error => { failure = error; });
      socket.on('message', data => {
        try {
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? new Uint8Array(Buffer.concat(data)) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const decoder = decoding.createDecoder(bytes); assert.equal(decoding.readVarString(decoder), documentId); const type = decoding.readVarUint(decoder);
          if (type === MessageType.Auth) { const value = decoding.readVarUint(decoder); authenticated ||= value === AuthMessageType.Authenticated; denied ||= value === AuthMessageType.PermissionDenied; }
          if (type === MessageType.Stateless) startup ||= JSON.parse(decoding.readVarString(decoder)).type === 'durability_snapshot';
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
    } catch (error) { nativeRoomFailure = error; throw error; }
    finally {
      try { await nativeRooms.close(); }
      catch (cleanup) { throw nativeRoomFailure === undefined ? cleanup
        : new AggregateError([nativeRoomFailure, cleanup], 'Live native path assertion and resource closure failed.'); }
    }
    await check('current expired session denies historical status and existing claim with zero domain/FS changes', async () => {
      assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [currentSession])).rowCount, 1);
      const before = await snapshot(), files = await filesystem();
      await assert.rejects(run('move', currentToken, h.source.workspaceId, async live => { await status(moved!, live); }), rejected('invalid_token'));
      await assert.rejects(run('delete', currentToken, h.source.workspaceId, async live => { await existing(deleted!, live); }), rejected('invalid_token'));
      assert.deepEqual(await snapshot(), before); assert.deepEqual(await filesystem(), files);
    });
    assert.equal(groups, 16);
    console.log(JSON.stringify({ test: 'direct-mcp-job-owner-integration', groups,
      scope: 'actual fixture JWT/current MCP/Store/OriginalMove/Delete/PG18/FD plus real room/socket/admission tickets; no OAuth issuance, HTTP, SDK, public-handler or browser claim' }));
  }); completed = true;
  } finally { if (originalBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = originalBase; }
}
directMcpWorkspacePathOwnerPostgresTest().catch(error => {
  const causes = error instanceof AggregateError ? error.errors.slice(0, 4).map(code) : [code(Object.getOwnPropertyDescriptor(error ?? {}, 'cause')?.value)];
  console.error(JSON.stringify({ test: 'direct-mcp-job-owner-integration', failed: true, case: currentCase, groups, code: code(error), causes,
    name: error instanceof Error ? error.name : 'Unknown', stack: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s*at\b/u.test(line)).slice(0, 6) : [] }));
  process.exitCode = 1;
});
