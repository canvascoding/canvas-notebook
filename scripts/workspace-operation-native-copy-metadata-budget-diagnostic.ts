import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Diagnostic only: the existing fixture retains real migrations, authentication,
// workspace permissions, starter initialization and owned-resource disposal.
// This script neither executes Copy nor claims the 2048-path workflow passed.
const diagnostic = 'native-copy-metadata-budget';
let completedDiagnostic = false;
process.once('beforeExit', () => { if (!completedDiagnostic) process.exitCode = 1; });

function safeCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(code) ? code : null;
}

function errorSummary(error: unknown): Record<string, unknown> {
  const seen = new Set<unknown>(); let remaining = 10;
  const visit = (value: unknown, depth: number): Record<string, unknown> => {
    if (!(value instanceof Error)) return { type: typeof value };
    if (seen.has(value) || depth > 3 || remaining-- <= 0) return { name: 'DiagnosticBound' };
    seen.add(value);
    const name = /^[A-Za-z0-9_$.-]{1,96}$/u.test(value.name) ? value.name : 'Error';
    // Emit file locations only. Error messages, SQL, parameters, function names
    // and the first stack line can contain request/private document data.
    const locations = (value.stack ?? '').split('\n').slice(1).flatMap(line => {
      const match = /((?:file:\/\/)?\/[^()\s]+\.(?:[cm]?js|tsx?)):(\d+):(\d+)/u.exec(line);
      return match ? [{ file: match[1].replace(/^file:\/\//u, ''), line: Number(match[2]), column: Number(match[3]) }] : [];
    }).slice(0, 6);
    const result: Record<string, unknown> = { name, code: safeCode(value), locations };
    const cause = Object.getOwnPropertyDescriptor(value, 'cause');
    if (cause && Object.hasOwn(cause, 'value')) result.cause = visit(cause.value, depth + 1);
    if (value instanceof AggregateError) result.errors = [...value.errors].slice(0, 6).map(child => visit(child, depth + 1));
    return result;
  };
  return visit(error, 0);
}

function queryIdentity(sql: string): { verb: string; sha256: string } {
  const candidate = /^\s*([A-Za-z]+)/u.exec(sql)?.[1].toUpperCase();
  const verb = candidate && ['SELECT', 'WITH', 'BEGIN', 'SET', 'ROLLBACK', 'SHOW'].includes(candidate) ? candidate : 'OTHER';
  return { verb, sha256: crypto.createHash('sha256').update(sql).digest('hex') };
}

async function runNativeCopyMetadataBudgetDiagnostic(): Promise<void> {
  const files = ['scripts/workspace-operation-native-copy-metadata-budget-diagnostic.ts',
    'scripts/helpers/native-copy-metadata-owner-fixture.ts', 'app/lib/files/workspace-operation-native-copy-owner.ts',
    'app/lib/files/workspace-operation-native-copy-plan.ts', 'app/lib/files/workspace-operation-native-source-evidence.ts',
    'app/lib/files/workspace-operation-native-plan-data.ts', 'app/lib/markdown/workspace-source-authority-stage.ts',
    'app/lib/markdown/workspace-native-file-operation-planner.ts', 'app/lib/markdown/workspace-native-mixed-batch-compiler.ts',
    'app/lib/files/workspace-original-file-source.ts', 'app/lib/workspaces/path-guard.ts',
    'app/lib/collaboration/native-inspection-schema.ts'];
  const pins = Object.fromEntries(await Promise.all(files.map(async file => [file,
    crypto.createHash('sha256').update(await readFile(file)).digest('hex')])));
  let previewObserved = false, collectorObserved = false, adminErrorCount = 0;
  let observedAdmin: Client | undefined;
  const adminError = (error: Error): void => {
    adminErrorCount++;
    if (adminErrorCount <= 12) console.log(JSON.stringify({ diagnostic, phase: 'fixture-admin-error-event',
      eventIndex: adminErrorCount, error: errorSummary(error) }));
  };
  try {
    await withNativeCopyMetadataOwnerFixture(async h => {
      // A transaction timeout can arrive while filesystem work is awaited.
      // Observe the actual Client event without replacing query rejection or
      // removing any existing listener. Keep this listener through admin.end().
      observedAdmin = h.admin;
      observedAdmin.on('error', adminError);
      const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
      const { previewWorkspaceNativeCopyOperation } = await import('../app/lib/files/workspace-operation-native-copy-owner');
      const { readWorkspaceLinkSourceAuthorityOnConnection } = await import('../app/lib/markdown/workspace-source-authority-stage');
      const { withNativeInspectionSchema } = await import('../app/lib/collaboration/native-inspection-schema');
      const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-member' },
        sourceWorkspace: h.source, destinationWorkspace: h.destination });

      // Keep the original source setup as well as the helper's genuine starter
      // initialization in both workspaces. The preceding 12 groups are not run.
      const sourcePath = 'metadata-original.md';
      await h.upload(sourcePath, Buffer.from('\uFEFF---\r\ntitle: YAML title remains content\r\n---\r\n# Actual imported document\r\n'));
      await h.metadata(h.source, sourcePath, { title: 'Shared database title', isFavorite: true, pinned: true });

      // Exact first catalogue and historical SQL title setup from group 13.
      // These explicit stored rows are a format fixture, not a metadata API or
      // permission grant. No data from previous completed Copies is recreated.
      const folder = `budget-${crypto.randomUUID()}-${'x'.repeat(145)}`;
      await mkdir(path.join(h.source.rootPath, folder), { mode: 0o700 });
      const paths = [folder];
      for (let index = 0; index < 2047; index++) {
        const filePath = `${folder}/${String(index).padStart(4, '0')}.bin`;
        await writeFile(path.join(h.source.rootPath, filePath), Buffer.alloc(0), { mode: 0o600, flag: 'wx' }); paths.push(filePath);
      }
      const rows = paths.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(filePath => ({ path: filePath, title: 'Q'.repeat(160), createdAt: 100, updatedAt: 101 }));
      await h.admin.query(`INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at)
        SELECT $1,x.path,x.title,x.created_at,x.updated_at FROM jsonb_to_recordset($2::jsonb)
        AS x(path text,title text,created_at bigint,updated_at bigint)
        ON CONFLICT(workspace_id,path) DO UPDATE SET title=excluded.title`, [h.source.workspaceId, JSON.stringify(rows.map(value => ({ path: value.path, title: value.title, created_at: value.createdAt, updated_at: value.updatedAt })))]);
      assert.equal(paths.length, 2048); assert.equal(rows.length, 2048);
      console.log(JSON.stringify({ diagnostic, phase: 'setup-completed', actualBudgetPaths: paths.length,
        historicalTitleRows: rows.length, titleUtf16Units: 160, folderUtf8Bytes: Buffer.byteLength(folder),
        genuineStartersInitializedByFixture: 2, precedingRegressionGroupsReplayed: false }));

      const previewStarted = performance.now();
      console.log(JSON.stringify({ diagnostic, phase: 'genuine-preview-started' }));
      try {
        const plan = await previewWorkspaceNativeCopyOperation({ origin, request: await h.request(),
          selections: [{ sourcePath: folder, destinationPath: `budget-copy-${crypto.randomUUID()}` }] });
        console.log(JSON.stringify({ diagnostic, phase: 'genuine-preview-returned', elapsedMs: performance.now() - previewStarted,
          readiness: plan.readiness, pathMappingCount: plan.nativePathPlan.pathMappings.length,
          sourceNamespaceCount: plan.sourceEvidence.stage.namespace.length, destinationNamespaceCount: plan.destinationEvidence.stage.namespace.length }));
      } catch (error) {
        console.log(JSON.stringify({ diagnostic, phase: 'genuine-preview-rejected', elapsedMs: performance.now() - previewStarted,
          error: errorSummary(error) }));
      } finally { previewObserved = true; }

      // Separate mechanical observation on the fixture's own actual connection.
      // RC/RO and the same five-second deadline do not grant mutation authority.
      // Preserve every real query result/error; record no SQL body or parameter.
      const sqlRejections: Array<Record<string, unknown>> = [];
      let queryCount = 0, began = false;
      const collectorStarted = performance.now();
      const query = async <T>(method: 'get' | 'all' | 'run', sql: string, operation: () => T | Promise<T>): Promise<T> => {
        queryCount++;
        try { return await operation(); }
        catch (error) {
          const rejection = { method, ...queryIdentity(sql), code: safeCode(error), elapsedMs: performance.now() - collectorStarted,
            error: errorSummary(error) };
          if (sqlRejections.length < 12) sqlRejections.push(rejection);
          console.log(JSON.stringify({ diagnostic, phase: 'collector-sql-rejected', ...rejection }));
          throw error;
        }
      };
      const connection: SqlConnection = {
        get: (sql, values) => query('get', sql, () => h.connection.get(sql, values)),
        all: (sql, values) => query('all', sql, () => h.connection.all(sql, values)),
        run: (sql, values) => query('run', sql, () => h.connection.run(sql, values)),
        close: () => assert.fail('The mechanical observer does not own the fixture connection.'),
      };
      console.log(JSON.stringify({ diagnostic, phase: 'mechanical-collector-started' }));
      try {
        await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'); began = true;
        await connection.run("SET LOCAL statement_timeout='5s'");
        await connection.run("SET LOCAL lock_timeout='4s'");
        await connection.run("SET LOCAL transaction_timeout='5s'");
        const settings = await connection.get(`SELECT current_setting('transaction_read_only') AS read_only,
          current_setting('transaction_isolation') AS isolation,current_setting('transaction_timeout') AS transaction_timeout,
          current_setting('statement_timeout') AS statement_timeout,pg_current_xact_id_if_assigned()::text AS xid`) as Record<string, unknown>;
        assert.equal(settings.read_only, 'on'); assert.equal(settings.isolation, 'read committed');
        assert.equal(settings.transaction_timeout, '5s'); assert.equal(settings.statement_timeout, '5s'); assert.equal(settings.xid, null);
        console.log(JSON.stringify({ diagnostic, phase: 'mechanical-collector-transaction-confirmed', readOnly: true,
          isolation: 'read committed', transactionTimeoutMs: 5000, statementTimeoutMs: 5000, xidAllocated: false }));
        const observed = await withNativeInspectionSchema(() => readWorkspaceLinkSourceAuthorityOnConnection(connection, h.source));
        const codes = new Map<string, number>();
        for (const gap of observed.stage.coverage.gaps) {
          const code = /^[A-Za-z0-9_-]{1,96}$/u.test(gap.code) ? gap.code : 'unrecognized-code';
          codes.set(code, (codes.get(code) ?? 0) + 1);
        }
        console.log(JSON.stringify({ diagnostic, phase: 'mechanical-collector-returned', elapsedMs: performance.now() - collectorStarted,
          readiness: observed.stage.readiness, coverageComplete: observed.stage.coverage.complete,
          gapCount: observed.stage.coverage.gaps.length, gapCodes: [...codes].slice(0, 16).map(([code, count]) => ({ code, count })),
          namespaceCount: observed.stage.namespace.length, nativeSourceCount: observed.stage.sources.length,
          nativeBindingCount: observed.nativeBindings.length, privateNativeStateCount: observed.privateNativeStates.length, queryCount }));
      } catch (error) {
        console.log(JSON.stringify({ diagnostic, phase: 'mechanical-collector-rejected', elapsedMs: performance.now() - collectorStarted,
          queryCount, error: errorSummary(error) }));
      } finally {
        if (began) {
          const rollbackStarted = performance.now();
          try {
            await connection.run('ROLLBACK');
            console.log(JSON.stringify({ diagnostic, phase: 'mechanical-collector-rollback', confirmed: true, code: null,
              elapsedMs: performance.now() - rollbackStarted }));
          } catch (error) {
            console.log(JSON.stringify({ diagnostic, phase: 'mechanical-collector-rollback', confirmed: false, code: safeCode(error),
              elapsedMs: performance.now() - rollbackStarted, error: errorSummary(error) }));
          }
        }
        collectorObserved = true;
        console.log(JSON.stringify({ diagnostic, phase: 'mechanical-collector-finished', elapsedMs: performance.now() - collectorStarted,
          queryCount, sqlRejections }));
      }
    });
  } finally {
    observedAdmin?.off('error', adminError);
    for (const [file, hash] of Object.entries(pins)) assert.equal(crypto.createHash('sha256').update(await readFile(file)).digest('hex'), hash, `Source changed: ${file}`);
  }
  assert(previewObserved && collectorObserved);
  completedDiagnostic = true;
  console.log(JSON.stringify({ diagnostic, completedDiagnostic: true, featureAcceptance: false, previewObserved, collectorObserved,
    sourcePinsUnchanged: true, fixtureCompleted: true, adminErrorCount, pins }));
}

runNativeCopyMetadataBudgetDiagnostic().catch(error => {
  console.error(JSON.stringify({ diagnostic, completedDiagnostic: false, featureAcceptance: false, error: errorSummary(error) }));
  process.exitCode = 1;
});
