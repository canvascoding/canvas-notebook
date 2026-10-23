/** Real PG18 regression for a lost successful Move COMMIT acknowledgement and
 * historical replay after later document changes. Reuses the owned native fixture.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WorkspaceRequestPrincipalAccess } from '../app/lib/workspaces/request-principal';
type Fixture = Parameters<Parameters<typeof withNativeCopyMetadataOwnerFixture>[0]>[0];
const repo = process.cwd(), suite = 'original-move-b2-ack';
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const directFiles = [
 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
 'scripts/workspace-operation-original-move-owner-postgres-test.ts',
 'scripts/workspace-operation-original-delete-recreate-postgres-test.ts',
 'scripts/native-link-mutation-postgres-test.ts',
 'app/lib/files/workspace-operation-batch-store.ts',
 'app/lib/files/workspace-operation-batch-plan.ts',
 'app/lib/files/workspace-operation-job-lifecycle-owner.ts',
 'app/lib/files/workspace-operation-original-move-runner.ts',
 'app/lib/files/workspace-operation-original-move.ts',
 'app/lib/files/workspace-operation-original-move-repository.ts',
 'app/lib/files/workspace-operation-original-move-sources.ts',
 'app/lib/files/workspace-operation-original-move-namespace-effects.ts',
 'app/lib/files/workspace-operation-native-move-status.ts',
 'app/lib/filesystem/prepared-workspace-path-move.ts',
 'app/lib/filesystem/prepared-workspace-path-move-contract.ts',
 'app/lib/collaboration/persistence.ts',
 'app/lib/markdown/native-file-operation-handoff.ts',
 'app/lib/markdown/native-file-operation-side-effects.ts',
];
function errorFacts(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error) || depth > 4) return null;
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  const cause = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
  return { name: /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name) ? error.name : 'unknown',
    code: typeof code === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(code) ? code : null,
    source: error.stack?.split('\n').flatMap(line => {
      const match = /\/(app\/.*|scripts\/.*):(\d+):(\d+)\)?$/u.exec(line); return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    }).slice(0, 6), cause: errorFacts(cause, depth + 1),
    ...(error instanceof AggregateError ? { errors: error.errors.slice(0, 4).map(value => errorFacts(value, depth + 1)) } : {}) };
}
const sqlIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
/** Observe every directory entry, file byte and stable identity under a real
 * workspace root. Reads intentionally omit atime, which inspection can change.
 * Special files/symlinks fail closed; this is not a syscall/hostile-FS audit. */
async function workspaceTree(root: string) {
  assert(path.isAbsolute(root) && await realpath(root) === root);
  const entries: Record<string, unknown> = {};
  const visit = async (relative: string): Promise<void> => {
    const absolute = relative ? path.join(root, relative) : root;
    const before = await lstat(absolute, { bigint: true });
    assert(!before.isSymbolicLink() && (before.isDirectory() || before.isFile()));
    const identity = (s: typeof before) => ({ device: String(s.dev), inode: String(s.ino), uid: String(s.uid), gid: String(s.gid),
      mode: String(s.mode), nlink: String(s.nlink), size: String(s.size), birthtimeNs: String(s.birthtimeNs),
      mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) });
    const children = before.isDirectory() ? (await readdir(absolute)).sort() : [];
    let bytesSha256: string | null = null;
    if (before.isFile()) {
      const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        assert.deepEqual(identity(await handle.stat({ bigint: true })), identity(before));
        bytesSha256 = hash(await handle.readFile());
        assert.deepEqual(identity(await handle.stat({ bigint: true })), identity(before));
      } finally { await handle.close(); }
    }
    entries[relative || '.'] = { kind: before.isDirectory() ? 'directory' : 'file', identity: identity(before), children, bytesSha256 };
    for (const child of children) await visit(relative ? `${relative}/${child}` : child);
    assert.deepEqual(identity(await lstat(absolute, { bigint: true })), identity(before));
    if (before.isDirectory()) assert.deepEqual((await readdir(absolute)).sort(), children);
  };
  await visit(''); return entries;
}
/** Full ordinary-table row/xmin inventory for this exact private schema.
 * Raw authentication/fixture rows never leave memory: only counts/hashes do.
 * Unsupported storage kinds fail closed rather than being omitted. Sequence
 * counters and relation/column identities are also retained as observations. */
async function privateSchemaSnapshot(h: Fixture) {
  let transaction = false;
  try {
    await h.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    const schema = (await h.admin.query(`SELECT n.oid::text AS oid,n.nspname,pg_get_userbyid(n.nspowner) AS owner,
      pg_get_userbyid(n.nspowner)=current_user AS owned,obj_description(n.oid,'pg_namespace') AS marker
      FROM pg_namespace n WHERE n.nspname=$1 AND n.oid::text=$2`, [h.schema, h.schemaOid])).rows[0];
    assert(schema); assert.equal(schema.oid, h.schemaOid); assert.equal(schema.nspname, h.schema);
    assert.equal(schema.owned, true); assert.equal(schema.marker, h.applicationName);
    const relations = (await h.admin.query(`SELECT c.oid::text AS oid,c.relname,c.relkind,c.relpersistence,c.relnatts,
      c.relrowsecurity,c.relforcerowsecurity,c.relispartition,pg_get_expr(c.relpartbound,c.oid) AS partition_bound
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND n.oid::text=$2 ORDER BY c.relname COLLATE "C",c.oid`, [h.schema, h.schemaOid])).rows;
    const tables = relations.filter(row => ['r','p','f','m'].includes(row.relkind));
    assert(tables.length > 0);
    assert(tables.every(row => row.relkind === 'r'), 'A non-ordinary private table requires an explicit complete snapshot implementation.');
    const columns = (await h.admin.query(`SELECT c.oid::text AS table_oid,a.attnum,a.attname,a.atttypid::text AS type_oid,
      a.atttypmod,a.attnotnull,a.attisdropped,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_expression
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND n.oid::text=$2 AND a.attnum>0 ORDER BY c.relname COLLATE "C",a.attnum`, [h.schema,h.schemaOid])).rows;
    const rowProofs: Record<string, unknown> = {};
    for (const table of tables) {
      const rows = (await h.admin.query(`SELECT to_jsonb(t) AS row,t.xmin::text AS xmin
        FROM ONLY ${sqlIdentifier(h.schema)}.${sqlIdentifier(table.relname)} t
        ORDER BY to_jsonb(t)::text COLLATE "C",t.xmin::text COLLATE "C"`)).rows;
      rowProofs[table.relname] = { oid: table.oid, count: rows.length, rowsAndXminSha256: hash(JSON.stringify(rows)) };
    }
    const sequences: Record<string, unknown> = {};
    for (const sequence of relations.filter(row => row.relkind === 'S')) {
      const row = (await h.admin.query(`SELECT last_value::text AS last_value,log_cnt::text AS log_cnt,is_called
        FROM ${sqlIdentifier(h.schema)}.${sqlIdentifier(sequence.relname)}`)).rows[0];
      assert(row); sequences[sequence.relname] = { oid: sequence.oid, ...row };
    }
    await h.admin.query('COMMIT'); transaction = false;
    return { schema, relations, columns, rowProofs, sequences };
  } catch (error) {
    if (transaction) {
      try { await h.admin.query('ROLLBACK'); }
      catch (rollback) { throw new AggregateError([error, rollback], 'Private-schema snapshot and read-only rollback failed.'); }
    }
    throw error;
  }
}
/** Inspect successful actual query text, ignoring comments/string/identifier
 * literals. Reject every observed mutation/DDL token, including writable CTEs.
 * This intentionally does not claim to inspect arbitrary server-function I/O. */
function pendingSqlMutation(text: string): string | null {
  let index = 0; const words: string[] = [];
  while (index < text.length) {
    const char = text[index];
    if (/\s/u.test(char)) { index++; continue; }
    if (text.startsWith('--', index)) { const end = text.indexOf('\n', index + 2); index = end < 0 ? text.length : end + 1; continue; }
    if (text.startsWith('/*', index)) {
      index += 2; let depth = 1;
      while (index < text.length && depth) {
        if (text.startsWith('/*', index)) { depth++; index += 2; }
        else if (text.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      assert.equal(depth, 0, 'Unterminated SQL comment in actual pending-scope observation.'); continue;
    }
    if (char === "'" || char === '"') {
      const quote = char; index++; let closed = false;
      while (index < text.length) {
        assert(!(text[index] === '\\' && quote === "'"), 'Backslash-escaped pending SQL literals require explicit review; do not silently skip a statement boundary.');
        if (text[index] === quote) {
          if (text[index + 1] === quote) { index += 2; continue; }
          index++; closed = true; break;
        }
        index++;
      }
      assert(closed, 'Unterminated SQL literal in actual pending-scope observation.'); continue;
    }
    if (char === '$') {
      const delimiter = /^(?:\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/u.exec(text.slice(index))?.[0];
      if (delimiter) {
        const end = text.indexOf(delimiter, index + delimiter.length);
        assert(end >= 0, 'Unterminated SQL dollar literal in actual pending-scope observation.');
        index = end + delimiter.length; continue;
      }
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(text.slice(index))?.[0];
    if (word) { words.push(word.toUpperCase()); index += word.length; } else index++;
  }
  const writes = new Set(['INSERT','UPDATE','DELETE','MERGE','TRUNCATE','COPY','CREATE','ALTER','DROP','GRANT','REVOKE',
    'CALL','DO','REFRESH','REINDEX','CLUSTER','VACUUM','ANALYZE','COMMENT','SECURITY']);
  return words.find(word => writes.has(word)) ?? null;
}
async function physical(filename: string) {
  try {
    const before = await lstat(filename); assert(before.isFile() && !before.isSymbolicLink());
    const bytes = await readFile(filename), after = await lstat(filename);
    const identity = ({ dev, ino, uid, mode, nlink, size, mtimeMs, ctimeMs }: typeof before) => ({ dev, ino, uid, mode, nlink, size, mtimeMs, ctimeMs });
    assert.deepEqual(identity(after), identity(before));
    return { present: true, identity: identity(after), bytesBase64: bytes.toString('base64'), bytesSha256: hash(bytes) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false }; throw error; }
}
async function annotations(h: Fixture, workspaceId: string, filePath: string) {
  return { shared: (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2 ORDER BY path', [workspaceId, filePath])).rows,
    personal: (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2 ORDER BY user_id', [workspaceId, filePath])).rows };
}
async function untouched(h: Fixture, filePath: string, workspace: WorkspaceContext) {
  return { physical: await physical(path.join(workspace.rootPath, filePath)), annotations: await annotations(h, workspace.workspaceId, filePath),
    registry: (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 ORDER BY id', [workspace.workspaceId, filePath])).rows,
    lineages: (await h.admin.query('SELECT l.*,l.xmin::text AS xmin FROM file_collaboration_lineages l JOIN collaboration_documents d ON d.lineage_id=l.id WHERE d.workspace_id=$1 AND d.path=$2 ORDER BY l.id', [workspace.workspaceId, filePath])).rows,
    states: (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2 ORDER BY document_id', [workspace.workspaceId, filePath])).rows,
    projections: (await h.admin.query('SELECT p.*,p.xmin::text AS xmin FROM collaboration_file_projections p JOIN collaboration_documents d ON d.id=p.document_id WHERE d.workspace_id=$1 AND d.path=$2 ORDER BY p.document_id', [workspace.workspaceId, filePath])).rows };
}

async function main(): Promise<void> {
  assert(process.argv.length === 2 || process.argv.length === 3);
  const reportRoot = process.argv[2] ?? await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-original-move-b2-ack-')));
  const reportIdentity = await lstat(reportRoot);
  assert(path.isAbsolute(reportRoot) && await realpath(reportRoot) === reportRoot && reportIdentity.isDirectory()
    && !reportIdentity.isSymbolicLink() && reportIdentity.uid === process.getuid?.() && (reportIdentity.mode & 0o777) === 0o700);
  const write = (name: string, value: unknown) => writeFile(path.join(reportRoot, `${name}.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  const started = performance.now(); let phase = 'fixture entry', recorded = false;
  const facts: Record<string, unknown> = { suite, passed: false, phaseBudgetMs: 180_000,
    automaticRetries: 0, replans: 0, declaredAckFaults: ['committed-B2'],
    scope: 'Genuine Principal/Store/OriginalMove/PG18/FD and native persistence kernel; no HTTP/editor transport, browser, host crash or production claim.' };
  const phaseAt = (value: string) => { phase = value; facts.phase = value;
    assert(performance.now() - started < 180_000, '180-second phase budget exceeded.'); };
  const pins = async () => Object.fromEntries(await Promise.all([...directFiles, path.relative(repo, fileURLToPath(import.meta.url))]
    .map(async filename => [filename, hash(await readFile(path.isAbsolute(filename) ? filename : path.join(repo, filename)))])));
  const beforePins = await pins(); await write('source-before', beforePins);
  console.log(JSON.stringify({ suite, sourcePins: beforePins }));
  const record = async () => { assert.equal(recorded, false); await write('observations', facts); recorded = true; };
  try {
    await withNativeCopyMetadataOwnerFixture(async h => {
      facts.fixture = { schema: h.schema, schemaOid: h.schemaOid, applicationName: h.applicationName, dataRoot: h.dataRoot };
      const { openDb } = await import('../app/lib/db');
      const { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } = await import('../app/lib/workspaces/request-principal');
      const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
      const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
      const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
      const { executeWorkspaceOperationOriginalMove: execute } = await import('../app/lib/files/workspace-operation-original-move-runner');
      const { readWorkspaceOperationNativeMoveBatchStatus } = await import('../app/lib/files/workspace-operation-native-move-status');
      const { readWorkspaceOperationOriginalMoveNativeBundle } = await import('../app/lib/files/workspace-operation-original-move');
      const { loadCollaborationState, persistCollaborationYDoc } = await import('../app/lib/collaboration/persistence');
      const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
      const { inspectPersistedDocumentLinks } = await import('../app/lib/markdown/workspace-native-link-inventory');
      const { WORKSPACE_STARTER_DOCUMENT_NAME } = await import('../app/lib/workspaces/starter-document');
      const { Y } = await import('../app/lib/collaboration/server-runtime');
      type Access = Pick<WorkspaceRequestPrincipalAccess, 'workspace' | 'userId' | 'sessionId'>;
      const currentAccess = async (): Promise<Access> => withWorkspaceRequestPrincipal<Access>(
        await h.request(h.source, 'owner', true), { workspaceId: h.source.workspaceId, permission: 'canWrite' }, async principal => {
          const connection = await openDb(); let began = false, committed = false;
          try {
            await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
            const result = await withWorkspaceRequestPrincipalOnConnection<Access>(connection, principal, async access => {
              assert.equal(access.userId, 'owner'); assert.equal(access.sessionId, 'session-owner');
              assert.equal(access.workspace.workspaceId, h.source.workspaceId);
              assert(access.workspace.permissions.canWrite && access.workspace.permissions.canDelete);
              await access.assertCurrent(); return { workspace: access.workspace, userId: access.userId, sessionId: access.sessionId };
            });
            await connection.run('COMMIT'); committed = true; return result;
          } catch (error) { if (began && !committed) await connection.run('ROLLBACK'); throw error; }
          finally { await connection.close(committed ? undefined : new Error('Discarding failed actual Principal phase.')); }
        });
      const sourcePath = `move-b2-${randomUUID()}.md`, destinationPath = `moved-${randomUUID()}/${sourcePath}`;
      const incomingPath = `incoming-${randomUUID()}.md`, keepPath = `keep-${randomUUID()}.md`;
      const bytes = Buffer.from('# Original moved D1\n\nExact D1 bytes.\n');
      phaseAt('genuine authenticated native imports and annotation writers');
      const target = await h.upload(sourcePath, bytes);
      await h.upload(keepPath, Buffer.from('# Keep\n\nIndependent neighbor.\n'));
      const incoming = await h.upload(incomingPath, Buffer.from(`# Incoming\n\n[D1](${sourcePath}) and [Keep](${keepPath}).\n`));
      await h.metadata(h.source, sourcePath, { title: 'Original D1 DB title', isFavorite: true, pinned: true });
      await h.metadata(h.source, incomingPath, { title: 'Incoming metadata', isFavorite: true, pinned: true });
      const access = await currentAccess(), workspace = access.workspace;
      const targetBefore = await untouched(h, sourcePath, workspace), incomingBefore = await untouched(h, incomingPath, workspace);
      const keepBefore = await untouched(h, keepPath, workspace), starterBefore = await untouched(h, WORKSPACE_STARTER_DOCUMENT_NAME, workspace);
      const neighborBefore = await untouched(h, WORKSPACE_STARTER_DOCUMENT_NAME, h.destination);
      const originals = new Map<string, NonNullable<Awaited<ReturnType<typeof loadCollaborationState>>>>();
      for (const id of [target.documentId, incoming.documentId]) { const state = await loadCollaborationState(id); assert(state); originals.set(id, state); }
      phaseAt('single actual Move preview then immutable Store plan');
      const plan = await buildWorkspaceOperationBatchPlan({ scope: { workspace, fileOptions: { workspace } },
        actions: [{ reviewId: randomUUID(), kind: 'move', selections: [{ sourcePath, destinationPath }] }] });
      assert.equal(plan.version, 3); if (plan.version !== 3) assert.fail('A genuine native Move plan is required.');
      assert.equal(plan.planIdentityVersion, 2); assert.equal(plan.readiness, 'ready'); assert.deepEqual(plan.issues, []);
      const planText = JSON.stringify(plan), batchId = randomUUID(), store = new WorkspaceOperationBatchStore();
      const created = await store.createDirect({ batchId, plan, authorization: { mode: 'direct', actorUserId: access.userId,
        actorId: access.userId, actorType: 'user', actorSessionId: access.sessionId, actorDisplayName: 'Actual Move B2 ACK fixture',
        requestHash: hash(randomUUID()), jobScope: captureWorkspaceOperationJobScope(workspace) } });
      const originalClaim = await store.claim(randomUUID()); assert(originalClaim); assert.equal(originalClaim.batchId, batchId);
      const batchIdentity = async () => (await h.admin.query(`SELECT batch_id,plan_id,workspace_id,plan_json,authorization_json,total_actions,created_at
        FROM workspace_file_operation_batches WHERE batch_id=$1`, [batchId])).rows[0];
      const originalBatchIdentity = await batchIdentity();
      const readLedger = async () => ({
        workspace_file_operation_move_intents: (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_operation_move_intents WHERE batch_id=$1', [batchId])).rows,
        workspace_file_operation_move_parent_receipts: (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_operation_move_parent_receipts WHERE batch_id=$1 ORDER BY parent_path COLLATE "C"', [batchId])).rows,
        workspace_file_operation_move_path_receipts: (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_operation_move_path_receipts WHERE batch_id=$1 ORDER BY step_key COLLATE "C"', [batchId])).rows,
        workspace_file_operation_move_receipts: (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_operation_move_receipts WHERE batch_id=$1', [batchId])).rows,
      });
      type Backend = { pid: number; start: string; schemaOid: string; xid: string | null };
      const backend = async (event: MetadataSqlEvent): Promise<Backend> => {
        const row = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM a.backend_start)::text AS start,
          n.oid::text AS schema_oid,current_schema() AS schema,current_setting('application_name') AS app,
          pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity a
          JOIN pg_namespace n ON n.nspname=current_schema() WHERE a.pid=pg_backend_pid()`)).rows[0];
        assert(row); assert.equal(row.schema, h.schema); assert.equal(row.schema_oid, h.schemaOid); assert.equal(row.app, h.applicationName);
        return { pid: Number(row.pid), start: String(row.start), schemaOid: row.schema_oid, xid: row.xid };
      };
      let selectedClient: MetadataSqlEvent['client'] | undefined, selectedBackend: Backend | undefined;
      let injected = false, actualCommittedLedger: Awaited<ReturnType<typeof readLedger>> | undefined;
      const successfulWrites: Array<{ table: string; affected: number | null; backend: Backend }> = [];
      phaseAt('real B2 COMMIT success followed by lost acknowledgement');
      await assert.rejects(h.withProbe(async event => {
        const mutation = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"[^"]+"\.)?"?([a-z_]+)"?/iu.exec(event.text);
        if (mutation) successfulWrites.push({ table: mutation[1], affected: event.result.rowCount, backend: await backend(event) });
        if (mutation?.[1] === 'workspace_file_operation_move_receipts') {
          assert.equal(event.values[0], batchId); assert.equal(event.result.rowCount, 1); assert.equal(selectedClient, undefined);
          selectedClient = event.client; selectedBackend = await backend(event); assert(selectedBackend.xid);
        }
        if (/^\s*COMMIT\s*$/iu.test(event.text) && event.client === selectedClient && !injected) {
          assert(selectedBackend?.xid); const after = await backend(event);
          assert.equal(after.pid, selectedBackend.pid); assert.equal(after.start, selectedBackend.start); assert.equal(after.xid, null);
          actualCommittedLedger = await readLedger(); const completionRows = actualCommittedLedger.workspace_file_operation_move_receipts;
          assert.equal(completionRows.length, 1); const xmin = String(BigInt(selectedBackend.xid) % (BigInt(1) << BigInt(32)));
          assert.equal(completionRows[0].xmin, xmin);
          const actualB2 = successfulWrites.filter(item => item.backend.pid === selectedBackend!.pid && item.backend.start === selectedBackend!.start
            && item.backend.xid === selectedBackend!.xid && (item.affected ?? 0) > 0);
          assert.equal(actualB2.filter(item => item.table === 'collaboration_yjs_states').reduce((sum, item) => sum + (item.affected ?? 0), 0), 2);
          assert.equal(actualB2.filter(item => item.table === 'collaboration_native_file_operation_receipts').reduce((sum, item) => sum + (item.affected ?? 0), 0), 2);
          assert.equal(actualB2.filter(item => item.table === 'workspace_file_operation_move_receipts').length, 1);
          assert(actualB2.some(item => item.table === 'collaboration_native_file_operation_side_effect_receipts'));
          facts.actualB2Writes = actualB2; injected = true;
          throw Object.assign(new Error('Lost the actual successful Move B2 COMMIT acknowledgement.'), { code: 'FIXTURE_MOVE_B2_ACK_LOST' });
        }
      }, () => store.withClaim(originalClaim, claim => execute({ claim, workspace }))),
      error => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED');
      assert(injected && selectedBackend && actualCommittedLedger);
      phaseAt('actual discarded owner backend and advisory lease absent');
      const deadline = Math.min(performance.now() + 2000, started + 180_000); let closed = false;
      do {
        const row: { alive: boolean; held: boolean } | undefined = (await h.admin.query<{ alive: boolean; held: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND extract(epoch FROM backend_start)::text=$2) AS alive,
          EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE l.pid=$1 AND extract(epoch FROM a.backend_start)::text=$2 AND l.locktype='advisory' AND l.granted) AS held`,
          [selectedBackend.pid, selectedBackend.start])).rows[0];
        assert(row); if (!row.alive && !row.held) { closed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (performance.now() < deadline);
      assert(closed, 'The actual original owner backend or advisory lease remains alive.');
      const readStatus = async () => {
        const current = (await currentAccess()).workspace;
        return readWorkspaceOperationNativeMoveBatchStatus({ batchId,
          scope: { workspace: current, fileOptions: { workspace: current } } });
      };
      const status = await readStatus(); assert(status?.observation.completion && status.observation.intent);
      assert.equal(status.observation.apply, 'complete'); const completion = status.observation.completion, intent = status.observation.intent;
      const bundle = readWorkspaceOperationOriginalMoveNativeBundle(intent); assert(bundle); assert.equal(bundle.mutations.length, 2);
      assert.equal(completion.native?.receipts.length, 2); assert.equal(completion.pathReceipts.length, 1); assert.equal(completion.parentReceipts.length, 1);
      facts.committed = { completion, intent, ledger: actualCommittedLedger, backend: selectedBackend, backendClosed: true };
      for (const mutation of bundle.mutations) {
        const before = originals.get(mutation.source.documentId); assert(before); const actual = await loadCollaborationState(mutation.source.documentId); assert(actual);
        const expected = new Y.Doc();
        try {
          Y.applyUpdate(expected, before.yjsState); if (mutation.prepared) Y.applyUpdate(expected, mutation.prepared.update);
          assert.deepEqual(Buffer.from(actual.yjsState), Buffer.from(Y.encodeStateAsUpdate(expected)));
          assert.deepEqual(Buffer.from(actual.stateVector), Buffer.from(Y.encodeStateVector(expected)));
        } finally { expected.destroy(); }
        assert.equal(actual.documentId, before.documentId); assert.equal(actual.lifecycleGeneration, before.lifecycleGeneration);
        assert.equal(actual.path, mutation.destinationPath ?? before.path); assert.equal(actual.documentSequence, before.documentSequence + (mutation.prepared ? 1 : 0));
        const state = authoritativeNativeCollaborationSnapshot(actual);
        const rows: Array<{ xmin: string; receipt_text: string }> = (await h.admin.query<{ xmin: string; receipt_text: string }>(
          'SELECT *,xmin::text AS xmin FROM collaboration_native_file_operation_receipts WHERE operation_id=$1 AND mutation_id=$2', [bundle.operationId, mutation.mutationId])).rows;
        assert.equal(rows.length, 1); assert.equal(rows[0].xmin, String(BigInt(selectedBackend.xid!) % (BigInt(1) << BigInt(32))));
        const receipt = JSON.parse(rows[0].receipt_text);
        assert.equal(receipt.after.clock.binaryHash, hash(actual.yjsState)); assert.equal(receipt.after.clock.stateVector, Buffer.from(actual.stateVector).toString('base64'));
        assert.equal(receipt.after.clock.stateProof, state.version.stateProof); assert.equal(receipt.after.clock.persistedAt, actual.persistedAt);
      }
      const moved = await untouched(h, destinationPath, workspace), linked = await loadCollaborationState(incoming.documentId); assert(linked);
      assert.equal((await physical(path.join(workspace.rootPath, sourcePath))).present, false);
      assert.equal(moved.physical.present, true); assert.equal(moved.physical.bytesSha256, hash(bytes));
      assert.equal(moved.physical.identity?.dev, targetBefore.physical.identity?.dev); assert.equal(moved.physical.identity?.ino, targetBefore.physical.identity?.ino);
      assert.equal(moved.annotations.shared[0]?.title, 'Original D1 DB title');
      assert.equal(moved.annotations.personal[0]?.is_favorite, 1); assert(moved.annotations.personal[0]?.pinned_at);
      assert.deepEqual(await annotations(h, workspace.workspaceId, sourcePath), { shared: [], personal: [] });
      assert.deepEqual(inspectPersistedDocumentLinks(linked).links.map(link => link.literal), [destinationPath, keepPath]);
      assert.deepEqual(await annotations(h, workspace.workspaceId, incomingPath), incomingBefore.annotations);
      const admission = (await h.admin.query('SELECT status,xmin::text AS xmin FROM collaboration_admission_requests WHERE request_id=$1', [bundle.requestId])).rows[0];
      assert(admission); assert.equal(admission.status, 'committed'); assert.equal(admission.xmin, String(BigInt(selectedBackend.xid!) % (BigInt(1) << BigInt(32))));
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_admission_targets WHERE request_id=$1 AND active', [bundle.requestId])).rows[0].n, 0);
      assert.deepEqual(await readLedger(), actualCommittedLedger);
      // Release the original claim only via the actual Store, never SQL-erase it.
      assert(await store.finishClaim(originalClaim, { status: 'needs_recovery', errorCode: 'FIXTURE_MOVE_B2_ACK_LOST', phase: 'recovery' }));
      phaseAt('genuine D2 import plus a later legitimate native edit after committed B2');
      const d2Bytes = Buffer.from('# Independent D2\n\nNever adopt this replacement.\n'), d2 = await h.upload(sourcePath, d2Bytes);
      assert.notEqual(d2.documentId, target.documentId); await h.metadata(h.source, sourcePath, { title: 'D2 only', isFavorite: true, pinned: true });
      const d2Row = (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [d2.documentId])).rows[0];
      const d1Row = (await h.admin.query('SELECT lineage_id,path FROM collaboration_documents WHERE id=$1', [target.documentId])).rows[0];
      assert(d2Row && d1Row); assert.notEqual(d2Row.lineage_id, d1Row.lineage_id); assert.equal(d1Row.path, destinationPath);
      await currentAccess();
      const later = await loadCollaborationState(target.documentId); assert(later);
      assert.equal(Number((await h.admin.query('SELECT room_owner_epoch FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId])).rows[0].room_owner_epoch), 0);
      const edit = new Y.Doc();
      try {
        Y.applyUpdate(edit, later.yjsState); const frontmatter = edit.getText('frontmatter'); frontmatter.insert(frontmatter.length, '\n# Later legitimate edit\n');
        assert.equal((await persistCollaborationYDoc(later.documentId, later.lifecycleGeneration, edit, {
          workspaceId: later.workspaceId, organizationId: later.organizationId, path: later.path,
          representation: later.representation, schemaVersion: later.schemaVersion })).persistenceDisposition, 'advanced');
      } finally { edit.destroy(); }
      await h.metadata(h.source, destinationPath, { title: 'Later legitimate D1 title' });
      const laterState = await loadCollaborationState(target.documentId); assert(laterState); assert.notEqual(hash(laterState.yjsState), hash(later.yjsState));
      phaseAt('new Store reloads the exact original saved plan and claim, no preview');
      const replayStore = new WorkspaceOperationBatchStore(), stored = await replayStore.get(batchId); assert(stored);
      assert.equal(JSON.stringify(stored.plan), planText); assert.deepEqual(stored.authorization, created.authorization);
      assert.deepEqual(await batchIdentity(), originalBatchIdentity);
      const queued = await replayStore.enqueue({ batchId, planId: stored.planId, userId: access.userId, displayName: 'Original owner historical resume', action: 'resume' });
      assert.equal(JSON.stringify(queued.plan), planText); const historicalClaim = await replayStore.claim(randomUUID()); assert(historicalClaim);
      assert.equal(historicalClaim.batchId, batchId); assert.equal(JSON.stringify(historicalClaim.plan), planText); assert.deepEqual(historicalClaim.authorization, created.authorization);
      const replayAccess = await currentAccess();
      const schemaBefore = await privateSchemaSnapshot(h), fsBefore = await workspaceTree(workspace.rootPath), neighborFsBefore = await workspaceTree(h.destination.rootPath);
      const d2Before = await untouched(h, sourcePath, workspace), movedBefore = await untouched(h, destinationPath, workspace);
      const incomingBeforeHistory = await untouched(h, incomingPath, workspace), immutableBefore = await readLedger();
      const domainWrites: Array<{ kind: string; table: string | null }> = [], bookkeeping: string[] = [];
      const sqlObservations: Array<{ querySha256: string; kind: string | null; table: string | null; rowCount: number | null }> = [];
      facts.historicalSql = { scope: 'Historical document execution; Store finalization follows outside this probe.',
        domainWrites, bookkeeping, sqlObservations };
      phaseAt('historical original replay with D2 and native edit present');
      const recovered = await replayStore.withClaim(historicalClaim, async claim => {
        const result = await h.withProbe(async event => {
          const kind = pendingSqlMutation(event.text);
          const table = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"[^"]+"\.)?"?([a-z_]+)"?/iu.exec(event.text)?.[1] ?? null;
          sqlObservations.push({ querySha256: hash(event.text), kind, table, rowCount: event.result.rowCount });
          if (!kind) return;
          if (kind === 'UPDATE' && table === 'workspace_file_operation_batches') bookkeeping.push(kind);
          else domainWrites.push({ kind, table });
        }, () => execute({ claim, workspace: replayAccess.workspace }));
        const finished = await replayStore.finishClaim(historicalClaim, { status: 'applied', completedActions: historicalClaim.totalActions, phase: 'complete' });
        assert(finished); return result;
      });
      await write('historical-sql-observation', facts.historicalSql);
      assert.deepEqual(domainWrites, []); assert.deepEqual(recovered, completion); assert.deepEqual(await readLedger(), immutableBefore);
      const schemaAfter = await privateSchemaSnapshot(h);
      const domainSchema = (value: Awaited<ReturnType<typeof privateSchemaSnapshot>>) => ({ ...value,
        rowProofs: Object.fromEntries(Object.entries(value.rowProofs).filter(([table]) => table !== 'workspace_file_operation_batches')) });
      assert.deepEqual(domainSchema(schemaAfter), domainSchema(schemaBefore));
      assert.deepEqual(await workspaceTree(workspace.rootPath), fsBefore); assert.deepEqual(await workspaceTree(h.destination.rootPath), neighborFsBefore);
      assert.deepEqual(await untouched(h, sourcePath, workspace), d2Before); assert.deepEqual(await untouched(h, destinationPath, workspace), movedBefore);
      assert.deepEqual(await untouched(h, incomingPath, workspace), incomingBeforeHistory);
      assert.deepEqual(await untouched(h, keepPath, workspace), keepBefore); assert.deepEqual(await untouched(h, WORKSPACE_STARTER_DOCUMENT_NAME, workspace), starterBefore);
      assert.deepEqual(await untouched(h, WORKSPACE_STARTER_DOCUMENT_NAME, h.destination), neighborBefore);
      const final = await replayStore.get(batchId); assert(final); assert.equal(final.status, 'applied'); assert.equal(final.phase, 'complete');
      assert.equal(final.completedActions, final.totalActions); assert.deepEqual(await batchIdentity(), originalBatchIdentity);
      assert.equal((await readStatus())?.observation.apply, 'complete');
      facts.result = { passed: true, b2AckLost: true, backendClosed: true, originalPlanReloaded: true, replans: 0,
        originalDocumentId: target.documentId, laterDocumentId: d2.documentId, originalDocumentEdited: true, laterDocumentUnchanged: true,
        nativeReceipts: completion.native?.receipts.length, domainWrites: domainWrites.length, batchBookkeepingStatements: bookkeeping.length };
      facts.passed = true; phaseAt('all domain assertions complete'); await record();
    });
  } catch (error) {
    facts.firstFailure = { phase, error: errorFacts(error) }; facts.passed = false;
    if (!recorded) await record(); else await write('terminal-failure', { phase, error: errorFacts(error), originalFailurePreserved: true });
    throw error;
  } finally { const afterPins = await pins(); await write('source-after', afterPins); assert.deepEqual(afterPins, beforePins);
    console.log(JSON.stringify({ suite, sourcePins: afterPins, sourcesUnchanged: true })); }
  console.log('PASS original-move-b2-ack 1: actual committed B2 ACK loss, fresh original Store reload, D2 and later native edit, historical zero domain DML');
  console.log(JSON.stringify({ suite, groups: 1, passed: true, closureRequiredAndReturned: true, elapsedMs: Math.round(performance.now() - started) }));
}
let mainCompleted = false;
process.once('beforeExit', () => { if (!mainCompleted) process.exitCode = 1; });
void main().then(() => { mainCompleted = true; }).catch(error => {
  console.error(JSON.stringify({ suite, passed: false, error: errorFacts(error) })); process.exitCode = 1;
});
