import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Actual explicit preparation: four no-write dispatch boundaries, two genuine
// original imports, then four fully fresh native plans. This does not claim UI,
// MCP preparation, action execution or operation-owned automatic import.
type Fixture = Parameters<Parameters<typeof withNativeCopyMetadataOwnerFixture>[0]>[0];
type Row = Record<string, unknown>;
type BoundaryCase = Readonly<{ name: 'raw-delete-native-incoming' | 'raw-move' | 'native-move-raw-incoming' | 'native-delete-raw-incoming';
  kind: 'move' | 'delete'; sourcePath: string; destinationPath?: string; expectedVersion: 2 | 3 }>;
type DiagnosticIssue = Readonly<{ code: string; path: string; workspaceId?: string; requestIndex?: number | null }>;
type ErrorFacts = Readonly<{ name: string; code: string | null }>;
let phase = 'fixture', complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });

function errorFacts(error: unknown): ErrorFacts {
  const code = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value as unknown : undefined;
  return { name: error instanceof Error ? error.name : 'UnknownError',
    code: typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(code) ? code : null };
}

/** Independent real read-only/unassigned-XID snapshots and O_NOFOLLOW FD reads.
 * No admin setup or source seeding takes place inside an attempt's probes. */
async function selectedRawBoundarySnapshot(h: Fixture) {
  const tables: Row[] = [], rows: Record<string, unknown> = {}, files: Row[] = [];
  let transaction = false, rowBytes = 0, fileBytes = 0;
  try {
    await h.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    const identity = (await h.admin.query(`SELECT current_schema() AS schema,
      pg_catalog.to_regnamespace(current_schema())::oid::text AS oid,
      current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,
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
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Selected raw snapshot rollback failed.'); }
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
      uid: String(stat.uid), gid: String(stat.gid), nlink: String(stat.nlink), size: String(stat.size),
      mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
    if (stat.isDirectory()) {
      const names = (await fs.readdir(full)).sort();
      assert(files.length + pending.length - index - 1 + names.length < 10000);
      pending.push(...names.map(name => path.join(relative, name)));
      const after = await fs.lstat(full, { bigint: true });
      for (const key of ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(after[key], stat[key]);
    } else {
      assert(stat.isFile() && stat.nlink === BigInt(1) && stat.size <= BigInt(8 * 1024 * 1024));
      const handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat({ bigint: true });
        for (const key of ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(opened[key], stat[key]);
        const bytes = await handle.readFile(); assert.equal(BigInt(bytes.length), stat.size);
        fileBytes += bytes.length; assert(fileBytes <= 128 * 1024 * 1024);
        item.sha256 = createHash('sha256').update(bytes).digest('hex');
        for (const after of [await handle.stat({ bigint: true }), await fs.lstat(full, { bigint: true })]) {
          for (const key of ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'] as const) assert.equal(after[key], stat[key]);
        }
      } finally { await handle.close(); }
    }
    files.push(item);
  }
  return { tables, rows, files };
}

export async function workspaceOperationRawPathImportPreparationPostgresTest(): Promise<void> {
  const previousBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    const { buildWorkspacePathOperationPlan } = await import('../app/lib/files/workspace-path-operation-service');
    const { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } = await import('../app/lib/workspaces/request-principal');
    const { openDb } = await import('../app/lib/db');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { stageWorkspaceLinkSourceAuthorityObservation } = await import('../app/lib/markdown/workspace-source-authority-stage');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { captureWorkspaceOperationNativeSourceEvidenceV3 } = await import('../app/lib/files/workspace-operation-native-source-evidence-v3');
    const { workspaceOperationMixedSourceSnapshot } = await import('../app/lib/files/workspace-operation-mixed-source-evidence');
    const { createWorkspaceMixedReadFileOperationPlanV3 } = await import('../app/lib/markdown/workspace-native-file-operation-planner');
    const { compileWorkspaceMixedReadBatchV3 } = await import('../app/lib/markdown/workspace-native-mixed-batch-compiler');
    const { buildWorkspaceMixedReadLinkGraphV3 } = await import('../app/lib/markdown/workspace-native-link-graph');
    assert(h.source.permissions.canRead && !h.source.permissions.canWrite); // never upgraded into a DTO grant

    // Actual fixture setup only. No direct native SQL rows, fabricated state or
    // caller-built authority replace the authenticated upload initializer.
    const rawPath = 'selected-raw-original.md', nativePath = 'selected-native-original.md';
    const nativeIncomingPath = 'selected-native-incoming.md', rawIncomingPath = 'selected-raw-incoming.md';
    const rawBytes = Buffer.from('# Selected original raw\n\nUTF-8: Ä Ω 🙂.\n');
    await fs.writeFile(path.join(h.source.rootPath, rawPath), rawBytes, { flag: 'wx', mode: 0o600 });
    const native = await h.upload(nativePath, Buffer.from('# Selected native target\n\nKeep native identity.\n'));
    const incoming = await h.upload(nativeIncomingPath, Buffer.from(`[Raw target](${rawPath}).\n`));
    const rawIncomingBytes = Buffer.from(`[Native target](${nativePath}).\n`);
    await fs.writeFile(path.join(h.source.rootPath, rawIncomingPath), rawIncomingBytes, { flag: 'wx', mode: 0o600 });
    for (const filePath of [rawPath, rawIncomingPath]) {
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
        [h.source.workspaceId, filePath])).rows[0].n, 0);
    }
    const setup = await stageWorkspaceLinkSourceAuthorityObservation(h.source);
    assert.equal(setup.stage.coverage.complete, true); assert.deepEqual(setup.stage.coverage.gaps, []);
    assert(setup.nativeBindings.some(binding => binding.expected.documentId === native.documentId));
    assert(setup.nativeBindings.some(binding => binding.expected.documentId === incoming.documentId));
    for (const [filePath, bytes] of [[rawPath, rawBytes], [rawIncomingPath, rawIncomingBytes]] as const) {
      const source = setup.stage.sources.find(source => source.kind === 'physical' && source.inventory.path === filePath);
      assert(source?.kind === 'physical'); assert.equal(source.inventory.authority.kind, 'unregistered');
      assert.equal(source.inventory.coverage.complete, true); assert.deepEqual(Buffer.from(source.inventory.originalBytes), bytes);
      assert.equal(source.inventory.physical.byteHash, createHash('sha256').update(bytes).digest('hex'));
    }
    const graph = buildWorkspaceMixedReadLinkGraphV3(workspaceOperationMixedSourceSnapshot(
      captureWorkspaceOperationNativeSourceEvidenceV3(captureWorkspaceOperationJobScope(h.source), setup)));
    assert(graph.edges.some(edge => edge.sourceKind === 'native' && edge.source.path === nativeIncomingPath
      && edge.resolution.status === 'resolved' && edge.resolution.target?.path === rawPath));
    assert(graph.edges.some(edge => edge.sourceKind === 'physical-read' && edge.source.path === rawIncomingPath
      && edge.resolution.status === 'resolved' && edge.resolution.target?.path === nativePath));
    const actualRequest = await h.request(h.source, 'owner', true);
    const cases: BoundaryCase[] = [
      { name: 'raw-delete-native-incoming', kind: 'delete', sourcePath: rawPath, expectedVersion: 2 },
      { name: 'raw-move', kind: 'move', sourcePath: rawPath, destinationPath: 'selected-raw-moved.md', expectedVersion: 3 },
      { name: 'native-move-raw-incoming', kind: 'move', sourcePath: nativePath, destinationPath: 'selected-native-moved.md', expectedVersion: 3 },
      { name: 'native-delete-raw-incoming', kind: 'delete', sourcePath: nativePath, expectedVersion: 2 },
    ];
    const results: Array<Record<string, unknown>> = [], failures: unknown[] = [];
    for (const round of ['before-import', 'after-import'] as const) {
      if (round === 'after-import') {
        phase = 'actual explicit owner-authorized original imports';
        const { persistExplicitOriginalMarkdownFileForWrite } = await import('../app/lib/collaboration/markdown-file-import-persistence');
        const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
        for (const filePath of [rawPath, rawIncomingPath]) {
          const original = setup.stage.sources.find(source => source.kind === 'physical' && source.inventory.path === filePath);
          assert(original?.kind === 'physical');
          const bytes = await fs.readFile(path.join(h.source.rootPath, filePath));
          const fileVersion = filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, filePath)));
          assert.equal(fileVersion, original.inventory.physical.filesystemIdentity);
          const imported = await persistExplicitOriginalMarkdownFileForWrite(actualRequest, {
            apiVersion: 1, workspaceId: h.source.workspaceId, path: filePath,
            operationId: `path_import_${randomUUID().replaceAll('-', '')}`, expectedFileVersion: fileVersion,
          });
          assert.equal(imported.disposition, 'applied');
          assert.equal(imported.receipt.target.workspaceId, h.source.workspaceId);
          assert.equal(imported.receipt.target.path, filePath);
          assert.equal(imported.receipt.sourceHash, original.inventory.physical.byteHash);
          assert.equal(imported.receipt.sourceBytes, bytes.length);
          assert.equal(filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, filePath))), fileVersion);
          assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, filePath)), bytes);
          const registered = (await h.admin.query(`SELECT d.id,d.lineage_id,s.document_sequence FROM collaboration_documents d
            JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.workspace_id=$1 AND d.path=$2`,
          [h.source.workspaceId, filePath])).rows;
          assert.equal(registered.length, 1); assert.equal(registered[0].id, imported.receipt.target.documentId);
          assert.equal(registered[0].lineage_id, imported.receipt.target.lineageId); assert.equal(Number(registered[0].document_sequence), 0);
        }
      }
      for (const selected of cases) {
      phase = `${round}/${selected.name}`;
      const noWrite = { beforeSnapshotCompleted: false, noDmlDdlOrNotify: false, afterSnapshotCompleted: false,
        tableCensusUnchanged: false, domainRowsAndXminsUnchanged: false, completeDataTreeUnchanged: false };
      let before: Awaited<ReturnType<typeof selectedRawBoundarySnapshot>> | undefined;
      try { before = await selectedRawBoundarySnapshot(h); noWrite.beforeSnapshotCompleted = true; }
      catch (error) { failures.push(error); }
      const writes: string[] = []; let statements = 0, currentRightsVerified = false;
      const observedPublic: { plan?: WorkspaceOperationBatchPlan; error: ErrorFacts | null; failure?: unknown } = { error: null };
      const diagnosticFacts: { value: { plannerReadiness: string; plannerIssues: DiagnosticIssue[];
        compilerReadiness: string; compilerIssues: DiagnosticIssue[] } | null } = { value: null };
      let diagnosticError: ErrorFacts | null = null, diagnosticFailure: unknown;
      // The real Cookie was created in setup. Every new actual principal,
      // public plan and diagnostic SQL statement below is then observed.
      try {
        await h.withProbe(async event => {
          assert(++statements <= 5000);
          if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)
            || /\bpg_notify\s*\(/iu.test(event.text)) writes.push(event.text);
        }, () => withWorkspaceRequestPrincipal(actualRequest, { workspaceId: h.source.workspaceId, permission: 'canWrite' }, async principal => {
          const database = await openDb(); let begun = false, committed = false;
          try {
            await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
            await database.get('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(h.source.workspaceId)]);
            await withWorkspaceRequestPrincipalOnConnection(database, principal, async access => {
              assert.equal(access.userId, 'owner'); assert.equal(access.sessionId, 'session-owner');
              assert.equal(access.workspace.workspaceId, h.source.workspaceId);
              assert(access.workspace.permissions.canRead && access.workspace.permissions.canWrite && access.workspace.permissions.canDelete);
              await access.assertCurrent();
              const scope = { workspace: access.workspace, fileOptions: { workspace: access.workspace } } satisfies WorkspaceOperationBatchScope;
              const selections = [{ sourcePath: selected.sourcePath,
                ...(selected.destinationPath === undefined ? {} : { destinationPath: selected.destinationPath }) }];
              // The same genuine public dispatch as direct Web file actions.
              // Capture rejection now; every NoWrite oracle still runs later.
              try { observedPublic.plan = await buildWorkspacePathOperationPlan({ scope, kind: selected.kind, selections }); }
              catch (error) { observedPublic.error = errorFacts(error); observedPublic.failure = error; }
              // Separate facts-only diagnosis: no mock and no alternative ready
              // result. It explains concrete imports hidden by public errors.
              try {
                const observed = await stageWorkspaceLinkSourceAuthorityObservation(access.workspace);
                const snapshot = workspaceOperationMixedSourceSnapshot(captureWorkspaceOperationNativeSourceEvidenceV3(
                  captureWorkspaceOperationJobScope(access.workspace), observed));
                const request = { kind: selected.kind, sourceWorkspaceId: access.workspace.workspaceId,
                  destinationWorkspaceId: access.workspace.workspaceId, selections };
                const planned = createWorkspaceMixedReadFileOperationPlanV3({ ...request, snapshots: [snapshot] });
                const compiled = compileWorkspaceMixedReadBatchV3({ snapshots: [snapshot], states: observed.privateNativeStates, requests: [request] });
                const issues = (rows: readonly { code: string; path: string; workspaceId?: string; requestIndex?: number | null }[]) =>
                  rows.map(({ code, path: filePath, workspaceId, requestIndex }) => ({ code, path: filePath,
                    ...(workspaceId === undefined ? {} : { workspaceId }), ...(requestIndex === undefined ? {} : { requestIndex }) }));
                diagnosticFacts.value = { plannerReadiness: planned.readiness, plannerIssues: issues(planned.issues),
                  compilerReadiness: compiled.readiness, compilerIssues: issues(compiled.issues) };
              } catch (error) { diagnosticError = errorFacts(error); diagnosticFailure = error; }
              await access.assertCurrent(); currentRightsVerified = true;
            });
            await database.run('COMMIT'); committed = true;
          } catch (error) {
            if (begun && !committed) try { await database.run('ROLLBACK'); }
            catch (cleanup) { throw new AggregateError([error, cleanup], 'Selected raw principal rollback failed.'); }
            throw error;
          } finally { await database.close(committed ? undefined : new Error('Discarding failed selected raw principal phase.')); }
        }));
      } catch (error) { failures.push(error); if (!observedPublic.error && !observedPublic.plan) {
        observedPublic.error = errorFacts(error); observedPublic.failure = error;
      } }
      finally {
        // Independent checks never short-circuit the next oracle or case.
        try { assert(statements > 0); assert.deepEqual(writes, []); noWrite.noDmlDdlOrNotify = true; }
        catch (error) { failures.push(error); }
        let after: Awaited<ReturnType<typeof selectedRawBoundarySnapshot>> | undefined;
        try { after = await selectedRawBoundarySnapshot(h); noWrite.afterSnapshotCompleted = true; }
        catch (error) { failures.push(error); }
        if (before && after) {
          try { assert.deepEqual(after.tables, before.tables); noWrite.tableCensusUnchanged = true; }
          catch (error) { failures.push(error); }
          try { assert.deepEqual(after.rows, before.rows); noWrite.domainRowsAndXminsUnchanged = true; }
          catch (error) { failures.push(error); }
          try { assert.deepEqual(after.files, before.files); noWrite.completeDataTreeUnchanged = true; }
          catch (error) { failures.push(error); }
        }
      }
      const publicPlan = observedPublic.plan, publicError = observedPublic.error;
      const ready = publicPlan?.readiness === 'ready';
      const legacyRawDeleteDispatch = selected.name === 'raw-delete-native-incoming' && ready && publicPlan?.version === 1;
      const planSummary = publicPlan ? { version: publicPlan.version, readiness: publicPlan.readiness,
        planId: publicPlan.planId, issues: publicPlan.issues.map(({ code, path: filePath }) => ({ code, path: filePath })),
        linkEdits: publicPlan.linkEdits.map(edit => ({ sourcePathBefore: edit.sourcePathBefore, sourcePathAfter: edit.sourcePathAfter,
          changeKind: edit.changeKind })) } : null;
      const result = { round, name: selected.name, kind: selected.kind, sourcePath: selected.sourcePath,
        destinationPath: selected.destinationPath ?? null, expectedNativeVersion: selected.expectedVersion, ready,
        currentRightsVerified, publicPlan: planSummary, publicError, diagnostic: diagnosticFacts.value, diagnosticError,
        legacyRawDeleteDispatch, actualStatements: statements, actualWriterStatements: writes.length, noWrite };
      results.push(result); console.log(JSON.stringify({ suite: 'raw-path-import-preparation', ...result }));
      // Before explicit preparation no executable legacy fallback is allowed.
      // The actual imports above are separate authorized writes, never preview.
      try {
        assert(currentRightsVerified);
        if (round === 'before-import') {
          assert.equal(publicPlan, undefined, 'Raw preparation must precede any executable legacy plan.');
          const expected = selected.sourcePath === rawPath && selected.kind === 'delete' ? 'NATIVE_SOURCE_IMPORT_REQUIRED'
            : selected.kind === 'move' ? 'NATIVE_MOVE_PLAN_UNSUPPORTED' : 'NATIVE_DELETE_PLAN_UNSUPPORTED';
          assert.equal(publicError?.code, expected);
          assert(diagnosticFacts.value?.plannerIssues.some(issue => issue.code === 'physical-source-import-required'));
        } else {
          assert(publicPlan, 'A fully fresh native plan must exist after confirmed explicit imports.');
          assert.equal(publicError, null); assert.equal(publicPlan.readiness, 'ready');
          assert.equal(publicPlan.version, selected.expectedVersion); assert.deepEqual(publicPlan.issues, []);
          assert.equal(diagnosticFacts.value?.plannerReadiness, 'ready'); assert.equal(diagnosticFacts.value?.compilerReadiness, 'ready');
          const incomingPath = selected.sourcePath === rawPath ? nativeIncomingPath : rawIncomingPath;
          if (publicPlan.version === 3) {
            const recipes = publicPlan.nativePathPlan.mutations.filter(value => value.source.path === incomingPath);
            assert.equal(recipes.length, 1); assert.equal(recipes[0].action, 'rewrite');
            assert.equal(recipes[0].nextValue, selected.destinationPath);
            assert.equal(recipes[0].cloneSelection, null); assert.equal(recipes[0].source.workspaceId, h.source.workspaceId);
          } else {
            const evidence = publicPlan.nativeGraphPlan.documentEvidence.find(value => value.inventory.document.path === incomingPath);
            assert(evidence); const link = evidence.inventory.links.find(value => value.targetPathText === selected.sourcePath);
            assert(link); const intent = publicPlan.nativeGraphPlan.steps[0].linkIntents.find(value => value.originEvidenceLinkId === link.id);
            assert(intent); assert.equal(intent.action, 'unlink'); assert.equal(intent.expectedValue, selected.sourcePath);
            assert.equal(intent.nextValue, null);
          }
        }
      } catch (error) { failures.push(error); }
      if (diagnosticError) failures.push(diagnosticFailure ?? Object.assign(new Error('Actual read-only diagnosis failed.'), { facts: diagnosticError }));
    }
    }
    console.log(JSON.stringify({ suite: 'raw-path-import-preparation', fixtureCases: 3, actualImports: 2, actualAttempts: results.length,
      allNoWriteOraclesPassed: results.length === 8 && results.every(result => Object.values(result.noWrite as Record<string, boolean>).every(Boolean)),
      observedLegacyRawDeleteDispatch: results.some(result => result.legacyRawDeleteDispatch), results }));
    assert.equal(results.length, 8);
    if (failures.length) throw new AggregateError(failures, 'Explicit raw import preparation/dispatch or NoWrite boundary failed.');
  }); complete = true;
  } finally { if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase; }
}

workspaceOperationRawPathImportPreparationPostgresTest().catch(error => {
  console.error(JSON.stringify({ suite: 'raw-path-import-preparation', phase, ...errorFacts(error) }));
  process.exitCode = 1;
});
