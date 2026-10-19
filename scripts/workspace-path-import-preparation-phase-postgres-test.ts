import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspacePathImportPreparationPlanV1 } from '../app/lib/files/workspace-path-import-preparation-plan';
import type { WorkspacePathImportPreparationRecordV1 } from '../app/lib/files/workspace-path-import-preparation-record';
import type { prepareWorkspacePathImportsOnConnection } from '../app/lib/files/workspace-path-import-preparation-phase';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

type Fixture = Parameters<Parameters<typeof withNativeCopyMetadataOwnerFixture>[0]>[0];
type Live = Parameters<typeof prepareWorkspacePathImportsOnConnection>[1]['principal'];
type Kind = 'move' | 'delete' | 'request';
type Job = { operationId: string; plan: WorkspacePathImportPreparationPlanV1; raw: string; incoming: string; destination: string };
let phase = 'fixture', groups = 0, complete = false, historicalPhase = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
const pathPrepCode = (error: unknown): string | null => {
  const value = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value as unknown : null;
  return typeof value === 'string' && /^[A-Z0-9][A-Z0-9_]{1,127}$/u.test(value) ? value : null;
};

/** Real RR/RO/unassigned-XID rows and FD identities; no fixture writes inside. */
async function pathPrepSnapshot(h: Fixture) {
  const rows: Record<string, unknown> = {}, files: unknown[] = []; let begun = false, total = 0;
  try {
    await h.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
    const state = (await h.admin.query(`SELECT current_schema() AS schema, to_regnamespace(current_schema())::oid::text AS oid,
      current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS isolation,
      pg_current_xact_id_if_assigned() IS NULL AS unassigned`)).rows[0];
    assert.deepEqual(state, { schema: h.schema, oid: h.schemaOid, ro: 'on', isolation: 'repeatable read', unassigned: true });
    const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind='r' AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)'
        OR c.relname IN ('workspace_path_import_preparations','file_revisions','file_revision_contents','file_version_blobs','workspace_trash_entries'))
      ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
    assert(tables.length > 15 && tables.length <= 512);
    for (const table of tables) {
      assert.match(table.relname, /^[a-z][a-z0-9_]{0,100}$/u);
      const values = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM "${h.schema}"."${table.relname}" t
        ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
      assert(values.length <= 10000);
      for (const value of values) { total += Buffer.byteLength(value.body); assert(total <= 128 * 1024 * 1024); }
      rows[table.relname] = { oid: table.oid, values };
    }
    assert.equal((await h.admin.query('SELECT pg_current_xact_id_if_assigned() IS NULL AS unassigned')).rows[0].unassigned, true);
    await h.admin.query('COMMIT'); begun = false;
  } finally { if (begun) await h.admin.query('ROLLBACK'); }
  assert.equal(await fs.realpath(h.dataRoot), h.dataRoot); const pending = ['.']; total = 0;
  for (let index = 0; index < pending.length; index++) {
    assert(pending.length <= 10000); const relative = pending[index], full = path.join(h.dataRoot, relative);
    assert(full === h.dataRoot || full.startsWith(h.dataRoot + path.sep));
    const before = await fs.lstat(full, { bigint: true }); assert(!before.isSymbolicLink());
    const identity = { path: relative, dev: String(before.dev), ino: String(before.ino), mode: String(before.mode), uid: String(before.uid),
      gid: String(before.gid), nlink: String(before.nlink), size: String(before.size), mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) };
    if (before.isDirectory()) {
      pending.push(...(await fs.readdir(full)).sort().map(name => path.join(relative, name))); files.push(identity);
    } else {
      assert(before.isFile() && before.nlink === BigInt(1) && before.size <= BigInt(8 * 1024 * 1024));
      const fd = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await fd.stat({ bigint: true });
        for (const key of ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(opened[key], before[key]);
        const bytes = await fd.readFile(); assert.equal(BigInt(bytes.length), before.size); total += bytes.length; assert(total <= 128 * 1024 * 1024);
        files.push({ ...identity, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
        const after = await fd.stat({ bigint: true });
        for (const key of ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(after[key], before[key]);
      } finally { await fd.close(); }
    }
    const after = await fs.lstat(full, { bigint: true });
    for (const key of ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(after[key], before[key]);
  }
  return { rows, files };
}

async function pathPrepNoWrite<T>(h: Fixture, operation: () => Promise<T>, expectedStatements: 'some' | 'none' = 'some'): Promise<T> {
  const before = await pathPrepSnapshot(h); let statements = 0, writes = 0;
  try { return await h.withProbe(async event => {
    assert(++statements <= 5000);
    if (historicalPhase) assert(!/\b(?:FROM|JOIN)\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?(?:collaboration_documents|collaboration_yjs_states|file_collaboration_lineages)"?\b/iu.test(event.text),
      'A historical B0 record must not probe today\'s source-document state.');
    if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)
      || /\bpg_notify\s*\(/iu.test(event.text)) writes++;
  }, operation); }
  finally { if (expectedStatements === 'some') assert(statements > 0); else assert.equal(statements, 0);
    assert.equal(writes, 0); assert.deepEqual(await pathPrepSnapshot(h), before); }
}

async function pathPrepIdentity(db: SqlConnection) {
  const value = await db.get(`SELECT pg_backend_pid() AS pid,extract(epoch FROM a.backend_start)::text AS start,
    current_schema() AS schema,pg_current_xact_id_if_assigned()::text AS xid,
    current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS ro
    FROM pg_stat_activity a WHERE pid=pg_backend_pid()`); assert(value); return value as Record<string, unknown>;
}

export async function workspacePathImportPreparationPhasePostgresTest(): Promise<void> {
  const previousBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'move_knowledge_source,delete_knowledge_source,read_knowledge_source' });
    const { auth } = await import('../app/lib/auth');
    const { openDb } = await import('../app/lib/db');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { upsertPostgresWorkspaceMemberForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const principalApi = await import('../app/lib/mcp/server/document-read-principal');
    const requestApi = await import('../app/lib/workspaces/request-principal');
    const { withWorkspaceFileLifecycleGuard } = await import('../app/lib/files/workspace-file-lifecycle-guard');
    const { readWorkspaceLinkSourceAuthorityOnConnection } = await import('../app/lib/markdown/workspace-source-authority-stage');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const { createWorkspacePathImportPreparationPlanV1 } = await import('../app/lib/files/workspace-path-import-preparation-plan');
    const { prepareWorkspacePathImportsOnConnection: prepare } = await import('../app/lib/files/workspace-path-import-preparation-phase');
    const { workspacePathOriginalImportIds } = await import('../app/lib/files/workspace-path-import-preparation-record');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinksV3 } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { readDocumentForRequest } = await import('../app/lib/documents/service');
    const owner = resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' });
    await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false });
    assert.equal(h.source.permissions.canWrite, false, 'The stale fixture DTO is never a grant.');
    assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1
      WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1);
    const clientId = `prep-${crypto.randomUUID()}`;
    await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
      VALUES($1,$1,'member','B0 principal fixture',0,'[]',100,100)`, [clientId]);
    await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
      VALUES($1,$2,'member','["knowledge:read","knowledge:write"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), clientId]);
    await h.admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at) VALUES($1,'owner',100,100)`, [h.source.workspaceId]);
    await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,'member',$2,100,100)`, [clientId, h.source.workspaceId]);
    let sessionId = 'session-member', sessionToken: string | undefined;
    const pathPrepWithPrincipal = async <T>(kind: Kind, operation: (live: Live) => Promise<T>): Promise<T> => {
      if (kind === 'request') return requestApi.withWorkspaceRequestPrincipal(await h.request(h.source, 'member', false, sessionToken),
        { workspaceId: h.source.workspaceId, permission: 'canWrite' }, principal => operation({ kind: 'request', principal }));
      const seconds = Math.floor(Date.now() / 1000), issued = await auth.api.signJWT({ body: { payload: { sub: 'member', azp: clientId, sid: sessionId,
        iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp', iat: seconds - 1, exp: seconds + 600, scope: 'knowledge:read knowledge:write' } } });
      assert(issued.token); const info: AuthInfo = { token: issued.token, clientId: 'untrusted-ignored', scopes: [], extra: { userId: 'owner' } };
      return kind === 'move' ? principalApi.withDirectMcpWorkspaceMovePrincipal(info, { workspaceId: h.source.workspaceId }, () => undefined,
        principal => operation({ kind, principal })) : principalApi.withDirectMcpWorkspaceDeletePrincipal(info, { workspaceId: h.source.workspaceId }, () => undefined,
        principal => operation({ kind, principal }));
    };
    const pathPrepCapture = async (live: Live, sourcePath: string, destination: string | null): Promise<WorkspacePathImportPreparationPlanV1> =>
      withWorkspaceFileLifecycleGuard({ workspaceId: h.source.workspaceId, paths: [''] }, async () => {
        const db = await openDb(); let begun = false, failure: Error | undefined;
        try {
          await db.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
          const pathPrepConsume = async (access: { workspace: import('../app/lib/workspaces/types').WorkspaceContext; assertCurrent: () => Promise<void> }) => {
            await access.assertCurrent(); const observation = await readWorkspaceLinkSourceAuthorityOnConnection(db, access.workspace, { physicalParserVersion: 3 });
            const plan = createWorkspacePathImportPreparationPlanV1({ scope: captureWorkspaceOperationJobScope(access.workspace),
              kind: destination === null ? 'delete' : 'move', selections: [{ sourcePath, ...(destination === null ? {} : { destinationPath: destination }) }], observation });
            await access.assertCurrent(); assert.equal(plan.readiness, 'requires-import-rebinding'); return plan;
          };
          const plan = live.kind === 'request' ? await requestApi.withWorkspaceRequestPrincipalOnConnection(db, live.principal, pathPrepConsume)
            : live.kind === 'move' ? await principalApi.withDirectMcpWorkspaceMovePrincipalOnConnection(db, live.principal, pathPrepConsume)
              : await principalApi.withDirectMcpWorkspaceDeletePrincipalOnConnection(db, live.principal, pathPrepConsume);
          await db.run('COMMIT'); begun = false; return plan;
        } catch (error) { failure = error instanceof Error ? error : new Error('B0 preview failed.'); throw error; }
        finally { try { if (begun) await db.run('ROLLBACK'); } finally { await db.close(failure); } }
      });
    const pathPrepSeed = async (kind: Kind, options: { pristine?: boolean; readOnly?: boolean } = {}): Promise<Job> => {
      const stem = `b0-${crypto.randomUUID()}`, raw = `${stem}.md`, incoming = `${stem}-incoming.md`, destination = `${stem}-moved.md`;
      await fs.writeFile(path.join(h.source.rootPath, raw), `# Target ${stem}\n\n[Self](${raw})\n`, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(path.join(h.source.rootPath, incoming), `[Target](${raw})\n`, { flag: 'wx', mode: 0o600 });
      if (options.pristine) await h.admin.query(`INSERT INTO collaboration_documents
        (id,organization_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
        VALUES($1,$2,$3,$4,$5,'yjs','active',0,1,1,'never_initialized')`, [`pristine-${stem}`, h.source.organizationId, h.source.workspaceId, h.source.workspaceType, raw]);
      if (options.readOnly) await fs.chmod(path.join(h.source.rootPath, raw), 0o444);
      const plan = await pathPrepWithPrincipal(kind, live => pathPrepNoWrite(h, () => pathPrepCapture(live, raw, kind === 'delete' ? null : destination)));
      assert.deepEqual(plan.importRequirements.map(value => value.path).sort(), [raw, incoming].sort());
      assert(plan.physicalLinkIntents.some(intent => intent.sourcePath === incoming && intent.action === (kind === 'delete' ? 'unlink' : 'rewrite')));
      return { operationId: `path_prep_${crypto.randomUUID().replaceAll('-', '')}`, plan, raw, incoming, destination };
    };
    const pathPrepSqlRows = async (job: Job) => (await h.admin.query(`SELECT record_text,record_digest,preview_plan_id,native_plan_id,b0_xid::text,
      xmin::text AS xmin FROM workspace_path_import_preparations WHERE workspace_id=$1 AND operation_id=$2`, [h.source.workspaceId, job.operationId])).rows;
    const pathPrepAssertRecord = async (db: SqlConnection, job: Job, record: WorkspacePathImportPreparationRecordV1) => {
      const identity = await pathPrepIdentity(db); assert.equal(identity.schema, h.schema); assert.equal(identity.isolation, 'read committed'); assert.equal(identity.ro, 'off');
      assert.equal(record.b0TransactionId, identity.xid); assert.equal(record.operationId, job.operationId); assert.deepEqual(record.previewPlan, job.plan);
      assert.match(record.batchId, /^[a-f0-9]{64}$/u); assert.equal(record.origin.userId, 'member'); assert.equal(record.origin.sessionId, sessionId);
      assert.equal(record.origin.clientId, record.origin.kind === 'direct-mcp' ? clientId : null);
      assert.equal(record.imports.length, job.plan.importRequirements.length); assert.equal(record.nativePlan.readiness, 'ready');
      assert.notEqual(record.nativePlan.planId, job.plan.planId); assert.equal(record.nativePlan.version, job.plan.request.kind === 'delete' ? 2 : 3);
      for (let index = 0; index < record.imports.length; index++) {
        const item = record.imports[index], required = job.plan.importRequirements[index], ids = workspacePathOriginalImportIds(job.operationId, job.plan.planId, index);
        assert.equal(item.requirementIndex, index); assert.equal(item.receipt.operationId, ids.operationId);
        assert.equal(item.receipt.sourceHash, required.physical.byteHash); assert.equal(item.receipt.target.path, required.path);
        assert.equal(item.receipt.target.initialSequence, 0); assert.match(item.bindingProof, /^[a-f0-9]{64}$/u);
        const stored = await db.get(`SELECT actor_user_id,actor_session_id,request_id,private_result,
          xmin=pg_current_xact_id()::text::xid AS own_xmin FROM collaboration_markdown_file_import_receipts
          WHERE workspace_id=$1 AND operation_id=$2`, [h.source.workspaceId, ids.operationId]) as Record<string, unknown> | undefined;
        assert(stored); assert.equal(stored.own_xmin, true); assert.deepEqual(stored.private_result, item.receipt);
        assert.equal(stored.actor_user_id, 'member'); assert.equal(stored.actor_session_id, sessionId); assert.equal(stored.request_id, ids.requestId);
        for (const table of ['collaboration_documents','collaboration_yjs_states']) {
          const row = await db.get(`SELECT xmin=pg_current_xact_id()::text::xid AS own_xmin FROM ${table}
            WHERE ${table === 'collaboration_documents' ? 'id' : 'document_id'}=$1`, [item.receipt.target.documentId]) as { own_xmin?: boolean } | undefined;
          assert.equal(row?.own_xmin, true, table);
        }
        const lineage = await db.get(`SELECT xmin=pg_current_xact_id()::text::xid AS own_xmin FROM file_collaboration_lineages WHERE id=$1`,
          [item.receipt.target.lineageId]) as { own_xmin?: boolean } | undefined;
        assert.equal(lineage?.own_xmin, true);
        const backups = await db.all(`SELECT xmin=pg_current_xact_id()::text::xid AS own_xmin FROM collaboration_yjs_state_backups
          WHERE document_id=$1`, [item.receipt.target.documentId]) as Array<{ own_xmin: boolean }>;
        assert(backups.every(backup => backup.own_xmin === true));
      }
      const parent = await db.get(`SELECT record_text,record_digest,xmin=pg_current_xact_id()::text::xid AS own_xmin
        FROM workspace_path_import_preparations WHERE workspace_id=$1 AND operation_id=$2`, [h.source.workspaceId, job.operationId]) as Record<string, unknown> | undefined;
      assert(parent); assert.equal(parent.own_xmin, true); assert.deepEqual(JSON.parse(parent.record_text as string), record);
      assert.equal(parent.record_digest, crypto.createHash('sha256').update(parent.record_text as string).digest('hex'));
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_path_import_preparations WHERE workspace_id=$1 AND operation_id=$2',
        [h.source.workspaceId, job.operationId])).rows[0].n, 0, 'The caller has not committed B0 yet.');
    };
    const pathPrepInvoke = async (live: Live, job: Job, rollback = false, verifyBirth = true) => withWorkspaceFileLifecycleGuard(
      { workspaceId: h.source.workspaceId, paths: [''] }, async () => {
        const db = await openDb(); let begun = false, failure: Error | undefined;
        try {
          await db.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
          const before = await pathPrepIdentity(db); let record: WorkspacePathImportPreparationRecordV1;
          try { historicalPhase = !verifyBirth; record = await prepare(db, { principal: live, operationId: job.operationId, plan: job.plan }); }
          finally { historicalPhase = false; }
          const after = await pathPrepIdentity(db); assert.equal(before.pid, after.pid); assert.equal(before.start, after.start); assert.equal(before.schema, after.schema);
          if (before.xid !== null) assert.equal(before.xid, after.xid);
          if (verifyBirth) await pathPrepAssertRecord(db, job, record);
          await db.run(rollback ? 'ROLLBACK' : 'COMMIT'); begun = false;
          if (!rollback) { const rows = await pathPrepSqlRows(job); assert.equal(rows.length, 1); assert.deepEqual(JSON.parse(rows[0].record_text), record); }
          return record;
        } catch (error) { failure = error instanceof Error ? error : new Error('B0 caller failed.'); throw error; }
        finally { try { if (begun) await db.run('ROLLBACK'); } finally { await db.close(failure); } }
      });
    const pathPrepAssertNative = async (job: Job, record: WorkspacePathImportPreparationRecordV1) => {
      for (const item of record.imports) {
        const persisted = await load(h.connection, item.receipt.target.documentId); assert(persisted); assert.equal(persisted.documentSequence, 0);
        assert.equal(crypto.createHash('sha256').update(persisted.yjsState).digest('hex'), item.initialBinaryHash);
        assert.equal(crypto.createHash('sha256').update(persisted.stateVector).digest('hex'), item.initialVectorHash);
        const inventory = inspectPersistedDocumentLinksV3(persisted); assert(inventory.coverage.complete); assert.equal(inventory.parserVersion, 3);
        const request = await h.request(h.source, 'member', false, sessionToken);
        const page = await readDocumentForRequest(request, { apiVersion: 1, workspaceId: h.source.workspaceId,
          documentId: item.receipt.target.documentId, format: 'native', maxBytes: 262144 });
        assert(page.complete); assert.equal(page.document.documentId, item.receipt.target.documentId); assert.equal(page.document.lineageId, item.receipt.target.lineageId);
        const requirement = job.plan.importRequirements[item.requirementIndex];
        assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(h.source.rootPath, requirement.path))).digest('hex'), requirement.physical.byteHash);
        assert.equal(filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, requirement.path))), requirement.physical.filesystemIdentity);
      }
      assert(record.nativePlan.version === 2 || record.nativePlan.version === 3);
      assert.equal(record.nativePlan.sourceEvidence.evidenceVersion, record.nativePlan.planIdentityVersion === 3 ? 3 : 2);
      if (record.nativePlan.version === 2) assert(record.nativePlan.nativeGraphPlan.steps.some(step => step.linkIntents.length > 0));
      else assert(record.nativePlan.nativePathPlan.mutations.length > 0);
    };

    phase = 'Move selected Raw and required incoming Raw import atomically, then compile genuine native references';
    const moved = await pathPrepSeed('move');
    // Canonically serialized history sorts destinationPath before sourcePath.
    // Valid plans with that key order must retain the public action identity.
    moved.plan = { ...moved.plan, request: { ...moved.plan.request, selections: moved.plan.request.selections.map(selection =>
      ({ destinationPath: selection.destinationPath!, sourcePath: selection.sourcePath })) } };
    const movedRecord = await pathPrepWithPrincipal('move', live => pathPrepInvoke(live, moved));
    await pathPrepAssertNative(moved, movedRecord); groups++;

    phase = 'Delete imports selected Raw and incoming Raw before native unlink planning';
    const deleted = await pathPrepSeed('delete'); const deleteRecord = await pathPrepWithPrincipal('delete', live => pathPrepInvoke(live, deleted));
    await pathPrepAssertNative(deleted, deleteRecord); assert.equal(deleteRecord.nativePlan.version, 2); groups++;

    phase = 'Request WRITE authority preserves genuine pristine document identity and 0444 original bytes';
    const pristine = await pathPrepSeed('request', { pristine: true, readOnly: true });
    const oldId = (await h.admin.query('SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, pristine.raw])).rows[0].id;
    const pristineFile = await fs.lstat(path.join(h.source.rootPath, pristine.raw), { bigint: true });
    const pristineRecord = await pathPrepWithPrincipal('request', live => pathPrepInvoke(live, pristine));
    assert.equal(pristineRecord.imports.find(item => item.receipt.target.path === pristine.raw)?.receipt.target.documentId, oldId);
    const pristineAfter = await fs.lstat(path.join(h.source.rootPath, pristine.raw), { bigint: true });
    for (const key of ['dev','ino','mode','size','mtimeNs','ctimeNs'] as const) assert.equal(pristineAfter[key], pristineFile[key]);
    await pathPrepAssertNative(pristine, pristineRecord); groups++;

    phase = 'Caller rollback discards the entire B0 import cohort and record without touching any DATA entry';
    const aborted = await pathPrepSeed('move'), rollbackBefore = await pathPrepSnapshot(h);
    await pathPrepWithPrincipal('move', live => pathPrepInvoke(live, aborted, true));
    assert.deepEqual(await pathPrepSnapshot(h), rollbackBefore); assert.deepEqual(await pathPrepSqlRows(aborted), []); groups++;

    phase = 'SID-B historical repeat after real native Move/link state changes and invalid UTF8 replacement at old path';
    const { runDirectMcpWorkspaceMoveService } = await import('../app/lib/files/workspace-operation-mcp-path-service');
    const seconds = Math.floor(Date.now() / 1000), signed = await auth.api.signJWT({ body: { payload: { sub: 'member', azp: clientId, sid: sessionId,
      iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp', iat: seconds - 1, exp: seconds + 600, scope: 'knowledge:read knowledge:write' } } }); assert(signed.token);
    const info: AuthInfo = { token: signed.token, clientId: 'ignored', scopes: [] };
    const preview = await runDirectMcpWorkspaceMoveService({ apiVersion: 1, action: 'preview', workspaceId: h.source.workspaceId,
      selections: [{ sourcePath: moved.raw, destinationPath: moved.destination }] }, info); assert(preview.action === 'preview');
    const applied = await runDirectMcpWorkspaceMoveService({ apiVersion: 1, action: 'apply', workspaceId: h.source.workspaceId,
      selections: [{ sourcePath: moved.raw, destinationPath: moved.destination }], operationId: `post_b0_${crypto.randomUUID().replaceAll('-', '')}`, planId: preview.preview.planId }, info);
    assert(applied.action === 'apply'); assert.equal(applied.operation.completion.status, 'confirmed');
    const incoming = movedRecord.imports.find(item => item.receipt.target.path === moved.incoming); assert(incoming);
    assert.equal((await load(h.connection, incoming.receipt.target.documentId))?.documentSequence, 1);
    await fs.writeFile(path.join(h.source.rootPath, moved.raw), Buffer.from([0xff, 0xfe]), { flag: 'wx', mode: 0o600 });
    const historicalRows = await pathPrepSqlRows(moved), originalSession = sessionId;
    const pathPrepRotate = async () => {
      const next = `prep-session-${crypto.randomUUID()}`, token = crypto.randomBytes(32).toString('hex'), now = Date.now();
      await h.admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,\'member\',$3,$4,$4)', [next, token, now + 3600000, now]);
      assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [sessionId])).rowCount, 1);
      sessionId = next; sessionToken = token; assert.equal((await auth.api.getSession({ headers: (await h.request(h.source, 'member', false, token)).headers }))?.session.id, next);
    };
    await pathPrepRotate(); assert.notEqual(sessionId, originalSession);
    const repeated = await pathPrepWithPrincipal('move', live => pathPrepNoWrite(h, () => pathPrepInvoke(live, moved, false, false)));
    assert.deepEqual(repeated, movedRecord); assert.equal(repeated.origin.sessionId, originalSession);
    assert.deepEqual(await pathPrepSqlRows(moved), historicalRows); groups++;

    // Remove only our deliberate D2 fixture before constructing unrelated fresh
    // previews. Historical proof above must not be confused with a fresh plan.
    await fs.unlink(path.join(h.source.rootPath, moved.raw));
    phase = 'Actual current WRITE revocation rejects before the first B0 import';
    const denied = await pathPrepSeed('move');
    try {
      await assert.rejects(pathPrepWithPrincipal('move', async live => {
        await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: false, canManage: false });
        return pathPrepNoWrite(h, () => pathPrepInvoke(live, denied));
      }), error => { assert.equal(pathPrepCode(error), 'MCP_READ_PRINCIPAL_ACCESS_DENIED'); return true; });
    } finally { await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false }); }
    groups++;

    phase = 'Changed real FD/FileVersion rejects before all native imports and record DML';
    const stale = await pathPrepSeed('move'); await fs.appendFile(path.join(h.source.rootPath, stale.raw), '\nactual later source version\n');
    await assert.rejects(pathPrepWithPrincipal('move', live => pathPrepNoWrite(h, () => pathPrepInvoke(live, stale))), error => {
      assert.equal(pathPrepCode(error), 'PATH_IMPORT_PREPARATION_CHANGED'); return true;
    }); groups++;

    phase = 'Forged handle, genuine wrong brand and direct unregistered importer cannot acquire import authority';
    const invalid = await pathPrepSeed('move');
    await assert.rejects(pathPrepNoWrite(h, () => pathPrepInvoke({ kind: 'move', principal: {} } as unknown as Live, invalid)), error => {
      assert.equal(pathPrepCode(error), 'MCP_READ_PRINCIPAL_REQUIRED'); return true;
    });
    await assert.rejects(pathPrepWithPrincipal('delete', live => pathPrepNoWrite(h,
      () => pathPrepInvoke({ kind: 'move', principal: live.principal } as unknown as Live, invalid))), error => {
      assert.equal(pathPrepCode(error), 'MCP_READ_PRINCIPAL_REQUIRED'); return true;
    });
    const { persistWorkspacePathOriginalMarkdownImportOnConnection } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const db = await openDb(); let begun = false;
    try {
      await db.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
      await assert.rejects(pathPrepNoWrite(h, () => persistWorkspacePathOriginalMarkdownImportOnConnection(db,
        { preparation: {} as Parameters<typeof persistWorkspacePathOriginalMarkdownImportOnConnection>[1]['preparation'], requirementIndex: 0 }), 'none'), error => {
        assert.equal(pathPrepCode(error), 'PATH_IMPORT_PREPARATION_PHASE_REQUIRED'); return true;
      });
    } finally { try { if (begun) await db.run('ROLLBACK'); } finally { await db.close(); } }
    groups++;

    phase = 'Required Raw import preserves untouched unselected Raw occurrences across the changed catalogue';
    const untouched = `untouched-${crypto.randomUUID()}.md`, untouchedPath = path.join(h.source.rootPath, untouched);
    await fs.writeFile(untouchedPath, `[Existing](${moved.destination})\n`, { flag: 'wx', mode: 0o444 });
    const mixed = await pathPrepSeed('move'), physicalBefore = (await pathPrepSnapshot(h)).files;
    assert(!mixed.plan.importRequirements.some(requirement => requirement.path === untouched));
    const mixedRecord = await pathPrepWithPrincipal('move', live => pathPrepInvoke(live, mixed));
    await pathPrepAssertNative(mixed, mixedRecord);
    assert.equal(mixedRecord.nativePlan.planIdentityVersion, 3);
    assert(!mixedRecord.imports.some(item => item.receipt.target.path === untouched));
    assert.deepEqual((await pathPrepSnapshot(h)).files, physicalBefore);
    assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
      [h.source.workspaceId, untouched])).rows[0].n, 0);
    groups++;
    assert.equal(groups, 9); console.log(JSON.stringify({ suite: 'workspace-path-import-preparation-phase', groups, passed: true,
      scope: 'genuine PG18 B0; existing native Move establishes later state; no prepared public Apply, browser or projector acceptance' }));
  }); complete = true; }
  finally { if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase; }
}

workspacePathImportPreparationPhasePostgresTest().catch(error => {
  process.exitCode = 1; console.error(JSON.stringify({ suite: 'workspace-path-import-preparation-phase', phase, groups,
    name: error instanceof Error ? error.name : 'UnknownError', code: pathPrepCode(error),
    message: error instanceof Error ? error.message.slice(0, 1500) : undefined,
    assertion: error instanceof assert.AssertionError ? error.message.slice(0, 1500) : undefined,
    stack: error instanceof Error ? error.stack?.split('\n').slice(1, 9) : [] }));
});
