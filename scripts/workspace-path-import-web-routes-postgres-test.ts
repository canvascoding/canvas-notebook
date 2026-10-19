import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { NextRequest } from 'next/server';
import type { NativeCollaborationContent } from '../app/lib/collaboration/document-snapshot';
import type { getNativeInspectionSchema } from '../app/lib/collaboration/native-inspection-schema';
import type { WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';
import type { WorkspacePathImportPreparationPreviewPublic } from '../app/lib/files/workspace-path-operation-preview';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

type Fixture = Parameters<Parameters<typeof withNativeCopyMetadataOwnerFixture>[0]>[0];
type Job = { kind: 'rename' | 'delete'; source: string; destination: string; incoming: string;
  operationId: string; preview: WorkspacePathImportPreparationPreviewPublic; originalSessionId: string };

async function webPathRouteFile(file: string) {
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
    return { ...identity, directory: false, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally { await fd.close(); }
}

/** Both independent oracles run, including after an operation rejects. Only
 * the fixture admin connection reads; no application authority is fabricated. */
async function webPathRouteSnapshot(h: Fixture) {
  const checks = await Promise.allSettled([(async () => {
    let begun = false, total = 0; const rows: Record<string, unknown> = {};
    try {
      await h.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
      const realm = (await h.admin.query(`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid::text AS oid,
        current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS isolation,
        pg_current_xact_id_if_assigned() IS NULL AS unassigned`)).rows[0];
      assert.deepEqual(realm, { schema: h.schema, oid: h.schemaOid, ro: 'on', isolation: 'repeatable read', unassigned: true });
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r'
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
      const identity = await webPathRouteFile(full); files.push({ path: relative, ...identity });
      total += Number(identity.size); assert(total <= 128 * 1024 ** 2);
      if (identity.directory) pending.push(...(await fs.readdir(full)).sort().map(name => path.join(relative, name)));
    }
    return files;
  })()]);
  const errors = checks.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
  if (errors.length) throw new AggregateError(errors, 'Web route snapshot oracles failed.');
  assert(checks[0].status === 'fulfilled' && checks[1].status === 'fulfilled');
  return { rows: checks[0].value, files: checks[1].value };
}

async function webPathRouteNoWrite<T>(h: Fixture, operation: () => Promise<T>, historical = false, noNativeAdapterSql = false): Promise<T> {
  const before = await webPathRouteSnapshot(h); let statements = 0, writes = 0, forbidden = 0, result: T | undefined, failure: unknown;
  try { result = await h.withProbe(async event => {
    statements++; if (statements > 6000) throw new Error('Web route SQL observation budget exceeded.');
    if (['INSERT','UPDATE','DELETE','MERGE','CREATE','ALTER','DROP','TRUNCATE','NOTIFY'].includes(event.result.command)
      || /\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX)|NOTIFY)\b/iu.test(event.text)
      || /\bpg_notify\s*\(/iu.test(event.text)) writes++;
    if (historical && /\b(?:FROM|JOIN)\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?(?:collaboration_documents|collaboration_yjs_states|file_collaboration_lineages)"?\b/iu.test(event.text)) forbidden++;
  }, operation); } catch (error) { failure = error; }
  const checks = await Promise.allSettled([(async () => assert(isDeepStrictEqual(await webPathRouteSnapshot(h), before),
    'Complete owned-schema rows/xmins/OIDs or full DATA FD census changed.'))(),
    (async () => { assert.equal(writes, 0); assert.equal(forbidden, 0, 'Historical B0 must not read current source/native rows.');
      if (noNativeAdapterSql) assert.equal(statements, 0); else assert(statements > 0); })()]);
  const errors = [...(failure === undefined ? [] : [failure]), ...checks.flatMap(check => check.status === 'rejected' ? [check.reason as unknown] : [])];
  if (errors.length === 1) throw errors[0]; if (errors.length) throw new AggregateError(errors, 'Web route no-write checks failed.'); return result as T;
}

function webPathRouteExpectedContent(supplied: NativeCollaborationContent, previous: string, next: string | null,
  label: string, schema: ReturnType<typeof getNativeInspectionSchema>): NativeCollaborationContent {
  const content = structuredClone(supplied); let changes = 0;
  if (content.kind === 'plain_text') {
    const old = `[${label}](${previous})`; assert.equal(content.text.split(old).length, 2);
    content.text = content.text.replace(old, next === null ? label : `[${label}](${next})`); return content;
  }
  const pending = [content.document];
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index];
    if (node.marks) node.marks = node.marks.flatMap(mark => {
      if (mark.type !== 'link' || mark.attrs?.href !== previous) return [mark]; changes++;
      return next === null ? [] : [{ ...mark, attrs: { ...mark.attrs, href: next } }];
    });
    pending.push(...(node.content ?? []));
  }
  assert.equal(changes, 1);
  const normalized = schema.nodeFromJSON(content.document); normalized.check(); content.document = normalized.toJSON(); return content;
}

/** Actual exported HTTP route functions, Cookie session, B0 and ordinary PG/FD
 * worker. This does not exercise TCP, proxy middleware, compiled UI or OAuth. */
export async function workspacePathImportWebRoutesPostgresTest(): Promise<void> {
  const previousBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost'; let phase = 'fixture', groups = 0;
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    const { auth } = await import('../app/lib/auth');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { upsertPostgresWorkspaceMemberForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { requireRequestWorkspace } = await import('../app/lib/workspaces/request');
    const { POST: rename } = await import('../app/api/files/rename/route');
    const { DELETE: remove } = await import('../app/api/files/delete/route');
    const { GET: status } = await import('../app/api/files/operations/batches/[batchId]/route');
    const { createWorkspaceOperationBatchWorker } = await import('../app/lib/files/workspace-operation-batch-worker');
    const { decodeWorkspacePathImportPreparationRecordV1 } = await import('../app/lib/files/workspace-path-import-preparation-record');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { authoritativeNativeCollaborationSnapshot, inspectNativeDocument } = await import('../app/lib/collaboration/document-snapshot');
    const { inspectArchivedNativeSnapshot } = await import('../app/lib/collaboration/archived-native-snapshot');
    const { getNativeInspectionSchema } = await import('../app/lib/collaboration/native-inspection-schema');
    const { readDocumentForRequest } = await import('../app/lib/documents/service');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const owner = resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' });
    await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false });
    assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1
      WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1);
    let sessionId = 'session-member', sessionToken: string | undefined = undefined;
    const webPathRouteRequest = async (url: string, method: string, body?: unknown, token = sessionToken) => {
      const actual = await h.request(h.source, 'member', true, token);
      assert(actual.headers.has('cookie')); assert.equal(actual.headers.has('authorization'), false);
      const headers = new Headers(actual.headers); headers.set('Content-Type', 'application/json');
      return new NextRequest(`http://localhost${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    // Legitimate pre-existing bootstrap/setup is fixture preparation. The complete
    // handler and repeat resolvers remain inside every following no-write oracle.
    const ready = await requireRequestWorkspace(await webPathRouteRequest('/api/files/rename', 'POST'),
      { permissions: ['canRead', 'canWrite', 'canDelete'] });
    assert.equal(ready.response, null); assert(ready.workspace && ready.workspace.permissions.canWrite && ready.workspace.permissions.canDelete);
    const webPathRouteCall = async (kind: Job['kind'], body: Record<string, unknown>) => {
      const response = await (kind === 'rename' ? rename : remove)(await webPathRouteRequest(`/api/files/${kind === 'rename' ? 'rename' : 'delete'}`,
        kind === 'rename' ? 'POST' : 'DELETE', body));
      const text = await response.text(); assert(Buffer.byteLength(text) <= 1024 * 1024);
      return { status: response.status, body: JSON.parse(text) as WorkspacePathOperationResponse & {
        success: boolean; code?: string; dryRun?: true; requiresRevalidation?: true; plan?: WorkspacePathImportPreparationPreviewPublic } };
    };
    const webPathRouteApply = async (job: Job) => {
      const worker = createWorkspaceOperationBatchWorker(); let finished = false, workerFailure: unknown;
      const initialStates = new Map<string, { path: string; representation: string; state: Uint8Array; vector: Uint8Array; client: unknown }>();
      const pending = h.withProbe(async event => {
        if (!/\bINSERT\s+INTO\s+collaboration_yjs_states\s*\(/iu.test(event.text)
          || event.values[1] !== h.source.workspaceId || event.values[3] !== job.source && event.values[3] !== job.incoming) return;
        assert.equal(event.result.command, 'INSERT'); assert.equal(event.result.rowCount, 1); assert.equal(event.values.length, 10);
        const [documentId, , , sourcePath, representation, state, vector] = event.values;
        assert(typeof documentId === 'string' && typeof sourcePath === 'string' && typeof representation === 'string');
        assert(state instanceof Uint8Array && state.byteLength > 0 && state.byteLength <= 8 * 1024 * 1024);
        assert(vector instanceof Uint8Array && vector.byteLength > 0 && vector.byteLength <= 8 * 1024 * 1024);
        assert.equal(initialStates.has(documentId), false);
        initialStates.set(documentId, { path: sourcePath, representation, state: Buffer.from(state), vector: Buffer.from(vector), client: event.client });
        assert(initialStates.size <= 2);
      }, () => webPathRouteCall(job.kind, { ...(job.kind === 'rename'
        ? { oldPath: job.source, newPath: job.destination } : { path: job.source }),
        planId: job.preview.planId, idempotencyKey: job.operationId }));
      const pump = (async () => {
        try { while (!finished) { await worker.tick(); if (!finished) await new Promise(resolve => setTimeout(resolve, 25)); } }
        catch (error) { workerFailure = error; }
      })();
      let result: Awaited<typeof pending> | undefined, requestFailure: unknown;
      try { result = await pending; } catch (error) { requestFailure = error; }
      finally { finished = true; await pump; } // Actual tick owns and drains its real renewal lifecycle.
      const failures = [requestFailure, workerFailure].filter(error => error !== undefined);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'Web route and default worker failed.');
      assert(result); return { ...result, initialStates };
    };
    const untouched = 'web-untouched-raw.md';
    await fs.writeFile(path.join(h.source.rootPath, untouched), '# Unchanged\n\n[Self](web-untouched-raw.md)\n', { flag: 'wx', mode: 0o600 });
    const untouchedOriginal = await webPathRouteFile(path.join(h.source.rootPath, untouched));
    const webPathRouteJob = async (kind: Job['kind'], tag: string): Promise<Job> => {
      const source = `web-${tag}-target.md`, incoming = `web-${tag}-incoming.md`, destination = `web-${tag}-moved.md`;
      await fs.writeFile(path.join(h.source.rootPath, source), `# Target\n\n[Self](${source})\n`, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(path.join(h.source.rootPath, incoming), `# Incoming\n\nBefore [Target](${source}) after.\n`, { flag: 'wx', mode: 0o600 });
      const preview = await webPathRouteNoWrite(h, () => webPathRouteCall(kind,
        { ...(kind === 'rename' ? { oldPath: source, newPath: destination } : { path: source }), dryRun: true }));
      assert.equal(preview.status, 200); assert.equal(preview.body.success, true); assert.equal(preview.body.dryRun, true);
      assert.equal(preview.body.requiresRevalidation, true); assert(preview.body.plan);
      assert.equal(preview.body.plan.kind, 'native-path-import-preparation'); assert.equal(preview.body.plan.readiness, 'requires-import-rebinding');
      assert.deepEqual(preview.body.plan.imports.map(value => value.path).sort(), [source, incoming].sort());
      assert.match(preview.body.plan.planId, /^[a-f0-9]{64}$/u);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=ANY($2::text[])',
        [h.source.workspaceId, [source, incoming]])).rows[0].n, 0);
      return { kind, source, incoming, destination, operationId: crypto.randomUUID(), preview: preview.body.plan, originalSessionId: sessionId };
    };
    const webPathRouteAssertResult = async (job: Job, response: Awaited<ReturnType<typeof webPathRouteApply>>) => {
      assert.equal(response.status, 200); assert.equal(response.body.success, true); assert.equal(response.body.historical, undefined);
      const operation = response.body.operation; assert(operation); assert.equal(operation.status, 'applied');
      assert.equal(operation.workspaceId, h.source.workspaceId); assert.equal(operation.preparation?.previewPlanId, job.preview.planId);
      const row = (await h.admin.query(`SELECT record_text,record_digest,b0_xid::text AS xid,xmin::text AS xmin
        FROM workspace_path_import_preparations WHERE workspace_id=$1 AND operation_id=$2`, [h.source.workspaceId, job.operationId])).rows;
      assert.equal(row.length, 1); const record = decodeWorkspacePathImportPreparationRecordV1(JSON.parse(row[0].record_text));
      assert.equal(record.origin.kind, 'request'); assert.equal(record.origin.userId, 'member'); assert.equal(record.origin.sessionId, job.originalSessionId);
      assert.equal(record.previewPlan.planId, job.preview.planId); assert.equal(operation.planId, record.nativePlan.planId);
      assert.notEqual(operation.planId, job.preview.planId); assert.equal(operation.batchId, record.batchId);
      assert.equal(row[0].xid, record.b0TransactionId); assert.equal(row[0].xmin, String(BigInt(row[0].xid) % BigInt(4294967296)));
      assert.equal(record.imports.length, 2);
      assert.equal(response.initialStates.size, record.imports.length);
      assert.equal(new Set([...response.initialStates.values()].map(value => value.client)).size, 1);
      const target = record.imports.find(item => item.receipt.target.path === job.source), incoming = record.imports.find(item => item.receipt.target.path === job.incoming);
      assert(target && incoming); assert.notEqual(target.receipt.target.documentId, incoming.receipt.target.documentId);
      assert.notEqual(target.receipt.target.lineageId, incoming.receipt.target.lineageId);
      for (const item of record.imports) {
        const base = (await h.admin.query(`SELECT private_result,after_state_snapshot,actor_session_id,live_yjs_state_sha256,live_state_vector_sha256,xmin::text AS xmin
          FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2`, [h.source.workspaceId, item.receipt.operationId])).rows;
        assert.equal(base.length, 1); assert.equal(base[0].xmin, row[0].xmin); assert.equal(base[0].actor_session_id, job.originalSessionId);
        assert.deepEqual(base[0].private_result, item.receipt);
        const original = response.initialStates.get(item.receipt.target.documentId); assert(original);
        assert.equal(original.path, item.receipt.target.path); assert.equal(original.representation, item.receipt.target.representation);
        assert.equal(crypto.createHash('sha256').update(original.state).digest('hex'), item.initialBinaryHash);
        assert.equal(crypto.createHash('sha256').update(original.vector).digest('hex'), item.initialVectorHash);
        assert.equal(base[0].live_yjs_state_sha256, item.initialBinaryHash); assert.equal(base[0].live_state_vector_sha256, item.initialVectorHash);
        assert(base[0].after_state_snapshot instanceof Uint8Array && base[0].after_state_snapshot.byteLength > 0
          && base[0].after_state_snapshot.byteLength <= 8 * 1024 * 1024);
        assert.equal(`yjs-snapshot-sha256-v1:${crypto.createHash('sha256').update(base[0].after_state_snapshot).digest('hex')}`,
          item.receipt.target.initialStateProof);
        const snapshot = Y.decodeSnapshot(base[0].after_state_snapshot);
        const doc = new Y.Doc(); let expected: NativeCollaborationContent;
        try {
          // The receipt stores a vector/DeleteSet snapshot, not a document update.
          // Full original content comes only from the real successful B0 INSERT.
          Y.applyUpdate(doc, original.state);
          assert.deepEqual(Buffer.from(Y.encodeStateVector(doc)), Buffer.from(original.vector));
          assert.deepEqual(Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))), Buffer.from(Y.encodeSnapshot(snapshot)));
          const initial = inspectNativeDocument(doc, item.receipt.target.representation);
          assert.equal(initial.version.stateProof, item.receipt.target.initialStateProof);
          const sourceContent = structuredClone(initial.content);
          expected = job.kind === 'delete' && item === target ? sourceContent
            : webPathRouteExpectedContent(sourceContent, job.source, job.kind === 'delete' ? null : job.destination,
              item === target ? 'Self' : 'Target', getNativeInspectionSchema());
        } finally { doc.destroy(); }
        const current = await load(h.connection, item.receipt.target.documentId, job.kind === 'delete' && item === target); assert(current);
        assert.equal(current.documentId, item.receipt.target.documentId);
        const registry = (await h.admin.query('SELECT lineage_id,status,path FROM collaboration_documents WHERE id=$1', [current.documentId])).rows[0];
        assert.equal(registry.lineage_id, item.receipt.target.lineageId);
        if (job.kind === 'delete' && item === target) {
          assert.equal(registry.status, 'archived'); assert.equal(current.status, 'archived');
          assert.deepEqual(JSON.parse(JSON.stringify(inspectArchivedNativeSnapshot(current).content)), JSON.parse(JSON.stringify(expected)));
        } else {
          assert.equal(current.status, 'active'); assert.equal(registry.status, 'active');
          assert.equal(current.path, item === target ? job.destination : job.incoming);
          assert.deepEqual(JSON.parse(JSON.stringify(authoritativeNativeCollaborationSnapshot(current).content)), JSON.parse(JSON.stringify(expected)));
          const page = await readDocumentForRequest(await webPathRouteRequest('/api/documents/read', 'POST'),
            { apiVersion: 1, workspaceId: h.source.workspaceId, documentId: current.documentId, format: 'native', maxBytes: 262144 });
          assert(page.complete); assert.equal(page.document.documentId, current.documentId); assert.equal(page.document.lineageId, item.receipt.target.lineageId);
          assert.deepEqual(JSON.parse(page.fragment).content, JSON.parse(JSON.stringify(expected)));
        }
      }
      await assert.rejects(fs.lstat(path.join(h.source.rootPath, job.source)), { code: 'ENOENT' });
      if (job.kind === 'rename') { assert((await fs.lstat(path.join(h.source.rootPath, job.destination))).isFile()); assert.equal(response.body.mutation?.oldPath, job.source); }
      else { assert.deepEqual(response.body.deleted, [job.source]); assert.equal(response.body.trashEntries?.length, 1);
        const trash = (await h.admin.query('SELECT original_path FROM workspace_trash_entries WHERE id=$1', [response.body.trashEntries![0].id])).rows;
        assert.equal(trash.length, 1); assert.equal(trash[0].original_path, job.source); }
      assert.deepEqual(await webPathRouteFile(path.join(h.source.rootPath, untouched)), untouchedOriginal);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, untouched])).rows[0].n, 0);
      return { record, originalRecordRows: row, operation };
    };

    phase = 'pure rename preview then OriginalPreview-ID Apply via real default worker';
    const moved = await webPathRouteJob('rename', 'rename'), movedResult = await webPathRouteAssertResult(moved, await webPathRouteApply(moved)); groups++;
    phase = 'pure delete preview then OriginalPreview-ID Apply, native unlink and actual FD trash';
    const deleted = await webPathRouteJob('delete', 'delete'), deletedResult = await webPathRouteAssertResult(deleted, await webPathRouteApply(deleted)); groups++;

    phase = 'real SID-B, original preview/key and historical status without current old D2 parsing or DML';
    const oldRequest = await webPathRouteRequest('/api/files/rename', 'POST', { oldPath: moved.source, newPath: moved.destination,
      idempotencyKey: moved.operationId, planId: moved.preview.planId });
    const nextId = `web-session-${crypto.randomUUID()}`, nextToken = crypto.randomBytes(32).toString('hex'), now = Date.now();
    await h.admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,\'member\',$3,$4,$4)', [nextId, nextToken, now + 3600000, now]);
    assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [sessionId])).rowCount, 1);
    sessionId = nextId; sessionToken = nextToken;
    assert.equal((await auth.api.getSession({ headers: (await webPathRouteRequest('/api/auth/get-session', 'GET')).headers }))?.session.id, nextId);
    // Better Auth may remove its expired session on first observation. Complete
    // that real authentication housekeeping before the strict route oracle.
    assert.equal(await auth.api.getSession({ headers: oldRequest.headers }), null);
    // Expect zero native adapter events: this real401 precedes any native phase.
    // Drizzle Auth QueryConfig+params calls are not observed by this probe;
    // complete schema/row/xmin and DATA/FD snapshots still apply unchanged.
    await webPathRouteNoWrite(h, async () => { assert.equal((await rename(oldRequest)).status, 401); }, false, true);
    for (const [job, result] of [[moved, movedResult], [deleted, deletedResult]] as const) {
      await fs.writeFile(path.join(h.source.rootPath, job.source), Buffer.from([0xff, 0xfe]), { flag: 'wx', mode: 0o600 });
      const replacement = await webPathRouteFile(path.join(h.source.rootPath, job.source));
      const retry = await webPathRouteNoWrite(h, () => webPathRouteCall(job.kind,
        { ...(job.kind === 'rename' ? { oldPath: job.source, newPath: job.destination } : { path: job.source }),
          planId: job.preview.planId, idempotencyKey: job.operationId }));
      assert.equal(retry.status, 200); assert.equal(retry.body.historical, true); assert.deepEqual(retry.body.operation, result.operation);
      assert.deepEqual(await webPathRouteFile(path.join(h.source.rootPath, job.source)), replacement);
      const current = (await h.admin.query('SELECT record_text,record_digest,b0_xid::text AS xid,xmin::text AS xmin FROM workspace_path_import_preparations WHERE batch_id=$1', [result.record.batchId])).rows;
      assert.deepEqual(current, result.originalRecordRows);
      await webPathRouteNoWrite(h, async () => {
        const response = await status(await webPathRouteRequest(`/api/files/operations/batches/${result.operation.batchId}`, 'GET'),
          { params: Promise.resolve({ batchId: result.operation.batchId }) });
        assert.equal(response.status, 200); const body = await response.json() as WorkspacePathOperationResponse;
        assert.equal(body.operation.batchId, result.operation.batchId); assert.equal(body.operation.planId, result.record.nativePlan.planId);
        assert.equal(body.operation.status, 'applied');
      });
    } groups++;

    phase = 'history changed request is closed before fresh plan or import';
    const changed = await webPathRouteNoWrite(h, () => webPathRouteCall('rename', { oldPath: moved.source, newPath: 'different.md',
      planId: moved.preview.planId, idempotencyKey: moved.operationId }));
    assert.equal(changed.status, 409); assert.equal(changed.body.code, 'PATH_IMPORT_HISTORY_CHANGED'); groups++;

    // Remove only the two deliberate invalid old D2 files between families, as fixture setup.
    await fs.unlink(path.join(h.source.rootPath, moved.source)); await fs.unlink(path.join(h.source.rootPath, deleted.source));
    phase = 'stale raw preview rejected before import/problem/header DML';
    const stale = await webPathRouteJob('rename', 'stale');
    await fs.appendFile(path.join(h.source.rootPath, stale.source), '\nChanged after preview.\n');
    const rejected = await webPathRouteNoWrite(h, () => webPathRouteCall('rename', { oldPath: stale.source, newPath: stale.destination,
      planId: stale.preview.planId, idempotencyKey: stale.operationId }));
    assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'PREVIEW_STALE'); groups++;

    phase = 'real current WRITE and Delete revocation reject before imports';
    await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: false, canManage: false });
    await webPathRouteNoWrite(h, async () => { assert.equal((await webPathRouteCall('rename', { oldPath: stale.source, newPath: stale.destination,
      planId: stale.preview.planId, idempotencyKey: stale.operationId })).status, 403); });
    await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false });
    assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=0 WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1);
    await webPathRouteNoWrite(h, async () => { assert.equal((await webPathRouteCall('delete', { path: stale.source, dryRun: true })).status, 403); });
    assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1); groups++;

    phase = 'raw overwrite and ignoreMissing explicitly reject with complete no-write';
    const options = await webPathRouteJob('rename', 'options');
    const overwrite = await webPathRouteNoWrite(h, () => webPathRouteCall('rename', { oldPath: options.source, newPath: options.destination,
      overwrite: true, planId: options.preview.planId, idempotencyKey: options.operationId }));
    assert.equal(overwrite.status, 409); assert.equal(overwrite.body.code, 'PATH_IMPORT_OVERWRITE_UNSUPPORTED');
    const ignore = await webPathRouteNoWrite(h, () => webPathRouteCall('delete', { path: options.source, ignoreMissing: true, idempotencyKey: crypto.randomUUID() }));
    assert.equal(ignore.status, 422); assert.equal(ignore.body.code, 'PATH_IMPORT_OPTIONS_UNSUPPORTED'); groups++;
    assert.equal(groups, 7); console.log(JSON.stringify({ suite: 'workspace-path-import-web-routes', groups, passed: true,
      scope: 'actual HTTP Request/Response route functions plus genuine Cookie session/default PG/FD worker; no TCP/browser/deployment' }));
  }); } catch (error) {
    console.error(JSON.stringify({ suite: 'workspace-path-import-web-routes', phase, groups,
      name: error instanceof Error ? error.name : 'UnknownError',
      assertion: error instanceof assert.AssertionError ? error.message.slice(0, 1500) : undefined,
      code: error instanceof Error && typeof Object.getOwnPropertyDescriptor(error, 'code')?.value === 'string'
        && /^[A-Z][A-Z0-9_]{0,127}$/u.test(Object.getOwnPropertyDescriptor(error, 'code')!.value)
        ? Object.getOwnPropertyDescriptor(error, 'code')!.value : undefined,
      stack: error instanceof Error ? error.stack?.split('\n').slice(1, 9) : [] })); throw error;
  } finally { if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase; }
}
