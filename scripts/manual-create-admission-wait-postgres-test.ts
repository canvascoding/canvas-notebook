import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Actual exported Web route, signed ordinary cookie,
// real independent PostgreSQL SH holder and genuine keyed EX wait. No TCP,
// compiled application, browser, model, public issuer or production proof.
// Every relative import and source pin selects this checkout.
const repository = path.resolve(process.cwd());
type Body = { success?: boolean; code?: string; completion?: {
  status: string; requestId: string; workspaceId: string; targetPath: string; code?: string;
} };
type Outcome = { response: Response; body: Body };
type LockRow = { pid: number; start: string; mode: string; granted: boolean;
  application_name: string; wait_event_type: string | null; blockers: number[]; query_age_ms: string };
type Settled = { value: Outcome } | { error: unknown };
let complete = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
}
function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its observation deadline.`)), milliseconds);
  })]); } finally { if (timer) clearTimeout(timer); }
}

export async function manualCreateAdmissionWaitPostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const previousBase = process.env.BASE_URL;
  process.env.BASE_URL = 'http://localhost';
  const sourceNames = ['scripts/manual-create-admission-wait-postgres-test.ts', 'scripts/run-document-read-tool-dispatch-test.mjs', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/api/files/create/route.ts', 'app/lib/files/workspace-markdown-manual-create.ts',
    'app/lib/collaboration/markdown-file-import-persistence.ts',
    'app/lib/files/workspace-file-lifecycle-guard.ts', 'app/lib/collaboration/room-admission-contract.ts'];
  const sourcePins = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name =>
    [name, crypto.createHash('sha256').update(await fs.readFile(path.join(repository, name))).digest('hex')])));
  const before = await sourcePins();
  console.log(JSON.stringify({ suite: 'manual-create-admission-wait-postgres', phase: 'source-binding-before-fixture',
    repository, sourcePins: before, groupsExpected: 2 }));
  let sourceFailure: unknown, sourceFailed = false;
  try {
    await withNativeCopyMetadataOwnerFixture(async h => {
      // Import production modules only after the fixture installs its own realm.
      const { POST: create } = await import('../app/api/files/create/route');
      const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
      const { loadCollaborationStateOnConnection } = await import('../app/lib/collaboration/persistence');
      const { authoritativeCollaborationSnapshot } = await import('../app/lib/collaboration/checkpoint');
      const workspaceId = h.source.workspaceId;
      const admissionKey = collaborationAdmissionLockKey(workspaceId);
      const unsigned = BigInt.asUintN(64, BigInt(admissionKey));
      const keyParts = [(unsigned >> BigInt(32)).toString(), (unsigned & BigInt('4294967295')).toString()];
      const lockRows = async (): Promise<LockRow[]> => {
        // The holder is READ ONLY across several observations; refresh only its
        // statistics snapshot so actual runtime waiters remain observable.
        await h.admin.query('SELECT pg_stat_clear_snapshot()');
        return (await h.admin.query<LockRow>(`
        SELECT l.pid,extract(epoch FROM a.backend_start)::text AS start,l.mode,l.granted,
          a.application_name,a.wait_event_type,pg_blocking_pids(l.pid) AS blockers,
          (extract(epoch FROM (clock_timestamp()-a.query_start))*1000)::text AS query_age_ms
        FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='advisory' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND l.classid=$1::oid AND l.objid=$2::oid AND l.objsubid=1 ORDER BY l.pid,l.mode`, keyParts)).rows;
      };
      const post = async (filePath: string, requestId: string): Promise<Outcome> => {
        const original = await h.request(h.source, 'owner', true);
        assert(original.headers.has('cookie'));
        assert.equal(original.headers.has('authorization'), false);
        const headers = new Headers(original.headers);
        headers.set('Content-Type', 'application/json');
        const response = await create(new NextRequest('http://localhost/api/files/create', {
          method: 'POST', headers, body: JSON.stringify({ path: filePath, type: 'file', requestId }),
        }));
        const bytes = await response.text();
        assert(Buffer.byteLength(bytes) <= 64 * 1024);
        return { response, body: JSON.parse(bytes) as Body };
      };
      const counts = async (filePath: string, requestId: string) => {
        const operationId = `manual-create:${requestId}`;
        const documents = (await h.admin.query('SELECT id,lineage_id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [workspaceId, filePath])).rows;
        const receipts = (await h.admin.query('SELECT private_result FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2', [workspaceId, operationId])).rows;
        const births = (await h.admin.query('SELECT document_id,finalized FROM collaboration_markdown_create_births WHERE workspace_id=$1 AND operation_id=$2', [workspaceId, operationId])).rows;
        const projections = (await h.admin.query(`SELECT p.document_id FROM collaboration_file_projections p
          JOIN collaboration_documents d ON d.id=p.document_id WHERE d.workspace_id=$1 AND d.path=$2`, [workspaceId, filePath])).rows;
        const revisions = (await h.admin.query('SELECT id FROM file_revisions WHERE workspace_id=$1 AND path=$2', [workspaceId, filePath])).rows;
        return { documents, receipts, births, projections, revisions };
      };
      const absent = async (filePath: string, requestId: string) => {
        const state = await counts(filePath, requestId);
        for (const rows of Object.values(state)) assert.equal(rows.length, 0);
        assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM audit_events WHERE workspace_id=$1 AND entity_id=$2', [workspaceId, filePath])).rows[0].n, 0);
        await assert.rejects(fs.lstat(path.join(h.source.rootPath, filePath)), { code: 'ENOENT' });
      };
      const completed = async (value: Outcome, filePath: string, requestId: string) => {
        assert.equal(value.response.status, 200, JSON.stringify({ status: value.response.status, code: value.body.code, completion: value.body.completion }));
        assert.deepEqual(value.body, { success: true, completion: {
          status: 'completed', requestId, workspaceId, targetPath: filePath,
        } });
        const state = await counts(filePath, requestId);
        for (const rows of Object.values(state)) assert.equal(rows.length, 1);
        const documentId = state.documents[0].id;
        assert.equal(state.receipts[0].private_result.target.documentId, documentId);
        assert.equal(state.receipts[0].private_result.target.path, filePath);
        assert.equal(state.births[0].document_id, documentId);
        assert.equal(Number(state.births[0].finalized), 1);
        assert.equal(state.projections[0].document_id, documentId);
        const native = await loadCollaborationStateOnConnection(h.connection, documentId);
        assert(native); assert.equal(native.representation, 'tiptap_blocks');
        assert.equal(native.workspaceId, workspaceId);
        assert.equal(authoritativeCollaborationSnapshot(native).canonicalContent, '');
        assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, filePath)), Buffer.alloc(0));
        return documentId as string;
      };
      const failures: unknown[] = [];
      for (const mode of ['short-shared-reader', 'bounded-shared-reader'] as const) {
        currentCase = mode;
        const filePath = `manual-admission-${mode}-${crypto.randomUUID()}.md`, requestId = crypto.randomUUID();
        const operationId = `manual-create:${requestId}`;
        const armed = signal<void>();
        const transactions = new WeakMap<MetadataSqlEvent['client'], { matched: boolean }>();
        let holderActive = false, holderPid = 0, holderStart = '', armCount = 0;
        let observerCommitted = false, observerOwnerPid = 0;
        let pending: Promise<Settled> | undefined, settled: Settled | undefined;
        let phaseConfirmed = false, owner: LockRow | undefined, waitObservedAt = 0;
        let primary: unknown, failed = false;
        await absent(filePath, requestId);
        const release = async () => {
          if (!holderActive) return;
          await h.admin.query('ROLLBACK');
          holderActive = false;
          assert.equal((await lockRows()).some(row => row.pid === holderPid && row.granted && row.mode === 'ShareLock'), false);
        };
        try {
          await h.withProbe(async event => {
            if (/^BEGIN\b/iu.test(event.text.trim())) transactions.set(event.client, { matched: false });
            const transaction = transactions.get(event.client);
            if (transaction && event.text.includes('SELECT * FROM collaboration_markdown_file_import_receipts')
              && event.values.includes(operationId)) transaction.matched = true;
            if (/^ROLLBACK\b/iu.test(event.text.trim())) transactions.delete(event.client);
            if (/^COMMIT\b/iu.test(event.text.trim())) {
              transactions.delete(event.client);
              if (transaction?.matched && !observerCommitted) {
                observerCommitted = true;
                const owners = (await lockRows()).filter(row => row.application_name === h.applicationName
                  && row.mode === 'ExclusiveLock' && row.granted);
                assert.equal(owners.length, 1);
                observerOwnerPid = owners[0].pid;
              }
            }
            if (!observerCommitted || armCount || !/^SELECT pg_advisory_unlock\(/u.test(event.text.trim())
              || String(event.values[0]) !== String(admissionKey)) return;
            assert.equal(event.result.rows[0]?.unlocked, true);
            assert.equal(Number(Reflect.get(event.client, 'processID')), observerOwnerPid);
            armCount++;
            // Initial create_observe really COMMITted and its dedicated outer
            // SESSION-EX is now actually unlocked. Hold SH before that genuine
            // unlock ACK returns and before create_native can acquire its EX.
            // The fixture admin is a separate client, outside the runtime pool.
            await h.admin.query('BEGIN READ ONLY'); holderActive = true;
            await h.admin.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [admissionKey]);
            await h.admin.query('SELECT pg_stat_clear_snapshot()');
            const facts = (await h.admin.query(`SELECT pg_backend_pid() AS pid,
              extract(epoch FROM backend_start)::text AS start,
              current_setting('transaction_read_only') AS readonly,pg_current_xact_id_if_assigned()::text AS xid
              FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
            assert.equal(facts.readonly, 'on'); assert.equal(facts.xid, null);
            holderPid = facts.pid; holderStart = facts.start;
            assert((await lockRows()).some(row => row.pid === holderPid && row.start === holderStart
              && row.mode === 'ShareLock' && row.granted && row.application_name === `${h.applicationName}-fixture`));
            phaseConfirmed = true; armed.resolve();
          }, async () => {
            pending = post(filePath, requestId).then(value => ({ value }), error => ({ error }));
            void pending.then(value => { settled = value; });
            // A missing arm is a clear failure; no timer ever releases the holder.
            await bounded(Promise.race([armed.promise, pending.then(() => {
              if (!phaseConfirmed) throw new Error('Create settled before the matching initial observer COMMIT.');
            })]), 3000, 'Initial Create observer');
            const deadline = performance.now() + 2000;
            do {
              const rows = await lockRows();
              owner = rows.find(row => row.pid !== holderPid && row.application_name === h.applicationName
                && row.mode === 'ExclusiveLock' && !row.granted && row.wait_event_type === 'Lock'
                && row.blockers.includes(holderPid));
              if (owner) {
                const age = Number(owner.query_age_ms);
                assert(Number.isFinite(age) && age >= 0 && age < 4000);
                waitObservedAt = performance.now() - age;
                break;
              }
              if (settled) break;
              await new Promise<void>(resolve => setImmediate(resolve));
            } while (performance.now() < deadline);
            assert(owner, 'The genuine Create must wait for the independent keyed SH holder before it can return.');
            assert.equal(settled, undefined);
            assert.equal(armCount, 1); assert(phaseConfirmed);
            await absent(filePath, requestId);
            if (mode === 'short-shared-reader') await release();
            const waitedBackends = new Set([`${owner.pid}:${owner.start}`]);
            if (mode === 'bounded-shared-reader') {
              // Native acquisition waits4s; catch-time completion observation
              // performs one further genuine bounded acquisition. No mutation
              // retry occurs. Observe both independently keyed runtime waiters.
              const deadline = waitObservedAt + 10500;
              while (!settled && performance.now() < deadline) {
                for (const row of await lockRows()) if (row.application_name === h.applicationName
                  && row.mode === 'ExclusiveLock' && !row.granted && row.wait_event_type === 'Lock'
                  && row.blockers.includes(holderPid)) waitedBackends.add(`${row.pid}:${row.start}`);
                if (!settled) await new Promise<void>(resolve => setTimeout(resolve, 25));
              }
            }
            const outcome = await bounded(pending, mode === 'bounded-shared-reader'
              ? Math.max(1, waitObservedAt + 10500 - performance.now()) : 6500, 'Contended genuine Create result');
            if ('error' in outcome) throw outcome.error;
            if (mode === 'bounded-shared-reader') {
              const elapsed = performance.now() - waitObservedAt;
              assert(elapsed >= 7000 && elapsed < 10000,
                `The two existing four-second admission bounds were not respected (${Math.round(elapsed)}ms).`);
              assert.equal(waitedBackends.size, 2, 'Native and catch-time observation must each wait on the actual shared holder.');
              assert.equal(outcome.value.response.status, 409);
              assert.equal(outcome.value.body.success, false);
              assert.equal(outcome.value.body.code, 'MARKDOWN_CREATE_RECOVERY_REQUIRED');
              assert.deepEqual(outcome.value.body.completion, { status: 'recovery_required', requestId,
                workspaceId, targetPath: filePath, code: 'MARKDOWN_CREATE_RECOVERY_REQUIRED' });
              await absent(filePath, requestId);
              assert((await lockRows()).some(row => row.pid === holderPid && row.start === holderStart
                && row.mode === 'ShareLock' && row.granted));
              await release();
            }
            const result = mode === 'short-shared-reader' ? outcome.value : await post(filePath, requestId);
            const originalId = await completed(result, filePath, requestId);
            const replayId = await completed(await post(filePath, requestId), filePath, requestId);
            assert.equal(replayId, originalId, 'Same UUID recovery/replay must retain one original native identity.');
          });
        } catch (error) { failed = true; primary = error; }
        finally {
          const cleanup: unknown[] = [];
          try { await release(); } catch (error) { cleanup.push(error); }
          if (pending) try { await bounded(pending, 15000, 'Settling the original owned Create after release'); }
          catch (error) { cleanup.push(error); }
          if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup,
            'Shared-holder release and pending Create settlement were not confirmed.');
        }
        if (failed) failures.push(primary);
        else { groups++; console.log(JSON.stringify({ case: mode, passed: true, phase: 'create_native',
          keyedIndependentShareLock: true, genuineExclusiveWait: true, sameUuidRecoveryAndReplay: true })); }
      }
      if (failures.length) throw new AggregateError(failures, 'Focused manual Create admission cases failed.');
    });
    assert.equal(groups, 2);
  } catch (error) { sourceFailed = true; sourceFailure = error; }
  finally {
    let pinFailure: unknown, pinsFailed = false;
    try {
      const after = await sourcePins();
      assert.deepEqual(after, before, 'Product and reused fixture source bytes changed during this run.');
      console.log(JSON.stringify({ suite: 'manual-create-admission-wait-postgres', phase: 'source-binding-after-fixture',
        repository, sourcePins: after, sourcesUnchanged: true, testFailed: sourceFailed }));
    } catch (error) { pinsFailed = true; pinFailure = error; }
    if (previousBase === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previousBase;
    if (pinsFailed) throw new AggregateError(sourceFailed ? [sourceFailure, pinFailure] : [pinFailure],
      'Test outcome and source stability could not both be confirmed.');
  }
  if (sourceFailed) throw sourceFailure;
  complete = true;
  console.log(JSON.stringify({ suite: 'manual-create-admission-wait-postgres', groups, passed: true,
    sourcePins: before, sourceUnchanged: true, scope: 'Real Web route/Auth/PG/FS, no TCP/browser/compiled-runtime acceptance' }));
}
void manualCreateAdmissionWaitPostgresTest().catch(error => {
  const causes = error instanceof AggregateError ? error.errors : [error];
  console.error('Focused manual Create admission test failed', { case: currentCase, groups,
    errors: causes.map(cause => ({ name: cause instanceof Error ? cause.name : 'NonError',
      code: errorCode(cause), message: cause instanceof Error ? cause.message : undefined })) });
  process.exitCode = 1;
});
