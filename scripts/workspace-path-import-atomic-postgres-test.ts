import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspacePathImportPreparationPlanV1 } from '../app/lib/files/workspace-path-import-preparation-plan';
import type { prepareWorkspacePathImportOperationOnConnection } from '../app/lib/files/workspace-path-import-preparation-phase';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

type Fixture = Parameters<Parameters<typeof withNativeCopyMetadataOwnerFixture>[0]>[0];
type Live = Parameters<typeof prepareWorkspacePathImportOperationOnConnection>[1]['principal'];
type Prepared = Awaited<ReturnType<typeof prepareWorkspacePathImportOperationOnConnection>>;
type Kind = 'move' | 'delete' | 'request';
type Job = { kind: Kind; operationId: string; plan: WorkspacePathImportPreparationPlanV1;
  raw: string; incoming: string; destination: string; originals: Map<string, Awaited<ReturnType<typeof atomicPathFile>>> };
const atomicPathCode = (error: unknown): string | null => {
  const value: unknown = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null;
  return typeof value === 'string' && /^[A-Z0-9][A-Z0-9_]{1,127}$/u.test(value) ? value : null;
};
const atomicPathSha = (bytes: string | Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

async function atomicPathFile(file: string) {
  const before = await fs.lstat(file, { bigint: true }); assert(!before.isSymbolicLink());
  const identity = { dev: String(before.dev), ino: String(before.ino), mode: String(before.mode), uid: String(before.uid),
    gid: String(before.gid), nlink: String(before.nlink), size: String(before.size), mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) };
  if (before.isDirectory()) return { ...identity, directory: true, sha256: null };
  assert(before.isFile() && before.nlink === BigInt(1) && before.size <= BigInt(8 * 1024 * 1024));
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    for (const stat of [await fd.stat({ bigint: true })]) for (const key of ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(stat[key], before[key]);
    const bytes = await fd.readFile(); assert.equal(BigInt(bytes.length), before.size);
    for (const stat of [await fd.stat({ bigint: true }), await fs.lstat(file, { bigint: true })]) {
      for (const key of ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(stat[key], before[key]);
    }
    return { ...identity, directory: false, sha256: atomicPathSha(bytes) };
  } finally { await fd.close(); }
}

/** Both independent oracles run, including after an operation rejects. Only
 * the fixture admin connection reads; no application authority is fabricated. */
async function atomicPathSnapshot(h: Fixture) {
  const checks = await Promise.allSettled([(async () => {
    let begun = false, total = 0; const rows: Record<string, unknown> = {};
    try {
      await h.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
      const realm = (await h.admin.query(`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid::text AS oid,
        current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS isolation,
        pg_current_xact_id_if_assigned() IS NULL AS unassigned`)).rows[0];
      assert.deepEqual(realm, { schema: h.schema, oid: h.schemaOid, ro: 'on', isolation: 'repeatable read', unassigned: true });
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)'
          OR c.relname IN ('workspace_path_import_preparations','file_revisions','file_revision_contents','file_version_blobs','workspace_trash_entries'))
        ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
      assert(tables.length > 15 && tables.length <= 512);
      for (const table of tables) {
        assert.match(table.relname, /^[a-z][a-z0-9_]{0,100}$/u);
        const values = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin
          FROM "${h.schema}"."${table.relname}" t ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
        assert(values.length <= 10000); for (const value of values) { total += Buffer.byteLength(value.body); assert(total <= 128 * 1024 ** 2); }
        rows[table.relname] = { oid: table.oid, values };
      }
      assert.equal((await h.admin.query('SELECT pg_current_xact_id_if_assigned() IS NULL AS unassigned')).rows[0].unassigned, true);
      await h.admin.query('COMMIT'); begun = false; return rows;
    } finally { if (begun) await h.admin.query('ROLLBACK'); }
  })(), (async () => {
    assert.equal(await fs.realpath(h.dataRoot), h.dataRoot); const pending = ['.'], files: unknown[] = []; let total = 0;
    for (let index = 0; index < pending.length; index++) {
      assert(pending.length <= 10000); const relative = pending[index], full = path.join(h.dataRoot, relative);
      assert(full === h.dataRoot || full.startsWith(h.dataRoot + path.sep));
      const identity = await atomicPathFile(full); files.push({ path: relative, ...identity });
      total += Number(identity.size); assert(total <= 128 * 1024 ** 2);
      if (identity.directory) pending.push(...(await fs.readdir(full)).sort().map(name => path.join(relative, name)));
    }
    return files;
  })()]);
  const errors = checks.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
  if (errors.length) throw new AggregateError(errors, 'Atomic path snapshot oracles failed.');
  assert(checks[0].status === 'fulfilled' && checks[1].status === 'fulfilled');
  return { rows: checks[0].value, files: checks[1].value };
}

async function atomicPathNoWrite<T>(h: Fixture, operation: () => Promise<T>, historical = false, noSql = false): Promise<T> {
  const before = await atomicPathSnapshot(h); let statements = 0, writes = 0, forbidden = 0, result: T | undefined, failure: unknown;
  try { result = await h.withProbe(async event => {
    statements++; if (statements > 6000) throw new Error('Atomic path SQL observation budget exceeded.');
    if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX)|NOTIFY)\b/iu.test(event.text)
      || /\bpg_notify\s*\(/iu.test(event.text)) writes++;
    if (historical && /\b(?:FROM|JOIN)\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?(?:collaboration_documents|collaboration_yjs_states|file_collaboration_lineages)"?\b/iu.test(event.text)) forbidden++;
  }, operation); } catch (error) { failure = error; }
  const checks = await Promise.allSettled([(async () => assert.deepEqual(await atomicPathSnapshot(h), before))(),
    (async () => { assert.equal(writes, 0); assert.equal(forbidden, 0, 'Historical B0 must not read current source/native rows.');
      if (noSql) assert.equal(statements, 0); else assert(statements > 0); })()]);
  const errors = [...(failure === undefined ? [] : [failure]), ...checks.flatMap(check => check.status === 'rejected' ? [check.reason as unknown] : [])];
  if (errors.length === 1) throw errors[0]; if (errors.length) throw new AggregateError(errors, 'Atomic path no-write checks failed.'); return result as T;
}

async function atomicPathIdentity(db: SqlConnection) {
  const row = await db.get(`SELECT pg_backend_pid() AS pid,extract(epoch FROM a.backend_start)::text AS start,current_schema() AS schema,
    pg_current_xact_id_if_assigned()::text AS xid,current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS ro FROM pg_stat_activity a WHERE pid=pg_backend_pid()`); assert(row); return row as Record<string, unknown>;
}

/** Internal atomic B0 and subsequent existing native owner only. No public
 * Original-Preview-ID adapter, HTTP/browser, TCP or deployment acceptance. */
export async function workspacePathImportAtomicPostgresTest(): Promise<void> {
  const previousBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost'; let phase = 'fixture', groups = 0;
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'move_knowledge_source,delete_knowledge_source,read_knowledge_source' });
    const { auth } = await import('../app/lib/auth'), { openDb } = await import('../app/lib/db');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { upsertPostgresWorkspaceMemberForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const principalApi = await import('../app/lib/mcp/server/document-read-principal');
    const requestApi = await import('../app/lib/workspaces/request-principal');
    const { withWorkspaceFileLifecycleGuard } = await import('../app/lib/files/workspace-file-lifecycle-guard');
    const { readWorkspaceLinkSourceAuthorityOnConnection } = await import('../app/lib/markdown/workspace-source-authority-stage');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { createWorkspacePathImportPreparationPlanV1 } = await import('../app/lib/files/workspace-path-import-preparation-plan');
    const { prepareWorkspacePathImportOperationOnConnection: prepare } = await import('../app/lib/files/workspace-path-import-preparation-phase');
    const { prepareWorkspacePathImportOperation } = await import('../app/lib/files/workspace-path-import-operation');
    const { workspacePathOriginalImportIds } = await import('../app/lib/files/workspace-path-import-preparation-record');
    const { workspaceOperationSourceNativeEvidence } = await import('../app/lib/files/workspace-operation-mixed-source-evidence');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinksV3 } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { inspectArchivedNativeSnapshot } = await import('../app/lib/collaboration/archived-native-snapshot');
    const { getNativeInspectionSchema } = await import('../app/lib/collaboration/native-inspection-schema');
    const { readDocumentForRequest } = await import('../app/lib/documents/service');
    const { runDirectMcpWorkspaceMoveService, runDirectMcpWorkspaceDeleteService } = await import('../app/lib/files/workspace-operation-mcp-path-service');
    const { materializeCollaborationCheckpoint } = await import('../app/lib/collaboration/checkpoint');
    const { withCollaborationProjectionPublicationGuard } = await import('../app/lib/collaboration/projection-publication-guard');
    const { CollaborationFileOperationProjectionPendingError } = await import('../app/lib/collaboration/checkpoint-errors');
    const { createWorkspaceOperationBatchWorker } = await import('../app/lib/files/workspace-operation-batch-worker');
    const owner = resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' });
    await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false });
    assert.equal(h.source.permissions.canWrite, false, 'The stale fixture DTO is not authority.');
    assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1
      WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1);
    const clientId = `atomic-${crypto.randomUUID()}`;
    await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
      VALUES($1,$1,'member','Atomic path real principal',0,'[]',100,100)`, [clientId]);
    await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
      VALUES($1,$2,'member','["knowledge:read","knowledge:write"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), clientId]);
    await h.admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at) VALUES($1,'owner',100,100)`, [h.source.workspaceId]);
    await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,'member',$2,100,100)`, [clientId, h.source.workspaceId]);
    let sessionId = 'session-member', sessionToken: string | undefined = undefined;
    const atomicPathIssue = async (): Promise<AuthInfo> => {
      const seconds = Math.floor(Date.now() / 1000), issued = await auth.api.signJWT({ body: { payload: { sub: 'member', azp: clientId, sid: sessionId,
        iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp', iat: seconds - 1, exp: seconds + 600, scope: 'knowledge:read knowledge:write' } } });
      assert(issued.token); return { token: issued.token, clientId: 'untrusted-ignored', scopes: [], extra: { userId: 'owner' } };
    };
    const atomicPathWithPrincipal = async <T>(kind: Kind, operation: (live: Live) => Promise<T>): Promise<T> => {
      if (kind === 'request') return requestApi.withWorkspaceRequestPrincipal(await h.request(h.source, 'member', false, sessionToken),
        { workspaceId: h.source.workspaceId, permission: 'canWrite' }, principal => operation({ kind, principal }));
      const info = await atomicPathIssue(); return kind === 'move'
        ? principalApi.withDirectMcpWorkspaceMovePrincipal(info, { workspaceId: h.source.workspaceId }, () => undefined, principal => operation({ kind, principal }))
        : principalApi.withDirectMcpWorkspaceDeletePrincipal(info, { workspaceId: h.source.workspaceId }, () => undefined, principal => operation({ kind, principal }));
    };
    const atomicPathCapture = async (live: Live, raw: string, destination: string | null) => withWorkspaceFileLifecycleGuard(
      { workspaceId: h.source.workspaceId, paths: [''] }, async () => {
        const db = await openDb(); let begun = false, failure: Error | undefined;
        try {
          await db.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
          const consume = async (access: { workspace: import('../app/lib/workspaces/types').WorkspaceContext; assertCurrent: () => Promise<void> }) => {
            await access.assertCurrent(); const observation = await readWorkspaceLinkSourceAuthorityOnConnection(db, access.workspace, { physicalParserVersion: 3 });
            const plan = createWorkspacePathImportPreparationPlanV1({ scope: captureWorkspaceOperationJobScope(access.workspace), kind: destination === null ? 'delete' : 'move',
              selections: [{ sourcePath: raw, ...(destination === null ? {} : { destinationPath: destination }) }], observation });
            assert.equal(plan.readiness, 'requires-import-rebinding'); await access.assertCurrent(); return plan;
          };
          const plan = live.kind === 'request' ? await requestApi.withWorkspaceRequestPrincipalOnConnection(db, live.principal, consume)
            : live.kind === 'move' ? await principalApi.withDirectMcpWorkspaceMovePrincipalOnConnection(db, live.principal, consume)
              : await principalApi.withDirectMcpWorkspaceDeletePrincipalOnConnection(db, live.principal, consume);
          await db.run('COMMIT'); begun = false; return plan;
        } catch (error) { failure = error instanceof Error ? error : new Error('Atomic preview failed.'); throw error; }
        finally { try { if (begun) await db.run('ROLLBACK'); } finally { await db.close(failure); } }
      });
    const atomicPathSeed = async (kind: Kind): Promise<Job> => {
      const stem = `atomic-${crypto.randomUUID()}`, raw = `${stem}.md`, incoming = `${stem}-incoming.md`, destination = `${stem}-moved.md`;
      await fs.writeFile(path.join(h.source.rootPath, raw), `# Original ${stem}\n\n[Self](${raw})\n`, { mode: 0o600, flag: 'wx' });
      await fs.writeFile(path.join(h.source.rootPath, incoming), `[Target](${raw})\n`, { mode: 0o600, flag: 'wx' });
      const plan = await atomicPathWithPrincipal(kind, live => atomicPathNoWrite(h, () => atomicPathCapture(live, raw, kind === 'delete' ? null : destination)));
      assert.deepEqual(plan.importRequirements.map(item => item.path).sort(), [raw, incoming].sort());
      assert(plan.importRequirements.every(item => item.importPolicy.parserVersion === 3));
      return { kind, operationId: `atomic_path_${crypto.randomUUID().replaceAll('-', '')}`, plan, raw, incoming, destination,
        originals: new Map(await Promise.all([raw, incoming].map(async file => [file, await atomicPathFile(path.join(h.source.rootPath, file))] as const))) };
    };
    const atomicPathAssertRows = async (db: SqlConnection, job: Job, value: Prepared) => {
      const { record, batch } = value, identity = await atomicPathIdentity(db);
      assert.equal(identity.schema, h.schema); assert.equal(identity.isolation, 'read committed'); assert.equal(identity.ro, 'off');
      assert.equal(record.b0TransactionId, identity.xid); assert.deepEqual(record.previewPlan, job.plan); assert.equal(record.operationId, job.operationId);
      assert.equal(record.origin.sessionId, sessionId); assert.equal(record.origin.userId, 'member');
      assert.equal(batch.batchId, record.batchId); assert.equal(batch.planId, record.nativePlan.planId); assert.deepEqual(batch.plan, record.nativePlan);
      assert.equal(batch.authorization.mode, job.kind === 'request' ? 'direct' : 'direct-mcp');
      assert.equal(batch.authorization.actorUserId, 'member');
      assert.equal(batch.status, job.kind === 'request' ? 'queued' : 'needs_recovery'); assert.equal(batch.leaseOwner, null);
      assert.equal(batch.completedActions, 0); assert.equal(record.imports.length, 2);
      const header = await db.get(`SELECT xmin=pg_current_xact_id()::text::xid AS own_xmin,lease_owner,lease_token,lease_expires_at
        FROM workspace_file_operation_batches WHERE batch_id=$1`, [batch.batchId]) as Record<string, unknown> | undefined;
      assert(header); assert.equal(header.own_xmin, true); for (const key of ['lease_owner','lease_token','lease_expires_at']) assert.equal(header[key], null);
      const parent = await db.get(`SELECT xmin=pg_current_xact_id()::text::xid AS own_xmin FROM workspace_path_import_preparations
        WHERE workspace_id=$1 AND operation_id=$2`, [h.source.workspaceId, job.operationId]) as { own_xmin: boolean } | undefined;
      assert.equal(parent?.own_xmin, true);
      for (const [index, item] of record.imports.entries()) {
        const ids = workspacePathOriginalImportIds(job.operationId, job.plan.planId, index), required = job.plan.importRequirements[index];
        assert.equal(item.receipt.operationId, ids.operationId); assert.equal(item.receipt.target.path, required.path);
        assert.equal(item.receipt.sourceHash, required.physical.byteHash); assert.equal(item.receipt.target.initialSequence, 0);
        const receipt = await db.get(`SELECT private_result,request_id,actor_session_id,xmin=pg_current_xact_id()::text::xid AS own_xmin
          FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2`, [h.source.workspaceId, ids.operationId]) as Record<string, unknown> | undefined;
        assert(receipt); assert.equal(receipt.own_xmin, true); assert.deepEqual(receipt.private_result, item.receipt);
        assert.equal(receipt.request_id, ids.requestId); assert.equal(receipt.actor_session_id, sessionId);
        for (const [table, key, id] of [['collaboration_documents','id',item.receipt.target.documentId], ['collaboration_yjs_states','document_id',item.receipt.target.documentId],
          ['file_collaboration_lineages','id',item.receipt.target.lineageId]] as const) {
          const row = await db.get(`SELECT xmin=pg_current_xact_id()::text::xid AS own_xmin FROM ${table} WHERE ${key}=$1`, [id]) as { own_xmin: boolean } | undefined;
          assert.equal(row?.own_xmin, true, table);
        }
        const actual = await load(db, item.receipt.target.documentId); assert(actual);
        assert.equal(atomicPathSha(actual.yjsState), item.initialBinaryHash); assert.equal(atomicPathSha(actual.stateVector), item.initialVectorHash);
        assert.deepEqual(await atomicPathFile(path.join(h.source.rootPath, required.path)), job.originals.get(required.path));
        for (const table of ['collaboration_documents','collaboration_yjs_states']) assert.equal((await h.admin.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'collaboration_documents' ? 'id' : 'document_id'}=$1`, [item.receipt.target.documentId])).rows[0].n, 0);
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2',
          [h.source.workspaceId, ids.operationId])).rows[0].n, 0);
      }
      const admissions = await db.all(`SELECT r.request_id,r.status,r.xmin=pg_current_xact_id()::text::xid AS own_xmin
        FROM collaboration_admission_requests r JOIN collaboration_admission_scopes s USING(request_id)
        WHERE s.workspace_id=$1 AND s.path='' AND s.kind='subtree' AND r.status='reserved'`, [h.source.workspaceId]) as Array<{ request_id: string; status: string; own_xmin: boolean }>;
      assert.equal(admissions.length, 1); const admission = admissions[0]; assert.equal(admission.own_xmin, true);
      const targets = await db.all(`SELECT document_id,active,status,xmin=pg_current_xact_id()::text::xid AS own_xmin
        FROM collaboration_admission_targets WHERE request_id=$1 ORDER BY document_id`, [admission.request_id]) as Array<{ document_id: string; active: boolean; status: string; own_xmin: boolean }>;
      assert.deepEqual(targets.map(item => item.document_id).sort(), workspaceOperationSourceNativeEvidence(record.nativePlan.sourceEvidence).nativeBindings.map(item => item.expected.documentId).sort());
      assert(targets.length >= 2 && targets.every(item => item.active && item.status === 'reserved' && item.own_xmin));
      const scopes = await db.all(`SELECT xmin=pg_current_xact_id()::text::xid AS own_xmin FROM collaboration_admission_scopes WHERE request_id=$1`, [admission.request_id]) as Array<{ own_xmin: boolean }>;
      assert.equal(scopes.length, 1); assert(scopes.every(item => item.own_xmin));
      if (record.nativePlan.version === 3) {
        const preparation = await db.get(`SELECT request_id,preparation_text,xmin=pg_current_xact_id()::text::xid AS own_xmin
          FROM workspace_file_operation_move_preparations WHERE batch_id=$1`, [batch.batchId]) as Record<string, unknown> | undefined;
        assert(preparation); assert.equal(preparation.own_xmin, true); assert.equal(preparation.request_id, admission.request_id);
        const body = JSON.parse(preparation.preparation_text as string) as { nativeBundle: { operationId: string } | null };
        assert(body.nativeBundle, 'Self/incoming changes require an actual native bundle.');
        const staged = await db.get(`SELECT xmin=pg_current_xact_id()::text::xid AS own_xmin,request_id
          FROM collaboration_native_file_operation_intents WHERE operation_id=$1`, [body.nativeBundle.operationId]) as Record<string, unknown> | undefined;
        assert(staged); assert.equal(staged.own_xmin, true); assert.equal(staged.request_id, admission.request_id);
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_file_operation_move_preparations WHERE batch_id=$1', [batch.batchId])).rows[0].n, 0);
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_native_file_operation_intents WHERE operation_id=$1', [body.nativeBundle.operationId])).rows[0].n, 0);
      } else assert.equal(record.nativePlan.version, 2);
      for (const table of ['workspace_file_operation_move_intents','workspace_file_operation_delete_intents']) assert.equal(
        (await db.get(`SELECT count(*)::int AS n FROM ${table} WHERE batch_id=$1`, [batch.batchId]) as { n: number }).n, 0, 'B0 does not execute B1.');
      for (const [table, key, id] of [['workspace_path_import_preparations','batch_id',batch.batchId], ['workspace_file_operation_batches','batch_id',batch.batchId],
        ['collaboration_admission_requests','request_id',admission.request_id], ['collaboration_admission_scopes','request_id',admission.request_id],
        ['collaboration_admission_targets','request_id',admission.request_id]] as const) assert.equal(
        (await h.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${key}=$1`, [id])).rows[0].n, 0, `${table} is uncommitted.`);
    };
    const atomicPathInvoke = async (live: Live, job: Job, rollback = false, fresh = true): Promise<Prepared> => withWorkspaceFileLifecycleGuard(
      { workspaceId: h.source.workspaceId, paths: [''] }, async () => {
        const db = await openDb(); let begun = false, failure: Error | undefined;
        try {
          await db.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true; const before = await atomicPathIdentity(db);
          const result = await prepare(db, { principal: live, operationId: job.operationId, plan: job.plan });
          const after = await atomicPathIdentity(db); for (const key of ['pid','start','schema','isolation','ro']) assert.equal(after[key], before[key]);
          if (before.xid !== null) assert.equal(after.xid, before.xid); if (fresh) await atomicPathAssertRows(db, job, result);
          await db.run(rollback ? 'ROLLBACK' : 'COMMIT'); begun = false; return result;
        } catch (error) { failure = error instanceof Error ? error : new Error('Atomic B0 failed.'); throw error; }
        finally { try { if (begun) await db.run('ROLLBACK'); } finally { await db.close(failure); } }
      });
    // Historical repeat enters the receipt-first API under the genuine current
    // principal without the fresh-source lifecycle guard. The strict no-current-
    // native-read oracle still observes the whole actual transaction.
    const atomicPathRepeat = async (live: Live, job: Job): Promise<Prepared> => {
      const db = await openDb(); let begun = false, failure: Error | undefined;
      try {
        await db.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
        const result = await prepare(db, { principal: live, operationId: job.operationId, plan: job.plan });
        await db.run('COMMIT'); begun = false; return result;
      } catch (error) { failure = error instanceof Error ? error : new Error('Atomic historical repeat failed.'); throw error; }
      finally { try { if (begun) await db.run('ROLLBACK'); } finally { await db.close(failure); } }
    };
    const atomicPathRead = async (state: PersistedCollaborationState, lineageId: string) => {
      const page = await readDocumentForRequest(await h.request(h.source, 'member', false, sessionToken), { apiVersion: 1,
        workspaceId: h.source.workspaceId, documentId: state.documentId, format: 'native', maxBytes: 262144 });
      assert(page.complete); assert.equal(page.document.documentId, state.documentId);
      assert.equal(page.document.lineageId, lineageId);
      const body = JSON.parse(page.fragment) as { representation: string; content: unknown };
      assert.equal(body.representation, state.representation);
      // Public native reads are JSON. Match the complete expected JSON content;
      // internal schema attributes may deliberately use null prototypes.
      assert.deepEqual(body.content, JSON.parse(JSON.stringify(authoritativeNativeCollaborationSnapshot(state).content))); return page;
    };
    const atomicPathExpectedContent = (state: PersistedCollaborationState, previous: string, next: string | null, label: string) => {
      const content = structuredClone(authoritativeNativeCollaborationSnapshot(state).content); let changes = 0;
      if (content.kind === 'plain_text') {
        const old = `[${label}](${previous})`; assert.equal(content.text.split(old).length, 2);
        content.text = content.text.replace(old, next === null ? label : `[${label}](${next})`); return content;
      }
      const visit = (node: import('@tiptap/core').JSONContent): void => {
        if (node.marks) node.marks = node.marks.flatMap(mark => {
          if (mark.type !== 'link' || mark.attrs?.href !== previous) return [mark]; changes++;
          return next === null ? [] : [{ ...mark, attrs: { ...mark.attrs, href: next } }];
        });
        for (const child of node.content ?? []) visit(child);
      };
      visit(content.document); assert.equal(changes, 1);
      const normalized = getNativeInspectionSchema().nodeFromJSON(content.document); normalized.check(); content.document = normalized.toJSON(); return content;
    };
    const atomicPathProjection = async (state: PersistedCollaborationState, pending: boolean) => atomicPathNoWrite(h, async () => {
      if (pending) {
        await assert.rejects(materializeCollaborationCheckpoint({ state, workspace: h.source, actorType: 'system' }),
          error => error instanceof CollaborationFileOperationProjectionPendingError);
        await assert.rejects(withCollaborationProjectionPublicationGuard(state, async current => current()),
          error => error instanceof CollaborationFileOperationProjectionPendingError);
      } else { let entered = false; await withCollaborationProjectionPublicationGuard(state, async current => { entered = true; await current(); }); assert(entered); }
    });
    const atomicPathFinish = async (job: Job, prepared: Prepared) => {
      const target = prepared.record.imports.find(item => item.receipt.target.path === job.raw)!, incoming = prepared.record.imports.find(item => item.receipt.target.path === job.incoming)!;
      assert(target && incoming); const before = await load(h.connection, incoming.receipt.target.documentId); assert(before);
      const originalTarget = await load(h.connection, target.receipt.target.documentId); assert(originalTarget);
      await atomicPathProjection(before, true);
      for (const [file, original] of job.originals) assert.deepEqual(await atomicPathFile(path.join(h.source.rootPath, file)), original);
      const originalAuthorization = prepared.batch.authorization;
      if (job.kind === 'request') {
        const worker = createWorkspaceOperationBatchWorker(); assert.equal(await worker.tick(), true);
        const row = (await h.admin.query('SELECT status,authorization_json FROM workspace_file_operation_batches WHERE batch_id=$1', [prepared.batch.batchId])).rows[0];
        assert.equal(row.status, 'applied'); assert.deepEqual(JSON.parse(row.authorization_json), originalAuthorization);
      } else {
        const info = await atomicPathIssue(), common = { apiVersion: 1 as const, action: 'recover' as const, workspaceId: h.source.workspaceId,
          operationId: job.operationId, planId: prepared.record.nativePlan.planId };
        const result = job.kind === 'move' ? await runDirectMcpWorkspaceMoveService({ ...common, selections: [{ sourcePath: job.raw, destinationPath: job.destination }] }, info)
          : await runDirectMcpWorkspaceDeleteService({ ...common, path: job.raw }, info);
        assert(result.action === 'recover'); assert.equal(result.operation.completion.status, 'confirmed'); assert.equal(result.operation.planId, prepared.record.nativePlan.planId);
        assert.equal(result.operation.batchId, prepared.record.batchId);
      }
      const after = await load(h.connection, incoming.receipt.target.documentId); assert(after); assert.equal(after.documentSequence, before.documentSequence + 1);
      assert.deepEqual(authoritativeNativeCollaborationSnapshot(after).content,
        atomicPathExpectedContent(before, job.raw, job.kind === 'delete' ? null : job.destination, 'Target'));
      const inventory = inspectPersistedDocumentLinksV3(after); assert(inventory.coverage.complete);
      if (job.kind === 'delete') {
        assert.equal(inventory.links.length, 0); const archived = (await h.admin.query('SELECT status,lineage_id FROM collaboration_documents WHERE id=$1', [target.receipt.target.documentId])).rows[0];
        assert.equal(archived.status, 'archived'); assert.equal(archived.lineage_id, target.receipt.target.lineageId);
        const archivedState = await load(h.connection, target.receipt.target.documentId, true); assert(archivedState);
        assert.equal(archivedState.status, 'archived'); assert.equal(archivedState.lifecycleGeneration, originalTarget.lifecycleGeneration + 1);
        assert.deepEqual(Buffer.from(archivedState.yjsState), Buffer.from(originalTarget.yjsState));
        assert.deepEqual(Buffer.from(archivedState.stateVector), Buffer.from(originalTarget.stateVector));
        assert.deepEqual(inspectArchivedNativeSnapshot(archivedState).content, authoritativeNativeCollaborationSnapshot(originalTarget).content);
        await assert.rejects(fs.lstat(path.join(h.source.rootPath, job.raw)), { code: 'ENOENT' });
      } else {
        assert.equal(inventory.links.length, 1); assert.equal(inventory.links[0].targetPathText, job.destination);
        const moved = await load(h.connection, target.receipt.target.documentId); assert(moved); assert.equal(moved.path, job.destination);
        assert.equal(moved.status, 'active'); const ownLinks = inspectPersistedDocumentLinksV3(moved); assert(ownLinks.links.some(link => link.targetPathText === job.destination));
        assert.deepEqual(authoritativeNativeCollaborationSnapshot(moved).content, atomicPathExpectedContent(originalTarget, job.raw, job.destination, 'Self'));
        await atomicPathRead(moved, target.receipt.target.lineageId); await assert.rejects(fs.lstat(path.join(h.source.rootPath, job.raw)), { code: 'ENOENT' });
      }
      await atomicPathRead(after, incoming.receipt.target.lineageId); await atomicPathProjection(after, false);
      const row = (await h.admin.query('SELECT authorization_json,status FROM workspace_file_operation_batches WHERE batch_id=$1', [prepared.batch.batchId])).rows[0];
      assert.equal(row.status, 'applied'); assert.deepEqual(JSON.parse(row.authorization_json), originalAuthorization); return after;
    };

    phase = 'MCP Move B0 imports/header/P0/bundle/targets are same-XID, invisible until caller commit; real owner releases projector';
    const moved = await atomicPathSeed('move'), movedPrepared = await atomicPathWithPrincipal('move', live => atomicPathInvoke(live, moved));
    await atomicPathFinish(moved, movedPrepared); groups++;

    phase = 'MCP Delete B0 atomically reserves actual native archive targets; real owner unlinks and releases projector';
    const deleted = await atomicPathSeed('delete'), deletedPrepared = await atomicPathWithPrincipal('delete', live => atomicPathInvoke(live, deleted));
    await atomicPathFinish(deleted, deletedPrepared); groups++;

    phase = 'Web genuine Request B0 creates queued unclaimed header; existing genuine worker completes that same operation';
    const web = await atomicPathSeed('request'), webPrepared = await atomicPathWithPrincipal('request', live => atomicPathInvoke(live, web));
    await atomicPathFinish(web, webPrepared); groups++;

    phase = 'Caller rollback removes complete Move and Delete B0 cohorts including actual header/P0/admission and keeps every DATA identity';
    for (const kind of ['move','delete'] as const) {
      const aborted = await atomicPathSeed(kind), before = await atomicPathSnapshot(h);
      await atomicPathWithPrincipal(kind, live => atomicPathInvoke(live, aborted, true)); assert.deepEqual(await atomicPathSnapshot(h), before);
    }
    groups++;

    phase = 'Actual commit-owner preserves untouched read-only Raw with links and completes Parser3 native owner after confirmed B0';
    const untouched = `atomic-untouched-${crypto.randomUUID()}.md`, untouchedPath = path.join(h.source.rootPath, untouched);
    await fs.writeFile(untouchedPath, `[Stable](${moved.destination})\n`, { mode: 0o444, flag: 'wx' });
    const originalUntouched = await atomicPathFile(untouchedPath), mixed = await atomicPathSeed('move');
    assert(!mixed.plan.importRequirements.some(item => item.path === untouched));
    const ownerFrames = new Map<MetadataSqlEvent['client'], string[]>(); let ownerStatements = 0;
    const mixedPrepared = await atomicPathWithPrincipal('move', live => h.withProbe(async event => {
      assert(++ownerStatements <= 6000); const statements = ownerFrames.get(event.client) ?? [];
      statements.push(event.text.trim()); ownerFrames.set(event.client, statements);
    }, () => prepareWorkspacePathImportOperation({ principal: live, operationId: mixed.operationId, plan: mixed.plan })));
    // The real lifecycle guard has its own pool client and transaction. Find
    // B0 by its genuine original record/header writes, never by global counts.
    const b0Frames = [...ownerFrames.values()].filter(statements => statements.some(text =>
      /\bINSERT\s+INTO\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?(?:workspace_path_import_preparations|workspace_file_operation_batches)"?(?=\s|\()/iu.test(text)));
    assert.equal(b0Frames.length, 1); const b0Statements = b0Frames[0];
    assert.equal(b0Statements.filter(text => /^BEGIN\b/iu.test(text)).length, 1);
    assert.equal(b0Statements.filter(text => /^COMMIT\b/iu.test(text)).length, 1);
    assert.equal(b0Statements.filter(text => /^ROLLBACK\b/iu.test(text)).length, 0);
    assert([...ownerFrames.values()].some(statements => statements !== b0Statements && statements.some(text => /^BEGIN\b/iu.test(text))),
      'The genuine guard transaction is observed separately.');
    assert.equal(mixedPrepared.batch.status, 'needs_recovery'); assert.equal(mixedPrepared.batch.leaseOwner, null);
    const committedHeader = (await h.admin.query('SELECT status,lease_owner,lease_token FROM workspace_file_operation_batches WHERE batch_id=$1', [mixedPrepared.batch.batchId])).rows[0];
    assert.equal(committedHeader.status, 'needs_recovery'); assert.equal(committedHeader.lease_owner, null); assert.equal(committedHeader.lease_token, null);
    assert.equal(mixedPrepared.record.nativePlan.planIdentityVersion, 3); await atomicPathFinish(mixed, mixedPrepared);
    assert.deepEqual(await atomicPathFile(untouchedPath), originalUntouched);
    assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, untouched])).rows[0].n, 0); groups++;

    phase = 'Forged principal/wrong genuine brand and unregistered central importer acquire no atomic/import capability';
    const forged = await atomicPathSeed('move');
    await assert.rejects(atomicPathNoWrite(h, () => atomicPathInvoke({ kind: 'move', principal: {} } as unknown as Live, forged)), error => { assert.equal(atomicPathCode(error), 'MCP_READ_PRINCIPAL_REQUIRED'); return true; });
    await assert.rejects(atomicPathWithPrincipal('delete', live => atomicPathNoWrite(h,
      () => atomicPathInvoke({ kind: 'move', principal: live.principal } as unknown as Live, forged))), error => { assert.equal(atomicPathCode(error), 'MCP_READ_PRINCIPAL_REQUIRED'); return true; });
    const { persistWorkspacePathOriginalMarkdownImportOnConnection } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const db = await openDb(); let begun = false;
    try { await db.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
      await assert.rejects(atomicPathNoWrite(h, () => persistWorkspacePathOriginalMarkdownImportOnConnection(db,
        { preparation: {} as Parameters<typeof persistWorkspacePathOriginalMarkdownImportOnConnection>[1]['preparation'], requirementIndex: 0 }), false, true),
      error => { assert.equal(atomicPathCode(error), 'PATH_IMPORT_PREPARATION_PHASE_REQUIRED'); return true; });
    } finally { try { if (begun) await db.run('ROLLBACK'); } finally { await db.close(); } } groups++;

    phase = 'SID-B receipt-first same-operation history survives real Move plus invalid D2 without current native/FD import or attribution replacement';
    await fs.writeFile(path.join(h.source.rootPath, moved.raw), Buffer.from([0xff, 0xfe]), { mode: 0o600, flag: 'wx' });
    const originalSession = sessionId, originalRecord = movedPrepared.record;
    const historical = (await h.admin.query(`SELECT record_text,record_digest,b0_xid::text,xmin::text FROM workspace_path_import_preparations
      WHERE batch_id=$1`, [originalRecord.batchId])).rows;
    const next = `atomic-session-${crypto.randomUUID()}`, token = crypto.randomBytes(32).toString('hex'), now = Date.now();
    await h.admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,\'member\',$3,$4,$4)', [next, token, now + 3600000, now]);
    assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [sessionId])).rowCount, 1);
    sessionId = next; sessionToken = token; assert.equal((await auth.api.getSession({ headers: (await h.request(h.source, 'member', false, token)).headers }))?.session.id, next);
    const repeat = await atomicPathWithPrincipal('move', live => atomicPathNoWrite(h, () => atomicPathRepeat(live, moved), true));
    assert.deepEqual(repeat.record, originalRecord); assert.equal(repeat.record.origin.sessionId, originalSession);
    assert.deepEqual(repeat.batch.authorization, movedPrepared.batch.authorization); assert.equal(repeat.batch.status, 'applied');
    const infoB = await atomicPathIssue();
    for (const action of ['status','recover'] as const) {
      const result = await atomicPathNoWrite(h, () => runDirectMcpWorkspaceMoveService(action === 'status'
        ? { apiVersion: 1, action, workspaceId: h.source.workspaceId, operationId: moved.operationId }
        : { apiVersion: 1, action, workspaceId: h.source.workspaceId, operationId: moved.operationId, planId: originalRecord.nativePlan.planId,
          selections: [{ sourcePath: moved.raw, destinationPath: moved.destination }] }, infoB), true);
      assert(result.action !== 'preview'); assert.equal(result.operation.completion.status, 'confirmed');
      assert.equal(result.operation.batchId, originalRecord.batchId);
    }
    assert.deepEqual((await h.admin.query(`SELECT record_text,record_digest,b0_xid::text,xmin::text FROM workspace_path_import_preparations
      WHERE batch_id=$1`, [originalRecord.batchId])).rows, historical); groups++;
    assert.equal(groups, 7);
    await fs.unlink(path.join(h.source.rootPath, moved.raw)); // Original invalid D2 history above is complete.
    phase = 'C1 atomic Record2/header/P0 same-B births and explicit genuine recovery beside unrelated HTML';
    const c1html = `c1-atomic-${crypto.randomUUID()}.html`, c1raw = `c1-atomic-${crypto.randomUUID()}.md`, c1incoming = c1raw + '-incoming.md', c1target = c1raw + '-moved.md';
    await fs.writeFile(path.join(h.source.rootPath, c1html), '<a href="unaffected.md">unrelated</a>\n', { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(h.source.rootPath, c1raw), `# C1\n\n[Self](${c1raw})\n`, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(h.source.rootPath, c1incoming), `[Target](${c1raw})\n`, { flag: 'wx', mode: 0o600 });
    const htmlBefore = await atomicPathFile(path.join(h.source.rootPath, c1html));
    const { readWorkspacePathImportPreparationPlan } = await import('../app/lib/files/workspace-path-import-operation-preview');
    const c1plan = await atomicPathWithPrincipal('move', live => atomicPathNoWrite(h, () => readWorkspacePathImportPreparationPlan({ principal: live,
      kind: 'move', selections: [{ sourcePath: c1raw, destinationPath: c1target }] })));
    assert(c1plan.version === 4); assert.equal(c1plan.readiness, 'requires-import-rebinding'); assert(c1plan.linkAssessment.complete);
    const operationId = `c1_atomic_${crypto.randomUUID().replaceAll('-', '')}`;
    let sameB = false;
    const prepared = await atomicPathWithPrincipal('move', live => h.withProbe(async event => {
      if (!/\bINSERT\s+INTO\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?workspace_file_operation_batches"?(?=\s|\()/iu.test(event.text)) return;
      const own = (await event.raw('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0]; assert(own.xid);
      const rows = (await event.raw(`SELECT p.b0_xid::text AS xid,p.xmin::text AS parent_xmin,b.xmin::text AS header_xmin,p.version
        FROM workspace_path_import_preparations p JOIN workspace_file_operation_batches b ON b.batch_id=p.batch_id
        WHERE p.operation_id=$1`, [operationId])).rows; assert.equal(rows.length, 1);
      assert.equal(rows[0].version, 2); assert.equal(rows[0].xid, own.xid); assert.equal(rows[0].parent_xmin, rows[0].header_xmin);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_path_import_preparations WHERE operation_id=$1', [operationId])).rows[0].n, 0);
      sameB = true;
    }, () => prepareWorkspacePathImportOperation({ principal: live, operationId, plan: c1plan })));
    assert(sameB); assert(prepared.record.version === 2); assert.equal(prepared.record.nativePlan.planIdentityVersion, 4); assert.equal(prepared.record.imports.length, 2);
    const result = await runDirectMcpWorkspaceMoveService({ apiVersion: 1, action: 'recover', workspaceId: h.source.workspaceId,
      operationId, planId: c1plan.planId, selections: [{ sourcePath: c1raw, destinationPath: c1target }] }, await atomicPathIssue());
    assert(result.action === 'recover'); assert.equal(result.operation.completion.status, 'confirmed'); assert.equal(result.operation.batchId, prepared.record.batchId);
    assert.deepEqual(await atomicPathFile(path.join(h.source.rootPath, c1html)), htmlBefore);
    groups++; assert.equal(groups, 8); console.log(JSON.stringify({ suite: 'workspace-path-import-atomic', groups, passed: true,
      scope: 'genuine borrowed B0 plus ordinary existing native claim/owner/worker; no Original-Preview mapping, HTTP/browser or deployment claim' }));
  }); } catch (error) {
    console.error(JSON.stringify({ suite: 'workspace-path-import-atomic', phase, groups, code: atomicPathCode(error),
      name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message.slice(0, 1500) : undefined,
      stack: error instanceof Error ? error.stack?.split('\n').slice(1, 9) : [] })); throw error;
  } finally { if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase; }
}
