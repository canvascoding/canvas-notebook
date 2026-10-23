/** PostgreSQL regression: original Delete B1/B2 recovery and native recreation.
 * Genuine default Original Delete Owner + actual PG18 + real Principal/Store/import/projector.
 * SQL probes observe actual executed SQL, then deliberately lose exactly two COMMIT ACKs.
 * No SQL native/registry patch, replan, fake owner, transport/browser claim or expected-RED pass.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WorkspaceRequestPrincipalAccess } from '../app/lib/workspaces/request-principal';
import type { WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import type { OriginalIntent } from '../app/lib/files/workspace-operation-original-delete-evidence';
type Fixture = Parameters<Parameters<typeof withNativeCopyMetadataOwnerFixture>[0]>[0];
const repo = process.cwd();
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sourceFiles = ["app/lib/collaboration/agent-durability.ts","app/lib/collaboration/checkpoint-errors.ts","app/lib/collaboration/checkpoint.ts","app/lib/collaboration/document-snapshot.ts","app/lib/collaboration/markdown-file-import-persistence.ts","app/lib/collaboration/native-copy-persistence.ts","app/lib/collaboration/native-file-archive-transition.ts","app/lib/collaboration/persistence.ts","app/lib/collaboration/projection-identity.ts","app/lib/collaboration/projection-publication-guard.ts","app/lib/collaboration/projection-repository.ts","app/lib/collaboration/projection-runtime.ts","app/lib/collaboration/room-admission-contract.ts","app/lib/collaboration/room-admission.ts","app/lib/collaboration/room-owner.ts","app/lib/collaboration/server-runtime.ts","app/lib/files/collaboration-policy.ts","app/lib/files/collaboration-repository/document-repository.ts","app/lib/files/collaboration-repository/lineage-revision-repository.ts","app/lib/files/collaboration-repository/transaction.ts","app/lib/files/workspace-file-lifecycle-guard.ts","app/lib/files/workspace-mutation-lock.ts","app/lib/files/workspace-operation-batch-contract.ts","app/lib/files/workspace-operation-batch-plan.ts","app/lib/files/workspace-operation-batch-store.ts","app/lib/files/workspace-operation-copy-origin.ts","app/lib/files/workspace-operation-job-lifecycle-owner.ts","app/lib/files/workspace-operation-job-phase-scheduling.ts","app/lib/files/workspace-operation-job-scope.ts","app/lib/files/workspace-operation-native-catalogue-witness.ts","app/lib/files/workspace-operation-native-copy-graph.ts","app/lib/files/workspace-operation-native-copy-metadata.ts","app/lib/files/workspace-operation-native-copy-owner.ts","app/lib/files/workspace-operation-native-copy-phase-contract.ts","app/lib/files/workspace-operation-native-copy-phase-read.ts","app/lib/files/workspace-operation-native-copy-phase.ts","app/lib/files/workspace-operation-native-copy-plan.ts","app/lib/files/workspace-operation-native-copy-stage.ts","app/lib/files/workspace-operation-native-delete-effects.ts","app/lib/files/workspace-operation-native-delete-plan.ts","app/lib/files/workspace-operation-native-move-plan.ts","app/lib/files/workspace-operation-native-original-source.ts","app/lib/files/workspace-operation-native-plan-data.ts","app/lib/files/workspace-operation-native-read-context.ts","app/lib/files/workspace-operation-native-source-evidence.ts","app/lib/files/workspace-operation-original-delete-evidence.ts","app/lib/files/workspace-operation-original-delete-links.ts","app/lib/files/workspace-operation-original-delete-native.ts","app/lib/files/workspace-operation-original-delete-observation.ts","app/lib/files/workspace-operation-original-delete-public.ts","app/lib/files/workspace-operation-original-delete-repository.ts","app/lib/files/workspace-operation-original-delete-storage.ts","app/lib/files/workspace-operation-original-delete.ts","app/lib/files/workspace-operation-original-move-admission.ts","app/lib/files/workspace-operation-original-move-handoff-storage.ts","app/lib/files/workspace-operation-original-move-namespace-effects.ts","app/lib/files/workspace-operation-original-move-repository.ts","app/lib/files/workspace-operation-original-move-runner.ts","app/lib/files/workspace-operation-original-move-sources.ts","app/lib/files/workspace-operation-original-move-storage.ts","app/lib/files/workspace-operation-original-move.ts","app/lib/files/workspace-operation-staging.ts","app/lib/filesystem/prepared-single-file-trash.ts","app/lib/filesystem/prepared-workspace-path-copy-contract.ts","app/lib/filesystem/prepared-workspace-path-copy.ts","app/lib/filesystem/prepared-workspace-path-move-contract.ts","app/lib/filesystem/prepared-workspace-path-move.ts","app/lib/filesystem/workspace-files.ts","app/lib/filesystem/workspace-trash-layout.ts","app/lib/markdown/native-file-operation-handoff.ts","app/lib/markdown/native-file-operation-side-effects.ts","app/lib/markdown/native-link-mutation-persistence.ts","app/lib/markdown/workspace-native-link-inventory.ts","app/lib/markdown/workspace-source-authority-stage.ts","app/lib/secrets/file-mutation-lock.ts","app/lib/workspaces/context.ts","app/lib/workspaces/postgres-runtime.ts","app/lib/workspaces/request-principal.ts","app/lib/workspaces/request.ts","app/lib/workspaces/starter-document.ts","scripts/helpers/native-copy-metadata-owner-fixture.ts","scripts/helpers/pglite-pool-harness.ts","scripts/workspace-operation-native-delete-links-postgres-test.ts","scripts/workspace-operation-original-delete-postgres-test.ts","scripts/workspace-operation-original-delete-v3-test.ts","scripts/workspace-operation-original-move-owner-postgres-test.ts"];
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
  assert(process.argv.length === 2 || process.argv.length === 3, 'Provide at most one absolute private report directory.');
  const reportRoot = process.argv[2] ?? await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-original-delete-recreate-')));
  const reportIdentity = await lstat(reportRoot);
  assert(path.isAbsolute(reportRoot) && await realpath(reportRoot) === reportRoot
    && reportIdentity.isDirectory() && !reportIdentity.isSymbolicLink()
    && reportIdentity.uid === process.getuid?.() && (reportIdentity.mode & 0o777) === 0o700);
  const started = performance.now();
  const write = (name: string, value: unknown) => writeFile(path.join(reportRoot, `${name}.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  const pins = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(path.join(repo, file)))])));
  const sourceBefore = await pins(); await write('source-before', sourceBefore);
  let phase = 'fixture entry', recorded = false;
  const facts: Record<string, unknown> = { suite: 'workspace-operation-original-delete-recreate-postgres', passed: false,
    scope: 'Actual default Owner/Principal/Store and real PG18/import/editor-persistence kernel/projector. No HTTP/editor transport/UI/production claim.',
    budgetMs: 180_000, passiveClosureBoundMs: 2000, replans: 0, automaticRetries: 0, declaredAckFaults: ['committed-B1', 'committed-recovery-B2'] };
  const phaseAt = (value: string) => { phase = value; facts.phase = value;
    assert(performance.now() - started < 180_000, 'The unchanged 180s child budget was exceeded.'); };
  const record = async () => { assert.equal(recorded, false); await write('observations', facts); recorded = true; };
  try {
    await withNativeCopyMetadataOwnerFixture(async h => {
      facts.fixture = { schema: h.schema, schemaOid: h.schemaOid, applicationName: h.applicationName, dataRoot: h.dataRoot,
        sourceWorkspaceId: h.source.workspaceId, sourceReadonlyMember: h.source.permissions.canWrite === false };
      const { openDb } = await import('../app/lib/db');
      const { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } = await import('../app/lib/workspaces/request-principal');
      const { loadCollaborationState, loadCollaborationStateIncludingArchived, persistCollaborationYDoc } = await import('../app/lib/collaboration/persistence');
      const { Y } = await import('../app/lib/collaboration/server-runtime');
      const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
      const { loadCollaborationProjectionWorkspace, hasPendingCollaborationProjection } = await import('../app/lib/collaboration/projection-repository');
      const { materializeCollaborationCheckpoint } = await import('../app/lib/collaboration/checkpoint');
      const { CollaborationFileOperationProjectionPendingError } = await import('../app/lib/collaboration/checkpoint-errors');
      const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
      const { inspectPersistedDocumentLinks, nativeLinkJsonProof } = await import('../app/lib/markdown/workspace-native-link-inventory');
      const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
      const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
      const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
      const { executeWorkspaceOperationOriginalDelete } = await import('../app/lib/files/workspace-operation-original-delete');
      const { parseIntent, assertOriginalDeleteIntentPlan, completed: decodeCompleted } = await import('../app/lib/files/workspace-operation-original-delete-evidence');
      const { WORKSPACE_STARTER_DOCUMENT_NAME } = await import('../app/lib/workspaces/starter-document');
      const store = new WorkspaceOperationBatchStore();
      type CurrentActor = Pick<WorkspaceRequestPrincipalAccess, 'workspace' | 'userId' | 'sessionId'>;
      const currentAccess = async (): Promise<CurrentActor> => {
        // Genuine signed helper request, then the actual current principal. This is a kernel probe, not an HTTP route test.
        const request = await h.request(h.source, 'owner', true);
        return withWorkspaceRequestPrincipal<CurrentActor>(request, { workspaceId: h.source.workspaceId, permission: 'canWrite' }, async principal => {
          const connection = await openDb(); let began = false, committed = false;
          try {
            await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
            const result = await withWorkspaceRequestPrincipalOnConnection<CurrentActor>(connection, principal, async access => {
              assert.equal(access.userId, 'owner'); assert.equal(access.sessionId, 'session-owner');
              assert.equal(access.workspace.workspaceId, h.source.workspaceId);
              assert.equal(access.workspace.permissions.canWrite, true); assert.equal(access.workspace.permissions.canDelete, true);
              await access.assertCurrent(); return { workspace: access.workspace, userId: access.userId, sessionId: access.sessionId };
            });
            await connection.run('COMMIT'); committed = true; return result;
          } catch (error) { if (began && !committed) await connection.run('ROLLBACK'); throw error; }
          finally { await connection.close(committed ? undefined : new Error('Discarding failed genuine Principal phase.')); }
        });
      };
      const targetPath = `selected-target-${randomUUID()}.md`, sourcePath = `incoming-source-${randomUUID()}.md`, keepPath = `keep-${randomUUID()}.md`;
      const targetBytes = Buffer.from('# Selected original D1\n\nExact target content.\n');
      const incomingBytes = Buffer.from(`# Incoming source\n\n[Target](${targetPath}) and [Keep](${keepPath}).\n\nPreserve this paragraph.\n`);
      phaseAt('authenticated target import'); const target = await h.upload(targetPath, targetBytes);
      phaseAt('authenticated keep import'); const keep = await h.upload(keepPath, Buffer.from('# Independent keep\n\nUnchanged.\n'));
      phaseAt('authenticated incoming source import'); const source = await h.upload(sourcePath, incomingBytes);
      await h.metadata(h.source, targetPath, { title: 'Original D1 metadata', isFavorite: true, pinned: true });
      await h.metadata(h.source, sourcePath, { title: 'Incoming source metadata', isFavorite: true, pinned: true });
      facts.selection = { targetPath, sourcePath, keepPath, target, source, keep };
      const sourceFacts = async () => {
        const state = await loadCollaborationState(source.documentId); assert(state);
        const snapshot = authoritativeNativeCollaborationSnapshot(state), inventory = inspectPersistedDocumentLinks(state);
        return { native: { documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId,
          path: state.path, status: state.status, lifecycleGeneration: state.lifecycleGeneration, representation: state.representation,
          schemaVersion: state.schemaVersion, yjsBase64: Buffer.from(state.yjsState).toString('base64'), binaryHash: hash(state.yjsState),
          vectorBase64: Buffer.from(state.stateVector).toString('base64'), vectorHash: hash(state.stateVector),
          documentSequence: state.documentSequence, persistedAt: state.persistedAt, stateProof: snapshot.version.stateProof,
          inventory, inventoryProof: nativeLinkJsonProof(inventory) },
          projection: { pending: await hasPendingCollaborationProjection(state), checkpointSequence: state.checkpointSequence,
            checkpointedAt: state.checkpointedAt, canonicalHash: state.canonicalHash, serializedHash: state.serializedHash },
          actual: await untouched(h, sourcePath, h.source) };
      };
      const lineageFacts = async (filePath: string) => (await h.admin.query(`SELECT l.*,l.xmin::text AS xmin FROM file_collaboration_lineages l
        JOIN collaboration_documents d ON d.lineage_id=l.id WHERE d.workspace_id=$1 AND d.path=$2 ORDER BY l.id`, [h.source.workspaceId, filePath])).rows;
      const currentTargetFacts = async () => ({ actual: await untouched(h, targetPath, h.source), lineages: await lineageFacts(targetPath) });
      const initialSource = await sourceFacts(); assert.equal(initialSource.native.representation, 'tiptap_blocks');
      assert.equal(initialSource.native.inventory.coverage.complete, true);
      assert.deepEqual(initialSource.native.inventory.links.map(link => link.literal), [targetPath, keepPath]);
      const targetBefore = await currentTargetFacts(), keepBefore = await untouched(h, keepPath, h.source);
      const starterBefore = await untouched(h, WORKSPACE_STARTER_DOCUMENT_NAME, h.source);
      const neighborBefore = await untouched(h, WORKSPACE_STARTER_DOCUMENT_NAME, h.destination);
      const targetNativeBefore = await loadCollaborationState(target.documentId); assert(targetNativeBefore);
      facts.before = { source: initialSource, target: targetBefore, keep: keepBefore, starter: starterBefore, neighbor: neighborBefore };
      phaseAt('actual editor persistence kernel before the single original preview');
      assert.equal(Number((await h.admin.query('SELECT room_owner_epoch FROM collaboration_yjs_states WHERE document_id=$1', [source.documentId])).rows[0].room_owner_epoch), 0);
      const edited = await loadCollaborationState(source.documentId); assert(edited); const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, edited.yjsState); const frontmatter = doc.getText('frontmatter');
        frontmatter.delete(0, frontmatter.length); frontmatter.insert(0, '---\ntitle: Actual native edit pending at B1\n---\n');
        const result = await persistCollaborationYDoc(edited.documentId, edited.lifecycleGeneration, doc, {
          workspaceId: edited.workspaceId, organizationId: edited.organizationId, path: edited.path,
          representation: edited.representation, schemaVersion: edited.schemaVersion });
        assert.equal(result.persistenceDisposition, 'advanced');
      } finally { doc.destroy(); }
      const beforePreview = await sourceFacts(); facts.beforePreview = beforePreview;
      assert.notEqual(beforePreview.native.binaryHash, initialSource.native.binaryHash);
      assert.equal(beforePreview.projection.pending, true); assert(beforePreview.projection.checkpointSequence < beforePreview.native.documentSequence);
      assert.deepEqual(beforePreview.actual.physical, initialSource.actual.physical);
      phaseAt('single genuine V2 preview'); const access = await currentAccess();
      const plan = await buildWorkspaceOperationBatchPlan({ scope: { workspace: access.workspace, fileOptions: { workspace: access.workspace } },
        actions: [{ reviewId: randomUUID(), kind: 'delete', selections: [{ sourcePath: targetPath }] }] });
      assert.equal(plan.version, 2); if (plan.version !== 2) assert.fail('A genuine native Delete plan is mandatory.');
      assert.equal(plan.planIdentityVersion, 2); assert.equal(plan.readiness, 'ready'); assert.deepEqual(plan.issues, []);
      assert.equal(plan.sourceEvidence.evidenceVersion, 2);
      assert(plan.sourceEvidence.nativeBindings.some(binding => binding.expected.documentId === source.documentId));
      facts.plan = plan; const planBytes = JSON.stringify(plan), batchId = randomUUID(); facts.batchId = batchId;
      phaseAt('actual Store createDirect and original claim');
      const created = await store.createDirect({ batchId, plan, authorization: { mode: 'direct', actorUserId: access.userId,
        actorId: access.userId, actorType: 'user', actorSessionId: access.sessionId, actorDisplayName: 'Delete B1 ACK recovery counterprobe',
        requestHash: hash(randomUUID()), jobScope: captureWorkspaceOperationJobScope(access.workspace) } });
      const originalClaim = await store.claim(randomUUID()); assert(originalClaim); assert.equal(originalClaim.batchId, batchId);
      const batchIdentity = async () => (await h.admin.query(`SELECT batch_id,plan_id,workspace_id,plan_json,authorization_json,total_actions,created_at
        FROM workspace_file_operation_batches WHERE batch_id=$1`, [batchId])).rows[0];
      const originalBatchIdentity = await batchIdentity(); facts.batchIdentity = originalBatchIdentity;
      const ledger = async () => Object.fromEntries(await Promise.all([
        'workspace_file_operation_delete_intents', 'workspace_file_operation_delete_trash_receipts', 'workspace_file_operation_delete_receipts',
      ].map(async table => [table, (await h.admin.query(`SELECT *,xmin::text AS xmin FROM ${table} WHERE batch_id=$1`, [batchId])).rows])));
      const intentRows = (rows: Awaited<ReturnType<typeof ledger>>) => rows.workspace_file_operation_delete_intents;
      const completionRows = (rows: Awaited<ReturnType<typeof ledger>>) => rows.workspace_file_operation_delete_receipts;
      const trashRows = (rows: Awaited<ReturnType<typeof ledger>>) => rows.workspace_file_operation_delete_trash_receipts;
      const ledgerBefore = await ledger(); assert.equal(intentRows(ledgerBefore).length, 0);
      assert.equal(completionRows(ledgerBefore).length, 0); assert.equal(trashRows(ledgerBefore).length, 0);
      type Backend = { pid: number; start: string; schema: string; schemaOid: string; applicationName: string; transactionId: string | null };
      const actualBackend = async (event: MetadataSqlEvent): Promise<Backend> => {
        const row = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM a.backend_start)::text AS start,
          current_schema() AS schema,n.oid::text AS schema_oid,current_setting('application_name') AS application_name,
          pg_current_xact_id_if_assigned()::text AS transaction_id FROM pg_stat_activity a
          JOIN pg_namespace n ON n.nspname=current_schema() WHERE a.pid=pg_backend_pid()`)).rows[0];
        assert(row); assert.equal(row.schema, h.schema); assert.equal(row.schema_oid, h.schemaOid); assert.equal(row.application_name, h.applicationName);
        return { pid: Number(row.pid), start: String(row.start), schema: row.schema, schemaOid: row.schema_oid,
          applicationName: row.application_name, transactionId: row.transaction_id };
      };
      const assertBackendClosed = async (backend: Backend) => {
        // This is passive disposal observation only: no domain call, SQL write,
        // backend termination, lock acquisition, replay or original-budget reset.
        const observationStarted = performance.now();
        const observationDeadline = Math.min(observationStarted + 2000, started + 180_000);
        let samples = 0, last: { alive?: unknown; advisory_held?: unknown } | undefined;
        while (true) {
          assert(performance.now() < observationDeadline, 'Passive backend closure bound or original 180s budget exhausted before observation.');
          last = (await h.admin.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1
            AND extract(epoch FROM backend_start)::text=$2) AS alive,
            EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
              WHERE l.pid=$1 AND extract(epoch FROM a.backend_start)::text=$2 AND l.locktype='advisory' AND l.granted) AS advisory_held`, [backend.pid, backend.start])).rows[0];
          samples++;
          assert(last && typeof last.alive === 'boolean' && typeof last.advisory_held === 'boolean');
          assert(performance.now() < observationDeadline, 'Passive backend closure bound or original 180s budget exhausted after observation.');
          if (!last.alive && !last.advisory_held) return { samples, elapsedMs: Math.round(performance.now() - observationStarted),
            originalBudgetMs: 180_000, passiveBoundMs: 2000, final: last };
          const remaining = observationDeadline - performance.now();
          assert(remaining > 0, 'Exact backend PID/start and advisory-lock disposal was not observed within the passive closure bound.');
          await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
        }
      };
      const invoke = (claimed: WorkspaceOperationBatchRecord) => store.withClaim(claimed, async claim => {
        const result = await executeWorkspaceOperationOriginalDelete(claim);
        assert.equal(result.version, 3); assert(result.nativeLinks); assert.equal(result.nativeLinks.length, 1);
        const finished = await store.finishClaim(claimed, { status: 'applied', trashEntryIds: [result.trashEntryId],
          completedActions: 1 + result.nativeLinks.length, phase: 'complete' });
        assert(finished); assert.equal(finished.status, 'applied'); assert.equal(finished.completedActions, finished.totalActions);
        return result;
      });
      const ackFault = async (kind: 'B1' | 'B2', claimed: WorkspaceOperationBatchRecord) => {
        let client: MetadataSqlEvent['client'] | undefined, backend: Backend | undefined, injected = false, committedLedger: Awaited<ReturnType<typeof ledger>> | undefined;
        let insertTransaction: string | null = null;
        const b2Effects: Array<{ table: string; backend: Backend; affectedRows: number | null }> = [];
        const b2Tables = ['collaboration_yjs_states', 'collaboration_documents', 'file_collaboration_lineages', 'collaboration_file_projections',
          'collaboration_native_link_mutation_receipts', 'workspace_trash_entries', 'workspace_file_operation_delete_trash_receipts', 'workspace_file_operation_delete_receipts'];
        await assert.rejects(h.withProbe(async event => {
          const effect = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"[^"]+"\.)?"?([a-z_]+)"?/iu.exec(event.text);
          if (kind === 'B2' && effect && b2Tables.includes(effect[1])) {
            b2Effects.push({ table: effect[1], backend: await actualBackend(event), affectedRows: event.result.rowCount });
          }
          const relation = kind === 'B1' ? 'workspace_file_operation_delete_intents' : 'workspace_file_operation_delete_receipts';
          if (/^\s*INSERT\s+INTO\b/iu.test(event.text) && event.text.includes(relation)) {
            assert.equal(injected, false); assert.equal(event.values[0], batchId);
            assert.equal(client, undefined, 'The selected journal INSERT must occur only once.');
            assert.equal(event.result.rowCount, 1); client = event.client; backend = await actualBackend(event);
            assert(backend.transactionId); insertTransaction = backend.transactionId;
          }
          if (/^\s*COMMIT\s*$/iu.test(event.text) && event.client === client && !injected) {
            assert(backend); const afterCommit = await actualBackend(event);
            assert.equal(afterCommit.pid, backend.pid); assert.equal(afterCommit.start, backend.start); assert.equal(afterCommit.transactionId, null);
            // An independent real connection must already see the committed journal.
            committedLedger = await ledger(); assert.equal(intentRows(committedLedger).length, 1);
            if (kind === 'B1') { assert.equal(completionRows(committedLedger).length, 0); assert.equal(trashRows(committedLedger).length, 0);
              assert.deepEqual(await currentTargetFacts(), targetBefore); assert.deepEqual(await sourceFacts(), beforePreview); }
            else {
              assert.equal(completionRows(committedLedger).length, 1); assert.equal(trashRows(committedLedger).length, 1);
              for (const table of b2Tables) assert(b2Effects.some(effect => effect.table === table && effect.affectedRows === 1), `Missing actual B2 write: ${table}`);
              assert.equal(b2Effects.filter(effect => effect.table === 'collaboration_yjs_states' && effect.affectedRows === 1).length, 2);
              for (const effect of b2Effects) {
                assert.equal(effect.backend.pid, backend.pid); assert.equal(effect.backend.start, backend.start);
                assert.equal(effect.backend.transactionId, insertTransaction, 'Archive, link, trash and immutable completion must share the same real B2 transaction.');
              }
            }
            injected = true;
            throw Object.assign(new Error(`Deliberate loss of the genuine ${kind} COMMIT acknowledgement.`), { code: `FIXTURE_DELETE_${kind}_ACK_LOST` });
          }
        }, () => invoke(claimed)), (error: unknown) => {
          facts[`${kind}Failure`] = errorFacts(error);
          return error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED';
        });
        assert.equal(injected, true); assert(backend); assert(committedLedger); assert(insertTransaction);
        const closureObservation = await assertBackendClosed(backend);
        facts[`${kind}CommittedOwner`] = { ...backend, insertTransaction, closed: true, closureObservation, ...(kind === 'B2' ? { actualSameTransactionEffects: b2Effects } : {}) };
        return { backend, committedLedger };
      };
      phaseAt('real B1 committed, acknowledgement lost, actual Owner B disposed');
      const b1 = await ackFault('B1', originalClaim); const ledgerB1 = await ledger(); facts.ledgerB1 = ledgerB1;
      assert.deepEqual(ledgerB1, b1.committedLedger);
      const originalRow = intentRows(ledgerB1)[0]; assert(originalRow); assert.equal(hash(originalRow.intent_text), originalRow.intent_digest);
      const evidenceRow = { batchId: originalRow.batch_id, planId: originalRow.plan_id, workspaceId: originalRow.workspace_id,
        requestHash: originalRow.request_hash, intentText: originalRow.intent_text, intentDigest: originalRow.intent_digest, createdAt: Number(originalRow.created_at) };
      const originalIntent: OriginalIntent = parseIntent(evidenceRow, { batchId, planId: plan.planId, workspaceId: h.source.workspaceId,
        authorization: created.authorization, sourcePath: targetPath }, access.workspace, h.dataRoot);
      assert.equal(originalIntent.version, 3); assert.equal(originalIntent.nativeLinks?.length, 1); assertOriginalDeleteIntentPlan(originalIntent, plan);
      assert(originalIntent.native); assert.equal(originalIntent.native.documentId, target.documentId);
      assert.equal(originalIntent.native.binaryHash, hash(targetNativeBefore.yjsState));
      assert.equal(originalIntent.native.vectorHash, hash(targetNativeBefore.stateVector));
      assert.equal(originalIntent.physical.source.kind, 'regular_file');
      assert.equal((await physical(path.join(h.dataRoot, originalIntent.physical.trashRelativePath))).present, false);
      const checkpoint = async () => {
        const state = await loadCollaborationState(source.documentId); assert(state);
        const workspace = await loadCollaborationProjectionWorkspace(state); assert(workspace);
        assert.equal(workspace.workspaceId, h.source.workspaceId); assert.equal(workspace.rootPath, h.source.rootPath);
        return materializeCollaborationCheckpoint({ state, workspace, actorType: 'system' });
      };
      const workspaceAdmissionKey = collaborationAdmissionLockKey(h.source.workspaceId);
      const workspaceAdmissionUnsigned = BigInt.asUintN(64, BigInt(workspaceAdmissionKey));
      const assertActualSharedWorkspaceLock = async (event: MetadataSqlEvent, backend: Backend) => {
        const row = (await event.raw(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a ON a.pid=l.pid
          WHERE l.locktype='advisory' AND l.granted AND l.mode='ShareLock' AND l.objsubid=1
            AND l.pid=pg_catalog.pg_backend_pid() AND l.pid=$1 AND extract(epoch FROM a.backend_start)::text=$2
            AND l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
            AND l.classid::bigint=$3 AND l.objid::bigint=$4) AS held`,
        [backend.pid,backend.start,Number(workspaceAdmissionUnsigned >> BigInt(32)),Number(workspaceAdmissionUnsigned & BigInt('0xffffffff'))])).rows[0];
        assert.equal(row?.held, true, 'The same actual guard B must retain the exact workspace shared admission key.');
      };
      const pendingSnapshot = async () => ({
        privateSchema: await privateSchemaSnapshot(h),
        sourceTree: await workspaceTree(h.source.rootPath), destinationTree: await workspaceTree(h.destination.rootPath),
        source: await sourceFacts(), target: await currentTargetFacts(), ledger: await ledger(), batch: await batchIdentity(),
      });
      const assertProjectorDeferred = async (label: string) => {
        phaseAt(label); const before = await pendingSnapshot();
        let sharedReads = 0, pendingReads = 0, guardBackend: Backend | undefined, guardClient: MetadataSqlEvent['client'] | undefined;
        const successfulMutations: Array<{ token: string; sqlSha256: string; affectedRows: number | null; backend: Backend }> = [];
        const causalObservations: Array<{ phase: 'shared-lock-acquired' | 'durable-delete-pending'; backend: Backend; held: true }> = [];
        // Retain observations even if the first unexpected successful write or
        // causal-binding assertion fails; failure reports must not erase it.
        facts[label] = { passed: false, beforeSnapshot: before, successfulMutations, causalObservations,
          expectedPendingCode: 'COLLABORATION_FILE_OPERATION_PROJECTION_PENDING' };
        await assert.rejects(h.withProbe(async event => {
          // The unchanged fixture calls this only AFTER a successful real SQL
          // result. Never mock query results or suppress a successful mutation.
          const mutation = pendingSqlMutation(event.text);
          if (mutation) {
            successfulMutations.push({ token: mutation, sqlSha256: hash(event.text), affectedRows: event.result.rowCount,
              backend: await actualBackend(event) });
            assert.fail('A successful actual mutating SQL statement occurred inside the Pending projector scope.');
          }
          if (event.text.includes('pg_try_advisory_lock_shared')) {
            assert.match(event.text, /^\s*SELECT\s+(?:pg_catalog\.)?pg_try_advisory_lock_shared\(\$1::bigint\)\s+AS\s+locked\s*$/iu);
            sharedReads++; assert.equal(sharedReads, 1); assert.equal(pendingReads, 0);
            assert.equal(event.values.length, 1); assert.equal(BigInt(String(event.values[0])), BigInt(workspaceAdmissionKey));
            assert.equal(event.result.rowCount, 1); assert.equal(event.result.rows.length, 1); assert.equal(event.result.rows[0]?.locked, true);
            guardClient = event.client; guardBackend = await actualBackend(event); assert.equal(guardBackend.transactionId, null);
            await assertActualSharedWorkspaceLock(event, guardBackend);
            causalObservations.push({ phase: 'shared-lock-acquired', backend: guardBackend, held: true });
          }
          if (event.text.includes(' AS delete_pending')) {
            pendingReads++; assert.equal(pendingReads, 1); assert.equal(sharedReads, 1); assert(guardBackend); assert(guardClient);
            assert.equal(event.client, guardClient, 'The durable pending SELECT must execute on the exact shared-lock guard client.');
            assert.equal(event.values.length, 1); assert.equal(event.values[0], h.source.workspaceId);
            assert(event.text.includes(`${sqlIdentifier(h.schema)}.workspace_file_operation_move_intents`));
            assert(event.text.includes(`${sqlIdentifier(h.schema)}.workspace_file_operation_move_receipts`));
            assert(event.text.includes(`${sqlIdentifier(h.schema)}.workspace_file_operation_delete_intents`));
            assert(event.text.includes(`${sqlIdentifier(h.schema)}.workspace_file_operation_delete_receipts`));
            assert.equal(event.result.rowCount, 1); assert.equal(event.result.rows.length, 1);
            assert.deepEqual(event.result.rows[0], { move_pending: false, delete_pending: true });
            const current = await actualBackend(event); assert.deepEqual(current, guardBackend);
            await assertActualSharedWorkspaceLock(event, current);
            causalObservations.push({ phase: 'durable-delete-pending', backend: current, held: true });
          }
        }, checkpoint), (error: unknown) => {
          facts[`${label}Failure`] = errorFacts(error);
          return error instanceof CollaborationFileOperationProjectionPendingError
            && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'COLLABORATION_FILE_OPERATION_PROJECTION_PENDING';
        });
        assert.equal(sharedReads, 1); assert.equal(pendingReads, 1); assert(guardBackend);
        assert.deepEqual(successfulMutations, []); assert.equal(causalObservations.length, 2);
        const closureObservation = await assertBackendClosed(guardBackend);
        const after = await pendingSnapshot();
        assert.deepEqual(after, before); assert.deepEqual(intentRows(after.ledger), intentRows(ledgerB1));
        assert.equal(after.source.projection.pending, true); assert.equal(after.source.native.binaryHash, beforePreview.native.binaryHash);
        assert.deepEqual(after.batch, originalBatchIdentity);
        facts[label] = { pendingCode: 'COLLABORATION_FILE_OPERATION_PROJECTION_PENDING', sharedReads, pendingReads,
          workspaceAdmissionUnsigned: workspaceAdmissionUnsigned.toString(), causalObservations, successfulMutations,
          passed: true, guardBackend, guardClosed: true, closureObservation, unchanged: true,
          beforeSnapshot: before, afterSnapshot: after, snapshotProof: nativeLinkJsonProof(after),
          proofScope: 'All entries/bytes/stable identities in both workspace roots, every ordinary private-schema table row+xmin, relation/column inventory and private sequence counters. Successful observed mutation SQL rejected. Not a syscall trace or arbitrary server-function/hostile-FS proof.' };
      };
      await assertProjectorDeferred('projector-after-B1-owner-closed');
      const markRecovery = async (claimed: WorkspaceOperationBatchRecord, label: string) => {
        phaseAt(label);
        const finished = await store.finishClaim(claimed, { status: 'needs_recovery', errorCode: 'FIXTURE_ACK_LOST', phase: 'recovery' });
        assert(finished); assert.equal(finished.status, 'needs_recovery');
        const row = (await h.admin.query(`SELECT status,lease_owner IS NULL AS owner_lost,lease_token IS NULL AS token_lost,
          lease_expires_at IS NULL AS expiry_cleared FROM workspace_file_operation_batches WHERE batch_id=$1`, [batchId])).rows[0];
        assert.deepEqual(row, { status: 'needs_recovery', owner_lost: true, token_lost: true, expiry_cleared: true });
        facts[label] = row; assert.deepEqual(await batchIdentity(), originalBatchIdentity);
      };
      await markRecovery(originalClaim, 'actual-Store-release-original-claim');
      await assertProjectorDeferred('projector-after-claim-owner-lost');
      assert.deepEqual(await currentTargetFacts(), targetBefore); assert.deepEqual(await sourceFacts(), beforePreview);
      const resume = async () => {
        const queued = await store.enqueue({ batchId, planId: plan.planId, userId: access.userId, displayName: 'Original genuine owner', action: 'resume' });
        assert.equal(queued.status, 'queued'); assert.equal(JSON.stringify(queued.plan), planBytes);
        assert.deepEqual(queued.authorization, created.authorization); const claimed = await store.claim(randomUUID()); assert(claimed);
        assert.equal(claimed.batchId, batchId); assert.equal(JSON.stringify(claimed.plan), planBytes);
        assert.deepEqual(claimed.authorization, created.authorization); assert.deepEqual(await batchIdentity(), originalBatchIdentity); return claimed;
      };
      phaseAt('same genuine Store operation claim resumed, original B1 text retained'); const resumedClaim = await resume();
      phaseAt('actual recovery B2 committed completely, deliberate second acknowledgement loss');
      const b2 = await ackFault('B2', resumedClaim); assert.notDeepEqual([b2.backend.pid, b2.backend.start], [b1.backend.pid, b1.backend.start]);
      const ledgerCompleted = await ledger(); facts.ledgerCompleted = ledgerCompleted;
      assert.deepEqual(intentRows(ledgerCompleted), intentRows(ledgerB1)); assert.equal(completionRows(ledgerCompleted).length, 1); assert.equal(trashRows(ledgerCompleted).length, 1);
      const receiptRow = (row: { batch_id: string; intent_digest: string; receipt_text: string; receipt_digest: string; created_at: number | string }) => ({ batchId: row.batch_id, intentDigest: row.intent_digest, receiptText: row.receipt_text,
        receiptDigest: row.receipt_digest, createdAt: Number(row.created_at) });
      const completion = decodeCompleted(receiptRow(completionRows(ledgerCompleted)[0]), receiptRow(trashRows(ledgerCompleted)[0]), evidenceRow, originalIntent);
      assert.equal(completion.version, 3); assert.equal(completion.intentDigest, originalRow.intent_digest);
      assert.equal(completion.trashEntryId, originalIntent.physical.trashEntryId); assert.deepEqual(completion.physical.original, originalIntent.physical);
      assert(completion.native); assert.deepEqual({ ...completion.native.before.identity, ...completion.native.before.clock,
        registryStateVersion: completion.native.before.registryStateVersion }, originalIntent.native);
      assert.equal(completion.native.after.identity.documentId, target.documentId); assert.equal(completion.native.after.status, 'archived');
      assert.equal(completion.native.after.identity.lifecycleGeneration, target.lifecycleGeneration + 1);
      const archived = await loadCollaborationStateIncludingArchived(target.documentId); assert(archived); assert.equal(archived.status, 'archived');
      assert.deepEqual(Buffer.from(archived.yjsState), Buffer.from(targetNativeBefore.yjsState));
      assert.deepEqual(Buffer.from(archived.stateVector), Buffer.from(targetNativeBefore.stateVector));
      assert.equal(archived.documentSequence, targetNativeBefore.documentSequence); assert.equal(archived.persistedAt, targetNativeBefore.persistedAt);
      assert.equal(archived.lifecycleGeneration, targetNativeBefore.lifecycleGeneration + 1);
      assert.equal((await physical(path.join(h.source.rootPath, targetPath))).present, false);
      const trash = (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_trash_entries WHERE id=$1', [completion.trashEntryId])).rows[0];
      assert(trash); assert.equal(trash.status, 'trashed'); assert.equal(trash.original_path, targetPath);
      assert.equal(trash.trash_relative_path, originalIntent.physical.trashRelativePath);
      const payload = await physical(path.join(h.dataRoot, trash.trash_relative_path)); assert.equal(payload.present, true);
      assert.equal(payload.bytesSha256, hash(targetBytes)); assert.equal(completion.physical.observation.kind, 'moved');
      if (originalIntent.physical.source.kind !== 'regular_file' || completion.physical.observation.kind !== 'moved') assert.fail('Actual original FD rename is required.');
      assert.equal(payload.identity?.dev, originalIntent.physical.source.identity.device); assert.equal(payload.identity?.ino, originalIntent.physical.source.identity.inode);
      const linked = await sourceFacts(); facts.afterRecoveryB2 = { source: linked, archived, trash, payload, completion };
      assert.equal(linked.native.inventory.coverage.complete, true); assert.deepEqual(linked.native.inventory.links.map(link => link.literal), [keepPath]);
      assert.equal(linked.native.documentSequence, beforePreview.native.documentSequence + 1); assert.equal(linked.projection.pending, true);
      assert.deepEqual(linked.actual.physical, beforePreview.actual.physical); assert.deepEqual(linked.actual.annotations, beforePreview.actual.annotations);
      assert(completion.nativeLinks); assert.equal(completion.nativeLinks.length, 1);
      const linkReceipt = completion.nativeLinks[0]; assert.equal(linkReceipt.resultEvidenceVersion, 3);
      assert.equal(linkReceipt.source.documentId, source.documentId); assert.equal(linkReceipt.afterBinaryHash, linked.native.binaryHash);
      assert.equal(linkReceipt.afterVectorHash, linked.native.vectorHash); assert.equal(linkReceipt.after.documentSequence, linked.native.documentSequence);
      const mutationRows = (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_native_link_mutation_receipts WHERE operation_id=$1', [linkReceipt.operationId])).rows;
      assert.equal(mutationRows.length, 1); assert.equal(mutationRows[0].after_state_proof, linked.native.stateProof);
      assert.equal(hash(mutationRows[0].after_state_vector), linked.native.vectorHash);
      const targetAnnotations = await annotations(h, h.source.workspaceId, targetPath); assert.deepEqual(targetAnnotations, { shared: [], personal: [] });
      const d1ArchivedFacts = await currentTargetFacts();
      assert.equal(d1ArchivedFacts.actual.registry.length, 1); assert.equal(d1ArchivedFacts.actual.registry[0].status, 'archived');
      assert.equal(d1ArchivedFacts.lineages.length, 1); assert.equal(d1ArchivedFacts.lineages[0].status, 'archived');
      assert.equal(d1ArchivedFacts.lineages[0].trash_entry_id, completion.trashEntryId);
      await markRecovery(resumedClaim, 'actual-Store-release-recovery-claim-after-completed-B2');
      phaseAt('completed immutable receipt releases the real incoming source projector');
      let completedPendingReads = 0;
      const projected = await h.withProbe(async event => {
        if (event.text.includes(' AS delete_pending')) { completedPendingReads++;
          assert.equal(event.result.rows[0]?.move_pending, false); assert.equal(event.result.rows[0]?.delete_pending, false); }
      }, checkpoint);
      assert(completedPendingReads > 0); const projectedSource = await sourceFacts();
      assert.deepEqual(projectedSource.native, linked.native); assert.equal(projectedSource.projection.pending, false);
      assert.notDeepEqual(projectedSource.actual.physical, linked.actual.physical); assert.equal(projectedSource.actual.physical.bytesSha256, hash(projected.content));
      assert.deepEqual(projectedSource.actual.annotations, beforePreview.actual.annotations); assert.deepEqual(await currentTargetFacts(), d1ArchivedFacts);
      assert.deepEqual(await ledger(), ledgerCompleted); facts.projectorAfterCompletion = { pendingReads: completedPendingReads, source: projectedSource,
        contentHash: hash(projected.content), revisionId: projected.revisionId };
      phaseAt('actual authenticated central upload creates D2 at the old path after completion');
      const d2Bytes = Buffer.from('# Independent replacement D2\n\nDo not adopt this later native document.\n');
      const d2 = await h.upload(targetPath, d2Bytes); assert.notEqual(d2.documentId, target.documentId);
      await h.metadata(h.source, targetPath, { title: 'Independent D2 metadata', isFavorite: true, pinned: true });
      const d2Before = await currentTargetFacts(), sourceBeforeHistorical = await sourceFacts();
      const d2Registry = d2Before.actual.registry.find(row => row.id === d2.documentId); assert(d2Registry);
      assert.equal(d2Registry.status, 'active'); assert.notEqual(d2Registry.lineage_id, originalIntent.native.lineageId);
      assert.deepEqual(d2Before.actual.registry.find(row => row.id === target.documentId), d1ArchivedFacts.actual.registry[0]);
      assert.deepEqual(d2Before.actual.states.find(row => row.document_id === target.documentId), d1ArchivedFacts.actual.states[0]);
      assert.equal(d2Before.actual.physical.bytesSha256, hash(d2Bytes));
      phaseAt('actual same Store historical resume with D2 present, no replan or new original data'); const historicalClaim = await resume();
      const domainTables = ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages', 'collaboration_file_projections',
        'collaboration_native_link_mutation_receipts', 'workspace_trash_entries', 'workspace_file_metadata', 'workspace_file_user_states',
        'public_file_shares', 'file_guest_invitations', 'workspace_file_operation_delete_intents', 'workspace_file_operation_delete_trash_receipts', 'workspace_file_operation_delete_receipts'];
      const historicalWrites: Array<{ operation: string; table: string }> = [];
      const recovered = await h.withProbe(async event => {
        const mutation = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+((?:"[^"]+"\.)?"?([a-z_]+)"?)/iu.exec(event.text);
        if (mutation && domainTables.includes(mutation[3])) historicalWrites.push({ operation: mutation[1], table: mutation[3] });
      }, () => invoke(historicalClaim));
      assert.deepEqual(historicalWrites, []); assert.deepEqual(recovered, completion);
      assert.deepEqual(await ledger(), ledgerCompleted); assert.deepEqual(await batchIdentity(), originalBatchIdentity);
      assert.deepEqual(await currentTargetFacts(), d2Before); assert.deepEqual(await sourceFacts(), sourceBeforeHistorical);
      assert.deepEqual(await physical(path.join(h.dataRoot, trash.trash_relative_path)), payload);
      assert.deepEqual((await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_trash_entries WHERE id=$1', [trash.id])).rows[0], trash);
      assert.deepEqual((await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_native_link_mutation_receipts WHERE operation_id=$1', [linkReceipt.operationId])).rows, mutationRows);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_trash_entries WHERE workspace_id=$1 AND original_path=$2', [h.source.workspaceId, targetPath])).rows[0].n, 1);
      assert.deepEqual(await untouched(h, keepPath, h.source), keepBefore); assert.deepEqual(await untouched(h, WORKSPACE_STARTER_DOCUMENT_NAME, h.source), starterBefore);
      assert.deepEqual(await untouched(h, WORKSPACE_STARTER_DOCUMENT_NAME, h.destination), neighborBefore);
      const final = await store.get(batchId); assert(final); assert.equal(final.status, 'applied'); assert.equal(final.phase, 'complete');
      assert.equal(final.completedActions, final.totalActions); assert.equal(final.totalActions, 2); assert.deepEqual(final.trashEntryIds, [completion.trashEntryId]);
      facts.result = { passed: true, originalPlanId: plan.planId, intentDigest: originalRow.intent_digest, receiptDigest: completion.receiptDigest,
        immutableOriginalRetained: true, completedActions: final.completedActions, nativeLinkReceiptCount: mutationRows.length,
        historicalDomainWrites: historicalWrites.length, originalDocumentId: target.documentId, laterDocumentId: d2.documentId,
        laterDocumentUnchanged: true, originalArchived: true, trashPayloadRetained: true, nativeLinkUpdateCount: 1 };
      facts.passed = true; phaseAt('all declared domain assertions complete'); await record();
      console.log(JSON.stringify({ suite: facts.suite, domainPassed: true, originalPlanRetained: true,
        b1AckLost: true, pendingBeforeAndAfterClaimLoss: true, recoveryB2AckLost: true, laterDocumentUnchanged: true, batchId }));
    });
  } catch (error) {
    facts.passed = false; facts.firstFailure = { phase, error: errorFacts(error) };
    if (!recorded) await record(); else await write('terminal-failure', { firstFailure: facts.firstFailure, actualChildMustFail: true });
    throw error;
  } finally { const sourceAfter = await pins(); await write('source-after', sourceAfter); assert.deepEqual(sourceAfter, sourceBefore); }
  console.log(JSON.stringify({ suite: facts.suite, passed: true, closureRequiredAndReturned: true, elapsedMs: Math.round(performance.now() - started) }));
}
let mainCompleted = false;
process.once('beforeExit', () => { if (!mainCompleted) process.exitCode = 1; });
void main().then(() => { mainCompleted = true; }).catch(error => {
  console.error(JSON.stringify({ suite: 'workspace-operation-original-delete-recreate-postgres', passed: false, error: errorFacts(error) })); process.exitCode = 1;
});
