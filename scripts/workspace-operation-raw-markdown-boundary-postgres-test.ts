import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Genuine PG18/Auth/import/FS fixture. No mocked source, principal, planner,
// SQL result or owner is supplied. This first M1 case is deliberately narrower
// than selected raw Markdown, raw incoming links or mutation/recovery support.
type Fixture = Parameters<Parameters<typeof withNativeCopyMetadataOwnerFixture>[0]>[0];
type Row = Record<string, unknown>;
type Selection = Readonly<{ sourcePath: string; copyPath: string; movePath: string }>;
let phase = 'setup', finished = false;
process.once('beforeExit', () => { if (!finished) process.exitCode = 1; });

async function snapshotRawMarkdownBoundary(h: Fixture) {
  const tables: Row[] = [], rows: Record<string, unknown> = {}, files: Row[] = [];
  let transaction = false, rowBytes = 0, fileBytes = 0;
  try {
    await h.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    const identity = (await h.admin.query(`SELECT current_schema() AS schema,
      pg_catalog.to_regnamespace(current_schema())::oid::text AS oid,
      current_setting('transaction_read_only') AS read_only,
      current_setting('transaction_isolation') AS isolation,
      pg_current_xact_id_if_assigned() IS NULL AS unassigned`)).rows[0];
    assert.equal(identity.schema, h.schema); assert.equal(identity.oid, h.schemaOid);
    assert.equal(identity.read_only, 'on'); assert.equal(identity.isolation, 'repeatable read'); assert.equal(identity.unassigned, true);
    tables.push(...(await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'
      AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)'
        OR c.relname IN ('file_revisions','file_revision_contents','file_version_blobs','workspace_trash_entries'))
      ORDER BY c.relname LIMIT 513`, [h.schema])).rows);
    assert(tables.length > 15 && tables.length <= 512);
    const prefix = `"${h.schema.replaceAll('"', '""')}"`;
    for (const table of tables) {
      assert(typeof table.relname === 'string' && /^[a-z][a-z0-9_]{0,100}$/u.test(table.relname));
      const values = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin
        FROM ${prefix}."${table.relname}" t ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
      assert(values.length <= 10000);
      for (const value of values) {
        assert(typeof value.body === 'string' && typeof value.xmin === 'string');
        const bytes = Buffer.byteLength(value.body); assert(bytes <= 8 * 1024 * 1024);
        rowBytes += bytes; assert(rowBytes <= 128 * 1024 * 1024);
      }
      rows[table.relname] = values;
    }
    assert.equal((await h.admin.query('SELECT pg_current_xact_id_if_assigned() IS NULL AS unassigned')).rows[0].unassigned, true);
    await h.admin.query('COMMIT'); transaction = false;
  } catch (error) {
    if (transaction) try { await h.admin.query('ROLLBACK'); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Raw Markdown snapshot rollback failed.'); }
    throw error;
  }
  assert.equal(await fs.realpath(h.dataRoot), h.dataRoot);
  const pending = ['.'];
  for (let index = 0; index < pending.length; index++) {
    assert(files.length < 10000);
    const relative = pending[index], full = path.join(h.dataRoot, relative);
    assert(full === h.dataRoot || full.startsWith(h.dataRoot + path.sep));
    const stat = await fs.lstat(full, { bigint: true }); assert(!stat.isSymbolicLink());
    const item: Row = { path: relative, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
      uid: String(stat.uid), nlink: String(stat.nlink), size: String(stat.size),
      mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
    if (stat.isDirectory()) {
      const names = (await fs.readdir(full)).sort();
      assert(files.length + pending.length - index - 1 + names.length < 10000);
      pending.push(...names.map(name => path.join(relative, name)));
      const after = await fs.lstat(full, { bigint: true });
      for (const key of ['dev','ino','mode','uid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(after[key], stat[key]);
    } else {
      assert(stat.isFile() && stat.nlink === BigInt(1) && stat.size <= BigInt(8 * 1024 * 1024));
      const handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat({ bigint: true });
        for (const key of ['dev','ino','mode','uid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(opened[key], stat[key]);
        const bytes = await handle.readFile(); assert.equal(BigInt(bytes.length), stat.size);
        fileBytes += bytes.length; assert(fileBytes <= 128 * 1024 * 1024);
        item.sha256 = createHash('sha256').update(bytes).digest('hex');
        for (const after of [await handle.stat({ bigint: true }), await fs.lstat(full, { bigint: true })]) {
          for (const key of ['dev','ino','mode','uid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(after[key], stat[key]);
        }
      } finally { await handle.close(); }
    }
    files.push(item);
  }
  return { tables, rows, files };
}

async function assertNativeActionsWithUnselectedRawMarkdown(h: Fixture, selection: Selection, label: 'baseline' | 'unselected-raw') {
  const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
  const { previewWorkspaceNativeCopyOperation } = await import('../app/lib/files/workspace-operation-native-copy-owner');
  const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
  const { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } = await import('../app/lib/workspaces/request-principal');
  const { openDb } = await import('../app/lib/db');
  const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
  const failures: unknown[] = [], results: Array<{ kind: string; ready: boolean; errorCode: string | null;
    noWrite: { noDmlDdlOrNotify: boolean; afterSnapshotCompleted: boolean; tableCensusUnchanged: boolean;
      domainRowsAndXminsUnchanged: boolean; completeDataTreeUnchanged: boolean } }> = [];
  for (const kind of ['copy', 'move', 'delete'] as const) {
    phase = `${label}/${kind}`;
    const before = await snapshotRawMarkdownBoundary(h);
    const writes: string[] = []; let statements = 0, ready = false, errorCode: string | null = null;
    const noWrite = { noDmlDdlOrNotify: false, afterSnapshotCompleted: false, tableCensusUnchanged: false,
      domainRowsAndXminsUnchanged: false, completeDataTreeUnchanged: false };
    try {
      await h.withProbe(async event => {
        assert(++statements <= 5000);
        if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)
          || /\bpg_notify\s*\(/iu.test(event.text)) writes.push(event.text);
      }, async () => {
        if (kind === 'copy') {
          assert(h.source.permissions.canRead && !h.source.permissions.canWrite && h.destination.permissions.canWrite);
          const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-member' },
            sourceWorkspace: h.source, destinationWorkspace: h.destination });
          const plan = await previewWorkspaceNativeCopyOperation({ origin, request: await h.request(h.source, 'member', true),
            selections: [{ sourcePath: selection.sourcePath, destinationPath: selection.copyPath }] });
          assert.equal(plan.version, 3); assert.equal(plan.executionReady, false);
          assert.equal(plan.readiness, 'requires-provider-publication');
          assert.equal(plan.selections.length, 1); assert.equal(plan.selections[0].sourcePath, selection.sourcePath);
        } else {
          // Genuine owner Cookie -> opaque request principal -> same-B current
          // rights. The stale read-only fixture DTO is never edited into a grant.
          const scope = await withWorkspaceRequestPrincipal(await h.request(h.source, 'owner', true),
            { workspaceId: h.source.workspaceId, permission: 'canWrite' }, async principal => {
              const database = await openDb(); let began = false, committed = false;
              try {
                await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
                await database.get('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(h.source.workspaceId)]);
                const current = await withWorkspaceRequestPrincipalOnConnection(database, principal, async access => {
                  assert.equal(access.userId, 'owner'); assert.equal(access.sessionId, 'session-owner');
                  assert.equal(access.workspace.workspaceId, h.source.workspaceId);
                  assert(access.workspace.permissions.canRead && access.workspace.permissions.canWrite && access.workspace.permissions.canDelete);
                  await access.assertCurrent();
                  return { workspace: access.workspace, fileOptions: { workspace: access.workspace } } satisfies WorkspaceOperationBatchScope;
                });
                await database.run('COMMIT'); committed = true; return current;
              } catch (error) {
                if (began && !committed) try { await database.run('ROLLBACK'); }
                catch (cleanup) { throw new AggregateError([error, cleanup], 'Raw Markdown request-principal rollback failed.'); }
                throw error;
              } finally { await database.close(committed ? undefined : new Error('Discarding failed actual raw Markdown principal phase.')); }
            });
          const plan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: `m1-unselected-${kind}`, kind,
            selections: kind === 'move' ? [{ sourcePath: selection.sourcePath, destinationPath: selection.movePath }]
              : [{ sourcePath: selection.sourcePath }] }] });
          assert.equal(plan.version, kind === 'move' ? 3 : 2); assert.equal(plan.readiness, 'ready'); assert.equal(plan.issues.length, 0);
        }
        ready = true;
      });
    } catch (error) {
      const code: unknown = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      errorCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ? code : null;
      failures.push(error);
    } finally {
      // Always run every oracle after a rejected preview, then continue to the
      // other operations. Expected-ready failures never skip the NoWrite proof.
      try { assert(statements > 0); assert.deepEqual(writes, [], 'Preview must issue no actual DML/DDL/NOTIFY.'); noWrite.noDmlDdlOrNotify = true; }
      catch (error) { failures.push(error); }
      let after: Awaited<ReturnType<typeof snapshotRawMarkdownBoundary>> | undefined;
      try {
        after = await snapshotRawMarkdownBoundary(h); noWrite.afterSnapshotCompleted = true;
      } catch (error) { failures.push(error); }
      if (after) {
        try { assert.deepEqual(after.tables, before.tables, 'Preview changed the complete domain table/OID census.'); noWrite.tableCensusUnchanged = true; }
        catch (error) { failures.push(error); }
        try { assert.deepEqual(after.rows, before.rows, 'Preview changed domain rows or xmin.'); noWrite.domainRowsAndXminsUnchanged = true; }
        catch (error) { failures.push(error); }
        try { assert.deepEqual(after.files, before.files, 'Preview changed the complete owned DATA tree, identities or bytes.'); noWrite.completeDataTreeUnchanged = true; }
        catch (error) { failures.push(error); }
      }
      results.push({ kind, ready, errorCode, noWrite });
      console.log(JSON.stringify({ fixture: 'm1-unselected-raw-markdown', phase: label, kind, ready, errorCode,
        actualStatements: statements, actualWriterStatements: writes.length, noWrite }));
    }
  }
  try { assert.deepEqual(results.map(result => [result.kind, result.ready]), [['copy', true], ['move', true], ['delete', true]],
    'An unrelated completely inspected zero-link raw Markdown file must not block native operations.'); }
  catch (error) { failures.push(error); }
  console.log(JSON.stringify({ fixture: 'm1-unselected-raw-markdown', phase: label, actualAttempts: results.length,
    allNativeReadinessExpectationsPassed: results.length === 3 && results.every(result => result.ready),
    allNoWriteOraclesPassed: results.length === 3 && results.every(result => Object.values(result.noWrite).every(Boolean)), results }));
  if (failures.length) throw new AggregateError(failures, `M1 ${label}: genuine native readiness or NoWrite oracle failed.`);
}

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  await withNativeCopyMetadataOwnerFixture(async h => {
    const selection = { sourcePath: 'm1-native-target.md', copyPath: 'm1-native-clone.md', movePath: 'm1-native-moved.md' };
    const target = await h.upload(selection.sourcePath, Buffer.from('# Native M1 target\n\nPreserve exact native content.\n'));
    await h.upload('m1-native-keep.md', Buffer.from('# Independent native Keep\n\nPreserve.\n'));
    await h.upload('m1-native-incoming.md', Buffer.from(`[Target](${selection.sourcePath}) and [Keep](m1-native-keep.md).\n`));
    const { stageWorkspaceLinkSourceAuthorityObservation } = await import('../app/lib/markdown/workspace-source-authority-stage');
    const original = await stageWorkspaceLinkSourceAuthorityObservation(h.source);
    assert.equal(original.stage.coverage.complete, true); assert.equal(original.stage.readiness, 'native-coordinator-required');
    assert(original.nativeBindings.some(binding => binding.expected.documentId === target.documentId && binding.expected.path === selection.sourcePath));
    await assertNativeActionsWithUnselectedRawMarkdown(h, selection, 'baseline');
    phase = 'unselected raw source setup';
    const rawPath = 'm1-unselected-raw.md', rawFile = path.join(h.source.rootPath, rawPath);
    const bytes = Buffer.from('# Unselected raw Markdown\n\nIndependent text without links. äöü 😀\n');
    await assert.rejects(fs.lstat(rawFile), { code: 'ENOENT' });
    await fs.writeFile(rawFile, bytes, { flag: 'wx', mode: 0o600 });
    const before = await snapshotRawMarkdownBoundary(h);
    try {
      const observation = await stageWorkspaceLinkSourceAuthorityObservation(h.source);
      assert.equal(observation.stage.coverage.complete, true); assert.deepEqual(observation.stage.coverage.gaps, []);
      const physical = observation.stage.sources.filter(source => source.kind === 'physical' && source.inventory.path === rawPath);
      assert.equal(physical.length, 1); assert(physical[0].kind === 'physical');
      assert.equal(physical[0].inventory.authority.kind, 'unregistered');
      assert.equal(physical[0].inventory.coverage.complete, true); assert.deepEqual(physical[0].inventory.links, []);
      assert.equal(physical[0].inventory.physical.byteHash, createHash('sha256').update(bytes).digest('hex'));
      assert.deepEqual(Buffer.from(physical[0].inventory.originalBytes), bytes);
      assert.equal(observation.nativeBindings.some(binding => binding.expected.path === rawPath), false);
      assert.equal(observation.privateNativeStates.some(state => state.path === rawPath), false);
      assert(observation.nativeBindings.some(binding => binding.expected.documentId === target.documentId));
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
        [h.source.workspaceId, rawPath])).rows[0].n, 0);
      // Exercise the new pure foundation using this actual PG/FS observation.
      // It supplies no operation authority and does not replace the genuine
      // public-owner readiness expectations that remain below.
      const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
      const { captureWorkspaceOperationNativeSourceEvidenceV3 } = await import('../app/lib/files/workspace-operation-native-source-evidence-v3');
      const { workspaceOperationMixedSourceSnapshot } = await import('../app/lib/files/workspace-operation-mixed-source-evidence');
      const { createWorkspaceMixedReadFileOperationPlanV3 } = await import('../app/lib/markdown/workspace-native-file-operation-planner');
      const { compileWorkspaceMixedReadBatchV3 } = await import('../app/lib/markdown/workspace-native-mixed-batch-compiler');
      const sourceEvidence = captureWorkspaceOperationNativeSourceEvidenceV3(captureWorkspaceOperationJobScope(h.source), observation);
      const destination = await stageWorkspaceLinkSourceAuthorityObservation(h.destination);
      const destinationEvidence = captureWorkspaceOperationNativeSourceEvidenceV3(captureWorkspaceOperationJobScope(h.destination), destination);
      const sourceSnapshot = workspaceOperationMixedSourceSnapshot(sourceEvidence), destinationSnapshot = workspaceOperationMixedSourceSnapshot(destinationEvidence);
      assert.deepEqual(sourceSnapshot.namespace, observation.stage.namespace);
      const foundation: Array<{ kind: string; pathPlanReady: boolean; compilerReadiness: string }> = [];
      for (const kind of ['copy', 'move', 'delete'] as const) {
        const request = { kind, sourceWorkspaceId: h.source.workspaceId,
          destinationWorkspaceId: kind === 'copy' ? h.destination.workspaceId : h.source.workspaceId,
          selections: [{ sourcePath: selection.sourcePath, ...(kind === 'copy' ? { destinationPath: selection.copyPath }
            : kind === 'move' ? { destinationPath: selection.movePath } : {}) }] };
        const snapshots = kind === 'copy' ? [sourceSnapshot, destinationSnapshot] : [sourceSnapshot];
        const plan = createWorkspaceMixedReadFileOperationPlanV3({ ...request, snapshots });
        assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues));
        assert(plan.mutations.every(recipe => recipe.source.path !== rawPath));
        const states = kind === 'copy' ? [...observation.privateNativeStates, ...destination.privateNativeStates] : observation.privateNativeStates;
        const compiled = compileWorkspaceMixedReadBatchV3({ snapshots, states, requests: [request] });
        assert.equal(compiled.readiness, kind === 'copy' ? 'requires-clone-rebinding' : 'ready', JSON.stringify(compiled.issues));
        const retainedRaw = compiled.finalNamespace.find(entry => entry.workspaceId === h.source.workspaceId && entry.path === rawPath); assert(retainedRaw);
        assert.equal(retainedRaw.physicalReadSource?.physicalSourceProof, physical[0].inventory.physicalSourceProof);
        assert.equal(retainedRaw.binding.kind === 'existing' && retainedRaw.binding.documentEvidenceKey, null);
        foundation.push({ kind, pathPlanReady: true, compilerReadiness: compiled.readiness });
      }
      console.log(JSON.stringify({ fixture: 'm1-unselected-raw-foundation', actualCollector: true,
        sourceReadOnly: !h.source.permissions.canWrite, evidenceVersion: sourceEvidence.evidenceVersion,
        fullPhysicalEvidenceRetained: true, foundation }));
    } finally {
      assert.deepEqual(await snapshotRawMarkdownBoundary(h), before, 'The actual source collector must preserve all domain rows/xmins and DATA.');
    }
    await assertNativeActionsWithUnselectedRawMarkdown(h, selection, 'unselected-raw');
    console.log('M1 unselected zero-link raw Markdown: all three native readiness expectations and complete NoWrite oracles passed.');
  });
  finished = true;
}

main().catch(error => {
  console.error(JSON.stringify({ fixture: 'm1-unselected-raw-markdown', phase, passed: false,
    name: error instanceof Error ? error.name : 'unknown',
    causes: error instanceof AggregateError ? error.errors.slice(0, 16).map(value => ({
      name: value instanceof Error ? value.name : 'unknown',
      code: value && typeof value === 'object' && typeof Object.getOwnPropertyDescriptor(value, 'code')?.value === 'string'
        && /^[A-Z][A-Z0-9_]{0,127}$/u.test(Object.getOwnPropertyDescriptor(value, 'code')!.value)
        ? Object.getOwnPropertyDescriptor(value, 'code')!.value : null,
    })) : [] }));
  process.exitCode = 1;
});
