import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { DirectMcpWorkspacePathImportPreviewV1, DirectMcpWorkspacePathResultV1 } from '../app/lib/mcp/server/workspace-path-tool-contract';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

type Fixture = Parameters<Parameters<typeof withNativeCopyMetadataOwnerFixture>[0]>[0];
type Kind = 'move' | 'delete';
type Job = { kind: Kind; operationId: string; raw: string; incoming: string; destination: string; bytes: Map<string, Buffer> };
const publicPathSha = (bytes: string | Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const publicPathCode = (error: unknown): string | null => {
  const value: unknown = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null;
  return typeof value === 'string' && /^[A-Z0-9][A-Z0-9_]{1,127}$/u.test(value) ? value : null;
};
function publicPathFailureFrames(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error) || depth > 4) return null;
  return { name: error.name, code: publicPathCode(error), frames: error.stack?.split('\n').slice(1, 7),
    ...(error.cause instanceof Error ? { cause: publicPathFailureFrames(error.cause, depth + 1) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.slice(0, 6).map(value => publicPathFailureFrames(value, depth + 1)) } : {}) };
}

async function publicPathFile(file: string) {
  const before = await fs.lstat(file, { bigint: true }); assert(!before.isSymbolicLink());
  const identity = { dev: String(before.dev), ino: String(before.ino), mode: String(before.mode), uid: String(before.uid), gid: String(before.gid),
    nlink: String(before.nlink), size: String(before.size), mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) };
  if (before.isDirectory()) return { ...identity, directory: true, sha256: null };
  assert(before.isFile() && before.nlink === BigInt(1) && before.size <= BigInt(8 * 1024 ** 2));
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await fd.stat({ bigint: true });
    for (const key of ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(opened[key], before[key]);
    const bytes = await fd.readFile(); assert.equal(BigInt(bytes.length), before.size);
    for (const stat of [await fd.stat({ bigint: true }), await fs.lstat(file, { bigint: true })]) {
      for (const key of ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(stat[key], before[key]);
    }
    return { ...identity, directory: false, sha256: publicPathSha(bytes) };
  } finally { await fd.close(); }
}

async function publicPathSnapshot(h: Fixture) {
  const checks = await Promise.allSettled([(async () => {
    const rows: Record<string, unknown> = {}; let begun = false, total = 0;
    try {
      await h.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
      const identity = (await h.admin.query(`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid::text AS oid,
        current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS ro,
        pg_current_xact_id_if_assigned() IS NULL AS unassigned`)).rows[0];
      assert.deepEqual(identity, { schema: h.schema, oid: h.schemaOid, isolation: 'repeatable read', ro: 'on', unassigned: true });
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)'
          OR c.relname IN ('workspace_path_import_preparations','file_revisions','file_revision_contents','file_version_blobs','workspace_trash_entries'))
        ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
      assert(tables.length > 15 && tables.length <= 512);
      for (const table of tables) {
        assert.match(table.relname, /^[a-z][a-z0-9_]{0,100}$/u);
        const values = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM "${h.schema}"."${table.relname}" t
          ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
        assert(values.length <= 10000); for (const row of values) { total += Buffer.byteLength(row.body); assert(total <= 128 * 1024 ** 2); }
        rows[table.relname] = { oid: table.oid, values };
      }
      assert.equal((await h.admin.query('SELECT pg_current_xact_id_if_assigned() IS NULL AS unassigned')).rows[0].unassigned, true);
      await h.admin.query('COMMIT'); begun = false; return rows;
    } finally { if (begun) await h.admin.query('ROLLBACK'); }
  })(), (async () => {
    assert.equal(await fs.realpath(h.dataRoot), h.dataRoot); const pending = ['.'], files: unknown[] = []; let bytes = 0;
    for (let index = 0; index < pending.length; index++) {
      assert(pending.length <= 10000); const relative = pending[index], file = path.join(h.dataRoot, relative);
      assert(file === h.dataRoot || file.startsWith(h.dataRoot + path.sep)); const state = await publicPathFile(file);
      files.push({ path: relative, ...state }); bytes += Number(state.size); assert(bytes <= 128 * 1024 ** 2);
      if (state.directory) pending.push(...(await fs.readdir(file)).sort().map(name => path.join(relative, name)));
    }
    return files;
  })()]);
  const failures = checks.flatMap(check => check.status === 'rejected' ? [check.reason as unknown] : []);
  if (failures.length) throw new AggregateError(failures, 'Public path snapshot oracles failed.');
  assert(checks[0].status === 'fulfilled' && checks[1].status === 'fulfilled'); return { rows: checks[0].value, files: checks[1].value };
}

async function publicPathNoWrite<T>(h: Fixture, operation: () => Promise<T>, historical = false): Promise<T> {
  const before = await publicPathSnapshot(h); let statements = 0, writes = 0, currentNative = 0, result: T | undefined, failure: unknown;
  try { result = await h.withProbe(async event => {
    assert(++statements <= 7000);
    if (['INSERT','UPDATE','DELETE','CREATE','ALTER','DROP','TRUNCATE','NOTIFY'].includes(event.result.command)
      || /\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX)|NOTIFY)\b/iu.test(event.text)
      || /\bpg_notify\s*\(/iu.test(event.text)) writes++;
    if (historical && /\b(?:FROM|JOIN)\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?(?:collaboration_documents|collaboration_yjs_states|file_collaboration_lineages)"?\b/iu.test(event.text)) currentNative++;
  }, operation); } catch (error) { failure = error; }
  const after = await Promise.allSettled([(async () => assert.deepEqual(await publicPathSnapshot(h), before))(),
    (async () => { assert(statements > 0); assert.equal(writes, 0); assert.equal(currentNative, 0, 'Completed history cannot probe current native state.'); })()]);
  const failures = [...(failure === undefined ? [] : [failure]), ...after.flatMap(check => check.status === 'rejected' ? [check.reason as unknown] : [])];
  if (failures.length === 1) throw failures[0]; if (failures.length) throw new AggregateError(failures, 'Public path NoWrite checks failed.'); return result as T;
}

/** Actual decoded public MCP services, not HTTP or a manual B0/Claim bypass.
 * Fixture mutation and token issue remain outside every NoWrite scope. */
export async function workspacePathImportPublicPostgresTest(): Promise<void> {
  let phase = 'fixture', groups = 0; const previousBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'move_knowledge_source,delete_knowledge_source,read_knowledge_source' });
    const { auth } = await import('../app/lib/auth');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { upsertPostgresWorkspaceMemberForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { runDirectMcpWorkspaceMoveService, runDirectMcpWorkspaceDeleteService } = await import('../app/lib/files/workspace-operation-mcp-path-service');
    const wire = await import('../app/lib/mcp/server/workspace-path-tool-contract');
    const { decodeWorkspacePathImportPreparationRecordV1 } = await import('../app/lib/files/workspace-path-import-preparation-record');
    const { prepareMarkdownFileImport } = await import('../app/lib/collaboration/markdown-file-import');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { inspectArchivedNativeSnapshot } = await import('../app/lib/collaboration/archived-native-snapshot');
    const { inspectPersistedDocumentLinksV3 } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { readDocumentForRequest } = await import('../app/lib/documents/service');
    const owner = resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' });
    await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false });
    assert.equal(h.source.permissions.canWrite, false);
    assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1
      WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1);
    const clientId = `public-path-${crypto.randomUUID()}`;
    await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
      VALUES($1,$1,'member','Public path real JWT',0,'[]',100,100)`, [clientId]);
    await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
      VALUES($1,$2,'member','["knowledge:read","knowledge:write"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), clientId]);
    await h.admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at) VALUES($1,'owner',100,100)`, [h.source.workspaceId]);
    await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,'member',$2,100,100)`, [clientId, h.source.workspaceId]);
    let sessionId = 'session-member', sessionToken: string | undefined = undefined;
    const publicPathIssue = async (): Promise<AuthInfo> => {
      const seconds = Math.floor(Date.now() / 1000), issued = await auth.api.signJWT({ body: { payload: { sub: 'member', azp: clientId, sid: sessionId,
        iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp', iat: seconds - 1, exp: seconds + 600, scope: 'knowledge:read knowledge:write' } } });
      assert(issued.token); return { token: issued.token, clientId: 'untrusted-client-ignored', scopes: [], extra: { userId: 'owner' } };
    };
    let info = await publicPathIssue();
    const publicPathCall = async (job: Job, action: 'preview' | 'apply' | 'status' | 'recover', planId?: string): Promise<DirectMcpWorkspacePathResultV1> => {
      const body = { api_version: 1, action, workspace_id: h.source.workspaceId,
        ...(action === 'status' ? {} : job.kind === 'move' ? { selections: [{ source_path: job.raw, destination_path: job.destination }] } : { path: job.raw }),
        ...(action === 'preview' ? {} : { operation_id: job.operationId }), ...(action === 'apply' || action === 'recover' ? { plan_id: planId } : {}) };
      const result = job.kind === 'move' ? await runDirectMcpWorkspaceMoveService(wire.decodeDirectMcpWorkspaceMoveRequestV1(body), info)
        : await runDirectMcpWorkspaceDeleteService(wire.decodeDirectMcpWorkspaceDeleteRequestV1(body), info);
      const encoded = wire.encodeDirectMcpWorkspacePathResultV1(result, action === 'preview' ? undefined : job.operationId);
      assert(!/"(?:sourceEvidence|nativePlan|physicalSourceProof|filesystemIdentity|requestFingerprint|actorUserId|actorSessionId|stateVector|yjsState|requestHash|bindingProof)"\s*:/u.test(JSON.stringify(encoded)));
      return encoded;
    };
    const publicPathReject = (expected: string, operationId?: string) => (error: unknown): boolean => {
      assert(!(error instanceof assert.AssertionError)); const failure = wire.workspacePathFailureV1(error, operationId);
      assert.equal(failure.body.code, expected); if (operationId) assert.equal(failure.body.operationId, operationId); return true;
    };
    const publicPathSeed = async (kind: Kind, native = false): Promise<Job> => {
      const stem = `public-${crypto.randomUUID()}`, raw = `${stem}.md`, incoming = `${stem}-incoming.md`, destination = `${stem}-moved.md`;
      // A genuine supported source-only comment makes auto import preserve
      // Plain text. This fixture precondition avoids invented Rich/Yjs IDs.
      const prefix = '<!-- theme: public-import-fixture -->\n\n';
      const bytes = new Map([[raw, Buffer.from(`${prefix}# Original ${stem}\n\n[Self](${raw})\n`)], [incoming, Buffer.from(`${prefix}[Target](${raw})\n`)]]);
      for (const [file, content] of bytes) {
        assert.equal(prepareMarkdownFileImport(content).representation, 'plain_text');
        if (native) await h.upload(file, content); else await fs.writeFile(path.join(h.source.rootPath, file), content, { mode: 0o600, flag: 'wx' });
      }
      return { kind, operationId: `public_path_${crypto.randomUUID().replaceAll('-', '')}`, raw, incoming, destination, bytes };
    };
    const publicPathRecord = async (job: Job) => {
      const rows = (await h.admin.query('SELECT record_text,record_digest,xmin::text FROM workspace_path_import_preparations WHERE workspace_id=$1 AND operation_id=$2',
        [h.source.workspaceId, job.operationId])).rows; assert.equal(rows.length, 1);
      assert.equal(publicPathSha(rows[0].record_text), rows[0].record_digest);
      const record = decodeWorkspacePathImportPreparationRecordV1(rows[0].record_text); assert.equal(record.operationId, job.operationId);
      assert.equal(record.imports.length, 2); assert.equal(record.origin.userId, 'member'); assert.equal(record.origin.clientId, clientId);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_file_operation_batches WHERE batch_id=$1', [record.batchId])).rows[0].n, 1);
      for (const imported of record.imports) {
        assert.equal(imported.receipt.target.representation, 'plain_text'); assert.equal(imported.receipt.sourceHash, publicPathSha(job.bytes.get(imported.receipt.target.path)!));
      }
      return record;
    };
    const publicPathExpectedContent = (job: Job, file: string, label: string, next: string | null) => {
      const text = job.bytes.get(file)!.toString('utf8'), old = `[${label}](${job.raw})`; assert.equal(text.split(old).length, 2);
      return { kind: 'plain_text', text: text.replace(old, next === null ? label : `[${label}](${next})`) };
    };
    const publicPathNativeRead = async (state: PersistedCollaborationState, lineageId: string) => {
      const page = await readDocumentForRequest(await h.request(h.source, 'member', false, sessionToken), { apiVersion: 1, workspaceId: h.source.workspaceId,
        documentId: state.documentId, format: 'native', maxBytes: 262144 });
      assert(page.complete); assert.equal(page.nextCursor, null); assert.equal(page.document.documentId, state.documentId); assert.equal(page.document.lineageId, lineageId);
      const body = JSON.parse(page.fragment) as { content: unknown; representation: string };
      assert.equal(body.representation, state.representation);
      assert.deepEqual(body.content, JSON.parse(JSON.stringify(authoritativeNativeCollaborationSnapshot(state).content)));
    };
    const publicPathAssertApplied = async (job: Job, preview: DirectMcpWorkspacePathImportPreviewV1, result: DirectMcpWorkspacePathResultV1) => {
      assert(result.action !== 'preview'); const record = await publicPathRecord(job);
      assert.equal(record.previewPlan.planId, preview.planId); assert.equal(result.operation.batchId, record.batchId);
      assert.equal(result.operation.planId, record.nativePlan.planId); assert.notEqual(result.operation.planId, preview.planId);
      assert.deepEqual(result.operation.preparation, { version: 1, previewPlanId: preview.planId }); assert.equal(result.operation.completion.status, 'confirmed');
      const target = record.imports.find(item => item.receipt.target.path === job.raw)!, incoming = record.imports.find(item => item.receipt.target.path === job.incoming)!;
      assert(target && incoming); const state = await load(h.connection, incoming.receipt.target.documentId); assert(state);
      assert.equal(state.documentSequence, 1); assert.deepEqual(authoritativeNativeCollaborationSnapshot(state).content,
        publicPathExpectedContent(job, job.incoming, 'Target', job.kind === 'delete' ? null : job.destination));
      const links = inspectPersistedDocumentLinksV3(state); assert(links.coverage.complete);
      assert.equal(links.links.length, job.kind === 'delete' ? 0 : 1); if (job.kind === 'move') assert.equal(links.links[0].targetPathText, job.destination);
      await publicPathNativeRead(state, incoming.receipt.target.lineageId);
      const targetState = await load(h.connection, target.receipt.target.documentId, job.kind === 'delete'); assert(targetState);
      const registry = (await h.admin.query('SELECT id,path,status,lineage_id FROM collaboration_documents WHERE id=$1', [target.receipt.target.documentId])).rows[0];
      assert.equal(registry.id, target.receipt.target.documentId); assert.equal(registry.lineage_id, target.receipt.target.lineageId);
      if (job.kind === 'delete') {
        assert.equal(registry.status, 'archived'); assert.equal(targetState.status, 'archived'); assert.equal(targetState.lifecycleGeneration, target.receipt.target.lifecycleGeneration + 1);
        assert.equal(publicPathSha(targetState.yjsState), target.initialBinaryHash); assert.equal(publicPathSha(targetState.stateVector), target.initialVectorHash);
        assert.deepEqual(inspectArchivedNativeSnapshot(targetState).content, { kind: 'plain_text', text: job.bytes.get(job.raw)!.toString('utf8') });
      } else {
        assert.equal(registry.path, job.destination); assert.equal(registry.status, 'active'); assert.equal(targetState.path, job.destination);
        assert.equal(targetState.lifecycleGeneration, target.receipt.target.lifecycleGeneration); assert.equal(targetState.documentSequence, 1);
        assert.deepEqual(authoritativeNativeCollaborationSnapshot(targetState).content, publicPathExpectedContent(job, job.raw, 'Self', job.destination));
        await publicPathNativeRead(targetState, target.receipt.target.lineageId);
      }
      await assert.rejects(fs.lstat(path.join(h.source.rootPath, job.raw)), { code: 'ENOENT' }); return record;
    };

    phase = 'Raw Move public preparation is NoWrite; ORIGINAL preview ID applies and remains mapped through status/recover';
    const moved = await publicPathSeed('move'), movePreview = await publicPathNoWrite(h, () => publicPathCall(moved, 'preview'));
    assert(movePreview.action === 'preview' && movePreview.preview.kind === 'native-path-import-preparation');
    assert.equal(movePreview.preview.executionReady, false); assert.equal(movePreview.preview.readiness, 'requires-import-rebinding');
    assert.deepEqual(movePreview.preview.imports.map(item => item.path).sort(), [moved.raw, moved.incoming].sort());
    assert(movePreview.preview.imports.find(item => item.path === moved.raw)?.reasons.includes('selected'));
    assert.deepEqual(movePreview.preview.imports.find(item => item.path === moved.incoming)?.reasons, ['link-change']);
    const moveResult = await publicPathCall(moved, 'apply', movePreview.preview.planId), moveRecord = await publicPathAssertApplied(moved, movePreview.preview, moveResult);
    for (const action of ['status','recover'] as const) {
      const result: DirectMcpWorkspacePathResultV1 = await publicPathNoWrite(h, (): Promise<DirectMcpWorkspacePathResultV1> => publicPathCall(moved, action, movePreview.preview.planId), true);
      assert(result.action !== 'preview'); assert.equal(result.operation.completion.status, 'confirmed'); assert.deepEqual(result.operation.preparation, { version: 1, previewPlanId: movePreview.preview.planId });
    }
    groups++;

    phase = 'Raw Delete public ORIGINAL preview ID archives original bytes/IDs and centrally unlinks incoming Raw';
    const deleted = await publicPathSeed('delete'), deletePreview = await publicPathNoWrite(h, () => publicPathCall(deleted, 'preview'));
    assert(deletePreview.action === 'preview' && deletePreview.preview.kind === 'native-path-import-preparation');
    assert.equal(deletePreview.preview.executionReady, false); assert.equal(deletePreview.preview.readiness, 'requires-import-rebinding');
    const deleteResult = await publicPathCall(deleted, 'apply', deletePreview.preview.planId);
    await publicPathAssertApplied(deleted, deletePreview.preview, deleteResult);
    for (const action of ['status','recover'] as const) {
      const result: DirectMcpWorkspacePathResultV1 = await publicPathNoWrite(h, (): Promise<DirectMcpWorkspacePathResultV1> => publicPathCall(deleted, action, deletePreview.preview.planId), true);
      assert(result.action !== 'preview'); assert.equal(result.operation.completion.status, 'confirmed'); assert.deepEqual(result.operation.preparation, { version: 1, previewPlanId: deletePreview.preview.planId });
    }
    groups++;

    phase = 'Actual B0 COMMIT succeeds but acknowledgement is lost; SID-B recovers ORIGINAL preview ID with original SID-A';
    const interrupted = await publicPathSeed('move'), lostPreview = await publicPathNoWrite(h, () => publicPathCall(interrupted, 'preview'));
    assert(lostPreview.action === 'preview' && lostPreview.preview.kind === 'native-path-import-preparation');
    const previewId = lostPreview.preview.planId, originalSession = sessionId, b0Clients = new Set<MetadataSqlEvent['client']>(); let lost = false;
    await assert.rejects(h.withProbe(async event => {
      if (/\bINSERT\s+INTO\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?(?:workspace_path_import_preparations|workspace_file_operation_batches)"?(?=\s|\()/iu.test(event.text)) b0Clients.add(event.client);
      if (!lost && b0Clients.has(event.client) && /^\s*COMMIT\s*$/iu.test(event.text)) {
        assert.equal(event.result.command, 'COMMIT'); assert.equal(b0Clients.size, 1); lost = true;
        throw Object.assign(new Error('Public fixture lost the completed B0 COMMIT acknowledgement.'), { code: 'PUBLIC_PATH_FIXTURE_ACK_LOST' });
      }
    }, () => publicPathCall(interrupted, 'apply', previewId)), publicPathReject('PATH_OUTCOME_UNCONFIRMED', interrupted.operationId));
    assert(lost); const initialInterrupted = await publicPathRecord(interrupted); assert.equal(initialInterrupted.origin.sessionId, originalSession);
    const header = (await h.admin.query('SELECT status,authorization_json,lease_owner,lease_token FROM workspace_file_operation_batches WHERE batch_id=$1', [initialInterrupted.batchId])).rows[0];
    assert.equal(header.status, 'needs_recovery'); assert.equal(header.lease_owner, null); assert.equal(header.lease_token, null);
    assert.equal(JSON.parse(header.authorization_json).actorSessionId, originalSession);
    for (const [file, bytes] of interrupted.bytes) assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, file)), bytes);
    const sessionB = `public-session-${crypto.randomUUID()}`, token = crypto.randomBytes(32).toString('hex'), now = Date.now();
    await h.admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,\'member\',$3,$4,$4)', [sessionB, token, now + 3600000, now]);
    assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [sessionId])).rowCount, 1);
    sessionId = sessionB; sessionToken = token; info = await publicPathIssue();
    assert.equal((await auth.api.getSession({ headers: (await h.request(h.source, 'member', false, token)).headers }))?.session.id, sessionB);
    const recovered = await publicPathCall(interrupted, 'recover', previewId), recoveredRecord = await publicPathAssertApplied(interrupted, lostPreview.preview, recovered);
    assert.deepEqual(recoveredRecord, initialInterrupted); assert.equal(recoveredRecord.origin.sessionId, originalSession);
    const finalAuthorization = (await h.admin.query('SELECT authorization_json FROM workspace_file_operation_batches WHERE batch_id=$1', [initialInterrupted.batchId])).rows[0].authorization_json;
    assert.deepEqual(finalAuthorization, header.authorization_json);
    const p0 = (await h.admin.query('SELECT request_id,preparation_text FROM workspace_file_operation_move_preparations WHERE batch_id=$1', [initialInterrupted.batchId])).rows;
    assert.equal(p0.length, 1); assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_admission_requests WHERE request_id=$1', [p0[0].request_id])).rows[0].n, 1); groups++;

    phase = 'Stale preview, changed original request, current rights denial and blocked collision perform no imports or file writes';
    const stale = await publicPathSeed('move'), stalePreview = await publicPathNoWrite(h, () => publicPathCall(stale, 'preview'));
    assert(stalePreview.action === 'preview'); await fs.appendFile(path.join(h.source.rootPath, stale.raw), '\nReal later source edit.\n');
    await assert.rejects(publicPathNoWrite(h, () => publicPathCall(stale, 'apply', stalePreview.preview.planId)), publicPathReject('PATH_PLAN_CHANGED', stale.operationId));
    await assert.rejects(publicPathNoWrite(h, () => publicPathCall({ ...moved, destination: `${moved.destination}-changed.md` }, 'recover', movePreview.preview.planId), true),
      publicPathReject('PATH_PLAN_CHANGED', moved.operationId));
    const denied = await publicPathSeed('move'), deniedPreview = await publicPathNoWrite(h, () => publicPathCall(denied, 'preview')); assert(deniedPreview.action === 'preview');
    try {
      await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: false, canManage: false });
      await assert.rejects(publicPathNoWrite(h, () => publicPathCall(denied, 'apply', deniedPreview.preview.planId)), publicPathReject('ACCESS_DENIED', denied.operationId));
    } finally { await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false }); }
    const blocked = { ...await publicPathSeed('move'), destination: moved.destination }, blockedPreview = await publicPathNoWrite(h, () => publicPathCall(blocked, 'preview'));
    assert(blockedPreview.action === 'preview' && blockedPreview.preview.kind === 'native-path-import-preparation');
    assert.equal(blockedPreview.preview.readiness, 'blocked'); assert.equal(blockedPreview.preview.executionReady, false); assert(blockedPreview.preview.issues.length > 0);
    await assert.rejects(publicPathNoWrite(h, () => publicPathCall(blocked, 'apply', blockedPreview.preview.planId)), publicPathReject('PATH_NATIVE_REQUIRED', blocked.operationId)); groups++;

    phase = 'Ordinary native preview retains exact legacy fields and works without any import record or preparation metadata';
    const native = await publicPathSeed('move', true), nativePreview = await publicPathNoWrite(h, () => publicPathCall(native, 'preview'));
    assert(nativePreview.action === 'preview' && nativePreview.preview.kind === 'move');
    assert.deepEqual(Object.keys(nativePreview.preview).sort(), ['kind','workspaceId','planId','readiness','paths','linkChanges','coverage'].sort());
    assert.equal(nativePreview.preview.readiness, 'ready'); assert.equal(nativePreview.preview.linkChanges.rewrites, 2);
    const nativeResult = await publicPathCall(native, 'apply', nativePreview.preview.planId); assert(nativeResult.action === 'apply');
    assert.equal(nativeResult.operation.completion.status, 'confirmed'); assert.equal(Object.hasOwn(nativeResult.operation, 'preparation'), false);
    for (const action of ['status','recover'] as const) {
      const result: DirectMcpWorkspacePathResultV1 = await publicPathNoWrite(h, (): Promise<DirectMcpWorkspacePathResultV1> => publicPathCall(native, action, nativePreview.preview.planId), true);
      assert(result.action !== 'preview'); assert.equal(result.operation.completion.status, 'confirmed'); assert.equal(Object.hasOwn(result.operation, 'preparation'), false);
    }
    assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_path_import_preparations WHERE workspace_id=$1 AND operation_id=$2', [h.source.workspaceId, native.operationId])).rows[0].n, 0); groups++;

    // The actual whole-workspace collector must see valid source bytes during
    // all fresh families. Deliberate invalid D2 belongs only to final history.
    phase = 'Completed historical Apply/status/recover with ORIGINAL ID ignore invalid D2 and remain wholly NoWrite under SID-B';
    await fs.writeFile(path.join(h.source.rootPath, moved.raw), Buffer.from([0xff, 0xfe]), { mode: 0o600, flag: 'wx' });
    const originalRows = (await h.admin.query('SELECT record_text,record_digest,xmin::text FROM workspace_path_import_preparations WHERE batch_id=$1', [moveRecord.batchId])).rows;
    for (const action of ['apply','status','recover'] as const) {
      const result: DirectMcpWorkspacePathResultV1 = await publicPathNoWrite(h, (): Promise<DirectMcpWorkspacePathResultV1> => publicPathCall(moved, action, movePreview.preview.planId), true);
      assert(result.action !== 'preview'); assert.equal(result.operation.completion.status, 'confirmed');
      assert.equal(result.operation.planId, moveRecord.nativePlan.planId); assert.deepEqual(result.operation.preparation, { version: 1, previewPlanId: movePreview.preview.planId });
      if (result.action !== 'status') assert.equal(result.alreadyKnown, true);
    }
    assert.deepEqual((await h.admin.query('SELECT record_text,record_digest,xmin::text FROM workspace_path_import_preparations WHERE batch_id=$1', [moveRecord.batchId])).rows, originalRows); groups++;
    assert.equal(groups, 6); console.log(JSON.stringify({ suite: 'workspace-path-import-public', groups, passed: true,
      scope: 'actual decode/MCP services/encode + genuine PG/current JWT/native owners; no HTTP/TCP/browser, OAuth sign-in or deployment claim' }));
  }); } catch (error) {
    console.error(JSON.stringify({ suite: 'workspace-path-import-public', phase, groups, code: publicPathCode(error), name: error instanceof Error ? error.name : 'UnknownError',
      assertion: error instanceof assert.AssertionError ? error.message.slice(0, 1200) : undefined, failure: publicPathFailureFrames(error) })); throw error;
  } finally { if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase; }
}
