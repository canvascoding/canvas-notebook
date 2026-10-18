import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { NativeWorkspaceFileRead } from '../app/lib/collaboration/workspace-native-file-read';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Genuine Reader -> shared admission lock versus ordinary authenticated Copy
// -> its dedicated Owner. This constructs a known contender; it does not
// identify the unknown holder from the original mobile browser trace.
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const sha = (value: Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const code = (error: unknown): unknown => error && typeof error === 'object'
  ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
function barrier<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Backend = { pid: number; start: string };
type ReaderFacts = Backend & { readonly: string; xid: string | null; native: NativeWorkspaceFileRead };
type LockRow = { pid: number; start: string; mode: string; granted: boolean;
  application_name: string; wait_event_type: string | null; blockers: number[]; query_age_ms: string };

export async function nativeCopyReaderContentionPostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const sourceFiles = ['scripts/workspace-native-copy-reader-contention-postgres-test.ts',
    'scripts/helpers/native-copy-metadata-owner-fixture.ts', 'app/lib/collaboration/workspace-native-file-read.ts',
    'app/lib/collaboration/room-admission-contract.ts', 'app/lib/files/workspace-file-operation-service.ts',
    'app/lib/files/workspace-operation-native-copy-owner.ts', 'app/lib/workspaces/copy-principal.ts',
    'app/lib/workspaces/request-principal.ts', 'app/lib/files/workspace-operation-staging.ts'];
  const pins = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await fs.readFile(file))])));
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { withNativeWorkspaceFilesRead: read } = await import('../app/lib/collaboration/workspace-native-file-read');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { executeWorkspaceFileOperationService: copy } = await import('../app/lib/files/workspace-file-operation-service');
    const { previewWorkspaceNativeCopyOperation: preview } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { WorkspaceOperationJournal } = await import('../app/lib/files/workspace-operation-journal');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { loadCollaborationStateOnConnection } = await import('../app/lib/collaboration/persistence');
    const sourceOwner = await readPostgresWorkspaceForActorOnConnection(h.connection,
      resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }), h.source.workspaceId);
    assert(sourceOwner?.permissions.canWrite);
    const staging = new WorkspaceOperationStaging(), journal = new WorkspaceOperationJournal();
    const sourceRows = async (documentId: string) => (await h.admin.query(`
      SELECT 'state' AS kind,to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1
      UNION ALL SELECT 'registry',to_jsonb(d)::text,xmin::text FROM collaboration_documents d WHERE id=$1
      UNION ALL SELECT 'lineage',to_jsonb(l)::text,xmin::text FROM file_collaboration_lineages l
        WHERE id=(SELECT lineage_id FROM collaboration_documents WHERE id=$1) ORDER BY kind`, [documentId])).rows;
    const disposed = async (owner: Backend) => {
      const deadline = performance.now() + 1500;
      do {
        const rows = (await h.admin.query(`SELECT pid FROM pg_stat_activity
          WHERE pid=$1 AND extract(epoch FROM backend_start)::text=$2`, [owner.pid, owner.start])).rows;
        if (!rows.length) {
          assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM pg_locks WHERE pid=$1', [owner.pid])).rows[0].n, 0);
          return;
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      } while (performance.now() < deadline);
      assert.fail('The actual dedicated Copy backend was not disposed.');
    };

    for (const mode of ['reader-release', 'reader-timeout', 'revoke-during-wait'] as const) {
      currentCase = mode;
      const crossWorkspace = mode === 'revoke-during-wait', userId = crossWorkspace ? 'member' : 'owner';
      const source: WorkspaceContext = crossWorkspace ? h.source : sourceOwner;
      const destination: WorkspaceContext = crossWorkspace ? h.destination : sourceOwner;
      const suffix = crypto.randomUUID(), sourcePath = `contended-${suffix}.md`, targetPath = `clone-${suffix}.md`;
      const content = Buffer.from('# Genuine shared Reader\n');
      const seeded = await h.upload(sourcePath, content);
      await fs.unlink(path.join(source.rootPath, sourcePath));
      const originalRows = await sourceRows(seeded.documentId);
      const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId, actorId: userId, sessionId: `session-${userId}` },
        sourceWorkspace: source, destinationWorkspace: destination });
      const request = await h.request(destination, userId, true);
      assert(request.headers.get('cookie')); assert.equal(request.headers.get('authorization'), null);
      const selections = [{ sourcePath, destinationPath: targetPath }];
      // Preview completes before the shared Reader enters. Its own Owner is not a contender.
      const plan = await preview({ origin, request, selections }); assert.equal(plan.version, 3);
      const operationId = crypto.randomUUID();
      assert.equal(await staging.readKind(operationId), null); // Initialize only the ordinary staging base before observations.
      const key = BigInt.asUintN(64, BigInt(collaborationAdmissionLockKey(source.workspaceId)));
      const keyParts = [(key >> BigInt(32)).toString(), (key & BigInt('4294967295')).toString()];
      const ready = barrier<ReaderFacts>(), release = barrier<void>();
      let readerFacts: ReaderFacts | undefined, inspectReader: (() => Promise<ReaderFacts>) | undefined;
      let owner: Backend | undefined, ownerObservedAt = 0, revocationApplied = false;
      let ownerClient: MetadataSqlEvent['client'] | undefined;
      let ownerIdentityQueries = 0, copyDml = 0;
      type CopyOutcome = { value: Awaited<ReturnType<typeof copy>> } | { error: unknown };
      let pending: Promise<CopyOutcome> | undefined, settled: CopyOutcome | undefined;
      let reader: Promise<ReaderFacts> | undefined, failure: unknown, failed = false;
      const lockRows = async (): Promise<LockRow[]> => (await h.admin.query<LockRow>(`
        SELECT l.pid,extract(epoch FROM a.backend_start)::text AS start,l.mode,l.granted,a.application_name,a.wait_event_type,
          pg_blocking_pids(l.pid) AS blockers,(extract(epoch FROM (clock_timestamp()-a.query_start))*1000)::text AS query_age_ms
        FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='advisory' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND l.classid=$1::oid AND l.objid=$2::oid AND l.objsubid=1 ORDER BY l.pid,l.mode`, keyParts)).rows;
      const noPublication = async () => {
        assert.equal(await staging.readKind(operationId), null);
        assert.equal(await journal.get(operationId), null);
        for (const table of ['collaboration_native_copy_receipts', 'collaboration_excalidraw_copy_receipts', 'workspace_file_operation_steps']) {
          assert.equal((await h.admin.query(`SELECT count(*)::integer AS n FROM ${table} WHERE operation_id=$1`, [operationId])).rows[0].n, 0);
        }
        for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'collaboration_excalidraw_states', 'file_collaboration_lineages']) {
          assert.equal((await h.admin.query(`SELECT count(*)::integer AS n FROM ${table} WHERE workspace_id=$1 AND path=$2`,
            [destination.workspaceId, targetPath])).rows[0].n, 0);
        }
        await assert.rejects(fs.lstat(path.join(destination.rootPath, targetPath)), { code: 'ENOENT' });
        assert.equal(copyDml, 0, 'Waiting/denied Copy must never begin domain publication.');
      };
      await h.withProbe(async event => {
        if (/^SELECT pg_catalog\.pg_backend_pid\(\)::text AS backend,/u.test(event.text.trim())) {
          const row = event.result.rows[0];
          assert.match(row.backend, /^[1-9][0-9]*$/u); assert.match(row.start, /^[0-9]+\.[0-9]+$/u);
          const actual = { pid: Number(row.backend), start: String(row.start) };
          if (!owner) {
            owner = actual; ownerClient = event.client; ownerObservedAt = performance.now();
            const settings = (await event.raw("SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout")).rows[0];
            assert.equal(settings.lock_timeout, '4s'); assert.equal(settings.statement_timeout, '5s');
          } else { assert.deepEqual(actual, owner); assert.equal(event.client, ownerClient); }
          ownerIdentityQueries++;
        }
        if (ownerClient && event.client === ownerClient && /^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(event.text)) copyDml++;
      }, async () => {
        try {
          reader = read({ workspace: h.source, paths: [sourcePath], maxEntries: 16 }, async (scope, readerB) => {
            const inspect = async (): Promise<ReaderFacts> => {
              const native = await scope.readFile(sourcePath, 64 * 1024); assert(native?.content);
              assert.equal(native.documentId, seeded.documentId); assert.deepEqual(native.content, content);
              const row = await readerB.get(`SELECT pg_backend_pid() AS pid,extract(epoch FROM a.backend_start)::text AS start,
                current_setting('transaction_read_only') AS readonly,pg_current_xact_id_if_assigned()::text AS xid
                FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`) as Omit<ReaderFacts, 'native'>;
              assert.equal(row.readonly, 'on'); assert.equal(row.xid, null);
              return { ...row, native };
            };
            inspectReader = inspect;
            const first = await inspect(); ready.resolve(first);
            await release.promise;
            assert.deepEqual(await inspect(), first, 'The genuine shared Reader stays unchanged through contention.');
            return first;
          });
          void reader.catch(error => ready.reject(error));
          readerFacts = await ready.promise;
          const shared = (await lockRows()).find(row => row.pid === readerFacts!.pid);
          assert(shared?.granted); assert.equal(shared.mode, 'ShareLock'); assert.equal(shared.start, readerFacts.start);
          pending = copy({ kind: 'copy', operationId, expectedPlanId: plan.planId, selections, request,
            source: { workspace: source, fileOptions: { workspace: source } },
            destination: { workspace: destination, fileOptions: { workspace: destination, mutationActorUserId: userId } },
            actorUserId: userId, actorId: userId, actorSessionId: `session-${userId}`, actorType: 'user', actorDisplayName: 'Genuine contended Copy' })
            .then(value => { settled = { value }; return settled; }, error => { settled = { error }; return settled; });
          let waiting: LockRow | undefined;
          const observationDeadline = performance.now() + 3000;
          do {
            const locks = await lockRows();
            waiting = locks.find(row => owner && row.pid === owner.pid && row.start === owner.start
              && row.mode === 'ExclusiveLock' && row.granted === false);
            if (waiting) break;
            if (settled) assert.fail(`Copy settled before a genuine ExclusiveLock wait: ${JSON.stringify('error' in settled
              ? { code: code(settled.error), name: settled.error instanceof Error ? settled.error.name : 'NonError' }
              : settled.value.execution)}`);
            await new Promise<void>(resolve => setImmediate(resolve)); // SQL rows, not a sleep, establish synchronization.
          } while (performance.now() < observationDeadline);
          assert(waiting, 'A real pg_locks waiting row must precede release, revocation or timeout.');
          assert(owner); assert(ownerIdentityQueries > 0); assert.notEqual(owner.pid, readerFacts.pid);
          assert.equal(waiting.application_name, h.applicationName); assert.equal(waiting.wait_event_type, 'Lock');
          assert(waiting.blockers.includes(readerFacts.pid));
          assert.equal(settled, undefined); assert.equal(copyDml, 0);
          if (mode === 'revoke-during-wait') {
            const changed = await h.admin.query(`UPDATE canvas_workspace_members SET can_write=0
              WHERE workspace_id=$1 AND user_id='member' AND can_read=1 AND can_write=1 AND can_manage=0 RETURNING workspace_id`, [destination.workspaceId]);
            assert.equal(changed.rowCount, 1); revocationApplied = true;
          }
          if (mode !== 'reader-timeout') { release.resolve(); await reader; }
          const outcome = await pending;
          if (mode === 'reader-release') {
            assert('value' in outcome, JSON.stringify('error' in outcome ? { code: code(outcome.error) } : {}));
            assert.equal(outcome.value.execution.status, 'complete', JSON.stringify(outcome.value.execution));
            assert.deepEqual(outcome.value.copied, [targetPath]);
            const operation = await journal.get(operationId); assert(operation);
            assert.equal(operation.status, 'completed'); assert.equal(operation.steps.length, operation.expectedStepCount);
            assert(operation.steps.every(step => step.status === 'applied'));
            const completion = operation.steps.find(step => step.stepKey === 'copy-completion'); assert(completion?.receiptJson);
            assert.equal(JSON.parse(completion.receiptJson).version, 3);
            const ledger = (await h.admin.query(`SELECT publication_status,private_result FROM collaboration_native_copy_receipts WHERE operation_id=$1`, [operationId])).rows[0];
            assert.equal(ledger?.publication_status, 'published'); assert.equal(ledger.private_result.documents.length, 1);
            const clone = ledger.private_result.documents[0]; assert.equal(clone.source.documentId, seeded.documentId);
            assert.notEqual(clone.clone.documentId, seeded.documentId); assert.equal(clone.clone.path, targetPath);
            const stored = await loadCollaborationStateOnConnection(h.connection, clone.clone.documentId); assert(stored);
            assert.equal(stored.workspaceId, destination.workspaceId); assert.equal(stored.lifecycleGeneration, 1); assert.equal(stored.documentSequence, 0);
            const sourceLineage = (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [seeded.documentId])).rows[0];
            assert.notEqual(clone.clone.lineageId, sourceLineage.lineage_id);
            await read({ workspace: destination, paths: [targetPath], maxEntries: 16 }, async scope => {
              assert.deepEqual((await scope.readFile(targetPath, 64 * 1024))?.content, content);
            });
            assert.equal(await staging.readKind(operationId), null);
          } else {
            assert('error' in outcome, 'A bounded/unauthorized wait must not return a successful Copy execution.');
            assert.equal(code(outcome.error), mode === 'reader-timeout' ? 'NATIVE_COPY_LIFECYCLE_BUSY' : 'PRINCIPAL_ACCESS_DENIED');
            await noPublication();
            if (mode === 'reader-timeout') {
              const elapsed = performance.now() - ownerObservedAt;
              assert(elapsed >= 3750 && elapsed < 6000, `The actual single-key four-second lock bound was not respected: ${elapsed}ms.`);
              assert(inspectReader); assert.deepEqual(await inspectReader(), readerFacts);
              const retained = (await lockRows()).find(row => row.pid === readerFacts!.pid);
              assert(retained?.granted); assert.equal(retained.mode, 'ShareLock'); assert.equal(retained.start, readerFacts.start);
            }
          }
          await disposed(owner);
          assert.deepEqual(await sourceRows(seeded.documentId), originalRows);
          await assert.rejects(fs.lstat(path.join(source.rootPath, sourcePath)), { code: 'ENOENT' });
        } catch (error) { failed = true; failure = error; }
        finally {
          const cleanup: unknown[] = [];
          release.resolve();
          try { if (reader) await reader; } catch (error) { cleanup.push(error); }
          try { if (pending) await pending; if (owner) await disposed(owner); } catch (error) { cleanup.push(error); }
          if (revocationApplied) try {
            assert.equal((await h.admin.query(`UPDATE canvas_workspace_members SET can_write=1
              WHERE workspace_id=$1 AND user_id='member' AND can_write=0 AND can_manage=0`, [destination.workspaceId])).rowCount, 1);
          } catch (error) { cleanup.push(error); }
          if (cleanup.length) throw new AggregateError(failed ? [failure, ...cleanup] : cleanup, 'Owned Reader/Copy contention cleanup was not confirmed.');
        }
        if (failed) throw failure;
      });
      groups++; console.log(`PASS native-copy-reader-contention ${groups}: ${mode}`);
    }
  });
  assert.equal(groups, 3);
  assert.deepEqual(Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await fs.readFile(file))]))), pins);
  completed = true; console.log(JSON.stringify({ suite: 'workspace-native-copy-reader-contention-postgres', groups, passed: true, sourcesUnchanged: true }));
}

void nativeCopyReaderContentionPostgresTest().catch(error => {
  console.error('Native Copy/Reader contention fixture failed:', { case: currentCase, groups,
    name: error instanceof Error ? error.name : 'NonError', code: code(error), message: error instanceof Error ? error.message : undefined });
  process.exitCode = 1;
});
